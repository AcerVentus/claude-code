// Turns the raw per-source series into what the screen shows: consensus
// values for now, each hour and each day, with a confidence for every one.

import { consensus, overall, valueAt, nearestAt, vote, median, VARS } from './consensus.js';
import { condGroup, CONDITIONS } from './conditions.js';
import { HOUR, dateKey, keyToStart, addDays, hourStart } from './time.js';
import { isNum, dewPoint } from './units.js';

export const NOW_VARS = ['temp', 'feels', 'rh', 'dew', 'wind', 'gust', 'dir', 'pressure', 'cloud'];
const OBS_MAX_AGE = 90 * 60e3;
const OBS_MAX_KM = 40;

/** One source's reading for "now": its own current report if it has one, else its forecast interpolated to now. */
export function sourceNow(source, now) {
  const out = {};
  const h = source.hourly;
  const explicit = source.now && now - source.now.t <= OBS_MAX_AGE && now - source.now.t >= -10 * 60e3 ? source.now : null;
  for (const v of NOW_VARS) {
    let val = explicit && isNum(explicit[v]) ? explicit[v] : null;
    if (val == null && h && h[v]) val = valueAt(h.t, h[v], now, 3 * HOUR, v === 'dir');
    out[v] = isNum(val) ? val : null;
  }
  if (out.dew == null && isNum(out.temp) && isNum(out.rh)) out.dew = dewPoint(out.temp, out.rh);
  out.code = explicit?.code ?? (h ? nearestAt(h.t, h.code, now) : null);
  return out;
}

/**
 * Consensus of current conditions.
 * @param sources forecast sources ({hourly, now?})
 * @param observations station observations ({now, meta})
 * @param preferCode condition to prefer when the vote ties
 */
export function buildNow(sources, observations, now, preferCode = null) {
  const rows = [];
  for (const s of sources) {
    const values = sourceNow(s, now);
    if (!isNum(values.temp)) continue;
    rows.push({ id: s.id, name: s.name, short: s.short || s.name, kind: s.kind, via: s.via, origin: s.origin || '', values });
  }
  for (const o of observations) {
    if (!o?.now || now - o.now.t > OBS_MAX_AGE) continue;
    if (isNum(o.meta?.distanceKm) && o.meta.distanceKm > OBS_MAX_KM) continue;
    const values = {};
    for (const v of NOW_VARS) values[v] = isNum(o.now[v]) ? o.now[v] : null;
    values.code = o.now.code ?? null;
    rows.push({ id: o.id, name: o.name, short: o.short || o.name, kind: 'observation', via: o.via, origin: '', values, observedAt: o.now.t, distanceKm: o.meta?.distanceKm ?? null });
  }

  const vars = {};
  for (const v of NOW_VARS) {
    vars[v] = consensus(rows.map((r) => ({ id: r.id, value: r.values[v] })), v);
  }
  // Direction means little in near-calm air; do not let it drag confidence around.
  if (vars.wind && vars.wind.value < 5) vars.dir = vars.dir ? { ...vars.dir, calm: true } : null;

  const groups = rows.map((r) => condGroup(r.values.code)).filter(Boolean);
  const groupVote = vote(groups, condGroup(preferCode));
  let code = null;
  if (groupVote) {
    const inGroup = rows.map((r) => r.values.code).filter((c) => condGroup(c) === groupVote.winner);
    code = vote(inGroup, condGroup(preferCode) === groupVote.winner ? preferCode : null)?.winner ?? null;
  }

  const summary = overall([
    { result: vars.temp, weight: 0.4 },
    { result: vars.wind, weight: 0.2 },
    { result: vars.rh, weight: 0.15 },
    { result: vars.pressure, weight: 0.15 },
    { result: vars.cloud, weight: 0.1 },
  ]);
  return { rows, vars, condition: { code, vote: groupVote }, overall: summary, count: rows.length };
}

const HOURLY_VARS = ['temp', 'feels', 'rh', 'dew', 'wind', 'gust', 'dir', 'pressure', 'cloud', 'precip'];

/**
 * Hour-by-hour consensus on a grid of local clock hours starting at the current
 * one. Local, because that is what the strip labels, and because Open-Meteo
 * serves its hours on the place's own clock: in a :30 or :45 zone those do not
 * fall on UTC hours. Sources published on UTC hours are interpolated there for
 * instantaneous values and left out of hourly rain totals.
 */
export function buildHourly(sources, now, hours = 168, extra = {}) {
  const start = hourStart(now, extra.tz);
  const out = { t: [], code: [], codeShare: [], pop: [], popN: [], confidence: [] };
  for (const v of HOURLY_VARS) out[v] = { value: [], sigma: [], n: [], level: [], min: [], max: [] };

  for (let i = 0; i < hours; i++) {
    const T = start + i * HOUR;
    out.t.push(T);
    const results = {};
    for (const v of HOURLY_VARS) {
      const entries = [];
      for (const s of sources) {
        const h = s.hourly;
        if (!h || !h[v]) continue;
        // Precipitation is an hourly total: only exact hours count. Others may bridge a 3-hour gap.
        const val = v === 'precip' ? valueAt(h.t, h[v], T, 0) : valueAt(h.t, h[v], T, 3 * HOUR, v === 'dir');
        if (isNum(val)) entries.push({ id: s.id, value: val });
      }
      const r = consensus(entries, v);
      results[v] = r;
      const col = out[v];
      col.value.push(r ? r.value : null);
      col.sigma.push(r ? r.sigma : null);
      col.n.push(r ? r.n : 0);
      col.level.push(r ? r.level : null);
      col.min.push(r ? r.min : null);
      col.max.push(r ? r.max : null);
    }

    const codes = sources.map((s) => (s.hourly ? nearestAt(s.hourly.t, s.hourly.code, T, 1.5 * HOUR) : null)).filter(Boolean);
    const prefer = extra.preferSource?.hourly ? nearestAt(extra.preferSource.hourly.t, extra.preferSource.hourly.code, T, 1.5 * HOUR) : null;
    const gv = vote(codes.map(condGroup), condGroup(prefer));
    let code = null;
    if (gv) {
      const inGroup = codes.filter((c) => condGroup(c) === gv.winner);
      code = vote(inGroup, condGroup(prefer) === gv.winner ? prefer : null)?.winner ?? null;
    }
    out.code.push(code);
    out.codeShare.push(gv ? gv.share : null);

    // Chance of precipitation: every probabilistic estimate we have for this hour.
    const pops = [];
    for (const p of extra.popSeries || []) {
      const val = valueAt(p.t, p.values, T, 0);
      if (isNum(val)) pops.push(val);
    }
    out.pop.push(pops.length ? median(pops) : null);
    out.popN.push(pops.length);

    const sum = overall([
      { result: results.temp, weight: 0.45 },
      { result: results.wind, weight: 0.2 },
      { result: results.precip, weight: 0.2 },
      { result: results.cloud, weight: 0.15 },
    ]);
    out.confidence.push(sum);
  }
  return out;
}

/** Daily extremes for a source that only publishes hourly (and 6-hourly) data. */
export function deriveDaily(source, keys, tz) {
  const daily = { key: [], tmax: [], tmin: [], precip: [], windMax: [], gustMax: [], code: [] };
  const h = source.hourly;
  for (const key of keys) {
    const start = keyToStart(key, tz);
    const end = keyToStart(addDays(key, 1), tz);
    const expected = Math.round((end - start) / HOUR);
    let tmax = null, tmin = null, precip = null, windMax = null, gustMax = null;

    if (source.maxPeriods || source.minPeriods) {
      // NWS-style named periods: assign by the local date of the period's midpoint.
      const pick = (periods) => periods?.find((p) => { const mid = (p.start + p.end) / 2; return mid >= start && mid < end; })?.value ?? null;
      tmax = pick(source.maxPeriods);
      tmin = pick(source.minPeriods);
    }

    if (h) {
      const idx = [];
      for (let i = 0; i < h.t.length; i++) if (h.t[i] >= start && h.t[i] < end) idx.push(i);
      const temps = idx.map((i) => h.temp[i]).filter(isNum);
      const hourlyStep = idx.length >= 2 && idx.every((i, k) => k === 0 || h.t[i] - h.t[idx[k - 1]] === HOUR);
      // Only a (nearly) complete day of hourly values gives a trustworthy max/min.
      if (hourlyStep && temps.length >= expected - 2) {
        if (tmax == null) tmax = Math.max(...temps);
        if (tmin == null) tmin = Math.min(...temps);
        const pr = idx.map((i) => h.precip?.[i]).filter(isNum);
        if (pr.length >= expected - 2) precip = pr.reduce((a, b) => a + b, 0);
        const w = idx.map((i) => h.wind?.[i]).filter(isNum);
        if (w.length >= expected - 2) windMax = Math.max(...w);
        const g = idx.map((i) => h.gust?.[i]).filter(isNum);
        if (g.length >= expected - 2) gustMax = Math.max(...g);
      }
    }

    if ((tmax == null || tmin == null) && source.blocks6) {
      // Six-hour blocks on the synoptic hours: use the four whose midpoint falls in this local day.
      const blocks = source.blocks6.filter((b) => b.t % (6 * HOUR) === 0 && b.t + 3 * HOUR >= start && b.t + 3 * HOUR < end);
      if (blocks.length === 4 && blocks.every((b) => isNum(b.tmax) && isNum(b.tmin))) {
        if (tmax == null) tmax = Math.max(...blocks.map((b) => b.tmax));
        if (tmin == null) tmin = Math.min(...blocks.map((b) => b.tmin));
        if (precip == null && blocks.every((b) => isNum(b.precip))) precip = blocks.reduce((s, b) => s + b.precip, 0);
      }
    }

    daily.key.push(key);
    daily.tmax.push(tmax); daily.tmin.push(tmin); daily.precip.push(precip);
    daily.windMax.push(windMax); daily.gustMax.push(gustMax); daily.code.push(null);
  }
  return daily;
}

/** Day-by-day consensus. `prefer` is the source whose daily sky code breaks ties. */
export function buildDaily(sources, keys, tz, prefer = null) {
  const prepared = sources.map((s) => ({ s, daily: s.daily ?? deriveDaily(s, keys, tz) }));
  const days = [];
  for (const key of keys) {
    const pick = (field) => prepared.map(({ s, daily }) => {
      const i = daily.key.indexOf(key);
      return { id: s.id, value: i >= 0 ? daily[field]?.[i] : null };
    });
    const tmax = consensus(pick('tmax'), 'temp');
    const tmin = consensus(pick('tmin'), 'temp');
    const precip = consensus(pick('precip'), 'precipDay');
    const windMax = consensus(pick('windMax'), 'wind');
    const gustMax = consensus(pick('gustMax'), 'gust');

    const codes = prepared.map(({ daily }) => { const i = daily.key.indexOf(key); return i >= 0 ? daily.code?.[i] : null; }).filter(Boolean);
    let preferCode = null;
    if (prefer?.daily) { const i = prefer.daily.key.indexOf(key); preferCode = i >= 0 ? prefer.daily.code[i] : null; }
    const gv = vote(codes.map(condGroup), condGroup(preferCode));
    let code = preferCode;
    if (gv) {
      const inGroup = codes.filter((c) => condGroup(c) === gv.winner);
      code = vote(inGroup, condGroup(preferCode) === gv.winner ? preferCode : null)?.winner ?? preferCode;
    }

    const wetShare = precip ? precip.used.filter((u) => u.value >= 1).length / precip.used.length : null;
    days.push({
      key, start: keyToStart(key, tz), tmax, tmin, precip, windMax, gustMax, code, codeShare: gv ? gv.share : null, wetShare,
      confidence: overall([
        { result: tmax, weight: 0.35 }, { result: tmin, weight: 0.35 }, { result: precip, weight: 0.3 },
      ]),
    });
  }
  return days;
}

/** The ten local dates starting today. */
export function dayKeys(now, tz, count = 10) {
  const first = dateKey(now, tz);
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

/** Sea state now from several wave models (plus any regional service). */
export function buildSea(waveSources, now) {
  const rows = waveSources.map((s) => ({
    id: s.id, name: s.name, short: s.short || s.name, via: s.via,
    values: {
      waveH: valueAt(s.hourly.t, s.hourly.waveH, now, 3 * HOUR),
      wavePeriod: s.hourly.wavePeriod ? valueAt(s.hourly.t, s.hourly.wavePeriod, now, 3 * HOUR) : null,
      waveDir: s.hourly.waveDir ? valueAt(s.hourly.t, s.hourly.waveDir, now, 3 * HOUR, true) : null,
    },
  })).filter((r) => isNum(r.values.waveH));
  const vars = {};
  for (const v of ['waveH', 'wavePeriod', 'waveDir']) {
    vars[v] = consensus(rows.map((r) => ({ id: r.id, value: r.values[v] })), v);
  }
  return { rows, vars, overall: overall([{ result: vars.waveH, weight: 0.6 }, { result: vars.wavePeriod, weight: 0.2 }, { result: vars.waveDir, weight: 0.2 }]) };
}

/** Hourly consensus wave height for charts. */
export function buildSeaHourly(waveSources, now, hours = 120, tz = null) {
  const start = hourStart(now, tz);
  const out = { t: [], value: [], min: [], max: [], n: [] };
  for (let i = 0; i < hours; i++) {
    const T = start + i * HOUR;
    const r = consensus(waveSources.map((s) => ({ id: s.id, value: valueAt(s.hourly.t, s.hourly.waveH, T, 3 * HOUR) })), 'waveH');
    out.t.push(T);
    out.value.push(r ? r.value : null);
    out.min.push(r ? r.min : null);
    out.max.push(r ? r.max : null);
    out.n.push(r ? r.n : 0);
  }
  return out;
}

/**
 * Agreement between independently computed event times (sunrise, moonrise…).
 * @param {{id:string,t:number|null}[]} entries
 */
export function compareTimes(entries) {
  const live = entries.filter((e) => isNum(e.t));
  if (!live.length) return null;
  const center = median(live.map((e) => e.t));
  const maxDiffMin = Math.max(...live.map((e) => Math.abs(e.t - center))) / 60e3;
  let level = 'single';
  if (live.length >= 2) level = maxDiffMin <= 2 ? 'high' : maxDiffMin <= 6 ? 'medium' : 'low';
  return { n: live.length, maxDiffMin, level, entries: live };
}

/** Met Office wording for a three-hour pressure change (hPa). */
export function pressureTendency(delta) {
  if (!isNum(delta)) return null;
  const a = Math.abs(delta);
  const dir = delta > 0 ? 'Rising' : 'Falling';
  if (a < 0.1) return { key: 'steady', label: 'Steady' };
  if (a <= 1.5) return { key: delta > 0 ? 'up' : 'down', label: `${dir} slowly` };
  if (a <= 3.5) return { key: delta > 0 ? 'up' : 'down', label: dir };
  if (a <= 6) return { key: delta > 0 ? 'up' : 'down', label: `${dir} quickly` };
  return { key: delta > 0 ? 'up' : 'down', label: `${dir} very rapidly` };
}

export { VARS, CONDITIONS };
