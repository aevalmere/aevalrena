"""Debug views: each cut layer of a stage over magenta (not shipped).

    python tools/stagecut/preview_layers.py <stageId> [outDir]

cut_stage.py already writes these as art/stages/<id>/view_*.png; this reruns
them from the shipped layer PNGs alone.
"""
import sys
from pathlib import Path
from PIL import Image

ART = Path(__file__).resolve().parents[2] / "art" / "stages" / sys.argv[1]
out = Path(sys.argv[2]) if len(sys.argv) > 2 else ART
for name in ("sky", "far", "mid", "stage"):
    im = Image.open(ART / "layers" / f"{name}.png").convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 0, 255, 255))
    bg.alpha_composite(im)
    bg.convert("RGB").save(out / f"view_{name}.png")
