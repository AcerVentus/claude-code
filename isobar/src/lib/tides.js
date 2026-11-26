// Tide analysis: find highs and lows in a sea-level series, describe where
// the tide stands now, and compare two independent sets of predictions.

import { isNum } from './units.js';
import { HOUR } from './time.js';

/** Centred moving average that ignores gaps. */
function smooth(values, half) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    let s = 0, w = 0;
    for (let k = -half; k <= half; k++) {
      const v = values[i + k];
      if (isNum(v)) { const wt = half + 1 - Math.abs(k); s += v * wt; w += wt; }
    }
    if (w && isNum(values[i])) out[i] = s / w;
  }
  return out;
}

/**
 * High and low waters in an evenly sampled series.
 * @param {number[]} times  ms, ascending, evenly spaced
 * @param {number[]} heights metres
 * @param {{minProminence?:number}} [opts]
 * @returns {{t:number,h:number,type:'H'|'L'}[]}
 */
export function findExtrema(times, heights, opts = {}) {
  const minProminence = opts.minProminence ?? 0.03;
  const n = times.length;
  if (n < 5) return [];
  const step = times[1] - times[0];
  // Sea-level data is rounded to the centimetre, which leaves flat tops at
  // 15-minute sampling; smoothing over about an hour restores a single turning point.
  const half = Math.max(1, Math.round((30 * 60e3) / step));
  const s = smooth(heights, half);

  const raw = [];
  let i = 1;
  while (i < n - 1) {
    if (!isNum(s[i - 1]) || !isNum(s[i])) { i++; continue; }
    // Walk across any plateau to find the far side of the turning point.
    let j = i;
    while (j < n - 1 && isNum(s[j + 1]) && s[j + 1] === s[i]) j++;
    if (j >= n - 1) break;
    if (!isNum(s[j + 1])) { i = j + 2; continue; } // a gap in the series: carry on after it
    const before = s[i] - s[i - 1];
    const after = s[j + 1] - s[j];
    if (before !== 0 && after !== 0 && Math.sign(before) !== Math.sign(after)) {
      const type = before > 0 ? 'H' : 'L';
      // Parabola through the three points around the turn (centre of plateau).
      const c = (i + j) / 2;
      const y0 = s[i - 1], y1 = s[i], y2 = s[j + 1];
      const x0 = i - 1 - c, x2 = j + 1 - c;
      // y = a x² + b x + y1 with y(x0)=y0, y(x2)=y2
      const det = x0 * x0 * x2 - x2 * x2 * x0;
      const a = ((y0 - y1) * x2 - (y2 - y1) * x0) / det;
      const b = ((y2 - y1) * x0 * x0 - (y0 - y1) * x2 * x2) / det;
      let xv = a !== 0 ? -b / (2 * a) : 0;
      xv = Math.max(x0, Math.min(x2, xv));
      const t = times[0] + (c + xv) * step;
      // Height from the unsmoothed data, so a smoothed peak is not flattened.
      const k = Math.max(0, Math.min(n - 1, Math.round(c + xv)));
      let h = heights[k];
      for (let m = Math.max(0, k - half); m <= Math.min(n - 1, k + half); m++) {
        if (!isNum(heights[m])) continue;
        if (type === 'H' ? heights[m] > h : heights[m] < h) h = heights[m];
      }
      raw.push({ t, h, type });
    }
    i = j + 1;
  }

  // Drop ripples: neighbouring high/low pairs closer than the prominence floor.
  let events = raw;
  let changed = true;
  while (changed && events.length > 1) {
    changed = false;
    for (let k = 0; k < events.length - 1; k++) {
      if (Math.abs(events[k].h - events[k + 1].h) < minProminence) {
        events = events.slice(0, k).concat(events.slice(k + 2));
        changed = true;
        break;
      }
    }
  }
  return events;
}

/**
 * State of the tide at instant `now` given a list of high/low events.
 */
export function tideState(events, now) {
  if (!events || !events.length) return null;
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const next = sorted.find((e) => e.t > now) ?? null;
  const prev = [...sorted].reverse().find((e) => e.t <= now) ?? null;
  if (!next) return null;
  const rising = next.type === 'H';
  let progress = null, height = null;
  if (prev) {
    progress = (now - prev.t) / (next.t - prev.t);
    // Half-cosine between turning points — the usual harmonic approximation.
    height = prev.h + (next.h - prev.h) * (1 - Math.cos(Math.PI * progress)) / 2;
  }
  return { rising, prev, next, progress, height };
}

/** Heights between events by half-cosine interpolation, for stations that only publish highs and lows. */
export function curveFromEvents(events, startMs, endMs, stepMs = 10 * 60e3) {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const t = [], h = [];
  for (let T = startMs; T <= endMs; T += stepMs) {
    const nextIdx = sorted.findIndex((e) => e.t > T);
    if (nextIdx <= 0) continue;
    const a = sorted[nextIdx - 1], b = sorted[nextIdx];
    const f = (T - a.t) / (b.t - a.t);
    t.push(T);
    h.push(a.h + (b.h - a.h) * (1 - Math.cos(Math.PI * f)) / 2);
  }
  return { t, h };
}

/**
 * Compare two sets of tide events (e.g. a tide-gauge prediction and an ocean model).
 * Events are paired by type within ±3 h. Heights are compared as range between
 * consecutive events so that the two sources may use different datums.
 */
export function compareTides(reference, other, fromMs, toMs) {
  const ref = reference.filter((e) => e.t >= fromMs && e.t <= toMs).sort((a, b) => a.t - b.t);
  const pairs = [];
  for (const r of ref) {
    let best = null;
    for (const o of other) {
      if (o.type !== r.type) continue;
      const d = Math.abs(o.t - r.t);
      if (d <= 3 * HOUR && (!best || d < Math.abs(best.t - r.t))) best = o;
    }
    if (best) pairs.push({ ref: r, other: best, dtMin: (best.t - r.t) / 60e3 });
  }
  if (pairs.length < 2) return { pairs, matched: pairs.length, expected: ref.length, timeDiffMin: null, rangeRatio: null, level: 'single' };

  const timeDiffMin = pairs.reduce((s, p) => s + Math.abs(p.dtMin), 0) / pairs.length;
  let refRange = 0, otherRange = 0, m = 0;
  for (let k = 1; k < pairs.length; k++) {
    refRange += Math.abs(pairs[k].ref.h - pairs[k - 1].ref.h);
    otherRange += Math.abs(pairs[k].other.h - pairs[k - 1].other.h);
    m++;
  }
  const rangeRatio = refRange > 0 ? otherRange / refRange : null;
  const meanRefRange = refRange / m;
  const meanOtherRange = otherRange / m;

  const coverage = pairs.length / ref.length;
  const rangeErr = rangeRatio == null ? 1 : Math.abs(rangeRatio - 1);
  let level = 'low';
  if (coverage >= 0.8 && timeDiffMin <= 30 && rangeErr <= 0.25) level = 'high';
  else if (coverage >= 0.6 && timeDiffMin <= 60 && rangeErr <= 0.5) level = 'medium';
  return { pairs, matched: pairs.length, expected: ref.length, timeDiffMin, rangeRatio, meanRefRange, meanOtherRange, level };
}
