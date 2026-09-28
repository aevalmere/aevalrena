# Sheet cutter spec (wave 1 + wave 3 sheets)

Four generated sprite sheets on a black background become the Aeval assets.
This document is the contract for `tools/sheetcut/cut.py`. Only the lead edits it.

## Inputs

Copy the four source PNGs into this folder with these names (keep the originals
in Downloads untouched):

| target file                      | source in `C:\Users\light_095j4re\Downloads\`           | size      |
|----------------------------------|----------------------------------------------------------|-----------|
| `art/aeval/sheets/moves.png`     | `ChatGPT Image Sep 15, 2026, 12_46_24 AM.png`            | 1536x1024 |
| `art/aeval/sheets/defense.png`   | `ChatGPT Image Sep 15, 2026, 12_43_58 AM.png`            | 2172x724  |
| `art/aeval/sheets/ground.png`    | `ChatGPT Image Sep 15, 2026, 12_50_10 AM.png`            | 1536x1024 |
| `art/aeval/sheets/special.png`   | `ChatGPT Image Sep 15, 2026, 12_53_19 AM.png`            | 1536x1024 |

Background is pure black (0,0,0 to about 3,3,3). Section titles and captions
are cyan text (mean colour about (70,125,175)) with a thin horizontal rule.

## Row layout (source pixel y ranges, measured)

Every row is a horizontal band of frames read left to right. `title` bands
are text only and are blanked. Character faces RIGHT in every frame.

### moves.png
| row     | y band   | frames | notes |
|---------|----------|--------|-------|
| title   | 23-47    |        | blank |
| idle    | 68-248   | 9      | standing, breathing |
| title   | 276-300  |        | blank |
| run     | 318-481  | 10     | |
| jump    | 511-762  | 9      | an arc: squat, launch, rise, rise, apex, fall, fall, land squat, stand |
| title   | 790-815  |        | blank |
| crouch  | 829-989  | 9      | |

### defense.png
| row     | y band   | frames | notes |
|---------|----------|--------|-------|
| title   | 20-40    |        | blank |
| ledge   | 41-285   | 11     | frames 1..3 hang on the block, 4..10 climb; the grey ledge block is NOT part of the sprite (see "Ledge block" below) |
| title   | 314-335  |        | blank |
| dodge   | 362-514  | 10     | frames 3..7 are water blurs; 8..9 recover |
| roll    | 538-705  | 11     | frames 3..8 are tucked balls with water |

### ground.png
| row        | y band   | frames | notes |
|------------|----------|--------|-------|
| title      | 12-30    |        | blank |
| spikeShort | 45-159   | 6      | captions at 164-176 |
| title      | 187-205  |        | blank |
| spikeMed   | 217-326  | 7      | frame 4 is projectile only (no body); captions 333-344 |
| title      | 361-375  |        | blank |
| sweepF     | 386-495  | 6      | captions 501-512 |
| title      | 528-675 top part | | this band is the UPWARDS SWEEP title (y 528-545) glued to its row |
| sweepU     | 545-675  | 6      | captions 682-694 |
| title      | 709-724  |        | blank |
| spikeD     | 725-853  | 6      | captions are inside the band bottom (about 838-853) |
| spikeU     | 859-990  | 7      | title text at 859-880 top-left is glued to this band; captions 996-1006 |

### special.png
| row       | y band   | frames | notes |
|-----------|----------|--------|-------|
| title     | 14-36    |        | blank |
| wave      | 75-202   | 8      | captions 209-222 |
| title     | 259-280  |        | blank |
| whirl     | 289-464  | 7      | captions 465-482 are glued to the band bottom |
| aerials   | 527-973  | 2 blocks | split at x = 770. LEFT block = `uair`, 2 rows x 3 frames, read row-major (6 frames). RIGHT block = `dair`, 2 rows x 3 frames, row-major (6 frames). Titles at 527-548 and captions under each row are text. |

Frame counts above are the acceptance test: if a row yields a different count
the tool must print the row, the count and the detected x spans, and exit 1.

### extra.png (wave 3, see WAVE3_SPEC.md)
Blocks sit side by side in one band, split by thin vertical cyan lines, so each
row also has an x range. Blanked full-width y ranges: 10-34, 50-70, 207-221,
244-266, 414-432, 458-482, 750-766; rect y 500-520 x 545-705 (the "2. TORNADO"
title glued to the full tornado frame). Not cut: TSUNAMI SUMMON, LAUNCH and the
bottom cinematic row.
| row     | y band  | x range   | frames | notes |
|---------|---------|-----------|--------|-------|
| nair    | 72-205  | 0-494     | 5      | |
| fair    | 72-205  | 499-1022  | 5      | |
| bair    | 72-205  | 1028-1535 | 5      | |
| airjump | 268-412 | 0-477     | 4      | |
| dash    | 268-412 | 482-1022  | 3      | 0 dash start, 1 dash, 2 turn around |
| taunt   | 268-412 | 1028-1535 | 3      | 0 look around, 1 meditate, 2 smirk; taunt 0 is the scale reference |
| tornado | 505-748 | 545-1040  | 3      | FS victim inside the water; legs hidden, so anchor = bottom centre of the crop |

### uptilt.png (wave 3)
Blanked: y 838-870 (captions), rect y 148-185 x 0-975 (title + rule; the
extend frame's javelin at x >= 1040 rises past it).
| row   | y band | frames | notes |
|-------|--------|--------|-------|
| spike | 60-835 | 5      | wind up, lift, javelin rise, extend, recover; frame 4 (recover) is the scale reference |

Wave 3 sheets set `wave3` in the cutter, which turns on two extra steps (the
four wave 1 sheets do not use them, so their output is unchanged):
- Spanning pieces: in body segmentation a non-body piece (>= 300 px) whose x
  range covers two or more body centres is cut at its thinnest column between
  each pair of centres (frames are packed tightly and rings touch).
- Body union for the heel: the largest body component can be the upper body
  only (water rings cross the legs, legs are near-black ink). It is grown with
  the other ink-bearing non-water pieces inside its x range (+-8 px) within
  20 px vertically; "water" here is only strongly cyan pixels (g-r >= 40,
  b-r >= 60) dilated 1 px, because blue-lit leg ink passes the normal test.
Per-sheet scale for wave 3 comes from `scaleRef` (row, frame) instead of the
first frame.

## Algorithm

1. Foreground = pixels with max(r,g,b) > 28.
2. Background keying: flood fill from the image border over pixels with
   max(r,g,b) <= 28. Only that connected region is transparent. Dark pixels
   enclosed inside a sprite (coat ink, eye pupils) stay opaque. Before the fill,
   blank (set to black) every title band and every caption line listed above,
   plus any foreground connected component whose bounding box is <= 22 px tall
   and whose pixels are >= 60% text-cyan (r 40..140, g 100..200, b 150..230).
   Also blank horizontal rules: components <= 4 px tall and >= 60 px wide.
3. Ledge block (defense.png `ledge` row only): the grey stone block under the
   character is a near-uniform slate colour (about (50,55,80), low saturation,
   large rectangular component). Blank it: remove the connected component
   whose bbox is >= 60 px wide, >= 60 px tall and whose colour variance is low
   (std of r,g,b over the component < 18 each). Print what was removed.
4. Row bands: use the y ranges in the tables (do not auto-detect rows; the
   ranges are given). Inside a band, frames are the runs of columns that
   contain any foreground pixel, merged when the gap between runs is < 14 px.
   4b. Water effects in one frame often touch or overlap the next frame, so
   column runs can merge two frames. When a row's run count differs from the
   table, segment by BODY instead: body components (non-water, > 400 px) in
   the band, sorted by x; each is one frame. Each water component is assigned
   to the body whose bbox is nearest horizontally (ties: the body on its LEFT,
   because effects fly forward). A large water cluster with no body within
   40 px (spikeMed 4 "travel") becomes its own bodyless frame in x order.
   The special `wave` row has 8 frames, not 7 (an unlabelled frame sits
   between WIND UP and RELEASE). Never scale or repaint pixels beyond the
   step 8 resize: the crops must be the sheet's own pixels.
   For the `aerials` band, first split at x = 770, then within each half detect
   the two sub-rows by the y projection, then columns within each sub-row.
5. Per frame, compute two masks:
   - `water` = foreground where (b - r) >= 30, dilated by 2 px, intersected
     with foreground.
   - `body` = foreground minus water. Take the largest connected component of
     `body` (the character). Its bbox is the body bbox. If a frame has no body
     component larger than 400 px (spikeMed frame 4), the frame is
     `bodyless` and its anchor is its centre.
6. Anchor = (body bbox centre x, body bbox bottom y) = the heel point.
7. Scale. Per sheet, `scale = 48 / bodyHeight(first frame of the first
   non-title row)`. Standing height in the game is 48 px. Print the scale.
8. Output crop = the frame's full foreground bbox (body + water), padded by 2
   px, resized by `scale` with premultiplied alpha (`convert('RGBa')` then
   `resize(..., Image.LANCZOS)` then back to `RGBA`). Water pixels get alpha
   capped at 254 so the game's outline ring can tell water from body; body
   pixels that were fully opaque keep alpha 255.
9. Write each frame to `art/aeval/sheets/crops/<sheet>_<row>_<n>.png` (n from
   0) and a manifest `art/aeval/sheets/crops/manifest.json`:
   ```json
   { "sheetScale": { "moves": 0.27, ... },
     "frames": { "moves_idle_0": { "w": 40, "h": 52, "ax": 19, "ay": 50, "bodyless": false }, ... } }
   ```
   `ax, ay` are the anchor in output pixels relative to the crop's top-left.
10. Write a contact sheet `art/aeval/sheets/crops/CONTACT.png`: every row of
    every sheet on one image at 2x, dark grey background, each frame drawn with a
    1 px magenta dot at its anchor and its name in small text underneath.
    Also write one contact sheet per source sheet (`CONTACT_moves.png`, ...).
11. Extra fx crops (water only, body removed). For these frames also write the
    `water`-only crop (foreground minus the body component, tight bbox, centre
    anchor) to `art/aeval/sheets/crops/fx_<name>.png` and list them in the
    manifest under `"fx"`:
    | fx name      | source frame            |
    |--------------|-------------------------|
    | orb0         | ground spikeShort 1     | (the little orb at the hand)
    | orb1         | ground spikeMed 1       |
    | orb2         | ground spikeMed 2       | (the spike; fine as a wobble)
    | burst0       | ground spikeShort 3     |
    | burst1       | ground spikeShort 4     |
    | burst2       | ground spikeMed 5       |
    | crescent0    | special wave 4          | (water right of the body bbox only)
    | crescent1    | special wave 5          |
    | crescent2    | special wave 6          |
    | arrow0       | ground spikeMed 4       | (bodyless frame, whole thing)
    | hitspark0    | ground spikeD 4         |
    | hitspark1    | ground spikeD 5         |
    | hitspark2    | ground spikeShort 4     |
    | splash0      | ground spikeD 3         |
    | splash1      | ground spikeD 4         |
    | splash2      | ground spikeD 5         |
    | ko0          | ground spikeU 3         |
    | ko1          | ground spikeU 4         |
    | ko2          | ground spikeU 5         |
    | ko3          | ground spikeU 6         |
    | geyser0      | special uair 3          | (heel anchor, see below)
    | geyser1      | special uair 4          | (heel anchor, see below)
    | whirl0..3    | special whirl 1,2,3,4   |
    For `crescent*` keep only water pixels whose x is right of the body bbox
    right edge. For everything else keep all water pixels in the frame.
    fx crops use the same per-sheet scale.
    `geyser0/1` are not centre-anchored: `ax` = the body heel x of the same
    source frame in the fx crop's coordinates, `ay` = the bottom row of the
    water (the column's base). The manifest fx entry carries `"anchor": "heel"`.
    The renderer draws them at the heel point latched at the up-special launch,
    so the column stays at the takeoff spot while the body rises.
12. Body-only copies: `special_uair_3b` and `special_uair_4b` are the same
    source frames as `special_uair_3` / `_4` with every water pixel removed
    (body component, the dark ink touching it and pieces it encloses such as
    the eyes), same scale, heel anchor. `_3` / `_4` are still written as-is.

## Command line

```
python tools/sheetcut/cut.py            # copy inputs if missing, cut everything, write manifest and contact sheets
python tools/sheetcut/cut.py --sheet ground   # one sheet only
```
Pure Python 3.12 + Pillow + numpy (both installed). No other dependencies.
`scipy` is NOT installed: write the flood fill and connected components with
numpy (a BFS over a boolean array is fine; images are at most 2172x1024).

## Done means

- All four sheets cut, every row at the expected frame count, exit 0.
- `crops/manifest.json`, `crops/CONTACT.png` and the four per-sheet contact
  sheets exist.
- No source PNG in Downloads was modified.
- Report: the per-sheet scale, the frame counts per row, anything blanked by
  the text or ledge rules that looked wrong, and the path of the contact sheets.
