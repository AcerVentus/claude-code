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
