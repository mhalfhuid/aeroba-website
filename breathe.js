// Aeroba in the browser: the exhale tone, leading from 12 breaths a minute to 7.
// The real app tones: the Shakuhachi exhale files (exhale_tone_true_v3) and the
// C2+G2 ground, as in Aeroba/Room. Each breath plays the shortest file that covers
// its exhale; a longer file fades softly at the exhale's end (keepToneShape). Pitch ladder as in the app:
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
  const pitch = bpm => bpm >= 10 ? 'C5' : bpm >= 8.6 ? 'A4' : bpm >= 7.2 ? 'G4' : 'E4';
  // file lengths per note, and the gain that puts every note's loudest moment at the same level (measured)
  const TONES = { C5: [[1.5, 2, 2.5, 3, 3.5], 0.34], A4: [[2.5, 3, 3.5, 4, 4.5], 0.29],
                  G4: [[3, 3.5, 4, 4.5, 5, 5.5], 0.31], E4: [[3.5, 4, 4.5, 5, 5.5, 6, 6.5], 0.25] };
  const toneUrl = (n, L) => `audio/tone-${n}-${L.toFixed(1)}.m4a`;
  const guidedBpm = t => 12 - 5 * ease((t - toneStart) / GLIDE);

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
    N.wet = ctx.createGain(); N.wet.gain.value = 0.35; N.reverb.connect(N.wet).connect(N.master);
    N.duck = ctx.createGain(); N.duck.gain.value = 1; N.duck.connect(N.master);
        N.toneBus = ctx.createGain(); N.toneBus.gain.value = 1; N.toneBus.connect(N.duck);
    N.toneSend = ctx.createGain(); N.toneSend.gain.value = 0.22; N.toneBus.connect(N.toneSend).connect(N.reverb);
    // the ground: the app's C2+G2 recording, looped, about 9 dB under the tone
    N.ground = ctx.createGain(); N.ground.gain.value = 0;
    N.ground.connect(N.duck);
    const gs = ctx.createGain(); gs.gain.value = 0.15; N.ground.connect(gs).connect(N.reverb);
    N.voice = ctx.createGain(); N.voice.gain.value = 1.15; N.voice.connect(N.master);
    const vs = ctx.createGain(); vs.gain.value = 0.10; N.voice.connect(vs).connect(N.reverb);   // same room
  }

  async function loadBuffer(key, url) {
    if (buffers[key]) return;
    try { const r = await fetch(url); buffers[key] = await ctx.decodeAudioData(await r.arrayBuffer()); } catch (e) { /* skip */ }
  }
  async function loadTones() {
    const jobs = [loadBuffer('ground', 'audio/ground-C2G2.m4a')];
    for (const [n, [lens]] of Object.entries(TONES)) lens.forEach(L => jobs.push(loadBuffer(n + L, toneUrl(n, L))));
    await Promise.all(jobs);
    if (buffers.ground && !N.groundSrc) {
      N.groundSrc = ctx.createBufferSource(); N.groundSrc.buffer = buffers.ground; N.groundSrc.loop = true;
      N.groundSrc.connect(N.ground); N.groundSrc.start();
    }
  }
  async function loadVoices() {
    const jobs = Object.entries(VOICE).map(async ([k, url]) => {
      if (buffers[k]) return;
      try { const r = await fetch(url); buffers[k] = await ctx.decodeAudioData(await r.arrayBuffer()); } catch (e) { /* no voice */ }
    });
    await Promise.all(jobs);
  }

  // ── sounds ──
  function tone(t, ex, note) {
    const [lens, gain] = TONES[note];
    let L = lens.find(x => x >= ex - 0.05);
    if (L === undefined) L = lens[lens.length - 1];
    const b = buffers[note + L];
    if (!b) return;
    const src = ctx.createBufferSource(); src.buffer = b;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.03);   // 30 ms in
    if (b.duration > ex + 0.05) {   // the exhale is shorter than the file: a soft exponential fade
      const f = Math.min(0.8, 0.3 * ex);
      g.gain.setValueAtTime(gain, t + ex - f);
      g.gain.setTargetAtTime(0, t + ex - f, f / 4);
    }
    src.connect(g).connect(N.toneBus);
    src.start(t);
    if (b.duration > ex + 0.05) src.stop(t + ex + 0.2);
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
    await loadTones();
    if (mode === 'guided' && voiceBox.checked) await loadVoices();
    const now = ctx.currentTime + 0.1;
    timeline = []; flags = {}; endAt = Infinity; voiceUntil = 0; history.length = 0;
    lastBpm = mode === 'free' ? freeBpm : 12;
    N.master.gain.cancelScheduledValues(now); N.master.gain.setValueAtTime(0, now); N.master.gain.linearRampToValueAtTime(1, now + 1.5);
    N.ground.gain.cancelScheduledValues(now); N.ground.gain.setValueAtTime(0, now); N.ground.gain.linearRampToValueAtTime(0.19, now + 6);
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
    g.addColorStop(0, 'rgba(197,126,203,0.22)'); g.addColorStop(0.7, 'rgba(197,126,203,0.07)'); g.addColorStop(1, 'rgba(197,126,203,0)');
    oc.fillStyle = g; oc.beginPath(); oc.arc(C, C, r * 1.25, 0, Math.PI * 2); oc.fill();
    // ring
    oc.lineWidth = 3; oc.strokeStyle = 'rgba(154,85,160,0.85)';
    oc.beginPath(); oc.arc(C, C, r, 0, Math.PI * 2); oc.stroke();
    // the outer limit, faint
    oc.lineWidth = 1.5; oc.strokeStyle = 'rgba(154,85,160,0.14)';
    oc.beginPath(); oc.arc(C, C, R, 0, Math.PI * 2); oc.stroke();
    // while the tone sounds: soft champagne ripples
    if (s.phase === 'out') {
      for (let j = 0; j < 3; j++) {
        const q = (s.k * 1.4 + j / 3) % 1;
        oc.strokeStyle = `rgba(200,160,90,${(0.45 * (1 - q)).toFixed(3)})`;
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
      tc.setLineDash([12, 9]); tc.lineWidth = 3; tc.strokeStyle = '#B06DB6';
      tc.beginPath();
      history.forEach(([t, a], i) => { const x = TW - (now - t) / 40 * TW, y = TH - 18 - a * (TH - 36); i ? tc.lineTo(x, y) : tc.moveTo(x, y); });
      tc.stroke(); tc.setLineDash([]);
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();
