# 01. Sim facts and Ultimate reference

Everything the brain needs to know about the rules of the game, with the Super Smash Bros. Ultimate
number beside each Aevalrena number so the coding agent knows which pro-level knowledge transfers and
which does not. Aevalrena values were read from the repository source (paths given), not from
`docs/SPEC.md`, because the spec and the code disagree in several places (listed at the end).
Ultimate values are from SSBWiki and the community calculator, cited inline.

Rule zero for the coding agent: the forward model is the source of truth. Every number here is a
planning aid. Any decision that depends on a frame or a pixel is confirmed by cloning the state and
calling `stepGame`. Off-by-one conventions differ between the wikis and the sim, and stage data is
read from the live `StageDef`, never from this file.

## 1. Frame step and determinism

- 60 Hz, one `stepGame(state, inputs)` per frame, pure, no DOM, RNG in `state.rng` (`docs/SPEC.md`
  section 2, `src/sim/index.ts`).
- Step order: inputs consumed, hitlag decrement, fighter update (state machine, physics, ledge grab,
  blast check), projectiles, hit resolution, match rules. `updateFighter` runs before `resolveHits`,
  which is why a ledge grab and a hit on the same frame resolve as a grab (`src/sim/index.ts`).
- A two-fighter step costs about 1.5 microseconds on the dev machine (`docs/CPU_AEVALMERE.md`).
  2,600 steps is about 3.9 ms; 20,000 steps is about 30 ms.
- The LAN host runs every CPU and sends its inputs as if a human had pressed them, so peers never
  re-run the brain; a rollback replays inputs, not decisions (`docs/LAN.md` section 5,
  `src/net/rollback.ts`). Consequence: the brain may keep hidden memory, but it must be a pure
  function of (state history, seed, level) so a replay of the same seed reproduces the same match.
- `Math.sin` and `**` can differ across JavaScript engines; the sim already calls `Math.cos` and
  `Math.sin` for launch direction (`src/sim/hits.ts`, `docs/LAN.md` section 10). Decision code must
  not add `exp`, `pow`, `log`, `tan` or `atan2`; use the sim's own functions or lookup tables
  (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math).

## 2. Damage, knockback, launch

Knockback, `src/sim/hits.ts` (`p` = victim percent after the hit, `d` = damage, `w` = weight):

```
kb = ((((p/10) + (p*d/20)) * (200/(w+100)) * 1.4) + 18) * (kbg/100) + bkb
```

This is the Smash 4 and Ultimate expression (https://www.ssbwiki.com/Knockback), minus three
Ultimate terms that Aevalrena does not have: rage (1.0 at 35% to 1.1 at 150%,
https://www.ssbwiki.com/Rage), stale-move negation (queue of 9, freshness bonus 1.05, fully stale
0.4695, https://www.ssbwiki.com/Stale-move_negation) and set knockback.

| Quantity | Aevalrena (code) | Ultimate | Source |
|---|---|---|---|
| Launch speed | `kb * 0.06` px/frame (`KB_TO_VEL`) | `kb * 0.03` units/frame | https://www.ssbwiki.com/Knockback |
| Launch decay | 0.051 per frame along the launch vector (`KB_DECAY`) | 0.051 | same |
| Gravity in launch | separate fall term, +gravity per frame, capped at `maxFall` | same shape; fall speed fixed 1.8 for angles 70 to 110 | same |
| Hitstun | `floor(0.4 * kb)` | `floor(0.4 * kb) - 1`, then "balloon" speed-up above 32 frames | https://www.ssbwiki.com/Hitstun |
| Tumble | `kb >= 80` (`TUMBLE_KB`) | hitstun 32 or more, which is kb 80 | https://www.ssbwiki.com/Tumble |
| Hitlag | `min(20, floor(d*0.5) + 4)`, both fighters, same on shield | `floor(d*0.65 + 6)`, cap 30, 1.5x electric, 0.67x on shield | https://www.ssbwiki.com/Hitlag |
| Sakurai angle (361) | 0 degrees below kb 60, 40 at or above (a step) | 0 to 38 degrees ramp between kb 60 and 88; airborne victims always 38 | https://www.ssbwiki.com/Sakurai_angle |
| Hitstun cancel | none | air dodge from frame 40, aerial from 45, nearly inert because of balloon knockback | https://www.ssbwiki.com/Hitstun_canceling |
| DI | none | rotation up to 0.17 rad (9.74 degrees) by the perpendicular stick component, read on the last hitlag frame | https://www.ssbwiki.com/Directional_influence |
| LSI | none | launch speed x1.095 (stick up) to x0.92 (down), off for angles 65 to 115 and 245 to 295 | same |
| SDI, ASDI | none | 2 units per pulse, 4-frame gap, x1.15 per 5 consecutive hits | https://www.ssbwiki.com/Smash_directional_influence |

Consequences for the brain:

1. Victim motion during hitstun is a pure function of the hit. Combo tables built from the forward
   model are exact for every knockback value. There is no DI reply model to keep.
2. Aevalrena hitstun is longer than Ultimate's at high knockback (kb 145 gives 58 frames here, 41
   in Ultimate, https://www.ssbwiki.com/Hitstun). Do not import Ultimate combo percent windows.
3. Launch distance scales with kb squared. Closed form for the end of hitstun (verified against the
   sim to four decimals on a probe hit, see research report 01):

```
v0 = 0.06 * kb ; T = floor(0.4 * kb)
L(T) = T*v0 - 0.051*T*(T+1)/2                         # distance along the launch vector
n = floor(maxFall / gravity)                          # 21 for Aeval
G(T) = gravity*T*(T+1)/2                 if T <= n
     = gravity*n*(n+1)/2 + maxFall*(T-n) otherwise    # downward drop from the gravity term
x(T) = x0 + cos(a)*L(T) ; y(T) = y0 - sin(a)*L(T) + G(T)   # y grows downward
```

   Use it to prefilter; use the sim to decide.
4. After hitstun the fighter keeps its velocity: `vx` moves toward 0 by `airFriction` per frame,
   `vy` is `min(vy + gravity, max(maxFall, vy))`, so a spiked fighter keeps its downward speed
   (`src/sim/physics.ts`). That is why a spike ends a stock faster than free fall.

## 3. Shield, dodges, out of shield

| Mechanic | Aevalrena (`src/core/constants.ts`, `src/sim/actions.ts`) | Ultimate | Source |
|---|---|---|---|
| Shield HP | 60, decay 0.12 per frame held, regen 0.07 | 50, decay 0.15, regen 0.08, shield damage x1.19 | https://www.ssbwiki.com/Shield |
| Shield stun | `floor(0.6 * d) + 2`, every hit type | `floor(0.8*d*t*m*p + 2)`, t = 0.725 smash, 0.33 aerial, p = 0.29 projectiles | https://www.ssbwiki.com/Shieldstun |
| Pushback | defender `vx += 2`, attacker none | defender `min(1.3, (stun+1)*0.09)`, attacker `d*0.04 + 0.025` | https://www.ssbwiki.com/Shield |
| Shield break | 180 frames fixed, shield resets to 30 HP | `400 - percent` frames, mash-out, resets to 37.5 | https://www.ssbwiki.com/Stun |
| Shield drop lag | none found (unverified) | 11 frames | https://www.ssbwiki.com/Shield_drop |
| Parry | none | release inside 5 frames of the drop, no shield damage, act at once | https://www.ssbwiki.com/Perfect_shield |
| Out of shield | jump, grab, up smash, up special, roll, spot dodge only | jump (3f squat) then any aerial, usmash, up B, grab (+4f after stun) | https://www.ssbwiki.com/Out_of_shield |
| Spot dodge | 22 total, invulnerable 3 to 17 | Mario 25, intangible 3 to 17 | https://ultimateframedata.com/mario |
| Roll | 24 total, dodges non-low hits 3 to 16, 80 px (`ROLL.distance`; SPEC says 60) | forward 29 (4 to 15), back 34 (5 to 16) | same |
| Air dodge | 34 total, invulnerable 2 to 31, directional, one per airborne period, not refunded by a hit | neutral 52 (3 to 29), directional 71 to 116 (3 to 21), refunded by a hit or ledge grab | https://www.ssbwiki.com/Air_dodge |
| Dodge staling | none | duration x(1 + P), P up to 0.3 or 0.5, later intangibility | https://www.ssbwiki.com/Roll |

Two Aevalrena specifics the brain must model:

- A roll does not dodge "low" hits: dtilt, dsmash, hits flagged low, or any hit centered within
  14 px (`LOW_HIT_HEIGHT`) above the roller's feet from a grounded attacker (`src/sim/dodge.ts`).
  A low poke beats a roll on every frame.
- Shield in the air is an air dodge; Shield on the ground never rolls. Rolls come from a second
  press of the same direction inside 12 frames (`rollTapWindow`) or the Dodge button
  (`src/sim/input.ts`). The executor's tap mirror exists because of this (see 02, section 12).

Aeval utilt on shield, worked (`docs/SPEC.md` table, `src/characters/aeval/moves.ts`): 7 damage,
stun `floor(4.2) + 2 = 6`; hit on frame 6, iasa 20, so the attacker has 14 frames of lag left:
the defender is free about 8 frames before the attacker, enough for a grab (active frame 7).
Confirm every such number in the forward model; the +1 convention is not settled.

## 4. Movement and jumps (Aeval)

`src/characters/aeval/moves.ts` (code, not SPEC): weight 88, walk 1.3, run 2.6, dash 2.8 for 12
frames, ground accel 0.35, friction 0.22, air speed 2.0, air accel 0.14, air friction 0.03, gravity
0.15, max fall 3.2, fast fall 5.0, jump 5.4, short hop 3.5, double jump 5.0, 2 jumps, jump squat 3.

- Full hop rise about 100 px (probe), short hop about 43 px, double jump about 81 px, apex 32 frames
  after the input, back at launch height after 68 frames (research report 05 probes).
- `jumpsLeft` is `def.jumps - 1 = 1` after a ground jump and 2 after landing, so a fighter knocked
  off the stage without jumping has two midair jumps (`src/sim/actions.ts`; flagged as possibly
  unintended in report 05).
- Holding a direction dashes; the Walk bit walks; reversing mid-dash restarts the dash at once
  (`locomotion`, `src/sim/actions.ts`). The 14-frame `dashRetapWindow` is unused by the sim.
- Only up smash and up special cancel a jump squat (test `bg`, `src/sim/selftest.ts`); other moves
  pressed in the squat come out as aerials. Ultimate: jump squat 3 for everyone but Kazuya
  (https://www.ssbwiki.com/Jump).
- Landing lag 4 (2 soft) normally, the move's `landingLag` during an aerial.
- Input buffer 6 frames, one entry, a fresh press replaces it, it keeps ageing through hitlag
  (`src/sim/input.ts`). Ultimate's buffer is 9 frames (https://www.ssbwiki.com/Buffer). Smash tap
  window 5 frames for all four smashes; Ultimate's forward smash window is 5, 6 or 7 by stick
  sensitivity (https://www.ssbwiki.com/Control_stick).

## 5. Ledge

`src/sim/ledge.ts`, probed in report 05:

- Grab condition: airborne, `vy > 0`, not in hitstun, tumble, attack or footstooled, not in the
  12-frame cooldown after a drop or ledge jump, ledge free, `ledgeGrabBox` (Aeval w 20, h 24,
  yOff -30) overlapping a region hanging off the corner. Probe: feet within x in
  [corner - 2, corner + 30] and depth 1 to 72 below the top. The fighter must face the stage, move
  toward it, or hold toward it. A rising fighter never grabs. Facing away with no input never grabs.
- Hang invulnerability: 40 frames on grabs 1 to 3 since the last landing; none from grab 4
  (`LEDGE_MAX_REGRABS`). A hang never times out. Dropping does not clear leftover invulnerability;
  a drop-regrab stall gives 66 continuous invulnerable frames (grabs at 0, 13, 26, 39, then 27, 14,
  1 leftover). Regrab count resets on landing, climb, roll or KO, not on hitstun.
- Occupied ledge cannot be grabbed (`ledgeTaken`): there is no ledge trump; edge-hogging works.
- No 2-frame window: the grab sets `invuln = 40` before hits resolve on the same frame. The
  equivalent is a hit that resolves on the frame before the grab frame, which gives hitstun and
  cancels the grab.
- Options from any hang frame (no 19-frame lockout as in Ultimate): climb 30 frames, invulnerable
  0 to 28, arrives 14 px inside; attack (`ledgeatk`) 40 frames, invulnerable 0 to 22, hitbox 18 to
  24, so frames 23 and 24 are active and vulnerable; roll 24 frames, invulnerable throughout,
  appears 34 px inside on frame 24, actionable at once; jump: 12 invulnerable frames, actionable next
  frame, one midair jump left; drop: no invulnerability beyond leftover, regrab blocked 12 frames.
- Hang hurtbox after invulnerability: the crouch box (26 by 26 px) from 6 px above the platform top
  to 20 px below, centered on the corner.

Ultimate for comparison: intangibility `60*(a/300) + 44 - 44*(p/120)` frames (min 23, max 123)
plus a 19-frame grab animation, hang limit 6.5 s, 6 grabs before landing, getup intangibility x0.8
then x0.5 then none on regrabs, ledge trump replaces hogging, a 2-frame vulnerability before
intangibility (https://www.ssbwiki.com/Edge). Lucario's first-grab options: neutral getup intangible
1 to 33 of 40, roll 1 to 26 of 45, jump 1 to 12 (https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups).

## 6. Tech, knockdown, footstool, grab

- Tech: press window 20 frames before landing, 40-frame lockout after any Shield, Dodge or tech
  press; tech in place 26 frames (intangible to 20), tech roll 40 frames (intangible to 20, 40 px)
  (`TECH`, `src/sim/tech.ts`). Ultimate: 11 frames and 40 lockout (https://www.ssbwiki.com/Tech).
  In tumble any non-tech press ends the tumble into `air` and throws the tech away.
- Missed tech: `downed` up to 120 frames (`KNOCKDOWN`), getup 30 (intangible to 22), getup roll 35
  (to 25, 40 px), getup attack 34 (intangible 0 to 13, hitboxes 14 to 20 both sides).
- Footstool: an airborne Jump with feet 0 to 12 px above another fighter's hurtbox top and within
  half its width plus 6 px; the victim cannot act for 30 frames grounded or 20 airborne, and in the
  air `vy` is set to 6 (above max fall), a drop of about 120 px (`src/sim/footstool.ts`).
- Grab: standing 30 frames, active 7 to 8; dash grab 38, active 9 to 10, 45 px. Hold
  `round(60 + 0.5 * percent)` frames, minus 4 per mash press (every distinct bit counts,
  `src/sim/grab.ts`). Pummel 1.5 damage, 16 frames, hits frame 4. Throws
  (`src/characters/common/grabkit.ts`): fthrow 24 total, release 10, 8 dmg, angle 40, bkb 60, kbg
  60; bthrow 30 total, release 14, 9 dmg, angle 40, 65/65 (holder turns first); uthrow 28, release
  12, 7 dmg, angle 90, 70/55; dthrow 26, release 12, 6 dmg, angle 70, 50/40. A throw direction held
  after 8 hold frames picks the throw. Release: holder 10 frames of lag, victim 12 frames of hitstun
  with a 2.5 push. No post-release grab immunity was found (Ultimate: 60 frames,
  https://www.ssbwiki.com/Grab). Ultimate hold `floor(90 + 1.7*p)`, minus 8 per stick input and
  about 14.4 per button.

## 7. Match, respawn, stage

- KO: stocks minus one, `dead` for 60 frames (`DEAD_FRAMES`, `src/sim/match.ts`), then `respawn`
  at `stage.respawn` (Tidegate (0, -160)) with `invuln = 120` set at the moment of respawn. The
  platform holds the fighter until any button press or 180 frames (`stepRespawn`). Invulnerability
  and platform time run concurrently, so a fighter that presses nothing is unhittable for
  60 + 180 = 240 frames after a KO and drops with no invulnerability left.
- Fighters in `dead` or `respawn` cannot be hit (`canBeHit`, `src/sim/hits.ts`).
- Timeout: most stocks, then lowest percent (`decideWinner`).
- Tidegate (`src/stages/tidegate/data.ts`, `geometry.ts`): main platform x -248 to 248, top at
  y 0, side discs x -234 to -100 and 101 to 235 at y -84, blast rect `{x: -598, y: -447, w: 1176,
  h: 752}` (left -598, right 578, top -447, bottom 305), spawns (-165, 0), (165, 0), (-55, 0),
  (55, 0). Hearthmoor: main x -298 to 298, blast x -578 to 598, y -394 to 358. The SPEC's numbers
  (-180..180, blast -420..420) are stale. Read `STAGE_DEFS` at run time.
- Fall from the ledge height to the lower blast line: about 120 frames with no fast fall
  (report 05, derived from gravity 0.15 and max fall 3.2).
- Final Smash meter: `FS_METER` in `src/core/constants.ts`; the rule is optional
  (`docs/DECISIONS.md` 2026-09-13). Tidal Judgement command-grabs at any range on frame 20,
  45 damage total, KOs from about 39% at Tidegate center (`docs/DECISIONS.md`).

## 8. Aeval move data, as the brain reads it

Authoritative: `src/characters/aeval/moves.ts`. The SPEC table is a guide. Per move the brain needs:
`totalFrames`, hitbox `start`/`end`, `iasa`, `landingLag`, hitbox circles (x, y, r, damage, angle,
bkb, kbg, group), `chargeable`, `invuln`, `helplessAfter`, projectiles (spawn frame, vx, vy, gravity,
lifetime, r, damage, angle, bkb, kbg, `strength`, `charged` fields, `chargeCastFrames`,
`destroyOnHit`, returns).

Kill percents against a passive weight-88 victim at Tidegate center, from `src/sim/calibrate.ts`
(report 01 ran it read-only): fsmash 121 (79 full charge), usmash 134 (90), dsmash 134 (92),
uspecial 127, bair 141, fair 155, uair 181, utilt 193, dspecial 194, sspecial 197, ftilt 198,
dtilt 213; jab, dash attack, nair and dair never kill from center; charged nspecial 108. Note the
disagreement with `docs/DECISIONS.md` (2026-09-10: fsmash KOs at 64) and with
`docs/CPU_AEVALMERE.md` (kills at about 100 to 140): balance has moved. The brain never hard-codes
these; it probes them at load (see 04).

Projectile clashes compare `strength` only: strictly stronger destroys weaker and flies on, equal
destroys both, a destroyed shot still bursts (`src/sim/hits.ts`). Tiers: jab drop 1, orb 2 to 10 by
charge (2 + 8c), crescent 4. The orb passes the crescent at about 21 held frames. Ultimate uses a 9%
damage rule instead (https://www.ssbwiki.com/Priority); do not port it.

Orb charge (`src/sim/projectiles.ts`): `c = (0.6 * 2.5^t - 0.6) / 0.9` with `t` = held/60, so the
last quarter of the hold is worth the most; cast delay after release is `round(16 * t)`. Stats at
hold 0, 30, 45, 60: damage 4, 8.6, 11.9, 16; speed 3.5, 5.8, 7.5, 9.5 px/frame; range about 186,
266, 307, 341 px (report 21 arithmetic). No charge cancel exists: release fires.

## 9. Mechanics the sim lacks, and what the brain does about each

| Absent | Brain treatment now | Recommendation to the owner |
|---|---|---|
| DI, SDI, LSI | combos exact; no DI reply model | do not add for the CPU project (retests every combo); if added, model 3 victim replies (none, survival, escape) and score by the worst |
| Parry | shield is never punished for timing; on-shield advantage is stun arithmetic | optional rule flag; if present the god tier needs a human window or it parries everything |
| Rage | kill tables keyed by victim percent only | add only for comebacks; then key tables by attacker percent too |
| Stale-move negation | repetition costs nothing; the brain keeps its own staleness cost | add (queue of 9, Ultimate reductors, 1.05 fresh); it is the main brake on a search brain repeating one kill move, and it lets the brain read staleness from state |
| Hitstun cancel, balloon knockback | none needed | no change |
| Ledge trump, 2-frame, airtime-scaled invulnerability, 6-grab cap | edge-hog is a first-class plan; pre-grab hit replaces the 2-frame | add trump if Ultimate edge play is wanted; the smallest 2-frame change is delaying `invuln = 40` by two frames in `grabLedge` |
| Grab release immunity | chain grabs on a passive victim are possible | add 60-frame immunity if chain grabs are unwanted; a search brain will find them |
| Wall jump, wall and ceiling tech | only floor techs | no change |
| Charge cancel | a charge that becomes unsafe can only be fired early | optional: cancel with shield or jump at a fixed lag (Ultimate uses 4 frames) |
| Dodge staleness | the level tables cap dodge repetition | optional |

## 10. Spec-versus-code discrepancies the coding agent must not trip on

- Stage geometry and spawns (section 7). Read the registry.
- `ROLL.distance` 80 in code, 60 in SPEC; roll frames 24 with dodge frames 3 to 16 (SPEC section 3
  lists an older 30-frame roll).
- Dash starts on a held direction, not a tap (`locomotion`); SPEC 4.2 says tap.
- Air speed 2.0 and air accel 0.14 in code; SPEC says 1.7 and 0.12.
- Kill percents: three documents give three answers; probe.
- The SPEC's CPU section (4.7) describes the original 250-line level 1 to 3 CPU; the real code is
  `src/ai/index.ts` (levels 1 to 9, 3,200 lines) and `src/ai/aevalmere.ts` (level 10).

## 11. Ultimate reference numbers with no Aevalrena equivalent

Kept for the designer calibrating "feel", all from the pages cited: Ultimate input lag about 5.9
frames before the display (https://www.eventhubs.com/news/2018/dec/11/super-smash-bros-ultimate-reportedly-features-highest-input-lag-series);
a browser game has no such delay, so human reactions in Aevalrena are 3 to 4 frames faster in sim
terms than in Ultimate (report 07). Ultimate mash rules: one input per frame, same button every 2
frames, alternating buttons every 3; level 9 CPU mashes every 2nd to 3rd frame, level 3 every 12th
to 13th, levels 1 and 2 never (https://www.ssbwiki.com/Button_mashing). Ultimate CPU internal
level values 0, 15, 21, 31, 42, 48, 60, 75, 100 for levels 1 to 9
(https://www.ssbwiki.com/Artificial_intelligence).
