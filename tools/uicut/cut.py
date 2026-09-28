"""Cut the UI assets in public/ui/ from the owner references in art/ui/ref/.

Run from anywhere:  python tools/uicut/cut.py
Contract: docs/UI_STYLE.md section 3.
"""
import os
import shutil

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REF = os.path.join(ROOT, "art", "ui", "ref")
OUT = os.path.join(ROOT, "public", "ui")

# ---------------------------------------------------------------------------
# Crop table. Boxes are (x0, y0, x1, y1) in source pixels, x1/y1 exclusive.
#
# MASKS: luma -> alpha. lo = luma floor (below it alpha 0). "auto" floor = the
# 90th percentile luma of the box border + 8, so the local background is gone.
# knock = list of ellipses (cx, cy, rx, ry) in SOURCE coords cleared to alpha 0,
# feathered by FEATHER px. clip = optional polygon (source coords) outside of
# which alpha is 0.
# ---------------------------------------------------------------------------
FEATHER = 3.5

MASKS = {
    "ring-hud.png": dict(src="hud.png", box=(0, 4, 202, 236), lo=50,
                         knock=[(108, 100, 64, 58), (96, 162, 62, 46),
                                (201, 196, 12, 17), (200, 177, 16, 4),
                                (204, 162, 9, 5)]),
    "ring-win.png": dict(src="screens.png", box=(658, 10, 822, 136), lo=48,
                         knock=[(742, 84, 52, 54), (722, 128, 44, 24),
                                (671, 124, 15, 20)]),
    "splash.png": dict(src="screens.png", box=(556, 124, 920, 184), lo=40,
                       knock=[(724, 128, 46, 26)]),
    "cursor.png": dict(src="screens.png", box=(47, 53, 83, 76), lo=70,
                       channel="min",
                       clip=[(47, 64), (57, 57), (63, 53), (70, 60), (83, 64),
                             (70, 68), (63, 76), (57, 71)]),
    "petal-1.png": dict(src="screens.png", box=(650, 32, 664, 49), lo="auto"),
    "petal-2.png": dict(src="screens.png", box=(816, 35, 833, 52), lo="auto"),
    "petal-3.png": dict(src="screens.png", box=(1180, 72, 1197, 95), lo="auto"),
    "petal-4.png": dict(src="screens.png", box=(877, 122, 900, 143), lo="auto"),
}

# COLOR backdrops: keep colors, fade alpha on edges.
# fade = fractions of width/height per edge (left, top, right, bottom).
BACKDROPS = {
    "backdrop-face.png": dict(src="screens.png", box=(200, 10, 452, 183),
                              fade=(0.45, 0.0, 0.0, 0.0)),
    "backdrop-lose.png": dict(src="screens.png", box=(1128, 44, 1346, 178),
                              fade=(0.18, 0.18, 0.18, 0.18)),
    "backdrop-stage.png": dict(src="hud.png", box=(200, 0, 361, 110),
                               fade=(0.18, 0.18, 0.18, 0.18)),
}

COPIES = {
    "aeval-win.png": os.path.join(ROOT, "art", "aeval", "sheets", "crops",
                                  "extra_taunt_0.png"),
}


def luma(img):
    return img.convert("RGB").convert("L")


def min_channel(img):
    r, g, b = img.convert("RGB").split()
    return ImageChops.darker(ImageChops.darker(r, g), b)


def border_floor(l):
    w, h = l.size
    px = l.load()
    vals = sorted([px[x, 0] for x in range(w)] + [px[x, h - 1] for x in range(w)]
                  + [px[0, y] for y in range(h)] + [px[w - 1, y] for y in range(h)])
    return vals[int(len(vals) * 0.9)] + 8


def stretch(l, lo):
    hi = max(l.getextrema()[1], lo + 1)
    scale = 255.0 / (hi - lo)
    return l.point(lambda v: 0 if v <= lo else min(255, int((v - lo) * scale + 0.5)))


def knockout(alpha, box, ellipses, clip):
    x0, y0 = box[0], box[1]
    keep = Image.new("L", alpha.size, 255)
    if clip:
        keep = Image.new("L", alpha.size, 0)
        ImageDraw.Draw(keep).polygon([(x - x0, y - y0) for x, y in clip], fill=255)
    d = ImageDraw.Draw(keep)
    for cx, cy, rx, ry in ellipses:
        d.ellipse((cx - rx - x0, cy - ry - y0, cx + rx - x0, cy + ry - y0), fill=0)
    if ellipses:
        keep = keep.filter(ImageFilter.GaussianBlur(FEATHER / 2))
    return ImageChops.multiply(alpha, keep)


def cut_mask(name, spec, sources):
    crop = sources[spec["src"]].crop(spec["box"])
    l = min_channel(crop) if spec.get("channel") == "min" else luma(crop)
    lo = border_floor(l) if spec["lo"] == "auto" else spec["lo"]
    a = stretch(l, lo)
    a = knockout(a, spec["box"], spec.get("knock", []), spec.get("clip"))
    out = Image.new("RGBA", crop.size, (255, 255, 255, 0))
    out.putalpha(a)
    out.save(os.path.join(OUT, name))
    return out.size


def cut_backdrop(name, spec, sources):
    crop = sources[spec["src"]].crop(spec["box"]).convert("RGBA")
    w, h = crop.size
    fl, ft, fr, fb = spec["fade"]
    fade = Image.new("L", (w, h))
    px = fade.load()

    def ramp(d, n):
        return 1.0 if n <= 0 else min(1.0, d / n)

    for y in range(h):
        for x in range(w):
            v = (ramp(x, fl * w) * ramp(y, ft * h)
                 * ramp(w - 1 - x, fr * w) * ramp(h - 1 - y, fb * h))
            px[x, y] = int(v * 255 + 0.5)
    crop.putalpha(ImageChops.multiply(crop.getchannel("A"), fade))
    crop.save(os.path.join(OUT, name))
    return crop.size


def main():
    os.makedirs(OUT, exist_ok=True)
    sources = {n: Image.open(os.path.join(REF, n)).convert("RGB")
               for n in ("hud.png", "screens.png")}
    for name, spec in MASKS.items():
        print(name, cut_mask(name, spec, sources))
    for name, spec in BACKDROPS.items():
        print(name, cut_backdrop(name, spec, sources))
    for name, path in COPIES.items():
        shutil.copyfile(path, os.path.join(OUT, name))
        print(name, Image.open(path).size)


if __name__ == "__main__":
    main()
