"""Cut a stage painting into parallax layers.

    python tools/stagecut/cut_stage.py <stageId>

Reads art/stages/<id>/source.png and masks.json, writes
art/stages/<id>/layers/*.png, art/stages/<id>/collision_check.png,
art/stages/<id>/masks_preview.png, art/stages/<id>/composite_reference.png,
src/stages/<id>/layers.ts and src/stages/<id>/geometry.ts.

Placement (docs/WAVE_ARENA_BALANCE.md contract 3): the painting is scaled so
its full width is masks.json "worldWidth" world px, the main platform walk line
(collision.origin, measured on the painting) sits at world (0, 0). The
painting's world rect is the camera bounds; the blast zone is that rect grown
by blastPad (left, top, right, bottom). Both are written into geometry.ts.

shiftY (world px, positive = down) on a stage-layer shape moves that piece's
pixels down in the stage layer (behind the unshifted stage pixels); the same
key on a collision platform moves its line. The place a piece leaves is filled
in the back layers by the same diffusion as any other hidden pixel.

Pipeline, per layer, back to front:
  1. Build the layer's cut-out mask at half source resolution from the hand
     polygons in masks.json, refined by colour rules (dark, light, water,
     green, foliage,
     sky) and flood-fill connectivity (PIL only, no scipy).
  2. A layer owns its mask minus every layer in front of it. The hidden part
     (and, for the sky, every hole left by a front layer) is filled by
     pull-push diffusion from the owned pixels, relaxed with Jacobi neighbour
     averaging, then blurred lightly inside the hole only. Nothing is painted.
  3. Scale to game size, pad every side by edge-clamped rows/columns blended
     into the diffusion fill so the runtime can clamp the outermost pixel
     without a visible edge.
  4. Quantize all layers to one shared palette with no dithering; alpha is
     hard (thresholded at 50%).

Only Python 3.12 + Pillow + numpy.
"""

from __future__ import annotations

import base64
import io
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]

WORK = 0.5  # masks are built at half source resolution


# ---------------------------------------------------------------- helpers


def load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float32)


def resize_rgb(rgb: np.ndarray, w: int, h: int) -> np.ndarray:
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    return np.asarray(img.resize((w, h), Image.Resampling.LANCZOS)).astype(np.float32)


def resize_mask(mask: np.ndarray, w: int, h: int) -> np.ndarray:
    """Area-average a bool mask to (w, h) and return the coverage in [0, 1]."""
    img = Image.fromarray((mask.astype(np.float32) * 255).astype(np.uint8))
    return np.asarray(img.resize((w, h), Image.Resampling.BOX)).astype(np.float32) / 255.0


def poly_mask(poly: list[list[float]], w: int, h: int, scale: float) -> np.ndarray:
    img = Image.new("L", (w, h), 0)
    ImageDraw.Draw(img).polygon([(x * scale, y * scale) for x, y in poly], fill=255)
    return np.asarray(img) > 0


def shift_or(m: np.ndarray, r: int) -> np.ndarray:
    """Square dilation by r pixels."""
    out = m.copy()
    for _ in range(r):
        o = out.copy()
        o[1:, :] |= out[:-1, :]
        o[:-1, :] |= out[1:, :]
        o[:, 1:] |= out[:, :-1]
        o[:, :-1] |= out[:, 1:]
        out = o
    return out


def shift_and(m: np.ndarray, r: int) -> np.ndarray:
    return ~shift_or(~m, r)


def shift_rows(m: np.ndarray, dy: int) -> np.ndarray:
    """Move a mask down by dy rows (up when negative); rows shifted in are False."""
    out = np.zeros_like(m)
    if dy > 0:
        out[dy:] = m[:-dy]
    elif dy < 0:
        out[:dy] = m[-dy:]
    else:
        out[:] = m
    return out


def flood_from(binary: np.ndarray, seeds: list[tuple[int, int]]) -> np.ndarray:
    """Pixels of `binary` 4-connected to any seed (seeds on False pixels are skipped)."""
    img = Image.fromarray((binary * 255).astype(np.uint8)).copy()
    h, w = binary.shape
    for x, y in seeds:
        # snap a seed that misses the rule mask to the nearest hit within 12 px
        if 0 <= x < w and 0 <= y < h and not binary[y, x]:
            best = None
            for r in range(1, 13):
                ys, xs = np.nonzero(binary[max(0, y - r) : y + r + 1, max(0, x - r) : x + r + 1])
                if len(xs):
                    best = (int(xs[0]) + max(0, x - r), int(ys[0]) + max(0, y - r))
                    break
            if best is not None:
                x, y = best
        if 0 <= x < img.width and 0 <= y < img.height and img.getpixel((x, y)) == 255:
            ImageDraw.floodfill(img, (x, y), 128)
        elif 0 <= x < img.width and 0 <= y < img.height and img.getpixel((x, y)) == 128:
            pass
        else:
            print(f"  seed {x},{y} not on the rule mask, skipped", file=sys.stderr)
    return np.asarray(img) == 128


def fill_holes(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    padded = np.ones((h + 2, w + 2), dtype=bool)
    padded[1:-1, 1:-1] = ~mask
    outside = flood_from(padded, [(0, 0)])[1:-1, 1:-1]
    return mask | (~outside & ~mask)


def box3(a: np.ndarray) -> np.ndarray:
    p = np.pad(a, ((1, 1), (1, 1), (0, 0)), mode="edge")
    s = np.zeros_like(a)
    for dy in range(3):
        for dx in range(3):
            s += p[dy : dy + a.shape[0], dx : dx + a.shape[1]]
    return s / 9.0


def diffuse_fill(rgb: np.ndarray, known: np.ndarray, jacobi: int = 160) -> np.ndarray:
    """Fill every unknown pixel from the known ones: pull-push, Jacobi, masked blur."""
    if known.all():
        return rgb.copy()
    if not known.any():
        raise ValueError("diffuse_fill: nothing known")
    h, w = known.shape
    # pull
    cs = [rgb * known[..., None]]
    ws = [known.astype(np.float32)]
    while min(cs[-1].shape[0], cs[-1].shape[1]) > 2 and (ws[-1] <= 0).any():
        c, wt = cs[-1], ws[-1]
        hh, ww = c.shape[0], c.shape[1]
        if hh % 2:
            c = np.concatenate([c, c[-1:]], 0)
            wt = np.concatenate([wt, wt[-1:]], 0)
        if ww % 2:
            c = np.concatenate([c, c[:, -1:]], 1)
            wt = np.concatenate([wt, wt[:, -1:]], 1)
        c = (c[0::2, 0::2] + c[1::2, 0::2] + c[0::2, 1::2] + c[1::2, 1::2]) / 4.0
        wt = (wt[0::2, 0::2] + wt[1::2, 0::2] + wt[0::2, 1::2] + wt[1::2, 1::2]) / 4.0
        cs.append(c)
        ws.append(wt)
    # push
    top_w = ws[-1]
    val = np.where(top_w[..., None] > 0, cs[-1] / np.maximum(top_w, 1e-6)[..., None], 0)
    if (top_w <= 0).any():
        mean = (cs[-1].sum((0, 1)) / max(top_w.sum(), 1e-6))
        val[top_w <= 0] = mean
    for lvl in range(len(cs) - 2, -1, -1):
        c, wt = cs[lvl], ws[lvl]
        up = np.dstack([
            np.asarray(Image.fromarray(val[..., ch].astype(np.float32), mode="F").resize(
                (c.shape[1], c.shape[0]), Image.Resampling.BILINEAR))
            for ch in range(val.shape[2])
        ])
        wcl = np.clip(wt, 0, 1)[..., None]
        norm = np.where(wt[..., None] > 0, c / np.maximum(wt, 1e-6)[..., None], 0)
        val = norm * wcl + up * (1 - wcl)
    out = np.where(known[..., None], rgb, val)
    # relax: iterative neighbour averaging inside the hole
    hole = ~known
    for _ in range(jacobi):
        p = np.pad(out, ((1, 1), (1, 1), (0, 0)), mode="edge")
        avg = (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) / 4.0
        out[hole] = avg[hole]
    # light blur restricted to the hole
    blurred = box3(box3(out))
    out[hole] = blurred[hole]
    return out


# ---------------------------------------------------------------- masks


def rule_mask(small: np.ndarray, names: list[str], shape: dict) -> np.ndarray:
    r, g, b = small[..., 0], small[..., 1], small[..., 2]
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    m = np.zeros(luma.shape, dtype=bool)
    for n in names:
        if n == "dark":
            m |= luma < shape.get("thr", 72)
        elif n == "light":
            m |= luma > shape.get("lthr", 180)
        elif n == "water":
            m |= ((g - r) > shape.get("wthr", 35)) & (b > 190)
        elif n == "foliage":
            m |= ((b - r) < shape.get("brthr", 40)) & (luma < shape.get("fthr", 200))
        elif n == "sky":
            m |= ((b - r) > shape.get("skythr", 80)) & (luma > shape.get("skyluma", 110))
        elif n == "green":
            m |= ((g - b) > shape.get("gthr", 10)) & ((g - r) > shape.get("grthr", 0))
        else:
            raise ValueError(f"unknown rule {n}")
    return m


def build_mask_groups(layer: dict, small: np.ndarray) -> dict[int, np.ndarray]:
    """Build a layer's mask, split by each add shape's shiftY (world px, 0 when absent).

    A sub shape removes from every group. grow connects through the union of all groups.
    """
    h, w = small.shape[:2]
    groups: dict[int, np.ndarray] = {0: np.zeros((h, w), dtype=bool)}

    def union() -> np.ndarray:
        u = np.zeros((h, w), dtype=bool)
        for g in groups.values():
            u |= g
        return u

    for shape in layer.get("shapes", []):
        pm = poly_mask(shape["poly"], w, h, WORK)
        if shape["op"] == "sub":
            rule = shape.get("rule")
            if rule:
                pm &= rule_mask(small, rule, shape)
            for k in groups:
                groups[k] &= ~pm
            continue
        shift = int(shape.get("shiftY", 0))
        if shift not in groups:
            groups[shift] = np.zeros((h, w), dtype=bool)
        rule = shape.get("rule")
        if not rule:
            groups[shift] |= pm
            continue
        rm = rule_mask(small, rule, shape) & pm
        if shape.get("close"):
            c = int(shape["close"])
            rm = shift_and(shift_or(rm, c), c) & pm | rm
        if shape.get("grow"):
            seeds = [(int(x * WORK), int(y * WORK)) for x, y in shape.get("seeds", [])]
            grown = flood_from(rm | union(), seeds)
            rm = grown & pm
        if shape.get("fillHoles"):
            rm = fill_holes(rm) & pm
        if shape.get("dilate"):
            rm = shift_or(rm, int(shape["dilate"])) & pm
        groups[shift] |= rm
    for k in list(groups):
        m = groups[k]
        if layer.get("fillHoles"):
            m = fill_holes(m)
        # close pin holes (dilate then erode by 1)
        groups[k] = shift_and(shift_or(m, 1), 1) | m
    return groups


def build_mask(layer: dict, small: np.ndarray) -> np.ndarray:
    """The whole layer mask at its painted position (all shiftY groups unshifted)."""
    out = None
    for m in build_mask_groups(layer, small).values():
        out = m.copy() if out is None else out | m
    return out


# ---------------------------------------------------------------- layers


def pad_layer(rgb: np.ndarray, alpha: np.ndarray, known: np.ndarray, pad: int):
    """Edge-clamp rows/columns outward, colour blended into the diffusion fill."""
    h, w = alpha.shape
    rgb_c = np.pad(rgb, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    alpha_c = np.pad(alpha, ((pad, pad), (pad, pad)), mode="edge")
    known_p = np.pad(known, ((pad, pad), (pad, pad)), mode="constant", constant_values=False)
    # diffuse the pad from the full (already filled) layer
    diff = diffuse_fill(np.pad(rgb, ((pad, pad), (pad, pad), (0, 0)), mode="edge"),
                        np.pad(np.ones_like(alpha), ((pad, pad), (pad, pad)), mode="constant", constant_values=False),
                        jacobi=120)
    yy, xx = np.mgrid[0 : h + 2 * pad, 0 : w + 2 * pad]
    dx = np.maximum(np.maximum(pad - xx, xx - (w + pad - 1)), 0)
    dy = np.maximum(np.maximum(pad - yy, yy - (h + pad - 1)), 0)
    d = np.maximum(dx, dy).astype(np.float32)
    t = np.clip(d / max(pad, 1), 0, 1)[..., None]
    out = rgb_c * (1 - t) + diff * t
    return out, alpha_c, known_p


def quantize_all(layers: list[dict], colors: int) -> list[int]:
    samples = []
    for L in layers:
        px = L["rgb"][L["alpha"]]
        if len(px) > 60000:
            idx = np.linspace(0, len(px) - 1, 60000).astype(int)
            px = px[idx]
        samples.append(px)
    allpx = np.concatenate(samples, 0)
    side = int(math.ceil(math.sqrt(len(allpx))))
    buf = np.zeros((side * side, 3), dtype=np.uint8)
    buf[: len(allpx)] = np.clip(allpx, 0, 255).astype(np.uint8)
    buf[len(allpx) :] = buf[0]
    pal_img = Image.fromarray(buf.reshape(side, side, 3)).quantize(
        colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    palette = pal_img.getpalette()[: colors * 3]
    for L in layers:
        img = Image.fromarray(np.clip(L["rgb"], 0, 255).astype(np.uint8))
        q = img.quantize(palette=pal_img, dither=Image.Dither.NONE)
        idx = np.asarray(q).copy()
        L["index"] = idx
    return palette


def encode_png(L: dict, palette: list[int], colors: int) -> bytes:
    idx = L["index"].copy()
    transparent = colors
    if not L["opaque"]:
        idx[~L["alpha"]] = transparent
    img = Image.fromarray(idx.astype(np.uint8), mode="P")
    img.putpalette(palette + [0, 0, 0])
    buf = io.BytesIO()
    if L["opaque"]:
        img.save(buf, format="PNG", optimize=True)
    else:
        img.save(buf, format="PNG", optimize=True, transparency=transparent)
    return buf.getvalue()


def rgba_of(L: dict, palette: list[int]) -> Image.Image:
    pal = np.array(palette, dtype=np.uint8).reshape(-1, 3)
    rgb = pal[L["index"]]
    a = (L["alpha"] * 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, a]), mode="RGBA")


# ---------------------------------------------------------------- main


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python tools/stagecut/cut_stage.py <stageId>", file=sys.stderr)
        sys.exit(2)
    stage_id = sys.argv[1]
    art = ROOT / "art" / "stages" / stage_id
    out_layers = art / "layers"
    ts_dir = ROOT / "src" / "stages" / stage_id
    prefix = stage_id.upper()

    spec = json.loads((art / "masks.json").read_text())
    src = load_rgb(art / spec["source"])
    SH, SW = src.shape[:2]
    small = resize_rgb(src, int(SW * WORK), int(SH * WORK))
    # contract 3: the painting's full width is worldWidth world px
    stage_scale = spec["worldWidth"] / SW
    back_scale = spec.get("backScale", 1.0)
    pad = spec["pad"]
    ox, oy = spec["collision"]["origin"]
    if "anchorWorld" in spec:
        ax_world, ay_world = spec["anchorWorld"]
    else:
        # the back layers line up with the stage when the camera sits on the painting centre
        ax_world = round((SW / 2 - ox) * stage_scale)
        ay_world = round((SH / 2 - oy) * stage_scale)
    print(f"{stage_id}: {SW}x{SH}, scale {stage_scale:.5f}, anchorWorld ({ax_world}, {ay_world})")

    names = [L["name"] for L in spec["layers"]]
    print("building masks", names)
    masks = {}
    shifted: dict[int, np.ndarray] = {}  # stage-layer pieces moved down by shiftY world px
    for L in spec["layers"]:
        if L.get("opaque"):
            masks[L["name"]] = np.ones(small.shape[:2], dtype=bool)
        elif L["name"] == "stage":
            groups = build_mask_groups(L, small)
            # masks["stage"] keeps every piece at its painted position: the pixels a
            # shifted piece leaves behind stay unknown to the back layers, which fill
            # them by diffusion instead of showing a second copy of the piece
            masks["stage"] = np.zeros(small.shape[:2], dtype=bool)
            for m in groups.values():
                masks["stage"] |= m
            shifted = {k: m for k, m in groups.items() if k != 0}
            stage_base = groups[0]
        else:
            masks[L["name"]] = build_mask(L, small)

    # ownership: a layer owns its mask minus every layer in front of it
    front_union = np.zeros(small.shape[:2], dtype=bool)
    owned = {}
    for L in reversed(spec["layers"]):
        n = L["name"]
        owned[n] = masks[n] & ~front_union
        front_union |= masks[n]

    # preview of the ownership map
    colors_prev = {"sky": (40, 40, 80), "far": (60, 160, 255), "mid": (80, 220, 120), "stage": (255, 120, 60)}
    prev = (small * 0.45).astype(np.float32)
    for n in names:
        c = np.array(colors_prev.get(n, (255, 255, 255)), dtype=np.float32)
        m = owned[n]
        if n == "stage" and shifted:
            # pieces at their shifted place; the place they left is shown dark
            vac = m & ~stage_base
            prev[vac] = prev[vac] * 0.3
            m = stage_base.copy()
            for sy, sm in shifted.items():
                m |= shift_rows(sm, int(round(sy / stage_scale * WORK)))
        prev[m] = prev[m] * 0.55 + c * 0.45
    Image.fromarray(np.clip(prev, 0, 255).astype(np.uint8)).save(art / "masks_preview.png")

    built = []
    for L in spec["layers"]:
        n = L["name"]
        k = stage_scale * (1.0 if n == "stage" else back_scale)
        w, h = int(round(SW * k)), int(round(SH * k))
        rgb = resize_rgb(src, w, h)
        alpha = resize_mask(masks[n], w, h) >= 0.5
        # known = strictly owned pixels; one-pixel guard so front colours never bleed in
        known = (resize_mask(owned[n], w, h) >= 0.999) & alpha
        known = known & ~shift_or(~(resize_mask(owned[n], w, h) >= 0.5), 1)
        if L.get("opaque"):
            alpha[:] = True
        hole = alpha & ~known
        print(f"  {n}: {w}x{h} scale {k:.4f}, hole {hole.sum()} px of {alpha.sum()}")
        # fill colour everywhere from the known pixels (also outside alpha, which
        # keeps the pad smooth); only alpha decides what is drawn
        rgb = diffuse_fill(rgb, known)
        if n == "stage" and shifted:
            # stage layer px == world px, so shiftY moves whole rows. A shifted piece
            # goes behind the unshifted stage (a waterfall under a lowered disc ends
            # where it did, at the main platform), and leaves transparency behind.
            base_a = resize_mask(stage_base, w, h) >= 0.5
            out_rgb = rgb.copy()
            out_a = base_a.copy()
            for sy, sm in sorted(shifted.items()):
                a_s = shift_rows(resize_mask(sm, w, h) >= 0.5, sy)
                rgb_s = np.zeros_like(rgb)
                rgb_s[sy:] = rgb[: h - sy] if sy > 0 else rgb
                put = a_s & ~out_a
                out_rgb[put] = rgb_s[put]
                out_a |= a_s
            # colour outside alpha only feeds the pad; refill it from the drawn pixels
            rgb = diffuse_fill(out_rgb, out_a)
            alpha = out_a
            known = out_a
        rgb, alpha, known = pad_layer(rgb, alpha, known, pad)
        # anchor: which layer pixel sits on anchorWorld when the camera is there
        if n == "stage":
            anchor_world = (0.0, 0.0)
            anchor = (ox * k + pad, oy * k + pad)
        else:
            anchor_world = (float(ax_world), float(ay_world))
            srcx = ox + ax_world / stage_scale
            srcy = oy + ay_world / stage_scale
            anchor = (srcx * k + pad, srcy * k + pad)
        # whole layer pixels, so the painting sits on the world pixel grid
        anchor = (float(round(anchor[0])), float(round(anchor[1])))
        built.append({
            "name": n, "parallax": L["parallax"], "opaque": bool(L.get("opaque")),
            "rgb": rgb, "alpha": alpha, "anchor": anchor, "anchorWorld": anchor_world,
            "w": rgb.shape[1], "h": rgb.shape[0],
        })

    colors = spec["paletteColors"]
    palette = quantize_all(built, colors)

    out_layers.mkdir(parents=True, exist_ok=True)
    entries = []
    for L in built:
        data = encode_png(L, palette, colors)
        (out_layers / f"{L['name']}.png").write_bytes(data)
        a = L["alpha"]
        clamp = [bool(a[:, 0].any()), bool(a[0, :].any()), bool(a[:, -1].any()), bool(a[-1, :].any())]
        entries.append((L, data, clamp))
        print(f"  wrote {L['name']}.png {L['w']}x{L['h']} {len(data)} bytes clamp={clamp}")
        # debug view of the cut over magenta (not shipped)
        im = rgba_of(L, palette)
        bg = Image.new("RGBA", im.size, (255, 0, 255, 255))
        bg.alpha_composite(im)
        bg.convert("RGB").save(art / f"view_{L['name']}.png")

    # ------------------------------------------------ geometry
    plats = []
    for p in spec["collision"]["platforms"]:
        x0 = (p["x0"] - ox) * stage_scale
        x1 = (p["x1"] - ox) * stage_scale
        y = (p["y"] - oy) * stage_scale + p.get("shiftY", 0)
        plats.append({"name": p["name"], "x": round(x0), "y": round(y), "w": round(x1) - round(x0), "h": p["h"],
                      "solid": p["solid"], "ledges": p["ledges"]})

    # camera bounds = the painting's world rect, exactly as the stage layer draws it
    stage = next(L for L in built if L["name"] == "stage")
    bounds = {
        "x": int(pad - stage["anchor"][0]),
        "y": int(pad - stage["anchor"][1]),
        "w": int(stage["w"] - 2 * pad),
        "h": int(stage["h"] - 2 * pad),
    }
    bl, bt, br, bb = spec.get("blastPad", [48, 48, 48, 96])
    blast = {"x": bounds["x"] - bl, "y": bounds["y"] - bt, "w": bounds["w"] + bl + br, "h": bounds["h"] + bt + bb}

    # ------------------------------------------------ composite + collision check
    stage_img = rgba_of(stage, palette)
    bgc = Image.new("RGBA", stage_img.size, (20, 20, 40, 255))
    # show the back layers at reference camera (camera on anchorWorld) under the stage
    for L in built:
        if L["name"] == "stage":
            continue
        im = rgba_of(L, palette)
        # stage-layer pixel of the anchor world point
        sx = stage["anchor"][0] + L["anchorWorld"][0]
        sy = stage["anchor"][1] + L["anchorWorld"][1]
        off = (int(round(sx - L["anchor"][0])), int(round(sy - L["anchor"][1])))
        layer_canvas = Image.new("RGBA", stage_img.size, (0, 0, 0, 0))
        layer_canvas.paste(im, off)
        bgc = Image.alpha_composite(bgc, layer_canvas)
    composite = Image.alpha_composite(bgc, stage_img)
    composite.convert("RGB").save(art / "composite_reference.png")

    check = Image.alpha_composite(Image.new("RGBA", stage_img.size, (40, 40, 60, 255)), stage_img)
    d = ImageDraw.Draw(check)
    for p in plats:
        x = p["x"] + stage["anchor"][0]
        y = p["y"] + stage["anchor"][1]
        d.line([(x, y), (x + p["w"] - 1, y)], fill=(255, 0, 0, 255), width=1)
        d.line([(x, y - 3), (x, y + 3)], fill=(255, 0, 0, 255))
        d.line([(x + p["w"] - 1, y - 3), (x + p["w"] - 1, y + 3)], fill=(255, 0, 0, 255))
    check = check.convert("RGB")
    check.resize((check.width * 2, check.height * 2), Image.Resampling.NEAREST).save(art / "collision_check.png")

    # ------------------------------------------------ TypeScript
    ts_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        f"// GENERATED by tools/stagecut/cut_stage.py {stage_id} from art/stages/{stage_id}/source.png",
        f"// and art/stages/{stage_id}/masks.json. Do not edit by hand; rerun the script.",
        "import type { StageLayerData } from '../layers';",
        "",
        f"export const {prefix}_LAYERS: readonly StageLayerData[] = [",
    ]
    for L, data, clamp in entries:
        b64 = base64.b64encode(data).decode("ascii")
        lines += [
            "  {",
            f"    name: '{L['name']}',",
            f"    parallax: {L['parallax']},",
            f"    width: {L['w']},",
            f"    height: {L['h']},",
            f"    anchorX: {L['anchor'][0]:.3f},",
            f"    anchorY: {L['anchor'][1]:.3f},",
            f"    anchorWorldX: {L['anchorWorld'][0]},",
            f"    anchorWorldY: {L['anchorWorld'][1]},",
            f"    clamp: [{', '.join('true' if c else 'false' for c in clamp)}],",
            f"    src: 'data:image/png;base64,{b64}',",
            "  },",
        ]
    lines += ["];", ""]
    (ts_dir / "layers.ts").write_text("\n".join(lines), encoding="utf-8")

    def rect(r: dict) -> str:
        return f"{{ x: {r['x']}, y: {r['y']}, w: {r['w']}, h: {r['h']} }}"

    g = [
        f"// GENERATED by tools/stagecut/cut_stage.py {stage_id} from art/stages/{stage_id}/masks.json.",
        "// Collision lines measured on the painting, in world pixels. Rerun the script to change.",
        f"// Painting {SW}x{SH} scaled by {stage_scale:.5f} (worldWidth {spec['worldWidth']}); the main walk line",
        f"// measured at painting ({ox}, {oy}) is world (0, 0).",
        "import type { Platform, Rect } from '../../core/types';",
        "",
        f"export const {prefix}_PLATFORMS: readonly Platform[] = [",
    ]
    for p in plats:
        g.append(
            f"  {{ x: {p['x']}, y: {p['y']}, w: {p['w']}, h: {p['h']}, solid: {str(p['solid']).lower()}, "
            f"ledgeLeft: {str(p['ledges']).lower()}, ledgeRight: {str(p['ledges']).lower()} }}, // {p['name']}"
        )
    g += [
        "];",
        "",
        "/** The painting's world rect. */",
        f"export const {prefix}_CAMERA_BOUNDS: Rect = {rect(bounds)};",
        "",
        f"/** Camera bounds grown by {bl} left, {bt} top, {br} right, {bb} bottom. */",
        f"export const {prefix}_BLAST: Rect = {rect(blast)};",
        "",
    ]
    (ts_dir / "geometry.ts").write_text("\n".join(g), encoding="utf-8")
    print("platforms", json.dumps(plats))
    print("cameraBounds", json.dumps(bounds))
    print("blast", json.dumps(blast))


if __name__ == "__main__":
    main()
