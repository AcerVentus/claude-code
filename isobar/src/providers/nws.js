// US National Weather Service (api.weather.gov): forecaster-edited gridded
// forecast, the nearest station's latest observation, and active alerts.
// United States and territories only.

import { getJson, HttpError } from '../lib/http.js';
import { parseIso, parseIsoDuration, HOUR } from '../lib/time.js';
import { MS_TO_KMH, isNum, distanceKm, relHumidity } from '../lib/units.js';

const BASE = 'https://api.weather.gov';
const c4 = (v) => (Math.round(v * 1e4) / 1e4).toString();

/** Rough boxes for the 50 states and territories; the API itself is the final judge. */
export function inNwsCoverage(lat, lon) {
  const box = (a, b, c, d) => lat >= a && lat <= b && lon >= c && lon <= d;
  return box(24, 50, -125.5, -66) || box(51, 72, -180, -129) || box(18, 23, -161, -154)
    || box(17, 19, -68, -64) || box(13, 21, 144, 147) || box(-15, -13, -171.5, -168);
}

/** Convert a {unitCode, value} quantity to this app's metric units. */
export function quantity(q, uomOverride) {
  if (!q || !isNum(q.value)) return null;
  const unit = String(uomOverride || q.unitCode || '').replace(/^(wmoUnit|unit|nwsUnit|uc):/, '');
  switch (unit) {
    case 'degC': case 'percent': case 'm': case 'mm': case 'degree_(angle)': case 'km_h-1': return q.value;
    case 'degF': return (q.value - 32) * 5 / 9;
    case 'm_s-1': return q.value * MS_TO_KMH;
    case 'Pa': return q.value / 100;
    case 'km': return q.value * 1000;
    default: return null; // unknown unit: refuse rather than guess
  }
}

/** Expand NWS {validTime: "start/duration", value} lists into hourly samples. */
export function expandSeries(field) {
  const out = new Map();
  if (!field || !Array.isArray(field.values)) return out;
  for (const item of field.values) {
    const [startStr, durStr] = String(item.validTime).split('/');
    const start = parseIso(startStr);
    const dur = parseIsoDuration(durStr);
    const v = quantity({ value: item.value }, field.uom);
    if (start == null || dur == null || v == null) continue;
    for (let t = start; t < start + dur; t += HOUR) out.set(t, v);
  }
  return out;
}

function periods(field) {
  if (!field || !Array.isArray(field.values)) return [];
  return field.values.map((item) => {
    const [startStr, durStr] = String(item.validTime).split('/');
    const start = parseIso(startStr), dur = parseIsoDuration(durStr);
    const v = quantity({ value: item.value }, field.uom);
    return start == null || dur == null || v == null ? null : { start, end: start + dur, value: v };
  }).filter(Boolean);
}

export async function fetchNws(lat, lon, opts) {
  let point;
  try {
    point = await getJson(`${BASE}/points/${c4(lat)},${c4(lon)}`, { ttl: 24 * HOUR, ...opts });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return null; // outside NWS coverage
    throw err;
  }
  const p = point.data?.properties;
  if (!p?.forecastGridData) return null;

  const [grid, stations, alerts] = await Promise.allSettled([
    getJson(p.forecastGridData, { ttl: 15 * 60e3, ...opts }),
    getJson(`${p.observationStations}?limit=4`, { ttl: 24 * HOUR, ...opts }),
    getJson(`${BASE}/alerts/active?point=${c4(lat)},${c4(lon)}`, { ttl: 5 * 60e3, ...opts }),
  ]);

  const result = { fetchedAt: point.fetchedAt, stale: false, ms: 0, office: p.gridId, source: null, observation: null, alerts: [], errors: [] };

  if (grid.status === 'fulfilled') {
    const g = grid.value.data?.properties || {};
    result.fetchedAt = grid.value.fetchedAt; result.stale = grid.value.stale; result.ms = grid.value.ms;
    const maps = {
      temp: expandSeries(g.temperature), feels: expandSeries(g.apparentTemperature), rh: expandSeries(g.relativeHumidity),
      dew: expandSeries(g.dewpoint), wind: expandSeries(g.windSpeed), gust: expandSeries(g.windGust),
      dir: expandSeries(g.windDirection), cloud: expandSeries(g.skyCover), pop: expandSeries(g.probabilityOfPrecipitation),
    };
    const times = [...maps.temp.keys()].sort((a, b) => a - b);
    const hourly = { t: times, pressure: times.map(() => null), precip: times.map(() => null), code: times.map(() => null) };
    for (const k of Object.keys(maps)) hourly[k] = times.map((t) => maps[k].get(t) ?? null);
    // NWS states the chance of precipitation per forecast period (often 6–12 hours, sometimes days).
    // That is not an hourly chance, so it is kept apart from the hourly consensus.
    hourly.popPeriod = hourly.pop;
    hourly.pop = null;
    result.source = {
      id: 'nws', name: 'US National Weather Service', short: 'NWS', origin: 'United States', kind: 'service', via: 'api.weather.gov',
      hourly, daily: null,
      maxPeriods: periods(g.maxTemperature), minPeriods: periods(g.minTemperature),
      meta: { office: p.gridId, updatedAt: parseIso(g.updateTime) },
    };
  } else result.errors.push(`forecast: ${grid.reason?.message}`);

  if (stations.status === 'fulfilled') {
    const feats = stations.value.data?.features || [];
    for (const f of feats.slice(0, 3)) {
      const id = f.properties?.stationIdentifier;
      const [slon, slat] = f.geometry?.coordinates || [];
      if (!id) continue;
      try {
        const obs = await getJson(`${BASE}/stations/${id}/observations/latest`, { ttl: 5 * 60e3, ...opts });
        const o = obs.data?.properties;
        const t = parseIso(o?.timestamp);
        const temp = quantity(o?.temperature);
        if (t == null || temp == null || Date.now() - t > 2 * HOUR) continue;
        const dew = quantity(o.dewpoint);
        result.observation = {
          id: 'nws_obs', name: `${f.properties.name} (station ${id})`, short: `Station ${id}`, kind: 'observation', via: 'api.weather.gov',
          now: {
            t, temp, dew, rh: quantity(o.relativeHumidity) ?? relHumidity(temp, dew),
            wind: quantity(o.windSpeed), gust: quantity(o.windGust), dir: quantity(o.windDirection),
            pressure: quantity(o.seaLevelPressure), visibility: quantity(o.visibility),
            text: o.textDescription || null,
          },
          meta: { stationId: id, distanceKm: isNum(slat) ? distanceKm(lat, lon, slat, slon) : null },
        };
        break;
      } catch { /* try the next station */ }
    }
  } else result.errors.push(`stations: ${stations.reason?.message}`);

  if (alerts.status === 'fulfilled') {
    result.alerts = (alerts.value.data?.features || []).map((f) => {
      const a = f.properties || {};
      return {
        id: a.id || f.id, source: a.senderName || 'NWS', event: a.event, severity: (a.severity || 'Unknown').toLowerCase(),
        headline: a.headline || a.event, description: a.description || '', instruction: a.instruction || '',
        onset: parseIso(a.onset || a.effective), ends: parseIso(a.ends || a.expires), url: null,
      };
    }).filter((a) => a.event);
  } else result.errors.push(`alerts: ${alerts.reason?.message}`);

  return result;
}
