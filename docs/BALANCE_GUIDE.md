# Balance Guide for Aevalrena

## Goal
Build a fighter game where characters are different without one character simply being better at everything.

## Shared scorecard
For every character, rate each axis from 0.75 to 1.25 around a 1.00 all rounder baseline:

| Axis | Meaning |
|---|---|
| speed | movement and approach speed |
| weight | resistance to KO |
| range | safe threat distance |
| frameAdvantage | ability to act first after a blocked or landed move |
| killPower | ability to close stocks |
| comboPower | damage from a clean opening |
| recovery | ability to return to stage |
| disadvantageEscape | tools for getting out of pressure |

A character should not receive 1.20 or higher on more than two major axes without paying for it elsewhere.

## Aeval budget
Aeval spends budget on range and recovery. Aeval also gets useful combo routing from dtilt and nair, but that should not become top tier pressure. The weaknesses are low weight, slower close range interactions, and landing commitment on fair, bair, and dair.

## Aeval move pass, 2026-09-29
Source of truth is `src/characters/aeval/moves.ts`; `balance/aeval.balance.json` mirrors it with a
`change_2026_09_29` note per move.

| Move | Before | After | Why |
|---|---|---|---|
| utilt | active 6-11, 24 total, iasa 20 | active 10-15, 30 total, iasa 26 | the anti-air came out before a jumper could commit; 4 more startup and 2 more endlag make it a read |
| usmash | active 12-18, 40 total | active 16-22, 46 total | a kill move that also caught landings on reaction |
| uair | 9 dmg, active 8-12, 30 total, landing lag 11, javelin top y -114 | 8 dmg, active 10-14, 33 total, landing lag 12, top y -110 | juggles were safe and paid too well; it was already slowed once, so this is small |
| fair | 10 dmg, reach 35 | 11.5 dmg, reach 41 (tip circle x 29 r 12 added) | the main spacer lost trades at its own range |
| bair | 11 dmg, reach 34 | 12.5 dmg, reach 41 (tip circle x -29 r 12 added) | the retreating aerial should win where it is thrown |
| nair | 7 dmg, active 5-22, one r 16 circle at x 6, 34 total, landing lag 8, bkb 21 kbg 63 | clean 3-6: 8 dmg, r 22, angle 70, bkb 20 kbg 50; late 7-20: 5 dmg, r 20, angle 60, bkb 12 kbg 40; both centred on the body; 30 total, landing lag 5 | too slow and too small to get out of pressure or start a combo; low knockback keeps it a lead-in to tilts, not a kill move |
| dair | spike, no reward on hit beyond the spike | on a body hit (not a shield): vy -3.5, fast fall cancelled, air dodge back, double jump not, actionable 10 frames after hitlag | the SSBU dair hop: a landed dair keeps Aeval in the air and in the exchange instead of dropping her into 20 frames of endlag |
| nspecial | tap throw frame 11 of 40, chargeCastFrames 16 (full throw 27 of 56) | tap 9 of 31, chargeCastFrames 12 (full 21 of 43) | the cast was too slow to use in neutral; the charge hold itself is unchanged |
| nspecial drain | none | a direct orb hit heals Aeval 35 percent of the damage dealt, floor 0 | rewards landing the orb rather than throwing it for space only |
| dtilt, dsmash, dair | hit a ledge hanger like any move | the only melee that reaches a ledge hanger (`hitsLedge`) | ledge rules, see SPEC 4.5 |

Assumptions: dsmash is not an aerial, so it does not bounce. The burst the orb leaves behind does
not drain; only the orb's direct hit does. Knockout calibration after this pass is in TUNING.md.

## Aeval move pass, 2026-09-30
Owner requests, same sources of truth (`moves.ts`, `balance/aeval.balance.json` with a
`change_2026_09_30` note per move).

| Move | Before | After | Why |
|---|---|---|---|
| sspecial | any number of crescents | one at a time: while hers is alive a side special press does nothing (no move, no turn, no endlag) and she stays actionable | a screen of crescents was too much lane control for no commitment |
| sspecial | 42 total, spawn frame 10 | 30 total, spawn frame 10 | she stood in the throw pose 32 frames after the throw; now 20 |
| crescent | kbg 44 (KO 197, kb at 100 71.2) | kbg 40 (KO 220, kb at 100 66.9) | shorter hitstun and tumble for the victim after the recovery cut |
| nspecial | tap throw frame 9 of 31; full charge 21 of 43 | tap throw frame 3 of 12; full charge 15 of 24 (chargeCastFrames 12 unchanged) | the zero-charge cast was too slow to use as a quick poke; about one third of the old time |
| nspecial hold | 60 frames to full charge | 60 frames, unchanged | see the reading below |
| uair | active 10-14, 33 total | active 14-18, 37 total, endlag and landing lag 12 unchanged | the owner wants it slower again; anim holds [7,7,7,16] put the javelin on frame 14 |
| dair | a 12-16 spike, 12 dmg, 270, bkb 30 kbg 85, 36 total, landing lag 16 | dive smash: 6 frames startup, then an invulnerable drop at 7 px/frame (fast fall is 5, vx zeroed each frame) that holds the spike out until it meets a fighter, a shield or the ground; 14 dmg, 275, bkb 50 kbg 80; 30 total, landing lag 20 | a committal dive: a strong spike and a bounce on contact, 20 frames of lag with no invulnerability on a whiff, and a self destruct off stage |
| dair on shield | no bounce | the same hop and air dodge back, but actionable 15 frames after hitlag instead of 10: about -4 against the shielder (14 damage is 10 frames of shield stun) | shielding the dive should pay a little without letting the shield punish the hop for free |
| every projectile | a crescent (destroyOnHit false) passed through a shield after its hit | any projectile that meets a shield deals its shield damage and is destroyed | shields are the stated counterplay to projectiles |
| dspecial | no heal | each whirlpool hit that lands on a body heals Aeval 50 percent of its damage (healFraction on the hitbox, the orb drain rule), 5 of a full 10 | a multi-hit trap has to be walked into, so it pays more per point than the orb's 0.35 |

Reading of an ambiguous owner line. "The charge and attack should be equal if not more charge" is
read as: the hold to a full charge must last at least as long as the charged cast it buys. The hold
is 60 frames (`TUNING.input.chargeMax`, shared with the smash charge) and the charged cast is
chargeCastFrames 12 plus the 12-frame throw, 24 frames, so the hold already exceeds it and was not
lengthened. If the owner meant the opposite (the cast should grow with the charge), raise
chargeCastFrames instead; the hold is a shared TUNING value and would need a per-move field.

Assumptions: the dive's bounce keeps the existing bounceOnHit values (vy -3.5, air dodge back,
actionable 10). The dive pins the move on frame 6, so the existing anim shows its strike pose
(special_dair_2) for the whole drop; the holds are [3,3,3,3,8,10]. The dive landing uses the move's
landingLag (20), which also applies if she lands during the 6 startup frames or the 10 bounce
frames. Shield breaking applies to every projectile of every character, not only Aeval's.

## How to tune a move
Change one or two knobs at a time.

First identify the gameplay problem. Example: Aeval wins neutral too often with Tidal Crescent.

Then decide whether the issue is:
startup, endlag, projectile speed, projectile lifetime, range, damage, knockback, safety, or reward on hit.

Use the smallest change that fixes that exact issue. Do not reduce damage when the real problem is that the projectile is too safe on whiff.

## Telemetry to add later
Record per stock and per match:

`neutral_openings`
`damage_dealt`
`damage_taken`
`kill_move`
`projectile_attempts`
`projectile_hits`
`whiffs`
`shield_damage`
`time_disadvantage`
`recoveries_attempted`
`recoveries_successful`

This lets future balance changes be based on behavior rather than intuition alone.

## Archetype starters
Rushdown: higher speed and frame advantage, lower range.
Zoner: higher range, lower close range frame advantage.
Heavy: high weight and kill power, lower mobility and disadvantage escape.
All rounder: all axes near 1.00.
Aerial specialist: stronger air speed, aerial pressure, and recovery, weaker grounded control.

## Anti power creep rule
When a new character gets a stronger version of an existing tool, it must pay somewhere. A projectile can be faster, larger, stronger, safer, or longer lived, but giving it all five properties is not acceptable.
