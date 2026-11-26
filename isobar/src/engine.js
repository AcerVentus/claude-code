// Loads every source for a place in parallel, records how each one fared,
// and derives the consensus view the panels render. Panels re-render as
// results arrive; nothing waits for the slowest service.

import { fetchForecast, fetchModels, fetchEnsemble, fetchMarine, fetchWaveModels, fetchAir, fetchClimate, inCamsEurope } from './providers/openmeteo.js';
import { fetchMetNo, fetchMetNoAstro, fetchMetNoOcean, inMetNoOcean } from './providers/metno.js';
import { fetchWttr } from './providers/wttr.js';
import { fetchNws, inNwsCoverage } from './providers/nws.js';
import { fetchBrightSky, fetchBrightSkyObservation, fetchBrightSkyAlerts, nearGermany } from './providers/brightsky.js';
import { nearestTideStation, fetchNoaaTides, fetchSensors, fetchKp } from './providers/misc.js';
import { buildNow, buildHourly, buildDaily, dayKeys, buildSea, buildSeaHourly, compareTimes } from './lib/model.js';
import { consensus, valueAt } from './lib/consensus.js';
import { findExtrema, compareTides, tideState, curveFromEvents } from './lib/tides.js';
import { sunDay, moonDay, moonNow, moonNext, moonQuarters, moonApsides, position, tideCycle } from './lib/astro.js';
import { dateKey, keyToStart, addDays, HOUR, DAY } from './lib/time.js';
import { isNum } from './lib/units.js';

/** Every feed the local view can draw on, in the order the source list shows them. */
export const FEEDS = [
  { key: 'forecast', label: 'Open-Meteo forecast blend', what: 'Detail fields: UV, visibility, cloud layers, 15-minute rain', url: 'https://open-meteo.com' },
  { key: 'models', label: 'Six national weather models', what: 'ECMWF, NOAA GFS, DWD ICON, ECCC GEM, Météo-France, UK Met Office (via Open-Meteo)', url: 'https://open-meteo.com/en/docs' },
  { key: 'ensemble', label: 'ECMWF ensemble (51 members)', what: 'Range of plausible temperatures, chance of rain', url: 'https://open-meteo.com/en/docs/ensemble-api' },
  { key: 'metno', label: 'MET Norway', what: 'Independent global forecast service', url: 'https://api.met.no' },
  { key: 'wwo', label: 'World Weather Online', what: 'Commercial forecast blend, via wttr.in', url: 'https://wttr.in' },
  { key: 'nws', label: 'US National Weather Service', what: 'Forecaster-edited grid, station observation, alerts (US only)', url: 'https://www.weather.gov' },
  { key: 'dwd', label: 'DWD MOSMIX', what: 'Station forecast from Germany\'s weather service, via Bright Sky', url: 'https://brightsky.dev' },
  { key: 'dwdObs', label: 'DWD station observation', what: 'Live SYNOP station and warnings (Germany and neighbours)', url: 'https://brightsky.dev' },
  { key: 'air', label: 'Copernicus CAMS air quality', what: 'AQI, pollutants, dust, pollen (via Open-Meteo)', url: 'https://atmosphere.copernicus.eu' },
  { key: 'airAlt', label: 'CAMS global model', what: 'Second air-quality model where the European one is primary', url: 'https://atmosphere.copernicus.eu' },
  { key: 'sensors', label: 'Sensor.Community', what: 'Citizen particulate sensors within 8 km', url: 'https://sensor.community' },
  { key: 'marine', label: 'Open-Meteo marine', what: 'Waves, swell, sea temperature, currents, modelled sea level', url: 'https://open-meteo.com/en/docs/marine-weather-api' },
  { key: 'waves', label: 'Four wave models', what: 'ECMWF WAM, NOAA GFS Wave, Météo-France MFWAM, DWD GWAM', url: 'https://open-meteo.com/en/docs/marine-weather-api' },
  { key: 'metOcean', label: 'MET Norway Oceanforecast', what: 'Waves and sea temperature, north-west Europe only', url: 'https://api.met.no' },
  { key: 'tides', label: 'NOAA CO-OPS tide predictions', what: 'Harmonic predictions from the nearest tide gauge (US only)', url: 'https://tidesandcurrents.noaa.gov' },
  { key: 'astroMet', label: 'MET Norway Sunrise', what: 'Independent sun and moon times to verify the built-in astronomy', url: 'https://api.met.no' },
  { key: 'climate', label: 'ERA5 climate record', what: 'What this date usually looks like (last ten years)', url: 'https://open-meteo.com/en/docs/historical-weather-api' },
  { key: 'kp', label: 'NOAA Space Weather', what: 'Planetary K-index and three-day forecast', url: 'https://www.swpc.noaa.gov' },
];

export function createEngine({ tideIndex, onChange }) {
  let token = 0;
  const state = { place: null, loadedAt: null, loading: false, raw: {}, status: {}, view: null };

  const setStatus = (key, s) => { state.status[key] = { ...(state.status[key] || {}), ...s }; };

  async function run(key, my, fn, { skip } = {}) {
    if (skip) { setStatus(key, { state: 'skip', note: skip }); return null; }
    setStatus(key, { state: 'loading', error: null, note: null });
    try {
      const res = await fn();
      if (my !== token) return null;
      if (res == null) { setStatus(key, { state: 'none', note: 'No coverage here' }); state.raw[key] = null; }
      else {
        state.raw[key] = res;
        setStatus(key, { state: res.stale ? 'stale' : 'ok', ms: res.ms, fetchedAt: res.fetchedAt });
      }
      refresh(my);
      return res;
    } catch (err) {
      if (my !== token) return null;
      state.raw[key] = null;
      setStatus(key, { state: 'error', error: err?.message || 'Failed' });
      refresh(my);
      return null;
    }
  }

  let pending = false;
  function refresh(my) {
    if (my !== token || pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (my !== token) return;
      try { state.view = derive(state); } catch (err) { console.error('derive failed', err); }
      onChange(state);
    });
  }

  async function load(place, { force = false } = {}) {
    const my = ++token;
    const { lat, lon } = place;
    const opts = force ? { force: true } : undefined;
    state.place = place;
    state.raw = {};
    state.status = {};
    state.view = null;
    state.loading = true;
    state.now = Date.now();
    for (const f of FEEDS) setStatus(f.key, { state: 'loading' });
    onChange(state);

    const jobs = [];
    const fc = run('forecast', my, () => fetchForecast(lat, lon, opts));
    jobs.push(fc);
    jobs.push(run('models', my, () => fetchModels(lat, lon, opts)));
    jobs.push(run('ensemble', my, () => fetchEnsemble(lat, lon, opts)));
    jobs.push(run('metno', my, () => fetchMetNo(lat, lon, opts)));
    jobs.push(run('nws', my, () => fetchNws(lat, lon, opts), { skip: inNwsCoverage(lat, lon) ? null : 'United States only' }));
    jobs.push(run('dwd', my, () => fetchBrightSky(lat, lon, Date.now(), opts)));
    jobs.push(run('dwdObs', my, async () => {
      const [obs, alerts] = await Promise.all([fetchBrightSkyObservation(lat, lon, opts), fetchBrightSkyAlerts(lat, lon, opts).catch(() => [])]);
      if (!obs && !alerts.length) return null;
      return { ...(obs || { fetchedAt: Date.now(), stale: false, ms: 0 }), alerts };
    }, { skip: nearGermany(lat, lon) ? null : 'Germany and neighbours only' }));
    jobs.push(run('air', my, () => fetchAir(lat, lon, 'auto', opts)));
    jobs.push(run('airAlt', my, () => fetchAir(lat, lon, 'cams_global', opts), { skip: inCamsEurope(lat, lon) ? null : 'Only one CAMS model covers this region' }));
    jobs.push(run('sensors', my, () => fetchSensors(lat, lon, 8, opts)));
    const marine = run('marine', my, () => fetchMarine(lat, lon, opts));
    jobs.push(marine);
    jobs.push(run('waves', my, () => fetchWaveModels(lat, lon, opts)));
    jobs.push(run('metOcean', my, () => fetchMetNoOcean(lat, lon, opts), { skip: inMetNoOcean(lat, lon) ? null : 'North-west European waters only' }));
    jobs.push(run('kp', my, () => fetchKp(opts)));
    const station = tideIndex ? nearestTideStation(tideIndex, lat, lon) : null;
    jobs.push(run('tides', my, () => fetchNoaaTides(station, Date.now(), opts), { skip: station ? null : 'No NOAA tide gauge within 30 km' }));

    // These need the place's time zone, which the forecast response settles.
    jobs.push(fc.then((res) => {
      const tz = res?.tz || place.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
      state.tz = tz;
      const key = dateKey(Date.now(), tz);
      return Promise.all([
        run('wwo', my, () => fetchWttr(lat, lon, tz, opts)),
        run('astroMet', my, () => fetchMetNoAstro(lat, lon, key, keyToStart(key, tz), tz, opts)),
        run('climate', my, () => fetchClimate(lat, lon, tz, Date.now(), opts)),
      ]);
    }));

    await Promise.allSettled(jobs);
    if (my !== token) return;
    state.loading = false;
    state.loadedAt = Date.now();
    refresh(my);
  }

  /** Recompute time-dependent values (tide state, sun position…) without refetching. */
  function tick() {
    if (!state.place) return;
    try { state.view = derive(state); } catch (err) { console.error('derive failed', err); }
    onChange(state);
  }

  return { state, load, tick };
}

// ---------------------------------------------------------------- derivation

export function derive(state) {
  const { raw, place } = state;
  const now = Date.now();
  const fc = raw.forecast;
  const tz = fc?.tz || state.tz || place.tz || 'UTC';
  const { lat, lon } = place;
  const v = { now, tz, place, elevation: fc?.elevation ?? place.elevation ?? null };

  // ---- weather sources
  const sources = [];
  if (raw.models?.sources?.length) sources.push(...raw.models.sources);
  else if (fc) sources.push(fc.source); // fall back to the blend when the per-model call failed
  if (raw.metno) sources.push(raw.metno.source);
  if (raw.wwo) sources.push(raw.wwo.source);
  if (raw.nws?.source) sources.push(raw.nws.source);
  if (raw.dwd?.source) sources.push(raw.dwd.source);
  const observations = [raw.nws?.observation, raw.dwdObs?.observation].filter(Boolean);
  v.sources = sources;
  v.observations = observations;

  if (sources.length) {
    v.current = buildNow(sources, observations, now, fc?.current?.code ?? null);
    const popSeries = [];
    if (fc) popSeries.push({ t: fc.source.hourly.t, values: fc.source.hourly.pop });
    if (raw.ensemble) popSeries.push({ t: raw.ensemble.t, values: raw.ensemble.precipProb });
    for (const s of sources) if (s.hourly?.pop?.some?.(isNum)) popSeries.push({ t: s.hourly.t, values: s.hourly.pop });
    v.hourly = buildHourly(sources, now, 168, { preferSource: fc?.source ?? null, popSeries });
    v.days = buildDaily(sources, dayKeys(now, tz, 10), tz, fc?.source ?? null);
    v.popSources = popSeries.length;
  }
  v.blend = fc || null;
  v.ensemble = raw.ensemble || null;

  // ---- sun & moon (local computation, verified against two outside services)
  const key = dateKey(now, tz);
  const start = keyToStart(key, tz);
  const end = keyToStart(addDays(key, 1), tz);
  const sun = sunDay(start, end, lat, lon, v.elevation || 0);
  const ystart = keyToStart(addDays(key, -1), tz);
  const yesterday = sunDay(ystart, start, lat, lon, v.elevation || 0);
  const tomorrow = sunDay(end, keyToStart(addDays(key, 2), tz), lat, lon, v.elevation || 0);
  const sunPos = position('sun', now, lat, lon, v.elevation || 0);
  const sunPosSoon = position('sun', now + 5 * 60e3, lat, lon, v.elevation || 0);
  const moon = moonNow(now, lat, lon);
  const met = raw.astroMet;
  const i0 = fc ? fc.daily.key.indexOf(key) : -1;
  const checks = [];
  const addCheck = (label, mine, others) => {
    const answered = others.filter((o) => o.asked);
    // "It does not happen today" is also something sources can agree on (polar day and night, moonless days).
    if (mine == null && answered.length && answered.every((o) => o.t == null)) {
      checks.push({ label, n: answered.length + 1, maxDiffMin: 0, level: 'high', none: true, entries: [{ id: 'Isobar', t: null }, ...answered] });
      return;
    }
    const cmp = compareTimes([{ id: 'Isobar', t: mine }, ...others]);
    if (cmp) checks.push({ label, ...cmp });
  };
  addCheck('Sunrise', sun.sunrise, [{ id: 'MET Norway', t: met?.sunrise ?? null, asked: !!met }, { id: 'Open-Meteo', t: i0 >= 0 ? fc.daily.sunrise[i0] : null }]);
  addCheck('Sunset', sun.sunset, [{ id: 'MET Norway', t: met?.sunset ?? null, asked: !!met }, { id: 'Open-Meteo', t: i0 >= 0 ? fc.daily.sunset[i0] : null }]);
  const mday = moonDay(start, end, lat, lon);
  addCheck('Moonrise', mday.rise, [{ id: 'MET Norway', t: met?.moonrise ?? null, asked: !!met }]);
  addCheck('Moonset', mday.set, [{ id: 'MET Norway', t: met?.moonset ?? null, asked: !!met }]);
  let phaseCheck = null;
  if (met && isNum(met.moonPhaseDeg) && isNum(met.moonPhaseAt)) {
    const mine = moonNow(met.moonPhaseAt, lat, lon).phaseDeg;
    let diff = Math.abs(mine - met.moonPhaseDeg) % 360;
    if (diff > 180) diff = 360 - diff;
    phaseCheck = { diffDeg: diff, level: diff <= 0.5 ? 'high' : diff <= 2 ? 'medium' : 'low' };
  }
  v.astro = {
    dayStart: start, dayEnd: end, sun, yesterday, tomorrow,
    sunPos, sunRising: sunPosSoon.altitude > sunPos.altitude,
    moon, moonDay: mday, moonNext: moonNext(now, lat, lon), quarters: moonQuarters(now, 4), apsides: moonApsides(now),
    checks, phaseCheck,
  };

  // ---- air quality
  if (raw.air?.current) {
    const cur = raw.air.current;
    const primaryName = inCamsEurope(lat, lon) ? 'CAMS Europe' : 'CAMS global';
    const pmEntries = [{ id: primaryName, value: cur.pm2_5 }];
    const pm10Entries = [{ id: primaryName, value: cur.pm10 }];
    if (raw.airAlt?.current) { pmEntries.push({ id: 'CAMS global', value: raw.airAlt.current.pm2_5 }); pm10Entries.push({ id: 'CAMS global', value: raw.airAlt.current.pm10 }); }
    if (raw.sensors) { pmEntries.push({ id: `${raw.sensors.count} sensors`, value: raw.sensors.pm25 }); pm10Entries.push({ id: `${raw.sensors.count} sensors`, value: raw.sensors.pm10 }); }
    v.air = {
      current: cur, hourly: raw.air.hourly, primaryName, alt: raw.airAlt?.current ?? null, sensors: raw.sensors ?? null,
      pm25: consensus(pmEntries, 'pm25'), pm10: consensus(pm10Entries, 'pm10'),
    };
  }

  // ---- sea
  const m = raw.marine;
  if (m && (m.hasWaves || m.hasSst || m.hasLevel)) {
    const waveSources = [...(raw.waves?.sources || [])];
    if (raw.metOcean?.source) waveSources.push(raw.metOcean.source);
    if (!waveSources.length && m.hasWaves) waveSources.push({ id: 'om_marine', name: 'Open-Meteo marine blend', short: 'Open-Meteo', via: 'Open-Meteo', hourly: m.hourly });
    const sstEntries = [{ id: 'Open-Meteo', value: m.current.sst }];
    if (raw.metOcean?.source) sstEntries.push({ id: 'MET Norway', value: valueAt(raw.metOcean.source.hourly.t, raw.metOcean.source.hourly.sst, now, 3 * HOUR) });
    v.sea = {
      marine: m, waveSources,
      now: waveSources.length ? buildSea(waveSources, now) : null,
      hourly: waveSources.length ? buildSeaHourly(waveSources, now, 120) : null,
      sst: consensus(sstEntries, 'seaTemp'),
    };
  }

  // ---- tides
  const noaa = raw.tides;
  const modelEvents = m?.hasLevel ? findExtrema(m.level.t, m.level.h) : [];
  if (noaa?.events?.length || modelEvents.length) {
    const primary = noaa?.events?.length ? 'noaa' : 'model';
    const events = primary === 'noaa' ? noaa.events : modelEvents;
    const from = now - 6 * HOUR, to = now + 2 * DAY;
    let curve;
    if (primary === 'noaa') curve = noaa.curve ?? curveFromEvents(noaa.events, from, to);
    else curve = m.level;
    const comparison = noaa?.events?.length && modelEvents.length ? compareTides(noaa.events, modelEvents, now - 12 * HOUR, now + 2 * DAY) : null;
    v.tides = {
      primary, events, curve, modelEvents, modelCurve: m?.hasLevel ? m.level : null,
      station: noaa?.station ?? null, datum: primary === 'noaa' ? noaa.datum : 'MSL',
      curveIsInterpolated: primary === 'noaa' && !noaa.curve,
      comparison, state: tideState(events, now), cycle: tideCycle(moon.phaseDeg),
      modelLevelNow: m?.hasLevel ? valueAt(m.level.t, m.level.h, now, HOUR) : null,
    };
  }

  // ---- alerts from official services
  v.alerts = [...(raw.nws?.alerts || []), ...(raw.dwdObs?.alerts || [])];
  v.climate = raw.climate || null;
  v.kp = raw.kp || null;
  return v;
}
