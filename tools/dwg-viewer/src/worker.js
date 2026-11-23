// Worker: parses a DWG/DXF file with LibreDWG (WebAssembly) and converts it
// to render-ready geometry. Each file gets a fresh worker so a failed parse
// or a huge drawing never leaves stale state or memory behind.

import { createModule, Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web'
import { buildScene, sceneTransferables } from './scene.js'

const RELEASES = {
  AC1006: 'R10', AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: '2000',
  AC1018: '2004', AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018'
}

function sniff(bytes, name) {
  const head = String.fromCharCode(...bytes.subarray(0, 6))
  if (/^AC\d{4}$/.test(head)) return { isDxf: false, code: head }
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
  const binaryDxf = text.startsWith('AutoCAD Binary DXF')
  if (binaryDxf || /\bSECTION\b/.test(text) || /\.dxf$/i.test(name)) {
    const m = /\$ACADVER\s+1\s+(AC\d{4})/.exec(text)
    return { isDxf: true, code: m ? m[1] : '' }
  }
  return null
}

// Sections or pages missing, invalid file, I/O error, out of memory.
const CRITICAL_ERRORS = 128 | 256 | 512 | 1024 | 2048 | 4096 | 8192
const DAMAGED = 'The file could not be decoded. It may be damaged, encrypted, or in an unsupported DWG version.'

const progress = stage => self.postMessage({ type: 'progress', stage })

self.onmessage = async event => {
  const { name, file, wasm } = event.data
  try {
    const bytes = new Uint8Array(file)
    const kind = sniff(bytes, name)
    if (!kind) throw new Error('This does not look like a DWG or DXF file.')

    progress('Starting the DWG reader')
    const wasmModule = await createModule({
      wasmBinary: wasm,
      locateFile: f => f,
      print: () => {},
      printErr: () => {}
    })
    const lib = LibreDwg.createByWasmInstance(wasmModule)

    progress('Reading ' + (kind.isDxf ? 'DXF' : 'DWG') + ' data')
    // LibreDWG reports its status through console.warn; capture the code
    // (a bit mask, see CRITICAL_ERRORS) instead of printing it.
    const warn = console.warn
    let readError = 0
    console.warn = (...args) => {
      if (typeof args[1] === 'number') readError |= args[1]
    }
    let db
    try {
      const data = lib.dwg_read_data(file, kind.isDxf ? Dwg_File_Type.DXF : Dwg_File_Type.DWG)
      if (!data) throw new Error(DAMAGED)
      progress('Converting entities')
      db = lib.convert(data)
      lib.dwg_free(data)
    } finally {
      console.warn = warn
    }

    progress('Building geometry')
    const scene = buildScene(db, { isDxf: kind.isDxf })
    scene.meta.format = kind.isDxf ? 'DXF' : 'DWG'
    scene.meta.release = RELEASES[kind.code] || kind.code || ''
    scene.meta.damaged = !!(readError & CRITICAL_ERRORS)
    if (scene.meta.damaged && !scene.spaces.some(s => s.fit)) throw new Error(DAMAGED)
    self.postMessage({ type: 'scene', scene }, sceneTransferables(scene))
  } catch (err) {
    let message = err && err.message ? err.message : String(err)
    if (/memory|out of bounds|unreachable|abort/i.test(message)) {
      message = 'The DWG reader ran out of memory or crashed on this file (' + message + ').'
    }
    self.postMessage({ type: 'error', message })
  }
}
