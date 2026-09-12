"""Reads the hand-authored text canvases, adds a strict 1px outline, writes TS.

The canvases hold fill pixels only (plus deliberate internal 'o' separators).
The outline pass writes 'o' into transparent cells that are 4-adjacent to a
non-outline pixel, exactly once, so the ring is 1px everywhere and can never
double. Anything already drawn is left alone.
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 32, 40
NAMES = ('base_front', 'base_side', 'base_air')
FILES = {'base_front': 'canvas_front.txt',
         'base_side': 'canvas_side.txt',
         'base_air': 'canvas_air.txt'}
KEYS = set('ohHDbBspecCwtgaA')


def load(path):
    rows = [ln.rstrip('\n') for ln in open(path, encoding='utf-8')]
    rows = [r for r in rows if r.strip() != '' or True][:H]
    bad = []
    if len(rows) != H:
        bad.append('%s: %d rows (want %d)' % (path, len(rows), H))
    for i, r in enumerate(rows):
        if len(r) != W:
            bad.append('%s row %d: %d chars (want %d) %r' % (path, i, len(r), W, r))
        for c in set(r) - {'.'}:
            if c not in KEYS:
                bad.append('%s row %d: bad key %r' % (path, i, c))
    for b in bad:
        print('CANVAS', b)
    if bad:
        sys.exit(1)
    return [list(r) for r in rows]


def outline(g):
    add = []
    for y in range(H):
        for x in range(W):
            if g[y][x] != '.':
                continue
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and g[ny][nx] not in ('.', 'o'):
                    add.append((y, x))
                    break
    for y, x in add:
        g[y][x] = 'o'
    return g


def check(name, rows):
    """Report anything that will read badly, per the sprite skill's rules."""
    # 1px outline: no drawn pixel may have an 'o' run wider than 1 outside it
    for y, r in enumerate(rows):
        run = 0
        for x, c in enumerate(r):
            run = run + 1 if c == 'o' else 0
            if run > 2:
                # a 3+ run of 'o' is fine along a horizontal edge; only flag
                # vertical doubling, checked below
                pass
    for x in range(W):
        col = [rows[y][x] for y in range(H)]
        for y in range(1, H - 1):
            if col[y] == 'o' and col[y - 1] == 'o' and col[y + 1] == 'o':
                left = rows[y][x - 1] if x else '.'
                right = rows[y][x + 1] if x < W - 1 else '.'
                if left not in ('.', 'o') and right not in ('.', 'o'):
                    print('CHECK %s: 1px-wide gap filled by outline at col %d row %d'
                          % (name, x, y))
    # nothing below row 39, feet on 39 for grounded poses
    last = max(y for y in range(H) if set(rows[y]) != {'.'})
    print('  %-11s last drawn row %d, widest span %d' %
          (name, last,
           max((len(r.rstrip('.')) - (len(r) - len(r.lstrip('.'))))
               for r in rows)))


frames = []
for n in NAMES:
    g = load(os.path.join(HERE, FILES[n]))
    g = outline(g)
    rows = [''.join(r) for r in g]
    assert len(rows) == H and all(len(r) == W for r in rows)
    check(n, rows)
    frames.append((n, rows))

out = os.path.join(HERE, 'base_frames.ts')
with open(out, 'w', encoding='utf-8') as f:
    f.write("// Canonical base poses for Aeval. 32 wide by 40 tall, feet on the last row.\n")
    f.write("// Every char is a palette key, '.' is transparent. All frames face right.\n\n")
    f.write("export const BASE_FRAMES: Record<string, string[]> = {\n")
    for name, rows in frames:
        f.write("  %s: [\n" % name)
        for r in rows:
            f.write("    '%s',\n" % r)
        f.write("  ],\n")
    f.write("};\n")
print('wrote', out)
