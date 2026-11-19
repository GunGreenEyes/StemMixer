#!/usr/bin/env python3
"""Stem Mixer: local server that separates songs into stems and serves the mixer UI.

Usage:  python server.py [--port 8765] [--model htdemucs_6s] [--cache ./library]
Then open http://localhost:8765
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import re
import shutil
import tempfile
import threading
import time
import traceback
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

from separator import SAMPLE_RATE, DemucsSeparator, decode_audio, ffmpeg_exe

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
ALLOWED_EXT = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".aiff", ".aif", ".mp4", ".webm"}
MAX_UPLOAD = 500 * 1024 * 1024
PEAK_BUCKETS = 1200
SILENT_RMS = 1e-3  # ~ -60 dBFS: stem effectively absent from this song
ID_RE = re.compile(r"^[0-9a-f]{16}$")
NAME_RE = re.compile(r"^[a-z0-9_]{1,32}$")


def to_int16_interleaved(stem: np.ndarray) -> np.ndarray:
    """(2, frames) float -> interleaved int16, processed in blocks to cap temp memory."""
    frames = stem.shape[1]
    out = np.empty(frames * 2, dtype=np.int16)
    block = SAMPLE_RATE * 10
    for s in range(0, frames, block):
        e = min(frames, s + block)
        chunk = np.clip(stem[:, s:e].T, -1.0, 1.0) * 32767.0
        out[2 * s:2 * e] = np.rint(chunk).astype(np.int16).ravel()
    return out


def peaks_and_rms(stem: np.ndarray, buckets: int = PEAK_BUCKETS):
    mono = np.abs(stem).max(axis=0)
    n = mono.shape[0] // buckets * buckets
    peaks = mono[:n].reshape(buckets, -1).max(axis=1) if n else np.zeros(buckets)
    rms = float(np.sqrt(np.mean(np.square(stem, dtype=np.float64))))
    return [round(float(p), 3) for p in peaks], rms


class Library:
    """On-disk cache keyed by content hash: library/<id>/{meta.json,<stem>.pcm}."""

    def __init__(self, path: Path, separator):
        self.path = path
        self.path.mkdir(parents=True, exist_ok=True)
        self.separator = separator
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.queue: "queue.Queue[str]" = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()

    def meta(self, song_id: str):
        f = self.path / song_id / "meta.json"
        return json.loads(f.read_text()) if f.exists() else None

    def list(self):
        items = []
        for d in self.path.iterdir():
            m = self.meta(d.name) if ID_RE.match(d.name) else None
            if m:
                items.append({"id": d.name, "title": m["title"], "duration": m["frames"] / m["sampleRate"],
                              "created": m.get("created", 0)})
        return sorted(items, key=lambda x: -x["created"])

    def status(self, song_id: str):
        m = self.meta(song_id)
        if m:
            return {"state": "done", "progress": 1, **m}
        with self.lock:
            job = self.jobs.get(song_id)
            return dict(job) if job else None

    def submit(self, tmp_path: Path, digest: str, title: str) -> str:
        song_id = digest[:16]
        if self.meta(song_id):
            tmp_path.unlink(missing_ok=True)
            return song_id
        with self.lock:
            if song_id in self.jobs and self.jobs[song_id]["state"] in ("queued", "running"):
                tmp_path.unlink(missing_ok=True)
                return song_id
            work = self.path / song_id
            work.mkdir(exist_ok=True)
            src = work / ("source" + tmp_path.suffix)
            shutil.move(str(tmp_path), src)
            self.jobs[song_id] = {"state": "queued", "progress": 0, "message": "Waiting in queue",
                                  "title": title, "source": str(src)}
        self.queue.put(song_id)
        return song_id

    def _update(self, song_id, **kw):
        with self.lock:
            self.jobs[song_id].update(kw)

    def _worker(self):
        while True:
            song_id = self.queue.get()
            job = self.jobs[song_id]
            work = self.path / song_id
            try:
                self._update(song_id, state="running", message="Decoding audio")
                mix = decode_audio(job["source"])
                stems = self.separator.separate(
                    mix, lambda p, msg: self._update(song_id, progress=round(p, 4), message=msg))
                del mix
                info = []
                for name in list(stems):
                    stem = stems.pop(name)  # release each stem as soon as it is written
                    pcm = to_int16_interleaved(stem)
                    pcm.tofile(work / f"{name}.pcm")
                    peaks, rms = peaks_and_rms(stem)
                    info.append({"name": name, "peaks": peaks, "rms": rms, "silent": rms < SILENT_RMS})
                    frames = stem.shape[1]
                    del stem, pcm
                meta = {"title": job["title"], "sampleRate": SAMPLE_RATE, "channels": 2,
                        "frames": frames, "stems": info, "created": time.time()}
                (work / "meta.json.tmp").write_text(json.dumps(meta))
                os.replace(work / "meta.json.tmp", work / "meta.json")  # atomic: meta marks completion
                Path(job["source"]).unlink(missing_ok=True)
                with self.lock:
                    self.jobs.pop(song_id, None)
            except Exception as e:  # noqa: BLE001 - report any failure to the UI
                traceback.print_exc()
                self._update(song_id, state="error", message=str(e) or e.__class__.__name__)


class Handler(SimpleHTTPRequestHandler):
    library: Library = None  # set in main()

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_request(self, code="-", size="-"):
        # Keep the console quiet: only report failed requests.
        if str(code).isdigit() and int(code) >= 400:
            super().log_request(code, size)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = self.path.split("?")[0].strip("/").split("/")
        if parts[0] != "api":
            return super().do_GET()
        if parts[1:] == ["library"]:
            return self._json(self.library.list())
        if len(parts) == 3 and parts[1] == "status" and ID_RE.match(parts[2]):
            st = self.library.status(parts[2])
            return self._json(st) if st else self._json({"error": "not found"}, 404)
        if len(parts) == 4 and parts[1] == "stem" and ID_RE.match(parts[2]) and NAME_RE.match(parts[3]):
            f = self.library.path / parts[2] / f"{parts[3]}.pcm"
            if not f.exists():
                return self._json({"error": "not found"}, 404)
            size = f.stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "private, max-age=31536000, immutable")
            self.end_headers()
            with open(f, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1 << 20)
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path.split("?")[0] != "/api/upload":
            return self._json({"error": "not found"}, 404)
        name = os.path.basename(self.headers.get("X-Filename", "upload"))
        try:
            from urllib.parse import unquote
            name = unquote(name)
        except Exception:  # noqa: BLE001
            pass
        ext = Path(name).suffix.lower()
        if ext not in ALLOWED_EXT:
            return self._json({"error": f"Unsupported file type '{ext}'"}, 400)
        length = int(self.headers.get("Content-Length", 0))
        if not 0 < length <= MAX_UPLOAD:
            return self._json({"error": "File is empty or too large"}, 413)
        # Stream to disk while hashing: never hold the upload in memory.
        h = hashlib.sha256()
        fd, tmp = tempfile.mkstemp(suffix=ext, dir=self.library.path)
        with os.fdopen(fd, "wb") as out:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                h.update(chunk)
                out.write(chunk)
                remaining -= len(chunk)
        if remaining:
            os.unlink(tmp)
            return self._json({"error": "Upload interrupted"}, 400)
        song_id = self.library.submit(Path(tmp), h.hexdigest(), Path(name).stem)
        self._json({"id": song_id})

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def already_running(url: str) -> bool:
    from urllib.request import urlopen
    try:
        with urlopen(url + "/api/library", timeout=1) as r:
            return r.status == 200 and r.headers.get("Content-Type", "").startswith("application/json")
    except Exception:  # noqa: BLE001
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--model", default="htdemucs_6s",
                    help="Demucs model (htdemucs_6s = drums/bass/vocals/guitar/piano/other)")
    ap.add_argument("--device", default=None, help="cpu, cuda or mps (auto-detected by default)")
    ap.add_argument("--cache", default=str(ROOT / "library"), help="where separated songs are stored")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if not ffmpeg_exe():
        raise SystemExit("ffmpeg was not found. Install it, or run: pip install imageio-ffmpeg")
    httpd = None
    for port in range(args.port, args.port + 10):
        url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{port}"
        if already_running(url):
            # Double-clicked again: just bring the existing app up in the browser.
            print(f"Stem Mixer is already running at {url} - opening it.")
            if not args.no_browser:
                webbrowser.open(url)
            return
        try:
            httpd = ThreadingHTTPServer((args.host, port), Handler)
            break
        except OSError:
            continue  # port taken by some other program: try the next one
    if httpd is None:
        raise SystemExit(f"No free port found between {args.port} and {args.port + 9}.")
    Handler.library = Library(Path(args.cache), DemucsSeparator(args.model, args.device))
    print(f"Stem Mixer running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
