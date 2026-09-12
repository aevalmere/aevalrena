"""Turn a reference crop into true pixel art.

The reference sheets are painterly imitations of pixel art: soft edges, tens of
thousands of colours, no consistent pixel grid. Recovering a grid is hopeless,
so instead we resolve the design down to a real one. The order matters:

  1. key the background to a soft alpha and un-mix it out of the edge colours,
     otherwise every downsampled edge pixel is contaminated with background
  2. fill interior holes, because the coat sits at the same value as the sheet
     background and keying punches holes straight through the torso
  3. area-average down to the target height on premultiplied colour
  4. snap to the locked palette and harden the alpha
  5. clean up: drop orphan pixels and close single-pixel gaps

Everything returns a plain RGBA Image at native sprite resolution.
"""
from PIL import Image

from palette import family, snap


def load(path):
    return Image.open(path).convert("RGBA")


def keyed(src, bg=None, lo=18, hi=54, alpha_lo=0.30, alpha_hi=0.80, box=None):
    """RGBA with the sheet background resolved to alpha and un-mixed from colour.

    Sheets that ship a real alpha channel use it. Flat-background sheets get a
    soft alpha from colour distance, then the background is algebraically
    removed: observed = a*true + (1-a)*bg, so true = (observed - (1-a)*bg)/a.
    """
    im = src if isinstance(src, Image.Image) else load(src)
    if box is not None:
        im = im.crop(box)
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    # A sheet only counts as pre-keyed if its alpha channel actually carries
    # holes. An RGB sheet promoted to RGBA is opaque everywhere, which would
    # otherwise sail through as "already keyed" and key nothing at all.
    achan = list(im.getchannel("A").getdata())
    n = len(achan)
    clear = sum(1 for v in achan if v <= 8)
    solid = sum(1 for v in achan if v >= 128)
    has_alpha = clear > n * 0.05 and solid > n * 0.02

    out = Image.new("RGBA", (w, h))
    op = out.load()
    if has_alpha:
        span = alpha_hi - alpha_lo
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                t = (a / 255.0 - alpha_lo) / span
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                op[x, y] = (r, g, b, int(t * 255 + 0.5))
        return out

    if bg is None:
        bg = px[1, 1][:3]
    br, bgc, bb = bg
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            d = abs(r - br) + abs(g - bgc) + abs(b - bb)
            if d <= lo:
                op[x, y] = (0, 0, 0, 0)
                continue
            a = 1.0 if d >= hi else (d - lo) / (hi - lo)
            if a > 0.999:
                op[x, y] = (r, g, b, 255)
            else:
                ur = (r - (1 - a) * br) / a
                ug = (g - (1 - a) * bgc) / a
                ub = (b - (1 - a) * bb) / a
                op[x, y] = (
                    min(255, max(0, int(ur + 0.5))),
                    min(255, max(0, int(ug + 0.5))),
                    min(255, max(0, int(ub + 0.5))),
                    int(a * 255 + 0.5),
                )
    return out


def fill_holes(im, thresh=8):
    """Make transparent regions that never touch the border opaque.

    The coat sits at the same value as the sheet background, so keying drills
    holes through the torso. Anything enclosed by the silhouette belongs to the
    character by definition, so it takes the mean of its opaque neighbours.
    """
    # Pad with a transparent ring so a crop whose edge cuts through opaque
    # content cannot block the flood and swallow the whole image.
    src = im
    pad = 2
    im = Image.new("RGBA", (src.size[0] + pad * 2, src.size[1] + pad * 2), (0, 0, 0, 0))
    im.paste(src, (pad, pad))
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    stack = []

    def push(x, y):
        if px[x, y][3] < thresh and not seen[y * w + x]:
            seen[y * w + x] = 1
            stack.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                push(nx, ny)

    for y in range(h):
        for x in range(w):
            if px[x, y][3] >= thresh or seen[y * w + x]:
                continue
            acc = [0, 0, 0, 0]
            for dx in (-2, -1, 0, 1, 2):
                for dy in (-2, -1, 0, 1, 2):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h:
                        c = px[nx, ny]
                        if c[3] >= thresh:
                            acc[0] += c[0]
                            acc[1] += c[1]
                            acc[2] += c[2]
                            acc[3] += 1
            if acc[3] == 0:
                px[x, y] = (0, 0, 0, 255)
            else:
                n = acc[3]
                px[x, y] = (acc[0] // n, acc[1] // n, acc[2] // n, 255)
    return im.crop((pad, pad, pad + src.size[0], pad + src.size[1]))


def tight(im, thresh=24):
    """Bounding box of everything at least `thresh` opaque, or None if empty."""
    w, h = im.size
    px = im.load()
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if px[x, y][3] >= thresh:
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                if y < y0:
                    y0 = y
                if y > y1:
                    y1 = y
    if x1 < 0:
        return None
    return (x0, y0, x1 + 1, y1 + 1)


def downsample(im, out_w, out_h, alpha_cut=112, keep_soft=False):
    """Area-average to the target size on premultiplied colour, then harden."""
    w, h = im.size
    px = im.load()
    pre = Image.new("RGBA", (w, h))
    pp = pre.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            f = a / 255.0
            pp[x, y] = (int(r * f + 0.5), int(g * f + 0.5), int(b * f + 0.5), a)
    small = pre.resize((max(1, out_w), max(1, out_h)), Image.Resampling.BOX)
    sp = small.load()
    out = Image.new("RGBA", small.size)
    op = out.load()
    for y in range(small.size[1]):
        for x in range(small.size[0]):
            r, g, b, a = sp[x, y]
            if a < alpha_cut:
                op[x, y] = (0, 0, 0, 0)
                continue
            f = 255.0 / a
            c = (
                min(255, int(r * f + 0.5)),
                min(255, int(g * f + 0.5)),
                min(255, int(b * f + 0.5)),
            )
            out_a = a if keep_soft else 255
            op[x, y] = snap(c) + (out_a,)
    return out


def _opaque(px, w, h, x, y):
    return 0 <= x < w and 0 <= y < h and px[x, y][3] > 0


def cleanup(im, min_neighbours=2):
    """Drop orphan pixels and close single-pixel gaps in the silhouette."""
    w, h = im.size
    px = im.load()
    drop = []
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0:
                continue
            n = 0
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                if _opaque(px, w, h, x + dx, y + dy):
                    n += 1
            if n < min_neighbours:
                drop.append((x, y))
    for x, y in drop:
        px[x, y] = (0, 0, 0, 0)

    add = []
    for y in range(h):
        for x in range(w):
            if px[x, y][3] != 0:
                continue
            horiz = _opaque(px, w, h, x - 1, y) and _opaque(px, w, h, x + 1, y)
            vert = _opaque(px, w, h, x, y - 1) and _opaque(px, w, h, x, y + 1)
            if horiz and vert:
                add.append((x, y))
    for x, y in add:
        acc = [0, 0, 0, 0]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            if _opaque(px, w, h, x + dx, y + dy):
                c = px[x + dx, y + dy]
                acc[0] += c[0]
                acc[1] += c[1]
                acc[2] += c[2]
                acc[3] += 1
        n = acc[3]
        px[x, y] = snap((acc[0] // n, acc[1] // n, acc[2] // n)) + (255,)
    return im


def despeckle(im, families=("ink", "coat", "hair", "band", "cloth", "boot", "skin")):
    """Rewrite pixels that are alone in their material.

    The references draw hair clips, strand outlines and rim light in colours
    that survive the downsample as single scattered pixels: maroon confetti
    through the hair, white grit along its top edge. A pixel with no
    eight-neighbour of its own material is noise by definition, and takes the
    material its neighbourhood actually agrees on. Eyes and blush are left out
    of the sweep because at 48 px they are legitimately one or two pixels.
    """
    w, h = im.size
    px = im.load()
    families = set(families)
    fixes = []
    for y in range(h):
        for x in range(w):
            here = px[x, y]
            if here[3] == 0:
                continue
            mine = family(here)
            if mine not in families:
                continue
            alone = True
            tally = {}
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < w and 0 <= ny < h):
                        continue
                    c = px[nx, ny]
                    if c[3] == 0:
                        continue
                    fam = family(c)
                    if fam == mine:
                        alone = False
                        break
                    key = (fam, c[0], c[1], c[2])
                    tally[key] = tally.get(key, 0) + 1
                if not alone:
                    break
            if alone and tally:
                by_family = {}
                for (fam, r, g, b), n in tally.items():
                    by_family.setdefault(fam, []).append((n, (r, g, b)))
                winner = max(by_family.items(), key=lambda kv: sum(n for n, _ in kv[1]))
                colour = max(winner[1])[1]
                fixes.append((x, y, colour + (255,)))
    for x, y, c in fixes:
        px[x, y] = c
    return im


def zoom(im, k, ground=(150, 150, 158)):
    """Nearest-neighbour blow-up on a neutral ground, for eyeballing the art."""
    out = Image.new("RGB", (im.size[0] * k, im.size[1] * k), ground)
    up = im.resize((im.size[0] * k, im.size[1] * k), Image.Resampling.NEAREST)
    out.paste(up, (0, 0), up)
    return out
