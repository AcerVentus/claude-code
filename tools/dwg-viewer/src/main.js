// UI shell: file handling, layer list, layout tabs, selection and measuring.

import { FOREGROUND } from './aci.js'
import { Renderer } from './render.js'

const $ = id => document.getElementById(id)
const canvas = $('canvas')
const renderer = new Renderer(canvas)

const state = {
  scene: null,
  fileName: '',
  tool: 'select',
  job: 0,
  worker: null,
  layerItems: []
}

const TYPE_NAMES = {
  LINE: 'Line', LWPOLYLINE: 'Polyline', POLYLINE2D: 'Polyline', POLYLINE3D: '3D polyline',
  CIRCLE: 'Circle', ARC: 'Arc', ELLIPSE: 'Ellipse', SPLINE: 'Spline', POINT: 'Point',
  TEXT: 'Text', MTEXT: 'Multiline text', ATTDEF: 'Attribute definition', INSERT: 'Block reference',
  DIMENSION: 'Dimension', HATCH: 'Hatch', SOLID: 'Solid fill', TRACE: 'Trace', '3DFACE': '3D face',
  LEADER: 'Leader', MULTILEADER: 'Multileader', MLINE: 'Multiline', IMAGE: 'Raster image',
  XLINE: 'Construction line', RAY: 'Ray', ACAD_TABLE: 'Table', TOLERANCE: 'Tolerance',
  VIEWPORT: 'Viewport', WIPEOUT: 'Wipeout'
}
const INFO_LABELS = { INSERT: 'Block', TEXT: 'Text', MTEXT: 'Text', ATTDEF: 'Tag', DIMENSION: 'Value', HATCH: 'Pattern' }

// ---- formatting -----------------------------------------------------------

function formatNumber(v, digits = 6) {
  if (!isFinite(v)) return '–'
  const rounded = Number(v.toPrecision(digits))
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 6, useGrouping: Math.abs(rounded) >= 10000 })
}

function formatCoord(v) {
  // Show about one more decimal than a screen pixel can resolve.
  const decimals = Math.min(6, Math.max(0, Math.ceil(Math.log10(renderer.view.k)) + 1))
  return v.toFixed(decimals)
}

const withUnits = text => (state.scene?.meta.units ? `${text} ${state.scene.meta.units}` : text)

// ---- theme ----------------------------------------------------------------

function applyTheme(name) {
  document.documentElement.dataset.theme = name
  renderer.setTheme(name)
  for (const item of state.layerItems) item.swatch.style.background = renderer.css(item.layer.color)
  try {
    localStorage.setItem('dwg-viewer-theme', name)
  } catch {
    // storage unavailable (private window or file:// restrictions)
  }
}

function initialTheme() {
  try {
    const saved = localStorage.getItem('dwg-viewer-theme')
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    // ignore
  }
  return 'dark'
}

// ---- loading --------------------------------------------------------------

let wasmPromise = null
function loadWasm() {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const b64 = $('wasm-gz').textContent.trim()
      const binary = atob(b64)
      const packed = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) packed[i] = binary.charCodeAt(i)
      const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))
      return new Response(stream).arrayBuffer()
    })()
  }
  return wasmPromise
}

let workerUrl = null
function createWorker() {
  if (!workerUrl) {
    workerUrl = URL.createObjectURL(new Blob([$('worker-src').textContent], { type: 'text/javascript' }))
  }
  return new Worker(workerUrl)
}

function show(id, on) {
  $(id).hidden = !on
}

function setBusy(name, stage) {
  $('busy-name').textContent = name
  $('busy-stage').textContent = stage
  show('busy', true)
  show('welcome', false)
  show('error', false)
}

function showError(message) {
  show('busy', false)
  show('welcome', false)
  $('error-text').textContent = message
  show('error', true)
}

async function openFile(file) {
  if (!file) return
  const job = ++state.job
  if (state.worker) state.worker.terminate()
  state.worker = null
  setBusy(file.name, 'Reading file')
  try {
    const [bytes, wasm] = await Promise.all([file.arrayBuffer(), loadWasm()])
    if (job !== state.job) return
    const worker = createWorker()
    state.worker = worker
    worker.onmessage = event => {
      if (job !== state.job) return
      const msg = event.data
      if (msg.type === 'progress') {
        $('busy-stage').textContent = msg.stage
      } else if (msg.type === 'scene') {
        worker.terminate()
        state.worker = null
        showScene(msg.scene, file.name)
      } else if (msg.type === 'error') {
        worker.terminate()
        state.worker = null
        showError(msg.message)
      }
    }
    worker.onerror = event => {
      if (job !== state.job) return
      showError(event.message || 'The file reader stopped unexpectedly.')
    }
    const wasmCopy = wasm.slice(0)
    worker.postMessage({ name: file.name, file: bytes, wasm: wasmCopy }, [bytes, wasmCopy])
  } catch (err) {
    if (job === state.job) showError(err && err.message ? err.message : String(err))
  }
}

function showScene(scene, name) {
  state.scene = scene
  state.fileName = name
  show('busy', false)
  show('error', false)
  show('welcome', false)
  setTool('select')
  renderer.setScene(scene)

  $('file-name').textContent = name
  const total = scene.spaces.reduce((n, s) => n + s.ents.type.length, 0)
  const parts = [scene.meta.format + (scene.meta.release ? ' ' + scene.meta.release : ''), total.toLocaleString('en-US') + ' objects']
  $('file-meta').textContent = parts.join(' · ')
  show('file', true)
  show('tools', true)
  document.title = name + ' – DWG Viewer'

  buildLayers()
  buildTabs()
  setSidebar(window.innerWidth > 720)
  updateNotes()
  clearSelection()
  renderer.resize()
  renderer.fit()

  if (!scene.spaces.some(s => s.fit)) {
    showError('The file was read, but it contains nothing this viewer can draw' +
      (Object.keys(scene.meta.unsupported).length ? ' (' + describeUnsupported() + ').' : '.'))
  }
}

function describeUnsupported() {
  return Object.entries(state.scene.meta.unsupported).map(([k, v]) => `${v.toLocaleString('en-US')} ${k}`).join(', ')
}

function updateNotes() {
  const el = $('notes')
  el.textContent = ''
  const scene = state.scene
  if (!scene) return
  const bits = []
  const skipped = describeUnsupported()
  if (skipped) bits.push('Not shown: ' + skipped)
  if (scene.meta.errors) bits.push(scene.meta.errors + ' objects could not be converted')
  if (scene.meta.damaged) bits.push('The file has errors, so parts of it may be missing')
  el.textContent = bits.join(' · ')
  el.title = bits.join('\n')
  const space = renderer.space
  if (space && space.fit && space.extents && String(space.fit) !== String(space.extents)) {
    if (bits.length) el.append(' · ')
    el.append('Some objects lie far from the drawing. ')
    const btn = document.createElement('button')
    btn.textContent = 'Show everything'
    btn.onclick = () => renderer.fit(space.extents)
    el.append(btn)
  }
}

// ---- layers ---------------------------------------------------------------

function buildLayers() {
  const list = $('layer-list')
  list.textContent = ''
  state.layerItems = []
  const layers = state.scene.layers
  const order = layers.map((l, i) => i).sort((a, b) =>
    layers[a].name.localeCompare(layers[b].name, undefined, { numeric: true, sensitivity: 'base' }))
  for (const index of order) {
    const layer = layers[index]
    const li = document.createElement('li')
    const label = document.createElement('label')
    label.title = layer.name + '\nDouble-click to show only this layer'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = !!renderer.layerVisible[index]
    box.dataset.index = index
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    swatch.style.background = renderer.css(layer.color)
    const nameEl = document.createElement('span')
    nameEl.className = 'layer-name'
    nameEl.textContent = layer.name
    const count = document.createElement('span')
    count.className = 'layer-n'
    count.textContent = layer.count ? layer.count.toLocaleString('en-US') : ''
    label.append(box, swatch, nameEl, count)
    li.append(label)
    li.classList.toggle('off', !box.checked)
    list.append(li)
    state.layerItems.push({ index, layer, li, box, swatch })
  }
  $('layer-filter').value = ''
  updateLayerCount()
}

function updateLayerCount() {
  const on = state.layerItems.filter(i => i.box.checked).length
  $('layer-count').textContent = `${on} of ${state.layerItems.length} on`
}

function setLayers(fn) {
  const filter = $('layer-filter').value.trim().toLowerCase()
  for (const item of state.layerItems) {
    // Bulk actions only touch layers matching the current filter.
    if (filter && !item.layer.name.toLowerCase().includes(filter)) continue
    const on = fn(item)
    item.box.checked = on
    item.li.classList.toggle('off', !on)
    renderer.layerVisible[item.index] = on ? 1 : 0
  }
  updateLayerCount()
  renderer.requestRender()
}

function isolateLayer(index) {
  $('layer-filter').value = ''
  filterLayers()
  setLayers(item => item.index === index)
}

function filterLayers() {
  const filter = $('layer-filter').value.trim().toLowerCase()
  let shown = 0
  for (const item of state.layerItems) {
    const match = !filter || item.layer.name.toLowerCase().includes(filter)
    item.li.hidden = !match
    if (match) shown++
  }
  let note = $('layer-list').querySelector('.empty-note')
  if (!shown && state.layerItems.length) {
    if (!note) {
      note = document.createElement('li')
      note.className = 'empty-note'
      $('layer-list').append(note)
    }
    note.textContent = 'No layers match the filter.'
  } else if (note) {
    note.remove()
  }
}

function setSidebar(on) {
  show('side', on && !!state.scene)
  $('btn-layers').setAttribute('aria-pressed', String(on))
  renderer.resize()
}

// ---- layout tabs ----------------------------------------------------------

function buildTabs() {
  const tabs = $('tabs')
  tabs.textContent = ''
  state.scene.spaces.forEach((space, index) => {
    const btn = document.createElement('button')
    btn.className = 'tab'
    btn.setAttribute('role', 'tab')
    btn.textContent = space.name
    btn.setAttribute('aria-selected', String(index === renderer.spaceIndex))
    btn.onclick = () => {
      renderer.setSpace(index)
      for (const el of tabs.children) el.setAttribute('aria-selected', String(el === btn))
      clearSelection()
      if (state.tool === 'measure') resetMeasure()
      updateNotes()
    }
    tabs.append(btn)
  })
}

// ---- selection ------------------------------------------------------------

function clearSelection() {
  renderer.selection = null
  show('info', false)
  renderer.requestRender()
}

function select(hit) {
  if (!hit) {
    clearSelection()
    return
  }
  renderer.selection = hit
  const ents = renderer.space.ents
  const type = ents.type[hit.ent]
  const layer = state.scene.layers[ents.layer[hit.ent]]
  $('info-title').textContent = TYPE_NAMES[type] || type
  const rows = [['Layer', layer ? layer.name : '']]
  if (ents.info[hit.ent]) rows.push([INFO_LABELS[type] || 'Name', ents.info[hit.ent]])
  if (hit.length != null && hit.length > 0 && type !== 'INSERT' && type !== 'DIMENSION') {
    rows.push([type === 'CIRCLE' ? 'Circumference' : 'Length', withUnits(formatNumber(hit.length))])
  }
  if (ents.handle[hit.ent]) rows.push(['Handle', ents.handle[hit.ent]])
  const dl = $('info-rows')
  dl.textContent = ''
  for (const [k, v] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = k
    const dd = document.createElement('dd')
    dd.textContent = v.length > 300 ? v.slice(0, 300) + '…' : v
    dl.append(dt, dd)
  }
  show('info', true)
  renderer.requestRender()
}

function selectionBounds() {
  const sel = renderer.selection
  const space = renderer.space
  if (!sel || !space) return null
  const out = [Infinity, Infinity, -Infinity, -Infinity]
  const add = (box, i) => {
    const o = i * 4
    if (box[o] > box[o + 2]) return
    out[0] = Math.min(out[0], box[o])
    out[1] = Math.min(out[1], box[o + 1])
    out[2] = Math.max(out[2], box[o + 2])
    out[3] = Math.max(out[3], box[o + 3])
  }
  for (const item of sel.items) {
    if (item.kind === 'line') add(space.strokes[item.batch].box, item.index)
    else if (item.kind === 'arc') add(space.strokes[item.batch].arcBox, item.index)
    else if (item.kind === 'seg') add(space.strokes[item.batch].segBox, item.index)
    else if (item.kind === 'fill') add(space.fills[item.batch].box, item.index)
    else if (item.kind === 'text') add(space.text.box, item.index)
  }
  return isFinite(out[0]) ? out : null
}

// ---- measuring ------------------------------------------------------------

function setTool(tool) {
  state.tool = tool
  canvas.classList.toggle('measuring', tool === 'measure')
  $('btn-measure').setAttribute('aria-pressed', String(tool === 'measure'))
  if (tool === 'measure') {
    clearSelection()
    resetMeasure()
  } else {
    renderer.measure = null
    show('measure', false)
    renderer.requestRender()
  }
}

function resetMeasure() {
  renderer.measure = { a: null, b: null, hover: null }
  updateMeasureReadout()
  renderer.requestRender()
}

function measurePoint(px, py) {
  const snapped = renderer.snap(px, py)
  return { point: snapped || renderer.toWorld(px, py), snapped: !!snapped }
}

function updateMeasureReadout() {
  const el = $('measure')
  const m = renderer.measure
  if (!m) {
    show('measure', false)
    return
  }
  el.textContent = ''
  const end = m.b || m.hover
  if (m.a && end) {
    const dx = end[0] - m.a[0]
    const dy = end[1] - m.a[1]
    const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
    const b = document.createElement('b')
    b.textContent = withUnits(formatNumber(Math.hypot(dx, dy)))
    el.append(b)
    for (const text of [`\u0394X ${formatNumber(dx)}`, `\u0394Y ${formatNumber(dy)}`, `Angle ${formatNumber(angle, 5)}\u00b0`]) {
      const span = document.createElement('span')
      span.textContent = text
      el.append(span)
    }
  } else {
    const hint = document.createElement('span')
    hint.textContent = m.a ? 'Click the second point' : 'Click the first point – snaps to ends, corners and centres. Esc to finish.'
    el.append(hint)
  }
  show('measure', true)
}

function measureClick(px, py) {
  const m = renderer.measure
  const { point, snapped } = measurePoint(px, py)
  if (!m.a || m.b) {
    renderer.measure = { a: point, aSnapped: snapped, b: null, hover: null }
  } else {
    m.b = point
    m.bSnapped = snapped
  }
  updateMeasureReadout()
  renderer.requestRender()
}

// ---- pointer input --------------------------------------------------------

const pointers = new Map()
let drag = null
let pinch = null

const localPos = e => {
  const r = canvas.getBoundingClientRect()
  return [e.clientX - r.left, e.clientY - r.top]
}

function updateCoords(px, py) {
  if (!renderer.space) return
  const [x, y] = renderer.toWorld(px, py)
  $('coords').textContent = withUnits(`X ${formatCoord(x)}   Y ${formatCoord(y)}`)
}

canvas.addEventListener('pointerdown', e => {
  if (!renderer.space) return
  canvas.setPointerCapture(e.pointerId)
  const [x, y] = localPos(e)
  pointers.set(e.pointerId, [x, y])
  if (pointers.size === 1) {
    drag = { x, y, startX: x, startY: y, moved: false }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 }
    if (drag) drag.moved = true
  }
})

canvas.addEventListener('pointermove', e => {
  const [x, y] = localPos(e)
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [x, y])
  if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()]
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1])
    const cx = (a[0] + b[0]) / 2
    const cy = (a[1] + b[1]) / 2
    renderer.panBy(cx - pinch.cx, cy - pinch.cy)
    if (pinch.dist > 0 && dist > 0) renderer.zoomAt(cx, cy, dist / pinch.dist)
    pinch = { dist, cx, cy }
    return
  }
  if (drag && pointers.size === 1) {
    if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) > 4) {
      drag.moved = true
      canvas.classList.add('panning')
    }
    if (drag.moved) renderer.panBy(x - drag.x, y - drag.y)
    drag.x = x
    drag.y = y
  } else if (state.tool === 'measure' && renderer.measure && !renderer.measure.b) {
    const { point, snapped } = measurePoint(x, y)
    renderer.measure.hover = point
    renderer.measure.hoverSnapped = snapped
    updateMeasureReadout()
    renderer.requestRender()
  }
  updateCoords(x, y)
})

function endPointer(e) {
  const had = pointers.delete(e.pointerId)
  if (pointers.size < 2) pinch = null
  if (!had || pointers.size) return
  canvas.classList.remove('panning')
  const d = drag
  drag = null
  if (!d || d.moved || e.type === 'pointercancel' || !renderer.space) return
  const [x, y] = localPos(e)
  if (state.tool === 'measure') measureClick(x, y)
  else select(renderer.pick(x, y, e.pointerType === 'touch' ? 14 : 6))
}
canvas.addEventListener('pointerup', endPointer)
canvas.addEventListener('pointercancel', endPointer)
canvas.addEventListener('pointerleave', () => {
  if (!pointers.size) $('coords').textContent = ''
})

canvas.addEventListener('wheel', e => {
  if (!renderer.space) return
  e.preventDefault()
  const [x, y] = localPos(e)
  let delta = e.deltaY
  if (e.deltaMode === 1) delta *= 32
  else if (e.deltaMode === 2) delta *= 400
  // Pinch gestures on trackpads arrive as ctrl+wheel with small deltas.
  const factor = Math.exp(-delta * (e.ctrlKey ? 0.012 : 0.0018))
  renderer.zoomAt(x, y, Math.min(4, Math.max(0.25, factor)))
  updateCoords(x, y)
}, { passive: false })

canvas.addEventListener('dblclick', e => {
  if (state.tool === 'select' && renderer.space) renderer.fit()
  e.preventDefault()
})

// ---- commands -------------------------------------------------------------

function exportPng() {
  if (!renderer.space) return
  renderer.render()
  canvas.toBlob(blob => {
    if (!blob) return
    const a = document.createElement('a')
    const base = state.fileName.replace(/\.[^.]+$/, '') || 'drawing'
    const suffix = state.scene.spaces.length > 1 ? '-' + renderer.space.name.replace(/[^\w.-]+/g, '_') : ''
    a.download = base + suffix + '.png'
    a.href = URL.createObjectURL(blob)
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }, 'image/png')
}

const pickFile = () => $('file-input').click()

$('btn-open').onclick = pickFile
$('btn-browse').onclick = pickFile
$('btn-retry').onclick = pickFile
$('file-input').onchange = e => {
  openFile(e.target.files[0])
  e.target.value = ''
}
$('btn-fit').onclick = e => renderer.fit(e.shiftKey ? renderer.space?.extents : undefined)
$('btn-measure').onclick = () => setTool(state.tool === 'measure' ? 'select' : 'measure')
$('btn-layers').onclick = () => setSidebar($('side').hidden)
$('btn-export').onclick = exportPng
$('btn-theme').onclick = () => applyTheme(renderer.theme === 'dark' ? 'light' : 'dark')

$('layers-all').onclick = () => setLayers(() => true)
$('layers-none').onclick = () => setLayers(() => false)
$('layers-invert').onclick = () => setLayers(item => !item.box.checked)
$('layer-filter').oninput = filterLayers
$('layer-list').addEventListener('change', e => {
  const index = Number(e.target.dataset.index)
  const item = state.layerItems.find(i => i.index === index)
  if (!item) return
  renderer.layerVisible[index] = e.target.checked ? 1 : 0
  item.li.classList.toggle('off', !e.target.checked)
  updateLayerCount()
  renderer.requestRender()
})
$('layer-list').addEventListener('dblclick', e => {
  const box = e.target.closest('label')?.querySelector('input')
  if (box) isolateLayer(Number(box.dataset.index))
})

$('info-close').onclick = clearSelection
$('info-zoom').onclick = () => {
  const box = selectionBounds()
  if (box) renderer.fit(box)
}
const selectedLayer = () => (renderer.selection ? renderer.space.ents.layer[renderer.selection.ent] : -1)
$('info-isolate').onclick = () => {
  const layer = selectedLayer()
  if (layer >= 0) isolateLayer(layer)
}
$('info-hide').onclick = () => {
  const layer = selectedLayer()
  if (layer < 0) return
  $('layer-filter').value = ''
  filterLayers()
  setLayers(item => (item.index === layer ? false : item.box.checked))
  clearSelection()
}

window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) {
    if (e.key === 'Escape') e.target.blur()
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const key = e.key.toLowerCase()
  if (key === 'o') pickFile()
  else if (key === 'b') applyTheme(renderer.theme === 'dark' ? 'light' : 'dark')
  else if (!renderer.space) return
  else if (key === 'f' || key === 'home') renderer.fit(e.shiftKey ? renderer.space.extents : undefined)
  else if (key === 'm') setTool(state.tool === 'measure' ? 'select' : 'measure')
  else if (key === 'l') setSidebar($('side').hidden)
  else if (key === 'escape') {
    if (state.tool === 'measure') setTool('select')
    else clearSelection()
  } else if (key === '+' || key === '=') zoomCentre(1.4)
  else if (key === '-' || key === '_') zoomCentre(1 / 1.4)
  else if (key === 'arrowleft') renderer.panBy(80, 0)
  else if (key === 'arrowright') renderer.panBy(-80, 0)
  else if (key === 'arrowup') renderer.panBy(0, 80)
  else if (key === 'arrowdown') renderer.panBy(0, -80)
  else return
  e.preventDefault()
})

function zoomCentre(factor) {
  const r = canvas.getBoundingClientRect()
  renderer.zoomAt(r.width / 2, r.height / 2, factor)
}

// ---- drag and drop --------------------------------------------------------

let dragDepth = 0
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files')
window.addEventListener('dragenter', e => {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  show('drop', true)
})
window.addEventListener('dragover', e => {
  if (hasFiles(e)) e.preventDefault()
})
window.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) show('drop', false)
})
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  show('drop', false)
  openFile(e.dataTransfer.files[0])
})

// ---- start ----------------------------------------------------------------

new ResizeObserver(() => renderer.resize()).observe($('stage'))
applyTheme(initialTheme())
renderer.resize()

// Hooks for automated tests.
window.dwgViewer = { renderer, state, openFile, FOREGROUND }
