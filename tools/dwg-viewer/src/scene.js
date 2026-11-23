// Turns a parsed DwgDatabase into flat, render-ready geometry.
//
// Every space (model space and each paper-space layout) becomes a set of
// batches keyed by layer / colour / width / dash pattern, holding typed
// arrays of polylines, analytic arcs, hatch line groups and filled polygons,
// plus text and construction-line lists. Blocks are expanded in place, so the
// renderer never needs to know about INSERTs.
//
// This module has no DOM or WASM dependencies and runs in a worker or in Node.

import { aciToColor, FOREGROUND } from './aci.js'
import {
  IDENTITY, TAU, mul, translate, scale, rotate, scaleOf, ocsMatrix,
  bulgeArc, bulgePoints, ellipsePoints, arcBounds, nurbsPoints, fitPointsCurve
} from './geom.js'
import {
  decodeMText, decodePlainText, estimateWidth, repairFusedAscii, wrapLine
} from './text.js'

const MAX_DEPTH = 24
const MAX_ARRAY_INSTANCES = 20000
const MAX_HATCH_SEGMENTS = 40000
const MAX_HATCH_LINES = 6000
const PATTERN_FALLBACK_ALPHA = 0.22

const UNIT_NAMES = {
  1: 'in', 2: 'ft', 3: 'mi', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 8: 'µin',
  9: 'mil', 10: 'yd', 11: 'Å', 12: 'nm', 13: 'µm', 14: 'dm', 15: 'dam',
  16: 'hm', 17: 'Gm', 18: 'AU', 19: 'ly', 20: 'pc'
}

// Entity types that carry no 2D geometry we can show.
const UNSUPPORTED_LABELS = {
  '3DSOLID': '3D solids', REGION: 'regions', BODY: 'bodies', SURFACE: 'surfaces',
  OLE2FRAME: 'OLE objects', OLEFRAME: 'OLE objects', ACAD_PROXY_ENTITY: 'proxy objects',
  SHAPE: 'shapes', SECTION: 'section objects', ARCALIGNEDTEXT: 'arc-aligned text'
}

const lower = s => (s || '').toLowerCase()
const applyPoint = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

function applyPoints(m, pts) {
  if (m === IDENTITY) return pts
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i]
    const y = pts[i + 1]
    pts[i] = m[0] * x + m[2] * y + m[4]
    pts[i + 1] = m[1] * x + m[3] * y + m[5]
  }
  return pts
}

class SpaceBuilder {
  constructor(name) {
    this.name = name
    this.strokes = new Map()
    this.fills = new Map()
    this.text = { geom: [], meta: [], str: [], width: [] }
    this.rays = { geom: [], meta: [] }
    this.ents = { type: [], handle: [], layer: [], info: [] }
    this.viewports = []
    this.entIds = new Map()
  }

  addEnt(type, handle, layer, info) {
    const e = this.ents
    e.type.push(type)
    e.handle.push(handle || '')
    e.layer.push(layer)
    e.info.push(info || '')
    return e.type.length - 1
  }

  stroke(layer, color, width, dash) {
    const key = layer + '|' + color + '|' + width + '|' + dash
    let b = this.strokes.get(key)
    if (!b) {
      b = {
        layer, color, width, dash,
        pts: [], starts: [0], ent: [],
        arcs: [], arcEnt: [],
        segs: [], segStarts: [0], segEnt: [], segSpacing: []
      }
      this.strokes.set(key, b)
    }
    return b
  }

  fill(layer, color, alpha) {
    const key = layer + '|' + color + '|' + alpha
    let b = this.fills.get(key)
    if (!b) {
      b = { layer, color, alpha, pts: [], ringStarts: [0], polyStarts: [0], ent: [] }
      this.fills.set(key, b)
    }
    return b
  }

  polyline(batch, pts, ent) {
    if (pts.length < 2) return
    const dst = batch.pts
    for (let i = 0; i < pts.length; i++) dst.push(pts[i])
    if (pts.length === 2) dst.push(pts[0], pts[1]) // a point: zero-length segment
    batch.starts.push(dst.length / 2)
    batch.ent.push(ent)
  }

  /** Arc c + u*cos(t) + v*sin(t), t in [a0, a1], given in local coordinates. */
  arc(batch, m, cx, cy, ux, uy, vx, vy, a0, a1, ent) {
    batch.arcs.push(
      m[0] * cx + m[2] * cy + m[4], m[1] * cx + m[3] * cy + m[5],
      m[0] * ux + m[2] * uy, m[1] * ux + m[3] * uy,
      m[0] * vx + m[2] * vy, m[1] * vx + m[3] * vy,
      a0, a1
    )
    batch.arcEnt.push(ent)
  }

  segments(batch, segs, spacing, ent) {
    if (!segs.length) return
    const dst = batch.segs
    for (let i = 0; i < segs.length; i++) dst.push(segs[i])
    batch.segStarts.push(dst.length / 4)
    batch.segEnt.push(ent)
    batch.segSpacing.push(spacing)
  }

  polygon(batch, rings, ent) {
    let any = false
    for (const ring of rings) {
      if (ring.length < 6) continue
      for (let i = 0; i < ring.length; i++) batch.pts.push(ring[i])
      batch.ringStarts.push(batch.pts.length / 2)
      any = true
    }
    if (!any) return
    batch.polyStarts.push(batch.ringStarts.length - 1)
    batch.ent.push(ent)
  }

  addText(layer, color, x, y, a, b, c, d, str, ha, va, font, ent) {
    if (!str || !isFinite(x + y + a + b + c + d)) return
    const t = this.text
    t.geom.push(x, y, a, b, c, d)
    t.meta.push(layer, color, ha | (va << 2) | (font << 4), ent)
    t.str.push(str)
    t.width.push(estimateWidth(str))
  }
}

function boxOfPoints(pts, from, to, out, o) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = from; i < to; i += 2) {
    const x = pts[i]
    const y = pts[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (isFinite(minX + minY + maxX + maxY)) {
    out[o] = minX
    out[o + 1] = minY
    out[o + 2] = maxX
    out[o + 3] = maxY
  } else {
    // Never intersects anything: hides primitives with broken coordinates.
    out[o] = 1
    out[o + 1] = 1
    out[o + 2] = 0
    out[o + 3] = 0
  }
}

/** Local-space text box in cap-height units: [x0, y0, x1, y1]. */
export function textLocalBox(width, ha, va) {
  const x0 = ha === 0 ? 0 : ha === 1 ? -width / 2 : -width
  const y0 = va === 0 ? -0.3 : va === 1 ? 0 : va === 2 ? -0.65 : -1.3
  return [x0, y0, x0 + width, y0 + 1.5]
}

function finalizeSpace(sb) {
  const boxes = []
  const strokes = []
  for (const b of sb.strokes.values()) {
    const n = b.ent.length
    const pts = Float64Array.from(b.pts)
    const starts = Uint32Array.from(b.starts)
    const box = new Float64Array(n * 4)
    for (let i = 0; i < n; i++) boxOfPoints(pts, starts[i] * 2, starts[i + 1] * 2, box, i * 4)
    const m = b.arcEnt.length
    const arcs = Float64Array.from(b.arcs)
    const arcBox = new Float64Array(m * 4)
    for (let i = 0; i < m; i++) {
      const o = i * 8
      arcBounds(arcs[o], arcs[o + 1], arcs[o + 2], arcs[o + 3], arcs[o + 4], arcs[o + 5], arcs[o + 6], arcs[o + 7], arcBox, i * 4)
      if (!isFinite(arcBox[i * 4] + arcBox[i * 4 + 1] + arcBox[i * 4 + 2] + arcBox[i * 4 + 3])) {
        arcBox.set([1, 1, 0, 0], i * 4)
      }
    }
    const g = b.segEnt.length
    const segs = Float64Array.from(b.segs)
    const segStarts = Uint32Array.from(b.segStarts)
    const segBox = new Float64Array(g * 4)
    for (let i = 0; i < g; i++) boxOfPoints(segs, segStarts[i] * 4, segStarts[i + 1] * 4, segBox, i * 4)
    strokes.push({
      layer: b.layer, color: b.color, width: b.width, dash: b.dash,
      pts, starts, ent: Uint32Array.from(b.ent), box,
      arcs, arcEnt: Uint32Array.from(b.arcEnt), arcBox,
      segs, segStarts, segEnt: Uint32Array.from(b.segEnt), segBox,
      segSpacing: Float64Array.from(b.segSpacing)
    })
    boxes.push(box, arcBox, segBox)
  }

  const fills = []
  for (const b of sb.fills.values()) {
    const n = b.ent.length
    const pts = Float64Array.from(b.pts)
    const ringStarts = Uint32Array.from(b.ringStarts)
    const polyStarts = Uint32Array.from(b.polyStarts)
    const box = new Float64Array(n * 4)
    for (let i = 0; i < n; i++) {
      boxOfPoints(pts, ringStarts[polyStarts[i]] * 2, ringStarts[polyStarts[i + 1]] * 2, box, i * 4)
    }
    fills.push({ layer: b.layer, color: b.color, alpha: b.alpha, pts, ringStarts, polyStarts, ent: Uint32Array.from(b.ent), box })
    boxes.push(box)
  }

  const t = sb.text
  const count = t.str.length
  const geom = Float64Array.from(t.geom)
  const meta = Int32Array.from(t.meta)
  const width = Float32Array.from(t.width)
  const tbox = new Float64Array(count * 4)
  const corners = new Array(8)
  for (let i = 0; i < count; i++) {
    const o = i * 6
    const flags = meta[i * 4 + 2]
    const [x0, y0, x1, y1] = textLocalBox(width[i], flags & 3, (flags >> 2) & 3)
    const local = [x0, y0, x1, y0, x1, y1, x0, y1]
    for (let k = 0; k < 8; k += 2) {
      corners[k] = geom[o] + geom[o + 2] * local[k] + geom[o + 4] * local[k + 1]
      corners[k + 1] = geom[o + 1] + geom[o + 3] * local[k] + geom[o + 5] * local[k + 1]
    }
    boxOfPoints(corners, 0, 8, tbox, i * 4)
  }
  boxes.push(tbox)

  const { extents, fit } = computeExtents(boxes)
  return {
    name: sb.name,
    strokes, fills,
    text: { geom, meta, str: t.str, width, box: tbox },
    rays: { geom: Float64Array.from(sb.rays.geom), meta: Int32Array.from(sb.rays.meta) },
    ents: {
      type: sb.ents.type,
      handle: sb.ents.handle,
      layer: Int32Array.from(sb.ents.layer),
      info: sb.ents.info
    },
    viewports: sb.viewports,
    extents, fit
  }
}

/**
 * `extents` is the box around everything. `fit` ignores stray primitives
 * lying far outside the main body of the drawing (a common leftover in real
 * files) so that "zoom to fit" lands on something useful.
 */
function computeExtents(boxes) {
  let total = 0
  for (const b of boxes) total += b.length / 4
  const full = [Infinity, Infinity, -Infinity, -Infinity]
  const step = Math.max(1, Math.floor(total / 200000))
  const xs = []
  const ys = []
  let idx = 0
  for (const b of boxes) {
    for (let i = 0; i < b.length; i += 4, idx++) {
      if (b[i] > b[i + 2]) continue
      if (b[i] < full[0]) full[0] = b[i]
      if (b[i + 1] < full[1]) full[1] = b[i + 1]
      if (b[i + 2] > full[2]) full[2] = b[i + 2]
      if (b[i + 3] > full[3]) full[3] = b[i + 3]
      if (idx % step === 0) {
        xs.push((b[i] + b[i + 2]) / 2)
        ys.push((b[i + 1] + b[i + 3]) / 2)
      }
    }
  }
  if (!isFinite(full[0])) return { extents: null, fit: null }
  if (xs.length < 20) return { extents: full, fit: full }

  xs.sort((a, b) => a - b)
  ys.sort((a, b) => a - b)
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))]
  const core = [q(xs, 0.005), q(ys, 0.005), q(xs, 0.995), q(ys, 0.995)]
  const size = Math.max(core[2] - core[0], core[3] - core[1])
  if (!(size > 0)) return { extents: full, fit: full }
  const reach = size * 5
  const limit = [core[0] - reach, core[1] - reach, core[2] + reach, core[3] + reach]
  if (full[0] >= limit[0] && full[1] >= limit[1] && full[2] <= limit[2] && full[3] <= limit[3]) {
    return { extents: full, fit: full }
  }
  const fit = [Infinity, Infinity, -Infinity, -Infinity]
  for (const b of boxes) {
    for (let i = 0; i < b.length; i += 4) {
      if (b[i] > b[i + 2]) continue
      if (b[i] < limit[0] || b[i + 1] < limit[1] || b[i + 2] > limit[2] || b[i + 3] > limit[3]) continue
      if (b[i] < fit[0]) fit[0] = b[i]
      if (b[i + 1] < fit[1]) fit[1] = b[i + 1]
      if (b[i + 2] > fit[2]) fit[2] = b[i + 2]
      if (b[i + 3] > fit[3]) fit[3] = b[i + 3]
    }
  }
  return { extents: full, fit: isFinite(fit[0]) ? fit : full }
}

/** List the transferable buffers of a finished scene. */
export function sceneTransferables(scene) {
  const out = []
  for (const sp of scene.spaces) {
    for (const b of sp.strokes) {
      out.push(b.pts.buffer, b.starts.buffer, b.ent.buffer, b.box.buffer, b.arcs.buffer, b.arcEnt.buffer,
        b.arcBox.buffer, b.segs.buffer, b.segStarts.buffer, b.segEnt.buffer, b.segBox.buffer, b.segSpacing.buffer)
    }
    for (const b of sp.fills) {
      out.push(b.pts.buffer, b.ringStarts.buffer, b.polyStarts.buffer, b.ent.buffer, b.box.buffer)
    }
    out.push(sp.text.geom.buffer, sp.text.meta.buffer, sp.text.width.buffer, sp.text.box.buffer,
      sp.rays.geom.buffer, sp.rays.meta.buffer, sp.ents.layer.buffer)
  }
  return out
}

/**
 * Clip hatch pattern lines to a set of boundary rings (even-odd rule).
 * Returns { segs, spacing } or null when the pattern would be too dense.
 */
function hatchPatternSegments(rings, defLines) {
  const segs = []
  let minSpacing = Infinity
  const xs = []
  for (const def of defLines) {
    const dx = Math.cos(def.angle)
    const dy = Math.sin(def.angle)
    const nx = -dy
    const ny = dx
    const ox = def.offset?.x || 0
    const oy = def.offset?.y || 0
    const spacing = ox * nx + oy * ny
    if (Math.abs(spacing) < 1e-9) continue
    const shift = ox * dx + oy * dy
    const bx = def.base?.x || 0
    const by = def.base?.y || 0
    const dashes = (def.dashLengths || []).filter(v => isFinite(v))
    let period = 0
    for (const v of dashes) period += Math.abs(v)
    const dashed = dashes.length > 1 && period > 1e-9

    let tMin = Infinity
    let tMax = -Infinity
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const t = (ring[i] - bx) * nx + (ring[i + 1] - by) * ny
        if (t < tMin) tMin = t
        if (t > tMax) tMax = t
      }
    }
    const k0 = Math.ceil(Math.min(tMin / spacing, tMax / spacing))
    const k1 = Math.floor(Math.max(tMin / spacing, tMax / spacing))
    if (k1 - k0 > MAX_HATCH_LINES) return null
    minSpacing = Math.min(minSpacing, Math.abs(spacing))

    for (let k = k0; k <= k1; k++) {
      const t = k * spacing
      xs.length = 0
      for (const ring of rings) {
        const n = ring.length
        let px = ring[n - 2]
        let py = ring[n - 1]
        let pt = (px - bx) * nx + (py - by) * ny
        for (let i = 0; i < n; i += 2) {
          const qx = ring[i]
          const qy = ring[i + 1]
          const qt = (qx - bx) * nx + (qy - by) * ny
          if ((pt <= t) !== (qt <= t)) {
            const f = (t - pt) / (qt - pt)
            xs.push((px + (qx - px) * f - bx) * dx + (py + (qy - py) * f - by) * dy)
          }
          px = qx
          py = qy
          pt = qt
        }
      }
      if (xs.length < 2) continue
      xs.sort((a, b) => a - b)
      const ox0 = bx + nx * t
      const oy0 = by + ny * t
      for (let j = 0; j + 1 < xs.length; j += 2) {
        const sa = xs[j]
        const sb = xs[j + 1]
        if (!dashed) {
          segs.push(ox0 + dx * sa, oy0 + dy * sa, ox0 + dx * sb, oy0 + dy * sb)
        } else {
          const origin = k * shift
          let pos = origin + Math.floor((sa - origin) / period) * period
          let guard = 0
          while (pos < sb && guard++ < 100000) {
            for (const dlen of dashes) {
              const len = Math.abs(dlen)
              if (dlen >= 0) {
                const a = Math.max(pos, sa)
                const b = Math.min(pos + len, sb)
                if (b >= a) segs.push(ox0 + dx * a, oy0 + dy * a, ox0 + dx * b, oy0 + dy * b)
              }
              pos += len
              if (pos >= sb) break
            }
            if (segs.length > MAX_HATCH_SEGMENTS * 4) return null
          }
        }
        if (segs.length > MAX_HATCH_SEGMENTS * 4) return null
      }
    }
  }
  return { segs, spacing: isFinite(minSpacing) ? minSpacing : 0 }
}

export function buildScene(db, options = {}) {
  const isDxf = !!options.isDxf
  const header = db.header || {}
  const ltScale = header.LTSCALE > 0 ? header.LTSCALE : 1

  // ---- layers -----------------------------------------------------------
  const layers = []
  const layerByName = new Map()
  const layerByHandle = new Map()
  const addLayer = (name, entry) => {
    const ci = entry ? entry.colorIndex : 7
    let color
    if (entry && ci === 256 && entry.color != null && entry.color !== 0xffffff) color = entry.color & 0xffffff
    else color = aciToColor(Math.abs(ci))
    const layer = {
      name,
      color,
      visible: entry ? !(entry.off || entry.frozen || ci < 0) : true,
      frozen: !!entry?.frozen,
      locked: !!entry?.locked,
      lineType: entry?.lineType || 'Continuous',
      count: 0
    }
    layers.push(layer)
    layerByName.set(lower(name), layers.length - 1)
    if (entry?.handle) layerByHandle.set(String(entry.handle).toUpperCase(), layers.length - 1)
    return layers.length - 1
  }
  for (const entry of db.tables?.LAYER?.entries || []) addLayer(entry.name, entry)
  if (!layerByName.has('0')) addLayer('0', null)
  const layerZero = layerByName.get('0')
  const layerIndex = name => {
    const idx = layerByName.get(lower(name))
    return idx === undefined ? addLayer(name || '0', null) : idx
  }

  // ---- linetypes --------------------------------------------------------
  const ltypes = new Map()
  for (const lt of db.tables?.LTYPE?.entries || []) {
    const pattern = (lt.pattern || []).map(p => p.elementLength).filter(v => isFinite(v))
    if (pattern.length >= 2 && pattern.some(v => v < 0)) ltypes.set(lower(lt.name), pattern)
  }
  const dashes = [null]
  const dashIds = new Map()
  const dashId = (name, factor) => {
    const pattern = ltypes.get(lower(name))
    if (!pattern || !(factor > 0)) return 0
    const scaled = pattern.map(v => Number((Math.abs(v) * factor).toPrecision(5)))
    // Canvas dash arrays alternate on/off starting with "on".
    const arr = []
    for (let i = 0; i < pattern.length; i++) {
      const on = pattern[i] >= 0
      if ((arr.length % 2 === 0) === on) arr.push(scaled[i])
      else if (arr.length) arr[arr.length - 1] += scaled[i]
      else arr.push(0, scaled[i])
    }
    if (arr.length % 2) arr.push(0)
    const key = arr.join(',')
    let id = dashIds.get(key)
    if (id === undefined) {
      id = dashes.length
      dashes.push(arr)
      dashIds.set(key, id)
    }
    return id
  }

  // ---- text styles ------------------------------------------------------
  const styles = new Map()
  for (const st of db.tables?.STYLE?.entries || []) {
    const font = lower(st.font)
    let family = 0
    if (/times|roman[^s]|serif|georgia|cambria|song|sim?sun|mincho|ming/.test(font) && !/sans/.test(font)) family = 1
    else if (/cour|mono|consol|lucida con/.test(font)) family = 2
    styles.set(lower(st.name), {
      family,
      widthFactor: st.widthFactor > 0 ? st.widthFactor : 1,
      height: st.fixedTextHeight > 0 ? st.fixedTextHeight : 0
    })
  }
  const styleOf = name => styles.get(lower(name)) || { family: 0, widthFactor: 1, height: 0 }

  // ---- blocks -----------------------------------------------------------
  const blocksByName = new Map()
  const blocksByHandle = new Map()
  for (const br of db.tables?.BLOCK_RECORD?.entries || []) {
    blocksByName.set(lower(br.name), br)
    if (br.handle) blocksByHandle.set(String(br.handle).toUpperCase(), br)
  }

  const unsupported = {}
  let errors = 0
  const splineCache = new WeakMap()
  const arrowSize = (header.DIMASZ > 0 ? header.DIMASZ : 0.18) * (header.DIMSCALE > 0 ? header.DIMSCALE : 1)

  // ---- style resolution -------------------------------------------------
  const effLayer = (e, ctx) => {
    if (ctx.depth > 0 && (e.layer === '0' || !e.layer)) return ctx.layer
    return layerIndex(e.layer)
  }
  const resolveColor = (e, ctx, layer) => {
    if (e.color != null) return e.color & 0xffffff
    const ci = e.colorIndex
    if (ci === 0) return ctx.color
    if (ci == null || ci >= 256 || ci < 0) return layers[layer].color
    return aciToColor(ci)
  }
  const resolveLtype = (e, ctx, layer) => {
    const name = lower(e.lineType)
    if (!name || name === 'bylayer') return layers[layer].lineType
    if (name === 'byblock') return ctx.ltype
    return e.lineType
  }
  const strokeFor = (S, ctx, e, width = 0) => {
    const layer = effLayer(e, ctx)
    const color = resolveColor(e, ctx, layer)
    const lt = resolveLtype(e, ctx, layer)
    const dash = ltypes.size ? dashId(lt, ltScale * (e.lineTypeScale > 0 ? e.lineTypeScale : 1) * ctx.scale) : 0
    const w = width > 0 ? Number((width * ctx.scale).toPrecision(4)) : 0
    return S.stroke(layer, color, w, dash)
  }
  const fillFor = (S, ctx, e, alpha = 1) => {
    const layer = effLayer(e, ctx)
    return S.fill(layer, resolveColor(e, ctx, layer), alpha)
  }
  const withOcs = (ctx, normal, elevation) => {
    const ocs = ocsMatrix(normal, elevation || 0)
    return ocs ? mul(ctx.m, ocs) : ctx.m
  }

  // ---- entity emitters --------------------------------------------------
  function emitPolyline(S, ctx, e, verts, closed, m, defStart, defEnd) {
    const n = verts.length
    if (!n) return
    if (n === 1) {
      S.polyline(strokeFor(S, ctx, e), applyPoints(m, [verts[0].x, verts[0].y]), ctx.ent)
      return
    }
    const segCount = closed ? n : n - 1
    const sw = i => (verts[i].startWidth > 0 ? verts[i].startWidth : defStart)
    const ew = i => (verts[i].endWidth > 0 ? verts[i].endWidth : defEnd)
    let uniform = true
    const w0 = sw(0)
    for (let i = 0; i < segCount && uniform; i++) {
      if (sw(i) !== w0 || ew(i) !== w0) uniform = false
    }
    const batches = new Map()
    const batchFor = w => {
      let b = batches.get(w)
      if (!b) batches.set(w, (b = strokeFor(S, ctx, e, w)))
      return b
    }
    let run = []
    let runBatch = null
    const flush = () => {
      if (run.length >= 4) S.polyline(runBatch, applyPoints(m, run), ctx.ent)
      run = []
    }
    for (let i = 0; i < segCount; i++) {
      const a = verts[i]
      const b = verts[(i + 1) % n]
      const ws = uniform ? w0 : sw(i)
      const we = uniform ? w0 : ew(i)
      const bulge = a.bulge
      if (bulge && isFinite(bulge) && Math.abs(bulge) > 1e-9) {
        flush()
        const arc = bulgeArc(a.x, a.y, b.x, b.y, bulge)
        if (isFinite(arc.r)) {
          S.arc(batchFor((ws + we) / 2), m, arc.cx, arc.cy, arc.r, 0, 0, arc.r, arc.a0, arc.a1, ctx.ent)
        }
        continue
      }
      if (!uniform && (ws > 0 || we > 0) && ws !== we) {
        // Tapered straight segment (typically an arrowhead): fill a quad.
        flush()
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.hypot(dx, dy)
        if (len > 0) {
          const px = -dy / len / 2
          const py = dx / len / 2
          const quad = [
            a.x + px * ws, a.y + py * ws, b.x + px * we, b.y + py * we,
            b.x - px * we, b.y - py * we, a.x - px * ws, a.y - py * ws
          ]
          S.polygon(fillFor(S, ctx, e), [applyPoints(m, quad)], ctx.ent)
        }
        continue
      }
      const batch = batchFor(ws)
      if (batch !== runBatch || !run.length) {
        flush()
        runBatch = batch
        run.push(a.x, a.y)
      }
      run.push(b.x, b.y)
    }
    flush()
  }

  function emitText(S, ctx, e, t, str) {
    str = decodePlainText(str)
    if (!str || !str.trim()) return
    const style = styleOf(t.styleName)
    let h = t.textHeight > 0 ? t.textHeight : style.height || header.TEXTSIZE || 1
    let wf = t.xScale > 0 ? t.xScale : style.widthFactor
    const m = withOcs(ctx, t.extrusionDirection, t.elevation)
    const start = t.startPoint || { x: 0, y: 0 }
    const end = t.endPoint || { x: 0, y: 0 }
    let rot = t.rotation || 0
    let ha = 0
    let va = 0
    let p = start
    const hAlign = t.halign || 0
    const vAlign = t.valign || 0
    if (hAlign === 3 || hAlign === 5) {
      const dist = Math.hypot(end.x - start.x, end.y - start.y)
      const est = estimateWidth(str)
      if (dist > 0 && est > 0) {
        rot = Math.atan2(end.y - start.y, end.x - start.x)
        if (hAlign === 5) wf = dist / (est * h)
        else h = dist / (est * wf)
      }
    } else if (hAlign !== 0 || vAlign !== 0) {
      p = end
      if (hAlign === 4) {
        ha = 1
        va = 2
      } else {
        ha = Math.min(hAlign, 2)
        va = vAlign
      }
    }
    const gen = t.generationFlag || 0
    const sx = (gen & 2 ? -1 : 1) * wf * h
    const sy = (gen & 4 ? -1 : 1) * h
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const layer = effLayer(e, ctx)
    const [x, y] = applyPoint(m, p.x, p.y)
    S.addText(
      layer, resolveColor(e, ctx, layer), x, y,
      m[0] * c * sx + m[2] * s * sx, m[1] * c * sx + m[3] * s * sx,
      m[0] * -s * sy + m[2] * c * sy, m[1] * -s * sy + m[3] * c * sy,
      str, ha, va, style.family, ctx.ent
    )
  }

  /** Multi-line text block; `dir` is the world-space reading direction. */
  function emitParagraph(S, ctx, e, opts) {
    const { x, y, h, text, attachment, rectWidth, styleName, normal } = opts
    if (!(h > 0)) return
    const style = styleOf(styleName)
    let lines = decodeMText(text)
    if (rectWidth > 0) {
      const max = (rectWidth / (h * style.widthFactor)) * 1.12
      lines = lines.flatMap(l => wrapLine(l, max))
    }
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop()
    if (!lines.some(l => l.trim())) return
    const ap = attachment >= 1 && attachment <= 9 ? attachment : 1
    const ha = (ap - 1) % 3
    const row = Math.floor((ap - 1) / 3)
    const spacing = h * (5 / 3) * (opts.lineSpacing > 0 ? opts.lineSpacing : 1)
    const total = (lines.length - 1) * spacing + h
    const first = row === 0 ? -h : row === 1 ? total / 2 - h : total - h

    let dx = opts.dirX
    let dy = opts.dirY
    const dl = Math.hypot(dx, dy)
    if (!(dl > 0)) {
      dx = Math.cos(opts.rotation || 0)
      dy = Math.sin(opts.rotation || 0)
    } else {
      dx /= dl
      dy /= dl
    }
    // up = N x dir, so a flipped normal mirrors the text.
    const flip = normal && normal.z < 0 ? -1 : 1
    const ux = -dy * flip
    const uy = dx * flip
    const m = ctx.m
    const layer = effLayer(e, ctx)
    const color = resolveColor(e, ctx, layer)
    const wf = style.widthFactor
    const ax = (m[0] * dx + m[2] * dy) * h * wf
    const ay = (m[1] * dx + m[3] * dy) * h * wf
    const cx = (m[0] * ux + m[2] * uy) * h
    const cy = (m[1] * ux + m[3] * uy) * h
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue
      const off = first - i * spacing
      const [px, py] = applyPoint(m, x + ux * off, y + uy * off)
      S.addText(layer, color, px, py, ax, ay, cx, cy, lines[i], ha, 0, style.family, ctx.ent)
    }
  }

  function emitArrow(S, ctx, e, tipX, tipY, fromX, fromY, size, m) {
    const dx = fromX - tipX
    const dy = fromY - tipY
    const len = Math.hypot(dx, dy)
    if (!(len > 0) || !(size > 0)) return
    const s = Math.min(size, len / 2)
    const ux = dx / len
    const uy = dy / len
    const tri = [
      tipX, tipY,
      tipX + ux * s - uy * s / 6, tipY + uy * s + ux * s / 6,
      tipX + ux * s + uy * s / 6, tipY + uy * s - ux * s / 6
    ]
    S.polygon(fillFor(S, ctx, e), [applyPoints(m, tri)], ctx.ent)
  }

  function hatchRings(e) {
    const rings = []
    for (const path of e.boundaryPaths || []) {
      const ring = []
      if (path.vertices) {
        const v = path.vertices
        const n = v.length
        if (!n) continue
        ring.push(v[0].x, v[0].y)
        const segs = path.isClosed === false ? n - 1 : n
        for (let i = 0; i < segs; i++) {
          const a = v[i]
          const b = v[(i + 1) % n]
          bulgePoints(a.x, a.y, b.x, b.y, a.bulge, ring)
        }
      } else {
        for (const edge of path.edges || []) {
          if (edge.type === 1) {
            if (!ring.length) ring.push(edge.start.x, edge.start.y)
            ring.push(edge.end.x, edge.end.y)
          } else if (edge.type === 2) {
            let a0 = edge.startAngle
            let a1 = edge.endAngle
            if (edge.isCCW === false) {
              a0 = -a0
              a1 = -a1
              if (a1 > a0) a1 -= TAU
            } else if (a1 < a0) a1 += TAU
            ellipsePoints(edge.center.x, edge.center.y, edge.radius, 0, 0, edge.radius, a0, a1, ring)
          } else if (edge.type === 3) {
            const ux = edge.end.x
            const uy = edge.end.y
            const ratio = edge.lengthOfMinorAxis
            let a0 = edge.startAngle
            let a1 = edge.endAngle
            if (edge.isCCW === false) {
              a0 = -a0
              a1 = -a1
              if (a1 > a0) a1 -= TAU
            } else if (a1 < a0) a1 += TAU
            ellipsePoints(edge.center.x, edge.center.y, ux, uy, -uy * ratio, ux * ratio, a0, a1, ring)
          } else if (edge.type === 4) {
            const pts = edge.controlPoints?.length > 1
              ? nurbsPoints(edge.degree, edge.knots, edge.controlPoints, edge.controlPoints.map(c => c.weight || 1), false)
              : fitPointsCurve(edge.fitDatum || [], false)
            for (const v of pts) ring.push(v)
          }
        }
      }
      if (ring.length >= 6) rings.push(ring)
    }
    return rings
  }

  function insertBlock(S, ctx, e, block, m) {
    if (!block || ctx.depth >= MAX_DEPTH || ctx.stack.includes(block)) return
    const layer = effLayer(e, ctx)
    const child = {
      m,
      scale: scaleOf(m),
      layer,
      color: resolveColor(e, ctx, layer),
      ltype: resolveLtype(e, ctx, layer),
      depth: ctx.depth + 1,
      ent: ctx.ent,
      stack: ctx.stack.concat(block)
    }
    for (const be of block.entities) processEntity(S, child, be)
  }

  function processEntity(S, ctx, e) {
    if (e.isVisible === false) return
    switch (e.type) {
      case 'LINE': {
        const a = e.startPoint
        const b = e.endPoint
        S.polyline(strokeFor(S, ctx, e), applyPoints(ctx.m, [a.x, a.y, b.x, b.y]), ctx.ent)
        break
      }
      case 'POINT': {
        const p = e.position
        S.polyline(strokeFor(S, ctx, e), applyPoints(ctx.m, [p.x, p.y]), ctx.ent)
        break
      }
      case 'CIRCLE':
      case 'ARC': {
        const m = withOcs(ctx, e.extrusionDirection, e.center.z)
        let a0 = 0
        let a1 = TAU
        if (e.type === 'ARC') {
          a0 = e.startAngle
          a1 = e.endAngle
          if (a1 <= a0) a1 += Math.ceil((a0 - a1) / TAU + 1e-12) * TAU
        }
        S.arc(strokeFor(S, ctx, e), m, e.center.x, e.center.y, e.radius, 0, 0, e.radius, a0, a1, ctx.ent)
        break
      }
      case 'ELLIPSE': {
        const ux = e.majorAxisEndPoint.x
        const uy = e.majorAxisEndPoint.y
        const n = e.extrusionDirection
        const flip = n && n.z < 0 ? -1 : 1
        const ratio = e.axisRatio
        let a0 = e.startAngle || 0
        let a1 = e.endAngle == null ? TAU : e.endAngle
        if (a1 <= a0) a1 += TAU
        S.arc(strokeFor(S, ctx, e), ctx.m, e.center.x, e.center.y, ux, uy, -uy * ratio * flip, ux * ratio * flip, a0, a1, ctx.ent)
        break
      }
      case 'LWPOLYLINE': {
        const closed = !!(e.flag & 512) || (isDxf && !!(e.flag & 1))
        const m = withOcs(ctx, e.extrusionDirection, e.elevation)
        const cw = e.constantWidth > 0 ? e.constantWidth : 0
        emitPolyline(S, ctx, e, e.vertices || [], closed, m, cw, cw)
        break
      }
      case 'POLYLINE2D': {
        const splineFit = !!(e.flag & 4)
        const verts = (e.vertices || []).filter(v => !(splineFit && v.flag & 16))
        const m = withOcs(ctx, e.extrusionDirection, e.elevation)
        emitPolyline(S, ctx, e, verts, !!(e.flag & 1), m, e.startWidth || 0, e.endWidth || 0)
        break
      }
      case 'POLYLINE3D': {
        const splineFit = !!(e.flag & 4)
        const pts = []
        for (const v of e.vertices || []) {
          if (splineFit && v.flag & 16) continue
          pts.push(v.x, v.y)
        }
        if (e.flag & 1 && pts.length >= 4) pts.push(pts[0], pts[1])
        S.polyline(strokeFor(S, ctx, e), applyPoints(ctx.m, pts), ctx.ent)
        break
      }
      case 'SPLINE': {
        let pts = splineCache.get(e)
        if (!pts) {
          const closed = !!(e.flag & 1)
          if (e.controlPoints?.length > 1) {
            pts = nurbsPoints(e.degree, e.knots, e.controlPoints, e.weights, false)
          } else {
            pts = fitPointsCurve(e.fitPoints || [], closed)
          }
          splineCache.set(e, pts)
        }
        S.polyline(strokeFor(S, ctx, e), applyPoints(ctx.m, pts.slice()), ctx.ent)
        break
      }
      case 'TEXT':
        emitText(S, ctx, e, e, e.text)
        break
      case 'ATTDEF':
        // Inside a block only constant attribute definitions are drawn; the
        // rest are replaced by the ATTRIBs attached to each INSERT.
        if (ctx.depth === 0 || e.flags & 2) {
          if (!(e.flags & 1)) emitText(S, ctx, e, e.text || {}, e.text?.text || e.tag)
        }
        break
      case 'ATTRIB':
        break // drawn with the owning INSERT
      case 'MTEXT': {
        const p = e.insertionPoint
        emitParagraph(S, ctx, e, {
          x: p.x, y: p.y, h: e.textHeight, text: e.text, attachment: e.attachmentPoint,
          rectWidth: e.rectWidth, styleName: e.styleName, normal: e.extrusionDirection,
          dirX: e.direction?.x || 0, dirY: e.direction?.y || 0, rotation: e.rotation,
          lineSpacing: e.lineSpacing
        })
        break
      }
      case 'TOLERANCE': {
        const p = e.insertionPoint
        const h = header.DIMTXT > 0 ? header.DIMTXT * (header.DIMSCALE > 0 ? header.DIMSCALE : 1) : header.TEXTSIZE || 1
        emitParagraph(S, ctx, e, {
          x: p.x, y: p.y, h, text: (e.text || '').replace(/%%v/gi, ' | '), attachment: 4,
          dirX: e.xAxisDirection?.x || 0, dirY: e.xAxisDirection?.y || 0, normal: e.extrusionDirection
        })
        break
      }
      case 'INSERT': {
        const block = blocksByName.get(lower(e.name))
        if (block) {
          const ins = e.insertionPoint
          const base = block.basePoint || { x: 0, y: 0 }
          const xs = e.xScale || 1
          const ys = e.yScale || 1
          const cols = Math.max(1, e.columnCount | 0)
          const rows = Math.max(1, e.rowCount | 0)
          const outer = mul(mul(withOcs(ctx, e.extrusionDirection, ins.z), translate(ins.x, ins.y)), rotate(e.rotation || 0))
          const inner = mul(scale(xs, ys), translate(-base.x, -base.y))
          if (rows * cols === 1) {
            insertBlock(S, ctx, e, block, mul(outer, inner))
          } else if (rows * cols <= MAX_ARRAY_INSTANCES) {
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                insertBlock(S, ctx, e, block, mul(mul(outer, translate(c * (e.columnSpacing || 0), r * (e.rowSpacing || 0))), inner))
              }
            }
          }
        }
        for (const at of e.attribs || []) {
          if (at.isVisible === false || at.flags & 1) continue
          emitText(S, ctx, at, at.text || {}, at.text?.text)
        }
        break
      }
      case 'DIMENSION': {
        const block = blocksByName.get(lower(e.name))
        if (!block) {
          unsupported['dimensions without geometry'] = (unsupported['dimensions without geometry'] || 0) + 1
          break
        }
        const ip = e.insertionPoint || { x: 0, y: 0 }
        insertBlock(S, ctx, e, block, mul(withOcs(ctx, e.extrusionDirection, 0), translate(ip.x || 0, ip.y || 0)))
        break
      }
      case 'ACAD_TABLE': {
        const block = blocksByHandle.get(String(e.blockRecordHandle || '').toUpperCase()) || blocksByName.get(lower(e.name))
        if (!block) {
          unsupported.tables = (unsupported.tables || 0) + 1
          break
        }
        const p = e.startPoint
        const d = e.directionVector || { x: 1, y: 0 }
        insertBlock(S, ctx, e, block, mul(mul(ctx.m, translate(p.x, p.y)), rotate(Math.atan2(d.y || 0, d.x || 1))))
        break
      }
      case 'HATCH': {
        const rings = hatchRings(e)
        if (!rings.length) break
        const m = withOcs(ctx, e.extrusionDirection, 0)
        if (e.solidFill || !e.definitionLines?.length) {
          S.polygon(fillFor(S, ctx, e, e.solidFill ? 1 : PATTERN_FALLBACK_ALPHA), rings.map(r => applyPoints(m, r)), ctx.ent)
        } else {
          const pattern = hatchPatternSegments(rings, e.definitionLines)
          if (pattern && pattern.segs.length) {
            S.segments(S.stroke(effLayer(e, ctx), resolveColor(e, ctx, effLayer(e, ctx)), 0, 0),
              applyPoints(m, pattern.segs), pattern.spacing * scaleOf(m), ctx.ent)
          } else if (!pattern) {
            S.polygon(fillFor(S, ctx, e, PATTERN_FALLBACK_ALPHA), rings.map(r => applyPoints(m, r)), ctx.ent)
          }
        }
        break
      }
      case 'SOLID':
      case 'TRACE': {
        const m = withOcs(ctx, e.extrusionDirection, 0)
        const c = [e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3]
        S.polygon(fillFor(S, ctx, e), [applyPoints(m, c.flatMap(p => [p.x, p.y]))], ctx.ent)
        break
      }
      case '3DFACE': {
        const c = [e.corner1, e.corner2, e.corner3, e.corner4 || e.corner3, e.corner1]
        S.polyline(strokeFor(S, ctx, e), applyPoints(ctx.m, c.flatMap(p => [p.x, p.y])), ctx.ent)
        break
      }
      case 'LEADER': {
        const v = e.vertices || []
        if (v.length < 2) break
        const m = ctx.m
        const pts = e.isSpline && v.length > 2 ? fitPointsCurve(v, false) : v.flatMap(p => [p.x, p.y])
        S.polyline(strokeFor(S, ctx, e), applyPoints(m, pts), ctx.ent)
        if (e.isArrowheadEnabled) emitArrow(S, ctx, e, v[0].x, v[0].y, v[1].x, v[1].y, arrowSize, m)
        break
      }
      case 'MULTILEADER': {
        const m = ctx.m
        const batch = strokeFor(S, ctx, e)
        const size = (e.arrowheadSize || 0) * (e.contentScale > 0 ? e.contentScale : 1)
        for (const section of e.leaderSections || []) {
          const last = section.lastLeaderLinePointSet === false ? null : section.lastLeaderLinePoint
          for (const line of section.leaderLines || []) {
            const v = line.vertices || []
            if (!v.length) continue
            const pts = v.flatMap(p => [p.x, p.y])
            if (last) pts.push(last.x, last.y)
            if (pts.length < 4) continue
            emitArrow(S, ctx, e, pts[0], pts[1], pts[2], pts[3], size, m)
            S.polyline(batch, applyPoints(m, pts), ctx.ent)
          }
          if (last && e.doglegEnabled && section.doglegVector && section.doglegLength > 0) {
            const d = section.doglegVector
            const len = section.doglegLength * (e.contentScale > 0 ? e.contentScale : 1)
            S.polyline(batch, applyPoints(m, [last.x, last.y, last.x + d.x * len, last.y + d.y * len]), ctx.ent)
          }
        }
        if (e.hasMText !== false && e.textContent && e.textAnchor) {
          emitParagraph(S, ctx, e, {
            x: e.textAnchor.x, y: e.textAnchor.y, h: e.textHeight, text: repairFusedAscii(e.textContent),
            attachment: e.textAttachmentPoint || 1, rectWidth: 0, normal: e.normal,
            dirX: e.textDirection?.x || 0, dirY: e.textDirection?.y || 0, rotation: e.textRotation
          })
        }
        const bc = e.blockContent
        if (bc?.blockContentId && bc.position) {
          const block = blocksByHandle.get(String(bc.blockContentId).toUpperCase())
          if (block) {
            const s = bc.scale || { x: 1, y: 1 }
            insertBlock(S, ctx, e, block, mul(mul(mul(m, translate(bc.position.x, bc.position.y)), rotate(bc.rotation || 0)), scale(s.x || 1, s.y || 1)))
          }
        }
        break
      }
      case 'MLINE': {
        const v = e.vertices || []
        if (v.length < 2) break
        const m = withOcs(ctx, e.extrusionDirection, 0)
        const batch = strokeFor(S, ctx, e)
        const count = Math.max(1, e.numberOfLines || v[0].lines?.length || 1)
        for (let li = 0; li < count; li++) {
          const pts = []
          for (const vert of v) {
            const off = vert.lines?.[li]?.segmentParams?.[0] || 0
            pts.push(vert.vertex.x + (vert.miterDirection?.x || 0) * off, vert.vertex.y + (vert.miterDirection?.y || 0) * off)
          }
          if (e.flags & 2) pts.push(pts[0], pts[1])
          S.polyline(batch, applyPoints(m, pts), ctx.ent)
        }
        break
      }
      case 'IMAGE': {
        // The raster itself lives in an external file; show its frame.
        const p = e.position
        const w = e.imageSize?.x || 0
        const h = e.imageSize?.y || 0
        const u = e.uPixel
        const v = e.vPixel
        if (!(w > 0 && h > 0) || !u || !v) break
        const cx = [p.x, p.x + u.x * w, p.x + u.x * w + v.x * h, p.x + v.x * h]
        const cy = [p.y, p.y + u.y * w, p.y + u.y * w + v.y * h, p.y + v.y * h]
        const batch = strokeFor(S, ctx, e)
        S.polyline(batch, applyPoints(ctx.m, [cx[0], cy[0], cx[1], cy[1], cx[2], cy[2], cx[3], cy[3], cx[0], cy[0]]), ctx.ent)
        S.polyline(batch, applyPoints(ctx.m, [cx[0], cy[0], cx[2], cy[2]]), ctx.ent)
        S.polyline(batch, applyPoints(ctx.m, [cx[1], cy[1], cx[3], cy[3]]), ctx.ent)
        unsupported['raster images (frame only)'] = (unsupported['raster images (frame only)'] || 0) + 1
        break
      }
      case 'XLINE':
      case 'RAY': {
        const p = e.firstPoint
        const d = e.unitDirection
        if (!p || !d) break
        const m = ctx.m
        const [x, y] = applyPoint(m, p.x, p.y)
        const layer = effLayer(e, ctx)
        S.rays.geom.push(x, y, m[0] * d.x + m[2] * d.y, m[1] * d.x + m[3] * d.y, e.type === 'RAY' ? 1 : 0)
        S.rays.meta.push(layer, resolveColor(e, ctx, layer), ctx.ent)
        break
      }
      case 'WIPEOUT':
      case 'VIEWPORT':
        break
      default: {
        const label = UNSUPPORTED_LABELS[e.type] || lower(e.type) + ' entities'
        unsupported[label] = (unsupported[label] || 0) + 1
      }
    }
  }

  function entityInfo(e) {
    switch (e.type) {
      case 'INSERT': return e.name || ''
      case 'TEXT': return decodePlainText(e.text || '')
      case 'MTEXT': return decodeMText(e.text || '').join(' ').trim()
      case 'ATTDEF': return e.tag || ''
      case 'DIMENSION': return e.text && e.text !== '<>' ? decodeMText(e.text).join(' ') : isFinite(e.measurement) ? String(Number(e.measurement.toPrecision(10))) : ''
      case 'HATCH': return e.solidFill ? 'SOLID' : e.patternName || ''
      default: return ''
    }
  }

  function buildSpace(name, entities) {
    const S = new SpaceBuilder(name)
    for (const e of entities || []) {
      if (!e || e.type === 'ATTRIB') continue
      const layer = layerIndex(e.layer)
      layers[layer].count++
      const ent = S.addEnt(e.type, e.handle, layer, entityInfo(e))
      if (e.type === 'VIEWPORT') S.entIds.set(e, ent)
      const ctx = { m: IDENTITY, scale: 1, layer: layerZero, color: FOREGROUND, ltype: 'Continuous', depth: 0, ent, stack: [] }
      try {
        processEntity(S, ctx, e)
      } catch (err) {
        errors++
      }
    }
    return S
  }

  // ---- spaces -----------------------------------------------------------
  const spaces = [finalizeSpace(buildSpace('Model', db.entities))]

  const layouts = (db.objects?.LAYOUT || [])
    .filter(l => lower(l.layoutName) !== 'model')
    .sort((a, b) => (a.tabOrder || 0) - (b.tabOrder || 0))
  for (const layout of layouts) {
    const block = blocksByHandle.get(String(layout.paperSpaceTableId || '').toUpperCase())
    if (!block || !block.entities?.length) continue
    const S = buildSpace(layout.layoutName || block.name, block.entities)
    // The first viewport of a layout is the sheet itself, not a model view.
    const vps = block.entities.filter(e => e.type === 'VIEWPORT').slice(1)
    for (const vp of vps) {
      if (vp.isVisible === false || !(vp.width > 0) || !(vp.height > 0) || !(vp.viewHeight > 0)) continue
      const c = vp.viewportCenter
      const layer = layerIndex(vp.layer)
      const color = resolveColor(vp, { color: FOREGROUND }, layer)
      const hw = vp.width / 2
      const hh = vp.height / 2
      S.polyline(S.stroke(layer, color, 0, 0), [c.x - hw, c.y - hh, c.x + hw, c.y - hh, c.x + hw, c.y + hh, c.x - hw, c.y + hh, c.x - hw, c.y - hh], S.entIds.get(vp) || 0)
      if (vp.statusBitFlags & 0x20000) continue
      const dir = vp.viewDirection
      if (dir && Math.abs(dir.z) < 0.999 * Math.hypot(dir.x, dir.y, dir.z)) {
        unsupported['3D viewports'] = (unsupported['3D viewports'] || 0) + 1
        continue
      }
      const k = vp.height / vp.viewHeight
      const target = vp.targetPoint || { x: 0, y: 0 }
      const dc = vp.displayCenter || { x: 0, y: 0 }
      // paper = centre + k * (R(twist) * (world - target) - displayCentre)
      const model = mul(
        mul(translate(c.x, c.y), scale(k, k)),
        mul(translate(-dc.x, -dc.y), mul(rotate(vp.viewTwistAngle || 0), translate(-target.x, -target.y)))
      )
      S.viewports.push({
        x0: c.x - hw, y0: c.y - hh, x1: c.x + hw, y1: c.y + hh,
        m: model,
        frozen: (vp.frozenLayerIds || []).map(h => layerByHandle.get(String(h).toUpperCase())).filter(i => i !== undefined)
      })
    }
    const space = finalizeSpace(S)
    if (space.extents) spaces.push(space)
  }

  const counts = {}
  for (const sp of spaces) for (const t of sp.ents.type) counts[t] = (counts[t] || 0) + 1

  return {
    layers,
    dashes,
    spaces,
    meta: {
      version: header.ACADVER || '',
      units: UNIT_NAMES[header.INSUNITS] || '',
      counts,
      unsupported,
      errors
    }
  }
}
