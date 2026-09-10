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
