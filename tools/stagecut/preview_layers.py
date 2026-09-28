"""Debug views: each cut layer over magenta, written next to the layers (not shipped)."""
import sys
from pathlib import Path
from PIL import Image

ART = Path(__file__).resolve().parents[2] / "art" / "stages" / "tidegate"
out = Path(sys.argv[1]) if len(sys.argv) > 1 else ART
for name in ("sky", "far", "mid", "stage"):
    im = Image.open(ART / "layers" / f"{name}.png").convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 0, 255, 255))
    bg.alpha_composite(im)
    bg.convert("RGB").save(out / f"view_{name}.png")
