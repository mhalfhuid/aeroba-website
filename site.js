// Tabs (hash based) and the home page's session graph.
(function () {
  const pages = document.querySelectorAll('.page');
  const links = document.querySelectorAll('[data-tab]');
  function show(name) {
    if (!document.getElementById('page-' + name)) name = 'home';
    pages.forEach(p => { p.hidden = p.dataset.page !== name; });
    document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    document.dispatchEvent(new CustomEvent('tabchange', { detail: name }));
  }
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1) || 'home');

  // A session as the app draws it: the breath (bright line) slowing from 12 to 7,
  // the tone (light plum, dashed) drawn on top.
  const svg = document.getElementById('hero-graph');
  if (!svg) return;
  const W = 520, H = 260, L = 34, R = 10, T = 14, B = 34;
  const bpmAt = x => 12 - 5 * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, x / 0.8)));
  const y = b => T + (14 - b) / (14 - 5) * (H - T - B);
  const X = x => L + x * (W - L - R);
  let tone = '', breath = '';
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
  let lag = 0.4;
  for (let i = 0; i <= 120; i++) {
    const x = i / 120;
    const tb = bpmAt(x);
    const bb = bpmAt(Math.max(0, x - 0.04)) + rnd() * 0.7 + lag * (1 - x);
    tone += (i ? 'L' : 'M') + X(x).toFixed(1) + ' ' + y(tb).toFixed(1);
    breath += (i ? 'L' : 'M') + X(x).toFixed(1) + ' ' + y(bb).toFixed(1);
  }
  const grid = [12, 9, 7].map(b =>
    `<line x1="${L}" x2="${W - R}" y1="${y(b)}" y2="${y(b)}" stroke="rgba(154,85,160,.14)"/>` +
    `<text x="${L - 8}" y="${y(b) + 5}" text-anchor="end" fill="#7E6F88" font-size="13" font-family="Spectral">${b}</text>`).join('');
  svg.innerHTML = grid +
    `<text x="${L}" y="${H - 8}" fill="#7E6F88" font-size="13" font-style="italic" font-family="Spectral">start</text>` +
    `<text x="${W - R}" y="${H - 8}" text-anchor="end" fill="#7E6F88" font-size="13" font-style="italic" font-family="Spectral">10 min</text>` +
    `<path class="g-breath" d="${breath}" fill="none" stroke="#2B1D33" stroke-width="2.2" stroke-linejoin="round"/>` +
    `<path class="g-tone" d="${tone}" fill="none" stroke="#B06DB6" stroke-width="2" stroke-dasharray="6 5"/>` +
    `<circle cx="${X(1)}" cy="${y(7)}" r="5" fill="#D9BC86"/>`;
  // draw-on when it scrolls into view
  const paths = svg.querySelectorAll('path');
  paths.forEach(p => { const len = p.getTotalLength(); p.style.strokeDasharray = p.classList.contains('g-tone') ? '' : len; p.style.strokeDashoffset = p.classList.contains('g-tone') ? 0 : len; });
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    paths.forEach(p => { if (!p.classList.contains('g-tone')) { p.style.transition = 'stroke-dashoffset 3.2s cubic-bezier(.37,0,.63,1)'; p.style.strokeDashoffset = 0; } });
    io.disconnect();
  }), { threshold: 0.4 });
  io.observe(svg);
})();
