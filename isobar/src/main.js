// Isobar — application shell: settings, places, routing between the Local
// and Globe views, and the render loop that repaints panels as sources arrive.

import { createEngine } from './engine.js';
import { searchPlaces } from './providers/openmeteo.js';
import { reverseGeocode } from './providers/misc.js';
import { pruneCache } from './lib/http.js';
import { PERSONALITIES } from './lib/snark.js';
import { escapeHtml as esc, fmtCoords } from './lib/units.js';
import { uiIcon } from './ui/icons.js';
import { createSky } from './ui/sky.js';
import { renderHero, renderAlerts, renderHourly, renderDaily, renderCross, renderNowcast, renderWind, renderPressure, renderUv, renderHumidity, renderVisibility, renderCloud, detailHtml, head } from './ui/panels-a.js';
import { renderAir, renderSun, renderMoon, renderTides, renderSea, renderClimate, renderSpace, renderSources, renderFoot } from './ui/panels-b.js';
import { createRadar, createGlobe } from './ui/globe.js';

const $ = (sel) => document.querySelector(sel);
const store = {
  get(key, fallback) { try { const raw = localStorage.getItem(`isobar:${key}`); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`isobar:${key}`, JSON.stringify(value)); } catch { /* private mode: settings last for this visit only */ } },
};

const DEFAULT_PLACE = { name: 'San Francisco', region: 'California, United States', lat: 37.7749, lon: -122.4194, tz: 'America/Los_Angeles' };
const SETTING_DEFAULTS = { wind: 'kmh', h12: false, aqi: 'us', voice: 'dry', theme: 'auto' };

const settings = { ...SETTING_DEFAULTS, ...store.get('settings', {}) };
let places = store.get('places', []);
if (!Array.isArray(places)) places = [];
const ui = { hourlyMetric: 'temp' };
let current = null;
let sky = null, radar = null, globe = null, engine = null;
let view = 'local';

// ------------------------------------------------------------------ boot

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = settings.theme;
  const darkNow = settings.theme === 'dark' || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', darkNow ? '#090f16' : '#eef1ee');
  radar?.retheme(); globe?.retheme();
}

async function loadTideIndex() {
  if (globalThis.__ISOBAR_TIDE_INDEX__) return globalThis.__ISOBAR_TIDE_INDEX__;
  try {
    const res = await fetch(new URL('../data/noaa-tide-stations.json', import.meta.url));
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function placeFromUrl() {
  const q = new URLSearchParams(location.search);
  const lat = parseFloat(q.get('lat')), lon = parseFloat(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name: (q.get('name') || fmtCoords(lat, lon)).slice(0, 80), region: '', lat, lon, tz: null };
}

async function boot() {
  applyTheme();
  $('#place-icon').innerHTML = uiIcon('search', 16);
  $('#btn-locate').innerHTML = uiIcon('locate');
  $('#btn-refresh').innerHTML = uiIcon('refresh');
  $('#btn-settings').innerHTML = uiIcon('settings');
  $('#dlg-locate').innerHTML = `${uiIcon('locate')} Use my current location`;
  document.querySelectorAll('[data-close]').forEach((b) => { b.innerHTML = uiIcon('close'); });
  renderFoot($('#foot'));
  pruneCache();

  sky = createSky($('#sky'));
  const tideIndex = await loadTideIndex();
  engine = createEngine({ tideIndex, onChange: schedule });

  $('#p-radar').innerHTML = `${head('h-radar', 'Rain radar', '<a class="p-note" href="#globe">Open the Globe for model and satellite layers</a>')}<div id="radar-host" style="display:grid;gap:10px"></div>`;
  radar = createRadar($('#radar-host'), mapCtx);
  globe = createGlobe({ mapEl: $('#globe-map'), sideEl: $('#globe-side'), barEl: $('#globe-bar'), getCtx: mapCtx });

  bind();
  route();
  const fromUrl = placeFromUrl();
  const last = store.get('current', null);
  setPlace(fromUrl || last || places[0] || DEFAULT_PLACE, { save: false });

  // If location access was granted on an earlier visit, use it without asking again.
  if (!fromUrl && !last && navigator.permissions?.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') locate(true); }).catch(() => {});
  }

  setInterval(() => { if (!document.hidden) engine.tick(); }, 60e3);
  setInterval(() => { if (!document.hidden && current) engine.load(current); }, 10 * 60e3);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && current && engine.state.loadedAt && Date.now() - engine.state.loadedAt > 10 * 60e3) engine.load(current);
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => render(), 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !globalThis.__ISOBAR_SINGLE_FILE__) {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
  }
}

function mapCtx() {
  return { place: current, tz: engine?.state.view?.tz || engine?.state.tz || current?.tz || 'UTC', settings };
}

// ---------------------------------------------------------------- places

function samePlace(a, b) { return a && b && Math.abs(a.lat - b.lat) < 0.005 && Math.abs(a.lon - b.lon) < 0.005; }

function setPlace(place, { save = true } = {}) {
  current = { ...place };
  store.set('current', current);
  if (save && !places.some((p) => samePlace(p, current))) { places = [current, ...places].slice(0, 12); store.set('places', places); }
  $('#place-name').textContent = current.name;
  $('#place-sub').textContent = current.region || '';
  document.title = `${current.name} · Isobar`;
  engine.load(current);
  globe.recenter();
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

function locate(silent = false) {
  if (!navigator.geolocation) { if (!silent) toast('This browser cannot share its location. Search for a place instead.'); return; }
  const btn = $('#btn-locate');
  btn.classList.add('spin');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    let name = 'My location', region = '';
    try { const r = await reverseGeocode(lat, lon); if (r.name) { name = r.name; region = r.region; } } catch { /* keep the generic name */ }
    btn.classList.remove('spin');
    $('#dlg-place').close();
    setPlace({ name, region, lat, lon, tz: null });
  }, (err) => {
    btn.classList.remove('spin');
    if (!silent) toast(err.code === 1 ? 'Location permission was declined. Search for a place instead.' : 'Could not get a location fix. Search for a place instead.');
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60e3 });
}

function renderSaved() {
  const el = $('#place-saved');
  if (!places.length) { el.innerHTML = '<p class="empty">Places you open are kept here on this device.</p>'; return; }
  el.innerHTML = places.map((p, i) => `<div class="place-row"><button type="button" class="place-pick" data-saved="${i}"><b>${esc(p.name)}</b><small>${esc(p.region || fmtCoords(p.lat, p.lon))}</small></button>
    <button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove ${esc(p.name)}">${uiIcon('trash')}</button></div>`).join('');
}

let searchSeq = 0, searchTimer = 0, lastResults = [];
function onSearchInput() {
  const q = $('#place-q').value.trim();
  const out = $('#place-results');
  clearTimeout(searchTimer);
  if (q.length < 2) { out.innerHTML = ''; return; }
  const my = ++searchSeq;
  searchTimer = setTimeout(async () => {
    out.innerHTML = '<p class="empty">Searching…</p>';
    try {
      const results = await searchPlaces(q);
      if (my !== searchSeq) return;
      lastResults = results;
      out.innerHTML = results.length
        ? results.map((r, i) => `<div class="place-row"><button type="button" class="place-pick" data-result="${i}"><b>${esc(r.name)}</b><small>${esc(r.region)} · ${fmtCoords(r.lat, r.lon)}</small></button></div>`).join('')
        : '<p class="empty">No place found with that name. Try the nearest town or a different spelling.</p>';
    } catch {
      if (my === searchSeq) out.innerHTML = '<p class="empty">Search is unavailable right now. Check your connection and try again.</p>';
    }
  }, 260);
}

// -------------------------------------------------------------- settings

function renderSettings() {
  const seg = (name, options) => `<div class="seg" role="radiogroup" aria-label="${name}">${options.map(([value, label, hint]) => `<label><input type="radio" name="${name}" value="${value}" ${String(settings[name]) === String(value) ? 'checked' : ''}><span>${label}${hint ? `<small>${hint}</small>` : ''}</span></label>`).join('')}</div>`;
  $('#settings-body').innerHTML = `
    <div class="set-group"><h3 class="label">Forecaster's voice</h3>${seg('voice', PERSONALITIES.map((p) => [p.key, p.label, p.hint]))}</div>
    <div class="set-group"><h3 class="label">Wind speed</h3>${seg('wind', [['kmh', 'km/h'], ['ms', 'm/s']])}</div>
    <div class="set-group"><h3 class="label">Clock</h3>${seg('h12', [[false, '24-hour'], [true, '12-hour']])}</div>
    <div class="set-group"><h3 class="label">Air quality index</h3>${seg('aqi', [['us', 'US AQI', '0–500'], ['eu', 'European AQI', '0–100+']])}</div>
    <div class="set-group"><h3 class="label">Appearance</h3>${seg('theme', [['auto', 'Match device'], ['light', 'Chart paper'], ['dark', 'Night watch']])}</div>
    <p class="p-note">Everything is metric: °C, mm, hPa, km, m, µg/m³. Settings and saved places stay in this browser; nothing is sent anywhere except the coordinates each weather service needs, rounded to about 100 m.</p>`;
}

// ---------------------------------------------------------------- render

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; render(); });
}

const PANELS = [
  ['#p-alerts', renderAlerts], ['#p-hourly', renderHourly], ['#p-daily', renderDaily], ['#p-cross', renderCross], ['#p-nowcast', renderNowcast],
  ['#p-wind', renderWind], ['#p-pressure', renderPressure], ['#p-uv', renderUv], ['#p-humidity', renderHumidity], ['#p-visibility', renderVisibility], ['#p-cloud', renderCloud],
  ['#p-air', renderAir], ['#p-sun', renderSun], ['#p-moon', renderMoon], ['#p-tides', renderTides], ['#p-sea', renderSea],
  ['#p-climate', renderClimate], ['#p-space', renderSpace], ['#p-sources', renderSources],
];

function render() {
  if (!engine) return;
  const state = engine.state;
  const ctx = { state, v: state.view, settings, ui };
  $('#btn-refresh').classList.toggle('spin', !!state.loading);
  if (view !== 'local') return;
  try { sky.set(renderHero($('#hero-content'), ctx)); } catch (err) { console.error('hero', err); }
  for (const [sel, fn] of PANELS) {
    try { fn($(sel), ctx); } catch (err) { console.error(sel, err); $(sel).innerHTML = '<p class="empty">This panel hit an error and was skipped. The rest of the page is unaffected.</p>'; }
  }
  radar.update();
}

function route() {
  view = location.hash === '#globe' ? 'globe' : 'local';
  $('#view-local').hidden = view !== 'local';
  $('#view-globe').hidden = view !== 'globe';
  document.querySelectorAll('.view-tab').forEach((a) => { if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (view === 'globe') globe.show(); else { globe?.stop(); render(); }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- events

function bind() {
  window.addEventListener('hashchange', route);
  $('#btn-place').addEventListener('click', () => { renderSaved(); $('#dlg-place').showModal(); $('#place-q').focus(); $('#place-q').select(); });
  $('#btn-settings').addEventListener('click', () => { renderSettings(); $('#dlg-settings').showModal(); });
  $('#btn-refresh').addEventListener('click', () => { if (current) { engine.load(current, { force: true }); radar.refresh(); } });
  $('#btn-locate').addEventListener('click', () => locate(false));
  $('#dlg-locate').addEventListener('click', () => locate(false));
  $('#place-q').addEventListener('input', onSearchInput);
  $('#place-q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); if (lastResults[0]) pick(lastResults[0]); } });

  const pick = (r) => { $('#dlg-place').close(); $('#place-q').value = ''; $('#place-results').innerHTML = ''; lastResults = []; setPlace({ name: r.name, region: r.region, lat: r.lat, lon: r.lon, tz: r.tz || null }); };
  $('#dlg-place').addEventListener('click', (ev) => {
    const res = ev.target.closest('[data-result]'), saved = ev.target.closest('[data-saved]'), rm = ev.target.closest('[data-remove]');
    if (res) pick(lastResults[+res.dataset.result]);
    else if (saved) pick(places[+saved.dataset.saved]);
    else if (rm) { places.splice(+rm.dataset.remove, 1); store.set('places', places); renderSaved(); }
  });

  $('#settings-body').addEventListener('change', (ev) => {
    const { name, value } = ev.target;
    if (!(name in settings)) return;
    settings[name] = name === 'h12' ? value === 'true' : value;
    store.set('settings', settings);
    if (name === 'theme') applyTheme();
    render();
  });

  // light-dismiss for dialogs
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); }));

  document.addEventListener('click', (ev) => {
    const metric = ev.target.closest('[data-metric]');
    if (metric) { ui.hourlyMetric = metric.dataset.metric; render(); return; }
    const detail = ev.target.closest('[data-detail]');
    if (detail && engine.state.view) {
      const { title, html } = detailHtml(detail.dataset.detail, { v: engine.state.view, settings });
      $('#dlg-detail-title').textContent = title;
      $('#detail-body').innerHTML = html;
      $('#dlg-detail').showModal();
    }
  });
}

boot();
