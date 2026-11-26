// Sun and Moon, computed locally with astronomy-engine (VSOP87 / ELP-based,
// accurate to about an arc-minute). Results are cross-checked at runtime
// against MET Norway's Sunrise service and Open-Meteo's sunrise/sunset.

import * as A from '../../vendor/astronomy.js';
import { DAY } from './time.js';

const RAD = Math.PI / 180;
const norm360 = (d) => ((d % 360) + 360) % 360;
const ms = (astroTime) => (astroTime ? astroTime.date.getTime() : null);

function observer(lat, lon, elev = 0) {
  return new A.Observer(lat, lon, Math.max(0, elev || 0));
}

function alt(body, obs, t) {
  const date = new Date(t);
  const eq = A.Equator(body, date, obs, true, true);
  return A.Horizon(date, obs, eq.ra, eq.dec, 'normal');
}

/** Altitude/azimuth (degrees, with standard refraction) of the Sun or Moon. */
export function position(body, t, lat, lon, elev = 0) {
  const h = alt(body === 'moon' ? A.Body.Moon : A.Body.Sun, observer(lat, lon, elev), t);
  return { altitude: h.altitude, azimuth: h.azimuth };
}

/** Altitude samples across a window, for the sky-path chart. */
export function altitudeSeries(body, startMs, endMs, stepMin, lat, lon) {
  const obs = observer(lat, lon);
  const b = body === 'moon' ? A.Body.Moon : A.Body.Sun;
  const out = [];
  for (let t = startMs; t <= endMs + 1; t += stepMin * 60e3) {
    const h = alt(b, obs, t);
    out.push({ t, altitude: h.altitude, azimuth: h.azimuth });
  }
  return out;
}

function within(t, a, b) {
  return t != null && t >= a && t < b ? t : null;
}

/**
 * Sun events for one local day [dayStart, dayEnd). Any event that does not
 * happen that day (polar day / polar night) is null.
 */
export function sunDay(dayStart, dayEnd, lat, lon, elev = 0) {
  const obs = observer(lat, lon, elev);
  const S = A.Body.Sun;
  const span = (dayEnd - dayStart) / DAY;
  const start = new Date(dayStart);

  const noonEv = A.SearchHourAngle(S, obs, 0, start);
  const solarNoon = within(ms(noonEv.time), dayStart, dayEnd);
  const noonAltitude = noonEv.hor.altitude;

  const sunrise = within(ms(A.SearchRiseSet(S, obs, +1, start, span)), dayStart, dayEnd);
  // The first sunset after local midnight can belong to the previous day at
  // high latitudes; the day's sunset is the one that follows its sunrise.
  const setFrom = sunrise ?? dayStart;
  const sunset = within(ms(A.SearchRiseSet(S, obs, -1, new Date(setFrom), (dayEnd - setFrom) / DAY)), dayStart, dayEnd);

  const up = (altitude) => within(ms(A.SearchAltitude(S, obs, +1, start, span, altitude)), dayStart, dayEnd);
  const down = (altitude) => {
    const from = solarNoon ?? dayStart;
    return within(ms(A.SearchAltitude(S, obs, -1, new Date(from), (dayEnd - from) / DAY, altitude)), dayStart, dayEnd);
  };

  const result = {
    sunrise, sunset, solarNoon, noonAltitude,
    civilDawn: up(-6), civilDusk: down(-6),
    nauticalDawn: up(-12), nauticalDusk: down(-12),
    astroDawn: up(-18), astroDusk: down(-18),
    goldenMorningEnd: up(6), goldenEveningStart: down(6),
    dayLength: sunrise != null && sunset != null && sunset > sunrise ? sunset - sunrise : null,
    polar: null,
  };
  if (sunrise == null && sunset == null) {
    result.polar = noonAltitude > -0.833 ? 'day' : 'night';
    result.dayLength = result.polar === 'day' ? dayEnd - dayStart : 0;
  }
  return result;
}

/** Name of the light right now, from the Sun's altitude. */
export function lightPhase(altitude, rising) {
  if (altitude >= 6) return 'day';
  if (altitude >= -0.833) return rising ? 'sunrise' : 'sunset';
  if (altitude >= -6) return rising ? 'dawn' : 'dusk';
  if (altitude >= -12) return 'nautical';
  if (altitude >= -18) return 'astronomical';
  return 'night';
}

const PHASE_NAMES = [
  'New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
  'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent',
];
// The Moon gains about 12.19° of elongation a day, so ±6.1° is "the day of".
const PRINCIPAL_WINDOW = 6.1;

export function phaseName(phaseDeg) {
  const p = norm360(phaseDeg);
  for (const [center, idx] of [[0, 0], [90, 2], [180, 4], [270, 6], [360, 0]]) {
    if (Math.abs(p - center) <= PRINCIPAL_WINDOW) return PHASE_NAMES[idx];
  }
  if (p < 90) return PHASE_NAMES[1];
  if (p < 180) return PHASE_NAMES[3];
  if (p < 270) return PHASE_NAMES[5];
  return PHASE_NAMES[7];
}

/** Position angle of point B as seen from point A (both RA hours / Dec degrees), north through east. */
function positionAngle(raA, decA, raB, decB) {
  const dRa = (raB - raA) * 15 * RAD;
  const dA = decA * RAD, dB = decB * RAD;
  return norm360(Math.atan2(
    Math.cos(dB) * Math.sin(dRa),
    Math.sin(dB) * Math.cos(dA) - Math.cos(dB) * Math.sin(dA) * Math.cos(dRa),
  ) / RAD);
}

/**
 * Everything needed to describe and draw the Moon as this observer sees it.
 * Angles named *FromZenith are measured anticlockwise from "straight up" in
 * the observer's sky, which is how the disc is drawn on screen.
 */
export function moonNow(t, lat, lon) {
  const date = new Date(t);
  const obs = observer(lat, lon);
  const phaseDeg = A.MoonPhase(date);
  const ill = A.Illumination(A.Body.Moon, date);
  const lib = A.Libration(date);

  const moon = A.Equator(A.Body.Moon, date, obs, true, true);
  const sun = A.Equator(A.Body.Sun, date, obs, true, true);
  const hor = A.Horizon(date, obs, moon.ra, moon.dec, 'normal');

  // Parallactic angle: celestial north → zenith, measured at the Moon.
  const lst = A.SiderealTime(date) + lon / 15;
  const H = (lst - moon.ra) * 15 * RAD;
  const phi = lat * RAD, dec = moon.dec * RAD;
  const q = Math.atan2(Math.sin(H), Math.tan(phi) * Math.cos(dec) - Math.sin(dec) * Math.cos(H)) / RAD;

  // Bright limb: direction of the Sun from the Moon on the sky.
  const chi = positionAngle(moon.ra, moon.dec, sun.ra, sun.dec);

  // Lunar north pole, rotated from J2000 into the equator of date.
  const axis = A.RotationAxis(A.Body.Moon, date);
  const north = A.RotateVector(A.Rotation_EQJ_EQD(date), axis.north);
  const pole = A.EquatorFromVector(north);
  const P = positionAngle(moon.ra, moon.dec, pole.ra, pole.dec);

  const prevNew = ms(A.SearchMoonPhase(0, date, -35));

  return {
    phaseDeg,
    waxing: phaseDeg < 180,
    illumination: ill.phase_fraction,
    phaseAngle: ill.phase_angle,
    name: phaseName(phaseDeg),
    ageDays: prevNew != null ? (t - prevNew) / DAY : null,
    distanceKm: lib.dist_km,
    diameterDeg: lib.diam_deg,
    librationLat: lib.elat,
    librationLon: lib.elon,
    altitude: hor.altitude,
    azimuth: hor.azimuth,
    parallacticAngle: q,
    limbFromZenith: norm360(chi - q),
    poleFromZenith: norm360(P - q),
  };
}

/** Moonrise / moonset inside one local day; either can be null. */
export function moonDay(dayStart, dayEnd, lat, lon) {
  const obs = observer(lat, lon);
  const span = (dayEnd - dayStart) / DAY;
  const start = new Date(dayStart);
  return {
    rise: within(ms(A.SearchRiseSet(A.Body.Moon, obs, +1, start, span)), dayStart, dayEnd),
    set: within(ms(A.SearchRiseSet(A.Body.Moon, obs, -1, start, span)), dayStart, dayEnd),
  };
}

/** Next rise and set after t (searching up to two days ahead). */
export function moonNext(t, lat, lon) {
  const obs = observer(lat, lon);
  const date = new Date(t);
  return {
    rise: ms(A.SearchRiseSet(A.Body.Moon, obs, +1, date, 2)),
    set: ms(A.SearchRiseSet(A.Body.Moon, obs, -1, date, 2)),
  };
}

const QUARTER_NAMES = ['New Moon', 'First Quarter', 'Full Moon', 'Last Quarter'];

/** The next `count` principal phases after t. */
export function moonQuarters(t, count = 4) {
  const out = [];
  let mq = A.SearchMoonQuarter(new Date(t));
  for (let i = 0; i < count; i++) {
    out.push({ quarter: mq.quarter, name: QUARTER_NAMES[mq.quarter], time: ms(mq.time) });
    mq = A.NextMoonQuarter(mq);
  }
  return out;
}

/** Next perigee and apogee after t. */
export function moonApsides(t) {
  let ap = A.SearchLunarApsis(new Date(t));
  const out = {};
  for (let i = 0; i < 2; i++) {
    out[ap.kind === 0 ? 'perigee' : 'apogee'] = { time: ms(ap.time), distanceKm: ap.dist_km };
    ap = A.NextLunarApsis(ap);
  }
  return out;
}

/**
 * Where the tide cycle stands, from the Sun–Moon elongation alone: tidal range
 * is largest shortly after new and full Moon (springs) and smallest after the
 * quarters (neaps).
 */
export function tideCycle(phaseDeg) {
  const fromSyzygy = Math.abs(((norm360(phaseDeg) + 90) % 180) - 90); // 0 at new/full, 90 at quarters
  if (fromSyzygy <= 30) return { key: 'spring', label: 'Spring tides', note: 'Large range around new and full Moon' };
  if (fromSyzygy >= 60) return { key: 'neap', label: 'Neap tides', note: 'Small range around the quarter Moons' };
  return { key: 'mid', label: 'Mid-cycle tides', note: 'Range between springs and neaps' };
}
