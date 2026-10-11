import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Plus, SoundOnReadOutLoudSpeaker, Stop } from '@openai/apps-sdk-ui/components/Icon'
import { speechSafeText, nextSpeech } from './lib/voiceSpeech.js'
import { normalizeName } from './lib/nameNormalizer.js'
import { normalizePlaces } from './lib/placeNames.js'
import { createVoiceEngine } from './lib/voiceEngine.js'
import { questionPrompt, matchSpokenAnswer, isRepeatRequest, answerAck } from './lib/voiceAnswer.js'

// Push-to-talk voice conversation that carries everything it needs: the app's
// own server turns speech into text (the same recognizer Möbius's built-in
// voice uses), the agent answers in an ordinary chat that appears in Recents,
// and the voice chosen in the Voice app reads the answer aloud.

const MAX_CLIP_MS = 60_000      // the longest recording an app may ask for
const HOLD_MS = 350             // a press longer than this is hold-to-talk; shorter toggles
const TARGET_RATE = 16000
const CURRENT_KEY = 'current.json'

// The same spoken style Möbius's built-in voice mode asks of the agent.
const VOICE_STYLE = 'The owner is talking with you by voice through the Voice Conversation app, and '
  + 'your reply is read aloud. Talk the way a person talks in a relaxed conversation: contractions, '
  + 'everyday words, short sentences, a warm natural tone, and a human reaction when it fits '
  + '(surprise, sympathy, a little humour). Do not open with filler like "Sure!" or "Great question"; '
  + 'go straight into it, though a natural spoken lead-in ("So,", "Oh, that one\'s easy —", "Hmm, '
  + 'honestly,") is fine when it fits. Keep it short: lead with the answer, usually one to three '
  + 'sentences. If you need tools before you can answer, first say one short sentence about what you '
  + 'are checking so they are not left in silence. No markdown, headings, lists, tables or code blocks, '
  + 'and do not read out links or file paths. If the answer needs real detail (a long list, code, '
  + 'several links), give the gist and offer to put the details in the chat for them to read. Say '
  + 'numbers and dates the way you would speak them.'

const CSS = `
  * { box-sizing: border-box; }
  .vc-root {
    height: 100%; min-height: 100%; display: flex; flex-direction: column;
    color: var(--text); background: var(--bg); font-family: var(--font);
  }
  .vc-head {
    flex: none; display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
  }
  .vc-title { margin: 0; font-size: 16px; font-weight: 650; flex: 1; min-width: 0; }
  .vc-voice {
    display: inline-flex; align-items: center; gap: 6px; max-width: 46%;
    font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .vc-new {
    flex: none; min-height: 36px; padding: 0 12px; border-radius: 10px;
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    font: inherit; font-size: 13px; color: var(--text);
    background: var(--surface); border: 1px solid var(--border);
  }
  .vc-new:focus-visible, .vc-talk:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  .vc-chat { flex: 1; min-height: 0; position: relative; }
  .vc-chat-mount { position: absolute; inset: 0; }
  .vc-empty {
    position: absolute; inset: 0; display: grid; place-items: center; padding: 24px;
    text-align: center; color: var(--muted);
  }
  .vc-empty h2 { margin: 0 0 6px; font-size: 20px; color: var(--text); font-weight: 650; }
  .vc-empty p { margin: 0 auto; max-width: 320px; font-size: 14px; line-height: 1.5; }
  .vc-dock {
    flex: none; display: flex; flex-direction: column; align-items: center; gap: 10px;
    padding: 14px 16px 22px; border-top: 1px solid var(--border); background: var(--bg);
  }
  .vc-caption {
    min-height: 20px; max-width: 520px; font-size: 14px; line-height: 1.4; text-align: center;
    color: var(--muted); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .vc-caption.is-error { color: #d0453b; }
  .vc-talk {
    --level: 0;
    position: relative; width: 84px; height: 84px; border-radius: 50%; border: 0;
    display: grid; place-items: center; cursor: pointer; touch-action: none; user-select: none;
    -webkit-user-select: none; -webkit-touch-callout: none;
    color: #fff; background: linear-gradient(160deg, #7c5cff, #2ab6d6);
    box-shadow: 0 8px 26px rgba(92, 110, 255, .33);
    transition: transform .12s ease, filter .2s ease;
  }
  .vc-talk::before {
    content: ''; position: absolute; inset: -8px; border-radius: 50%;
    border: 3px solid #7c5cff; opacity: 0; transform: scale(calc(1 + var(--level) * .35));
    transition: transform .08s linear, opacity .2s ease;
  }
  .vc-talk.is-recording { transform: scale(1.06); background: linear-gradient(160deg, #ff5c7a, #ff9a3c); }
  .vc-talk.is-recording::before { opacity: .55; border-color: #ff5c7a; }
  .vc-talk.is-busy { filter: saturate(.55) brightness(.95); }
  .vc-talk.is-speaking { background: linear-gradient(160deg, #2ab6d6, #2fbf71); }
  .vc-talk:disabled { cursor: default; filter: grayscale(.7) opacity(.6); }
  .vc-hint { font-size: 12.5px; color: var(--muted); }
  .vc-voicenote { font-size: 12.5px; color: var(--muted); text-align: center; max-width: 420px; }
  .vc-setup {
    width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 8px; align-items: stretch;
    font-size: 13.5px; color: var(--muted); text-align: center;
  }
  .vc-bar { height: 6px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
  .vc-bar > span { display: block; height: 100%; background: var(--accent); transition: width .3s ease; }
  .vc-dots span { animation: vc-blink 1.2s infinite both; }
  .vc-dots span:nth-child(2) { animation-delay: .2s; }
  .vc-dots span:nth-child(3) { animation-delay: .4s; }
  @keyframes vc-blink { 0%, 80%, 100% { opacity: .2; } 40% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .vc-talk, .vc-talk::before, .vc-bar > span { transition: none; }
    .vc-dots span { animation: none; opacity: 1; }
  }
`

// ---------------------------------------------------------------- helpers

function api(token, path, init = {}) {
  return fetch(path, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  })
}

/** Float32 mono at any rate -> base64 of 16 kHz int16 little-endian. */
function encodeClip(samples, rate) {
  const n = Math.floor(samples.length * TARGET_RATE / rate)
  const out = new Int16Array(n)
  const step = rate / TARGET_RATE
  for (let i = 0; i < n; i++) {
    // Average the source window: a cheap low-pass before decimating.
    const from = Math.floor(i * step)
    const to = Math.max(from + 1, Math.floor((i + 1) * step))
    let sum = 0
    for (let j = from; j < to && j < samples.length; j++) sum += samples[j]
    const v = Math.max(-1, Math.min(1, sum / (to - from)))
    out[i] = v < 0 ? v * 32768 : v * 32767
  }
  const bytes = new Uint8Array(out.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** The assistant text of the turn now streaming in `chatId`, live. */
async function followReply(token, chatId, { onText, onQuestion, signal }) {
  // The turn's broadcast may not exist for a moment after sending (204).
  let res = null
  for (let attempt = 0; attempt < 20 && !signal.aborted; attempt++) {
    res = await api(token, `/api/chats/${encodeURIComponent(chatId)}/stream`, { signal })
    if (res.status !== 204) break
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!res || !res.ok || !res.body) throw new Error(`stream ${res?.status}`)
  const items = []          // [{ id, text }] in order
  const itemFor = (id, fresh) => {
    let item = !fresh && items.findLast((it) => it.id === id)
    if (!item) { item = { id, text: '' }; items.push(item) }
    return item
  }
  let forceNew = false
  const emit = (done) => onText(items.map((it) => it.text).filter(Boolean).join('\n'), done)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
      if (!data) continue
      let event
      try { event = JSON.parse(data) } catch { continue }
      const id = event.text_item_id || null
      if (event.type === 'text') {
        itemFor(id, forceNew).text += event.content || ''
        forceNew = false
        emit(false)
      } else if (event.type === 'text_final') {
        if (event.content) itemFor(id, false).text = event.content
        emit(false)
      } else if (event.type === 'text_boundary') {
        if (event.replace_text_item_id) {
          const at = items.findIndex((it) => it.id === event.replace_text_item_id)
          if (at >= 0) items.splice(at, 1)
        }
        forceNew = true
      } else if (event.type === 'question') {
        // A choice card. Restart and secure-input cards are never answered by
        // voice: a misheard word must not restart Möbius or fill a secret.
        const questions = Array.isArray(event.questions) ? event.questions : []
        if (questions.length && questions[0]?.question && !event.platform_action && !event.secure_input
          && !event.answers) {
          onQuestion?.({ question_id: event.question_id || null, questions })
        }
      } else if (event.type === 'done' || event.type === 'error') {
        emit(true)
        try { reader.cancel() } catch { /* already closed */ }
        return
      }
    }
  }
  emit(true)
}

/**
 * The Voice app's on-device voice. Inside an app, every synthesis request
 * starts a fresh engine and streams the whole voice model into it, so the
 * speaker batches: the first sentence goes alone (sound as soon as possible),
 * and whatever arrives while one request is running is read by the next
 * request as one document. A reply costs two or three engine starts, not one
 * per sentence. Audio is scheduled gaplessly on one AudioContext.
 */
const VOICE_START_TIMEOUT_MS = 45_000   // a phone's first engine start can be slow
const MAX_DOCUMENT_CHARS = 4000         // under the reviewed 5000-character limit

function createSpeaker({ onIdle, onStatus }) {
  let ctx = null
  let model = null
  let queue = []
  let busy = false
  let session = null
  let sources = new Set()
  let playhead = 0
  let epoch = 0
  let ended = false          // no more text will come for this reply
  let idleTimer = null
  let engine = null          // the app's own long-lived voice engine, when loaded
  let loadingPercent = null

  // iPhone Safari moves the output to 'interrupted' (or 'suspended') when the
  // microphone takes the audio session; it must be resumed again, ideally
  // inside a tap, or the voice plays silently.
  const context = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)()
    if (ctx.state !== 'running') ctx.resume().catch(() => {})
    return ctx
  }
  const checkIdle = () => {
    clearTimeout(idleTimer)
    if (!ended || busy || queue.length) return
    const left = Math.max(0, playhead - (ctx ? ctx.currentTime : 0))
    const mine = epoch
    idleTimer = setTimeout(() => { if (mine === epoch && !busy && !queue.length) onIdle() }, left * 1000 + 60)
  }
  const takeBatch = () => {
    const batch = []
    let chars = 0
    while (queue.length && (batch.length === 0 || chars + queue[0].length <= MAX_DOCUMENT_CHARS)) {
      const text = queue.shift()
      batch.push(text)
      chars += text.length
    }
    return batch
  }
  const schedule = (c, samples) => {
    const buffer = c.createBuffer(1, samples.length, model.sampleRate || 24000)
    buffer.getChannelData(0).set(samples)
    const src = c.createBufferSource()
    src.buffer = buffer
    src.connect(c.destination)
    if (c.state !== 'running') c.resume().catch(() => {})
    const at = Math.max(c.currentTime + 0.03, playhead)
    src.start(at)
    playhead = at + buffer.duration
    sources.add(src)
    src.onended = () => sources.delete(src)
  }
  const engineUsable = () => engine && !engine.dead && model && engine.modelId === model.id

  // The long-lived engine: one sentence at a time, no reloads.
  const pumpEngine = async () => {
    busy = true
    const mine = epoch
    const text = queue.shift()
    const c = context()
    let heard = false
    try {
      if (!engine.loaded) onStatus?.('loading', loadingPercent)
      await engine.generate(text, (samples) => {
        if (mine !== epoch) return
        if (!heard) { heard = true; onStatus?.('playing') }
        schedule(c, samples)
      })
    } catch {
      // The engine could not load or stopped: put the sentence back and let
      // ordinary synthesis read it (and everything after it).
      if (mine === epoch && !heard) queue.unshift(text)
      engine = null
    } finally {
      if (mine === epoch) { busy = false; pump() }
    }
  }

  const pump = async () => {
    if (busy || !queue.length) { checkIdle(); return }
    if (engineUsable()) { pumpEngine(); return }
    busy = true
    const mine = epoch
    const batch = takeBatch()
    const c = context()
    let heard = false
    let watchdog = null
    try {
      session = window.mobius.capabilities.open('media.speech', {
        operation: 'synthesize',
        modelId: model.id,
        document: {
          version: 1,
          locale: navigator.language || 'en-US',
          hints: [],
          segments: batch.map((text) => ({ kind: 'paragraph', text, pauseAfterMs: 0 })),
        },
      })
      const offLoading = session.on('loading', (value) => {
        if (mine === epoch && !heard && value?.stage !== 'generating') onStatus?.('loading', value?.percent)
      })
      const offAudio = session.on('audio', ({ samples }) => {
        if (mine !== epoch || !samples?.length) return
        if (!heard) { heard = true; clearTimeout(watchdog); onStatus?.('playing') }
        schedule(c, samples)
      })
      const current = session
      watchdog = setTimeout(() => {
        if (heard || mine !== epoch) return
        try { current.cancel() } catch { /* finished */ }
        onStatus?.('failed')
      }, VOICE_START_TIMEOUT_MS)
      await session.result.catch(() => { if (!heard && mine === epoch) onStatus?.('failed') })
      offLoading?.()
      offAudio?.()
    } catch {
      if (mine === epoch) onStatus?.('failed')
    } finally {
      clearTimeout(watchdog)
      session = null
      if (mine === epoch) { busy = false; pump() }
    }
  }
  return {
    /** Call inside the press handler: phones only start audio from a gesture. */
    unlock() { context() },
    /** Use this long-lived engine for sentences once it is loaded. */
    setEngine(next) { engine = next; loadingPercent = null },
    loadingProgress(percent) {
      loadingPercent = percent
      if (busy && engine && !engine.loaded) onStatus?.('loading', percent)
    },
    setModel(next) { model = next },
    get model() { return model },
    begin() { ended = false },
    say(text) { if (text && model) { queue.push(text); pump() } },
    end() { ended = true; checkIdle() },
    stop() {
      epoch += 1
      queue = []
      ended = true
      busy = false
      clearTimeout(idleTimer)
      try { session?.cancel() } catch { /* finished */ }
      session = null
      try { engine?.cancel() } catch { /* idle */ }
      for (const s of sources) { try { s.stop() } catch { /* ended */ } }
      sources = new Set()
      playhead = 0
    },
  }
}

// ---------------------------------------------------------------- app

export default function App({ appId, token }) {
  const [phase, setPhase] = useState('loading')   // loading | setup | idle | recording | transcribing | thinking | speaking
  const [progress, setProgress] = useState(0)
  const [voice, setVoice] = useState(undefined)   // undefined: checking, null: none installed
  const [chatId, setChatId] = useState(null)
  const [embedKey, setEmbedKey] = useState(0)   // bump to reload the chat view after sending
  const [caption, setCaption] = useState('')
  const [error, setError] = useState('')
  const [level, setLevel] = useState(0)
  const [voiceNote, setVoiceNote] = useState('')   // voice loading or failure, shown under the caption

  const tokenRef = useRef(token)
  tokenRef.current = token
  const mountRef = useRef(null)
  const recordingRef = useRef(null)
  const pressRef = useRef({ at: 0, toggled: false })
  const speakerRef = useRef(null)
  const replyRef = useRef(null)    // { abort, consumed, first }
  const chatIdRef = useRef(null)
  chatIdRef.current = chatId
  const engineRef = useRef(null)
  const questionRef = useRef(null)   // open choice card being answered by voice: { card, index, answers, resolved }

  // Load the Voice app's voice once and keep it while the app is open (the
  // first talk starts it, so just opening the app costs nothing).
  const ensureEngine = useCallback((model) => {
    const current = engineRef.current
    if (!model || (current && !current.dead && current.modelId === model.id)) return
    current?.dispose()
    const engine = createVoiceEngine({
      modelId: model.id,
      onLoading: (percent) => speakerRef.current?.loadingProgress(percent),
    })
    engineRef.current = engine
    speakerRef.current?.setEngine(engine)
  }, [])
  useEffect(() => () => engineRef.current?.dispose(), [])

  if (!speakerRef.current) {
    speakerRef.current = createSpeaker({
      onIdle: () => {
        setVoiceNote('')
        setPhase((p) => (p === 'speaking' || p === 'thinking' ? 'idle' : p))
      },
      onStatus: (state, percent) => {
        if (state === 'loading') setVoiceNote(percent > 0 && percent < 100 ? `Getting the voice ready… ${Math.round(percent)}%` : 'Getting the voice ready…')
        else if (state === 'playing') setVoiceNote('')
        else if (state === 'failed') setVoiceNote("The Voice app's voice didn't start on this device. The answer is in the chat.")
      },
    })
  }

  // The conversation in progress (an ordinary chat, so it is also in Recents).
  useEffect(() => {
    // Reads answer from this device's cache first; the subscription delivers
    // the server's value once it is revalidated (or written from elsewhere).
    const adopt = (saved) => setChatId(saved?.id ? String(saved.id) : null)
    window.mobius.storage.get(CURRENT_KEY).then(adopt).catch(() => {})
    const unsubscribe = window.mobius.storage.subscribe?.(CURRENT_KEY, adopt)
    return () => { unsubscribe?.(); speakerRef.current?.stop(); replyRef.current?.abort() }
  }, [])

  // The voice picked in the Voice app.
  const refreshVoice = useCallback(async () => {
    try {
      const caps = window.mobius.capabilities
      if (!caps?.available?.('media.speech', 1)) { setVoice(null); return null }
      const catalog = await caps.invoke('media.speech', { operation: 'catalog' })
      const model = catalog?.activeModel || null
      speakerRef.current.setModel(model)
      setVoice(model)
      return model
    } catch {
      setVoice(null)
      return null
    }
  }, [])
  useEffect(() => { refreshVoice() }, [refreshVoice])

  // Speech recognition lives on this Möbius: download it once, in slices.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        let state = await (await api(token, `/api/apps/${appId}/service/status`)).json()
        while (!cancelled && !state.ready) {
          setPhase('setup')
          setProgress(state.progress || 0)
          const res = await api(token, `/api/apps/${appId}/service/prepare`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
          state = await res.json().catch(() => ({}))
          if (!res.ok && !cancelled) {
            setError(state.error || 'Downloading speech recognition paused. Retrying…')
            await new Promise((r) => setTimeout(r, 3000))
          } else if (state.error) setError(state.error)
          else setError('')
        }
        if (!cancelled) { setProgress(1); setPhase('idle'); setError('') }
      } catch {
        if (!cancelled) setError('Speech recognition could not be prepared. Close and reopen the app to retry.')
      }
    })()
    return () => { cancelled = true }
  }, [appId, token])

  // Show the conversation as a normal Möbius chat.
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !chatId) return undefined
    let handle = null
    let disposed = false
    window.mobius.chat({ mount, chatId, picker: false })
      .then((h) => { if (disposed) h.destroy(); else handle = h })
      .catch(() => setError('The conversation could not be shown. Start a new one.'))
    return () => { disposed = true; handle?.destroy() }
    // The embedded chat only notices messages typed into it, so it is
    // remounted after the app sends one: it then shows the new message and
    // follows the answer as it is written.
  }, [chatId, embedKey])

  // --- reply → voice
  const speakReply = useCallback((id) => {
    replyRef.current?.abort()
    const controller = new AbortController()
    const state = { consumed: 0, first: true, abort: () => controller.abort() }
    replyRef.current = state
    const speaker = speakerRef.current
    speaker.begin()
    followReply(tokenRef.current, id, {
      signal: controller.signal,
      onText(text, done) {
        if (replyRef.current !== state) return
        for (;;) {
          const { speech, consumed } = nextSpeech(text, state.consumed, done, state.first)
          if (consumed === state.consumed) break
          state.consumed = consumed
          if (speech) {
            state.first = false
            setPhase('speaking')
            speaker.say(speech)
          }
        }
        if (done) speaker.end()
      },
      onQuestion(card) {
        if (replyRef.current !== state) return
        // Read the card after the answer, then treat the next thing said as
        // the reply to it, one question at a time.
        questionRef.current = { card, index: 0, answers: {}, resolved: {} }
        setPhase('speaking')
        speaker.say(questionPrompt(card.questions[0], { index: 0, total: card.questions.length }))
      },
    }).catch(() => {
      if (replyRef.current === state) { speaker.end(); setPhase((p) => (p === 'thinking' ? 'idle' : p)) }
    })
  }, [])

  // --- a spoken reply to an open choice card (as Möbius's built-in voice did)
  const answerCard = useCallback(async (text) => {
    const state = questionRef.current
    const { card } = state
    const question = card.questions[state.index]
    const speaker = speakerRef.current
    const id = chatIdRef.current
    setCaption(text)
    speaker.begin()
    setPhase('speaking')
    if (isRepeatRequest(text)) {
      speaker.say(questionPrompt(question, { index: state.index, total: card.questions.length }))
      speaker.end()
      return true
    }
    const match = matchSpokenAnswer(text, question)
    if (match.kind === 'options') {
      state.answers[question.question] = question.multiSelect ? match.labels : match.labels[0]
      state.resolved[question.question] = match.labels.join(', ')
    } else {
      state.answers[question.question] = '__other__'
      state.resolved[question.question] = match.text
    }
    speaker.say(answerAck(match))
    if (state.index + 1 < card.questions.length) {
      state.index += 1
      speaker.say(questionPrompt(card.questions[state.index], { index: state.index, total: card.questions.length }))
      speaker.end()
      return true
    }
    // Same submission the card's own buttons make: the chosen option ids
    // where every choice is a listed option, otherwise the words themselves.
    const selected = {}
    for (const q of card.questions) {
      const answer = state.answers[q.question]
      const labels = Array.isArray(answer) ? answer : [answer]
      const options = labels.map((label) => q.options?.find((o) => o.label === label))
      if (q.id && options.length && options.every((o) => typeof o?.id === 'string')) {
        selected[q.id] = options.map((o) => o.id)
      }
    }
    questionRef.current = null
    const res = await api(tokenRef.current, `/api/chats/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: card.questions.map((q) => `- ${q.question}: ${state.resolved[q.question]}`).join('\n'),
        hidden: true,
        cid: crypto.randomUUID(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        answers: state.resolved,
        question_id: card.question_id,
        selected_options: selected,
      }),
    }).catch(() => null)
    if (!res?.ok) {
      // Already answered on screen (or gone): treat the words as a message.
      speaker.stop()
      return false
    }
    setEmbedKey((k) => k + 1)
    speakReply(id)
    return true
  }, [speakReply])

  // --- send what was said
  const send = useCallback(async (text) => {
    if (questionRef.current && chatIdRef.current && await answerCard(text)) return
    setPhase('thinking')
    setCaption(text)
    try {
      let id = chatIdRef.current
      if (id) {
        const res = await api(tokenRef.current, `/api/chats/${encodeURIComponent(id)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: text,
            cid: crypto.randomUUID(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }),
        })
        if (res.status === 404 || res.status === 410) id = null   // deleted: start over
        else if (!res.ok) throw new Error(String(res.status))
        else setEmbedKey((k) => k + 1)
      }
      if (!id) {
        const started = await window.mobius.chat.start({
          content: text,
          title: text.length > 48 ? `${text.slice(0, 46)}…` : text,
          systemPrompt: VOICE_STYLE,
        })
        id = started.chatId
        setChatId(id)
        window.mobius.storage.set(CURRENT_KEY, { id }).catch(() => {})
      }
      speakReply(id)
    } catch {
      setPhase('idle')
      setError('That message did not send. Try again.')
    }
  }, [speakReply, answerCard])

  // --- push to talk
  const startRecording = useCallback(async () => {
    const caps = window.mobius.capabilities
    if (!caps?.available?.('media.microphone.capture', 1)) {
      setError('The microphone is not available here.')
      return
    }
    setError('')
    setCaption('')
    setVoiceNote('')
    setPhase('recording')
    try {
      const recording = caps.open('media.microphone.capture', { maxDurationMs: MAX_CLIP_MS })
      recordingRef.current = recording
      const off = recording.on('level', (v) => setLevel(Math.min(1, v * 2.5)))
      recording.cleanup = off
      await recording.ready
    } catch {
      recordingRef.current = null
      setPhase('idle')
      setError('Möbius needs microphone permission to hear you.')
    }
  }, [])

  const finishRecording = useCallback(async () => {
    const recording = recordingRef.current
    if (!recording) return
    recordingRef.current = null
    setLevel(0)
    setPhase('transcribing')
    try {
      const { samples, sampleRate } = await recording.finish()
      recording.cleanup?.()
      if (!samples?.length || samples.length < sampleRate * 0.25) {
        setPhase('idle')
        setCaption('')
        return
      }
      const res = await api(tokenRef.current, `/api/apps/${appId}/service/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: encodeClip(samples, sampleRate) }),
        signal: AbortSignal.timeout?.(30_000),   // never leave the talk button greyed out
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'transcribe')
      // The assistant's name and local place names are not in the model's
      // vocabulary: put them back, as Möbius's built-in voice does.
      const text = normalizePlaces(normalizeName(body.text || '').text).text.trim()
      if (!text) {
        setPhase('idle')
        setCaption("Didn't catch that. Hold the button and try again.")
        return
      }
      send(text)
    } catch (e) {
      recording.cleanup?.()
      setPhase('idle')
      setError(String(e?.message || '').length > 12 ? e.message : 'I could not make that out. Try again.')
    }
  }, [appId, send])

  const onPointerDown = useCallback(async (event) => {
    event.preventDefault()
    const speaker = speakerRef.current
    speaker.unlock()
    if (phase === 'recording') {         // second tap of tap-to-talk
      pressRef.current.toggled = false
      finishRecording()
      return
    }
    if (phase === 'speaking' || phase === 'thinking') {
      speaker.stop()
      replyRef.current?.abort()
      replyRef.current = null
    }
    if (phase === 'transcribing' || phase === 'setup' || phase === 'loading') return
    const model = speaker.model || await refreshVoice()
    if (!model) { setError('Pick a voice in the Voice app first, then come back.'); return }
    ensureEngine(model)
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* not supported */ }
    pressRef.current = { at: performance.now(), toggled: false }
    startRecording()
  }, [phase, finishRecording, refreshVoice, startRecording, ensureEngine])

  const onPointerUp = useCallback(() => {
    if (!recordingRef.current || pressRef.current.toggled) return
    if (performance.now() - pressRef.current.at < HOLD_MS) {
      pressRef.current.toggled = true        // a tap: keep listening until the next tap
      return
    }
    finishRecording()
  }, [finishRecording])

  const onKeyDown = useCallback((event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault()
      onPointerDown({ ...event, preventDefault() {}, currentTarget: event.currentTarget, pointerId: 0 })
    }
  }, [onPointerDown])

  const newConversation = useCallback(() => {
    speakerRef.current.stop()
    replyRef.current?.abort()
    replyRef.current = null
    questionRef.current = null
    setChatId(null)
    setCaption('')
    setError('')
    setPhase((p) => (p === 'setup' || p === 'loading' ? p : 'idle'))
    window.mobius.storage.set(CURRENT_KEY, { id: null }).catch(() => {})
  }, [])

  const busy = phase === 'transcribing' || phase === 'thinking'
  const hint = {
    loading: 'Getting ready…',
    setup: 'Setting up speech recognition…',
    idle: 'Hold to talk, or tap to start and tap again to send',
    recording: pressRef.current.toggled ? 'Listening… tap to send' : 'Listening… let go to send',
    transcribing: 'Writing down what you said…',
    thinking: 'Thinking…',
    speaking: 'Tap to stop and talk',
  }[phase]

  return (
    <div className="vc-root">
      <style>{CSS}</style>
      <header className="vc-head">
        <h1 className="vc-title">Voice Conversation</h1>
        <span className="vc-voice" title="Change the voice in the Voice app">
          <SoundOnReadOutLoudSpeaker width={15} height={15} aria-hidden="true" />
          {voice === undefined ? 'Checking voice…' : voice ? voice.name : 'No voice yet'}
        </span>
        <button type="button" className="vc-new" onClick={newConversation} disabled={!chatId}>
          <Plus width={16} height={16} aria-hidden="true" /> New
        </button>
      </header>

      <section className="vc-chat" aria-label="Conversation">
        {chatId ? <div ref={mountRef} className="vc-chat-mount" /> : (
          <div className="vc-empty">
            <div>
              <h2>Talk to your agent</h2>
              <p>
                {voice === null
                  ? 'Open the Voice app and download a voice first. Answers are read aloud with it.'
                  : 'Hold the button and speak. When you let go, your words go to your agent and the answer is read aloud. Every conversation is also saved in your chats.'}
              </p>
            </div>
          </div>
        )}
      </section>

      <footer className="vc-dock">
        {phase === 'setup' ? (
          <div className="vc-setup" role="status">
            <span>Downloading speech recognition (about 100 MB, only once)</span>
            <div className="vc-bar" aria-hidden="true"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <span>{Math.round(progress * 100)}%</span>
          </div>
        ) : (
          <div className={`vc-caption${error ? ' is-error' : ''}`} role="status" aria-live="polite">
            {error || caption || (busy ? <span className="vc-dots"><span>•</span><span>•</span><span>•</span></span> : '')}
          </div>
        )}
        {voiceNote && phase !== 'setup' ? <div className="vc-voicenote" role="status">{voiceNote}</div> : null}
        <button
          type="button"
          className={`vc-talk${phase === 'recording' ? ' is-recording' : ''}${busy ? ' is-busy' : ''}${phase === 'speaking' ? ' is-speaking' : ''}`}
          style={{ '--level': level }}
          aria-label={phase === 'recording' ? 'Send' : phase === 'speaking' ? 'Stop speaking' : 'Hold to talk'}
          aria-pressed={phase === 'recording'}
          disabled={phase === 'setup' || phase === 'loading' || phase === 'transcribing'}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') onPointerUp() }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {phase === 'speaking' ? <Stop width={30} height={30} aria-hidden="true" /> : <Mic width={32} height={32} aria-hidden="true" />}
        </button>
        <span className="vc-hint">{hint}</span>
      </footer>
    </div>
  )
}
