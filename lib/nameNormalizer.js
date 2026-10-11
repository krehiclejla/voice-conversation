/**
 * Put the assistant's name back into recognized speech.
 *
 * "Möbius" is not in the recognizers' vocabularies, so it comes out as common
 * words ("more abuse", "Morbius", "Kobius"…). The worker's recognizer is
 * biased toward it (hotwords) but still misses some, and the browser's
 * recognizer cannot be biased at all: this is the safety net for both, and
 * the one place that adds the umlaut the recognizers cannot spell.
 *
 * Over windows of 1-3 words, a match is one of:
 *   'spelling'  mobius / moebius / möbius: always "Möbius";
 *   'pattern'   a single non-word shaped like the name (m-vowel-(r)-b-i-vowel-s:
 *               murbius, mobias…): corrected anywhere, no English word looks so;
 *   'known'     an entry of nameMishearings.js;
 *   'edit'      within two letters of "mobius" (kobius);
 *   'phonetic'  the same consonant skeleton as "mobius" (M-B-S, with a silent
 *               r after a vowel and vowels dropped): "moby us", "more abuse".
 * 'known', 'edit' and 'phonetic' only apply where the name is plainly being
 * said: the whole utterance, or right after "hey"/"okay" with the end of the
 * utterance or a request after it ("hey more abuse, what time is it"); at the
 * very start of an utterance only a close single word ('edit') counts. So
 * "there is more abuse of power" or "okay, more abuse claims came in" are
 * never rewritten.
 */
import { KNOWN_MISHEARINGS, REQUEST_STARTS, WAKE_LEADS } from './nameMishearings.js'

export const NAME = 'Möbius'
const TARGET = 'mobius'
const KNOWN = new Set(KNOWN_MISHEARINGS)
const LEADS = new Set(WAKE_LEADS)
const REQUESTS = new Set(REQUEST_STARTS)
const SPELLINGS = new Set(['mobius', 'moebius', 'möbius'])
const SHAPE = /^m[aeiouy]+r?b[iey][aeou]+s$/

const plain = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z']/g, '')

/** A rough consonant skeleton (a much simplified metaphone). */
export function phoneticKey(text) {
  let s = plain(text).replace(/'/g, '')
  s = s.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's')
  // An r after a vowel is silent in much of English ("more", "Morbius").
  s = s.replace(/([aeiouy])r/g, '$1')
  let key = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if ('aeiouyhw'.includes(c)) continue
    if (key.at(-1) !== c) key += c
  }
  return key.toUpperCase()
}
const TARGET_KEY = phoneticKey(TARGET)

/** Levenshtein distance. */
export function editDistance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/** How `words` (lower case, no punctuation) match the name, or null. */
function matchMethod(words, { addressed, atStart }) {
  const joined = words.join('')
  const spaced = words.join(' ')
  if (words.length === 1 && SPELLINGS.has(joined)) return 'spelling'
  if (words.length === 1 && SHAPE.test(joined)) return 'pattern'
  if (addressed) {
    if (KNOWN.has(spaced)) return 'known'
    if (editDistance(joined, TARGET) <= 2) return 'edit'
    if (phoneticKey(joined) === TARGET_KEY && editDistance(joined, TARGET) <= 4) return 'phonetic'
  } else if (atStart && words.length === 1 && editDistance(joined, TARGET) <= 1 && joined.length >= 5) {
    return 'edit'
  }
  return null
}

/**
 * @param {string} text  recognized speech
 * @returns {{ text: string, corrections: Array<{original:string, corrected:string, method:string}> }}
 */
export function normalizeName(text) {
  const tokens = [...String(text || '').matchAll(/\S+/g)].map((m) => ({
    raw: m[0], start: m.index, end: m.index + m[0].length, word: plain(m[0]),
  })).filter((t) => t.word)
  if (!tokens.length) return { text, corrections: [] }
  const corrections = []
  const replace = []   // [startToken, endToken, method]
  for (let i = 0; i < tokens.length; i++) {
    for (const size of [3, 2, 1]) {
      const end = i + size
      if (end > tokens.length) continue
      // Punctuation inside the window means separate phrases.
      if (tokens.slice(i, end - 1).some((t) => /[,.!?;:]$/.test(t.raw))) continue
      const words = tokens.slice(i, end).map((t) => t.word)
      // "Hey"/"okay" introduce the name; they are never part of it.
      if (size > 1 && LEADS.has(words[0])) continue
      const prev = tokens[i - 1]
      const next = tokens[end]
      const standalone = i === 0 && end === tokens.length
      // Right after "hey"/"okay" that opens the utterance or a new sentence.
      const afterLead = !!prev && LEADS.has(prev.word) && (i === 1 || /[,.!?]$/.test(tokens[i - 2].raw))
      const requestAfter = !next || /[,.!?;:]$/.test(tokens[end - 1].raw) || REQUESTS.has(next.word)
      const addressed = standalone || (afterLead && requestAfter)
      const method = matchMethod(words, { addressed, atStart: i === 0 })
      if (!method) continue
      replace.push([i, end, method])
      i = end - 1
      break
    }
  }
  if (!replace.length) return { text, corrections }
  let out = ''
  let cursor = 0
  const source = String(text)
  for (const [from, to, method] of replace) {
    const first = tokens[from]
    const last = tokens[to - 1]
    const original = source.slice(first.start, last.end)
    const lead = original.match(/^[^\p{L}\p{N}]*/u)[0]
    const trail = original.match(/[^\p{L}\p{N}]*$/u)[0]
    const corrected = `${lead}${NAME}${trail}`
    out += source.slice(cursor, first.start) + corrected
    cursor = last.end
    if (original !== corrected) corrections.push({ original, corrected, method })
  }
  out += source.slice(cursor)
  return { text: out, corrections }
}
