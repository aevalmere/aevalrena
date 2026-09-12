"""Render Aeval PixelSheet frames to a PNG so you can SEE what you drew.

Usage:
  python preview.py <file.ts> <EXPORT_NAME> <out.png> [frame1 frame2 ...]

With no frame list it renders every frame in the file, 8 per row, labelled by
index order. Transparent pixels show as dark slate. Any character that is not in
the palette renders as magenta, so palette typos are loud.
"""
import re, sys, os
from PIL import Image, ImageDraw

def parse(path, var):
    src = open(path, encoding='utf-8').read()
    src = src[src.index(var):]
    return {m.group(1): re.findall(r"['\"]([^'\"]*)['\"]", m.group(2))
            for m in re.finditer(r"^  ([A-Za-z0-9_]+):\s*\[(.*?)^  \]", src, re.S | re.M)}

def palette(path):
    return dict(re.findall(r"(\w):\s*'(#[0-9a-fA-F]{6})'", open(path, encoding='utf-8').read()))

def main():
    src, var, out = sys.argv[1], sys.argv[2], sys.argv[3]
    order = sys.argv[4:]
    frames = parse(src, var)
    pal = palette(os.path.join(os.path.dirname(src) or '.', 'palette.ts'))
    if not order:
        order = list(frames)
    S, COLS = 6, 8
    W = max(len(f[0]) for f in frames.values() if f)
    H = max(len(f) for f in frames.values() if f)
    rows = (len(order) + COLS - 1) // COLS
    img = Image.new('RGB', (COLS * (W + 3) * S, rows * (H + 12) * S), (34, 36, 44))
    px = img.load()
    d = ImageDraw.Draw(img)
    bad = []
    for i, name in enumerate(order):
        f = frames.get(name)
        ox, oy = (i % COLS) * (W + 3) * S, (i // COLS) * (H + 12) * S
        d.text((ox + 2, oy + (H + 2) * S), name, fill=(180, 190, 210))
        if not f:
            bad.append(f'{name}: MISSING')
            continue
        if len(f) != 40 or any(len(r) != 32 for r in f):
            bad.append(f'{name}: {len(f)} rows, widths {sorted(set(len(r) for r in f))} (want 40x32)')
        # ground line so you can check feet sit on the bottom row
        d.rectangle([ox, oy + (H - 1) * S, ox + W * S, oy + H * S], fill=(70, 60, 60))
        for y, row in enumerate(f):
            for x, ch in enumerate(row):
                if ch == '.':
                    continue
                c = pal.get(ch)
                if c is None:
                    c = '#ff00ff'
                    bad.append(f'{name}: char {ch!r} not in palette')
                rgb = tuple(int(c[j:j + 2], 16) for j in (1, 3, 5))
                for dy in range(S):
                    for dx in range(S):
                        px[ox + x * S + dx, oy + y * S + dy] = rgb
    img.save(out)
    for b in sorted(set(bad)):
        print('PROBLEM', b)
    print(f'rendered {len(order)} frames -> {out}')

main()
