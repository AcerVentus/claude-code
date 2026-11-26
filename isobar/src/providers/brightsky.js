// Bright Sky (api.brightsky.dev): Germany's DWD open data — MOSMIX station
// forecasts for ~5,000 stations worldwide, live SYNOP observations and
// official warnings in and around Germany.

import { getJson, HttpError, coord, qs } from '../lib/http.js';
import { parseIso, HOUR } from '../lib/time.js';
import { fromBrightSky } from '../lib/conditions.js';
import { relHumidity, isNum } from '../lib/units.js';

const BASE = 'https://api.brightsky.dev';
const MAX_STATION_KM = 40;

/** DWD's live stations and warnings: Germany and its immediate surroundings. */
export function nearGermany(lat, lon) {
  return lat >= 46.5 && lat <= 55.5 && lon >= 5 && lon <= 16;
}

const notCovered = (err) => err instanceof HttpError && [400, 404, 422].includes(err.status);

export async function fetchBrightSky(lat, lon, now = Date.now(), opts) {
  const from = new Date(Math.floor(now / HOUR) * HOUR - HOUR).toISOString();
  const to = new Date(now + 10 * 24 * HOUR).toISOString();
  let res;
  try {
    res = await getJson(`${BASE}/weather?${qs({ lat: coord(lat), lon: coord(lon), date: from, last_date: to, max_dist: MAX_STATION_KM * 1000 })}`, opts);
  } catch (err) {
    if (notCovered(err)) return null;
    throw err;
  }
  const rows = res.data?.weather || [];
  const stations = res.data?.sources || [];
  if (!rows.length || !stations.length) return null;
  const main = stations.find((s) => s.observation_type === 'forecast') || stations[0];
  const hourly = { t: [], temp: [], feels: [], rh: [], dew: [], wind: [], gust: [], dir: [], pressure: [], cloud: [], precip: [], pop: [], code: [] };
  for (const r of rows) {
    const t = parseIso(r.timestamp);
    if (t == null || !isNum(r.temperature)) continue;
    hourly.t.push(t);
    hourly.temp.push(r.temperature);
    hourly.feels.push(null);
    hourly.rh.push(r.relative_humidity ?? relHumidity(r.temperature, r.dew_point));
    hourly.dew.push(r.dew_point ?? null);
    hourly.wind.push(r.wind_speed ?? null);
    hourly.gust.push(r.wind_gust_speed ?? null);
    hourly.dir.push(r.wind_direction ?? null);
    hourly.pressure.push(r.pressure_msl ?? null);
    hourly.cloud.push(r.cloud_cover ?? null);
    hourly.precip.push(null); // filled below: DWD totals cover the hour ending at the timestamp
    hourly.pop.push(null);
    hourly.code.push(fromBrightSky(r.icon));
  }
  const byTime = new Map(rows.map((r) => [parseIso(r.timestamp), r]));
  hourly.t.forEach((t, i) => {
    const next = byTime.get(t + HOUR);
    if (next) {
      hourly.precip[i] = next.precipitation ?? null;
      hourly.pop[i] = next.precipitation_probability ?? null;
    }
  });
  if (!hourly.t.length) return null;
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms,
    source: {
      id: 'dwd', name: `DWD MOSMIX · ${titleCase(main.station_name)}`, short: 'DWD', origin: 'Germany', kind: 'service', via: 'Bright Sky',
      hourly, daily: null,
      meta: { station: titleCase(main.station_name), distanceKm: isNum(main.distance) ? main.distance / 1000 : null },
    },
  };
}

/** Latest SYNOP station observation near the point (Germany and neighbours), or null. */
export async function fetchBrightSkyObservation(lat, lon, opts) {
  let res;
  try {
    res = await getJson(`${BASE}/current_weather?${qs({ lat: coord(lat), lon: coord(lon), max_dist: MAX_STATION_KM * 1000 })}`, { ttl: 5 * 60e3, ...opts });
  } catch (err) {
    if (notCovered(err)) return null;
    throw err;
  }
  const w = res.data?.weather;
  const t = parseIso(w?.timestamp);
  if (!w || t == null || !isNum(w.temperature) || Date.now() - t > 2 * HOUR) return null;
  const st = (res.data.sources || []).find((s) => s.id === w.source_id) || res.data.sources?.[0];
  const name = titleCase(st?.station_name || 'DWD station');
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms,
    observation: {
      id: 'dwd_obs', name: `${name} (DWD station)`, short: `Station ${name}`, kind: 'observation', via: 'Bright Sky',
      now: {
        t, temp: w.temperature, dew: w.dew_point ?? null, rh: w.relative_humidity ?? null,
        wind: w.wind_speed_10 ?? null, gust: w.wind_gust_speed_10 ?? null, dir: w.wind_direction_10 ?? null,
        pressure: w.pressure_msl ?? null, cloud: w.cloud_cover ?? null, visibility: w.visibility ?? null,
        code: fromBrightSky(w.icon),
      },
      meta: { distanceKm: isNum(st?.distance) ? st.distance / 1000 : null },
    },
  };
}

/** Official DWD warnings for the point (Germany only); empty elsewhere. */
export async function fetchBrightSkyAlerts(lat, lon, opts) {
  let res;
  try {
    res = await getJson(`${BASE}/alerts?${qs({ lat: coord(lat), lon: coord(lon) })}`, { ttl: 5 * 60e3, ...opts });
  } catch (err) {
    if (notCovered(err)) return [];
    throw err;
  }
  return (res.data?.alerts || []).map((a) => ({
    id: a.alert_id || String(a.id), source: 'Deutscher Wetterdienst', event: a.event_en || a.event_de,
    severity: (a.severity || 'unknown').toLowerCase(), headline: a.headline_en || a.headline_de || a.event_en,
    description: a.description_en || a.description_de || '', instruction: a.instruction_en || a.instruction_de || '',
    onset: parseIso(a.onset || a.effective), ends: parseIso(a.expires), url: null,
  })).filter((a) => a.event);
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}
