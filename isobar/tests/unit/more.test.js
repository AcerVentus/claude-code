import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeDimension, wmsTime, ALL_LAYERS, OVERLAYS } from '../../src/lib/layers.js';
import { mood, quip, PERSONALITIES } from '../../src/lib/snark.js';
import { sunDay, moonNow, moonDay, moonQuarters, moonApsides, phaseName, tideCycle, lightPhase, position } from '../../src/lib/astro.js';
import { skyStops } from '../../src/ui/sky.js';
import { derive } from '../../src/engine.js';
import { HOUR, DAY } from '../../src/lib/time.js';

test('WMS time dimensions: ranges, lists and mixtures', () => {
  assert.deepEqual(parseTimeDimension('2026-11-26T00:00:00Z/2026-11-26T09:00:00Z/PT3H').map(wmsTime), ['2026-11-26T00:00:00Z', '2026-11-26T03:00:00Z', '2026-11-26T06:00:00Z', '2026-11-26T09:00:00Z']);
  assert.equal(parseTimeDimension('2026-11-26T00:00:00Z,2026-11-26T01:00:00Z,2026-11-26T01:00:00Z').length, 2);
  assert.equal(parseTimeDimension('2026-11-26T00:00:00Z/2026-11-27T00:00:00Z/PT1H,2026-11-27T03:00:00Z/2026-11-28T00:00:00Z/PT3H').length, 25 + 8);
  assert.equal(parseTimeDimension('2025-03-01T00:00:00Z/2025-06-01T00:00:00Z/P1D').length, 93);
  assert.deepEqual(parseTimeDimension(''), []);
  assert.deepEqual(parseTimeDimension('garbage/also/PT0H'), []);
});

test('layer catalogue is well formed', () => {
  const ids = new Set();
  for (const l of ALL_LAYERS) {
    assert.ok(!ids.has(l.id), `duplicate ${l.id}`); ids.add(l.id);
    assert.ok(l.name && l.desc && l.source, l.id);
    if (l.kind === 'wms') { assert.ok(l.layer && l.style, l.id); assert.ok(l.probe || l.wind || l.vector, `${l.id} has a way to read a value`); assert.ok(Array.isArray(l.valid), `${l.id} valid range`); }
    else if (l.kind === 'gibs') assert.ok(l.layer && l.level && l.ext && l.time, l.id);
    else assert.equal(l.kind, 'radar');
  }
  for (const want of ['cloud', 'thunder', 'cape', 'snowdepth', 'waves', 'currents', 'rootzone']) assert.ok(ids.has(want), want);
  assert.equal(OVERLAYS.length, 2);
  // converted readings stay metric
  const by = Object.fromEntries(ALL_LAYERS.map((l) => [l.id, l]));
  assert.equal(by.pressure.probe(101325).text, '1013 hPa');
  assert.equal(by.rain.probe(0.001).text, '3.6 mm/h');
  assert.equal(by.snowdepth.probe(0.35).text, '35 cm');
  assert.equal(by.temp.probe(-3.26).text, '-3.3 °C');
});

test('forecaster lines: every mood has every voice, and moods follow the conditions', () => {
  const base = { code: 'clear', group: 'clear', feels: 20, gust: 10, dew: 10, aqi: 20, uv: 2, isDay: true };
  assert.equal(mood(base), 'clear_day');
  assert.equal(mood({ ...base, isDay: false }), 'clear_night');
  assert.equal(mood({ ...base, group: 'thunder' }), 'thunder');
  assert.equal(mood({ ...base, code: 'rain_heavy', group: 'rain' }), 'heavy_rain');
  assert.equal(mood({ ...base, group: 'rain', code: 'rain' }), 'rain');
  assert.equal(mood({ ...base, group: 'snow' }), 'snow');
  assert.equal(mood({ ...base, feels: 44 }), 'very_hot');
  assert.equal(mood({ ...base, feels: -20 }), 'bitter');
  assert.equal(mood({ ...base, gust: 75 }), 'windy');
  assert.equal(mood({ ...base, aqi: 160 }), 'bad_air');
  assert.equal(mood({ ...base, feels: 35 }), 'hot');
  assert.equal(mood({ ...base, feels: 1 }), 'cold');
  assert.equal(mood({ ...base, group: 'fog' }), 'fog');
  assert.equal(mood({ ...base, dew: 24 }), 'humid');
  assert.equal(mood({ ...base, uv: 9 }), 'uv');
  assert.equal(mood({ ...base, uv: 9, isDay: false }), 'clear_night');
  assert.equal(mood({ ...base, group: 'cloudy' }), 'cloudy');
  assert.equal(mood({ ...base, group: 'partly' }), 'partly');
  assert.equal(mood({ group: 'clear', isDay: true }), 'clear_day', 'missing numbers do not trigger a mood');
  for (const group of ['thunder', 'rain', 'snow', 'fog', 'cloudy', 'partly', 'clear']) {
    for (const p of PERSONALITIES) {
      for (const isDay of [true, false]) {
        const line = quip({ ...base, group, code: group, isDay }, p.key, 3);
        assert.ok(typeof line === 'string' && line.length > 8, `${group}/${p.key}`);
      }
    }
  }
  assert.equal(quip(base, 'dry', 5), quip(base, 'dry', 5), 'stable for the same seed');
  assert.ok(quip(base, 'no-such-voice', 0).length > 0);
});

test('astronomy: fixed cases with published answers', () => {
  // London, summer solstice 2025: sunrise 04:43 BST, sunset 21:21 BST (HM Nautical Almanac Office)
  const start = Date.UTC(2025, 5, 20, 23, 0), end = start + DAY;
  const s = sunDay(start, end, 51.5074, -0.1278);
  assert.ok(Math.abs(s.sunrise - Date.UTC(2025, 5, 21, 3, 43)) < 2 * 60e3, `sunrise ${new Date(s.sunrise).toISOString()}`);
  assert.ok(Math.abs(s.sunset - Date.UTC(2025, 5, 21, 20, 21)) < 2 * 60e3, `sunset ${new Date(s.sunset).toISOString()}`);
  assert.ok(Math.abs(s.noonAltitude - 61.9) < 0.3);
  assert.ok(s.civilDawn < s.sunrise && s.sunrise < s.goldenMorningEnd && s.goldenMorningEnd < s.solarNoon);
  assert.ok(s.solarNoon < s.goldenEveningStart && s.goldenEveningStart < s.sunset && s.sunset < s.civilDusk);
  assert.equal(s.astroDawn, null, 'no astronomical darkness in London at midsummer');
  // Tromsø: midnight sun in June, polar night in December
  assert.equal(sunDay(Date.UTC(2025, 5, 20, 22, 0), Date.UTC(2025, 5, 21, 22, 0), 69.65, 18.96).polar, 'day');
  const polar = sunDay(Date.UTC(2025, 11, 20, 23, 0), Date.UTC(2025, 11, 21, 23, 0), 69.65, 18.96);
  assert.equal(polar.polar, 'night');
  assert.equal(polar.dayLength, 0);
  // Total lunar eclipse of 2025-09-07 18:11 UTC = full Moon; new Moon 2025-09-21 19:54 UTC
  const full = moonNow(Date.UTC(2025, 8, 7, 18, 9), 0, 0);
  assert.ok(Math.abs(full.phaseDeg - 180) < 0.2 && full.illumination > 0.999 && full.name === 'Full Moon');
  const nw = moonNow(Date.UTC(2025, 8, 21, 19, 54), 0, 0);
  assert.ok(Math.min(nw.phaseDeg, 360 - nw.phaseDeg) < 0.2 && nw.illumination < 0.001 && nw.name === 'New Moon');
  assert.ok(nw.distanceKm > 356000 && nw.distanceKm < 407000);
  const q = moonQuarters(Date.UTC(2025, 8, 1), 4);
  assert.deepEqual(q.map((x) => x.quarter), [2, 3, 0, 1]);
  assert.ok(Math.abs(q[0].time - Date.UTC(2025, 8, 7, 18, 9)) < 3 * 60e3);
  assert.ok(Math.abs(q[2].time - Date.UTC(2025, 8, 21, 19, 54)) < 3 * 60e3);
  const ap = moonApsides(Date.UTC(2025, 8, 1));
  assert.ok(ap.perigee.distanceKm < 370000 && ap.apogee.distanceKm > 404000);
  assert.equal(phaseName(45), 'Waxing Crescent');
  assert.equal(phaseName(95), 'First Quarter');
  assert.equal(phaseName(200), 'Waning Gibbous');
  assert.equal(phaseName(355), 'New Moon');
  assert.equal(tideCycle(5).key, 'spring');
  assert.equal(tideCycle(185).key, 'spring');
  assert.equal(tideCycle(92).key, 'neap');
  assert.equal(tideCycle(45).key, 'mid');
  assert.equal(lightPhase(30, true), 'day');
  assert.equal(lightPhase(2, false), 'sunset');
  assert.equal(lightPhase(-3, true), 'dawn');
  assert.equal(lightPhase(-30, true), 'night');
});

test('astronomy: the Moon is drawn the right way round', () => {
  // Waxing crescent, evening, western sky from 40°N: the lit limb points down and to the right,
  // i.e. 180°–270° anticlockwise from "up". (2025-09-25 01:30 UTC is 19:30 on the 24th in Denver, half an hour after sunset.)
  const eve = moonNow(Date.UTC(2025, 8, 25, 1, 30), 39.74, -104.99);
  assert.ok(eve.waxing && eve.illumination < 0.2 && eve.altitude > 0 && eve.azimuth > 180, JSON.stringify(eve));
  assert.ok(eve.limbFromZenith > 180 && eve.limbFromZenith < 270, `limb ${eve.limbFromZenith}`);
  // Same instant from 40°S the crescent is mirrored: lit limb down and to the left.
  const south = moonNow(Date.UTC(2025, 8, 24, 8, 0), -37.81, 144.96); // 18:00 in Melbourne
  assert.ok(south.altitude > 0 && south.limbFromZenith > 90 && south.limbFromZenith < 180, `southern limb ${south.limbFromZenith} alt ${south.altitude}`);
  // The Moon's north pole is roughly "up" for a northern observer when it is due south, and "down" for a southern one.
  const merid = moonDay(Date.UTC(2025, 8, 7, 0, 0), Date.UTC(2025, 8, 8, 0, 0), 51.5, 0);
  assert.ok(merid.rise != null && merid.set != null);
  const pos = position('sun', Date.UTC(2025, 2, 20, 12, 0), 0, 0); // equinox noon on the equator
  assert.ok(pos.altitude > 85);
});

test('sky palette: valid colours for every phase and cloud amount', () => {
  for (const phase of ['day', 'sunrise', 'sunset', 'dawn', 'dusk', 'nautical', 'astronomical', 'night', 'unknown']) {
    for (const cloud of [0, 50, 100]) {
      for (const group of [null, 'rain', 'thunder']) {
        const stops = skyStops(phase, cloud, group);
        assert.equal(stops.length, 3);
        stops.forEach((c) => assert.match(c, /^rgb\(\d+,\d+,\d+\)$/));
      }
    }
  }
});

test('engine: derive survives having nothing but a place, and builds a view from a single source', () => {
  const place = { name: 'Nowhere', lat: 10, lon: 20, tz: 'UTC' };
  const empty = derive({ raw: {}, place, tz: 'UTC' });
  assert.equal(empty.current, undefined);
  assert.ok(empty.astro.sun && empty.astro.moon, 'sun and moon need no network');
  assert.deepEqual(empty.alerts, []);
  const start = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  const t = Array.from({ length: 80 }, (_, i) => start + i * HOUR);
  const col = (v) => t.map(() => v);
  const one = { id: 'metno', name: 'MET Norway', short: 'MET Norway', kind: 'service', via: 'x', hourly: { t, temp: col(12), feels: col(null), rh: col(60), dew: col(4), wind: col(10), gust: col(null), dir: col(200), pressure: col(1010), cloud: col(50), precip: col(0), pop: col(null), code: col('cloudy') }, blocks6: [], daily: null };
  const v = derive({ raw: { metno: { source: one } }, place, tz: 'UTC' });
  assert.equal(v.current.vars.temp.value, 12);
  assert.equal(v.current.vars.temp.level, 'single');
  assert.equal(v.current.overall.level, 'single', 'one source is never reported as verified');
  assert.equal(v.hourly.temp.n[0], 1);
  assert.equal(v.days.length, 10);
});

test('service worker pre-caches every file the page loads', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url);
  const sw = readFileSync(new URL('sw.js', root), 'utf8');
  const listed = new Set([...sw.matchAll(/'([^']+\.(?:js|css|json|woff2|svg|html|webmanifest))'/g)].map((m) => m[1]));
  const need = ['index.html', 'css/app.css', 'manifest.webmanifest', 'data/noaa-tide-stations.json', 'assets/icon.svg'];
  for (const dir of ['src', 'src/lib', 'src/providers', 'src/ui', 'vendor']) {
    for (const f of readdirSync(new URL(`${dir}/`, root))) if (f.endsWith('.js') || f.endsWith('.css')) need.push(`${dir}/${f}`);
  }
  for (const f of readdirSync(new URL('assets/fonts/', root))) if (f.endsWith('.woff2')) need.push(`assets/fonts/${f}`);
  for (const f of need) assert.ok(listed.has(f), `sw.js is missing ${f}`);
  for (const f of listed) assert.doesNotThrow(() => readFileSync(new URL(f, root)), `sw.js lists ${f}, which does not exist`);
});

// ---- regressions for defects found in review

test('half-hour time zones: hourly rain and its chance survive (Asia/Kolkata, Asia/Kathmandu)', async () => {
  const { buildHourly } = await import('../../src/lib/model.js');
  const { hourStart, zonedParts } = await import('../../src/lib/time.js');
  for (const [tz, offMin] of [['Asia/Kolkata', 330], ['Asia/Kathmandu', 345], ['America/St_Johns', -210], ['UTC', 0]]) {
    const now = Date.UTC(2026, 10, 26, 9, 17);
    const start = hourStart(now, tz);
    assert.equal(zonedParts(start, tz).min, 0, `${tz}: grid starts on a local hour`);
    assert.ok(start <= now && now - start < HOUR);
    // Open-Meteo style: samples on local hours. MET Norway style: samples on UTC hours.
    const local = Array.from({ length: 60 }, (_, i) => start - 3 * HOUR + i * HOUR);
    const utc = Array.from({ length: 60 }, (_, i) => Math.floor(now / HOUR) * HOUR - 3 * HOUR + i * HOUR);
    const mk = (id, t, rain) => ({ id, hourly: { t, temp: t.map(() => 20), feels: null, rh: null, dew: null, wind: t.map(() => 10), gust: null, dir: null, pressure: null, cloud: t.map(() => 50), precip: t.map(() => rain), pop: null, code: t.map(() => 'rain') } });
    const sources = [mk('a', local, 5), mk('b', local, 5), mk('c', local, 5), mk('utc', utc, 0)];
    const h = buildHourly(sources, now, 24, { tz, popSeries: [{ t: local, values: local.map(() => 80) }] });
    assert.equal(h.t[0], start);
    assert.equal(h.precip.value[0], 5, `${tz}: rain consensus comes from the models, not from the lone UTC-hour source`);
    assert.ok(h.precip.n[0] >= 3, `${tz}: ${h.precip.n[0]} rain sources`);
    assert.equal(h.pop[0], 80, `${tz}: chance of rain present`);
    assert.equal(h.temp.n[0], 4, `${tz}: instantaneous values still use every source`);
    assert.equal(offMin % 60 === 0 ? h.precip.n[0] : 3, h.precip.n[0]);
  }
});

test('daily rows keep their dates across a clock change (Sydney, April 2026)', async () => {
  const { dailyKeys } = await import('../../src/providers/openmeteo.js');
  // Open-Meteo stamps every row with the offset in force when asked (+11 h here); DST ends on 5 April.
  const stamps = [3, 4, 5, 6, 7, 8].map((d) => Date.UTC(2026, 3, d, 0, 0) / 1000 - 11 * 3600);
  assert.deepEqual(dailyKeys(stamps, 'Australia/Sydney'), ['2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-07', '2026-04-08']);
  // and the other way round: asked in winter (+10 h), window crossing into summer time on 4 October
  const spring = [2, 3, 4, 5, 6].map((d) => Date.UTC(2026, 9, d, 0, 0) / 1000 - 10 * 3600);
  assert.deepEqual(dailyKeys(spring, 'Australia/Sydney'), ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
});

test('polar boundary: a Sun that never clears the horizon is polar night, not midnight sun', () => {
  // Tromsø, 28 November 2026: no sunrise; the refracted noon Sun sits just below the horizon.
  const s = sunDay(Date.UTC(2026, 10, 27, 23, 0), Date.UTC(2026, 10, 28, 23, 0), 69.65, 18.96);
  assert.equal(s.sunrise, null);
  assert.equal(s.polar, 'night');
  assert.equal(s.dayLength, 0);
  assert.ok(s.noonAltitude > -0.833 && s.noonAltitude < 0, `refracted noon altitude ${s.noonAltitude}`);
  const jan = sunDay(Date.UTC(2027, 0, 13, 23, 0), Date.UTC(2027, 0, 14, 23, 0), 69.65, 18.96);
  assert.equal(jan.polar, 'night');
});

test('high latitudes: a sunset after midnight still belongs to its day', () => {
  // Tromsø, 17 May 2026 (CEST, UTC+2): the Sun sets shortly after local midnight.
  const start = Date.UTC(2026, 4, 16, 22, 0), end = Date.UTC(2026, 4, 17, 22, 0);
  const s = sunDay(start, end, 69.65, 18.96);
  assert.ok(s.sunrise != null && s.sunset != null, JSON.stringify(s));
  assert.ok(s.sunset > s.sunrise && s.sunset >= end && s.sunsetNextDay);
  assert.ok(s.dayLength > 22 * HOUR && s.dayLength < 24 * HOUR);
});

test('clock changes at midnight: the day starts at its first real instant', async () => {
  const { keyToStart, zonedToUtc, dateKey } = await import('../../src/lib/time.js');
  // Santiago springs forward at 00:00 → 01:00 on 6 September 2026: midnight does not exist.
  const santiago = keyToStart('2026-09-06', 'America/Santiago');
  assert.equal(dateKey(santiago, 'America/Santiago'), '2026-09-06');
  assert.equal(dateKey(santiago - 1, 'America/Santiago'), '2026-09-05');
  // Havana falls back at 01:00 → 00:00 on 1 November 2026: midnight happens twice; take the first.
  const havana = keyToStart('2026-11-01', 'America/Havana');
  assert.equal(dateKey(havana, 'America/Havana'), '2026-11-01');
  assert.equal(dateKey(havana - 1, 'America/Havana'), '2026-10-31');
  // an ordinary ambiguous hour resolves to its first occurrence
  assert.equal(zonedToUtc(2026, 11, 1, 1, 30, 'America/New_York'), Date.UTC(2026, 10, 1, 5, 30));
  // and every day in a year still has a start strictly after the previous one
  for (const tz of ['America/Santiago', 'America/Havana', 'Australia/Lord_Howe', 'Europe/London', 'Asia/Tehran']) {
    let prev = keyToStart('2026-01-01', tz);
    for (let d = 1; d < 366; d++) {
      const key = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
      const t = keyToStart(key, tz);
      assert.ok(t - prev >= 23 * HOUR && t - prev <= 25 * HOUR, `${tz} ${key}: ${(t - prev) / HOUR} h`);
      assert.equal(dateKey(t, tz), key, `${tz} ${key}`);
      prev = t;
    }
  }
});

test('tide extrema continue after a gap in the series', async () => {
  const { findExtrema } = await import('../../src/lib/tides.js');
  const step = 15 * 60e3;
  const times = [], heights = [];
  for (let t = 0; t <= 3 * DAY; t += step) { times.push(t); heights.push(Math.round(Math.cos((2 * Math.PI * t) / (12.42 * HOUR)) * 100) / 100); }
  const whole = findExtrema(times, heights).length;
  const holed = [...heights]; holed[60] = null;
  const found = findExtrema(times, holed);
  assert.ok(whole >= 10);
  assert.ok(found.length >= whole - 2, `${found.length} of ${whole} events survive one missing sample`);
});

test('dissent caps confidence: dropping more than 15% of sources is never "high"', async () => {
  const { consensus } = await import('../../src/lib/consensus.js');
  const mk = (vals) => consensus(vals.map((value, i) => ({ id: `s${i}`, value })), 'temp');
  const split = mk([10, 10, 10, 10, 10, 25, 25]);
  assert.equal(split.used.filter((u) => u.outlier).length, 2);
  assert.notEqual(split.level, 'high');
  const lone = mk([10, 10.2, 9.9, 10.1, 10, 10.1, 9.8, 10.2, 10, 10.1, 25]); // one stray among eleven
  assert.equal(lone.used.filter((u) => u.outlier).length, 1);
  assert.equal(lone.level, 'high');
  assert.ok(lone.score < mk([10, 10.2, 9.9, 10.1, 10, 10.1, 9.8, 10.2, 10, 10.1]).score);
});

test('engine: unknown time-zone names fall back instead of throwing; no reading for "now" means no current block', async () => {
  const { safeTz } = await import('../../src/engine.js');
  assert.equal(safeTz('Europe/Oslo'), 'Europe/Oslo');
  assert.equal(safeTz('Mars/Olympus_Mons'), null);
  assert.equal(safeTz(null), null);
  const place = { name: 'X', lat: 10, lon: 20, tz: 'Mars/Olympus_Mons' };
  const v = derive({ raw: {}, place, tz: 'Not/AZone' });
  assert.equal(v.tz, 'UTC');
  // a source whose series ended long ago cannot say anything about now
  const t = Array.from({ length: 24 }, (_, i) => Date.UTC(2020, 0, 1) + i * HOUR);
  const old = { id: 'metno', name: 'Old', kind: 'service', via: 'x', hourly: { t, temp: t.map(() => 5), feels: null, rh: null, dew: null, wind: null, gust: null, dir: null, pressure: null, cloud: null, precip: null, pop: null, code: t.map(() => null) }, blocks6: [], daily: null };
  const stale = derive({ raw: { metno: { source: old } }, place: { ...place, tz: 'UTC' }, tz: 'UTC' });
  assert.equal(stale.current, null);
});
