"""Cut the HUD portrait bust and stock head (and, for new characters, the select
tile) from a character's idle frame.

Default (Aeval): art/aeval/sheets/crops/moves_idle_0.png (37x49 pixel art, feet at the bottom).
Outputs, at native pixel size (no resampling; the HUD scales them with pixelated rendering):
  public/icons/<char>-bust.png   head and shoulders
  public/icons/<char>-stock.png  head only, padded to a square
  public/icons/<char>.png        select tile, 256x256 (not for Aeval: her tile is owner art)

Run from the repo root:
  python tools/uicut/portrait.py
  python tools/uicut/portrait.py --char trekmore --src art/trekmore/sheets/crops/loco_idle_0.png
"""
import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "art/aeval/sheets/crops/moves_idle_0.png"
OUT = ROOT / "public/icons"

# Row ranges (end exclusive) in the source frame, per character.
ROWS = {
    # 49-row frame: hair tip down to the chest (cape shoulders included); hair tip to the collar
    "aeval": {"bust": (0, 37), "stock": (0, 28)},
    # 60-row loco_idle_0 (55 px body + 2 px pad top and bottom, heel at row 57):
    # helmet crest to the belt; helmet only (crest to the chin guard)
    "trekmore": {"bust": (0, 31), "stock": (0, 17), "stockCols": (32, 52)},
}
TILE = 256  # select tile side; the idle frame is scaled by the largest integer that fits 240 px


def trim_cols(img: Image.Image) -> Image.Image:
    box = img.getbbox()
    if box is None:
        return img
    return img.crop((box[0], 0, box[2], img.height))


def trim(img: Image.Image) -> Image.Image:
    box = img.getbbox()
    return img if box is None else img.crop(box)


def pad_square(img: Image.Image) -> Image.Image:
    side = max(img.width, img.height)
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(img, ((side - img.width) // 2, side - img.height))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", default="aeval", choices=sorted(ROWS))
    ap.add_argument("--src", default=None, help="idle frame png, relative to the repo root")
    args = ap.parse_args()
    src_path = SRC if args.src is None else ROOT / args.src
    rows = ROWS[args.char]
    src = Image.open(src_path).convert("RGBA")
    bust = trim_cols(src.crop((0, rows["bust"][0], src.width, rows["bust"][1])))
    c0, c1 = rows.get("stockCols", (0, src.width))  # helmet columns, so no cape shoulder
    head = pad_square(trim_cols(src.crop((c0, rows["stock"][0], c1, rows["stock"][1]))))
    OUT.mkdir(parents=True, exist_ok=True)
    bust.save(OUT / f"{args.char}-bust.png")
    head.save(OUT / f"{args.char}-stock.png")
    msg = f"bust {bust.size}, stock {head.size}"
    if args.char != "aeval":
        body = trim(src)
        z = max(1, 240 // max(body.width, body.height))
        big = body.resize((body.width * z, body.height * z), Image.NEAREST)
        tile = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
        tile.paste(big, ((TILE - big.width) // 2, TILE - 8 - big.height))
        tile.save(OUT / f"{args.char}.png")
        msg += f", tile {tile.size} at {z}x"
    print(msg)


if __name__ == "__main__":
    main()
