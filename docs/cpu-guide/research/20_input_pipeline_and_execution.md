# Input pipeline and execution for CPU brains

## Conventions

- Frames are 1/60 s (16.67 ms). Values are Ultimate unless a line names another game. Aevalrena facts were read from the local repo copy of https://github.com/aevalmere/aevalrena and are cited by path, for example `src/sim/input.ts`.
- `unverified:` marks anything I could not confirm on a fetched page or in code. `computed:` marks numbers I derived from a formula or from repo constants.
- The web search budget ran out during this task, so every external source below was fetched directly (raw files or pages). None rests on a search snippet.

## Virtual controller designs

### libmelee and SmashBot

libmelee's `Controller` keeps two states, `current` and `prev`. Buttons are booleans, sticks are floats from 0 to 1 with 0.5 as neutral, and the analog shoulders are separate from the digital L and R buttons (https://github.com/altf4/libmelee/blob/master/melee/controller.py). The methods `press_button`, `release_button`, `tilt_analog` and `release_all` only queue text lines for the Dolphin pipe. `flush()` copies `current` into `prev` and sends a FLUSH line, and the docs expect one flush per frame (https://libmelee.readthedocs.io/en/latest/controller.html). Pressing a button that is already down does nothing, so the API has no press-edge field. An edge exists only as the difference between `prev` and `current`, and every SmashBot chain that needs a one-frame press tests `controller.prev.button[X]` and lets go if it was already down (https://github.com/altf4/SmashBot/blob/master/Chains/wavedash.py). On the hardware path each stick axis is quantized to 1..255 with `int(clamp(v, 0, 1) * 254) + 1` (controller.py above). The `simple_press` helper releases every other button and its docstring warns against calling it twice in a frame.

SmashBot stacks Strategy, Tactic and Chain, and only chains touch the controller. A `Chain` has an `interruptible` flag (default True) and a `step(gamestate, smashbot_state, opponent_state)` method (https://github.com/altf4/SmashBot/blob/master/Chains/chain.py). A tactic keeps its chain instance while the requested chain type is unchanged and builds a new one otherwise (https://github.com/altf4/SmashBot/blob/master/Tactics/tactic.py). The strategy steps the running tactic and returns early while `isinteruptible()` is false (https://github.com/altf4/SmashBot/blob/master/Strategies/bait.py). A comment in the same file says that when the bot is stuck in a lag state it should do nothing, because an attempted action might buffer an input it does not want. The main loop sends a neutral input if any step throws (https://github.com/altf4/SmashBot/blob/master/smashbot.py).

### Chains as multi-frame input programs

A chain is a per-frame state machine keyed on the observed `action` and `action_frame`, not a precomputed frame array. Three examples show the pattern:

- Wavedash: press Y from shield or a neutral state, let go the next frame (the `prev` check), and once the fighter is in the jump animation press L together with a stick at x = distance/2 + 0.5 and y = 0.35, which the author calls a near-perfect wavedash angle. It sets `interruptible = False` while mid-sequence and back to True when the slide ends (https://github.com/altf4/SmashBot/blob/master/Chains/wavedash.py).
- Jump-cancel up smash: `SmashAttack` presses Y from shield, dash or run (skipping the press if Y was down last frame), then presses A with the stick at full deflection. Charging is a counter, `frames_charged`, incremented while the fighter is in a smash action (https://github.com/altf4/SmashBot/blob/master/Chains/smashattack.py).
- Multishine: press B with the stick down again on `action_frame == 3` of knee bend (https://github.com/altf4/libmelee/blob/master/melee/techskill.py).

The same file has a latency test that dash-dances while adding delay, which is direct evidence that a libmelee bot's input pipeline has a measurable lag of whole frames.

### Tilt versus smash by analog magnitude

SmashBot chooses the move class with stick magnitude. `Tilt` sends 0.65 or 0.35 on the stick axis (0.15 from center) together with A (https://github.com/altf4/SmashBot/blob/master/Chains/tilt.py). `SmashAttack` sends 0 or 1 (full deflection) with A on the same flush (smashattack.py above). Moving the stick from neutral to full within one frame is a perfect flick, so the bot never searches for a timing. The C stick is a second direct channel: `techskill.upsmashes` just sets the C stick to (0.5, 1).

Aevalrena: there is no analog axis. The `Btn.Walk` bit is the magnitude substitute (Walk held downgrades a flick to a tilt) and direct move codes are the C-stick substitute (`src/sim/actions.ts`, `docs/SPEC.md` section 4.3).

### Preventing accidental dashes and rolls

`DashDance` is a list of guards, and several of them exist to stop an unwanted double tap. It never sends a dash while the fighter is shielding, walking, or in the first frames of a forward dash, and it neutralizes the stick for a frame when the previous stick direction did not produce the expected turn or dash (https://github.com/altf4/SmashBot/blob/master/Chains/dashdance.py). The reason is Melee behavior: a shield press in the first two frames of a forward dash always rolls (https://www.ssbwiki.com/Dash). `Powershield` and `Edgestall` use the same one-frame press pattern, letting go if the button was down on the previous frame (https://github.com/altf4/SmashBot/blob/master/Chains/powershield.py, https://github.com/altf4/SmashBot/blob/master/Chains/edgestall.py).

SmashBot also mirrors game timers from its own controller. `ESAgent` sets a 40-frame tech lockout whenever its own L is down and decrements it each frame, so a tactic can ask whether a tech press would still count (https://github.com/altf4/SmashBot/blob/master/esagent.py). Melee has the same 40-frame rule (https://www.ssbwiki.com/Tech).

### Rivals of Aether workshop

The manual documents the read side of input and the AI state, not the write side. Each input name has `_pressed` (buffer included) and `_down` (held); the input-names page says a `_pressed` check looks back 6 frames. It also lists `[direction]_hard_pressed` for stick hits like dashing or platform drops, `[direction]_strong` for smash inputs (there is no plain `strong_pressed`), `joy_dir`, `joy_pad_idle`, and a function `clear_button_buffer(input_index)` (https://www.rivalsofaether.com/workshop/player-variables/, https://www.rivalsofaether.com/workshop/input-names/, https://www.rivalsofaether.com/workshop/functions/). `ai_update.gml` runs every frame for a CPU version of the character and is meant for special cases such as recovery and complex specials; it exposes `ai_target`, `ai_recovering` and `temp_level` (1 to 9) (https://www.rivalsofaether.com/workshop/scripts/). Timers `ai_attack_timer` and `ai_attack_time` (minimum frames between attacks) plus `ready_to_attack`, `ai_going_left` and `ai_going_right` are listed on the player-variables page. `unverified:` how a workshop CPU injects its presses; the manual pages I fetched do not say.

### FightingICE

An AI returns one `Key` per frame from `input()`: seven booleans A, B, C, U, D, L, R (https://github.com/TeamFightingICE/FightingICE/blob/master/src/struct/Key.java). `CommandCenter.commandCall(name)` compiles an action name into a FIFO of Keys and does nothing while that FIFO is non-empty. `DASH` becomes forward, neutral, forward (three frames); motion moves are digit sequences such as 2 3 6 followed by a button, an underscore puts a direction and a button in the same frame, and keys are mirrored when the fighter faces the other way (https://github.com/TeamFightingICE/FightingICE/blob/master/src/aiinterface/CommandCenter.java). That FIFO is the "plan as frame-indexed array" design, with no preemption unless the AI clears the queue. The framework delays the frame data an AI sees by 15 frames (`DELAY = 15`), but the `isControl` flag passed to `getInformation` is not delayed (https://github.com/TeamFightingICE/FightingICE/blob/master/src/aiinterface/AIController.java, https://github.com/TeamFightingICE/FightingICE/blob/master/src/aiinterface/AIInterface.java). Own actionability is exact and only the world is late.

### Mugen and Ikemen GO

Mugen's trigger reference gives `AILevel` as 1 (easiest) to 8, or 0 when AI is off, and `Random` as 0 to 999. Its example scales a probability by 10 percent per level (https://www.elecbyte.com/mugendocs/trigger.html). The `Command` trigger reads a named command from the character's CMD file. The pages that would give command time and buffer time were not fetchable (403). `unverified:` the common community pattern of scripting AI with `ChangeState` under `AILevel` triggers instead of going through commands.

Ikemen GO, a MUGEN-compatible engine, shows the input-level model in source. `AiInput.Update` "jams" buttons: each frame, each button not currently jammed has a 1 in `int((-11.25 L + 165) * 7)` chance to start a hold of uniform 1 to 30 frames (`computed:` 1 in 1076 at level 1, 1 in 525 at level 8), and a random one of eight directions is held with chance 1 in 15 for up to 60 frames. Those presses go through the same command buffer as a human's (defaults: command time 15, buffer time 1) (https://github.com/ikemen-engine/Ikemen-GO/blob/master/src/input.go). A source comment says AI input is handled locally because it uses random numbers. In its GGPO rollback path the AI appears only in the desync-test branch, where `getAIInputs` feeds AI presses to the backend with `AddLocalInput`, the same call a human uses (https://github.com/ikemen-engine/Ikemen-GO/blob/master/src/rollback.go). Its rollback checksum includes the sim RNG seed (rollback.go above).

### A restricted action space

Phillip, the Melee deep-RL agent, acts on every second frame (30 Hz), picks from 9 stick positions and 5 buttons with at most one button at a time (54 actions), and has a 2-frame (33 ms) reaction time. The authors restricted the space on purpose because skilled humans use partial tilts and precise angles that the agent would otherwise exploit. Added delay of 2 to 4 frames barely hurt it; 6 to 10 frames hurt a lot (https://arxiv.org/abs/1702.06230, read through https://ar5iv.labs.arxiv.org/html/1702.06230).

Aevalrena: `InputFrame` (`src/core/types.ts`) already has the libmelee shape (held, pressed, released) plus a `direct` code, which plays the role of FightingICE's named actions and Rivals' `_strong` inputs. What it lacks compared with libmelee is nothing the sim reads: no analog magnitude exists. Build one generic controller object, not per-brain code: it owns `prevHeld`, derives `pressed` and `released` itself, and rejects an inconsistent frame, as level 10's `finish()` already does (`src/ai/aevalmere.ts`).

## Input semantics in Smash-likes

### Input buffer

Buffering exists in every Smash game, but Brawl was the first with a universal buffer. Brawl's window is 10 frames, Smash 4 kept it and added a priority order, and Ultimate's window is 9 frames, down from 10 (https://www.ssbwiki.com/Buffer). So "Ultimate has a 10-frame buffer" is wrong; the number is 9 (verified on SSBWiki and in the Ultimate buffering thread, https://smashboards.com/threads/ultimate-buffering-system.465269/). That thread also gives the grounded priority order (dodge above grab above shield above special above attack above jump above taunt above dash above turn), says only one action is normally buffered, and describes a second mechanism, hold-buffering, where an input held until at least 3 frames before the fighter can act still fires; dash, turn, fast fall and platform drop have their own windows (6 to 7, 6, 3 and 4 frames). The buffer window is tied to interruptibility rather than the whole animation (https://www.ssbwiki.com/Interruptibility). Unintended buffered actions are much more common online because of frame delay (https://www.ssbwiki.com/Buffer). Rivals uses a 6-frame buffer (https://www.rivalsofaether.com/workshop/input-names/).

Aevalrena: the buffer is 6 frames and holds one entry. A fresh press replaces the whole buffer, direct code included; the entry ages by one per frame and clears after age 6, so a press is usable on its own frame and the 6 after (`src/sim/input.ts`, `TUNING.input.buffer`). `consumeInput` runs before the hitlag check (`docs/SPEC.md` section 4.1), so the buffer keeps ageing through hitlag: a press made at the start of a 10-frame hitlag is gone before it ends. There is no hold-buffering and no priority table beyond the order in `tryBuffered` (`src/sim/actions.ts`).

### Flick windows, taps, dash, roll

- Smash input. Ultimate exposes a stick sensitivity option (low, normal, high) that sets the flick window: forward smash 5, 6 or 7 frames; up and down smash 3, 4 or 5; smashed side specials 7, 8 or 9. It does not change how fast a tap must be for dashes, tap jump, fast fall or platform drop (https://www.ssbwiki.com/Control_stick). A tilt is the same attack without a flick (https://www.ssbwiki.com/Tilt_attack). Aevalrena uses one window, 5 frames (`smashTapWindow`), for all four smash directions. That equals Ultimate's low sensitivity for forward smash and is one frame looser than normal for up and down smash.
- Dash versus walk. In Brawl onward a fighter can reverse an initial dash only in its first 6 frames (https://www.ssbwiki.com/Dash, https://www.ssbwiki.com/Dashdance). In Aevalrena a held direction dashes by default and the Walk bit walks; reversing mid-dash restarts the dash immediately (`locomotion` in `src/sim/actions.ts`). `docs/SPEC.md` section 4.2 says a dash needs a tap within `SMASH_TAP_WINDOW`; the code does not. Treat the code as correct: any direction press without Walk dashes. `TUNING.input.dashRetapWindow` (14) is read only by the debug tuner and the constants file, not by the sim.
- Roll and spot dodge. In Smash a roll is a stick flick with shield held (https://www.ssbwiki.com/Roll). Aevalrena rolls on a double tap of the same direction (12-frame `rollTapWindow`) or Dodge plus a direction, and Shield on the ground never rolls. The sim compares each fresh Left or Right press with the previous horizontal press: same direction inside 12 frames sets `dirRetap`, an opposite press overwrites the remembered direction, so Left, Right, Left is not a retap. The retap check runs before the dash check, so the second tap rolls instead of dashing (`src/sim/input.ts`, `tryTapRoll`). Down works the same for spot dodge, except on a soft platform where the drop-through wins.
- Tap jump. Stick-up jump causes accidental jumps when a player wants an up tilt or up aerial, so tournament players often turn it off (https://www.ssbwiki.com/Tap). In Aevalrena Up jumps by default unless the Walk bit is held (`docs/SPEC.md` section 4.3).

### Jump squat, short hop, jump cancel

Ultimate gives every fighter a 3-frame jump squat (Kazuya 7, Giga Bowser 15), which is why short hops are hard on a stick; players compensate with the jump-plus-attack short-hop aerial (0.85x damage) and two simultaneous jump buttons (https://www.ssbwiki.com/Jump, https://www.ssbwiki.com/Short_hop). In Melee the short-hop window is jump squat minus one frame (Short hop page).

Aevalrena: Aeval's `jumpSquat` is 3 (`src/characters/aeval/moves.ts`). `stepJumpsquat` sets the short-hop flag on any squat frame where Jump is not held, so a press on frame 0 released on frame 1 is a short hop; a full hop needs Jump held through the last squat frame. Level 10's `hopAerial` uses hold 1 for short hops and hold 4 for full hops. Only up smash and up special cancel a jump squat (Up plus Attack, Up plus Special, C-stick up, or their direct codes); any other move pressed in the squat stays buffered and comes out in the air. The repo test `bg` in `src/sim/selftest.ts` confirms the sequence: Jump on frame 0, then Up plus Attack on frame 1, gives a grounded up smash.

### C-stick and direct channels

The C-stick in Melee acts as a macro that tells the game a tap and an attack press happened on the same frame (https://www.ssbwiki.com/Tap). In Aevalrena the four C-stick bits buffer like buttons, give smashes on the ground and aerials in the air, and sit in `ACTION_BUTTONS` (`src/sim/input.ts`). Direct move codes (`InputFrame.direct`, 17 moves then 20 commands) need no stick timing at all. A smash started by a direct code charges on its own direction key (Up, Down, or the facing side), not on Attack (`docs/SPEC.md` section 4.3); level 10's `P_USMASH_C` holds Up for 13 frames after the code for that reason.

### Buffered actions out of hitstun and tech

Human mashing gets punished by four mechanisms. First, a buffered press fires on the first actionable frame, so a jab or aerial the player did not want comes out (Smash 4 explicitly allowed buffering out of hitstun, https://www.ssbwiki.com/Buffer). Second, a shield press too early locks out the tech: Ultimate's tech window is 11 frames and any shield press starts a 40-frame lockout (https://www.ssbwiki.com/Tech). Third, mashing keeps re-triggering the lockout. Fourth, Ultimate restored tech buffering during hitlag (Tech page).

Aevalrena: the tech press window is 20 frames and the lockout is 40 (`TECH` in `src/core/constants.ts`). A Shield, Dodge or `tech` press outside the lockout opens the window and starts the lockout; presses inside it do nothing. `computed:` a shield masher therefore has the window open for 20 of every 40 frames, 50 percent coverage. In tumble, any non-tech press (Jump, Attack, a direction is not a press) ends the tumble into the air, which throws away the tech (`stepHitstun`, `src/sim/actions.ts`). CPU rule: from the frame a hit lands until the fighter is actionable, emit only the planned tech press, timed inside the landing prediction (`TECH_LOOK` = 10 frames in level 1 to 9), and mask every other press. Levels 1 to 9 and level 10 both strip Shield and Dodge while launched for this reason (`src/ai/index.ts`).

### Locks and rapid jabs

Jab locks exist in Brawl, Smash 4 and Ultimate (two-hit limit in Ultimate) and need repeated fast presses on a floored opponent (https://www.ssbwiki.com/Lock). Aevalrena has a single-hit jab (18 frames, iasa 14 in `docs/SPEC.md`) and no lock system I could find. `unverified:` whether a hit on a downed fighter re-bounds it. I could not tie "attack cancel" to a specific SSBWiki mechanic, so this report covers its three likely meanings elsewhere: interruptibility (IASA), jump cancel, and hit-confirm timing.

### Accident channels in Aevalrena

| Accident | Sim cause | Guard |
|---|---|---|
| Tilt becomes smash | Attack within 5 frames of a fresh direction press, Walk not held | Use a direct code, or hold Walk, or wait until `dirTapAge > 5` (level 1 to 9 waits `smashTapWindow + 3`) |
| Smash becomes tilt | Attack later than 5 frames after the press | Direct smash code |
| Dash becomes roll | Second press of the same horizontal direction inside 12 frames | Tap mirror: wait until 13 frames after the last press of that direction |
| Roll or dash becomes spot dodge | Second Down press inside 12 frames | Same mirror on Down |
| Attack becomes dash attack | Attack while `dash` or `run` | Hold the press one frame, release the run first (level 1 to 9 `jabPending`) |
| Up becomes jump | Up press without Walk | Walk bit, or direct codes |
| Late shield loses the tech | Shield or Dodge press starts a 40-frame lockout | Only the planned tech press while launched |
| Buffered press misfires | 6-frame buffer holds a stale press | No presses in states where the buffer will outlive the state |
| Shield in the air | Shield press airborne is an air dodge | Never send Shield while airborne unless an air dodge is wanted |

## Plan and executor architecture

### Plan representation

Three designs appear in the sources: a FIFO of per-frame keys (FightingICE), a per-frame state machine keyed on observed animation (SmashBot chains), and a function of plan time and own state (level 10's `planStep(pid, t, f)`). A frame array is easy to test but cannot absorb hitlag, a bumped fighter, or a fighter that lands earlier than planned. A state machine keyed only on observation is robust but hard to reuse in rollouts. Level 10's compromise is the one to keep: a plan is `{ id, minFrames, flags, script(t, self) }`, the script counts its own output frames `t`, reads the fighter's exact state to stay valid, and the same function drives both the rollouts and the real output, so what the search evaluated is what gets pressed (`src/ai/aevalmere.ts`).

One rule to add: hitlag freezes the fighter but not the brain (a comment in `src/ai/index.ts` says so), so a script synchronized to move frames must advance `t` only on frames where `hitlag == 0`, or key on `actionFrame`. Scripts keyed to output frames drift by the hitlag length otherwise.

### Interruptibility and IASA-aware endings

Level 10 tags plans with flags: `F_ATTACK` (commits a hitbox), `F_INTR` (may be replaced every `REPLAN` = 3 frames or on a trigger), `F_TAIL` (recovery policy takes over off stage), `F_MOVE`, `F_PROJ`, `F_EG`, `F_STALE`, `F_SPIKE`, plus `PLAN_MIN` minimum frames. A plan with `F_INTR` unset runs until its script ends. SmashBot's `interruptible` flag is the same idea, set false in the middle of a multi-press chain and true after the last press.

For endings, use move data. The sim ends a move at `totalFrames`, or at `iasa` if a new action is requested (`docs/SPEC.md` section 4.3). A queued follow-up should therefore be pressed at `iasa - k`, where `k` is at most the buffer length (6). It then fires on the first actionable frame with no chance of being late. Humans press early to use the buffer; the cost of being early is a stale press (a press more than 6 frames early expires), the cost of being late is a full frame of lag each. After hitlag the same holds: the follow-up must be pressed within the last 6 frames of hitlag, and the frame that ends hitlag is the exact one.

Aevalrena: `PLAN_MIN` and `F_INTR` already give continuation logic. What is missing is a generic "next plan" slot: level 10 decides only when `act` (actionable) is true, so no follow-up is ever pre-buffered.

### Continuation versus re-decision

Level 10 decides when a plan's minimum is done and its flags allow it: a non-interruptible plan always ends before a new decision; an interruptible one re-decides on a trigger (the opponent's action signature changed as seen `AEVALMERE_REACT` = 4 frames ago) or every 3 frames (6 for recovery). A plan that lost its footing (launched, on a ledge, downed) is re-decided immediately. Keep those three rules and make plan validity explicit: each plan declares the states it can legally run in, and the executor drops it the frame the fighter leaves them.

### Reflex layer

Reflexes run outside search, before plan selection, and claim the frame. Level 10 does this inline with early returns; levels 1 to 9 run Final Smash, footstool and mashing "every real frame, outside the decision cadence" (`src/ai/index.ts`). Ordering: reflexes, then plan continuation, then new decision. A reflex that fires drops the plan, or freezes its clock if the plan is flagged resumable.

Reflex list for Aevalrena, with the numbers that set each trigger:

- Held (`grabbed`): mash every allowed frame; never use Shield or Dodge bits, since each starts the 40-frame tech lockout and a throw launches into a tumble that needs the tech.
- Respawn platform: leave early on input; level 10 waits until `actionFrame` 20 and presses Down once.
- Tech: arm when the predicted landing is within about 10 frames; choose in place or roll by rollout; press once (the sim ignores later presses for 40 frames anyway).
- Ledge: options are chosen from hang frame 1; the first 3 grabs give 40 frames of invulnerability, later ones none; a drop has a 12-frame regrab cooldown (`src/sim/ledge.ts`).
- Shield floor: drop the shield when its HP would fall below the profile's floor; a break is 180 stunned frames.
- Getup: pick an option when `downed`; the knockdown lasts at most 120 frames.
- Buffer hygiene: in hitlag, hitstun and tumble, emit nothing except the tech press.

## Human execution modelling

### Timing jitter

Model each press or release as an event with a target frame and a random offset. Two distributions:

- Practised, self-timed inputs (a scripted wavedash, a short hop): Gaussian with standard deviation sigma frames, rounded to an integer.
- Reaction-triggered inputs (shield on seeing a move): ex-Gaussian, the standard shape for response times (https://en.wikipedia.org/wiki/Exponentially_modified_Gaussian_distribution). Sample `mu + sigma * z - ln(u) / lambda`, mean `mu + 1/lambda`, variance `sigma^2 + 1/lambda^2`. Pick `mu` so the mean equals the level's reaction frames. Human simple visual reaction time is about 190 ms (11 frames) in the textbook figure (https://en.wikipedia.org/wiki/Reaction_time) and about 265 ms (16 frames) for a fighting-game player reacting to one known cue (https://ki.infil.net/reaction.html). That page also notes that single blocking inputs are faster than button presses, which are faster than motion inputs.

No source I fetched gives a measured sigma for Smash input timing. `unverified:` any specific sigma. What can be derived is the success rate on a window. With a Gaussian error and a window of width w frames centered on the target, `P = erf(w / (2 * sigma * sqrt(2)))`. `computed:`

| sigma (frames) | 1-frame window | 2 | 3 (Ultimate short hop) | 5 (Aevalrena smash) | 6 (Ultimate fsmash normal) |
|---|---|---|---|---|---|
| 0.5 | 0.68 | 0.95 | 1.00 | 1.00 | 1.00 |
| 1.0 | 0.38 | 0.68 | 0.87 | 0.99 | 1.00 |
| 1.5 | 0.26 | 0.50 | 0.68 | 0.90 | 0.95 |
| 2.0 | 0.20 | 0.38 | 0.55 | 0.79 | 0.87 |
| 3.0 | 0.13 | 0.26 | 0.38 | 0.60 | 0.68 |

Two consequences. A 1-frame window is missed more often than hit for any sigma of 1 frame or more, so human-tier scripts should use 2 to 3 frame windows (direct codes, buffering) or accept high failure. And a level table can be derived from one number: choose a target success rate `p` on a reference window (the 3-frame short hop), then `sigma = (w/2) / z((1+p)/2)` where `z` is the normal quantile. `computed:` for `p` = 0.99, 0.95, 0.9, 0.8, 0.7, 0.5 on w = 3, sigma is 0.58, 0.77, 0.91, 1.17, 1.45, 2.22 frames. That keeps levels "fair and easy to derive": one knob per level, and the failure rate on every other window follows from the table.

### Mash rate

Measured and documented figures:

- Takahashi Meijin was clocked at 16 presses per second in the 1980s (filmed at 17), and at 12 to 12.3 per second in 2005 and 2008 (https://en.wikipedia.org/wiki/Takahashi_Meijin).
- SSBWiki says feasible human mashing registers an input every 3 or 4 frames (15 to 20 per second) when spinning the stick (https://www.ssbwiki.com/Button_mashing). The brief's 8 to 12 Hz for typical sustained mashing has no source I could fetch; `unverified:` that range.
- Ultimate's own limits: one input per frame, the same action's buttons register every 2 frames, and alternating between different actions registers every 3 frames (Button mashing page). That is a ceiling of 30 Hz or 20 Hz for any player.
- Nintendo's CPU ladder in Ultimate: levels 1 and 2 do not mash, level 3 presses every 12th to 13th frame, level 9 every 2nd to 3rd frame. In Melee the CPU attempts every third frame and succeeds about 15 percent of the time at level 1 and about 90 percent at level 9 (Button mashing page).

Aevalrena's grab hold is `60 + 0.5 * percent` frames. Each frame the timer drops by 1, plus `mashFrames` (4) for every distinct bit in `inputPressed` among the mash buttons (`src/sim/grab.ts`, `src/characters/common/grabkit.ts`). `computed:` frames to escape:

| Presses | Escape at 0 percent | Escape at 100 percent |
|---|---|---|
| none | 60 | 110 |
| every 12 frames (5 Hz) | 48 | 84 |
| every 6 frames (10 Hz) | 36 | 66 |
| every 4 frames (15 Hz) | 32 | 56 |
| every 3 frames (20 Hz) | 27 | 48 |
| every 2 frames (30 Hz) | 20 | 38 |
| every frame, 1 bit (60 Hz) | 12 | 22 |
| level 10 today: 4 bits every frame | 4 | 7 |

Level 10 mashes four bits per frame, so it leaves a grab in about 4 frames. Levels 1 to 9 press one fresh bit per frame with probability `0.1 + 0.9 * diQuality`, which at high quality is near 60 Hz. Both exceed what Ultimate's own input rules allow any player or CPU. A human holder reacting in 11 to 16 frames can never pummel or throw a level 10 CPU out of a grab. Recommendation: cap the mash for levels 1 to 9 at the ladder above (one bit per 12 frames at the bottom to one per 3 frames at the top) and cap the god tier at one bit every 2 frames. That is still faster than any measured human, keeps the escape at 20 frames at 0 percent, and leaves a holder who throws within about 11 frames a chance. The god tier needs no extra advantage here to feel unbeatable, and the sim itself has one loophole worth closing: `bitCount` credits every simultaneous bit, which a human on a keyboard cannot use.

### Dropped, wrong-direction and extra presses

Derive the error catalogue from real Smash accidents, not from noise, so mistakes look like ones a person makes (https://www.gamedeveloper.com/programming/intelligent-mistakes-how-to-incorporate-stupidity-into-your-ai-code, which argues against blunders no human would make):

- Drop: a press is skipped with probability `p_drop`; the executor notices after `notice` frames and repeats it. Melee's CPU-mash success rates (15 to 90 percent per attempt) are the only documented per-attempt success ladder.
- Wrong direction: only when a plan reverses a direction within about 8 frames of the last reversal (dash dance, pivots). Delay the reversal by 1 to 3 frames or skip it. A stick has to pass through neutral, so fast reversals are where humans fail.
- Extra press: an adjacent action bit on the same frame as an intended press. Allowed only through the accident policy below.
- Buffered leak: the human-only failure of pressing during hitstun or hitlag. Model as a press that lands in the buffer window before actionability.

The guard stage must know which accidents are intended. Keep two separate stages: the humanizer injects errors on purpose, at level-dependent rates; the guard enforces mechanical invariants (consistency, tap mirror, one press per frame) and an `accidentTolerance` per level. God is 0. Levels 1 to 3 may let a deliberate double tap through as a real roll.

### Consequences for specific skills

- Mash-out and pummel: the mash cap above; pummel is limited by the move itself (16 frames each, hit on frame 4), so the pummel cadence is not an input-rate matter.
- Ledge stall: drop, act at a fixed frame, regrab after the 12-frame cooldown; with jitter the drop frame varies and the CPU can fall too far to regrab. The stall gives 40 invulnerable frames for the first 3 grabs only.
- Short hop and jump-cancel: 3-frame windows, so a level with sigma 2 misses them 45 percent of the time (table). That is the intended feel of a weaker player.

### Seeded and deterministic humanizer

A sequential PRNG makes the result depend on call order. If the brain is skipped for a stall, resumed after a reload, or called twice in a resim, the stream shifts. Use a counter-based generator instead, where the nth value is a pure function of a key and a counter and needs no stored state (https://www.thesalmons.org/john/random123/papers/random123sc11.pdf). Key it on `(matchSeed, slot, inputFrame, stream, k)`:

```ts
function u01(seed: number, slot: number, frame: number, stream: number, k = 0): number {
  let h = (seed ^ Math.imul(slot + 1, 0x9e3779b1) ^ Math.imul(frame, 0x85ebca6b)
           ^ Math.imul(stream + 1, 0xc2b2ae35) ^ Math.imul(k + 1, 0x27d4eb2f)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
```

Gaussian by Box-Muller from two draws with `k = 0, 1`. `stream` names the purpose (jitter, drop, direction, mash, decision noise) so adding a new random use never perturbs the others. Aevalrena today draws from one shared `createRng(seed ^ 0x9e3779b9)` closure in `src/main.ts`, consumed in slot order; that is fine for host-only play and for replays of a whole match, but any change in call count shifts every later draw.

## Frame-perfect execution for the god tier

The god tier gets exactness from four properties the sim provides: it can read its own fighter exactly (`actionFrame`, `hitlag`, `onGround`), send direct codes so no flick can be misread, simulate candidate futures cheaply, and produce inputs with no jitter. What it should not do is add ad hoc "superhuman" behavior in scripts; put caps in one place, the executor (level 10's reaction floor, never a fresh shield while an opponent's startup is 0 or 1 frames old, is in `aevalmereInput`'s tail and should move there).

- Exact-frame scripts. Key on the fighter's own `actionFrame`, never on the opponent's delayed state. Multishine in libmelee does exactly this (action_frame 3 of knee bend). Jump-cancel up smash in Aevalrena is Jump on frame 0 and the usmash code on frame 1 (test `bg`); a 3-frame squat leaves frames 1 and 2 as the window.
- Follow-up on the last frame of hitlag. The buffer ages during hitlag, so schedule the next press at `hitlagEnd` (fresh press, fires on the first actionable frame) or up to 5 frames before it. Anything earlier expires.
- Instant reactions. The brief's 4-frame perception delay applies to the opponent. FightingICE keeps own actionability undelayed and delays only the world (`isControl`); do the same: own fighter exact, opponent perceived `R` frames ago and rolled forward.
- Perfect spacing. Ground movement in Aevalrena is digital (hold, Walk bit, release into a skid), so an exact stop is a search, not an analog release. For target x: for `k` in 0..K, clone the state, hold the direction for `k` frames, release, step until `vx` is 0, record final x, keep the `k` with least error. With K about 30 and about 30 frames each that is roughly 900 steps, `computed:` about 1.4 ms at 1.5 microseconds a step; run it once per approach, not per frame. In the air, alternate hold and neutral to trim drift the same way.
- Charge release. The charge lasts up to 60 frames and adds up to 40 percent damage, linearly (`1 + 0.4 * charge / 60`). Choose `n = clamp(T_target - now - startup, 0, 60)` so the first active frame lands on the opponent's committed frame, not a search. Hold the move's own charge key (its direction for direct-coded smashes) for `n` frames.
- Ledge. Aevalrena has no ledge trump: a ledge held by another fighter cannot be grabbed (`ledgeTaken` in `src/sim/ledge.ts`), which is edge-hogging, and SSBWiki notes Smash 4 and Ultimate removed it in favor of trumping (https://www.ssbwiki.com/Edgeguarding). The frame-critical action is taking the ledge first. After 3 regrabs the hang has no invulnerability.
- Things that do not exist here, so they cost nothing to plan: DI, SDI, perfect shield, hitstun cancel, wall jump.

Aevalrena: level 10's `safeDir` and levels 1 to 9's `guardTaps` implement the tap guard twice, differently. Merge them into the shared guard stage described below.

## Rollback and determinism

### How rollback engines treat a CPU

GGPO has no CPU concept. The game state must be decided solely by inputs; local inputs enter with `ggpo_add_local_input`, and during a rollback `ggpo_synchronize_inputs` replaces them with what was used before (https://github.com/pond3r/ggpo/blob/master/doc/DeveloperGuide.md). The guide's warnings apply to a brain: RNG state must be in the game state, wall-clock time must not enter it, and hidden static variables break rollback. It also says SyncTest, which rolls back one frame every frame and compares states, is the tool for finding leaks. Ikemen GO feeds AI presses through `AddLocalInput` in its test path (above), which is the "CPU as an input source" reading.

The other reading puts the AI inside the deterministic sim. Photon Quantum's Bot SDK describes deterministic AI implemented as part of the simulation (https://doc.photonengine.com/quantum/current/addons/bot-sdk/overview). Age of Empires ran a lockstep sim in which AI planning could swing turn time by as much as 200 ms and tagged commands to run two communication turns later (https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond). The article does not say where the AI ran; `unverified:` that it ran inside the simulation on every machine, which is what a synchronized sim implies. Gaffer on Games states that only inputs are sent and that determinism has to hold to the bit, and that cross-platform floating point is the hard part (https://gafferongames.com/post/deterministic_lockstep/).

### What the LAN layer does

- CPU slots belong to the lobby host's browser. It calls `cpuInput` once per frame and sends the result as an ordinary input, because the AI keeps state rollback cannot restore (`docs/LAN.md` section 5).
- `RollbackSession.tickOnce` calls `sampleLocal` before it saves and steps. It samples `frame = tick + inputDelay` with the live state, whose last consumed input is frame `tick - 1`, and skips sampling when a frame index was already sampled. So a resimulation never re-runs the brain, and a stall does not call it twice (`src/net/rollback.ts`).
- Peers predict a remote fighter by repeating its last `held` with no edges; each CPU press that arrives late causes a rollback of at most `MAX_PREDICTION` = 12 frames on the other peers. `computed:` at 1.5 microseconds per step that is well under a millisecond, so rollback cost is not the risk; visual correction is.
- Desync detection hashes the sim state every 60 frames (FNV-1a over frame, RNG, positions, velocities, percent, stocks, action and projectiles); brain memory is not in the hash and does not need to be, because inputs are authoritative (`src/net/hash.ts`). When the host leaves, its CPUs are retired through the KO path (LAN.md section 6).
- `docs/LAN.md` section 10 lists the cross-engine limit: `Math.sin` and `**` can differ between browser engines. The brain reads the game only through `stepGame`, so it inherits exactly that limit and adds none.

### Interaction with input delay

`sampleLocal` gives the CPU the same delay `d` as a human (1 frame by default on a LAN, clamped 1 to 4 by `autoDelay`). Two consequences:

1. The brain's view is `d` frames stale when its input is consumed. Scripts that key on observed state (`recoverStep`, `f.action === 'air'` checks) act on a fighter that has moved on. Fix: roll the own fighter forward `d` frames on a clone using the already-sampled own inputs and a repeated opponent input before deciding. That costs `d` steps, `computed:` under 10 microseconds.
2. `safeDir` reads `f.dirTapAge` from sim state, which cannot include inputs sampled but not yet consumed. A press decided at tick `t` shows up in `dirTapAge` from tick `t + d + 1`. At `d = 1` a release and re-press in the same direction is still seen, because two ticks pass; at `d >= 2` a re-press within `d` ticks would slip past and roll. `unverified:` not tested; plans that release and re-press one direction that fast are rare. Levels 1 to 9's `guardTaps` stores press frames from its own output and only compares differences, so it is delay-invariant. Use that design for every level.

A cheap way to spend the delay: `d` is already latency the human on the same peer pays, so define a level's reaction as the total from stimulus to consumed input, and perceive the opponent `R - d` frames back instead of `R` (never below 0). Then a level behaves the same offline and on a LAN. For `R = 4` and `d = 1` that is a 3-frame perception delay. A per-fighter `inputDelay` would also let the CPU use a larger `d` than humans to keep remote peers from mispredicting it; `RollbackSession` keeps a single `lastLocalFrame`, so that needs a net change (LAN.md section 8 item 4 applies).

### Decision delay for expensive searches

The brief's "fixed decision delay" trick is a design, not something I found in a source. The form that fits: the brain decides at tick `t` from the snapshot of frame `t - K` (cloned, so safe to hand to a Worker), the Worker returns a plan by tick `t`, and the input is applied at `t + d`. Total stimulus-to-action latency is `K + d`, so with `R = 4` and `d = 1` the search may take `K = 3` frames (50 ms) of wall time off the main thread. If the Worker is late, the executor falls back to plan continuation and reflexes for that frame. `computed:` one decision costs about `115 * m * H` steps for `m` reply models and horizon `H`; at `m = 3` and `H = 60` (both assumed) that is 20,700 steps, about 31 ms at 1.5 microseconds, so a decision does not fit in one 16.7 ms frame and the replan cadence of 3 frames is what makes level 10 affordable now.

### Recommendation

| Option | Host-only brain (current) | Brain on every peer |
|---|---|---|
| Cost per peer | One brain | Brain re-run on every rollback frame |
| Float determinism across engines | Not needed for the brain | Needed for the brain and for its search |
| State to save | None | Brain memory in `GameState`, hashed |
| Host leaves | CPUs retire (LAN.md) | CPUs survive |
| Test | Final hash equals offline replay of the relay log (`npm run test:net`) | Needs SyncTest with the brain in the loop |

Keep the host-only brain, as an input source. Concretely: (1) forward-roll the own fighter `d` frames; (2) move the tap mirror to output coordinates for every level, including level 10; (3) subtract `d` from perception delay; (4) seed the humanizer with the counter-based hash above; (5) add a determinism test that runs the same match seed twice offline and compares an FNV hash of each CPU's `(frame, held, pressed, direct)` stream, since the brain's hidden state is the thing GGPO's SyncTest would catch and nothing tests it today; (6) optionally move the search to a Worker with `K` frames of lead. If an all-peers design is ever needed, the brain's memory has to live in `GameState`, all randomness has to come from the counter hash, and level 10's module-level `memSlots` and localStorage profiles have to be removed from the decision path.

## Pseudocode

```ts
// Types
interface Intent { held: number; direct: number }            // desired this frame, before shaping
interface Plan {
  id: number; minFrames: number; flags: number;              // F_ATTACK | F_INTR | F_TAIL | F_RESUME ...
  legalIn(f: FighterView): boolean;                          // states the plan may run in
  script(t: number, self: FighterView, ctx: Ctx): Intent;    // reads own exact state
  iasaAt?(self: FighterView): number;                        // move frame where a new action may start
}
interface Reflex {
  priority: number;
  applies(v: View): boolean;
  intent(v: View): Intent;
  dropsPlan: boolean;
}

class Executor {
  plan: Plan | null = null; planT = 0; next: Plan | null = null;  // plan queue of depth 2
  mirror = new Mirror();                                          // tap timers in OUTPUT frame coordinates
  hum: Humanizer; guard: Guard;

  step(view: View, out: InputFrame): InputFrame {
    const f = view.own;                                           // exact, undelayed
    const inputFrame = view.frame + view.inputDelay;              // frame this input will be consumed at
    this.mirror.advance(inputFrame);

    // 1. Reflexes claim the frame first.
    let intent: Intent | null = null;
    for (const r of REFLEXES_BY_PRIORITY) {
      if (r.applies(view)) { intent = r.intent(view); if (r.dropsPlan) this.plan = null; break; }
    }

    // 2. Plan continuation, then decision.
    if (intent === null) {
      if (this.plan !== null && !this.plan.legalIn(f)) this.plan = null;
      if (this.needDecision(view)) {
        const p = this.decide(view.perceivedOpp, view.ownForwardRolled);  // R - d back, own fighter rolled d ahead
        if (p !== null) { this.plan = p; this.planT = 0; this.next = null; }
      }
      intent = this.plan ? this.plan.script(this.planT, f, view.ctx) : { held: 0, direct: 0 };
      if (this.plan && f.hitlag === 0) this.planT++;              // move-synced clocks skip hitlag
      // 2b. Pre-buffer the follow-up inside the buffer window.
      if (this.next && this.plan?.iasaAt) {
        const left = this.plan.iasaAt(f) - f.actionFrame;
        if (left <= this.hum.followLead(view) /* god: 0..1, human: 0..5, never > buffer */) {
          intent = merge(intent, this.next.script(0, f, view.ctx));
          this.plan = this.next; this.planT = 1; this.next = null;
        }
      }
    }

    // 3. Humanizer: turn intent edges into scheduled events with jitter, drops and errors.
    const shaped = this.hum.shape(intent, view, inputFrame);

    // 4. Guard: mechanical invariants. Runs after the humanizer, so human errors cannot
    //    produce an inconsistent frame, and accidents happen only when accidentTolerance allows.
    const safe = this.guard.apply(shaped, view, this.mirror, inputFrame);

    // 5. Emit. pressed and released are derived here and nowhere else.
    out.held = safe.held;
    out.pressed = safe.held & ~this.prevHeld;
    out.released = this.prevHeld & ~safe.held;
    out.direct = safe.direct;
    this.mirror.record(out, inputFrame);
    this.prevHeld = safe.held;
    return out;
  }
}

class Humanizer {
  events: { frame: number; bit: number; down: boolean }[] = [];   // ordered per bit
  shape(intent: Intent, v: View, inputFrame: number): Intent {
    // a) diff the intent against the last INTENDED state to find edges
    for (const e of edgesOf(intent, this.lastIntended)) {
      const dj = Math.round(this.p.sigma * gauss(v.seed, v.slot, inputFrame, S_JITTER, e.bit))
               + (e.reactionTriggered ? exGaussTail(v, inputFrame, e.bit) : 0);
      let at = inputFrame + Math.max(0, dj);                        // never earlier than the decision
      at = Math.max(at, this.lastEventFrame(e.bit) + 1);            // keep order, hold at least 1 frame
      if (e.down && u01(v.seed, v.slot, inputFrame, S_DROP, e.bit) < this.p.drop) { this.scheduleRetry(e, at, v); continue; }
      if (isDirectionFlip(e) && this.sinceLastFlip(e) <= 8 && u01(v.seed, v.slot, inputFrame, S_DIR, e.bit) < this.p.dirError)
        at += 1 + Math.floor(3 * u01(v.seed, v.slot, inputFrame, S_DIR, e.bit + 32));
      this.events.push({ frame: at, bit: e.bit, down: e.down });
    }
    this.lastIntended = intent;
    // b) apply events due now
    this.applyDue(inputFrame);
    // c) mash limiter: a fresh mash bit only if inputFrame - lastMashFrame >= this.p.mashPeriod
    //    and at most one bit per frame; alternate bits so each is a fresh press
    return this.currentIntent();
  }
}

class Guard {
  apply(i: Intent, v: View, m: Mirror, fr: number): Intent {
    let held = i.held, direct = i.direct;
    const rising = held & ~m.prevHeld;

    // a) tap mirror: the sim rolls on a 2nd press of the same direction within rollTapWindow
    //    (12), and spot dodges on a 2nd Down press. A same-frame TAP_CONSUMER starts an action first.
    if (!(rising & TAP_CONSUMERS)) {
      for (const bit of [Btn.Left, Btn.Right, Btn.Down]) {
        if ((rising & bit) && m.lastPress(bit) !== null && m.lastPressWasSameDir(bit)
            && fr - m.lastPress(bit) <= TUNING.input.rollTapWindow + this.slack
            && !(bit === Btn.Down && v.onSoftPlatform)) {
          held &= ~bit;                                            // wait; try again next frame
        }
      }
    }
    // b) one action press per frame, by fixed priority; a direct code owns the frame
    let act = (held & ~m.prevHeld) & ACTION_BUTTONS;
    if (direct !== 0) held &= ~act;
    else if (bitCount(act) > 1) held &= ~(act & ~topPriorityBit(act));
    // c) states where any press is poison: launched (only the planned tech press), hitlag/hitstun buffer
    if (v.own.launched) held &= ~(Btn.Shield | Btn.Dodge) | (v.techPress ? Btn.Shield : 0);
    // d) tilt must not read as a smash: no direct code, Attack rising, horizontal press younger than smashTapWindow
    if ((held & ~m.prevHeld & Btn.Attack) && direct === 0 && m.dirAge(fr) <= TUNING.input.smashTapWindow)
      held &= ~Btn.Attack;                                         // or add Btn.Walk
    // e) accident policy: a level may let an intended accident through
    return this.tolerance > 0 ? this.maybeLetThrough(held, direct, v, fr) : { held, direct };
  }
}
```

Notes on the pseudocode: `Mirror.record` stores press frames in input-frame coordinates (the frame the sim will consume the input), advances the same 12-frame and 5-frame counters `consumeInput` does, and never reads `dirTapAge` from the state. `ctx` carries `cDir`, `cHome` and stage info, as level 10's script context does today. Any exception inside `step` returns a neutral frame, the way SmashBot's main loop does.

## Open questions

- No measured sigma for Smash input timing was found, and the sustained human mash rate (the brief's 8 to 12 Hz) has no fetched source. Both could be measured from Slippi replays or from local playtests with `src/input`.
- Whether hits on a downed fighter re-bound it in Aevalrena (jab-lock viability) is unread; `src/sim/hits.ts` and `tech.ts` would answer it.
- `docs/SPEC.md` section 4.2 and `locomotion` disagree on how a dash starts. The code was taken as correct here; the doc should be fixed or the code changed.
- The `safeDir` staleness at `d >= 2` is a reading of the code, not a test result. `npm run test:net` with `inputDelay` 2 to 4 and a level 10 CPU dash-dancing near a ledge would confirm or clear it.
- Whether a cap on mash rate for the god tier is wanted is the owner's decision; the tables give the escape times for each choice.
- Rivals' CPU input write path and MUGEN's command time and buffer time defaults were not obtainable from the pages fetched.

## Sources

Fetched means the page or file text was retrieved and read, either raw or through the fetch tool's summary. No source below is a search snippet.

- https://github.com/altf4/libmelee/blob/master/melee/controller.py : controller state, press and flush semantics, byte quantization. Fetched raw.
- https://github.com/altf4/libmelee/blob/master/melee/techskill.py : multishine on action_frame 3, upsmash via C stick, latency test. Fetched raw.
- https://libmelee.readthedocs.io/en/latest/controller.html : queued inputs and flush. Fetched.
- https://github.com/altf4/SmashBot/blob/master/Chains/chain.py : Chain base class, `interruptible`, `step`. Fetched raw.
- https://github.com/altf4/SmashBot/blob/master/Chains/wavedash.py : wavedash chain, stick 0.35 angle, one-frame press. Fetched raw.
- https://github.com/altf4/SmashBot/blob/master/Chains/smashattack.py : jump-cancel smash, charge counter, full deflection. Fetched raw.
- https://github.com/altf4/SmashBot/blob/master/Chains/tilt.py : tilt by 0.65 and 0.35 deflection. Fetched raw.
- https://github.com/altf4/SmashBot/blob/master/Chains/dashdance.py : accidental-roll guards. Fetched raw.
- https://github.com/altf4/SmashBot/blob/master/Chains/powershield.py : one-frame press, hold logic. Fetched raw.
- https://github.com/altf4/SmashBot/blob/master/Chains/edgestall.py : one-frame C-stick drop. Fetched raw.
- https://github.com/altf4/SmashBot/blob/master/Tactics/tactic.py : chain reuse and `isinteruptible`. Fetched raw.
- https://github.com/altf4/SmashBot/blob/master/Strategies/bait.py : interruptibility gate, lag-state comment. Fetched raw.
- https://github.com/altf4/SmashBot/blob/master/esagent.py : 40-frame tech lockout mirror. Fetched raw.
- https://github.com/altf4/SmashBot/blob/master/smashbot.py : neutral input on exception. Fetched raw.
- https://github.com/TeamFightingICE/FightingICE/blob/master/src/struct/Key.java : seven-boolean Key. Fetched raw.
- https://github.com/TeamFightingICE/FightingICE/blob/master/src/aiinterface/CommandCenter.java : action-to-key FIFO, DASH as 6 5 6. Fetched raw.
- https://github.com/TeamFightingICE/FightingICE/blob/master/src/aiinterface/AIController.java : DELAY = 15. Fetched raw.
- https://github.com/TeamFightingICE/FightingICE/blob/master/src/aiinterface/AIInterface.java : undelayed `isControl`. Fetched raw.
- https://www.elecbyte.com/mugendocs/trigger.html : AILevel 1 to 8, Random 0 to 999. Fetched. The CMD and CNS pages returned 403 or lacked the AI content.
- https://github.com/ikemen-engine/Ikemen-GO/blob/master/src/input.go : AI button jamming formula, command defaults. Fetched raw.
- https://github.com/ikemen-engine/Ikemen-GO/blob/master/src/rollback.go : AI inputs via AddLocalInput, checksum includes RNG seed. Fetched raw.
- https://www.rivalsofaether.com/workshop/scripts/ : ai_update.gml description. Fetched.
- https://www.rivalsofaether.com/workshop/player-variables/ : input and AI variables. Fetched.
- https://www.rivalsofaether.com/workshop/input-names/ : `_pressed` 6-frame look-back, `_strong`. Fetched.
- https://www.rivalsofaether.com/workshop/functions/ : `clear_button_buffer`. Fetched; argument detail absent.
- https://arxiv.org/abs/1702.06230 : Phillip. Read through https://ar5iv.labs.arxiv.org/html/1702.06230 (fetched): 54 actions, 30 Hz, 2-frame reaction, delay experiments.
- https://www.ssbwiki.com/Buffer : buffer windows by game, Ultimate 9 frames. Fetched (raw wikitext).
- https://smashboards.com/threads/ultimate-buffering-system.465269/ : priority order, hold-buffering. Fetched (summary).
- https://www.ssbwiki.com/Control_stick : Ultimate flick windows by sensitivity. Fetched.
- https://www.ssbwiki.com/Tap : tap definitions, C-stick macro, tap jump accidents. Fetched.
- https://www.ssbwiki.com/Tilt_attack : tilt definition. Fetched.
- https://www.ssbwiki.com/Jump : Ultimate 3-frame jump squat. Fetched.
- https://www.ssbwiki.com/Short_hop : short hop windows, Ultimate additions. Fetched.
- https://www.ssbwiki.com/Dash and https://www.ssbwiki.com/Dashdance : initial dash, 6-frame reversal window, Melee roll-on-dash. Fetched.
- https://www.ssbwiki.com/Roll : roll input. Fetched.
- https://www.ssbwiki.com/Tech : tech window and 40-frame lockout by game. Fetched.
- https://www.ssbwiki.com/Button_mashing : feasible mash rates, input cooldown rules, CPU mash ladder. Fetched.
- https://www.ssbwiki.com/Interruptibility : IASA and buffer relation. Fetched.
- https://www.ssbwiki.com/Lock : jab lock rules by game. Fetched.
- https://www.ssbwiki.com/Edgeguarding : ledge trumping. Fetched.
- https://en.wikipedia.org/wiki/Takahashi_Meijin : 16 to 17 presses per second, later 12 to 12.3. Fetched (raw wikitext).
- https://en.wikipedia.org/wiki/Reaction_time : 190 ms visual figure. Fetched.
- https://en.wikipedia.org/wiki/Exponentially_modified_Gaussian_distribution : ex-Gaussian parameters. Fetched.
- https://ki.infil.net/reaction.html : 265 ms known-stimulus figure, input complexity. Fetched.
- https://www.gamedeveloper.com/programming/intelligent-mistakes-how-to-incorporate-stupidity-into-your-ai-code : believable mistakes. Fetched.
- https://www.thesalmons.org/john/random123/papers/random123sc11.pdf : counter-based generators. Fetched (summary).
- https://github.com/pond3r/ggpo/blob/master/doc/DeveloperGuide.md : input synchronization, determinism, SyncTest. Fetched raw.
- https://gafferongames.com/post/deterministic_lockstep/ : inputs-only, bit-level determinism. Fetched.
- https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond : two-turn command delay, AI turn-time swings. Fetched (summary).
- https://doc.photonengine.com/quantum/current/addons/bot-sdk/overview : deterministic AI inside the simulation. Fetched (overview only).
- https://github.com/aevalmere/aevalrena : `docs/LAN.md`, `docs/SPEC.md`, `docs/CPU_AEVALMERE.md`, `src/core/constants.ts`, `src/core/types.ts`, `src/core/rng.ts`, `src/sim/input.ts`, `src/sim/actions.ts`, `src/sim/grab.ts`, `src/sim/tech.ts`, `src/sim/ledge.ts`, `src/sim/selftest.ts`, `src/net/rollback.ts`, `src/net/hash.ts`, `src/net/inputs.ts`, `src/ai/aevalmere.ts`, `src/ai/index.ts`, `src/main.ts`, `src/characters/common/grabkit.ts`. Read from the local copy.
