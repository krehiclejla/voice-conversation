/**
 * Answering question cards by voice.
 *
 * - `findVoiceQuestion` finds the open, answerable question card.
 * - `questionPrompt` is what gets read aloud: the question, then numbered options.
 * - `matchSpokenAnswer` turns what the owner said into option choices
 *   ("two", "the second one", "approve the plan", "recommended") or, when no
 *   option fits, their own words as a custom answer.
 *
 * Restart and secure-input cards are never voice-answered: a misheard word must
 * not restart the platform or fill a secret.
 */

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10,
}
const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'it', 'my', 'me', 'i',
  'let', 'lets', "let's", 'go', 'with', 'please', 'option', 'number', 'choice', 'one',
  'pick', 'choose', 'take', 'want', 'like', 'would', 'is', 'that', 'this',
])

const norm = (t) => String(t || '').toLowerCase().replace(/\(recommended\)/g, ' recommended ')
  .replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim()
const words = (t) => norm(t).split(' ').filter(Boolean)
const cleanLabel = (l) => String(l || '').replace(/\s*\(recommended\)\s*/i, '').trim()
const isRecommended = (l) => /\(recommended\)/i.test(l || '')

/** The open card a spoken reply should answer, or null. */
export function findVoiceQuestion(messages, streamItems, liveQuestionId) {
  const usable = (b) => b?.type === 'question' && !b.answers && !b.platform_action
    && Array.isArray(b.questions) && b.questions.length > 0
  const live = (streamItems || []).find(usable)
  if (live) return live
  if (!liveQuestionId) return null
  const last = [...(messages || [])].reverse().find((m) => m?.role === 'assistant')
  return (last?.blocks || []).find((b) => usable(b) && b.question_id === liveQuestionId) || null
}

/** What to say for one question of a card. */
export function questionPrompt(question, { index = 0, total = 1 } = {}) {
  const options = question.options || []
  const lead = total > 1 ? `Question ${index + 1} of ${total}. ` : ''
  const ask = String(question.question || '').trim()
  if (options.length === 0) return `${lead}${ask} Answer in your own words.`
  const list = options.map((o, i) => (
    `${i + 1}, ${cleanLabel(o.label)}${isRecommended(o.label) ? ', recommended' : ''}.`
  )).join(' ')
  const how = question.multiSelect
    ? 'Say the numbers or names of all that apply, or answer in your own words.'
    : 'Say a number or the option, or answer in your own words.'
  return `${lead}${ask} The options are: ${list} ${how}`
}

function numbersIn(text, count) {
  const found = []
  const list = words(text)
  const hasOrdinal = list.some((w) => /^(last|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/.test(w))
  for (const w of list) {
    // "the second one": the "one" is a pronoun, not option 1.
    if (hasOrdinal && w === 'one') continue
    const n = /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w]
    if (n && n >= 1 && n <= count && !found.includes(n)) found.push(n)
  }
  return found
}

function labelScore(spoken, label) {
  const l = words(cleanLabel(label)).filter((w) => !STOP.has(w))
  if (l.length === 0) return 0
  const s = new Set(words(spoken))
  const hit = l.filter((w) => s.has(w)).length
  // Two distinctive words are enough to name a long label.
  return hit / Math.min(l.length, 3)
}

/**
 * @param {string} text what the owner said
 * @param {{options?: Array<{label: string}>, multiSelect?: boolean}} question
 * @returns {{kind: 'options', labels: string[]} | {kind: 'custom', text: string}}
 */
export function matchSpokenAnswer(text, question) {
  const options = question.options || []
  const spoken = String(text || '').trim()
  const picked = []
  const add = (i) => { if (i >= 0 && i < options.length && !picked.includes(i)) picked.push(i) }

  const n = norm(spoken)
  // A bare ordinal / number statement like "two", "option 2", "the second one".
  const bare = words(spoken).filter((w) => !STOP.has(w) || w === 'one')
  const onlyNumbers = bare.length > 0 && bare.every((w) => /^\d+$/.test(w) || NUMBER_WORDS[w]
    || w === 'and' || w === 'last')
  if (onlyNumbers || /\b(option|number|choice)\s+\w+/.test(n)) {
    for (const k of numbersIn(spoken, options.length)) add(k - 1)
    if (/\blast\b/.test(n)) add(options.length - 1)
  }
  if (picked.length === 0 && /\b(recommended|your recommendation|your pick|your suggestion)\b/.test(n)) {
    add(options.findIndex((o) => isRecommended(o.label)))
  }
  if (picked.length === 0) {
    const scores = options.map((o) => labelScore(spoken, o.label))
    const best = Math.max(0, ...scores)
    if (best >= 0.6) {
      const winners = scores.map((s, i) => [s, i]).filter(([s]) => s === best).map(([, i]) => i)
      // Several equally good matches only count for a multi-select question.
      if (winners.length === 1 || question.multiSelect) winners.forEach(add)
      if (question.multiSelect) {
        scores.forEach((s, i) => { if (s >= 0.6) add(i) })
      }
    }
  }
  if (picked.length === 0) return { kind: 'custom', text: spoken }
  picked.sort((a, b) => a - b)
  const chosen = question.multiSelect ? picked : picked.slice(0, 1)
  return { kind: 'options', labels: chosen.map((i) => options[i].label) }
}

/** "Repeat that", "what were the options?" while a question is open. */
export function isRepeatRequest(text) {
  return /\b(repeat|say (that|it|them) again|again please|what (were|are) the (options|choices)|read (them|the options) (again|out))\b/.test(norm(text))
}

/** Short spoken confirmation of what was understood. */
export function answerAck(match) {
  if (match.kind === 'custom') return 'Okay, got it.'
  return `Okay, ${match.labels.map(cleanLabel).join(' and ')}.`
}
