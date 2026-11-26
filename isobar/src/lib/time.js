// Time-zone aware helpers. Everything internal is UTC milliseconds; a location's
// IANA zone is applied only when formatting or when cutting days.

const HOUR = 3600e3;
const DAY = 86400e3;
export { HOUR, DAY };

const cache = new Map();
function dtf(tz, opts) {
  const key = tz + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts });
    cache.set(key, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(ms, tz) {
  const f = dtf(tz, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  });
  const p = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    y: +p.year, m: +p.month, d: +p.day,
    h: +p.hour % 24, min: +p.minute, s: +p.second,
    weekday: p.weekday,
  };
}

/** Offset (ms) to add to UTC to get wall-clock time in the zone at that instant. */
export function tzOffsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC instant of a wall-clock time in a zone. A time that happens twice (clocks
 * going back) resolves to its first occurrence; a time that never happens
 * (clocks going forward) resolves to the instant the clocks jump, so the start
 * of a day is always the first instant that carries that date.
 */
export function zonedToUtc(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const a = guess - tzOffsetMs(guess, tz);
  const b = guess - tzOffsetMs(a, tz);
  if (a === b) return a;
  const matches = (t) => { const p = zonedParts(t, tz); return p.y === y && p.m === m && p.d === d && p.h === h && p.min === min; };
  const okA = matches(a), okB = matches(b);
  if (okA && okB) return Math.min(a, b);
  if (okA) return a;
  if (okB) return b;
  return Math.max(a, b);
}

/** Start of the current local hour (zones with :30 and :45 offsets do not share UTC's hour marks). */
export function hourStart(ms, tz) {
  const off = tz ? tzOffsetMs(ms, tz) : 0;
  return Math.floor((ms + off) / HOUR) * HOUR - off;
}

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of an instant in a zone. */
export function dateKey(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** UTC instant of local midnight that starts the given date key in a zone. */
export function keyToStart(key, tz) {
  const [y, m, d] = key.split('-').map(Number);
  return zonedToUtc(y, m, d, 0, 0, tz);
}

export function startOfDay(ms, tz) {
  return keyToStart(dateKey(ms, tz), tz);
}

/** Shift a date key by whole calendar days. */
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Clock time, e.g. "14:05" or "2:05 pm". */
export function fmtTime(ms, tz, h12 = false) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (!h12) {
    const p = zonedParts(ms, tz);
    return `${pad(p.h)}:${pad(p.min)}`;
  }
  return dtf(tz, { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms)).replace(' ', ' ');
}

/** Hour label for strips, e.g. "14" or "2 pm". */
export function fmtHour(ms, tz, h12 = false) {
  const p = zonedParts(ms, tz);
  if (!h12) return pad(p.h);
  const h = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h} ${p.h < 12 ? 'am' : 'pm'}`;
}

export function fmtWeekday(ms, tz, long = false) {
  return dtf(tz, { weekday: long ? 'long' : 'short' }).format(new Date(ms));
}

/** "26 Nov" */
export function fmtDayMonth(ms, tz) {
  return dtf(tz, { day: 'numeric', month: 'short' }).format(new Date(ms));
}

/** "Thu 26 Nov, 14:05" */
export function fmtDateTime(ms, tz, h12 = false) {
  return `${fmtWeekday(ms, tz)} ${fmtDayMonth(ms, tz)}, ${fmtTime(ms, tz, h12)}`;
}

/** Duration like "10 h 45 min" (rounded to the minute). */
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const total = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${pad(m)} min`;
}

/** Relative phrase like "in 25 min", "3 h ago". */
export function fmtRelative(ms, now) {
  const diff = ms - now;
  const mins = Math.round(Math.abs(diff) / 60000);
  let body;
  if (mins < 1) return 'now';
  if (mins < 60) body = `${mins} min`;
  else if (mins < 48 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    body = m && h < 6 ? `${h} h ${m} min` : `${Math.round(mins / 60)} h`;
  } else body = `${Math.round(mins / 1440)} d`;
  return diff >= 0 ? `in ${body}` : `${body} ago`;
}

/** Parse "…T…Z" or offset ISO strings to ms; returns null when invalid. */
export function parseIso(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** ISO-8601 duration ("PT3H", "P2DT23H", "PT30M") to ms. */
export function parseIsoDuration(s) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s || '');
  if (!m) return null;
  const [, w, d, h, min, sec] = m;
  return ((+w || 0) * 7 * 24 + (+d || 0) * 24 + (+h || 0)) * HOUR + (+min || 0) * 60e3 + (+sec || 0) * 1e3;
}
