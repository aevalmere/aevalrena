"""Generate Aeval FX frames -> src/characters/aeval/art/fx.ts

Effect palette keys only: a (#7fb2ff water), A (#c8e8ff water bright),
w (#d6d8de foam), o (#0e0f17 outline). No body colours.
"""
import math, random

OUT = r"C:\Users\light_095j4re\Documents\aevalrena\src\characters\aeval\art\fx.ts"

RANK = {'.': 0, 'a': 1, 'A': 2, 'w': 3}


class G:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.g = [['.'] * w for _ in range(h)]

    def put(self, x, y, c, force=True):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.w and 0 <= y < self.h:
            if force or RANK[c] > RANK[self.g[y][x]]:
                self.g[y][x] = c

    def get(self, x, y):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.w and 0 <= y < self.h:
            return self.g[y][x]
        return '.'

    def empty(self, x, y):
        return self.get(x, y) == '.'

    def droplet(self, x, y, size=1):
        """Teardrop fleck. Only lands where there is empty space."""
        x, y = int(round(x)), int(round(y))
        if size <= 0:
            if self.empty(x, y):
                self.put(x, y, 'A')
            return
        if size == 1:
            cells = [(0, 0, 'A'), (0, -1, 'a')]
        elif size == 2:
            cells = [(0, 0, 'A'), (0, -1, 'a'), (-1, 0, 'a'), (1, 0, 'a'), (0, 1, 'a')]
        else:
            cells = [(0, 0, 'w'), (0, -1, 'A'), (-1, 0, 'A'), (1, 0, 'A'),
                     (0, 1, 'A'), (0, -2, 'a'), (-1, -1, 'a'), (1, -1, 'a'),
                     (-1, 1, 'a'), (1, 1, 'a'), (0, 2, 'a')]
        for dx, dy, c in cells:
            if self.empty(x + dx, y + dy):
                self.put(x + dx, y + dy, c)

    def rows(self):
        return [''.join(r) for r in self.g]


def scatter(g, spots):
    for (x, y, s) in spots:
        g.droplet(x, y, s)


# ---------------------------------------------------------------- orb 12x12
# Frame 0 is the small end of the pulse. A radius-4.5 disc has to be placed by
# hand at this size; rasterising it from the circle formula gives a rounded box.
ORB0 = [
    '............',
    '....aaaa....',
    '...aAAAAa...',
    '..aAwwAAAa..',
    '.aAwAAAAAAa.',
    '.aAAAAAAAAa.',
    '.aAAAAAAAAa.',
    '.aAAAAAAAAa.',
    '..aAAAAAAa..',
    '...aAAAAa...',
    '....aaaa....',
    '............',
]


def orb(phase):
    """Floating water orb. 0 compact, 1 swollen peak, 2 relaxing and shedding."""
    if phase == 0:
        g = G(12, 12)
        for y, row in enumerate(ORB0):
            for x, ch in enumerate(row):
                if ch != '.':
                    g.put(x, y, ch)
        scatter(g, [(11, 4, 0), (0, 8, 0)])
        return g.rows()
    g = G(12, 12)
    cx, cy = 5.5, 5.5
    rad = [4.4, 5.4, 4.8][phase]
    squash = [1.0, 0.96, 1.06][phase]
    for y in range(12):
        for x in range(12):
            dx = (x - cx) / (rad * squash)
            dy = (y - cy) / rad
            r = math.hypot(dx, dy)
            if r <= 1.0:
                g.put(x, y, 'a' if r > 0.72 else 'A')
    gx, gy = [(-1.6, -1.6), (1.0, -1.8), (-1.0, 1.6)][phase]
    for dx, dy in ((0, 0), (1, 0), (2, 0), (0, 1)):
        if g.get(cx + gx + dx, cy + gy + dy) == 'A':
            g.put(cx + gx + dx, cy + gy + dy, 'w')
    specks = [
        [],
        [(0, 1, 0), (11, 4, 0), (2, 11, 0)],
        [(1, 1, 0), (10, 2, 0), (1, 9, 1), (10, 9, 0), (6, 11, 0)],
    ][phase]
    scatter(g, specks)
    return g.rows()


# ------------------------------------------------------------ crescent 36x20
def crescent(phase):
    """Forward-flying crescent wave. Convex leading edge points right."""
    g = G(36, 20)
    cx, cy = 9.0, 9.5
    ax, ay, wmax = [(21.0, 8.8, 0.38), (24.0, 9.6, 0.46)][phase]
    for y in range(20):
        for x in range(36):
            dx = (x - cx) / ax
            dy = (y - cy) / ay
            r = math.hypot(dx, dy)
            if r < 1e-6 or r > 1.0:
                continue
            cos = dx / r
            if cos < -0.12:
                continue
            band = wmax * (0.22 + 0.78 * math.sqrt(max(0.0, cos)))
            d = (1.0 - r) / band          # 0 at outer rim, 1 at inner rim
            if d > 1.0:
                continue
            if d < 0.34:
                c = 'a'
            elif d < 0.88:
                c = 'A'
            else:
                c = 'w'
            g.put(x, y, c)
    # foam crest flecks riding the leading edge
    for t in range(-8, 9):
        th = t * 0.16
        if abs(t) % 3:
            continue
        x = cx + ax * 0.93 * math.cos(th)
        y = cy + ay * 0.93 * math.sin(th)
        if g.get(x, y) == 'A':
            g.put(x, y, 'w')
    trail = [
        [(6, 1, 1), (2, 4, 0), (4, 16, 1), (1, 13, 0), (14, 0, 0), (13, 19, 0),
         (10, 6, 0), (10, 13, 0)],
        [(3, 2, 1), (0, 6, 0), (5, 17, 1), (1, 11, 0), (11, 1, 0), (9, 18, 0),
         (7, 5, 0), (8, 14, 0), (16, 0, 0), (15, 19, 0)],
    ][phase]
    scatter(g, trail)
    return g.rows()


# ---------------------------------------------------------------- spike tool
def spike(g, x0, hw_base, y_tip, y_base, core='A', edge='a'):
    if y_base <= y_tip:
        return
    span = y_base - y_tip
    for y in range(int(math.floor(y_tip)), int(math.floor(y_base)) + 1):
        t = (y - y_tip) / span
        if t < 0:
            continue
        t = min(1.0, t)
        hw = hw_base * (t ** 0.72)
        lo = int(round(x0 - hw))
        hi = int(round(x0 + hw))
        for x in range(lo, hi + 1):
            inner = (x - lo >= 1) and (hi - x >= 1)
            g.put(x, y, core if inner else edge)


def foam_fan(g, cx, ybase, reach, rows=2):
    """Spiky foam fan at the foot of a water column."""
    for ang, ln in ((18, 1.00), (38, 0.86), (58, 0.70), (76, 0.50)):
        for sgn in (-1, 1):
            a = math.radians(ang)
            L = reach * ln
            for i in range(int(L) + 1):
                t = i / max(1.0, L)
                x = cx + sgn * math.sin(a) * i
                y = ybase - math.cos(a) * i * 0.55
                g.put(x, y, 'a' if t > 0.74 else ('A' if t > 0.42 else 'w'))
    half = int(reach * 0.60)
    for r in range(rows):
        y = ybase - r
        hw = half - r
        for x in range(int(cx - hw), int(cx + hw) + 1):
            g.put(x, y, 'w' if abs(x - cx) < hw - 0.5 else 'a')


# -------------------------------------------------------------- geyser 24x48
GEYSER_SPIKES = [
    (2.0, 1.6, 31, 47),
    (21.5, 1.6, 33, 47),
    (5.0, 2.2, 21, 47),
    (18.5, 2.2, 23, 47),
    (8.0, 2.7, 8, 46),
    (15.5, 2.7, 10, 46),
    (11.8, 3.8, 0, 45),
]


def geyser(phase):
    s = [0.28, 0.66, 1.0][phase]
    g = G(24, 48)
    for (x0, hw, tip_full, ybase) in GEYSER_SPIKES:
        tip = ybase - (ybase - tip_full) * s
        spike(g, x0, hw * (0.72 + 0.28 * s), tip, ybase)
    foam_fan(g, 11.8, 47, 6.5 + 3.5 * s, rows=2)
    top = 45 - 45 * s
    for y in range(int(top) + 2, 46):
        if g.get(11, y) != '.' and g.get(12, y) != '.':
            g.put(11, y, 'A')
            g.put(12, y, 'A')
    # foam highlight streak running up the inside of the main column
    for y in range(int(top) + 3, 44):
        if g.get(11, y) == 'A' and g.get(10, y) != '.' and (y % 5) != 0:
            g.put(11, y, 'w')
    for y in range(int(top) + 9, 44, 3):
        if g.get(13, y) == 'A':
            g.put(13, y, 'w')
    rng = random.Random(7 + phase)
    n = [7, 11, 15][phase]
    ceil = [26, 12, 0][phase]
    for _ in range(n):
        side = rng.choice((-1, 1))
        x = 11.5 + side * rng.uniform(4.5, 11.0)
        y = rng.uniform(ceil, min(47, ceil + 26))
        g.droplet(x, y, rng.choice((0, 1, 1, 2)))
    return g.rows()


# --------------------------------------------------------------- whirl 40x24
# A funnel seen at a low angle, built from nested elliptical bands that shrink
# and sink toward a dark throat low and right of centre. Each band is a thick
# sheet of water with a gap in it; the gaps sit at different angles per band, so
# the eye joins them into one spiral, and the whole set turns between frames.
# (cx, cy, ax, ay, thickness, gap centre offset, gap half width)
WHIRL_BANDS = [
    (19.5, 10.6, 16.0, 8.2, 4.6, 0.00, 0.30),
    (21.0, 13.2, 11.0, 5.6, 3.4, 1.55, 0.40),
    (22.6, 15.2, 6.6, 3.3, 2.4, 3.10, 0.46),
]
WHIRL_THROAT = (23.2, 16.4, 3.6, 2.0)


def whirl(phase):
    g = G(40, 24)
    phi = -phase * 1.10
    for (cx, cy, ax, ay, th, gapoff, gaphw) in WHIRL_BANDS:
        rin = 1.0 - th / ax
        for y in range(24):
            for x in range(40):
                r = math.hypot((x - cx) / ax, (y - cy) / ay)
                if not (rin <= r <= 1.0):
                    continue
                a = math.atan2(y - cy, x - cx)
                d = (a - (phi + gapoff)) % (2 * math.pi)
                if d > math.pi:
                    d -= 2 * math.pi
                if abs(d) < gaphw:
                    continue
                g.put(x, y, 'a')
    # dark throat the water drains into
    tcx, tcy, tax, tay = WHIRL_THROAT
    for y in range(24):
        for x in range(40):
            if math.hypot((x - tcx) / tax, (y - tcy) / tay) <= 1.0:
                g.g[y][x] = '.'
    # light from above catches the upper edge of every sheet
    for y in range(24):
        for x in range(40):
            if g.g[y][x] == 'a' and (y == 0 or g.g[y - 1][x] == '.'):
                g.g[y][x] = 'A'
    # foam along the crest of the outer rim and the lip of the throat
    cx, cy, ax, ay = WHIRL_BANDS[0][:4]
    t = 0.0
    while t < 2 * math.pi:
        if math.sin(t) < -0.5 and g.get(cx + ax * math.cos(t),
                                       cy + ay * math.sin(t)) in ('a', 'A'):
            g.put(cx + ax * math.cos(t), cy + ay * math.sin(t), 'w')
        if math.sin(t) < -0.15:
            x = tcx + (tax + 0.9) * math.cos(t)
            y = tcy + (tay + 0.8) * math.sin(t)
            if g.get(x, y) in ('a', 'A'):
                g.put(x, y, 'w')
        t += 0.04
    # a bright streak on each band where the water runs fastest
    for i, (bcx, bcy, bax, bay, th, gapoff, gaphw) in enumerate(WHIRL_BANDS):
        a0 = phi + gapoff + math.pi
        for k in range(-5, 6):
            a = a0 + k * 0.09
            for j in range(2):
                rr = 1.0 - (j + 0.5) / bax
                x = bcx + bax * rr * math.cos(a)
                y = bcy + bay * rr * math.sin(a)
                if g.get(x, y) == 'a':
                    g.put(x, y, 'A')
    rng = random.Random(31 + phase)
    for _ in range(7):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(1.06, 1.20)
        g.droplet(cx + ax * r * math.cos(a), cy + ay * r * math.sin(a),
                  rng.choice((0, 0, 1)))
    return g.rows()


# -------------------------------------------------------------- splash 16x12
SPLASH_SPIKES = [
    (1.8, 1.3, 7, 11),
    (13.2, 1.3, 7, 11),
    (4.2, 1.8, 3, 11),
    (10.8, 1.8, 4, 11),
    (7.5, 2.4, 0, 11),
]


def splash(phase):
    s = [0.72, 1.0, 0.50][phase]
    spread = [0.88, 1.0, 1.32][phase]
    g = G(16, 12)
    for (x0, hw, tip_full, ybase) in SPLASH_SPIKES:
        x = 7.5 + (x0 - 7.5) * spread
        tip = ybase - (ybase - tip_full) * s
        spike(g, x, hw * (0.8 if phase == 0 else 1.0), tip, ybase)
    # sheet of water joining the spikes at the ground
    sheet = [((11, 3.4), (10, 2.2)),
             ((11, 5.6), (10, 4.2), (9, 2.6)),
             ((11, 7.2), (10, 5.0))][phase]
    for (r, hw) in sheet:
        for x in range(int(round(7.5 - hw)), int(round(7.5 + hw)) + 1):
            d = abs(x - 7.5)
            g.put(x, r, 'A' if d < hw - 0.6 else 'a')
    for x in range(6, 10):
        g.put(x, 11, 'w')
    if phase != 0:
        g.put(7, 10, 'w')
        g.put(8, 10, 'w')
    rng = random.Random(3 + phase)
    n = [3, 6, 9][phase]
    for _ in range(n):
        side = rng.choice((-1, 1))
        x = 7.5 + side * rng.uniform(2.0, 7.5)
        y = rng.uniform(0, [7, 5, 4][phase])
        g.droplet(x, y, rng.choice((0, 0, 1)))
    return g.rows()


# ----------------------------------------------------------- hitspark 12x12
HITSPARK = [
    [
        '............',
        '............',
        '.....a......',
        '.....A......',
        '....AwA.....',
        '..aAwwwAa...',
        '....AwA.....',
        '.....A......',
        '.....a......',
        '............',
        '............',
        '............',
    ],
    [
        '.....a......',
        '..a..A..a...',
        '...A.A.A....',
        '....AwA.....',
        '.aAAwwwAAa..',
        'aAAwwwwwAAa.',
        '.aAAwwwAAa..',
        '....AwA.....',
        '...A.A.A....',
        '..a..A..a...',
        '.....a......',
        '............',
    ],
    [
        '.....a......',
        '.a...a...a..',
        '..A..A..A...',
        '...A.A.A....',
        '...........a',
        'aaAA...AAaa.',
        'a...........',
        '...A.A.A....',
        '..A..A..A...',
        '.a...a...a..',
        '.....a......',
        '............',
    ],
]


def hitspark(phase):
    return list(HITSPARK[phase])


# ----------------------------------------------------------------- dust 12x6
DUST = [
    [
        '............',
        '............',
        '............',
        '....a...a...',
        '...awa.awa..',
        '..aaaa.aaaa.',
    ],
    [
        '............',
        '............',
        '..a......a..',
        '.awa....awa.',
        'awwwa..awwwa',
        'aaaaa..aaaaa',
    ],
    [
        '.a........a.',
        'aww......wwa',
        '..a......a..',
        '....a..a....',
        '...aw..wa...',
        '....a.a.a...',
    ],
]


def dust(phase):
    return list(DUST[phase])


# ------------------------------------------------------------------ ko 32x32
def ko(phase):
    g = G(32, 32)
    cx = cy = 15.5
    if phase == 0:
        for y in range(32):
            for x in range(32):
                r = math.hypot(x - cx, y - cy)
                if r <= 3.2:
                    g.put(x, y, 'w')
                elif r <= 5.0:
                    g.put(x, y, 'A')
                elif r <= 6.2:
                    g.put(x, y, 'a')
        for i in range(8):
            a = i * math.pi / 4
            for t in range(5, 10):
                g.put(cx + math.cos(a) * t, cy + math.sin(a) * t,
                      'A' if t < 8 else 'a', force=False)
        return g.rows()

    r_in, r_out, spike_to, dash = [
        (0, 0, 0, 0),
        (5.6, 9.6, 13.5, 0),
        (10.2, 13.2, 15.4, 5),
        (13.0, 15.4, 0, 3),
    ][phase]
    for y in range(32):
        for x in range(32):
            r = math.hypot(x - cx, y - cy)
            if not (r_in <= r <= r_out):
                continue
            if dash:
                th = math.atan2(y - cy, x - cx)
                if int((th + math.pi) / (2 * math.pi) * 32) % dash == 0:
                    continue
            t = (r - r_in) / max(0.001, (r_out - r_in))
            if phase == 1:
                c = 'w' if t < 0.34 else ('A' if t < 0.74 else 'a')
            elif phase == 2:
                c = 'A' if t < 0.55 else 'a'
            else:
                c = 'a' if t > 0.45 else 'A'
            g.put(x, y, c)
    if spike_to:
        for i in range(12):
            a = i * math.pi / 6
            t = r_out
            while t <= spike_to:
                g.put(cx + math.cos(a) * t, cy + math.sin(a) * t, 'a', force=False)
                t += 0.7
    if phase == 1:
        for i in range(6):
            a = math.pi / 6 + i * math.pi / 3
            g.droplet(cx + math.cos(a) * 14.2, cy + math.sin(a) * 14.2, 0)
    if phase >= 2:
        rng = random.Random(11 * phase)
        for _ in range(10):
            a = rng.uniform(0, 2 * math.pi)
            r = rng.uniform(r_out + 0.8, 15.6)
            g.droplet(cx + math.cos(a) * r, cy + math.sin(a) * r, 0)
    if phase == 3:
        for i in range(8):
            a = i * math.pi / 4 + 0.2
            g.droplet(cx + math.cos(a) * 6.0, cy + math.sin(a) * 6.0, 0)
    return g.rows()


FRAMES = {}
for i in range(3):
    FRAMES[f'orb{i}'] = orb(i)
for i in range(2):
    FRAMES[f'crescent{i}'] = crescent(i)
for i in range(3):
    FRAMES[f'geyser{i}'] = geyser(i)
for i in range(3):
    FRAMES[f'whirl{i}'] = whirl(i)
for i in range(3):
    FRAMES[f'splash{i}'] = splash(i)
for i in range(3):
    FRAMES[f'hitspark{i}'] = hitspark(i)
for i in range(3):
    FRAMES[f'dust{i}'] = dust(i)
for i in range(4):
    FRAMES[f'ko{i}'] = ko(i)

SIZES = {
    'orb': (12, 12), 'crescent': (36, 20), 'geyser': (24, 48), 'whirl': (40, 24),
    'splash': (16, 12), 'hitspark': (12, 12), 'dust': (12, 6), 'ko': (32, 32),
}
for name, rows in FRAMES.items():
    key = name.rstrip('0123456789')
    w, h = SIZES[key]
    assert len(rows) == h, f'{name}: height {len(rows)} want {h}'
    for r in rows:
        assert len(r) == w, f'{name}: width {len(r)} want {w}'
        assert set(r) <= set('.aAwo'), f'{name}: bad chars'

HEAD = """// Generated pixel art for Aeval. Water effect frames. Sizes vary per effect.
// Each frame is an array of equal-length strings; every char is a palette key,
// '.' is transparent. All frames face right; the renderer flips for left.
// Effects use only the water keys: a, A (bright) and w (foam).

export const FX_FRAMES: Record<string, string[]> = {
"""

with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    f.write(HEAD)
    for name, rows in FRAMES.items():
        f.write(f'  {name}: [\n')
        for r in rows:
            f.write(f"    '{r}',\n")
        f.write('  ],\n')
    f.write('};\n')

print('wrote', OUT, len(FRAMES), 'frames')
