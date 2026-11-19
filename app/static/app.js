// Stem Mixer UI: upload → poll separation → stream stems into the AudioWorklet mixer.

const STEM_INFO = {
  vocals: { label: 'Vocals', color: '#ff6b9a' },
  drums:  { label: 'Drums',  color: '#ffb547' },
  bass:   { label: 'Bass',   color: '#7ce07a' },
  guitar: { label: 'Guitar', color: '#4fd1ff' },
  piano:  { label: 'Keys', color: '#b48cff' },
  other:  { label: 'Other',  color: '#9aa3b5' },
};
const ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];

const $ = (s) => document.querySelector(s);
const el = {
  file: $('#file'), drop: $('#drop'), job: $('#job'), jobTitle: $('#job-title'), jobPct: $('#job-pct'),
  jobBar: $('#job-bar'), jobMsg: $('#job-msg'), mixer: $('#mixer'), title: $('#song-title'),
  master: $('#master'), speed: $('#speed'), speedVal: $('#speed-val'), play: $('#play'), time: $('#time'), stems: $('#stems'),
  loopA: $('#loop-a'), loopB: $('#loop-b'), loopClear: $('#loop-clear'), reset: $('#reset'),
  libCard: $('#library-card'), lib: $('#library'), tpl: $('#stem-row'),
};

// ---------- state ----------
let ctx = null, node = null;
let song = null;        // { id, title, sampleRate, frames, stems: [...] }
let rows = [];          // per-stem UI + mix state
let frame = 0, playing = false;
let loop = { a: -1, b: -1 };
let pendingA = -1;
let loadToken = 0;

// Perceptual slider: 0..100 → gain via squared curve (≈ -40 dB at 10%, 0 dB at 100%).
const sliderGain = (v) => (v / 100) ** 2;
const fmtDb = (g) => (g <= 0.0001 ? '−∞ dB' : `${(20 * Math.log10(g)).toFixed(1)} dB`);
const fmtTime = (f) => {
  const s = Math.max(0, f / (song?.sampleRate || 44100));
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

async function ensureAudio(sampleRate) {
  if (ctx && ctx.sampleRate === sampleRate) return;
  if (ctx) await ctx.close();
  // 'interactive' keeps buffers small so slider moves are heard immediately.
  ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('mixer-worklet.js');
  node = new AudioWorkletNode(ctx, 'stem-mixer', { numberOfInputs: 0, outputChannelCount: [2] });
  node.connect(ctx.destination);
  node.port.postMessage({ type: 'rate', rate: +el.speed.value / 100 });
  node.port.onmessage = ({ data }) => {
    if (data.type === 'pos') { frame = data.frame; setPlaying(data.playing); }
    else if (data.type === 'ended') setPlaying(false);
  };
}

// ---------- mix ----------
let gainsQueued = false;
function pushGains() {
  // Coalesce bursts of slider events into one message per animation frame.
  if (gainsQueued || !node) return;
  gainsQueued = true;
  requestAnimationFrame(() => {
    gainsQueued = false;
    const master = sliderGain(+el.master.value);
    const anySolo = rows.some((r) => r.solo);
    const gains = rows.map((r) => {
      const audible = anySolo ? r.solo : !r.mute;
      r.el.classList.toggle('off', !audible);
      return audible ? sliderGain(r.vol) * master : 0;
    });
    node.port.postMessage({ type: 'gains', gains });
  });
}

function setPlaying(p) {
  playing = p;
  el.play.textContent = p ? '❚❚' : '▶';
}

function togglePlay() {
  if (!song || !node) return;
  ctx.resume();
  node.port.postMessage({ type: playing ? 'pause' : 'play' });
  setPlaying(!playing);
}

function seek(f) {
  if (!song) return;
  frame = Math.max(0, Math.min(song.frames, Math.round(f)));
  node.port.postMessage({ type: 'seek', frame });
}

function setLoop(a, b) {
  loop = a >= 0 && b > a ? { a, b } : { a: -1, b: -1 };
  node?.port.postMessage({ type: 'loop', ...loop });
  el.loopClear.disabled = loop.a < 0;
  el.loopA.classList.toggle('on', pendingA >= 0 || loop.a >= 0);
  el.loopA.classList.add('loop'); el.loopB.classList.add('loop');
  el.loopB.classList.toggle('on', loop.a >= 0);
  for (const r of rows) {
    const show = loop.a >= 0;
    r.loopEl.hidden = !show;
    if (show) {
      r.loopEl.style.left = `${(loop.a / song.frames) * 100}%`;
      r.loopEl.style.width = `${((loop.b - loop.a) / song.frames) * 100}%`;
    }
  }
}

// ---------- rendering ----------
function drawWave(canvas, peaks, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = color;
  const mid = h / 2, n = peaks.length;
  for (let x = 0; x < w; x++) {
    // max over the peaks that fall into this pixel column
    const i0 = Math.floor((x / w) * n), i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
    let p = 0;
    for (let i = i0; i < i1; i++) if (peaks[i] > p) p = peaks[i];
    const y = Math.max(0.5, Math.min(1, p) * mid * 0.95);
    g.fillRect(x, mid - y, 1, y * 2);
  }
}

function redrawWaves() { for (const r of rows) drawWave(r.canvas, r.peaks, r.color); }
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(redrawWaves, 120); });

let lastFrameDrawn = -1;
function tick() {
  // Only touch the DOM when the position actually changed.
  if (song && frame !== lastFrameDrawn) {
    lastFrameDrawn = frame;
    const pct = (frame / song.frames) * 100;
    for (const r of rows) r.head.style.left = `${pct}%`;
    el.time.textContent = `${fmtTime(frame)} / ${fmtTime(song.frames)}`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function buildRows() {
  el.stems.replaceChildren();
  const ordered = [...song.stems].sort((a, b) => {
    const ia = ORDER.indexOf(a.name), ib = ORDER.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  rows = ordered.map((s, idx) => {
    const info = STEM_INFO[s.name] || { label: s.name, color: '#9aa3b5' };
    const frag = el.tpl.content.cloneNode(true);
    const root = frag.querySelector('.stem');
    const r = {
      name: s.name, idx, peaks: s.peaks, color: info.color, el: root,
      vol: 100, mute: false, solo: false,
      canvas: root.querySelector('canvas'), slider: root.querySelector('input'),
      db: root.querySelector('.db'), muteBtn: root.querySelector('.mute'), soloBtn: root.querySelector('.solo'),
    };
    root.querySelector('.dot').style.background = info.color;
    root.querySelector('.name').textContent = `${idx + 1}. ${info.label}`;
    if (s.silent) { root.classList.add('silent'); root.title = 'This instrument is (almost) absent from the song'; }
    const wave = root.querySelector('.wave');
    r.head = Object.assign(document.createElement('div'), { className: 'overlay playhead' });
    r.loopEl = Object.assign(document.createElement('div'), { className: 'overlay loop-region', hidden: true });
    wave.append(r.loopEl, r.head);
    attachWaveMouse(wave);

    r.slider.addEventListener('input', () => setVol(r, +r.slider.value));
    r.slider.addEventListener('dblclick', () => setVol(r, 100));
    r.muteBtn.addEventListener('click', () => toggleMute(r));
    r.soloBtn.addEventListener('click', () => toggleSolo(r));
    el.stems.append(frag);
    return r;
  });
  requestAnimationFrame(redrawWaves);
}

function setVol(r, v) {
  r.vol = v; r.slider.value = v;
  r.db.textContent = fmtDb(sliderGain(v));
  pushGains();
}
function toggleMute(r) { r.mute = !r.mute; r.muteBtn.classList.toggle('on', r.mute); pushGains(); }
function toggleSolo(r) { r.solo = !r.solo; r.soloBtn.classList.toggle('on', r.solo); pushGains(); }

function attachWaveMouse(wave) {
  wave.addEventListener('pointerdown', (e) => {
    if (!song) return;
    const rect = wave.getBoundingClientRect();
    const toFrame = (x) => Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * song.frames;
    const x0 = e.clientX;
    let dragging = false;
    wave.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!dragging && Math.abs(ev.clientX - x0) > 5) dragging = true;
      if (dragging) {
        const a = toFrame(Math.min(x0, ev.clientX)), b = toFrame(Math.max(x0, ev.clientX));
        pendingA = -1;
        setLoop(Math.round(a), Math.round(b));
      }
    };
    const up = (ev) => {
      wave.removeEventListener('pointermove', move);
      wave.removeEventListener('pointerup', up);
      if (dragging) seek(loop.a);
      else seek(toFrame(ev.clientX));
    };
    wave.addEventListener('pointermove', move);
    wave.addEventListener('pointerup', up);
  });
}

// ---------- loading ----------
async function openSong(id) {
  const token = ++loadToken;
  const meta = await (await fetch(`/api/status/${id}`)).json();
  if (meta.state !== 'done') return watchJob(id, meta.title);
  showJob(meta.title, 'Loading stems', 0);

  await ensureAudio(meta.sampleRate);
  node.port.postMessage({ type: 'unload' }); // let the previous song's buffers be collected
  setPlaying(false);

  // Download stems in parallel, tracking bytes for the progress bar.
  const total = meta.frames * 4 * meta.stems.length;
  let loaded = 0;
  const buffers = await Promise.all(meta.stems.map(async (s) => {
    const res = await fetch(`/api/stem/${id}/${s.name}`);
    if (!res.ok) throw new Error(`Missing stem ${s.name}`);
    const buf = new Uint8Array(meta.frames * 4);
    const reader = res.body.getReader();
    let off = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf.set(value, off); off += value.length; loaded += value.length;
      if (token === loadToken) setJobProgress(loaded / total, 'Loading stems');
    }
    return buf.buffer;
  }));
  if (token !== loadToken) return; // user opened something else meanwhile

  song = { id, ...meta };
  el.job.hidden = true;
  el.mixer.hidden = false;
  document.body.classList.add('has-song');
  el.title.textContent = meta.title;
  document.title = `${meta.title} · Stem Mixer`;
  buildRows();

  // Stem order in the worklet must match `rows` order.
  const byName = Object.fromEntries(meta.stems.map((s, i) => [s.name, buffers[i]]));
  const stems = rows.map((r) => new Int16Array(byName[r.name]));
  node.port.postMessage(
    { type: 'load', frames: meta.frames, stems, gains: rows.map(() => sliderGain(+el.master.value)) },
    stems.map((s) => s.buffer), // transfer ownership: zero-copy, main thread keeps nothing
  );
  frame = 0; lastFrameDrawn = -1; pendingA = -1;
  setLoop(-1, -1);
  for (const r of rows) setVol(r, 100);
  try { localStorage.setItem('lastSong', id); } catch { /* storage unavailable */ }
}

function showJob(title, msg, p) {
  el.job.hidden = false; el.job.classList.remove('error');
  el.jobTitle.textContent = title || '';
  setJobProgress(p, msg);
}
function setJobProgress(p, msg) {
  el.jobBar.style.width = `${(p * 100).toFixed(1)}%`;
  el.jobPct.textContent = `${Math.round(p * 100)}%`;
  el.jobMsg.textContent = msg || '';
}
function showError(msg) {
  el.job.hidden = false; el.job.classList.add('error');
  el.jobMsg.textContent = `Error: ${msg}`;
}

async function watchJob(id, title) {
  const token = ++loadToken;
  showJob(title, 'Starting…', 0);
  const started = Date.now();
  for (;;) {
    if (token !== loadToken) return;
    const st = await (await fetch(`/api/status/${id}`)).json();
    if (st.state === 'error') return showError(st.message);
    if (st.state === 'done') { refreshLibrary(); return openSong(id); }
    let msg = st.message || '';
    if (st.state === 'running' && st.progress > 0.02) {
      const elapsed = (Date.now() - started) / 1000;
      const left = Math.max(0, elapsed / st.progress - elapsed);
      msg += ` · about ${left > 90 ? Math.round(left / 60) + ' min' : Math.round(left) + ' s'} left`;
    } else if (st.message === 'Loading model') {
      msg += ' (first run downloads ~80 MB of model weights)';
    }
    setJobProgress(st.progress || 0, msg);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function upload(file) {
  if (!file) return;
  showJob(file.name, 'Uploading', 0);
  try {
    const res = await fetch('/api/upload', {
      method: 'POST', body: file,
      headers: { 'X-Filename': encodeURIComponent(file.name) },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    await watchJob(data.id, file.name.replace(/\.[^.]+$/, ''));
  } catch (e) { showError(e.message); }
}

async function refreshLibrary() {
  const items = await (await fetch('/api/library')).json();
  el.libCard.hidden = !items.length;
  el.lib.replaceChildren(...items.map((it) => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = it.title;
    const dur = document.createElement('span'); dur.className = 'muted mono';
    dur.textContent = fmtTime(it.duration * (song?.sampleRate || 44100));
    li.append(name, dur);
    li.addEventListener('click', () => openSong(it.id).catch((e) => showError(e.message)));
    return li;
  }));
}

// ---------- wiring ----------
// Drop focus after mouse clicks so Space always means play/pause, not "press the last button".
document.addEventListener('click', (e) => e.target.closest?.('button')?.blur());
el.file.addEventListener('change', () => { upload(el.file.files[0]); el.file.value = ''; });
for (const t of ['dragenter', 'dragover']) document.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); });
for (const t of ['dragleave', 'drop']) document.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); });
document.addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));

el.play.addEventListener('click', togglePlay);
el.master.addEventListener('input', pushGains);

// Speed: 50–150 %, pitch preserved by the worklet's time-stretcher.
function setSpeed(pct) {
  pct = Math.max(50, Math.min(150, Math.round(pct / 5) * 5));
  el.speed.value = pct;
  el.speedVal.textContent = `${pct}%`;
  el.speedVal.classList.toggle('changed', pct !== 100);
  node?.port.postMessage({ type: 'rate', rate: pct / 100 });
  try { localStorage.setItem('speed', pct); } catch { /* storage unavailable */ }
}
el.speed.addEventListener('input', () => setSpeed(+el.speed.value));
el.speed.addEventListener('dblclick', () => setSpeed(100));
el.speedVal.addEventListener('click', () => setSpeed(100));
try { const s = +localStorage.getItem('speed'); if (s) setSpeed(s); } catch { /* storage unavailable */ }
el.master.addEventListener('dblclick', () => { el.master.value = 90; pushGains(); });
el.loopA.addEventListener('click', () => {
  pendingA = frame;
  if (loop.a >= 0 && loop.b > frame) setLoop(frame, loop.b);
  else { el.loopA.classList.add('on'); }
});
el.loopB.addEventListener('click', () => {
  const a = pendingA >= 0 ? pendingA : loop.a >= 0 ? loop.a : 0;
  if (frame > a) { pendingA = -1; setLoop(a, frame); }
});
el.loopClear.addEventListener('click', () => { pendingA = -1; setLoop(-1, -1); });
el.reset.addEventListener('click', () => {
  for (const r of rows) {
    r.mute = r.solo = false;
    r.muteBtn.classList.remove('on'); r.soloBtn.classList.remove('on');
    setVol(r, 100);
  }
});

document.addEventListener('keydown', (e) => {
  if (!song || e.target.matches('input[type=file], textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const sr = song.sampleRate;
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowLeft' && !e.target.matches('input[type=range]')) seek(frame - 5 * sr);
  else if (e.code === 'ArrowRight' && !e.target.matches('input[type=range]')) seek(frame + 5 * sr);
  else if (e.code === 'Home') seek(loop.a >= 0 ? loop.a : 0);
  else if (e.code === 'KeyA') el.loopA.click();
  else if (e.code === 'KeyB') el.loopB.click();
  else if (e.code === 'KeyL') el.loopClear.click();
  else if (e.code === 'BracketLeft') setSpeed(+el.speed.value - 5);
  else if (e.code === 'BracketRight') setSpeed(+el.speed.value + 5);
  else if (digit && rows[digit[1] - 1]) {
    const r = rows[digit[1] - 1];
    e.shiftKey ? toggleSolo(r) : toggleMute(r);
  }
});

refreshLibrary().then(() => {
  let last = null;
  try { last = localStorage.getItem('lastSong'); } catch { /* storage unavailable */ }
  if (last) fetch(`/api/status/${last}`).then((r) => r.ok && r.json()).then((st) => {
    if (st && st.state === 'done') openSong(last);
  });
}).catch(() => {});
