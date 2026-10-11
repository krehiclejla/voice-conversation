/**
 * Pure text helpers for voice conversation mode: turn streamed markdown into
 * short, speakable chunks.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December']

const SYMBOLS = [
  [/\s*(?:->|→|=>)\s*/g, ' to '],
  [/\s*&\s*/g, ' and '],
  [/\s*≥\s*/g, ' at least '],
  [/\s*≤\s*/g, ' at most '],
  [/\s*~\s*(?=\d)/g, ' about '],
  [/\s*≈\s*/g, ' about '],
  [/\s*×\s*/g, ' times '],
  [/\be\.g\.,?/gi, 'for example,'],
  [/\bi\.e\.,?/gi, 'that is,'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
]

// "Quarter past" style reading is left to the voice; these make the numbers
// and identifiers it would otherwise stumble over unambiguous.
function normalizeSpoken(text) {
  let t = text
  // Links: say where they point, not the whole address.
  t = t.replace(/https?:\/\/(?:www\.)?([^\s/?#)]+)[^\s)]*/g, (_m, host) => `link to ${host}`)
  // ISO dates and times.
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => {
    const month = MONTHS[Number(mo) - 1]
    return month && Number(d) >= 1 && Number(d) <= 31 ? `${month} ${Number(d)}, ${y}` : m
  })
  t = t.replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/g, (_m, h, mi) => (
    mi === '00' ? `${Number(h)} o'clock` : `${Number(h)} ${mi}`
  ))
  // Money, percentages, thousands separators, decimals.
  t = t.replace(/([$€£])\s?(\d[\d,]*(?:\.\d+)?)(k|m|bn|b)?\b/gi, (_m, cur, n, mag) => {
    const unit = { '$': 'dollars', '€': 'euros', '£': 'pounds' }[cur]
    const scale = { k: ' thousand', m: ' million', bn: ' billion', b: ' billion' }[(mag || '').toLowerCase()] || ''
    return `${n.replace(/,/g, '')}${scale} ${unit}`
  })
  t = t.replace(/(\d)%/g, '$1 percent')
  t = t.replace(/\b(\d{1,3}(?:,\d{3})+)\b/g, (m) => m.replace(/,/g, ''))
  t = t.replace(/\b(\d+)\.(\d+)\b(?!\.\d)/g, '$1 point $2')
  // Units glued to numbers.
  t = t.replace(/(\d)\s?ms\b/g, '$1 milliseconds')
  t = t.replace(/(\d)\s?(GB|MB|KB|TB)\b/g, (_m, n, u) => `${n} ${{
    GB: 'gigabytes', MB: 'megabytes', KB: 'kilobytes', TB: 'terabytes',
  }[u]}`)
  // "5s" is five seconds, but "the 1990s", "'90s", "her 30s" are decades and
  // "1800s"/"100s" plurals: those stay as written (the voice reads them well).
  t = t.replace(/(\b(?:the|early|mid|late|her|his|their|my|your|our)\s+)?('?)\b(\d+)(\s?)s\b/gi,
    (m, lead = '', apos, n, space) => {
      const plural = !space && /0$/.test(n) && (n.length === 4 || /00$/.test(n) || apos || (lead && n.length === 2))
      return plural ? m : `${lead}${apos}${n} seconds`
    })
  // Identifiers and paths read as words.
  t = t.replace(/\b([A-Za-z]+(?:_[A-Za-z0-9]+)+)\b/g, (m) => m.replace(/_/g, ' '))
  t = t.replace(/(?:\/[\w.-]+){3,}/g, 'a file path')
  for (const [re, to] of SYMBOLS) t = t.replace(re, to)
  // Emoji and stray symbols the voice would spell out or skip noisily.
  t = t.replace(/\p{Extended_Pictographic}|\u200d|\ufe0f/gu, '')
  t = t.replace(/[#@^=<>{}\\]/g, ' ')
  return t
}

/** Turn markdown into plain text a voice can read naturally. */
export function speechSafeText(markdown) {
  const cleaned = markdown
    // A trailing citations line is for reading, not listening.
    .replace(/\n+\s*sources?:[^\n]*(\n[^\n]*)*$/i, '')
    .replace(/```[\s\S]*?```/g, ' (code omitted). ')
    // Long inline code is noise when read aloud; short names read fine.
    .replace(/`([^`]{25,})`/g, ' some code ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*[-|: ]{3,}$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/[*_~]{1,3}(?=\S)([^*_~]*?)(?<=\S)[*_~]{1,3}/g, '$1')
    .replace(/[*~]{1,3}/g, '')
  return normalizeSpoken(cleaned).replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim()
}

/**
 * Pick the next complete chunk of `text` after offset `from`.
 *
 * While the reply is still streaming only text up to the last sentence or
 * paragraph boundary is released (an unclosed code fence is held back);
 * once `final` is true the remainder is released too. With `eager` (the first
 * chunk of a reply, where the owner is waiting for sound) a long run with no
 * sentence end is released at its last clause break instead.
 *
 * @returns {{ speech: string, consumed: number }} `consumed` is the new offset.
 */
export function nextSpeech(text, from, final, eager = false) {
  let rest = text.slice(from)
  if (!rest) return { speech: '', consumed: from }

  if (!final) {
    const fences = rest.match(/```/g)
    if (fences && fences.length % 2 === 1) {
      rest = rest.slice(0, rest.lastIndexOf('```'))
    }
    // Sentence end followed by whitespace, or any line break.
    const boundary = /[.!?…]+["')\]]*\s|\n/g
    let end = 0
    for (let m = boundary.exec(rest); m; m = boundary.exec(rest)) {
      end = m.index + m[0].length
    }
    if (end === 0 && eager && rest.length >= 40) {
      // No sentence end yet: speak up to the last clause break.
      const clause = /[,;:—–]\s/g
      for (let m = clause.exec(rest); m; m = clause.exec(rest)) end = m.index + m[0].length
    }
    rest = rest.slice(0, end)
  }
  return { speech: speechSafeText(rest), consumed: from + rest.length }
}

const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()

/**
 * True when what the microphone heard is probably the speaker's own output
 * leaking back in, so it must not count as the owner interrupting.
 */
export function isEcho(heard, spoken) {
  const h = normalize(heard)
  if (!h) return true
  const s = normalize(spoken)
  if (s.includes(h)) return true
  // The recognizer mishears its own echo, so also accept text whose words are
  // almost all words just spoken (3+ words, so a short real command such as
  // "wait" or "stop that" is never mistaken for echo).
  const words = h.split(' ')
  if (words.length < 3) return false
  const tail = new Set(s.split(' ').slice(-120))
  const covered = words.filter((w) => tail.has(w)).length
  return covered / words.length >= 0.85
}
