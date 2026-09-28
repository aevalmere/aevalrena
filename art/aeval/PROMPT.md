# Aeval sprite job

> **NOT READY. Do not start.** This file is being rebuilt for a new reference
> sheet. Every section marked `TO BE WRITTEN` is empty on purpose. If you were
> given this file and any `TO BE WRITTEN` marker is still in it, stop and reply
> with the single line `NOT READY: PROMPT.md still has TO BE WRITTEN sections.`
> The lead removes this box when the job is ready.

You are drawing every sprite for Aeval, the Water Mage, the first character in
Aevalrena (a browser Smash-style fighter). Read this whole file before you touch
anything. Then do the steps in order. You do not skip steps, change numbers, or
decide anything this file already decides. When this file and your own taste
disagree, this file wins.

There is exactly ONE stop in this job: after the character design (Step A) you
stop and wait for the owner's approval. After that you draw everything else
without stopping.

If your instructions say the design is already APPROVED, skip Step A and start
at Step B.

---

## 1. Rules that end the job if broken

1. Every frame faces RIGHT. Never draw a left-facing frame. The game mirrors.
2. Every frame is an 80 x 80 text grid. Standing feet rest ON row 67. Body
   centre is column 40. Nothing about that is negotiable.
3. Only characters from `art/aeval/palette.json` and `.` for transparent.
4. Water uses only the five water keys. The body never uses a water key. Water
   never uses a body key.
5. No anti-aliasing, no gradients, no dithering. Hard 1 px ink outline (`#`)
   around the whole body silhouette. Water has no ink outline.
6. You never write a program that generates Aeval's body. You draw with the
   `put`, `fill` and `shift` commands and by copying frames. (A throwaway
   script that only copies or mirrors pixels between two frames is allowed;
   it must not be saved in the repo.)
7. You never edit `art/aeval/anims.json`, anything under `src/`, or
   `tools/spritemaker/sm.mjs`. If a tool is broken, write the exact error in
   `art/aeval/REPORT.md` and continue with what works.
8. You never say a frame is done without having Read its preview PNG and
   written one sentence about what is actually in it.
9. You stop exactly once, at the gate in Step A. Never anywhere else.

---

## 2. Files

Yours to create and edit:

| path | what |
|---|---|
| `art/aeval/palette.json` | the palette, written exactly as given in section 5 |
| `art/aeval/frames/<anim>/<anim><N>.txt` | body frames, N from 0. One folder per animation name from `anims.json` |
| `art/aeval/fx/<name>/<name><N>.txt` | effect frames, N from 0. One folder per effect name from `anims.json` |
| `art/aeval/sheets/*` | previews, gifs and stage mocks the tool writes. Review only |
| `art/aeval/GATE.md` | written once, at the gate |
| `art/aeval/REPORT.md` | written at the very end |

Read only:

| path | what |
|---|---|
| `art/aeval/anims.json` | the manifest: every animation, its frame count, per-frame holds, loop flag, and the hit circles water must cover. The tool checks your work against it |
| `art/aeval/reference/aevalmere.png` | the character sheet. Read it with the Read tool and look at it |
| `art/aeval/reference/crops/*.png` | upscaled crops of the sheet. TO BE WRITTEN: the lead lists the crop names here after cutting them from the new sheet |
| `tools/spritemaker/README.md` | the tool's own docs |

Never touch: `src/`, `docs/`, `tools/`, `art/aeval/anims.json`. The `.json`
and `.png` files the tool writes next to your `.txt` files are generated; never
hand-edit them.

Integration is not your job. The lead packs your `.txt` frames into the game's
atlases using `anims.json`. Your job ends at REPORT.md.

---

## 3. Tools

Every command runs from the repo root: `C:/Users/light_095j4re/Documents/aevalrena`.
`<frame>` means `<anim>/<N>` for a body frame (file
`art/aeval/frames/<anim>/<anim><N>.txt`); add `--fx` for an effect frame
(file `art/aeval/fx/<name>/<name><N>.txt`).

| command | what it does |
|---|---|
| `node tools/spritemaker/sm.mjs new <frame> [--from <frame>] [--fx]` | creates a blank frame, or a copy of another frame |
| `node tools/spritemaker/sm.mjs rows <frame> [y0 [y1]]` | prints rows y0..y1 with a column ruler. This is how you look at the grid with coordinates |
| `node tools/spritemaker/sm.mjs put <frame> <y> <x> "<string>" [<y> <x> "<string>" ...]` | writes characters into row y from column x. `_` leaves a pixel unchanged |
| `node tools/spritemaker/sm.mjs fill <frame> <x> <y> <w> <h> <char>` | fills a rectangle with one character (`.` to erase) |
| `node tools/spritemaker/sm.mjs shift <frame> <x0> <y0> <x1> <y1> <dx> <dy>` | moves a rectangle of pixels by (dx, dy). Use it to bob the hair, raise the chest, move an arm |
| `node tools/spritemaker/sm.mjs render art/aeval/frames/<anim>` | validates every frame in the folder and writes the PNGs. Fix every `PROBLEM` line before anything else |
| `node tools/spritemaker/sm.mjs preview <anim> [--fx]` | writes `art/aeval/sheets/<anim>_preview.png`, a 6x contact sheet with the heel line and centre column drawn in |
| `node tools/spritemaker/sm.mjs preview <anim> --frame N` | one frame at 10x: `art/aeval/sheets/<anim>N_big.png` |
| `node tools/spritemaker/sm.mjs gif <anim> --holds a,b,c [--fx]` | animated gif at 4x with the holds from anims.json: `art/aeval/sheets/<anim>.gif` |
| `node tools/spritemaker/sm.mjs stage <anim>` | `art/aeval/sheets/<anim>_stage.png`: frame 0 at true 1x scale on a platform, facing both ways, plus a 3x copy. The only honest test of whether she reads in the game |
| `node tools/spritemaker/sm.mjs check [<anim>] [--fx] [--all]` | compares the folders against anims.json: missing frames, bad characters, and whether water covers each hit circle on the active frames. `check` alone prints the progress table |
| `node tools/spritemaker/sm.mjs flip <in.png> <out.png>` | mirrors a PNG left to right. Only for a generated PNG that faces left, before `import` |
| `node tools/spritemaker/sm.mjs import <png> <frame> [--fx] [--anchor feet\|centre] [--force]` | converts a PNG (80 x 80 or smaller, transparent background) into a frame: every pixel snaps to the nearest palette key, the sprite is placed with its lowest opaque row on row 67 and its centre on column 40 (`--anchor centre` centres it on (40,40) instead). Prints how many pixels landed on each key and warns about pixels far from any palette colour. The result is a starting point, never a finished frame |

### If the Pixler tools are loaded (optional)

If your tool list contains Pixler tools (`generate`, `edit`, `animate`,
`get_job`, `list_jobs`, `get_quota`; the server is `mcp.pixler.dev`), you may
use them as a starting point. Read each tool's own parameter schema before
calling it. The frame contract, the palette and the gate do not change.

- Call `get_quota` first and write the numbers into your notes. The free tier
  is 5 generations and 2 animations a day. Never spend more than 10
  generations and 4 animations on this whole job without the owner saying so.
- For the character design: `generate` a Sprite, 80 x 80, transparent, with
  the colour count limited to 28 if the tool allows it, from this prompt:
  "TO BE WRITTEN: one-sentence description of the new sheet, ending with
  facing right, full body, standing, pixel art, hard outline, no background".
  Download the PNG into `art/aeval/sheets/pixler/` (create it), then
  `import` it into `idle/0`, then fix it by hand until it matches section 6
  (feet on row 67, centre on column 40, hair top near row 20, palette keys
  used as the ramp table says, water only in water keys). If the result
  faces left, mirror it before importing (`flip`).
- For movement animations only (idle, walk, run, jump, fall, crouch, hurt,
  turnaround presets), you may `animate` the approved idle0 PNG, split the
  sheet into single frames, `import` each one, and then fix every frame by
  hand to the frame counts and descriptions in Step B. Attacks, specials,
  grabs, taunts, Final Smash frames and every effect are drawn by hand: the
  hit circles must be covered exactly, and a generated sweep cannot be
  trusted to do that.
- Nothing generated is done until it has been through the same loop as a
  hand-drawn frame: `render`, `preview`, Read, fix, `check`.

If the Pixler tools are not in your tool list, ignore this section and draw
everything by hand.

### The loop you run for every single frame

1. `new` the frame (always `--from` the nearest finished frame; idle0 is the
   base of everything).
2. `rows` the region you are about to change so you know the coordinates.
3. Edit with `put`, `fill`, `shift`.
4. `render` the folder. Fix every `PROBLEM`.
5. `preview` the animation, then Read the PNG and write one sentence: what is
   in it, what is wrong. If anything is wrong, go back to 3.
6. When every frame of the animation exists: `gif` with the holds from
   anims.json, Read it, and `check <anim>`. Fix until `check` prints `OK`.
7. For the first animation of every batch in Step B, also `stage` it and Read
   the stage PNG.

Failures that mean a frame is not done: reads as a blob; head floating off the
body; feet not on row 67 while standing; body shifted off column 40; water
missing on an active frame; outline broken; anti-aliased or blended edges;
faces left; more than 1 px of head or hair movement between neighbouring frames
of one animation (except hits, tumble, throws, Final Smash).

---

## 4. Frame rules

- Canvas 80 wide x 80 tall. x runs 0..79 left to right, y runs 0..79 top to
  bottom. `put` and `fill` take (y, x) and (x, y) as written in the table
  above; read the ruler.
- Facing RIGHT. Columns 0..39 are behind her, 40..79 in front of her.
- Heel line: row 67. Standing boot soles are ON row 67. Rows 68..79 are ground
  room for splashes, puddles and the down-air spike only.
- Standing height 48 px: tallest hair spike at row 20, soles on row 67. Head
  plus hair is about half of that (rows 20..43). Body rows 44..67.
- Body about 26 px wide (columns 27..53). Hair cloud up to 34 px wide
  (columns 24..57). Water may reach any pixel of the canvas.
- Airborne poses tuck the feet up above row 67. The body does NOT move up as a
  whole: the game places every frame by its bottom edge at the feet, so a body
  drawn higher would float.
- Effect frames: same canvas. `anchor: centre` effects are centred on pixel
  (40, 40). `anchor: feet` effects stand on row 67 like the body.
- Source of truth is the `.txt`: 80 lines of 80 characters, no header, no
  blank lines, no spaces, no tabs.
- Light comes from the upper left on every frame: the lighter ramp step goes on
  the upper-left of each shape, the darker step on the lower-right.

Hit circles (from anims.json) are in canvas coordinates: on every animation
frame whose hold span overlaps the hit's sim frames, at least 20% of the pixels
inside the circle must be water keys. `check` measures it. Draw the water so
the circle is obviously covered, not barely.

---

## 5. Palette

Create `art/aeval/palette.json` with exactly this content. Do not add, remove
or change a colour before the gate. If the owner changes a colour at the gate,
change it here and nowhere else.

TO BE WRITTEN: the lead picks the palette from the new sheet. Fixed parts
that do not change with the sheet: `.` transparent, `#` ink = `#0e0c16`
(never pure black, the gif encoder treats `#000000` as transparent), and the
water ramp `Q A a q z` deep to near-white, used for ALL water and nothing else.
Every other ramp (hair, skin, clothes, eyes, accessories) comes from the sheet.

How to use it:

| ramp | keys, light to dark | used for |
|---|---|---|
| ink | `#` | the 1 px outline around the body |
| water | `Q` `A` `a` `q` `z` | ALL water, deep to near-white: `Q` deepest core, `A` body of a wave, `a` the main water colour, `q` the lit edge, `z` the 1 px highlight and spray specks |
| (others) | TO BE WRITTEN | one row per body ramp, from the new sheet |

---

## 6. Who Aeval is

TO BE WRITTEN by the lead after looking at the new reference sheet:

- three sentences on silhouette (what she must read as at 1x)
- the pixel plan for idle0 on the 80 x 80 canvas: every body part with its
  rows, columns and ramp keys, top to bottom, in drawing order
- the expression rules per animation group

The frame rules in section 4 (canvas, heel row 67, centre column 40, standing
height 48 px, facing right, hard outline) do not change with the sheet.

---

## STEP A. The character design (the only gate)

Do these in order.

A1. Read `art/aeval/reference/aevalmere.png` and every PNG under
    `reference/crops/`. Write three sentences describing the character to
    yourself (silhouette, clothes, water). Do not draw yet.

A2. Create `art/aeval/palette.json` exactly as in section 5.

A3. `new idle/0`. Draw idle0 from the pixel plan in section 6, top to bottom:
    hair, band, face, eyes, scarf, coat, arms, wisp, trousers, boots, then the
    ink outline. Run the loop from section 3 after each part. Use
    `preview idle --frame 0` and Read the 10x PNG every time. Then `stage idle`
    and Read it: she must read as the silhouette sentence in section 6 says,
    at 1x, facing both ways.

A4. The idle loop, all copies of idle0 (`new idle/1 --from idle/0` etc.). The
    feet never move. holds 8,8,8,8, loop.
    TO BE WRITTEN: the exact `shift` commands per frame (torso up 1, hair
    settles late, water bob) once section 6 fixes the part coordinates.
    Then `render`, `preview idle`, `gif idle --holds 8,8,8,8`, `stage idle`,
    `check idle`. Read every PNG and the gif.

A5. Write `art/aeval/GATE.md` with: the list of files under
    `art/aeval/frames/idle/` and `art/aeval/sheets/`, one sentence per PNG
    describing what is in it, and anything you could not make match section 6.

A6. STOP. End your turn with exactly this line and nothing after it:

    GATE: Aeval character design ready. Review art/aeval/sheets/idle_stage.png, idle0_big.png, idle_preview.png, idle.gif. Reply APPROVED to continue or CHANGE: <notes>.

Do not create any other folder under `art/aeval/frames/` before approval.

When the next message contains APPROVED: if it also contains change notes,
apply them to idle0 first, then rebuild idle1..3 from the new idle0 (do not
patch them by hand), rerun A4's commands, and then start Step B. No second
gate.

---

## STEP B. Every other animation

> TO BE WRITTEN / REFERENCE-BOUND. The batch order, animation names, frame
> counts and holds below are from `anims.json` and stay. Every anatomy word
> (hair cloud, coat, scarf, hairband, wisp, pendant) and every row or column
> number in the descriptions was written for the previous sheet. The lead
> rewrites the descriptions from the new section 6 before this job is
> dispatched. Until then this section is a structural outline only.

Everything below is built by copying the nearest finished frame and editing.
`anims.json` is the law for frame counts and holds; the descriptions here say
what each frame shows. Work through the batches in order. After every
animation: `render`, `preview`, `gif` with the manifest's holds, `check
<anim>`, Read the outputs, fix. After the first animation of every batch:
`stage` it and Read it.

Frame roles: `w` wind-up (anticipation: squash, lean back, arm cocked), `H`
active hit (the water is fully out and covers the hit circle; the arm is
extended; add 2..4 `z` spray specks and 1 px `q` speed lines along the motion),
`r` recovery (water breaking apart into `q`/`z` droplets, body settling back
toward idle). Every attack must read as three beats: wind-up, snap, settle.
Punchy poses, not in-betweens.

Water drawing rules, used everywhere below:

- A "crescent" is a curved blade of water, thickest in the middle (3..4 px of
  `A` with an `a` band and a `q` outer edge), tapering to 1 px `q` at both
  tips, with 2..3 `z` specks just beyond its leading edge.
- A "splash" is a fan of 3..5 short `a` streaks from one point, `q` at the
  ends, `z` specks past the ends.
- A "ring at the feet" is a flat ellipse 24 wide and 4 tall centred on column
  40 at rows 66..69: `A` core, `a` sides, `q` ends.
- A "trail" is 4..8 px of `q` and `z` single pixels behind the moving part.
- Water never has an ink outline. Water never touches the body ramps.

### Batch B1: movement and states (start from idle0)

walk (6 frames, holds 5 each, loop). Contact, down, pass, contact, down, pass.
Copy idle0 for all.
- walk0: front leg forward (front boot columns 46..53, back boot 30..37),
  torso as idle0, front arm slightly lower (hand rows 52..54), coat hem
  flares 1 px each side, scarf tail trails 2 px further back.
- walk1: legs passing under her (both boots columns 36..46, one 1 px in front
  of the other), torso `shift` down 1 (the "down" beat), hair unchanged.
- walk2: back leg now forward (front boot 30..37 becomes the trailing one at
  columns 32..39, leading boot 44..51), torso back up.
- walk3, walk4, walk5: mirror the leg positions of walk0..2 (swap which boot
  leads) with the same torso beats. The wisp trails 1 px behind the hand on
  every walk frame.

run (6, holds 4 each, loop). Copy walk frames, then: lean the torso block and
head forward by `shift`ing rows 20..58 right by 2; stride 4 px longer than
walk each way; the coat hem streams back to columns 22..28 in `C`/`k` with a
`c` edge; scarf tail streams straight back 12 px; both arms bent and pumping
(front hand up at rows 48..50 on run0/run3, down at 54..56 on run2/run5); a
`q`/`z` water trail of 4 pixels at the trailing heel on every frame.

dash (2, holds 6,6). Copy run0 and run1. Lower the whole body by tucking the
legs (boots rows 64..67, knees bent), coat snapping back with 2 `z` specks off
the hem. The first lunge out of standing.

turn (2, holds 3,3). Copy idle0. turn0: three-quarter pivot; the face moves 3
px toward the centre (columns 37..52), one eye only (front eye at columns
44..47), the front arm crosses the body, hair `shift` 2 px the opposite way
from the face. turn1: nearly faced the new way: same as turn0 with the hair
back over the centre.

crouch (2, holds 3,60). Copy idle0. crouch0: knees bent, hair top at row 26,
everything from the shoulders down compressed by `shift`ing the torso block
down 4 and shortening the legs (trousers rows 60..64). crouch1: 2 px lower
again (hair top at row 28), coat hem spread to columns 27..55, hair still
overhanging the face.

jumpsquat (2, holds 2,1). Copy crouch1 for both; jumpsquat1 has the arms pulled
in and the coat compressed 1 px more.

jump (3, holds 4,4,60). Copy idle0. jump0: launch stretch, arms up, legs
straight and together, feet at rows 60..67, hair `shift` down 2 (drag). jump1:
rising, knees tucked (boots rows 58..62), arms out to the sides, coat hem
lifted to row 56 flaring wide (columns 26..56), hair back at row 20. jump2:
apex float, one leg up one leg down, hair 1 px higher (row 19 is allowed on
this frame only), coat wide, scarf floating up.

fall (3, holds 6 each, loop). Copy jump2. Legs tucked (boots rows 58..63), coat
lifted and flaring upward (hem at rows 50..54, columns 26..56), hair pushed up
1 px, scarf tail flapping up on fall0, straight on fall1, down on fall2.

land (2, holds 2,2). land0: copy crouch0 with a ring at the feet. land1: copy
idle0 with the knees 1 px bent and the ring fading (`q` only).

helpless (3, holds 8 each, loop). Copy fall0. Arms out to both sides, palms
down, head tilted 1 px back (hair `shift` -1 x), eyes closed line. helpless1:
tilt the whole body 1 px clockwise by `shift`ing the head 1 px right and the
feet 1 px left. helpless2: the opposite tilt.

shield (2, holds 6,6, loop). Copy crouch0. Arms crossed in front of the chest
(both hands at columns 40..46, rows 48..51), eyes closed, head down 1 px.
shield1: 1 px breathing on the torso. The bubble is drawn by the game.

hitLight (2, holds 4,60). Copy idle0. hitLight0: whole torso `shift` back
(left) by 3, head snapped back 2, eyes wide, hair thrown forward 2 (hair
`shift` +2 x). hitLight1: torso back 2, head back 1, hair back over the
centre, mouth open (2 px `S`).

hitStrong (2, holds 4,60). Copy hitLight0. hitStrong0: torso leaning back 6 px
(`shift` rows 43..58 by -6), legs kicked forward (boots columns 44..55, rows
62..67), hair thrown forward 4, arms flung forward, eyes wide, mouth open.
hitStrong1: same body, arms and hair swinging back the other way 2 px.

tumble (4, holds 5 each, loop). One full rotation. tumble0: copy hitStrong0
(head back, feet forward). tumble1: horizontal, head at the left (columns
20..40, rows 40..56), feet at the right. tumble2: upside down: hair cloud at
rows 44..64 columns 24..57, boots at rows 20..28 columns 36..48, coat hanging
"down" toward the head (toward row 64). tumble3: horizontal the other way,
head at the right, feet at the left. On every tumble frame the body is inside
rows 20..67 and centred on column 40. Eyes wide throughout.

dead (1, hold). Copy tumble1 and lay her flat on row 67: hair cloud on the
left (columns 12..40, rows 50..67), coat and legs to the right (columns
40..68), boots on their sides, eyes closed.

### Batch B2: ground attacks (start from idle0)

jab (4, holds 4,2,2,10, roles wHHr, hit circle (55,49) r9 on frames 1..2).
- jab0: front arm pulled back to the chest (hand at columns 44..47, rows
  48..50), torso `shift` -1 x, wisp compressed to 3 x 3 `A` at the palm.
- jab1: arm thrust forward straight (hand at columns 56..59, rows 49..51),
  palm out; a splash of water fanning from the palm covering columns 52..64,
  rows 43..56 (`A` core at the palm, `a` streaks, `q` tips, 3 `z` specks
  further out). Torso leaning 1 px forward.
- jab2: same arm; the splash has flown 4 px further (columns 56..68) and is
  breaking into droplets; a bead of `a` 3 px wide separates at column 60.
- jab3: arm halfway back (hand columns 50..53), droplets `q`/`z` only.

ftilt (5, holds 5,3,3,2,13, wwHHr, hit (64,49) r11 on frames 2..3).
- ftilt0: copy jab0, plus the back foot slides back 2 px (weight back).
- ftilt1: arm cocked further back (hand behind the shoulder at columns 34..37,
  rows 46..48), torso twisted back 2 px, water gathering as a 6 x 6 blob at
  the hand.
- ftilt2: arm fully out, body leaning forward 2 px, front foot forward 3 px;
  a horizontal splash from the hand covering columns 54..75, rows 43..56:
  three thick `A`/`a` streaks with `q` edges and 4 `z` specks at columns
  70..77.
- ftilt3: same pose, water 3 px further out and thinning to `a`/`q`.
- ftilt4: arm lowering (hand rows 54..56), body back to idle, `q` droplets.

utilt (5, holds 4,2,3,3,12, wwHHr, hit (42,23) r12 on frames 2..3).
- utilt0: crouch slightly (copy crouch0), front hand low at the hip.
- utilt1: hand swinging up past the chest, palm up, water blob following.
- utilt2: arm straight up (hand at columns 44..47, rows 20..23), body
  stretched (copy idle0 legs), a ripple of water arcing over the head from
  column 30 to column 54 across rows 14..28: an upward crescent, `A` centre at
  rows 16..19 columns 38..46, tips down to row 28 at both ends, `z` specks
  above row 14.
- utilt3: same arm; the ripple 2 px higher and wider, breaking into droplets at
  the tips.
- utilt4: arm coming down (hand at rows 40..43), droplets falling past the
  hair.

dtilt (4, holds 5,3,2,12, wHHr, hit (50,63) r9 on frames 1..2).
- dtilt0: copy crouch1, front hand reaching down to the ground at column 48.
- dtilt1: hand on the ground at columns 48..51 row 64..66; a puddle of water
  under and in front of it: `A`/`a` ellipse columns 44..62, rows 62..69, with
  a spike of `a`/`q` popping up at columns 54..57 from row 56 to row 62, `z`
  specks at the top.
- dtilt2: the spike is taller (from row 52) and thinner, the puddle spreading
  to column 66 and thinning to `q`.
- dtilt3: hand lifting, puddle gone to `q` droplets on the ground.

dashatk (5, holds 6,4,4,3,15, wHHHr, hit (60,51) r12 on frames 1..3).
- dashatk0: copy dash1, leaning further forward, front arm back.
- dashatk1: sliding low on a wave: body lowered (hair top row 28), knees bent,
  front arm out low; a wave of water under and in front of her, columns
  36..72, rows 56..69, `A` core with an `a` crest curling up at columns 60..70
  rows 46..56 (crest tip `q`, `z` specks ahead at columns 70..76).
- dashatk2: wave 3 px further forward, crest taller (from row 42), speed lines
  (`q` single pixels) trailing behind at rows 50..60 columns 20..34.
- dashatk3: wave collapsing (crest breaking into droplets), body still low.
- dashatk4: body rising back to idle height, `q` droplets around the boots.

fsmash (6, holds 8,8,3,3,10,12, wwHHrr, hit (66,49) r16 on frames 2..3). The
biggest pose in the set.
- fsmash0: copy ftilt1: weight back, arm cocked behind, water gathering in a
  10 x 10 blob behind the hand.
- fsmash1: deeper wind-up: torso twisted back 3 px, front knee bent, hair
  swung back 2, blob 12 x 12 with a `Q` core and `z` ring.
- fsmash2: full swing: body lunging forward 3 px, front foot forward 4 px, arm
  straight out; a HUGE crescent wave in front of her, tips at (58,30) and
  (58,66), belly out to column 78, 6 px thick at the middle (`Q` core, `A`,
  `a`, `q` edge), 5 `z` specks beyond it, 3 `q` speed lines behind the arm.
  Eyes open, mouth line.
- fsmash3: same pose, crescent 3 px further forward and thinner (5 px), tips
  fraying into droplets.
- fsmash4: crescent gone; arm still out; `q`/`z` droplets in an arc; body
  settling back 1 px.
- fsmash5: arm lowering (hand rows 54..56), body back to idle0 position.

fsmashCharge (2, holds 6,6, loop). Copy fsmash1 for both. fsmashCharge1: the
blob 1 px bigger and pulsing (`z` ring 1 px further out), hair 1 px lower.

usmash (6, holds 6,6,3,4,11,10, wwHHrr, hit (42,23) r15 on frames 2..3).
- usmash0: copy crouch0, both hands together low at the waist (columns 40..47,
  rows 54..57), water pooling between them.
- usmash1: deeper crouch (copy crouch1 body), hands lower, water blob 8 x 8
  between the hands with a `Q` core.
- usmash2: body stretched straight up, both arms straight up (hands together
  at columns 42..47, rows 18..21); a geyser burst from the hands: a column of
  `A`/`a` 8 px wide from row 22 up to row 4, flaring into a splash of 5 streaks
  at rows 4..14 across columns 28..56, `z` specks at the top edge.
- usmash3: same pose, the column 2 px wider and the splash 4 px wider and 2 px
  higher, droplets separating.
- usmash4: arms still up, water collapsing into falling droplets over the
  hair, body 1 px lower.
- usmash5: arms coming down, back to idle posture.

usmashCharge (2, holds 6,6, loop). Copy usmash1 for both. usmashCharge1: the
blob pulses 1 px bigger and a ring at the feet appears in `q`.

dsmash (6, holds 6,6,2,2,13,13, wwHHrr, hits (58,61) r14 AND (22,61) r14 on
frames 2..3). The water is symmetric front and back.
- dsmash0: copy crouch1, arms crossed low in front (hands at columns 36..46,
  rows 56..59).
- dsmash1: lower still, arms crossed tighter, two water blobs 6 x 6 at the
  hips, one at columns 26..31 and one at columns 50..55, rows 56..61.
- dsmash2: arms flung out to both sides, palms down (hands at columns 20..23
  and 58..61, rows 56..58); a ring wave on BOTH sides: two low crescents
  lying on the ground, one covering columns 8..34, one covering columns
  46..72, rows 52..69, each 5 px thick with a `Q` core and a curling `q` tip
  at the outer end, `z` specks at columns 4..8 and 72..76. Draw the front one,
  then write the back one mirrored around column 40 (mirror column = 80 - x).
  Eyes open, mouth line.
- dsmash3: both waves 3 px further out and thinner.
- dsmash4: arms still out, water collapsing to droplets both sides.
- dsmash5: standing up to idle0 posture, arms lowering.

dsmashCharge (2, holds 6,6, loop). Copy dsmash1 for both. dsmashCharge1: the
two blobs pulse 1 px bigger.

### Batch B3: aerials (start from fall0). Every aerial is an animated sweep:
the active frames show a thick crescent moving along an arc, with a trailing
`q` edge and `z` specks ahead of it. The crescent must cover the hit circle on
every active frame.

nair (5, holds 5,6,6,6,11, wHHHr, hit (46,47) r16 on frames 1..3).
- nair0: copy fall0, arms pulled in to the chest, knees tucked, a 6 x 6 water
  blob at the chest.
- nair1: a ring of water orbits the body. Draw an ellipse 44 wide and 30 tall
  centred at (44,47) as a 4 px thick band (`A` core, `a`, `q` outer edge). On
  nair1 the thick part (6 px, with `Q` core and `z` specks) is at the FRONT
  (columns 60..66) and the ring thins to 2 px at the back.
- nair2: same ring, the thick part has moved one third of the way round: it is
  now at the BOTTOM BACK (columns 24..34, rows 56..62); the front is thin.
- nair3: thick part at the TOP BACK (columns 26..36, rows 32..38).
- nair4: ring breaking apart into `q`/`z` droplets, arms relaxing to fall0.

fair (6, holds 5,4,2,3,7,9, wwHHrr, hit (62,47) r13 on frames 2..3).
- fair0: copy fall0, front arm raised straight up behind the head (hand at
  columns 36..39, rows 22..25), water blob at the hand.
- fair1: arm at the top of the arc, body arched back 2 px, blob stretched into
  a short crescent above the head (columns 34..50, rows 16..26).
- fair2: arm swinging down-forward, hand at (60,40); the crescent sweeps in
  front and above: tips at (46,22) and (70,50), belly at (68,34), 5 px thick,
  `Q` core, `z` specks ahead of the lower tip, coat whipping forward.
- fair3: arm down-forward, hand at (60,54); the crescent continues the arc:
  tips at (62,28) and (58,64), belly at (72,48), 5 px thick; the previous
  position left as a 1 px `q` trail.
- fair4: arm at the bottom, crescent fraying into droplets at rows 50..66.
- fair5: arm relaxing back, body to fall0.

bair (5, holds 4,3,2,2,17, wwHHr, hit (18,47) r12 on frames 2..3).
- bair0: copy fall0, torso twisting toward the back (head `shift` -2 x, the
  back arm crossing the chest), water blob at the back hand.
- bair1: twist deeper, back arm cocked forward across the chest, blob bigger.
- bair2: back arm flung straight back (hand at columns 20..23, rows 46..48),
  body twisted so the coat swings behind; a crescent sweeping behind her: tips
  at (30,30) and (30,64), belly at (10,47), 5 px thick, `Q` core, `z` specks
  at columns 4..8.
- bair3: crescent 3 px further back and thinner, a `q` trail at its previous
  place.
- bair4: arm relaxing, droplets behind, body untwisting toward fall0.

uair (6, holds 3,3,2,3,5,10, wwHHrr, hit (42,23) r12 on frames 2..3). The arc
sweeps ABOVE her.
- uair0: copy fall0, front arm low and forward (hand at (56,56)), blob at the
  hand.
- uair1: arm swinging up in front (hand at (60,40)), the blob stretching.
- uair2: arm up-forward (hand at (54,24)); a crescent from FRONT to TOP: tips
  at (66,40) and (40,10), belly at (60,18), 5 px thick, `Q` core, `z` specks
  ahead of the upper tip. Legs kicked forward slightly.
- uair3: arm straight up then over (hand at (36,20)); the crescent has swept
  OVER THE CROWN to the back: tips at (56,8) and (18,34), belly at (34,10), 5
  px thick; a 1 px `q` trail where uair2's crescent was. Hair pushed down 1 by
  the sweep.
- uair4: arm behind her, crescent breaking into droplets falling past the
  back of the hair.
- uair5: arm returning, fall0 body.

dair (6, holds 6,6,3,2,8,11, wwHHrr, hit (44,65) r12 on frames 2..3). The
sweep goes BELOW the feet and ends in a spike. Rows 68..79 are allowed here.
- dair0: copy fall0, both arms raised over the head, legs together and pointed
  down (boots at rows 60..67), a blob between the hands at rows 14..20.
- dair1: arms swinging down in front (hands at (56,44)), body curling, blob
  following.
- dair2: both arms straight down (hands at columns 42..47, rows 58..62), legs
  pointed straight down, toes at row 67; a crescent below her: tips at
  (26,58) and (62,58), belly at (44,76), 6 px thick, `Q` core, `z` specks
  below row 76.
- dair3: the crescent narrows into a downward spike 8 px wide from row 60 to
  row 79 under the feet, `Q` core, `q` edges, `z` specks at the tip.
- dair4: spike breaking into droplets below the feet, arms still down.
- dair5: arms relaxing, legs tucking back to fall0.

### Batch B4: specials

nspecial (5, holds 7,8,4,12,21, wwHrr; the orb (an effect) leaves the front
hand at (58,47) on frame 2).
- nspecial0: copy idle0, both hands cupped together in front of the chest
  (columns 46..51, rows 48..52), a 5 x 5 water blob between them.
- nspecial1: hands pulled back to the hip (columns 40..45, rows 52..56), blob
  8 x 8 with a `Q` core and a `z` ring.
- nspecial2: both arms pushing straight forward, palms out (hands at columns
  56..60, rows 46..49), body leaning 2 px forward; NO orb drawn (the effect
  draws it), only a 3 px splash of `q`/`z` at the palms and 3 `q` speed lines
  behind the arms.
- nspecial3: arms still out, body settling back 1 px, droplets fading.
- nspecial4: arms lowering to idle0.

nspecialCharge (3, holds 6,6,6, loop). Copy nspecial1 for all three. The blob
between the hands: 8 x 8 on nspecialCharge0, 10 x 10 on nspecialCharge1, 12 x
12 with a bigger `z` ring on nspecialCharge2. Hair 1 px lower on
nspecialCharge1.

sspecial (5, holds 5,5,4,12,16, wwHrr; the crescent (an effect) leaves at
(60,49) on frame 2).
- sspecial0: copy ftilt1 (arm cocked behind), water blob stretched into a
  short crescent behind the hand.
- sspecial1: deeper: body twisted back 3 px, crescent 16 px tall behind the
  shoulder.
- sspecial2: arm swung forward and out, body lunging 3 px forward with the
  front foot forward; NO crescent drawn (the effect draws it): only a `q`/`z`
  release spray at the hand and speed lines behind the arm.
- sspecial3: arm out, body settling.
- sspecial4: arm lowering to idle0.

uspecial (6, holds 4,4,5,8,13,14, wwHHrr, hit (42,23) r14 on frames 2..3;
the geyser column is an effect).
- uspecial0: copy crouch0, arms down and back, hair pressed down 1.
- uspecial1: copy crouch1, deeper, both hands on the ground either side of
  the feet, water pooling at the hands (a ring at the feet).
- uspecial2: launched: body stretched straight, both arms straight up, legs
  together and pointed down (toes at row 67), hair streaming down 2 px;
  water bursting around the raised hands: a splash of 5 streaks from
  (44,20) covering columns 28..58, rows 8..30, `z` specks above.
- uspecial3: same pose, the splash wider (columns 24..62) and rising 3 px,
  droplets separating, coat hem flaring up around the knees.
- uspecial4: arms coming down to the sides, legs still together, droplets
  falling, eyes closed (she is helpless after this).
- uspecial5: copy helpless0 posture (arms out, limp), hair up 1.

dspecial (6, holds 6,6,12,12,8,6, wHHHrr; the whirl and its hits are an
effect).
- dspecial0: copy idle0, arms out to both sides low, palms down, a ring at the
  feet.
- dspecial1: arms rising to shoulder height, body twisting 2 px (front arm
  forward, back arm back), coat hem swinging.
- dspecial2: arms level, body turned three-quarter toward the viewer (face
  columns 38..54, both eyes equal size), coat hem swung out to columns 26..56
  in a spiral (`c` lit edge), hair swung 2 px; water spiralling up around
  her: two `a`/`q` bands, each 3 px thick, wrapping the body at rows 44..50
  and 56..62, `z` specks.
- dspecial3: the mirror twist of dspecial2: hair and coat swung the other way,
  bands moved up 4 px.
- dspecial4: arms lowering, bands breaking into droplets.
- dspecial5: idle0 posture, droplets at the feet.

### Batch B5: defence, ledge, ground

spotDodge (3, holds 5,12,5). spotDodge0: copy crouch0 with the arms in.
spotDodge1: compressed into a water blur: body drawn as crouch1 but every
body pixel column between 33 and 47 stays and the rest is replaced by a
vertical `a`/`q` blur (columns 30..50, rows 30..66), hair reduced to a `q`
smear. spotDodge2: copy crouch0 popping back, `q` droplets around.

roll (4, holds 6 each). roll0: copy crouch1, tucked (arms around the knees,
head down 3 px). roll1: a ball: hair cloud at the FRONT bottom (columns
40..60, rows 46..66), boots at the back top (columns 22..34, rows 40..48),
coat wrapped around, a water streak of 6 px `q`/`z` behind at rows 60..66.
roll2: the ball rotated another quarter: hair at the back bottom (columns
20..40), boots at the front top. roll3: rising out of the roll: copy crouch0
with droplets behind.

airDodge (3, holds 5,20,5). airDodge0: copy fall0, arms crossing the chest.
airDodge1: tucked spin: knees to the chest, arms wrapped, coat wrapped around
the body as a `C` oval with a `c` edge, hair cloud over the top, a shimmer of
single `q`/`z` pixels in a ring 3 px outside the body. airDodge2: copy fall0
uncurling.

ledgeHang (2, holds 12,12, loop). ledgeHang0: copy idle0 with both arms
straight up above the head (hands at columns 40..47, rows 20..23; the hair
top may drop to row 24 because the arms are the highest point), body hanging
straight, legs dangling together, boots at rows 62..67. ledgeHang1: body
swayed 1 px back, coat hem swung 1 px, wisp gone.

ledgeClimb (3, holds 10,10,10). ledgeClimb0: copy ledgeHang0 with the elbows
bent (pulling up: hands at rows 30..33). ledgeClimb1: one knee up at column
50 rows 50..56, body leaning forward 3 px. ledgeClimb2: copy crouch0 standing
up.

ledgeatk (5, holds 9,9,4,3,15, wwHHr, hit (60,53) r12 on frames 2..3).
ledgeatk0: copy ledgeClimb0. ledgeatk1: copy ledgeClimb1 with the front arm
cocked back, water gathering. ledgeatk2: low lunge onto the stage: body low
(copy dashatk1 posture) with the front arm sweeping forward low; a low
crescent in front, tips at (50,40) and (50,66), belly at (72,53), 5 px thick,
`Q` core, `z` specks ahead. ledgeatk3: crescent 3 px further, thinner.
ledgeatk4: copy crouch0 rising, droplets.

tech (2, holds 8,18). tech0: copy crouch1 with one hand slapping the ground
at column 52 row 66, a ring at the feet, hair pressed down 2. tech1: copy
crouch0 popping up, ring fading to `q`.

techRoll (4, holds 10 each). Copy roll0..roll3 with the ring at the feet on
techRoll0 and a longer trail (10 px) on techRoll1 and techRoll2.

downed (2, holds 15,15, loop). downed0: copy dead: flat on the ground, face
up, eyes closed, hair cloud spread on the ground at the left. downed1: chest
1 px higher (breathing), one hand 1 px up.

getUp (3, holds 10 each). getUp0: copy downed0 with the head lifted 3 px and
the front hand pushing on the ground. getUp1: sitting up: copy crouch1 with
one hand still on the ground behind. getUp2: copy crouch0.

getUpRoll (4, holds 9,9,9,8). getUpRoll0: copy downed0 curling (knees up).
getUpRoll1: copy roll1. getUpRoll2: copy roll2. getUpRoll3: copy crouch0.

getupatk (5, holds 7,7,4,3,13, wwHHr, hits (58,57) r12 AND (22,57) r12 on
frames 2..3). getupatk0: copy getUp0. getupatk1: copy getUp1 with both arms
pulled in and two water blobs at the hips. getupatk2: rising to a crouch with
both arms flung out to the sides: two low crescents lying on the ground, one
covering columns 44..72 and one covering columns 8..36, rows 48..66, 5 px
thick, `Q` cores, `z` specks at both ends (draw the front one, mirror it
around column 40 for the back one). getupatk3: crescents 3 px further out
and thinner. getupatk4: copy crouch0 standing, droplets.

footstooled (2, holds 4,60). footstooled0: copy crouch1 squashed: hair
flattened to rows 30..40, head pushed down into the shoulders, eyes wide,
arms out. footstooled1: 1 px less squashed, mouth open.

### Batch B6: grabs

grab (3, holds 7,3,20, wHr, hit (56,47) r9 on frame 1). grab0: copy jab0
(hand pulled back). grab1: front arm straight forward, fingers spread (hand
columns 56..60, rows 46..48); a water tendril from the fingertips: a 3 px
thick `a` line with a `q` edge from (58,47) curling to (66,44), `Q` at the
base, `z` at the tip; the tendril must cover the circle at (56,47). grab2:
arm halfway back, tendril gone to droplets.

grabHold (2, holds 10,10, loop). grabHold0: copy grab1: arm out, and instead
of the tendril a "grip": a 10 x 12 open ring of `a`/`q` at columns 60..69,
rows 42..53 (the victim is drawn by the game inside it). grabHold1: the ring
1 px bigger, torso breathing 1 px.

pummel (2, holds 4,12). pummel0: copy grabHold0 with the grip ring squeezed
to 8 x 10 and `z` specks. pummel1: copy grabHold0.

throwF (3, holds 10,4,10; release on frame 1). throwF0: copy grabHold0 with
the arm pulled back to the chest, grip ring following. throwF1: arm thrust
forward past full extension, body lunging 3 px, a splash from the palm
(columns 58..72). throwF2: arm out, settling, droplets.

throwB (3, holds 14,4,12; release on frame 1; the holder turns first).
throwB0: copy turn0 (three-quarter view) with the grip ring in front.
throwB1: arm flung back over the shoulder (hand at (24,30)), body twisted, a
splash behind her at columns 8..30, rows 24..44. throwB2: copy idle0 with the
arm lowering behind, droplets.

throwU (3, holds 12,4,12; release on frame 1). throwU0: copy grabHold0 with
both hands under the grip ring, knees bent. throwU1: both arms straight up
(copy usmash2 arms), body stretched, a splash upward from the hands covering
columns 32..56, rows 8..24. throwU2: arms lowering, droplets over the hair.

throwD (3, holds 12,4,10; release on frame 1). throwD0: copy grabHold0 with
the arm raised (hand at (56,34)), grip ring high. throwD1: arm slammed down,
hand at (54,62), body crouched (copy crouch0 legs), a splash on the ground at
columns 46..70, rows 60..69 with `z` specks bouncing up. throwD2: copy crouch0
rising, droplets.

grabbed (2, holds 8,8, loop). grabbed0: copy hitLight0 with both arms up and
out, one leg kicking forward, eyes wide, mouth open. grabbed1: arms and leg
swapped (the other leg kicks), hair 1 px the other way.

### Batch B7: taunts and Final Smash

taunt (4, holds 12 each, loop). taunt0: copy idle0 with the front palm up at
chest height, eyes closed, a small 4 x 4 orb on the palm. taunt1: orb 3 px
higher, arm rising 1. taunt2: orb 6 px above the palm, both arms half raised.
taunt3: orb 8 px up with a `z` ring, both arms raised, hair 1 px up.

taunt2 (4, holds 12 each, loop). Copy idle0 with the front arm raised to
shoulder height, one finger up (a 1 px `s` column at (58,40..44)), a 6 x 6
orb balanced on the fingertip at rows 33..38, eyes closed. Across taunt2_0..3
the orb's `z` highlight moves around it (top-left, top-right, bottom-right,
bottom-left) and the orb tilts 1 px.

taunt3 (4, holds 12 each, loop). Copy crouch1 with both hands on the knees,
eyes closed. Water pooling around the boots: a puddle `A`/`a`/`q` from
columns 26 to 56, rows 64..69, growing 2 px wider on each frame with `q`
ripples, and 1..2 `z` drips rising on taunt3_2 and taunt3_3.

fsStart (3, holds 7,7,6). fsStart0: copy idle0 with both hands raised to the
chest, a 6 x 6 blob between them. fsStart1: both arms flung up and forward,
eyes open, a 12 x 12 `Q`-cored blob at the hands. fsStart2: both arms out
straight forward, palms open; a water tendril lunging forward from both hands
as a 6 px thick `A`/`a` beam from (58,44) to (79,44), `q` edges, `z` specks
at the far end (the grip effect finishes the catch).

fsTsunami (2, holds 10,10, loop). Copy fsStart2 with the arms wide to the
sides and up, palms forward, body leaning forward 2 px, coat streaming back,
hair swept back 2; water rushing forward past her feet as three horizontal
`a`/`q` bands rows 58..69, columns 20..79, `z` specks. fsTsunami1: bands
`shift` 4 px right (wrapping is not needed; erase the far end and redraw the
near end).

fsTornado (2, holds 10,10, loop). Copy fsTsunami0 with both arms raised and
circling (fsTornado0: front arm high, back arm level; fsTornado1: front arm
level, back arm high), head tilted up 1 px, and a spiral of `q` pixels rising
from the hands.

fsLaunch (3, holds 6,6,8). fsLaunch0: copy fsTornado0 with both arms pulled
down and back to the hips, knees bent, blobs at both hands. fsLaunch1: both
arms swung straight up, body stretched on tiptoe (toes on row 67), eyes open,
mouth line; a burst of 8 short `a` streaks from the hands in all upward
directions, rows 6..30, `z` specks. fsLaunch2: arms up, droplets falling,
body relaxing 1 px.

fsVictim (3, holds 8 each, loop). Copy tumble1, tumble2, tumble3 in that
order (the victim is carried by the game), eyes wide, with 4..6 `q`/`z`
droplets around the body on each frame.

---

## STEP C. Effects (folders under `art/aeval/fx/`, use `--fx`)

> REFERENCE-BOUND: effect shapes are water-only and mostly independent of the
> sheet, but the lead re-checks them against the new sheet's effects crop and
> adjusts sizes before dispatch.

Same 80 x 80 canvas. `anchor: centre` effects are centred on pixel (40,40).
`anchor: feet` effects stand on row 67 like the body. Sizes are the bounding
box in anims.json. No ink outline on water. Water keys only, except `ko`,
`hitspark` and `dust`, which may also use `w` and `m` for white flashes.

| name | frames | anchor | draw |
|---|---|---|---|
| orb | 3, loop | centre | a 14 px round ball: `Q` core 4 px, `A` body, `a` rim, `q` top-left edge, one `z` highlight; orb1 is 1 px wider and 1 px shorter (wobble), orb2 1 px taller and narrower |
| burst | 3 | centre | the orb popping: burst0 a 20 px ring 3 px thick; burst1 a 30 px ring 2 px thick with 6 `z` specks outside; burst2 a 34 px ring 1 px `q` with 10 `z` specks |
| crescent | 3, loop | centre | a crescent 40 wide and 22 tall pointing RIGHT (belly at the right, tips at the left), 5 px thick at the belly, `Q` core, `A`, `a`, `q` edge, 4 `z` specks ahead of the belly; frames 1 and 2 move the `z` specks and shift the `Q` core 1 px |
| geyser | 4 | feet | a rising column on row 67: geyser0 a 12 px wide, 20 px tall column with a rounded top; geyser1 16 wide, 40 tall; geyser2 22 wide, 60 tall with a splash of 5 streaks at the top; geyser3 30 wide, rows 8..67 (60 tall, the tallest allowed) with the top breaking into droplets. `Q` centre column, `A`, `a`, `q` edges, `z` specks |
| whirl | 4, loop | feet | a funnel 56 wide and 28 tall sitting on row 67: three nested horizontal bands (`A` outer, `a`, `q` inner), each band an ellipse, the smallest at the bottom; on each frame the bands' `z` highlight moves a quarter turn around the ellipse and the bands `shift` 1 px alternately left and right, so it reads as rotating, not as a static spiral |
| splash | 3 | feet | a ring at the feet: splash0 24 x 6 `A`/`a`; splash1 30 x 8 `a`/`q` with 4 `z` drops rising 4 px; splash2 34 x 6 `q` only with 6 `z` drops at rows 58..62 |
| hitspark | 3 | centre | hitspark0 a 6 px `w` square with a `z` cross 10 px; hitspark1 a 14 px 4-point star of `z`/`q` with a `w` centre; hitspark2 4 separate `q` specks 12 px apart |
| dust | 2 | feet | dust0 a 12 x 6 `m`/`w` puff on row 67; dust1 a 12 x 4 `m` puff 2 px higher and thinner |
| ko | 4 | centre | ko0 an 18 px `w`/`z` burst; ko1 a 34 px 8-point star `z` with `a` between the points; ko2 a 48 px ring 3 px thick `a`/`q` with 8 `z` specks; ko3 a 48 px `q` ring 1 px with 12 `z` specks |
| grip | 3 | centre | a hand of water closing: grip0 an open 30 x 30 `a` ring with 5 short `q` "fingers" pointing inward; grip1 the fingers 4 px longer, ring 26 px; grip2 a closed 22 px `A` blob with `Q` core and `z` ring |
| tsunami | 4, loop | centre | a wave 80 wide and 48 tall, its base at row 64 (rows 16..64), belly rising to the right, `Q` deep body, `A`, `a` crest curling to the right at rows 16..28, `q` foam line along the crest, `z` specks; frames 1..3 move the crest curl 3 px along and the foam line 1 px up and down |
| tornado | 4, loop | centre | a water tornado 40 wide and 80 tall, rows 0..79, narrow at the bottom (8 px at row 76) and wide at the top (40 px at row 4): five stacked horizontal `a`/`q` bands with `A` shadows, the bands tilting 1 px alternately per frame and their `z` highlights moving a quarter turn per frame |
| fsburst | 3 | centre | the launch burst, 80 x 80: fsburst0 a 30 px `z`/`w` core with 8 `a` rays 20 px long; fsburst1 rays 36 px long with a 50 px `q` ring; fsburst2 a 78 px `q` ring 2 px thick with 16 `z` specks and no core |

For each effect: `new <name>/<N> --fx`, draw, `render art/aeval/fx/<name>`,
`preview <name> --fx`, `gif <name> --fx --holds ...`, `check <name> --fx`.
Read every preview.

---

## FINISH

1. `node tools/spritemaker/sm.mjs check --all` must print
   `BODY 66/66 animations complete` and `FX 13/13 effects complete` with no
   PROBLEM lines. If something cannot pass, say exactly which frame and why in
   REPORT.md; do not delete frames to make the count pass.
2. `stage` for idle, run, fsmash, nair, uspecial and dspecial, and Read each.
3. Write `art/aeval/REPORT.md`:
   - the two summary lines from `check --all`
   - a table: animation, frames, one sentence on what it shows, anything off
   - a list of every frame where you deviated from this file and why
   - every tool error you hit
4. End your turn with this JSON as the last thing in your message:

```json
{
  "gate": "approved",
  "body_complete": "<n>/66",
  "fx_complete": "<n>/13",
  "check_all_exit": <0 or 1>,
  "deviations": [ "<anim><N>: <why>" ],
  "tool_errors": [ "..." ],
  "review_files": [ "art/aeval/sheets/..._stage.png", "..." ]
}
```
