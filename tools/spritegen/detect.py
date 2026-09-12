"""Find sprite frame boxes on a reference sheet by labelling its alpha mask.

The reference sheets are pre-keyed (a real alpha channel) or sit on a flat
background. Either way we reduce to a boolean mask, dilate it so a character
and its water effect merge into one blob, label the blobs, and print the boxes
grouped into horizontal bands. Names get assigned by hand afterwards.
"""
import sys
from collections import deque
from PIL import Image

def mask_of(path, alpha_min=128, bg=None, bg_th=26):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    a = im.getchannel("A")
    opaque = sum(1 for v in a.getdata() if v >= alpha_min)
    if opaque > w * h * 0.02:
        m = a.point(lambda v: 255 if v >= alpha_min else 0)
    else:
        if bg is None:
            bg = im.convert("RGB").getpixel((1, 1))
        px = im.convert("RGB").load()
        m = Image.new("L", (w, h), 0)
        mp = m.load()
        for y in range(h):
            for x in range(w):
                c = px[x, y]
                if abs(c[0]-bg[0]) + abs(c[1]-bg[1]) + abs(c[2]-bg[2]) > bg_th:
                    mp[x, y] = 255
    return im, m

def dilate(m, r):
    out = m
    for _ in range(r):
        out = out.filter(__import__("PIL.ImageFilter", fromlist=["MaxFilter"]).MaxFilter(3))
    return out

def components(m, scale=2, min_px=400):
    w, h = m.size
    sm = m.resize((w // scale, h // scale), Image.Resampling.BOX).point(lambda v: 1 if v > 40 else 0)
    W, H = sm.size
    p = sm.load()
    seen = [[False]*W for _ in range(H)]
    out = []
    for y0 in range(H):
        for x0 in range(W):
            if p[x0, y0] == 0 or seen[y0][x0]:
                continue
            q = deque([(x0, y0)]); seen[y0][x0] = True
            minx = maxx = x0; miny = maxy = y0; n = 0
            while q:
                x, y = q.popleft(); n += 1
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
                for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                    nx, ny = x+dx, y+dy
                    if 0 <= nx < W and 0 <= ny < H and not seen[ny][nx] and p[nx, ny]:
                        seen[ny][nx] = True; q.append((nx, ny))
            if n * scale * scale >= min_px:
                out.append((minx*scale, miny*scale, (maxx+1)*scale, (maxy+1)*scale, n*scale*scale))
    return out

def band(boxes, tol=28):
    boxes = sorted(boxes, key=lambda b: b[1])
    bands = []
    for b in boxes:
        for row in bands:
            if abs(row[0][1] - b[1]) <= tol or (b[1] < row[0][3] and b[3] > row[0][1]):
                row.append(b); break
        else:
            bands.append([b])
    for row in bands:
        row.sort(key=lambda b: b[0])
    bands.sort(key=lambda r: r[0][1])
    return bands

if __name__ == "__main__":
    path = sys.argv[1]
    r = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    im, m = mask_of(path)
    boxes = components(dilate(m, r))
    for i, row in enumerate(band(boxes)):
        print(f"band {i}: y~{row[0][1]}")
        for b in row:
            print(f"   ({b[0]},{b[1]},{b[2]},{b[3]}) {b[2]-b[0]}x{b[3]-b[1]} px={b[4]}")

def region_boxes(path, region, r=4, min_px=300, max_text_h=24, min_text_w=28):
    """Boxes inside `region`, text labels dropped, sorted left to right."""
    im, m = mask_of(path)
    x0, y0, x1, y1 = region
    sub = Image.new("L", m.size, 0)
    sub.paste(m.crop(region), (x0, y0))
    boxes = components(dilate(sub, r), min_px=min_px)
    keep = []
    for b in boxes:
        w, h = b[2]-b[0], b[3]-b[1]
        if h <= max_text_h and w >= min_text_w:
            continue
        keep.append(b)
    keep.sort(key=lambda b: (b[0]))
    return keep
