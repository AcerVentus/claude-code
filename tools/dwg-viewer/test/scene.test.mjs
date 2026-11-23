import test from 'node:test'
import assert from 'node:assert/strict'
import { FOREGROUND } from '../src/aci.js'
import { buildScene, sceneTransferables } from '../src/scene.js'

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)
const Z = { x: 0, y: 0, z: 1 }
const pt = (x, y) => ({ x, y, z: 0 })

let handle = 0x100
const ent = (type, props) => ({ type, handle: (handle++).toString(16).toUpperCase(), layer: '0', colorIndex: 256, isVisible: true, ...props })

function database({ entities = [], blocks = [], layers = [], layouts = [], ltypes = [], header = {} } = {}) {
  return {
    header: { LTSCALE: 1, ...header },
    entities,
    tables: {
      LAYER: {
        entries: [
          { name: '0', colorIndex: 7, color: 0xffffff, lineType: 'Continuous', handle: '10' },
          ...layers
        ]
      },
      LTYPE: { entries: ltypes },
      STYLE: { entries: [{ name: 'Standard', font: 'txt', widthFactor: 1, fixedTextHeight: 0 }] },
      BLOCK_RECORD: { entries: blocks }
    },
    objects: { LAYOUT: layouts }
  }
}

const strokeOf = (space, pred = () => true) => space.strokes.filter(pred)
const polyline = (batch, i) => Array.from(batch.pts.subarray(batch.starts[i] * 2, batch.starts[i + 1] * 2))

test('lines, circles and arcs become primitives with tight extents', () => {
  const scene = buildScene(database({
    entities: [
      ent('LINE', { startPoint: pt(0, 0), endPoint: pt(10, 5) }),
      ent('CIRCLE', { center: pt(20, 0), radius: 5, extrusionDirection: Z }),
      ent('ARC', { center: pt(0, 0), radius: 2, startAngle: Math.PI, endAngle: Math.PI / 2, extrusionDirection: Z })
    ]
  }))
  const model = scene.spaces[0]
  assert.equal(model.name, 'Model')
  assert.equal(model.ents.type.length, 3)
  const [batch] = model.strokes
  assert.deepEqual(polyline(batch, 0), [0, 0, 10, 5])
  assert.equal(batch.arcEnt.length, 2)
  // The arc runs counter-clockwise from 180 degrees round to 90 degrees.
  near(batch.arcs[8 + 7] - batch.arcs[8 + 6], Math.PI * 1.5)
  assert.deepEqual(model.extents.map(v => Math.round(v * 1e6) / 1e6), [-2, -5, 25, 5])
  assert.deepEqual(model.fit, model.extents)
  assert.ok(sceneTransferables(scene).every(b => b instanceof ArrayBuffer))
})

test('colours resolve through layers, entities and true colour', () => {
  const scene = buildScene(database({
    layers: [{ name: 'RED', colorIndex: 1, color: 0xffffff, lineType: 'Continuous', handle: '20' },
      { name: 'HIDDEN', colorIndex: 3, color: 0xffffff, lineType: 'Continuous', off: true, handle: '21' }],
    entities: [
      ent('LINE', { layer: 'RED', startPoint: pt(0, 0), endPoint: pt(1, 0) }),
      ent('LINE', { layer: 'RED', colorIndex: 5, startPoint: pt(0, 1), endPoint: pt(1, 1) }),
      ent('LINE', { layer: 'RED', color: 0x123456, startPoint: pt(0, 2), endPoint: pt(1, 2) }),
      ent('LINE', { startPoint: pt(0, 3), endPoint: pt(1, 3) }),
      ent('LINE', { layer: 'NOT IN TABLE', startPoint: pt(0, 4), endPoint: pt(1, 4) })
    ]
  }))
  const colors = scene.spaces[0].strokes.map(b => b.color).sort((a, b) => a - b)
  assert.deepEqual(colors, [FOREGROUND, FOREGROUND, 0x0000ff, 0x123456, 0xff0000].sort((a, b) => a - b))
  assert.equal(scene.layers.find(l => l.name === 'HIDDEN').visible, false)
  assert.ok(scene.layers.some(l => l.name === 'NOT IN TABLE'))
  assert.equal(scene.layers.find(l => l.name === 'RED').count, 3)
})

test('polyline bulges become arcs and closed polylines return to the start', () => {
  const scene = buildScene(database({
    entities: [
      ent('LWPOLYLINE', {
        flag: 512,
        vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 4, y: 0, bulge: 1 }, { x: 4, y: 2, bulge: 0 }, { x: 0, y: 2, bulge: 0 }]
      })
    ]
  }))
  const [batch] = scene.spaces[0].strokes
  assert.equal(batch.arcEnt.length, 1)
  near(batch.arcs[0], 4)
  near(batch.arcs[1], 1)
  assert.deepEqual(polyline(batch, 0), [0, 0, 4, 0])
  assert.deepEqual(polyline(batch, 1), [4, 2, 0, 2, 0, 0])
  near(scene.spaces[0].extents[2], 5) // the bulge sticks out to x = 5
})

test('wide and tapered polyline segments', () => {
  const scene = buildScene(database({
    entities: [
      ent('LWPOLYLINE', { flag: 0, constantWidth: 2, vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 0 }] }),
      ent('LWPOLYLINE', { flag: 0, vertices: [{ x: 0, y: 5, bulge: 0, startWidth: 3, endWidth: 0 }, { x: 6, y: 5, bulge: 0 }] })
    ]
  }))
  const model = scene.spaces[0]
  assert.deepEqual(model.strokes.map(b => b.width), [2])
  assert.equal(model.fills.length, 1)
  assert.equal(model.fills[0].ent.length, 1) // the arrowhead
})

test('block references apply transforms and inherit layer and colour', () => {
  const block = {
    name: 'B', handle: 'B1', basePoint: pt(1, 0), entities: [
      ent('LINE', { layer: '0', colorIndex: 0, startPoint: pt(1, 0), endPoint: pt(2, 0) }),
      ent('LINE', { layer: 'FIXED', colorIndex: 256, startPoint: pt(1, 1), endPoint: pt(2, 1) }),
      ent('ATTDEF', { tag: 'TAG', flags: 0, text: { startPoint: pt(0, 0), textHeight: 1 } })
    ]
  }
  const scene = buildScene(database({
    layers: [{ name: 'INS', colorIndex: 2, color: 0xffffff, lineType: 'Continuous', handle: '30' },
      { name: 'FIXED', colorIndex: 4, color: 0xffffff, lineType: 'Continuous', handle: '31' }],
    blocks: [block],
    entities: [
      ent('INSERT', {
        name: 'b', layer: 'INS', colorIndex: 1, insertionPoint: pt(10, 10), xScale: 2, yScale: 2,
        rotation: Math.PI / 2, extrusionDirection: Z, attribs: [
          ent('ATTRIB', { layer: 'INS', flags: 0, text: { text: 'A-101', startPoint: pt(10, 12), textHeight: 1 } }),
          ent('ATTRIB', { layer: 'INS', flags: 1, text: { text: 'hidden', startPoint: pt(10, 13), textHeight: 1 } })
        ]
      })
    ]
  }))
  const model = scene.spaces[0]
  const layerName = b => scene.layers[b.layer].name
  const byBlock = model.strokes.find(b => layerName(b) === 'INS')
  const fixed = model.strokes.find(b => layerName(b) === 'FIXED')
  assert.equal(byBlock.color, 0xff0000) // BYBLOCK takes the insert's colour
  assert.equal(fixed.color, 0x00ffff) // BYLAYER on its own layer keeps that layer's colour
  // (1,0)-(2,0) relative to base (1,0), scaled 2x, rotated 90 degrees, moved to (10,10).
  polyline(byBlock, 0).forEach((v, i) => near(v, [10, 10, 10, 12][i]))
  polyline(fixed, 0).forEach((v, i) => near(v, [8, 10, 8, 12][i]))
  // Everything drawn by the insert reports the insert as its entity.
  assert.equal(model.ents.type[byBlock.ent[0]], 'INSERT')
  assert.equal(model.ents.info[byBlock.ent[0]], 'b')
  assert.deepEqual(model.text.str, ['A-101'])
})

test('self-referencing blocks do not recurse forever', () => {
  const block = { name: 'LOOP', handle: 'B2', basePoint: pt(0, 0), entities: [] }
  block.entities.push(
    ent('LINE', { startPoint: pt(0, 0), endPoint: pt(1, 0) }),
    ent('INSERT', { name: 'LOOP', insertionPoint: pt(5, 0), xScale: 1, yScale: 1, rotation: 0, attribs: [] })
  )
  const scene = buildScene(database({
    blocks: [block],
    entities: [ent('INSERT', { name: 'LOOP', insertionPoint: pt(0, 0), xScale: 1, yScale: 1, rotation: 0, attribs: [] })]
  }))
  assert.equal(scene.spaces[0].strokes[0].ent.length, 1)
})

test('mirrored extrusion flips geometry', () => {
  const scene = buildScene(database({
    entities: [ent('CIRCLE', { center: pt(10, 0), radius: 1, extrusionDirection: { x: 0, y: 0, z: -1 } })]
  }))
  near(scene.spaces[0].strokes[0].arcs[0], -10)
})

test('solid hatches fill, patterned hatches produce clipped lines', () => {
  const square = { boundaryPathTypeFlag: 2, isClosed: true, vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 0, bulge: 0 }, { x: 10, y: 10, bulge: 0 }, { x: 0, y: 10, bulge: 0 }] }
  const hole = { boundaryPathTypeFlag: 2, isClosed: true, vertices: [{ x: 4, y: 4, bulge: 0 }, { x: 6, y: 4, bulge: 0 }, { x: 6, y: 6, bulge: 0 }, { x: 4, y: 6, bulge: 0 }] }
  const scene = buildScene(database({
    entities: [
      ent('HATCH', { solidFill: 1, patternName: 'SOLID', boundaryPaths: [square, hole], definitionLines: [] }),
      ent('HATCH', {
        solidFill: 0, patternName: 'LINES', boundaryPaths: [square, hole],
        definitionLines: [{ angle: 0, base: { x: 0, y: 0.5 }, offset: { x: 0, y: 1 }, dashLengths: [] }]
      }),
      ent('HATCH', {
        solidFill: 0, patternName: 'DENSE', boundaryPaths: [square],
        definitionLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 1e-5 }, dashLengths: [] }]
      })
    ]
  }))
  const model = scene.spaces[0]
  const solid = model.fills.find(b => b.alpha === 1)
  assert.equal(solid.polyStarts[1] - solid.polyStarts[0], 2) // outer ring plus hole
  const lines = model.strokes.find(b => b.segEnt.length)
  // Ten horizontal lines; the two crossing the hole are split in two.
  assert.equal(lines.segs.length / 4, 12)
  near(lines.segSpacing[0], 1)
  for (let i = 0; i < lines.segs.length; i += 4) {
    near(lines.segs[i + 1], lines.segs[i + 3])
    const inHole = lines.segs[i + 1] > 4 && lines.segs[i + 1] < 6
    near(Math.abs(lines.segs[i + 2] - lines.segs[i]), inHole ? 4 : 10)
  }
  // A pattern too dense to draw falls back to a translucent fill.
  assert.ok(model.fills.some(b => b.alpha < 1))
})

test('text alignment, MTEXT lines and invisible entities', () => {
  const scene = buildScene(database({
    entities: [
      ent('TEXT', { text: 'left', startPoint: pt(1, 2), endPoint: pt(0, 0), textHeight: 2, rotation: 0, xScale: 1, halign: 0, valign: 0, styleName: 'Standard', extrusionDirection: Z }),
      ent('TEXT', { text: 'centred', startPoint: pt(0, 0), endPoint: pt(5, 5), textHeight: 1, rotation: Math.PI / 2, xScale: 1, halign: 1, valign: 2, styleName: 'Standard', extrusionDirection: Z }),
      ent('MTEXT', { text: 'one\\Ptwo', insertionPoint: pt(0, 20), textHeight: 3, rectWidth: 0, attachmentPoint: 1, direction: { x: 1, y: 0, z: 0 }, rotation: 0, styleName: 'Standard' }),
      ent('TEXT', { isVisible: false, text: 'ghost', startPoint: pt(0, 0), textHeight: 1 })
    ]
  }))
  const t = scene.spaces[0].text
  assert.deepEqual(t.str, ['left', 'centred', 'one', 'two'])
  assert.deepEqual(Array.from(t.geom.subarray(0, 6)), [1, 2, 2, 0, 0, 2])
  // Second text: anchored at its alignment point, rotated 90 degrees.
  near(t.geom[6], 5)
  near(t.geom[7], 5)
  near(t.geom[8], 0)
  near(t.geom[9], 1)
  assert.equal(t.meta[4 + 2] & 3, 1)
  assert.equal((t.meta[4 + 2] >> 2) & 3, 2)
  // MTEXT top-left: first baseline one text height below the insertion point,
  // second line 5/3 of the height further down.
  near(t.geom[12 + 1], 17)
  near(t.geom[18 + 1], 12)
})

test('linetypes turn into dash patterns scaled by LTSCALE', () => {
  const scene = buildScene(database({
    header: { LTSCALE: 10 },
    ltypes: [{ name: 'DASHED', pattern: [{ elementLength: 0.5 }, { elementLength: -0.25 }] }],
    entities: [
      ent('LINE', { lineType: 'DASHED', lineTypeScale: 2, startPoint: pt(0, 0), endPoint: pt(100, 0) }),
      ent('LINE', { lineType: 'Continuous', startPoint: pt(0, 1), endPoint: pt(100, 1) })
    ]
  }))
  const dashed = scene.spaces[0].strokes.find(b => b.dash)
  assert.deepEqual(scene.dashes[dashed.dash], [10, 5])
  assert.equal(scene.spaces[0].strokes.filter(b => !b.dash).length, 1)
})

test('fit ignores stray objects far from the drawing', () => {
  const entities = []
  for (let i = 0; i < 400; i++) {
    entities.push(ent('LINE', { startPoint: pt(i % 20, Math.floor(i / 20)), endPoint: pt((i % 20) + 1, Math.floor(i / 20) + 1) }))
  }
  entities.push(ent('LINE', { startPoint: pt(1e7, 1e7), endPoint: pt(1e7 + 1, 1e7) }))
  const model = buildScene(database({ entities })).spaces[0]
  near(model.extents[2], 1e7 + 1)
  assert.deepEqual(model.fit, [0, 0, 20, 20])
})

test('paper-space layouts expose their viewports', () => {
  const sheet = ent('VIEWPORT', { viewportCenter: pt(100, 50), width: 200, height: 100, viewHeight: 100, statusBitFlags: 0 })
  const view = ent('VIEWPORT', {
    viewportCenter: pt(50, 50), width: 80, height: 40, viewHeight: 400, statusBitFlags: 0,
    viewDirection: Z, targetPoint: pt(1000, 2000), displayCenter: { x: 30, y: 40 }, viewTwistAngle: 0, frozenLayerIds: ['10']
  })
  const scene = buildScene(database({
    blocks: [{ name: '*Paper_Space', handle: 'P1', basePoint: pt(0, 0), entities: [sheet, view, ent('LINE', { startPoint: pt(0, 0), endPoint: pt(200, 100) })] }],
    layouts: [{ layoutName: 'Model', tabOrder: 0, paperSpaceTableId: '1F' }, { layoutName: 'Sheet 1', tabOrder: 1, paperSpaceTableId: 'P1' }],
    entities: [ent('LINE', { startPoint: pt(0, 0), endPoint: pt(1, 1) })]
  }))
  assert.deepEqual(scene.spaces.map(s => s.name), ['Model', 'Sheet 1'])
  const [vp] = scene.spaces[1].viewports
  assert.equal(scene.spaces[1].viewports.length, 1)
  // The model point at the view centre lands on the viewport centre at 1:10.
  const m = vp.m
  near(m[0] * 1030 + m[2] * 2040 + m[4], 50)
  near(m[1] * 1030 + m[3] * 2040 + m[5], 50)
  near(m[0], 0.1)
  assert.deepEqual(vp.frozen, [0])
})

test('unsupported and broken entities are counted, not fatal', () => {
  const scene = buildScene(database({
    entities: [
      ent('3DSOLID', {}),
      ent('LINE', {}), // no points: throws inside the converter
      ent('LINE', { startPoint: pt(NaN, 0), endPoint: pt(1, 1) }),
      ent('LINE', { startPoint: pt(0, 0), endPoint: pt(1, 1) })
    ]
  }))
  assert.equal(scene.meta.unsupported['3D solids'], 1)
  assert.equal(scene.meta.errors, 1)
  assert.deepEqual(scene.spaces[0].extents, [0, 0, 1, 1]) // the NaN line is ignored
})
