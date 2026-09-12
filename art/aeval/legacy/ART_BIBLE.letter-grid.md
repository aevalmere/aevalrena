# Aeval art bible

Canonical base poses. Everything else in the sheet is derived from these three
frames, never drawn from scratch. Frames are 32 wide x 40 tall, all facing
right; '.' is transparent, every other char is a key in
`src/characters/aeval/art/palette.ts`.

These were hand-authored pixel by pixel on a text canvas, not generated. The
canvases and the emitter sit next to this file (`canvas_front.txt`,
`canvas_side.txt`, `canvas_air.txt`, `emit.py`) if you would rather edit a
canvas than a TS array; `emit.py` adds the outline and rewrites
`base_frames.ts`.

Render check after every batch:

```
python preview.py <yourfile.ts> <EXPORT_NAME> out_<you>.png
python zoom.py 11 zoom.png      # large, white ground - judge the art on this
python zoom.py 4 small.png      # game scale - does it still read?
```

## The three base frames

### `base_front`

```
  base_front: [
    '............oho......oo.........',
    '...........ohho..o..ohho........',
    '..........ohhHo.ohoohhHo........',
    '........oohhhHoohhHohhHHo.......',
    '......oohhohhhHhhhhhhHHHHo......',
    '.....ohhhhhhhHhhhhhhhHHHHo......',
    '....ohhhhhbBBbbbbbbbbbHHHHo.....',
    '...ohhhhhbbbbbbbbbbbbbbHHHHo....',
    '...ohhhhhhhhHhhhhhhhHHHDDHHo....',
    '...ohhhHhhhHhhhhhhHhhHHDDHHHo...',
    '....ooHhhhHhhhhhhhhHhHDDHHDHo...',
    '......oohhhhhHhhhhhhHHDHDDHHo...',
    '......oohhhhHhhhHhhhhHDDDHoo....',
    '....oohhhhhHhhhhhHhhHDDHoo......',
    '...ohhHhhhHhhhhhhhHhhDDDoo......',
    '...ohHhhhhhhhshhhshhhsDDHDoo....',
    '...ohhhhhhDhssHssshhhsDDHHDDo...',
    '....oohhHhDhoooHsooossDDDHHDo...',
    '......oohHDseweHsewessDDHHHDo...',
    '......ooHDDseeessseeessDDDHo....',
    '.....ohHDDDppsssssssppDDooo.....',
    '....ohHDDDDppssspsssppDDo.......',
    '.....oHDDDDDssssssssDDDDDo......',
    '......ooDDDDsssssssDDDDDo.......',
    '.......oDDDooossssooDDDo........',
    '......ooooCccwwwwwwccCoooo......',
    '.....oCccoCcccwaawcccCoccCo.....',
    '.....oCccoCcccwAAwcccCoccCo.....',
    '.....oCccoCcccwwwwcccCoccCo.....',
    '.....oCccoCcccwwwwcccCoccCo.....',
    '.....oCccoCccccwwccccCoccCo.....',
    '.....owwwoCccccwwccccCowwwo.....',
    '....osssoCCccccwwccccCCossso....',
    '....osssoCcccccwwcccccCossso....',
    '....oCCcccccCCwwCCCCCCCCCCCo....',
    '....oCccccCottttottttoCcccCo....',
    '.....oCccCoottttottttoCcccCo....',
    '......ooooogggggogggggoccco.....',
    '..........ogggggogggggoooo......',
    '...........ooooo.ooooo..........',
  ],
```

### `base_side`

```
  base_side: [
    '.........oho......oo............',
    '........ohho..o..ohho...........',
    '.......ohhHo.ohoohhHo...........',
    '.....oohhhHoohhHohhHHo..........',
    '....ohhohhhHhhhhhhHHHoo.........',
    '...ohhhhhhhHhhhhhhhHHHHo........',
    '...ohhhhbBBbbbbbbbbbHHHHo.......',
    '...ohhhbbbbbbbbbbbbbbHHHHo......',
    '...ohhhhhhhhhhhhHhhhHHDDHo......',
    '...ohhhhhhhhhhhHhhhhHHDDHDo.....',
    '....oohhhhhhhhHhhhhHHDDDHHo.....',
    '......oohhhhhhhhhhHhDDDHHDo.....',
    '......oohhHhhhhhhHhhDDoooo......',
    '....oohhhHhhhhhhHhhhDDo.........',
    '...ohhhhHhhhhHhhhhhhDDoooo......',
    '...ohhhhhhhhHhhhhhHhsssssso.....',
    '....oohhhhhHhhhhhHhsssssso......',
    '......oohhHDhHhhhHssooossso.....',
    '......ooHHDDDHhhssssewessso.....',
    '.....ohHHDDDDHhhsssseeesso......',
    '....ohHDDDDDDHhhppssssppso......',
    '....ohHDDDDDDDhhssssspsso.......',
    '....oDDDDDDDDDDhssssssDo........',
    '....oDDDDDDDDDDDsssssDo.........',
    '....oDDDDoooooooossssoooo.......',
    '....oDDDoCCCccccwwwcccccCooo....',
    '.....ooooCCoCcccwaawcccCoccCo...',
    '........oCCoCcccwAAwcccCoccCo...',
    '.......ooCCoCcccwwwwcccCoccCo...',
    '.....ooCcCCoCcccwwwccccCoccCo...',
    '....oCcccCCoCcccwwcccccCowwwo...',
    '...oCccccCCoCcccwwcccccCossso...',
    '...oCcccccccCcccwwcccccCCssso...',
    '...oCCccccCCCCCwwCCCCCoooooo....',
    '...oCccCoottttotttttoo..........',
    '....oooo.ottttotttttooo.........',
    '........owwwwwwowwwwwwwo........',
    '........oggggggogggggggo........',
    '........oggggggogggggggo........',
    '.........oooooo.ooooooo.........',
  ],
```

### `base_air`

```
  base_air: [
    '............oho......oo.........',
    '...........ohho..o..ohho........',
    '..........ohhHo.ohoohhHo........',
    '........oohhhHoohhHohhHHo.......',
    '......oohhohhhHhhhhhhHHHHo......',
    '.....ohhhhhhhHhhhhhhhHHHHo......',
    '....ohhhhhbBBbbbbbbbbbHHHHo.....',
    '...ohhhhhbbbbbbbbbbbbbbHHHHo....',
    '...ohhhhhhhhHhhhhhhhHHHDDHHo....',
    '...ohhhHhhhHhhhhhhHhhHHDDHHHo...',
    '....ooHhhhHhhhhhhhhHhHDDHHDHo...',
    '......oohhhhhHhhhhhhHHDHDDHHo...',
    '......oohhhhHhhhHhhhhHDDDHoo....',
    '....oohhhhhHhhhhhHhhHDDHoo......',
    '...ohhHhhhHhhhhhhhHhhDDDoo......',
    '...ohHhhhhhhhshhhshhhsDDHDoo....',
    '...ohhhhhhDhssHssshhhsDDHHDDo...',
    '....oohhHhDhoooHsooossDDDHHDo...',
    '......oohHDseweHsewessDDHHHDo...',
    '......ooHDDseeessseeessDDDHo....',
    '.....ohHDDDppsssssssppDDooo.....',
    '....ohHDDDDppssspsssppDDo.......',
    '....ooHDDDDDssssssssDDDDDooo....',
    '...occccDDDDsssssssDDDDDossso...',
    '...occccDDDooossssooDDDoowwwo...',
    '....oCCcccCccwwwwwwccCooccco....',
    '...oCCccccCcccwaawcccCooccco....',
    '...oCCccccCcccwAAwcccCoccco.....',
    '...oCCccccCcccwwwwcccCccco......',
    '....oCCcccCcccwwwwcccCooo.......',
    '.....oCCccCccccwwccccCo.........',
    '......oCCcCCCCCwwCCCCCCo........',
    '.......ooootttttottttto.........',
    '.........oggggggoggggggo........',
    '........oggggggo.oggggggo.......',
    '.........oooooo...oooooo........',
    '................................',
    '................................',
    '................................',
    '................................',
  ],
```

## Row anchors

Read off the finished frames above. `base_front` and `base_air` share a
byte-identical head (rows 0..23); `base_side` shares the same vertical anchors
with the mass pushed back and the face pushed forward.

| Feature | base_front | base_side | base_air |
| --- | --- | --- | --- |
| Cowlick spikes (4, uneven lengths) | 0-4 | 0-4 | 0-4 |
| Hair crown | 4-5 | 4-5 | 4-5 |
| Hairband `b`, `B` highlight | 6-7 | 6-7 | 6-7 |
| Hair gap, upper left | 11-12 | 11-12 | 11-12 |
| Hair gap, upper right | 13-14 | n/a (face) | 13-14 |
| Widest hair (cols 3..28) | 16 | 15-16 | 16 |
| Fringe, first skin showing | 15 | 15 | 15 |
| Fringe tips + lid line `o` | 17 | 17 | 17 |
| Eyes `e` (2 rows only, half-lidded) | 18-19 | 18-19 | 18-19 |
| Eye glint `w` (1px per eye) | 18 | 18 | 18 |
| Hair gap, lower left | 18-21 | 16-19 | 18-21 |
| Hair gap, lower right | 20-21 | n/a | 20-21 |
| Blush `p` | 20-21 | 20-21 | 20-21 |
| Mouth (1px `p`) | 21 | 21 | 21 |
| Jaw | 22 | 22 | 22 |
| Chin + hair locks over the shoulders | 23 | 22-24 | 23 |
| Neck `s` | 24 | 24 | 24 |
| Collar `w` + shoulders | 25 | 25 | 25 |
| Torso, coat open, shirt strip | 26-31 | 26-31 | 26-29 |
| Cravat `a`/`A` | 26-27 | 26-27 | 26-27 |
| Cuff `w` | 31 | 30 | n/a |
| Hand `s` | 32-33 | 31 | 22-23 (raised) |
| Coat flare | 32-34 | 28-33 | 25-31 |
| Coat hem shadow line `C` | 34 | 33 | 31 |
| Coat hem, lowest coat row | 36 | 34 | 31 |
| Trousers `t` | 35-36 | 34-35 | 32 |
| Boots `g` | 37-38 | 37-38 | 33-34 |
| Ground contact (outline row) | 39 | 39 | none |

`base_air` ends at row 35 and never touches row 39: three rows shorter than the
grounded poses, with the boots splayed outward instead of hanging straight.
That height difference plus the splay is what makes it read as airborne once
the colours are stripped out.

## Column anchors

| Anchor | base_front | base_side | base_air |
| --- | --- | --- | --- |
| Head centre column | 15/16 | 14/15 | 15/16 |
| Torso centre column | 15/16 | 16/17 | 15/16 |
| Hair silhouette limits | 3..28 | 3..26 | 3..28 |
| Face skin block | 11..21 | 15..25 | 11..21 |
| Left eye `e` | 12..14 | hidden | 12..14 |
| Right eye `e` | 17..19 | 20..22 | 17..19 |
| Centre hair strand between the eyes | 15 | 15 | 15 |
| Torso fill | 10..21 | 10..21 | 10..21 |
| Shirt strip `w` | 14..17 then 15..16 | 16..19 then 16..17 | 14..17 |
| Coat lapels | 10..13, 18..21 | 10..15, 19..21 | 10..13, 18..21 |
| Arm/torso separator `o` | 9 and 22 | 11 and 22 | 22 |
| Far (left) arm | 6..8 | 10..12 | under the coat tail |
| Near (right) arm | 23..25 | 23..25 | 22..26 (raised) |
| Coat hem, widest | 5..26 | 3..22 | 7..22 |
| Left boot | 11..15 | 9..14 | 9..14 |
| Right boot | 17..21 | 17..22 | 18..23 |

Both arms attach at shoulder row **26**, one column outside the torso edge
(10..21), with a single `o` pixel at column 9 or 22 between arm and coat. At
this size the coat, the arms and the trousers are all near-black; that `o` is
the only thing separating them. Never omit it.

## How to derive a frame

Copy a base frame whole, then change only what the pose needs.

**Rows 0..23 are the character.** Do not redraw the head. Bob it, tilt it, or
shift it whole, and nothing else.

### Hair gaps: the rule everything else depends on
The 1px outline grows into every transparent cell touching a filled one, so a
notch shallower than 3 rows or narrower than 4 columns is eaten whole and
vanishes from the silhouette. Every gap in these frames is 4 rows tall with the
depth ramping 2 / 4 / 4 / 2, which leaves a 2x2 hole after outlining. Cut new
gaps that size or they will not exist. Check by rendering the frame as a solid
fill and looking only at the outline.

### Bob the head 1px (idle, breathing, landing squash)
Shift rows 0..24 down one, insert a blank row at the top, delete one torso row.
Rows 28 and 29 are identical, so deleting one is invisible and the feet stay on
row 39.

### Raise an arm
Walk the 3-wide arm up and out one pixel per row, then a `w` cuff two rows past
the last coat pixel and an `s` hand two rows past that. `base_air` does exactly
this on the right:

```
row 28: cols 22..24   row 27: 23..25   row 26: 24..26
row 24: cuff 25..27   rows 22-23: hand 26..27
```

The hand must clear the hair. Hair reaches column 27 down to row 18 and only
column 24 by row 23, so a raised hand lands at rows 22-23 or lower, never
higher, or it disappears into the cloud.

To extend an arm forward (punch, cast), run it horizontally out of rows 27-28
to column 26, cuff at 27, hand at 28.

### Hair streaks
Light comes from the upper left: `h` upper-left, `H` through the middle, `D`
lower-right and in the recesses beside the face. Place them as short segments,
not as a gradient band and not as long lines:

- **3-5 rows per segment, never more.** A longer run reads as combed length.
- **Angle each segment away from the crown**, one column per row: segments left
  of column 15 step down-left, segments right of column 15 step down-right, and
  segments in an outer lobe follow that lobe's bulge. `base_side` is swept back,
  so every segment there steps down-left.
- **Never let two segments be collinear and adjacent.** Two 3-row streaks that
  line up merge into one 6-row line and the problem comes straight back. This
  is easy to do by accident; check it by scanning each diagonal for runs of
  `H`/`D`.
- **Stagger the start rows** so no two neighbouring segments begin on the same
  row, and leave flat `h` between them. The stagger is what reads as clumping.
- The whole right flank sitting in `H`/`D` is a shadow region, not a streak,
  and is fine as a solid mass.

### Sweep the coat
The coat is a per-row left/right edge table and nothing more. Back-sweep (walk,
run, side attacks), taken from `base_side`:

```
row 29: 8..22   row 30: 6..22   row 31: 6..21   row 32: 7..20   row 33: 9..19
```

Up-sweep (jump, aerials) is the same table climbing instead of widening, as in
`base_air` rows 25..31, which leaves the hem at row 31, five rows above the
standing hem. Fill `c`, then repaint the outermost two columns `C`. Step the
trailing edge in and out by one across consecutive rows: a smooth arc reads as
a rubber cape, a stepped one reads as cloth.

### Crouch
Delete two torso rows (26..31 repeat) and two flare rows, push rows 0..24 down
four, widen the flare one column each side. Boots stay on 37..38 with the
outline on 39; trousers compress to row 36 only. The head must not shrink: a
chibi crouch is the head coming down, not the head getting smaller.

### Turn (front to side and back)
Do not redraw. Take `base_front`, move the hair's right edge in three columns
and drop the right-side gaps, then swap in the side face: one eye at 20..22,
the far eye deleted, skin extended one column past the hair at row 18 for the
nose. Move the torso two columns right relative to the head. That offset is
what sells the turn.

### What breaks the character
- A smooth hair edge. The gaps at rows 11-12 and 18-21 on the left, 13-14 and
  20-21 on the right, are not decoration; without them the head fills to a
  mushroom when solid.
- Symmetry. Left and right gaps sit on deliberately different rows. Keep them
  different.
- Opening the eyes. `e` is two rows tall with a solid `o` lid on row 17 above
  it and the fringe over that. Three rows of `e` makes her wide awake, and she
  is not.
- A dashed hairband. Rows 6-7 are a continuous run of `b`, with `B` only on the
  upper-left few pixels where the light hits.
- Hair narrower than the shoulders. Hair spans 3..28, the body 5..26. Keep that
  four-column margin in every frame.
- Long shading streaks. This is the one that will bite you. Run an `H` or `D`
  line down more than about five rows and Aeval reads as having long straight
  hair, which fights the short fluffy silhouette and wins. Keep every streak to
  a 3-5 row segment (see "Hair streaks" above).
- Adding palette keys. The sixteen in `palette.ts` are the whole vocabulary.

## Note on coat and trouser values

Measured relative luminance: `o` 15, `C` 29, `t` 37, `c` 53, `g` 150, `w` 216.

Trousers and coat are only 16 apart out of 255, so `t` against `c` cannot carry
the boundary on its own at this size. What separates the legs from the coat is
the 1px `C` line along the coat's bottom edge where the legs emerge (front row
34, side row 33, air row 31), with the shirt-strip columns left as `w`. Keep
that line in every derived frame; if you move the hem, move the line with it.
If the legs ever need to read on their own without it, `t` has to move lighter
in the palette, which is an owner decision, not something to fake with outline.
