"""Cut the neutral-special orb sheet into fx crops.

Contract: art/aeval/sheets/CUT_SPEC.md, section "Orb sheet". Pure Python 3.12 +
Pillow + numpy + scipy.ndimage. Sprites are cropped and downscaled, never redrawn.

    python tools/sheetcut/cut_orb.py

Reads the owner's sheet (copied once to art/aeval/sheets/orb.png), writes
crops/fx_orbCharge*.png, fx_orb*.png, fx_orbBig*.png, fx_burst*.png, replaces
those names in the "fx" section of crops/manifest.json (every other entry is
kept) and writes crops/CONTACT_orb.png. Run it after cut.py: cut.py rewrites
the old orb0-2 / burst0-2 crops from the move sheets.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd

ROOT = Path(__file__).resolve().parents[2]
SHEETS_DIR = ROOT / "art" / "aeval" / "sheets"
OUT_DIR = SHEETS_DIR / "crops"
SOURCE = Path.home() / "Downloads" / "ChatGPT Image Sep 28, 2026, 11_36_20 PM.png"
SHEET = SHEETS_DIR / "orb.png"

BG_T = 40          # luma (times source alpha) at or below this is background (the navy halo)
FULL_T = 110       # luma at or above this is fully opaque; soft ramp in between
CORE_T = 150       # bright core used to measure the in-game size
X_MIN, X_MAX = 30, 1662   # the left border rule sits at x 21
MIN_COMP = 2       # components smaller than this are dropped as specks

# Caption numbers sit in a strip under each row. A component that lies wholly
# inside the strip and within LABEL_DX of a measured number x is a caption.
LABEL_DX = 12

# (fx name, band y0, y1 inclusive, label strip y0, y1, label x list,
#  frame slots as source x ranges (x0, x1) of the sprite, slots to drop)
# Titles sit above each band's y0, so the band never contains them.
ROWS = [
    ("orbCharge", 40, 148, 136, 147,
     [80, 186, 320, 445, 567, 702, 855, 1006],
     [(62, 96), (164, 209), (293, 344), (406, 480), (505, 606), (648, 752),
      (796, 913), (953, 1089)], []),
    ("orb", 182, 292, 280, 291,
     [69, 141, 225, 327, 436, 540, 662, 787, 935, 1071, 1218, 1389, 1570],
     [(52, 85), (116, 159), (198, 246), (298, 358), (389, 466), (501, 580),
      (612, 701), (731, 833), (870, 980), (1019, 1134), (1161, 1287),
      (1327, 1486), (1508, 1644)], [6]),
    ("orbBig", 316, 460, 445, 459,
     [67, 142, 225, 324, 434, 550, 681, 804, 935, 1072, 1219, 1390, 1576],
     [(49, 79), (114, 164), (193, 259), (283, 363), (386, 484), (504, 610),
      (625, 769), (780, 962), (975, 1182), (1195, 1402), (1410, 1646)], []),
    ("burst", 494, 666, 652, 664,
     [62, 143, 235, 349, 508, 671, 831, 1029, 1177, 1347, 1532],
     [(44, 80), (105, 166), (192, 272), (309, 403), (443, 571), (594, 748),
      (766, 907), (919, 1107), (1125, 1286), (1300, 1456), (1489, 1588)], []),
]

# Rows anchored on the bright core's centroid; the rest use the bbox centre.
CORE_SHARE = 0.6  # largest blob's share of the bright pixels needed for a core anchor
CORE_ANCHOR = {"orb": "core", "orbBig": "core", "orbCharge": "core_if_compact"}

# In-game size targets (px). "core" = widest side of the largest bright blob,
# median over the second half of the row; "full" = widest frame width.
TARGET = {
    "orb": ("core", 16),
    "orbBig": ("full", 72),   # widest frame (orbBig10) 72 px long; drawn at native size in game
    "burst": ("full", 40),
    "orbCharge": ("same", "orb"),   # the formed charge matches the shot it becomes
}


def luma(im: np.ndarray) -> np.ndarray:
    rgb = im[..., :3].astype(np.float32)
    a = im[..., 3].astype(np.float32) / 255.0
    return (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]) * a


def cut_row(im, L, row):
    name, y0, y1, ly0, ly1, labels_x, slots, drop = row
    band = L[y0:y1 + 1, X_MIN:X_MAX]
    fg = band > BG_T
    lab, n = nd.label(fg, structure=np.ones((3, 3), dtype=bool))
    objs = nd.find_objects(lab)
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    lx = np.array(labels_x) - X_MIN
    # Column -> slot index, split halfway between neighbouring slot ranges.
    bounds = [((slots[i][1] + slots[i + 1][0]) / 2) - X_MIN for i in range(len(slots) - 1)]
    col_slot = np.searchsorted(np.array(bounds), np.arange(band.shape[1]))
    masks = [np.zeros_like(fg) for _ in slots]
    captions = 0
    for k, sl in enumerate(objs, start=1):
        if sl is None or sizes[k] < MIN_COMP:
            continue
        cy0, cy1 = sl[0].start + y0, sl[0].stop - 1 + y0
        cx = (sl[1].start + sl[1].stop - 1) / 2
        if cy0 >= ly0 and cy1 <= ly1 and np.min(np.abs(lx - cx)) <= LABEL_DX:
            captions += 1
            continue
        comp = lab[sl] == k
        s0 = col_slot[sl[1].start]
        s1 = col_slot[sl[1].stop - 1]
        if s0 == s1:
            masks[s0][sl] |= comp
            continue
        # Straddles a slot boundary: the component's centroid slot keeps it
        # unless both sides are substantial, then it is split by column.
        cols = col_slot[sl[1].start:sl[1].stop]
        per = {s: int(comp[:, cols == s].sum()) for s in np.unique(cols)}
        big = [s for s, c in per.items() if c >= 20]
        if len(big) <= 1:
            keep = max(per, key=per.get)
            masks[keep][sl] |= comp
        else:
            for s in per:
                part = comp & (cols == s)[None, :]
                masks[s][sl] |= part
    frames = []
    for i, m in enumerate(masks):
        if i in drop:
            continue
        frames.append((i, m))
    return frames, captions, (y0, X_MIN)


def core_size(L, mask, origin):
    y0, x0 = origin
    ys, xs = np.nonzero(mask)
    sub = np.zeros(mask.shape, dtype=bool)
    sub[ys, xs] = L[ys + y0, xs + x0] > CORE_T
    lab, n = nd.label(sub, structure=np.ones((3, 3), dtype=bool))
    if n == 0:
        return 0, 0
    k = int(np.argmax(np.bincount(lab.ravel())[1:])) + 1
    yy, xx = np.nonzero(lab == k)
    return xx.max() - xx.min() + 1, yy.max() - yy.min() + 1


def render(im, L, mask, origin, scale, core_anchor):
    y0, x0 = origin
    ys, xs = np.nonzero(mask)
    by0, by1, bx0, bx1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    m = mask[by0:by1, bx0:bx1]
    sy, sx = by0 + y0, bx0 + x0
    rgb = im[sy:sy + m.shape[0], sx:sx + m.shape[1], :3]
    lum = L[sy:sy + m.shape[0], sx:sx + m.shape[1]]
    soft = np.clip((lum - BG_T) / (FULL_T - BG_T), 0, 1)
    alpha = np.where(m, soft * 255, 0).astype(np.uint8)
    # Pad 2 so the box filter has room at the edge, then trim to the tight bbox.
    rgba = np.zeros((m.shape[0] + 4, m.shape[1] + 4, 4), dtype=np.uint8)
    rgba[2:-2, 2:-2, :3] = rgb
    rgba[2:-2, 2:-2, 3] = alpha
    w, h = rgba.shape[1], rgba.shape[0]
    ow, oh = max(1, round(w * scale)), max(1, round(h * scale))
    img = Image.fromarray(rgba, "RGBA").convert("RGBa").resize((ow, oh), Image.BOX).convert("RGBA")
    arr = np.asarray(img).copy()
    # Hard-ish alpha: 50% source coverage maps to ~75% opacity, faint haze drops out.
    a = arr[..., 3].astype(np.int32)
    a = np.clip(2 * a - 64, 0, 255)
    arr[..., 3] = a.astype(np.uint8)
    arr[a < 8] = 0
    nz = np.nonzero(arr[..., 3])
    if len(nz[0]) == 0:
        return None
    ty, tx = nz[0].min(), nz[1].min()
    arr = arr[ty:nz[0].max() + 1, tx:nz[1].max() + 1]
    out = Image.fromarray(arr, "RGBA")
    ax, ay = out.width // 2, out.height // 2
    if core_anchor:
        # Centroid of the largest bright blob (the head of the shot), so the
        # hit circle drawn at the anchor sits on the head, not the tail.
        core = m & (lum > CORE_T)
        lab, n = nd.label(core, structure=np.ones((3, 3), dtype=bool))
        counts = np.bincount(lab.ravel())[1:] if n > 0 else np.zeros(0)
        # orbCharge only: a ring frame (charge 2-4) has no single head: its bright pixels are
        # spread over many blobs, so it keeps the bbox centre.
        if n > 0 and (core_anchor == "core" or counts.max() >= CORE_SHARE * counts.sum()):
            k = int(np.argmax(counts)) + 1
            cy, cx = nd.center_of_mass(lab == k)
            ax = int(round((cx + 2 + 0.5) * scale - 0.5)) - int(tx)
            ay = int(round((cy + 2 + 0.5) * scale - 0.5)) - int(ty)
            ax = min(max(ax, 0), out.width - 1)
            ay = min(max(ay, 0), out.height - 1)
    return out, ax, ay, (int(sx), int(sy), int(m.shape[1]), int(m.shape[0]))


def contact(rows_out, path):
    Z = 3
    pad = 8
    lines = []
    for name, crops in rows_out:
        h = max(c.height for _, c, _, _ in crops) * Z
        w = sum(c.width * Z + pad for _, c, _, _ in crops)
        lines.append((name, crops, w, h))
    W = max(l[2] for l in lines) + 120
    H = sum(l[3] + 24 for l in lines) + 8
    sheet = Image.new("RGBA", (W, H), (40, 44, 52, 255))
    d = ImageDraw.Draw(sheet)
    y = 8
    for name, crops, _, h in lines:
        d.text((4, y + h // 2), f"{name} ({len(crops)})", fill=(230, 230, 230, 255))
        x = 110
        for n, c, cax, cay in crops:
            big = c.resize((c.width * Z, c.height * Z), Image.NEAREST)
            d.rectangle([x - 1, y - 1, x + big.width, y + big.height], outline=(90, 90, 110, 255))
            sheet.alpha_composite(big, (x, y))
            # anchor
            ax, ay = x + cax * Z + Z // 2, y + cay * Z + Z // 2
            d.line([ax - 3, ay, ax + 3, ay], fill=(255, 80, 80, 255))
            d.line([ax, ay - 3, ax, ay + 3], fill=(255, 80, 80, 255))
            d.text((x, y + big.height + 1), f"{n} {c.width}x{c.height}", fill=(200, 200, 200, 255))
            x += big.width + pad
        y += h + 24
    sheet.save(path)


def main() -> int:
    if not SHEET.exists():
        if not SOURCE.exists():
            print(f"missing source sheet: {SOURCE}")
            return 1
        shutil.copyfile(SOURCE, SHEET)
    im = np.asarray(Image.open(SHEET).convert("RGBA"))
    L = luma(im)

    cut = {}
    for row in ROWS:
        frames, captions, origin = cut_row(im, L, row)
        cut[row[0]] = (frames, origin)
        print(f"{row[0]}: {len(frames)} frames, {captions} caption components removed")

    scales = {}
    for name, (kind, val) in TARGET.items():
        frames, origin = cut[name]
        if kind == "core":
            half = frames[len(frames) // 2:]
            cores = [max(core_size(L, m, origin)) for _, m in half]
            scales[name] = val / float(np.median(cores))
        elif kind == "full":
            widest = max(int(np.ptp(np.nonzero(m.any(0))[0])) + 1 for _, m in frames)
            scales[name] = val / widest
    for name, (kind, val) in TARGET.items():
        if kind == "same":
            scales[name] = scales[val]

    man_path = OUT_DIR / "manifest.json"
    manifest = json.loads(man_path.read_text())
    prefixes = tuple(r[0] for r in ROWS)
    fx = {k: v for k, v in manifest["fx"].items() if not (k.startswith(prefixes) and k.rstrip("0123456789") in prefixes)}
    for old in OUT_DIR.glob("fx_*.png"):
        stem = old.stem[3:]
        if stem.rstrip("0123456789") in prefixes:
            old.unlink()

    rows_out = []
    report = {}
    for row in ROWS:
        name = row[0]
        frames, origin = cut[name]
        crops = []
        for j, (src_idx, m) in enumerate(frames):
            res = render(im, L, m, origin, scales[name], CORE_ANCHOR.get(name))
            if res is None:
                print(f"error: {name} frame {j} is empty")
                return 1
            img, ax, ay, src = res
            fname = f"{name}{j}"
            img.save(OUT_DIR / f"fx_{fname}.png")
            fx[fname] = {"w": img.width, "h": img.height, "ax": ax, "ay": ay,
                         "anchor": "core" if name in CORE_ANCHOR else "centre",
                         "src": f"orb_{name}_{src_idx + 1}"}
            crops.append((fname, img, ax, ay))
        rows_out.append((name, crops))
        report[name] = {"frames": len(crops), "scale": round(scales[name], 4),
                        "sizes": [f"{c.width}x{c.height}" for _, c, _, _ in crops],
                        "anchors": [[ax, ay] for _, _, ax, ay in crops]}
    manifest["fx"] = fx
    man_path.write_text(json.dumps(manifest, indent=1))
    contact(rows_out, OUT_DIR / "CONTACT_orb.png")
    print(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
