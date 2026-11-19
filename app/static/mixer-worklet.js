// Real-time stem mixer + pitch-preserving speed control, running on the audio thread.
//
// Design goals:
//  * Memory: stems stay as interleaved Int16 PCM (half the size of Float32 AudioBuffers),
//    transferred here zero-copy. The main thread keeps no copy. All working buffers are
//    allocated once in the constructor; process() never allocates.
//  * CPU: at 100% speed the stems are mixed straight to the output (one tight loop per
//    audible stem per 128-frame block). Stems at gain 0 are skipped entirely.
//  * Speed: when speed != 100% the mix is time-stretched with WSOLA (waveform-similarity
//    overlap-add): ~46 ms grains are taken from the song at the *speed-scaled* rate but laid
//    down at the *normal* rate, and each grain's start is nudged (±11.6 ms) to the spot whose
//    waveform best continues the previous grain. Durations change; pitch does not.
//  * Smoothness: gain changes and play/pause are ramped across one block; switching between
//    the direct and stretched paths is hidden under a 3 ms fade.

const INV_I16 = 1 / 32768;

// WSOLA parameters (frames). Grain 2048 ≈ 46 ms @ 44.1 kHz, 50% overlap with a periodic
// Hann window, which sums exactly to 1 so steady material passes through unchanged.
const GRAIN = 2048;
const HOP = GRAIN / 2;           // synthesis hop (output advance per grain)
const SEEK = 512;                // search ±SEEK frames around the nominal position
const REGION = 2 * SEEK + GRAIN; // frames mixed per grain (search area + grain)
const DECIM = 4;                 // coarse search step / correlation decimation
const MIN_RATE = 0.25, MAX_RATE = 2;

class StemMixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stems = [];          // Int16Array (interleaved L/R) per stem
    this.target = new Float32Array(0); // requested gain per stem (already includes master)
    this.current = new Float32Array(0); // gain applied at end of last block
    this.frames = 0;
    this.pos = 0;             // playback position (frames) on the direct path
    this.playing = false;
    this.fade = 0;            // global fade for click-free start/stop/path switch
    this.fadeTarget = 0;
    this.loopA = -1;
    this.loopB = -1;
    this.reportEvery = 12;    // ~35 ms at 44.1 kHz
    this.blockCount = 0;

    // Speed / WSOLA state
    this.rate = 1;            // rate currently in effect
    this.wantRate = 1;        // rate requested by the UI
    this.switching = false;   // fading out to swap between direct and stretched paths
    this.resumeFade = 0;
    this.win = new Float32Array(GRAIN);
    for (let i = 0; i < GRAIN; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN);
    this.regL = new Float32Array(REGION);
    this.regR = new Float32Array(REGION);
    this.regM = new Float32Array(REGION);   // mono of the region, for the similarity search
    this.natM = new Float32Array(HOP);      // mono of the previous grain's natural continuation
    this.accL = new Float32Array(GRAIN);    // overlap-add accumulator
    this.accR = new Float32Array(GRAIN);
    this.outL = new Float32Array(HOP);      // finished output waiting to be played
    this.outR = new Float32Array(HOP);
    this.outIdx = HOP;
    this.srcPos = 0;          // nominal (fractional) source position of the next grain
    this.grainStart = 0;      // source position of the grain now being played
    this.hasPrev = false;
    this.stretchEnded = false;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  get looping() { return this.loopA >= 0 && this.loopB > this.loopA; }
  get stretched() { return this.rate !== 1; }

  // Audible position, whichever path is active.
  get position() {
    if (!this.stretched) return this.pos;
    if (!this.hasPrev) return this.mapFrame(Math.round(this.srcPos));
    return this.mapFrame(Math.max(0, Math.round(this.grainStart + this.outIdx * this.rate)));
  }

  mapFrame(i) {
    if (this.looping && i >= this.loopB) i = this.loopA + ((i - this.loopB) % (this.loopB - this.loopA));
    return Math.min(i, this.frames);
  }

  resetStretch(at) {
    this.srcPos = at;
    this.grainStart = at;
    this.hasPrev = false;
    this.stretchEnded = false;
    this.accL.fill(0);
    this.accR.fill(0);
    this.outIdx = HOP;
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.stems = m.stems;
        this.frames = m.frames;
        this.target = new Float32Array(m.gains);
        this.current = new Float32Array(m.gains);
        this.pos = 0; this.playing = false; this.fade = 0; this.fadeTarget = 0;
        this.switching = false; this.rate = this.wantRate;
        this.loopA = this.loopB = -1;
        this.resetStretch(0);
        this.post();
        break;
      case 'unload':
        this.stems = []; this.frames = 0; this.playing = false; this.pos = 0;
        break;
      case 'gains':
        this.target.set(m.gains);
        break;
      case 'rate':
        this.wantRate = Math.max(MIN_RATE, Math.min(MAX_RATE, +m.rate || 1));
        if (!this.playing) this.applyRate();
        break;
      case 'play':
        if (!this.frames) return;
        if (this.position >= this.frames) this.seekTo(this.looping ? this.loopA : 0);
        else this.seekTo(this.position);
        this.playing = true; this.fadeTarget = this.switching ? this.fadeTarget : 1;
        this.resumeFade = 1;
        break;
      case 'pause':
        this.fadeTarget = 0; this.resumeFade = 0; // process() stops once the fade-out completes
        break;
      case 'seek':
        this.seekTo(m.frame | 0);
        this.post();
        break;
      case 'loop':
        this.loopA = m.a; this.loopB = m.b;
        if (this.looping) {
          const p = this.position;
          if (p < this.loopA || p >= this.loopB) this.seekTo(this.loopA);
        }
        break;
    }
  }

  seekTo(frame) {
    const f = Math.max(0, Math.min(this.frames, frame));
    this.pos = f;
    this.resetStretch(f);
  }

  // Switch between direct and stretched path at the current audible position.
  applyRate() {
    const p = this.position;
    this.rate = this.wantRate;
    this.pos = p;
    this.resetStretch(p);
  }

  post() {
    this.port.postMessage({ type: 'pos', frame: this.position, playing: this.playing && this.resumeFade > 0 });
  }

  // Mix all audible stems for source frames [start, start+len) into dstL/dstR.
  // Honors the loop (frames past B wrap to A) and yields silence outside the song.
  mixRange(dstL, dstR, start, len) {
    dstL.fill(0, 0, len);
    dstR.fill(0, 0, len);
    const stems = this.stems, tgt = this.target, cur = this.current;
    const looping = this.looping;
    let off = 0;
    while (off < len) {
      let i = start + off;
      if (i < 0) { off += Math.min(len - off, -i); continue; }
      if (looping && i >= this.loopB) i = this.loopA + ((i - this.loopB) % (this.loopB - this.loopA));
      const limit = looping && i < this.loopB ? this.loopB : this.frames;
      if (i >= limit) break; // past the end of the song: rest stays silent
      const piece = Math.min(len - off, limit - i);
      for (let s = 0; s < stems.length; s++) {
        const g = tgt[s] * INV_I16;
        if (g === 0) continue;
        const data = stems[s];
        let idx = i << 1;
        for (let k = off, kEnd = off + piece; k < kEnd; k++) {
          dstL[k] += data[idx] * g;
          dstR[k] += data[idx + 1] * g;
          idx += 2;
        }
      }
      off += piece;
    }
    cur.set(tgt); // stretched path applies gains per grain; overlap-add smooths the change
  }

  // Offset (0..2*SEEK) in the region whose waveform best continues the previous grain.
  findBestOffset() {
    const regM = this.regM, natM = this.natM;
    let bestK = SEEK, bestScore = -Infinity;
    // Coarse pass: every DECIM-th lag, correlating every DECIM-th sample.
    for (let k = 0; k <= 2 * SEEK; k += DECIM) {
      let c = 0, e = 0;
      for (let j = 0; j < HOP; j += DECIM) {
        const x = regM[k + j];
        c += x * natM[j];
        e += x * x;
      }
      const score = c / Math.sqrt(e + 1e-9);
      if (score > bestScore) { bestScore = score; bestK = k; }
    }
    // Fine pass: single-frame lags around the coarse winner, at half resolution.
    const k0 = Math.max(0, bestK - DECIM + 1), k1 = Math.min(2 * SEEK, bestK + DECIM - 1);
    bestScore = -Infinity;
    for (let k = k0; k <= k1; k++) {
      let c = 0, e = 0;
      for (let j = 0; j < HOP; j += 2) {
        const x = regM[k + j];
        c += x * natM[j];
        e += x * x;
      }
      const score = c / Math.sqrt(e + 1e-9);
      if (score > bestScore) { bestScore = score; bestK = k; }
    }
    return bestK;
  }

  // Produce the next HOP output frames into outL/outR.
  generateGrain() {
    if (this.looping && this.srcPos >= this.loopB) this.srcPos -= this.loopB - this.loopA;
    const target = Math.round(this.srcPos);
    const regStart = target - SEEK;
    const { regL, regR, regM, natM, accL, accR, win } = this;
    this.mixRange(regL, regR, regStart, REGION);

    let best = SEEK;
    if (this.hasPrev) {
      for (let i = 0, n = 2 * SEEK + HOP; i < n; i++) regM[i] = regL[i] + regR[i];
      best = this.findBestOffset();
    }
    for (let i = 0; i < GRAIN; i++) {
      const w = win[i];
      accL[i] += regL[best + i] * w;
      accR[i] += regR[best + i] * w;
    }
    // What would naturally follow this grain: the reference for the next search.
    for (let j = 0; j < HOP; j++) natM[j] = regL[best + HOP + j] + regR[best + HOP + j];
    this.hasPrev = true;

    // First half of the accumulator is now complete.
    this.outL.set(accL.subarray(0, HOP));
    this.outR.set(accR.subarray(0, HOP));
    accL.copyWithin(0, HOP); accL.fill(0, HOP);
    accR.copyWithin(0, HOP); accR.fill(0, HOP);
    this.outIdx = 0;

    this.grainStart = regStart + best;
    if (!this.looping && this.grainStart >= this.frames) this.stretchEnded = true;
    this.srcPos += HOP * this.rate;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    L.fill(0);
    if (R !== L) R.fill(0);
    if (!this.playing) return true;

    // Speed change while playing: same path → apply now; path change → fade out, swap, fade in.
    if (this.wantRate !== this.rate && !this.switching) {
      if ((this.wantRate === 1) === (this.rate === 1)) this.rate = this.wantRate;
      else { this.switching = true; this.resumeFade = this.fadeTarget; this.fadeTarget = 0; }
    }

    const ended = this.stretched ? this.renderStretched(L, R, n) : this.renderDirect(L, R, n);

    this.fade = this.fadeTarget;
    if (this.switching && this.fade === 0) {
      this.switching = false;
      this.applyRate();
      this.fadeTarget = this.resumeFade;
      if (this.fadeTarget === 0) { this.playing = false; this.post(); }
    } else if (ended || (this.fadeTarget === 0 && !this.switching)) {
      this.playing = false;
      this.fade = 0;
      this.resumeFade = 0;
      if (ended) { this.pos = this.frames; this.port.postMessage({ type: 'ended' }); }
      this.post();
    } else if (++this.blockCount >= this.reportEvery) {
      this.blockCount = 0;
      this.post();
    }
    return true;
  }

  renderDirect(L, R, n) {
    const fade0 = this.fade, fade1 = this.fadeTarget;
    const stems = this.stems, cur = this.current, tgt = this.target;
    const looping = this.looping;
    let written = 0;
    let ended = false;

    while (written < n) {
      const end = looping ? this.loopB : this.frames;
      const count = Math.min(n - written, end - this.pos);
      if (count <= 0) {
        if (looping) { this.pos = this.loopA; continue; }
        ended = true;
        break;
      }
      for (let s = 0; s < stems.length; s++) {
        // Gain for sample k in this block: linear ramp from start to end of the quantum.
        const g0 = cur[s] * fade0 * INV_I16;
        const g1 = tgt[s] * fade1 * INV_I16;
        if (g0 === 0 && g1 === 0) continue; // silent stem: no work at all
        const step = (g1 - g0) / n;
        const data = stems[s];
        let g = g0 + step * written;
        let idx = this.pos << 1;
        for (let k = written, kEnd = written + count; k < kEnd; k++) {
          L[k] += data[idx] * g;
          R[k] += data[idx + 1] * g;
          idx += 2;
          g += step;
        }
      }
      this.pos += count;
      written += count;
    }
    cur.set(tgt);
    return ended;
  }

  renderStretched(L, R, n) {
    const fade0 = this.fade, step = (this.fadeTarget - fade0) / n;
    let f = fade0;
    for (let k = 0; k < n; k++) {
      if (this.outIdx >= HOP) {
        if (this.stretchEnded) return true;
        this.generateGrain();
      }
      L[k] = this.outL[this.outIdx] * f;
      R[k] = this.outR[this.outIdx] * f;
      this.outIdx++;
      f += step;
    }
    return false;
  }
}

registerProcessor('stem-mixer', StemMixer);
