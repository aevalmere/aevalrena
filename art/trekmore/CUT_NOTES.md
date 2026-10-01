# Trekmore cut notes (W0-art, 2026-09-30)

Tool: `tools/sheetcut/cut_trekmore.py`, map: `art/trekmore/cutmap.json`, output: `art/trekmore/sheets/crops/`
(crops, `manifest.json`, `CONTACT_<sheet>.png`, `CONTACT.png`, `CONTACT_fx.png`), log numbers in
`art/trekmore/sheets/cut_report.json`. Rebuild everything with:

```
python tools/sheetcut/cut_trekmore.py --measure --preview
python tools/sheetcut/pack.py --char trekmore
python tools/uicut/portrait.py --char trekmore --src art/trekmore/sheets/crops/loco_idle_0.png
```

Target: standing body 55 game px (heel to helmet crest), heel anchor (body mask bottom row, x = median x of the
lowest fifth of the body so the cape and sword do not make idle loops jitter). Sword calibration on `loco_idle_0`:
pommel (209,146) to tip (258,202) = 74.4 px x 0.47826 = SWORD_LEN 35.59 game px (plan expected about 36).

## Keying (applies to every sheet)

The plan's border flood over dark pixels was tried first and rejected: the armour ink is as dark as the
background and reaches it through crevices, so the flood punched holes through the torso at every threshold
from 12 to 24 (checked on heavy_slash, locomotion and parry_counter). The cutter builds a silhouette envelope
instead: strong pixels (clearly unlike the background), closed by 3 px (5 px on neutral_special), holes filled,
then only background-exact pockets are keyed back (black sheets: max <= bg + 1 and mean max < 10, at least 40 px;
locomotion keeps all pockets because its background (10 to 12) is brighter than its armour ink). Navy and grey
backgrounds use colour distance to the local background plus a violet test (red > green; the navy and checker
backgrounds have red <= green), then a 3x3 mask median, specks under 6 px dropped and a 1 px erosion. JPEG sheets
get a 3x3 RGB median first. Glow pieces farther than 6 px from the body are capped at alpha 254 (like Aeval's
water) so an outline ring would skip slash arcs.

## Per source image

| Source | Mode | Cut | Scale (source px to game px) | Rejected / notes |
|---|---|---|---|---|
| `locomotion.png` | black | idle 8, walk 10, run 7, dash 3 | stand 55/115 = 0.47826 (loco_idle_0); sword is the calibration | Titles sit outside the row bands. run and dash overlap (cape trails), split by body cores. |
| `jump_fall_airdash.png` | black (alpha ignored) | jump 10, fall 10, stepR 8, stepL 8 | sword 35.59/76.0 = 0.46822 (air_fall_0, sword vertical) | No standing frame, so no cross check. Titles and "(RIGHT)/(LEFT)" blanked by rects. Step rows split from measured body centres (cores merged frames 2 and 3). |
| `heavy_slash.png` | black | slash 6 | pose 44.8/145 = 0.30916 (heavy_slash_0 matched to parry_counter_0); sword 0.30998; agree 0.3 percent | Core segmentation merged frames 1 and 2 and split the crescents, so explicit cells are used (the cells do not overlap). Captions sit outside the band. |
| `shadow_step.png` | black | ground 8, front 12, side 10, strike 4 | ground and side: sword 35.59/62.5 = 0.56957, pose vs loco_dash_0 0.56366 (1.0 percent); front: stand 55/110 = 0.5 (step_front_0, drawn larger than the ground row); strike: sword 35.59/93.2 = 0.38172 (row scale, drawn larger) | Rows 1 to 3 split from measured body centres, grown geodesically through the mask. Row 3 frames 7 and 8 share one crescent (side_6, side_7). The number glyphs under the strike row blanked by rects. |
| `parry_counter.png` | black | parry 4, counter 9 (6 + 3 concatenated) | stand 55/146 = 0.37671 (parry_parry_0); sword 0.40691 | Stand and sword disagree by 8.0 percent: this sheet draws the sword longer relative to the body than locomotion.png (re-measured; the guard-to-tip length gives a worse 14 percent). Stand is used and `allowDisagree` records why. Counter line 1 uses cells because the arc of frame 5 bled into frame 6. |
| `up_special.jpeg` | checker grid 5x4 | g 0..19 | stand 55/188 = 0.29255 (uspec_g_11, heel to helmet crest y 718; the raised sword above the helmet excluded) | Grid lines found on the unfiltered image (the median erases 1 px lines). Number boxes painted with the cell background. |
| `neutral_special.jpeg` | navy grid 5x4 | g 0..19 | stand 55/223 = 0.24664 (nspec_g_0) | The dark cloak is within 7 levels of the navy; the violet test plus a 5 px closing keeps it solid. Cells 9 to 14 (dissolve) come out as solid dark smoke blobs, which is how they read at 55 px. |
| `clone_slashes.jpeg` | navy grid 5x4, split top / shadow | top 0..19, shadow 0..19 | pose 44.8/110 = 0.40753 (clone_top_0 vs heavy_slash_0) | Reference only, nothing mapped (plan). Top grid line is the image edge. |
| `concept_a.png` | navy rows | idle 4, slash 3, summon 4, aerial 1, erupt 2, cloneIdle 3, emerge 3, hands 1 | idle panel 55/153 = 0.35948; attack panel: slash pose 0.70045 (vs heavy_slash_0), summon stand 55/81 = 0.67901, aerial and erupt share the slash scale; cloneIdle 0.40441; emerge and hands 0.42636 | Normal Slash has 3 figures, not 4 (the fourth "frame" is the crescent held by figure 3). Emerge cells are a giant helmet mask, a half figure and smoke: not full body, so taunt3 uses the plan fallback cloneIdle. Shadow Hands is one composition, not 3 frames, and reads as a smoke blob at game scale: rejected for grab. Summon clones are hollow outlines; pockets of 60 px or more keyed inside them. |
| `concept_b.png` | navy rows | hero 2, idle 7, taunt 4, slash 4, ranged 3, aerial 3, hitLight 3, hitStrong 4, ledge 5 | idle 55/93 = 0.59140; taunt 55/79 = 0.69620 (taunt_3, upright); slash, ranged, aerial, hits, ledge share the taunt scale | Pose matching on the 40 to 60 px panel sprites was unstable (0.7x to 1.45x), so the small panels share one scale. Ledge: the grey slate blocks removed (rim rows blanked, low-chroma block pixels dropped, largest piece per cell kept). Underline rules clipped by band limits. Title text blanked on the hero row. Wall cling, walk, run, dash, jump, fall, land, heavy slash rows not cut (plan: unused or backups). |
| `pixler/downed_raw.png` | alpha | downed 1 | fit width 60/96 = 0.625 | Failed the A.5 gate, see below. |

## fx (plan A.6)

shadowSword0..1 = nspec_g_5, 6 (bodyless cells). shadowBurst0 = conA_erupt_0 violet pieces, 1 = parry_counter_5
eruption, 2 = parry_counter_6 eruption (both clipped to the eruption, body removed), 3 = burst 2 at half alpha;
ordered small to large so it reads as a growing burst. swordRise0..2 = the sword alone in uspec_g_3, 4, 5, clipped
above the hand, anchored at the source frame's heel (world anchored, like geyser). stepTrail0..1 = step_front_3, 4.
counterFlash1 = parry_parry_2 arc and flare with the body removed; 0 = 70 percent scale, 2 = half alpha.
hitspark1 = heavy_slash_3 crescent tip fitted to 24 px; 0 = 16 px; 2 = 24 px at 45 percent alpha. ko0..3 =
shadowBurst0..2 at 1.5x (ko3 = ko2 at half alpha). Derived frames only rescale or fade cut pixels.

## Pixler (plan A.5)

One still generated (quota 5 to 4): "downed", 96x48, prompt with the measured palette. Gate
(`pixler/downed_gate.png`, `downed_gate.json`): glow hue 270 in band (pass, but only 51 px: the visor), body hue
236 against the cloth band 261 to 289 (fail: blue-grey armour, not violet), ink outline on 49 percent of the edge
(fail, needs 70), crisp 0 percent partial alpha (pass), height 22 of 22 (pass), helmet and cape readable (pass).
Verdict: FAIL, the fallback kneel uspec_g_18, 19 ships for downed. crouch and tumble were not generated: their
reuse crops are not broken on the contact sheet (crouch changed its first frame, see below).

## Frame pick changes against plan A.4

- crouch: parry_counter_0, parry_counter_8 (plan 7, 8). counter_7 carries a wide smoke smear at game scale.
- ftilt: conA_slash_0..2 with holds 7, 6, 25 (38, hit at 13 on the crescent frame): only 3 figures exist.
- taunt3: conA_cloneIdle_0..2, holds 20, 20, 50: plan fallback, emerge cells are not full body.
- grab, grabHold, pummel: parry_parry_0 / parry_counter_0 / parry_counter_8 instead of conA_hands_0..2 (one
  composition, not three frames).
- downed: uspec_g_18, 19 (plan fallback; pixler failed the gate).

## Palette measure

`palette_measure.json` (from the side-view crops). Glow band hue 263.9 to 289.0, cloth band 261.2 to 288.9 (s >= 0.2,
l 0.10 to 0.35). Five hex values: #0a040f #190c24 #261337 #351b4b #522c75. Aeval (moves_idle_0, hue 180 to 260,
s < 0.35): hair region lightness 0.51 to 0.77 (p5 to p95), coat 0.18 to 0.72, so a coat band capped at l 0.45 would
still catch part of the hair's darker strands; hair lightness p50 0.69 sits above the coat p50 0.46.

## UI art

`public/icons/trekmore.png` (256 tile, loco_idle_0 at 3x nearest), `trekmore-bust.png` (46x31, helmet to belt),
`trekmore-stock.png` (18x18, helmet only), `public/ui/trekmore-win.png` (46x50: conB front hero, rendered from the
source at 0.13736 to Aeval's win pose height of 50).

## Polish wave (2026-09-30, docs/TREKMORE_POLISH.md)

Rebuild as above, plus the size strip from the current crops:

```
python tools/sheetcut/cut_trekmore.py --size-strip art/trekmore/qa/SIZE_STRIP.png
```

`qa/SIZE_STRIP_before.png` is the same strip from the crops before this wave. Each line has the 55 px standing guide
(magenta), heels on the baseline (cyan dot), and the crop's body-scale factor under its name.

### Body size

The body metric covers only the dark armour core: helmet width, torso width and helmet-to-hip length. The sword,
the glow and the cape spikes are left out. It is compared against loco_idle_0 (55 px standing). Automatic metrics
turned out to depend on pose: torso thickness varies 20 percent inside loco_walk alone, and core area changes with
how much of the armour a sheet paints as glow. So each row was checked by eye against loco_idle_0 on a 5 px
grid at 3x, using factor ladders (0.8 to 1.55), with the rigid sword as a cross check. The chosen factor multiplies
the sheet or row scale in the cutter (`bodyScale` per row, `bodyScaleFrames` per frame in cutmap.json), and the
manifest records it per crop (`bodyScale`). The heel anchor is still the body mask's lowest row, so it does not move.
fx cut from a scaled row get the same factor.

| Row | Factor | Why |
|---|---|---|
| conB slash, ranged, aerial, hitLight, hitStrong, ledge | 1.30 | These panels draw the knight smaller than the taunt panel they took their scale from (likeRow). At 1.3 the helmet and torso match loco, and the sword measures about 36 px, as on loco. |
| conA slash | 1.25 | The pose match to heavy_slash_0 left the body about 20 percent small. |
| step strike | 0.90 | The backstrike row is drawn larger. Its own sword scale left the body about 10 percent big. |
| step side 5..8 | 0.88 | The reappearance frames are drawn about 12 percent larger than the rest of the row. |

Every other row stays at 1.0. The rows calibrated on standing height (loco, parry, nspec, uspec, conB idle and
taunt, conA idle and cloneIdle, step front) and air (sword scale) already agree by eye. The uspec crescent frames
12 to 17 look big only because of the arc; the body inside them matches.

### Crop fixes

- conB hitLight: the band was raised from y 751 to 741 because the helmets of all 3 frames were cut. The
  "HIT (LIGHT)" title is blanked with a rect.
- conB ledge: the cells were re-measured to each hanging figure's own columns. The old cells cut off the right
  side of every figure and kept the slate block's left pillar. The ledge block removal now also puts back small
  enclosed pinholes, because the grey test had punched see-through dots into grey armour highlights.
- conA slash: this row now splits by body centres grown through the mask instead of fixed cells. slash_0 no longer
  carries the tip of slash_1's sword, and slash_1 no longer carries a piece of slash_2's cape.
- All body crops: specks that would be under 4 game px² and sit more than 4 game px from the body are dropped
  (`drop_far_specks`). Larger smoke tatters drawn by the owner are kept.
- Unfixable items are listed in `NEEDS_REDRAW.md`: the ledge block, the nspec dissolve blobs, and the small
  concept sprites, which are upscaled.

### sheetmap

The frame budget table in the polish contract is applied exactly: utilt, usmash, usmashCharge and uair are the
crescent swing uspec_g_12..17; nspecial is nspec_g_0, 2, 3, 4 (3,3,3,13), and nspecialCharge is removed; uspecial
has 12 frames summing to 56, with uspec_g_7 as the hidden placeholder; dspecial is parry_parry_0, 1, 2, 0
(3,3,25,25); dspecialBranch is parry_counter_1..8 (6,4,2,2,4,4,8,14). No anim uses parry_parry_3. The counterFlash
fx anim and its cuts are removed at the owner's request.

### New fx (cutmap `_fx`, sheetmap `fx`, one anim each)

| fx | Source | Game px | Note |
|---|---|---|---|
| swordUp0, 1 | uspec_g_4, uspec_g_5 sword clips | 15x33, 12x39 | point up, centre anchor, loop 4,4; swordUp0 clipped above the hand |
| pShard0..3 | parry_parry_3 flying armour fragments (3), parry_counter_5 eruption fleck | 3 to 8 | `keep: pieces`, largest piece in the clip |
| pSmoke0..2 | parry_counter_7 and 8 detached cape tatters | 10 to 16 | pSmoke2 fitted to 16 |
| pSmoke3 | nspec_g_11 dissolve wisps | 14 | `softAlpha`: alpha from the distance to the cell background (keying, no new pixels), so the faint smoke stays faint |
| pMote0, 1 | conB_hero_1 bright violet glints | 3 to 4 | |
| pSliver0..2 | parry_counter_2, 3, 4 thin arc tails | 8 to 20 | |
| pSpike0, 1 | parry_counter_5 central spike, parry_counter_6 side spike | 24, 20 tall | fitted |

Each particle is one frame, holds 60, loop. Sizes include the 2 px render padding. pack.py writes them into
TREKMORE_FX_ANIMS. pack.py itself is unchanged. Re-packing Aeval gives byte-identical atlases, but its committed
anims.ts has fps values that the current pack.py does not reproduce (uair 7/6, dair 10/12, nspecial 10/25, sspecial
9/12). This predates this wave, so the committed file was kept.

### QA follow-up (same day)

- **Duplicate swords.** The cutmap `_derived` list makes body crops from a source frame with cut pixels erased.
  Scale and heel anchor stay the same as the source.
  - `uspec_g_2_nosword` (`bodyOnly`) drops the detached thrown sword. uspecial uses it, so the swordUp projectile
    is the only sword from frame 8.
  - `nspec_g_4_nosword` erases the blade right of x 1292, which is the hand. The empty arm reads as a cut-off
    stump when held, so nspecial (SIM holds 3,3,3,25 = 34) is now nspec_g_0, 2, 3, nspec_g_4_nosword, nspec_g_14
    with holds 3,3,3,10,15. nspec_g_14 is the reformed, sword-less front stance.
- **Colour.** Per sheet, the opaque body pixels were measured in source pixels (lightness median L50, saturation
  median S50, hue median):

  | Sheet | L50 | S50 | Hue |
  |---|---|---|---|
  | loco | 0.135 | 0.33 | 274 |
  | air | 0.129 | 0.50 | 275 |
  | heavy | 0.133 | 0.79 | 270 |
  | parry | 0.104 | 0.89 | 271 |
  | step | 0.108 | 0.80 | 268 |
  | uspec | 0.110 | 0.63 | 262 |
  | nspec | 0.057 | 0.63 | 257 |
  | conB | 0.106 | 0.52 | 266 |
  | conA | 0.116 | 0.55 | 260 |

  The locomotion and air sheets read as greyer, lighter lavender mainly because their saturation is low. The
  target is the attack sheets (heavy, parry, step, uspec) pooled, from `--colour-target`: L50 0.110, S50 0.75,
  hue 267.
- **Recolour pass** (`_colour` in cutmap.json):
  - Lightness goes through a percentile-matched curve (1, 10, 25, 50, 75, 90, 99).
  - Saturation is scaled by the median ratio, capped at 0.6 to 2.0. This leaves loco at 0.65.
  - Coloured pixels get a hue shift.
  - It runs after keying, so masks and glow tests use the source colours. fx cut from a recoloured sheet carry
    the same colours. `--no-recolour` skips the pass.
- **QA files.** `qa/COLOUR_STRIP.png` shows the same 19 frames before (top) and after (bottom). The portrait,
  icons and win pose are regenerated from the recoloured crops.

## Round 2 (2026-09-30 evening, docs/TREKMORE_POLISH.md "Round 2")

New sheets in `cutmap.json`: `dk` (dark_knight.png: light, strong, dead, 7 each), `vk` (violet_knight.png: dash 11,
ledge 11, climb 10) and `twin` (twin_strike.png: 2 frames, row name "" so the crops are `twin_0`, `twin_1`). All black
backgrounds; the captions sit outside the row bands except LEDGE HANG, which is blanked by a rect. dk_light uses cells,
dk_strong, dk_dead and vk_dash use measured body centres (the cape, sword and smoke join neighbouring frames).

| Sheet | Scale | Body factor |
|---|---|---|
| dk | stand 55/150 = 0.36667 (dk_light_0, the new side-view standing reference) | 1.0 |
| vk | stand 55/122 = 0.45082 (vk_climb_9, standing on the ledge top) | 1.0 |
| twin | pose against vk_dash_3 = 0.10937 | 1.2 (the pose match on the whole lunge left the body about 20 percent small) |
| loco run, dash | unchanged sheet scale | 0.9 (new) |

**Run and dash.** Inside locomotion.png the run sword (guard to tip) is 74 source px against 70 on idle_0, and next to
dk_light_0, vk_dash_0 and heavy_slash_0 the run and dash helmets and torsos read about 10 percent big, so both rows get
bodyScale 0.9. The turn anim is loco_idle_0, which is the 55 px reference itself and matches dk_light_0; it is not
changed. `qa/SIZE_COMPARE_R2.png`: idle, run, dash, turn (idle_0), dk_light_0, vk_dash_0, heavy_slash_0 on one
baseline at 3x with the 55 px guide. `qa/SIZE_STRIP.png` is regenerated.

**Pillar removal** (`remove_pillars`, row `pillars` {idx: [eraseFromX, lipY, cornerX, eraseToX]}). Each ledge and
climb figure hangs from a dark stone pillar drawn to his right: very dark blue-violet (hue 250 to 260) with a bright
lip line on top; the knight is hue 266 and up. Everything from eraseFromX to eraseToX (the pillar plus its lip
overhang) from the lip row down is erased, except knight-hue pixels below the lip that connect to the knight outside
the zone (his chest and knees in front of the pillar's left face: 535 px kept on the ledge row, 184 on the climb
row). The hands rest above the lip and are untouched. The lip rows were set one row above the brightest lip row so
no lip line stays under the feet.

**Ledge anchors** (`ledge_anchors`). The sim holds a hanging or climbing fighter at (corner x, ledge top + 20)
(LEDGE_HANG_DROP), and the renderer draws the anchor there. So the anchor is the source corner moved 20 game px down
and the hands land on the stage corner. cornerX is the pillar's left edge on the ledge row. On the climb row it is
the right edge minus 42 (the hang width), because the drawn top slab widens as he climbs. vk_ledge_0 has no pillar;
its corner comes from the reaching hand (`corners`). The climb row `settle` slides the anchors of frames 4 to 9 so
the last heel stands 14 px inside the corner (CLIMB_INSET), where the sim puts him at the end of the 30-frame
climb (slide -22.7 game px). ledgeatk starts on the stage, so `vk_climb_7_stage` and `vk_climb_8_stage` are
`_derived` copies with `heelAnchor`.

**fx.** pSmoke4 and pSmoke5 are the rising smoke wisps of dk_dead_5 and dk_dead_6, clipped above the heap and fitted to 16 px.

**sheetmap** follows the Round 2 frame table: utilt, uair, usmash and usmashCharge use the sword column (the original
uspec_g_2 with its sword). fair is heavy_slash, dair is parry_counter, nspecialCharge is the aim hold, and dashatk is
vk_dash + twin. ledgeGrab (new), ledgeHang and ledgeClimb (3 x 10 = 30 = CLIMB_FRAMES) come from the new sheet, as do
the hits, tumble, downed and getUp (15 + 15 = GETUP.total). dead is dk_dead_0..6 with holds 3,4,5,6,8,10,24 = 60 (sim
DEAD_FRAMES). grabbed, footstooled and fsVictim use dk frames. uspecial keeps the crescent swing and the nosword
frames. `src/characters/trekmore/sprites.ts` maps the ledgeGrab action to the ledgeGrab anim.

## QA round 2 and round 3 fixes (2026-10-01)

- **parry_counter line 1:** the row is now 425..685 and is split from measured body centres instead of cells. The
  cells had cut the arc of counter_4 flat at the top and right, and the eruption of counter_5 flat at the left and
  bottom. The DOWN SMASH caption and the frame numbers are blanked by rects. A detached arc tail of counter_4 had
  grown into counter_5; the new row `reassign` option gives it back to counter_4 (3429 px), so nothing is clipped.
  counter_6 was already whole: its flat base is the drawn ground glow.
- **vk_climb_0:** the CLIMB caption underline is blanked by a rect.
- **vk_climb / vk_ledge feet:** the keying closing had bridged the gap rows between the soles and the pillar lip
  into a flat strip. Non-ink pixels in the 4 rows above each lip now go with the pillar.
- **twin_1:** a row `glowBoost` raises the lightness (x1.35) and saturation (x1.25) of the glow pixels (l >= 0.28,
  s >= 0.3) after the recolour. Hue and pixel positions are unchanged.
- **conA_aerial_0** is the round 3 utilt / uair / usmash hit frame. Its band ends above the panel rule, 40 px pockets
  are keyed (the cape and arc loop had filled solid), and it gets bodyScale 0.8. The figure has no standing heel, so
  it has a fixed ground anchor (`anchors`, 1262, 734) under the body at the arc base. It is listed in NEEDS_REDRAW.
- **fx:** pSpike2 and pSpike3 are the central and right spikes of the concept_a eruption panel (conA_erupt_0).
- **sheetmap:**
  - utilt: parry_counter_0, parry_counter_1, conA_aerial_0, heavy_slash_5, loco_idle_0 (6, 7, 8, 9, 8).
  - uair: heavy_slash_0, parry_counter_1, conA_aerial_0, air_fall_0 (8, 8, 8, 18).
  - usmash: parry_counter_0, heavy_slash_0, parry_counter_1, conA_aerial_0, heavy_slash_5, loco_idle_0
    (10, 5, 6, 8, 14, 13).
  - usmashCharge: parry_counter_0 held.
  - nspecialCharge: nspec_g_4_nosword (6), then nspec_g_14 held, so no drawn sword while aiming.
  - dashatk: vk_dash_7 removed (vk_dash_0..3, twin_0, twin_1, vk_dash_8..10; 2, 2, 2, 3, 2, 8, 10, 6, 9).
- **Upsweep follow-up:**
  - **Facing:** in concept_a the figure faces right. The sword sweeps down in front of him; the big crescent shape on
    the left is his cape loop. At game size that loop is what reads as "the swing". The owner wants it in front, so the
    anims use `conA_aerial_0_r`, a mirrored `_derived` copy (`flip`). The anchor x is mirrored with it, so the ground
    point stays under the body.
  - **Hollow body:** this came from ending the band above the panel rule. That opened the keying envelope, so the dark
    painted cape and armour fell out as background. The band is back to 745 with the default pockets, and the rule rows
    are dropped after keying (`maskY1` 736). The cell starts at 1148 so the cape tip (x 1162) is no longer clipped.
- **Owner decision (later the same day):** utilt, uair, usmash and usmashCharge are back on the round-1 crescent
  swing (uspec_g_12..17, as drawn). The round-1 tables are restored. conA_aerial_0 and conA_aerial_0_r are still cut
  but no anim uses them, and the upsweep entry is gone from NEEDS_REDRAW.md.
