#!/usr/bin/env node
// Parse drawings from the command line and print what the viewer would draw.
// Usage: node scripts/inspect.mjs file.dwg [more.dxf ...]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web'
import { buildScene } from '../src/scene.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export async function loadLibrary() {
  return LibreDwg.create(path.join(root, 'node_modules/@mlightcad/libredwg-web/wasm'))
}

export function readScene(lib, file) {
  const buf = fs.readFileSync(file)
  const isDxf = /\.dxf$/i.test(file)
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const warn = console.warn
  console.warn = () => {}
  try {
    const data = lib.dwg_read_data(bytes, isDxf ? Dwg_File_Type.DXF : Dwg_File_Type.DWG)
    if (!data) throw new Error('not a readable DWG/DXF file')
    const db = lib.convert(data)
    lib.dwg_free(data)
    return buildScene(db, { isDxf })
  } finally {
    console.warn = warn
  }
}

function summarize(space) {
  let polylines = 0, arcs = 0, hatchLines = 0, fills = 0
  for (const b of space.strokes) {
    polylines += b.ent.length
    arcs += b.arcEnt.length
    hatchLines += b.segs.length / 4
  }
  for (const b of space.fills) fills += b.ent.length
  const box = space.fit ? space.fit.map(v => Number(v.toFixed(2))).join(', ') : 'empty'
  return `${space.name}: ${space.ents.type.length} entities -> ${polylines} polylines, ${arcs} arcs, ` +
    `${hatchLines} hatch lines, ${fills} fills, ${space.text.str.length} texts, ` +
    `${space.viewports.length} viewports; fit [${box}]`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.error('usage: node scripts/inspect.mjs file.dwg [...]')
    process.exit(2)
  }
  const lib = await loadLibrary()
  let failed = 0
  for (const file of files) {
    try {
      const t0 = performance.now()
      const scene = readScene(lib, file)
      const ms = (performance.now() - t0).toFixed(0)
      console.log(`${path.basename(file)}  (${scene.meta.version || 'unknown version'}, ${scene.layers.length} layers, ${ms} ms)`)
      for (const space of scene.spaces) console.log('  ' + summarize(space))
      const skipped = Object.entries(scene.meta.unsupported).map(([k, v]) => `${v} ${k}`).join(', ')
      if (skipped) console.log('  not drawn: ' + skipped)
      if (scene.meta.errors) console.log(`  ${scene.meta.errors} entities failed to convert`)
    } catch (err) {
      failed++
      console.log(`${path.basename(file)}  FAILED: ${err.message}`)
    }
  }
  process.exit(failed ? 1 : 0)
}
