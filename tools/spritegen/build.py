"""Build Aeval's sprite atlas from the reference sheets.

Run from the repo root:  python tools/spritegen/build.py

Writes, per sheet kind:
  src/characters/aeval/art/atlas.<kind>.ts   the packed PNG as a data URL plus
                                             a frame table
  art/aeval/preview/<kind>.png               a blown-up contact sheet to judge
                                             the art on

Body frames are baked so the frame's bottom row is the character's heel line
and the frame's horizontal centre is the body's centre. That is exactly the
origin the fighter renderer already assumes, so no per-frame pivot is needed
and flipping stays symmetric. Water may hang off either side; the anchor
deliberately ignores water-coloured pixels so a sweep or a splash never shifts
the body.
"""
import base64
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image, ImageDraw

import pixelize as P
from palette import PALETTE, PALETTE_NAMES
import frames as F

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART_OUT = os.path.join(ROOT, "src", "characters", "aeval", "art")
PREVIEW_OUT = os.path.join(ROOT, "art", "aeval", "preview")

WATER_INDEX = {i for i, n in enumerate(PALETTE_NAMES) if n.startswith("water")}
WATER_RGB = {PALETTE[i] for i in WATER_INDEX}


def is_body(c):
    """True for character material. Water is excluded so it never moves the anchor."""
    return c[3] > 0 and (c[0], c[1], c[2]) not in WATER_RGB


def split_group(im, count):
    """Cut a multi-frame group into `count` slices at its emptiest columns."""
    if count <= 1:
        return [im]
    w, h = im.size
    px = im.load()
    weight = []
    for x in range(w):
        n = 0
        for y in range(h):
            if px[x, y][3] > 0:
                n += 1
        weight.append(n)

    cuts = [0]
    step = w / count
    window = max(2, int(step * 0.28))
    for i in range(1, count):
        ideal = int(round(i * step))
        lo = max(cuts[-1] + 4, ideal - window)
        hi = min(w - 4, ideal + window)
        if hi <= lo:
            cuts.append(ideal)
            continue
        best = lo
        for x in range(lo, hi + 1):
            if weight[x] < weight[best]:
                best = x
        cuts.append(best)
    cuts.append(w)
    return [im.crop((cuts[i], 0, cuts[i + 1], h)) for i in range(count)]


def anchor(im, dy=0):
    """(centre x, heel row) from body pixels only, in this image's own pixels."""
    w, h = im.size
    px = im.load()
    xs = []
    heel = -1
    for y in range(h):
        for x in range(w):
            if is_body(px[x, y]):
                xs.append(x)
                if y > heel:
                    heel = y
    if heel < 0:
        return (w // 2, h - 1)
    xs.sort()
    cx = xs[len(xs) // 2]
    return (cx, min(h - 1, heel + dy))


def place_body(im, dy=0):
    """Re-frame so bottom row is the heel line and the body centre is centred."""
    box = P.tight(im, thresh=1)
    if box is None:
        return None
    cx, heel = anchor(im, dy)
    x0, y0, x1, y1 = box
    left = cx - x0
    right = x1 - cx
    half = max(left, right) + 1
    w = half * 2
    h = heel + 1 - y0
    if h <= 0:
        return None
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(im.crop((x0, y0, x1, min(y1, heel + 1))), (half - left, 0))
    return out


def place_center(im):
    """Re-frame so the image centre is the frame centre, for effect sheets."""
    box = P.tight(im, thresh=1)
    if box is None:
        return None
    x0, y0, x1, y1 = box
    cx = (x0 + x1) // 2
    cy = (y0 + y1) // 2
    half_w = max(cx - x0, x1 - cx) + 1
    half_h = max(cy - y0, y1 - cy) + 1
    out = Image.new("RGBA", (half_w * 2, half_h * 2), (0, 0, 0, 0))
    out.paste(im.crop(box), (half_w - (cx - x0), half_h - (cy - y0)))
    return out


_keyed_cache = {}


def keyed_sheet(path, bg):
    if path not in _keyed_cache:
        _keyed_cache[path] = P.keyed(path, bg=bg)
    return _keyed_cache[path]


def build_groups(groups, char_h=None, bg=F.CLEAN_BG, center=False):
    """Every group in `groups` to a list of (frame name, native RGBA image)."""
    char_h = F.CHAR_H if char_h is None else char_h
    out = []
    for g in groups:
        scale = char_h / g["ref"]
        sheet = keyed_sheet(g["sheet"], bg)
        crop = sheet.crop(g["box"])
        crop = P.fill_holes(crop)
        slices = split_group(crop, g["count"])
        for i, part in enumerate(slices):
            box = P.tight(part, thresh=24)
            if box is None:
                print(f"  !! {g['name']}{i} is empty")
                continue
            part = part.crop(box)
            w = max(1, round(part.size[0] * scale))
            h = max(1, round(part.size[1] * scale))
            small = P.downsample(part, w, h)
            small = P.cleanup(small)
            small = P.despeckle(small)
            framed = place_center(small) if center else place_body(small, g["dy"])
            if framed is None:
                print(f"  !! {g['name']}{i} vanished in cleanup")
                continue
            name = g["name"] if g["count"] == 1 else f"{g['name']}{i}"
            out.append((name, framed))
    return out


def pack(items, pad=1):
    """Shelf-pack frames tallest first. Returns (atlas image, frame table)."""
    order = sorted(items, key=lambda kv: -kv[1].size[1])
    width = 256
    while True:
        x = y = 0
        shelf = 0
        placed = {}
        ok = True
        for name, im in order:
            w, h = im.size
            if x + w + pad > width:
                x = 0
                y += shelf + pad
                shelf = 0
            if w + pad > width:
                ok = False
                break
            placed[name] = (x, y, w, h)
            x += w + pad
            if h > shelf:
                shelf = h
        if ok:
            height = y + shelf
            if height <= width * 4:
                break
        width *= 2
        if width > 4096:
            raise RuntimeError("atlas will not pack")
    atlas = Image.new("RGBA", (width, max(1, height)), (0, 0, 0, 0))
    for name, im in order:
        x, y, w, h = placed[name]
        atlas.paste(im, (x, y))
    return atlas, placed


def contact_sheet(items, zoom=5, cols=8, guide=None):
    """Bottom-aligned grid. `guide` rules a line where a correctly sized
    character's head should reach, which is how scale errors get spotted."""
    cw = max(im.size[0] for _, im in items) + 6
    ch = max(im.size[1] for _, im in items) + 6
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGB", (cw * cols * zoom, ch * rows * zoom), (118, 120, 130))
    draw = ImageDraw.Draw(sheet)
    for r in range(rows):
        base = (r + 1) * ch * zoom - 2 * zoom
        draw.line([(0, base), (sheet.size[0], base)], fill=(84, 86, 96))
        if guide:
            top = base - guide * zoom
            draw.line([(0, top), (sheet.size[0], top)], fill=(150, 96, 96))
    for i, (_name, im) in enumerate(items):
        c, r = i % cols, i // cols
        up = im.resize((im.size[0] * zoom, im.size[1] * zoom), Image.Resampling.NEAREST)
        ox = c * cw * zoom + (cw * zoom - up.size[0]) // 2
        oy = (r + 1) * ch * zoom - 2 * zoom - up.size[1]
        sheet.paste(up, (ox, oy), up)
    return sheet


WATER_HEX = [f"#{r:02x}{g:02x}{b:02x}" for (r, g, b) in sorted(WATER_RGB)]


def emit(kind, items, origin):
    os.makedirs(ART_OUT, exist_ok=True)
    os.makedirs(PREVIEW_OUT, exist_ok=True)
    atlas, table = pack(items)
    buf = io.BytesIO()
    atlas.save(buf, format="PNG", optimize=True)
    raw = buf.getvalue()
    b64 = base64.b64encode(raw).decode("ascii")

    ignore = ", ".join(f"'{h}'" for h in WATER_HEX) if origin == "bottom-center" else ""
    rows = ",\n".join(
        f"  {json.dumps(name)}: [{t[0]}, {t[1]}, {t[2]}, {t[3]}]"
        for name, t in sorted(table.items())
    )
    ts = f'''// GENERATED by tools/spritegen/build.py -- do not hand edit.
// Aeval {kind} atlas, pixelised from the reference sheets. {len(items)} frames,
// {atlas.size[0]}x{atlas.size[1]}, {len(raw) / 1024:.1f} KB of PNG.
// Frame origin: {origin}.

import type {{ ImageSheetData }} from '../../../core/types';

const FRAMES: Record<string, [number, number, number, number]> = {{
{rows},
}};

export const {kind.upper()}_ATLAS: ImageSheetData = {{
  origin: '{origin}',
  frames: FRAMES,
  outlineIgnore: [{ignore}],
  url:
    'data:image/png;base64,{b64}',
}};
'''
    path = os.path.join(ART_OUT, f"atlas.{kind}.ts")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(ts)
    guide = F.CHAR_H if origin == "bottom-center" else None
    contact_sheet(items, guide=guide).save(os.path.join(PREVIEW_OUT, f"{kind}.png"))
    print(f"{kind}: {len(items)} frames, atlas {atlas.size[0]}x{atlas.size[1]}, "
          f"{len(raw) / 1024:.1f} KB -> {os.path.relpath(path, ROOT)}")
    return atlas


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("all", "body"):
        items = build_groups(F.MOVEMENT + F.STATES + F.ATTACKS)
        emit("body", items, "bottom-center")
    if which in ("all", "fx"):
        items = build_groups(F.EFFECTS, center=True)
        # The sheet draws one whirlpool. Mirroring it reads as the spiral
        # turning over, which is all a two-frame loop needs.
        whirl = dict(items).get("whirl")
        if whirl is not None:
            items.append(("whirl1", whirl.transpose(Image.Transpose.FLIP_LEFT_RIGHT)))
            items = [("whirl0", whirl) if n == "whirl" else (n, im) for n, im in items]
        emit("fx", items, "center")


if __name__ == "__main__":
    main()
