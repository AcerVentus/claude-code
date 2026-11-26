// The Moon as the observer sees it: a shaded sphere with the principal maria,
// lit from the true direction of the Sun, turned to the true orientation in
// the local sky, and nudged by the current libration.

const RAD = Math.PI / 180;

// [latitude °N, longitude °E, radius °, darkness 0–1] — the near-side seas.
const MARIA = [
  [32.8, -15.6, 17, 0.5],   // Imbrium
  [18.4, -57.4, 20, 0.42],  // Oceanus Procellarum (north)
  [-2, -50, 15, 0.36],      // Oceanus Procellarum (south)
  [28, 17.5, 10.5, 0.5],    // Serenitatis
  [8.5, 31.4, 12.5, 0.52],  // Tranquillitatis
  [17, 59.1, 8, 0.58],      // Crisium
  [-7.8, 51.3, 11, 0.46],   // Fecunditatis
  [-15.2, 35.5, 5.5, 0.44], // Nectaris
  [-21.3, -16.6, 11, 0.42], // Nubium
  [-24.4, -38.6, 6.5, 0.5], // Humorum
  [-10, -23.1, 6.5, 0.36],  // Cognitum
  [7.5, -30.9, 8.5, 0.34],  // Insularum
  [13.3, 3.6, 4.5, 0.38],   // Vaporum
  [56, -22, 6, 0.3], [57, 0, 6, 0.32], [55, 22, 6, 0.3], // Frigoris
  [44, -55, 6, 0.3],        // Sinus Roris
  [1, 0, 4, 0.2],           // Sinus Medii
];
// [lat, lon, radius °, brightness] — young ray craters.
const BRIGHT = [
  [-43.3, -11.4, 5.5, 0.22], // Tycho
  [9.6, -20.1, 3.2, 0.2],    // Copernicus
  [8.1, -38, 2.2, 0.16],     // Kepler
  [23.7, -47.4, 2, 0.24],    // Aristarchus
  [-9, 61, 3, 0.1],          // Langrenus
];

const unit = (lat, lon) => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
const MARIA_V = MARIA.map(([lat, lon, r, d]) => ({ v: unit(lat, lon), cosOuter: Math.cos(r * 1.25 * RAD), cosInner: Math.cos(r * 0.55 * RAD), d }));
const BRIGHT_V = BRIGHT.map(([lat, lon, r, b]) => ({ v: unit(lat, lon), k: 1 / (1 - Math.cos(r * RAD)), b }));

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
  return (hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u) * (1 - w) + (hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u) * w;
}

function albedo(p) {
  let dark = 0;
  for (const m of MARIA_V) {
    const c = p[0] * m.v[0] + p[1] * m.v[1] + p[2] * m.v[2];
    if (c > m.cosOuter) dark += m.d * smooth(m.cosOuter, m.cosInner, c);
  }
  let a = 0.9 * (1 - Math.min(0.62, dark));
  for (const b of BRIGHT_V) {
    const c = p[0] * b.v[0] + p[1] * b.v[1] + p[2] * b.v[2];
    a += b.b * Math.exp(-(1 - c) * b.k * 1.2);
  }
  const lon = Math.atan2(p[1], p[0]), lat = Math.asin(p[2]);
  a *= 0.93 + 0.1 * noise(lon * 9 + 40, lat * 9 + 40) + 0.05 * noise(lon * 27, lat * 27);
  return Math.min(1.08, a);
}

/**
 * Paint the Moon.
 * @param {HTMLCanvasElement} canvas
 * @param {{phaseAngle:number, limbFromZenith:number, poleFromZenith:number, librationLat:number, librationLon:number, illumination:number}} m
 * @param {number} cssSize diameter of the canvas in CSS pixels
 */
export function drawMoon(canvas, m, cssSize) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const size = Math.round(cssSize * dpr);
  canvas.width = size; canvas.height = size;
  canvas.style.width = `${cssSize}px`; canvas.style.height = `${cssSize}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const R = size / 2 - 1.5, c = size / 2;

  // Sun direction in screen space (x right, y up, z towards the viewer).
  const i = m.phaseAngle * RAD, th = m.limbFromZenith * RAD;
  const sx = -Math.sin(th) * Math.sin(i), sy = Math.cos(th) * Math.sin(i), sz = Math.cos(i);
  // Lunar north and east on screen.
  const ph = m.poleFromZenith * RAD;
  const nx = -Math.sin(ph), ny = Math.cos(ph), ex = Math.cos(ph), ey = Math.sin(ph);
  // Sub-observer point (libration) in selenographic coordinates.
  const lat0 = (m.librationLat || 0) * RAD, lon0 = (m.librationLon || 0) * RAD;
  const C = [Math.cos(lat0) * Math.cos(lon0), Math.cos(lat0) * Math.sin(lon0), Math.sin(lat0)];
  const E = [-Math.sin(lon0), Math.cos(lon0), 0];
  const N = [-Math.sin(lat0) * Math.cos(lon0), -Math.sin(lat0) * Math.sin(lon0), Math.cos(lat0)];
  const earthshine = 0.05 + 0.09 * (1 - (m.illumination ?? 0.5));

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5 - c) / R, v = (c - py - 0.5) / R;
      const rr = u * u + v * v;
      if (rr > 1.02) continue;
      const z = Math.sqrt(Math.max(0, 1 - rr));
      const xm = u * ex + v * ey, ym = u * nx + v * ny;
      const p = [xm * E[0] + ym * N[0] + z * C[0], xm * E[1] + ym * N[1] + z * C[1], xm * E[2] + ym * N[2] + z * C[2]];
      const a = albedo(p);
      const lambert = u * sx + v * sy + z * sz;
      const lit = smooth(-0.015, 0.07, lambert);
      // The regolith scatters light back strongly: brightness falls off far more gently than a matte ball.
      const day = a * (0.3 + 0.7 * Math.sqrt(Math.max(0, lambert))) * (0.86 + 0.14 * z);
      const night = a * earthshine;
      const k = (py * size + px) * 4;
      data[k] = Math.min(255, (242 * day) * lit + 96 * night * (1 - lit));
      data[k + 1] = Math.min(255, (238 * day) * lit + 112 * night * (1 - lit));
      data[k + 2] = Math.min(255, (226 * day) * lit + 150 * night * (1 - lit));
      const edge = Math.max(0, Math.min(1, (1 - Math.sqrt(rr)) * R + 0.5));
      data[k + 3] = 255 * edge * (lit + (1 - lit) * 0.92);
    }
  }
  ctx.putImageData(img, 0, 0);
}
