"""Contact sheet of public/ui/ for review: masks painted #7fb2ff on #070a16,
backdrops composited on #070a16. Writes art/ui/CONTACT.png (review only, never shipped).
Run after cut.py:  python tools/uicut/contact.py
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
UI = os.path.join(ROOT, "public", "ui")
OUT = os.path.join(ROOT, "art", "ui", "CONTACT.png")
BG = (7, 10, 22, 255)
INK = (127, 178, 255)

MASKS = ["ring-hud.png", "ring-win.png", "splash.png", "cursor.png",
         "petal-1.png", "petal-2.png", "petal-3.png", "petal-4.png"]
COLOR = ["backdrop-face.png", "backdrop-lose.png", "backdrop-stage.png", "aeval-win.png"]


def tile(name, mask):
    im = Image.open(os.path.join(UI, name)).convert("RGBA")
    scale = 2 if max(im.size) > 100 else (4 if max(im.size) > 30 else 6)
    if mask:
        paint = Image.new("RGBA", im.size, INK + (255,))
        paint.putalpha(im.getchannel("A"))
        im = paint
    im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
    card = Image.new("RGBA", (im.width + 16, im.height + 32), BG)
    card.alpha_composite(im, (8, 24))
    ImageDraw.Draw(card).text((8, 6), f"{name} {im.width // scale}x{im.height // scale} @{scale}x",
                              fill=(220, 220, 220))
    return card


def main():
    cards = [tile(n, True) for n in MASKS] + [tile(n, False) for n in COLOR]
    width = 1400
    rows, row, x = [], [], 0
    for c in cards:
        if row and x + c.width > width:
            rows.append(row)
            row, x = [], 0
        row.append(c)
        x += c.width + 8
    rows.append(row)
    height = sum(max(c.height for c in r) + 8 for r in rows)
    sheet = Image.new("RGBA", (width, height), (30, 30, 40, 255))
    y = 0
    for r in rows:
        x = 0
        for c in r:
            sheet.alpha_composite(c, (x, y))
            x += c.width + 8
        y += max(c.height for c in r) + 8
    sheet.save(OUT)
    print("CONTACT.png", sheet.size)


if __name__ == "__main__":
    main()
