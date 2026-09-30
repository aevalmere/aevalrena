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
