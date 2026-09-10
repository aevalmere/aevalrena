# Tuning

## Opening the panel

Press F4 during a match or on a menu. The panel opens on the right side of the window, 300 px
wide. Press F4 again to close it. Every group has a header you can click to collapse it.

Each row is a label, a slider and a number box bound to the same value. Changing either one applies
the value on the next sim frame, so you can tune while a match is running. Key presses inside the
panel do not reach the game.

Values live in `TUNING` in `src/core/constants.ts` and in the Aeval character def. The sim reads
them at the moment it uses them and never writes them, so the sim stays deterministic for a given
set of values.

## Knockback

- `toVel`: launch speed in px per frame for one unit of knockback.
- `decay`: launch speed lost per frame while a victim is in hitstun.
- `hitstunPerKb`: frames of hitstun per unit of knockback.
- `tumbleKb`: knockback above which the victim tumbles instead of taking plain hitstun.
- `damageMul`: scales all damage dealt, which also moves hitlag and shield damage.
- `kbMul`: scales the final knockback of every hit.
- `sakuraiThresh`: knockback below which a Sakurai-angle hit uses the low angle.

## Hitlag

- `base`: freeze frames every hit gets before damage is counted.
- `perDamage`: extra freeze frames per point of damage.
- `max`: cap on the freeze frames a single hit can produce.

## Input

- `buffer`: frames a button press stays buffered waiting for an action to accept it.
- `smashTapWindow`: frames after a direction press in which an attack becomes a smash.
- `dashRetapWindow`: frames in which a second tap of the same direction dashes.
- `chargeMax`: frames a smash can be held at charge.
- `chargeBonus`: extra damage fraction at full charge.

## Camera

- `lerp`: how fast the camera moves toward its target, 0 to 1 per frame.
- `zoomMin`: closest the camera is allowed to pull in.
- `zoomMax`: furthest the camera is allowed to push out.
- `margin`: px of empty space kept around the fighters.
- `shakeMax`: px of screen shake at the strongest hit.
- `shakeFrames`: frames a shake takes to fade out.

## Aeval physics

These rows write into the character def in place, so they change the fighter that is already on
screen: `weight`, `walkSpeed`, `runSpeed`, `dashSpeed`, `dashFrames`, `groundAccel`,
`groundFriction`, `airSpeed`, `airAccel`, `airFriction`, `gravity`, `maxFall`, `fastFall`,
`jumpVel`, `shortHopVel`, `doubleJumpVel`, `jumpSquat`. Each one matches the field of the same name
in section 5 of the spec.

## Session

- Time scale buttons 0.25x, 0.5x and 1x. The sim still runs at 60 Hz; the loop feeds it less real
  time, so rendering stays smooth while the fight slows down.
- Freeze CPU: every CPU slot receives an empty input frame, so a computer opponent stands still
  while you test a move on it.
- The readout under the buttons lists each fighter's slot, action, percent and remaining hitstun,
  refreshed ten times a second.

## Saving and copying

- Save writes the four TUNING groups and the Aeval physics fields to `localStorage` under
  `aevalrena.tuning.v1`. Saved values are applied at boot, before the first match. Unknown keys and
  values that are not numbers are ignored.
- Reset all restores the built-in defaults for both TUNING and the physics fields, and clears the
  saved key.
- Copy JSON puts the same JSON on the clipboard. If the browser refuses the clipboard, the text
  appears in a box below the buttons, selected and ready to copy by hand.

## Knockout calibration

`npm run calibrate` runs `src/sim/calibrate.ts`. P1 stands at x -20 facing right and performs one
move against a motionless P2 (weight 88) at center stage. Aerials start on the first airborne frame
30 px above the stage. For every move with a hitbox or a projectile the harness binary searches the
lowest victim percent, from 0 to 300, at which the move kills inside 240 frames.

The upward normals and the whirlpool are centered on the attacker and cannot touch a victim 40 px
away, so the harness probes closer placements and prints the one it used: `gap` is how far to the
right the victim stands, `lift` is how far above the attacker's feet the victim starts. `kb at 100`
is the largest launch knockback the move produces against a victim at 100 percent.

```
move        gap  lift    ko %  full ko %  kb at 100
---------------------------------------------------
jab          40     0    none          -       42.5
ftilt        40     0     166          -       69.2
utilt        26     0     151          -      117.7
dtilt        26     0     169          -      111.1
dashatk      40     0     151          -       85.6
fsmash       40     0     100         64       94.2
usmash       26     0     106         69      143.8
dsmash       40     0     114         78       91.1
nair         26     0     176          -       77.5
fair         40     0     130          -       80.8
bair          0     0     121          -       91.3
uair          0    44     137          -      110.8
dair         26     0    none          -      144.6
nspecial     40     0     210          -       63.0
sspecial     40     0     140          -       78.5
uspecial     26     0     162          -      120.0
dspecial     26     0     130          -      145.7
ledgeatk     40     0     180          -       66.3
getupatk     40     0     178          -       67.8
```

Targets for this pass, all met inside plus or minus 10 percent: jab never below 250, ftilt 165,
utilt 150, dtilt 170, dashatk 150, fsmash 100 uncharged, usmash 105, dsmash 115, nair 175, fair 130,
bair 120, uair 135, nspecial 210, sspecial 140, uspecial 160, dspecial 130 on the last hit, ledgeatk
and getupatk 180. dair is a spike and is not calibrated: it sends the victim down, so a grounded
victim never leaves the stage and the harness reports no kill. Numbers were reached by editing
`bkb` and `kbg` in `src/characters/aeval/moves.ts`, never by changing the knockback formula or the
TUNING defaults.
