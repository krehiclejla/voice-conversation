/**
 * Put place names back into recognized speech.
 *
 * The worker's recognizer is a small English model that has never heard most
 * Bosnian place names. It spells what it hears in English ("Sarajevo" comes out
 * as "sarrievo", "saravo", "sarryvo"…; "Tuzla" as "tusler"), and hotwords do
 * not help: they bias toward a spelling, and these spellings do not match the
 * sounds (j sounds like y). Tested 2026-10-08 on Kokoro-spoken fixtures in
 * three voices: 3/27 heard as is, 5/27 with the names as hotwords, and
 * phonetic hotwords made other words worse. So this runs after recognition,
 * for both recognizers, like the name normalizer.
 *
 * A window of one or two words matches a place when it is
 *   'spelling'  the name itself, any case, accents optional ("bihac" → "Bihać");
 *   'known'     an entry of `heard` (forms seen from the recognizer);
 *   'pattern'   one word with the place's `shape`, which no English word has.
 * Ordinary words are never rewritten ("Mostar" is heard as "most are", "Jajce"
 * as "judge": those stay). The voice debug drawer lists every correction, so
 * new mishearings show up there first; add them to `heard`.
 */

export const PLACES = [
  // sarrievo, sarryvo, saravo, sarievo, sirievo, sarriervo, saryevo (not "servo")
  { name: 'Sarajevo', shape: /^s[aeiu]r+[aeiouy]+r?[aeiouyj]*vo$/ },
  // tusler, tuzler, tussla, tozla (not "tussle")
  { name: 'Tuzla', shape: /^t[ou]+[sz]+l(?:a|er|ar|o)$/ },
  { name: 'Banja Luka', heard: ['banya lucca', 'banya luka', 'banalucca', 'banyaluka', 'bania luka', 'bonya luka'] },
  { name: 'Bihać', heard: ['bihak', 'behak', 'beehak', 'bihatch'] },
  { name: 'Mostar' }, { name: 'Zenica' }, { name: 'Jajce' }, { name: 'Travnik' },
  { name: 'Konjic' }, { name: 'Goražde' }, { name: 'Trebinje' }, { name: 'Brčko' },
  { name: 'Bijeljina' }, { name: 'Prijedor' }, { name: 'Ilidža' }, { name: 'Visoko' },
  { name: 'Neum' }, { name: 'Livno' }, { name: 'Cazin' }, { name: 'Srebrenica' },
]

const plain = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z']/g, '')

const LOOKUP = new Map()   // "banya lucca" → { place, method }
for (const place of PLACES) {
  LOOKUP.set(place.name.split(' ').map(plain).join(' '), { place, method: 'spelling' })
  for (const form of place.heard || []) LOOKUP.set(form, { place, method: 'known' })
}

function match(words) {
  const hit = LOOKUP.get(words.join(' '))
  if (hit) return hit
  if (words.length === 1) {
    const place = PLACES.find((p) => p.shape?.test(words[0]))
    if (place) return { place, method: 'pattern' }
  }
  return null
}

/**
 * @param {string} text  recognized speech
 * @returns {{ text: string, corrections: Array<{original:string, corrected:string, method:string}> }}
 */
export function normalizePlaces(text) {
  const source = String(text || '')
  const tokens = [...source.matchAll(/\S+/g)].map((m) => ({
    raw: m[0], start: m.index, end: m.index + m[0].length, word: plain(m[0]).replace(/'s$/, ''),
  })).filter((t) => t.word)
  const corrections = []
  let out = ''
  let cursor = 0
  for (let i = 0; i < tokens.length; i++) {
    for (const size of [2, 1]) {
      const end = i + size
      if (end > tokens.length) continue
      // Punctuation inside the window means separate phrases.
      if (size > 1 && /[,.!?;:]$/.test(tokens[i].raw)) continue
      const hit = match(tokens.slice(i, end).map((t) => t.word))
      if (!hit) continue
      const original = source.slice(tokens[i].start, tokens[end - 1].end)
      const lead = original.match(/^[^\p{L}\p{N}]*/u)[0]
      const trail = original.match(/[^\p{L}\p{N}]*$/u)[0]
      // Keep a possessive: "sarrievo's" → "Sarajevo's".
      const possessive = /'s$/i.test(original.slice(0, original.length - trail.length)) ? "'s" : ''
      const corrected = `${lead}${hit.place.name}${possessive}${trail}`
      out += source.slice(cursor, tokens[i].start) + corrected
      cursor = tokens[end - 1].end
      // Case or accents alone are not worth logging as a mishearing.
      if (hit.method !== 'spelling') corrections.push({ original, corrected, method: `place-${hit.method}` })
      i = end - 1
      break
    }
  }
  return { text: out + source.slice(cursor), corrections }
}
