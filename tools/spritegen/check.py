"""Cross-check the generated atlases against everything that names a frame.

The old hand-authored sheets had src/characters/aeval/art/validate.ts for this.
The frames are generated now, so the check moved next to the generator: it
reads the frame tables out of the emitted atlases and every frame name the
animation table and the move table ask for, and fails on a name that does not
exist. A typo here is a fighter that silently falls back to idle mid-attack.

Run from the repo root:  python tools/spritegen/check.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, "src", "characters", "aeval", "art")
SPRITES = os.path.join(ROOT, "src", "characters", "aeval", "sprites.ts")
MOVES = os.path.join(ROOT, "src", "characters", "aeval", "moves.ts")

# Effect bases the renderer probes for itself, in visuals.ts.
PROBED = ["geyser", "whirl", "hitspark", "splash", "ko"]


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def atlas_frames(kind):
    text = read(os.path.join(ART, f"atlas.{kind}.ts"))
    table = text[text.index("const FRAMES"):text.index("export const")]
    return set(re.findall(r'"([A-Za-z0-9_]+)":', table))


def anim_frames():
    """Every frame name inside the anims table's `frames: [...]` arrays."""
    text = read(SPRITES)
    body = text[text.index("const anims"):text.index("const MOVE_ANIM")]
    names = []
    for arr in re.findall(r"frames:\s*\[([^\]]*)\]", body):
        names += re.findall(r"'([A-Za-z0-9_]+)'", arr)
    names += re.findall(r"still\('([A-Za-z0-9_]+)'\)", body)
    return names


def projectile_sprites():
    return re.findall(r"sprite:\s*'([A-Za-z0-9_]+)'", read(MOVES))


def resolves(name, frames):
    """A sprite key resolves if it exists, or if key+0 does: visuals.ts probes."""
    return name in frames or f"{name}0" in frames


def main():
    body = atlas_frames("body")
    fx = atlas_frames("fx")
    errors = []

    for name in anim_frames():
        if name not in body:
            errors.append(f"animation frame '{name}' is not in the body atlas")

    for name in projectile_sprites():
        if not resolves(name, fx):
            errors.append(f"projectile sprite '{name}' is not in the effect atlas")

    for base in PROBED:
        if not resolves(base, fx):
            errors.append(f"effect '{base}' is not in the effect atlas")

    used = set(anim_frames())
    unused = sorted(body - used)
    if unused:
        print(f"note: {len(unused)} body frames unused: {', '.join(unused)}")

    if errors:
        for e in errors:
            print(f"FAIL {e}")
        return 1
    print(f"OK {len(body)} body frames, {len(fx)} effect frames, every name resolves")
    return 0


if __name__ == "__main__":
    sys.exit(main())
