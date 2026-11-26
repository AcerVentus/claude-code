// Metric-only units and the standard meteorological scales built on them.
// Internal units everywhere: °C, km/h, mm, hPa, m, km, %, µg/m³, seconds.

export const MS_TO_KMH = 3.6;

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Round half away from zero so -0.5 shows as -1, and never print "-0". */
export function round(v, digits = 0) {
  if (!isNum(v)) return null;
  const f = 10 ** digits;
  const r = Math.sign(v) * Math.round(Math.abs(v) * f + 1e-9) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function fmt(v, digits = 0) {
  const r = round(v, digits);
  if (r == null) return '—';
  return r.toFixed(digits).replace('-', '−');
}

export const fmtTemp = (v) => (isNum(v) ? `${fmt(v)}°` : '—');
export const fmtPct = (v) => (isNum(v) ? `${fmt(v)}%` : '—');

/** Wind speed in the chosen metric unit ('kmh' | 'ms'). Input is km/h. */
export function windValue(kmh, unit = 'kmh') {
  if (!isNum(kmh)) return null;
  return unit === 'ms' ? kmh / MS_TO_KMH : kmh;
}
export function fmtWind(kmh, unit = 'kmh') {
  const v = windValue(kmh, unit);
  if (v == null) return '—';
  return unit === 'ms' ? fmt(v, 1) : fmt(v);
}
export const windUnitLabel = (unit) => (unit === 'ms' ? 'm/s' : 'km/h');

const POINTS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg) {
  if (!isNum(deg)) return '—';
  return POINTS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// Beaufort scale. WMO defines the forces in m/s; these are the lower bounds of
// forces 1–12 (force 0 is below 0.3 m/s).
const BEAUFORT_MS = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
const BEAUFORT_LABELS = [
  'Calm', 'Light air', 'Light breeze', 'Gentle breeze', 'Moderate breeze', 'Fresh breeze',
  'Strong breeze', 'Near gale', 'Gale', 'Strong gale', 'Storm', 'Violent storm', 'Hurricane force',
];
export function beaufort(kmh) {
  if (!isNum(kmh)) return null;
  const ms = Math.round((kmh / MS_TO_KMH) * 10) / 10;
  let force = 0;
  while (force < 12 && ms >= BEAUFORT_MS[force]) force++;
  return { force, label: BEAUFORT_LABELS[force] };
}

// Douglas sea-state scale (wind sea), by significant wave height in metres.
const DOUGLAS = [
  [0.005, 'Calm (glassy)'], [0.1, 'Calm (rippled)'], [0.5, 'Smooth'], [1.25, 'Slight'],
  [2.5, 'Moderate'], [4, 'Rough'], [6, 'Very rough'], [9, 'High'],
  [14, 'Very high'], [Infinity, 'Phenomenal'],
];
export function seaState(hs) {
  if (!isNum(hs)) return null;
  for (let i = 0; i < DOUGLAS.length; i++) {
    if (hs <= DOUGLAS[i][0]) return { code: i, label: DOUGLAS[i][1] };
  }
  return { code: 9, label: 'Phenomenal' };
}

// WHO UV index exposure categories.
export function uvCategory(uv) {
  if (!isNum(uv)) return null;
  const v = Math.round(uv);
  if (v <= 2) return { label: 'Low', level: 0 };
  if (v <= 5) return { label: 'Moderate', level: 1 };
  if (v <= 7) return { label: 'High', level: 2 };
  if (v <= 10) return { label: 'Very high', level: 3 };
  return { label: 'Extreme', level: 4 };
}

export function dewComfort(dew) {
  if (!isNum(dew)) return '';
  if (dew < 10) return 'Dry air';
  if (dew < 16) return 'Comfortable';
  if (dew < 20) return 'A little humid';
  if (dew < 24) return 'Muggy';
  return 'Oppressive';
}

export function visibilityLabel(km) {
  if (!isNum(km)) return '';
  if (km < 1) return 'Fog';
  if (km < 4) return 'Poor';
  if (km < 10) return 'Moderate';
  if (km < 20) return 'Good';
  return 'Excellent';
}

/** Dew point (°C) from temperature and relative humidity — Magnus formula. */
export function dewPoint(tempC, rh) {
  if (!isNum(tempC) || !isNum(rh) || rh <= 0) return null;
  const a = 17.625, b = 243.04;
  const g = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}

/** Relative humidity (%) from temperature and dew point — Magnus formula. */
export function relHumidity(tempC, dewC) {
  if (!isNum(tempC) || !isNum(dewC)) return null;
  const a = 17.625, b = 243.04;
  const rh = 100 * Math.exp((a * dewC) / (b + dewC) - (a * tempC) / (b + tempC));
  return Math.max(0, Math.min(100, rh));
}

/** Great-circle distance in km (haversine, mean Earth radius). */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Format coordinates like a chart: 37°46′N 122°25′W. */
export function fmtCoords(lat, lon) {
  const part = (v, pos, neg) => {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = Math.round((a - d) * 60);
    if (m === 60) { d += 1; m = 0; }
    return `${d}°${String(m).padStart(2, '0')}′${v >= 0 ? pos : neg}`;
  };
  return `${part(lat, 'N', 'S')} ${part(lon, 'E', 'W')}`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
