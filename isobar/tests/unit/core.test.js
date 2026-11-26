import test from 'node:test';
import assert from 'node:assert/strict';
import { median, quantile, angleDiff, circularMean, consensus, overall, valueAt, nearestAt, vote, scoreFromSpread, levelFromScore } from '../../src/lib/consensus.js';
import { zonedParts, zonedToUtc, dateKey, keyToStart, addDays, fmtTime, fmtHour, fmtDuration, fmtRelative, parseIsoDuration, tzOffsetMs, HOUR, DAY } from '../../src/lib/time.js';
import { round, fmt, beaufort, seaState, uvCategory, compass, dewPoint, relHumidity, distanceKm, fmtCoords, fmtWind, escapeHtml } from '../../src/lib/units.js';
import { fromWmo, fromMetNo, fromWwo, fromBrightSky, condGroup, CONDITIONS } from '../../src/lib/conditions.js';
import { aqiCategory } from '../../src/lib/aqi.js';
import { findExtrema, tideState, compareTides, curveFromEvents } from '../../src/lib/tides.js';
import { sourceNow, buildNow, buildHourly, buildDaily, deriveDaily, dayKeys, compareTimes, pressureTendency } from '../../src/lib/model.js';
import { quantity, expandSeries, inNwsCoverage } from '../../src/providers/nws.js';
import { nearestTideStation, kpDescription, geomagneticLatitude, auroraChance } from '../../src/providers/misc.js';
import { inCamsEurope } from '../../src/providers/openmeteo.js';
import { qs, coord } from '../../src/lib/http.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ±${tol}, got ${a}`);

test('median / quantile', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([null, 5, NaN]), 5);
  assert.equal(quantile([0, 10], 0.5), 5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.1), 1.4);
});

test('bearings', () => {
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(350, 10), -20);
  assert.equal(angleDiff(180, 0), 180);
  near(circularMean([350, 10]), 0, 1e-9);
  near(circularMean([90, 180]), 135, 1e-9);
  assert.equal(circularMean([0, 180]), null);
});

test('consensus: tight agreement is high confidence', () => {
  const r = consensus([20, 20.4, 19.8, 20.2, 20.1].map((value, i) => ({ id: `s${i}`, value })), 'temp');
  near(r.value, 20.1, 1e-9);
  assert.equal(r.n, 5);
  assert.equal(r.level, 'high');
  assert.ok(r.score >= 90);
  assert.ok(r.used.every((u) => !u.outlier));
});

test('consensus: one source is never more than "single"', () => {
  const r = consensus([{ id: 'a', value: 12 }], 'temp');
  assert.equal(r.level, 'single');
  assert.equal(r.score, 30);
});

test('consensus: two sources cannot be high', () => {
  const r = consensus([{ id: 'a', value: 12 }, { id: 'b', value: 12 }], 'temp');
  assert.equal(r.level, 'medium');
  assert.equal(r.score, 74);
});

test('consensus: an outlier is dropped, flagged and costs confidence', () => {
  const vals = [20, 20.2, 19.9, 20.1, 20, 27];
  const r = consensus(vals.map((value, i) => ({ id: `s${i}`, value })), 'temp');
  near(r.value, 20, 0.11);
  assert.deepEqual(r.used.filter((u) => u.outlier).map((u) => u.id), ['s5']);
  assert.ok(r.max < 21);
  const clean = consensus(vals.slice(0, 5).map((value, i) => ({ id: `s${i}`, value })), 'temp');
  assert.ok(r.score < clean.score);
});

test('consensus: broad disagreement is low confidence, nothing is hidden as an outlier', () => {
  const r = consensus([14, 17, 20, 23, 26].map((value, i) => ({ id: `s${i}`, value })), 'temp');
  assert.equal(r.level, 'low');
  assert.ok(r.used.every((u) => !u.outlier));
});

test('consensus: split camps are not rated high', () => {
  const r = consensus([20, 20, 20, 24, 25].map((value, i) => ({ id: `s${i}`, value })), 'temp');
  assert.notEqual(r.level, 'high');
});

test('consensus: relative tolerance for wind, circular for direction', () => {
  const strong = consensus([60, 66, 57, 63].map((value, i) => ({ id: `s${i}`, value })), 'wind');
  assert.equal(strong.level, 'high'); // ±3.4 km/h at 60 km/h is tight
  const light = consensus([6, 12, 3, 9].map((value, i) => ({ id: `s${i}`, value })), 'wind');
  assert.notEqual(light.level, 'high');
  const dir = consensus([350, 5, 10, 355].map((value, i) => ({ id: `s${i}`, value })), 'dir');
  near(angleDiff(dir.value, 0), 0, 0.01);
  assert.equal(dir.level, 'high');
});

test('consensus: ignores missing values, null when none', () => {
  assert.equal(consensus([{ id: 'a', value: null }, { id: 'b', value: NaN }], 'temp'), null);
  assert.equal(consensus([{ id: 'a', value: null }, { id: 'b', value: 3 }], 'temp').n, 1);
});

test('score mapping is monotonic and matches documented anchors', () => {
  const tol = { hi: 1, mid: 2.5 };
  assert.equal(scoreFromSpread(0, tol), 100);
  assert.equal(scoreFromSpread(1, tol), 80);
  assert.equal(scoreFromSpread(2.5, tol), 50);
  assert.equal(scoreFromSpread(5, tol), 15);
  assert.equal(scoreFromSpread(50, tol), 5);
  let prev = 101;
  for (let s = 0; s < 12; s += 0.05) { const v = scoreFromSpread(s, tol); assert.ok(v <= prev); prev = v; }
  assert.equal(levelFromScore(80), 'high');
  assert.equal(levelFromScore(79), 'medium');
  assert.equal(levelFromScore(50), 'medium');
  assert.equal(levelFromScore(49), 'low');
});

test('overall roll-up', () => {
  const a = consensus([{ id: 'a', value: 1 }], 'temp');
  assert.equal(overall([{ result: a, weight: 1 }]).level, 'single');
  assert.equal(overall([{ result: null, weight: 1 }]), null);
  const b = consensus([10, 10.1, 9.9].map((value, i) => ({ id: `s${i}`, value })), 'temp');
  const c = consensus([10, 30, 50].map((value, i) => ({ id: `s${i}`, value })), 'wind');
  const o = overall([{ result: b, weight: 1 }, { result: c, weight: 1 }]);
  assert.ok(o.score < b.score && o.score > c.score);
});

test('valueAt / nearestAt / vote', () => {
  const t = [0, HOUR, 2 * HOUR, 8 * HOUR];
  const v = [10, 12, null, 20];
  assert.equal(valueAt(t, v, 0), 10);
  assert.equal(valueAt(t, v, HOUR / 2), 11);
  assert.equal(valueAt(t, v, 1.5 * HOUR), null); // neighbour missing
  assert.equal(valueAt(t, v, 5 * HOUR), null); // 6-hour gap is too wide
  assert.equal(valueAt(t, v, -1), null);
  assert.equal(valueAt(t, v, 9 * HOUR), null);
  assert.equal(valueAt([0, HOUR], [350, 10], HOUR / 2, 3 * HOUR, true), 0);
  assert.equal(valueAt([0, HOUR], [1, 3], HOUR / 2, 0), null); // exact-only mode
  assert.equal(nearestAt([0, HOUR], ['a', 'b'], 0.4 * HOUR), 'a');
  assert.equal(nearestAt([0, 10 * HOUR], ['a', 'b'], 5 * HOUR), null);
  assert.equal(vote(['x', 'y', 'y']).winner, 'y');
  assert.equal(vote(['x', 'y'], 'y').winner, 'y');
  assert.equal(vote([]), null);
});

test('time zones: parts, DST-safe conversion, day keys', () => {
  const t = Date.UTC(2026, 10, 26, 9, 0); // 2026-11-26 09:00Z
  assert.deepEqual({ ...zonedParts(t, 'Asia/Dubai'), weekday: undefined }, { y: 2026, m: 11, d: 26, h: 13, min: 0, s: 0, weekday: undefined });
  assert.equal(dateKey(t, 'America/Los_Angeles'), '2026-11-26');
  assert.equal(dateKey(Date.UTC(2026, 10, 26, 7, 59), 'America/Los_Angeles'), '2026-11-25');
  assert.equal(zonedToUtc(2026, 11, 26, 0, 0, 'Asia/Dubai'), Date.UTC(2026, 10, 25, 20, 0));
  assert.equal(tzOffsetMs(t, 'Asia/Kolkata'), 5.5 * HOUR);
  // US DST ends 2026-11-01: that local day is 25 hours long
  const s = keyToStart('2026-11-01', 'America/New_York');
  const e = keyToStart('2026-11-02', 'America/New_York');
  assert.equal(e - s, 25 * HOUR);
  // EU DST starts 2026-03-29: 23 hours
  assert.equal(keyToStart('2026-03-30', 'Europe/Berlin') - keyToStart('2026-03-29', 'Europe/Berlin'), 23 * HOUR);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(fmtTime(t, 'Asia/Dubai'), '13:00');
  assert.match(fmtTime(t, 'Asia/Dubai', true), /^1:00.pm$/i);
  assert.equal(fmtHour(Date.UTC(2026, 10, 26, 20, 0), 'Asia/Dubai'), '00');
  assert.match(fmtHour(Date.UTC(2026, 10, 26, 20, 0), 'Asia/Dubai', true), /^12.am$/);
  assert.equal(fmtDuration(10 * HOUR + 45 * 60e3), '10 h 45 min');
  assert.equal(fmtRelative(25 * 60e3, 0), 'in 25 min');
  assert.equal(fmtRelative(-3 * HOUR, 0), '3 h ago');
  assert.equal(parseIsoDuration('PT3H'), 3 * HOUR);
  assert.equal(parseIsoDuration('P2DT23H'), 71 * HOUR);
  assert.equal(parseIsoDuration('P1D'), DAY);
  assert.equal(parseIsoDuration('nonsense'), null);
});

test('units and scales', () => {
  assert.equal(round(-0.4), 0);
  assert.equal(fmt(-0.4), '0');
  assert.equal(fmt(-3.26, 1), '−3.3');
  assert.equal(fmt(null), '—');
  assert.equal(beaufort(0).force, 0);
  assert.equal(beaufort(5).force, 1);     // 1.4 m/s
  assert.equal(beaufort(6).force, 2);     // 1.7 m/s
  assert.equal(beaufort(30).force, 5);    // 8.3 m/s
  assert.equal(beaufort(62).force, 8);    // 17.2 m/s
  assert.equal(beaufort(118).force, 12);  // 32.8 m/s
  assert.equal(beaufort(200).label, 'Hurricane force');
  assert.equal(seaState(0.3).label, 'Smooth');
  assert.equal(seaState(1.25).label, 'Slight');
  assert.equal(seaState(3).label, 'Rough');
  assert.equal(seaState(20).label, 'Phenomenal');
  assert.equal(uvCategory(2.4).label, 'Low');
  assert.equal(uvCategory(2.6).label, 'Moderate');
  assert.equal(uvCategory(7.6).label, 'Very high');
  assert.equal(uvCategory(11).label, 'Extreme');
  assert.equal(compass(0), 'N');
  assert.equal(compass(348.8), 'N');
  assert.equal(compass(225), 'SW');
  assert.equal(compass(-90), 'W');
  near(dewPoint(20, 50), 9.26, 0.1);
  near(relHumidity(20, 9.26), 50, 0.3);
  near(distanceKm(51.5074, -0.1278, 48.8566, 2.3522), 343.6, 1.5, 'London–Paris');
  assert.equal(fmtCoords(37.7749, -122.4194), '37°46′N 122°25′W');
  assert.equal(fmtCoords(-33.9999, 18.0), '34°00′S 18°00′E');
  assert.equal(fmtWind(36, 'ms'), '10.0');
  assert.equal(fmtWind(36, 'kmh'), '36');
  assert.equal(escapeHtml('<b a="1">&\'</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;');
});

test('condition code mappings cover each provider', () => {
  for (const code of [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]) {
    assert.ok(CONDITIONS[fromWmo(code)], `WMO ${code}`);
  }
  assert.equal(fromWmo(42), null);
  const metno = ['clearsky_day', 'fair_night', 'partlycloudy_polartwilight', 'cloudy', 'fog', 'lightrain', 'rain', 'heavyrain', 'lightrainshowers_day', 'rainshowers_night', 'heavyrainshowers_day', 'lightsleet', 'sleet', 'heavysleet', 'sleetshowers_day', 'lightsnow', 'snow', 'heavysnow', 'snowshowers_day', 'lightsnowshowers_night', 'rainandthunder', 'heavyrainshowersandthunder_day', 'lightssleetshowersandthunder_day', 'lightssnowshowersandthunder_night', 'snowandthunder', 'heavysleetandthunder'];
  for (const s of metno) assert.ok(CONDITIONS[fromMetNo(s)], `metno ${s}`);
  assert.equal(fromMetNo('heavyrain'), 'rain_heavy');
  assert.equal(fromMetNo('lightsnowshowers_day'), 'snow_showers');
  assert.equal(fromMetNo('rainandthunder'), 'thunder');
  assert.equal(fromMetNo(undefined), null);
  for (const code of [113, 116, 119, 122, 143, 176, 179, 182, 185, 200, 227, 230, 248, 260, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 317, 320, 323, 326, 329, 332, 335, 338, 350, 353, 356, 359, 362, 365, 368, 371, 374, 377, 386, 389, 392, 395]) {
    assert.ok(CONDITIONS[fromWwo(String(code))], `WWO ${code}`);
  }
  for (const icon of ['clear-day', 'clear-night', 'partly-cloudy-day', 'partly-cloudy-night', 'cloudy', 'fog', 'rain', 'sleet', 'snow', 'hail', 'thunderstorm']) {
    assert.ok(CONDITIONS[fromBrightSky(icon)], icon);
  }
  assert.equal(fromBrightSky('wind'), null);
  assert.equal(condGroup('showers_heavy'), 'rain');
});

test('AQI categories', () => {
  assert.equal(aqiCategory(50, 'us').label, 'Good');
  assert.equal(aqiCategory(51, 'us').label, 'Moderate');
  assert.equal(aqiCategory(129, 'us').label, 'Unhealthy for sensitive groups');
  assert.equal(aqiCategory(180, 'us').label, 'Unhealthy');
  assert.equal(aqiCategory(420, 'us').label, 'Hazardous');
  assert.equal(aqiCategory(20, 'eu').label, 'Good');
  assert.equal(aqiCategory(57, 'eu').label, 'Moderate');
  assert.equal(aqiCategory(140, 'eu').label, 'Extremely poor');
  assert.equal(aqiCategory(null), null);
});

test('tide extrema: recovers known highs and lows from a rounded 15-minute series', () => {
  // Semidiurnal (M2 12.42 h) + diurnal (K1 23.93 h) mix, rounded to the centimetre like the real data.
  const step = 15 * 60e3;
  const f = (t) => 1.1 * Math.cos((2 * Math.PI * t) / (12.4206 * HOUR)) + 0.4 * Math.cos((2 * Math.PI * t) / (23.9345 * HOUR) - 1);
  const times = [], heights = [];
  for (let t = 0; t <= 4 * DAY; t += step) { times.push(t); heights.push(Math.round(f(t) * 100) / 100); }
  const found = findExtrema(times, heights);
  // truth by dense scan
  const truth = [];
  const fine = 30e3;
  for (let t = fine; t < 4 * DAY - fine; t += fine) {
    const a = f(t - fine), b = f(t), c = f(t + fine);
    if (b > a && b >= c) truth.push({ t, h: b, type: 'H' });
    if (b < a && b <= c) truth.push({ t, h: b, type: 'L' });
  }
  const inner = truth.filter((e) => e.t > HOUR && e.t < 4 * DAY - HOUR);
  assert.ok(found.length >= inner.length && found.length <= truth.length + 1, `count ${found.length} vs ${inner.length}`);
  for (const e of inner) {
    const m = found.find((x) => x.type === e.type && Math.abs(x.t - e.t) < HOUR);
    assert.ok(m, `missing ${e.type} at ${e.t / HOUR}h`);
    assert.ok(Math.abs(m.t - e.t) <= 8 * 60e3, `time error ${(m.t - e.t) / 60e3} min`);
    near(m.h, e.h, 0.02, 'height');
  }
  for (let i = 1; i < found.length; i++) assert.notEqual(found[i].type, found[i - 1].type, 'highs and lows alternate');
});

test('tide extrema: flat or empty series produce no events', () => {
  const times = Array.from({ length: 50 }, (_, i) => i * 900e3);
  assert.deepEqual(findExtrema(times, times.map(() => 0.5)), []);
  assert.deepEqual(findExtrema(times, times.map(() => null)), []);
  assert.deepEqual(findExtrema([], []), []);
});

test('tide state, interpolated curve and comparison', () => {
  const ev = [{ t: 0, h: -1, type: 'L' }, { t: 6 * HOUR, h: 1, type: 'H' }, { t: 12 * HOUR, h: -1, type: 'L' }];
  const s = tideState(ev, 3 * HOUR);
  assert.equal(s.rising, true);
  near(s.height, 0, 1e-9);
  near(s.progress, 0.5, 1e-9);
  assert.equal(tideState(ev, 7 * HOUR).rising, false);
  assert.equal(tideState(ev, 13 * HOUR), null);
  const c = curveFromEvents(ev, 0, 12 * HOUR, HOUR);
  near(c.h[c.t.indexOf(6 * HOUR)], 1, 1e-9);
  const shifted = ev.map((e) => ({ ...e, t: e.t + 12 * 60e3, h: e.h * 0.9 + 0.3 })); // other datum, 12 min late, 10% smaller
  const cmp = compareTides(ev, shifted, 0, 12 * HOUR);
  assert.equal(cmp.matched, 3);
  near(cmp.timeDiffMin, 12, 1e-6);
  near(cmp.rangeRatio, 0.9, 1e-9);
  assert.equal(cmp.level, 'high');
  const bad = ev.map((e) => ({ ...e, t: e.t + 100 * 60e3, h: e.h * 0.3 }));
  assert.equal(compareTides(ev, bad, 0, 12 * HOUR).level, 'low');
  assert.equal(compareTides(ev, [], 0, 12 * HOUR).level, 'single');
});

function fakeSource(id, base, opts = {}) {
  const t = Array.from({ length: 72 }, (_, i) => i * HOUR);
  const wave = (i) => base + 5 * Math.sin(((i - 9) / 24) * 2 * Math.PI);
  return {
    id, name: id, short: id, kind: 'model', via: 'test',
    hourly: {
      t, temp: t.map((_, i) => wave(i)), feels: t.map((_, i) => wave(i) - 1), rh: t.map(() => 50 + (opts.rh || 0)), dew: null,
      wind: t.map(() => 10 + (opts.wind || 0)), gust: t.map(() => 20), dir: t.map(() => 270), pressure: t.map(() => 1015),
      cloud: t.map(() => 40), precip: t.map(() => opts.precip ?? 0), pop: null, code: t.map(() => opts.code || 'partly_cloudy'),
    },
    daily: opts.daily ?? null,
  };
}

test('model: now, hourly and daily consensus from several sources', () => {
  const sources = [fakeSource('a', 20), fakeSource('b', 20.5), fakeSource('c', 19.5), fakeSource('d', 20.2, { code: 'cloudy' })];
  const now = 12.5 * HOUR;
  const n = buildNow(sources, [], now, 'partly_cloudy');
  assert.equal(n.count, 4);
  assert.equal(n.vars.temp.level, 'high');
  near(n.vars.temp.value, (sourceNow(sources[0], now).temp + sourceNow(sources[3], now).temp) / 2, 0.01);
  assert.equal(n.condition.code, 'partly_cloudy');
  near(n.condition.vote.share, 0.75, 1e-9);
  assert.ok(n.vars.dew.value < n.vars.temp.value, 'dew point derived from T and RH');
  assert.equal(n.overall.level, 'high');

  const withObs = buildNow(sources, [
    { id: 'obs', name: 'Station', kind: 'observation', now: { t: now - 10 * 60e3, temp: 20.3, wind: 12 }, meta: { distanceKm: 4 } },
    { id: 'far', name: 'Far', kind: 'observation', now: { t: now, temp: 5 }, meta: { distanceKm: 300 } },
    { id: 'old', name: 'Old', kind: 'observation', now: { t: now - 5 * HOUR, temp: 5 }, meta: { distanceKm: 1 } },
  ], now);
  assert.equal(withObs.count, 5, 'only the near, fresh station joins');

  const h = buildHourly(sources, now, 24, { popSeries: [{ t: sources[0].hourly.t, values: sources[0].hourly.t.map(() => 30) }] });
  assert.equal(h.t[0], 12 * HOUR);
  assert.equal(h.temp.n[0], 4);
  assert.equal(h.temp.level[0], 'high');
  assert.equal(h.code[0], 'partly_cloudy');
  assert.equal(h.pop[0], 30);
  assert.equal(h.precip.value[0], 0);

  const tz = 'UTC';
  const keys = ['1970-01-01', '1970-01-02', '1970-01-03'];
  const d = deriveDaily(sources[0], keys, tz);
  near(d.tmax[0], 25, 0.01);
  near(d.tmin[0], 15, 0.2);
  assert.equal(d.precip[0], 0);
  const days = buildDaily(sources, keys, tz);
  assert.equal(days.length, 3);
  assert.equal(days[0].tmax.n, 4);
  assert.equal(days[0].confidence.level, 'high');
  assert.deepEqual(dayKeys(0, 'UTC', 3), keys);
});

test('model: partial days are not turned into daily extremes', () => {
  const s = fakeSource('a', 20);
  s.hourly.t = s.hourly.t.slice(14); // starts 14:00 on day one
  for (const k of Object.keys(s.hourly)) if (Array.isArray(s.hourly[k]) && k !== 't') s.hourly[k] = s.hourly[k].slice(14);
  const d = deriveDaily(s, ['1970-01-01', '1970-01-02'], 'UTC');
  assert.equal(d.tmax[0], null);
  assert.notEqual(d.tmax[1], null);
});

test('model: six-hour blocks and named periods', () => {
  const blocks6 = [0, 6, 12, 18].map((hh) => ({ t: 3 * DAY + hh * HOUR, tmax: 10 + hh / 2, tmin: 5 + hh / 6, precip: 1 }));
  const d = deriveDaily({ hourly: { t: [], temp: [] }, blocks6 }, ['1970-01-04'], 'UTC');
  assert.equal(d.tmax[0], 19);
  assert.equal(d.tmin[0], 5);
  assert.equal(d.precip[0], 4);
  const p = deriveDaily({ hourly: null, maxPeriods: [{ start: 15 * HOUR, end: 28 * HOUR, value: 17.8 }], minPeriods: [{ start: -5 * HOUR, end: 9 * HOUR, value: 11.1 }] }, ['1970-01-01'], 'UTC');
  assert.equal(p.tmax[0], 17.8);
  assert.equal(p.tmin[0], 11.1);
});

test('model: time comparison and pressure wording', () => {
  assert.equal(compareTimes([{ id: 'a', t: 0 }, { id: 'b', t: 60e3 }]).level, 'high');
  assert.equal(compareTimes([{ id: 'a', t: 0 }, { id: 'b', t: 8 * 60e3 }, { id: 'c', t: 0 }]).level, 'low');
  assert.equal(compareTimes([{ id: 'a', t: 0 }, { id: 'b', t: null }]).level, 'single');
  assert.equal(compareTimes([]), null);
  assert.equal(pressureTendency(0.05).label, 'Steady');
  assert.equal(pressureTendency(-1.0).label, 'Falling slowly');
  assert.equal(pressureTendency(2.0).label, 'Rising');
  assert.equal(pressureTendency(-4).label, 'Falling quickly');
  assert.equal(pressureTendency(7).label, 'Rising very rapidly');
});

test('NWS quantities and series expansion', () => {
  assert.equal(quantity({ unitCode: 'wmoUnit:degC', value: 12 }), 12);
  near(quantity({ unitCode: 'wmoUnit:degF', value: 53.6 }), 12, 1e-9);
  assert.equal(quantity({ unitCode: 'wmoUnit:Pa', value: 101325 }), 1013.25);
  near(quantity({ unitCode: 'wmoUnit:m_s-1', value: 10 }), 36, 1e-9);
  assert.equal(quantity({ unitCode: 'wmoUnit:furlong', value: 1 }), null);
  assert.equal(quantity({ unitCode: 'wmoUnit:degC', value: null }), null);
  const m = expandSeries({ uom: 'wmoUnit:km_h-1', values: [{ validTime: '2026-11-26T01:00:00+00:00/PT3H', value: 7.4 }, { validTime: '2026-11-26T04:00:00+00:00/PT1H', value: 5.5 }] });
  assert.equal(m.size, 4);
  assert.equal(m.get(Date.UTC(2026, 10, 26, 3)), 7.4);
  assert.equal(m.get(Date.UTC(2026, 10, 26, 4)), 5.5);
  assert.equal(inNwsCoverage(37.77, -122.42), true);
  assert.equal(inNwsCoverage(21.3, -157.8), true);
  assert.equal(inNwsCoverage(25.2, 55.27), false);
  assert.equal(inCamsEurope(52.5, 13.4), true);
  assert.equal(inCamsEurope(25.2, 55.27), false);
});

test('tide station lookup, space weather helpers, URL building', () => {
  const index = { stations: [['1', 'Near', 'CA', 37.80, -122.46, 'R'], ['2', 'Nearer', 'CA', 37.78, -122.43, 'S'], ['3', 'Far', 'HI', 21, -157, 'R']] };
  assert.equal(nearestTideStation(index, 37.77, -122.42).id, '2');
  assert.equal(nearestTideStation(index, 0, 0), null);
  assert.equal(kpDescription(5).g, 'G1');
  assert.equal(kpDescription(7.33).g, 'G3');
  assert.equal(kpDescription(2).label, 'Quiet');
  near(geomagneticLatitude(80.8, -72.7), 90, 1e-6);
  assert.ok(geomagneticLatitude(69.65, 18.96) > 66 && geomagneticLatitude(69.65, 18.96) < 68, 'Tromsø is about 67° geomagnetic');
  assert.equal(auroraChance(3, 67).key, 'likely');
  assert.equal(auroraChance(1, 25).key, 'no');
  assert.equal(qs({ a: 1, b: ['x', 'y'], c: null, d: 'p q' }), 'a=1&b=x,y&d=p%20q');
  assert.equal(coord(37.77491), '37.775');
  assert.equal(coord(-0.0004), '0.000');
});
