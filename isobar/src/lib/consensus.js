// Cross-source consensus and confidence.
//
// Every reading the app shows is the median of whatever independent sources
// could be reached. The confidence attached to it is computed, never assumed:
//
//   1. value   = median of the sources (after dropping clear outliers)
//   2. spread  = RMS deviation of the remaining sources from that median
//   3. score   = 100 at zero spread, 80 at the "tight" tolerance for the
//                variable, 50 at the "loose" tolerance, falling to 5 beyond;
//                80+ reads as high confidence, 50+ as medium, below as low
//   4. caps    = one source can never be more than "single source";
//                two sources can never be "high"
//   5. penalty = each outlier that had to be dropped costs confidence, and
//                dropping more than 15% of the sources rules out "high"
//
// Tolerances are per variable and listed in VARS so they can be audited.

import { isNum } from './units.js';

/** Per-variable tolerances. `rel` scales a tolerance with the reading itself. */
export const VARS = {
  temp:       { label: 'Temperature',   unit: '°C',    hi: 1.0,  mid: 2.5,  out: 4,    digits: 1 },
  feels:      { label: 'Feels like',    unit: '°C',    hi: 1.5,  mid: 3.0,  out: 5,    digits: 1 },
  dew:        { label: 'Dew point',     unit: '°C',    hi: 1.5,  mid: 3.0,  out: 5,    digits: 1 },
  rh:         { label: 'Humidity',      unit: '%',     hi: 6,    mid: 14,   out: 22,   digits: 0 },
  wind:       { label: 'Wind',          unit: 'km/h',  hi: 3,    mid: 7,    out: 10,   digits: 0, rel: { hi: 0.15, mid: 0.35, out: 0.6 } },
  gust:       { label: 'Gusts',         unit: 'km/h',  hi: 5,    mid: 11,   out: 15,   digits: 0, rel: { hi: 0.15, mid: 0.35, out: 0.6 } },
  dir:        { label: 'Wind direction', unit: '°',    hi: 20,   mid: 45,   out: 80,   digits: 0, circular: true },
  pressure:   { label: 'Pressure',      unit: 'hPa',   hi: 1.0,  mid: 2.5,  out: 4,    digits: 0 },
  cloud:      { label: 'Cloud cover',   unit: '%',     hi: 15,   mid: 35,   out: 60,   digits: 0 },
  precip:     { label: 'Precipitation', unit: 'mm',    hi: 0.2,  mid: 0.6,  out: 1.5,  digits: 1, rel: { hi: 0.25, mid: 0.6, out: 1.5 } },
  precipDay:  { label: 'Precipitation', unit: 'mm',    hi: 1,    mid: 3,    out: 6,    digits: 1, rel: { hi: 0.25, mid: 0.6, out: 1.5 } },
  pop:        { label: 'Chance of precipitation', unit: '%', hi: 10, mid: 25, out: 45, digits: 0 },
  waveH:      { label: 'Wave height',   unit: 'm',     hi: 0.15, mid: 0.35, out: 0.6,  digits: 1, rel: { hi: 0.12, mid: 0.3, out: 0.6 } },
  wavePeriod: { label: 'Wave period',   unit: 's',     hi: 1.0,  mid: 2.5,  out: 4,    digits: 1 },
  waveDir:    { label: 'Wave direction', unit: '°',    hi: 20,   mid: 45,   out: 80,   digits: 0, circular: true },
  seaTemp:    { label: 'Sea temperature', unit: '°C',  hi: 0.7,  mid: 1.5,  out: 3,    digits: 1 },
  pm25:       { label: 'PM2.5',         unit: 'µg/m³', hi: 3,    mid: 8,    out: 15,   digits: 0, rel: { hi: 0.2, mid: 0.5, out: 1.0 } },
  pm10:       { label: 'PM10',          unit: 'µg/m³', hi: 5,    mid: 12,   out: 25,   digits: 0, rel: { hi: 0.2, mid: 0.5, out: 1.0 } },
};

export const LEVELS = {
  high:   { label: 'High confidence',   short: 'High' },
  medium: { label: 'Medium confidence', short: 'Medium' },
  low:    { label: 'Low confidence',    short: 'Low' },
  single: { label: 'Single source',     short: 'Unverified' },
};

export function median(values) {
  const a = values.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Linear-interpolated quantile, q in [0,1]. */
export function quantile(values, q) {
  const a = values.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

const RAD = Math.PI / 180;

/** Smallest signed difference a − b between two bearings, in (−180, 180]. */
export function angleDiff(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Mean of bearings (degrees), or null when they cancel out. */
export function circularMean(degs) {
  let x = 0, y = 0, n = 0;
  for (const d of degs) {
    if (!isNum(d)) continue;
    x += Math.cos(d * RAD); y += Math.sin(d * RAD); n++;
  }
  if (!n || Math.hypot(x, y) / n < 1e-6) return null;
  return ((Math.atan2(y, x) / RAD) % 360 + 360) % 360;
}

function tolerances(spec, center) {
  const base = { hi: spec.hi, mid: spec.mid, out: spec.out };
  if (spec.rel && isNum(center)) {
    const m = Math.abs(center);
    base.hi = Math.max(base.hi, spec.rel.hi * m);
    base.mid = Math.max(base.mid, spec.rel.mid * m);
    base.out = Math.max(base.out, spec.rel.out * m);
  }
  return base;
}

/** Spread → 0–100 agreement score (before source-count caps). */
export function scoreFromSpread(sigma, tol) {
  if (sigma <= tol.hi) return 100 - 20 * (sigma / tol.hi);
  if (sigma <= tol.mid) return 80 - 30 * ((sigma - tol.hi) / (tol.mid - tol.hi));
  if (sigma <= 2 * tol.mid) return 50 - 35 * ((sigma - tol.mid) / tol.mid);
  return Math.max(5, 15 - 10 * ((sigma - 2 * tol.mid) / tol.mid));
}

export function levelFromScore(score) {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

/**
 * Combine readings of one variable from several sources.
 * @param {{id:string,value:number}[]} entries
 * @param {keyof VARS} varKey
 * @returns {null | {value:number,n:number,sigma:number,min:number,max:number,
 *   score:number,level:string,used:{id:string,value:number,dev:number,outlier:boolean}[]}}
 */
export function consensus(entries, varKey) {
  const spec = VARS[varKey];
  if (!spec) throw new Error(`Unknown variable ${varKey}`);
  const list = entries.filter((e) => e && isNum(e.value));
  const n = list.length;
  if (!n) return null;

  const dev = spec.circular
    ? (v, c) => angleDiff(v, c)
    : (v, c) => v - c;
  const center = (vals) => (spec.circular ? circularMean(vals) : median(vals));

  let c0 = center(list.map((e) => e.value));
  if (c0 == null) c0 = list[0].value; // bearings that cancel exactly
  const tol0 = tolerances(spec, c0);

  // Outliers: far outside both the robust scale of the group and the variable's
  // own outlier tolerance. Needs at least four sources, and never drops a third
  // or more of them — at that point it is disagreement, not an outlier.
  let outlierIds = new Set();
  if (n >= 4) {
    const absDevs = list.map((e) => Math.abs(dev(e.value, c0)));
    const mad = median(absDevs);
    const limit = Math.max(3 * 1.4826 * mad, tol0.out);
    const flagged = list.filter((e) => Math.abs(dev(e.value, c0)) > limit);
    if (flagged.length && flagged.length < n / 3) outlierIds = new Set(flagged.map((e) => e.id));
  }

  const inliers = list.filter((e) => !outlierIds.has(e.id));
  let value = center(inliers.map((e) => e.value));
  if (value == null) value = c0;
  const tol = tolerances(spec, value);
  const sq = inliers.reduce((s, e) => s + dev(e.value, value) ** 2, 0);
  const sigma = Math.sqrt(sq / inliers.length);

  const vals = inliers.map((e) => e.value);
  const result = {
    value,
    n,
    sigma,
    min: spec.circular ? null : Math.min(...vals),
    max: spec.circular ? null : Math.max(...vals),
    used: list.map((e) => ({ id: e.id, value: e.value, dev: dev(e.value, value), outlier: outlierIds.has(e.id) })),
  };

  if (n === 1) {
    result.score = 30;
    result.level = 'single';
    return result;
  }
  let score = scoreFromSpread(sigma, tol);
  score *= 1 - 0.5 * (outlierIds.size / n);
  // One stray source among many is what the median is for. More than that (over 15% of
  // the sources set aside) is real dissent, however tightly the rest agree: never "high".
  if (outlierIds.size / n > 0.15) score = Math.min(score, 74);
  if (n === 2) score = Math.min(score, 74);
  result.score = Math.round(score);
  result.level = levelFromScore(result.score);
  return result;
}

/**
 * Weighted roll-up of several per-variable results into one headline figure.
 * @param {{result: object|null, weight: number}[]} parts
 */
export function overall(parts) {
  const live = parts.filter((p) => p.result);
  if (!live.length) return null;
  const wsum = live.reduce((s, p) => s + p.weight, 0);
  const score = Math.round(live.reduce((s, p) => s + p.result.score * p.weight, 0) / wsum);
  const maxN = Math.max(...live.map((p) => p.result.n));
  const level = maxN <= 1 ? 'single' : levelFromScore(score);
  return { score, level, n: maxN };
}

/**
 * Value of a time series at instant T. Exact samples are returned as-is;
 * between samples it interpolates linearly, but only across gaps no longer
 * than maxGapMs. Returns null outside the series or across longer gaps.
 */
export function valueAt(times, values, T, maxGapMs = 3 * 3600e3, circular = false) {
  if (!times || !values || !times.length) return null;
  let lo = 0, hi = times.length - 1;
  if (T < times[lo] || T > times[hi]) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= T) lo = mid; else hi = mid;
  }
  const a = values[lo], b = values[hi];
  if (times[lo] === T) return isNum(a) ? a : null;
  if (times[hi] === T) return isNum(b) ? b : null;
  if (!isNum(a) || !isNum(b)) return null;
  const span = times[hi] - times[lo];
  if (span > maxGapMs) return null;
  const f = (T - times[lo]) / span;
  if (circular) return ((a + angleDiff(b, a) * f) % 360 + 360) % 360;
  return a + (b - a) * f;
}

/** Nearest sample to T within maxDistMs (for categorical series such as weather codes). */
export function nearestAt(times, values, T, maxDistMs = 1.5 * 3600e3) {
  if (!times || !values || !times.length) return null;
  let best = null, bestD = Infinity;
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= T) lo = mid; else hi = mid;
  }
  for (const i of [lo, hi]) {
    const d = Math.abs(times[i] - T);
    if (d < bestD && values[i] != null) { bestD = d; best = values[i]; }
  }
  return bestD <= maxDistMs ? best : null;
}

/** Most common item; ties go to `prefer` when it is among the leaders. */
export function vote(items, prefer = null) {
  const counts = new Map();
  for (const it of items) if (it != null) counts.set(it, (counts.get(it) || 0) + 1);
  if (!counts.size) return null;
  const top = Math.max(...counts.values());
  const leaders = [...counts.entries()].filter(([, c]) => c === top).map(([k]) => k);
  const winner = prefer != null && leaders.includes(prefer) ? prefer : leaders[0];
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return { winner, count: top, total, share: top / total, counts };
}
