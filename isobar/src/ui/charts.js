// Small SVG chart primitives. Charts are drawn at the container's real pixel
// width (no stretched text), use one y-scale each, and take every colour from
// CSS classes so both themes work.

import { isNum } from '../lib/units.js';

export const scale = (d0, d1, r0, r1) => {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
};

/** Round tick values covering [min, max]. */
export function niceTicks(min, max, target = 4) {
  if (!isNum(min) || !isNum(max)) return [];
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** Pad a data range to tick boundaries. */
export function niceRange(min, max, target = 4, floorZero = false) {
  if (!isNum(min) || !isNum(max)) return [0, 1];
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || raw;
  let lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  if (floorZero) lo = Math.min(0, lo);
  return [lo, hi === lo ? lo + step : hi];
}

const f = (n) => (Math.round(n * 10) / 10).toString();

/** Straight polyline; gaps in the data (null y) break the line. */
export function linePath(pts) {
  let d = '', pen = false;
  for (const [x, y] of pts) {
    if (!isNum(y) || !isNum(x)) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${f(x)} ${f(y)}`;
    pen = true;
  }
  return d;
}

/** Monotone cubic curve (no overshoot between samples); gaps break the line. */
export function smoothPath(pts) {
  const runs = [];
  let run = [];
  for (const p of pts) {
    if (isNum(p[0]) && isNum(p[1])) run.push(p);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs.map(smoothRun).join('');
}

function smoothRun(p) {
  const n = p.length;
  if (n < 3) return linePath(p);
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx.push(p[i + 1][0] - p[i][0]); m.push((p[i + 1][1] - p[i][1]) / (dx[i] || 1)); }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (2 * m[i - 1] * m[i]) / (m[i - 1] + m[i]));
  t.push(m[n - 2]);
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f(p[i][0] + h)} ${f(p[i][1] + t[i] * h)} ${f(p[i + 1][0] - h)} ${f(p[i + 1][1] - t[i + 1] * h)} ${f(p[i + 1][0])} ${f(p[i + 1][1])}`;
  }
  return d;
}

/** Closed band between an upper and a lower line (both as point lists over the same x). */
export function bandPath(upper, lower) {
  const u = upper.filter((p) => isNum(p[1])), l = lower.filter((p) => isNum(p[1]));
  if (u.length < 2 || l.length < 2) return '';
  return `${linePath(u)}${linePath([...l].reverse()).replace('M', 'L')}Z`;
}

/** Area under a line down to a baseline y. */
export function areaPath(pts, baseY, smooth = false) {
  const live = pts.filter((p) => isNum(p[1]));
  if (live.length < 2) return '';
  const top = smooth ? smoothPath(live) : linePath(live);
  return `${top}L${f(live[live.length - 1][0])} ${f(baseY)}L${f(live[0][0])} ${f(baseY)}Z`;
}

/** Bar with rounded data-end, anchored to the baseline. */
export function bar(x, y, w, baseY, cls, r = 3) {
  const h = baseY - y;
  if (!(h > 0.4)) return '';
  const rr = Math.min(r, w / 2, h);
  return `<path class="${cls}" d="M${f(x)} ${f(baseY)}V${f(y + rr)}a${f(rr)} ${f(rr)} 0 0 1 ${f(rr)} ${f(-rr)}h${f(w - 2 * rr)}a${f(rr)} ${f(rr)} 0 0 1 ${f(rr)} ${f(rr)}V${f(baseY)}Z"/>`;
}

/** Horizontal gridlines with labels on the left. */
export function yGrid(ticks, sy, x0, x1, fmtFn = (v) => v) {
  return ticks.map((v) => `<line class="c-grid" x1="${f(x0)}" x2="${f(x1)}" y1="${f(sy(v))}" y2="${f(sy(v))}"/><text class="c-tick" x="${f(x0 - 6)}" y="${f(sy(v) + 3.5)}" text-anchor="end">${fmtFn(v)}</text>`).join('');
}

export const svgOpen = (w, h, label) => `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">`;

/** Point on a circle, angle in degrees clockwise from north (compass convention). */
export function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** SVG arc path between two compass-style angles (clockwise). */
export function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${f(x0)} ${f(y0)}A${f(r)} ${f(r)} 0 ${large} 1 ${f(x1)} ${f(y1)}`;
}

// ------------------------------------------------------------------ hover

const hovers = new WeakMap();
let tip = null;

/**
 * Give a chart a crosshair and tooltip.
 * @param {HTMLElement} el container holding the chart's <svg>
 * @param {{x:number, html:string}[]} points pixel x (within the svg) and tooltip HTML per sample
 * @param {{top:number,bottom:number}} extent vertical extent of the crosshair in px
 */
export function attachHover(el, points, extent) {
  hovers.set(el, { points, extent });
  if (el.dataset.hoverBound) return;
  el.dataset.hoverBound = '1';
  el.classList.add('has-hover');
  const move = (ev) => {
    const cfg = hovers.get(el);
    const svg = el.querySelector('svg.chart');
    if (!cfg || !svg || !cfg.points.length) return;
    const rect = svg.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    let best = cfg.points[0];
    for (const p of cfg.points) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    let line = svg.querySelector('.c-cross');
    if (!line) {
      line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'c-cross');
      svg.appendChild(line);
    }
    line.setAttribute('x1', best.x); line.setAttribute('x2', best.x);
    line.setAttribute('y1', cfg.extent.top); line.setAttribute('y2', cfg.extent.bottom);
    if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; tip.setAttribute('role', 'status'); document.body.appendChild(tip); }
    tip.innerHTML = best.html;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = rect.left + best.x + 12;
    if (left + tw > window.innerWidth - 8) left = rect.left + best.x - tw - 12;
    tip.style.left = `${Math.max(8, left) + window.scrollX}px`;
    tip.style.top = `${Math.max(8, rect.top + cfg.extent.top - th - 6) + window.scrollY}px`;
  };
  const leave = () => {
    el.querySelector('.c-cross')?.remove();
    if (tip) tip.hidden = true;
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerdown', move);
  el.addEventListener('pointerleave', leave);
  el.addEventListener('pointercancel', leave);
}
