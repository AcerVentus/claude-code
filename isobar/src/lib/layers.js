// Catalogue of the Globe view's layers. Model fields come from Environment
// and Climate Change Canada's MSC GeoMet WMS (GDPS 15 km global weather
// model, GDWPS 25 km wave model, GIOPS ocean model); observed fields from
// NASA GIBS; radar from RainViewer. Every legend is metric.

export const GEOMET = 'https://geo.weather.gc.ca/geomet';
export const GIBS = 'https://gibs.earthdata.nasa.gov';

const GDPS = 'ECCC GDPS · 15 km global weather model';
const GDWPS = 'ECCC GDWPS · 25 km global wave model';
const GIOPS = 'ECCC GIOPS · global ice–ocean model';

const pct = (v) => ({ text: `${Math.round(v)} %` });

export const LAYER_GROUPS = [
  {
    title: 'Sky & rain',
    layers: [
      { id: 'cloud', name: 'Cloud cover', kind: 'wms', valid: [0, 100], layer: 'GDPS_15km_TotalCloudCover', style: 'CLOUD', source: GDPS, opacity: 0.8,
        desc: 'Share of the sky covered by cloud at all levels. White is overcast.', probe: pct },
      { id: 'rain', name: 'Rain & snow rate', kind: 'wms', valid: [0, 0.2], layer: 'GDPS_15km_PrecipRate', style: 'PRECIPPRTMMH', source: GDPS,
        desc: 'How hard it is forecast to be raining or snowing at that moment, in millimetres per hour.',
        probe: (v) => ({ text: `${(v * 3600).toFixed(v * 3600 < 1 ? 2 : 1)} mm/h` }), empty: 'No precipitation here at this time.' },
      { id: 'rain24', name: 'Rain total, 24 h', kind: 'wms', valid: [0, 3000], layer: 'GDPS_15km_Precip-Accum24h', style: 'PRECIPMM', source: GDPS,
        desc: 'Precipitation accumulated over the 24 hours ending at the selected time.', probe: (v) => ({ text: `${v.toFixed(1)} mm in 24 h` }), empty: 'Dry.' },
      { id: 'radar', name: 'Rain radar', kind: 'radar', source: 'RainViewer · mosaic of national weather radars', tag: 'observed',
        desc: 'What radars are actually seeing, for the last two hours. Coverage follows where countries run and share radars, so large gaps (oceans, much of Africa and the Middle East) are missing data, not clear skies.' },
      { id: 'imerg', name: 'Rainfall from space', kind: 'gibs', layer: 'IMERG_Precipitation_Rate_30min', level: 6, ext: 'png', time: 'latest', legend: 'GPM_Precipitation_Rate_H.svg', tag: 'observed',
        source: 'NASA GPM IMERG · satellite precipitation estimate', desc: 'Satellite-estimated rain and snow rate between 60°N and 60°S, including over oceans where there is no radar. Latest half-hour available, typically a few hours old.' },
      { id: 'satellite', name: 'Satellite, true colour', kind: 'gibs', opacity: 1, layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', level: 9, ext: 'jpg', time: 'yesterday', tag: 'observed',
        source: 'NASA / NOAA-20 VIIRS · daily mosaic', desc: 'Yesterday\'s daytime passes stitched into one picture: real cloud, snow, dust and smoke as a camera sees them.' },
    ],
  },
  {
    title: 'Storms',
    layers: [
      { id: 'thunder', name: 'Thunderstorm probability', kind: 'wms', valid: [0, 100], layer: 'GDPS-WEonG_15km_Thunderstorm-Prob', style: 'Thunderstorm-Prob', source: `${GDPS} (weather-elements product, experimental)`,
        desc: 'Chance of a thunderstorm at each point, post-processed from the global model.', probe: pct, empty: 'Below 5 %.' },
      { id: 'cape', name: 'Storm energy · hail potential', kind: 'wms', valid: [0, 12000], layer: 'GDPS_15km_MU-CAPE', style: 'CAPE_COARSE', source: GDPS,
        desc: 'Convective available potential energy of the most unstable air parcel. No public global model publishes hail directly; this is its main ingredient. Above roughly 1 000 J/kg storms can be strong, and above 2 500 J/kg they can carry large hail if something triggers them.',
        probe: (v) => ({ text: `${Math.round(v)} J/kg`, note: v >= 2500 ? 'Extreme instability' : v >= 1000 ? 'Strong instability' : v >= 300 ? 'Modest instability' : 'Stable' }), empty: 'Below 50 J/kg — stable air.' },
      { id: 'gust', name: 'Wind gusts', kind: 'wms', valid: [0, 150], layer: 'GDPS_15km_WindGust_10m', style: 'GUST_MS2KMH', source: GDPS, wind: true,
        desc: 'Strongest gusts expected at 10 m above ground. Legend in km/h.' },
      { id: 'wind', name: 'Wind speed', kind: 'wms', valid: [0, 150], layer: 'GDPS_15km_WindSpeed_10m', style: 'WINDSPEEDKMH', source: GDPS, wind: true,
        desc: 'Sustained wind at 10 m above ground. Legend in km/h. Turn on wind arrows to see direction.' },
    ],
  },
  {
    title: 'Temperature & pressure',
    layers: [
      { id: 'temp', name: 'Temperature', kind: 'wms', valid: [-95, 65], layer: 'GDPS_15km_AirTemp_2m', style: 'TEMPERATURE', source: GDPS,
        desc: 'Air temperature 2 m above ground.', probe: (v) => ({ text: `${v.toFixed(1)} °C` }) },
      { id: 'pressure', name: 'Sea-level pressure', kind: 'wms', valid: [85000, 110000], layer: 'GDPS_15km_Pressure_MSL', style: 'PRESSURE4', source: GDPS,
        desc: 'Mean sea-level pressure in hectopascals (the legend\'s “mb” is the same unit). Turn on isobars for the classic chart.', probe: (v) => ({ text: `${(v / 100).toFixed(0)} hPa` }) },
      { id: 'uv', name: 'UV index', kind: 'wms', valid: [0, 25], layer: 'GDPS_15km_UVIndex', style: 'UVIndex_LowtoExtreme_Dis', source: GDPS,
        desc: 'Forecast UV index including the effect of cloud.', probe: (v) => ({ text: `UV ${v.toFixed(1)}` }), empty: 'Night or negligible UV.' },
    ],
  },
  {
    title: 'Snow & ice',
    layers: [
      { id: 'snowdepth', name: 'Snow on the ground', kind: 'wms', valid: [0, 50], layer: 'GDPS_15km_SnowDepth', style: 'SNOWDEPTH', source: GDPS,
        desc: 'Modelled depth of lying snow. Legend in centimetres.', probe: (v) => ({ text: `${(v * 100).toFixed(0)} cm` }), empty: 'No lying snow.' },
      { id: 'snowprob', name: 'Chance of snow', kind: 'wms', valid: [0, 100], layer: 'GDPS-WEonG_15km_Snow-Prob', style: 'Snow-Prob', source: `${GDPS} (weather-elements product, experimental)`,
        desc: 'Probability that snow is falling at the selected time.', probe: pct, empty: 'Below 5 %.' },
      { id: 'snowcover', name: 'Snow cover from space', kind: 'gibs', layer: 'MODIS_Terra_NDSI_Snow_Cover', level: 8, ext: 'png', time: 'yesterday', legend: 'MODIS_NDSI_Snow_Cover_H.svg', tag: 'observed',
        source: 'NASA Terra MODIS · daily snow index', desc: 'Where the satellite saw snow yesterday. Cloud and polar night hide the surface, which is why the picture has holes.' },
      { id: 'seaice', name: 'Sea ice', kind: 'wms', valid: [0, 1], layer: 'OCEAN.GIOPS.2D_GL', style: 'SEA_ICECONC', source: GIOPS,
        desc: 'Fraction of the sea surface covered by ice.', probe: (v) => ({ text: `${Math.round(v * 100)} % ice` }), empty: 'Open water or land.' },
    ],
  },
  {
    title: 'Ocean',
    layers: [
      { id: 'waves', name: 'Wave height', kind: 'wms', valid: [0, 40], layer: 'GDWPS_25km_HTSGW_PT3H', style: 'MODELWAVEHEIGHT_OCEAN', source: GDWPS,
        desc: 'Significant height of the combined sea and swell: the average of the highest third of waves. Individual waves can be twice as high.', probe: (v) => ({ text: `${v.toFixed(1)} m` }), empty: 'Land or ice.' },
      { id: 'swell', name: 'Swell height', kind: 'wms', valid: [0, 40], layer: 'GDWPS_25km_SWHFSWEL_PT3H', style: 'MODELWAVEHEIGHT_OCEAN', source: GDWPS,
        desc: 'Height of the primary swell: waves that have travelled out of the storms that made them.', probe: (v) => ({ text: `${v.toFixed(1)} m` }), empty: 'No swell here.' },
      { id: 'period', name: 'Wave period', kind: 'wms', valid: [0, 40], layer: 'GDWPS_25km_PWPER_PT3H', style: 'MODELWAVEPERIOD_OCEAN', source: GDWPS,
        desc: 'Seconds between the most energetic waves. Long periods (12 s and more) mean powerful ocean swell.', probe: (v) => ({ text: `${v.toFixed(1)} s` }), empty: 'Land or ice.' },
      { id: 'currents', name: 'Ocean currents', kind: 'wms', valid: [0, 10], layer: 'OCEAN.GIOPS.2D_UU2W', style: 'SeaWaterVelocity_Dis_0.05-20', source: GIOPS, vector: true,
        desc: 'Surface current speed and direction. The Gulf Stream, Kuroshio and Agulhas stand out as bright ribbons. This global model does not include tidal streams.' },
      { id: 'sst', name: 'Sea surface temperature', kind: 'gibs', layer: 'GHRSST_L4_MUR_Sea_Surface_Temperature', level: 7, ext: 'png', time: 'latest', legend: 'GHRSST_Sea_Surface_Temperature_H.svg', tag: 'observed',
        source: 'NASA JPL MUR · satellite and buoy analysis, 1 km', desc: 'Measured sea-surface temperature, blended daily from satellites and buoys. Usually one to two days old.' },
    ],
  },
  {
    title: 'Drought & land',
    layers: [
      { id: 'rootzone', name: 'Root-zone soil moisture', kind: 'gibs', layer: 'SMAP_L4_Analyzed_Root_Zone_Soil_Moisture', level: 6, ext: 'png', time: 'latest', legend: 'SMAP_Analyzed_Soil_Moisture_H.svg', tag: 'observed',
        source: 'NASA SMAP Level 4 · satellite microwave + land model, 9 km', desc: 'Water in the top metre of soil, the layer crops and vegetation draw on. Persistently dry root zones are what agricultural drought looks like. This shows the amount of water, not how unusual it is for the season: deserts are always dry here.' },
      { id: 'soil', name: 'Topsoil moisture forecast', kind: 'wms', valid: [0, 1], layer: 'GDPS_15km_SoilVolumetricWaterContent_0-10cm', style: 'WATERCONTENTSOIL', source: GDPS,
        desc: 'Forecast water content of the top 10 cm of soil (m³ of water per m³ of soil). It responds within hours to rain and drying winds.', probe: (v) => ({ text: `${(v * 100).toFixed(0)} % by volume` }), empty: 'Sea or ice.' },
    ],
  },
];

export const OVERLAYS = [
  { id: 'isobars', name: 'Isobars', layer: 'GDPS_15km_Pressure_MSL-Contour', style: 'SeaLevelPressure_4mb', note: 'Lines of equal sea-level pressure, every 4 hPa' },
  { id: 'arrows', name: 'Wind arrows', layer: 'GDPS_15km_Winds_10m', style: 'WINDARROWKMH', note: 'Direction and strength at 10 m' },
];

export const ALL_LAYERS = LAYER_GROUPS.flatMap((g) => g.layers);

/** Parse a WMS time dimension ("a/b/PT3H", "t1,t2,…" or a mix) into ascending ms timestamps. */
export function parseTimeDimension(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes('/')) {
      const [a, b, step] = p.split('/');
      const start = Date.parse(a), end = Date.parse(b);
      const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(step || '');
      const stepMs = m ? ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600e3 + (+m[3] || 0) * 60e3 : 0;
      if (!Number.isFinite(start) || !Number.isFinite(end) || !(stepMs > 0)) continue;
      for (let t = start; t <= end && out.length < 2000; t += stepMs) out.push(t);
    } else {
      const t = Date.parse(p);
      if (Number.isFinite(t)) out.push(t);
    }
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

/** ISO string as WMS wants it: seconds precision, Z. */
export const wmsTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
