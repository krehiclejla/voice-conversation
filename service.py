#!/usr/bin/env python3
"""Voice Conversation's own speech recognition.

Möbius starts this entry once per request with one JSON envelope on stdin and
reads one JSON reply from stdout, so everything here is request-shaped:

- `GET status`      is the recognition model on this server yet?
- `POST prepare`    download the model a slice at a time (each call stays well
                    inside the platform's request time limit); the app calls it
                    until `ready`. Interrupted downloads resume where they were.
- `POST transcribe` one push-to-talk clip -> text.

The recognizer is NVIDIA's Parakeet TDT-CTC 110M (English, int8) through
sherpa-onnx: it reads the whole recording at once, which suits push to talk
and is far more accurate with accents than a streaming model. A fresh process
loads it per clip (about 0.6 s); it cannot be preloaded, because onnxruntime
starts worker threads that do not survive the platform's per-request fork.
"""
from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SAMPLE_RATE = 16000
# NVIDIA Parakeet TDT-CTC 110M (English, int8), packaged by sherpa-onnx. A
# whole-recording model: on accented speech it got about 8% of words wrong
# where the streaming Zipformer Möbius's built-in voice used got 28%, and it
# adds punctuation and capitals.
MODEL_NAME = 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8'
ARCHIVE_URL = f'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{MODEL_NAME}.tar.bz2'
ARCHIVE_BYTES = 104337827
ARCHIVE_SHA256 = '17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b'
# Member -> (bytes, sha256). Pinned so a changed upstream file is refused
# rather than silently changing recognition.
MODEL_FILES = {
  'model.int8.onnx': (131652171, '9177a9146cf32ee0cc8152276ef95116f312018d316be37ccf57f7efea81fc1a'),
  'tokens.txt': (9953, '450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10'),
}
PREPARE_BUDGET_SECS = 9.0       # the platform allows 15 s per request
CHUNK_BYTES = 1 << 20
MAX_CLIP_SECS = 150


def storage_dir() -> Path:
  return Path(os.environ.get('APP_STORAGE_DIR') or HERE / '.storage')


def model_dir() -> Path:
  return storage_dir() / 'parakeet-110m'


def ready() -> bool:
  d = model_dir()
  return (d / 'READY').is_file() and all((d / name).is_file() for name in MODEL_FILES)


def status() -> dict:
  if ready():
    return {'ready': True, 'progress': 1.0}
  part = model_dir() / 'archive.part'
  have = part.stat().st_size if part.is_file() else 0
  # Downloading is 95% of the bar; unpacking is the last stretch.
  return {'ready': False, 'progress': round(min(have, ARCHIVE_BYTES) / ARCHIVE_BYTES * 0.95, 4),
          'bytes': have, 'total': ARCHIVE_BYTES}


def sha256(path: Path) -> str:
  h = hashlib.sha256()
  with path.open('rb') as f:
    for block in iter(lambda: f.read(1 << 20), b''):
      h.update(block)
  return h.hexdigest()


def download_slice(part: Path, deadline: float) -> int:
  """Append to the partial archive until the deadline; returns its size."""
  have = part.stat().st_size if part.is_file() else 0
  if have >= ARCHIVE_BYTES:
    return have
  request = urllib.request.Request(ARCHIVE_URL, headers={
    'Range': f'bytes={have}-', 'User-Agent': 'mobius-voice-conversation/1'})
  with urllib.request.urlopen(request, timeout=8) as response:
    if have and response.status != 206:
      have = 0            # the server ignored the range: start over
      part.unlink(missing_ok=True)
    with part.open('ab') as out:
      while have < ARCHIVE_BYTES and time.monotonic() < deadline:
        block = response.read(CHUNK_BYTES)
        if not block:
          break
        out.write(block)
        have += len(block)
  return have


def unpack(part: Path, d: Path) -> None:
  """Write the model files out of the verified archive (about 6 s)."""
  import tarfile

  with tarfile.open(part, mode='r|bz2') as tar:
    for member in tar:
      name = member.name.rsplit('/', 1)[-1]
      if name in MODEL_FILES and member.isfile():
        with tar.extractfile(member) as src, (d / f'{name}.new').open('wb') as out:
          for block in iter(lambda: src.read(1 << 20), b''):
            out.write(block)
  for name, (size, digest) in MODEL_FILES.items():
    new = d / f'{name}.new'
    if not new.is_file() or new.stat().st_size != size or sha256(new) != digest:
      raise ValueError(f'{name} did not match its checksum')
    new.rename(d / name)


def prepare() -> dict:
  """One step of setup: download a slice, or verify and unpack the archive."""
  d = model_dir()
  d.mkdir(parents=True, exist_ok=True)
  with (d / '.lock').open('w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if ready():
      return status()
    part = d / 'archive.part'
    have = download_slice(part, time.monotonic() + PREPARE_BUDGET_SECS)
    if have < ARCHIVE_BYTES:
      return status()
    if have > ARCHIVE_BYTES or sha256(part) != ARCHIVE_SHA256:
      part.unlink(missing_ok=True)
      return {**status(), 'error': 'The speech model download was damaged; it will download again.'}
    # Unpacking gets a request of its own so it has the whole time limit.
    if not (d / 'verified').is_file():
      (d / 'verified').write_text(ARCHIVE_SHA256)
      return {**status(), 'progress': 0.96}
    unpack(part, d)
    (d / 'READY').write_text(MODEL_NAME)
    part.unlink(missing_ok=True)
    (d / 'verified').unlink(missing_ok=True)
  # The earlier streaming model is no longer used.
  shutil.rmtree(storage_dir() / 'stt-model', ignore_errors=True)
  return status()


def recognizer():
  import sherpa_onnx

  d = model_dir()
  return sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
    model=str(d / 'model.int8.onnx'), tokens=str(d / 'tokens.txt'), num_threads=2)


def transcribe(pcm: bytes) -> str:
  """Text of one clip of 16 kHz mono int16 PCM."""
  import numpy as np

  samples = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype='<i2').astype('float32') / 32768.0
  samples = samples[: MAX_CLIP_SECS * SAMPLE_RATE]
  engine = recognizer()
  stream = engine.create_stream()
  stream.accept_waveform(SAMPLE_RATE, samples)
  engine.decode_stream(stream)
  return stream.result.text.strip()


def handle(req: dict) -> dict:
  path = (req.get('path') or '').strip('/')
  method = req.get('method')
  body = req.get('body') if isinstance(req.get('body'), dict) else {}
  if path == 'status' and method == 'GET':
    return {'status': 200, 'body': status()}
  if path == 'prepare' and method == 'POST':
    try:
      return {'status': 200, 'body': prepare()}
    except OSError as error:
      return {'status': 502, 'body': {**status(), 'error': f'Download interrupted ({error}). Retrying will resume.'}}
  if path == 'transcribe' and method == 'POST':
    if not ready():
      return {'status': 409, 'body': {'error': 'Speech recognition is still downloading.', **status()}}
    try:
      pcm = base64.b64decode(body.get('audio') or '', validate=True)
    except (ValueError, TypeError):
      return {'status': 400, 'body': {'error': 'The recording could not be read.'}}
    started = time.monotonic()
    text = transcribe(pcm)
    return {'status': 200, 'body': {
      'text': text, 'seconds': round(len(pcm) / 2 / SAMPLE_RATE, 2),
      'took_ms': round((time.monotonic() - started) * 1000)}}
  return {'status': 404, 'body': {'error': 'Not found'}}


if __name__ == '__main__':
  try:
    response = handle(json.load(sys.stdin))
  except Exception as exc:  # keep the envelope valid; details go to the platform log
    print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
    response = {'status': 500, 'body': {'error': 'Speech recognition hit an unexpected error. Please try again.'}}
  print(json.dumps(response, ensure_ascii=False, separators=(',', ':')))
