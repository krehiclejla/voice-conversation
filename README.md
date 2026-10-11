# Voice Conversation

Push-to-talk conversation with your Möbius agent. Everything it needs ships in
the app, so it works on any Möbius once a voice is downloaded in the Voice app.

- **Hold to talk** (or tap to start, tap again to send). Recordings are up to
  60 seconds.
- **Speech recognition runs in this app's own server** (`service.py`): NVIDIA
  Parakeet TDT-CTC 110M (English, int8) via sherpa-onnx, which reads the whole
  recording and copes well with accents. The app downloads it (~104 MB package,
  checksummed, resumable) the first time it opens, into its storage folder. Name and place fixes
  (`lib/nameNormalizer.js`, `lib/placeNames.js`) run on the text afterwards.
- **Each conversation is an ordinary chat** that appears in Recents, using the
  owner's own models and agents, with a spoken-style instruction.
- **Answers are read aloud** sentence by sentence with the voice selected in the
  Voice app (on the device, through the shared `media.speech` capability).

Talking while an answer is still being written queues the new message; the
chat's own Stop button stops a running answer.
