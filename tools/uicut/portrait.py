"""Cut the HUD portrait bust and stock head from Aeval's idle frame.

Source: art/aeval/sheets/crops/moves_idle_0.png (37x49 pixel art, feet at the bottom).
Outputs, at native pixel size (no resampling; the HUD scales them with pixelated rendering):
  public/icons/aeval-bust.png   head and shoulders
  public/icons/aeval-stock.png  head only, padded to a square

Run from the repo root: python tools/uicut/portrait.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "art/aeval/sheets/crops/moves_idle_0.png"
OUT = ROOT / "public/icons"

# Row ranges (end exclusive) in the 49-row source frame.
BUST_ROWS = (0, 37)   # hair tip down to the chest, cape shoulders included
STOCK_ROWS = (0, 28)  # hair tip down to the collar


def trim_cols(img: Image.Image) -> Image.Image:
    box = img.getbbox()
    if box is None:
        return img
    return img.crop((box[0], 0, box[2], img.height))


def pad_square(img: Image.Image) -> Image.Image:
    side = max(img.width, img.height)
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(img, ((side - img.width) // 2, side - img.height))
    return out


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    bust = trim_cols(src.crop((0, BUST_ROWS[0], src.width, BUST_ROWS[1])))
    head = pad_square(trim_cols(src.crop((0, STOCK_ROWS[0], src.width, STOCK_ROWS[1]))))
    OUT.mkdir(parents=True, exist_ok=True)
    bust.save(OUT / "aeval-bust.png")
    head.save(OUT / "aeval-stock.png")
    print(f"bust {bust.size}, stock {head.size}")


if __name__ == "__main__":
    main()
