// The hero's living sky: a gradient chosen from the Sun's real altitude and
// the cloud cover, drawn over with slowly drifting isobars — the contour
// lines the app is named after — and rain or snow when it is falling.

const PALETTES = {
  day:          ['#1b56a6', '#3f86cf', '#74aede'],
  sunrise:      ['#27457f', '#b8627a', '#eb9a5c'],
  sunset:       ['#2a3f7c', '#b4576f', '#ea8f55'],
  dawn:         ['#15224e', '#5d4a82', '#c9806f'],
  dusk:         ['#141f4a', '#5a4580', '#c4776d'],
  nautical:     ['#0c1535', '#232a5e', '#4a4474'],
  astronomical: ['#080e24', '#141d47', '#262c5c'],
  night:        ['#060b1c', '#0e1838', '#1b2550'],
};
const OVERCAST_DAY = ['#4a5668', '#66758a', '#8793a3'];
const OVERCAST_NIGHT = ['#0d1220', '#1a2233', '#272f41'];
const STORM = ['#1d2430', '#313b4b', '#465163'];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => { const x = hex(a), y = hex(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`; };

export function skyStops(phase, cloud = 0, group = null) {
  const base = PALETTES[phase] || PALETTES.day;
  const dark = phase === 'night' || phase === 'astronomical' || phase === 'nautical';
  if (group === 'thunder') return base.map((c, i) => mix(c, STORM[i], 0.85));
  const target = dark ? OVERCAST_NIGHT : OVERCAST_DAY;
  let t = Math.max(0, Math.min(1, (cloud - 25) / 75)) * 0.82;
  if (group === 'rain' || group === 'snow' || group === 'sleet' || group === 'fog') t = Math.max(t, 0.7);
  return base.map((c, i) => mix(c, target[i], t));
}

export function createSky(canvas) {
  const ctx = canvas.getContext('2d');
  let state = { phase: 'day', cloud: 0, group: null, windDir: 270, windSpeed: 10 };
  let raf = 0, last = 0, t0 = Math.random() * 1000, running = false, w = 0, h = 0;
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const drops = [];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    w = Math.max(1, Math.round(rect.width)); h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // A smooth pressure-like field: a few broad waves that drift with time.
  function field(x, y, t) {
    return Math.sin(x * 2.1 + t * 0.21) * Math.cos(y * 2.7 - t * 0.13)
      + 0.8 * Math.sin((x + y) * 1.6 - t * 0.17 + 1.3)
      + 0.6 * Math.cos(x * 0.9 - y * 3.1 + t * 0.11)
      + 0.45 * Math.sin(Math.hypot(x - 0.7, y - 0.4) * 5.2 - t * 0.19);
  }

  function contours(t) {
    const cols = Math.max(24, Math.round(w / 22)), rows = Math.max(10, Math.round(h / 22));
    const grid = [];
    for (let j = 0; j <= rows; j++) {
      const row = [];
      for (let i = 0; i <= cols; i++) row.push(field((i / cols) * (w / h) * 1.15, j / rows, t));
      grid.push(row);
    }
    const cw = w / cols, ch = h / rows;
    ctx.lineWidth = 1;
    const levels = [-1.8, -1.2, -0.6, 0, 0.6, 1.2, 1.8];
    levels.forEach((lv, li) => {
      ctx.strokeStyle = `rgba(255,255,255,${li % 2 === 1 ? 0.2 : 0.11})`;
      ctx.beginPath();
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
          const pts = [];
          const cut = (v1, v2, x1, y1, x2, y2) => {
            if ((v1 < lv) !== (v2 < lv)) { const f = (lv - v1) / (v2 - v1); pts.push([x1 + (x2 - x1) * f, y1 + (y2 - y1) * f]); }
          };
          const x = i * cw, y = j * ch;
          cut(a, b, x, y, x + cw, y); cut(b, c, x + cw, y, x + cw, y + ch);
          cut(d, c, x, y + ch, x + cw, y + ch); cut(a, d, x, y, x, y + ch);
          if (pts.length >= 2) { ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); }
          if (pts.length === 4) { ctx.moveTo(pts[2][0], pts[2][1]); ctx.lineTo(pts[3][0], pts[3][1]); }
        }
      }
      ctx.stroke();
    });
  }

  function precipitation(dt) {
    const g = state.group;
    const wet = g === 'rain' || g === 'thunder' || g === 'sleet';
    const snow = g === 'snow';
    if (!wet && !snow) { drops.length = 0; return; }
    const want = Math.round((w * h) / (snow ? 5200 : 3600));
    while (drops.length < want) drops.push({ x: Math.random() * w, y: Math.random() * h, s: 0.6 + Math.random() * 0.8 });
    drops.length = Math.min(drops.length, want);
    const slant = Math.max(-0.5, Math.min(0.5, (state.windSpeed || 0) / 80)) * (Math.sin(((state.windDir || 270) * Math.PI) / 180) > 0 ? -1 : 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.34)'; ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (const d of drops) {
      const v = (snow ? 38 : 420) * d.s;
      d.y += v * dt; d.x += v * slant * dt + (snow ? Math.sin((d.y + d.s * 90) / 22) * 12 * dt : 0);
      if (d.y > h + 12) { d.y = -12; d.x = Math.random() * w; }
      if (d.x > w + 12) d.x = -12; else if (d.x < -12) d.x = w + 12;
      if (snow) { ctx.moveTo(d.x + 1.6 * d.s, d.y); ctx.arc(d.x, d.y, 1.6 * d.s, 0, 6.3); }
      else { ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + 11 * slant * d.s, d.y + 11 * d.s); }
    }
    if (snow) ctx.fill(); else ctx.stroke();
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    const stops = skyStops(state.phase, state.cloud, state.group);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, stops[0]); g.addColorStop(0.58, stops[1]); g.addColorStop(1, stops[2]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    contours(t0 + now / 1000 * 0.35);
    precipitation(dt);
  }

  function loop(now) {
    frame(now);
    if (running) raf = requestAnimationFrame(loop);
  }
  function start() {
    cancelAnimationFrame(raf);
    running = !(reduce && reduce.matches) && !document.hidden;
    if (running) raf = requestAnimationFrame(loop); else frame(performance.now());
  }

  resize();
  const ro = new ResizeObserver(() => { resize(); if (!running) frame(performance.now()); });
  ro.observe(canvas);
  document.addEventListener('visibilitychange', start);
  reduce?.addEventListener?.('change', start);
  start();

  return {
    set(next) { state = { ...state, ...next }; if (!running) frame(performance.now()); },
  };
}
