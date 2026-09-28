"""Cut the Aeval sprite sheets into per-frame crops.

Contract: art/aeval/sheets/CUT_SPEC.md. Pure Python 3.12 + Pillow + numpy.

    python tools/sheetcut/cut.py                 # all sheets
    python tools/sheetcut/cut.py --sheet ground  # one sheet
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SHEETS_DIR = ROOT / "art" / "aeval" / "sheets"
OUT_DIR = SHEETS_DIR / "crops"
DOWNLOADS = Path.home() / "Downloads"

SOURCES = {
    "moves": "ChatGPT Image Sep 15, 2026, 12_46_24 AM.png",
    "defense": "ChatGPT Image Sep 15, 2026, 12_43_58 AM.png",
    "ground": "ChatGPT Image Sep 15, 2026, 12_50_10 AM.png",
    "special": "ChatGPT Image Sep 15, 2026, 12_53_19 AM.png",
}

FG_T = 28          # foreground: max(r,g,b) > 28
RUN_GAP = 14       # merge column runs whose gap is < 14 px
BODY_MIN = 400     # body component minimum size
STAND_H = 48       # standing height in game px

# Blanked y ranges (inclusive) spanning the full width: titles and caption lines.
# Rects are (y0, y1, x0, x1) inclusive, used for titles glued to a sprite band.
SHEETS = {
    "moves": {
        "blank": [(23, 47), (276, 300), (790, 815)],
        "rects": [],
        "rows": [("idle", 68, 248, 9), ("run", 318, 481, 10),
                 ("jump", 511, 762, 9), ("crouch", 829, 989, 9)],
    },
    "defense": {
        "blank": [(20, 40), (314, 335)],
        "rects": [],
        "rows": [("ledge", 41, 285, 11), ("dodge", 362, 514, 10),
                 ("roll", 538, 705, 11)],
    },
    "ground": {
        "blank": [(12, 30), (164, 176), (187, 205), (333, 344), (361, 375),
                  (501, 512), (682, 694), (709, 724), (838, 853),
                  (996, 1006)],
        # Titles glued to a sprite band: blank the title text area only, the
        # sweepU slash (frame 4) reaches up to y 528 beside its title.
        "rects": [(528, 545, 0, 400), (859, 880, 0, 262)],
        "rows": [("spikeShort", 45, 159, 6), ("spikeMed", 217, 326, 7),
                 ("sweepF", 386, 495, 6), ("sweepU", 528, 675, 6),
                 ("spikeD", 725, 853, 6), ("spikeU", 859, 990, 7)],
    },
    "special": {
        "blank": [(14, 36), (209, 222), (259, 280), (465, 482), (527, 548)],
        "rects": [],
        "rows": [("wave", 75, 202, 8), ("whirl", 289, 464, 7),
                 ("aerials", 527, 973, None)],
    },
    # Wave 3 sheets. Blocks sit side by side split by thin vertical cyan
    # lines, so rows carry an x range too: (name, y0, y1, frames, (x0, x1)).
    # "scaleRef" = (row, idx) of the standing frame whose body height is 48.
    "extra": {
        "blank": [(10, 34), (50, 70), (207, 221), (244, 266), (414, 432),
                  (458, 482), (750, 766)],
        # "2. TORNADO (3)" title is glued to the top of the full tornado frame
        "rects": [(500, 520, 545, 705)],
        "rows": [("nair", 72, 205, 5, (0, 494)), ("fair", 72, 205, 5, (499, 1022)),
                 ("bair", 72, 205, 5, (1028, 1535)),
                 ("airjump", 268, 412, 4, (0, 477)), ("dash", 268, 412, 3, (482, 1022)),
                 ("taunt", 268, 412, 3, (1028, 1535)),
                 ("tornado", 505, 748, 3, (545, 1040))],
        "scaleRef": ("taunt", 0),
        # the FS victim's legs are hidden inside the tornado water
        "anchorBottom": ("tornado",),
        "wave3": True,   # split_spanning + union_body (see below)
    },
    "uptilt": {
        "blank": [(838, 870)],
        # title + rule; the extend frame's javelin (x >= 1040) rises past it
        "rects": [(148, 185, 0, 975)],
        "rows": [("spike", 60, 835, 5)],
        "scaleRef": ("spike", 4),
        "wave3": True,
    },
}
AERIAL_SPLIT = 770

FX = [
    ("orb0", "ground", "spikeShort", 1), ("orb1", "ground", "spikeMed", 1),
    ("orb2", "ground", "spikeMed", 2), ("burst0", "ground", "spikeShort", 3),
    ("burst1", "ground", "spikeShort", 4), ("burst2", "ground", "spikeMed", 5),
    ("crescent0", "special", "wave", 4), ("crescent1", "special", "wave", 5),
    ("crescent2", "special", "wave", 6), ("arrow0", "ground", "spikeMed", 4),
    ("hitspark0", "ground", "spikeD", 4), ("hitspark1", "ground", "spikeD", 5),
    ("hitspark2", "ground", "spikeShort", 4), ("splash0", "ground", "spikeD", 3),
    ("splash1", "ground", "spikeD", 4), ("splash2", "ground", "spikeD", 5),
    ("ko0", "ground", "spikeU", 3), ("ko1", "ground", "spikeU", 4),
    ("ko2", "ground", "spikeU", 5), ("ko3", "ground", "spikeU", 6),
    # The up-special water column, cut off the body. Anchored at the source
    # frame's heel x and the column's bottom row (see FX_HEEL_ANCHOR).
    ("geyser0", "special", "uair", 3), ("geyser1", "special", "uair", 4),
    ("whirl0", "special", "whirl", 1), ("whirl1", "special", "whirl", 2),
    ("whirl2", "special", "whirl", 3), ("whirl3", "special", "whirl", 4),
]

# fx whose anchor is (body heel x of the source frame, bottom row of the water)
# instead of the crop centre: drawn at a latched takeoff heel point, the column
# stands on the takeoff floor line where the sheet drew it beside the body.
FX_HEEL_ANCHOR = {"geyser0", "geyser1"}

# Body-only copies of frames: (row, idx) -> suffix. Same source frame, every
# water pixel removed, heel anchor. The original frame is still written too.
BODY_ONLY = {"special": {("uair", 3): "3b", ("uair", 4): "4b"}}


# --------------------------------------------------------------------------
# connected components (8-connectivity) via row runs + union-find

def label(mask: np.ndarray):
    """Return (labels int32 array, n). Labels are 1..n, 0 is background."""
    h, w = mask.shape
    m = np.zeros((h, w + 2), dtype=np.int8)
    m[:, 1:-1] = mask
    d = np.diff(m, axis=1)
    ry, rs = np.nonzero(d == 1)
    _, re = np.nonzero(d == -1)
    n = len(ry)
    labels = np.zeros((h, w), dtype=np.int32)
    if n == 0:
        return labels, 0
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    row_start = np.searchsorted(ry, np.arange(h + 1))
    rs_l = rs.tolist()
    re_l = re.tolist()
    for y in range(1, h):
        a0, a1 = row_start[y - 1], row_start[y]
        b0, b1 = row_start[y], row_start[y + 1]
        i, j = a0, b0
        while i < a1 and j < b1:
            # 8-connectivity: [s, e) overlaps with 1 px slack
            if rs_l[i] <= re_l[j] and rs_l[j] <= re_l[i]:
                ra, rb = find(i), find(j)
                if ra != rb:
                    parent[max(ra, rb)] = min(ra, rb)
            if re_l[i] < re_l[j]:
                i += 1
            else:
                j += 1
    roots = np.array([find(k) for k in range(n)])
    uniq, lab = np.unique(roots, return_inverse=True)
    lab = lab + 1
    for k in range(n):
        labels[ry[k], rs_l[k]:re_l[k]] = lab[k]
    return labels, len(uniq)


def comp_stats(labels: np.ndarray, n: int):
    """Per-label size and bbox (x0, y0, x1, y1 inclusive). Index 0 unused."""
    ys, xs = np.nonzero(labels)
    ls = labels[ys, xs]
    size = np.bincount(ls, minlength=n + 1)
    x0 = np.full(n + 1, 1 << 30); y0 = np.full(n + 1, 1 << 30)
    x1 = np.full(n + 1, -1); y1 = np.full(n + 1, -1)
    np.minimum.at(x0, ls, xs); np.minimum.at(y0, ls, ys)
    np.maximum.at(x1, ls, xs); np.maximum.at(y1, ls, ys)
    return size, x0, y0, x1, y1


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(r):
        m = out.copy()
        m[1:, :] |= out[:-1, :]; m[:-1, :] |= out[1:, :]
        m[:, 1:] |= out[:, :-1]; m[:, :-1] |= out[:, 1:]
        m[1:, 1:] |= out[:-1, :-1]; m[:-1, :-1] |= out[1:, 1:]
        m[1:, :-1] |= out[:-1, 1:]; m[:-1, 1:] |= out[1:, :-1]
        out = m
    return out


# --------------------------------------------------------------------------
# masks

def water_seed(a: np.ndarray) -> np.ndarray:
    """Spec: (b - r) >= 30. The character's grey-blue hair and outlines also
    reach b - r >= 30 (about (113,115,147)), so water additionally needs green
    well above red (real water is cyan-blue: g - r >= 15)."""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return ((b - r) >= 30) & ((g - r) >= 15)


def water_mask(a: np.ndarray, fg: np.ndarray) -> np.ndarray:
    return dilate(water_seed(a) & fg, 2) & fg


# --------------------------------------------------------------------------
# blanking

def blank_text_and_rules(a: np.ndarray, log: list) -> None:
    fg = a.max(2) > FG_T
    labels, n = label(fg)
    size, x0, y0, x1, y1 = comp_stats(labels, n)
    hh = y1 - y0 + 1
    ww = x1 - x0 + 1
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # Spec text-cyan is r 40..140, g 100..200, b 150..230; the caption glyphs
    # measure up to b 255 with dark antialiased edges, so the range is widened
    # and only the glyph core (max > 60) is scored.
    core = fg & (a.max(2) > 60)
    cyan = core & (r <= 140) & (g <= 215) & (b >= 100) & (b > g) & (g >= r) & ((b - r) >= 60)
    white = core & (r > 140)
    core_cnt = np.bincount(labels[core], minlength=n + 1)
    cyan_cnt = np.bincount(labels[cyan], minlength=n + 1)
    white_cnt = np.bincount(labels[white], minlength=n + 1)
    kill = np.zeros(n + 1, bool)
    # horizontal rules and vertical dividers
    rules = (hh <= 4) & (ww >= 60)
    vrules = (ww <= 4) & (hh >= 60)
    kill |= rules | vrules
    # broken-off rule segments: thin pieces on the same line as a rule
    for q in np.nonzero(rules)[0]:
        seg = (hh <= 4) & (y0 >= y0[q] - 2) & (y1 <= y1[q] + 2)             & (np.maximum(0, np.maximum(x0 - x1[q], x0[q] - x1)) <= 20)
        kill |= seg
    # text: small cyan glyphs sitting on one baseline with >= 2 neighbours.
    # The baseline test keeps loose water droplets (which are also cyan).
    cand = np.array([k for k in range(1, n + 1)
                     if 8 <= hh[k] <= 26 and core_cnt[k] >= 1 and cyan_cnt[k] >= 0.6 * core_cnt[k]
                     and white_cnt[k] <= 0.15 * core_cnt[k]], dtype=int)
    text = 0
    if len(cand):
        cb, cx0, cx1 = y1[cand], x0[cand], x1[cand]
        ch = hh[cand]
        for i, k in enumerate(cand):
            gap = np.maximum(0, np.maximum(cx0 - x1[k], x0[k] - cx1))
            near = (np.abs(cb - y1[k]) <= 3) & (gap <= 30) & (ch <= 2 * max(hh[k], 6))
            # a merged word (wide, pure glyph colour) counts as a line by itself
            word = (ww[k] >= 2 * hh[k] and 8 <= hh[k] <= 16
                    and cyan_cnt[k] >= 0.8 * core_cnt[k] and white_cnt[k] == 0)
            if near.sum() >= 3 or word:  # near includes itself
                kill[k] = True
                text += 1
        # punctuation and dim glyph pieces inside a detected text line
        tk = np.nonzero(kill[cand])[0]
        if len(tk):
            small = np.nonzero((hh <= 22) & (ww <= 22))[0]
            for k in small:
                if kill[k] or k == 0:
                    continue
                gap = np.maximum(0, np.maximum(x0[cand[tk]] - x1[k], x0[k] - x1[cand[tk]]))
                # bottom-aligned with a glyph (periods, split digits)
                ok = (gap <= 20) & (y0[k] >= y0[cand[tk]] - 3) & (np.abs(y1[k] - y1[cand[tk]]) <= 2)
                if ok.any():
                    kill[k] = True
                    text += 1
    kill[0] = False
    a[kill[labels]] = 0
    log.append(f"  blanked {int(rules.sum())} rules, {int(vrules.sum())} vertical rules, "
               f"{text} text components")


def blank_ledge_blocks(a: np.ndarray, y0b: int, y1b: int, log: list) -> None:
    """Remove the grey slate block(s) in the defense ledge row."""
    band = a[y0b:y1b + 1]
    slate = (np.abs(band[..., 0] - 50) <= 16) & (np.abs(band[..., 1] - 53) <= 16) \
        & (np.abs(band[..., 2] - 80) <= 18) & ((band[..., 2] - band[..., 0]) >= 18) \
        & ((band[..., 2] - band[..., 0]) <= 45)
    labels, n = label(slate)
    size, x0, y0, x1, y1 = comp_stats(labels, n)
    rects = []
    for k in range(1, n + 1):
        w, h = x1[k] - x0[k] + 1, y1[k] - y0[k] + 1
        # Spec says >= 60 wide; the three hang-frame blocks are 50-60 wide, so
        # use >= 40 plus shape tests: a solid rectangle standing on the band floor.
        if w < 40 or h < 60:
            continue
        fill = size[k] / (w * h)
        if fill < 0.8 or y1[k] < band.shape[0] - 8:
            if w >= 60 and h >= 60:
                log.append(f"  (kept slate-coloured component x {x0[k]}-{x1[k]}, y {y0b + y0[k]}-{y0b + y1[k]}: "
                           f"fill {fill:.2f}, not a block)")
            continue
        px = band[labels == k]
        sd = px.std(0)
        if (sd >= 18).any():
            continue
        # the block is a rectangle; its top rim (highlight rows) sits just above
        # the slate body. Walk up while the row is mostly foreground.
        xa, xb = x0[k], x1[k]
        top = y0[k]
        while top > 0:
            row = band[top - 1, xa:xb + 1].max(1) > FG_T
            if row.mean() < 0.8:
                break
            top -= 1
        # below the rim: blank only block-coloured / rim pixels, keep anything
        # far from the block colour (character overlapping the block face).
        med = np.median(px, 0)
        # include the 2 px dark outline columns either side of the block face
        xa = max(xa - 2, 0)
        xb = min(xb + 2, band.shape[1] - 1)
        reg = band[top:, xa:xb + 1]
        dist = np.abs(reg - med).max(2)
        rim_rows = y0[k] - top
        kill = dist <= 40
        kill[:rim_rows + 2] = True
        # anything dark (<= FG_T) inside the block rect is block shading too
        kill |= reg.max(2) <= FG_T
        reg[kill] = 0
        rects.append((xa - 4, top - 2, xb + 4, band.shape[0] - 1))
        log.append(f"  ledge block removed: x {xa}-{xb}, y {y0b + top}-{y0b + y1[k]} "
                   f"(rim {rim_rows}px, colour {med.astype(int).tolist()}, std {sd.round(1).tolist()})")
    # leftover edge lines: foreground pieces lying wholly inside a block rect
    fl, fn = label(band.max(2) > FG_T)
    size, x0, y0, x1, y1 = comp_stats(fl, fn)
    kill = np.zeros(fn + 1, bool)
    for k in range(1, fn + 1):
        for ra, rb, rc, rd in rects:
            if x0[k] >= ra and x1[k] <= rc and y0[k] >= rb and y1[k] <= rd:
                kill[k] = True
    band[kill[fl]] = 0
    log.append(f"  removed {int(kill.sum())} block edge fragments")


# --------------------------------------------------------------------------
# segmentation

def column_runs(mask: np.ndarray):
    cols = mask.any(0)
    xs = np.nonzero(cols)[0]
    if len(xs) == 0:
        return []
    runs = [[xs[0], xs[0]]]
    for x in xs[1:]:
        if x - runs[-1][1] - 1 < RUN_GAP:
            runs[-1][1] = x
        else:
            runs.append([x, x])
    return [(int(s), int(e)) for s, e in runs]


def clean_specks(mask: np.ndarray, min_px: int = 4) -> np.ndarray:
    labels, n = label(mask)
    size = np.bincount(labels.ravel(), minlength=n + 1)
    keep = size >= min_px
    keep[0] = False
    return keep[labels]


def body_components(a, fg, water):
    body = fg & ~water
    labels, n = label(body)
    size, x0, y0, x1, y1 = comp_stats(labels, n)
    dark = (a.max(2) < 90) & body
    dark_cnt = np.bincount(labels[dark], minlength=n + 1)
    out = []
    for k in range(1, n + 1):
        if size[k] > BODY_MIN and dark_cnt[k] >= 0.1 * size[k]:
            out.append((k, x0[k], y0[k], x1[k], y1[k]))
    return labels, out


def gap1d(a0, a1, b0, b1):
    return max(0, b0 - a1, a0 - b1)


def split_spanning(rlabels, rn, bodies, min_px=300):
    """Wave 3 sheets pack frames tightly: one piece (lower body + water ring)
    can touch the next frame's ring and span two bodies. Such a piece is cut
    at its thinnest column between each pair of body centres it covers, so
    each half goes to its own frame. Pixels are partitioned, never repainted."""
    size, x0, y0, x1, y1 = comp_stats(rlabels, rn)
    cxs = sorted((bx0 + bx1) / 2 for (_, bx0, by0, bx1, by1) in bodies)
    nxt = rn + 1
    for c in range(1, rn + 1):
        if size[c] < min_px:
            continue
        inside = [cx for cx in cxs if x0[c] < cx < x1[c]]
        if len(inside) < 2:
            continue
        pm = rlabels == c
        colcnt = pm.sum(0)
        for ca, cb in zip(inside, inside[1:]):
            xa, xb = int(ca) + 1, int(cb)
            cutx = xa + int(np.argmin(colcnt[xa:xb]))
            sel = pm.copy(); sel[:, :cutx] = False
            rlabels[sel & (rlabels == c)] = nxt
            nxt += 1
    # the relabelled halves may themselves be several components: relabel all
    out = np.zeros_like(rlabels)
    n = 0
    for k in np.unique(rlabels):
        if k == 0:
            continue
        l2, n2 = label(rlabels == k)
        out[l2 > 0] = l2[l2 > 0] + n
        n += n2
    return out, n


def segment_by_body(a, nonbg, fg, water, two_d=False, split=False):
    """Step 4b. Returns a list of (sort_x, mask, body_y0, body_y1).

    Body components (non-water, > 400 px, containing coat ink) are the frames.
    Every other piece goes to a body:
      * never across a clean column gap: a piece is only matched against the
        bodies in its own column run (runs that hold one body stay intact);
      * big pieces (>= 300 px) first, to the nearest body bbox;
      * then small pieces, to the nearest frame extent (body + big pieces),
        so spray off the end of a long water arc stays with that arc.
    Distance is the horizontal bbox gap (2-D gap for the aerial blocks); ties go
    to the body on the LEFT in 1-D, to the nearest centre in 2-D.
    A run with no body that holds >= 1500 px is its own bodyless frame.
    """
    blabels, bodies = body_components(a, fg, water)
    body_px = np.zeros(fg.shape, bool)
    for k, *_ in bodies:
        body_px |= blabels == k
    rest = nonbg & ~body_px
    rlabels, rn = label(rest)
    if split:
        rlabels, rn = split_spanning(rlabels, rn, bodies)
    rsize, rx0, ry0, rx1, ry1 = comp_stats(rlabels, rn)
    runs = column_runs(nonbg) if not two_d else [(0, fg.shape[1] - 1)]

    def run_of(x):
        for i, (s0, e0) in enumerate(runs):
            if s0 <= x <= e0:
                return i
        return -1

    ext = [[bx0, by0, bx1, by1] for (_, bx0, by0, bx1, by1) in bodies]
    brun = [run_of((bx0 + bx1) // 2) for (_, bx0, by0, bx1, by1) in bodies]
    owner = np.full(rn + 1, -1, dtype=int)

    def nearest(c, boxes, cands):
        best, bestkey = -1, None
        ccx, ccy = (rx0[c] + rx1[c]) / 2, (ry0[c] + ry1[c]) / 2
        for i in cands:
            bx0, by0, bx1, by1 = boxes[i]
            dx = gap1d(rx0[c], rx1[c], bx0, bx1)
            if two_d:
                dy = gap1d(ry0[c], ry1[c], by0, by1)
                d = (dx * dx + dy * dy) ** 0.5
                tie = ((bx0 + bx1) / 2 - ccx) ** 2 + ((by0 + by1) / 2 - ccy) ** 2
            else:
                d, tie = dx, bx0
            key = (d, tie)
            if bestkey is None or key < bestkey:
                best, bestkey = i, key
        return best

    comps = list(range(1, rn + 1))
    big = [c for c in comps if rsize[c] >= 300]
    small = [c for c in comps if rsize[c] < 300]
    orphan_runs = {}
    for phase, group in ((0, big), (1, small)):
        for c in group:
            r = run_of(rx0[c])
            cands = [i for i in range(len(bodies)) if brun[i] == r]
            if not cands:
                orphan_runs.setdefault(r, []).append(c)
                continue
            boxes = [[bx0, by0, bx1, by1] for (_, bx0, by0, bx1, by1) in bodies] if phase == 0 else ext
            i = nearest(c, boxes, cands)
            owner[c] = i
            if phase == 0:
                e = ext[i]
                e[0] = min(e[0], rx0[c]); e[1] = min(e[1], ry0[c])
                e[2] = max(e[2], rx1[c]); e[3] = max(e[3], ry1[c])
    frames = []
    for i, (k, bx0, by0, bx1, by1) in enumerate(bodies):
        m = (blabels == k) | np.isin(rlabels, np.nonzero(owner == i)[0])
        frames.append((bx0, m, by0, by1))
    for r, members in orphan_runs.items():
        tot = sum(int(rsize[c]) for c in members)
        if tot >= 1500:
            frames.append((runs[r][0], np.isin(rlabels, members), None, None))
        elif bodies:
            # stray bits in an empty run: nearest body anywhere
            boxes = [[bx0, by0, bx1, by1] for (_, bx0, by0, bx1, by1) in bodies]
            for c in members:
                i = nearest(c, boxes, range(len(bodies)))
                fr = frames[i]
                frames[i] = (fr[0], fr[1] | (rlabels == c), fr[2], fr[3])
    return frames


# --------------------------------------------------------------------------

def union_body(labels, n, k, dark, body, gap=20, min_px=30):
    """Wave 3: water rings cross the legs, so the character's largest body
    component can be the upper body only. Grow it with the other ink-bearing
    body pieces lying under / over it (x range inside the body's, vertical gap
    <= `gap`) so the heel anchor is the real feet."""
    size, x0, y0, x1, y1 = comp_stats(labels, n)
    dcnt = np.bincount(labels[dark & body], minlength=n + 1)
    got = {k}
    bx0, by0, bx1, by1 = x0[k], y0[k], x1[k], y1[k]
    grew = True
    while grew:
        grew = False
        for c in range(1, n + 1):
            if c in got or size[c] < min_px or dcnt[c] < 0.1 * size[c]:
                continue
            if x0[c] < bx0 - 8 or x1[c] > bx1 + 8:
                continue
            if gap1d(y0[c], y1[c], by0, by1) > gap:
                continue
            got.add(c); grew = True
            by0, by1 = min(by0, y0[c]), max(by1, y1[c])
    return np.isin(labels, list(got))


def frame_info(a, frame_mask, fg, water, seed, union=False):
    """Return (body_mask or None, anchor (x, y) in band coords).

    Body = largest non-water component that is the character (holds coat ink,
    so a white spike core never wins). If the dilated water mask shatters a
    body hidden behind water, retry against the undilated water seed."""
    dark = a.max(2) < 90
    for wm in (water, seed):
        body = frame_mask & fg & ~wm
        labels, n = label(body)
        if not n:
            continue
        size = np.bincount(labels.ravel(), minlength=n + 1)
        dcnt = np.bincount(labels[dark & body], minlength=n + 1)
        size[0] = 0
        size[dcnt < 0.1 * size] = 0
        k = int(size.argmax())
        if size[k] > BODY_MIN:
            bm = labels == k
            if union:
                # the legs are mostly near-black coat ink (not foreground),
                # so grow over every non-water, non-background pixel
                # blue-tinted leg ink inside a ring's glow (about (79,103,155))
                # passes the water colour test; for the heel only strongly
                # cyan water counts (g - r >= 40, b - r >= 60), dilated 1 px
                r_, g_, b_ = a[..., 0], a[..., 1], a[..., 2]
                bright = dilate(((g_ - r_) >= 40) & ((b_ - r_) >= 60) & fg, 1) & fg
                cand = frame_mask & ~bright
                l2, n2 = label(cand)
                k2 = int(np.bincount(l2[bm], minlength=n2 + 1)[1:].argmax()) + 1
                bm = union_body(l2, n2, k2, dark, cand)
            ys, xs = np.nonzero(bm)
            return bm, ((xs.min() + xs.max()) / 2, float(ys.max() + 1))
    ys, xs = np.nonzero(frame_mask)
    return None, ((xs.min() + xs.max()) / 2, (ys.min() + ys.max() + 1) / 2)


def enclosed_pieces(pieces: np.ndarray, body: np.ndarray, r: int = 3, frac: float = 0.6) -> np.ndarray:
    """Pieces (components of `pieces`) that sit inside the character: at least
    `frac` of the r-px ring around them is body. These are blue eyes and bits
    of face/hair the water dilation carved off the body, not water effects."""
    out = np.zeros_like(pieces)
    labels, n = label(pieces)
    if not n:
        return out
    size, x0, y0, x1, y1 = comp_stats(labels, n)
    H, W = pieces.shape
    for k in range(1, n + 1):
        a0, b0 = max(y0[k] - r, 0), max(x0[k] - r, 0)
        a1, b1 = min(y1[k] + r + 1, H), min(x1[k] + r + 1, W)
        c = labels[a0:a1, b0:b1] == k
        ring = dilate(c, r) & ~pieces[a0:a1, b0:b1]
        if ring.any() and body[a0:a1, b0:b1][ring].mean() >= frac:
            out[a0:a1, b0:b1] |= c
    return out


def body_only_mask(f) -> np.ndarray:
    """The frame's character with every water pixel removed: the body component
    plus the dark ink (non-foreground, non-background) touching it and the
    little pieces enclosed by it (eyes, face bits the water dilation carved off).
    Pixels are never repainted, so water in front of the body leaves a gap."""
    body = f["body"]
    water = f["W"] & ~enclosed_pieces(f["W"], body)
    cand = f["mask"] & f["NB"] & ~water
    labels, n = label(cand)
    hit = np.bincount(labels[body], minlength=n + 1) > 0
    hit[0] = False
    bm = hit[labels] | body
    bm |= enclosed_pieces(f["mask"] & f["NB"] & ~bm, bm)
    return bm


def render(a, alpha, mask, water, scale, anchor=None, cap_all=False):
    """Crop pixels in `mask` (band coords), pad 2, resize. Returns (img, ax, ay)."""
    ys, xs = np.nonzero(mask)
    x0, x1, y0, y1 = xs.min() - 2, xs.max() + 3, ys.min() - 2, ys.max() + 3
    x0 = max(x0, 0); y0 = max(y0, 0)
    x1 = min(x1, mask.shape[1]); y1 = min(y1, mask.shape[0])
    sub = a[y0:y1, x0:x1].astype(np.uint8)
    al = np.where(mask[y0:y1, x0:x1] & alpha[y0:y1, x0:x1], 255, 0).astype(np.uint8)
    rgba = np.dstack([sub, al])
    w, h = x1 - x0, y1 - y0
    ow, oh = max(1, round(w * scale)), max(1, round(h * scale))
    img = Image.fromarray(rgba, "RGBA").convert("RGBa").resize((ow, oh), Image.LANCZOS).convert("RGBA")
    arr = np.asarray(img).copy()
    wm = water[y0:y1, x0:x1] & mask[y0:y1, x0:x1]
    if cap_all:
        cap = arr[..., 3] > 0
    else:
        ws = np.asarray(Image.fromarray((wm * 255).astype(np.uint8)).resize((ow, oh), Image.BILINEAR)) >= 128
        cap = ws
    arr[..., 3] = np.where(cap & (arr[..., 3] > 254), 254, arr[..., 3])
    arr[arr[..., 3] < 4] = 0   # LANCZOS ringing specks in the empty area
    img = Image.fromarray(arr, "RGBA")
    if anchor is None:
        anchor = ((xs.min() + xs.max()) / 2, (ys.min() + ys.max() + 1) / 2)
    ax = round((anchor[0] - x0) * scale)
    ay = round((anchor[1] - y0) * scale)
    return img, ax, ay


def cut_sheet(name: str, report: dict, log: list):
    cfg = SHEETS[name]
    a = np.asarray(Image.open(SHEETS_DIR / f"{name}.png").convert("RGB")).astype(np.int32).copy()
    log.append(f"[{name}] {a.shape[1]}x{a.shape[0]}")
    for y0, y1 in cfg["blank"]:
        a[y0:y1 + 1] = 0
    for y0, y1, x0, x1 in cfg["rects"]:
        a[y0:y1 + 1, x0:x1 + 1] = 0
    blank_text_and_rules(a, log)
    if name == "defense":
        _, y0, y1, _ = cfg["rows"][0]
        blank_ledge_blocks(a, y0, y1, log)

    fg_full = a.max(2) > FG_T
    # background keying: flood from the border over dark pixels
    dl, dn = label(~fg_full)
    border = np.unique(np.concatenate([dl[0], dl[-1], dl[:, 0], dl[:, -1]]))
    border = border[border > 0]
    # Enclosed dark pockets: coat ink and pupils sit at max about 15-25 and stay
    # opaque; pockets of near-pure black (mean max < 12) are background seen
    # through a water ring or between limbs and are keyed out too.
    mx = a.max(2)
    dsum = np.bincount(dl.ravel(), weights=mx.ravel(), minlength=dn + 1)
    dcnt = np.bincount(dl.ravel(), minlength=dn + 1)
    holes = np.nonzero(dsum < 12 * dcnt)[0]
    holes = holes[holes > 0]
    bg_full = np.isin(dl, np.union1d(border, holes))
    nonbg_full = ~bg_full
    water_full = water_mask(a, fg_full)
    seed_full = water_seed(a) & fg_full

    frames_out = []   # (rowname, idx, img, ax, ay, bodyless, fxinfo)
    scale = None
    ok = True
    for row in cfg["rows"]:
        rowname, yb0, yb1, expected = row[:4]
        sl = slice(yb0, yb1 + 1)
        A = a[sl]; FG = fg_full[sl]; NB = nonbg_full[sl]; W = water_full[sl]; SD = seed_full[sl]
        if len(row) > 4:  # block row: only this x range of the band
            xm = np.zeros(FG.shape, bool)
            xm[:, row[4][0]:row[4][1] + 1] = True
            FG = FG & xm; NB = NB & xm; W = W & xm; SD = SD & xm
        NBc = clean_specks(NB)
        frame_masks = []   # list of masks in band coords, ordered
        if expected is None:  # aerials: two blocks, 2x3 each
            for block, (bx0, bx1) in (("uair", (0, AERIAL_SPLIT)), ("dair", (AERIAL_SPLIT, a.shape[1]))):
                half = np.zeros_like(NBc); half[:, bx0:bx1] = True
                fr = segment_by_body(A, NBc & half, FG & half, W & half, two_d=True)
                if len(fr) != 6:
                    log.append(f"  ERROR {name} {block}: {len(fr)} frames (expected 6)")
                    ok = False
                    continue
                # row-major: split at the largest gap of body-centre y
                cys = []
                for bx, m, by0, by1 in fr:
                    ys = np.nonzero(m.any(1))[0]
                    cys.append((by0 + by1) / 2 if by0 is not None else ys.mean())
                order = np.argsort(cys)
                top = sorted(order[:3], key=lambda i: fr[i][0])
                bot = sorted(order[3:], key=lambda i: fr[i][0])
                masks = [fr[i][1] for i in list(top) + list(bot)]
                report["counts"][f"{name}_{block}"] = len(masks)
                report["fallbackRows"].append(f"{name}_{block}")
                frame_masks.append((block, masks))
        else:
            runs = column_runs(NBc)
            if len(runs) == expected:
                masks = []
                for s, e in runs:
                    m = np.zeros_like(NBc); m[:, s:e + 1] = NBc[:, s:e + 1]
                    masks.append(m)
            else:
                log.append(f"  {rowname}: {len(runs)} column runs (expected {expected}), "
                           f"spans {runs}; using body segmentation")
                fr = segment_by_body(A, NBc, FG, W, split=cfg.get("wave3", False))
                fr.sort(key=lambda f: f[0])
                masks = [f[1] for f in fr]
                report["fallbackRows"].append(f"{name}_{rowname}")
                if len(masks) != expected:
                    spans = []
                    for m in masks:
                        xs = np.nonzero(m.any(0))[0]
                        spans.append((int(xs.min()), int(xs.max())))
                    log.append(f"  ERROR {name} {rowname}: {len(masks)} frames (expected {expected}), spans {spans}")
                    ok = False
                    # still write the column-run frames so the row can be inspected
                    masks = []
                    for s, e in runs:
                        m = np.zeros_like(NBc); m[:, s:e + 1] = NBc[:, s:e + 1]
                        masks.append(m)
                    log.append(f"  wrote {len(masks)} column-run frames for {rowname} (count check FAILED)")
            report["counts"][f"{name}_{rowname}"] = len(masks)
            frame_masks.append((rowname, masks))

        for rname, masks in frame_masks:
            for i, m in enumerate(masks):
                bm, anchor = frame_info(A, m, FG, W, SD, union=cfg.get("wave3", False))
                if rname in cfg.get("anchorBottom", ()):
                    # body hidden inside the water: bottom centre of the crop
                    ys_, xs_ = np.nonzero(m)
                    anchor = ((xs_.min() + xs_.max()) / 2, float(ys_.max() + 1))
                if scale is None and "scaleRef" not in cfg:
                    bh = np.nonzero(bm.any(1))[0]
                    scale = STAND_H / (bh.max() - bh.min() + 1)
                    log.append(f"  scale = 48 / {bh.max() - bh.min() + 1} = {scale:.5f}")
                frames_out.append(dict(row=rname, idx=i, A=A, NB=NB, mask=m, W=W & m,
                                       FG=FG, body=bm, anchor=anchor, y0=yb0))
    if "scaleRef" in cfg:
        rr, ri = cfg["scaleRef"]
        f = next((f for f in frames_out if f["row"] == rr and f["idx"] == ri), None)
        if f is None or f["body"] is None:
            log.append(f"  ERROR {name}: scale reference {rr} {ri} has no body")
            return False, []
        bh = np.nonzero(f["body"].any(1))[0]
        scale = STAND_H / (bh.max() - bh.min() + 1)
        log.append(f"  scale = 48 / {bh.max() - bh.min() + 1} = {scale:.5f} (from {rr}_{ri})")
    report["scale"][name] = round(scale, 5) if scale else None

    results = []
    for f in frames_out:
        wcap = f["W"]
        if f["body"] is not None:
            wcap = wcap & ~enclosed_pieces(wcap, f["body"])
        img, ax, ay = render(f["A"], f["NB"], f["mask"], wcap, scale, f["anchor"])
        key = f"{name}_{f['row']}_{f['idx']}"
        img.save(OUT_DIR / f"{key}.png")
        ys, xs = np.nonzero(f["mask"])
        report["manifest"]["frames"][key] = {"w": img.width, "h": img.height, "ax": ax, "ay": ay,
                                             "bodyless": f["body"] is None,
                                             # source rect on the sheet, for tracing
                                             "src": [int(xs.min()), int(ys.min()) + f["y0"],
                                                     int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]}
        results.append((f["row"], key, img, ax, ay))
        suffix = BODY_ONLY.get(name, {}).get((f["row"], f["idx"]))
        if suffix is not None and f["body"] is not None:
            bm = body_only_mask(f)
            img, ax, ay = render(f["A"], f["NB"], bm, f["W"] & bm & ~f["body"], scale, f["anchor"])
            key = f"{name}_{f['row']}_{suffix}"
            img.save(OUT_DIR / f"{key}.png")
            ys, xs = np.nonzero(bm)
            report["manifest"]["frames"][key] = {"w": img.width, "h": img.height, "ax": ax, "ay": ay,
                                                 "bodyless": False,
                                                 "src": [int(xs.min()), int(ys.min()) + f["y0"],
                                                         int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]}
            results.append((f["row"], key, img, ax, ay))
            log.append(f"  body-only {key}: {int(bm.sum())} px (body component {int(f['body'].sum())} px)")

    # fx
    for fxname, sheet, row, idx in FX:
        if sheet != name:
            continue
        f = next((f for f in frames_out if f["row"] == row and f["idx"] == idx), None)
        if f is None:
            log.append(f"  ERROR fx {fxname}: frame missing")
            ok = False
            continue
        m = f["mask"] & f["FG"]
        if f["body"] is not None:
            m = m & ~f["body"]
            # drop leftover pieces that carry no water (character fringe)
            fl, fn = label(m)
            has_w = np.bincount(fl[f["W"] & m], minlength=fn + 1) > 0
            has_w[0] = False
            m = has_w[fl]
            # keep only watery pixels: the water seed or white-blue highlights;
            # this drops skin, hair and coat fringe the dilation cut off the body
            A_ = f["A"]
            watery = water_seed(A_) | ((A_.min(2) >= 170) & (A_[..., 2] >= A_[..., 0]))
            m &= watery
            # white outline bits of hair/coat left behind: pieces that are not
            # mostly true water colour
            mxA = np.maximum(A_.max(2), 1)
            sat = (A_.max(2) - A_.min(2)) / mxA
            sd = water_seed(A_) & (sat >= 0.3) & m   # pale hair sheen is < 0.3
            fl, fn = label(m)
            tot = np.bincount(fl.ravel(), minlength=fn + 1)
            wat = np.bincount(fl[sd], minlength=fn + 1)
            bright = np.bincount(fl.ravel(), weights=A_.max(2).ravel(), minlength=fn + 1)
            # also dim blue-tinted coat/hair edge pixels (mean max < 120)
            keep = (wat >= 0.3 * tot) & (bright >= 120 * tot)
            keep[0] = False
            m = keep[fl]
            m &= ~enclosed_pieces(m, f["body"])
            if fxname.startswith("crescent"):
                bx1 = np.nonzero(f["body"].any(0))[0].max()
                m[:, :bx1 + 1] = False
        if not m.any():
            log.append(f"  ERROR fx {fxname}: empty")
            ok = False
            continue
        anchor = None
        if fxname in FX_HEEL_ANCHOR:
            if f["body"] is None:
                log.append(f"  ERROR fx {fxname}: source frame has no body for the heel anchor")
                ok = False
                continue
            # heel x of the source frame, column base = bottom row of the water
            anchor = (f["anchor"][0], float(np.nonzero(m.any(1))[0].max() + 1))
        img, ax, ay = render(f["A"], f["NB"], m, f["W"], scale, anchor, cap_all=True)
        img.save(OUT_DIR / f"fx_{fxname}.png")
        report["manifest"]["fx"][fxname] = {"w": img.width, "h": img.height, "ax": ax, "ay": ay,
                                            "anchor": "heel" if anchor is not None else "centre",
                                            "src": f"{sheet}_{row}_{idx}"}
        report["fx"].append(fxname)
    return ok, results


# --------------------------------------------------------------------------
# contact sheets

def contact(results, path: Path):
    font = ImageFont.load_default()
    Z = 2
    rows = []
    cur = None
    for row, key, img, ax, ay in results:
        if row != cur:
            rows.append([]); cur = row
        rows[-1].append((key, img, ax, ay))
    pad, lab_h = 8, 14
    tiles = []
    for r in rows:
        cells = []
        for key, img, ax, ay in r:
            big = img.resize((img.width * Z, img.height * Z), Image.NEAREST)
            label_w = int(font.getlength(key)) + 4
            cells.append((key, big, ax * Z, ay * Z, max(big.width, label_w)))
        rw = sum(c[4] for c in cells) + pad * (len(cells) + 1)
        rh = max(c[1].height for c in cells) + lab_h + pad * 2
        tiles.append((cells, rw, rh))
    W = max(t[1] for t in tiles)
    H = sum(t[2] for t in tiles)
    out = Image.new("RGBA", (W, H), (48, 48, 52, 255))
    d = ImageDraw.Draw(out)
    y = 0
    for cells, rw, rh in tiles:
        x = pad
        base = y + pad + max(c[1].height for c in cells)
        for key, big, ax, ay, cw in cells:
            ox = x + (cw - big.width) // 2
            oy = base - big.height
            d.rectangle([ox - 1, oy - 1, ox + big.width, oy + big.height], outline=(70, 70, 76))
            out.alpha_composite(big, (ox, oy))
            d.rectangle([ox + ax - 1, oy + ay - 1, ox + ax, oy + ay], fill=(255, 0, 255, 255))
            d.text((x, base + 2), key, fill=(220, 220, 220), font=font)
            x += cw + pad
        y += rh
    out.save(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", choices=list(SHEETS))
    args = ap.parse_args()
    for name, src in SOURCES.items():
        dst = SHEETS_DIR / f"{name}.png"
        if not dst.exists():
            s = DOWNLOADS / src
            if not s.exists():
                print(f"missing input {dst} and {s}")
                return 1
            shutil.copyfile(s, dst)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    names = [args.sheet] if args.sheet else list(SHEETS)
    man_path = OUT_DIR / "manifest.json"
    manifest = {"sheetScale": {}, "frames": {}, "fx": {}}
    if args.sheet and man_path.exists():
        manifest = json.loads(man_path.read_text())
        manifest["frames"] = {k: v for k, v in manifest["frames"].items() if not k.startswith(args.sheet + "_")}
        manifest["fx"] = {k: v for k, v in manifest.get("fx", {}).items()
                          if not v.get("src", "").startswith(args.sheet + "_")}
    report = {"scale": {}, "counts": {}, "fx": [], "fallbackRows": [], "manifest": manifest}
    all_ok = True
    all_results = []
    for name in names:
        for p in OUT_DIR.glob(f"{name}_*.png"):
            p.unlink()
        log: list = []
        ok, results = cut_sheet(name, report, log)
        print("\n".join(log))
        all_ok &= ok
        if results:
            contact(results, OUT_DIR / f"CONTACT_{name}.png")
            all_results += results
    manifest["sheetScale"].update(report["scale"])
    man_path.write_text(json.dumps(manifest, indent=1))
    if not args.sheet and all_results:
        contact(all_results, OUT_DIR / "CONTACT.png")
    print("scale", report["scale"])
    print("counts", report["counts"])
    print("fallback", report["fallbackRows"])
    print("fx", len(report["fx"]))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
