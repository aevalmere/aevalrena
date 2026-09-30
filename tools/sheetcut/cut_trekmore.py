"""Cut the Trekmore source images into per-frame crops.

Contract: docs/TREKMORE_PLAN.md section A. Pure Python 3.12 + Pillow + numpy.
Helpers come from cut.py (not modified). Map of every sheet: art/trekmore/cutmap.json.

    python tools/sheetcut/cut_trekmore.py                # all sheets, fx, contact sheets
    python tools/sheetcut/cut_trekmore.py --sheet heavy  # one sheet (fx of other sheets kept)
    python tools/sheetcut/cut_trekmore.py --measure      # also write art/trekmore/palette_measure.json

Keying (every mode builds a silhouette envelope instead of flooding the
background, because the armour ink is as dark as the background and touches it
through crevices; a border flood ate holes into the torso):
  1. strong = pixels clearly unlike the background (black: max channel above
     bg + fgDelta; navy / checker: colour distance to the local background above
     its measured tolerance + fgDelta);
  2. envelope = closing(strong, closeR), holes filled;
  3. inside the envelope, pockets that look exactly like the background (black:
     mean max < 10 and max <= bg + 1; navy / checker: background colour and hue)
     of at least pocketMin px are keyed out again (see-through gaps);
  4. jpeg and concept sheets: 3x3 median on the mask, specks < 6 px dropped,
     1 px erosion. JPEG sheets also get a 3x3 median on RGB before keying.
Grid lines are found from row and column projections of long grey runs; each
cell is cut inside them with an inset, and the number box is painted with the
cell's background colour first.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.dont_write_bytecode = True   # tools/sheetcut/__pycache__ is tracked; importing cut.py must not rewrite it
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cut import comp_stats, contact, dilate, label, render  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "art" / "trekmore"
SRC_DIR = ART / "source"
OUT_DIR = ART / "sheets" / "crops"
CUTMAP = ART / "cutmap.json"
STAND_H = 55          # standing body height in game px (Aeval: 48)
RUN_GAP = 14          # column runs closer than this merge (as cut.py)
SCALE_TOL = 0.05      # stand and sword scales must agree within 5 percent
FX_FAR = 6            # glow farther than this from the body is effect (alpha 254)
AEVAL_CROPS = ROOT / "art" / "aeval" / "sheets" / "crops"


# --------------------------------------------------------------------------
# small image helpers

def erode(m: np.ndarray, r: int) -> np.ndarray:
    return ~dilate(~m, r)


def fill_holes(m: np.ndarray) -> np.ndarray:
    lab, n = label(~m)
    b = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    b = b[b > 0]
    return m | ((lab > 0) & ~np.isin(lab, b))


def drop_specks(m: np.ndarray, min_px: int) -> np.ndarray:
    lab, n = label(m)
    if n == 0:
        return m
    size = np.bincount(lab.ravel(), minlength=n + 1)
    keep = size >= min_px
    keep[0] = False
    return keep[lab]


def median_mask(m: np.ndarray) -> np.ndarray:
    im = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(3))
    return np.asarray(im) >= 128


def hsl(a: np.ndarray):
    """Vectorised HSL: hue degrees, s, l in 0..1."""
    f = a.astype(np.float32) / 255.0
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    mx = f.max(-1)
    mn = f.min(-1)
    l = (mx + mn) / 2
    d = mx - mn
    s = np.where(d == 0, 0, d / np.maximum(1e-6, 1 - np.abs(2 * l - 1)))
    dd = np.where(d == 0, 1, d)
    h = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) * 60
    h = np.where(d == 0, 0, h)
    return h, s, l


def glow_mask(a: np.ndarray) -> np.ndarray:
    """Bright violet glow (plan A.3 rule 8): hue 250..300, s >= 0.35, l >= 0.35."""
    h, s, l = hsl(a)
    return (h >= 250) & (h <= 300) & (s >= 0.35) & (l >= 0.35)


# --------------------------------------------------------------------------
# keying

def ring_px(a: np.ndarray, w: int = 4) -> np.ndarray:
    return np.concatenate([a[:w].reshape(-1, 3), a[-w:].reshape(-1, 3),
                           a[:, :w].reshape(-1, 3), a[:, -w:].reshape(-1, 3)])


def key_black(a: np.ndarray, bg: float, cfg: dict, log: list, tag: str) -> np.ndarray:
    mx = a.max(2)
    strong = mx > bg + cfg.get("fgDelta", 16)
    r = cfg.get("closeR", 3)
    env = fill_holes(erode(dilate(strong, r), r))
    pocket = env & (mx <= bg + 1)
    lab, n = label(pocket)
    size = np.bincount(lab.ravel(), minlength=n + 1)
    tot = np.bincount(lab.ravel(), weights=mx.ravel(), minlength=n + 1)
    kill = (size >= cfg.get("pocketMin", 10 ** 9)) & (tot < 10 * np.maximum(size, 1))
    kill[0] = False
    out = env & ~kill[lab]
    out = drop_specks(out, 4)
    log.append(f"  {tag}: black key bg {bg:.0f}, strong > {bg + cfg.get('fgDelta', 16):.0f}, "
               f"close {r}, {int(kill.sum())} see-through pockets keyed")
    return out


def key_soft(a: np.ndarray, cfg: dict, log: list, tag: str, ref=None) -> np.ndarray:
    """navy and checker backgrounds (jpegs, concept sheets)."""
    ring = ring_px(a)
    if ref is None:
        ref = np.median(ring, 0)
    ref = np.asarray(ref, dtype=np.float32)
    dist = np.abs(a - ref).max(2)
    rdist = np.abs(ring - ref).max(1)
    tol = float(np.clip(np.percentile(rdist, 98) + 4, 6, 26))
    mx = a.max(2)
    rg = a[..., 0] - a[..., 1]
    ref_rg = float(ref[0] - ref[1])
    strong = dist > tol + cfg.get("fgDelta", 8)
    # violet ink darker than the tolerance still counts: the navy and grey
    # backgrounds have red <= green, the knight's ink has red > green
    strong |= (rg >= ref_rg + cfg.get("inkRG", 4)) & (dist > tol * 0.5)
    strong = drop_specks(strong, 3)
    r = cfg.get("closeR", 3)
    env = fill_holes(erode(dilate(strong, r), r))
    bglike = (dist <= tol) & (rg < ref_rg + 3)
    lab, n = label(env & bglike)
    size = np.bincount(lab.ravel(), minlength=n + 1)
    kill = size >= cfg.get("pocketMin", 10 ** 9)
    kill[0] = False
    out = env & ~kill[lab]
    out = median_mask(out)
    out = drop_specks(out, 6)
    out = erode(out, 1)
    out = drop_specks(out, 6)
    log.append(f"  {tag}: soft key ref {ref.round(0).astype(int).tolist()}, tol {tol:.0f}, "
               f"strong > {tol + cfg.get('fgDelta', 8):.0f}, {int(kill.sum())} pockets keyed, max bg {mx[~out].max() if (~out).any() else 0}")
    return out


def remove_rules(m: np.ndarray, log: list, tag: str) -> np.ndarray:
    """Panel rules and underlines on the concept sheets: long thin components."""
    lab, n = label(m)
    if n == 0:
        return m
    size, x0, y0, x1, y1 = comp_stats(lab, n)
    hh, ww = y1 - y0 + 1, x1 - x0 + 1
    kill = ((hh <= 5) & (ww >= 50)) | ((ww <= 5) & (hh >= 40))
    kill[0] = False
    if kill.any():
        log.append(f"  {tag}: removed {int(kill.sum())} panel rules")
    return m & ~kill[lab]


def largest_and_near(m: np.ndarray, r: int = 4) -> np.ndarray:
    """The largest piece of a cell and every piece within r px of it."""
    lab, n = label(m)
    if n == 0:
        return m
    size = np.bincount(lab.ravel(), minlength=n + 1)
    size[0] = 0
    near = dilate(lab == int(size.argmax()), r)
    hit = np.bincount(lab[near], minlength=n + 1) > 0
    hit[0] = False
    return hit[lab]


def remove_ledge_blocks(a: np.ndarray, m: np.ndarray, log: list, tag: str) -> np.ndarray:
    """concept_b ledge grab: each frame hangs from a grey slate block drawn as a
    rectangle outline with a lighter rim. The block pixels are low-saturation
    grey-violet; the knight is violet ink with bright violet glints. Keep the
    body: remove low-chroma block pixels, then pieces with no violet in them."""
    h, s, l = hsl(a)
    greyish = (s < 0.25) & (l > 0.04)
    out = m & ~greyish
    lab, n = label(out)
    if n == 0:
        return out
    vio = np.bincount(lab[(s >= 0.3) & out], minlength=n + 1)
    size = np.bincount(lab.ravel(), minlength=n + 1)
    keep = (vio >= 0.2 * size) & (size >= 8)
    keep[0] = False
    out = keep[lab]
    log.append(f"  {tag}: ledge block removed ({int((m & ~out).sum())} px)")
    return out


# --------------------------------------------------------------------------
# segmentation

def column_runs(mask: np.ndarray):
    xs = np.nonzero(mask.any(0))[0]
    if len(xs) == 0:
        return []
    runs = [[xs[0], xs[0]]]
    for x in xs[1:]:
        if x - runs[-1][1] - 1 < RUN_GAP:
            runs[-1][1] = x
        else:
            runs.append([x, x])
    return [(int(s), int(e)) for s, e in runs]


def find_cores(m: np.ndarray, glow: np.ndarray, count: int, log: list, tag: str):
    """Body cores: components of the eroded non-glow mask. The erosion radius
    grows until exactly `count` big components remain (thin cape wisps, sword
    trails and slash arcs vanish first)."""
    base = m & ~glow
    best = None
    for r in range(2, 16):
        e = erode(base, r)
        lab, n = label(e)
        if n == 0:
            break
        size = np.bincount(lab.ravel(), minlength=n + 1)
        size[0] = 0
        big = np.nonzero(size >= 0.12 * size.max())[0]
        if len(big) == count:
            log.append(f"  {tag}: {count} body cores at erosion {r}")
            return lab, list(big)
        if len(big) > count and best is None:
            order = big[np.argsort(-size[big])][:count]
            best = (r, lab, list(order))
    if best is not None:
        r, lab, order = best
        log.append(f"  {tag}: no exact core count, took the {count} largest at erosion {r}")
        return lab, order
    return None, []


def geodesic_assign(m: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    """Grow integer seed labels through the mask (8-neighbour BFS, one ring per
    step), so each pixel joins the core it is connected to by the shortest path."""
    lab = np.where(m, seeds, 0).astype(np.int32)
    shifts = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
    H, W = m.shape
    while True:
        free = m & (lab == 0)
        if not free.any():
            break
        grew = False
        new = lab.copy()
        for dy, dx in shifts:
            src = np.zeros_like(lab)
            ys0, ys1 = max(dy, 0), H + min(dy, 0)
            xs0, xs1 = max(dx, 0), W + min(dx, 0)
            src[ys0:ys1, xs0:xs1] = lab[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
            take = free & (new == 0) & (src > 0)
            if take.any():
                new[take] = src[take]
                grew = True
        lab = new
        if not grew:
            break
    return lab


def seeds_from_centers(m: np.ndarray, glow: np.ndarray, centers, log: list, tag: str):
    """Measured body centre x per frame (cutmap `centers`, band coords): the seed
    of frame i is the non-glow mask inside a 20 px strip around its centre."""
    base = erode(m & ~glow, 1)
    lab = np.zeros(m.shape, np.int32)
    for i, cx in enumerate(centers):
        strip = np.zeros_like(m)
        strip[:, max(cx - 10, 0):cx + 11] = True
        lab[base & strip & (lab == 0)] = i + 1
    log.append(f"  {tag}: {len(centers)} seeds from measured body centres")
    return lab


def segment_by_cores(m: np.ndarray, glow: np.ndarray, count: int, log: list, tag: str, centers=None):
    if centers is not None:
        seeds = seeds_from_centers(m, glow, centers, log, tag)
        return grow_frames(m, seeds, count)
    clab, cores = find_cores(m, glow, count, log, tag)
    if len(cores) != count:
        return None
    # order cores left to right by centre x
    cx = []
    for c in cores:
        xs = np.nonzero((clab == c).any(0))[0]
        cx.append((xs.min() + xs.max()) / 2)
    order = [cores[i] for i in np.argsort(cx)]
    seeds = np.zeros(m.shape, np.int32)
    for i, c in enumerate(order):
        seeds[clab == c] = i + 1
    return grow_frames(m, seeds, count)


def grow_frames(m: np.ndarray, seeds: np.ndarray, count: int):
    lab = geodesic_assign(m, seeds)
    # pieces not connected to any core: nearest frame by horizontal bbox gap
    rest = m & (lab == 0)
    rl, rn = label(rest)
    if rn:
        size, x0, y0, x1, y1 = comp_stats(rl, rn)
        ext = []
        for i in range(count):
            ys, xs = np.nonzero(lab == i + 1)
            ext.append((xs.min(), ys.min(), xs.max(), ys.max()))
        for k in range(1, rn + 1):
            best, bk = 0, None
            for i, (ex0, ey0, ex1, ey1) in enumerate(ext):
                dx = max(0, ex0 - x1[k], x0[k] - ex1)
                dy = max(0, ey0 - y1[k], y0[k] - ey1)
                key = (dx + dy, abs((ex0 + ex1) / 2 - (x0[k] + x1[k]) / 2))
                if bk is None or key < bk:
                    best, bk = i, key
            lab[rl == k] = best + 1
    return [lab == i + 1 for i in range(count)]


# --------------------------------------------------------------------------
# frames

def frame_body(a: np.ndarray, m: np.ndarray, glow: np.ndarray):
    """The knight's body: the largest component of the non-glow mask opened by
    2 px (drops cape wisps, sword trails and slash arcs). Returns the mask or None."""
    core = m & ~glow
    op = dilate(erode(core, 2), 2) & core
    lab, n = label(op)
    if n == 0:
        return None
    size = np.bincount(lab.ravel(), minlength=n + 1)
    size[0] = 0
    k = int(size.argmax())
    if size[k] < 150:
        return None
    return lab == k


def heel_anchor(body: np.ndarray):
    """Heel point: body mask bottom row; x = median x of the body pixels in the
    lowest fifth of the body (the legs), which ignores the cape and sword that
    widen the bbox and would make the anchor jitter."""
    ys, xs = np.nonzero(body)
    y0, y1 = ys.min(), ys.max()
    low = ys >= y1 - max(3, (y1 - y0 + 1) // 5)
    return float(np.median(xs[low])), float(y1 + 1)


class Frame:
    def __init__(self, sheet, row, idx, a, mask, off, bodyless=False, anchor_bottom=False):
        self.sheet, self.row, self.idx = sheet, row, idx
        self.a, self.mask, self.off = a, mask, off
        self.glow = glow_mask(a) & mask
        self.body = None if bodyless else frame_body(a, mask, self.glow)
        if self.body is not None:
            self.anchor = heel_anchor(self.body)
        else:
            ys, xs = np.nonzero(mask)
            if anchor_bottom:
                self.anchor = ((xs.min() + xs.max()) / 2, float(ys.max() + 1))
            else:
                self.anchor = ((xs.min() + xs.max()) / 2, (ys.min() + ys.max() + 1) / 2)

    @property
    def key(self):
        return f"{self.sheet}_{self.row}_{self.idx}"

    def fx_part(self) -> np.ndarray:
        """Glow pieces far from the body: slash arcs, trails. Capped at alpha 254."""
        if self.body is None:
            return self.mask
        far = ~dilate(self.body, FX_FAR)
        return self.glow & far


def body_height(f: Frame) -> int:
    ys = np.nonzero(f.body.any(1))[0]
    return int(ys.max() - ys.min() + 1)


# --------------------------------------------------------------------------
# sheets

def detect_lines(a: np.ndarray, axis: int, want: int, log: list, tag: str):
    mx = a.max(2)
    mn = a.min(2)
    grey = (mx >= 38) & (mx <= 100) & ((mx - mn) <= 22)
    frac = grey.mean(axis)
    idx = np.nonzero(frac > 0.5)[0]
    runs = []
    for i in idx:
        if runs and i - runs[-1][1] <= 5:
            runs[-1][1] = int(i)
        else:
            runs.append([int(i), int(i)])
    size = a.shape[1 - axis]
    if len(runs) == want - 1:
        if runs[0][0] > size * 0.1:
            runs.insert(0, [0, 0])
        else:
            runs.append([size - 1, size - 1])
        log.append(f"  {tag}: one grid line missing, used the image edge")
    if len(runs) != want:
        raise SystemExit(f"{tag}: found {len(runs)} grid lines, expected {want}: {runs}")
    return runs


def src_path(cfg: dict) -> Path:
    """Source images live in art/trekmore/source; the pixler sheet in art/trekmore/pixler."""
    return (ART / cfg["file"]) if "/" in cfg["file"] else (SRC_DIR / cfg["file"])


def load(cfg: dict) -> np.ndarray:
    im = Image.open(src_path(cfg)).convert("RGB")
    if cfg.get("rgbMedian"):
        im = im.filter(ImageFilter.MedianFilter(3))
    return np.asarray(im).astype(np.int32).copy()


def cut_rows_sheet(name: str, cfg: dict, log: list, report: dict):
    a = load(cfg)
    H, W = a.shape[:2]
    bgmode = cfg["bg"]
    bgref = None
    alpha_src = None
    if bgmode == "alpha":
        alpha_src = np.asarray(Image.open(src_path(cfg)).convert("RGBA"))[..., 3]
    elif bgmode == "black":
        bg = float(np.percentile(ring_px(a, 8).max(1), 99))
        for y0, y1 in cfg.get("blank", []):
            a[y0:y1 + 1] = 0
        for y0, y1, x0, x1 in cfg.get("rects", []):
            a[y0:y1 + 1, x0:x1 + 1] = 0
    else:
        bgref = np.median(ring_px(a, 6), 0)
        for y0, y1 in cfg.get("blank", []):
            a[y0:y1 + 1] = bgref
        for y0, y1, x0, x1 in cfg.get("rects", []):
            a[y0:y1 + 1, x0:x1 + 1] = bgref
    frames = []
    ok = True
    for row in cfg["rows"]:
        parts = row.get("parts") or [dict(y0=row["y0"], y1=row["y1"], count=row["count"])]
        idx0 = 0
        for part in parts:
            y0, y1 = part["y0"], part["y1"]
            x0, x1 = part.get("x0", row.get("x0", 0)), part.get("x1", row.get("x1", W - 1))
            A = a[y0:y1 + 1, x0:x1 + 1]
            tag = f"{name}_{row['name']}" + (f"[{y0}]" if len(parts) > 1 else "")
            kcfg = {**cfg, **row.get("key", {})}
            if bgmode == "alpha":
                # pixler output: already cut out on a clear background
                M = alpha_src[y0:y1 + 1, x0:x1 + 1] > 127
            elif bgmode == "black":
                M = key_black(A, bg, kcfg, log, tag)
            else:
                M = key_soft(A, kcfg, log, tag)
            if cfg.get("rules"):
                M = remove_rules(M, log, tag)
            if row.get("ledgeBlocks"):
                M = remove_ledge_blocks(A, M, log, tag)
            count = part["count"]
            masks = None
            if "cells" in part or ("cells" in row and len(parts) == 1):
                cells = part.get("cells", row.get("cells"))
                masks = []
                for cx0, cx1 in cells:
                    mm = np.zeros_like(M)
                    mm[:, cx0 - x0:cx1 - x0 + 1] = M[:, cx0 - x0:cx1 - x0 + 1]
                    mm = drop_specks(mm, 6)
                    if row.get("ledgeBlocks"):
                        mm = largest_and_near(mm)
                    masks.append(mm)
                if row.get("splitCores"):
                    # one cell per frame is too coarse: cores inside the whole row
                    masks = None
            if masks is None:
                runs = column_runs(M)
                if len(runs) == count and not row.get("forceCores"):
                    masks = []
                    for s, e in runs:
                        mm = np.zeros_like(M)
                        mm[:, s:e + 1] = M[:, s:e + 1]
                        masks.append(mm)
                else:
                    log.append(f"  {tag}: {len(runs)} column runs (expected {count}); body core segmentation")
                    report["fallbackRows"].append(tag)
                    g = glow_mask(A) & M
                    cen = part.get("centers", row.get("centers") if len(parts) == 1 else None)
                    if cen is not None:
                        cen = [c - x0 for c in cen]
                    masks = segment_by_cores(M, g, count, log, tag, cen)
                    if masks is None:
                        log.append(f"  ERROR {tag}: core segmentation failed; wrote {len(runs)} column-run frames")
                        ok = False
                        masks = []
                        for s, e in runs:
                            mm = np.zeros_like(M)
                            mm[:, s:e + 1] = M[:, s:e + 1]
                            masks.append(mm)
            if len(masks) != count:
                log.append(f"  ERROR {tag}: {len(masks)} frames (expected {count})")
                ok = False
            order = row.get("order")
            if order and len(parts) == 1:
                masks = [masks[i] for i in order]
            for i, mm in enumerate(masks):
                j = idx0 + i
                frames.append(Frame(name, row["name"], j, A, mm, (x0, y0),
                                    bodyless=j in row.get("bodyless", []),
                                    anchor_bottom=row.get("anchorBottom", False)))
            idx0 += len(masks)
        report["counts"][f"{name}_{row['name']}"] = idx0
    return ok, frames


def cut_grid_sheet(name: str, cfg: dict, log: list, report: dict):
    a = load(cfg)
    raw = np.asarray(Image.open(src_path(cfg)).convert("RGB")).astype(np.int32)
    g = cfg["grid"]
    # lines are found on the unfiltered image (the median removes 1 px lines)
    xs = detect_lines(raw, 0, g["cols"] + 1, log, name + " cols")
    ys = detect_lines(raw, 1, g["rows"] + 1, log, name + " rows")
    inset = g.get("inset", 6)
    frames = []
    ok = True
    k = 0
    for r in range(g["rows"]):
        for c in range(g["cols"]):
            cx0, cx1 = xs[c][1] + 1 + inset, xs[c + 1][0] - 1 - inset
            cy0, cy1 = ys[r][1] + 1 + inset, ys[r + 1][0] - 1 - inset
            A = a[cy0:cy1 + 1, cx0:cx1 + 1].copy()
            ref = np.median(ring_px(A), 0)
            lb = g.get("labelBox")
            if lb:
                A[max(lb[1] - inset, 0):lb[3] - inset, max(lb[0] - inset, 0):lb[2] - inset] = ref
            tag = f"{name}_{k}"
            M = key_soft(A, cfg, log if k == 0 else [], tag, ref)
            if cfg.get("split"):
                # clone sheet: the knight above, his shadow clone below
                h = M.shape[0]
                cnt = M.sum(1)
                lo, hi = int(h * 0.4), int(h * 0.62)
                sy = lo + int(np.argmin(cnt[lo:hi]))
                top = M.copy(); top[sy:] = False
                bot = M.copy(); bot[:sy] = False
                for rname, mm in zip(cfg["split"], (top, bot)):
                    if mm.any():
                        frames.append(Frame(name, rname, k, A, mm, (cx0, cy0)))
                    else:
                        log.append(f"  ERROR {name}_{rname}_{k}: empty")
                        ok = False
            else:
                if not M.any():
                    log.append(f"  ERROR {tag}: empty cell")
                    ok = False
                else:
                    frames.append(Frame(name, cfg.get("rowName", "g"), k, A, M, (cx0, cy0),
                                        bodyless=k in cfg.get("bodyless", [])))
            k += 1
    report["counts"][name] = k
    if cfg.get("split"):
        frames.sort(key=lambda f: (cfg["split"].index(f.row), f.idx))
    return ok, frames


# --------------------------------------------------------------------------
# scale

def sword_px(ref: dict) -> float:
    (x0, y0), (x1, y1) = ref["p0"], ref["p1"]
    return math.hypot(x1 - x0, y1 - y0)


def find(frames, row, idx):
    return next((f for f in frames if f.row == row and f.idx == idx), None)


POSE_H: dict = {}   # game-px body height of every frame cut so far, for the pose method


def sheet_scale(name: str, cfg: dict, frames, log: list, sword_len, report: dict):
    """Returns (scale, ok). Prints every method that applies.

    pose: the sheet has no standing frame, so a frame is matched to the same
    pose on an already scaled sheet (same body mask rule) and takes its height."""
    ref = cfg["scaleRef"]
    stand = sword = pose = None
    if "pose" in ref:
        p = ref["pose"]
        f = find(frames, p.get("row", cfg.get("rowName", "g")), p["idx"])
        if f is None or f.body is None or p["ref"] not in POSE_H:
            log.append(f"  ERROR {name}: pose reference missing")
        else:
            bh = body_height(f)
            pose = POSE_H[p["ref"]] / bh
            log.append(f"  scale pose = {POSE_H[p['ref']]:.1f} ({p['ref']}) / {bh} = {pose:.5f} ({f.key})")
    if "stand" in ref:
        s = ref["stand"]
        f = find(frames, s.get("row", cfg.get("rowName", "g")), s["idx"])
        if f is None or f.body is None:
            log.append(f"  ERROR {name}: stand reference has no body")
        else:
            bh = body_height(f)
            if "top" in s:
                # the raised sword sits above the helmet: crest y measured by hand
                bh = int(f.off[1] + np.nonzero(f.body.any(1))[0].max() + 1 - s["top"])
            stand = STAND_H / bh
            log.append(f"  scale stand = {STAND_H} / {bh} = {stand:.5f} ({f.key})")
    if "fitWidth" in ref:
        # generated art (pixler): fit the crop width to a measured target in game px
        fw = ref["fitWidth"]
        f = find(frames, fw["row"], fw["idx"])
        xs = np.nonzero(f.mask.any(0))[0]
        pose = fw["target"] / (xs.max() - xs.min() + 1)
        log.append(f"  scale fit width = {fw['target']} / {xs.max() - xs.min() + 1} = {pose:.5f}")
    if "sword" in ref and sword_len is not None:
        px = sword_px(ref["sword"])
        sword = sword_len / px
        log.append(f"  scale sword = {sword_len:.2f} / {px:.1f} = {sword:.5f}")
    use = ref.get("use", "stand" if stand is not None else ("pose" if pose is not None else "sword"))
    if "fitWidth" in ref:
        use = "fitWidth"
    chosen = {"stand": stand, "sword": sword, "pose": pose, "fitWidth": pose}[use]
    agree = None
    primary = stand if stand is not None else pose
    if chosen is not None and primary is not None and sword is not None:
        agree = abs(primary - sword) / chosen
        flag = "" if agree <= SCALE_TOL else "  DISAGREE"
        log.append(f"  cross check: {agree * 100:.1f} percent{flag}")
    report["scaleTable"][name] = {"stand": round(stand, 5) if stand else None,
                                  "pose": round(pose, 5) if pose else None,
                                  "sword": round(sword, 5) if sword else None,
                                  "used": use, "scale": round(chosen, 5) if chosen else None,
                                  "diffPct": round(agree * 100, 1) if agree is not None else None}
    ok = chosen is not None and (agree is None or agree <= SCALE_TOL or bool(ref.get("allowDisagree")))
    if agree is not None and agree > SCALE_TOL and not ref.get("allowDisagree"):
        log.append(f"  ERROR {name}: stand and sword scales disagree by more than 5 percent")
    return chosen, ok


# --------------------------------------------------------------------------
# output

def write_frame(f: Frame, scale: float, manifest: dict, key=None, mask=None):
    m = f.mask if mask is None else mask
    fxp = f.fx_part() & m
    img, ax, ay = render(f.a, m, m, fxp, scale, f.anchor if f.body is not None or True else None)
    key = key or f.key
    img.save(OUT_DIR / f"{key}.png")
    ys, xs = np.nonzero(m)
    manifest["frames"][key] = {"w": img.width, "h": img.height, "ax": ax, "ay": ay,
                               "bodyless": f.body is None,
                               "src": [int(xs.min()) + f.off[0], int(ys.min()) + f.off[1],
                                       int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]}
    return img, ax, ay


def fx_from(f: Frame, scale: float, spec: dict):
    """Cut an effect out of a frame: body removed, bright violet pieces kept."""
    m = f.mask.copy()
    mode = spec.get("keep", "glowNoBody")
    if mode == "all":
        pass
    else:
        if f.body is not None:
            m &= ~dilate(f.body, spec.get("bodyPad", 2))
        h, s, l = hsl(f.a)
        vio = (h >= 250) & (h <= 300) & (s >= 0.35) & (l >= 0.35)
        lab, n = label(m)
        if n:
            size = np.bincount(lab.ravel(), minlength=n + 1)
            vc = np.bincount(lab[vio & m], minlength=n + 1)
            keep = (vc >= spec.get("minVio", 0.15) * size) & (size >= 6)
            keep[0] = False
            m = keep[lab]
    if "clip" in spec:   # [x0, y0, x1, y1] in sheet coords
        cx0, cy0, cx1, cy1 = spec["clip"]
        clip = np.zeros_like(m)
        clip[max(cy0 - f.off[1], 0):max(cy1 - f.off[1], 0), max(cx0 - f.off[0], 0):max(cx1 - f.off[0], 0)] = True
        m &= clip
    m = drop_specks(m, 4)
    if not m.any():
        return None, None
    if spec.get("anchor") == "heel" and f.body is not None:
        # world anchored at the source frame's heel: drawn at the latched
        # takeoff point, the effect keeps its height above the floor
        anchor = f.anchor
    else:
        ys, xs = np.nonzero(m)
        anchor = ((xs.min() + xs.max()) / 2, (ys.min() + ys.max() + 1) / 2)
    img, ax, ay = render(f.a, m, m, m, scale, anchor, cap_all=True)
    return (img, ax, ay), m


def post(img_tuple, spec):
    """Derived fx frames: scale and alpha only (no new pixels)."""
    img, ax, ay = img_tuple
    sc = spec.get("rescale", 1.0)
    if "fitMax" in spec:
        sc = spec["fitMax"] / max(img.width, img.height)
    if sc != 1.0:
        w, h = max(1, round(img.width * sc)), max(1, round(img.height * sc))
        img = img.convert("RGBa").resize((w, h), Image.LANCZOS).convert("RGBA")
        ax, ay = round(ax * sc), round(ay * sc)
    if "alpha" in spec:
        arr = np.asarray(img).copy()
        arr[..., 3] = (arr[..., 3].astype(np.float32) * spec["alpha"]).astype(np.uint8)
        img = Image.fromarray(arr, "RGBA")
    arr = np.asarray(img).copy()
    arr[..., 3] = np.minimum(arr[..., 3], 254)
    arr[arr[..., 3] < 4] = 0
    return Image.fromarray(arr, "RGBA"), ax, ay


# --------------------------------------------------------------------------
# pixler quality gate (plan A.5)

def pix_gate(cfg: dict) -> None:
    """Contact sheet with each pixler crop between loco_idle_0 and conB_hitStrong_1
    at 1x and 3x (fallback frames after them), plus the measured checks in
    art/trekmore/pixler/<row>_gate.json. The numbers prepare the call; the
    verdict is recorded in CUT_NOTES.md and the W0-art report."""
    pal_path = ART / "palette_measure.json"
    pal = json.loads(pal_path.read_text(encoding="utf-8")) if pal_path.exists() else None
    band = pal["trekmore"]["bandEstimate"] if pal else {"glow": {"hueMin": 255, "hueMax": 300},
                                                         "cloth": {"hueMin": 250, "hueMax": 300}}
    raw = np.asarray(Image.open(src_path(cfg)).convert("RGBA"))
    for row in cfg["rows"]:
        key = f"pix_{row['name']}_0"
        path = OUT_DIR / f"{key}.png"
        if not path.exists():
            continue
        op = raw[..., 3] > 0
        h, s, l = hsl(raw[..., :3])
        glow = op & (s >= 0.35) & (l >= 0.35)
        colour = op & (s >= 0.2)
        edge = op & ~erode(op, 1)
        crop = np.asarray(Image.open(path).convert("RGBA"))
        cop = crop[..., 3] > 0
        partial_raw = float(((raw[..., 3] > 0) & (raw[..., 3] < 255)).sum() / max(op.sum(), 1))
        partial_crop = float(((crop[..., 3] > 0) & (crop[..., 3] < 255)).sum() / max(cop.sum(), 1))
        ghue = float(np.median(h[glow])) if glow.any() else None
        chue = float(np.median(h[colour])) if colour.any() else None
        ys = np.nonzero(cop.any(1))[0]
        hpx = int(ys.max() - ys.min() + 1)
        target_h = row.get("targetH")
        ink = float((l[edge] < 0.12).mean())
        checks = {
            "glowHueMedian": ghue, "glowPx": int(glow.sum()),
            "glowHueInBand10": bool(ghue is not None and band["glow"]["hueMin"] - 10 <= ghue <= band["glow"]["hueMax"] + 10),
            "bodyHueMedian": chue,
            "bodyHueInClothBand10": bool(chue is not None and band["cloth"]["hueMin"] - 10 <= chue <= band["cloth"]["hueMax"] + 10),
            "inkOutlineFrac": round(ink, 3), "inkOutlinePass": ink >= 0.7,
            "partialAlphaRaw": round(partial_raw, 3), "partialAlphaCrop": round(partial_crop, 3),
            "crispPass": partial_raw <= 0.15,
            "heightPx": hpx, "targetH": target_h,
            "heightPass": bool(target_h is None or abs(hpx - target_h) <= 0.1 * target_h),
            "helmetCapeReadable": row.get("readable"),
        }
        checks["pass"] = bool(checks["glowHueInBand10"] and checks["bodyHueInClothBand10"] and checks["inkOutlinePass"]
                              and checks["crispPass"] and checks["heightPass"] and row.get("readable") is True)
        tiles = [Image.open(OUT_DIR / "loco_idle_0.png"), Image.open(path), Image.open(OUT_DIR / "conB_hitStrong_1.png")]
        tiles += [Image.open(OUT_DIR / f"{k}.png") for k in row.get("fallback", []) if (OUT_DIR / f"{k}.png").exists()]
        font = ImageFont.load_default()
        th = max(t.height for t in tiles)
        W = sum(t.width for t in tiles) * 3 + 12 * len(tiles) + 20
        Hh = 24 + th + 16 + th * 3 + 20
        out = Image.new("RGBA", (max(W, 700), Hh), (128, 128, 128, 255))
        d = ImageDraw.Draw(out)
        for z, y in ((1, 24), (3, 24 + th + 16)):
            x = 10
            for t in tiles:
                big = t.resize((t.width * z, t.height * z), Image.NEAREST)
                out.alpha_composite(big, (x, y + th * z - big.height))
                x += big.width + 12
        d.text((10, 6), f"{key} between loco_idle_0 and conB_hitStrong_1; then fallback "
                        f"{', '.join(row.get('fallback', []))}. gate pass = {checks['pass']}",
               fill=(255, 255, 255), font=font)
        (ART / "pixler").mkdir(exist_ok=True)
        out.save(ART / "pixler" / f"{row['name']}_gate.png")
        (ART / "pixler" / f"{row['name']}_gate.json").write_text(json.dumps(checks, indent=1), encoding="utf-8", newline=chr(10))
        print(f"pixler gate {row['name']}: {json.dumps(checks)}")


# --------------------------------------------------------------------------
# preview sheets for the lead (sheetmap order, one animation per row)

def preview(kind: str, out: Path, zoom: int = 2) -> None:
    smap = json.loads((ART / "sheetmap.json").read_text(encoding="utf-8"))
    man = json.loads((OUT_DIR / "manifest.json").read_text(encoding="utf-8"))
    font = ImageFont.load_default()
    rows = []
    for name, anim in smap[kind].items():
        cells = []
        for i, (fr, hold) in enumerate(zip(anim["frames"], anim["holds"])):
            meta = man["frames"][fr] if kind == "body" else man["fx"][fr[3:]]
            im = Image.open(OUT_DIR / f"{fr}.png").convert("RGBA")
            cells.append((fr, hold, im.resize((im.width * zoom, im.height * zoom), Image.NEAREST),
                          meta["ax"] * zoom, meta["ay"] * zoom, i))
        rows.append((name, anim, cells))
    lab_w, pad, gap = 150, 10, 8
    layouts = []
    for name, anim, cells in rows:
        up = max(max(c[4] for c in cells), 1)
        down = max(max(c[2].height - c[4] for c in cells), 0)
        x = lab_w
        pos = []
        for c in cells:
            left = max(c[3], 0)
            cw = max(c[2].width, left + 1, int(font.getlength(f"{c[5]}:{c[1]}")) + 2)
            pos.append((x, left))
            x += cw + gap
        layouts.append((up, down, x, pos))
    W = max(l[2] for l in layouts) + pad
    H = sum(l[0] + l[1] + 34 for l in layouts) + pad
    img = Image.new("RGBA", (W, H), (128, 128, 128, 255))
    d = ImageDraw.Draw(img)
    y = pad
    for (name, anim, cells), (up, down, _, pos) in zip(rows, layouts):
        base = y + 14 + up
        d.rectangle([0, y, W, y], fill=(96, 96, 100, 255))
        flags = ("loop " if anim.get("loop") else "") + ("mirror" if anim.get("mirror") else "")
        d.text((6, y + 4), name, fill=(255, 255, 255), font=font)
        d.text((6, y + 18), f"{len(cells)} fr, {sum(anim['holds'])} f", fill=(230, 230, 230), font=font)
        if flags:
            d.text((6, y + 32), flags, fill=(230, 230, 230), font=font)
        d.line([(lab_w - 4, base), (W - pad, base)], fill=(90, 90, 96, 255))
        for (fr, hold, im, ax, ay, i), (x, left) in zip(cells, pos):
            if anim.get("mirror"):
                im = im.transpose(Image.FLIP_LEFT_RIGHT)
                ax = im.width - ax
            ox = x + left - ax
            img.alpha_composite(im, (ox, base - ay))
            d.rectangle([x + left - 1, base - 1, x + left, base], fill=(255, 0, 255, 255))
            d.text((x, y + 2), f"{i}:{hold}", fill=(255, 255, 160), font=font)
            d.text((x, base + down + 4), fr if kind == "body" else fr[3:], fill=(20, 20, 20), font=font)
        y += up + down + 34
    img.save(out)
    print(f"preview {out.name}: {img.size}")


# --------------------------------------------------------------------------
# palette measure

def hue_hist(a, mask):
    h, s, l = hsl(a)
    sel = mask & (s >= 0.3)
    out = {}
    for name, lo, hi in (("ink", 0, 0.12), ("cloth", 0.12, 0.40), ("glow", 0.40, 1.01)):
        m = sel & (l >= lo) & (l < hi)
        hist = np.bincount((h[m] // 5).astype(int), minlength=72)[:72]
        n = int(m.sum())
        stats = None
        if n:
            stats = {"n": n, "hueP5": round(float(np.percentile(h[m], 5)), 1),
                     "hueP50": round(float(np.percentile(h[m], 50)), 1),
                     "hueP95": round(float(np.percentile(h[m], 95)), 1),
                     "satP5": round(float(np.percentile(s[m], 5)), 3),
                     "satP50": round(float(np.percentile(s[m], 50)), 3),
                     "lightP5": round(float(np.percentile(l[m], 5)), 3),
                     "lightP95": round(float(np.percentile(l[m], 95)), 3)}
        out[name] = {"stats": stats, "hist5deg": {str(i * 5): int(v) for i, v in enumerate(hist) if v}}
    return out


def measure(manifest: dict):
    pix = []
    for key in manifest["frames"]:
        if key.split("_")[0] in ("loco", "air", "heavy", "parry"):
            im = np.asarray(Image.open(OUT_DIR / f"{key}.png").convert("RGBA"))
            pix.append(im[im[..., 3] == 255][:, :3])
    allp = np.concatenate(pix)[None]
    ones = np.ones(allp.shape[:2], bool)
    res = {"_readme": "Written by cut_trekmore.py --measure. Opaque pixels of the side-view crops "
                      "(loco, air, heavy, parry). Lightness classes: ink l < 0.12, cloth 0.12..0.40, glow >= 0.40; "
                      "only s >= 0.3. hist5deg = pixel count per 5 degree hue bin.",
           "trekmore": hue_hist(allp, ones)}
    h, s, l = hsl(allp)
    res["trekmore"]["bandEstimate"] = {
        "glow": {"hueMin": float(np.percentile(h[(s >= 0.35) & (l >= 0.35)], 2)),
                 "hueMax": float(np.percentile(h[(s >= 0.35) & (l >= 0.35)], 98)),
                 "satMin": 0.35, "lightMin": 0.35},
        "cloth": {"hueMin": float(np.percentile(h[(s >= 0.2) & (l >= 0.10) & (l < 0.35)], 2)),
                  "hueMax": float(np.percentile(h[(s >= 0.2) & (l >= 0.10) & (l < 0.35)], 98)),
                  "satMin": 0.2, "lightMin": 0.10, "lightMax": 0.35},
        "inkBelowL": 0.07,
    }
    for band in res["trekmore"]["bandEstimate"].values():
        if isinstance(band, dict):
            for k in ("hueMin", "hueMax"):
                band[k] = round(band[k], 1)
    # five hex values for the pixler prompt: medians of l-quantiles of violet pixels
    vio = (h >= 240) & (h <= 300) & (s >= 0.2)
    px = allp[0][vio[0]]
    lv = l[0][vio[0]]
    hexes = []
    for q0, q1 in ((0, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.0)):
        a0, a1 = np.quantile(lv, q0), np.quantile(lv, q1)
        sel = px[(lv >= a0) & (lv <= a1)]
        c = np.median(sel, 0).astype(int)
        hexes.append("#%02x%02x%02x" % tuple(c))
    res["trekmore"]["paletteHex"] = hexes
    # Aeval: coat and hair
    idle = np.asarray(Image.open(AEVAL_CROPS / "moves_idle_0.png").convert("RGBA"))
    op = idle[..., 3] == 255
    ys = np.nonzero(op.any(1))[0]
    cut_y = ys.min() + int(0.2 * (ys.max() - ys.min() + 1))
    hair = np.zeros_like(op); hair[:cut_y] = op[:cut_y]
    coat = op & ~hair
    ah, as_, al = hsl(idle[..., :3])
    blue = (ah >= 180) & (ah <= 260) & (as_ < 0.35)

    def region(m):
        m = m & blue
        if not m.any():
            return None
        return {"n": int(m.sum()),
                "hueP5": round(float(np.percentile(ah[m], 5)), 1), "hueP50": round(float(np.percentile(ah[m], 50)), 1),
                "hueP95": round(float(np.percentile(ah[m], 95)), 1),
                "satP5": round(float(np.percentile(as_[m], 5)), 3), "satP95": round(float(np.percentile(as_[m], 95)), 3),
                "lightP5": round(float(np.percentile(al[m], 5)), 3), "lightP50": round(float(np.percentile(al[m], 50)), 3),
                "lightP95": round(float(np.percentile(al[m], 95)), 3)}
    body_src = []
    import re
    ts = (ROOT / "src" / "characters" / "aeval" / "art" / "atlas.body.ts").read_text(encoding="utf-8")
    mt = re.search(r"base64,([A-Za-z0-9+/=]+)'", ts)
    if mt:
        import base64
        import io
        atlas = np.asarray(Image.open(io.BytesIO(base64.b64decode(mt.group(1)))).convert("RGBA"))
        aop = atlas[..., 3] == 255
        th, ts_, tl = hsl(atlas[..., :3])
        am = aop & (th >= 180) & (th <= 260) & (ts_ < 0.35)
        res["aeval"] = {"atlasCoatHair": {"n": int(am.sum()),
                                          "hist5deg": {str(i * 5): int(v) for i, v in enumerate(np.bincount((th[am] // 5).astype(int), minlength=72)[:72]) if v},
                                          "lightP5": round(float(np.percentile(tl[am], 5)), 3),
                                          "lightP50": round(float(np.percentile(tl[am], 50)), 3),
                                          "lightP95": round(float(np.percentile(tl[am], 95)), 3),
                                          "satP50": round(float(np.percentile(ts_[am], 50)), 3)}}
    res.setdefault("aeval", {})
    res["aeval"]["hairRegion_moves_idle_0_top20pct"] = region(hair)
    res["aeval"]["coatRegion_moves_idle_0_rest"] = region(coat)
    del body_src
    (ART / "palette_measure.json").write_text(json.dumps(res, indent=1), encoding="utf-8", newline=chr(10))
    print("palette:", json.dumps(res["trekmore"]["bandEstimate"]), res["trekmore"]["paletteHex"])


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    cmap = json.loads(CUTMAP.read_text(encoding="utf-8"))
    sheets = [k for k in cmap if not k.startswith("_")]
    ap.add_argument("--sheet", choices=sheets)
    ap.add_argument("--measure", action="store_true")
    ap.add_argument("--preview", action="store_true",
                    help="write art/trekmore/preview_sheet_body.png and preview_sheet_fx.png from sheetmap.json")
    args = ap.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    man_path = OUT_DIR / "manifest.json"
    manifest = {"sheetScale": {}, "frames": {}, "fx": {}}
    names = [args.sheet] if args.sheet else sheets
    if args.sheet and man_path.exists():
        manifest = json.loads(man_path.read_text(encoding="utf-8"))
        manifest["frames"] = {k: v for k, v in manifest["frames"].items() if not k.startswith(args.sheet + "_")}
    report = {"counts": {}, "fallbackRows": [], "scaleTable": {}}
    all_ok = True
    frames_by_sheet = {}
    scales = {}
    # sword length is calibrated once on the reference sheet (loco idle 0)
    sword_cfg = cmap["_swordCalibration"]
    order = [sword_cfg["sheet"]] + [n for n in sheets if n != sword_cfg["sheet"]]
    sword_len = None
    all_results = []
    for name in order:
        cfg = cmap[name]
        need = True  # every sheet is cut for scale and fx sources; only --sheet is written
        if not need:
            continue
        log: list = [f"[{name}] {cfg['file']}"]
        if cfg["mode"] == "grid":
            ok, frames = cut_grid_sheet(name, cfg, log, report)
        else:
            ok, frames = cut_rows_sheet(name, cfg, log, report)
        scale, sok = sheet_scale(name, cfg, frames, log, sword_len, report)
        ok &= sok
        if name == sword_cfg["sheet"]:
            sword_len = sword_px(sword_cfg) * scale
            log.append(f"  SWORD_LEN = {sword_px(sword_cfg):.1f} px x {scale:.5f} = {sword_len:.2f} game px")
            report["swordLen"] = round(sword_len, 2)
        # per-row scale override (the backstrike row is drawn larger)
        row_scale = {}
        for row in cfg.get("rows", []):
            if "likeRow" in row.get("scaleRef", {}):
                # a row with no measurable body takes the scale of a row drawn in the same panel
                row_scale[row["name"]] = row_scale[row["scaleRef"]["likeRow"]]
                log.append(f"  row {row['name']}: scale of row {row['scaleRef']['likeRow']} = {row_scale[row['name']]:.5f}")
                report["scaleTable"][f"{name}_{row['name']}"] = {"used": "likeRow " + row["scaleRef"]["likeRow"],
                                                                 "scale": round(row_scale[row["name"]], 5)}
            elif "scaleRef" in row:
                # a row drawn at its own scale (backstrike row, concept mini sprites)
                rs, rok = sheet_scale(f"{name}_{row['name']}", {"scaleRef": row["scaleRef"], "rowName": row["name"]},
                                      frames, log, sword_len, report)
                ok &= rok
                if rs is None:
                    log.append(f"  ERROR {name}_{row['name']}: row scale reference failed; sheet scale used")
                    rs = scale
                row_scale[row["name"]] = rs
        scales[name] = (scale, row_scale)
        for f in frames:
            if f.body is not None:
                POSE_H[f.key] = body_height(f) * row_scale.get(f.row, scale)
        frames_by_sheet[name] = frames
        if name in names:
            for p in OUT_DIR.glob(f"{name}_*.png"):
                p.unlink()
            results = []
            for f in frames:
                sc = row_scale.get(f.row, scale)
                img, ax, ay = write_frame(f, sc, manifest)
                results.append((f.row, f.key, img, ax, ay))
            manifest["sheetScale"][name] = round(scale, 5)
            for rn, rs in row_scale.items():
                manifest["sheetScale"][f"{name}_{rn}"] = round(rs, 5)
            contact(results, OUT_DIR / f"CONTACT_{name}.png")
            all_results += results
        print("\n".join(log))
        all_ok &= ok

    # fx
    fx_results = []
    if not args.sheet:
        manifest["fx"] = {}
        for p in OUT_DIR.glob("fx_*.png"):
            p.unlink()
    made = {}
    # cut fx first, then the derived ones (scale / alpha of a cut fx)
    fx_order = {sp["name"]: i for i, sp in enumerate(cmap["_fx"])}
    for spec in sorted(cmap["_fx"], key=lambda sp: "from" in sp):
        sheet = spec["src"].split("_")[0]
        if args.sheet and sheet != args.sheet and "from" not in spec:
            continue
        if "from" in spec:
            if spec["from"] not in made:
                continue
            res = post(made[spec["from"]], spec)
            src = manifest["fx"].get(spec["from"], {}).get("src", spec["src"])
        else:
            parts = spec["src"].split("_")
            row, idx = "_".join(parts[1:-1]), int(parts[-1])
            f = find(frames_by_sheet.get(sheet, []), row, idx)
            if f is None:
                print(f"ERROR fx {spec['name']}: source {spec['src']} missing")
                all_ok = False
                continue
            sc, rsc = scales[sheet]
            res, _ = fx_from(f, rsc.get(row, sc), spec)
            if res is None:
                print(f"ERROR fx {spec['name']}: empty")
                all_ok = False
                continue
            made[spec["name"]] = res
            if any(k in spec for k in ("rescale", "alpha", "fitMax")):
                res = post(res, spec)
            src = spec["src"]
        img, ax, ay = res
        img.save(OUT_DIR / f"fx_{spec['name']}.png")
        manifest["fx"][spec["name"]] = {"w": img.width, "h": img.height, "ax": ax, "ay": ay,
                                        "anchor": spec.get("anchor", "centre"), "src": src}
        fx_results.append(("fx", "fx_" + spec["name"], img, ax, ay))
    fx_results.sort(key=lambda r: fx_order[r[1][3:]])
    if fx_results:
        contact(fx_results, OUT_DIR / "CONTACT_fx.png")
    man_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8", newline=chr(10))
    if not args.sheet and all_results:
        contact(all_results, OUT_DIR / "CONTACT.png")
    wp = cmap.get("_winPose")
    if wp and (not args.sheet or args.sheet == wp["src"].split("_")[0]):
        # results win pose (plan A.7): the source figure keyed and scaled to the
        # height of Aeval's win pose, rendered straight from the source pixels
        parts = wp["src"].split("_")
        f = find(frames_by_sheet[parts[0]], "_".join(parts[1:-1]), int(parts[-1]))
        target_h = Image.open(ROOT / wp["heightOf"]).height
        ys = np.nonzero(f.mask.any(1))[0]
        wscale = target_h / (ys.max() - ys.min() + 1)
        img, _, _ = render(f.a, f.mask, f.mask, np.zeros_like(f.mask), wscale, f.anchor)
        img = img.crop(img.getbbox())
        img.save(ROOT / wp["out"])
        print(f"win pose {wp['out']}: {img.size} (scale {wscale:.5f}, target height {target_h})")
    if "pix" in cmap and (not args.sheet or args.sheet == "pix"):
        pix_gate(cmap["pix"])
    if args.measure:
        measure(manifest)
    if args.preview:
        preview("body", ART / "preview_sheet_body.png")
        preview("fx", ART / "preview_sheet_fx.png", zoom=3)
    print("counts", json.dumps(report["counts"]))
    print("fallback", report["fallbackRows"])
    print("scales", json.dumps(report["scaleTable"]))
    print("fx", len(fx_results))
    (ART / "sheets" / "cut_report.json").write_text(json.dumps(report, indent=1), encoding="utf-8", newline=chr(10))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
