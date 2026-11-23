// 2D geometry helpers shared by the scene builder and the renderer.
//
// An affine matrix is [a, b, c, d, e, f] with
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
// (the same layout as CanvasRenderingContext2D.setTransform).

export const TAU = Math.PI * 2
export const IDENTITY = [1, 0, 0, 1, 0, 0]

/** m o n: apply n first, then m. */
export function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ]
}

export const translate = (x, y) => [1, 0, 0, 1, x, y]
export const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0]
export function rotate(angle) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [c, s, -s, c, 0, 0]
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det) return null
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}

/** Uniform scale factor of a matrix (geometric mean of its two axes). */
export const scaleOf = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))

/**
 * AutoCAD's "arbitrary axis algorithm": the matrix taking 2D object
 * coordinates (OCS) with the given extrusion normal to world XY. Returns
 * null for the common case where the OCS is the world system.
 */
export function ocsMatrix(normal, elevation = 0) {
  if (!normal) return null
  let { x: nx, y: ny, z: nz } = normal
  const len = Math.hypot(nx, ny, nz)
  if (!len) return null
  nx /= len
  ny /= len
  nz /= len
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && nz > 0) return null
  let ax, ay, az
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) {
    // Ax = Wy x N
    ax = nz
    ay = 0
    az = -nx
  } else {
    // Ax = Wz x N
    ax = -ny
    ay = nx
    az = 0
  }
  const al = Math.hypot(ax, ay, az)
  ax /= al
  ay /= al
  az /= al
  // Ay = N x Ax
  const bx = ny * az - nz * ay
  const by = nz * ax - nx * az
  return [ax, ay, bx, by, elevation * nx, elevation * ny]
}

/**
 * Circular arc for a polyline segment with a bulge.
 * Returns { cx, cy, r, a0, a1 } with a0 < a1 swept counter-clockwise.
 */
export function bulgeArc(x1, y1, x2, y2, bulge) {
  const k = (1 - bulge * bulge) / (4 * bulge)
  const cx = (x1 + x2) / 2 - (y2 - y1) * k
  const cy = (y1 + y2) / 2 + (x2 - x1) * k
  const r = Math.hypot(x1 - cx, y1 - cy)
  const sweep = 4 * Math.atan(bulge)
  let a0
  if (sweep >= 0) a0 = Math.atan2(y1 - cy, x1 - cx)
  else a0 = Math.atan2(y2 - cy, x2 - cx)
  return { cx, cy, r, a0, a1: a0 + Math.abs(sweep) }
}

/** Append the points of a bulge segment (excluding its start point). */
export function bulgePoints(x1, y1, x2, y2, bulge, out) {
  if (!bulge || !isFinite(bulge)) {
    out.push(x2, y2)
    return
  }
  const { cx, cy, r } = bulgeArc(x1, y1, x2, y2, bulge)
  const sweep = 4 * Math.atan(bulge)
  const start = Math.atan2(y1 - cy, x1 - cx)
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 32)))
  for (let i = 1; i < n; i++) {
    const a = start + (sweep * i) / n
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
  out.push(x2, y2)
}

/** Append points along an elliptical arc given centre and conjugate axes. */
export function ellipsePoints(cx, cy, ux, uy, vx, vy, a0, a1, out, includeStart = true) {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 32)))
  for (let i = includeStart ? 0 : 1; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    const c = Math.cos(a)
    const s = Math.sin(a)
    out.push(cx + ux * c + vx * s, cy + uy * c + vy * s)
  }
}

/**
 * Tight bounding box of the arc c + u*cos(t) + v*sin(t), t in [a0, a1].
 * Writes [minX, minY, maxX, maxY] into out at offset o.
 */
export function arcBounds(cx, cy, ux, uy, vx, vy, a0, a1, out, o) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const add = t => {
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = cx + ux * c + vx * s
    const y = cy + uy * c + vy * s
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  add(a0)
  add(a1)
  if (a1 - a0 >= TAU - 1e-9) {
    add(Math.atan2(vx, ux))
    add(Math.atan2(vx, ux) + Math.PI)
    add(Math.atan2(vy, uy))
    add(Math.atan2(vy, uy) + Math.PI)
  } else {
    for (const base of [Math.atan2(vx, ux), Math.atan2(vy, uy)]) {
      for (let k = 0; k < 2; k++) {
        let t = base + k * Math.PI
        t -= Math.floor((t - a0) / TAU) * TAU // smallest t >= a0
        if (t <= a1) add(t)
      }
    }
  }
  out[o] = minX
  out[o + 1] = minY
  out[o + 2] = maxX
  out[o + 3] = maxY
}

/** Evaluate a (rational) B-spline into a flat [x, y, ...] point list. */
export function nurbsPoints(degree, knots, ctrl, weights, closed) {
  const n = ctrl.length
  const p = Math.max(1, Math.min(degree || 3, n - 1))
  let U = knots
  if (!U || U.length !== n + p + 1) {
    // Missing or inconsistent knot vector: fall back to a clamped uniform one.
    U = []
    for (let i = 0; i <= n + p; i++) {
      U.push(i <= p ? 0 : i >= n ? n - p : i - p)
    }
  }
  const lo = U[p]
  const hi = U[n]
  const out = []
  if (!(hi > lo)) {
    for (const c of ctrl) out.push(c.x, c.y)
    return out
  }
  const d = new Array(p + 1)
  const evalAt = u => {
    let k = p
    while (k < n - 1 && U[k + 1] <= u) k++
    for (let j = 0; j <= p; j++) {
      const c = ctrl[k - p + j]
      const w = weights && weights.length === n ? weights[k - p + j] || 1 : 1
      d[j] = [c.x * w, c.y * w, w]
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j
        const den = U[i + p - r + 1] - U[i]
        const a = den ? (u - U[i]) / den : 0
        const q = d[j - 1]
        const t = d[j]
        d[j] = [q[0] + (t[0] - q[0]) * a, q[1] + (t[1] - q[1]) * a, q[2] + (t[2] - q[2]) * a]
      }
    }
    const w = d[p][2] || 1
    out.push(d[p][0] / w, d[p][1] / w)
  }
  const perSpan = p === 1 ? 1 : 12
  for (let k = p; k < n; k++) {
    const a = U[k]
    const b = U[k + 1]
    if (!(b > a)) continue
    for (let i = 0; i < perSpan; i++) evalAt(a + ((b - a) * i) / perSpan)
  }
  evalAt(hi)
  if (closed && out.length >= 4) out.push(out[0], out[1])
  return out
}

/** Smooth curve through fit points (centripetal-ish Catmull-Rom). */
export function fitPointsCurve(pts, closed) {
  const n = pts.length
  if (n < 3) return pts.flatMap(p => [p.x, p.y])
  const out = []
  const get = i => {
    if (closed) return pts[((i % n) + n) % n]
    return pts[Math.max(0, Math.min(n - 1, i))]
  }
  const segs = closed ? n : n - 1
  const steps = 12
  for (let s = 0; s < segs; s++) {
    const p0 = get(s - 1), p1 = get(s), p2 = get(s + 1), p3 = get(s + 2)
    for (let i = 0; i < steps; i++) {
      const t = i / steps
      const t2 = t * t
      const t3 = t2 * t
      out.push(
        0.5 * (2 * p1.x + (p2.x - p0.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3),
        0.5 * (2 * p1.y + (p2.y - p0.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (3 * p1.y - p0.y - 3 * p2.y + p3.y) * t3)
      )
    }
  }
  const last = get(closed ? 0 : n - 1)
  out.push(last.x, last.y)
  return out
}
