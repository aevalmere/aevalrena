# Wave 3: extra sheets (lead-owned contract)

Two new owner sheets, already copied in:

- `art/aeval/sheets/extra.png` (1536x1024): aerials, air jump, dash/turn, taunts, final smash.
- `art/aeval/sheets/uptilt.png` (1536x1024): one row, "UP SPIKE (SPIKE JAVELIN ABOVE HEAD)", 5 frames.

Same rules as CUT_SPEC.md: crop the owner's pixels exactly, never redraw; captions, titles,
horizontal and vertical divider lines never appear in a crop; character faces RIGHT.

## 1. Rows to cut (sheet `extra`)

Measure the y bands and x blocks yourself (the sheet has blocks side by side, split by thin
vertical cyan lines). Crop names `extra_<row>_<n>`, n from 0.

| row       | where on the sheet                         | frames |
|-----------|--------------------------------------------|--------|
| nair      | top-left block "NEUTRAL AIR SPIN"          | 5 |
| fair      | top-middle block "FORWARD AIR"             | 5 |
| bair      | top-right block "BACK AIR"                 | 5 |
| airjump   | second band left "AIR JUMP"                | 4 |
| dash      | second band middle "DASH START / TURN AROUND" | 3 (0 dash start, 1 dash, 2 turn around) |
| taunt     | second band right "TAUNTS"                 | 3 (0 look around, 1 meditate, 2 smirk) |
| tornado   | final smash band, middle block "2. TORNADO"| 3 (0 lift, 1 spin, 2 full tornado) |

Do NOT cut: "1. TSUNAMI SUMMON", "3. LAUNCH", or anything in the bottom cinematic row.

Tornado frames contain the FS victim inside the water. The body test (coat ink) may find a
body; anchor = body heel as usual. If the body is too hidden to anchor, anchor at the bottom
centre of the crop and say so.

Sheet `uptilt`: row `spike`, 5 frames -> `uptilt_spike_0..4`.

Per-sheet scale as before: 48 / standing body height. For `extra` use `taunt_0` (standing)
as the reference; for `uptilt` use frame 0 (a crouched wind-up) and 4 (recover) — take the
recover frame's body height as the reference.

## 2. sheetmap.json (the worker may edit these entries only)

```
nair      extra_nair_0..4                 holds [5,6,6,6,11]      (28)
fair      extra_fair_0..4                 holds [5,5,4,6,12]      (check totalFrames in moves.ts; scale holds to sum to it, keep the swing frame on the hitbox start)
bair      extra_bair_0..4                 see section 3
jump      keep; add new anim "airJump" = extra_airjump_0..3 holds [3,4,5,60] loop false
dash      extra_dash_0, extra_dash_1       holds [6,6]
turn      extra_dash_2                     holds [6]
taunt     extra_taunt_0 holds [90]; taunt2 extra_taunt_1 [90]; taunt3 extra_taunt_2 [90]
fsVictim  extra_tornado_0,1,2,1,2          holds [8,8,8,8,8] loop true
fsStart   special_whirl_1,2,3              holds [7,7,6]  (Aeval casting = the swirl)
fsTornado special_whirl_3,4                holds [10,10] loop true
utilt     uptilt_spike_0..4                holds [4,2,3,6,9]     (24; javelin rise on 6 = hitbox start)
usmash    uptilt_spike_0..4                holds [6,6,3,6,19]    (40; rise on 12 = hitbox start)
usmashCharge uptilt_spike_1, uptilt_spike_0 holds [6,6] loop
uair      uptilt_spike_0..4                holds [3,3,2,5,13]    (26; rise on 6 = hitbox start)
```

For every move, check `totalFrames` and hitbox `start` in `src/characters/aeval/moves.ts`; the
holds must sum to totalFrames and the frame where the attack's water appears must begin on the
first active hitbox frame. Adjust holds if the numbers above are off; report what you changed.

`airJump` must actually play: if the sim/renderer has no double-jump anim hook, make `animFor`
return `airJump` while the fighter is in the jump action and has used its double jump within
the last ~15 frames (read the fighter state fields; render-side only, no sim changes). If that
needs sim state that does not exist, skip it and report.

## 3. Back air direction

The bair hitbox is BEHIND Aeval (negative x in moves.ts). Crops face right, so "behind" is the
LEFT of the body in the crop. For each bair crop compute the water centroid x relative to the
body heel x. If on the active frames the water is on the LEFT: `mirror: false`. If it is on the
RIGHT: `mirror: true` (the whole anim draws flipped, so the swing lands behind). Report the
numbers. Then check in game: facing right, bair's water must appear on the LEFT of the fighter
(screenshot `bair_check.png`).

## 4. Stretch the up-javelin hitboxes (owner approved)

`utilt`, `usmash`, `uair` in `src/characters/aeval/moves.ts`: measure from `uptilt_spike_2`
(rise) and `uptilt_spike_3` (extend) where the javelin is relative to the heel anchor, in game
pixels (crop px = game px): its x centre and its top y. Keep the existing circle (id 1, y -44).
Add circles along the javelin column from y -44 up to the javelin tip, spacing <= radius so
there are no gaps, same damage / angle / bkb / kbg and the SAME group as the existing circle
(so a target is hit once). Radius 10 (usmash 12). Time them: circles above the rise frame's tip
only become active on the frame the extend crop starts (use the holds). Do not change any other
number in moves.ts. If `box()` or HitboxDef can't express this, report it.

Also keep `balance/aeval.balance.json` in sync if it lists these hitboxes.

## 5. Gates

cut.py exit 0 (all rows at expected counts), pack.py exit 0, `npm run typecheck`,
`npx --yes tsx src/render/rendertest.ts`, `npm run test:sim` all exit 0. If a sim test pins the
old utilt/usmash/uair hitboxes, update only that expectation and report it.

Browser screenshots in `art/aeval/sheets/crops/`: `w3_utilt.png` (javelin at extend, with the
debug hitbox view on if the game has one), `w3_nair.png`, `bair_check.png`, `w3_taunt.png`.
Read them yourself.

## 6. Two fixes carried over from the up-special job

a. Grounded up special does not rise: `src/sim/physics.ts` zeroes vy while `onGround`, and the
   move's `velocity` entry `{ frame: 8, vy: -6.5, setY: true }` never clears `onGround`. Fix in
   the sim: when a move velocity entry sets a negative vy (upward) with `setY`, the fighter leaves
   the ground that frame (clear onGround / enter the airborne state the same way a jump does),
   so from the ground he rises exactly as he does from the air. Keep it deterministic. Add a
   selftest case in `src/sim/selftest.ts`: grounded uspecial, heel y is at least 40 px above
   the floor by action frame 20. `npm run test:sim` must pass.
b. The geyser column must draw BEHIND the fighters (it currently draws after them in
   `src/render/index.ts` via drawFighterFx). Draw the latched geyser before drawFighters; the
   whirl and other fighter fx keep their current order.

Screenshots `w3_usp_ground1.png` / `w3_usp_ground2.png`: up special from standing on the
floor, at launch and ~15 frames later: he must be clearly above the column's base, column behind him.
