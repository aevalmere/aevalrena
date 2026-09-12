"""Composite Aeval at true game scale, the way the renderer does.

The contact sheets judge the art blown up. This judges it at 1x on a stage:
640x360 logical pixels, the fighter drawn bottom-centre on the platform with the
1 px player-colour outline ring the fighter renderer bakes, one facing each way.
If the pose does not read here it does not read in the game.

Run from the repo root:  python tools/spritegen/stagecheck.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image

import frames as F
import build as B

VIEW_W, VIEW_H = 640, 360
GROUND_Y = 250
PLAYER_COLOURS = ["#7fb2ff", "#ff7f7f", "#ffd27f", "#9fff7f"]

# Stage colours lifted from the Tidegate palette so the contrast is honest.
SKY_TOP = (22, 30, 52)
SKY_LOW = (38, 58, 92)
PLATFORM = (46, 54, 74)
PLATFORM_TOP = (96, 112, 140)


def rgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def outline_ring(im, colour):
    """The 1 px ring the baker draws, per player colour.

    It traces the frame's largest connected body region only, exactly as the
    baker does: water is exempt by colour, and any detached spray is exempt by
    not being part of the fighter. Ringing every droplet in the player colour
    turns a sweep into confetti.
    """
    w, h = im.size
    px = im.load()

    def solid(x, y):
        if not (0 <= x < w and 0 <= y < h):
            return False
        c = px[x, y]
        return c[3] > 0 and (c[0], c[1], c[2]) not in B.WATER_RGB

    label = [[-1] * w for _ in range(h)]
    best, best_size, nxt = -1, 0, 0
    for sy in range(h):
        for sx in range(w):
            if label[sy][sx] != -1 or not solid(sx, sy):
                continue
            stack = [(sx, sy)]
            label[sy][sx] = nxt
            size = 0
            while stack:
                x, y = stack.pop()
                size += 1
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and label[ny][nx] == -1 and solid(nx, ny):
                        label[ny][nx] = nxt
                        stack.append((nx, ny))
            if size > best_size:
                best_size, best = size, nxt
            nxt += 1

    def body(x, y):
        return 0 <= x < w and 0 <= y < h and label[y][x] == best

    ring = Image.new("RGBA", (w + 2, h + 2), (0, 0, 0, 0))
    rp = ring.load()
    for y in range(-1, h + 1):
        for x in range(-1, w + 1):
            if body(x, y):
                continue
            if body(x - 1, y) or body(x + 1, y) or body(x, y - 1) or body(x, y + 1):
                rp[x + 1, y + 1] = colour + (255,)
    return ring


def stage():
    img = Image.new("RGB", (VIEW_W, VIEW_H))
    px = img.load()
    for y in range(VIEW_H):
        t = y / (VIEW_H - 1)
        px_row = tuple(int(SKY_TOP[i] + (SKY_LOW[i] - SKY_TOP[i]) * t) for i in range(3))
        for x in range(VIEW_W):
            px[x, y] = px_row
    for y in range(GROUND_Y, VIEW_H):
        for x in range(70, VIEW_W - 70):
            px[x, y] = PLATFORM
    for x in range(70, VIEW_W - 70):
        px[x, GROUND_Y] = PLATFORM_TOP
        px[x, GROUND_Y + 1] = PLATFORM_TOP
    return img


def put(img, frame, cx, feet, colour, flip=False):
    if flip:
        frame = frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    ring = outline_ring(frame, colour)
    w, h = frame.size
    x = round(cx - w / 2)
    y = feet - h
    img.paste(ring, (x - 1, y - 1), ring)
    img.paste(frame, (x, y), frame)


def main():
    body = dict(B.build_groups(F.MOVEMENT + F.STATES + F.ATTACKS))
    fx = dict(B.build_groups(F.EFFECTS, center=True))

    img = stage()
    p1 = rgb(PLAYER_COLOURS[0])
    p2 = rgb(PLAYER_COLOURS[1])

    # A trade at mid stage: player one jabs right, player two swings back.
    put(img, body["idle0"], 96, GROUND_Y, p1)
    put(img, body["jab1"], 190, GROUND_Y, p1)
    put(img, body["fair1"], 300, GROUND_Y - 46, p1)
    put(img, body["run1"], 396, GROUND_Y, p2, flip=True)
    put(img, body["hitStrong"], 480, GROUND_Y, p2, flip=True)
    put(img, body["crouch"], 560, GROUND_Y, p2, flip=True)

    # Effects sit where the sim would put them: orb at chest height, geyser and
    # whirlpool anchored on the feet.
    def centre(name, cx, cy, flip=False):
        f = fx[name]
        if flip:
            f = f.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        img.paste(f, (round(cx - f.size[0] / 2), round(cy - f.size[1] / 2)), f)

    centre("orb0", 240, GROUND_Y - 20)
    centre("slash", 340, GROUND_Y - 64)
    geyser = fx["geyser2"]
    img.paste(geyser, (96 - geyser.size[0] // 2, GROUND_Y - geyser.size[1]), geyser)
    whirl = fx["whirl"]
    img.paste(whirl, (560 - whirl.size[0] // 2, GROUND_Y - whirl.size[1]), whirl)

    out = os.path.join(B.PREVIEW_OUT, "stage.png")
    img.save(out)
    img.resize((VIEW_W * 3, VIEW_H * 3), Image.Resampling.NEAREST).save(
        os.path.join(B.PREVIEW_OUT, "stage3x.png")
    )
    print(f"wrote {os.path.relpath(out, B.ROOT)} and stage3x.png")


if __name__ == "__main__":
    main()
