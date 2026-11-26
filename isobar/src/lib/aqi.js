// Air-quality index scales. The index values themselves come from the data
// provider (they need rolling averages); this module only classifies them.

import { isNum } from './units.js';

// US EPA AQI categories.
const US = [
  { max: 50,  label: 'Good',                            level: 0, advice: 'Air quality is satisfactory.' },
  { max: 100, label: 'Moderate',                        level: 1, advice: 'Acceptable. Unusually sensitive people should consider limiting long outdoor exertion.' },
  { max: 150, label: 'Unhealthy for sensitive groups',  level: 2, advice: 'Children, older adults and people with heart or lung disease should cut back on outdoor exertion.' },
  { max: 200, label: 'Unhealthy',                       level: 3, advice: 'Everyone may begin to feel effects. Limit prolonged outdoor exertion.' },
  { max: 300, label: 'Very unhealthy',                  level: 4, advice: 'Health alert. Avoid outdoor exertion; sensitive groups should stay indoors.' },
  { max: Infinity, label: 'Hazardous',                  level: 5, advice: 'Emergency conditions. Stay indoors and keep activity low.' },
];

// European Air Quality Index bands, on the 0–100+ scale Open-Meteo reports.
const EU = [
  { max: 20,  label: 'Good',           level: 0, advice: 'Air quality is good. Enjoy your usual outdoor activities.' },
  { max: 40,  label: 'Fair',           level: 1, advice: 'Fine for most. Sensitive people may notice mild symptoms.' },
  { max: 60,  label: 'Moderate',       level: 2, advice: 'Sensitive people should consider reducing intense outdoor activity.' },
  { max: 80,  label: 'Poor',           level: 3, advice: 'Consider reducing intense activity outdoors, especially if you have symptoms.' },
  { max: 100, label: 'Very poor',      level: 4, advice: 'Reduce physical activity outdoors; sensitive groups should avoid it.' },
  { max: Infinity, label: 'Extremely poor', level: 5, advice: 'Avoid physical activity outdoors.' },
];

export const AQI_SCALES = {
  us: { name: 'US AQI', bands: US, gaugeMax: 300, ticks: [0, 50, 100, 150, 200, 300] },
  eu: { name: 'European AQI', bands: EU, gaugeMax: 100, ticks: [0, 20, 40, 60, 80, 100] },
};

export function aqiCategory(value, scale = 'us') {
  if (!isNum(value)) return null;
  const bands = AQI_SCALES[scale].bands;
  return bands.find((b) => value <= b.max) ?? bands[bands.length - 1];
}

// WHO 2021 air-quality guideline levels (µg/m³): 24-hour mean, except ozone
// (8-hour mean) and CO (24-hour mean, given here in µg/m³).
export const WHO_GUIDELINE = {
  pm2_5: 15, pm10: 45, nitrogen_dioxide: 25, sulphur_dioxide: 40, ozone: 100, carbon_monoxide: 4000,
};

export const POLLUTANTS = [
  { key: 'pm2_5', label: 'PM2.5', name: 'Fine particles' },
  { key: 'pm10', label: 'PM10', name: 'Coarse particles' },
  { key: 'ozone', label: 'O₃', name: 'Ozone' },
  { key: 'nitrogen_dioxide', label: 'NO₂', name: 'Nitrogen dioxide' },
  { key: 'sulphur_dioxide', label: 'SO₂', name: 'Sulphur dioxide' },
  { key: 'carbon_monoxide', label: 'CO', name: 'Carbon monoxide' },
];

// Pollen (grains/m³) — CAMS Europe only. Thresholds are indicative bands.
export const POLLEN = [
  { key: 'alder_pollen', label: 'Alder' },
  { key: 'birch_pollen', label: 'Birch' },
  { key: 'grass_pollen', label: 'Grass' },
  { key: 'mugwort_pollen', label: 'Mugwort' },
  { key: 'olive_pollen', label: 'Olive' },
  { key: 'ragweed_pollen', label: 'Ragweed' },
];
export function pollenLevel(v) {
  if (!isNum(v)) return null;
  if (v < 1) return { label: 'None', level: 0 };
  if (v < 10) return { label: 'Low', level: 1 };
  if (v < 50) return { label: 'Moderate', level: 2 };
  if (v < 200) return { label: 'High', level: 3 };
  return { label: 'Very high', level: 4 };
}
