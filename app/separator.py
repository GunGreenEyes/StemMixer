"""Stem separation backed by Demucs (htdemucs_6s by default).

Produces six stems: drums, bass, vocals, guitar, piano, other.
Heavy imports (torch / demucs) are deferred until the first separation so the
server starts instantly and stays light while idle.
"""
from __future__ import annotations

import shutil
import subprocess
import threading
from typing import Callable, Dict

import numpy as np

SAMPLE_RATE = 44100
CHANNELS = 2

ProgressFn = Callable[[float, str], None]


def ffmpeg_exe() -> str | None:
    """System ffmpeg if installed, otherwise the copy bundled with the imageio-ffmpeg package."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return None


def decode_audio(path: str, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Decode any ffmpeg-readable file to float32 array shaped (2, frames)."""
    cmd = [
        ffmpeg_exe() or "ffmpeg", "-v", "error", "-nostdin", "-i", path,
        "-map", "0:a:0", "-ac", str(CHANNELS), "-ar", str(sample_rate),
        "-f", "f32le", "-",
    ]
    # CREATE_NO_WINDOW: don't flash a console window on Windows.
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    if proc.returncode != 0:
        raise RuntimeError("Could not decode audio: " + proc.stderr.decode(errors="replace").strip())
    data = np.frombuffer(proc.stdout, dtype=np.float32)
    if data.size < CHANNELS * sample_rate // 10:
        raise RuntimeError("File contains no usable audio")
    # (frames, 2) interleaved -> (2, frames); copy so the array is writable/contiguous.
    return np.ascontiguousarray(data.reshape(-1, CHANNELS).T)


def _allow_full_checkpoints(torch):
    """PyTorch 2.6+ refuses Demucs's checkpoint format by default (weights_only=True).
    The models come from Demucs's official download location, so load them the way Demucs
    was written to. This lets newer PyTorch builds (needed for RTX 50-series GPUs) work."""
    if getattr(torch.load, "_stem_mixer_patched", False):
        return
    original = torch.load

    def load(*args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return original(*args, **kwargs)

    load._stem_mixer_patched = True
    torch.load = load


def _gpu_works(torch, device: str) -> bool:
    """Run the kinds of operations Demucs uses. A GPU this PyTorch build wasn't compiled for
    fails here ("no kernel image is available") instead of halfway through a song."""
    try:
        x = torch.randn(1, 2, 4096, device=device)
        w = torch.randn(4, 2, 8, device=device)
        torch.nn.functional.conv1d(x, w)
        torch.stft(x[0], 1024, window=torch.hann_window(1024, device=device), return_complex=True).abs()
        if device == "cuda":
            torch.cuda.synchronize()
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[stem-mixer] {device} is not usable with this PyTorch build, using the CPU instead: {e}")
        return False


def _is_gpu_failure(e: Exception) -> bool:
    msg = str(e).lower()
    return any(s in msg for s in ("cuda", "cudnn", "cublas", "kernel image", "out of memory", "mps"))


class DemucsSeparator:
    """Keeps one model resident; separations are serialized by the caller."""

    def __init__(self, model_name: str = "htdemucs_6s", device: str | None = None):
        self.model_name = model_name
        self.device = device
        self._model = None
        self._lock = threading.Lock()

    def _load(self):
        if self._model is None:
            import torch
            from demucs.pretrained import get_model

            _allow_full_checkpoints(torch)
            if self.device is None:
                if torch.cuda.is_available() and _gpu_works(torch, "cuda"):
                    self.device = "cuda"
                elif (getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()
                      and _gpu_works(torch, "mps")):
                    self.device = "mps"
                else:
                    self.device = "cpu"
            print(f"[stem-mixer] Separating on: {self.device}")
            model = get_model(self.model_name)
            model.eval()
            self._model = model
        return self._model

    @property
    def sources(self):
        return list(self._load().sources)

    def separate(self, mix: np.ndarray, progress: ProgressFn) -> Dict[str, np.ndarray]:
        with self._lock:
            progress(0.0, "Loading model")
            model = self._load()
            import torch
            import demucs.apply as dapply

            # Demucs reports progress through tqdm; swap in a shim that forwards
            # chunk completion to our callback (one pass per sub-model in a bag).
            passes = len(getattr(model, "models", [model]))
            state = {"pass": 0, "label": "Separating"}

            class _TqdmShim:
                @staticmethod
                def tqdm(iterable, **_):
                    items = list(iterable)
                    p = state["pass"]
                    state["pass"] += 1
                    for i, item in enumerate(items):
                        yield item
                        progress((p + (i + 1) / len(items)) / passes, state["label"])

            original_tqdm = dapply.tqdm
            dapply.tqdm = _TqdmShim
            try:
                wav = torch.from_numpy(mix)
                ref = wav.mean(0)
                mean, std = ref.mean(), ref.std() + 1e-8
                wav = (wav - mean) / std
                def run():
                    state["pass"] = 0
                    with torch.inference_mode():
                        return dapply.apply_model(
                            model, wav[None], device=self.device, shifts=1,
                            split=True, overlap=0.25, progress=True,
                        )[0]

                try:
                    out = run()
                except RuntimeError as e:
                    if self.device == "cpu" or not _is_gpu_failure(e):
                        raise
                    # Any GPU problem: finish the song on the CPU, and stay there.
                    print(f"[stem-mixer] GPU failed ({e}); switching to the CPU.")
                    self.device = "cpu"
                    model.to("cpu")
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    state["label"] = "Separating on the CPU (graphics card not supported, slower)"
                    progress(0.0, state["label"])
                    out = run()
                out = out.cpu() * std + mean
            finally:
                dapply.tqdm = original_tqdm

            progress(1.0, "Writing stems")
            # Hand back numpy views one stem at a time; caller converts to int16.
            return {name: out[i].cpu().numpy() for i, name in enumerate(model.sources)}
