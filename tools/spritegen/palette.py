"""Aeval's locked palette, read off the reference sheets.

Every generated pixel snaps to one of these. Ramps stay short on purpose: a
44 px tall character cannot carry more than four or five steps per material
before the shading turns to noise.
"""

RAMPS = {
    "ink":   ["#0a0b12"],
    "coat":  ["#12141d", "#1b1e2b", "#262a3a", "#333849", "#454c61"],
    "hair":  ["#3f4a5e", "#5b6880", "#8494ad", "#a8b8ce", "#c6d4e6"],
    "band":  ["#421c26", "#6e2f3f", "#9c4459"],
    "skin":  ["#c9967f", "#e6bda6", "#f8ddc9", "#fff2e6"],
    "blush": ["#f0a0a0"],
    "eye":   ["#1e3a66", "#3f7ec4", "#7cc0ee", "#ffffff"],
    "cloth": ["#8d99ab", "#b3bdcb", "#d3dae4", "#f0f4f9"],
    "boot":  ["#4d5566", "#79839a", "#a6b0c0"],
    "water": ["#15407e", "#2a6bc0", "#4b9ce6", "#84cbf7", "#c2ebff", "#eefbff"],
}

def _rgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

PALETTE = []
PALETTE_NAMES = []
for _name, _ramp in RAMPS.items():
    for _i, _hex in enumerate(_ramp):
        PALETTE.append(_rgb(_hex))
        PALETTE_NAMES.append(f"{_name}{_i}")

def snap(c):
    """Nearest palette colour, weighted to keep hue from drifting."""
    r, g, b = c
    best = 0
    bestd = 1 << 30
    for i, (pr, pg, pb) in enumerate(PALETTE):
        dr = r - pr; dg = g - pg; db = b - pb
        d = 3 * dr * dr + 6 * dg * dg + 2 * db * db
        if d < bestd:
            bestd = d; best = i
    return PALETTE[best]


FAMILY_OF = {}
for _name, _ramp in RAMPS.items():
    for _hex in _ramp:
        FAMILY_OF[_rgb(_hex)] = _name


def family(c):
    return FAMILY_OF.get((c[0], c[1], c[2]))
