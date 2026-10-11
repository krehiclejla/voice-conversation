/**
 * Known mishearings of the assistant's name, "Möbius", by the speech
 * recognizers. Add new ones here: the voice debug drawer lists every
 * correction (and the JSON export keeps them), so a new mishearing shows up
 * there first. Lower case, words separated by single spaces.
 *
 * Multi-word entries made of real words ("more abuse") are only applied where
 * the name is plainly being said (alone, or after "hey"/"okay" and before a
 * request); see nameNormalizer.js.
 */
export const KNOWN_MISHEARINGS = [
  // Reported by the owner.
  'more abuse', 'mobias', 'mo bius', 'moby us',
  // Heard on Kokoro-spoken fixtures by the streaming Zipformer.
  'morbius', 'murbius', 'murbeus', 'marbius', 'morbias', 'kobius',
  // Spacing and spelling variants.
  'more bius', 'moe bius', 'mow bius', 'mobeus', 'mobus', 'moebius', 'mobius',
]

/** Words before the name that mean "I am talking to you" (incl. misheard ones). */
export const WAKE_LEADS = ['hey', 'hay', 'hi', 'okay', 'ok', 'okey', 'o']

/** Words that start a request: the name before one is being addressed. */
export const REQUEST_STARTS = [
  'what', 'whats', "what's", 'can', 'could', 'would', 'will', 'please', 'tell', 'read', 'open',
  'set', 'start', 'stop', 'play', 'how', 'why', 'who', 'when', 'where', 'is', 'are', 'do',
  'does', 'show', 'find', 'turn', 'call', 'send', 'remind', 'wait', 'add', 'make', 'give',
  'check', 'help', 'are', 'you', 'i', "i'm", 'let', "let's", 'search', 'look',
]
