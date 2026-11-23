// Text helpers: decoding AutoCAD control codes and estimating string widths.
//
// Widths are estimates because the original SHX/TrueType fonts are not
// available; they only drive word wrapping, culling and extents.

const PERCENT_CODES = { d: '°', p: '±', c: '⌀', '%': '%' }

/** Replace `%%d`-style codes and drop underline/overline toggles. */
export function decodePercentCodes(s) {
  if (!s || s.indexOf('%%') < 0) return s || ''
  return s.replace(/%%(\d{3}|[a-zA-Z%])/g, (m, code) => {
    if (code.length === 3) return String.fromCharCode(parseInt(code, 10))
    const lower = code.toLowerCase()
    if (lower in PERCENT_CODES) return PERCENT_CODES[lower]
    return '' // %%u, %%o, %%k toggles and geometric-tolerance codes
  })
}

const decodeUnicodeEscapes = s =>
  s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))

/**
 * Some pre-2007 files hand back 8-bit text reinterpreted as UTF-16, so two
 * ASCII characters arrive fused into one CJK-looking code unit. Undo that
 * when every unit splits cleanly into printable ASCII.
 */
export function repairFusedAscii(s) {
  if (!s || s.length < 2) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    const lo = code & 0xff
    const hi = code >> 8
    const printable = v => (v >= 0x20 && v < 0x7f) || v === 0x0a || v === 0x09
    if (code < 0x100 && i === s.length - 1 && printable(code)) {
      out += s[i]
    } else if (printable(lo) && printable(hi)) {
      out += String.fromCharCode(lo, hi)
    } else {
      return s
    }
  }
  return out
}

/** Plain single-line text (TEXT, ATTRIB, ATTDEF). */
export function decodePlainText(s) {
  return decodeUnicodeEscapes(decodePercentCodes(s || ''))
}

/**
 * Strip MTEXT inline formatting and return the paragraphs as plain lines.
 * Per-run fonts, colours and heights are dropped; stacked fractions become
 * "a/b".
 */
export function decodeMText(s) {
  if (!s) return ['']
  const lines = []
  let cur = ''
  const n = s.length
  for (let i = 0; i < n; i++) {
    const ch = s[i]
    if (ch === '\\') {
      const next = s[++i]
      if (next === undefined) break
      switch (next) {
        case 'P': case 'X': case 'N':
          lines.push(cur)
          cur = ''
          break
        case '~':
          cur += ' '
          break
        case '\\': case '{': case '}':
          cur += next
          break
        case 'L': case 'l': case 'O': case 'o': case 'K': case 'k':
          break
        case 'U':
          if (s[i + 1] === '+') {
            const hex = s.slice(i + 2, i + 6)
            if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
              cur += String.fromCharCode(parseInt(hex, 16))
              i += 5
            }
          }
          break
        case 'S': {
          const end = s.indexOf(';', i)
          const body = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end)
          cur += body.replace(/\^\s?|#/g, '/').replace(/\\(.)/g, '$1')
          i = end < 0 ? n : end
          break
        }
        case 'f': case 'F': case 'H': case 'h': case 'C': case 'c': case 'T':
        case 'Q': case 'W': case 'A': case 'p': {
          const end = s.indexOf(';', i)
          i = end < 0 ? n : end
          break
        }
        default:
          cur += next
      }
    } else if (ch === '{' || ch === '}') {
      // grouping only
    } else if (ch === '\n') {
      lines.push(cur)
      cur = ''
    } else if (ch === '\r') {
      // ignore
    } else if (ch === '^' && s[i + 1] === 'I') {
      cur += '    '
      i++
    } else if (ch === '^' && s[i + 1] === 'J') {
      lines.push(cur)
      cur = ''
      i++
    } else {
      cur += ch
    }
  }
  lines.push(cur)
  return lines.map(decodePercentCodes)
}

/** Advance width of one character, in units of the text's cap height. */
function charWidth(code) {
  if (code === 0x20 || code === 0xa0) return 0.4
  if (code < 0x80) {
    if (code >= 0x41 && code <= 0x5a) return 0.92 // A-Z
    if (code >= 0x30 && code <= 0x39) return 0.78 // 0-9
    if (code === 0x69 || code === 0x6c || code === 0x49 || code === 0x2e ||
        code === 0x2c || code === 0x27 || code === 0x3a || code === 0x21) return 0.36
    if (code === 0x6d || code === 0x77 || code === 0x4d || code === 0x57) return 1.15
    return 0.76
  }
  if (code >= 0x2e80) return 1.4 // CJK and other wide scripts
  return 0.8
}

/** Estimated width of a string in units of cap height. */
export function estimateWidth(s) {
  let w = 0
  for (let i = 0; i < s.length; i++) w += charWidth(s.charCodeAt(i))
  return w
}

/** Greedy word wrap to `maxWidth` (in cap-height units). */
export function wrapLine(line, maxWidth) {
  if (!(maxWidth > 0) || estimateWidth(line) <= maxWidth) return [line]
  const out = []
  let cur = ''
  let curW = 0
  for (const word of line.split(/(\s+)/)) {
    if (!word) continue
    const w = estimateWidth(word)
    if (cur && curW + w > maxWidth && word.trim()) {
      out.push(cur.replace(/\s+$/, ''))
      cur = ''
      curW = 0
    }
    if (!cur && !word.trim()) continue
    cur += word
    curW += w
  }
  if (cur) out.push(cur.replace(/\s+$/, ''))
  return out.length ? out : ['']
}
