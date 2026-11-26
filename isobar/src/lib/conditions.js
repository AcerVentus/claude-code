// One internal vocabulary for sky conditions, with a mapping from each
// provider's own codes. `group` is the coarse bucket used when sources vote.

export const CONDITIONS = {
  clear:           { label: 'Clear',                 group: 'clear',   icon: 'clear',    wet: 0 },
  mostly_clear:    { label: 'Mostly clear',          group: 'clear',   icon: 'fair',     wet: 0 },
  partly_cloudy:   { label: 'Partly cloudy',         group: 'partly',  icon: 'partly',   wet: 0 },
  cloudy:          { label: 'Overcast',              group: 'cloudy',  icon: 'cloudy',   wet: 0 },
  fog:             { label: 'Fog',                   group: 'fog',     icon: 'fog',      wet: 0 },
  drizzle:         { label: 'Drizzle',               group: 'rain',    icon: 'drizzle',  wet: 1 },
  freezing_drizzle:{ label: 'Freezing drizzle',      group: 'sleet',   icon: 'sleet',    wet: 1 },
  rain_light:      { label: 'Light rain',            group: 'rain',    icon: 'drizzle',  wet: 1 },
  rain:            { label: 'Rain',                  group: 'rain',    icon: 'rain',     wet: 2 },
  rain_heavy:      { label: 'Heavy rain',            group: 'rain',    icon: 'heavy',    wet: 3 },
  freezing_rain:   { label: 'Freezing rain',         group: 'sleet',   icon: 'sleet',    wet: 2 },
  sleet:           { label: 'Sleet',                 group: 'sleet',   icon: 'sleet',    wet: 2 },
  snow_light:      { label: 'Light snow',            group: 'snow',    icon: 'snow',     wet: 1 },
  snow:            { label: 'Snow',                  group: 'snow',    icon: 'snow',     wet: 2 },
  snow_heavy:      { label: 'Heavy snow',            group: 'snow',    icon: 'snow',     wet: 3 },
  showers_light:   { label: 'Light showers',         group: 'rain',    icon: 'drizzle',  wet: 1 },
  showers:         { label: 'Showers',               group: 'rain',    icon: 'rain',     wet: 2 },
  showers_heavy:   { label: 'Heavy showers',         group: 'rain',    icon: 'heavy',    wet: 3 },
  snow_showers:    { label: 'Snow showers',          group: 'snow',    icon: 'snow',     wet: 2 },
  thunder:         { label: 'Thunderstorm',          group: 'thunder', icon: 'thunder',  wet: 3 },
  thunder_hail:    { label: 'Thunderstorm with hail', group: 'thunder', icon: 'thunder', wet: 3 },
};

export const GROUP_LABELS = {
  clear: 'clear', partly: 'partly cloudy', cloudy: 'overcast', fog: 'fog',
  rain: 'rain', sleet: 'sleet', snow: 'snow', thunder: 'thunder',
};

// WMO weather interpretation codes (WW), as used by Open-Meteo.
const WMO = {
  0: 'clear', 1: 'mostly_clear', 2: 'partly_cloudy', 3: 'cloudy',
  45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
  56: 'freezing_drizzle', 57: 'freezing_drizzle',
  61: 'rain_light', 63: 'rain', 65: 'rain_heavy',
  66: 'freezing_rain', 67: 'freezing_rain',
  71: 'snow_light', 73: 'snow', 75: 'snow_heavy', 77: 'snow_light',
  80: 'showers_light', 81: 'showers', 82: 'showers_heavy',
  85: 'snow_showers', 86: 'snow_showers',
  95: 'thunder', 96: 'thunder_hail', 99: 'thunder_hail',
};
export function fromWmo(code) {
  return code == null ? null : WMO[code] ?? null;
}

// MET Norway symbol codes, e.g. "lightrainshowers_day", "heavysnowandthunder".
export function fromMetNo(symbol) {
  if (!symbol) return null;
  const s = symbol.split('_')[0];
  if (s.includes('thunder')) return 'thunder';
  const light = s.startsWith('light');
  const heavy = s.startsWith('heavy');
  if (s.includes('sleet')) return 'sleet';
  if (s.includes('snow')) {
    if (s.includes('showers')) return 'snow_showers';
    return light ? 'snow_light' : heavy ? 'snow_heavy' : 'snow';
  }
  if (s.includes('rain')) {
    if (s.includes('showers')) return light ? 'showers_light' : heavy ? 'showers_heavy' : 'showers';
    return light ? 'rain_light' : heavy ? 'rain_heavy' : 'rain';
  }
  if (s === 'fog') return 'fog';
  if (s === 'cloudy') return 'cloudy';
  if (s === 'partlycloudy') return 'partly_cloudy';
  if (s === 'fair') return 'mostly_clear';
  if (s === 'clearsky') return 'clear';
  return null;
}

// World Weather Online codes, as served by wttr.in.
const WWO = {
  113: 'clear', 116: 'partly_cloudy', 119: 'cloudy', 122: 'cloudy',
  143: 'fog', 248: 'fog', 260: 'fog',
  176: 'showers_light', 263: 'drizzle', 266: 'drizzle',
  281: 'freezing_drizzle', 284: 'freezing_drizzle', 185: 'freezing_drizzle',
  293: 'rain_light', 296: 'rain_light', 299: 'rain', 302: 'rain', 305: 'rain_heavy', 308: 'rain_heavy',
  311: 'freezing_rain', 314: 'freezing_rain',
  182: 'sleet', 317: 'sleet', 320: 'sleet', 350: 'sleet', 362: 'sleet', 365: 'sleet', 374: 'sleet', 377: 'sleet',
  353: 'showers_light', 356: 'showers', 359: 'showers_heavy',
  179: 'snow_light', 323: 'snow_light', 326: 'snow_light', 329: 'snow', 332: 'snow',
  335: 'snow_heavy', 338: 'snow_heavy', 227: 'snow', 230: 'snow_heavy',
  368: 'snow_showers', 371: 'snow_showers',
  200: 'thunder', 386: 'thunder', 389: 'thunder', 392: 'thunder', 395: 'thunder',
};
export function fromWwo(code) {
  return WWO[+code] ?? null;
}

// Bright Sky icon names.
const BRIGHTSKY = {
  'clear-day': 'clear', 'clear-night': 'clear',
  'partly-cloudy-day': 'partly_cloudy', 'partly-cloudy-night': 'partly_cloudy',
  cloudy: 'cloudy', fog: 'fog', rain: 'rain', sleet: 'sleet', snow: 'snow',
  hail: 'thunder_hail', thunderstorm: 'thunder',
};
export function fromBrightSky(icon) {
  return BRIGHTSKY[icon] ?? null;
}

export const condLabel = (c) => CONDITIONS[c]?.label ?? '—';
export const condGroup = (c) => CONDITIONS[c]?.group ?? null;

/** Short phrase for the dominant sky over a day, e.g. for the daily list. */
export function describe(cond, isDay = true) {
  if (!cond) return '—';
  if (cond === 'clear') return isDay ? 'Sunny' : 'Clear';
  if (cond === 'mostly_clear') return isDay ? 'Mostly sunny' : 'Mostly clear';
  return CONDITIONS[cond].label;
}
