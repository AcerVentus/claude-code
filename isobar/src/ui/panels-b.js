// Panels, part two: air quality, sun, moon, tides, sea, climate context,
// space weather and the source ledger.

import { LEVELS, valueAt } from '../lib/consensus.js';
import { AQI_SCALES, aqiCategory, POLLUTANTS, WHO_GUIDELINE, POLLEN, pollenLevel } from '../lib/aqi.js';
import { fmt, fmtTemp, compass, seaState, escapeHtml as esc, isNum } from '../lib/units.js';
import { fmtTime, fmtWeekday, fmtDayMonth, fmtDuration, fmtRelative, dateKey, HOUR, DAY } from '../lib/time.js';
import { altitudeSeries } from '../lib/astro.js';
import { kpDescription, geomagneticLatitude, auroraChance } from '../providers/misc.js';
import { FEEDS } from '../engine.js';
import { uiIcon, fromArrow } from './icons.js';
import { scale, niceRange, niceTicks, smoothPath, linePath, bandPath, areaPath, bar, yGrid, svgOpen, polar, arcPath, attachHover } from './charts.js';
import { drawMoon } from './moon.js';
import { head, conf, skeleton, unavailable, innerWidth } from './panels-a.js';

const loading = (state, keys) => keys.some((k) => state.status[k]?.state === 'loading');

// ------------------------------------------------------------ air quality

export function renderAir(el, { state, v, settings }) {
  const a = v?.air;
  if (!a) { el.innerHTML = loading(state, ['air']) ? skeleton('h-air', 'Air quality') : unavailable('h-air', 'Air quality', 'Air-quality data is unavailable for this place right now.'); return; }
  const { tz, now } = v;
  const sk = settings.aqi === 'eu' ? 'eu' : 'us';
  const sc = AQI_SCALES[sk];
  const field = sk === 'eu' ? 'european_aqi' : 'us_aqi';
  const value = a.current[field];
  const cat = aqiCategory(value, sk);
  const other = sk === 'eu' ? `US AQI ${fmt(a.current.us_aqi)}` : `European AQI ${fmt(a.current.european_aqi)}`;

  // gauge: 240° arc split into the scale's bands
  const A0 = -120, A1 = 120;
  const ang = (x) => A0 + (Math.min(x, sc.gaugeMax) / sc.gaugeMax) * (A1 - A0);
  let g = '<svg class="gauge" viewBox="0 0 220 150" role="img" aria-label="Air quality gauge">';
  let from = 0;
  sc.bands.forEach((b, i) => {
    const to = Math.min(b.max, sc.gaugeMax);
    if (to > from) g += `<path class="g-track" stroke="var(--aqi-${i})" d="${arcPath(110, 112, 88, ang(from) + (i ? 1 : 0), ang(to))}"/>`;
    from = to;
  });
  sc.ticks.forEach((t) => { const [x, y] = polar(110, 112, 71, ang(t)); g += `<text class="g-tick" x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}">${t}${t === sc.gaugeMax ? '+' : ''}</text>`; });
  if (isNum(value)) { const [x, y] = polar(110, 112, 80, ang(value)); const [bx, by] = polar(110, 112, 44, ang(value)); g += `<line class="g-needle" x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }
  g += `<text class="g-val" x="110" y="118">${isNum(value) ? fmt(value) : '—'}</text><text class="g-sub" x="110" y="136">${sc.name.toUpperCase()}</text></svg>`;

  // dominant pollutant by sub-index (US) — only meaningful on the US scale
  const subs = [['PM2.5', a.current.us_aqi_pm2_5], ['PM10', a.current.us_aqi_pm10], ['O₃', a.current.us_aqi_ozone], ['NO₂', a.current.us_aqi_nitrogen_dioxide], ['SO₂', a.current.us_aqi_sulphur_dioxide], ['CO', a.current.us_aqi_carbon_monoxide]].filter(([, x]) => isNum(x));
  const dominant = subs.length ? subs.reduce((m, x) => (x[1] > m[1] ? x : m)) : null;

  const rows = POLLUTANTS.map((p) => {
    const val = a.current[p.key];
    if (!isNum(val)) return '';
    const guide = WHO_GUIDELINE[p.key];
    const ratio = val / guide;
    const width = Math.min(100, (ratio / 3) * 100);
    return `<dt title="${p.name}">${p.label}</dt><dd><div class="meter"><i class="${ratio > 2 ? 'far' : ratio > 1 ? 'over' : ''}" style="width:${Math.max(2, width).toFixed(0)}%"></i><i class="who" style="left:33.3%" title="WHO guideline ${guide} µg/m³"></i></div></dd><dd class="v">${fmt(val, val < 10 ? 1 : 0)} µg/m³</dd>`;
  }).join('');

  // forecast sparkline of the chosen index
  let chart = '', hover = [];
  const hh = a.hourly;
  if (hh) {
    const pts = [];
    hh.t.forEach((t, i) => { if (t >= now - 6 * HOUR && isNum(hh[field][i])) pts.push([t, hh[field][i]]); });
    if (pts.length > 6) {
      const w = innerWidth(el), h = 96, padL = 30, top = 8, base = 70;
      const [, y1] = niceRange(0, Math.max(...pts.map((p) => p[1]), sk === 'eu' ? 40 : 60), 3, true);
      const sx = scale(pts[0][0], pts[pts.length - 1][0], padL, w - 6), sy = scale(0, y1, base, top);
      chart = svgOpen(w, h, `${sc.name} forecast`) + yGrid(niceTicks(0, y1, 3), sy, padL, w - 6);
      chart += `<path class="c-area" d="${areaPath(pts.map(([t, x]) => [sx(t), sy(x)]), base, true)}"/><path class="c-line" d="${smoothPath(pts.map(([t, x]) => [sx(t), sy(x)]))}"/>`;
      chart += `<line class="c-now" x1="${sx(now)}" x2="${sx(now)}" y1="${top}" y2="${base}"/>`;
      pts.forEach(([t], i) => {
        if (i === 0 || dateKey(t, tz) === dateKey(pts[i - 1][0], tz)) return;
        chart += `<line class="c-grid" x1="${sx(t)}" x2="${sx(t)}" y1="${top}" y2="${base}"/>${sx(t) < w - 40 ? `<text class="c-tick" x="${sx(t) + 4}" y="${base + 15}">${fmtWeekday(t, tz)}</text>` : ''}`;
      });
      chart += '</svg>';
      hover = pts.map(([t, x]) => ({ x: sx(t), html: `<b>${fmtWeekday(t, tz)} ${fmtTime(t, tz, settings.h12)}</b><span>${sc.name} ${fmt(x)} · ${aqiCategory(x, sk).label}</span>` }));
    }
  }

  // cross-check on PM2.5 concentrations
  const pm = a.pm25;
  const chips = pm ? pm.used.map((u) => `<span class="chip">${esc(u.id)} <b>${fmt(u.value, 1)}</b></span>`).join('') : '';
  let verify;
  if (pm && pm.n > 1) verify = `<div class="verify">${conf(pm)}<span>PM2.5 from ${pm.n} sources (µg/m³): </span></div><div class="chips">${chips}</div>${a.sensors ? `<p class="p-note">Sensors are low-cost citizen instruments (${a.sensors.count} outdoor units within ${a.sensors.radiusKm} km, nearest ${fmt(a.sensors.nearestKm, 1)} km); they read instant values and can over-read in humid air, while the index uses rolling averages.</p>` : ''}`;
  else verify = `<div class="verify">${conf('single')}<span>Only the ${esc(a.primaryName)} model covers this place and no citizen sensors are within 8 km, so the index could not be cross-checked. CAMS is a ~${a.primaryName.includes('Europe') ? '11' : '45'} km model: it shows the regional background, not a street-level reading.</span></div>`;

  // extras: dust, aerosol, pollen
  const extras = [];
  if (isNum(a.current.dust)) extras.push(`<div class="stat"><span class="label">Dust</span><b>${fmt(a.current.dust)}<small>µg/m³</small></b></div>`);
  if (isNum(a.current.aerosol_optical_depth)) extras.push(`<div class="stat"><span class="label">Aerosol optical depth</span><b>${fmt(a.current.aerosol_optical_depth, 2)}</b><i>${a.current.aerosol_optical_depth < 0.1 ? 'Very clear' : a.current.aerosol_optical_depth < 0.3 ? 'Clear' : a.current.aerosol_optical_depth < 0.6 ? 'Hazy' : 'Very hazy'}</i></div>`);
  let pollen = '';
  if (hh) {
    const items = POLLEN.map((p) => ({ ...p, v: valueAt(hh.t, hh[p.key] || [], now, HOUR) })).filter((p) => isNum(p.v));
    if (items.length) {
      const active = items.filter((p) => p.v >= 1);
      pollen = `<p class="sub"><span class="label">Pollen</span> ${active.length ? active.map((p) => `${p.label} ${pollenLevel(p.v).label.toLowerCase()} (${fmt(p.v)}/m³)`).join(' · ') : 'none in the air right now'}</p>`;
    }
  }

  el.innerHTML = `${head('h-air', 'Air quality', conf(pm && pm.n > 1 ? pm : 'single'))}
    <div class="split">${g}<div style="display:grid;gap:8px;min-width:0">
      <p class="lvl l${cat?.level ?? 0}" style="font-size:17px">${cat?.label ?? '—'}</p>
      <p class="sub">${cat?.advice ?? ''}</p>
      <p class="p-note">${other}${dominant ? ` · main pollutant ${dominant[0]}` : ''}</p></div></div>
    <dl class="poll">${rows}</dl><p class="p-note">Bars run to three times the WHO guideline; the tick marks the guideline itself.</p>
    ${extras.length ? `<div class="cols">${extras.join('')}</div>` : ''}${pollen}
    ${chart ? `<div class="chart-box">${chart}</div>` : ''}${verify}`;
  if (chart) attachHover(el.querySelector('.chart-box'), hover, { top: 8, bottom: 70 });
}

// ------------------------------------------------------------------- sun

export function renderSun(el, { v, settings }) {
  if (!v?.astro) { el.innerHTML = skeleton('h-sun', 'Sun'); return; }
  const { tz, now, place } = v;
  const A = v.astro, s = A.sun;
  const t = (x) => fmtTime(x, tz, settings.h12);
  const w = innerWidth(el), h = 150, padL = 30, padR = 6, top = 10, bottom = 118;
  const sx = scale(A.dayStart, A.dayEnd, padL, w - padR);
  const sun = altitudeSeries('sun', A.dayStart, A.dayEnd, 12, place.lat, place.lon);
  const moon = altitudeSeries('moon', A.dayStart, A.dayEnd, 12, place.lat, place.lon);
  const maxAlt = Math.max(20, ...sun.map((p) => p.altitude), ...moon.map((p) => p.altitude));
  const minAlt = Math.min(-20, ...sun.map((p) => p.altitude));
  const hi = Math.ceil(maxAlt / 10) * 10, lo = Math.floor(Math.min(minAlt, ...moon.map((p) => p.altitude)) / 10) * 10;
  const sy = scale(lo, hi, bottom, top);
  let svg = svgOpen(w, h, 'Altitude of the Sun and Moon through today');
  svg += `<rect class="c-shade" x="${padL}" y="${sy(0)}" width="${w - padL - padR}" height="${bottom - sy(0)}"/>`;
  svg += yGrid([lo, 0, hi].filter((x, i, arr) => arr.indexOf(x) === i), sy, padL, w - padR, (x) => `${x}°`);
  svg += `<line class="c-axis" x1="${padL}" x2="${w - padR}" y1="${sy(0)}" y2="${sy(0)}"/>`;
  svg += `<path class="c-line ink dash" d="${linePath(moon.map((p) => [sx(p.t), sy(p.altitude)]))}"/>`;
  svg += `<path class="c-area" style="fill:color-mix(in srgb, var(--series-4) 20%, transparent)" d="${areaPath(sun.filter((p) => p.altitude >= 0).map((p) => [sx(p.t), sy(p.altitude)]), sy(0))}"/>`;
  svg += `<path class="c-line s4" d="${linePath(sun.map((p) => [sx(p.t), sy(p.altitude)]))}"/>`;
  for (let k = 0; k <= 4; k++) { const tt = A.dayStart + (k * (A.dayEnd - A.dayStart)) / 4; svg += `<text class="c-tick" x="${sx(tt)}" y="${bottom + 15}" text-anchor="${k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}">${t(tt)}</text>`; }
  if (now >= A.dayStart && now <= A.dayEnd) svg += `<line class="c-now" x1="${sx(now)}" x2="${sx(now)}" y1="${top}" y2="${bottom}"/><circle class="c-dot s4" cx="${sx(now)}" cy="${sy(A.sunPos.altitude)}" r="5"/>`;
  svg += '</svg>';
  const hover = sun.filter((_, i) => i % 2 === 0).map((p, i) => ({ x: sx(p.t), html: `<b>${t(p.t)}</b><span>Sun ${fmt(p.altitude)}° high, bearing ${fmt(p.azimuth)}° ${compass(p.azimuth)}</span><span>Moon ${fmt(moon[i * 2]?.altitude)}° high</span>` }));

  const diff = isNum(s.dayLength) && isNum(A.yesterday.dayLength) ? s.dayLength - A.yesterday.dayLength : null;
  const polar_ = s.polar === 'day' ? 'Midnight sun: the Sun stays up all day.' : s.polar === 'night' ? 'Polar night: the Sun stays below the horizon today.' : '';
  const rows = [
    ['First light', s.civilDawn, 'civil dawn'], ['Sunrise', s.sunrise, ''], ['Solar noon', s.solarNoon, `${fmt(s.noonAltitude)}° high`],
    ['Sunset', s.sunset, s.sunsetNextDay ? 'after midnight' : ''], ['Last light', s.civilDusk, 'civil dusk'],
  ].map(([label, time, note]) => `<div class="stat"><span class="label">${label}</span><b>${t(time)}</b><i>${note}</i></div>`).join('');
  const golden = [];
  if (isNum(s.sunrise) && isNum(s.goldenMorningEnd)) golden.push(`${t(s.sunrise)}–${t(s.goldenMorningEnd)}`);
  if (isNum(s.goldenEveningStart) && isNum(s.sunset)) golden.push(`${t(s.goldenEveningStart)}–${t(s.sunset)}`);
  const checks = A.checks.filter((c) => c.label === 'Sunrise' || c.label === 'Sunset');
  const worst = checks.length ? checks.reduce((a, b) => (b.maxDiffMin > a.maxDiffMin ? b : a)) : null;
  const level = !checks.length ? 'single' : checks.some((c) => c.level === 'low') ? 'low' : checks.some((c) => c.level === 'medium') ? 'medium' : checks.every((c) => c.level === 'high') ? 'high' : 'single';
  const names = worst ? [...new Set(checks.flatMap((c) => c.entries.map((e) => e.id)))].filter((n) => n !== 'Isobar') : [];
  let verify;
  if (checks.some((c) => c.missing)) verify = 'An outside service reports a sunrise or sunset today that the built-in calculation does not show. Treat today\'s sun times with caution.';
  else if (worst && worst.n > 1 && checks.every((c) => c.none)) verify = `Computed on this device. MET Norway also reports no sunrise or sunset here today.`;
  else if (worst && worst.n > 1) verify = `Computed on this device and checked against ${names.join(' and ')}: all within ${worst.maxDiffMin < 1 ? 'a minute' : `${fmt(Math.ceil(worst.maxDiffMin))} min`}.`;
  else verify = 'Computed on this device from the Sun\'s position; no outside service was reachable to compare.';
  el.innerHTML = `${head('h-sun', 'Sun', `<span class="p-note">Now ${fmt(A.sunPos.altitude)}° ${A.sunPos.altitude >= 0 ? 'above' : 'below'} horizon · bearing ${fmt(A.sunPos.azimuth)}° ${compass(A.sunPos.azimuth)}</span>`)}
    <div class="chart-box">${svg}</div>
    <div class="legend"><span><i class="s4"></i>Sun</span><span><i class="ink dash"></i>Moon</span></div>
    ${polar_ ? `<p class="sub">${polar_}</p>` : ''}
    <div class="cols" style="grid-template-columns:repeat(auto-fit,minmax(96px,1fr))">${rows}</div>
    <dl class="kv">
      <dt>Nautical twilight</dt><dd>${t(s.nauticalDawn)} – ${t(s.nauticalDusk)}</dd>
      <dt>Astronomical twilight</dt><dd>${t(s.astroDawn)} – ${t(s.astroDusk)}</dd>
      <dt>Tomorrow's sunrise and sunset</dt><dd>${A.tomorrow.polar ? `none (${A.tomorrow.polar === 'day' ? 'midnight sun' : 'polar night'})` : `${t(A.tomorrow.sunrise)} – ${t(A.tomorrow.sunset)}`}</dd>
    </dl>
    <p class="sub">Daylight <b>${fmtDuration(s.dayLength)}</b>${isNum(diff) && Math.abs(diff) >= 1000 ? ` · ${fmtDuration(diff)} ${diff > 0 ? 'longer' : 'shorter'} than yesterday` : ''}${golden.length ? ` · golden hour ${golden.join(' and ')}` : ''}</p>
    <div class="verify">${conf(level)}<span>${verify}</span></div>`;
  attachHover(el.querySelector('.chart-box'), hover, { top, bottom });
}

// ------------------------------------------------------------------ moon

function phaseGlyph(quarter) {
  const lit = { 0: '', 1: 'M12 2a10 10 0 0 1 0 20z', 2: 'M12 2a10 10 0 0 1 0 20a10 10 0 0 1 0-20z', 3: 'M12 2a10 10 0 0 0 0 20z' }[quarter];
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="pm-dark" cx="12" cy="12" r="10"/>${lit ? `<path class="pm-lit" d="${lit}"/>` : ''}</svg>`;
}

export function renderMoon(el, { v, settings }) {
  if (!v?.astro) { el.innerHTML = skeleton('h-moon', 'Moon'); return; }
  const { tz, now, place } = v;
  const A = v.astro, m = A.moon;
  const t = (x) => fmtTime(x, tz, settings.h12);
  const when = (x) => (x == null ? '—' : `${dateKey(x, tz) === dateKey(now, tz) ? '' : `${fmtWeekday(x, tz)} `}${t(x)}`);
  const up = m.altitude > 0;
  const nxt = A.moonNext;
  const size = innerWidth(el) < 330 ? 132 : 156;
  const perigee = A.apsides.perigee, apogee = A.apsides.apogee;
  const southern = place.lat < 0;
  const rise = A.checks.find((c) => c.label === 'Moonrise'), set = A.checks.find((c) => c.label === 'Moonset');
  const timeChecks = [rise, set].filter((c) => c && c.n > 1);
  let level = 'single', verify = 'Computed on this device; MET Norway was not reachable to compare.';
  if (A.phaseCheck || timeChecks.length) {
    const levels = [A.phaseCheck?.level, ...timeChecks.map((c) => c.level)].filter(Boolean);
    level = levels.includes('low') ? 'low' : levels.includes('medium') ? 'medium' : 'high';
    const bits = [];
    if (A.phaseCheck) bits.push(`phase within ${fmt(A.phaseCheck.diffDeg, 1)}°`);
    if (timeChecks.length) bits.push(`rise/set within ${fmt(Math.max(1, Math.ceil(Math.max(...timeChecks.map((c) => c.maxDiffMin)))))} min`);
    verify = `Computed on this device and checked against MET Norway: ${bits.join(', ')}.`;
  }
  const superMoon = m.name === 'Full Moon' && m.distanceKm < 362000 ? ' · near perigee (a “supermoon”)' : '';
  el.innerHTML = `${head('h-moon', 'Moon', `<span class="p-note">${up ? `Up · ${fmt(m.altitude)}° high in the ${compass(m.azimuth)}` : 'Below the horizon'}</span>`)}
    <div class="moon-wrap">
      <div class="moon-sky"><span class="up">zenith ↑</span><canvas id="moon-canvas" width="${size}" height="${size}" role="img" aria-label="${m.name}, ${fmt(m.illumination * 100)} percent lit"></canvas></div>
      <div style="display:grid;gap:10px;min-width:0">
        <p class="big" style="font-size:26px;line-height:1.05">${m.name}</p>
        <p class="sub"><b>${fmt(m.illumination * 100)}%</b> lit · ${m.waxing ? 'waxing' : 'waning'} · ${fmt(m.ageDays, 1)} days old${superMoon}</p>
        <dl class="kv">
          <dt>${nxt.rise != null && (nxt.set == null || nxt.rise < nxt.set) ? 'Moonrise' : 'Moonset'}</dt><dd>${when(nxt.rise != null && (nxt.set == null || nxt.rise < nxt.set) ? nxt.rise : nxt.set)}</dd>
          <dt>${nxt.rise != null && (nxt.set == null || nxt.rise < nxt.set) ? 'Moonset' : 'Moonrise'}</dt><dd>${when(nxt.rise != null && (nxt.set == null || nxt.rise < nxt.set) ? nxt.set : nxt.rise)}</dd>
          <dt>Distance</dt><dd>${fmt(Math.round(m.distanceKm / 100) * 100).replace(/(\d)(?=(\d{3})+$)/g, '$1 ')} km</dd>
          <dt>${perigee.time < apogee.time ? 'Perigee' : 'Apogee'}</dt><dd>${fmtDayMonth(Math.min(perigee.time, apogee.time), tz)}</dd>
        </dl>
      </div>
    </div>
    <div class="phases">${A.quarters.map((q) => `<div class="phase">${phaseGlyph(southern && (q.quarter === 1 || q.quarter === 3) ? 4 - q.quarter : q.quarter)}<b>${q.name.replace(' Moon', '')}</b><span>${fmtDayMonth(q.time, tz)}<br>${t(q.time)}</span></div>`).join('')}</div>
    <p class="p-note">Drawn as it appears from ${esc(place.name)} right now: lit side, tilt and libration are computed for this spot${up ? '' : ' (shown as it would look if the horizon were not in the way)'}.</p>
    <div class="verify">${conf(level)}<span>${verify}</span></div>`;
  const canvas = el.querySelector('#moon-canvas');
  if (canvas) drawMoon(canvas, m, size);
}

// ----------------------------------------------------------------- tides

export function renderTides(el, { state, v, settings }) {
  const T = v?.tides;
  if (!T) {
    el.innerHTML = loading(state, ['marine', 'tides']) ? skeleton('h-tides', 'Tides')
      : unavailable('h-tides', 'Tides', 'No tidal water nearby: the ocean model has no sea cell close to this place and there is no tide gauge within 30 km.');
    return;
  }
  const { tz, now } = v;
  const t = (x) => fmtTime(x, tz, settings.h12);
  const from = now - 6 * HOUR, to = now + 42 * HOUR;
  const w = innerWidth(el), h = 190, padL = 34, padR = 8, top = 26, bottom = 150;
  const pick = (curve) => { const pts = []; if (curve) curve.t.forEach((tt, i) => { if (tt >= from && tt <= to && isNum(curve.h[i])) pts.push([tt, curve.h[i]]); }); return pts; };
  let pts = pick(T.curve);
  // thin dense official curves (6-minute data) to about one point per 2 px
  const stride = Math.max(1, Math.floor(pts.length / (w / 2)));
  pts = pts.filter((_, i) => i % stride === 0);
  let overlay = [];
  if (T.primary === 'noaa' && T.modelCurve) {
    overlay = pick(T.modelCurve);
    // different datums: align the model's mean to the gauge's mean over the window
    if (overlay.length && pts.length) {
      const mean = (a) => a.reduce((s, p) => s + p[1], 0) / a.length;
      const shift = mean(pts) - mean(overlay);
      overlay = overlay.map(([tt, y]) => [tt, y + shift]);
    }
  }
  const ys = [...pts, ...overlay].map((p) => p[1]);
  if (!ys.length) { el.innerHTML = unavailable('h-tides', 'Tides', 'No tide curve available.'); return; }
  const [y0, y1] = niceRange(Math.min(...ys), Math.max(...ys), 3);
  const sx = scale(from, to, padL, w - padR), sy = scale(y0, y1, bottom, top);
  let svg = svgOpen(w, h, 'Tide height over the next two days') + yGrid(niceTicks(y0, y1, 3), sy, padL, w - padR, (x) => fmt(x, 1));
  svg += `<text class="c-tick" x="${padL - 6}" y="${top - 12}" text-anchor="end">m</text>`;
  svg += `<path class="c-area" d="${areaPath(pts.map(([tt, y]) => [sx(tt), sy(y)]), bottom, true)}"/><path class="c-line" d="${smoothPath(pts.map(([tt, y]) => [sx(tt), sy(y)]))}"/>`;
  if (overlay.length) svg += `<path class="c-line s2 dash" d="${smoothPath(overlay.map(([tt, y]) => [sx(tt), sy(y)]))}"/>`;
  const evs = T.events.filter((e) => e.t >= from && e.t <= to);
  evs.forEach((e) => {
    const x = sx(e.t), y = sy(e.h);
    if (x < padL + 16 || x > w - padR - 16) return;
    svg += `<circle class="c-dot" cx="${x}" cy="${y}" r="3.5"/><text class="c-label" x="${x}" y="${e.type === 'H' ? y - 9 : y + 17}" text-anchor="middle">${t(e.t)}</text>`;
  });
  for (let tt = Math.ceil(from / (6 * HOUR)) * 6 * HOUR; tt <= to; tt += 6 * HOUR) {
    const lbl = fmtTime(tt, tz, settings.h12);
    if (sx(tt) > padL + 20 && sx(tt) < w - padR - 20 && (w > 520 || tt % (12 * HOUR) === 0)) svg += `<text class="c-tick" x="${sx(tt)}" y="${bottom + 16}" text-anchor="middle">${lbl}</text>`;
  }
  const st = T.state;
  if (st && isNum(st.height)) svg += `<line class="c-now" x1="${sx(now)}" x2="${sx(now)}" y1="${top}" y2="${bottom}"/><circle class="c-now-dot" cx="${sx(now)}" cy="${sy(Math.max(y0, Math.min(y1, st.height)))}" r="4.5"/>`;
  svg += '</svg>';
  const hover = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 120)) === 0).map(([tt, y]) => ({ x: sx(tt), html: `<b>${fmtWeekday(tt, tz)} ${t(tt)}</b><span>${fmt(y, 2)} m above ${T.datum === 'MSL' ? 'mean sea level' : 'chart datum (MLLW)'}</span>` }));

  const next = T.events.filter((e) => e.t > now).slice(0, 4);
  const list = next.map((e) => `<div class="stat"><span class="label">${e.type === 'H' ? 'High water' : 'Low water'}</span><b>${t(e.t)}</b><i>${fmt(e.h, 2)} m · ${fmtRelative(e.t, now)}</i></div>`).join('');
  const official = T.primary === 'noaa';
  const srcLine = official
    ? `NOAA harmonic prediction for the ${esc(T.station.name)} gauge, ${fmt(T.station.distanceKm, 1)} km away${T.curveIsInterpolated ? ' (curve drawn between its published highs and lows)' : ''}.`
    : 'Modelled sea level at the nearest ocean cell of an 8 km global model (tide plus weather-driven surge).';
  let verify;
  const cmp = T.comparison;
  if (official && cmp && cmp.matched >= 2) {
    verify = `<div class="verify">${conf(cmp.level)}<span>Checked against the global ocean model: ${cmp.matched} of ${cmp.expected} highs and lows matched, on average ${fmt(cmp.timeDiffMin)} min apart, range ${fmt(cmp.rangeRatio * 100)}% of the gauge's. ${cmp.level === 'high' ? '' : 'The gauge prediction is the one to trust; an 8 km model cannot resolve harbours, bays and estuaries.'}</span></div>`;
  } else if (official) {
    verify = `<div class="verify">${conf('official')}<span>Official gauge-based prediction. The global ocean model has no cell close enough to compare.</span></div>`;
  } else {
    verify = `<div class="verify">${conf('single')}<span>No tide gauge prediction is freely available here, so this is an unverified model estimate. Where a gauge exists, this model's high and low times run 10–60 minutes off, and more inside bays and estuaries. Do not use it for navigation.</span></div>`;
  }
  el.innerHTML = `${head('h-tides', 'Tides', conf(official ? 'official' : 'single', { text: official ? 'Tide gauge' : 'Model estimate' }))}
    <p class="big" style="font-size:22px;line-height:1.15">${st ? `${st.rising ? 'Rising' : 'Falling'} · ${st.next.type === 'H' ? 'high' : 'low'} water at ${t(st.next.t)}` : 'Tide times'}</p>
    <p class="sub">${st ? `${fmtRelative(st.next.t, now)} · ` : ''}${T.cycle.label} (${T.cycle.note.toLowerCase()})</p>
    <div class="chart-box">${svg}</div>
    ${overlay.length ? '<div class="legend"><span><i></i>NOAA gauge prediction</span><span><i class="s2 dash"></i>ocean model, levels aligned</span></div>' : ''}
    <div class="cols" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">${list}</div>
    <p class="p-note">${srcLine} Heights in metres above ${T.datum === 'MSL' ? 'mean sea level' : 'mean lower low water'}.</p>${verify}`;
  attachHover(el.querySelector('.chart-box'), hover, { top, bottom });
}

// ------------------------------------------------------------------- sea

export function renderSea(el, { state, v, settings }) {
  const S = v?.sea;
  if (!S) {
    el.innerHTML = loading(state, ['marine', 'waves']) ? skeleton('h-sea', 'Sea state')
      : unavailable('h-sea', 'Sea state', 'No open water close to this place, so there is no wave, swell or sea-temperature forecast.');
    return;
  }
  const { tz, now } = v;
  const cur = S.marine.current;
  const N = S.now;
  const hs = N?.vars.waveH?.value ?? cur.waveH;
  const period = N?.vars.wavePeriod?.value ?? cur.wavePeriod;
  const dir = N?.vars.waveDir?.value ?? cur.waveDir;
  const sea = seaState(hs);
  const stats = [];
  if (isNum(hs)) stats.push(`<div class="stat"><span class="label">Significant wave height</span><b>${fmt(hs, 1)}<small>m</small></b><i>${sea.label}</i></div>`);
  if (isNum(period)) stats.push(`<div class="stat"><span class="label">Mean period</span><b>${fmt(period, 1)}<small>s</small></b><i>${isNum(dir) ? `${fromArrow(dir)} from ${compass(dir)}` : ''}</i></div>`);
  if (isNum(cur.swellH)) stats.push(`<div class="stat"><span class="label">Swell</span><b>${fmt(cur.swellH, 1)}<small>m</small></b><i>${isNum(cur.swellPeriod) ? `${fmt(cur.swellPeriod, 1)} s` : ''}${isNum(cur.swellDir) ? ` · ${fromArrow(cur.swellDir)} from ${compass(cur.swellDir)}` : ''}</i></div>`);
  if (isNum(cur.windWaveH)) stats.push(`<div class="stat"><span class="label">Wind waves</span><b>${fmt(cur.windWaveH, 1)}<small>m</small></b><i>${isNum(cur.windWavePeriod) && cur.windWaveH > 0 ? `${fmt(cur.windWavePeriod, 1)} s` : ''}</i></div>`);
  if (S.sst) stats.push(`<div class="stat"><span class="label">Sea temperature</span><b>${fmt(S.sst.value, 1)}<small>°C</small></b><i>${S.sst.n > 1 ? `±${fmt(S.sst.sigma, 1)}° · ${S.sst.n} sources` : 'one source'}</i></div>`);
  if (isNum(cur.currentSpeed)) stats.push(`<div class="stat"><span class="label">Surface current</span><b>${fmt(cur.currentSpeed, 1)}<small>km/h</small></b><i>${isNum(cur.currentDir) && cur.currentSpeed >= 0.1 ? `setting ${compass(cur.currentDir)} (${fmt(cur.currentSpeed / 3.6, 2)} m/s)` : 'slack'}</i></div>`);

  let chart = '', hover = [];
  const H = S.hourly;
  if (H && H.value.some(isNum)) {
    const w = innerWidth(el), h = 158, padL = 30, padR = 6, top = 22, bottom = 120;
    const all = [...H.value, ...H.max].filter(isNum);
    const [, y1] = niceRange(0, Math.max(0.5, ...all), 3, true);
    const sx = scale(H.t[0], H.t[H.t.length - 1], padL, w - padR), sy = scale(0, y1, bottom, top);
    chart = svgOpen(w, h, 'Significant wave height over five days') + yGrid(niceTicks(0, y1, 3), sy, padL, w - padR, (x) => fmt(x, y1 <= 2 ? 1 : 0));
    chart += `<text class="c-tick" x="${padL - 6}" y="${top - 10}" text-anchor="end">m</text>`;
    chart += `<path class="c-band" d="${bandPath(H.t.map((tt, i) => [sx(tt), isNum(H.max[i]) ? sy(H.max[i]) : null]), H.t.map((tt, i) => [sx(tt), isNum(H.min[i]) ? sy(H.min[i]) : null]))}"/>`;
    chart += `<path class="c-line" d="${smoothPath(H.t.map((tt, i) => [sx(tt), isNum(H.value[i]) ? sy(H.value[i]) : null]))}"/>`;
    H.t.forEach((tt, i) => {
      if (i === 0 || dateKey(tt, tz) === dateKey(H.t[i - 1], tz)) return;
      chart += `<line class="c-grid" x1="${sx(tt)}" x2="${sx(tt)}" y1="${top}" y2="${bottom}"/>${sx(tt) < w - padR - 34 ? `<text class="c-tick" x="${sx(tt) + 4}" y="${bottom + 15}">${fmtWeekday(tt, tz)}</text>` : ''}`;
    });
    chart += '</svg>';
    hover = H.t.map((tt, i) => ({ x: sx(tt), html: `<b>${fmtWeekday(tt, tz)} ${fmtTime(tt, tz, settings.h12)}</b><span>${fmt(H.value[i], 1)} m${H.n[i] > 1 ? ` · models ${fmt(H.min[i], 1)}–${fmt(H.max[i], 1)} m (${H.n[i]})` : ''}</span>` })).filter((p, i) => isNum(H.value[i]));
  }
  let verify = '';
  if (N?.vars.waveH) {
    const r = N.vars.waveH;
    const chips = N.rows.map((row) => { const u = r.used.find((x) => x.id === row.id); return `<span class="chip${u?.outlier ? ' out' : ''}">${esc(row.short)} <b>${fmt(row.values.waveH, 1)} m</b></span>`; }).join('');
    verify = `<div class="verify">${conf(r)}<span>${r.n > 1 ? `Wave height from ${r.n} independent wave models, ±${fmt(r.sigma, 2)} m:` : 'Only one wave model has a sea cell here, so the sea state is unverified:'}</span></div><div class="chips">${chips}</div>
      <p class="p-note">Models work on 10–50 km grids and describe open water off this coast, not surf at the beach or sheltered harbours.</p>`;
  }
  el.innerHTML = `${head('h-sea', 'Sea state', N?.vars.waveH ? conf(N.vars.waveH) : conf('single'))}
    <div class="cols">${stats.join('')}</div>
    ${chart ? `<div class="chart-box">${chart}</div><div class="legend"><span><i></i>median of the wave models</span><span><i class="band"></i>range between models</span></div>` : ''}${verify}`;
  if (chart) attachHover(el.querySelector('.chart-box'), hover, { top: 22, bottom: 120 });
}

// --------------------------------------------------------------- climate

export function renderClimate(el, { state, v }) {
  const c = v?.climate;
  if (!c || !c.samples) { el.innerHTML = loading(state, ['climate', 'forecast']) ? skeleton('h-climate', 'Today in context') : unavailable('h-climate', 'Today in context', 'The climate record is unavailable right now.'); return; }
  const today = v.days?.[0];
  const hi = today?.tmax?.value;
  const w = innerWidth(el), h = 92, pad = 14, y = 46;
  const lo = Math.min(c.tmaxMin, isNum(hi) ? hi : Infinity) - 1, up = Math.max(c.tmaxMax, isNum(hi) ? hi : -Infinity) + 1;
  const sx = scale(lo, up, pad, w - pad);
  let svg = svgOpen(w, h, 'Today\'s forecast high against the last ten years');
  svg += `<line class="c-axis" x1="${pad}" x2="${w - pad}" y1="${y + 14}" y2="${y + 14}"/>`;
  svg += `<rect class="c-band" x="${sx(c.tmaxP10)}" y="${y - 12}" width="${Math.max(2, sx(c.tmaxP90) - sx(c.tmaxP10))}" height="24" rx="4"/>`;
  c.tmaxValues.forEach((val) => { svg += `<line x1="${sx(val).toFixed(1)}" x2="${sx(val).toFixed(1)}" y1="${y - 8}" y2="${y + 8}" stroke="var(--ink-3)" stroke-opacity=".28" stroke-width="1.5"/>`; });
  svg += `<line class="c-line" x1="${sx(c.tmaxMean)}" x2="${sx(c.tmaxMean)}" y1="${y - 15}" y2="${y + 15}"/><text class="c-tick" x="${sx(c.tmaxMean)}" y="${y + 30}" text-anchor="middle">usual ${fmt(c.tmaxMean, 1)}°</text>`;
  if (isNum(hi)) {
    const anchor = sx(hi) > w - 70 ? 'end' : sx(hi) < 70 ? 'start' : 'middle';
    svg += `<circle class="c-now-dot" cx="${sx(hi)}" cy="${y}" r="6"/><text class="c-label" x="${sx(hi)}" y="${y - 20}" text-anchor="${anchor}">today ${fmt(hi, 1)}°</text>`;
  }
  svg += `<text class="c-tick" x="${pad}" y="${h - 2}">${fmt(lo)}°</text><text class="c-tick" x="${w - pad}" y="${h - 2}" text-anchor="end">${fmt(up)}°</text></svg>`;
  let sentence = `Highs around this date usually reach ${fmt(c.tmaxMean, 1)}°.`;
  if (isNum(hi)) {
    const d = hi - c.tmaxMean;
    const rank = c.tmaxValues.filter((x) => x < hi).length / c.tmaxValues.length;
    const word = Math.abs(d) < 1 ? 'right on the usual' : `${fmt(Math.abs(d), 1)}° ${d > 0 ? 'warmer' : 'cooler'} than the usual`;
    sentence = `Today's high of ${fmt(hi)}° is ${word} ${fmt(c.tmaxMean, 1)}°, ${rank >= 0.9 ? 'among the warmest tenth' : rank <= 0.1 ? 'among the coolest tenth' : `warmer than ${fmt(rank * 100)}%`} of days at this time of year.`;
  }
  el.innerHTML = `${head('h-climate', 'Today in context')}
    <p class="big" style="font-size:20px;line-height:1.2;font-weight:500">${sentence}</p>
    <div class="chart-box">${svg}</div>
    <div class="legend"><span><i class="band"></i>middle 80% of past highs</span><span><i></i>ten-year mean</span></div>
    <div class="cols"><div class="stat"><span class="label">Usual low</span><b>${fmt(c.tminMean, 1)}<small>°C</small></b><i>${today?.tmin ? `today ${fmt(today.tmin.value)}°` : ''}</i></div>
      <div class="stat"><span class="label">Wet days</span><b>${fmt(c.wetShare * 100)}<small>%</small></b><i>with 1 mm or more</i></div></div>
    <p class="p-note">Each tick is one day's high from ERA5 reanalysis, ${c.firstYear}–${c.lastYear}, within a week either side of today's date (${c.samples} days). Reanalysis is a ~25 km grid, so it can differ from a city thermometer by a degree or two.</p>`;
}

// ---------------------------------------------------------------- space

export function renderSpace(el, { state, v, settings }) {
  const k = v?.kp;
  if (!k || !k.series.length) { el.innerHTML = loading(state, ['kp']) ? skeleton('h-space', 'Space weather') : unavailable('h-space', 'Space weather', 'NOAA space-weather data is unavailable right now.'); return; }
  const { tz, now, place } = v;
  const series = k.series.filter((s) => s.t >= now - 36 * HOUR && s.t <= now + 72 * HOUR);
  const latest = [...k.series].reverse().find((s) => s.observed && s.t <= now) || k.series[0];
  const ahead = k.series.filter((s) => s.t > now - 3 * HOUR && s.t <= now + 72 * HOUR);
  const peak = ahead.reduce((a, b) => (b.kp > (a?.kp ?? -1) ? b : a), null);
  const desc = kpDescription(latest.kp);
  const gm = geomagneticLatitude(place.lat, place.lon);
  const kpForAurora = Math.max(peak?.kp ?? 0, latest.kp);
  const aur = auroraChance(kpForAurora, gm);
  const w = innerWidth(el), h = 120, padL = 22, padR = 4, top = 8, base = 88;
  const sy = scale(0, 9, base, top);
  const bw = (w - padL - padR) / Math.max(1, series.length);
  let svg = svgOpen(w, h, 'Planetary K index, observed and forecast') + yGrid([0, 3, 5, 9], sy, padL, w - padR);
  const hover = [];
  series.forEach((s, i) => {
    const x = padL + i * bw;
    svg += bar(x + 1.5, sy(Math.max(0.15, s.kp)), Math.max(2, bw - 3), base, s.observed ? 'c-bar s5' : 'c-bar forecast', 2);
    if (i > 0 && dateKey(s.t, tz) !== dateKey(series[i - 1].t, tz) && x < w - padR - 30) svg += `<text class="c-tick" x="${x + 2}" y="${base + 15}">${fmtWeekday(s.t, tz)}</text>`;
    hover.push({ x: x + bw / 2, html: `<b>${fmtWeekday(s.t, tz)} ${fmtTime(s.t, tz, settings.h12)}</b><span>Kp ${fmt(s.kp, 1)} · ${kpDescription(s.kp).label}${s.observed ? '' : ' (forecast)'}</span>` });
  });
  svg += '</svg>';
  el.innerHTML = `${head('h-space', 'Space weather')}
    <div class="cols"><div class="stat"><span class="label">Planetary Kp · latest</span><b>${fmt(latest.kp, 1)}<small>of 9</small></b><i>${desc.label}${desc.g ? ` (${desc.g})` : ''}</i></div>
      <div class="stat"><span class="label">Peak next 3 days</span><b>${peak ? fmt(peak.kp, 1) : '—'}</b><i>${peak ? `${fmtWeekday(peak.t, tz)} ${fmtTime(peak.t, tz, settings.h12)} · ${kpDescription(peak.kp).label}${kpDescription(peak.kp).g ? ` (${kpDescription(peak.kp).g})` : ''}` : ''}</i></div></div>
    <div class="chart-box">${svg}</div>
    <div class="legend"><span><i class="band" style="background:var(--series-5)"></i>observed</span><span><i class="band" style="background:color-mix(in srgb, var(--series-5) 45%, transparent)"></i>NOAA forecast</span></div>
    <p class="sub">${peak && peak.kp > latest.kp ? `At the forecast peak (Kp ${fmt(kpForAurora, 1)}): ` : `At the current level (Kp ${fmt(kpForAurora, 1)}): `}${aur.label.charAt(0).toLowerCase()}${aur.label.slice(1)}.</p>
    <p class="p-note">Geomagnetic latitude here is ${fmt(Math.abs(gm))}°${gm < 0 ? 'S' : 'N'}. The aurora line is a rule of thumb from Kp; cloud and daylight still decide. Source: NOAA Space Weather Prediction Center.</p>`;
  attachHover(el.querySelector('.chart-box'), hover, { top, bottom: base });
}

// --------------------------------------------------------------- sources

const STATE_TEXT = { ok: 'Live', stale: 'Showing last good copy', error: 'Unreachable', none: 'No coverage here', skip: 'Not applicable', loading: 'Loading…' };

export function renderSources(el, { state, v, settings }) {
  const tz = v?.tz || 'UTC';
  const rows = FEEDS.map((f) => {
    const s = state.status[f.key] || { state: 'loading' };
    const note = s.state === 'error' ? esc(s.error || '') : s.note ? esc(s.note) : STATE_TEXT[s.state];
    const when = s.fetchedAt ? `${fmtTime(s.fetchedAt, tz, settings.h12)}${s.ms ? ` · ${s.ms} ms` : ''}` : '';
    return `<div class="feed"><i class="st is-${s.state}" title="${STATE_TEXT[s.state] || ''}"></i><div><b><a href="${f.url}" target="_blank" rel="noopener">${f.label}</a></b><small>${f.what}</small><small>${note}</small></div><span class="when">${when}</span></div>`;
  }).join('');
  const live = FEEDS.filter((f) => ['ok', 'stale'].includes(state.status[f.key]?.state)).length;
  el.innerHTML = `${head('h-sources', 'Sources', `<span class="p-note">${live} of ${FEEDS.length} feeds answering${state.loadedAt ? ` · checked ${fmtTime(state.loadedAt, tz, settings.h12)}` : ''}</span>`)}
    <div class="feeds">${rows}</div>
    <div class="method">
      <p><b>How Isobar decides what to show.</b> Every reading is the median of the sources that answered, after setting aside any that sit far outside the rest. Confidence comes from how tightly they agree, with fixed tolerances per variable (temperature: within ±1.0° is high, ±2.5° medium). One source alone is always labelled unverified, and two can never rate above medium.</p>
      <p><b>What that does and does not mean.</b> Agreement between models is evidence, not proof: models share observations and physics, and they can be wrong together. Nearby weather stations are included where they exist. Tides, UV, visibility and currents often have a single source and say so.</p>
    </div>`;
}

export function renderFoot(el) {
  el.innerHTML = `<p>Weather data: <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0) with models from ECMWF, NOAA, DWD, ECCC, Météo-France and the UK Met Office; <a href="https://api.met.no" target="_blank" rel="noopener">MET Norway</a> (CC BY 4.0); US National Weather Service; DWD via Bright Sky; World Weather Online via wttr.in. Air quality: Copernicus Atmosphere Monitoring Service; Sensor.Community (ODbL). Tides: NOAA CO-OPS. Radar: RainViewer. Global maps: Environment and Climate Change Canada (MSC GeoMet) and NASA GIBS; NASA GIBS with © OpenStreetMap contributors. Astronomy: Astronomy Engine.</p>
    <p>Isobar is not a safety service. For warnings, follow your national weather agency; never use these tide or sea figures for navigation.</p>`;
}
