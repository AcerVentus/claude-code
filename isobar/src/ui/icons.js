// Line icons drawn on a 24-unit grid. Strokes take the current text colour;
// the sun, moon and lightning take the accent tokens through CSS classes.

const CLOUD = 'M7.5 18.5a4 4 0 0 1-.6-7.96 5.5 5.5 0 0 1 10.63 1.02A3.5 3.5 0 0 1 17 18.5Z';
const CLOUD_HIGH = 'M7.5 15.5a4 4 0 0 1-.6-7.96 5.5 5.5 0 0 1 10.63 1.02A3.5 3.5 0 0 1 17 15.5Z';

const sun = (cx, cy, r, ray) => {
  let rays = '';
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * (r + 1.8), y1 = cy + Math.sin(a) * (r + 1.8);
    const x2 = cx + Math.cos(a) * (r + 1.8 + ray), y2 = cy + Math.sin(a) * (r + 1.8 + ray);
    rays += `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }
  return `<g class="i-sun"><circle cx="${cx}" cy="${cy}" r="${r}"/><path d="${rays}"/></g>`;
};
const moon = (s = 1, tx = 0, ty = 0) => `<path class="i-moon" transform="translate(${tx} ${ty}) scale(${s})" d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>`;
const drops = (xs, y1, y2, cls = 'i-rain') => `<path class="${cls}" d="${xs.map((x) => `M${x} ${y1}l-1.2 ${y2 - y1}`).join('')}"/>`;
const flakes = (pts) => `<g class="i-snow">${pts.map(([x, y]) => `<path d="M${x - 1.1} ${y}h2.2M${x} ${y - 1.1}v2.2"/>`).join('')}</g>`;
const peekSun = `<g transform="translate(-1.5 -2.5)">${sun(8, 8.5, 2.6, 1.3)}</g>`;
const peekMoon = moon(0.5, -0.5, 0.5);
const lowCloud = `<path class="i-cloud" transform="translate(1.5 1.5)" d="${CLOUD}"/>`;

const ICONS = {
  clear: (day) => (day ? sun(12, 12, 4.2, 2.2) : moon()),
  fair: (day) => `${day ? peekSun : peekMoon}<path class="i-cloud i-thin" transform="translate(4.5 6.2) scale(0.72)" d="${CLOUD}"/>`,
  partly: (day) => `${day ? peekSun : peekMoon}${lowCloud}`,
  cloudy: () => `<path class="i-cloud i-back" transform="translate(5.2 -3.4) scale(0.72)" d="${CLOUD}"/>${lowCloud}`,
  fog: () => `<path class="i-cloud" d="${CLOUD_HIGH}"/><path class="i-fog" d="M5 19h14M7.5 22h9"/>`,
  drizzle: () => `<path class="i-cloud" d="${CLOUD_HIGH}"/>${drops([10, 14.5], 18.2, 21.2)}`,
  rain: () => `<path class="i-cloud" d="${CLOUD_HIGH}"/>${drops([8.5, 12.5, 16.5], 18.2, 22)}`,
  heavy: () => `<path class="i-cloud" d="${CLOUD_HIGH}"/>${drops([7.5, 10.7, 13.9, 17.1], 18, 22.6, 'i-rain i-bold')}`,
  sleet: () => `<path class="i-cloud" d="${CLOUD_HIGH}"/>${drops([9, 16], 18.2, 21.6)}${flakes([[12.3, 20.4]])}`,
  snow: () => `<path class="i-cloud" d="${CLOUD_HIGH}"/>${flakes([[8.5, 19.6], [12.2, 21.6], [15.9, 19.6]])}`,
  thunder: () => `<path class="i-cloud" d="${CLOUD_HIGH}"/><path class="i-bolt" d="M12.8 16.2l-2.6 3.6h3l-1.6 3.4"/>${drops([7.6, 17], 18.2, 21.2)}`,
};

/** Weather icon by internal icon name. */
export function weatherIcon(name, isDay = true, size = 28, label = '') {
  const draw = ICONS[name] || ICONS.cloudy;
  const aria = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="wx-icon" width="${size}" height="${size}" viewBox="0 0 24 24" ${aria}>${draw(isDay)}</svg>`;
}

const UI = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  locate: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 4.2v4.2h-4.2"/>',
  settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  pin: '<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.400 6.500 11 6.500 11z"/><circle cx="12" cy="10" r="2.3"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.8 2.6 2.8 14.400 0 17M12 3.500c-2.800 2.600-2.800 14.400 0 17"/>',
  home: '<path d="M4 11.500l8-7 8 7"/><path d="M6.500 10v9h11v-9"/>',
  play: '<path d="M8 5.500v13l10.500-6.500z"/>',
  pause: '<path d="M8 5.500v13M16 5.500v13"/>',
  layers: '<path d="M12 4l8.500 4.500L12 13 3.500 8.500z"/><path d="M3.500 12.500L12 17l8.500-4.500M3.500 16.500L12 21l8.500-4.500"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  alert: '<path d="M12 4.500l8.500 15h-17z"/><path d="M12 10.500v4M12 17.200v.3"/>',
  info: '<circle cx="12" cy="12" r="8.500"/><path d="M12 11v5.500M12 7.700v.3"/>',
  up: '<path d="M12 19V5.500M6.500 11L12 5.500l5.500 5.500"/>',
  down: '<path d="M12 5v13.500M6.500 13l5.500 5.500 5.500-5.500"/>',
  steady: '<path d="M4.500 12h15M14 6.500l5.500 5.500-5.500 5.500"/>',
  trash: '<path d="M5 7h14M10 7V4.500h4V7M7 7l.8 12.500h8.400L17 7"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
};
export function uiIcon(name, size = 18) {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${UI[name] || ''}</svg>`;
}

/** Arrow pointing the way the wind or waves are travelling (bearing given as "from"). */
export function fromArrow(fromDeg, size = 14) {
  const rot = ((fromDeg ?? 0) + 180) % 360;
  return `<svg class="dir-arrow" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(${rot.toFixed(0)} 12 12)"><path d="M12 20V5M6.500 10.500L12 5l5.500 5.500"/></g></svg>`;
}
