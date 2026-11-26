// Open-Meteo: forecast blend, six national weather models side by side, the
// ECMWF ensemble, marine/ocean models, CAMS air quality, ERA5 climate history
// and place search. All requests are metric and use Unix timestamps (UTC).

import { getJson, coord, qs } from '../lib/http.js';
import { dateKey, HOUR } from '../lib/time.js';
import { fromWmo } from '../lib/conditions.js';
import { isNum } from '../lib/units.js';
import { quantile } from '../lib/consensus.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ENSEMBLE = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';

export const MODELS = [
  { id: 'ecmwf_ifs025',         short: 'ECMWF',         name: 'ECMWF IFS',              origin: 'European Centre' },
  { id: 'gfs_seamless',         short: 'GFS',           name: 'NOAA GFS / HRRR',        origin: 'United States' },
  { id: 'icon_seamless',        short: 'ICON',          name: 'DWD ICON',               origin: 'Germany' },
  { id: 'gem_seamless',         short: 'GEM',           name: 'ECCC GEM',               origin: 'Canada' },
  { id: 'meteofrance_seamless', short: 'Météo-France',  name: 'Météo-France ARPEGE / AROME', origin: 'France' },
  { id: 'ukmo_seamless',        short: 'UKMO',          name: 'UK Met Office',          origin: 'United Kingdom' },
];

export const WAVE_MODELS = [
  { id: 'ecmwf_wam025',    short: 'ECMWF WAM',    name: 'ECMWF WAM' },
  { id: 'ncep_gfswave025', short: 'GFS Wave',     name: 'NOAA GFS Wave' },
  { id: 'meteofrance_wave', short: 'MFWAM',       name: 'Météo-France MFWAM' },
  { id: 'gwam',            short: 'DWD GWAM',     name: 'DWD GWAM' },
];

const toMs = (arr) => arr.map((s) => s * 1000);
const col = (obj, key) => obj?.[key] ?? null;
/** Open-Meteo sums precipitation over the hour *ending* at the timestamp; shift to the hour *starting* there. */
const shiftBack = (arr) => (arr ? arr.slice(1).concat([null]) : null);

const base = (lat, lon) => ({
  latitude: coord(lat), longitude: coord(lon), timezone: 'auto', timeformat: 'unixtime',
});

/** Open-Meteo's own best-match blend: the richest variable set, used for detail panels. */
export async function fetchForecast(lat, lon, opts) {
  const url = `${FORECAST}?${qs({
    ...base(lat, lon), forecast_days: 10, past_days: 1, wind_speed_unit: 'kmh',
    forecast_minutely_15: 12, past_minutely_15: 0,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    minutely_15: 'precipitation',
    hourly: 'temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation_probability,precipitation,snowfall,snow_depth,weather_code,pressure_msl,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,uv_index_clear_sky,is_day,cape,freezing_level_height,wet_bulb_temperature_2m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,daylight_duration,sunshine_duration,uv_index_max,precipitation_sum,snowfall_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant',
  })}`;
  const res = await getJson(url, opts);
  const d = res.data;
  const tz = d.timezone;
  const h = d.hourly, c = d.current, dy = d.daily, m = d.minutely_15;
  const t = toMs(h.time);
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms,
    tz, tzAbbr: d.timezone_abbreviation, utcOffsetMs: d.utc_offset_seconds * 1000,
    elevation: d.elevation, gridLat: d.latitude, gridLon: d.longitude,
    current: c && {
      t: c.time * 1000, temp: c.temperature_2m, feels: c.apparent_temperature, rh: c.relative_humidity_2m,
      precip: c.precipitation, code: fromWmo(c.weather_code), cloud: c.cloud_cover,
      pressure: c.pressure_msl, surfacePressure: c.surface_pressure,
      wind: c.wind_speed_10m, dir: c.wind_direction_10m, gust: c.wind_gusts_10m, isDay: c.is_day === 1,
    },
    // precipitation in each 15-minute step, labelled by the step's start
    m15: m ? { t: toMs(m.time).map((x) => x - 15 * 60e3).slice(1), precip: m.precipitation.slice(1) } : null,
    source: {
      id: 'om_best', name: 'Open-Meteo blend', short: 'Open-Meteo', kind: 'model', via: 'Open-Meteo',
      hourly: {
        t, temp: h.temperature_2m, feels: h.apparent_temperature, rh: h.relative_humidity_2m, dew: h.dew_point_2m,
        wind: h.wind_speed_10m, gust: h.wind_gusts_10m, dir: h.wind_direction_10m, pressure: h.pressure_msl,
        cloud: h.cloud_cover, precip: shiftBack(h.precipitation), pop: shiftBack(h.precipitation_probability),
        code: h.weather_code.map(fromWmo),
      },
      daily: {
        key: dy.time.map((s) => dateKey(s * 1000, tz)),
        tmax: dy.temperature_2m_max, tmin: dy.temperature_2m_min, precip: dy.precipitation_sum,
        windMax: dy.wind_speed_10m_max, gustMax: dy.wind_gusts_10m_max, code: dy.weather_code.map(fromWmo),
      },
    },
    extra: {
      t, visibility: h.visibility, uv: h.uv_index, uvClear: h.uv_index_clear_sky, isDay: h.is_day,
      cape: h.cape, freezingLevel: h.freezing_level_height, wetBulb: h.wet_bulb_temperature_2m,
      snowDepth: h.snow_depth, snowfall: shiftBack(h.snowfall),
      cloudLow: h.cloud_cover_low, cloudMid: h.cloud_cover_mid, cloudHigh: h.cloud_cover_high,
    },
    daily: {
      key: dy.time.map((s) => dateKey(s * 1000, tz)),
      start: toMs(dy.time),
      code: dy.weather_code.map(fromWmo),
      tmax: dy.temperature_2m_max, tmin: dy.temperature_2m_min,
      feelsMax: dy.apparent_temperature_max, feelsMin: dy.apparent_temperature_min,
      sunrise: dy.sunrise.map((s) => (s ? s * 1000 : null)), sunset: dy.sunset.map((s) => (s ? s * 1000 : null)),
      daylight: dy.daylight_duration, sunshine: dy.sunshine_duration, uvMax: dy.uv_index_max,
      precip: dy.precipitation_sum, snowfall: dy.snowfall_sum, precipHours: dy.precipitation_hours,
      popMax: dy.precipitation_probability_max, windMax: dy.wind_speed_10m_max, gustMax: dy.wind_gusts_10m_max,
      dirDominant: dy.wind_direction_10m_dominant,
    },
  };
}

/** Six global/regional models from different national weather centres, each as its own source. */
export async function fetchModels(lat, lon, opts) {
  const ids = MODELS.map((m) => m.id);
  const url = `${FORECAST}?${qs({
    ...base(lat, lon), forecast_days: 10, wind_speed_unit: 'kmh', models: ids,
    hourly: 'temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation,weather_code,pressure_msl,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max',
  })}`;
  const res = await getJson(url, opts);
  const d = res.data;
  const tz = d.timezone;
  const t = toMs(d.hourly.time);
  const keys = d.daily.time.map((s) => dateKey(s * 1000, tz));
  const sources = [];
  for (const m of MODELS) {
    // With a single model Open-Meteo drops the suffix; with several it adds one.
    const hk = (v) => col(d.hourly, `${v}_${m.id}`) ?? (ids.length === 1 ? col(d.hourly, v) : null);
    const dk = (v) => col(d.daily, `${v}_${m.id}`) ?? (ids.length === 1 ? col(d.daily, v) : null);
    const temp = hk('temperature_2m');
    if (!temp || !temp.some(isNum)) continue;
    sources.push({
      id: m.id, name: m.name, short: m.short, origin: m.origin, kind: 'model', via: 'Open-Meteo',
      hourly: {
        t, temp, feels: hk('apparent_temperature'), rh: hk('relative_humidity_2m'), dew: hk('dew_point_2m'),
        wind: hk('wind_speed_10m'), gust: hk('wind_gusts_10m'), dir: hk('wind_direction_10m'),
        pressure: hk('pressure_msl'), cloud: hk('cloud_cover'), precip: shiftBack(hk('precipitation')),
        pop: null, code: (hk('weather_code') || []).map(fromWmo),
      },
      daily: {
        key: keys, tmax: dk('temperature_2m_max'), tmin: dk('temperature_2m_min'), precip: dk('precipitation_sum'),
        windMax: dk('wind_speed_10m_max'), gustMax: dk('wind_gusts_10m_max'), code: (dk('weather_code') || []).map(fromWmo),
      },
    });
  }
  return { fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms, sources };
}

/** ECMWF 51-member ensemble: the spread of plausible outcomes for temperature and precipitation. */
export async function fetchEnsemble(lat, lon, opts) {
  const url = `${ENSEMBLE}?${qs({
    ...base(lat, lon), forecast_days: 7, models: 'ecmwf_ifs025', hourly: 'temperature_2m,precipitation',
  })}`;
  const res = await getJson(url, { ttl: 60 * 60e3, ...opts });
  const h = res.data.hourly;
  const t = toMs(h.time);
  const members = (prefix) => Object.keys(h).filter((k) => k === prefix || k.startsWith(`${prefix}_member`)).map((k) => h[k]);
  const temps = members('temperature_2m');
  const precs = members('precipitation').map(shiftBack);
  const out = { t, n: temps.length, tempP10: [], tempP50: [], tempP90: [], precipProb: [], precipP50: [], precipP90: [] };
  for (let i = 0; i < t.length; i++) {
    const tv = temps.map((m) => m[i]).filter(isNum);
    out.tempP10.push(tv.length >= 10 ? quantile(tv, 0.1) : null);
    out.tempP50.push(tv.length >= 10 ? quantile(tv, 0.5) : null);
    out.tempP90.push(tv.length >= 10 ? quantile(tv, 0.9) : null);
    const pv = precs.map((m) => m[i]).filter(isNum);
    out.precipProb.push(pv.length >= 10 ? (100 * pv.filter((v) => v >= 0.1).length) / pv.length : null);
    out.precipP50.push(pv.length >= 10 ? quantile(pv, 0.5) : null);
    out.precipP90.push(pv.length >= 10 ? quantile(pv, 0.9) : null);
  }
  return { fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms, ...out };
}

/** Sea state, sea temperature, currents and modelled sea level (tide + surge) at the nearest sea cell. */
export async function fetchMarine(lat, lon, opts) {
  const url = `${MARINE}?${qs({
    ...base(lat, lon), forecast_days: 6, past_days: 1, cell_selection: 'sea',
    current: 'wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_direction,wind_wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,sea_surface_temperature,ocean_current_velocity,ocean_current_direction,sea_level_height_msl',
    hourly: 'wave_height,wave_direction,wave_period,wind_wave_height,swell_wave_height,swell_wave_direction,swell_wave_period,sea_surface_temperature,ocean_current_velocity,ocean_current_direction',
    minutely_15: 'sea_level_height_msl',
  })}`;
  const res = await getJson(url, { ttl: 30 * 60e3, ...opts });
  const d = res.data;
  const c = d.current || {}, h = d.hourly || {}, m = d.minutely_15 || {};
  const hasAny = (arr) => Array.isArray(arr) && arr.some(isNum);
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms,
    tz: d.timezone, gridLat: d.latitude, gridLon: d.longitude,
    hasWaves: hasAny(h.wave_height),
    hasLevel: hasAny(m.sea_level_height_msl),
    hasSst: hasAny(h.sea_surface_temperature),
    hasCurrent: hasAny(h.ocean_current_velocity),
    current: {
      t: c.time ? c.time * 1000 : null,
      waveH: c.wave_height, waveDir: c.wave_direction, wavePeriod: c.wave_period,
      windWaveH: c.wind_wave_height, windWaveDir: c.wind_wave_direction, windWavePeriod: c.wind_wave_period,
      swellH: c.swell_wave_height, swellDir: c.swell_wave_direction, swellPeriod: c.swell_wave_period,
      sst: c.sea_surface_temperature, currentSpeed: c.ocean_current_velocity, currentDir: c.ocean_current_direction,
      level: c.sea_level_height_msl,
    },
    hourly: {
      t: toMs(h.time || []), waveH: h.wave_height, waveDir: h.wave_direction, wavePeriod: h.wave_period,
      windWaveH: h.wind_wave_height, swellH: h.swell_wave_height, swellDir: h.swell_wave_direction, swellPeriod: h.swell_wave_period,
      sst: h.sea_surface_temperature, currentSpeed: h.ocean_current_velocity, currentDir: h.ocean_current_direction,
    },
    level: { t: toMs(m.time || []), h: m.sea_level_height_msl || [] },
  };
}

/** Four independent wave models for cross-checking the sea state. */
export async function fetchWaveModels(lat, lon, opts) {
  const ids = WAVE_MODELS.map((m) => m.id);
  const url = `${MARINE}?${qs({
    ...base(lat, lon), forecast_days: 6, cell_selection: 'sea', models: ids,
    hourly: 'wave_height,wave_direction,wave_period',
  })}`;
  const res = await getJson(url, { ttl: 30 * 60e3, ...opts });
  const h = res.data.hourly || {};
  const t = toMs(h.time || []);
  const sources = [];
  for (const m of WAVE_MODELS) {
    const waveH = h[`wave_height_${m.id}`];
    // A model whose nearest cell is land reports a flat zero sea; that is a mask, not a calm.
    if (!waveH || !waveH.some((v) => isNum(v) && v > 0)) continue;
    sources.push({
      id: m.id, name: m.name, short: m.short, kind: 'model', via: 'Open-Meteo',
      hourly: { t, waveH, waveDir: h[`wave_direction_${m.id}`], wavePeriod: h[`wave_period_${m.id}`] },
    });
  }
  return { fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms, sources };
}

const AIR_CURRENT = 'us_aqi,european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,aerosol_optical_depth,dust,us_aqi_pm2_5,us_aqi_pm10,us_aqi_nitrogen_dioxide,us_aqi_ozone,us_aqi_sulphur_dioxide,us_aqi_carbon_monoxide';

/** CAMS Europe covers roughly this box at ~11 km; elsewhere only the global ~45 km model exists. */
export function inCamsEurope(lat, lon) {
  return lat >= 30.5 && lat <= 71.5 && lon >= -24.5 && lon <= 44.5;
}

/**
 * Air quality from the Copernicus Atmosphere Monitoring Service.
 * domain: 'auto' (best available), 'cams_global' or 'cams_europe'.
 */
export async function fetchAir(lat, lon, domain = 'auto', opts) {
  const full = domain === 'auto';
  const url = `${AIR}?${qs({
    ...base(lat, lon), domains: domain, forecast_days: full ? 5 : 1, past_days: full ? 1 : 0,
    current: full ? AIR_CURRENT : 'us_aqi,european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone',
    hourly: full ? 'us_aqi,european_aqi,pm10,pm2_5,ozone,nitrogen_dioxide,dust,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen' : null,
  })}`;
  const res = await getJson(url, { ttl: 30 * 60e3, ...opts });
  const d = res.data;
  const h = d.hourly;
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms, domain,
    tz: d.timezone,
    current: d.current ? { ...d.current, t: d.current.time * 1000 } : null,
    hourly: h ? { ...h, t: toMs(h.time) } : null,
  };
}

/**
 * What this calendar date usually looks like here: ERA5 reanalysis for the
 * last ten full years, ±7 days around today's day of year.
 */
export async function fetchClimate(lat, lon, tz, now = Date.now(), opts) {
  const year = +dateKey(now, tz).slice(0, 4);
  const first = year - 10, last = year - 1;
  const url = `${ARCHIVE}?${qs({
    latitude: coord(lat), longitude: coord(lon), timezone: 'auto',
    start_date: `${first}-01-01`, end_date: `${last}-12-31`,
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
  })}`;
  const res = await getJson(url, { ttl: 30 * 24 * HOUR, timeout: 25000, ...opts });
  const dy = res.data.daily;
  const todayKey = dateKey(now, tz);
  const md = (key) => { const [, m, d] = key.split('-').map(Number); return Date.UTC(2001, m - 1, d) / 86400e3; };
  const target = md(todayKey);
  const tmax = [], tmin = [], precip = [];
  dy.time.forEach((key, i) => {
    let diff = Math.abs(md(key) - target);
    diff = Math.min(diff, 365 - diff);
    if (diff > 7) return;
    if (isNum(dy.temperature_2m_max[i])) tmax.push(dy.temperature_2m_max[i]);
    if (isNum(dy.temperature_2m_min[i])) tmin.push(dy.temperature_2m_min[i]);
    if (isNum(dy.precipitation_sum[i])) precip.push(dy.precipitation_sum[i]);
  });
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms,
    firstYear: first, lastYear: last, samples: tmax.length,
    tmaxMean: mean(tmax), tminMean: mean(tmin),
    tmaxP10: quantile(tmax, 0.1), tmaxP90: quantile(tmax, 0.9),
    tmaxMin: tmax.length ? Math.min(...tmax) : null, tmaxMax: tmax.length ? Math.max(...tmax) : null,
    tminP10: quantile(tmin, 0.1), tminP90: quantile(tmin, 0.9),
    wetShare: precip.length ? precip.filter((v) => v >= 1).length / precip.length : null,
    tmaxValues: tmax,
  };
}

/** Place search. */
export async function searchPlaces(query, opts) {
  const url = `${GEOCODE}?${qs({ name: query.trim(), count: 8, language: 'en', format: 'json' })}`;
  const res = await getJson(url, { ttl: 24 * HOUR, timeout: 8000, ...opts });
  return (res.data.results || []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    country: r.country || '', countryCode: r.country_code || '',
    lat: r.latitude, lon: r.longitude, tz: r.timezone || null, elevation: r.elevation ?? null,
  }));
}
