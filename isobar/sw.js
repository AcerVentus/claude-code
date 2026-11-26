// Offline support. The app shell is cached so Isobar opens without a network;
// weather responses are kept so the last good reading can still be shown
// (the app labels anything stale). Map tiles are never cached here.

const VERSION = 'isobar-v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'vendor/leaflet.css', 'vendor/leaflet.js', 'vendor/astronomy.js', 'manifest.webmanifest',
  'assets/icon.svg', 'assets/fonts/bricolage-grotesque.woff2', 'assets/fonts/instrument-sans.woff2', 'assets/fonts/instrument-sans-ext.woff2', 'assets/fonts/martian-mono.woff2',
  'data/noaa-tide-stations.json',
  'src/main.js', 'src/engine.js',
  'src/lib/aqi.js', 'src/lib/astro.js', 'src/lib/conditions.js', 'src/lib/consensus.js', 'src/lib/http.js', 'src/lib/layers.js', 'src/lib/model.js', 'src/lib/snark.js', 'src/lib/tides.js', 'src/lib/time.js', 'src/lib/units.js',
  'src/providers/brightsky.js', 'src/providers/metno.js', 'src/providers/misc.js', 'src/providers/nws.js', 'src/providers/openmeteo.js', 'src/providers/wttr.js',
  'src/ui/charts.js', 'src/ui/globe.js', 'src/ui/icons.js', 'src/ui/moon.js', 'src/ui/panels-a.js', 'src/ui/panels-b.js', 'src/ui/sky.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // APIs and tiles go straight to the network; the app keeps its own data cache
  // Shell: answer from cache at once, refresh the copy in the background.
  event.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(request, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') });
    const network = fetch(request).then((res) => { if (res.ok) cache.put(request, res.clone()); return res; }).catch(() => null);
    return cached || (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
  }));
});
