// Live checks against the real services. Run with `npm run test:live`.
// They assert that every adapter still parses real responses into sane metric
// values, and that independent sources agree where they should.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchForecast, fetchModels, fetchEnsemble, fetchMarine, fetchWaveModels, fetchAir, fetchClimate, searchPlaces, inCamsEurope } from '../../src/providers/openmeteo.js';
import { fetchMetNo, fetchMetNoAstro, fetchMetNoOcean } from '../../src/providers/metno.js';
import { fetchWttr } from '../../src/providers/wttr.js';
import { fetchNws, inNwsCoverage } from '../../src/providers/nws.js';
import { fetchBrightSky, fetchBrightSkyObservation, fetchBrightSkyAlerts } from '../../src/providers/brightsky.js';
import { nearestTideStation, fetchNoaaTides, fetchSensors, fetchRadarFrames, fetchKp, reverseGeocode } from '../../src/providers/misc.js';
import { buildNow, buildHourly, buildDaily, dayKeys, buildSea, compareTimes } from '../../src/lib/model.js';
import { findExtrema, compareTides } from '../../src/lib/tides.js';
import { sunDay, moonDay, moonNow } from '../../src/lib/astro.js';
import { dateKey, keyToStart, addDays, fmtTime, HOUR, DAY } from '../../src/lib/time.js';
import { angleDiff } from '../../src/lib/consensus.js';
import { isNum } from '../../src/lib/units.js';

const PLACES = [
  { name: 'San Francisco', lat: 37.7749, lon: -122.4194 },
  { name: 'Dubai', lat: 25.2048, lon: 55.2708 },
  { name: 'Berlin', lat: 52.52, lon: 13.405 },
  { name: 'Bergen', lat: 60.3913, lon: 5.3221 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { name: 'Denver', lat: 39.7392, lon: -104.9903 },
  { name: 'Tromsø', lat: 69.6492, lon: 18.9553 },
];
const index = JSON.parse(readFileSync(new URL('../../data/noaa-tide-stations.json', import.meta.url)));
const now = Date.now();
const inRange = (v, lo, hi, what) => assert.ok(isNum(v) && v >= lo && v <= hi, `${what} = ${v} outside [${lo}, ${hi}]`);
const settle = async (p) => { try { return await p; } catch (e) { return { error: e.message }; } };

for (const place of PLACES) {
  test(`${place.name}: weather sources parse and agree`, async (t) => {
    const { lat, lon } = place;
    const fc = await fetchForecast(lat, lon);
    const tz = fc.tz;
    assert.ok(tz && tz.includes('/'), 'IANA zone');
    inRange(fc.current.temp, -70, 58, 'current temp');
    inRange(fc.current.pressure, 870, 1085, 'pressure');
    inRange(fc.current.wind, 0, 250, 'wind km/h');
    assert.ok(Math.abs(fc.current.t - now) < 30 * 60e3, 'current time is now');
    assert.equal(fc.source.hourly.t.length, 264);
    assert.equal(fc.daily.key[1], dateKey(now, tz), 'second daily row is today (past_days=1)');
    assert.ok(fc.m15.t.length >= 8, `15-minute steps: ${fc.m15.t.length}`);
    assert.ok(fc.m15.t[0] >= now - 15 * 60e3 && fc.m15.t[0] <= now + 15 * 60e3, '15-minute series starts at the current step');

    const [models, metno, wttr, ens, nws, dwd, dwdObs] = await Promise.all([
      settle(fetchModels(lat, lon)), settle(fetchMetNo(lat, lon)), settle(fetchWttr(lat, lon, tz)), settle(fetchEnsemble(lat, lon)),
      inNwsCoverage(lat, lon) ? settle(fetchNws(lat, lon)) : null, settle(fetchBrightSky(lat, lon, now)), settle(fetchBrightSkyObservation(lat, lon)),
    ]);
    assert.ok(!models.error, `models: ${models.error}`);
    assert.ok(models.sources.length >= 4, `only ${models.sources.length} models`);
    assert.ok(!metno.error, `metno: ${metno.error}`);
    assert.ok(metno.source.hourly.t.length > 50);
    assert.ok(!ens.error, `ensemble: ${ens.error}`);
    assert.equal(ens.n, 51);

    const sources = [...models.sources, metno.source];
    if (!wttr.error) sources.push(wttr.source); else t.diagnostic(`wttr unavailable: ${wttr.error}`);
    if (nws && !nws.error && nws.source) sources.push(nws.source);
    if (dwd && !dwd.error && dwd.source) sources.push(dwd.source);
    const observations = [nws?.observation, dwdObs?.observation].filter(Boolean);

    for (const s of sources) {
      const h = s.hourly;
      assert.ok(h.t.every((x, i) => i === 0 || x > h.t[i - 1]), `${s.id} times ascend`);
      for (const [k, lo, hi] of [['temp', -70, 58], ['rh', 0, 100], ['wind', 0, 300], ['gust', 0, 400], ['dir', 0, 360], ['pressure', 870, 1085], ['cloud', 0, 100], ['precip', 0, 200]]) {
        for (const v of h[k] || []) if (v != null) inRange(v, lo, hi, `${s.id}.${k}`);
      }
    }

    const n = buildNow(sources, observations, now, fc.current.code);
    assert.ok(n.count >= 5, `sources reporting now: ${n.count}`);
    assert.ok(Math.abs(n.vars.temp.value - fc.current.temp) < 4, `consensus ${n.vars.temp.value} vs Open-Meteo blend ${fc.current.temp}`);
    // Above ~800 m, models reduce pressure to sea level differently; agreement is only expected lower down.
    if (fc.elevation < 800) assert.ok(Math.abs(n.vars.pressure.value - fc.current.pressure) < 4, 'pressure agrees with blend');
    else t.diagnostic(`elevation ${fc.elevation} m: sea-level pressure spread ±${n.vars.pressure.sigma.toFixed(1)} hPa (${n.vars.pressure.level})`);
    assert.ok(n.condition.code, 'a condition was chosen');

    const hourly = buildHourly(sources, now, 168, { preferSource: fc.source, popSeries: [{ t: fc.source.hourly.t, values: fc.source.hourly.pop }, { t: ens.t, values: ens.precipProb }] });
    assert.ok(hourly.temp.n[0] >= 5);
    assert.ok(hourly.temp.value.slice(0, 120).every(isNum), 'hourly temperature has no holes for 5 days');
    assert.ok(hourly.pop.slice(0, 48).every((v) => isNum(v) && v >= 0 && v <= 100));
    // ensemble band brackets its own median
    assert.ok(ens.tempP10.every((v, i) => v == null || (v <= ens.tempP50[i] && ens.tempP50[i] <= ens.tempP90[i])));

    const keys = dayKeys(now, tz, 10);
    const days = buildDaily(sources, keys, tz, fc.source);
    assert.equal(days.length, 10);
    for (const d of days.slice(0, 7)) {
      assert.ok(d.tmax && d.tmin && d.tmax.n >= 3, `${d.key}: ${d.tmax?.n} sources`);
      assert.ok(d.tmax.value >= d.tmin.value, `${d.key}: max ≥ min`);
    }
    const i1 = fc.daily.key.indexOf(keys[1]);
    assert.ok(Math.abs(days[1].tmax.value - fc.daily.tmax[i1]) < 5, 'tomorrow max near blend');

    t.diagnostic(`${place.name} (${tz}) now ${n.vars.temp.value.toFixed(1)}°C ±${n.vars.temp.sigma.toFixed(2)} n=${n.vars.temp.n} conf=${n.overall.level}/${n.overall.score} cond=${n.condition.code} | wind ${n.vars.wind.value.toFixed(0)} km/h ±${n.vars.wind.sigma.toFixed(1)} | p ${n.vars.pressure.value.toFixed(1)} hPa`);
    t.diagnostic(`  rows: ${n.rows.map((r) => `${r.short}=${r.values.temp?.toFixed(1)}`).join(', ')}`);
    t.diagnostic(`  days: ${days.slice(0, 5).map((d) => `${d.key.slice(5)} ${d.tmax.value.toFixed(0)}/${d.tmin.value.toFixed(0)} n${d.tmax.n} ${d.confidence.level}`).join(' | ')}`);
  });

  test(`${place.name}: sun and moon match MET Norway and Open-Meteo`, async (t) => {
    const { lat, lon } = place;
    const fc = await fetchForecast(lat, lon);
    const tz = fc.tz;
    const key = dateKey(now, tz);
    const start = keyToStart(key, tz), end = keyToStart(addDays(key, 1), tz);
    const mine = sunDay(start, end, lat, lon);
    const met = await fetchMetNoAstro(lat, lon, key, start, tz);
    const i = fc.daily.key.indexOf(key);
    for (const ev of ['sunrise', 'sunset']) {
      const cmp = compareTimes([{ id: 'isobar', t: mine[ev] }, { id: 'metno', t: met[ev] }, { id: 'openmeteo', t: fc.daily[ev][i] }]);
      if (mine[ev] == null) { assert.equal(met[ev], null, `${ev}: polar agreement`); continue; }
      assert.ok(cmp.n >= 2 && cmp.maxDiffMin <= 3, `${ev} differs by ${cmp.maxDiffMin.toFixed(1)} min (${cmp.entries.map((e) => `${e.id} ${fmtTime(e.t, tz)}`).join(', ')})`);
    }
    const moon = moonDay(start, end, lat, lon);
    for (const [a, b, what] of [[moon.rise, met.moonrise, 'moonrise'], [moon.set, met.moonset, 'moonset']]) {
      if (a == null || b == null) { assert.ok(a == null && b == null, `${what}: one side missing (isobar ${a}, metno ${b})`); continue; }
      assert.ok(Math.abs(a - b) <= 3 * 60e3, `${what} differs by ${((a - b) / 60e3).toFixed(1)} min`);
    }
    const phase = moonNow(met.moonPhaseAt, lat, lon).phaseDeg;
    assert.ok(Math.abs(angleDiff(phase, met.moonPhaseDeg)) < 0.5, `moon phase ${phase.toFixed(2)} vs MET ${met.moonPhaseDeg}`);
    t.diagnostic(`${place.name}: sunrise ${fmtTime(mine.sunrise, tz)} sunset ${fmtTime(mine.sunset, tz)} moonrise ${fmtTime(moon.rise, tz)} moonset ${fmtTime(moon.set, tz)} phase ${phase.toFixed(1)}° polar=${mine.polar}`);
  });
}

test('San Francisco: NWS forecast, station observation and alerts', async (t) => {
  const r = await fetchNws(37.7749, -122.4194);
  assert.ok(r.source, `errors: ${r.errors}`);
  assert.ok(r.source.hourly.t.length > 100);
  assert.ok(r.source.maxPeriods.length >= 5 && r.source.minPeriods.length >= 5);
  if (r.observation) { assert.ok(r.observation.meta.distanceKm < 60); assert.ok(isNum(r.observation.now.temp)); }
  t.diagnostic(`NWS obs: ${r.observation ? `${r.observation.name} ${r.observation.now.temp.toFixed(1)}°C, ${r.observation.meta.distanceKm.toFixed(1)} km` : 'none'}; alerts: ${r.alerts.map((a) => a.event).join(', ') || 'none'}`);
});

test('NWS returns null outside the United States', async () => {
  assert.equal(await fetchNws(51.5, -0.12), null);
});

test('Berlin: DWD observation, warnings shape, CAMS Europe vs global, citizen sensors', async (t) => {
  const obs = await fetchBrightSkyObservation(52.52, 13.405);
  assert.ok(obs?.observation, 'a synoptic station near Berlin');
  inRange(obs.observation.now.temp, -40, 45, 'obs temp');
  assert.ok(Array.isArray(await fetchBrightSkyAlerts(52.52, 13.405)));
  assert.deepEqual(await fetchBrightSkyAlerts(25.2, 55.27), []);
  assert.equal(await fetchBrightSkyObservation(-33.87, 151.21), null);
  const [auto, global] = await Promise.all([fetchAir(52.52, 13.405, 'auto'), fetchAir(52.52, 13.405, 'cams_global')]);
  inRange(auto.current.us_aqi, 0, 500, 'us aqi');
  inRange(auto.current.european_aqi, 0, 500, 'eu aqi');
  inRange(auto.current.pm2_5, 0, 500, 'pm2.5');
  assert.ok(auto.hourly.t.length >= 120);
  assert.ok(auto.hourly.grass_pollen.some(isNum), 'pollen exists in Europe');
  inRange(global.current.pm2_5, 0, 500, 'global pm2.5');
  const sensors = await fetchSensors(52.52, 13.405);
  assert.ok(sensors && sensors.count >= 3, 'sensors near Berlin');
  inRange(sensors.pm25, 0, 500, 'sensor pm2.5');
  t.diagnostic(`Berlin PM2.5: CAMS Europe ${auto.current.pm2_5}, CAMS global ${global.current.pm2_5}, ${sensors.count} sensors median ${sensors.pm25.toFixed(1)} µg/m³`);
});

test('Dubai: air quality (global model only), no sensors is handled', async (t) => {
  const air = await fetchAir(25.2048, 55.2708, 'auto');
  inRange(air.current.us_aqi, 0, 500, 'us aqi');
  assert.equal(inCamsEurope(25.2, 55.27), false);
  const sensors = await fetchSensors(25.2048, 55.2708);
  t.diagnostic(`Dubai US AQI ${air.current.us_aqi}, PM2.5 ${air.current.pm2_5}, dust ${air.current.dust}; sensors: ${sensors ? sensors.count : 'none'}`);
});

test('marine: wave models agree, inland has no sea, MET Norway ocean only in the north-east Atlantic', async (t) => {
  for (const [name, lat, lon] of [['San Francisco', 37.77, -122.55], ['Dubai', 25.2048, 55.2708], ['Bergen', 60.39, 5.0], ['Sydney', -33.87, 151.3]]) {
    const [m, wm] = await Promise.all([fetchMarine(lat, lon), fetchWaveModels(lat, lon)]);
    assert.ok(m.hasWaves, `${name} has waves`);
    inRange(m.current.waveH, 0, 20, 'wave height');
    inRange(m.current.sst, -2, 36, 'sea temperature');
    assert.ok(wm.sources.length >= 2, `${name}: ${wm.sources.length} wave models`);
    const sea = buildSea(wm.sources, now);
    assert.ok(Math.abs(sea.vars.waveH.value - m.current.waveH) < Math.max(0.6, 0.5 * m.current.waveH), `${name}: consensus ${sea.vars.waveH.value} vs ${m.current.waveH}`);
    t.diagnostic(`${name}: Hs ${sea.vars.waveH.value.toFixed(2)} m ±${sea.vars.waveH.sigma.toFixed(2)} (${sea.rows.map((r) => `${r.short} ${r.values.waveH.toFixed(2)}`).join(', ')}) ${sea.overall.level}; SST ${m.current.sst}°C; level pts ${m.level.t.length}`);
  }
  const inland = await fetchMarine(39.7392, -104.9903);
  assert.equal(inland.hasWaves, false);
  assert.equal(inland.hasLevel, false);
  assert.equal(await fetchMetNoOcean(37.77, -122.55), null);
  const ocean = await fetchMetNoOcean(60.39, 5.0);
  assert.ok(ocean?.source.hourly.waveH.some(isNum));
});

test('tides: NOAA gauge predictions parse, and the ocean model tracks them loosely', async (t) => {
  // Measured when this was written: the 8 km ocean model's highs and lows run 10–60 minutes ahead
  // of the gauges on open coasts and ~90 minutes off inside San Francisco Bay. The app therefore
  // treats the gauge as primary and never rates this model "high" on its own. The bounds below
  // catch a broken parser or a time-zone slip (hours off), not that known model error.
  for (const [name, lat, lon] of [['San Francisco', 37.7749, -122.4194], ['Honolulu', 21.3069, -157.8583], ['Boston', 42.3601, -71.0589], ['Miami Beach', 25.7907, -80.13]]) {
    const station = nearestTideStation(index, lat, lon);
    assert.ok(station, `${name}: station within range`);
    const [noaa, marine] = await Promise.all([fetchNoaaTides(station, now), fetchMarine(lat, lon)]);
    assert.ok(noaa.events.length >= 12, `${name}: ${noaa.events.length} NOAA events`);
    assert.ok(noaa.events.every((e, i) => i === 0 || e.type !== noaa.events[i - 1].type), 'NOAA highs and lows alternate');
    assert.ok(noaa.events.every((e, i) => i === 0 || (e.t - noaa.events[i - 1].t > 2 * HOUR && e.t - noaa.events[i - 1].t < 14 * HOUR)), 'plausible spacing between tides');
    assert.ok(noaa.events[0].t < now && noaa.events.at(-1).t > now + DAY, 'predictions bracket now');
    assert.ok(marine.hasLevel, `${name}: modelled sea level`);
    const model = findExtrema(marine.level.t, marine.level.h);
    const cmp = compareTides(noaa.events, model, now - 12 * HOUR, now + 2 * DAY);
    t.diagnostic(`${name}: ${station.name} (${station.type}, ${station.distanceKm.toFixed(1)} km, datum ${noaa.datum}) matched ${cmp.matched}/${cmp.expected}, mean |Δt| ${cmp.timeDiffMin?.toFixed(0)} min, range ratio ${cmp.rangeRatio?.toFixed(2)} → ${cmp.level}; curve ${noaa.curve ? noaa.curve.t.length : 'none'}`);
    assert.ok(cmp.matched >= cmp.expected - 2, `${name}: matched ${cmp.matched}/${cmp.expected}`);
    assert.ok(cmp.timeDiffMin < 120, `${name}: time difference ${cmp.timeDiffMin} min`);
    assert.ok(cmp.rangeRatio > 0.6 && cmp.rangeRatio < 1.5, `${name}: range ratio ${cmp.rangeRatio}`);
  }
  // Puget Sound is too narrow for the ocean model: the gauge must carry the panel alone.
  const seattle = nearestTideStation(index, 47.6062, -122.3321);
  assert.ok(seattle);
  assert.ok((await fetchNoaaTides(seattle, now)).events.length >= 12);
});

test('climate normals, radar frames, Kp, geocoding', async (t) => {
  const c = await fetchClimate(25.2048, 55.2708, 'Asia/Dubai', now);
  assert.equal(c.samples, 150, '15 days × 10 years');
  inRange(c.tmaxMean, 15, 45, 'Dubai late-November mean max');
  assert.ok(c.tmaxP10 <= c.tmaxMean && c.tmaxMean <= c.tmaxP90);
  const radar = await fetchRadarFrames();
  assert.ok(radar.frames.length >= 6);
  assert.ok(radar.frames.every((f) => f.url.includes('{z}/{x}/{y}')));
  assert.ok(now - radar.frames.filter((f) => f.kind === 'past').at(-1).t < 40 * 60e3, 'latest radar frame is recent');
  const kp = await fetchKp();
  assert.ok(kp.series.length > 20);
  assert.ok(kp.series.some((k) => k.observed) && kp.series.some((k) => !k.observed));
  assert.ok(kp.series.every((k) => k.kp >= 0 && k.kp <= 9));
  const places = await searchPlaces('Reykjavik');
  assert.equal(places[0].countryCode, 'IS');
  assert.equal(places[0].tz, 'Atlantic/Reykjavik');
  const rev = await reverseGeocode(48.8566, 2.3522);
  assert.equal(rev.name, 'Paris');
  t.diagnostic(`Dubai normal max ${c.tmaxMean.toFixed(1)}°C (${c.firstYear}–${c.lastYear}); radar frames ${radar.frames.length}; Kp latest obs ${kp.series.filter((k) => k.observed).at(-1).kp}`);
});
