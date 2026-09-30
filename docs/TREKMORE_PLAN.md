# Trekmore plan: second fighter, shadow knight of Moonanchor

Status: plan, 2026-09-30. Owner of this file: the lead. Workers read the sections named in their wave card (section F) and nothing here is
optional unless marked "choice".

Trekmore is a soul knight and royal guard of Moonanchor: heavy, slow, big single hits, a shadow clone that repeats his basic attacks, a
counter, a teleporting sword throw and a shadow step. He is purple and black. He must end equal in strength to Aeval (section F, W4).

Hard boundaries for every worker in this plan:

- `src/ai/**` belongs to the brain worker until it reports done. Nothing in W0 to W2 edits it. W3 starts only after the lead confirms the
  brain worker finished.
- `src/net/**` and `src/ui/lan.ts` belong to the LAN worker. No wave here edits them. Every API change in this plan is additive with a
  default that keeps `lan.ts` compiling unchanged.
- Aeval's art pipeline (`art/aeval/**`, `tools/sheetcut/cut.py`, `cut_orb.py`) is not edited. `pack.py` gains a `--char` flag with `aeval`
  as the default so its Aeval output is byte identical.
- Never redraw owner art. Crops are cut, scaled, retimed, mirrored, tinted or composited. The only new pixels allowed are the pixler
  generations in A.5, and only after their quality gate.

---

## A. Art

### A.1 Source images and verdicts

All ten images now live in `art/trekmore/source/` (copied from the owner's OneDrive folder, which is no longer referenced). All are AI
generated, drawn at different scales, facing right, on black or near-black. Measured sizes below; the verdicts were made by opening each
image.

| File | Size | Verdict | Used for |
|---|---|---|---|
| `concept_a.png` | 1536x1024 RGB | Concept sheet, small sprites (60 to 90 px tall), caption text and panel rules. Usable after text and rule blanking. | Palette measurement; helmet reference; hero figure (left) for the select tile backdrop; rows used: normal slash (ftilt), shadow clone summon (taunt2), shadow form emerge (taunt3), shadow hands (grab, grabHold, pummel), spike eruption (burst fx), aerial arc (fair fx). Idle/walk/run rows are not used (the large sheets win). |
| `concept_b.png` | 1536x1024 RGB | Concept sheet, small sprites in labelled panels. Cleaner than A. Usable after panel border and text blanking; the ledge grab row has a grey wall block to remove (same job as Aeval's `blank_ledge_blocks`). | Front hero figure (top left, about 360 px tall) for the results win pose and bust; rows used: normal slash (jab), ranged/charge (dash attack), aerial attack (fair), hit light, hit strong, taunt, ledge grab (ledgeHang, ledgeClimb, ledgeatk start). Jump/fall/land rows are backups only. Wall cling is unused (no wall mechanic). |
| `locomotion.png` | 1774x887 RGB | Clean, large (body about 120 px tall), side view, generous gaps. Best reference for scale. | idle (8), walk (10), run (7), dash (3); scale reference `loco_idle_0`; portrait and stock icon source. |
| `jump_fall_airdash.png` | 1774x887 RGBA | Clean, large, side view. RGBA with an opaque black background: key it like the others, do not trust its alpha. | jump (10), fall (10), aerial shadow step right (8, air sspecial), aerial shadow step left (8, bair). |
| `heavy_slash.png` | 1774x887 RGB | Clean, large, one row of 6, numbered captions under each frame. The crescent in frames 4 and 5 is wider than the body; cells do not overlap. | fsmash (6), fsmashCharge, throwF/throwB, ledgeatk slash. |
| `shadow_step.png` | 1774x887 RGB | Large; four rows with titles. Rows 1 to 3 pack frames tightly and their shadow trails touch the next frame, so column runs will not separate them: segment by body (the Aeval `segment_by_body` plus `split_spanning` approach). Row 3 frames 7 and 8 sit inside one crescent. The 4-frame backstrike row is drawn at a larger scale than the other rows. | Row 1 ground shadow step (8, reference only, not mapped); row 2 teleport front view (about 11 to 12, roll, airDodge, techRoll, getUpRoll, step trail fx); row 3 teleport side view (about 9 to 10, ground sspecial); row 4 backstrike slash (4, sspecial strike). |
| `parry_counter.png` | 1536x1024 RGB | Clean, large, captions and numbers under each frame. The counter row wraps: 6 frames on line 2, 3 on line 3; the cutter concatenates them as one row of 9. | Parry (4: shield, dspecial stance), down smash counter (9: dsmash, dspecial counter branch, crouch reuse, dtilt, getupatk, throwD), counter flash fx (parry 3), eruption fx (counter 6, 7). |
| `up_special.jpeg` | 1314x1197 RGB | 5 columns x 4 rows, numbered cells, dark checker background, grey grid lines, title bar, JPEG noise. Front three-quarter view, not side view. Content matches the owner's up special: crouch, throw, sword rises alone, body melts into a streak, reforms under the sword, big downward arc swing, kneel. | uspecial (frames 1 to 18), utilt, usmash, uair, dair stab, getUp and downed fallback (19, 20), rising sword fx (4 to 6). |
| `clone_slashes.jpeg` | 1254x1254 RGB | 5x4 cells, each with Trekmore on top and his shadow clone below, the clone lagging the same motion. Dark navy background, grid lines, numbers, JPEG noise. Clone figures are darker and lower contrast than the top figure. | Reference only: the echo timing and the echo tint are taken from it (the clone trails by about 1 to 3 cells, reads as a dark violet copy at roughly 60 percent opacity). Cut both figures per cell for QA side-by-side, map none of them in the game. |
| `neutral_special.jpeg` | 1402x1122 RGB | 5 columns x 4 rows (the brief said 4x5; it is 5 wide), no numbers, navy background, grid lines, JPEG noise. Front three-quarter view. Cells 6 to 8 hold the sword projectile alone; 9 to 15 dissolve and reform; 16 to 20 hold, spin (ring slash) and a downward thrust. | nspecial (1 to 5), recall branch (13 to 15), sword projectile fx (6, 7), spotDodge and airDodge (9 to 15), nair (16 to 19), dair thrust (20). |

The lead's read was verified with two corrections: `neutral_special.jpeg` is 5 wide by 4 high, and the front-view jpegs differ in camera
angle from the side-view pngs (risk G.1).

### A.2 Scale measurement

Target standing height `STAND_H = 55` game px (Aeval's cut uses 48; 55 / 48 = 1.146).

1. Primary reference: standing body height on a neutral standing frame, measured on the body mask (not including the sword or cape wisps),
   heel row to helmet crest. Sheets and their reference frame: `loco` idle 0; `air` jump 0 (crouched, so use method 2 and cross check);
   `parry` parry 0; `nspec` cell 1; `uspec` cell 12 (standing under the raised sword); `conB` idle 0; `conA` idle 0.
2. Secondary reference: sword length, hilt pommel to blade tip, measured on a frame where the blade is straight and roughly in the image
   plane. The sword is rigid across every sheet, so it scales sheets that have no standing frame (`heavy`, `step`, `clone`). Calibrate
   `SWORD_LEN` once on `loco_idle_0` after its scale is fixed (expected about 36 game px), then per sheet `scale = SWORD_LEN /
   measured_blade_px`.
3. Cross check: on every sheet that has both, the two scales must agree within 5 percent; the cut log prints both and the chosen one.
   Disagreement over 5 percent is an error for that sheet.
4. The backstrike row of `shadow_step.png` is scaled on its own (row level `scaleRef`), because it is drawn larger than the rest of the
   sheet.
5. Anchor: heel point, the same rule as Aeval (`frame_info`): body mask bottom row, x centre of the body mask. Bodyless cells (sword
   projectile, wisps) anchor at the crop centre.

### A.3 Cutter: `tools/sheetcut/cut_trekmore.py` and `art/trekmore/cutmap.json`

Pure Python 3.12 + Pillow + numpy, like `cut.py`. It may import helpers from `cut.py` (`label`, `comp_stats`, `dilate`, `render`, `contact`)
but must not modify it.

`cutmap.json` has one entry per source image:

```json
{ "loco": { "file": "locomotion.png", "mode": "rows", "bg": "black", "blank": [[y0, y1]], "rects": [[y0, y1, x0, x1]],
    "rows": [{ "name": "idle", "y0": 70, "y1": 215, "count": 8 }], "scaleRef": { "method": "stand", "row": "idle", "idx": 0 } },
  "uspec": { "file": "up_special.jpeg", "mode": "grid", "bg": "checker", "rowName": "g",
    "grid": { "cols": 5, "rows": 4, "inset": 6, "labelBox": [0, 0, 44, 40] }, "scaleRef": { "method": "stand", "idx": 11 } } }
```

Rules:

1. Crop names are `<sheet>_<row>_<n>` with `n` from 0. Sheet keys: `loco`, `air`, `heavy`, `step`, `parry`, `uspec`, `nspec`, `clone`,
   `conA`, `conB`. Grid sheets use row `g` (`uspec_g_0` .. `uspec_g_19`); `clone` uses rows `top` and `shadow`. The image cell numbered "11"
   is crop index 10 everywhere.
2. Background keying: `black` mode floods from the border over pixels with max channel <= 22 and keeps enclosed dark pockets unless their
   mean max is under 10 (the Aeval rule, retuned: the armour ink is darker than Aeval's coat, so the threshold is measured and printed).
   `checker` and `navy` modes (the jpegs): first blank grid lines by row and column projections (lines are long runs of grey (50 to 80) that
   span a whole cell edge) plus an inset of `inset` px, blank the number box, then key by low saturation (HSL s < 0.18) and lightness below
   the measured checker maximum plus 6, flooded from the cell border only, so near-black armour enclosed by the silhouette survives. Then a
   3x3 median on the alpha mask, drop specks under 6 px, erode 1 px.
3. JPEG noise: before keying, a 3x3 median on the cell RGB for the jpeg sheets only; after scaling down to 55 px the noise falls under one
   pixel. Never sharpen.
4. Text and panel rules on the png sheets: reuse the `blank_text_and_rules` idea with the purple caption colour (measure it; captions are
   lavender, hue about 255 to 265, bright) and explicit `blank` / `rects` from the cutmap. Concept sheets are cut from explicit rects per
   row.
5. Tightly packed rows (`step` rows 1 to 3, `air` step rows) segment by body component, splitting spanning trail pieces at the thinnest
   column between body centres, as `cut.py` does for wave 3.
6. Count check: every row's expected count is in the cutmap; a mismatch exits 1 and still writes the column-run frames for inspection (same
   behaviour as `cut.py`).
7. Outputs: `art/trekmore/sheets/crops/<name>.png`, `crops/manifest.json` (same schema as Aeval's: `sheetScale`, `frames` with `w h ax ay
   bodyless src`, `fx`), `CONTACT_<sheet>.png` per sheet and `CONTACT.png`, magenta anchor dot as in `cut.py`.
8. fx cuts (table A.6) take the named source crop, remove the body mask, keep the bright purple pieces (the equivalent of Aeval's water
   test: HSL hue 250 to 300, s >= 0.35, l >= 0.35), and anchor at the centre (or the heel for world anchored fx).
9. Palette measurement: `--measure` writes `art/trekmore/palette_measure.json`: a hue histogram (5 degree bins) for pixels with s >= 0.3,
   split into three lightness classes (l < 0.12 ink, 0.12 to 0.40 cloth, >= 0.40 glow), plus the same for Aeval's body atlas restricted to
   hue 180 to 260 and s < 0.35 (the coat and hair), with separate stats for the hair region (top 20 percent of `moves_idle_0`) and the coat
   region (the rest). W1-colours reads this file.

### A.4 Animation map (`art/trekmore/sheetmap.json`)

Same format as `art/aeval/sheetmap.json` (`frames`, `holds`, `loop`, optional `mirror`, `_note`). Every name Aeval's sheetmap defines is
defined here, plus `sspecialAir`, `nspecialBranch` and `dspecialBranch` (see C.5). Holds sum to the move's `totalFrames` (D) so the art and
the sim agree; the first active hitbox frame is the start of the frame marked (hit).

Locomotion, defence and states:

| Anim | Frames | Holds | Note |
|---|---|---|---|
| idle | loco_idle_0..7 | 8 x8 loop | |
| walk | loco_walk_0..9 | 6 x10 loop | |
| run | loco_run_0..6 | 5 x7 loop | |
| dash | loco_dash_0, loco_dash_1 | 6, 8 | |
| turn | loco_idle_0 | 5 | |
| crouch | parry_counter_7, parry_counter_8 | 3, 60 | reuse: counter recovery poses are the lowest side view stance. Pixler fallback A.5 if QA rejects. |
| jumpsquat | air_jump_0 | 4 | |
| jump | air_jump_1..5 | 4,4,5,6,60 | |
| airJump | air_jump_3..6 | 3,4,5,60 | plus `stepTrail` fx puff under the feet on frame 0 |
| fall | air_fall_0..5 | 6 x6 loop | |
| land | air_jump_8, air_jump_9 | 3, 3 | |
| helpless | air_fall_0..3 | 8 x4 loop | |
| shield | parry_parry_0 | 60 loop | shield bubble is drawn by the renderer as today |
| spotDodge | nspec_g_8, nspec_g_9, nspec_g_12, nspec_g_14 | 4,8,6,4 | dissolve and reform in place |
| roll | step_front_1..7 | 3,3,3,3,3,4,5 | shadow teleport reads as the roll |
| airDodge | step_front_2, step_front_3, step_front_4 | 5,20,5 | |
| hitLight | conB_hitLight_0, conB_hitLight_1 | 4, 60 | |
| hitStrong | conB_hitStrong_0, conB_hitStrong_1 | 4, 60 | |
| tumble | conB_hitStrong_1..3 | 5 x3 loop | pixler animate fallback A.5 |
| ledgeHang | conB_ledge_0..2 | 12 x3 loop | wall block removed by the cutter |
| ledgeClimb | conB_ledge_2..4, loco_idle_0 | 6 x4 | |
| dead | conB_hitStrong_3 | 60 | |
| taunt | conB_taunt_0..3 | 10,10,20,50 | |
| taunt2 | conA_summon_0..3 | 15,15,20,40 | the clone summon |
| taunt3 | conA_emerge_0..3 | 12,12,16,50 | verify the emerge cells are full body; else conA_cloneIdle_0..2 |
| tech | air_jump_8, air_jump_9 | 8, 18 | |
| techRoll | step_front_1, 3, 5, 7 | 10 x4 | |
| downed | pixler `downed` (A.5) | 15, 15 loop | reuse fallback: uspec_g_18, uspec_g_19 (kneel) |
| getUp | uspec_g_19, loco_idle_0 | 15, 15 | |
| getUpRoll | step_front_2, 4, 6, 7 | 9,9,9,8 | |
| footstooled | conB_hitLight_1, parry_counter_8 | 4, 60 | |
| grab | conA_hands_0..2 | 6, 4, 20 | shadow hand grab |
| grabHold | conA_hands_2, conA_hands_1 | 10 x2 loop | |
| pummel | conA_hands_1, conA_hands_2 | 4, 12 | |
| throwF | heavy_slash_0, 2, 5 | 10, 4, 10 | |
| throwB | heavy_slash_0, 2, 5 | 14, 4, 12, mirror | |
| throwU | uspec_g_1, uspec_g_2 | 12, 16 | |
| throwD | parry_counter_4, parry_counter_5 | 12, 14 | |
| grabbed | conB_hitLight_0, conB_hitLight_1 | 8 x2 loop | |
| fsStart | loco_idle_0 | 20 | Trekmore has no Final Smash this wave; the name must exist |
| fsVictim | conB_hitStrong_1..3 | 8 x3 loop | he can be caught by Aeval's Final Smash |
| fsTsunami, fsTornado, fsLaunch | loco_idle_0 | 10 | unused placeholders so animFor never misses |

Attacks (frame data in D):

| Anim | Frames | Holds (sum) | Note |
|---|---|---|---|
| jab | conB_slash_0..3 | 5,2,3(hit),16 = 26 | |
| ftilt | conA_slash_0..3 | 7,6,5(hit at 13),20 = 38 | normal slash with crescent |
| utilt | uspec_g_0, uspec_g_11, uspec_g_10, uspec_g_19 | 6,7,6(hit at 13),19 = 38 | front view |
| dtilt | parry_counter_0, parry_counter_7, parry_counter_8 | 4,4(hit at 8),22 = 30 | low sword sweep |
| dashatk | conB_ranged_0..2, loco_dash_2 | 6,5(hit at 11),12,21 = 44 | lunge thrust with trail |
| fsmash | heavy_slash_0..5 | 10,13,3(hit at 23),3,6,23 = 58 | |
| fsmashCharge | heavy_slash_1, heavy_slash_0 | 6,6 loop | |
| usmash | uspec_g_0, 1, 2, 4, 5, 11, 19 | 8,8,5,6(hit at 21),8,8,13 = 56 | sword flung up as a column and caught |
| usmashCharge | uspec_g_0, uspec_g_1 | 6,6 loop | |
| dsmash | parry_counter_0..8 | 5,6,6,3(arc at 17),4,4(erupt at 24),6,10,16 = 60 | shares art with the counter branch |
| dsmashCharge | parry_counter_1, parry_counter_0 | 6,6 loop | |
| nair | nspec_g_15, nspec_g_17, nspec_g_18, nspec_g_16 | 6,6(hit at 6),7,21 = 40 | ring spin |
| fair | conB_aerial_0..2, air_fall_0 | 7,5(hit at 12),8,20 = 40 | |
| bair | air_stepL_0, 1, 3, 7 | 5,5,6(hit at 10),20 = 36 | source faces left, so no mirror flag: the body turns and thrusts back |
| uair | uspec_g_12, uspec_g_13, uspec_g_14, air_fall_0 | 8,8(hit at 16),8,18 = 42 | overhead arc |
| dair | nspec_g_15, nspec_g_19, uspec_g_17, air_fall_4 | 7,7(hit at 14),10,24 = 48 | downward stab |
| nspecial | nspec_g_0..4 | 5,5,4,4(throw at 14),12 = 30 | a charged cast stretches by the anim's Charge path |
| nspecialCharge | nspec_g_1, nspec_g_2 | 6,6 loop | |
| nspecialBranch | nspec_g_12, nspec_g_13, nspec_g_14 | 3,4,7 = 14 | reappear after the recall teleport |
| sspecial | step_side_0..4, step_strike_0..3 | 4,4,3,3,3,2,2(hit at 19),4,21 = 46 | ground |
| sspecialAir | air_stepR_0..4, step_strike_0..3 | 4,4,3,3,3,2,2,4,21 = 46 | air |
| uspecial | uspec_g_0..17 | 3,3,4,3,3,3,3,3,3,3,3,3,3,4,4,3,3,2 = 56 | launch at 10, swing hit at 40 |
| dspecial | parry_parry_0..3 | 5,5,13,27 = 50 | window 5 to 22 on parry_parry_2 |
| dspecialBranch | parry_counter_0..8 | 3,4,4,3,4,4,6,6,10 = 44 | counter attack, frames 60 to 103 |
| ledgeatk | conB_ledge_3, conB_ledge_4, heavy_slash_1, 3, 5 | 8,8,6,4(hit at 22),18 = 44 | |
| getupatk | uspec_g_19, parry_counter_3, parry_counter_5, parry_counter_8 | 8,8(hit at 16),6,16 = 38 | |

Portrait (`_notes`): `loco_idle_0`.

### A.5 Pixler (generated art, gated)

`mcp__pixler__get_quota` returned
`{"remaining":5,"total":5,"type":"Daily","resetAt":"2026-10-01T00:00:00Z","animationsRemaining":2,"animationsTotal":2}`. Five stills and two
animations per day. Plan at most three uses, one spare:

| Use | Kind | Why reuse fails | Fallback |
|---|---|---|---|
| downed | generate (1 still, lying face down, sword beside him) | no source frame lies on the ground | uspec_g_18/19 kneel |
| crouch | generate (1 still) only if QA rejects parry_counter_7/8 | the counter poses carry a sword swing | keep reuse |
| tumble | animate (4 frames, tumbling in the air) only if QA rejects the hitStrong loop | no airborne spin exists | keep reuse |

Prompt inputs: `loco_idle_0` and `conB_hitStrong_1` crops at 4x as style reference, the measured palette (five hex values from
`palette_measure.json`), "side view, facing right, black background, pixel art at 55 px character height, dark armour with violet glow
edges, jagged cape". The output goes through `cut_trekmore.py` as sheet `pix` (rows `downed`, `crouch`, `tumble`) so it is scaled and
anchored like everything else.

Quality gate (W0-art prepares it, the lead or W2 decides): a contact sheet with the pixler crop between `loco_idle_0` and `conB_hitStrong_1`
at 1x and 3x. Pass needs all of: dominant glow hue within 10 degrees of the measured band; ink outline present (l < 0.12 border ring on at
least 70 percent of the silhouette edge); crisp pixels (no more than 15 percent of opaque pixels with alpha between 1 and 254); helmet crest
and jagged cape readable; height within 10 percent of the target pose height. Fail on any point means the fallback column ships. Record the
verdict in the W0-art report.

### A.6 fx crops (`fx` block of the sheetmap, all `fx_<name>`)

| fx | Source | Anchor | Use |
|---|---|---|---|
| shadowSword0..1 | nspec_g_5, nspec_g_6 (sword and trail only) | centre | nspecial projectile, rotated to its velocity |
| shadowBurst0..3 | parry_counter_5, parry_counter_6 eruption with body removed, conA_erupt_0 | centre | projectile burst, ko fx |
| swordRise0..2 | uspec_g_3, uspec_g_4, uspec_g_5 (sword alone, body removed) | heel of source, world anchored like Aeval's geyser | uspecial rise |
| stepTrail0..1 | step_front_3, step_front_4 (pure wisps) | centre | shadow step departure, recall departure, air jump puff |
| counterFlash0..2 | parry_parry_2 flare and arc (body removed), shown 2,2,2 | centre | parry success, crit flash core |
| hitspark0..2 | heavy_slash_3 crescent tip, cropped to 24 px | centre | normal hit spark |
| ko0..3 | shadowBurst frames at 1.5x | centre | KO fx |

The echo tint has no crop: it is a render bake (C.3).

### A.7 UI art

- `public/icons/trekmore.png` (select tile), `trekmore-bust.png`, `trekmore-stock.png`: from `loco_idle_0` with `tools/uicut/portrait.py
  --char trekmore --src art/trekmore/sheets/crops/loco_idle_0.png` (add the two flags; defaults keep Aeval's output identical).
- `public/ui/trekmore-win.png`: the front hero figure of `concept_b.png` (left of the two large figures), keyed with the `black` mode,
  scaled to the height of `public/ui/aeval-win.png`.
- HUD stock icon: `trekmore-stock.png` (helmet only, square).

---

## B. Sim mechanics (W0-sim)

All names below are frozen. New `MoveDef`, `ProjectileDef`, `HitboxDef`, `CharacterDef` fields are optional; with none of them set the sim
behaves exactly as today, and an Aeval-only match never advances `state.rng` (it does not today; a selftest pins that). New fighter fields
are primitives so `src/ai/perception.ts` `copyFighterInto` (key learning copy) picks them up with no AI edit.

### B.1 Types (`src/core/types.ts`)

```ts
/** Shadow echo: a translucent copy replays chosen hitbox groups of this move later. */
export interface EchoDef {
  delayFrames: number;       // echo move frame 0 = owner move frame delayFrames
  damageScale: number;       // damage and shield damage multiplier, about 0.5
  offsetX: number;           // fighter-local x offset of the echo, facing right (negative = behind)
  groups: number[];          // hitbox groups replayed; others are not
}

/** Counter: a hit inside the window is absorbed and the move jumps to its branch. */
export interface CounterDef {
  windowStart: number; windowEnd: number;   // move frames, inclusive
  scale: number;             // counter damage = clamp(absorbed * scale, minDamage, maxDamage)
  minDamage: number; maxDamage: number;
  attackerFreeze: number;    // hitlag frames the countered attacker is frozen for
}

/** Frames reached only by a branch (counter trigger or recall teleport). */
export interface BranchDef { start: number; end: number }   // move ends when actionFrame >= end

/** Recall: pressing the special again while the owner's projectile lives teleports to it. */
export interface RecallDef {
  projectileId: string;      // the def whose live instance is the target
  footOffsetY: number;       // feet land this far below the projectile centre (px, positive = down)
  invulnFrames: number;      // from the teleport frame
  oncePerAir: boolean;       // one recall per airborne period
}

/** Shadow step: vanish, travel, reappear. */
export interface ShadowStepDef {
  startFrame: number; travelFrames: number; distance: number;   // px along facing
  invuln: [number, number];  // move frames
  turnIfPassed: boolean;     // reappearing past the nearest opponent turns the fighter around
  stopAtEdge: boolean;       // ground use stops at the platform edge
  oncePerAir: boolean;       // one air use per airborne period
}

/** Aimed projectile: direction read at release from the held stick. */
export type AimDir = 0 | 1 | 2 | 3 | 4;   // forward, up-forward, up, down-forward, down
export const AIM_ANGLES: readonly number[] = [0, 45, 90, -45, -90];

// HitboxDef additions
fromCounter?: boolean;       // damage = the fighter's stored counterDamage instead of `damage`
noCrit?: boolean;            // never crits (throws and counter hitboxes set it)

// ProjectileDef additions
aim?: boolean;               // spawn velocity = speed (vx, charged) rotated by AIM_ANGLES[aimDir]
fixedScale?: boolean;        // ignore the charge scale curve for hit circle and sprite (scale 1)

// MoveDef additions
echo?: EchoDef;
counter?: CounterDef;
branch?: BranchDef;
recall?: RecallDef;
shadowStep?: ShadowStepDef;

// CharacterDef addition
crit?: { chance: number; scale: number };   // melee only; echo hits roll at chance / 2

// FighterState additions (optional here, required on SimFighter; renderer reads them)
echoMove?: MoveId | null;    // move being echoed, null when no echo
echoAge?: number;            // echo move frame; negative while waiting out delayFrames
echoX?: number; echoY?: number; echoFacing?: Facing;   // latched at owner move frame 0
onBranch?: boolean;          // the current move is running its branch frames
aimDir?: AimDir;             // latched aim of the current aimed move

// SimFighter additions (src/sim/state.ts), initialised in makeFighter, copied in cloneFighter
echoHitGroups: number;       // groups the echo already landed
counterDamage: number;       // absorbed damage stored at the counter trigger
airLock: number;             // bit 1 = air shadow step used, bit 2 = air recall used; cleared on landing, ledge grab, respawn, and on being hit

// SimEvent additions
| { type: 'teleport'; slot: number; fromX: number; fromY: number; x: number; y: number; kind: 'step' | 'recall' }
| { type: 'counter'; x: number; y: number; slot: number; attacker: number }
// 'hit' event gains optional fields:
crit?: boolean; echo?: boolean;
source?: string;             // move id, 'echo:<move id>', projectile def id, or throw id (balance metrics)
```

W0-sim greps the repo for exhaustive `switch (event.type)` with a `never` check before adding the two event kinds; if one exists in `src/ai`
or `src/net`, it reports it instead of editing it and the lead routes it.

### B.2 Rules

Echo (`src/sim/moves.ts`, `hits.ts`, `state.ts`):
1. `startMove` of a move with `echo`: set `echoMove = id`, `echoAge = -delayFrames`, latch `echoX = x + offsetX * facing`, `echoY = y`,
   `echoFacing = facing`, `echoHitGroups = 0`. A new echo replaces a running one.
2. Each frame the owner is not in hitlag, `echoAge++`. The echo ends (`echoMove = null`) when `echoAge > lastEchoedHitboxEnd + ECHO_TAIL`
   (`ECHO_TAIL = 8`, in `constants.ts`).
3. The echo is cancelled when the owner enters hitstun, tumble, grabbed, shieldBreak, dead, respawn or finalSmashVictim. Hitting Trekmore
   kills his shadow.
4. In `resolveHits`, after the owner's own hitboxes: for each hitbox in `echo.groups` with `start <= echoAge <= end` and its group bit not
   in `echoHitGroups`, test at `(echoX + hb.x * echoFacing, echoY + hb.y)` against every victim with the same filters as a normal hitbox
   (canBeHit, teams, ledge rule, dodges). Damage and shield damage times `damageScale`; knockback from the scaled damage. Victim hitlag
   only; the echo and the owner are not frozen. Echo hits never grab and never bounce. They count as ordinary hits for stats and combos
   (`recordHit`), and trigger counters (B.2 counter rule).
5. The owner's `hitGroups` and the echo's `echoHitGroups` are separate, so the owner hit and the echo hit on the same victim are two hits.

Crit (`hits.ts`):
6. Only when the attacker's def has `crit` and the hit lands on a body (not a shield, not countered), for melee hitboxes without `noCrit`,
   including echo hitboxes at `chance / 2`. Projectiles, throws, pummels and counter hitboxes never crit. Roll `nextFloat(state.rng) <
   chance` at that point only, so the rng advances only on Trekmore's landed melee hits.
7. A crit multiplies damage by `scale` and multiplies the final knockback by `scale` (new optional last parameter `kbScale = 1` on
   `applyHit`). The 'hit' event carries `crit: true`.
8. Decision recorded: all melee, echo at half chance. Reason: the owner calls him a crit hitter, and crits on tilts are what make the "one
   hit can take a stock" identity show up in neutral; limiting them to smashes makes them invisible because smashes rarely land. The
   expected damage cost is small (1 + 0.12 x 0.3 = 1.036 on normals, 1.018 on echoes) and the balance loop owns it. Counters are excluded
   because a guaranteed punish should not gamble.

Counter (`hits.ts`, `moves.ts`, `projectiles.ts`):
9. A defender whose current move has `counter`, with `windowStart <= actionFrame <= windowEnd` and not on a branch, absorbs any melee hit
   (owner or echo) and any projectile. Grab hitboxes and throws are never absorbed (grab beats counter). An absorbed hit deals no damage, no
   knockback and no shield damage.
10. On absorb: `counterDamage = clamp(raw damage * scale, minDamage, maxDamage)` (raw = the damage the hit would have dealt, charge
    included, before crit); the defender faces the attacker (or the projectile's owner side), `onBranch = true`, `actionFrame =
    branch.start`; a melee attacker gets `hitlag = attackerFreeze` and the hitbox's group bit is set so it cannot hit again; a projectile is
    killed with no burst (`killProjectile(state, p, def, false)`: new optional `burst = true` parameter). Push a 'counter' event.
11. `fromCounter` hitboxes deal `counterDamage` and are `noCrit`.
12. On whiff the move runs to `totalFrames` like any move.

Branch (`moves.ts`):
13. `advanceMove`: when `onBranch`, the move ends at `actionFrame >= branch.end` instead of `totalFrames + castDelay`; hitboxes, velocity
    and invuln entries in branch frames only run on the branch because the normal path ends first. Invariant checked by a selftest over
    every def: `branch.start >= totalFrames + (chargeCastFrames ?? 0)`. `setAction` clears `onBranch`.

Aim (`moves.ts`, `projectiles.ts`):
14. For a move with any `aim` projectile, the aim is read on the release frame (end of the charge hold, or frame 0 on a tap) from the held
    direction: up plus forward or back = 1, up = 2, down plus forward or back = 3, down = 4, else 0. Held back without up or down turns the
    fighter first and fires forward (0). Held back with up or down turns the fighter and fires 1 or
    3. During a charge the latched value updates every frame, so the direction held at release wins and a charge lets the player preset it.
       Stored in `aimDir`.
15. `spawnAt` of an `aim` def: speed = `chargedStat(def, charge, 'vx')`; `vx = speed * cos(a) * facing`, `vy = -speed * sin(a)` with `a =
    AIM_ANGLES[aimDir]` in degrees. Use a five-entry table of cos/sin constants, not `Math.cos` at runtime, so AI code that mirrors it stays
    within its no-trig rule. `fixedScale` forces `scale = 1`.

Recall (`actions.ts`, `moves.ts`):
16. Where a special press today hits `moveLocked` and is dropped: if the locked move has `recall` and a live projectile of
    `recall.projectileId` owned by the fighter exists, and not (`oncePerAir` and airborne and `airLock & 2`), perform the recall instead:
    push a 'teleport' event, set feet to `(p.x, p.y + footOffsetY)`, clamp inside the blast zone by 40 px, and if the feet point is inside a
    solid platform rect, snap to its top and set `onGround`. Zero vx and vy, kill the projectile with no burst, start the move, `onBranch =
    true`, `actionFrame = branch.start`, `invuln = invulnFrames`. In the air set `airLock |= 2`.
17. The recall works from any actionable state that could start the special, including mid-air and out of a run. It does not work in
    hitstun.

Shadow step (`moves.ts`, `physics.ts` only if the edge stop needs the platform query there):
18. On `startFrame`: record the start x. For `travelFrames` frames the fighter moves `distance / travelFrames` px per frame along facing
    (set vx, skip friction, gravity skipped in the air, vy 0). Fighters do not block it (no body push exists today; confirm).
19. `stopAtEdge` on the ground: travel stops at the platform edge; the fighter never leaves the ground by stepping.
20. On the last travel frame: if `turnIfPassed` and the nearest living opponent's x lies strictly between the start x and the end x, flip
    facing. Push a 'teleport' event (kind 'step').
21. In the air with `oncePerAir`: set `airLock |= 1`; a second air sspecial is dropped (the fighter stays actionable, the press is consumed)
    until landing, a ledge grab or being hit. The fighter is not helpless after it.

### B.3 Selftests (append to `src/sim/selftest.ts`, one section header "Trekmore mechanics")

Tests use a synthetic def built from `aevalDef` with the new fields (the pattern of `src/ai/eval/cases/character.ts` ALT def), inserted into
`CHARACTER_DEFS` under a test id, then `rebuildProjectileDefs()` (new export in `projectiles.ts` that rescans `CHARACTER_DEFS`).

1. Echo: jab with echo delay 8, scale 0.5: a standing victim takes two hits, 8 frames apart, the second at half damage; two 'hit' events,
   the second with `echo: true`; `comboCount` 2.
2. Echo cancel: hitting the owner before the echo's active frame means no echo hit.
3. Echo does not exist for moves without `echo`; an Aeval mirror of 1,200 frames with hits leaves `state.rng.s` unchanged.
4. Crit rate: 2,000 landed hits with chance 0.12 give 0.10 to 0.14 crits; crit damage is exactly `scale` times; crit launch speed is
   greater; same seed gives the same crit sequence twice.
5. Echo crit: 4,000 echo hits with chance 0.12 give 0.045 to 0.075.
6. Counter melee: hit inside the window leaves the defender's percent unchanged, sets `onBranch`, freezes the attacker `attackerFreeze`
   frames, and the counter hitbox deals `clamp(absorbed * scale, min, max)`; a hit one frame outside the window lands normally; a whiff
   returns to idle at `totalFrames`.
7. Counter projectile: an Aeval orb inside the window dies with no `orbBurst` spawned, counter fires.
8. Counter vs grab: the grab catches.
9. Branch invariant: every def in `CHARACTER_DEFS` with `branch` has `branch.start >= totalFrames + chargeCastFrames`.
10. Aim: held up gives `vx 0, vy < 0`; down-forward gives `vx > 0, vy > 0`; back turns the fighter; tap travel 140 px within 5, full-charge
    travel 372 px within 10 (numbers from D.6).
11. Recall: second press teleports the feet to the projectile point plus `footOffsetY`, no burst, invuln for `invulnFrames`; a second air
    recall before landing is dropped; recall aimed into the floor snaps onto it.
12. Aeval crescent lock (`onePerOwner`) unchanged.
13. Shadow step: travel within 1 px of `distance` in the air; ground stop at the edge; facing flips when an opponent was crossed; second air
    use dropped until landing.
14. `fixedScale`: charged instance keeps scale 1.
15. Rollback: `cloneGameState` taken mid-echo, mid-branch, mid-recall and mid-step, both copies stepped 180 frames with the same inputs,
    give equal `hashState` style comparisons (use the existing selftest clone check).
16. 'hit' events carry `source`.

---

## C. Render (W0-render, then W1-colours)

### C.1 Multi-character loading

Nothing structural: `visuals.ts` builds `CharVisual` per entry of `CHARACTER_SPRITES`, `bake.ts` bakes any sheet id. Changes:

1. `visuals.ts`: `FX_ANIMS` gains `trekmore: TREKMORE_FX_ANIMS` (W1-char adds the import line; W0-render makes the table lookup tolerate a
   missing id). The hard-coded Aeval fx lists (`geyser`, `whirl`, `orbCharge`) become lookups by fx name that may be empty; Trekmore adds
   `swordRise` (world anchored at the uspecial launch frame like `geyser`), `stepTrail`, `counterFlash`, `shadowBurst`.
2. Aimed projectiles draw rotated by `atan2(vy, vx)` (render code may use trig) and keep the facing mirror for vx < 0.
3. `anim.ts`: a `Branch` suffix like `Charge`: when `fighter.onBranch` and the sheet defines `<anim>Branch`, play it with time
   `actionFrame - moveDef.branch.start`. `sspecialAir` is chosen by Trekmore's `animFor` (air when not on the ground).

### C.2 Palette per character (`src/render/palette.ts`)

```ts
export interface PaletteBand {
  hueMin: number; hueMax: number; hueCenter: number; feather: number;
  satMin: number; satMax: number; lightMin: number; lightMax: number;
  strength: number;            // 1 = full remap, <1 = partial tint toward the target
}
export interface VariantTarget {
  hue: number | null;          // null = keep hue (white)
  sat: number;                 // multiplier; white uses 0.08
  lift: number;                // lightness lift toward white, 0..1
  metal?: { highlight: number; shadowHue: number };   // gold: highlights toward pale yellow, deep shade hue
}
export interface PaletteConfig { bands: PaletteBand[]; variants: VariantTarget[]; names: string[]; swatches: string[] }
export const PALETTES: Record<string, PaletteConfig>;
export function paletteOf(charId: string): PaletteConfig;          // unknown id -> aeval
export function remapRgb(r, g, b, variant, out, charId = 'aeval'): void;
export function remapPixels(data, variant, charId = 'aeval'): void;
export function remapHex(hex, variant, charId = 'aeval'): string;
export function variantTable(hex, charId = 'aeval'): readonly string[];
export function variantNames(charId: string): readonly string[];
export function variantSwatches(charId: string): readonly string[];
```

`VARIANT_NAMES`, `VARIANT_SWATCHES`, `VARIANT_COUNT = 4` stay exported with Aeval's values so `src/ui/lan.ts` compiles untouched. Variant
indices stay 0..3 for every character, so the LAN protocol's 0..3 check still holds.

Aeval (`PALETTES.aeval`): band 1 is today's blue band unchanged (the regression test pins today's output for 12 sample colours). Band 2 is
new: the coat, hue 190 to 250, s 0.06 to 0.33, l 0.12 to 0.45 (W1-colours replaces these with `palette_measure.json` numbers), strength
0.45: the pixel's hue moves toward the variant hue by 45 percent of the way and its saturation is raised to `max(s, 0.22)` times the
strength. White on the coat: desaturate to 0.04 and lift 0.25. Variant 0 (blue) leaves the coat as drawn. Hair shares the hue family; if the
measure shows hair lightness above the coat band, the band's `lightMax` excludes it; otherwise hair tints too (G.5).

Trekmore (`PALETTES.trekmore`), names `['Purple', 'Red', 'White', 'Gold']`:
- Band 1 glow: measured (expected hue 255 to 300, s >= 0.35, l >= 0.35), strength 1.
- Band 2 cloth: measured (expected hue 250 to 300, s >= 0.20, l 0.10 to 0.35), strength 1.
- Ink below l 0.07 never moves (lower than Aeval's 0.12 because his armour is dark violet, not black, and should tint).
- Red: hue 4 plus half the pixel's offset from the band centre, sat x1.05.
- White: sat x0.06, lift 0.40 on glow, 0.28 on cloth, so it reads as a pale silver knight with dark joints.
- Gold: hue 45 (clamped 42 to 48), sat to `max(s, 0.7)` x1.1, lightness `l + (1 - l) * 0.35 * l` (lifts mid tones, leaves ink), and
  `metal.highlight`: pixels above l 0.75 move toward `#fff2c0` by 60 percent so the edges read as polished metal; deep cloth below l 0.2
  takes hue 30 so the shading reads as bronze, not mustard.
- Swatches: `#8a4dff`, `#e0323c`, `#e8e6f0`, `#e0b040`.

### C.3 Echo and crit drawing

1. `bake.ts`: `getShadowFrame(sheetId, frameName, flipped, variant)`: baked lazily on first request per frame and variant: every opaque
   pixel becomes the variant's shadow colour (Trekmore purple `#2a1640`, red `#3a1010`, white `#3a3848`, gold `#3a2a10`, from
   `PALETTES[..].shadow`, a new optional field) with its alpha times 0.62, edge pixels (alpha < 255) times 0.4. No allocation per draw after
   the bake.
2. `fighters.ts`: before a fighter's body, if `echoMove !== null` and `echoAge >= 0`, draw the echo: anim = `sprites.animFor('attack',
   echoMove, fighter)`, frame at time `echoAge`, at `(echoX, echoY)` flipped by `echoFacing`, using the shadow frame; fade alpha linearly to
   0 over the last `ECHO_TAIL` frames. Interpolate nothing (the echo does not move).
3. Crit: 'hit' with `crit` spawns `counterFlash` at 1.5x plus a white core ring (fx.ts, drawn), shake `amount x 1.6` (index.ts,
   `CRIT_SHAKE_MUL = 1.6`), and 3 extra particles in the variant glow.
4. 'counter' event: `counterFlash` at the defender's chest, 4 frames of full screen dim at 15 percent (fx.ts overlay, skipped when the debug
   frame data view is on).
5. 'teleport' event: `stepTrail` at `(fromX, fromY)`, a second one at the destination 4 frames later.

### C.4 Other files

- `varianticon.ts`: `variantImageUrl(url, variant, charId = 'aeval')`, `setVariantSrc(img, url, fallback, parent, variant, charId =
  'aeval')` (keep the current argument order, append charId). Cache key includes charId.
- `particles.ts`, `colors.ts`: per-character variant tables (`glowFor(v, charId = 'aeval')`). Trekmore glow base `#b070ff`.
- `bake.ts`: `bakeVariantSheet(baseId, variantId, variant, charId = 'aeval')`.
- `tools/variants/preview.ts`: `--char aeval|trekmore` writing `art/<char>/preview_variants/`.
- `rendertest.ts`: see gates in F.

### C.5 Files changed in render

`src/render/palette.ts`, `bake.ts`, `visuals.ts`, `fighters.ts`, `fx.ts`, `anim.ts`, `index.ts`, `particles.ts`, `colors.ts`,
`varianticon.ts`, `rendertest.ts`, `tools/variants/preview.ts`.

---

## D. Character definition (`src/characters/trekmore/moves.ts`)

Frame numbers are 0-based move frames as in Aeval's file. "A:" gives Aeval's value for the same slot. Damage is 1.4x to 1.6x Aeval's per
hit; tilts and jab start 2 to 4 frames later, smashes 4 to 6 frames later. Hitbox offsets are scaled 1.15x for his size and his sword reach.

### D.1 Attributes

| Field | Aeval | Trekmore | Note |
|---|---|---|---|
| weight | 88 | 110 | knockback growth factor 200/(w+100): 1.064 to 0.952, about 10.5 percent less launch |
| walkSpeed | 1.6 | 1.3 | |
| runSpeed | 3.1 | 2.5 | 0.8x |
| dashSpeed / dashFrames | 3.4 / 12 | 2.8 / 14 | |
| groundAccel / groundFriction | 0.42 / 0.22 | 0.34 / 0.24 | |
| airSpeed / airAccel / airFriction | 2.0 / 0.14 / 0.03 | 1.7 / 0.11 / 0.035 | 0.85x |
| gravity / maxFall / fastFall | 0.15 / 3.2 / 5.0 | 0.17 / 3.7 / 5.75 | 1.15x fall |
| jumpVel / shortHopVel / doubleJumpVel | 5.4 / 3.5 / 5.0 | 5.2 / 3.3 / 4.8 | |
| jumps / jumpSquat | 2 / 3 | 2 / 4 | |
| hurtbox | 26x40 | 32x46 | |
| crouchHurtbox | 26x26 | 32x30 | |
| ledgeGrabBox | 20x24 yOff -30 | 22x26 yOff -35 | |
| crit | none | chance 0.12, scale 1.3 | |
| finalSmash | Tidal Judgement | none this wave | G.6 |

### D.2 Ground normals (echo on all)

| Move | A: frames / dmg | Trekmore active | Total / iasa | Damage, angle, bkb, kbg | Hitboxes (x, y, r) | Echo |
|---|---|---|---|---|---|---|
| jab | 4-6, 3 (+jabDrop 2) | 7-9 | 26 / 22 | 4.5, 361, 24, 42 | forwardChain x 16 to 40, y -24, r 10 | delay 8, 0.5, offsetX -6, groups [1] |
| ftilt | 10-14, 8 | 13-17 | 38 / 34 | 12, 361, 22, 58 | forwardChain x 14 to 62 (tip 72), y -26, r 11 | delay 10, 0.5, -8, [1] |
| utilt | 10-15, 7 | 13-18 | 38 / 34 | 10.5, 90, 38, 92 | head box x 2 y -52 r 13 plus column to y -118, r 11 | delay 10, 0.5, -6, [1] |
| dtilt | 5-9, 6 | 8-12 | 30 / 26 | 9, 75, 36, 90, low, hitsLedge | x 18 y -5 r 12; x 34 y -5 r 10 | delay 8, 0.5, -6, [1] |
| dashatk | 8-18, 9 | 11-18 | 44 / none | 13, 55, 36, 58 | forwardChain x 14 to 80, y -20, r 12; velocity frame 6 vx 3.5 | delay 10, 0.5, -10, [1] |

No jab projectile: Trekmore has no chip projectile; his reach is the sword.

### D.3 Smashes (no echo, chargeable)

| Move | A: frames / dmg / total | Trekmore | Hitboxes |
|---|---|---|---|
| fsmash | 18-23, 15, 48 | active 23-27, total 58; 22, 40, bkb 26, kbg 50 | forwardChain x 16 to 94 (tip 108), y -24, r 14 |
| usmash | 16-22, 14, 46 | active 21-26, total 56; 20, 88, 32, 76 | head x 2 y -52 r 15 plus sword column to y -128, r 13 |
| dsmash | 12-15, 12 both sides, 42 | arc 17-20: 18, 45, 30, 68, x 26 y -34 r 18; eruption 24-27 same group: front x 38 y -8 r 16 dmg 16 angle 80 bkb 34 kbg 70, back x -26 y -6 r 12 dmg 12 angle 150 bkb 30 kbg 64; total 60; hitsLedge | one group, so one hit per victim |

Targets on Tidegate from centre, fresh, full charge, Aeval as victim: fsmash KO about 72 percent (Aeval's fsmash on Trekmore about 104);
uncharged about 100. `src/sim/calibrate.ts` prints them; W1-char records the printed numbers in `balance/trekmore.balance.json`.

### D.4 Aerials (echo on all)

| Move | A: frames / dmg / landing | Trekmore active | Total / landing | Damage, angle, bkb, kbg | Hitboxes | Echo |
|---|---|---|---|---|---|---|
| nair | 3-6 clean 8, 7-20 late 5 / 5 | clean 6-9, late 10-18 | 40 / 9 | 12 / 7, 60 / 55, 22 / 14, 52 / 42 | ring x 0 y -26 r 26 (late r 24) | delay 8, 0.5, 0, [1] |
| fair | 9-13, 11.5 / 12 | 12-16 | 40 / 16 | 16, 45, 24, 62 | x 26 y -26 r 15; x 38 y -22 r 13 | delay 10, 0.5, -6, [1] |
| bair | 7-10, 12.5 / 12 | 10-13 | 36 / 15 | 17, 361, 26, 64 | x -28 y -24 r 14; x -40 y -24 r 12 | delay 8, 0.5, 6, [1] |
| uair | 14-18, 8 / 12 | 16-21 | 42 / 14 | 12, 80, 30, 82 | x -10 y -56 r 16; x 10 y -60 r 16; x 24 y -42 r 12 | delay 10, 0.5, 0, [1] |
| dair | dive, 14 / 20 | spike 14-18, late 19-24 | 48 / 24 | spike 16, 270, 40, 78; late 11, 70, 30, 60; hitsLedge | spike x 4 y 10 r 13 (tip), late x 4 y -6 r 16 | delay 10, 0.5, 0, [2] (late only: an echo spike is a free double meteor) |

No dive and no bounce on his dair: it is a heavy stall-free stab with long landing lag.

### D.5 Specials

nspecial, Shadow Sword (chargeable on Special, chargeCastFrames 8, `recall`, `branch`):
- Tap: total 30, sword leaves on frame 14; full charge: frame 22, total 38. Aim per B.2.
- `shadowSword` ProjectileDef: `aim: true`, `fixedScale: true`, `onePerOwner: true`, spawn x 20 y -26, vx 5.0 (charged 6.0), vy 0, gravity
  0, lifetime 28 (charged 62), r 10, damage 7 (charged 12), angle 40, bkb 30 (charged 40), kbg 55 (charged 62), strength 3 (charged 6),
  destroyOnHit, burstId `shadowBurst`, sprite `shadowSword`. Travel: tap 140 px (0.28 of Tidegate's 496 px main platform, medium-low), full
  372 px (0.75 of the platform, medium-high).
- `shadowBurst`: BURST_ONLY, r 22, lifetime 12, damage 5 (charged 9), angle 60, bkb 30, kbg 50, strength 3, not destroyOnHit, sprite
  `shadowBurst`. It skips victims the sword hit (existing rule).
- recall: `{ projectileId: 'shadowSword', footOffsetY: 26, invulnFrames: 12, oncePerAir: true }`, branch `{ start: 40, end: 54 }` (14 frames
  of reappear lag, first 12 invulnerable).
- Compare Aeval's orb: tap 186 px chip at 4, full 341 px at 16 with a heal. The sword is slower to cast and shorter at a tap, hits harder at
  a tap, a little weaker at full, has no heal, and buys a teleport. That pays for itself under the anti power creep rule.

sspecial, Shadow Step and Backstrike:
- `shadowStep { startFrame: 8, travelFrames: 6, distance: 96, invuln: [6, 16], turnIfPassed: true, stopAtEdge: true, oncePerAir: true }`. 96
  px in 6 frames is 16 px/frame (a teleport, not a run).
- Backstrike hitboxes 19-24: forwardChain x 14 to 52, y -26, r 16, 13 damage, angle 40, bkb 40, kbg 60, group 1. Total 46. On the ground
  `stopAtEdge`; in the air the anim is `sspecialAir`, no helpless, one per airborne period.
- A: sspecial is a returning crescent projectile; Trekmore's is a mobility strike.

uspecial, Shadow Ascent:
- Frames 0-9 throw the sword up; velocity frame 10 `vy -7.2 setY`, `vx 1.2` (facing); frames 11 to 30 `vy +0.25` each (the geyser shape,
  stronger because he falls faster; A: -6.5 at 8, +0.3 to 20).
- Rising hitbox 12-30: x 0 y -44 r 16, 3 damage, angle 90, bkb 60, kbg 30, group 1 (drags up).
- Top swing 40-46: x 20 y -30 r 22 and x 34 y -14 r 16, 14 damage, angle 50, bkb 42, kbg 80, group 2. Total 56, `helplessAfter`. Invuln
  frames 10-14 (the melt).
- Height target: 1.1x Aeval's uspecial rise, measured by `probeRecovery` in W3; W1-char checks it with a sim trace and prints it.

dspecial, Moon Parry:
- `counter { windowStart: 5, windowEnd: 22, scale: 1.3, minDamage: 10, maxDamage: 30, attackerFreeze: 14 }`, total 50 on a whiff (28 frames
  of endlag after the window).
- `branch { start: 60, end: 104 }`, invuln 60-72. Counter hitboxes, `fromCounter`, `noCrit`, group 1: arc 70-73 x 24 y -34 r 20, eruption
  78-81 x 38 y -8 r 18; angle 45, bkb 60, kbg 70.
- Usable in the air (the branch plays in the air; it does not fall faster).

### D.6 Grab kit (own `grabKit`)

Relative to `DEFAULT_GRAB_KIT`: stand grab start 9 end 10 (2 later), x 20 y -24 r 11 (shadow hand reach +25 percent), total 34; dash grab
start 11 end 12, x 28 r 12, total 42; pummel 2.2 damage, totalFrames 18, hitFrame 5. Throws (damage 1.4x, all `noCrit` by rule):

| Throw | Default | Trekmore |
|---|---|---|
| fthrow | 8, 40, 60, 60 | 11, 40, 64, 62 |
| bthrow | 9, 40, 65, 65 | 12.5, 45, 62, 74 (his kill throw, about 150 percent at the ledge) |
| uthrow | 7, 90, 70, 55 | 10, 90, 72, 58 |
| dthrow | 6, 70, 50, 40 | 8, 72, 48, 38 (combo starter into uair or echo nair) |

### D.7 Utility

taunt, taunt2, taunt3: 90 frames each, no hitboxes. ledgeatk: total 44, invuln 0-24, hit 22-26 x 24 y -16 r 14, 10 damage, 361, 22, 48.
getupatk: total 38, invuln 0-15, hit 16-21 both sides x ±22 y -12 r 13, 9 damage, 361, 24, 52.

### D.8 Budget (BALANCE_GUIDE scorecard, starting point)

speed 0.80, weight 1.20, range 1.05, frameAdvantage 0.80, killPower 1.20, comboPower 1.10, recovery 1.00, disadvantageEscape 0.95. Two axes
at 1.20 paid for by speed and frame advantage.

### D.9 Files

`src/characters/trekmore/moves.ts` (`trekmoreDef`), `sprites.ts` (`trekmoreSprites`, the Aeval MOVE_ANIM and ACTION_ANIM tables plus
`sspecial` air choice), `art/*` (generated by pack.py), `src/characters/registry.ts` (three lines), `balance/trekmore.balance.json` (mirror
of `balance/aeval.balance.json` schema, archetype `heavy_shadow_bruiser`).

---

## E. UI

1. Select (`src/ui/select.ts`): the character grid shows Trekmore from `CHARACTER_LIST` (`{ id: 'trekmore', name: 'Trekmore', icon:
   'icons/trekmore.png', winPose: 'ui/trekmore-win.png' }`). Swatches and names come from `variantNames(charId)` /
   `variantSwatches(charId)`; the "two slots on the same character never share a colour" rule keeps working per character. Card art goes
   through `setVariantSrc(..., charId)`. Follow `docs/UI_STYLE.md` sections 4 and 7.
2. HUD (`src/ui/hud.ts`): bust and stock via `-bust.png` / `-stock.png` as today, with charId.
3. Results (`src/ui/results.ts`): win pose `ui/trekmore-win.png` recoloured with charId; stats rows unchanged (echo hits already count as
   hits).
4. Movelist (`src/ui/movelist.ts`): rows are generic. Add: damage of an echo move shows `12 (+6 echo)`; `fromCounter` shows `counter 10 to
   30`; recall shows on the Neutral Special row as "press again: teleport to sword"; the character line gets a tag "crit 12%". A small
   `MOVE_NOTES: Record<string, Partial<Record<MoveId, string>>>` table, Trekmore entries: nspecial "Aim with the stick. Press again to
   teleport to the sword."; sspecial "Shadow step through, strike from behind."; uspecial "Throw the sword up and rise into it."; dspecial
   "Parry. A blocked hit becomes a counter slash."; jab, tilts, aerials, dash attack "Shadow repeats it."
5. Quotes (`src/ui/quotes.ts`), `trekmore`: "Everywhere I go, the shadow follows.", "Moonanchor holds.", "No face. No fear. Only wins.",
   "The Queen sleeps soundly tonight.", "Your shadow knew before you did.", "Kneel. The blade is heavier than you."
6. LAN lobby: Trekmore appears automatically (it reads the character list). Its variant chip shows Aeval's colour names until the LAN worker
   switches `lan.ts` to `variantNames(charId)`; the lead passes that one-line change to the LAN worker (open question 9).

---

## F. Waves

Gates, as named in the cards:

| Gate | Command | Pass |
|---|---|---|
| typecheck | `npm run typecheck` | exit 0, or failures only in files owned by an active other worker (list them) |
| test:sim | `npm run test:sim` | exit 0 |
| test:net | `npm run test:net` | exit 0 (sim determinism under the net harness) |
| rendertest | `npx --yes tsx src/render/rendertest.ts` | exit 0 |
| cut | `python tools/sheetcut/cut_trekmore.py` | exit 0, all counts match |
| pack | `python tools/sheetcut/pack.py --char trekmore` and plain `pack.py` | exit 0, each atlas under 1.5 MB base64, Aeval output byte identical (`git diff --exit-code src/characters/aeval/art`) |
| test:ai | `npm run test:ai` | exit 0 (W3 and later only) |
| browser | the `browser-automation` skill against `npm run dev` | screenshots listed, no console errors |

Every worker returns one JSON object:

```json
{ "worker": "W0-sim", "gates": { "typecheck": 0 }, "changedFiles": [], "createdFiles": [], "decisions": [], "deviations": [], "numbers": {}, "problems": [], "handoff": "" }
```

`numbers` holds measured values the plan asked for (scales, atlas bytes, KO percents, win rates). Every worker: own only your files, no em
dashes, no `Math.random` in sim, no commits (the lead commits between waves), run your gates and report real exit codes.

### Wave 0 (start now). Parallel group: W0-art, W0-sim, W0-render

**W0-art** (Opus; art judgement). Files: `tools/sheetcut/cut_trekmore.py`, `art/trekmore/cutmap.json`, `art/trekmore/sheets/crops/**`,
`art/trekmore/sheetmap.json`, `art/trekmore/palette_measure.json`, `art/trekmore/pixler/**`, `tools/sheetcut/pack.py` (`--char` only),
`src/characters/trekmore/art/atlas.body.ts`, `atlas.fx.ts`, `anims.ts` (generated), `tools/uicut/portrait.py` (`--char`, `--src` only),
`public/icons/trekmore*.png`, `public/ui/trekmore-win.png`. Inputs: `art/trekmore/source/*`. Read: this plan A;
`art/aeval/INTEGRATION_SPEC.md`; `tools/sheetcut/cut.py`; `art/aeval/sheetmap.json`. Tasks:
1. Open each source image; write `cutmap.json` rows and grid entries with measured y and x ranges.
2. Write `cut_trekmore.py` per A.3 (import helpers from `cut.py`, do not edit it).
3. Cut all ten sheets; iterate until counts match; save contact sheets.
4. Measure scales per A.2; print both methods; fix `SWORD_LEN`; report the table.
5. Cut the fx of A.6.
6. Write `sheetmap.json` exactly as A.4 and A.6, adjusting frame picks only where a crop is unusable (report each change with the reason).
7. Run `--measure` and write `palette_measure.json`.
8. Pixler: generate `downed` only (one still). Build the A.5 quality gate contact sheet; do not decide crouch or tumble unless the reuse
   crops are visibly broken on the contact sheet.
9. Add `--char` to `pack.py` (defaults unchanged) and generate Trekmore's atlases and anims into `src/characters/trekmore/art/`. The
   generated `anims.ts` imports `FxAnimDef` from `../../aeval/art/anims`. If an atlas exceeds 1.5 MB base64, palette-quantize that atlas to
   255 colours plus alpha and report both sizes.
10. Cut the portrait, bust, stock and win pose (A.7). Gates: cut, pack, typecheck. Return `numbers`: per-sheet scale and method, counts,
    atlas sizes, pixler verdict, palette band estimates.

**W0-sim** (Opus). Files: `src/core/types.ts`, `src/core/constants.ts` (`ECHO_TAIL`), `src/sim/moves.ts`, `hits.ts`, `projectiles.ts`,
`actions.ts`, `state.ts`, `physics.ts` (only if needed), `src/sim/selftest.ts`. Inputs: none. Read: this plan B; `docs/SPEC.md` 3, 4.3, 4.4;
`src/sim/*` listed; `src/ai/perception.ts` lines 225 to 300 (read only, to confirm fields copy). Tasks:
1. Add the B.1 types exactly (names frozen). FighterState fields optional, SimFighter required.
2. Initialise and clone the new SimFighter fields (`makeFighter`, `cloneFighter`); clear `onBranch` in `setAction`; clear `airLock` on
   landing, ledge grab, respawn, hit.
3. Implement echo (B.2 1 to 5), crit (6 to 8), counter (9 to 12), branch (13), aim (14, 15), recall (16, 17), shadow step (18 to 21), 'hit'
   event `source`.
4. Export `rebuildProjectileDefs()`.
5. Add the B.3 selftests.
6. Grep `src/ai` and `src/net` for exhaustive SimEvent switches; report, do not edit. Gates: typecheck, test:sim, test:net. Return the list
   of sim behaviours that changed for Aeval (expected: none).

**W0-render** (Sonnet is enough for the plumbing; Opus if the palette maths slips). Files: C.5 list. Inputs: B.1 names (frozen, code against
them before W0-sim lands; test with hand-built states). Read: this plan C; `docs/SPEC.md` 8, 8.1; `docs/UI_STYLE.md` 7. Tasks:
1. Palette per character (C.2) with provisional Trekmore bands (the "expected" numbers) and the Aeval coat band; Aeval band 1 output
   unchanged.
2. Thread `charId` through `bake.ts`, `visuals.ts`, `varianticon.ts`, `particles.ts`, `colors.ts` with `'aeval'` defaults.
3. fx lookups by name (C.1 1), aimed projectile rotation (C.1 2), `Branch` anim suffix (C.1 3).
4. Echo shadow bake and draw (C.3 1, 2); crit, counter, teleport fx (C.3 3 to 5).
5. `preview.ts --char`.
6. rendertest additions: Aeval band 1 regression on 12 pinned colours; Trekmore red, white, gold hue and lightness checks on 6 sample
   colours; Aeval coat colour moves toward purple under variant 1 and stays under variant 0; echo draw issues one extra `drawImage` with a
   hand-built state; crit event raises the shake above a normal hit of the same damage. Gates: typecheck, rendertest.

### Wave 1 (after W0 all three). Parallel group: W1-char, W1-ui, W1-colours

**W1-char** (Opus). Files: `src/characters/trekmore/moves.ts`, `sprites.ts`, `src/characters/registry.ts`, `src/render/visuals.ts` (the
FX_ANIMS import line only), `balance/trekmore.balance.json`, `src/sim/selftest.ts` (a "Trekmore def" section). Inputs: W0-sim types, W0-art
atlases and anims. Read: this plan D, A.4; `src/characters/aeval/moves.ts`, `sprites.ts`; `docs/BALANCE_GUIDE.md`. Tasks:
1. Write `trekmoreDef` with every number in D.
2. Write `trekmoreSprites` (tables as Aeval's; `sspecial` returns `sspecialAir` in the air; portrait `loco_idle_0`).
3. Register in `CHARACTER_DEFS`, `CHARACTER_SPRITES`, `CHARACTER_LIST`.
4. Selftests: every MoveId has a MoveDef and an anim; every hitbox `end < totalFrames` or inside its branch; anim holds sum to totalFrames
   for every move anim (and branch anims to branch length); the same hit launches Trekmore about 10 percent less than Aeval; uspecial rise
   height printed and at least 1.0x Aeval's.
5. Run `src/sim/calibrate.ts` for both characters; write the KO percents into the balance JSON. Gates: typecheck, test:sim, test:net,
   rendertest.

**W1-ui** (Sonnet). Files: `src/ui/select.ts`, `hud.ts`, `results.ts`, `movelist.ts`, `quotes.ts`, `styles.ts` if a rule is needed. Inputs:
W0-render palette API; W1-char registry entry (code against the literal in E.1; verify once W1-char lands). Read: this plan E;
`docs/UI_STYLE.md` 4 to 7. Tasks: E.1 to E.5 as written. Gates: typecheck, rendertest.

**W1-colours** (Opus; colour judgement). Files: `src/render/palette.ts` (numbers only), `art/trekmore/preview_variants/**`,
`art/aeval/preview_variants/**` (regenerated). Inputs: `palette_measure.json`, W0-render palette code. Read: this plan C.2; `docs/SPEC.md`
8.1. Tasks:
1. Replace provisional band numbers with measured ones for Trekmore glow, Trekmore cloth and Aeval coat; decide the hair question with the
   measure (G.5) and report.
2. Tune red, white, gold until the previews read as those colours at 1x and 3x; gold must read as metal (highlights pale, shade bronze).
3. Regenerate previews for both characters; attach paths. Gates: rendertest, typecheck.

### Wave 2 (after W1). Serial: W2-qa (Sonnet), fix loop

**W2-qa**. Files: fixes in any W1 file and `art/trekmore/sheetmap.json` (holds and frame picks only), ledger `art/trekmore/qa/LEDGER.md`,
screenshots `art/trekmore/qa/*.png`. Inputs: the built game. Read: this plan A.4, D, E; the `browser-automation` skill. Tasks:
1. Start `npm run dev`; open a match Trekmore vs Aeval CPU level 0 on Tidegate.
2. For every animation in A.4 trigger it (debug frame data on) and screenshot; heels on the floor, no box placeholders, no clipped crops,
   hitboxes cover the drawn blade on active frames.
3. Check the echo visible behind jab, ftilt, nair; crit flash; counter vs Aeval's orb and fsmash; recall in four directions; shadow step on
   stage, off the edge in the air, cross-up turn.
4. Check the four colours for both characters on select, HUD, in game, results.
5. Log each defect in the ledger (id, what, where, fix, gate result). Fix one defect per iteration; rerun typecheck, test:sim, rendertest.
   Stop when no open defect is above cosmetic or after 12 iterations.
6. Apply the A.5 pixler gate verdict for `downed`; request `crouch` or `tumble` generation from the lead only for a defect the ledger shows
   reuse cannot fix. Gates: typecheck, test:sim, rendertest, browser.

### Wave 3 (after the brain worker reports done and after W2). Serial: W3a then W3b

**W3a-profile** (Opus). Files: `src/characters/trekmore/ai.overrides.json`, `src/characters/trekmore/ai.profile.cache.json` (generated),
`src/ai/charprofile/overrides.ts` and `cache.ts` (one line each), `src/ai/charprofile/derive.ts`, `probeHit.ts`, `probeMotion.ts`,
`tags.ts`, `combo.ts` (only as far as the new mechanics need). Read: `docs/CPU_PLAN.md` 4.3, `docs/cpu-guide/` 04; this plan B, D. Tasks:
1. Add the OVERRIDE_FILES and CACHE_FILES lines.
2. Teach derive the new mechanics: echo damage and timing folded into `MoveAiInfo` (hit count 2, second hit time), tags `counter` for
   dspecial, `teleport` for nspecial recall and sspecial, recovery routes that include recall (probeMotion samples the five aim directions
   and charge 0, 0.5, 1), crit as expected damage x1.036 on melee.
3. Build the mirror combo table and the Trekmore vs Aeval tables; print `summary()`; echo routes must appear (jab, dtilt, nair starters).
4. Overrides only where derive is wrong; each with a `$comment` reason.
5. Regenerate caches with the REGENERATE_COMMAND. Gates: typecheck, test:ai, test:sim.

**W3b-plans** (Opus). Files: `src/ai/characters/trekmore.ts`, `src/ai/brain.ts` (one import line), `src/ai/contracts.ts` (only if
`PlanFamilyId` is a closed union: add one id `'charPack'`), `src/ai/eval/cases/trekmore.ts`, `src/ai/eval/cases/index.ts` (one group line).
Read: `docs/CPU_PLAN.md` 4.5, 4.7; `src/ai/plans/index.ts` registry comment. Tasks:
1. Plan families registered with `registerFamilies`, each gated to the level vocabulary (none below UI 4, full at UI 7 and up):
   - `trekmore.swordRoute`: throw the sword at the opponent's predicted landing or behind them, recall on the frame that puts Trekmore
     behind or above them, follow with bair, dair or a grab; recovery routes aim up or up-forward from offstage and recall (uses the
     recovery solver input).
   - `trekmore.stepCross`: shadow step through a shielding or whiffing opponent within 96 px, backstrike on the far side; never toward a
     ledge-less side in the air without a recall left.
   - `trekmore.counterRead`: dspecial when the predictor's probability that the opponent's attack becomes active inside frames 5 to 22 is
     above the break-even `p*` (`breakEven` with gain = counter damage, loss = 28 frames of whiff punish).
   - `trekmore.echoChain`: jab, dtilt and nair routes from the combo table that land the echo hit, preferring routes that end with fair or
     uair at kill percent.
2. Harness cases `tk.mirror` (UI 7 mirror, no errors, determinism, each special used at least once per 3 matches), `tk.vsAeval.5`,
   `tk.vsAeval.7`, `tk.vsAeval.10` (Trekmore vs Aeval at the same UI level, win rate within 40 to 60 percent with the Wilson 95 percent
   interval inside 30 to 70 at the fast tier and inside 40 to 60 at full), `tk.god.1v3` (god Trekmore alone vs three teamed UI 4 Aevals,
   gate like `team.1v3.l4`), `tk.metrics` (info: per-move usage share and KO share from the 'hit' `source` of each KO's last hit). Gates:
   typecheck, test:ai, `npx --yes tsx src/ai/eval/main.ts --tier full --only tk.mirror,tk.vsAeval.7`.

### Wave 4 (after W3). Serial loop: W4-balance

Files: `src/characters/trekmore/moves.ts` (numbers only), `balance/trekmore.balance.json`, `docs/TREKMORE_BALANCE_LEDGER.md`,
`src/characters/trekmore/ai.profile.cache.json` (regenerate). Aeval's numbers are frozen in this loop; a change to Aeval needs the lead.
Read: this plan D, `docs/BALANCE_GUIDE.md`. Each loop:
1. Run `tk.vsAeval.7` at 100 paired matches (50 seeds, sides swapped) and `tk.metrics`.
2. Write a ledger entry: win rate with Wilson interval, KO share by move, top 3 moves by usage, hypothesis, the numbers changed (before and
   after), and why.
3. Change at most three numbers, the move with the largest KO share first. Regenerate the AI cache. Rerun test:sim and the loop. Stop when
   the win rate is inside 45 to 55 percent at UI 7 and no move holds more than 40 percent of KOs, or after 4 loops (then report the gap and
   the next change you would make). Gates each loop: typecheck, test:sim, test:ai.

### Wave 5 (after W4). Parallel group: W5-review, W5-docs

**W5-review**: the `code-review` skill at high over the whole Trekmore diff (sim, render, UI, character, AI); findings list with file and
line; fixes only for correctness findings, each with its gate rerun. Files: whatever a finding needs, reported.

**W5-docs** (Sonnet). Files: `docs/SPEC.md` (new sections: "Trekmore move set" after 5, "Trekmore sprites" after 7, "Shadow echo, crit,
counter, recall, shadow step" in 4, palette per character in 8.1), `docs/BALANCE_GUIDE.md` ("Trekmore budget"), `art/trekmore/README.md` is
not created (the cutmap comment and this plan cover it), the lead's memory file
`C:\Users\light_095j4re\.claude\projects\C--Users-light-095j4re-Documents-aevalrena\memory\trekmore.md` plus one index line in `MEMORY.md`.
Gates: none beyond typecheck.

Dispatch summary:

| Order | Group (parallel inside) |
|---|---|
| 1 | W0-art, W0-sim, W0-render |
| 2 | W1-char, W1-ui, W1-colours |
| 3 | W2-qa |
| 4 | W3a-profile, then W3b-plans (needs the brain worker done) |
| 5 | W4-balance |
| 6 | W5-review, W5-docs |

---

## G. Risks and owner decisions

Risks:

1. Mixed camera angles. The three jpegs are front three-quarter view; the pngs are side view. utilt, usmash, uair, uspecial, nspecial, nair,
   spotDodge and parts of dair come from the front view. At 55 px the difference is small for symmetric poses (sword straight up, ring spin,
   dissolve) and larger for the uspecial swing. W2 judges it; the fallback is retiming side view frames, not redrawing.
2. JPEG noise and the checker background may leave dark fringes around near-black armour. Mitigation: flood from cell borders only,
   low-saturation key, median plus 1 px erosion; W0-art shows every jpeg crop on a mid grey contact sheet.
3. Atlas size. About 230 body crops at up to 130 px wide for slashes may pass 1.5 MB base64; palette quantization is the planned fix.
4. Echo strength. Two hits per normal, a separate hit group and crits on both can make jab and nair loops too good. Levers in order: echo
   `damageScale`, echo `delayFrames` (a longer delay lets the victim escape), echo group lists.
5. Recall as recovery. Up aim at full charge plus recall is a 300 px vertical teleport; together with uspecial it could be too safe
   offstage. Levers: `oncePerAir` (on), charged lifetime.
6. Counter plus crit plus weight gives Trekmore a strong disadvantage state; the whiff endlag (28) is the lever.
7. Determinism across builds: the sim changes, so a LAN peer on an older build desyncs against a newer one. The LAN worker should bump its
   protocol version when this lands (not our file).
8. Up special art shows the sword leaving his hand; the body still carries hitboxes. Players may read the sword, not the body, as the
   hitbox. The rising hitbox sits on the body streak.
9. Brain worker overlap: W3 edits `src/ai/charprofile/*`. If the brain worker is still active, W3 waits; no partial W3 starts early.

Decisions the owner may want to revisit:

1. Crit on all melee (echo at half chance) rather than smashes and specials only.
2. The echo latches where the move started and does not follow him; getting hit cancels it.
3. dsmash and the counter branch share the same 9-frame art (the owner's sheet labels it "down smash (counter)").
4. bair uses the left-facing aerial shadow step frames, so his body turns for bair.
5. The Aeval coat band may also tint her hair toward the variant colour.
6. No Final Smash for Trekmore this wave (the Final Smash rule is off by default).
7. Ground shadow step stops at the edge; only the air version can go off stage.
8. One recall and one shadow step per airborne period.
9. LAN shows Aeval's colour names on Trekmore's variant chip until the LAN worker makes its one-line change to `variantNames(charId)`.
10. Variant order for Trekmore: 0 Purple, 1 Red, 2 White, 3 Gold.

