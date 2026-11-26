// Map views: the local radar panel and the full-screen Globe with global
// model and satellite layers, a forecast time slider and tap-to-read values.

import * as L from '../../vendor/leaflet.js';
import { GEOMET, GIBS, LAYER_GROUPS, OVERLAYS, ALL_LAYERS, parseTimeDimension, wmsTime } from '../lib/layers.js';
import { fetchRadarFrames } from '../providers/misc.js';
import { fmtTime, fmtWeekday, fmtDayMonth, HOUR, DAY } from '../lib/time.js';
import { escapeHtml as esc, compass, fmtWind, windUnitLabel, isNum } from '../lib/units.js';
import { uiIcon } from './icons.js';

// Base map: NASA GIBS reference layers (keyless). Land mask below the data,
// borders and place names above it; CSS filters theme them (see app.css).
const gibsStatic = (layer, level = 9) => `${GIBS}/wmts/epsg3857/best/${layer}/default/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.png`;
const ATTR_BASE = 'Base map: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a>, © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

function hereIcon() {
  return L.divIcon({ className: '', html: '<div class="here-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
}

function baseLayers(map) {
  const pane = (name, z, interactive = false) => { const p = map.createPane(name); p.style.zIndex = z; if (!interactive) p.style.pointerEvents = 'none'; return p; };
  pane('land', 210); pane('data', 300); pane('lines', 350); pane('ref', 420); pane('labels', 450);
  L.tileLayer(gibsStatic('OSM_Land_Mask'), { pane: 'land', attribution: ATTR_BASE, maxNativeZoom: 9, maxZoom: 12 }).addTo(map);
  L.tileLayer(gibsStatic('Reference_Features'), { pane: 'ref', maxNativeZoom: 9, maxZoom: 12 }).addTo(map);
  L.tileLayer(gibsStatic('Reference_Labels'), { pane: 'labels', maxNativeZoom: 9, maxZoom: 12 }).addTo(map);
  return { retheme() { /* colours follow the CSS theme tokens */ } };
}

// ------------------------------------------------------------ local radar

export function createRadar(el, getCtx) {
  el.innerHTML = `<div class="radar-map" id="radar-map"></div>
    <div class="map-ctl"><button class="icon-btn" type="button" id="radar-play" aria-label="Play radar loop">${uiIcon('play')}</button>
      <label class="sr" for="radar-range">Radar frame</label><input id="radar-range" type="range" min="0" max="0" value="0" step="1"><span class="when" id="radar-when">—</span></div>
    <p class="p-note" id="radar-note">Loading radar…</p>`;
  const map = L.map(el.querySelector('#radar-map'), { zoomControl: true, attributionControl: true, minZoom: 3, maxZoom: 9, scrollWheelZoom: false, worldCopyJump: true });
  const base = baseLayers(map);
  const marker = L.marker([0, 0], { icon: hereIcon(), interactive: false, keyboard: false }).addTo(map);
  const range = el.querySelector('#radar-range'), whenEl = el.querySelector('#radar-when'), note = el.querySelector('#radar-note'), playBtn = el.querySelector('#radar-play');
  let frames = [], layer = null, timer = 0, placeKey = '';

  function show(i) {
    const f = frames[i];
    if (!f) return;
    const { tz, settings } = getCtx();
    const next = L.tileLayer(f.url, { pane: 'data', opacity: 0.75, maxNativeZoom: 7, maxZoom: 12, attribution: 'Radar © <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>' });
    next.addTo(map);
    const old = layer;
    layer = next;
    if (old) next.once('load', () => map.removeLayer(old)), setTimeout(() => map.hasLayer(old) && map.removeLayer(old), 1500);
    whenEl.textContent = `${fmtTime(f.t, tz, settings.h12)}${f.kind === 'nowcast' ? ' forecast' : ''}`;
    range.value = String(i);
  }
  function stop() { clearInterval(timer); timer = 0; playBtn.innerHTML = uiIcon('play'); playBtn.setAttribute('aria-label', 'Play radar loop'); }
  playBtn.addEventListener('click', () => {
    if (timer) return stop();
    playBtn.innerHTML = uiIcon('pause'); playBtn.setAttribute('aria-label', 'Pause radar loop');
    timer = setInterval(() => show((+range.value + 1) % frames.length), 700);
  });
  range.addEventListener('input', () => { stop(); show(+range.value); });

  async function load() {
    try {
      const res = await fetchRadarFrames();
      frames = res.frames;
      range.max = String(Math.max(0, frames.length - 1));
      const lastPast = frames.map((f) => f.kind).lastIndexOf('past');
      show(lastPast >= 0 ? lastPast : frames.length - 1);
      note.textContent = 'Composite of national weather radars, last two hours. Empty areas may simply have no radar coverage — the Globe view has satellite rainfall for those.';
    } catch {
      note.textContent = 'Radar frames could not be loaded right now.';
    }
  }

  return {
    update() {
      const { place } = getCtx();
      if (!place) return;
      const key = `${place.lat},${place.lon}`;
      if (key !== placeKey) {
        placeKey = key;
        map.setView([place.lat, place.lon], 6);
        marker.setLatLng([place.lat, place.lon]);
        load();
      }
      map.invalidateSize();
    },
    retheme: () => base.retheme(),
    refresh: load,
  };
}

// ------------------------------------------------------------------ globe

const capCache = new Map();
async function layerTimes(layerName) {
  const hit = capCache.get(layerName);
  if (hit && Date.now() - hit.at < 20 * 60e3) return hit.value;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&layers=${encodeURIComponent(layerName)}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/xml');
    const dims = [...doc.getElementsByTagName('Dimension')];
    const time = dims.find((d) => d.getAttribute('name') === 'time');
    const ref = dims.find((d) => d.getAttribute('name') === 'reference_time');
    const value = {
      times: time ? parseTimeDimension(time.textContent) : [],
      defaultTime: time ? Date.parse(time.getAttribute('default')) : null,
      run: ref ? Date.parse(ref.getAttribute('default')) : null,
    };
    capCache.set(layerName, { at: Date.now(), value });
    return value;
  } finally { clearTimeout(timer); }
}

const utcStamp = (ms) => `${fmtWeekday(ms, 'UTC')} ${fmtDayMonth(ms, 'UTC')} ${fmtTime(ms, 'UTC')} UTC`;

export function createGlobe({ mapEl, sideEl, barEl, getCtx, initialLayer = 'cloud' }) {
  const map = L.map(mapEl, { zoomControl: true, minZoom: 2, maxZoom: 9, worldCopyJump: true, zoomSnap: 0.5 });
  map.setView([20, 0], 2.5);
  const base = baseLayers(map);
  const marker = L.marker([0, 0], { icon: hereIcon(), interactive: false, keyboard: false });
  const st = { id: initialLayer, times: [], idx: 0, run: null, opacity: null, overlays: new Set(), playing: 0, frames: [], token: 0, started: false };
  let dataLayer = null;
  const overlayLayers = new Map();
  const def = () => ALL_LAYERS.find((l) => l.id === st.id) || ALL_LAYERS[0];
  const currentTime = () => st.times[st.idx] ?? null;

  // ---- side panel
  function renderSide() {
    const d = def();
    const groups = LAYER_GROUPS.map((g) => `<div class="layer-group"><h3 class="label">${g.title}</h3>${g.layers.map((l) => `
      <button type="button" class="layer-btn" data-layer="${l.id}" aria-pressed="${l.id === d.id}"><b>${l.name}</b>${l.tag ? `<span class="tag">${l.tag}</span>` : '<span class="tag">forecast</span>'}</button>`).join('')}</div>`).join('');
    const legend = d.kind === 'wms'
      ? `<img alt="Legend for ${esc(d.name)}" loading="lazy" src="${GEOMET}?service=WMS&version=1.3.0&request=GetLegendGraphic&layer=${encodeURIComponent(d.layer)}&style=${encodeURIComponent(d.style)}&format=image/png&sld_version=1.1.0&lang=en">`
      : d.legend ? `<img alt="Legend for ${esc(d.name)}" loading="lazy" src="${GIBS}/legends/${d.legend}">`
        : d.kind === 'radar' ? '<p>Blue is light rain, yellow moderate, red heavy; pink and white mark snow and hail cores.</p>' : '';
    const overlays = OVERLAYS.map((o) => `<label class="toggle" title="${o.note}"><input type="checkbox" data-overlay="${o.id}" ${st.overlays.has(o.id) ? 'checked' : ''}> ${o.name}</label>`).join('');
    sideEl.innerHTML = `<button type="button" class="sheet-toggle" id="sheet-toggle" aria-expanded="${!sideEl.classList.contains('collapsed')}"><span>${esc(d.name)} <small>· layers and legend</small></span>${uiIcon('layers')}</button>
      <div class="layer-info"><h3>${esc(d.name)}</h3><p>${esc(d.desc)}</p><p class="mono">${esc(d.source)}</p>${legend}
        <label class="toggle" for="layer-opacity">Opacity <input id="layer-opacity" type="range" min="20" max="100" step="5" value="${Math.round((st.opacity ?? d.opacity ?? 0.7) * 100)}" style="flex:1;accent-color:var(--accent)"></label>
        <div style="display:flex;gap:14px;flex-wrap:wrap">${overlays}</div>
        <p class="p-note">${d.kind === 'wms' ? 'Tap the map to read the value at any point.' : d.kind === 'radar' ? 'Observed by radar; no point values.' : 'Satellite product; no point values.'}</p></div>
      ${groups}
      <p class="p-note">Forecast layers come from one model, Canada's GDPS, shown at full resolution. They are not blended with the other models the Local view compares, so treat detail as one model's opinion.</p>`;
  }

  sideEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-layer]');
    if (btn) { select(btn.dataset.layer); return; }
    if (ev.target.closest('#sheet-toggle')) { sideEl.classList.toggle('collapsed'); renderSide(); map.invalidateSize(); }
  });
  sideEl.addEventListener('input', (ev) => {
    if (ev.target.id === 'layer-opacity') { st.opacity = +ev.target.value / 100; dataLayer?.setOpacity(st.opacity); }
  });
  sideEl.addEventListener('change', (ev) => {
    const id = ev.target.dataset?.overlay;
    if (!id) return;
    if (ev.target.checked) st.overlays.add(id); else st.overlays.delete(id);
    syncOverlays();
  });

  // ---- time bar
  function renderBar(message = '') {
    const d = def();
    const { tz, place, settings } = getCtx();
    const t = currentTime();
    const hasSlider = st.times.length > 1;
    let caption = message;
    if (!caption) {
      if (d.kind === 'wms') caption = st.run ? `Model run ${utcStamp(st.run)}` : '';
      else if (d.kind === 'radar') caption = 'Observed radar frames';
      else caption = d.time === 'yesterday' ? `Daily mosaic for ${fmtDayMonth(Date.now() - DAY, 'UTC')} (UTC)` : 'Latest available analysis';
    }
    const local = t != null && tz && place ? ` · ${fmtWeekday(t, tz)} ${fmtTime(t, tz, settings.h12)} in ${esc(place.name)}` : '';
    const lead = t != null && d.kind === 'wms' ? (() => { const h = Math.round((t - Date.now()) / HOUR); return h === 0 ? 'now' : h > 0 ? `+${h} h` : `${h} h`; })() : '';
    barEl.innerHTML = `${hasSlider ? `<div class="globe-time"><button class="icon-btn" type="button" id="globe-play" aria-label="${st.playing ? 'Pause' : 'Play'} forecast animation">${uiIcon(st.playing ? 'pause' : 'play')}</button>
        <label class="sr" for="globe-range">Forecast time</label><input id="globe-range" type="range" min="0" max="${st.times.length - 1}" step="1" value="${st.idx}">
        <span class="when">${t != null ? utcStamp(t) : ''}</span></div>` : ''}
      <div class="globe-caption"><span><b>${esc(d.name)}</b>${lead ? ` · ${lead}` : ''}${local}</span><span>${esc(caption)}</span></div>`;
  }
  let debounce = 0;
  barEl.addEventListener('input', (ev) => {
    if (ev.target.id !== 'globe-range') return;
    stopPlay();
    st.idx = +ev.target.value;
    const when = barEl.querySelector('.when');
    if (when && currentTime() != null) when.textContent = utcStamp(currentTime());
    clearTimeout(debounce);
    debounce = setTimeout(() => { applyTime(); renderBar(); barEl.querySelector('#globe-range')?.focus(); }, 180);
  });
  barEl.addEventListener('click', (ev) => {
    if (!ev.target.closest('#globe-play')) return;
    if (st.playing) { stopPlay(); renderBar(); return; }
    st.playing = setInterval(() => {
      st.idx = (st.idx + 1) % st.times.length;
      // keep the loop inside the next three days so it stays snappy
      if (currentTime() - Date.now() > 72 * HOUR) st.idx = Math.max(0, st.times.findIndex((x) => x >= Date.now() - HOUR));
      applyTime(); renderBar();
    }, 1400);
    renderBar();
  });
  function stopPlay() { clearInterval(st.playing); st.playing = 0; }

  // ---- layers
  function makeLayer(d) {
    const opacity = st.opacity ?? d.opacity ?? 0.7;
    if (d.kind === 'wms') {
      const params = { layers: d.layer, styles: d.style, format: 'image/png', transparent: true, version: '1.3.0', pane: 'data', opacity, attribution: 'Model data © <a href="https://eccc-msc.github.io/open-data/licence/readme_en/" target="_blank" rel="noopener">Environment and Climate Change Canada</a>' };
      if (currentTime() != null) params.time = wmsTime(currentTime());
      return L.tileLayer.wms(GEOMET, params);
    }
    if (d.kind === 'gibs') {
      const time = d.time === 'yesterday' ? new Date(Date.now() - DAY).toISOString().slice(0, 10) : 'default';
      return L.tileLayer(`${GIBS}/wmts/epsg3857/best/${d.layer}/default/${time}/GoogleMapsCompatible_Level${d.level}/{z}/{y}/{x}.${d.ext}`, { pane: 'data', opacity, maxNativeZoom: d.level, maxZoom: 12, attribution: 'Imagery: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA EOSDIS GIBS</a>' });
    }
    const f = st.frames[st.idx];
    return f ? L.tileLayer(f.url, { pane: 'data', opacity, maxNativeZoom: 7, maxZoom: 12, attribution: 'Radar © <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>' }) : null;
  }

  function swap(next) {
    const old = dataLayer;
    dataLayer = next;
    if (next) next.addTo(map);
    if (old) {
      if (next) { next.once('load', () => map.hasLayer(old) && map.removeLayer(old)); setTimeout(() => map.hasLayer(old) && map.removeLayer(old), 2500); }
      else map.removeLayer(old);
    }
  }

  function applyTime() {
    const d = def();
    if (d.kind === 'wms' && dataLayer?.setParams && currentTime() != null) dataLayer.setParams({ time: wmsTime(currentTime()) });
    else if (d.kind === 'radar') swap(makeLayer(d));
    syncOverlays();
  }

  function overlayTime() {
    // Overlays are GDPS fields: follow the selected time when the main layer is a model, else "now".
    const d = def();
    const t = d.kind === 'wms' && currentTime() != null ? currentTime() : Math.round(Date.now() / HOUR) * HOUR;
    return wmsTime(Math.round(t / HOUR) * HOUR);
  }
  function syncOverlays() {
    for (const o of OVERLAYS) {
      const on = st.overlays.has(o.id);
      let lyr = overlayLayers.get(o.id);
      if (on && !lyr) {
        lyr = L.tileLayer.wms(GEOMET, { layers: o.layer, styles: o.style, format: 'image/png', transparent: true, version: '1.3.0', pane: 'lines', opacity: 0.85, time: overlayTime() }).addTo(map);
        overlayLayers.set(o.id, lyr);
      } else if (on && lyr) lyr.setParams({ time: overlayTime() });
      else if (!on && lyr) { map.removeLayer(lyr); overlayLayers.delete(o.id); }
    }
  }

  async function select(id) {
    const my = ++st.token;
    stopPlay();
    st.id = id; st.times = []; st.idx = 0; st.run = null; st.opacity = null;
    const d = def();
    map.closePopup();
    renderSide();
    renderBar('Loading…');
    try {
      if (d.kind === 'wms') {
        const cap = await layerTimes(d.layer);
        if (my !== st.token) return;
        // from the current step out to the end of the run
        const startAt = Date.now() - 2 * HOUR;
        st.times = cap.times.filter((t) => t >= startAt);
        if (!st.times.length) st.times = cap.times.slice(-1);
        const now = Date.now();
        st.idx = st.times.reduce((best, t, i) => (Math.abs(t - now) < Math.abs(st.times[best] - now) ? i : best), 0);
        st.run = cap.run;
      } else if (d.kind === 'radar') {
        const res = await fetchRadarFrames();
        if (my !== st.token) return;
        st.frames = res.frames;
        st.times = res.frames.map((f) => f.t);
        st.idx = Math.max(0, res.frames.map((f) => f.kind).lastIndexOf('past'));
      }
      swap(makeLayer(d));
      syncOverlays();
      renderBar();
    } catch (err) {
      if (my !== st.token) return;
      swap(null);
      renderBar(`This layer could not be loaded (${err?.message || 'network error'}). Try another layer or come back shortly.`);
    }
  }

  // ---- tap to read
  map.on('click', async (ev) => {
    const d = def();
    if (d.kind !== 'wms') return;
    const { lat, lng } = ev.latlng;
    const lon = ((lng + 540) % 360) - 180;
    const popup = L.popup({ maxWidth: 240 }).setLatLng(ev.latlng).setContent('Reading…').openOn(map);
    const half = 0.25;
    const q = new URLSearchParams({
      service: 'WMS', version: '1.3.0', request: 'GetFeatureInfo', layers: d.layer, query_layers: d.layer, info_format: 'application/json',
      crs: 'EPSG:4326', bbox: `${lat - half},${lon - half},${lat + half},${lon + half}`, width: '101', height: '101', i: '50', j: '50',
    });
    if (currentTime() != null) q.set('time', wmsTime(currentTime()));
    try {
      const res = await fetch(`${GEOMET}?${q}`);
      const json = await res.json();
      const props = json?.features?.[0]?.properties;
      const { settings } = getCtx();
      let body;
      // Models pad land, ice and gaps with fill values (9999, 1e20…); those are not readings.
      const real = (x) => isNum(x) && Math.abs(x) < 1e15 && x !== 9999 && x !== -9999 && (!d.valid || (x >= d.valid[0] && x <= d.valid[1]));
      if (d.vector && props && real(props.uv_length)) {
        body = `<b>${(props.uv_length * 3.6).toFixed(2)} km/h</b>${props.uv_length.toFixed(2)} m/s${isNum(props.uv_angle) ? ` · setting ${compass(props.uv_angle)}` : ''}`;
      } else if (props && real(props.value)) {
        if (d.wind) body = `<b>${fmtWind(props.value * 3.6, settings.wind)} ${windUnitLabel(settings.wind)}</b>`;
        else { const r = d.probe(props.value); body = `<b>${esc(r.text)}</b>${r.note ? esc(r.note) : ''}`; }
      } else body = esc(d.empty || 'No value at this point.');
      popup.setContent(`${body}<br><span class="p-note">${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'} · ${esc(d.name)}${currentTime() != null ? ` · ${utcStamp(currentTime())}` : ''}</span>`);
    } catch {
      popup.setContent('Could not read a value here just now.');
    }
  });

  return {
    /** Call when the view becomes visible or the place changes. */
    show() {
      const { place } = getCtx();
      map.invalidateSize();
      if (place) { marker.setLatLng([place.lat, place.lon]); if (!map.hasLayer(marker)) marker.addTo(map); }
      if (!st.started) {
        st.started = true;
        if (matchMedia('(max-width: 760px)').matches) sideEl.classList.add('collapsed');
        if (place) map.setView([place.lat, place.lon], 3.5);
        select(st.id);
      } else renderBar();
    },
    recenter() { const { place } = getCtx(); if (place) { marker.setLatLng([place.lat, place.lon]); if (!map.hasLayer(marker)) marker.addTo(map); map.setView([place.lat, place.lon], Math.max(map.getZoom(), 3.5)); } },
    retheme: () => base.retheme(),
    stop: stopPlay,
  };
}
