# Playtest log

Integration pass, 2026-09-09. Chrome via the Browser pane against `npm run dev` at
http://localhost:5173, canvas at 1x integer scale.

Test harness note: the automation layer sends keyboard events with an empty `KeyboardEvent.code`,
and the pane suspends `requestAnimationFrame` while it is not on screen. Every step below was
therefore driven by dispatching real `KeyboardEvent`s with the right `code` on `window`, and by
replacing `requestAnimationFrame` with a timer of the same period. Nothing in `src/` was changed for
the test. That timer caps the observed frame rate near 52, so the fps figure below measures the
harness, not the engine.

## Checklist

| # | Step | Result | Notes |
|---|---|---|---|
| a | Title screen renders | pass | Logo, "press any key", version string. |
| b | Any key to mode menu, Local to select, slot 0 Human and slot 1 CPU 1, Start | pass | Off slots showed a stray character stepper until the `[hidden]` CSS fix. |
| c | Match renders: parallax, platforms, two fighters, HUD 0 percent 3 stocks | pass | Player-colored outlines, HUD sits below the stage and never over a fighter. |
| d | Hold KeyD walks, double tap dashes, Space jumps, Space twice double jumps, KeyS fast falls | pass | Hold now walks at 1.3 and a double tap runs at 2.6. See the input decision in DECISIONS.md. |
| e | KeyJ jab, hold KeyD + KeyJ ftilt, tap KeyD + KeyJ fsmash, KeyK water orb, KeyW + KeyK geyser | pass | All confirmed with F1 hitboxes on. Orb spawns and flies, geyser rises with its hitbox. |
| f | Attack the CPU: percent rises, sparks, launch | pass | fsmash took the dummy to 15 percent, launched at vx 3.6 vy -3.1, spark burst drawn, HUD percent scaled up. Screen shake fires from the hit event but a still frame cannot prove it. |
| g | KeyL shield bubble, KeyL + KeyS spot dodge | pass | Bubble scales with shield HP. Down must come after shield is held, otherwise it drops through a pass-through platform, which is correct. |
| h | Walk off the edge and drift back: ledge hang | pass | Reached `ledgeHang` then `ledgeClimb` when the drift key kept pointing at the stage. |
| i | Escape pauses and the game freezes, Resume returns | pass | Frame counter froze. Resume does not re-pause: the latch is drained. |
| j | CPU walks, jumps, attacks, recovers; results show; Rematch; Character Select | pass | Results lists winner, slot, character, stocks, percent. Rematch restarts with a new seed. Character Select returns and clears the canvas. |
| k | Rebind P1 attack to KeyU, confirm, rebind back to KeyJ | pass | Live in the same session, saved to `aevalrena.controls.v1`, and KeyJ went dead while KeyU was bound. |
| l | F3 perf under 4 ms, F2 action names | pass | See perf below. F2 lists action, move, action frame, percent, vx and vy per fighter. |
| 4p | Slots 2 and 3 as CPU 2 and CPU 3, all four fight, camera zooms out | pass | Four HUD cards, four outline colors, camera widened as the fighters spread. |

No console errors or warnings at any point.

## Perf

F3 overlay, 1x zoom, samples taken during 2-fighter and 4-fighter play:

- sim: 0.00 to 0.20 ms per frame (4 fighters with projectiles and particles: 0.20 ms)
- render: 0.40 to 2.30 ms per frame, typically 0.80 ms
- fps: 50 to 54, limited by the test harness timer described above

Both halves sit far under the 4 ms budget.

## Known issues not fixed

- A CPU cannot reach an opponent hanging on a ledge, so a match where the human stops playing while
  hanging never ends. A player who presses anything leaves the hang and the match resumes.
- Level 1 CPUs rarely KO. Two level 1 CPUs left alone reach high percent and stall; matches between
  them can run past 30000 frames. Level 2 and 3 finish normally.
- Level 2 and 3 CPUs lean heavily on up air when an opponent is above them.
- Walking a direction from a standstill can produce an fsmash from a CPU that has to turn around,
  because the turn registers as a fresh direction tap.
- Screen shake and the 2-frame white hit flash were not verified frame by frame; only their event
  sources were.

## Controls

Defaults from `src/input/defaults.ts`. Every action has 2 key slots and 2 pad slots, and anything not
listed starts unbound. Rebind on the Controls screen. Tap jump starts on.

### P1 keyboard

| Action | Key |
|---|---|
| Left, Right, Down | A, D, S |
| Up | W |
| Jump | W, Space |
| Walk (hold) | Left Shift |
| Attack | J |
| Special | K |
| Shield | L |
| Grab | ; |
| Dodge | E |
| Taunt | T |
| Pause | Escape |
| Forward smash | F + J |
| Up smash | F + W |
| Down smash | F + S |
| Forward tilt | G + J |
| Up tilt | G + W |
| Down tilt | G + S |

W is bound to both Up and Jump; Walk (Shift) suppresses the jump so Shift + W + J is an up tilt
instead of a jumpsquat.

### How to do each move (P1 keyboard)

- Jab: Attack (J), no direction held.
- Forward tilt: hold Shift (Walk) + Left/Right + Attack, or G + J.
- Up tilt: hold Shift (Walk) + W + Attack, or G + W.
- Down tilt: hold S (Down) + Attack, or G + S.
- Dash attack: hold Left/Right without Walk to dash or run, then Attack.
- Forward smash: flick Left/Right and Attack together, or F + J.
- Up smash: flick W and Attack together, F + W, or a jump-cancelled/out-of-shield up smash.
- Down smash: flick S and Attack together, or F + S.
- Neutral air: Attack in the air with no direction held.
- Forward air: Attack in the air toward the way you're facing.
- Back air: Attack in the air away from the way you're facing.
- Up air: Attack in the air + Up (W).
- Down air: Attack in the air + Down (S).
- Neutral special: Special (K), no direction.
- Side special: Special (K) + a side.
- Up special: Special (K) + Up (W), also out of shield or jump-cancelled from jumpsquat.
- Down special: Special (K) + Down (S).
- Grab: Grab (;) on the ground, or Shield (L) + Attack (J) out of shield.
- Shield: hold Shield (L) on the ground.
- Spot dodge: double-tap Down (S), or Dodge (E) with no direction held.
- Roll: double-tap Left/Right (A/D), or Dodge (E) + a held direction.
- Air dodge: Shield (L) or Dodge (E) in the air, toward whatever direction is held.
- Taunt: Taunt (T).

### Gamepad (every player)

Standard mapping. PlayStation name first, Xbox name second.

| Action | Slot 1 | Slot 2 |
|---|---|---|
| Left, Right, Up, Down | Left stick | D-pad |
| Jump | Triangle / Y | Square / X |
| Attack | Cross / A | |
| Special | Circle / B | |
| Shield | L2 / LT | R2 / RT |
| Grab | R1 / RB | |
| Dodge | L1 / LB | |
| Taunt | R3 (right stick click) | |
| Pause | Options / Menu | |
| C-stick up, down, left, right | Right stick | |

A light left stick tilt walks. A full tilt runs. Only a full push up tap-jumps: a gentle upward
tilt, short of the walk threshold, is read as a held Up instead, so a pad player can tilt up gently
and press Attack for an up tilt.

### Things to try

- Double tap left or right on the ground to roll. Double tap Down to spot dodge.
- Press Grab next to the CPU, then Attack to pummel, or a direction to throw. Get grabbed and mash to
  break out.
- Get launched into tumble and press Shield just before landing to tech. Hold a direction as well to
  tech roll. Land without teching and try the get-up options.
- Jump onto a fighter's head in the air and press Jump again to footstool.
- Turn the Final Smash rule On in Mode Select, fill the meter, face an opponent and press Special.
- Hold F and press J for a forward smash.
- Press W then F quickly: it still comes out as an up smash, jump-cancelled out of the jumpsquat W
  started.
- Hold Shift, then W, then J for an up tilt.
- Press L (Shield) in the air while holding a direction to air dodge that way.
- Press L (Shield) on the ground next to an opponent, then J (Attack) to grab out of shield.
- On the Mode Select screen, set a player's slot to CPU Lv 0 in Character Select and toggle "Lv 0
  CPU" to Wanders; the dummy walks, runs and jumps at random instead of standing still.
- On the Controls screen, hold two keys and release one to bind a chord.

### Known feel issues

- On keyboard, a bare direction plus Attack gives dash attack (or a forward smash on a fresh flick),
  because holding a direction dashes by default. Forward tilt needs Walk (Shift) held, or G + J.
- The first tap of a double tap still starts a dash, so the fighter slides a little before the roll.
- Saved controls from before this wave are ignored, not migrated: the store key moved to
  `aevalrena.controls.v3`, so any save left under the old `v1` or `v2` keys stays untouched in
  storage and every player gets the new Smash-style defaults once.
- Every keyboard player now has a Walk key, so every player can reach forward tilt (Walk +
  left/right + Attack) and up tilt (Walk + Up + Attack); only Player 1 also has the F/G chord
  shortcuts. Down tilt has always worked for everyone since Down does not dash or jump.
