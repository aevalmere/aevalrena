# Trekmore polish wave (2026-09-30)

Owner feedback, verbatim points:
1. Up air, up tilt, up smash all use "the swipey one" (the big crescent swing, `uspec_g_12..17`).
2. Neutral B: fast cast, NOT chargeable; damage grows with distance travelled. Recall teleport stays.
3. Effects mainly particles: crop sheets into particle pieces, not only whole frames.
4. The shadow must be a real dark clone that follows behind him on attacks and visibly attacks.
5. Weird crops, broken images, avatar/hitbox size varies a lot: keep his body one consistent size.
6. Up B: sword thrown UP first, he phases out into particles and materializes OUT of the sword near the top.
7. Counter: the crescent-shield frame parry_parry_2 is GOOD and holds through the window. The broken-counter
   flash/fade parry_parry_3 is removed entirely (owner update: never play it). Window longer.

Owner rule still holds: crop the owner's art exactly, never redraw. Derived pieces may only crop,
rescale, fade or recolour cut pixels. Anything that cannot be fixed that way goes on the
"needs redraw" list for the owner.

## Frozen contract (all workers code against this)

### New generic fields (src/core/types.ts, owned by SIM worker)

```ts
// MoveDef
/** Move frames [start, end] inclusive during which the body is not drawn (render only). */
hiddenFrames?: [number, number];

// ProjectileDef
/** Damage and knockback grow with distance flown since spawn (px). Applied at hit time. */
distanceScale?: { damagePerPx: number; maxDamage: number; bkbPerPx?: number };
```

Projectile state must carry the distance flown (or its spawn x/y) so the scale is deterministic and
survives rollback/state copies like every other projectile field. Aeval-only matches must keep their
exact hashes (the selftest checks this).

### Frame budgets (sim frames at 60 Hz). Art holds MUST sum to these; hit frames MUST line up.

| Anim | Frames (crop names) | Holds | Total | Active hits |
|---|---|---|---|---|
| utilt | uspec_g_12, 13, 14, 15, 16, 17, loco_idle_0 | 7,6,3,3,3,4,12 | 38 | 13 to 18 |
| usmash | uspec_g_12, 13, 14, 15, 16, 17, 19 | 10,11,3,3,3,6,20 | 56 | 21 to 26 |
| usmashCharge | uspec_g_12, uspec_g_13 | 6,6 loop | | |
| uair | uspec_g_12, 13, 14, 15, 16, 17, air_fall_0 | 8,8,3,3,3,3,14 | 42 | 16 to 21 |
| nspecial | nspec_g_0, 2, 3, 4 | 3,3,3,25 | 34 | sword spawns frame 9 (balance pass: total 22 to 34, last hold 13 to 25) |
| nspecialCharge | removed | | | |
| nspecialBranch | unchanged (nspec_g_12..14, 3,4,7) | | 14 | branch 40 to 54 |
| uspecial | uspec_g_0, 1, 2, 7, 10, 11, 12, 13, 14, 15, 16, 17 | 3,3,4,12,4,4,5,5,3,3,3,7 | 56 | sword proj 8 to 21, swing 40 to 46 |
| dspecial (whiff) | parry_parry_0, parry_parry_1, parry_parry_2, parry_parry_0 | 3,3,25,25 | 56 | window 4 to 30 |
| dspecialBranch | parry_counter_1, 2, 3, 4, 5, 6, 7, 8 | 6,4,2,2,4,4,8,14 | 44 | arc 70 to 73, eruption 78 to 81 |

uspecial frames 10 to 21 are `hiddenFrames` (the uspec_g_7 entry is a placeholder; the renderer skips
the body there and draws particles).

### Move changes (SIM worker)

- utilt, usmash, uair: keep damage, angles, bkb, kbg, totals and active frames. Replace the vertical
  sword column with an overhead arc of circles matching the crescent: from up-behind (about 120 deg)
  over the top to in front and slightly down (about -20 deg), centre near (6, -34), radius about 40
  (usmash about 50). Echo stays on utilt and uair.
- nspecial: `chargeable` false, totalFrames 22 (34 after the balance pass), sword `spawnFrame` 9, vx 8,
  lifetime 45 (360 px), no `charged` block. Damage 4 at the hand, +1 per 36 px flown, cap 13 (11 after the
  balance pass) (`distanceScale`), bkb +0.05/px.
  Burst stays but flat 4 damage. Recall and branch unchanged.
- uspecial "Sword Ascent": a new projectile `ascentSword` (sprite `swordUp`) spawns on frame 8 at the
  hand and flies straight up with the same forward drift as the body (1.2 px/f), decelerating
  (use gravity) so it reaches the point where his raised hand will be on frame 22 and dies there
  (lifetime 14). It carries the old rising drag hit (3 dmg, 90 deg, bkb 60, kbg 30). The body keeps
  `ascentVelocity()` unchanged (same 91 px height), `hiddenFrames: [10, 21]`, invuln [10, 21]. Remove
  the old body rising box. Swing on 40 to 46 unchanged. The sword leads the body the whole way up.
- dspecial: counter window 4 to 30, whiff totalFrames 56. Branch unchanged (60 to 104).
- Afterwards: `npx --yes tsx src/ai/charprofile/cache.ts --write`, typecheck, `npm run test:sim`,
  `npm run test:ai`. Log numbers in docs/TREKMORE_BALANCE_LEDGER.md (a new "Polish wave" section).

### Art (ART worker): tools/sheetcut/cut_trekmore.py, art/trekmore/*, generated src/characters/trekmore/art/*

1. Consistent body size. Measure every body crop's scale against the standing 55 px body using a
   body-only metric (helmet width, torso width, helmet-to-hip length), NOT the bbox (sword, cape
   spikes and glow inflate the bbox). Rescale each crop so his body matches loco_idle_0 within 5
   percent. Heel anchor stays the body's lowest core row. Output `art/trekmore/qa/SIZE_STRIP.png`:
   every body anim's frames on one strip with a 55 px guide line, before and after.
2. Clean crops. Audit every crop in the CONTACT sheets for: cut-off limbs or swords at the cell edge,
   neighbour-frame bleed, background blocks, holes in the body, stray specks, captions. Fix by
   re-cutting. Anything unfixable goes in `art/trekmore/NEEDS_REDRAW.md` (crop, source cell, what is
   wrong, what drawing is needed).
3. sheetmap.json: apply the frame budget table above exactly.
4. New fx crops (named exactly; the renderer uses these names):
   - `swordUp`: the lone vertical sword from uspec_g_4 / uspec_g_5 (point up), 2 frames.
   - particle pieces, each a separate single-frame fx anim: `pShard0..3` (small violet armour/glow
     shards, 3 to 8 px), `pSmoke0..3` (dark smoke wisps from the dissolve cells nspec_g_9..14 and the
     cape tatters, 6 to 16 px), `pMote0..1` (bright violet glow dots, 2 to 4 px), `pSliver0..2` (thin
     crescent slivers cut from the slash arcs, 8 to 20 px), `pSpike0..1` (eruption spikes from
     parry_counter_5/6, 10 to 24 px tall).
   Run pack.py so TREKMORE_FX_ANIMS contains them.

### Render (RENDER worker): src/render/*

1. Sprite particle emitters for Trekmore: a pool (no per-frame allocation, same style as
   particles.ts) that draws the `p*` fx crops with position, velocity, gravity, rotation, scale, alpha
   fade and palette tint by variant. Missing crops fall back to rect particles.
2. Effects driven from fighter state (moveId, actionFrame, branch, echo fields), deterministic from
   state, safe to re-run after rollback (no double spawn when a frame is re-rendered):
   - Swing trails: pSliver + pMote along the crescent on active frames of utilt, usmash, uair, ftilt,
     fsmash, fair, bair, and the uspecial swing.
   - uspecial: frames 8 to 12 phase-out (body fades and breaks into pSmoke/pShard that stream upward
     toward the sword), frames 10 to 21 body hidden with a particle stream between him and the sword,
     frames 22 to 29 materialize: particles burst out of the sword and converge into the body (body
     alpha ramps in). `swordUp` draws at the ascentSword projectile.
   - nspecial: the flying sword leaves a pSmoke/pMote trail that grows denser with distance (visible
     cue for the damage scaling); recall teleport gets a phase-out at the start point and a
     materialize burst at the sword.
   - sspecial (shadow step): phase-out and materialize bursts.
   - dspecial: NO counter flash anywhere (owner removed it; do not draw counterFlash). Hit branch:
     pShard burst on the arc, eruption pSpike fountain. Whiff: nothing beyond the stance.
   - hitsparks / KO: add pShard/pMote bursts on Trekmore's hits, including echo hits.
3. The shadow clone: bake the echo as a solid near-black clone (not a faint tint), about 0.9 alpha,
   a thin violet rim, dark smoke pSmoke trailing off it. Between move start and its first replayed
   frame it follows BEHIND him: it rises out of smoke at his back (fighter x minus facing * 18) and
   glides to its latched strike point, then plays the attack, then dissolves into pSmoke. Its hits
   draw normal hitsparks.
4. Honour `MoveDef.hiddenFrames`: skip the body draw (and its outline) on those frames.
5. Update rendertest.ts for the new echo draw and hidden frames.

## QA (after the three merge)

Screenshots of every Trekmore move at 1x and 2x in `art/trekmore/qa/polish2/`, the size strip, and a
browser run of a match (Trekmore vs Aeval CPU) with no console errors.

---

# Round 2 (owner feedback, 2026-09-30 evening)

1. Neutral B: holdable again, but holding ONLY aims. It fires on release; no damage or speed bonus from holding.
2. dair uses the down smash animation (parry_counter_0..8), retimed to dair speed. dsmash keeps it too.
3. fair uses the forward smash animation (heavy_slash_0..5), retimed. fsmash keeps it too.
4. utilt and uair use the PREVIOUS up smash animation (the sword flung up as a column, uspec_g_0..19 subset), not the
   crescent swipe. usmash goes back to it too. Hitboxes return to the sword column (as at commit bfa892a).
5. The shadow clone goes slightly IN FRONT of him, in the direction he is travelling when the move starts, not behind.
6. Run and turn are too big: fix their size.
7. New owner sheets in art/trekmore/source/:
   - twin_strike.png: 2 frames, a long thrust and the big impact burst. Dash attack impact.
   - violet_knight.png: rows DASH ATTACK (SMOOTH) 11 frames, LEDGE HANG (SIDE) 11 frames, CLIMB (UP) 10 frames.
     Ledge rows have a dark stone pillar to the right of him: remove it.
   - dark_knight.png: rows LIGHT HIT REACT 7, STRONG HIT REACT 7, DEAD 7 (the last frames dissolve into smoke).
   These supersede conB_ledge_*, conB_hitLight_*, conB_hitStrong_* and conB_ranged_* (dashatk).

## Round 2 frozen contract

### Sim fields (SIM worker)
- `MoveDef.holdAim?: boolean`: with `chargeable` and `chargeButton: 'special'`, holding pauses the move at its hold
  frame (max 45 frames) WITHOUT any power, speed or lifetime scaling; the projectile aim is read on the release
  frame; a tap behaves exactly as today (sword spawns frame 9, total 34). While holding, the fighter state exposes
  `aimDir?: number` (the aim index the sword would use if released now) for the renderer.
- Echo placement: `EchoDef.offsetX` is now measured along the travel direction at move frame 0:
  dir = sign(vx) when |vx| >= 0.5, else facing. Echo position = owner position + dir * offsetX. Every Trekmore
  echo gets a small POSITIVE offset (about 10 to 24, tuned per move so the echo still connects) so it stands in
  front. The echo keeps the owner's facing.

### Frame tables (holds sum to the totals; active frames line up)

| Anim | Frames | Holds | Total | Active |
|---|---|---|---|---|
| utilt | uspec_g_1, 2, 3, 7, 10, 11, loco_idle_0 | 4,4,3,2,6,8,11 | 38 | 13 to 18 |
| uair | uspec_g_1, 2, 3, 7, 10, 11, air_fall_0 | 5,5,4,2,6,8,12 | 42 | 16 to 21 |
| usmash | uspec_g_0, 1, 2, 3, 7, 10, 11, 19 | 6,5,4,3,3,8,10,17 | 56 | 21 to 26 |
| usmashCharge | uspec_g_0, uspec_g_18 | 6,6 loop | | |
| fair | heavy_slash_0, 1, 2, 3, 4, 5, air_fall_0 | 4,6,2,3,3,10,12 | 40 | 12 to 16 |
| dair | parry_counter_0..8, air_fall_4 | 3,4,4,3,3,3,5,8,7,8 | 48 | spike 14 to 18, late 19 to 24 |
| nspecial | unchanged (with the nosword frames) | | 34 | sword frame 9 (tap) |
| nspecialCharge | the aim hold: nspec_g_2, nspec_g_3 | 6,6 loop | | |
| dashatk | vk_dash_0, 1, 2, 3, twin_0, twin_1, vk_dash_7, 8, 9, 10 | 2,2,2,3,2,8,4,6,6,9 | 44 | 11 to 18 |
| ledgeGrab (new anim name) | vk_ledge_0, vk_ledge_1 | 4,4 | | |
| ledgeHang | vk_ledge_1 .. vk_ledge_8 | 6 each, loop | | |
| ledgeClimb | vk_climb_0 .. vk_climb_9 | sum to the sim's ledge climb length | | |
| hitLight | dk_light_1, 2, 3 | 3,4,60 | | |
| hitStrong | dk_strong_1, 2, 3 | 3,4,60 | | |
| tumble | dk_strong_3, dk_strong_4 | 6,6 loop | | |
| downed | dk_strong_5 | 60 loop | | |
| getUp | dk_strong_5, dk_strong_6 | sum 30 (GETUP.total) | | |
| dead | dk_dead_0 .. dk_dead_6 | ART worker picks, front-loaded | | |
| grabbed, footstooled, shieldStun, fsVictim | dk_light_* / dk_strong_* as fits | | | |

Crop names: `twin_0..1`, `vk_dash_0..10`, `vk_ledge_0..10`, `vk_climb_0..9`, `dk_light_0..6`, `dk_strong_0..6`,
`dk_dead_0..6`. Body size: normalize every new crop to the 55 px standing body (dk_light_0 is a clean side-view
standing reference) and re-check the WHOLE locomotion sheet (idle, walk, run, dash, turn) against it: the owner says
run and turn are too big. Also add `pSmoke4..5` cut from dk_dead_5, 6 smoke.
