// World Weather Online data, served keyless by wttr.in (JSON format j1).
// Three-hourly, whole degrees — coarse, but an independent commercial blend.

import { getJson, coord } from '../lib/http.js';
import { zonedToUtc } from '../lib/time.js';
import { fromWwo } from '../lib/conditions.js';

const num = (v) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) ? null : n;
};

export async function fetchWttr(lat, lon, tz, opts) {
  const url = `https://wttr.in/${coord(lat)},${coord(lon)}?format=j1`;
  const res = await getJson(url, { timeout: 12000, ...opts });
  const d = res.data;
  if (!d || !Array.isArray(d.weather) || !d.weather.length) throw new Error('No forecast in response');

  const hourly = { t: [], temp: [], feels: [], rh: [], dew: [], wind: [], gust: [], dir: [], pressure: [], cloud: [], precip: [], pop: [], code: [] };
  const daily = { key: [], tmax: [], tmin: [], precip: [], windMax: [], gustMax: [], code: [] };
  for (const day of d.weather) {
    const [y, m, dd] = String(day.date).split('-').map(Number);
    if (!y) continue;
    daily.key.push(day.date);
    daily.tmax.push(num(day.maxtempC));
    daily.tmin.push(num(day.mintempC));
    daily.precip.push(null);
    daily.windMax.push(null);
    daily.gustMax.push(null);
    daily.code.push(null);
    for (const h of day.hourly || []) {
      const hhmm = num(h.time);
      if (hhmm == null) continue;
      // "0", "300", … "2100" are local wall-clock times at the place
      hourly.t.push(zonedToUtc(y, m, dd, Math.floor(hhmm / 100), hhmm % 100, tz));
      hourly.temp.push(num(h.tempC));
      hourly.feels.push(num(h.FeelsLikeC));
      hourly.rh.push(num(h.humidity));
      hourly.dew.push(num(h.DewPointC));
      hourly.wind.push(num(h.windspeedKmph));
      hourly.gust.push(num(h.WindGustKmph));
      hourly.dir.push(num(h.winddirDegree));
      hourly.pressure.push(num(h.pressure));
      hourly.cloud.push(num(h.cloudcover));
      hourly.precip.push(null); // three-hour totals; not comparable with hourly sources
      hourly.pop.push(null);
      hourly.code.push(fromWwo(h.weatherCode));
    }
  }

  const c = d.current_condition?.[0];
  const now = c ? {
    t: res.fetchedAt,
    temp: num(c.temp_C), feels: num(c.FeelsLikeC), rh: num(c.humidity),
    wind: num(c.windspeedKmph), dir: num(c.winddirDegree), pressure: num(c.pressure),
    cloud: num(c.cloudcover), code: fromWwo(c.weatherCode),
    visibility: num(c.visibility) != null ? num(c.visibility) * 1000 : null,
  } : null;

  const area = d.nearest_area?.[0];
  return {
    fetchedAt: res.fetchedAt, stale: res.stale, ms: res.ms,
    source: {
      id: 'wwo', name: 'World Weather Online', short: 'WWO', origin: 'Commercial blend', kind: 'service', via: 'wttr.in',
      hourly, daily, now,
      meta: { area: area?.areaName?.[0]?.value || null },
    },
  };
}
