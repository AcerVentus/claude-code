#!/usr/bin/env node
// Builds dist/dwg-viewer.html: one self-contained file with the UI, the
// parsing worker and the LibreDWG WebAssembly binary all inlined, so it runs
// from a double-click (file://) with no server and no network access.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.join(root, 'node_modules/@mlightcad/libredwg-web')

async function bundle(entry) {
  const result = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    write: false,
    // The Emscripten loader carries a Node.js code path that is never taken
    // in a browser; keep its imports out of the bundle.
    external: ['node:*', 'module', 'fs', 'path', 'url', 'crypto', 'worker_threads'],
    define: { 'import.meta.url': '""' },
    logLevel: 'warning'
  })
  // Keep the code from terminating the <script> element it is inlined into.
  return result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
}

const [appJs, workerJs] = await Promise.all([bundle('src/main.js'), bundle('src/worker.js')])
const wasm = fs.readFileSync(path.join(libDir, 'wasm/libredwg-web.wasm'))
const wasmB64 = zlib.gzipSync(wasm, { level: 9 }).toString('base64')
const libVersion = JSON.parse(fs.readFileSync(path.join(libDir, 'package.json'), 'utf8')).version

const banner = `<!--
  DWG Viewer - offline viewer for AutoCAD .dwg and .dxf drawings.
  Open this file in a browser. Drawings are read locally and never uploaded.

  Includes LibreDWG (https://www.gnu.org/software/libredwg/) compiled to
  WebAssembly via @mlightcad/libredwg-web ${libVersion}. LibreDWG is free
  software under the GNU General Public License v3 or later, so this combined
  file is distributed under the same terms: https://www.gnu.org/licenses/gpl-3.0.html
-->
`

const replacements = { __APP_JS__: appJs, __WORKER_JS__: workerJs, __WASM_GZ_B64__: wasmB64 }
let html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8')
html = html.replace('<!doctype html>\n', '<!doctype html>\n' + banner)
for (const [key, value] of Object.entries(replacements)) {
  if (!html.includes(key)) throw new Error(`placeholder ${key} missing from src/index.html`)
  html = html.replace(key, () => value)
}

const outDir = path.join(root, 'dist')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'dwg-viewer.html')
fs.writeFileSync(outFile, html)
const mb = n => (n / 1048576).toFixed(2) + ' MB'
console.log(`${path.relative(process.cwd(), outFile)}  ${mb(html.length)}  (app ${mb(appJs.length)}, worker ${mb(workerJs.length)}, wasm ${mb(wasmB64.length)})`)
