// Smaller providers: NOAA tide predictions, Sensor.Community particulate
// sensors, RainViewer radar frames, NOAA space weather, reverse geocoding.

import { getJson, HttpError, coord, qs } from '../lib/http.js';
import { HOUR, DAY } from '../lib/time.js';
import { distanceKm, isNum } from '../lib/units.js';
import { median } from '../lib/consensus.js';

// ---------------------------------------------------------------- NOAA tides

const COOPS = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
export const TIDE_STATION_MAX_KM = 30;

/** Nearest NOAA tide-prediction station from the bundled index, or null. */
export function nearestTideStation(index, lat, lon, maxKm = TIDE_STATION_MAX_KM) {
  let best = null;
  for (const [id, name, state, slat, slon, type] of index.stations) {
    if (Math.abs(slat - lat) > 1 || Math.abs(slon - lon) > 2) continue;
    const d = distanceKm(lat, lon, slat, slon);
    if (d <= maxKm && (!best || d < best.distanceKm)) best = { id, name, state, lat: slat, lon: slon, type, distanceKm: d };
  }
  return best;
}

const yyyymmdd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const parseGmt = (s) => Date.parse(`${s.replace(' ', 'T')}:00Z`);

/**
 * Official harmonic tide predictions for a NOAA station: highs/lows for four
 * days from yesterday, plus the 6-minute curve where the station publishes one.
 */
export async function fetchNoaaTides(station, now = Date.now(), opts) {
  const common = {
    product: 'predictions', application: 'isobar-weather', station: station.id,
    begin_date: yyyymmdd(now - DAY), range: 96, time_zone: 'gmt', units: 'metric', format: 'json',
  };
  const get = async (extra) => {
    const res = await getJson(`${COOPS}?${qs({ ...common, ...extra })}`, { ttl: 6 * HOUR, ...opts });
    if (res.data?.error) throw new HttpError(res.data.error.message || 'NOAA error', 400);
    return res;
  };
  // Mean sea level is the datum the ocean model uses too; subordinate stations only offer MLLW.
  let datum = 'MSL';
  let hilo;
  try {
    hilo = await get({ datum, interval: 'hilo' });
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 400) throw err;
    datum = 'MLLW';
    hilo = await get({ datum, interval: 'hilo' });
  }
  const events = (hilo.data.predictions || []).map((p) => ({ t: parseGmt(p.t), h: Number(p.v), type: p.type }))
    .filter((e) => Number.isFinite(e.t) && isNum(e.h) && (e.type === 'H' || e.type === 'L'));
  let curve = null;
  if (station.type === 'R') {
    try {
      const fine = await get({ datum });
      const t = [], h = [];
      for (const p of fine.data.predictions || []) {
        const tt = parseGmt(p.t), v = Number(p.v);
        if (Number.isFinite(tt) && isNum(v)) { t.push(tt); h.push(v); }
      }
      if (t.length > 10) curve = { t, h };
    } catch { /* highs and lows are enough */ }
  }
  return { fetchedAt: hilo.fetchedAt, stale: hilo.stale, ms: hilo.ms, station, datum, events, curve };
}

// --------------------------------------------------------- Sensor.Community

/** Median PM2.5 / PM10 from outdoor citizen sensors within radiusKm, or null when there are none. */
export async function fetchSensors(lat, lon, radiusKm = 8, opts) {
  const url = `https://data.sensor.community/airrohr/v1/filter/area=${coord(lat)},${coord(lon)},${radiusKm}`;
  const res = await getJson(url, { ttl: 5 * 60e3, timeout: 12000, ...opts });
  if (!Array.isArray(res.data)) return null;
  const latest = new Map();
  for (const row of res.data) {
    if (row?.location?.indoor) continue;
    const vals = {};
    for (const v of row.sensordatavalues || []) vals[v.value_type] = Number(v.value);
    // P2 = PM2.5, P1 = PM10 (µg/m³). Reject sensor faults and saturated readings.
    if (!isNum(vals.P2) || vals.P2 <= 0 || vals.P2 > 500) continue;
    const id = row.sensor?.id;
    const prev = latest.get(id);
    if (!prev || row.timestamp > prev.timestamp) {
      latest.set(id, {
        timestamp: row.timestamp, pm25: vals.P2, pm10: isNum(vals.P1) && vals.P1 > 0 && vals.P1 < 1500 ? vals.P1 : null,
        km: distanceKm(lat, lon, Number(row.location.latitude), Number(row.location.longitude)),
      });
    }
  }
  const sensors = [...latest.values()];
  if (!sensors.length) return null;
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms,
    count: sensors.length, radiusKm,
    pm25: median(sensors.map((s) => s.pm25)), pm10: median(sensors.map((s) => s.pm10)),
    nearestKm: Math.min(...sensors.map((s) => s.km)),
  };
}

// ---------------------------------------------------------------- RainViewer

/** Radar mosaic frames (past two hours, plus nowcast when offered). */
export async function fetchRadarFrames(opts) {
  const res = await getJson('https://api.rainviewer.com/public/weather-maps.json', { ttl: 5 * 60e3, ...opts });
  const d = res.data || {};
  const host = d.host || 'https://tilecache.rainviewer.com';
  const frame = (f, kind) => ({ t: f.time * 1000, kind, url: `${host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` });
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms,
    frames: [...(d.radar?.past || []).map((f) => frame(f, 'past')), ...(d.radar?.nowcast || []).map((f) => frame(f, 'nowcast'))],
  };
}

// ------------------------------------------------------------- Space weather

const G_SCALE = [[9, 'G5', 'Extreme storm'], [8, 'G4', 'Severe storm'], [7, 'G3', 'Strong storm'], [6, 'G2', 'Moderate storm'], [5, 'G1', 'Minor storm']];
export function kpDescription(kp) {
  if (!isNum(kp)) return null;
  for (const [min, g, label] of G_SCALE) if (kp >= min) return { g, label };
  if (kp >= 4) return { g: null, label: 'Active' };
  if (kp >= 3) return { g: null, label: 'Unsettled' };
  return { g: null, label: 'Quiet' };
}

/** NOAA SWPC planetary K-index: recent observations and the 3-day forecast. */
export async function fetchKp(opts) {
  const res = await getJson('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json', { ttl: 30 * 60e3, ...opts });
  const rows = Array.isArray(res.data) ? res.data : [];
  const series = [];
  for (const r of rows) {
    // Served either as objects or (historically) as arrays with a header row.
    const tag = Array.isArray(r) ? r[0] : r.time_tag;
    const kp = Number(Array.isArray(r) ? r[1] : r.kp);
    const status = Array.isArray(r) ? r[2] : r.observed;
    const t = Date.parse(`${String(tag).replace(' ', 'T')}Z`);
    if (!Number.isFinite(t) || !isNum(kp)) continue;
    series.push({ t, kp, observed: status === 'observed' });
  }
  series.sort((a, b) => a.t - b.t);
  return { fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms, series };
}

/** Geomagnetic latitude (degrees) for a centred-dipole pole at 80.8°N, 72.7°W (IGRF-14, epoch 2025). */
export function geomagneticLatitude(lat, lon) {
  const rad = Math.PI / 180;
  const pLat = 80.8 * rad, pLon = -72.7 * rad;
  const s = Math.sin(lat * rad) * Math.sin(pLat) + Math.cos(lat * rad) * Math.cos(pLat) * Math.cos(lon * rad - pLon);
  return Math.asin(Math.max(-1, Math.min(1, s))) / rad;
}

/**
 * Rule of thumb: the equatorward edge of the auroral oval sits near
 * 66.5° − 2.05°·Kp geomagnetic latitude; it can be seen low on the horizon
 * from about five degrees further towards the equator.
 */
export function auroraChance(kp, geomagLat) {
  if (!isNum(kp) || !isNum(geomagLat)) return null;
  const boundary = 66.5 - 2.05 * kp;
  const margin = Math.abs(geomagLat) - boundary;
  if (margin >= 0) return { key: 'likely', label: 'Aurora possible overhead if the sky is dark and clear' };
  if (margin >= -5) return { key: 'possible', label: 'Aurora may show low on the poleward horizon' };
  return { key: 'no', label: 'Aurora not expected at this latitude' };
}

// ----------------------------------------------------------- Reverse geocode

/** Name for a coordinate (BigDataCloud's keyless client-side endpoint). */
export async function reverseGeocode(lat, lon, opts) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?${qs({ latitude: coord(lat), longitude: coord(lon), localityLanguage: 'en' })}`;
  const res = await getJson(url, { ttl: 30 * DAY, timeout: 8000, ...opts });
  const d = res.data || {};
  const name = d.city || d.locality || d.principalSubdivision || d.countryName || null;
  return {
    name,
    region: [d.principalSubdivision, d.countryName].filter((x) => x && x !== name).join(', '),
    country: d.countryName || '', countryCode: d.countryCode || '',
  };
}
