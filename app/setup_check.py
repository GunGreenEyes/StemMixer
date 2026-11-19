"""Run once by the Windows launcher at the end of setup: downloads the AI model, makes sure the
bundled audio decoder is present, and reports whether separation will use the GPU or the CPU."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from separator import DemucsSeparator, ffmpeg_exe  # noqa: E402

if not ffmpeg_exe():
    sys.exit("The audio decoder (ffmpeg) is missing.")

sep = DemucsSeparator()
sep._load()  # downloads the model on first run and tests the graphics card
if sep.device == "cuda":
    import torch
    print(f"  Graphics card OK: {torch.cuda.get_device_name(0)} - songs will separate quickly.")
elif sep.device == "mps":
    print("  Apple GPU OK - songs will separate quickly.")
else:
    print("  Songs will be separated on the CPU (roughly the length of the song each).")
