// Panels, part one: hero, alerts, hourly, daily, cross-check, rain nowcast
// and the small instrument tiles.

import { LEVELS, VARS, consensus, valueAt } from '../lib/consensus.js';
import { CONDITIONS, GROUP_LABELS, condGroup, describe } from '../lib/conditions.js';
import { fmt, fmtTemp, fmtWind, windUnitLabel, windValue, compass, beaufort, uvCategory, dewComfort, visibilityLabel, fmtCoords, escapeHtml as esc, isNum } from '../lib/units.js';
import { fmtTime, fmtHour, fmtWeekday, fmtDayMonth, fmtRelative, dateKey, zonedParts, HOUR } from '../lib/time.js';
import { position, lightPhase } from '../lib/astro.js';
import { pressureTendency } from '../lib/model.js';
import { quip, mood } from '../lib/snark.js';
import { weatherIcon, uiIcon, fromArrow } from './icons.js';
import { scale, niceRange, niceTicks, smoothPath, linePath, bandPath, areaPath, bar, yGrid, svgOpen, polar, attachHover } from './charts.js';

// ------------------------------------------------------------ shared bits

export const innerWidth = (el) => {
  const cs = getComputedStyle(el);
  return Math.max(200, Math.floor(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
};

export function head(id, title, right = '') {
  return `<div class="p-head"><h2 class="p-title" id="${id}">${title}</h2>${right}</div>`;
}

/** Confidence chip. `r` is a consensus/overall result or a level string. */
export function conf(r, { detail = null, text = null, tag = 'span' } = {}) {
  const level = typeof r === 'string' ? r : r?.level;
  if (!level) return '';
  const label = text ?? (level === 'official' ? 'Official' : LEVELS[level]?.short ?? level);
  const n = typeof r === 'object' && r?.n ? ` · ${r.n} source${r.n === 1 ? '' : 's'}` : '';
  const title = level === 'single' ? 'Only one source reports this, so it cannot be cross-checked' : `${LEVELS[level]?.label ?? label}${n}`;
  if (detail) return `<button type="button" class="conf ${level}" data-detail="${detail}" title="${title} — show sources">${label}</button>`;
  return `<${tag} class="conf ${level}" title="${title}">${label}</${tag}>`;
}

export const skeleton = (id, title) => `${head(id, title)}<div class="skel" style="width:55%"></div><div class="skel tall"></div><div class="skel" style="width:35%"></div>`;
export const unavailable = (id, title, why) => `${head(id, title)}<p class="empty">${why}</p>`;

const feedDown = (state, keys) => keys.every((k) => ['error', 'none', 'skip'].includes(state.status[k]?.state));
const feedLoading = (state, keys) => keys.some((k) => state.status[k]?.state === 'loading');

function isDayAt(t, place) {
  return position('sun', t, place.lat, place.lon).altitude > -0.833;
}

const unitFor = (key, settings) => (key === 'wind' || key === 'gust' ? windUnitLabel(settings.wind) : VARS[key].unit);
function fmtVar(key, value, settings) {
  if (!isNum(value)) return '—';
  if (key === 'wind' || key === 'gust') return fmtWind(value, settings.wind);
  if (key === 'dir') return `${compass(value)} ${fmt(value)}°`;
  return fmt(value, key === 'temp' || key === 'feels' || key === 'dew' ? 1 : VARS[key].digits);
}
const spreadText = (key, r, settings) => {
  if (!r || r.n < 2) return 'single source';
  const s = key === 'wind' || key === 'gust' ? windValue(r.sigma, settings.wind) : r.sigma;
  return `±${fmt(s, s < 10 ? 1 : 0)} across ${r.n}`;
};

// ------------------------------------------------------------------ hero

export function renderHero(el, { state, v, settings }) {
  if (!v?.current?.vars.temp) {
    const failed = !state.loading && !!state.loadedAt;
    el.innerHTML = `<div class="hero-skeleton"><div class="hero-meta">${failed ? 'No forecast source could be reached' : 'Gathering sources…'}</div>
      <div class="hero-place">${esc(state.place?.name || '')}</div>
      <p class="hero-sub">${failed ? 'Check your connection and press refresh. Sun, moon and anything cached still show below.' : 'Asking six weather models and up to four services for a second opinion.'}</p></div>`;
    return { phase: 'day', cloud: 40, group: null };
  }
  const { tz, place, now } = v;
  const c = v.current;
  const T = c.vars.temp;
  const today = v.days?.[0];
  const sunAlt = v.astro.sunPos.altitude;
  const isDay = sunAlt > -0.833;
  const code = c.condition.code;
  const group = condGroup(code);
  const feels = c.vars.feels?.value ?? null;
  const uvNow = v.blend ? valueAt(v.blend.extra.t, v.blend.extra.uv, now, HOUR) : null;
  const aqiKey = settings.aqi === 'eu' ? 'european_aqi' : 'us_aqi';
  const aqi = v.air?.current?.[aqiKey] ?? null;
  const p = zonedParts(now, tz);
  const seed = p.y * 400 + p.m * 31 + p.d + (isDay ? 0 : 7);
  const line = quip({ code, group, feels, gust: c.vars.gust?.value, dew: c.vars.dew?.value, aqi: v.air?.current?.us_aqi, uv: uvNow, isDay }, settings.voice, seed);
  const voteTxt = c.condition.vote ? `${c.condition.vote.count} of ${c.condition.vote.total} sources say ${GROUP_LABELS[c.condition.vote.winner] || 'this'}` : '';

  const sub = [];
  if (isNum(feels)) sub.push(`Feels like <b>${fmtTemp(feels)}</b>`);
  if (today?.tmax) sub.push(`High <b>${fmtTemp(today.tmax.value)}</b>`);
  if (today?.tmin) sub.push(`Low <b>${fmtTemp(today.tmin.value)}</b>`);

  const stats = [];
  const W = c.vars.wind, G = c.vars.gust, D = c.vars.dir;
  stats.push(`<div class="hero-stat"><span>Wind</span><b>${W ? fmtWind(W.value, settings.wind) : '—'}<small>${windUnitLabel(settings.wind)}</small></b><em>${D && !D.calm ? `${compass(D.value)} ` : ''}${G ? `gusts ${fmtWind(G.value, settings.wind)}` : ''}</em></div>`);
  stats.push(`<div class="hero-stat"><span>Humidity</span><b>${c.vars.rh ? fmt(c.vars.rh.value) : '—'}<small>%</small></b><em>${c.vars.dew ? `dew point ${fmtTemp(c.vars.dew.value)}` : ''}</em></div>`);
  stats.push(`<div class="hero-stat"><span>Pressure</span><b>${c.vars.pressure ? fmt(c.vars.pressure.value) : '—'}<small>hPa</small></b><em>${pressureNow(v)?.label ?? ''}</em></div>`);
  if (isNum(aqi)) stats.push(`<div class="hero-stat"><span>${settings.aqi === 'eu' ? 'EU AQI' : 'US AQI'}</span><b>${fmt(aqi)}</b><em>${esc(aqiLabel(aqi, settings.aqi))}</em></div>`);
  else stats.push(`<div class="hero-stat"><span>UV index</span><b>${isNum(uvNow) ? fmt(uvNow) : '—'}</b><em>${uvCategory(uvNow)?.label ?? ''}</em></div>`);

  const offsetNote = Intl.DateTimeFormat().resolvedOptions().timeZone !== tz ? ` ${v.blend?.tzAbbr || ''}` : '';
  el.innerHTML = `
    <div class="hero-main">
      <div class="hero-meta"><span>${fmtWeekday(now, tz, true)} ${fmtDayMonth(now, tz)} · ${fmtTime(now, tz, settings.h12)}${esc(offsetNote)}</span><span>${fmtCoords(place.lat, place.lon)}</span>${isNum(v.elevation) ? `<span>${fmt(v.elevation)} m</span>` : ''}</div>
      <h1 class="hero-place">${esc(place.name)}</h1>
      <div class="hero-now">
        <div class="hero-temp num" aria-label="Temperature ${fmt(T.value)} degrees Celsius">${fmt(T.value)}<sup>°C</sup></div>
        <div class="hero-cond">
          <div class="hero-cond-top">${weatherIcon(CONDITIONS[code]?.icon, isDay, 40)}<span>${esc(describe(code, isDay))}</span></div>
          <div class="hero-sub">${sub.map((s) => `<span>${s}</span>`).join('')}</div>
        </div>
      </div>
      <p class="hero-quip">${esc(line)}</p>
    </div>
    <div class="hero-side">
      <div class="glass agree">
        <div class="agree-head"><span class="agree-title">Source agreement · temperature now</span>${conf(T, { detail: 'temp', text: `${LEVELS[T.level].label} · ${T.n} source${T.n === 1 ? '' : 's'}` })}</div>
        ${agreementStrip(c, v.ensemble, now)}
        <p class="agree-text">${agreementText(c, voteTxt)}</p>
      </div>
      <div class="glass hero-stats">${stats.join('')}</div>
    </div>`;
  const rising = v.astro.sunRising;
  return { phase: lightPhase(sunAlt, rising), cloud: c.vars.cloud?.value ?? 0, group, windDir: D?.value ?? 270, windSpeed: W?.value ?? 0, mood: mood({ code, group, feels, isDay }) };
}

function aqiLabel(value, scaleKey) {
  const us = [[50, 'Good'], [100, 'Moderate'], [150, 'Unhealthy for sensitive'], [200, 'Unhealthy'], [300, 'Very unhealthy'], [Infinity, 'Hazardous']];
  const eu = [[20, 'Good'], [40, 'Fair'], [60, 'Moderate'], [80, 'Poor'], [100, 'Very poor'], [Infinity, 'Extremely poor']];
  return (scaleKey === 'eu' ? eu : us).find(([max]) => value <= max)[1];
}

function agreementText(c, voteTxt) {
  const T = c.vars.temp;
  if (T.n < 2) return 'Only one source answered, so this reading could not be cross-checked.';
  const outliers = T.used.filter((u) => u.outlier).length;
  const parts = [`${T.n - outliers} of ${T.n} sources sit between ${fmt(T.min, 1)}° and ${fmt(T.max, 1)}°`];
  if (outliers) parts.push(`${outliers} outlier${outliers > 1 ? 's' : ''} set aside`);
  if (voteTxt) parts.push(voteTxt);
  return `${parts.join(' · ')}.`;
}

function agreementStrip(c, ens, now) {
  const T = c.vars.temp;
  const vals = T.used.map((u) => u.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(0.6, (hi - lo) * 0.18);
  lo -= pad; hi += pad;
  const w = 340, h = 58, x = scale(lo, hi, 10, w - 10), y0 = 30;
  const kind = Object.fromEntries(c.rows.map((r) => [r.id, r.kind]));
  // stack dots that would overlap
  const placed = [];
  const dots = [...T.used].sort((a, b) => a.value - b.value).map((u) => {
    const cx = x(u.value);
    let row = 0;
    while (placed.some((p) => p.row === row && Math.abs(p.cx - cx) < 9)) row++;
    placed.push({ cx, row });
    const cy = y0 - row * 8.5;
    return `<circle class="ag-dot${kind[u.id] === 'observation' ? ' obs' : ''}${u.outlier ? ' out' : ''}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4"/>`;
  }).join('');
  const band = T.n >= 2 ? `<rect class="ag-band" x="${x(T.value - T.sigma).toFixed(1)}" y="${y0 - 12}" width="${Math.max(2, x(T.value + T.sigma) - x(T.value - T.sigma)).toFixed(1)}" height="24" rx="4"/>` : '';
  const hasObs = c.rows.some((r) => r.kind === 'observation');
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Each dot is one source's temperature; the line marks the median">
    ${band}<line class="ag-axis" x1="6" x2="${w - 6}" y1="${y0 + 8}" y2="${y0 + 8}"/>
    <line class="ag-med" x1="${x(T.value).toFixed(1)}" x2="${x(T.value).toFixed(1)}" y1="${y0 - 16}" y2="${y0 + 11}"/>${dots}
    <text x="6" y="${h - 3}">${fmt(lo, 1)}°</text><text x="${w - 6}" y="${h - 3}" text-anchor="end">${fmt(hi, 1)}°</text>
    <text x="${x(T.value).toFixed(1)}" y="${h - 3}" text-anchor="middle">median ${fmt(T.value, 1)}°</text></svg>
    <div class="agree-legend"><span><i></i>forecast source</span>${hasObs ? '<span><i class="obs"></i>weather station</span>' : ''}<span><i class="med"></i>median</span></div>`;
}

function pressureNow(v) {
  if (!v.blend) return null;
  const h = v.blend.source.hourly;
  const a = valueAt(h.t, h.pressure, v.now, HOUR), b = valueAt(h.t, h.pressure, v.now - 3 * HOUR, HOUR);
  return isNum(a) && isNum(b) ? { ...pressureTendency(a - b), delta: a - b } : null;
}

// ---------------------------------------------------------------- alerts

function advisories(v, settings) {
  const out = [];
  const { now, tz } = v;
  const H = v.hourly;
  if (!H) return out;
  const next = (n) => Array.from({ length: n }, (_, i) => i);
  const gusts = next(24).map((i) => ({ t: H.t[i], g: H.gust.value[i] })).filter((x) => isNum(x.g));
  const top = gusts.reduce((a, b) => (b.g > (a?.g ?? -1) ? b : a), null);
  if (top && top.g >= 70) out.push({ event: 'Strong wind', headline: `Gusts to ${fmtWind(top.g, settings.wind)} ${windUnitLabel(settings.wind)} around ${fmtTime(top.t, tz, settings.h12)}`, body: 'Secure loose objects; expect difficult conditions for high-sided vehicles and on exposed routes.' });
  const feelsMax = Math.max(...next(24).map((i) => H.feels.value[i]).filter(isNum), -Infinity);
  if (feelsMax >= 38) out.push({ event: 'Heat', headline: `Feels like up to ${fmt(feelsMax)}° in the next 24 hours`, body: 'Drink water regularly, avoid exertion in the afternoon and check on anyone vulnerable to heat.' });
  const tmin = Math.min(...next(24).map((i) => H.temp.value[i]).filter(isNum), Infinity);
  if (tmin <= -10) out.push({ event: 'Severe cold', headline: `Down to ${fmt(tmin)}° in the next 24 hours`, body: 'Cover exposed skin and limit time outdoors.' });
  const thunderAt = next(12).find((i) => condGroup(H.code[i]) === 'thunder');
  if (thunderAt != null) out.push({ event: 'Thunderstorms', headline: `Thunderstorms possible ${thunderAt === 0 ? 'now' : `around ${fmtTime(H.t[thunderAt], tz, settings.h12)}`}`, body: 'When thunder is audible, lightning is close enough to strike. Shelter indoors or in a vehicle.' });
  const rain24 = next(24).map((i) => H.precip.value[i]).filter(isNum).reduce((a, b) => a + b, 0);
  if (rain24 >= 30) out.push({ event: 'Heavy rain', headline: `About ${fmt(rain24)} mm expected in the next 24 hours`, body: 'Watch for standing water and local flooding in low-lying places.' });
  if (v.blend) {
    const e = v.blend.extra;
    let uvMax = null, at = null;
    e.t.forEach((t, i) => { if (t >= now && t <= now + 12 * HOUR && isNum(e.uv[i]) && e.uv[i] > (uvMax ?? 0)) { uvMax = e.uv[i]; at = t; } });
    if (uvMax >= 8) out.push({ event: 'Very high UV', headline: `UV index peaks at ${fmt(uvMax)} around ${fmtTime(at, tz, settings.h12)}`, body: 'Unprotected skin can burn in well under half an hour. Use shade, clothing and sunscreen.' });
  }
  const aqi = v.air?.current?.us_aqi;
  if (isNum(aqi) && aqi >= 151) out.push({ event: 'Unhealthy air', headline: `US AQI ${fmt(aqi)}`, body: 'Reduce prolonged or heavy exertion outdoors; sensitive groups should stay inside.' });
  return out;
}

export function renderAlerts(el, { v, settings }) {
  if (!v) { el.innerHTML = ''; return; }
  const { tz } = v;
  const official = (v.alerts || []).map((a) => `
    <details class="alert ${esc(a.severity)}"><summary>${uiIcon('alert', 20)}<b>${esc(a.event.charAt(0).toUpperCase() + a.event.slice(1))}</b>
      <span>${esc(a.source)}${a.ends ? ` · until ${fmtWeekday(a.ends, tz)} ${fmtTime(a.ends, tz, settings.h12)}` : ''}</span></summary>
      <div class="alert-body"><b>${esc(a.headline || '')}</b>\n${esc(a.description)}${a.instruction ? `\n\n${esc(a.instruction)}` : ''}</div></details>`);
  const derived = advisories(v, settings).map((a) => `
    <details class="alert advice"><summary>${uiIcon('info', 20)}<b>${esc(a.event)}</b><span>${esc(a.headline)}</span></summary>
      <div class="alert-body">${esc(a.body)}\n\nIsobar advisory, worked out from the forecast consensus. It is not an official warning.</div></details>`);
  el.innerHTML = official.join('') + derived.join('');
}

// ---------------------------------------------------------------- hourly

const METRICS = [
  { key: 'temp', label: 'Temperature', cls: 's2', unit: '°' },
  { key: 'feels', label: 'Feels like', cls: 's2', unit: '°' },
  { key: 'precip', label: 'Rain', cls: '', unit: 'mm' },
  { key: 'wind', label: 'Wind', cls: 's3', unit: 'wind' },
  { key: 'rh', label: 'Humidity', cls: '', unit: '%' },
  { key: 'pressure', label: 'Pressure', cls: 's5', unit: 'hPa' },
  { key: 'cloud', label: 'Cloud', cls: 'ink', unit: '%' },
];

export function renderHourly(el, ctx) {
  const { state, v, settings, ui } = ctx;
  if (!v?.hourly) {
    el.innerHTML = feedLoading(state, ['models', 'metno', 'forecast']) ? skeleton('h-hourly', 'Next 48 hours') : unavailable('h-hourly', 'Next 48 hours', 'No forecast source could be reached.');
    return;
  }
  const prevScroll = el.querySelector('.scroller')?.scrollLeft ?? 0;
  const { tz, place, now } = v;
  const H = v.hourly;
  const metric = METRICS.find((m) => m.key === ui.hourlyMetric) || METRICS[0];
  const N = 48;
  const narrow = innerWidth(el) < 520;
  const colW = narrow ? 46 : 54;
  const padL = 34, padR = 12;
  const W = padL + N * colW + padR;
  const yTop = 78, yBot = 172, rainTop = 186, rainBot = 208, height = 232;
  const X = (i) => padL + i * colW + colW / 2;
  const windU = (x) => (metric.unit === 'wind' ? windValue(x, settings.wind) : x);
  const series = H[metric.key].value.slice(0, N).map(windU);
  const ens = metric.key === 'temp' && v.ensemble ? v.ensemble : null;
  const bandLo = ens ? H.t.slice(0, N).map((t) => valueAt(ens.t, ens.tempP10, t, 0)) : [];
  const bandHi = ens ? H.t.slice(0, N).map((t) => valueAt(ens.t, ens.tempP90, t, 0)) : [];
  const gusts = metric.key === 'wind' ? H.gust.value.slice(0, N).map(windU) : [];
  const all = [...series, ...bandLo, ...bandHi, ...gusts].filter(isNum);
  if (!all.length) { el.innerHTML = unavailable('h-hourly', 'Next 48 hours', 'No hourly values available.'); return; }
  let [y0, y1] = niceRange(Math.min(...all), Math.max(...all), 3, ['precip', 'wind', 'rh', 'cloud'].includes(metric.key));
  if (metric.key === 'rh' || metric.key === 'cloud') { y0 = 0; y1 = 100; }
  if (metric.key === 'precip') y1 = Math.max(y1, 2);
  const sy = scale(y0, y1, yBot, yTop);
  const ticks = niceTicks(y0, y1, 3);
  const unitLabel = metric.unit === 'wind' ? windUnitLabel(settings.wind) : metric.unit;

  let svg = svgOpen(W, height, `${metric.label} for the next 48 hours`);
  // night shading
  const day = H.t.slice(0, N).map((t) => isDayAt(t + HOUR / 2, place));
  for (let i = 0; i < N; i++) if (!day[i]) svg += `<rect class="c-night" x="${padL + i * colW}" y="${yTop - 6}" width="${colW}" height="${rainBot - yTop + 8}"/>`;
  svg += yGrid(ticks, sy, padL, W - padR, (x) => fmt(x, y1 - y0 < 4 ? 1 : 0));
  svg += `<text class="c-tick" x="${padL - 6}" y="${yTop - 12}" text-anchor="end">${unitLabel}</text>`;

  const pts = series.map((val, i) => [X(i), isNum(val) ? sy(val) : null]);
  if (metric.key === 'precip') {
    series.forEach((val, i) => { if (isNum(val) && val > 0) svg += bar(X(i) - colW * 0.3, sy(val), colW * 0.6, yBot, 'c-bar'); });
  } else {
    if (ens) svg += `<path class="c-band s2" d="${bandPath(bandHi.map((b, i) => [X(i), isNum(b) ? sy(b) : null]), bandLo.map((b, i) => [X(i), isNum(b) ? sy(b) : null]))}"/>`;
    if (metric.key === 'cloud' || metric.key === 'rh') svg += `<path class="c-area ${metric.cls}" d="${areaPath(pts, yBot, true)}"/>`;
    if (gusts.length) svg += `<path class="c-line s3 dash" d="${smoothPath(gusts.map((g, i) => [X(i), isNum(g) ? sy(g) : null]))}"/>`;
    svg += `<path class="c-line ${metric.cls}" d="${smoothPath(pts)}"/>`;
  }

  // column furniture
  const every = narrow ? 3 : 2;
  const maxRain = Math.max(2, ...H.precip.value.slice(0, N).filter(isNum));
  const rs = scale(0, maxRain, rainBot, rainTop);
  const hover = [];
  for (let i = 0; i < N; i++) {
    const t = H.t[i];
    const p = zonedParts(t, tz);
    const x = X(i);
    if (p.h === 0 || i === 0) svg += `<text class="c-label" x="${x}" y="12" text-anchor="middle">${i === 0 ? 'Now' : fmtWeekday(t, tz)}</text>`;
    svg += `<text class="c-tick" x="${x}" y="27" text-anchor="middle">${fmtHour(t, tz, settings.h12)}</text>`;
    const lvl = H.confidence[i]?.level;
    if (lvl) svg += `<rect x="${padL + i * colW + 2}" y="33" width="${colW - 4}" height="3" rx="1.5" fill="var(--${lvl === 'high' ? 'good' : lvl === 'medium' ? 'warn' : lvl === 'low' ? 'bad' : 'mute'})"/>`;
    const icon = CONDITIONS[H.code[i]]?.icon;
    if (icon && i % (narrow ? 2 : 1) === 0) svg += weatherIcon(icon, day[i], 22).replace('<svg ', `<svg x="${x - 11}" y="42" `);
    const val = series[i];
    if (isNum(val) && i % every === 0 && metric.key !== 'precip') {
      svg += `<circle class="c-dot ${metric.cls}" cx="${x}" cy="${sy(val)}" r="3.5"/><text class="c-label" x="${x}" y="${sy(val) - 9}" text-anchor="middle">${fmt(val, metric.key === 'wind' && settings.wind === 'ms' ? 1 : 0)}${metric.unit === '°' ? '°' : ''}</text>`;
    }
    const rain = H.precip.value[i];
    if (metric.key !== 'precip' && isNum(rain) && rain > 0) svg += bar(x - colW * 0.28, rs(rain), colW * 0.56, rainBot, 'c-bar faint', 2);
    const pop = H.pop[i];
    if (isNum(pop) && pop >= 10 && i % every === 0) svg += `<text class="c-tick" x="${x}" y="${rainBot + 15}" text-anchor="middle">${fmt(pop)}%</text>`;

    const r = (k) => H[k];
    const sig = r(metric.key).sigma[i], n = r(metric.key).n[i];
    const lines = [`<b>${fmtWeekday(t, tz)} ${fmtTime(t, tz, settings.h12)} · ${esc(describe(H.code[i], day[i]))}</b>`];
    lines.push(`<span>${fmtTemp(H.temp.value[i])} (feels ${fmtTemp(H.feels.value[i])}) ±${fmt(H.temp.sigma[i] ?? 0, 1)}° across ${H.temp.n[i]} sources</span>`);
    if (ens && isNum(bandLo[i])) lines.push(`<span>Ensemble 10–90%: ${fmt(bandLo[i])}° to ${fmt(bandHi[i])}°</span>`);
    lines.push(`<span>Rain ${isNum(rain) ? fmt(rain, 1) : '—'} mm${isNum(pop) ? ` · ${fmt(pop)}% chance` : ''}</span>`);
    lines.push(`<span>Wind ${fmtWind(H.wind.value[i], settings.wind)} ${windUnitLabel(settings.wind)} ${compass(H.dir.value[i])}, gusts ${fmtWind(H.gust.value[i], settings.wind)}</span>`);
    if (!['temp', 'feels', 'precip', 'wind'].includes(metric.key)) lines.push(`<span>${metric.label} ${fmt(val)} ${unitLabel}${n > 1 ? ` ±${fmt(sig, 1)} across ${n}` : ''}</span>`);
    lines.push(`<span>Agreement: ${LEVELS[lvl]?.label.toLowerCase() ?? '—'}</span>`);
    hover.push({ x, html: lines.join('') });
  }
  svg += `<text class="c-tick" x="${padL - 6}" y="${rainBot}" text-anchor="end">rain</text></svg>`;

  const tabs = METRICS.map((m) => `<button type="button" class="tab" data-metric="${m.key}" aria-pressed="${m.key === metric.key}">${m.label}</button>`).join('');
  const legend = [];
  if (ens) legend.push('<span><i class="band s2"></i>ECMWF ensemble 10–90% range</span>');
  if (gusts.length) legend.push('<span><i class="s3" style="border-color:var(--series-3)"></i>sustained</span><span><i class="dash" style="border-color:var(--series-3)"></i>gusts</span>');
  legend.push('<span><span class="dot high"></span> <span class="dot medium"></span> <span class="dot low"></span> top rule: how well sources agree</span>');
  el.innerHTML = `${head('h-hourly', 'Next 48 hours', `<div class="tabs" role="group" aria-label="Chart metric">${tabs}</div>`)}
    <div class="scroller" tabindex="0" role="group" aria-label="Hourly forecast, scrolls sideways"><div class="chart-box" style="width:${W}px">${svg}</div></div>
    <div class="legend">${legend.join('')}</div>`;
  const sc = el.querySelector('.scroller');
  sc.scrollLeft = prevScroll;
  attachHover(el.querySelector('.chart-box'), hover, { top: yTop - 6, bottom: rainBot });
}

// ----------------------------------------------------------------- daily

export function renderDaily(el, ctx) {
  const { state, v, settings } = ctx;
  if (!v?.days) {
    el.innerHTML = feedLoading(state, ['models', 'metno', 'forecast']) ? skeleton('h-daily', 'Ten days') : unavailable('h-daily', 'Ten days', 'No forecast source could be reached.');
    return;
  }
  const { tz, now } = v;
  const days = v.days.filter((d) => d.tmax && d.tmin);
  if (!days.length) { el.innerHTML = unavailable('h-daily', 'Ten days', 'No daily values available.'); return; }
  const lo = Math.min(...days.map((d) => d.tmin.value)), hi = Math.max(...days.map((d) => d.tmax.value));
  const span = hi - lo || 1;
  const H = v.hourly;
  const rows = days.map((d, i) => {
    const l = (d.tmin.value - lo) / span, w = Math.max(0.04, (d.tmax.value - d.tmin.value) / span);
    const bgw = `${(100 / w).toFixed(0)}%`, bgx = w < 0.999 ? `${((l / (1 - w)) * 100).toFixed(1)}%` : '0%';
    let pop = null;
    H.t.forEach((t, k) => { if (dateKey(t, tz) === d.key && isNum(H.pop[k])) pop = Math.max(pop ?? 0, H.pop[k]); });
    if (pop == null && v.blend) { const k = v.blend.daily.key.indexOf(d.key); if (k >= 0) pop = v.blend.daily.popMax[k]; }
    const mm = d.precip?.value;
    const nowDot = i === 0 && v.current ? `<i class="range-now" style="left:${(Math.max(0, Math.min(1, (v.current.vars.temp.value - lo) / span)) * 100).toFixed(1)}%" title="Now ${fmtTemp(v.current.vars.temp.value)}"></i>` : '';
    const lvl = d.confidence?.level;
    return `<button type="button" class="day" data-detail="day:${d.key}" title="${LEVELS[lvl]?.label ?? ''} — show each source">
      <span class="day-name">${i === 0 ? 'Today' : fmtWeekday(d.start + 12 * HOUR, tz)}<small>${fmtDayMonth(d.start + 12 * HOUR, tz)}</small></span>
      ${weatherIcon(CONDITIONS[d.code]?.icon, true, 26, describe(d.code))}
      <span class="day-rain">${isNum(pop) && pop >= 5 ? `<b>${fmt(pop)}%</b>` : ''}${isNum(mm) && mm >= 0.1 ? `${fmt(mm, 1)} mm` : isNum(pop) && pop >= 5 ? '' : 'dry'}</span>
      <span class="range"><span class="lo">${fmtTemp(d.tmin.value)}</span><span class="range-track"><i class="range-fill" style="left:${(l * 100).toFixed(1)}%;width:${(w * 100).toFixed(1)}%;--bgw:${bgw};--bgx:${bgx}"></i>${nowDot}</span><span class="hi">${fmtTemp(d.tmax.value)}</span></span>
      <span class="dot ${lvl}" aria-label="${LEVELS[lvl]?.label ?? ''}"></span></button>`;
  }).join('');
  el.innerHTML = `${head('h-daily', 'Ten days', `<span class="p-note">dot = source agreement · tap a day for every source</span>`)}<div class="days">${rows}</div>`;
}

// ----------------------------------------------------------- cross-check

const CROSS_ROWS = ['temp', 'feels', 'wind', 'gust', 'rh', 'pressure', 'cloud'];

function strip(r) {
  const vals = r.used.map((u) => u.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  const x = scale(lo - pad, hi + pad, 4, 116);
  const dots = r.used.map((u) => `<circle class="st-dot${u.outlier ? ' out' : ''}" cx="${x(u.value).toFixed(1)}" cy="9" r="3"/>`).join('');
  return `<svg class="strip" viewBox="0 0 120 18" preserveAspectRatio="none" aria-hidden="true"><line class="st-axis" x1="2" x2="118" y1="9" y2="9"/>${dots}<line class="st-med" x1="${x(r.value).toFixed(1)}" x2="${x(r.value).toFixed(1)}" y1="1" y2="17"/></svg>`;
}

export function renderCross(el, ctx) {
  const { state, v, settings } = ctx;
  if (!v?.current) {
    el.innerHTML = feedLoading(state, ['models', 'metno']) ? skeleton('h-cross', 'Cross-check') : unavailable('h-cross', 'Cross-check', 'No sources to compare.');
    return;
  }
  const c = v.current;
  const rows = CROSS_ROWS.map((k) => {
    const r = c.vars[k];
    if (!r) return '';
    return `<button type="button" class="xrow" data-detail="${k}" title="Show every source for ${VARS[k].label.toLowerCase()}">
      <span class="xrow-name">${VARS[k].label}<small>${spreadText(k, r, settings)}</small></span>
      <span class="xrow-val">${fmtVar(k, r.value, settings)}<small>${unitFor(k, settings)}</small></span>
      ${r.n > 1 ? strip(r) : '<span></span>'}${conf(r)}</button>`;
  }).join('');
  const vote = c.condition.vote;
  const voteLine = vote ? `<p class="p-note">Sky: ${vote.count} of ${vote.total} sources say <b>${GROUP_LABELS[vote.winner]}</b>${vote.count < vote.total ? `; others say ${[...vote.counts.entries()].filter(([g]) => g !== vote.winner).map(([g, n]) => `${GROUP_LABELS[g]} (${n})`).join(', ')}` : ''}.</p>` : '';
  const elevNote = isNum(v.elevation) && v.elevation > 500 ? `<p class="p-note">At ${fmt(v.elevation)} m, sea-level pressure is an estimate each model makes differently, so its spread is wider.</p>` : '';
  el.innerHTML = `${head('h-cross', 'Cross-check · right now', conf(c.overall, { text: `${LEVELS[c.overall.level].label} · ${c.overall.score}/100` }))}
    <div class="xrows">${rows}</div>${voteLine}${elevNote}
    <p class="p-note">Each value is the median of the sources that report it (up to ${c.count} here). Dots are the individual sources; the bar is the median. Tap a row for the full list.</p>`;
}

// -------------------------------------------------------- detail dialogs

export function detailHtml(key, { v, settings }) {
  if (key.startsWith('day:')) return dayDetail(key.slice(4), v, settings);
  const c = v.current;
  const r = c?.vars[key];
  if (!r) return { title: 'Sources', html: '<p class="empty">No data.</p>' };
  const spec = VARS[key];
  const unit = unitFor(key, settings);
  const byId = Object.fromEntries(c.rows.map((row) => [row.id, row]));
  const cv = (x) => (key === 'wind' || key === 'gust' ? windValue(x, settings.wind) : x);
  const digits = key === 'wind' || key === 'gust' ? (settings.wind === 'ms' ? 1 : 0) : Math.max(1, spec.digits);
  const body = [...r.used].sort((a, b) => b.value - a.value).map((u) => {
    const row = byId[u.id];
    const kind = row.kind === 'observation' ? `Measured${isNum(row.distanceKm) ? ` ${fmt(row.distanceKm, 1)} km away` : ''}${row.observedAt ? `, ${fmtRelative(row.observedAt, v.now)}` : ''}` : row.kind === 'model' ? `Weather model · ${esc(row.origin)}` : `Forecast service · ${esc(row.origin)}`;
    return `<tr class="${u.outlier ? 'out' : ''}"><td>${esc(row.name)}<small>${kind} · via ${esc(row.via)}</small></td>
      <td class="r">${fmt(cv(u.value), digits)} ${unit}</td><td class="r">${u.dev >= 0 ? '+' : '−'}${fmt(Math.abs(cv(u.dev)), digits)}${u.outlier ? ' · outlier' : ''}</td></tr>`;
  }).join('');
  const tolHi = spec.rel ? Math.max(spec.hi, spec.rel.hi * Math.abs(r.value)) : spec.hi;
  const tolMid = spec.rel ? Math.max(spec.mid, spec.rel.mid * Math.abs(r.value)) : spec.mid;
  const html = `<p class="sub">${conf(r)} &nbsp;Consensus <b>${fmtVar(key, r.value, settings)} ${unit}</b>, ${spreadText(key, r, settings)} sources. Score ${r.score}/100.</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Source</th><th class="r">Reading</th><th class="r">From median</th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="method"><p><b>How this is rated.</b> The reading shown is the median. Agreement is the spread of the sources around it: within ±${fmt(cv(tolHi), 1)} ${unit} is high confidence, within ±${fmt(cv(tolMid), 1)} ${unit} is medium, wider is low. Two sources can never rate higher than medium, and a single source is always marked unverified.</p>
    ${key === 'feels' ? '<p>Services compute “feels like” with different formulas (heat index, wind chill, radiation), so some spread here is definitional.</p>' : ''}
    ${key === 'pressure' ? '<p>All values are reduced to mean sea level so they can be compared between places.</p>' : ''}</div>`;
  return { title: `${spec.label} · every source`, html };
}

function dayDetail(dayKey, v, settings) {
  const d = v.days.find((x) => x.key === dayKey);
  if (!d) return { title: 'Day', html: '<p class="empty">No data.</p>' };
  const names = Object.fromEntries(v.sources.map((s) => [s.id, s.name]));
  const ids = [...new Set([...(d.tmax?.used || []), ...(d.tmin?.used || []), ...(d.precip?.used || [])].map((u) => u.id))];
  const get = (r, id) => r?.used.find((u) => u.id === id);
  const cell = (u, digits, suffix) => (u ? `<td class="r${u.outlier ? ' out' : ''}">${fmt(u.value, digits)}${suffix}${u.outlier ? '*' : ''}</td>` : '<td class="r">—</td>');
  const body = ids.map((id) => `<tr><td>${esc(names[id] || id)}</td>${cell(get(d.tmax, id), 1, '°')}${cell(get(d.tmin, id), 1, '°')}${cell(get(d.precip, id), 1, ' mm')}</tr>`).join('');
  const sum = `<tr class="sum"><td>Consensus (median)</td><td class="r">${fmt(d.tmax.value, 1)}°</td><td class="r">${fmt(d.tmin.value, 1)}°</td><td class="r">${d.precip ? `${fmt(d.precip.value, 1)} mm` : '—'}</td></tr>`;
  const extra = [];
  if (d.windMax) extra.push(`Wind up to ${fmtWind(d.windMax.value, settings.wind)} ${windUnitLabel(settings.wind)}${d.gustMax ? `, gusts ${fmtWind(d.gustMax.value, settings.wind)}` : ''}`);
  if (v.blend) { const k = v.blend.daily.key.indexOf(d.key); if (k >= 0 && isNum(v.blend.daily.uvMax[k])) extra.push(`UV index up to ${fmt(v.blend.daily.uvMax[k])}`); }
  if (isNum(d.wetShare) && d.precip?.n > 1) extra.push(`${Math.round(d.wetShare * d.precip.n)} of ${d.precip.n} sources expect at least 1 mm`);
  const html = `<p class="sub">${conf(d.confidence)} &nbsp;${esc(describe(d.code))}. High ${fmtTemp(d.tmax.value)} (±${fmt(d.tmax.sigma, 1)}°), low ${fmtTemp(d.tmin.value)} (±${fmt(d.tmin.sigma, 1)}°).</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Source</th><th class="r">High</th><th class="r">Low</th><th class="r">Precipitation</th></tr></thead><tbody>${body}${sum}</tbody></table></div>
    ${extra.length ? `<p class="sub">${extra.join(' · ')}.</p>` : ''}
    <p class="p-note">Highs and lows cover the local calendar day. Services that only publish hourly values are included once a full day of hours is available; * marks an outlier left out of the median.</p>`;
  return { title: `${fmtWeekday(d.start + 12 * HOUR, v.tz, true)} ${fmtDayMonth(d.start + 12 * HOUR, v.tz)}`, html };
}

// --------------------------------------------------------------- nowcast

export function renderNowcast(el, ctx) {
  const { state, v, settings } = ctx;
  const m = v?.blend?.m15;
  if (!m) {
    el.innerHTML = feedLoading(state, ['forecast']) ? skeleton('h-nowcast', 'Rain · next hours') : unavailable('h-nowcast', 'Rain · next hours', 'The 15-minute forecast is unavailable right now.');
    return;
  }
  const { tz, now } = v;
  const n = Math.min(m.t.length, 11);
  const vals = m.precip.slice(0, n).map((x) => (isNum(x) ? x : 0));
  const wetIdx = vals.findIndex((x) => x >= 0.05);
  const dryIdx = vals.findIndex((x) => x < 0.05);
  let headline;
  if (wetIdx === -1) headline = `No rain expected before ${fmtTime(m.t[n - 1] + 15 * 60e3, tz, settings.h12)}`;
  else if (wetIdx > 0) headline = `Rain likely from about ${fmtTime(m.t[wetIdx], tz, settings.h12)}`;
  else if (dryIdx === -1) headline = 'Rain continuing for the next few hours';
  else headline = `Rain easing around ${fmtTime(m.t[dryIdx], tz, settings.h12)}`;

  const w = innerWidth(el), h = 126, padL = 30, padR = 6, top = 20, base = 94;
  const maxV = Math.max(0.5, ...vals);
  const [, y1] = niceRange(0, maxV, 2, true);
  const sy = scale(0, y1, base, top);
  const bw = (w - padL - padR) / n;
  let svg = svgOpen(w, h, 'Rain in each 15-minute step') + yGrid(niceTicks(0, y1, 2), sy, padL, w - padR, (x) => fmt(x, y1 < 4 ? 1 : 0));
  const hover = [];
  vals.forEach((val, i) => {
    const x = padL + i * bw;
    svg += val > 0 ? bar(x + 2, sy(val), bw - 4, base, 'c-bar') : `<rect class="c-shade" x="${x + 2}" y="${base - 2}" width="${bw - 4}" height="2" rx="1"/>`;
    if (i % 2 === 0) svg += `<text class="c-tick" x="${x + bw / 2}" y="${base + 15}" text-anchor="middle">${fmtTime(m.t[i], tz, settings.h12)}</text>`;
    hover.push({ x: x + bw / 2, html: `<b>${fmtTime(m.t[i], tz, settings.h12)}–${fmtTime(m.t[i] + 15 * 60e3, tz, settings.h12)}</b><span>${fmt(val, 1)} mm in 15 min (${fmt(val * 4, 1)} mm/h)</span>` });
  });
  svg += `<text class="c-tick" x="${padL - 6}" y="${top - 9}" text-anchor="end">mm</text></svg>`;

  // 24-hour total per source, then the usual consensus
  const start = v.hourly?.t[0] ?? Math.floor(now / HOUR) * HOUR;
  const totals = (v.sources || []).map((s) => {
    if (!s.hourly?.precip) return null;
    let sum = 0, got = 0;
    for (let i = 0; i < 24; i++) { const x = valueAt(s.hourly.t, s.hourly.precip, start + i * HOUR, 0); if (isNum(x)) { sum += x; got++; } }
    return got >= 22 ? { id: s.id, value: sum } : null;
  }).filter(Boolean);
  const total = consensus(totals, 'precipDay');
  const totalLine = total ? `<div class="verify">${conf(total)}<span>Next 24 hours: <b>${fmt(total.value, 1)} mm</b>${total.n > 1 ? `, sources range ${fmt(total.min, 1)}–${fmt(total.max, 1)} mm (${total.n} hourly sources)` : ''}.</span></div>` : '';
  el.innerHTML = `${head('h-nowcast', 'Rain · next hours')}<p class="big" style="font-size:22px;line-height:1.15">${headline}</p>
    <div class="chart-box">${svg}</div>
    <p class="p-note">15-minute steps from Open-Meteo's high-resolution blend. Outside North America and central Europe these steps are interpolated from hourly model output.</p>${totalLine}`;
  attachHover(el.querySelector('.chart-box'), hover, { top, bottom: base });
}

// ----------------------------------------------------------------- tiles

export function renderWind(el, { state, v, settings }) {
  const c = v?.current;
  if (!c?.vars.wind) { el.innerHTML = feedLoading(state, ['models', 'metno']) ? skeleton('h-wind', 'Wind') : unavailable('h-wind', 'Wind', 'Unavailable.'); return; }
  const W = c.vars.wind, G = c.vars.gust, D = c.vars.dir;
  const dir = D?.value;
  const bf = beaufort(W.value);
  let dial = '<svg class="dial" viewBox="0 0 120 120" role="img" aria-label="Wind direction dial">';
  dial += '<circle class="d-ring" cx="60" cy="60" r="50"/>';
  for (let a = 0; a < 360; a += 15) { const [x1, y1] = polar(60, 60, 50, a), [x2, y2] = polar(60, 60, a % 90 === 0 ? 43 : 46, a); dial += `<line class="d-tick${a % 90 === 0 ? ' major' : ''}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`; }
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([t, a]) => { const [x, y] = polar(60, 60, 36, a); dial += `<text class="${t === 'N' ? 'd-n' : ''}" x="${x.toFixed(1)}" y="${(y + 3.2).toFixed(1)}">${t}</text>`; });
  if (isNum(dir) && !D.calm) {
    if (D.n > 1 && D.sigma > 4) { const [x1, y1] = polar(60, 60, 50, dir - D.sigma), [x2, y2] = polar(60, 60, 50, dir + D.sigma); dial += `<path class="d-spread" d="M60 60L${x1.toFixed(1)} ${y1.toFixed(1)}A50 50 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}Z"/>`; }
    // arrow sits on the side the wind comes from and points to the centre (the way it blows)
    const [tx, ty] = polar(60, 60, 50, dir), [hx, hy] = polar(60, 60, 26, dir);
    const [lx, ly] = polar(60, 60, 34, dir - 9), [rx, ry] = polar(60, 60, 34, dir + 9);
    dial += `<line class="d-tail" x1="${tx.toFixed(1)}" y1="${ty.toFixed(1)}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}"/><path class="d-arrow" d="M${hx.toFixed(1)} ${hy.toFixed(1)}L${lx.toFixed(1)} ${ly.toFixed(1)}L${rx.toFixed(1)} ${ry.toFixed(1)}Z"/>`;
  }
  dial += `<text class="d-center" x="60" y="64">${fmtWind(W.value, settings.wind)}</text><text class="d-unit" x="60" y="75">${windUnitLabel(settings.wind)}</text></svg>`;
  el.innerHTML = `${head('h-wind', 'Wind', conf(W, { detail: 'wind' }))}${dial}
    <p class="sub">${D?.calm || !isNum(dir) ? 'Light and variable' : `From ${compass(dir)} (${fmt(dir)}°)`} · Force ${bf.force}, ${bf.label.toLowerCase()}</p>
    <p class="sub">${G ? `Gusts <b>${fmtWind(G.value, settings.wind)}</b> ${windUnitLabel(settings.wind)}` : ''}</p>`;
}

export function renderPressure(el, { state, v }) {
  const P = v?.current?.vars.pressure;
  if (!P) { el.innerHTML = feedLoading(state, ['models', 'metno']) ? skeleton('h-pressure', 'Pressure') : unavailable('h-pressure', 'Pressure', 'Unavailable.'); return; }
  const tend = pressureNow(v);
  let spark = '';
  if (v.blend) {
    const h = v.blend.source.hourly;
    const pts = [];
    h.t.forEach((t, i) => { if (t >= v.now - 24 * HOUR && t <= v.now + 24 * HOUR && isNum(h.pressure[i])) pts.push([t, h.pressure[i]]); });
    if (pts.length > 4) {
      const w = Math.max(120, innerWidth(el)), hh = 54;
      const ys = pts.map((p) => p[1]);
      const sx = scale(v.now - 24 * HOUR, v.now + 24 * HOUR, 2, w - 2), sy = scale(Math.min(...ys) - 0.5, Math.max(...ys) + 0.5, hh - 6, 6);
      const here = valueAt(h.t, h.pressure, v.now, HOUR);
      spark = `${svgOpen(w, hh, 'Pressure, 24 hours back and ahead')}<path class="c-area s5" d="${areaPath(pts.map(([t, p]) => [sx(t), sy(p)]), hh, true)}"/><path class="c-line s5" d="${smoothPath(pts.map(([t, p]) => [sx(t), sy(p)]))}"/>
        <line class="c-now" x1="${sx(v.now)}" x2="${sx(v.now)}" y1="2" y2="${hh}"/>${isNum(here) ? `<circle class="c-now-dot" cx="${sx(v.now)}" cy="${sy(here)}" r="4"/>` : ''}</svg>`;
    }
  }
  const icon = tend ? uiIcon(tend.key === 'steady' ? 'steady' : tend.key, 16) : '';
  el.innerHTML = `${head('h-pressure', 'Pressure', conf(P, { detail: 'pressure' }))}
    <p class="big">${fmt(P.value)}<small>hPa</small></p>
    <p class="sub" style="display:flex;align-items:center;gap:6px">${icon}${tend ? `${tend.label} (${tend.delta >= 0 ? '+' : '−'}${fmt(Math.abs(tend.delta), 1)} in 3 h)` : 'Trend unavailable'}</p>
    <div class="chart-box">${spark}</div><p class="p-note">Sea level · −24 h to +24 h</p>`;
}

export function renderUv(el, { state, v, settings }) {
  if (!v?.blend) { el.innerHTML = feedLoading(state, ['forecast']) ? skeleton('h-uv', 'UV index') : unavailable('h-uv', 'UV index', 'Unavailable.'); return; }
  const e = v.blend.extra, { now, tz } = v;
  const uv = valueAt(e.t, e.uv, now, HOUR);
  const cat = uvCategory(uv);
  const key = dateKey(now, tz);
  let max = null, at = null, from = null, to = null;
  e.t.forEach((t, i) => {
    if (dateKey(t, tz) !== key || !isNum(e.uv[i])) return;
    if (e.uv[i] > (max ?? -1)) { max = e.uv[i]; at = t; }
    if (e.uv[i] >= 3) { from = from ?? t; to = t; }
  });
  const pin = Math.max(0, Math.min(100, ((uv ?? 0) / 11) * 100));
  el.innerHTML = `${head('h-uv', 'UV index', conf('single'))}
    <p class="big">${isNum(uv) ? fmt(uv) : '—'}<small>${cat?.label ?? ''}</small></p>
    <div class="meter scale" role="img" aria-label="UV scale from low to extreme"><i class="pin" style="left:${pin}%;background:var(--ink)"></i></div>
    <p class="sub">${isNum(max) ? `Today's peak ${fmt(max)} at ${fmtTime(at, tz, settings.h12)}` : ''}</p>
    <p class="p-note">${from != null ? `Protection advised ${fmtTime(from, tz, settings.h12)}–${fmtTime(to + HOUR, tz, settings.h12)} (UV 3 or more).` : 'No sun protection needed today.'}</p>`;
}

export function renderHumidity(el, { state, v }) {
  const R = v?.current?.vars.rh;
  if (!R) { el.innerHTML = feedLoading(state, ['models', 'metno']) ? skeleton('h-humidity', 'Humidity') : unavailable('h-humidity', 'Humidity', 'Unavailable.'); return; }
  const dew = v.current.vars.dew?.value;
  const wb = v.blend ? valueAt(v.blend.extra.t, v.blend.extra.wetBulb, v.now, HOUR) : null;
  el.innerHTML = `${head('h-humidity', 'Humidity', conf(R, { detail: 'rh' }))}
    <p class="big">${fmt(R.value)}<small>%</small></p>
    <div class="meter" role="img" aria-label="Relative humidity ${fmt(R.value)} percent"><i style="width:${Math.max(2, Math.min(100, R.value))}%"></i></div>
    <p class="sub">Dew point <b>${fmtTemp(dew)}</b> · ${dewComfort(dew)}</p>
    <p class="p-note">${isNum(wb) ? `Wet-bulb ${fmtTemp(wb)}` : ''}</p>`;
}

export function renderVisibility(el, { state, v }) {
  if (!v?.blend) { el.innerHTML = feedLoading(state, ['forecast']) ? skeleton('h-visibility', 'Visibility') : unavailable('h-visibility', 'Visibility', 'Unavailable.'); return; }
  const e = v.blend.extra;
  const entries = [{ id: 'Open-Meteo', value: valueAt(e.t, e.visibility, v.now, HOUR) }];
  for (const o of v.observations || []) if (isNum(o.now?.visibility)) entries.push({ id: o.short, value: o.now.visibility });
  const wwo = v.sources?.find((s) => s.id === 'wwo')?.now?.visibility;
  if (isNum(wwo)) entries.push({ id: 'WWO', value: wwo });
  const live = entries.filter((x) => isNum(x.value));
  if (!live.length) { el.innerHTML = unavailable('h-visibility', 'Visibility', 'Unavailable.'); return; }
  // Reports are capped differently (10 km, 16 km, 24 km…), so compare on the lowest and say so.
  const km = Math.min(...live.map((x) => x.value)) / 1000;
  const snow = valueAt(e.t, e.snowDepth, v.now, HOUR);
  const fz = valueAt(e.t, e.freezingLevel, v.now, HOUR);
  // Services cap what they report (10 km, 16 km, 24 km…), so agreement is judged below the lowest cap.
  const capped = live.map((x) => Math.min(x.value, 10000));
  const gapKm = (Math.max(...capped) - Math.min(...capped)) / 1000;
  const visLevel = live.length < 2 ? 'single' : gapKm > 3 ? 'low' : live.length >= 3 && gapKm <= 1.5 ? 'high' : 'medium';
  el.innerHTML = `${head('h-visibility', 'Visibility', conf(visLevel, { text: live.length > 1 ? `${LEVELS[visLevel].short} · ${live.length} sources` : undefined }))}
    <p class="big">${km >= 10 ? fmt(km) : fmt(km, 1)}<small>km</small></p>
    <p class="sub">${visibilityLabel(km)}${live.length > 1 ? ' · lowest of the reports' : ''}</p>
    <div class="chips">${live.map((x) => `<span class="chip">${esc(x.id)} <b>${fmt(x.value / 1000, x.value < 10000 ? 1 : 0)} km</b></span>`).join('')}</div>
    <p class="p-note">${isNum(fz) ? `Freezing level ${Math.round(fz / 100) * 100} m` : ''}${isNum(snow) && snow > 0 ? ` · snow on ground ${fmt(snow * 100)} cm` : ''}</p>`;
}

export function renderCloud(el, { state, v }) {
  const C = v?.current?.vars.cloud;
  if (!C) { el.innerHTML = feedLoading(state, ['models', 'metno']) ? skeleton('h-cloud', 'Cloud cover') : unavailable('h-cloud', 'Cloud cover', 'Unavailable.'); return; }
  let layers = '';
  if (v.blend) {
    const e = v.blend.extra;
    layers = `<div class="layers">${[['High', e.cloudHigh], ['Mid', e.cloudMid], ['Low', e.cloudLow]].map(([name, arr]) => {
      const val = valueAt(e.t, arr, v.now, HOUR);
      return `<span>${name}</span><div class="meter"><i style="width:${isNum(val) ? Math.max(0, Math.min(100, val)) : 0}%"></i></div><span>${isNum(val) ? fmt(val) : '—'}%</span>`;
    }).join('')}</div>`;
  }
  const oktas = Math.round((C.value / 100) * 8);
  el.innerHTML = `${head('h-cloud', 'Cloud cover', conf(C, { detail: 'cloud' }))}
    <p class="big">${fmt(C.value)}<small>%</small></p><p class="sub">${oktas} of 8 oktas</p>${layers}`;
}
