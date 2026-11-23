import test from 'node:test'
import assert from 'node:assert/strict'
import { ACI, aciToColor, FOREGROUND } from '../src/aci.js'
import {
  TAU, mul, invert, translate, rotate, scale, scaleOf, ocsMatrix,
  bulgeArc, bulgePoints, arcBounds, nurbsPoints, fitPointsCurve
} from '../src/geom.js'
import { decodeMText, decodePlainText, repairFusedAscii, wrapLine, estimateWidth } from '../src/text.js'

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

test('ACI palette has the standard named colours', () => {
  assert.equal(ACI[1], 0xff0000)
  assert.equal(ACI[2], 0xffff00)
  assert.equal(ACI[3], 0x00ff00)
  assert.equal(ACI[4], 0x00ffff)
  assert.equal(ACI[5], 0x0000ff)
  assert.equal(ACI[6], 0xff00ff)
  assert.equal(ACI[10], 0xff0000)
  assert.equal(ACI[250], 0x333333)
  assert.equal(aciToColor(7), FOREGROUND)
})

test('matrix composition and inversion round-trip', () => {
  const m = mul(translate(10, -4), mul(rotate(0.7), scale(2, 3)))
  const [x, y] = apply(m, 5, 6)
  const [bx, by] = apply(invert(m), x, y)
  near(bx, 5)
  near(by, 6)
  near(scaleOf(m), Math.sqrt(6))
  assert.equal(invert([0, 0, 0, 0, 1, 1]), null)
})

test('OCS with a downward normal mirrors X', () => {
  assert.equal(ocsMatrix({ x: 0, y: 0, z: 1 }), null)
  assert.equal(ocsMatrix({ x: 0, y: 0, z: 0 }), null)
  const m = ocsMatrix({ x: 0, y: 0, z: -1 })
  const [x, y] = apply(m, 3, 4)
  near(x, -3)
  near(y, 4)
})

test('bulge of 1 is a counter-clockwise semicircle', () => {
  const arc = bulgeArc(0, 0, 2, 0, 1)
  near(arc.cx, 1)
  near(arc.cy, 0)
  near(arc.r, 1)
  near(arc.a1 - arc.a0, Math.PI)
  // Travelling from (0,0) to (2,0) counter-clockwise passes through (1,-1).
  const pts = [0, 0]
  bulgePoints(0, 0, 2, 0, 1, pts)
  const ys = pts.filter((v, i) => i % 2 === 1)
  near(Math.min(...ys), -1, 1e-3)
  near(pts[pts.length - 2], 2)
  near(pts[pts.length - 1], 0)
  // A negative bulge goes the other way round.
  const down = bulgeArc(0, 0, 2, 0, -1)
  near(down.a1 - down.a0, Math.PI)
})

test('arc bounds are tight for partial arcs and full circles', () => {
  const box = new Float64Array(4)
  arcBounds(0, 0, 10, 0, 0, 10, 0, Math.PI / 2, box, 0)
  ;[0, 0, 10, 10].forEach((v, i) => near(box[i], v))
  arcBounds(5, 5, 2, 0, 0, 2, 0, TAU, box, 0)
  ;[3, 3, 7, 7].forEach((v, i) => near(box[i], v))
  // A shallow arc of a huge circle must not report the whole circle.
  arcBounds(0, 0, 1e6, 0, 0, 1e6, Math.PI / 2 - 1e-4, Math.PI / 2 + 1e-4, box, 0)
  assert.ok(box[2] - box[0] < 250 && box[3] - box[1] < 1)
})

test('splines start and end on their end control points', () => {
  const ctrl = [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 0 }]
  const pts = nurbsPoints(3, [0, 0, 0, 0, 1, 1, 1, 1], ctrl, null, false)
  near(pts[0], 0)
  near(pts[1], 0)
  near(pts[pts.length - 2], 4)
  near(pts[pts.length - 1], 0)
  // Bezier midpoint of these control points.
  const mid = pts.length / 2 - (pts.length / 2) % 2
  near(pts[mid], 2, 1e-9)
  near(pts[mid + 1], 1.5, 1e-9)
  // Bad knot vectors fall back to something sane instead of NaN.
  assert.ok(nurbsPoints(3, [], ctrl, null, false).every(Number.isFinite))
  const fit = fitPointsCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }], false)
  near(fit[0], 0)
  near(fit[fit.length - 2], 2)
})

test('MTEXT formatting codes are stripped', () => {
  assert.deepEqual(decodeMText('{\\fArial|b0|i0;Hello} \\C1;world\\Pline 2'), ['Hello world', 'line 2'])
  assert.deepEqual(decodeMText('1\\S1/2;"'), ['11/2"'])
  assert.deepEqual(decodeMText('a\\~b \\\\ \\{x\\}'), ['a\u00a0b \\ {x}'])
  assert.deepEqual(decodeMText('%%c20 %%p0.5 45%%d'), ['\u230020 \u00b10.5 45\u00b0'])
  assert.deepEqual(decodeMText('\\U+00C9t\u00e9'), ['\u00c9t\u00e9'])
  assert.deepEqual(decodeMText(''), [''])
  assert.equal(decodePlainText('%%uTitle%%u %%065'), 'Title A')
})

test('fused 8-bit text is repaired and real CJK is left alone', () => {
  const fused = String.fromCharCode(0x7878, 0x505c)
  assert.equal(repairFusedAscii(fused), 'xx\\P')
  assert.equal(repairFusedAscii('\u623f\u95f4'), '\u623f\u95f4')
  assert.equal(repairFusedAscii('plain'), 'plain')
})

test('word wrap keeps words whole', () => {
  const lines = wrapLine('aaaa bbbb cccc dddd', estimateWidth('aaaa bbbb') + 0.1)
  assert.deepEqual(lines, ['aaaa bbbb', 'cccc dddd'])
  assert.deepEqual(wrapLine('short', 100), ['short'])
  assert.deepEqual(wrapLine('anything', 0), ['anything'])
})
