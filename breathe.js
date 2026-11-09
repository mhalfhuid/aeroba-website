// Aeroba in the browser: the exhale tone, leading from 12 breaths a minute to 7.
// The tone follows the app's recipe (aeroba-exhale-tone skill), synthesised here:
// start 3 semitones low, raised-cosine scoop to the note by 200 ms, steady body,
// a 200 ms accelerating fall of −20.8 cents, the fallen pitch held for the last
// 500 ms, and the exponential end fade. Pitch ladder as in the app:
// C5 (≥10 bpm) · A4 (8.6–10) · G4 (7.2–8.6) · E4 (below 7.2) — it never rises in the guided session.
(function () {
  const $ = id => document.getElementById(id);
  const startBtn = $('start'), cueEl = $('cue'), bpmEl = $('bpm');
  const orb = $('orb'), trace = $('trace');
  const pace = $('pace'), paceOut = $('pace-out'), freeBox = $('free-controls'), voiceBox = $('voice');
  if (!startBtn) return;

  const GLIDE = 150;            // seconds from 12 to 7 in the guided session
  const VOICE = { welcome: 'audio/voice-welcome.mp3', middle: 'audio/voice-middle.mp3', closing: 'audio/voice-closing.mp3' };
  let mode = 'guided';
  let ctx = null, N = {}, buffers = {}, running = false, timer = null;
  let timeline = [], nextT = 0, toneStart = 0, freeBpm = 10, lastBpm = 12;
  let flags = {}, voiceUntil = 0, endAt = Infinity, cueText = '';
  const history = [];

  // ── mode switch ──
  document.querySelectorAll('.mode-switch button').forEach(b => b.addEventListener('click', () => {
    if (running) return;
    mode = b.dataset.mode;
    document.querySelectorAll('.mode-switch button').forEach(x => x.setAttribute('aria-selected', x === b));
    freeBox.hidden = mode !== 'free';
    $('voice-toggle').hidden = mode !== 'guided';
    bpmEl.textContent = (mode === 'free' ? +pace.value : 12).toFixed(1);
  }));
  pace.addEventListener('input', () => { freeBpm = +pace.value; paceOut.textContent = freeBpm.toFixed(1); });

  // ── helpers ──
  const ease = x => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, x)))) / 2;
  const ratio = bpm => Math.min(1, Math.max(0.7, 0.7 + 0.3 * (bpm - 6) / 6));   // inhale : exhale
  const pitch = bpm => bpm >= 10 ? 523.25 : bpm >= 8.6 ? 440 : bpm >= 7.2 ? 392 : 329.63;
  const guidedBpm = t => 12 - 5 * ease((t - toneStart) / GLIDE);

  function makeNoise(seconds) {
    const b = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate), d = b.getChannelData(0);
    let p = 0;   // pinkish
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; p = 0.97 * p + 0.03 * w; d[i] = (w * 0.35 + p * 3.2) * 0.5; }
    return b;
  }
  function makeReverb(seconds) {
    const len = ctx.sampleRate * seconds, b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        lp = lp * 0.55 + (Math.random() * 2 - 1) * 0.45;
        d[i] = lp * Math.exp(-t / 0.75) * (t < 0.012 ? t / 0.012 : 1);
      }
    }
    return b;
  }

  async function setup() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3;
    N.master = ctx.createGain(); N.master.gain.value = 0;
    N.master.connect(comp).connect(ctx.destination);
    N.reverb = ctx.createConvolver(); N.reverb.buffer = makeReverb(3.4);
    N.wet = ctx.createGain(); N.wet.gain.value = 0.55; N.reverb.connect(N.wet).connect(N.master);
    N.duck = ctx.createGain(); N.duck.gain.value = 1; N.duck.connect(N.master);
    N.duckSend = ctx.createGain(); N.duckSend.gain.value = 1; N.duck.connect(N.duckSend); // (dry only)
    N.toneBus = ctx.createGain(); N.toneBus.gain.value = 0.3; N.toneBus.connect(N.duck);
    N.toneSend = ctx.createGain(); N.toneSend.gain.value = 0.42; N.toneBus.connect(N.toneSend).connect(N.reverb);
    N.noise = makeNoise(4);
    const real = new Float32Array([0, 1, 0.16, 0.07, 0.035, 0.015]);
    N.wave = ctx.createPeriodicWave(real, new Float32Array(real.length));
    // the ground: C2 + G2, very low, slowly moving
    N.ground = ctx.createGain(); N.ground.gain.value = 0;
    const glp = ctx.createBiquadFilter(); glp.type = 'lowpass'; glp.frequency.value = 420;
    [[65.41, 1], [98.0, 0.7], [130.81, 0.18]].forEach(([f, a]) => {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = a; o.connect(g).connect(glp); o.start();
    });
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.25;
    const groundAmp = ctx.createGain(); groundAmp.gain.value = 1;
    lfo.connect(lfoG).connect(groundAmp.gain); lfo.start();
    glp.connect(groundAmp).connect(N.ground);
    N.ground.connect(N.duck);
    const gs = ctx.createGain(); gs.gain.value = 0.25; N.ground.connect(gs).connect(N.reverb);
    N.voice = ctx.createGain(); N.voice.gain.value = 1.15; N.voice.connect(N.master);
    const vs = ctx.createGain(); vs.gain.value = 0.10; N.voice.connect(vs).connect(N.reverb);   // same room
  }

  async function loadVoices() {
    const jobs = Object.entries(VOICE).map(async ([k, url]) => {
      if (buffers[k]) return;
      try { const r = await fetch(url); buffers[k] = await ctx.decodeAudioData(await r.arrayBuffer()); } catch (e) { /* no voice */ }
    });
    await Promise.all(jobs);
  }

  // ── sounds ──
  function tone(t, D, f) {
    D = Math.max(1.6, Math.min(D, 6.5));
    const S = Math.pow(2, -3 / 12), FALL = 517 / 523.25, H = 0.067, FS = D - 0.7;
    const n = Math.ceil(D * 120), hz = new Float32Array(n), amp = new Float32Array(n), air = new Float32Array(n);
    const F = Math.min(2, Math.max(0.75, 0.5 * D)), K = 2;
    for (let i = 0; i < n; i++) {
      const tt = i / (n - 1) * D;
      let h = f * S * Math.pow(1 / S, ease((tt - H) / (0.2 - H)));
      if (tt >= FS) h = f * Math.pow(FALL, Math.pow(Math.min(1, (tt - FS) / 0.2), 3));
      hz[i] = h;
      let a = Math.min(1, tt / 0.05) * (0.82 + 0.18 * ease(tt / 0.3));
      const fx = (tt - (D - F)) / F;
      if (fx > 0) a *= (Math.exp(-K * fx) - Math.exp(-K)) / (1 - Math.exp(-K));
      amp[i] = Math.max(0, a);
      air[i] = Math.max(0, 0.9 * Math.exp(-tt / 0.09) * Math.min(1, tt / 0.012) + 0.16 * amp[i]);
    }
    const o = ctx.createOscillator(); o.setPeriodicWave(N.wave);
    o.frequency.setValueCurveAtTime(hz, t, D);
    const vib = ctx.createOscillator(); vib.frequency.value = 4.7;
    const vibG = ctx.createGain(); vibG.gain.setValueAtTime(0, t); vibG.gain.setValueAtTime(0, t + 0.7); vibG.gain.linearRampToValueAtTime(f * 0.0035, t + 1.8);
    vib.connect(vibG).connect(o.frequency);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800; lp.Q.value = 0.3;
    const g = ctx.createGain(); g.gain.value = 0; g.gain.setValueCurveAtTime(amp, t, D);
    o.connect(lp).connect(g).connect(N.toneBus);
    const nz = ctx.createBufferSource(); nz.buffer = N.noise; nz.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2.2; bp.Q.value = 0.9;
    const ng = ctx.createGain(); ng.gain.value = 0; ng.gain.setValueCurveAtTime(air, t, D);
    const nlevel = ctx.createGain(); nlevel.gain.value = 0.55;
    nz.connect(bp).connect(ng).connect(nlevel).connect(N.toneBus);
    [o, vib, nz].forEach(s => { s.start(t); s.stop(t + D + 0.05); });
  }
  function inhaleAir(t, D) {
    const n = 64, env = new Float32Array(n);
    for (let i = 0; i < n; i++) env[i] = Math.pow(Math.sin(Math.PI * i / (n - 1)), 1.6) * 0.07;
    const nz = ctx.createBufferSource(); nz.buffer = N.noise; nz.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0; g.gain.setValueCurveAtTime(env, t, D);
    nz.connect(bp).connect(g).connect(N.duck);
    nz.start(t, Math.random() * 3); nz.stop(t + D + 0.05);
  }
  function say(name, t) {
    const b = buffers[name];
    if (!b || !voiceBox.checked) return t;
    const s = ctx.createBufferSource(); s.buffer = b; s.connect(N.voice); s.start(t);
    // duck the tone, the air and the ground under the voice (as the app does)
    N.duck.gain.setTargetAtTime(0.28, t - 0.05, 0.04);
    N.duck.gain.setTargetAtTime(1, t + b.duration, 0.05);
    voiceUntil = t + b.duration;
    return t + b.duration;
  }

  // ── the schedule ──
  function bpmAt(t) {
    if (mode === 'free') {
      const target = freeBpm;   // move toward the slider by at most 1 bpm a breath
      lastBpm = lastBpm + Math.max(-1, Math.min(1, target - lastBpm));
      return lastBpm;
    }
    return guidedBpm(t);
  }
  function scheduleBreath(t) {
    const bpm = bpmAt(t), period = 60 / bpm, r = ratio(bpm);
    const ins = period * r / (1 + r), ex = period - ins;
    timeline.push({ t0: t, ins, ex, bpm });
    if (timeline.length > 60) timeline.shift();
    inhaleAir(t, ins);
    tone(t + ins, ex, pitch(bpm));
    if (mode === 'guided') {
      if (!flags.middle && bpm <= 9.6) { flags.middle = true; say('middle', t + 0.3); }
      if (!flags.closing && t - toneStart >= GLIDE + 2 * period) {
        flags.closing = true;
        const end = say('closing', t + 0.3);
        endAt = Math.max(end, t + period) + period;
      }
    }
    nextT = t + period;
  }
  function tick() {
    if (!running) return;
    const now = ctx.currentTime;
    if (nextT < now + 0.05) nextT = Math.max(nextT, now + 0.05);
    while (nextT < now + 1.6 && nextT < endAt) scheduleBreath(nextT);
    if (now >= endAt) finish(true);
  }

  async function begin() {
    startBtn.disabled = true; startBtn.textContent = 'Loading…';
    if (!ctx) await setup();
    if (ctx.state === 'suspended') await ctx.resume();
    if (mode === 'guided' && voiceBox.checked) await loadVoices();
    const now = ctx.currentTime + 0.1;
    timeline = []; flags = {}; endAt = Infinity; voiceUntil = 0; history.length = 0;
    lastBpm = mode === 'free' ? freeBpm : 12;
    N.master.gain.cancelScheduledValues(now); N.master.gain.setValueAtTime(0, now); N.master.gain.linearRampToValueAtTime(1, now + 1.5);
    N.ground.gain.cancelScheduledValues(now); N.ground.gain.setValueAtTime(0, now); N.ground.gain.linearRampToValueAtTime(0.05, now + 6);
    N.duck.gain.cancelScheduledValues(now); N.duck.gain.setValueAtTime(1, now);
    let first = now + 2.5;
    if (mode === 'guided' && voiceBox.checked && buffers.welcome) first = say('welcome', now + 1.2) + 1.2;
    toneStart = first; nextT = first;
    running = true;
    startBtn.disabled = false; startBtn.textContent = 'Stop';
    document.querySelectorAll('.mode-switch button').forEach(b => b.disabled = true);
    timer = setInterval(tick, 50); tick();
  }
  function finish(natural) {
    if (!running) return;
    running = false; clearInterval(timer);
    const now = ctx.currentTime;
    N.master.gain.cancelScheduledValues(now);
    N.master.gain.setValueAtTime(N.master.gain.value, now);
    N.master.gain.linearRampToValueAtTime(0, now + (natural ? 5 : 1.2));
    endAt = Infinity;
    setTimeout(() => { if (!running) ctx.suspend(); }, natural ? 5500 : 1500);
    startBtn.textContent = natural ? 'Again' : 'Begin';
    cueText = natural ? 'Well breathed' : 'Ready when you are';
    document.querySelectorAll('.mode-switch button').forEach(b => b.disabled = false);
    timeline.length = 0;
  }
  startBtn.addEventListener('click', () => running ? finish(false) : begin());
  document.addEventListener('tabchange', e => { if (e.detail !== 'try' && running) finish(false); });

  // ── drawing ──
  const oc = orb.getContext('2d'), tc = trace.getContext('2d');
  let shownCue = '';
  function state() {
    if (!running || !ctx) return { amp: 0, phase: 'idle', bpm: mode === 'free' ? freeBpm : 12 };
    const t = ctx.currentTime;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const b = timeline[i];
      if (t >= b.t0) {
        const x = t - b.t0;
        if (x < b.ins) return { amp: ease(x / b.ins), phase: 'in', bpm: b.bpm, k: x / b.ins };
        if (x < b.ins + b.ex) return { amp: 1 - ease((x - b.ins) / b.ex), phase: 'out', bpm: b.bpm, k: (x - b.ins) / b.ex };
        return { amp: 0, phase: 'in', bpm: b.bpm, k: 0 };
      }
    }
    return { amp: 0, phase: 'listen', bpm: mode === 'free' ? lastBpm : 12 };
  }
  function draw(ts) {
    const s = state();
    const W = orb.width, C = W / 2, R = W * 0.44;
    oc.clearRect(0, 0, W, W);
    const idle = s.phase === 'idle' || s.phase === 'listen';
    const amp = idle ? 0.25 + 0.06 * Math.sin(ts / 1400) : s.amp;
    const r = R * (0.5 + 0.5 * amp);
    // glow
    const g = oc.createRadialGradient(C, C, r * 0.1, C, C, r * 1.25);
    g.addColorStop(0, 'rgba(197,126,203,0.30)'); g.addColorStop(0.7, 'rgba(197,126,203,0.08)'); g.addColorStop(1, 'rgba(197,126,203,0)');
    oc.fillStyle = g; oc.beginPath(); oc.arc(C, C, r * 1.25, 0, Math.PI * 2); oc.fill();
    // ring
    oc.lineWidth = 3; oc.strokeStyle = 'rgba(197,126,203,0.9)';
    oc.beginPath(); oc.arc(C, C, r, 0, Math.PI * 2); oc.stroke();
    // the outer limit, faint
    oc.lineWidth = 1.5; oc.strokeStyle = 'rgba(197,126,203,0.16)';
    oc.beginPath(); oc.arc(C, C, R, 0, Math.PI * 2); oc.stroke();
    // while the tone sounds: soft champagne ripples
    if (s.phase === 'out') {
      for (let j = 0; j < 3; j++) {
        const q = (s.k * 1.4 + j / 3) % 1;
        oc.strokeStyle = `rgba(230,209,166,${(0.35 * (1 - q)).toFixed(3)})`;
        oc.lineWidth = 2;
        oc.beginPath(); oc.arc(C, C, r + q * R * 0.35, 0, Math.PI * 2); oc.stroke();
      }
    }
    // cue + bpm
    let cue = cueText || 'Ready when you are';
    if (running) cue = s.phase === 'listen' ? 'Listen…' : s.phase === 'in' ? 'Breathe in' : 'Breathe out';
    if (cue !== shownCue) { shownCue = cue; cueEl.textContent = cue; }
    bpmEl.textContent = s.bpm.toFixed(1);
    // trace: the last 40 s, the tone's lead drawn dashed
    if (running) history.push([ctx.currentTime, amp]);
    while (history.length && running && history[0][0] < ctx.currentTime - 40) history.shift();
    const TW = trace.width, TH = trace.height;
    tc.clearRect(0, 0, TW, TH);
    if (history.length > 1) {
      const now = history[history.length - 1][0];
      tc.setLineDash([12, 9]); tc.lineWidth = 3; tc.strokeStyle = '#E3A6E8';
      tc.beginPath();
      history.forEach(([t, a], i) => { const x = TW - (now - t) / 40 * TW, y = TH - 18 - a * (TH - 36); i ? tc.lineTo(x, y) : tc.moveTo(x, y); });
      tc.stroke(); tc.setLineDash([]);
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();
