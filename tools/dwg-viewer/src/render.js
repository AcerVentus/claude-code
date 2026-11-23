// Canvas 2D renderer for scenes produced by scene.js.
//
// All geometry is kept in world coordinates as doubles and projected to
// device pixels in JavaScript each frame. That keeps lines crisp and exact at
// any zoom level (canvas transforms are single precision and fall apart on
// drawings with large coordinates), and lets every primitive be culled and
// simplified against the current view.

import { FOREGROUND } from './aci.js'
import { TAU, invert, mul } from './geom.js'
import { textLocalBox } from './scene.js'

const FONT_PX = 100
const CAP_RATIO = 0.72 // cap height / em for the fallback fonts
const FONTS = [
  `${FONT_PX}px "Helvetica Neue", Arial, "Liberation Sans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`,
  `${FONT_PX}px Georgia, "Times New Roman", "Noto Serif CJK SC", SimSun, serif`,
  `${FONT_PX}px Consolas, "DejaVu Sans Mono", "Courier New", monospace`
]
const BIG_ARC_PX = 3000
const PATH_CHUNK = 6000

export const THEMES = {
  dark: { bg: '#1c2025', fg: '#f2f4f6', highlight: '#ff9f1a', measure: '#5ad1ff' },
  light: { bg: '#ffffff', fg: '#101214', highlight: '#e8590c', measure: '#0b6bcb' }
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: false })
    this.scene = null
    this.space = null
    this.spaceIndex = 0
    this.layerVisible = new Uint8Array(0)
    this.view = { x: 0, y: 0, k: 1 }
    this.views = []
    this.theme = 'dark'
    this.selection = null
    this.measure = null
    this.dpr = 1
    this.lastDrawMs = 0
    this.onAfterRender = null
    this._colorCache = new Map()
    this._raf = 0
    this._settle = 0
    this._snapshot = null
  }

  // ---- state ------------------------------------------------------------
  setScene(scene) {
    this.scene = scene
    this.selection = null
    this.measure = null
    this.views = scene ? scene.spaces.map(() => null) : []
    this.layerVisible = scene ? Uint8Array.from(scene.layers, l => (l.visible ? 1 : 0)) : new Uint8Array(0)
    this.space = null
    this._snapshot = null
    if (scene) {
      let first = scene.spaces.findIndex(s => s.fit)
      if (first < 0) first = 0
      this.setSpace(first)
    } else {
      this.requestRender()
    }
  }

  setSpace(index) {
    if (!this.scene) return
    if (this.space) this.views[this.spaceIndex] = { ...this.view }
    this.spaceIndex = index
    this.space = this.scene.spaces[index]
    this.selection = null
    this.measure = null
    this._snapshot = null
    if (this.views[index]) {
      this.view = { ...this.views[index] }
      this.requestRender()
    } else {
      this.fit()
    }
  }

  setTheme(name) {
    this.theme = name
    this._colorCache.clear()
    this._snapshot = null
    this.requestRender()
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const rect = this.canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (w !== this.canvas.width || h !== this.canvas.height || dpr !== this.dpr) {
      this.canvas.width = w
      this.canvas.height = h
      this.dpr = dpr
      this._snapshot = null
    }
    this.requestRender()
  }

  /** Zoom to a world box; defaults to the main body of the current space. */
  fit(box) {
    const b = box || this.space?.fit
    const w = this.canvas.width / this.dpr
    const h = this.canvas.height / this.dpr
    if (!b) {
      this.view = { x: 0, y: 0, k: 1 }
    } else {
      const bw = Math.max(b[2] - b[0], 1e-9)
      const bh = Math.max(b[3] - b[1], 1e-9)
      const pad = Math.min(48, Math.min(w, h) * 0.08)
      let k = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)
      if (!isFinite(k) || k <= 0) k = 1
      if (b[2] - b[0] <= 0 && b[3] - b[1] <= 0) k = 1
      this.view = { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, k }
    }
    this.requestRender()
  }

  // ---- coordinate helpers ----------------------------------------------
  /** World -> device pixel matrix for the current view. */
  matrix() {
    const s = this.view.k * this.dpr
    return [s, 0, 0, -s, this.canvas.width / 2 - this.view.x * s, this.canvas.height / 2 + this.view.y * s]
  }

  /** CSS pixel position (relative to the canvas) -> world. */
  toWorld(px, py) {
    const w = this.canvas.width / this.dpr
    const h = this.canvas.height / this.dpr
    return [this.view.x + (px - w / 2) / this.view.k, this.view.y - (py - h / 2) / this.view.k]
  }

  toScreen(x, y) {
    const w = this.canvas.width / this.dpr
    const h = this.canvas.height / this.dpr
    return [(x - this.view.x) * this.view.k + w / 2, -(y - this.view.y) * this.view.k + h / 2]
  }

  panBy(dx, dy) {
    this.view.x -= dx / this.view.k
    this.view.y += dy / this.view.k
    this.requestRender(true)
  }

  zoomAt(px, py, factor) {
    const [wx, wy] = this.toWorld(px, py)
    const k = Math.min(Math.max(this.view.k * factor, 1e-12), 1e12)
    const w = this.canvas.width / this.dpr
    const h = this.canvas.height / this.dpr
    this.view.k = k
    this.view.x = wx - (px - w / 2) / k
    this.view.y = wy + (py - h / 2) / k
    this.requestRender(true)
  }

  // ---- scheduling -------------------------------------------------------
  /**
   * Redraw on the next frame. On heavy drawings, interactive redraws reuse
   * the previous frame as a stretched bitmap and the real redraw happens
   * once input settles.
   */
  requestRender(interactive = false) {
    if (interactive && this.lastDrawMs > 45 && this._snapshot) {
      clearTimeout(this._settle)
      this._settle = setTimeout(() => this.requestRender(), 140)
      this._preview = true
    } else {
      this._preview = false
    }
    if (this._raf) return
    this._raf = requestAnimationFrame(() => {
      this._raf = 0
      if (this._preview) this.drawPreview()
      else this.render()
    })
  }

  drawPreview() {
    const { ctx, canvas } = this
    const snap = this._snapshot
    const theme = THEMES[this.theme]
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = theme.bg
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const ratio = this.view.k / snap.view.k
    const [sx, sy] = this.toScreen(snap.view.x, snap.view.y)
    const w = canvas.width * ratio
    const h = canvas.height * ratio
    ctx.imageSmoothingEnabled = ratio < 1
    ctx.drawImage(snap.canvas, sx * this.dpr - w / 2, sy * this.dpr - h / 2, w, h)
    this.drawOverlays()
  }

  // ---- drawing ----------------------------------------------------------
  css(color) {
    let v = this._colorCache.get(color)
    if (v) return v
    const theme = THEMES[this.theme]
    if (color === FOREGROUND) {
      v = theme.fg
    } else {
      const r = (color >> 16) & 255
      const g = (color >> 8) & 255
      const b = color & 255
      // Keep near-background colours readable instead of invisible.
      if (this.theme === 'dark' && Math.max(r, g, b) < 0x30) v = theme.fg
      else if (this.theme === 'light' && Math.min(r, g, b) > 0xd8) v = theme.fg
      else v = '#' + (color & 0xffffff).toString(16).padStart(6, '0')
    }
    this._colorCache.set(color, v)
    return v
  }

  render() {
    const t0 = performance.now()
    const { ctx, canvas } = this
    const theme = THEMES[this.theme]
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.fillStyle = theme.bg
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (this.space) {
      const T = this.matrix()
      this.drawSpace(this.space, T, [0, 0, canvas.width, canvas.height], null, 0)
      this.lastDrawMs = performance.now() - t0
      if (this.lastDrawMs > 45) this.takeSnapshot()
      else this._snapshot = null
      this.drawOverlays()
    }
    if (this.onAfterRender) this.onAfterRender()
  }

  takeSnapshot() {
    let snap = this._snapshot
    if (!snap || snap.canvas.width !== this.canvas.width || snap.canvas.height !== this.canvas.height) {
      const c = document.createElement('canvas')
      c.width = this.canvas.width
      c.height = this.canvas.height
      snap = { canvas: c, view: null }
    }
    snap.canvas.getContext('2d', { alpha: false }).drawImage(this.canvas, 0, 0)
    snap.view = { ...this.view }
    this._snapshot = snap
  }

  /**
   * Draw one space with world->device matrix T, limited to the device
   * rectangle `rect`. `hidden` is an optional set of extra layers to skip.
   */
  drawSpace(space, T, rect, hidden, depth) {
    const { ctx } = this
    const inv = invert(T)
    if (!inv) return
    const ppu = Math.sqrt(Math.abs(T[0] * T[3] - T[1] * T[2]))
    // World-space bounds of the visible rectangle.
    let vx0 = Infinity, vy0 = Infinity, vx1 = -Infinity, vy1 = -Infinity
    for (const [px, py] of [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]]) {
      const x = inv[0] * px + inv[2] * py + inv[4]
      const y = inv[1] * px + inv[3] * py + inv[5]
      if (x < vx0) vx0 = x
      if (x > vx1) vx1 = x
      if (y < vy0) vy0 = y
      if (y > vy1) vy1 = y
    }
    const vis = this.layerVisible
    const shown = layer => vis[layer] && !(hidden && hidden.has(layer))
    const hair = this.dpr
    const dashes = this.scene.dashes
    const t0 = T[0], t1 = T[1], t2 = T[2], t3 = T[3], t4 = T[4], t5 = T[5]

    // Fills first so linework stays on top of solid hatches.
    for (const b of space.fills) {
      if (!shown(b.layer)) continue
      ctx.fillStyle = this.css(b.color)
      ctx.globalAlpha = b.alpha
      const { pts, ringStarts, polyStarts, box } = b
      for (let i = 0, n = b.ent.length; i < n; i++) {
        const o = i * 4
        if (box[o] > vx1 || box[o + 2] < vx0 || box[o + 1] > vy1 || box[o + 3] < vy0) continue
        if (Math.max(box[o + 2] - box[o], box[o + 3] - box[o + 1]) * ppu < 0.8) {
          ctx.fillRect(t0 * box[o] + t2 * box[o + 1] + t4, t1 * box[o] + t3 * box[o + 1] + t5, hair, hair)
          continue
        }
        ctx.beginPath()
        for (let r = polyStarts[i]; r < polyStarts[i + 1]; r++) {
          const from = ringStarts[r] * 2
          const to = ringStarts[r + 1] * 2
          ctx.moveTo(t0 * pts[from] + t2 * pts[from + 1] + t4, t1 * pts[from] + t3 * pts[from + 1] + t5)
          for (let j = from + 2; j < to; j += 2) {
            ctx.lineTo(t0 * pts[j] + t2 * pts[j + 1] + t4, t1 * pts[j] + t3 * pts[j + 1] + t5)
          }
          ctx.closePath()
        }
        ctx.fill('evenodd')
      }
    }
    ctx.globalAlpha = 1

    ctx.lineJoin = 'round'
    ctx.lineCap = 'butt'
    for (const b of space.strokes) {
      if (!shown(b.layer)) continue
      ctx.strokeStyle = this.css(b.color)
      ctx.lineWidth = Math.max(b.width * ppu, hair)
      let dash = null
      if (b.dash) {
        const pattern = dashes[b.dash]
        let period = 0
        for (const v of pattern) period += v
        if (period * ppu >= 5 * hair && period * ppu < 1e6) dash = pattern.map(v => Math.max(v * ppu, hair))
      }
      ctx.setLineDash(dash || [])
      ctx.beginPath()
      let budget = PATH_CHUNK
      const spend = n => {
        budget -= n
        if (budget <= 0) {
          ctx.stroke()
          ctx.beginPath()
          budget = PATH_CHUNK
        }
      }

      const { pts, starts, box } = b
      for (let i = 0, n = b.ent.length; i < n; i++) {
        const o = i * 4
        if (box[o] > vx1 || box[o + 2] < vx0 || box[o + 1] > vy1 || box[o + 3] < vy0) continue
        const from = starts[i] * 2
        const to = starts[i + 1] * 2
        let lx = t0 * pts[from] + t2 * pts[from + 1] + t4
        let ly = t1 * pts[from] + t3 * pts[from + 1] + t5
        ctx.moveTo(lx, ly)
        if (Math.max(box[o + 2] - box[o], box[o + 3] - box[o + 1]) * ppu < 0.6) {
          ctx.lineTo(lx + 0.6, ly)
          spend(2)
          continue
        }
        const last = to - 2
        for (let j = from + 2; j < to; j += 2) {
          const x = t0 * pts[j] + t2 * pts[j + 1] + t4
          const y = t1 * pts[j] + t3 * pts[j + 1] + t5
          if (j < last && Math.abs(x - lx) + Math.abs(y - ly) < 0.5) continue
          ctx.lineTo(x, y)
          lx = x
          ly = y
        }
        spend((to - from) / 2)
      }

      const { arcs, arcBox } = b
      for (let i = 0, n = b.arcEnt.length; i < n; i++) {
        const o = i * 4
        if (arcBox[o] > vx1 || arcBox[o + 2] < vx0 || arcBox[o + 1] > vy1 || arcBox[o + 3] < vy0) continue
        spend(this.arcPath(arcs, i * 8, T, rect, ctx.lineWidth))
      }

      const { segs, segStarts, segBox, segSpacing } = b
      for (let i = 0, n = b.segEnt.length; i < n; i++) {
        const o = i * 4
        if (segBox[o] > vx1 || segBox[o + 2] < vx0 || segBox[o + 1] > vy1 || segBox[o + 3] < vy0) continue
        // Thin out pattern lines that would be closer than about a pixel.
        const gap = segSpacing[i] * ppu
        const stride = gap > 0 && gap < 1.5 * hair ? Math.min(64, Math.ceil((1.5 * hair) / gap)) : 1
        for (let j = segStarts[i] * 4, end = segStarts[i + 1] * 4; j < end; j += 4 * stride) {
          const ax = segs[j], ay = segs[j + 1], bx = segs[j + 2], by = segs[j + 3]
          if ((ax > vx1 && bx > vx1) || (ax < vx0 && bx < vx0) || (ay > vy1 && by > vy1) || (ay < vy0 && by < vy0)) continue
          const x = t0 * ax + t2 * ay + t4
          const y = t1 * ax + t3 * ay + t5
          let x2 = t0 * bx + t2 * by + t4
          const y2 = t1 * bx + t3 * by + t5
          if (Math.abs(x2 - x) + Math.abs(y2 - y) < 0.5) x2 = x + 0.6
          ctx.moveTo(x, y)
          ctx.lineTo(x2, y2)
          spend(2)
        }
      }
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.lineWidth = hair

    // Construction lines and rays: infinite, so clipped to the view.
    const rays = space.rays
    for (let i = 0, n = rays.meta.length / 3; i < n; i++) {
      if (!shown(rays.meta[i * 3])) continue
      const o = i * 5
      const seg = clipRay(rays.geom[o], rays.geom[o + 1], rays.geom[o + 2], rays.geom[o + 3], rays.geom[o + 4] === 1, vx0, vy0, vx1, vy1)
      if (!seg) continue
      ctx.strokeStyle = this.css(rays.meta[i * 3 + 1])
      ctx.beginPath()
      ctx.moveTo(t0 * seg[0] + t2 * seg[1] + t4, t1 * seg[0] + t3 * seg[1] + t5)
      ctx.lineTo(t0 * seg[2] + t2 * seg[3] + t4, t1 * seg[2] + t3 * seg[3] + t5)
      ctx.stroke()
    }

    this.drawTexts(space, T, vx0, vy0, vx1, vy1, shown)

    // Model space seen through paper-space viewports.
    if (depth === 0 && space.viewports.length && this.scene.spaces[0] !== space) {
      for (const vp of space.viewports) {
        const xs = [t0 * vp.x0 + t2 * vp.y0 + t4, t0 * vp.x1 + t2 * vp.y1 + t4]
        const ys = [t1 * vp.x0 + t3 * vp.y0 + t5, t1 * vp.x1 + t3 * vp.y1 + t5]
        const r = [
          Math.max(rect[0], Math.min(xs[0], xs[1])), Math.max(rect[1], Math.min(ys[0], ys[1])),
          Math.min(rect[2], Math.max(xs[0], xs[1])), Math.min(rect[3], Math.max(ys[0], ys[1]))
        ]
        if (r[2] - r[0] < 1 || r[3] - r[1] < 1) continue
        ctx.save()
        ctx.beginPath()
        ctx.rect(r[0], r[1], r[2] - r[0], r[3] - r[1])
        ctx.clip()
        this.drawSpace(this.scene.spaces[0], mul(T, vp.m), r, vp.frozen.length ? new Set(vp.frozen) : null, depth + 1)
        ctx.restore()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
      }
    }
  }

  /** Add one arc to the current path; returns the number of vertices used. */
  arcPath(arcs, o, T, rect, lineWidth) {
    const { ctx } = this
    const cx = T[0] * arcs[o] + T[2] * arcs[o + 1] + T[4]
    const cy = T[1] * arcs[o] + T[3] * arcs[o + 1] + T[5]
    const ux = T[0] * arcs[o + 2] + T[2] * arcs[o + 3]
    const uy = T[1] * arcs[o + 2] + T[3] * arcs[o + 3]
    const vx = T[0] * arcs[o + 4] + T[2] * arcs[o + 5]
    const vy = T[1] * arcs[o + 4] + T[3] * arcs[o + 5]
    const a0 = arcs[o + 6]
    const a1 = arcs[o + 7]
    const r = Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy))
    if (r < 0.6) {
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + 0.6, cy)
      return 2
    }
    const step = r < 2 ? Math.PI / 4 : Math.min(Math.PI / 8, 2 * Math.acos(1 - 0.15 / r))
    const trace = (from, to) => {
      const n = Math.min(4096, Math.max(1, Math.ceil((to - from) / step)))
      for (let i = 0; i <= n; i++) {
        const t = from + ((to - from) * i) / n
        const c = Math.cos(t)
        const s = Math.sin(t)
        const x = cx + ux * c + vx * s
        const y = cy + uy * c + vy * s
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      return n + 1
    }
    if (r <= BIG_ARC_PX) return trace(a0, a1)

    // Very large on screen: only trace the pieces that cross the view.
    const pad = lineWidth + 2
    const spans = visibleArcSpans(cx, cy, ux, uy, vx, vy, rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad)
    if (!spans) return trace(a0, a1)
    let used = 0
    for (let s = 0; s < spans.length; s += 2) {
      // Shift the span by whole turns so it lines up with [a0, a1].
      let from = spans[s]
      let to = spans[s + 1]
      const shift = Math.ceil((a0 - to) / TAU) * TAU
      from += shift
      to += shift
      for (; from < a1; from += TAU, to += TAU) {
        const lo = Math.max(from, a0)
        const hi = Math.min(to, a1)
        if (hi > lo) used += trace(lo, hi)
      }
    }
    return used
  }

  drawTexts(space, T, vx0, vy0, vx1, vy1, shown) {
    const { ctx } = this
    const { geom, meta, str, width, box } = space.text
    const n = str.length
    if (!n) return
    const hair = this.dpr
    let font = -1
    let color = null
    let align = 0
    const greek = new Map()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    for (let i = 0; i < n; i++) {
      const o4 = i * 4
      if (box[o4] > vx1 || box[o4 + 2] < vx0 || box[o4 + 1] > vy1 || box[o4 + 3] < vy0) continue
      if (!shown(meta[o4])) continue
      const o = i * 6
      // Device-space images of the text's local x (advance) and y (up) axes.
      const ax = T[0] * geom[o + 2] + T[2] * geom[o + 3]
      const ay = T[1] * geom[o + 2] + T[3] * geom[o + 3]
      const cx = T[0] * geom[o + 4] + T[2] * geom[o + 5]
      const cy = T[1] * geom[o + 4] + T[3] * geom[o + 5]
      const px = Math.hypot(cx, cy) // cap height in device pixels
      if (px < 1.3 * hair) continue
      const x = T[0] * geom[o] + T[2] * geom[o + 1] + T[4]
      const y = T[1] * geom[o] + T[3] * geom[o + 1] + T[5]
      const flags = meta[o4 + 2]
      const ha = flags & 3
      const va = (flags >> 2) & 3
      const w = width[i]
      const x0 = ha === 0 ? 0 : ha === 1 ? -w / 2 : -w
      const c = meta[o4 + 1]
      if (px < 4 * hair) {
        // Too small to read: draw a faint bar where the text is.
        const yMid = (va === 0 ? 0 : va === 1 ? 0.3 : va === 2 ? -0.5 : -1) + 0.5
        let list = greek.get(c)
        if (!list) greek.set(c, (list = []))
        list.push(
          x + ax * x0 + cx * yMid, y + ay * x0 + cy * yMid,
          x + ax * (x0 + w) + cx * yMid, y + ay * (x0 + w) + cy * yMid, px
        )
        continue
      }
      const f = (flags >> 4) & 3
      if (f !== font) {
        ctx.font = FONTS[f] || FONTS[0]
        font = f
      }
      if (c !== color) {
        ctx.fillStyle = this.css(c)
        color = c
      }
      const k = 1 / (FONT_PX * CAP_RATIO)
      ctx.setTransform(ax * k, ay * k, -cx * k, -cy * k, x, y)
      const yOff = va === 0 ? 0 : va === 1 ? -0.3 : va === 2 ? 0.5 : 1
      if (ha !== align) {
        ctx.textAlign = ha === 0 ? 'left' : ha === 1 ? 'center' : 'right'
        align = ha
      }
      ctx.fillText(str[i], 0, yOff * FONT_PX * CAP_RATIO)
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (greek.size) {
      ctx.globalAlpha = 0.55
      for (const [c, list] of greek) {
        ctx.strokeStyle = this.css(c)
        for (let i = 0; i < list.length; i += 5) {
          ctx.lineWidth = Math.max(hair, list[i + 4] * 0.5)
          ctx.beginPath()
          ctx.moveTo(list[i], list[i + 1])
          ctx.lineTo(list[i + 2], list[i + 3])
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      ctx.lineWidth = hair
    }
  }

  // ---- overlays ---------------------------------------------------------
  drawOverlays() {
    const { ctx } = this
    const theme = THEMES[this.theme]
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    if (this.selection && this.space) this.drawSelection(theme)
    if (this.measure) this.drawMeasure(theme)
  }

  drawSelection(theme) {
    const { ctx, space } = this
    const T = this.matrix()
    const rect = [0, 0, this.canvas.width, this.canvas.height]
    const sel = this.selection
    ctx.strokeStyle = theme.highlight
    ctx.fillStyle = theme.highlight
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    const px = (x, y) => [T[0] * x + T[2] * y + T[4], T[1] * x + T[3] * y + T[5]]
    for (const item of sel.items) {
      if (item.kind === 'fill') {
        const b = space.fills[item.batch]
        ctx.globalAlpha = 0.45
        ctx.beginPath()
        for (let r = b.polyStarts[item.index]; r < b.polyStarts[item.index + 1]; r++) {
          for (let j = b.ringStarts[r] * 2, end = b.ringStarts[r + 1] * 2, first = true; j < end; j += 2, first = false) {
            const [x, y] = px(b.pts[j], b.pts[j + 1])
            if (first) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.closePath()
        }
        ctx.fill('evenodd')
        ctx.globalAlpha = 1
        continue
      }
      if (item.kind === 'text') {
        const t = space.text
        const o = item.index * 6
        const flags = t.meta[item.index * 4 + 2]
        const [x0, y0, x1, y1] = textLocalBox(t.width[item.index], flags & 3, (flags >> 2) & 3)
        const corner = (lx, ly) => px(t.geom[o] + t.geom[o + 2] * lx + t.geom[o + 4] * ly, t.geom[o + 1] + t.geom[o + 3] * lx + t.geom[o + 5] * ly)
        ctx.lineWidth = 1.5 * this.dpr
        ctx.beginPath()
        ctx.moveTo(...corner(x0, y0))
        ctx.lineTo(...corner(x1, y0))
        ctx.lineTo(...corner(x1, y1))
        ctx.lineTo(...corner(x0, y1))
        ctx.closePath()
        ctx.stroke()
        continue
      }
      const b = space.strokes[item.batch]
      const ppu = this.view.k * this.dpr
      ctx.lineWidth = Math.max(b.width * ppu, this.dpr) + 2 * this.dpr
      ctx.beginPath()
      if (item.kind === 'line') {
        for (let j = b.starts[item.index] * 2, end = b.starts[item.index + 1] * 2, first = true; j < end; j += 2, first = false) {
          const [x, y] = px(b.pts[j], b.pts[j + 1])
          if (first) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
      } else if (item.kind === 'arc') {
        this.arcPath(b.arcs, item.index * 8, T, rect, ctx.lineWidth)
      } else if (item.kind === 'seg') {
        ctx.lineWidth = 1.5 * this.dpr
        for (let j = b.segStarts[item.index] * 4, end = b.segStarts[item.index + 1] * 4; j < end; j += 4) {
          ctx.moveTo(...px(b.segs[j], b.segs[j + 1]))
          ctx.lineTo(...px(b.segs[j + 2], b.segs[j + 3]))
        }
      }
      ctx.stroke()
    }
  }

  drawMeasure(theme) {
    const { ctx } = this
    const m = this.measure
    const d = this.dpr
    ctx.strokeStyle = theme.measure
    ctx.fillStyle = theme.measure
    ctx.lineWidth = 1.5 * d
    const mark = (p, snapped) => {
      const [x, y] = this.toScreen(p[0], p[1])
      ctx.beginPath()
      if (snapped) ctx.rect(x * d - 5 * d, y * d - 5 * d, 10 * d, 10 * d)
      else ctx.arc(x * d, y * d, 4 * d, 0, TAU)
      ctx.stroke()
    }
    const a = m.a
    const b = m.b || m.hover
    if (a && b) {
      const [x1, y1] = this.toScreen(a[0], a[1])
      const [x2, y2] = this.toScreen(b[0], b[1])
      if (!m.b) ctx.setLineDash([6 * d, 4 * d])
      ctx.beginPath()
      ctx.moveTo(x1 * d, y1 * d)
      ctx.lineTo(x2 * d, y2 * d)
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (a) mark(a, m.aSnapped)
    if (m.b) mark(m.b, m.bSnapped)
    else if (m.hover) mark(m.hover, m.hoverSnapped)
  }

  // ---- picking ----------------------------------------------------------
  /** Find the entity under a CSS-pixel position. Returns { ent, items } or null. */
  pick(px, py, tolerancePx = 6) {
    const space = this.space
    if (!space) return null
    const [wx, wy] = this.toWorld(px, py)
    const tol = tolerancePx / this.view.k
    const vis = this.layerVisible
    let best = Infinity
    let ent = -1

    for (const b of space.strokes) {
      if (!vis[b.layer]) continue
      const reach = tol + b.width / 2
      const { pts, starts, box } = b
      for (let i = 0, n = b.ent.length; i < n; i++) {
        const o = i * 4
        if (wx < box[o] - reach || wx > box[o + 2] + reach || wy < box[o + 1] - reach || wy > box[o + 3] + reach) continue
        for (let j = starts[i] * 2, end = starts[i + 1] * 2 - 2; j < end; j += 2) {
          const d = segmentDistance(wx, wy, pts[j], pts[j + 1], pts[j + 2], pts[j + 3]) - b.width / 2
          if (d < best) {
            best = d
            ent = b.ent[i]
          }
        }
      }
      const { arcs, arcBox } = b
      for (let i = 0, n = b.arcEnt.length; i < n; i++) {
        const o = i * 4
        if (wx < arcBox[o] - reach || wx > arcBox[o + 2] + reach || wy < arcBox[o + 1] - reach || wy > arcBox[o + 3] + reach) continue
        const d = arcDistance(arcs, i * 8, wx, wy) - b.width / 2
        if (d < best) {
          best = d
          ent = b.arcEnt[i]
        }
      }
      const { segs, segStarts, segBox } = b
      for (let i = 0, n = b.segEnt.length; i < n; i++) {
        const o = i * 4
        if (wx < segBox[o] - tol || wx > segBox[o + 2] + tol || wy < segBox[o + 1] - tol || wy > segBox[o + 3] + tol) continue
        for (let j = segStarts[i] * 4, end = segStarts[i + 1] * 4; j < end; j += 4) {
          const d = segmentDistance(wx, wy, segs[j], segs[j + 1], segs[j + 2], segs[j + 3])
          if (d < best) {
            best = d
            ent = b.segEnt[i]
          }
        }
      }
    }
    if (best > tol) {
      best = Infinity
      ent = -1
      // Text, then filled areas, when no linework is close enough.
      const t = space.text
      for (let i = 0, n = t.str.length; i < n; i++) {
        const o = i * 4
        if (!vis[t.meta[o]]) continue
        if (wx < t.box[o] || wx > t.box[o + 2] || wy < t.box[o + 1] || wy > t.box[o + 3]) continue
        const area = (t.box[o + 2] - t.box[o]) * (t.box[o + 3] - t.box[o + 1])
        if (area < best) {
          best = area
          ent = t.meta[o + 3]
        }
      }
      if (ent < 0) {
        for (const b of space.fills) {
          if (!vis[b.layer]) continue
          for (let i = 0, n = b.ent.length; i < n; i++) {
            const o = i * 4
            if (wx < b.box[o] || wx > b.box[o + 2] || wy < b.box[o + 1] || wy > b.box[o + 3]) continue
            if (!pointInPolygon(b, i, wx, wy)) continue
            const area = (b.box[o + 2] - b.box[o]) * (b.box[o + 3] - b.box[o + 1])
            if (area < best) {
              best = area
              ent = b.ent[i]
            }
          }
        }
      }
    }
    if (ent < 0) return null
    return this.collect(ent)
  }

  /** Gather every primitive belonging to an entity, with its total length. */
  collect(ent) {
    const space = this.space
    const items = []
    let length = 0
    let measurable = false
    space.strokes.forEach((b, batch) => {
      for (let i = 0; i < b.ent.length; i++) {
        if (b.ent[i] !== ent) continue
        items.push({ kind: 'line', batch, index: i })
        for (let j = b.starts[i] * 2, end = b.starts[i + 1] * 2 - 2; j < end; j += 2) {
          length += Math.hypot(b.pts[j + 2] - b.pts[j], b.pts[j + 3] - b.pts[j + 1])
        }
        measurable = true
      }
      for (let i = 0; i < b.arcEnt.length; i++) {
        if (b.arcEnt[i] !== ent) continue
        items.push({ kind: 'arc', batch, index: i })
        length += arcLength(b.arcs, i * 8)
        measurable = true
      }
      for (let i = 0; i < b.segEnt.length; i++) {
        if (b.segEnt[i] === ent) items.push({ kind: 'seg', batch, index: i })
      }
    })
    space.fills.forEach((b, batch) => {
      for (let i = 0; i < b.ent.length; i++) {
        if (b.ent[i] === ent) items.push({ kind: 'fill', batch, index: i })
      }
    })
    const t = space.text
    for (let i = 0; i < t.str.length; i++) {
      if (t.meta[i * 4 + 3] === ent) items.push({ kind: 'text', index: i })
    }
    return { ent, items, length: measurable ? length : null }
  }

  /** Nearest polyline vertex or arc end/centre within tolerance, or null. */
  snap(px, py, tolerancePx = 10) {
    const space = this.space
    if (!space) return null
    const [wx, wy] = this.toWorld(px, py)
    const tol = tolerancePx / this.view.k
    const vis = this.layerVisible
    let best = tol * tol
    let found = null
    const test = (x, y) => {
      const d = (x - wx) * (x - wx) + (y - wy) * (y - wy)
      if (d <= best) {
        best = d
        found = [x, y]
      }
    }
    for (const b of space.strokes) {
      if (!vis[b.layer]) continue
      const { pts, starts, box } = b
      for (let i = 0, n = b.ent.length; i < n; i++) {
        const o = i * 4
        if (wx < box[o] - tol || wx > box[o + 2] + tol || wy < box[o + 1] - tol || wy > box[o + 3] + tol) continue
        for (let j = starts[i] * 2, end = starts[i + 1] * 2; j < end; j += 2) test(pts[j], pts[j + 1])
      }
      const { arcs, arcBox } = b
      for (let i = 0, n = b.arcEnt.length; i < n; i++) {
        const o = i * 8
        const q = i * 4
        const cx = arcs[o], cy = arcs[o + 1]
        test(cx, cy)
        if (wx < arcBox[q] - tol || wx > arcBox[q + 2] + tol || wy < arcBox[q + 1] - tol || wy > arcBox[q + 3] + tol) continue
        if (arcs[o + 7] - arcs[o + 6] < TAU - 1e-9) {
          for (const t of [arcs[o + 6], arcs[o + 7]]) {
            test(cx + arcs[o + 2] * Math.cos(t) + arcs[o + 4] * Math.sin(t), cy + arcs[o + 3] * Math.cos(t) + arcs[o + 5] * Math.sin(t))
          }
        } else {
          for (let q4 = 0; q4 < 4; q4++) {
            const t = (q4 * Math.PI) / 2
            test(cx + arcs[o + 2] * Math.cos(t) + arcs[o + 4] * Math.sin(t), cy + arcs[o + 3] * Math.cos(t) + arcs[o + 5] * Math.sin(t))
          }
        }
      }
    }
    return found
  }
}

// ---- geometry utilities ---------------------------------------------------

function segmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t))
}

/** Parameter-space position of a point relative to an arc's ellipse. */
function arcParam(arcs, o, px, py) {
  const ux = arcs[o + 2], uy = arcs[o + 3], vx = arcs[o + 4], vy = arcs[o + 5]
  const det = ux * vy - uy * vx
  if (!det) return null
  const dx = px - arcs[o]
  const dy = py - arcs[o + 1]
  return [(dx * vy - dy * vx) / det, (ux * dy - uy * dx) / det]
}

function arcDistance(arcs, o, px, py) {
  const q = arcParam(arcs, o, px, py)
  if (!q) return Infinity
  const a0 = arcs[o + 6]
  const a1 = arcs[o + 7]
  let t = Math.atan2(q[1], q[0])
  t -= Math.floor((t - a0) / TAU) * TAU
  if (t > a1) t = t - a1 < a0 + TAU - t ? a1 : a0
  const x = arcs[o] + arcs[o + 2] * Math.cos(t) + arcs[o + 4] * Math.sin(t)
  const y = arcs[o + 1] + arcs[o + 3] * Math.cos(t) + arcs[o + 5] * Math.sin(t)
  return Math.hypot(px - x, py - y)
}

function arcLength(arcs, o) {
  const ru = Math.hypot(arcs[o + 2], arcs[o + 3])
  const rv = Math.hypot(arcs[o + 4], arcs[o + 5])
  const sweep = arcs[o + 7] - arcs[o + 6]
  if (Math.abs(ru - rv) <= 1e-9 * Math.max(ru, rv)) return ru * sweep
  let len = 0
  let lx = 0
  let ly = 0
  const n = 128
  for (let i = 0; i <= n; i++) {
    const t = arcs[o + 6] + (sweep * i) / n
    const x = arcs[o + 2] * Math.cos(t) + arcs[o + 4] * Math.sin(t)
    const y = arcs[o + 3] * Math.cos(t) + arcs[o + 5] * Math.sin(t)
    if (i) len += Math.hypot(x - lx, y - ly)
    lx = x
    ly = y
  }
  return len
}

function pointInPolygon(b, index, px, py) {
  let inside = false
  for (let r = b.polyStarts[index]; r < b.polyStarts[index + 1]; r++) {
    const from = b.ringStarts[r] * 2
    const to = b.ringStarts[r + 1] * 2
    let x1 = b.pts[to - 2]
    let y1 = b.pts[to - 1]
    for (let j = from; j < to; j += 2) {
      const x2 = b.pts[j]
      const y2 = b.pts[j + 1]
      if ((y1 > py) !== (y2 > py) && px < x1 + ((py - y1) / (y2 - y1)) * (x2 - x1)) inside = !inside
      x1 = x2
      y1 = y2
    }
  }
  return inside
}

/** Clip an infinite line or ray to a box; returns [x1, y1, x2, y2] or null. */
function clipRay(x, y, dx, dy, isRay, x0, y0, x1, y1) {
  let tMin = isRay ? 0 : -Infinity
  let tMax = Infinity
  for (const [p, d, lo, hi] of [[x, dx, x0, x1], [y, dy, y0, y1]]) {
    if (Math.abs(d) < 1e-300) {
      if (p < lo || p > hi) return null
      continue
    }
    let ta = (lo - p) / d
    let tb = (hi - p) / d
    if (ta > tb) [ta, tb] = [tb, ta]
    if (ta > tMin) tMin = ta
    if (tb < tMax) tMax = tb
  }
  if (!(tMin < tMax) || !isFinite(tMin) || !isFinite(tMax)) return null
  return [x + dx * tMin, y + dy * tMin, x + dx * tMax, y + dy * tMax]
}

/**
 * Parameter spans [t0, t1, ...] (t0 in [0, 2pi)) of the ellipse
 * c + u*cos(t) + v*sin(t) that lie inside a device rectangle. Returns null
 * when the ellipse is degenerate and the caller should trace it whole.
 */
function visibleArcSpans(cx, cy, ux, uy, vx, vy, x0, y0, x1, y1) {
  const det = ux * vy - uy * vx
  if (Math.abs(det) < 1e-12) return null
  // Rectangle corners in the ellipse's unit-circle space.
  const q = []
  for (const [px, py] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
    const dx = px - cx
    const dy = py - cy
    q.push((dx * vy - dy * vx) / det, (ux * dy - uy * dx) / det)
  }
  const angles = []
  for (let i = 0; i < 4; i++) {
    const ax = q[i * 2], ay = q[i * 2 + 1]
    const bx = q[((i + 1) % 4) * 2] - ax
    const by = q[((i + 1) % 4) * 2 + 1] - ay
    const A = bx * bx + by * by
    const B = 2 * (ax * bx + ay * by)
    const C = ax * ax + ay * ay - 1
    const disc = B * B - 4 * A * C
    if (A === 0 || disc < 0) continue
    const root = Math.sqrt(disc)
    for (const s of [(-B - root) / (2 * A), (-B + root) / (2 * A)]) {
      if (s < 0 || s > 1) continue
      let t = Math.atan2(ay + by * s, ax + bx * s)
      if (t < 0) t += TAU
      angles.push(t)
    }
  }
  const inside = t => {
    const x = cx + ux * Math.cos(t) + vx * Math.sin(t)
    const y = cy + uy * Math.cos(t) + vy * Math.sin(t)
    return x >= x0 && x <= x1 && y >= y0 && y <= y1
  }
  if (!angles.length) return inside(0) ? [0, TAU] : []
  angles.sort((a, b) => a - b)
  const spans = []
  for (let i = 0; i < angles.length; i++) {
    const from = angles[i]
    const to = i + 1 < angles.length ? angles[i + 1] : angles[0] + TAU
    if (to - from > 1e-12 && inside((from + to) / 2)) spans.push(from, to)
  }
  return spans
}
