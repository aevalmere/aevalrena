# Trekmore: needs redraw (polish wave and Round 2, 2026-09-30)

Crops that cannot be fixed by cropping, rescaling, fading or recolouring the owner's pixels. Each entry names the
crop, where it comes from, what is wrong, and the drawing that would fix it. Everything else found in the crop
audit was fixed by re-cutting (see CUT_NOTES.md, "Polish wave").

| Crop | Source cell | What is wrong | Drawing needed |
|---|---|---|---|
| nspec_g_9, nspec_g_10, nspec_g_11, nspec_g_12, nspec_g_13 (spotDodge, nspecialBranch) | neutral_special.jpeg cells 10..14 | The dissolve is painted as very faint smoke only a few levels above the navy background. Keying gives a solid dark blob with straight sides; the smoke has no edge to cut along. Kept because it reads as "turned to smoke" at 55 px, but it looks like a cut-out block when zoomed. | The dissolve and reform as 4 to 5 frames on pure black: body breaking into smoke wisps and violet motes (clear gaps between wisps), then the reverse, same front three-quarter view. |
| conB_slash_0..3 (jab) | concept_b.png small panels (40 to 60 px figures) | Body size is matched (x1.3), but these sprites are upscaled from about 45 source px, so they are softer and less detailed than the locomotion / heavy slash frames next to them. Round 2 replaced the other small panels (dash attack, fair, hits, tumble, grabbed, dead, ledge) with the owner's new sheets. | A 4-frame jab at the locomotion.png scale on black. |
| conA_slash_0..2 (ftilt) | concept_a.png ATTACKS / Normal Slash, x 526..826, y 486..597 | Same as above: 3 small figures (about 60 px) upscaled x1.25 to body size; the crescent in slash_2 overlaps the next panel's rule area. The plan wanted 4 frames; only 3 exist. | A 4-frame forward tilt slash at the heavy_slash.png scale on black. |
| parry_parry_3 | parry_counter.png parry row, frame 4 | The owner banned this frame from every anim (broken fade / scatter). It is used only as a particle source (pShard0..2). | None unless the owner wants a new counter-whiff recovery frame. |
| uspec_g_7 (uspecial placeholder, hidden frames 10 to 21) | up_special.jpeg cell 8 | The vertical streak is a front-view smear; the renderer hides the body there and draws particles instead, so nothing ships from it on screen. | None needed for this wave. If the owner wants the phase-out drawn: 3 frames of the body breaking into smoke and shards streaming upward, side view, on black. |

## Round 2 (new owner sheets twin_strike.png, violet_knight.png, dark_knight.png)

Solved and removed above: the ledge hang and climb (conB_ledge, now vk_ledge / vk_climb with the stone pillar erased),
the dash attack (conB_ranged, now vk_dash + twin), forward air (conB_aerial, now heavy_slash), the hit reactions,
tumble, downed, get-up and dead (conB_hit*, uspec kneel, now dk_light / dk_strong / dk_dead).

Still open from the new sheets:

| Crop | Source cell | What is wrong | Drawing needed |
|---|---|---|---|
| vk_ledge_0 (ledgeGrab) | violet_knight.png LEDGE HANG frame 1 | The reach has no ledge drawn, so its anchor is set from the reaching hand by eye (corner about 18 px left of and 6 px below the fist), not measured like the other hang frames. | Optional: the same reach with the hand touching a ledge corner. |
| vk_climb_4..9 (ledgeClimb) | violet_knight.png CLIMB row | The drawn ledge top widens as he climbs (the slab grows to the left), so the frames do not share one corner. The anchors use the pillar's right edge minus the hang width and slide the last frames 22 game px inward so the final heel lands where the sim puts him (corner + 14). | Optional: the climb on one fixed ledge corner. |
