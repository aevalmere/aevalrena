# Aeval frame manifest — the authoritative frame list

Owner decision: attacks get 4-6 frames with a real startup / active / recovery
read. Movement gets full cycles. Defence and reaction states stay 1-3.
"Pixely, non-super-smooth" is the target — punchy poses, not interpolation.

Files are split so three workers never touch the same file:

| module | export | owner |
|---|---|---|
| `art/body.states.ts` | `BODY_STATE_FRAMES` | worker A |
| `art/body.ground.ts` | `BODY_GROUND_FRAMES` | worker B |
| `art/body.air.ts`    | `BODY_AIR_FRAMES`   | worker C |
| `art/body.ts`        | `BODY_FRAMES` (merge of the three) | assembler |

## Worker A — `body.states.ts` (46 frames)

| anim | frames | names | reference cell | note |
|---|---|---|---|---|
| idle | 4 | idle0..3 | r0c1, r0c3 | breathing sway, 1px head bob, hair settle |
| walk | 4 | walk0..3 | r1c2..r1c5 | contact, pass, contact, pass; coat swings |
| run | 4 | run0..3 | r2c1..r2c4 | forward lean, bigger stride, coat streams back |
| turn | 2 | turn0..1 | r3c4, r3c5 | pivot through a back view |
| crouch | 2 | crouch0..1 | r3c3 | compressed, hair still overhangs |
| jumpsquat | 2 | jumpsquat0..1 | — | deep knee bend, coat compressed |
| jump | 2 | jump0..1 | r3c0 | arm up, rising |
| fall | 2 | fall0..1 | r3c1 | legs tucked, coat up |
| land | 2 | land0..1 | r3c2 | knee bend + small water splash at feet |
| helpless | 2 | helpless0..1 | r3c1 | limp, arms out, slow spin feel |
| shield | 2 | shield0..1 | r4c0 | crouched inside the bubble; bubble is FX, body only here |
| spotDodge | 2 | spotDodge0..1 | r4c2 | duck and compress |
| roll | 3 | roll0..2 | r4c4 | tuck, roll, rise |
| airDodge | 2 | airDodge0..1 | r4c1 | tucked spin |
| hitLight | 2 | hitLight0..1 | r5c6 | recoil back, eyes wide |
| hitStrong | 2 | hitStrong0..1 | r5c0, r3c6 | big knock back, head snapped |
| tumble | 4 | tumble0..3 | r4c4, r4c5 | loops; full rotation over 4 frames |
| ledgeHang | 2 | ledgeHang0..1 | r4c6 | hands on the lip, body dangling, slight sway |
| ledgeClimb | 3 | ledgeClimb0..2 | r4c7 | pull, knee up, stand |
| dead | 1 | dead0 | r3c7 | prone |
| taunt | 4 | taunt0..3 | r5c5, r5c7 | tiny orb floats up; arms raise |

## Worker B — `body.ground.ts` (41 frames)

Frame roles: `w` windup, `H` active hit, `r` recovery. Match the sim's frame data
in `src/characters/aeval/moves.ts` — the active frames listed there are when the
hitbox is live, so the `H` poses must be the extended ones.

| anim | frames | names | roles | reference | fantasy |
|---|---|---|---|---|---|
| jab | 4 | jab0..3 | w H H r | r6c1 | short water slap |
| ftilt | 5 | ftilt0..4 | w w H H r | r6c3 | horizontal splash, arm fully out |
| utilt | 5 | utilt0..4 | w w H H r | r6c7 | upward ripple over the head |
| dtilt | 4 | dtilt0..3 | w H H r | — | low crouched puddle poke, pops up |
| dashatk | 5 | dashatk0..4 | w H H H r | r4c3 | slide on a wave, low and committed |
| fsmash | 6 | fsmash0..5 | w w H H r r | r6c6, r6c7 | large crescent wave, biggest pose in the set |
| usmash | 6 | usmash0..5 | w w H H r r | r7c5 | geyser burst straight up |
| dsmash | 6 | dsmash0..5 | w w H H r r | — | ring wave covering BOTH sides, symmetric |

## Worker C — `body.air.ts` (42 frames)

All of these are airborne: legs tucked or trailing, coat lifted, nothing rests on
row 39. Body only — the projectile and water effects are drawn from `fx.ts` by
the renderer, so do not draw a full orb or crescent into a body frame; a small
water accent at the hand is fine.

| anim | frames | names | roles | reference | fantasy |
|---|---|---|---|---|---|
| nair | 4 | nair0..3 | w H H r | r5c4 | orbiting bubble, arms tucked in |
| fair | 5 | fair0..4 | w w H H r | r6c7 | forward wave slash, big arm arc |
| bair | 4 | bair0..3 | w H H r | r6c5 | back splash, body twists away |
| uair | 4 | uair0..3 | w H H r | — | upward flick, both arms up |
| dair | 5 | dair0..4 | w w H H r | — | downward drop, spike, legs point down |
| nspecial | 5 | nspecial0..4 | w w H H r | r6c0, r6c4 | Water Orb: gather, then push forward |
| sspecial | 5 | sspecial0..4 | w w H H r | r6c6 | Tidal Crescent: wind back, throw |
| uspecial | 5 | uspecial0..4 | w w H H r | r7c5 | Geyser: crouch, then launched upward |
| dspecial | 5 | dspecial0..4 | w H H H r | r4c5 | Whirlpool: spin, arms out, cloak spiral |

## Totals

46 + 41 + 42 = **129 body frames**, up from 67 (of which 3 were silently missing).
