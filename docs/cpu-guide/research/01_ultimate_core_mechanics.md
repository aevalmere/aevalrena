# Super Smash Bros. Ultimate core combat mechanics: formulas and frame rules

## Conventions

- Scope: Ultimate values unless a line says Smash 4. No official specification exists. The numbers below come from SSBWiki wikitext read through the MediaWiki raw endpoint, the SSBU-Calculator source code (https://github.com/rubendal/SSBU-Calculator), ultimateframedata.com, and KuroganeHammer's Smash 4 formula list. `unverified:` marks anything I did not read on a fetched page. When two sources disagree, both are named.
- Symbols: `p` victim percent after the hit, `d` move base damage, `s` stale multiplier, `w` victim weight, `bkb` base knockback, `kbg` knockback growth, `r` ratio product, `kb` knockback, `T` hitstun frames, `FAF` first actionable frame. Frames are 1-indexed: "intangible 3-17" means the third through seventeenth frame of the action.
- Aevalrena facts were read from the repository source (https://github.com/aevalmere/aevalrena, local copy, read-only): `src/core/constants.ts`, `src/sim/hits.ts`, `src/sim/physics.ts`, `src/sim/ledge.ts`, `src/sim/tech.ts`, `src/sim/calibrate.ts`, `src/stages/*/geometry.ts`. Lines starting with `Aevalrena:` map a finding onto the game.
- Distances in Smash are "units". Aevalrena uses pixels and its launch-speed constant is 0.06 where Smash uses 0.03. The px-per-unit ratio of the port is `unverified:`.

## Knockback

### Formula

```
kb = ( ( ( (p/10 + p*d'/20) * (200/(w+100)) * 1.4 ) + 18 ) * (kbg/100) + bkb ) * r * rage
p  = percent_before_hit + d*s          # percent after the hit, using stale-adjusted damage
d' = d * (1 - (1 - s) * 0.3)           # only 0.3 of the staling term reaches the damage factor
```

This is the Smash 4 and Ultimate form (https://www.ssbwiki.com/Knockback). The calculator's `VSKB` implements exactly this, with rage applied to the final value (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js). KuroganeHammer's Smash 4 "VS Mode" formula has the same shape (https://kuroganehammer.com/Smash4/Formulas).

Terms in `r` (Ultimate): crouch cancel 0.85 (https://www.ssbwiki.com/Crouch_cancel), and the match launch-rate setting (https://www.ssbwiki.com/Knockback). Smash 4 also had a 1.2 smash-charge interruption bonus, removed for Ultimate (https://www.ssbwiki.com/Knockback). KuroganeHammer lists a 0.8 grounded-meteor ratio for Smash 4 (https://kuroganehammer.com/Smash4/Formulas); `unverified:` whether Ultimate keeps the same 0.8. Short hop aerials carry a 0.85 damage multiplier, which lowers `d` and therefore knockback (https://www.ssbwiki.com/Short_hop).

The 1v1 multiplier (1.2x damage taken with two players and items off) does not change KO thresholds: a move that KOs at 120% does so with or without it, and it does not alter hitstun, hitlag or shieldstun (https://www.ssbwiki.com/1v1_multiplier). Treat `d` in the formula as the unmultiplied move damage.

Set knockback ignores victim percent and move damage but keeps weight: replace `(p/10 + p*d'/20)` with `(1 + wbkb/2)`, which is the same as `p=10, d=wbkb` (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js, function `WeightBasedKB`; https://www.ssbwiki.com/Knockback). In Ultimate rage and other knockback modifiers no longer touch set knockback (https://www.ssbwiki.com/Knockback). Weight-independent moves use `w = 100` (https://www.ssbwiki.com/Knockback).

Aevalrena: `knockback()` in `src/sim/hits.ts` is the same expression with `r = kbMul` (default 1), `s = 1`, no rage, no set knockback. `p` is percent after the hit and `d` is `rawDamage * damageMul`.

### Launch angle (Sakurai angle)

Angle 361 resolves at hit time. Ultimate: a grounded victim gets 0 degrees below kb 60 and 38 degrees at kb 88 or more, linear between; an airborne victim always gets 38 (https://www.ssbwiki.com/Sakurai_angle). The calculator's ramp is `min((kb-60)/28*38 + 1, 38)` (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js). Moves with angle 0 turn into 32 degrees at kb 120 or more (https://www.ssbwiki.com/Sakurai_angle).

Aevalrena: `launchAngle()` is a step, 0 below `sakuraiThreshold = 60` and 40 at or above it; there is no ramp and no 32-degree rule. Use the sim's own function when predicting launches, never the Ultimate ramp.

### Launch speed, decay, gravity

- Initial launch speed is `kb * 0.03` units per frame, and it drops by 0.051 every frame until it reaches zero. Air friction is disabled during launch, while fall speed still applies (https://www.ssbwiki.com/Knockback).
- The calculator splits the decay per axis (`0.051*cos(angle)`, `0.051*sin(angle)`), clamps each axis at zero, and keeps gravity in a separate vertical term that grows by the character's gravity each tick and is capped at fall speed (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/knockback.js).
- Smash 4 and Brawl added extra vertical launch speed from a gravity-based formula. Ultimate removed that. For launch angles 70 to 110 degrees, fall speed is fixed to 1.8 during hitstun instead (https://www.ssbwiki.com/Knockback). The calculator implements this as a per-character "damage fly top" gravity for angles between 1.22173 and 1.91986 radians (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/knockback.js). `unverified:` the per-character gravity values.
- Bouncing off a surface costs 5% knockback in Ultimate (https://www.ssbwiki.com/Knockback).

### Balloon knockback (hitstun speed-up)

Ultimate maps hitstun above 32 frames through a speed-up that makes the launch run faster and end sooner (https://www.ssbwiki.com/Hitstun). SSBWiki's description: take the first actionable frame `faf = hitstun + 1`, get a frame speed multiplier from 1x to 6x according to where `faf` sits between 30 and 80, apply it on the first frame, and shrink it every following frame; above 200 knockback the scaling stops and hitstun grows by `(kb - 200) * 0.25` (https://www.ssbwiki.com/Hitstun). The calculator's code gives the exact algorithm (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js):

```
hitstunRaw(kb): h = 0.4*kb; if h < 5 then h = 5; return floor(h) - 1
speedUpFrames(faf):                      # real frames until actionable, faf = hitstunRaw + 1
  maxMag = 1 + 5*clamp((faf - 30) / 50, 0, 1)      # 1x at faf <= 30, 6x at faf >= 80
  frame = faf; mag = maxMag; i = 0
  while mag > 1:
     ratio = clamp((faf*0.3 - frame) / (faf*0.3 - faf), 0, 1)
     mag   = ratio * maxMag
     frame = frame - (mag < 1 ? 1 : mag)
     i = i + 1
  return i + ceil(frame)                 # the angle term is a no-op (its rate constant is 100)
```

Outputs of my reproduction of that code, as `kb: sped-up hitstun` (hitstun = result - 1): 80: 31, 85: 32, 90: 33, 100: 35, 110: 36, 120: 38, 130: 39, 145: 41, 160: 43, 180: 46, 200: 49, 250: 61, 300: 74. SSBWiki states 90 gives 33 and 145 gives 41 in Ultimate, against 36 and 58 in Smash 4 (https://www.ssbwiki.com/Hitstun), which matches the reproduction; the other rows are calculator-derived only. Set-knockback hits skip the effect (https://www.ssbwiki.com/Hitstun).

In the calculator's trajectory loop, physics advances one tick per raw hitstun frame and positions are recorded only on frames that the speed-up list keeps (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/knockback.js). My reading, `unverified:` against the game, is that total displacement equals the un-sped-up flight of `hitstunRaw` ticks, reached in fewer real frames.

Aevalrena: there is no speed-up. Hitstun is `floor(kb * 0.4)` (no minus 1), so at kb 145 the sim gives 58 frames where Ultimate gives 41. Do not import Ultimate combo timings.

## Hitstun, tumble and hitlag

### Hitstun and tumble

- `T = floor(0.4 * kb) - 1` in Ultimate, always, including tumble and electric hits (Smash 4 did not subtract 1 in those cases per SSBWiki). Hits that flinch have at least 4 frames of hitstun. Individual moves can carry hitstun modifiers that add or subtract frames without changing knockback or tumble thresholds (https://www.ssbwiki.com/Hitstun). KuroganeHammer lists the Smash 4 formula as `floor(kb*0.4) - 1` (https://kuroganehammer.com/Smash4/Formulas), which disagrees with SSBWiki's statement that Smash 4 skipped the subtraction on tumble hits; `unverified:` which is right for Smash 4. It does not affect Ultimate.
- Tumble starts when the hit causes 32 frames of hitstun before modifiers (https://www.ssbwiki.com/Tumble), i.e. `floor(0.4*kb) >= 32`, kb 80 or more. The calculator tests `hitstun + 1 >= 32` (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/knockback.js).
- Reeling is a cosmetic variant with a 30% chance when the victim is at 100% or more (https://www.ssbwiki.com/Tumble).
- Frame advantage on hit: `advantage = T - (FAF - (hitFrame + 1)) + paralysis` (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js, `HitAdvantage`). Hitlag applies to both fighters and cancels.

Aevalrena: `hitstun = floor(kb*0.4)`, tumble at `kb >= 80` (`TUNING.knockback`, `src/sim/hits.ts`). The 80 threshold equals Ultimate's. A fighter in hitstun cannot act at all; only the tech press is recorded.

### Hitlag

```
hitlag = floor( floor( floor( (d*0.65 + 6) * h * e * s ) * pc ) * c )       cap 30 before pc
h  = move hitlag multiplier (default 1)     e = 1.5 if electric, else 1
s  = 0.67 when the hit lands on a shield    pc = player-count factor, 1.0 with two players
c  = 0.67 for a crouch-cancelling victim, applied to victim and attacker in Ultimate
```

(https://www.ssbwiki.com/Hitlag; crouch cancel https://www.ssbwiki.com/Crouch_cancel). Examples: `d = 12` gives 13 frames, `d = 12` electric gives 20, `d = 12` on a shield gives 9, `d = 30` gives 25 (my arithmetic on the formula). A hitlag multiplier of 0 gives no hitlag at all in Ultimate and enables ASDI on most projectiles; multipliers below 1 are ignored when the hit lands on a shield, except the electric factor (https://www.ssbwiki.com/Hitlag). The calculator floors once at the end instead of three times (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js); `unverified:` whether the difference ever changes a result. Smash 4 used `INT(((d/2.6 + 5) * e) * h) * c) - 1` (https://kuroganehammer.com/Smash4/Formulas).

Aevalrena: `hitlagFrames(d) = min(20, floor(0.5*d) + 4)`, then `round(... * hitlagMul)` with a floor of 1, applied to both fighters; shielded hits use the same value with no 0.67 factor. For `d = 12` that is 10 frames against Ultimate's 13. No electric or crouch-cancel factor exists.

## Hitstun canceling

- Brawl: an air dodge after 13 frames of hitstun or an aerial after 26, whatever the knockback (https://www.ssbwiki.com/Hitstun_canceling).
- Smash 4: air dodge only at frame 40 or later and only if the current launch speed is below 2.5; aerial at frame 45 or later and only if launch speed is below 2 (https://www.ssbwiki.com/Hitstun_canceling). The calculator carries the same four numbers for Ultimate (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js).
- Ultimate: parameters unchanged from Smash 4, but balloon knockback ends most hitstun before frame 40, so cancelling with an aerial is close to impossible; it keeps some use against set-knockback moves and grounded meteor smashes (https://www.ssbwiki.com/Hitstun_canceling).

Aevalrena: not implemented. The victim is locked until `T` frames elapse, then may act (air dodge or any action ends tumble, `stepHitstun` in `src/sim/actions.ts`). Combo timing is therefore exact and the same `T` formula holds at every knockback.

## Rage

`rage = 1 + (p_attacker - 35) / 115 * 0.1`, with `p_attacker` clamped to 35..150, so the multiplier runs from 1.0 to 1.1 (https://www.ssbwiki.com/Rage). Smash 4 used 0.15 as the top (https://www.ssbwiki.com/Rage, https://kuroganehammer.com/Smash4/Formulas). It multiplies the finished knockback and does not apply to set knockback in Ultimate (https://www.ssbwiki.com/Rage). Values: 35%: 1.0000, 60%: 1.0217, 100%: 1.0565, 150%: 1.1000 (my arithmetic).

Aevalrena: absent.

## Stale-move negation

- Queue: the last nine moves that connected, one entry per attack (all hitboxes and variants of a move count as the same move). Being KO'd clears the queue (https://www.ssbwiki.com/Stale-move_negation).
- Ultimate reductors by queue position, position 1 being the most recent: 0.09, 0.08545, 0.07635, 0.0679, 0.05945, 0.05035, 0.04255, 0.03345, 0.025 (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js; SSBWiki's worked example uses 0.09, 0.08545 and 0.05035 for queue positions 1, 2 and 6, https://www.ssbwiki.com/Stale-move_negation). Smash 4 reductors: 0.08, 0.07594, 0.06782, 0.06028, 0.05274, 0.04462, 0.03766, 0.02954, 0.022 (https://kuroganehammer.com/Smash4/Formulas).
- Multiplier: `s = 1 - sum(reductor[i] for each queue position i that holds this move)`. If the move is absent from the queue, `s = 1.05` (freshness bonus) (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js). A move in positions 1, 2 and 6 gets `1 - 0.2258 = 0.7742` (https://www.ssbwiki.com/Stale-move_negation). Fully stale (nine entries) gives `1 - 0.5305 = 0.4695` (my sum of the nine reductors).
- Ultimate stales moves that hit a shield too, with the reductor scaled by 0.85 (https://www.ssbwiki.com/Stale-move_negation; calculator `StaleNegation`).
- `s` scales damage, and enters knockback through `p` (full) and `d'` (0.3 of it). Example, weight 100, victim at 88% before the hit, `d = 12, bkb = 30, kbg = 100`: fresh 147.9, neutral 146.0 (s = 1), one recent use 142.7, fully stale 127.2 (my arithmetic on the formula).

Aevalrena: absent. `damage` is `rawDamage * damageMul` with no queue.

## DI, LSI, SDI and ASDI

### Trajectory DI and launch speed influence

- DI rotates the launch vector by at most 0.17 radians (9.74 degrees) in Smash 4 and Ultimate. The stick is read on the last frame of hitlag, and only tumbling knockback is affected (the calculator's comment says DI requires tumble, https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js). The rotation scales with the stick component perpendicular to the launch direction, so parallel input does nothing (https://www.ssbwiki.com/Directional_influence). Calculator form (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js):

```
perp = |X*Vy - Y*Vx| / |V|          # (X,Y) stick after deadzone mapping, V launch vector
angle' = angle +/- 0.17 * perp       # toward the side the stick points
```

- The calculator returns the input angle unchanged when `|atan2(Vy, Vx)| < 0.17`, which reads as "no DI for launches within 0.17 rad of the +x axis"; `unverified:` against the game.
- LSI multiplies launch speed by 1.095 (stick fully up) or 0.92 (fully down), scaling linearly with vertical stick, and is off for launch angles 65 to 115 and 245 to 295 degrees (https://www.ssbwiki.com/Directional_influence).
- During a Special Zoom or Finish Zoom the DI window ignores the slowdown (https://www.ssbwiki.com/Directional_influence).

### SDI and ASDI

- SDI: 2 units per pulse (6 in Melee and earlier). In Ultimate the next SDI input is ignored for 4 frames after one registers (latest input buffered), and SDI distance is multiplied by 1.15 for each block of five consecutive hits. Grounded victims cannot SDI upward except on hitlag frame 2 as the first input (https://www.ssbwiki.com/Smash_directional_influence).
- Shield SDI: horizontal only, 2/3 of a normal pulse, not subject to the 4-frame limit (https://www.ssbwiki.com/Smash_directional_influence).
- ASDI: 1.33 units in Smash 4. In Ultimate it exists only for electric, paralyze, crumple or autoshift moves and 0x-hitlag projectiles, is not available for launch angles 70 to 110, and applies twice (https://www.ssbwiki.com/Automatic_smash_directional_influence).

Aevalrena: none of this exists. During hitstun `knockbackDecay` in `src/sim/physics.ts` overwrites `vx, vy` from the stored launch direction every frame, so the victim's stick has no effect until hitstun ends.

## Shield

### HP, decay, regeneration

| Quantity | Ultimate |
|---|---|
| Max HP | 50 |
| Damage multiplier on shield hits | 1.19 (effective HP 42.02) |
| Depletion while held | 0.15 per frame (9 per second) |
| Regeneration | 0.08 per frame |
| HP after shield break stun ends | 37.5 (75% of max) |
| Minimum shield time before it can drop | 3 frames |
| Shield drop lag | 11 frames |
| Size multiplier | `(HP/50)*0.85 + 0.15` |

(https://www.ssbwiki.com/Shield). A full shield lasts 5.56 seconds held; an empty one takes 10.39 seconds to refill (https://www.ssbwiki.com/Shield). Shield damage per hit is `(d + bonusShieldDamage) * 1.19`, where the bonus is fixed and independent of staling and charge (https://www.ssbwiki.com/Shield_damage). Since 3.0.0 many projectiles have negative shield damage (https://www.ssbwiki.com/Shield_damage).

Aevalrena: HP 60, decay 0.12, regen 0.07, no 1.19 factor, and the shield resets to 30 HP (50% of max, `SHIELD_BREAK_RECOVERY` in `src/sim/actions.ts`) after a break instead of 75% (`src/core/constants.ts`, `applyHit`). Hold time from full is 500 frames against Ultimate's 333.

### Shieldstun and pushback

```
shieldstun = floor(0.8 * d * t * m * p + 2)               cap 60
t = 0.725 smash attack, 0.33 aerial (not grab aerial or landing hitbox), 1 otherwise
m = per-hitbox shieldstun multiplier (1 unless the move sets one)
p = 0.29 for projectiles, applied only when t = 1 and m = 1
```

(https://www.ssbwiki.com/Shieldstun; `d` is the damage the hit would deal unshielded, shield damage is not included.) A grounded smash therefore has a net factor of 0.58 and an aerial 0.264 (https://www.ssbwiki.com/Shieldstun). Example: `d = 12` gives 8 frames for a smash, 11 for a tilt, 5 for an aerial (my arithmetic).

```
defenderPushback = min(1.3, (shieldstunUnrounded + 1) * 0.09 * shieldFactor)   # units per frame, decays by traction
attackerPushback = d*0.04 + 0.025                                              # none for projectiles
shieldstunUnrounded = 0.8*d*t*m*p + 2 ; shieldFactor = 1 (0.15 when parried)
```

(https://www.ssbwiki.com/Shield, table row for Ultimate, which notes the shieldstun used is not rounded; the calculator matches with `(0.8*d*t*m*p + 3) * 0.09` at https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js.) Attacker traction is multiplied by 1.1 while it slides (https://www.ssbwiki.com/Shield).

Advantage on shield in the calculator: `hitFrame - (FAF - 1) + shieldstun + shieldHitlag - attackerHitlag`, and for non-attached projectiles the attacker term is replaced by 1 (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js). KuroganeHammer's Smash 4 version has the same skeleton (https://kuroganehammer.com/Smash4/Formulas).

Aevalrena: `shieldstun = floor(0.6*d) + 2` for every hit type, defender gets a flat `vx += 2` push and the attacker gets none, hitlag is the same as on a normal hit. A CPU that wants exact on-shield advantage must measure it in the forward model, not from the Ultimate formula.

### Shield drop, out of shield, shield grab

- Shield drop is 11 frames in Ultimate (7 in Smash 4) (https://www.ssbwiki.com/Shield_drop, https://www.ssbwiki.com/Out_of_shield).
- Out of shield: jump takes the 3-frame jumpsquat then any aerial (so an OoS aerial is `3 + startup`), and up smash and up special can be used directly without jumping. All jumpsquats are 3 frames except Kazuya (7) (https://www.ssbwiki.com/Out_of_shield). Mario's example: up special 3 frames, neutral air 6, up air 7 (https://ultimateframedata.com/mario).
- Shield grab after shieldstun needs 4 extra frames of shield first, so Mario's post-shieldstun grab comes out at 10 frames (https://www.ssbwiki.com/Shield_grab, https://ultimateframedata.com/mario).
- Shielding cannot drop through platforms in Ultimate, and holding special, two shield buttons or a side taunt suppresses roll, spot dodge and jump out of shield (https://www.ssbwiki.com/Shield).

Aevalrena: out-of-shield options are jump, grab, up smash, up special, roll and spot dodge (brief). I found no shield-drop lag constant in `src/core/constants.ts` or `src/sim/actions.ts`, so a released shield probably returns to idle at once (`unverified:`), which makes shield pressure less punishable than the 11-frame Ultimate drop.

### Perfect shield (parry)

- Input: release the shield during the first 5 frames of the 11-frame drop. The shield must have been up at least 3 frames, so the earliest parry is at frame 4 of shielding. The parry bubble is always full shield size (https://www.ssbwiki.com/Perfect_shield).
- Grants: no shield damage, defender pushback multiplied by 0.15, and any action out of the drop lag (https://www.ssbwiki.com/Perfect_shield, https://www.ssbwiki.com/Shield).
- Extra hitlag: direct melee, attacker +14 and defender +11 (defender acts 3 frames sooner than on a normal block); indirect melee, attacker +14 and defender +2 (12 frames sooner); direct projectile, defender +8 (acts 8 frames later, worse than blocking); indirect projectile, defender 1 less (https://www.ssbwiki.com/Perfect_shield). Patch 9.0.0 raised the projectile numbers by 3 for all modes (https://www.ssbwiki.com/Perfect_shield).
- Limits: after a normal block the next drop cannot parry until 3 frames after shieldstun ends; multiple parries in the same drop are not allowed (https://www.ssbwiki.com/Perfect_shield).

Aevalrena: absent.

### Shield break

Stun is `400 - p_victim` frames at the moment of the break (minimum none: at 400% or more the fighter recovers at once), followed by a 33-frame recovery animation. Stick inputs shave 3 frames each and button presses 5.4 each (https://www.ssbwiki.com/Stun). After the stun the shield resets to 37.5 HP (https://www.ssbwiki.com/Shield).

Aevalrena: `SHIELD_BREAK_STUN = 180`, fixed; the `shieldBreak` case in `src/sim/actions.ts` only counts `stateTimer` down, so there is no percent scaling, no mash-out and no separate recovery animation.

## Jumps, falling and landing

- Jumpsquat is 3 frames for every character except Kazuya (7) and Giga Bowser (15) (https://www.ssbwiki.com/Jump). Releasing jump inside the squat gives a short hop. Jump plus attack pressed together gives a short hop aerial, and since 2.0.0 two jump buttons give a plain short hop (https://www.ssbwiki.com/Short_hop).
- Ultimate full hops have an "initial height" phase: the first 4 frames are sped up (most characters: 0.55 times the full-hop height); air jumps and short hops do not use it, and a soft hop (jump within 4 frames of leaving a ledge) disables it (https://www.ssbwiki.com/Jump).
- Mario example: full hop 36.33 units, short hop 17.54, air jump 36.33 (https://www.ssbwiki.com/Jump); airtime SH 40 frames, FH 56, SH fast fall 28, FH fast fall 39, fall speed 1.5, fast fall 2.4, gravity 0.087 (https://ultimateframedata.com/mario).
- Fast fall is usually 1.6x the fall speed (60% faster): 44 of the roughly 50 characters in SSBWiki's Ultimate table, with exceptions at 90%, 40%, 33%, 31.6% and 52.8% (https://www.ssbwiki.com/Fast_fall). An aerial attack cancels fast fall (https://www.ssbwiki.com/Fast_fall).
- Landing lag: aerial landing lag is per move; landing while the aerial's auto-cancel window is active gives a normal landing. Mario's normal landing is 4 frames (hard) or 2 (soft), 5 for Donkey Kong and Link (https://ultimateframedata.com/stats).
- Air dodge landing lag is 10 frames after a neutral air dodge and up to 19 after a directional one (https://www.ssbwiki.com/Lag), listed as 11-19 by direction for Mario (https://ultimateframedata.com/mario).

Aevalrena: Aeval gravity 0.15, max fall 3.2, fast fall 5.0 (ratio 1.5625), air speed 2.0, air accel 0.14, air friction 0.03 (`src/characters/aeval/moves.ts`). Read these from the character definition; do not assume 1.6.

## Dodges

### Frame data

| Action (Mario, Ultimate) | Total | Intangible | Notes |
|---|---|---|---|
| Spot dodge | 25 (20 if cancelled into a ground attack) | 3-17 | (https://ultimateframedata.com/mario, https://www.ssbwiki.com/Spot_dodge) |
| Forward roll | 29 | 4-15 | (https://ultimateframedata.com/mario) |
| Back roll | 34 | 5-16 | (https://ultimateframedata.com/mario) |
| Neutral air dodge | 52 | 3-29 | landing lag 10 (https://ultimateframedata.com/mario) |
| Directional air dodge | 71 to 116 by direction | 3-21 | landing lag 11-19 (https://ultimateframedata.com/mario) |

Every character's spot dodge becomes intangible on frame 3 (https://www.ssbwiki.com/Spot_dodge). Air dodge duration is tuned so all characters fall about the same distance, so it is shorter for fast fallers (https://www.ssbwiki.com/Air_dodge). Neutral air dodges average 49-50 frames in Ultimate against 32-33 in Smash 4, with landing lag halved to 10 (https://www.ssbwiki.com/Air_dodge).

Air dodge rules: one per airborne period (reset on landing, being hit or grabbing a ledge), neutral and directional share the one use; directional dodges first slingshot backward, then travel, and can grab a ledge after their first 24 frames (https://www.ssbwiki.com/Air_dodge). Most characters are vulnerable for only 3 frames if a directional dodge catches a ledge as early as possible, not counting the 2-frame ledge vulnerability (https://www.ssbwiki.com/Air_dodge).

### Dodge staling

```
duration = D * (1 + P)                    # D = fresh duration; spot dodge adds 1 frame if stale
P += 0.06 per spot dodge or forward roll  (cap 0.3)
P += 0.10 per back roll                   (cap 0.5)
P resets after about one second without any dodge
fully stale: intangibility starts 3 frames later (spot dodge, air dodge) or 4 later (rolls)
```

(https://www.ssbwiki.com/Roll, https://www.ssbwiki.com/Spot_dodge, https://www.ssbwiki.com/Air_dodge). Roll and spot dodge staling is shared across the three dodge types. Air dodge staling shortens intangibility and cuts directional distance by about one third when fully stale, but does not lengthen ending lag (https://www.ssbwiki.com/Air_dodge). Mario fully stale: spot dodge intangible 6-17 and 33 frames, forward roll 8-14 and 38, back roll 9-14 and 51, neutral air dodge 6-27, directional 6-20 (https://www.ssbwiki.com/Spot_dodge, https://www.ssbwiki.com/Roll, https://www.ssbwiki.com/Air_dodge).

Aevalrena: spot dodge 22 frames intangible 3-17 (the intangible window equals Ultimate's fresh value); roll 24 frames intangible 3-16, faster and shorter than Ultimate's 29 and 4-15; air dodge 34 frames intangible 2-31, close to Smash 4's shape rather than Ultimate's 52; no staling, no air dodge landing lag known (`src/core/constants.ts`). `ROLL.distance` in the file is 80 while the brief says 60 px; read the constant.

## Ledge

### Grab rules

- A ledge behind the character can be grabbed with 40% less range than one in front; grabs are automatic unless down is held (https://www.ssbwiki.com/Edge).
- Ledge trump: grabbing an occupied ledge makes the holder let go and unable to act for a moment, so edge-hogging does not work in Smash 4 and Ultimate (https://www.ssbwiki.com/Edgeguarding). A held character avoids it by buffering attack, jump or roll on the grab frame; regular getup and drop cannot be buffered (https://www.ssbwiki.com/Edgeguarding).
- 2-frame punish: there are two frames between grabbing and the intangibility starting, and it does not apply when the grab comes from beyond the ledge (https://www.ssbwiki.com/Edge).
- Smash 4: 55 frames without ledge grabs after being hit (https://www.ssbwiki.com/Edge). The Lucario page notes a 45-frame regrab restriction after falling off from hang time (https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups); `unverified:` exact scope.
- Hang time: 6.5 seconds in Smash 4 and Ultimate at any percent (https://www.ssbwiki.com/Edge); the Lucario page counts 380 frames including the 19-frame grab animation (https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups). Sources differ by about 10 frames.

### Grab intangibility

```
ledgeIntangibility = 60*(a/300) + (44 - p/120*44) frames, plus the 19-frame grab animation   (SSBWiki)
                     a = airborne frames capped at 300, p = percent capped at 120; min 23, max 123
ledgeIntangibility = floor(0.2*a + 64 - p*44/120)   min 24, max 124                            (KuroganeHammer, Smash 4)
```

(https://www.ssbwiki.com/Edge, https://kuroganehammer.com/Smash4/Formulas). The two agree apart from a 1-frame offset in the constant (63 against 64 at a = 0, p = 0); which counting convention matches game frame numbering is `unverified:`. SSBWiki's stated extremes: 63 frames with low damage and low airtime, up to 79 with high damage and airtime, 23 with high damage and low airtime, 123 with low damage and 5 seconds of airtime (https://www.ssbwiki.com/Edge).

### Regrabs

- Regrabbing without landing or taking hitstun gives no hang intangibility (tether recoveries excepted), and a fighter can grab at most 6 times before landing or being hit (https://www.ssbwiki.com/Edge).
- Getup option intangibility (climb, jump, attack, roll) is multiplied by 0.8 after the first regrab, 0.5 after the second and removed from the third regrab on (https://www.ssbwiki.com/Edge).
- The grab animation of 19 frames stretches on later grabs: speed 1, 1, 0.9375, 0.875, 0.8125, 0.75 for grabs 1 to 6 (https://www.ssbwiki.com/Edge).

### Ledge options (Lucario, fresh first grab)

Neutral getup intangible 1-33, interruptible at 35 of 40; ledge jump intangible 1-12, interruptible at 15; ledge roll intangible 1-26 of 45 frames; second-grab values 27, 10 and 21, third-grab 16, 6 and 13; option priority is jump above attack above roll above climb above drop (https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups). Ledge attack timings were not recorded, `unverified:`.

Aevalrena: hang invulnerability 40 frames flat, granted on the first three grabs since landing and denied from the fourth (`src/sim/ledge.ts`: `LEDGE_HANG_INVULN`, `LEDGE_MAX_REGRABS = 3`), no airtime or percent scaling, 12-frame drop cooldown, unlimited hang time. An occupied ledge cannot be grabbed (`ledgeTaken`), so there is no trump and edge-hogging works. Ultimate gives no hang intangibility from the second grab; the sim's rule is more generous.

## Tech and missed tech

- Tech window: 11 frames in Ultimate (8 in Smash 4, 20 in the other games), then a 40-frame lockout (30 in Smash 4); techs can be buffered in hitlag, and a shield held down on ground contact still counts (https://www.ssbwiki.com/Tech). The Lucario techs page says the window "is slightly increased to 12" (https://www.ssbwiki.com/Lucario_(SSBU)/Techs). The two sources disagree; 11 is from the general page.
- Surfaces: floors, walls and ceilings can all be teched; grounded meteor smashes cannot; footstools and reeling can be teched (https://www.ssbwiki.com/Tech). Impact launch speed of 6 or more removes the tech (Lucario techs page); the calculator uses 6 for walls and ceilings and 3 for floors (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/knockback.js).
- Timings (Lucario): neutral tech intangible 1-20, actionable at 27 of a 36-frame animation; forward and back tech rolls 40 frames, intangible 1-20; wall tech intangible 1-20 with a 1-5 wall-jump window that carries no intangibility (https://www.ssbwiki.com/Lucario_(SSBU)/Techs).
- Missed tech: floor options become available after 25 frames; without input the fighter gets up by itself after 245 frames including the fall. Neutral getup 29 frames, getup rolls 35 frames, all intangible 1-22 (https://www.ssbwiki.com/Lucario_(SSBU)/Floor_getups_(front), https://www.ssbwiki.com/Lucario_(SSBU)/Floor_getups_(back)). Character-specific values may differ; `unverified:` beyond Lucario.

Aevalrena: press window 20, lockout 40, in place 26 frames (intangible to 20), roll 40 frames (intangible to 20, 40 px), floor only, no wall or ceiling tech, no impact-speed threshold (`src/core/constants.ts`, `src/sim/tech.ts`). Knockdown at most 120 frames; getup 30 (intangible to 22), getup roll 35 (to 25). A CPU that tech-chases can rely on these exact values.

## Grabs

- Hold time `floor(90 + 1.7*p_victim) - mashing`, minimum 19 frames. Mashing removes 8 frames per stick input and about 14.3 to 14.4 per button (https://www.ssbwiki.com/Grab reports 14.4 and https://kuroganehammer.com/Smash4/Formulas reports 14.3; sources differ). Victims flash when 180 frames remain (https://www.ssbwiki.com/Grab). Ultimate button mashing rules: same-action buttons register every 2 frames, mixed inputs every 3 (https://www.ssbwiki.com/Button_mashing).
- Grab immunity after a release: 60 frames in Ultimate (70 in Smash 4) (https://www.ssbwiki.com/Grab). Release lag is 29 frames for both fighters on a ground or air release, giving no advantage (https://www.ssbwiki.com/Grab_release).
- Throw invincibility: the thrower is invincible until the opponent has been thrown in Ultimate (https://www.ssbwiki.com/Throw).
- Pummel: 1% to 1.6% before the 1v1 multiplier, most at 1.3% (https://www.ssbwiki.com/Pummel).
- Priority: a hitbox beats a grab in Smash 4 and Ultimate; the grabber is released and takes 3%. Simultaneous grabs cancel and each fighter takes 1% (https://www.ssbwiki.com/Grab), listed as 1.2% on the grab release page (https://www.ssbwiki.com/Grab_release); the two match if the second includes the 1.2x 1v1 multiplier, `unverified:`.
- Mario timings: grab active 6-7, 34 frames total; dash grab active 9-10, 42 total; pivot grab startup 10 (https://ultimateframedata.com/mario).

Aevalrena: grab 30 frames active 7-8, dash grab 38 active 9-10, pummel, four throws and mash-out exist. A release leaves the holder 10 frames of lag and the victim 12 frames of hitstun with a 2.5 push (`src/sim/grab.ts`); I found no post-release grab immunity in that file, so a chain grab is possible unless mash-out timing or throw knockback prevents it.

## Kill percent and KO math

### Inverting the formula

Required knockback to percent, given `R = r * rage`:

```
X   = (kbReq / R - bkb) * 100 / kbg - 18
p*  = X * (w + 100) / (280 * (0.1 + d'/20))      # percent after the hit
percentBefore = p* - d*s
```

Check: `w = 100, d = 12, bkb = 30, kbg = 100, R = 1`: `kbReq = 146` gives `p* = 100`, launch speed 4.38 units per frame, `hitstunRaw = 57`, sped-up hitstun 41 (my arithmetic on the formulas above). With rage from a 100% attacker (R = 1.0565), the same `kbReq` is reached at `p* = 92.0`, about 8 percent earlier. The kill percent for a move is `p*` at the smallest `kbReq` that removes the victim; finding `kbReq` needs the trajectory.

### Ultimate procedure (calculator method)

1. Compute `kb`, launch angle (Sakurai rules), apply DI and LSI to angle and speed if modelling the victim's stick.
2. Run the launch tick loop (decay 0.051 per tick along the vector, gravity term capped at fall speed, fall speed 1.8 for angles 70 to 110) for `hitstunRaw` ticks, checking each position against the blast zones.
3. The calculator checks the top and bottom lines with a 30-unit camera margin and the side lines directly (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/knockback.js). Stage blast coordinates are not recorded here; SSBWiki stage pages list them and were not read for numbers.
4. Ultimate also has a lower meteor blast line that applies to fighters moving faster than 3 (https://www.ssbwiki.com/Blast_line).

### Aevalrena exact model

Verified by driving `applyHit` and `stepGame` on the real sim against a closed-form model: positions matched to four decimals at frames 9 and 57 (victim weight 88, gravity 0.15, max fall 3.2, air friction 0.03; the victim was at 100% before a `d = 10, bkb = 30, kbg = 100` hit at angle 0, so `p = 110`, `kb = 146.3`, launch speed 8.778, hitlag 9, hitstun 58).

```
kb = knockback(p_after, w, d, bkb, kbg) * kbMul
v0 = kb * 0.06 ; T = floor(kb * 0.4) ; (dirX, dirY) = (cos a, -sin a) with a = 180 - a when facing left   # y grows downward
launch starts after `hitlag` frozen frames
for t = 1..T:
   ks = max(0, ks - 0.051) ; kf = min(maxFall, kf + gravity)
   vx = dirX*ks ; vy = dirY*ks + kf ; x += vx ; y += vy
for t > T (stick neutral):
   vx moves toward 0 by airFriction ; vy = min(vy + gravity, max(maxFall, vy)) ; x += vx ; y += vy
KO the first frame (x,y) is outside stage.blast = {x, y, w, h}   # y up is negative
```

Closed forms at the end of hitstun (the launch speed never reaches zero inside hitstun because `0.06*kb > 0.051 * 0.4*kb`):

```
L(T) = T*v0 - 0.051*T*(T+1)/2                       # distance travelled along the launch vector
n    = floor(maxFall / gravity)                     # 21 for Aeval
G(T) = gravity*T*(T+1)/2                 if T <= n
     = gravity*n*(n+1)/2 + maxFall*(T-n) otherwise # extra downward drop from the gravity term
x(T) = x0 + dirX*L(T) ; y(T) = y0 + dirY*L(T) + G(T)
```

Check: for the probe hit, `L(57) = 416.04` and `G(57) = 149.85`, matching the sim at frame 57; `L(58) = 421.9` is the position at the end of hitstun. Horizontal distance grows with kb squared (`L ~ 0.0199*kb^2`), so KO percentages fall quickly once the victim is near a blast line.

`stage.blast` is a rect; the sim tests `x < b.x`, `x > b.x + b.w`, `y < b.y`, `y > b.y + b.h` on the fighter anchor (`checkBlast`, `src/sim/physics.ts`). Tidegate in code: main platform x -248..248 at y 0, blast `{x: -598, y: -447, w: 1176, h: 752}`, so the lines are left -598, right 578, top -447, bottom 305; Hearthmoor: main x -298..298, blast `{x: -578, y: -394, w: 1176, h: 752}` (`src/stages/*/geometry.ts`). The brief's Tidegate numbers (blast -420..420 by -300..240, main -180..180) match `docs/SPEC.md` section 6 and not the code. The CPU must read `stage.blast` and platform data from the stage definition at run time.

Guaranteed KO test, victim locked in hitstun (no input can stop it), from position (x0, y0), launch angle `a`:

```
guaranteedKO(kb):  (x(T), y(T)) outside blast   or   any t <= T with (x(t), y(t)) outside blast
kbMin = bisection over kb in [0, 600] on guaranteedKO      # monotone in kb for a fixed angle and start
percentAfter = invert(kbMin) ; percentBefore = percentAfter - d
```

Computed for Aeval as victim (weight 88, `d = 12, bkb = 30, kbg = 100`, `p` is percent after the hit), Tidegate: from the right edge (248, 0) at angle 0, kbMin 129.9 and `p` 78.6; at angle 40, kbMin 147.5 and `p` 95.4; from centre stage (0, 0) straight up, kbMin 180.3 and `p` 126.9; at angle 70, kbMin 187.5 and `p` 133.8 (my calculation with the model above). These are guaranteed-KO floors. Free flight with no inputs after hitstun kills earlier (kb 84.7 from the same edge at angle 0, dying at frame 144) but a victim with a double jump and an up special usually survives that, so the practical KO line needs a recovery-reach check: after `T`, compare `(x(T), y(T), vx, vy)` against the victim's remaining jumps, jump height, up-special reach and air speed.

`calibrate.ts` binary-searches, for each Aeval move against a passive weight-88 victim at centre stage on Tidegate, the lowest victim percent that kills within 240 frames. Its printed values: forward smash 121 (79 fully charged), up smash 134 (90), down smash 134 (92), up special 127, back air 141, forward air 155, up air 181, up tilt 193, down special 194, side special 197, forward tilt 198, down tilt 213; jab, dash attack, neutral air and down air never kill; neutral special kills at 108 only when charged. Knockback at 100% for reference: up smash 143.8, up special 156.6, down air 144.6, jab 24.6 (`src/sim/calibrate.ts`, run read-only).

## Mapping to Aevalrena

### Present, with differences from Ultimate

| Mechanic | Aevalrena | Ultimate | CPU consequence |
|---|---|---|---|
| Knockback formula | same expression, `kbMul` 1 | same, plus rage, staling, rage-in-`r` | kill tables depend on victim percent and weight only |
| Launch speed | `kb*0.06`, decay 0.051 | `kb*0.03`, decay 0.051 | speed doubled with the same decay, so distance per kb squared is about 2.5 times Ultimate's before any px-per-unit scaling; use the sim |
| Hitstun | `floor(0.4*kb)` | `floor(0.4*kb) - 1`, then speed-up above 32 | combos work at higher kb than in Ultimate |
| Tumble | kb 80 | hitstun 32 | same threshold |
| Hitlag | `min(20, floor(0.5d)+4)` | `floor(d*0.65+6)`, cap 30 | freeze is shorter, no electric or crouch cancel |
| Shield | HP 60, decay 0.12, regen 0.07, stun `floor(0.6d)+2` | HP 50 at 1.19, 0.15, 0.08, stun by move type | one stun formula for the frame-trap calculator |
| Ledge | 40 frames, 3 grabs, no trump | formula, 6 grabs, trump | hogging is real, see below |
| Tech | window 20, lockout 40, floor only | 11 or 12, 40, walls and ceilings | tech-chase windows are exact and generous |
| Air dodge | 34 frames, intangible 2-31 | 52 (Mario), intangible 3-29 | shorter, less punishable |

### Missing mechanics: add or not, and how the brain behaves

Each entry gives a recommendation for the game and the treatment in the CPU guide.

1. Trajectory DI (absent). Recommend: do not add for the CPU project; it is a large balance change and every character's combo data would need retesting. Brain, absent: victim movement during hitstun is a pure function of the hit, so a combo table built from the forward model is exact for all knockback values and the search brain needs no DI reply model. If added later (0.17 rad rotation by the perpendicular stick component, read on the last hitlag frame, LSI x1.095 and x0.92 outside 65 to 115 and 245 to 295 degrees), model DI as three replies (none, best survival, best combo escape) and score combos by the worst of them.
2. SDI and ASDI (absent). Recommend: no. Brain, absent: multi-hit moves connect deterministically once the first hit lands. If added, use the Ultimate numbers (2 units per pulse, 4-frame gap, x1.15 per five hits) scaled by the port's px-per-unit ratio (`unverified:`).
3. Perfect shield / parry (absent). Recommend: add as an optional rule flag if the owner wants a defensive skill ceiling, since the level 10 brain could otherwise never be punished for shield pressure and lower levels cannot express a "counter" archetype through it. Spec: release within frames 1-5 of the drop, shield up at least 3 frames, no shield damage, act out of the drop; extra hitlag +14 attacker and +11 defender on direct melee. Brain, absent: shield is always safe from parry, so on-shield advantage is `shieldstun` and shield HP arithmetic; measure it in the forward model. If present, the god brain must be capped to a human window or it parries everything; use a per-level reaction delay with a hit-frame prediction error.
4. Rage (absent). Recommend: add only if the game wants comebacks. Cost is one multiplication (1 + (p_attacker - 35)/115 * 0.1, clamped). Brain, absent: kill percent tables need only `(victim percent, weight, move)`. If added, index tables by attacker percent as well or compute `kbReq` directly with the inversion above (about 8% shift at a 100% attacker).
5. Stale-move negation (absent). Recommend: add. It is the main brake on a search brain that finds one best kill move and repeats it (fully stale 0.4695 times damage, fresh 1.05). Spec: queue of 9, the Ultimate reductor list above, freshness bonus 1.05, 0.3 of the term in `d'`, clear on KO. The queue must be inside the cloned state and the rollback hash. Brain, absent: repeated use costs nothing, so add an explicit repetition penalty in the level tables (fewer repeats at higher levels) or the tiers will feel scripted.
6. Hitstun cancelling (absent). Recommend: no; Ultimate's version is almost inert because of balloon knockback. Brain: hitstun `T` is exact, so `advantage = T - (FAF - hitFrame - 1)` gives true combo windows (verify off-by-one by simulation).
7. Balloon knockback and the hitstun minus 1 (absent). Recommend: no change unless the owner wants Ultimate feel, since it would shorten every high-kb combo. Brain: state in the guide that Aevalrena hitstun is longer than Ultimate's, so professional Ultimate combo tables cannot be imported.
8. Ledge trump, airtime and percent scaling, 6-grab limit, regrab slowdown (absent or simplified). Recommend: add trump if the owner wants Ultimate edge play; the current sim lets a fighter occupy a ledge and block the recovery. Brain: edge-hog is a first-class edgeguard plan (the level 10 code already has `ledgeHog`); the ledge invulnerability value must be read from state, not assumed to be a formula.
9. Grab release immunity (absent in `src/sim/grab.ts` as far as I read). Recommend: add a post-release grab immunity (60 frames in Ultimate) if chain grabs on a passive victim are unwanted; a level 10 brain would otherwise find and loop them. Throw invincibility until the throw, hitbox-beats-grab and simultaneous-grab cancel are `unverified:` in the sim.
10. Wall jump, wall tech, ceiling tech (absent). Recommend: no. Brain: the only tech situations are floor landings.

### Sim differences the CPU guide must state

- Launch scale 0.06 and unscaled decay 0.051 (Ultimate 0.03 and 0.051); gravity accumulates in a separate term during hitstun and the victim's air friction and air control are off until hitstun ends.
- Sakurai angle is a step at kb 60 with 40 degrees, not a 0 to 38 ramp.
- Blast and platform numbers in the brief differ from the code; read stage data at run time.
- `ROLL.distance` is 80 in code against 60 in the brief.
- The forward model, not a formula table, is the source of truth for advantage, KO frame and tech timing, because off-by-one conventions differ between the Smash wikis and the sim.

## Open questions

- Smashboards research threads on knockback values and teching were seen only as search snippets, never opened, so nothing here depends on them.
- The exact Ultimate speed-up interaction with gravity (per tick or per frame) is read from calculator code only.
- Tech window 11 (SSBWiki Tech) against 12 (Lucario techs page), and ledge intangibility 63 against 64 base frames, are unresolved between sources.
- Per-stage Ultimate blast zone coordinates and the per-character "damage fly top" gravity values were not recorded, so no real-game KO distance example is given beyond the formulas.
- Grounded meteor 0.8 ratio in Ultimate, ledge attack timings, and Aevalrena's shield drop frames and throw invincibility are not verified.

## Sources

Fetched (page read in full or by section as wikitext, HTML or raw file):

- https://www.ssbwiki.com/Knockback: knockback formula, terms, launch speed 0.03, decay 0.051, gravity change, set and weight-independent knockback, rage range, bounce loss.
- https://www.ssbwiki.com/Hitstun: hitstun formula, Ultimate minus 1, speed-up description and examples, minimum flinch hitstun.
- https://www.ssbwiki.com/Tumble: 32-frame tumble rule, reeling.
- https://www.ssbwiki.com/Hitlag: Ultimate hitlag formula, cap, multipliers, 0x rule.
- https://www.ssbwiki.com/Hitstun_canceling: Brawl, Smash 4 and Ultimate cancel rules and thresholds.
- https://www.ssbwiki.com/Rage: Ultimate rage formula and set-knockback exclusion.
- https://www.ssbwiki.com/Stale-move_negation: queue rules, Ultimate shield staling, worked example.
- https://www.ssbwiki.com/Directional_influence: DI angle, LSI, timing.
- https://www.ssbwiki.com/Smash_directional_influence: SDI distance, cooldown, shield SDI.
- https://www.ssbwiki.com/Automatic_smash_directional_influence: ASDI limits in Ultimate.
- https://www.ssbwiki.com/Crouch_cancel: Ultimate crouch cancel factors.
- https://www.ssbwiki.com/Sakurai_angle: Sakurai and angle-0 rules by game.
- https://www.ssbwiki.com/1v1_multiplier: 1v1 damage multiplier and what it does not affect.
- https://www.ssbwiki.com/Shield: shield HP, depletion, regeneration, reset, pushback formulas, options.
- https://www.ssbwiki.com/Shield_damage: 1.19 factor and bonus shield damage.
- https://www.ssbwiki.com/Shieldstun: Ultimate shieldstun formula, cap.
- https://www.ssbwiki.com/Perfect_shield: parry window, hitlag values, limits.
- https://www.ssbwiki.com/Shield_drop: shield drop frames.
- https://www.ssbwiki.com/Out_of_shield: out-of-shield rules and frame counts.
- https://www.ssbwiki.com/Shield_grab: shield grab startup penalty.
- https://www.ssbwiki.com/Stun: shield break stun formula and mashing.
- https://www.ssbwiki.com/Button_mashing: mash rates and input cooldowns.
- https://www.ssbwiki.com/Jump: jumpsquat, initial height, heights.
- https://www.ssbwiki.com/Short_hop: short hop aerial rules and 0.85 damage.
- https://www.ssbwiki.com/Fast_fall: fast fall multipliers.
- https://www.ssbwiki.com/Lag: landing lag notes and air dodge landing lag.
- https://www.ssbwiki.com/Air_dodge: Ultimate air dodge rules and staling.
- https://www.ssbwiki.com/Spot_dodge: spot dodge frames and staling formula.
- https://www.ssbwiki.com/Roll: roll frames and staling formula.
- https://www.ssbwiki.com/Edge: ledge intangibility formula, hang time, regrab penalties, 2-frame punish.
- https://www.ssbwiki.com/Edgeguarding: ledge trump.
- https://www.ssbwiki.com/Blast_line: meteor blast line.
- https://www.ssbwiki.com/Tech: tech window, lockout, surfaces.
- https://www.ssbwiki.com/Grab: hold time formula, immunity, priority.
- https://www.ssbwiki.com/Grab_release: release lag and simultaneous-grab damage.
- https://www.ssbwiki.com/Throw: throw invincibility.
- https://www.ssbwiki.com/Pummel: pummel damage.
- https://www.ssbwiki.com/Lucario_(SSBU)/Techs, https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups, https://www.ssbwiki.com/Lucario_(SSBU)/Floor_getups_(front), https://www.ssbwiki.com/Lucario_(SSBU)/Floor_getups_(back): example tech, ledge and getup frame data, tech window 12 note.
- https://kuroganehammer.com/Smash4/Formulas: Smash 4 formulas (knockback, staling, rage, hitstun, hitlag, ledge, grab); Smash 4 only.
- https://ultimateframedata.com/mario and https://ultimateframedata.com/stats: Mario dodge, grab, jump and landing data, out-of-shield frames.
- https://github.com/rubendal/SSBU-Calculator (files js/formulas.js and js/knockback.js via https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js and https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/knockback.js): community reference implementation of Ultimate formulas and launch simulation.
- https://github.com/aevalmere/aevalrena (local read-only copy: constants, hits, physics, ledge, tech, grab, actions, calibrate, stage geometry, SPEC): Aevalrena mechanics and probe results.

Seen only as search snippets and not cited for any claim above: the Smashboards research threads on knockback values and on teching (not opened). Nothing in this report rests on a snippet.
