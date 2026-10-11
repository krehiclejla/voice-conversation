/**
 * One long-lived copy of the Voice app's on-device voice engine.
 *
 * Möbius's own `media.speech` synthesis starts a fresh engine for every
 * request and streams the whole voice model into it (141 MB for English), so
 * speaking sentence by sentence reloads the model each time. This keeps one
 * engine loaded for as long as the app is open: the model streams in once,
 * and every later sentence starts at once.
 *
 * It uses the same public pieces Möbius's runtime uses inside an app frame:
 * the shell-served engine script and binary, and the `media.speech`
 * `model-stream` operation for the selected voice's bytes. If Möbius ever
 * changes that engine, loading fails and the caller falls back to ordinary
 * `media.speech` synthesis.
 */

const WORKER_URL = '/speech/pocket-tts-worker.js'
const WASM_URL = '/speech/pocket-tts-xn.wasm'
const LOAD_STALL_MS = 180_000      // no progress at all for this long = failed

function engineError(message) {
  const error = new Error(message)
  error.name = 'VoiceEngineError'
  return error
}

/**
 * @param {{ modelId: string, onLoading?: (percent: number|null) => void }} options
 * @returns {{ modelId: string, ready: Promise<void>, generate: Function, cancel: Function, dispose: Function, dead: boolean, loaded: boolean }}
 */
export function createVoiceEngine({ modelId, onLoading }) {
  let worker = null
  let blobUrl = ''
  let stream = null
  let dead = false
  let loaded = false
  let stallTimer = null
  let current = null        // { id, resolve, reject, onAudio } of the running sentence
  let nextRequest = 1
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {})

  const fail = (error) => {
    if (dead) return
    dead = true
    clearTimeout(stallTimer)
    try { stream?.cancel?.() } catch { /* closed */ }
    try { worker?.terminate() } catch { /* gone */ }
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    rejectReady(error)
    current?.reject(error)
    current = null
  }
  const progress = () => {
    if (loaded || dead) return
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => fail(engineError('The voice stopped loading.')), LOAD_STALL_MS)
  }

  // Messages wait for the worker script to exist (see Möbius runtime speech.js).
  let sendChain = Promise.resolve()
  const workerReady = (async () => {
    const response = await fetch(WORKER_URL, { credentials: 'same-origin' })
    if (!response.ok) throw engineError(`The voice engine returned ${response.status}.`)
    const source = await response.text()
    if (dead) return
    blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    worker = new Worker(blobUrl)
    worker.onerror = (event) => fail(engineError(event?.message || 'The voice engine could not start.'))
    worker.onmessage = ({ data }) => onMessage(data)
  })()
  workerReady.catch(fail)
  const send = (message, transfer = []) => {
    sendChain = sendChain.then(() => workerReady).then(() => {
      if (!dead && worker) worker.postMessage(message, transfer)
    })
    sendChain.catch(() => {})
  }

  function onMessage(data) {
    if (!data || dead) return
    if (data.type === 'load-ready') { progress(); stream?.control?.('start'); return }
    if (data.type === 'chunk-accepted') { progress(); stream?.control?.('chunk-accepted'); return }
    if (data.type === 'load-complete') {
      loaded = true
      clearTimeout(stallTimer)
      onLoading?.(100)
      resolveReady()
      return
    }
    // Sentence messages carry their request id: anything from a cancelled
    // sentence is dropped rather than played into the next one.
    const mine = current && data.requestId === current.id
    if (data.type === 'audio') { if (mine && data.samples?.length) current.onAudio(data.samples); return }
    if (data.type === 'generate-complete') { if (!mine) return; const done = current; current = null; done.resolve(); return }
    if (data.type === 'generate-error') {
      if (!mine) return
      const done = current
      current = null
      done?.reject(engineError(data.error?.message || 'The voice stopped unexpectedly.'))
      return
    }
    if (data.type === 'worker-error') fail(engineError(data.error?.message || 'The voice stopped unexpectedly.'))
  }

  progress()
  onLoading?.(0)
  try {
    stream = window.mobius.capabilities.open('media.speech', { operation: 'model-stream', modelId })
    stream.on('manifest', (value) => {
      progress()
      send({
        type: 'load-start',
        wasmUrl: new URL(WASM_URL, globalThis.location.href).href,
        assetBytes: value.assetBytes,
        temperature: value.temperature,
        clonedVoiceSamples: value.clonedVoiceSamples || undefined,
      })
    })
    stream.on('chunk', (value) => {
      progress()
      send({
        type: 'asset-chunk', chunkId: value.index, assetId: value.assetId,
        index: value.index, offset: value.offset, bytes: value.bytes,
      }, [value.bytes])
    })
    stream.on('progress', (value) => {
      progress()
      onLoading?.(typeof value?.percent === 'number' ? value.percent : null)
    })
    stream.result.then(() => send({ type: 'load-finish' })).catch(fail)
  } catch (error) {
    fail(error)
  }

  return {
    modelId,
    ready,
    get dead() { return dead },
    get loaded() { return loaded && !dead },
    /** Speak one piece of text; `onAudio(Float32Array)` receives its audio as it is made. */
    async generate(text, onAudio) {
      await ready
      if (dead) throw engineError('The voice is not loaded.')
      if (current) throw engineError('The voice is busy.')
      return new Promise((resolve, reject) => {
        const id = `vc-${nextRequest++}`
        current = { id, resolve, reject, onAudio }
        send({ type: 'generate', requestId: id, text })
      })
    },
    /** Stop the sentence being made (the engine stays loaded). */
    cancel() {
      if (dead || !current) return
      send({ type: 'cancel-generate' })
      const done = current
      current = null
      done.resolve()
    },
    dispose() {
      if (dead) return
      send({ type: 'dispose' })
      setTimeout(() => fail(engineError('Closed.')), 100)
    },
  }
}
