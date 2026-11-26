// Builds dist/isobar.html: the whole app in one self-contained file that
// opens by double-click (no server, no install). Fonts, styles, scripts, the
// astronomy engine, the map library and the tide-station index are inlined;
// only live weather data and map tiles are fetched at run time.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFile(root + p, 'utf8');
const dataUri = async (p, type) => `data:${type};base64,${(await readFile(root + p)).toString('base64')}`;

const bundle = await build({
  entryPoints: [root + 'src/main.js'], bundle: true, format: 'esm', minify: true, write: false,
  target: ['es2022'], legalComments: 'inline', logLevel: 'warning', // keep the libraries' licence notices
});
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

let css = `${await read('vendor/leaflet.css')}\n${await read('css/app.css')}`;
css = css.replace(/url\(images\/[^)]+\)/g, 'none'); // Leaflet's default marker art is not used
for (const font of ['bricolage-grotesque', 'instrument-sans', 'instrument-sans-ext', 'martian-mono']) {
  css = css.replace(`url(../assets/fonts/${font}.woff2)`, `url(${await dataUri(`assets/fonts/${font}.woff2`, 'font/woff2')})`);
}
if (css.includes('../assets/fonts/')) throw new Error('A font reference was not inlined');

const tides = (await read('data/noaa-tide-stations.json')).replace(/</g, '\\u003c');
const icon = await dataUri('assets/icon.svg', 'image/svg+xml');

let html = await read('index.html');
html = html
  .replace(/\s*<link rel="manifest"[^>]*>/, '')
  .replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="${icon}" type="image/svg+xml">`)
  .replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '')
  .replace(/\s*<link rel="stylesheet" href="vendor\/leaflet.css">/, '')
  .replace('<link rel="stylesheet" href="css/app.css">', () => `<style>${css}</style>`)
  .replace('<script type="module" src="src/main.js"></script>', () =>
    `<script>globalThis.__ISOBAR_SINGLE_FILE__=true;globalThis.__ISOBAR_TIDE_INDEX__=${tides};</script>\n<script type="module">${js}</script>`);
if (html.includes('src="src/main.js"') || html.includes('href="css/app.css"')) throw new Error('index.html changed shape; update scripts/build.mjs');

await mkdir(root + 'dist', { recursive: true });
await writeFile(root + 'dist/isobar.html', html);
console.log(`dist/isobar.html  ${(html.length / 1024).toFixed(0)} kB`);
