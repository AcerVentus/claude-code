// MET Norway (api.met.no): global Locationforecast, Sunrise (sun & moon) for
// verifying the local astronomy, and Oceanforecast for north-west Europe.
// Terms of service: coordinates must carry at most 4 decimals.

import { getJson, HttpError, qs } from '../lib/http.js';
import { parseIso, zonedParts, HOUR } from '../lib/time.js';
import { fromMetNo } from '../lib/conditions.js';
import { MS_TO_KMH, isNum } from '../lib/units.js';

const BASE = 'https://api.met.no/weatherapi';
const c4 = (v) => (Math.round(v * 1e4) / 1e4).toString();

export async function fetchMetNo(lat, lon, opts) {
  const url = `${BASE}/locationforecast/2.0/complete?${qs({ lat: c4(lat), lon: c4(lon) })}`;
  const res = await getJson(url, opts);
  const series = res.data?.properties?.timeseries || [];
  const hourly = { t: [], temp: [], feels: [], rh: [], dew: [], wind: [], gust: [], dir: [], pressure: [], cloud: [], precip: [], pop: [], code: [] };
  const blocks6 = []; // 6-hour blocks with max/min temperature and precipitation
  const kmh = (v) => (isNum(v) ? v * MS_TO_KMH : null);
  for (const row of series) {
    const t = parseIso(row.time);
    const i = row.data?.instant?.details;
    if (t == null || !i) continue;
    const n1 = row.data.next_1_hours, n6 = row.data.next_6_hours;
    hourly.t.push(t);
    hourly.temp.push(i.air_temperature ?? null);
    hourly.feels.push(null); // MET Norway publishes no apparent temperature in this product
    hourly.rh.push(i.relative_humidity ?? null);
    hourly.dew.push(i.dew_point_temperature ?? null);
    hourly.wind.push(kmh(i.wind_speed));
    hourly.gust.push(kmh(i.wind_speed_of_gust));
    hourly.dir.push(i.wind_from_direction ?? null);
    hourly.pressure.push(i.air_pressure_at_sea_level ?? null);
    hourly.cloud.push(i.cloud_area_fraction ?? null);
    hourly.precip.push(n1?.details?.precipitation_amount ?? null);
    hourly.pop.push(n1?.details?.probability_of_precipitation ?? null);
    hourly.code.push(fromMetNo(n1?.summary?.symbol_code ?? n6?.summary?.symbol_code));
    if (n6?.details) {
      blocks6.push({
        t, tmax: n6.details.air_temperature_max ?? null, tmin: n6.details.air_temperature_min ?? null,
        precip: n6.details.precipitation_amount ?? null,
      });
    }
  }
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms,
    updatedAt: parseIso(res.data?.properties?.meta?.updated_at),
    source: {
      id: 'metno', name: 'MET Norway', short: 'MET Norway', origin: 'Norway', kind: 'service', via: 'api.met.no',
      hourly, blocks6, daily: null,
    },
  };
}

function offsetString(ms, tz) {
  // "+04:00" style offset of the zone at that instant
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  const mins = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = mins < 0 ? '-' : '+';
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** Sun and Moon events for one local date, as computed independently by MET Norway. */
export async function fetchMetNoAstro(lat, lon, dateKeyStr, dayStartMs, tz, opts) {
  const offset = offsetString(dayStartMs + 12 * HOUR, tz);
  const q = qs({ lat: c4(lat), lon: c4(lon), date: dateKeyStr, offset });
  const [sun, moon] = await Promise.all([
    getJson(`${BASE}/sunrise/3.0/sun?${q}`, { ttl: 6 * HOUR, ...opts }),
    getJson(`${BASE}/sunrise/3.0/moon?${q}`, { ttl: 6 * HOUR, ...opts }),
  ]);
  const s = sun.data?.properties || {}, m = moon.data?.properties || {};
  return {
    fetchedAt: Math.min(sun.fetchedAt, moon.fetchedAt), stale: sun.stale || moon.stale, ms: Math.max(sun.ms, moon.ms),
    sunrise: parseIso(s.sunrise?.time), sunset: parseIso(s.sunset?.time), solarNoon: parseIso(s.solarnoon?.time),
    moonrise: parseIso(m.moonrise?.time), moonset: parseIso(m.moonset?.time),
    moonPhaseDeg: isNum(m.moonphase) ? m.moonphase : null,
    // MET Norway reports the phase for the start of its 24-hour interval.
    moonPhaseAt: parseIso(moon.data?.when?.interval?.[0]),
  };
}

/** Rough extent of the Oceanforecast product (north-west European shelf, Norwegian and Barents seas). */
export function inMetNoOcean(lat, lon) {
  return lat >= 46 && lat <= 82 && lon >= -25 && lon <= 45;
}

/** MET Norway Oceanforecast — north-west European waters only. Resolves null elsewhere. */
export async function fetchMetNoOcean(lat, lon, opts) {
  const url = `${BASE}/oceanforecast/2.0/complete?${qs({ lat: c4(lat), lon: c4(lon) })}`;
  let res;
  try {
    res = await getJson(url, { ttl: 30 * 60e3, ...opts });
  } catch (err) {
    // Points outside the product (or on land) are refused with a 422 that carries no CORS
    // header, which a browser reports as a plain network failure. Either way: no coverage.
    if (!(err instanceof HttpError) || [400, 404, 422].includes(err.status)) return null;
    throw err;
  }
  const series = res.data?.properties?.timeseries || [];
  const hourly = { t: [], waveH: [], waveDir: [], sst: [], currentSpeed: [], currentDir: [] };
  for (const row of series) {
    const t = parseIso(row.time);
    const i = row.data?.instant?.details;
    if (t == null || !i) continue;
    hourly.t.push(t);
    hourly.waveH.push(i.sea_surface_wave_height ?? null);
    hourly.waveDir.push(i.sea_surface_wave_from_direction ?? null);
    hourly.sst.push(i.sea_water_temperature ?? null);
    hourly.currentSpeed.push(isNum(i.sea_water_speed) ? i.sea_water_speed * MS_TO_KMH : null);
    hourly.currentDir.push(i.sea_water_to_direction ?? null);
  }
  if (!hourly.t.length || !hourly.waveH.some(isNum)) return null;
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms,
    source: { id: 'metno_ocean', name: 'MET Norway Oceanforecast', short: 'MET Norway', kind: 'service', via: 'api.met.no', hourly },
  };
}
