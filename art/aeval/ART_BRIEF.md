# Aeval art brief — shared spec for all art workers

Repo: C:/Users/light_095j4re/Documents/aevalrena

## The character (from the approved concept sheet)

Aeval, a sleepy small water mage. Chibi proportions: the head with its hair is
roughly **half the total height**. Read her by silhouette:

- **Hair**: a big soft cloud of grey-blue, wider than the shoulders, with 2-3
  cowlick spikes off the top. This is the single most important read. It must
  overhang the face and flare past the body on both sides.
- **Hairband**: a dark wine-red band across the top of the head, visible as a
  short horizontal stripe above the fringe.
- **Face**: half-lidded sleepy blue eyes under a heavy fringe, small pink blush
  on both cheeks, tiny or absent mouth.
- **Coat**: long dark navy coat/cloak, open down the front, flaring out below the
  waist. A pale grey-white shirt front and cravat sits in the opening. The coat
  hem and cuffs flare with motion — this is the second silhouette read.
- **Legs**: dark navy trousers, light grey boots.

Water is always the **bright** element. Attacks read by arm extension, cloak
sweep, and water shape, in that order.

## Frame contract (do not change)

- **32 wide x 40 tall**, every frame, no exceptions.
- Each frame is `string[]` of exactly 40 strings of exactly 32 characters.
- Characters are palette keys; `.` is transparent and is never a palette key.
- **Feet sit on row 39** (the last row) for all grounded poses. Airborne poses
  may float, crouches sit lower, but nothing may be drawn below row 39.
- **All frames face RIGHT.** The renderer flips for left. Never draw a left-facing
  frame.
- Keep the body inside roughly columns 3..28 so the flip does not clip.

## Palette (src/characters/aeval/art/palette.ts)

Sampled from the concept sheet. Workers must NOT invent new keys.

```
o: '#0e0f17'  outline, the dark line around every shape
h: '#9aa8bb'  hair light
H: '#6e7a94'  hair mid shade
D: '#4a5470'  hair deep shade
b: '#5a2e3e'  hairband
B: '#8a3c5a'  hairband highlight
s: '#fde4d1'  skin
p: '#e0a8a8'  blush
e: '#5b8fd0'  eye
c: '#35334b'  coat
C: '#1d1c2c'  coat shade
w: '#d6d8de'  shirt and white trim
t: '#23243a'  trousers
g: '#8d97ab'  boots
a: '#7fb2ff'  water
A: '#c8e8ff'  water bright
```

## How to work (this is not optional)

You are drawing blind unless you render. After every batch of frames:

```
python "C:/Users/LIGHT_~1/AppData/Local/Temp/claude/C--Users-light-095j4re-Documents-aevalrena/9461c8ef-2a35-4cc3-a817-4f95ba2cc2ff/scratchpad/preview.py" <yourfile.ts> <EXPORT_NAME> "C:/Users/LIGHT_~1/AppData/Local/Temp/claude/C--Users-light-095j4re-Documents-aevalrena/9461c8ef-2a35-4cc3-a817-4f95ba2cc2ff/scratchpad/out_<you>.png"
```

then **Read the PNG** and look at it. The tool prints `PROBLEM` lines for wrong
sizes and palette typos, and draws a dark ground line on row 39 so you can check
foot placement. Iterate until the frames actually read as the character above.
A frame that renders as a floating head or an unrecognisable blob is not done.

Reference crops of the concept sheet are in `C:/Users/LIGHT_~1/AppData/Local/Temp/claude/C--Users-light-095j4re-Documents-aevalrena/9461c8ef-2a35-4cc3-a817-4f95ba2cc2ff/scratchpad/ref/rNcM.png`
(row N, column M, both 0-7). Read the ones named in your task.

## Construction rule for consistency

Do not draw each frame from scratch. Start from the canonical base frame you are
given, then move limbs, tilt the head, and sweep the coat. The hair cloud and
head should stay nearly identical between frames except for a 1-2px bob or tilt.
This is what keeps the character from morphing between animation states.
