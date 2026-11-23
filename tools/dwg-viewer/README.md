# DWG Viewer

An offline viewer for AutoCAD `.dwg` and `.dxf` drawings. It builds to a
single HTML file (about 3 MB) that you open in a browser. Drawings are parsed
on your own machine with [LibreDWG](https://www.gnu.org/software/libredwg/)
compiled to WebAssembly; nothing is uploaded and no network access is needed.

## Build and run

```bash
npm install
```

```bash
npm run build
```

Then open `dist/dwg-viewer.html` in Chrome, Edge, Firefox or Safari (a
double-click works; no web server is required) and drop a drawing onto the
window. The built file is self-contained, so you can copy it anywhere.

## Using it

| Action | How |
| --- | --- |
| Open a drawing | Drop a file on the window, **Open…**, or `O` |
| Pan | Drag, or arrow keys |
| Zoom | Mouse wheel or pinch, `+` / `-` |
| Zoom to fit | **Fit**, `F`, or double-click the drawing. Shift includes stray far-away objects |
| Inspect an object | Click it: type, layer, block name or text, length, handle |
| Layers | Tick boxes in the side panel; double-click a layer to show only that one; filter by name |
| Layouts | Tabs at the bottom left switch between model space and paper-space sheets |
| Measure | **Measure** or `M`, then click two points. Snaps to ends, corners and centres |
| Background | Half-moon button or `B` toggles dark / light |
| Save an image | **Save PNG** writes the current view |

## What is drawn

DWG R13 through 2018 (AC1012 to AC1032) and DXF, as far as LibreDWG can read
them:

- Lines, polylines (with arcs, widths and tapers), circles, arcs, ellipses,
  splines, points, rays and construction lines
- Text, multiline text and block attributes
- Block references, including nested, mirrored, scaled and arrayed ones
- Dimensions, leaders, multileaders, tables and multilines
- Hatches: solid fills and line patterns
- Layers with their colours and on/off/frozen state, linetype dash patterns,
  ACI and true colours
- Paper-space layouts with model-space viewports

## What is not

- 3D solids, surfaces, regions, OLE objects and proxy objects are skipped;
  the status bar says how many. 3D drawings are shown in plan (top) view only.
- Text uses your system fonts in place of the drawing's SHX or TrueType
  fonts, so string widths differ slightly from AutoCAD. Inline MTEXT
  formatting (per-word fonts, colours, heights) is flattened.
- Raster images and external references are not loaded; images show as a
  crossed frame.
- Lineweights, wipeouts, gradient fills (drawn as flat colour), complex
  linetypes with embedded text or shapes, and non-rectangular viewport
  clipping are not reproduced.
- Very dense hatch patterns fall back to a translucent fill.

It is a viewer: it never modifies or writes drawing files.

## Development

```bash
npm test
```

runs the unit tests for the geometry, text and scene-building code.

```bash
node scripts/inspect.mjs path/to/drawing.dwg
```

parses drawings from the command line and prints what the viewer would draw,
which is handy for checking a batch of files.

| File | Role |
| --- | --- |
| `src/worker.js` | Web worker: runs LibreDWG and converts the result |
| `src/scene.js` | Expands blocks and flattens entities into typed-array batches |
| `src/render.js` | Canvas renderer, picking and snapping |
| `src/main.js`, `src/index.html` | User interface |
| `src/geom.js`, `src/text.js`, `src/aci.js` | Geometry, text decoding, colour palette |
| `build.mjs` | Bundles everything, including the WASM binary, into one HTML file |

## Licence

The viewer links against LibreDWG through
[`@mlightcad/libredwg-web`](https://www.npmjs.com/package/@mlightcad/libredwg-web),
which is licensed under the GNU GPL v3 or later. The built
`dist/dwg-viewer.html` contains LibreDWG, so if you pass that file on to
anyone else, the GPL's terms apply to it. Using it yourself carries no such
obligation.
