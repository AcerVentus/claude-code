// Refreshes the vendored libraries and fonts from node_modules after `npm install`.
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const copies = [
  ['node_modules/astronomy-engine/esm/astronomy.js', 'vendor/astronomy.js'],
  ['node_modules/leaflet/dist/leaflet-src.esm.js', 'vendor/leaflet.js'],
  ['node_modules/leaflet/dist/leaflet.css', 'vendor/leaflet.css'],
  ['node_modules/leaflet/LICENSE', 'vendor/LICENSE-leaflet.txt'],
  ['node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wdth-normal.woff2', 'assets/fonts/bricolage-grotesque.woff2'],
  ['node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2', 'assets/fonts/instrument-sans.woff2'],
  ['node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-ext-wght-normal.woff2', 'assets/fonts/instrument-sans-ext.woff2'],
  ['node_modules/@fontsource-variable/martian-mono/files/martian-mono-latin-wght-normal.woff2', 'assets/fonts/martian-mono.woff2'],
];
for (const [from, to] of copies) { await copyFile(root + from, root + to); console.log(to); }
// The source map is not shipped; drop the pointer so browsers do not ask for it.
const leaflet = await readFile(root + 'vendor/leaflet.js', 'utf8');
await writeFile(root + 'vendor/leaflet.js', leaflet.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n'));
// Font licences travel with the fonts.
const fonts = ['bricolage-grotesque', 'instrument-sans', 'martian-mono'];
let notices = 'The fonts in this folder are distributed under the SIL Open Font License 1.1.\n';
for (const f of fonts) notices += `\n===== ${f} =====\n${await readFile(`${root}node_modules/@fontsource-variable/${f}/LICENSE`, 'utf8')}`;
await writeFile(root + 'assets/fonts/LICENSES.txt', notices);
