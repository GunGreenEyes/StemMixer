# Stem Mixer

Split a song into its instruments and practice along with it. Drop in an MP3/WAV/FLAC/M4A/OGG,
and Stem Mixer separates it into **Vocals, Drums, Bass, Guitar, Keys and Other** using the
[Demucs](https://github.com/facebookresearch/demucs) `htdemucs_6s` AI model. You then get a mixer
with a volume slider, mute and solo for every part, all applied live while the song plays.

Typical practice uses:
- **Learn a bass line**: solo Bass to hear it clearly, then mute it and play along.
- **Sing karaoke**: pull Vocals down to 0 (or 20% for a guide melody).
- **Drill a hard passage**: drag across a waveform to loop just that section.
- **Slow it down**: set Speed to 50–75% to learn a fast part. The pitch stays the same, so you
  can still play along in the right key. Speed it up past 100% to push yourself.

## Install

Requires Python 3.10+ and ffmpeg.

```bash
# ffmpeg:  macOS: brew install ffmpeg   ·   Ubuntu: sudo apt install ffmpeg   ·   Windows: winget install ffmpeg
cd stem-mixer
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

For an NVIDIA GPU (much faster separation), install the CUDA build of PyTorch first, following
the instructions at https://pytorch.org/get-started/locally/. Apple Silicon uses the GPU (MPS) automatically.

## Run

```bash
python server.py
```

Your browser opens at http://localhost:8765. Drop a song on the page or click **Open song…**.

- The first separation downloads the model (~80 MB, once).
- Separation time: about 1–3× the song length on a modern CPU, a few seconds on a GPU.
- Each song is processed **once** and saved in `library/` (keyed by file content), so it reopens
  instantly from the Library list. Delete a folder in `library/` to remove a song.

Options: `--port`, `--device cpu|cuda|mps`, `--cache <folder>`, `--model <demucs model>`, `--no-browser`.
`--model htdemucs` gives a 4-stem split (vocals/drums/bass/other) that is somewhat cleaner when you
don't need guitar and keys separated.

## Controls

| Action | Mouse | Key |
|---|---|---|
| Play / pause | ▶ button | `Space` |
| Jump | click a waveform | `←` / `→` (5 s), `Home` |
| Loop a section | drag across a waveform, or Loop A / Loop B buttons | `A`, `B`, `L` (clear) |
| Mute / solo part *n* | M / S buttons | `1`–`6` / `Shift`+`1`–`6` |
| Speed (50–150%, pitch unchanged) | Speed slider; click the % badge to reset | `[` / `]` (±5%) |
| Reset a slider | double-click it | |

Dimmed rows are instruments the model found (almost) nothing for in that song.

## How it's built for real-time performance

```
browser                                         server.py (Python, stdlib HTTP)
───────                                         ──────────────────────────────
UI (sliders) ──gains, ≤1 msg/frame──▶ AudioWorklet   upload ─▶ hash ─▶ queue ─▶ Demucs (one model kept loaded)
                                      "stem-mixer"            cache hit? skip         │
          ◀── raw int16 PCM stems ───────────────────────────────── library/<id>/*.pcm + meta.json
```

- **One mixing node on the audio thread.** All stems are summed in a single `AudioWorkletProcessor`
  (`static/mixer-worklet.js`): one tight loop per stem per 128-sample block, with no allocations and no
  garbage collection while playing. Slider moves reach the audio within one block (~3 ms) plus the
  output latency.
- **Muted stems cost nothing.** A stem at zero gain is skipped entirely, so soloing one part cuts the
  mixing work by about 6×.
- **Click-free.** Every gain change, and play/pause, is ramped linearly across one block, so dragging a
  slider never crackles or zips.
- **Speed without pitch change.** At any speed other than 100%, the mix is time-stretched in the same
  worklet with WSOLA (waveform-similarity overlap-add). About 46 ms slices of the song are read at the
  chosen speed but laid back down at normal speed, overlapped with smooth crossfades. Each slice's start
  is nudged by up to ±12 ms to the point whose waveform best lines up with the previous one, so the
  joins are seamless. The pitch never changes. The search runs coarse-to-fine on a reduced signal, so
  stretching six stems uses under 1% of one CPU core. At exactly 100% the stretcher is bypassed and
  costs nothing. Volume changes still apply immediately while stretched (within ~25 ms).
- **Half the memory.** Stems stay as 16-bit PCM in the browser instead of 32-bit float `AudioBuffer`s,
  and are *transferred* (zero-copy) into the audio thread, so the page keeps no second copy. A 4-minute
  song with 6 stems takes about 250 MB, versus about 500 MB decoded the usual way. Opening another song
  frees the previous one.
- **No decoding in the browser.** The server stores the stems as raw PCM, so loading is a straight
  memory copy with no `decodeAudioData` CPU spike or temporary buffers.
- **A light UI.** Slider events are coalesced into one message per animation frame. The waveform
  overviews are drawn once from 1200 precomputed peaks. Each frame only moves the playhead, and only
  when the position has changed.
- **Lean server.** Uploads stream to disk while being hashed, never sitting in RAM whole. The model
  loads lazily and stays resident. Separation runs in one background worker, so you can keep practicing
  one song while another is processed. Stems are converted to int16 in 10-second blocks and released one
  by one.

## Files

- `server.py`: HTTP server, upload, job queue, on-disk library
- `separator.py`: ffmpeg decoding and the Demucs wrapper (progress reporting, device auto-detect)
- `static/mixer-worklet.js`: the real-time mixer
- `static/app.js`, `index.html`, `style.css`: the interface

## Limits

- Separation quality is very good for vocals, drums and bass. Guitar and keys are harder: some of
  each can bleed into "Other", especially in dense mixes.
- Time-stretching is tuned for 50–150%. Very percussive material at 50% can sound slightly
  "flammy" (doubled drum hits), which is normal for this kind of processing.
- The server binds to `127.0.0.1`, so it is reachable only from your own computer.
