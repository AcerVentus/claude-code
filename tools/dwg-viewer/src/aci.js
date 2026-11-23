// AutoCAD Color Index (ACI) palette, generated rather than tabulated.
//
// Indices 1-9 are fixed named colours, 10-249 are 24 hues x 5 shades x
// (full, half-saturated), and 250-255 are a grey ramp. This reproduces the
// standard palette exactly for the pure hues and to within a couple of
// 8-bit steps elsewhere, which is all a viewer needs.

/** Colour value meaning "the foreground colour" (white on dark, black on light). */
export const FOREGROUND = -1

const FIXED = [
  0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff,
  0xffffff, 0x808080, 0xc0c0c0
]
const SHADES = [1, 0.65, 0.5, 0.3, 0.15]
const GREYS = [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff]

function hueToRgb(hue) {
  const h = hue / 60
  const x = 1 - Math.abs((h % 2) - 1)
  switch (Math.floor(h) % 6) {
    case 0: return [1, x, 0]
    case 1: return [x, 1, 0]
    case 2: return [0, 1, x]
    case 3: return [0, x, 1]
    case 4: return [x, 0, 1]
    default: return [1, 0, x]
  }
}

export const ACI = new Int32Array(257)
for (let i = 0; i < 10; i++) ACI[i] = FIXED[i]
for (let i = 10; i < 250; i++) {
  const hue = Math.floor((i - 10) / 10) * 15
  const shade = SHADES[Math.floor(((i - 10) % 10) / 2)]
  const pastel = i % 2 === 1
  const rgb = hueToRgb(hue).map(v => {
    const c = pastel ? v + (1 - v) * 0.5 : v
    return Math.round(c * shade * 255)
  })
  ACI[i] = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
}
for (let i = 250; i < 256; i++) ACI[i] = GREYS[i - 250]
ACI[256] = 0xffffff

/** Resolve an ACI index to a colour, mapping 7 to the adaptive foreground. */
export function aciToColor(index) {
  if (index === 7) return FOREGROUND
  if (index >= 1 && index <= 255) return ACI[index]
  return FOREGROUND
}
