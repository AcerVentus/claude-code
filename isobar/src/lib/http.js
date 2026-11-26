// Fetch with a timeout, a short-lived cache and a stale fallback, so that a
// reload does not hammer the free public APIs and a flaky network still shows
// the last good reading (clearly marked as stale by the caller).

const mem = new Map();
const PREFIX = 'isobar:c:';
const MAX_STORED = 160_000; // characters per cached response kept in localStorage
const STALE_LIMIT = 24 * 3600e3;

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function store() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function readCache(url) {
  if (mem.has(url)) return mem.get(url);
  const ls = store();
  if (!ls) return null;
  try {
    const raw = ls.getItem(PREFIX + url);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    mem.set(url, entry);
    return entry;
  } catch { return null; }
}

function writeCache(url, entry) {
  mem.set(url, entry);
  const ls = store();
  if (!ls) return;
  try {
    const raw = JSON.stringify(entry);
    if (raw.length > MAX_STORED) return;
    ls.setItem(PREFIX + url, raw);
  } catch {
    pruneCache(0); // quota: drop everything cached and carry on in memory
  }
}

/** Remove cached responses older than maxAgeMs (0 removes all). */
export function pruneCache(maxAgeMs = STALE_LIMIT) {
  const ls = store();
  if (!ls) return;
  try {
    const now = Date.now();
    const doomed = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      if (maxAgeMs === 0) { doomed.push(k); continue; }
      try {
        const { t } = JSON.parse(ls.getItem(k));
        if (!(now - t < maxAgeMs)) doomed.push(k);
      } catch { doomed.push(k); }
    }
    doomed.forEach((k) => ls.removeItem(k));
  } catch { /* storage unavailable */ }
}

/**
 * GET a JSON document.
 * @returns {Promise<{data:any, fetchedAt:number, stale:boolean, ms:number}>}
 */
export async function getJson(url, { ttl = 10 * 60e3, timeout = 15000, force = false } = {}) {
  const now = Date.now();
  const cached = readCache(url);
  if (!force && cached && now - cached.t < ttl) {
    return { data: cached.d, fetchedAt: cached.t, stale: false, ms: 0 };
  }
  const started = Date.now();
  // One retry for dropped connections and overloaded servers; never for a definite answer.
  const attempt = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
      const text = await res.text();
      try { return JSON.parse(text); } catch { throw new HttpError('Response was not JSON', res.status); }
    } catch (err) {
      if (err.name === 'AbortError') throw new HttpError('Timed out', 0);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  const retryable = (err) => !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
  try {
    let data;
    try {
      data = await attempt();
    } catch (err) {
      if (!retryable(err)) throw err;
      await new Promise((r) => setTimeout(r, 600));
      data = await attempt();
    }
    const entry = { t: Date.now(), d: data };
    writeCache(url, entry);
    return { data, fetchedAt: entry.t, stale: false, ms: Date.now() - started };
  } catch (err) {
    // A definite "no data here" answer is not worth papering over with old data.
    const definite = err instanceof HttpError && [400, 404, 422].includes(err.status);
    if (!definite && cached && now - cached.t < STALE_LIMIT) {
      return { data: cached.d, fetchedAt: cached.t, stale: true, ms: Date.now() - started };
    }
    throw err;
  }
}

/** Coordinates as sent to providers: 3 decimals (~100 m) is ample for weather and kinder to privacy and caches. */
export function coord(v) {
  return (Math.round(v * 1000) / 1000).toFixed(3);
}

export function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : v).replace(/%2C/g, ',')}`)
    .join('&');
}
