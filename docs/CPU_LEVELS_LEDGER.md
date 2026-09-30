# CPU levels ledger (human tiers, UI 1 to 9)

Loop against `npx --yes tsx src/ai/aitest.ts` after src/ai/index.ts routed UI levels 1 to 9 to the
search engine (src/ai/brain.ts, spec from src/ai/levels.ts specForUiLevel). One root cause per
failing test, found in the engine, never in the test; no aitest threshold was lowered. Every row
names the file changed and the result on the test and its neighbours.

Iteration: a subset runner (a scratch copy of aitest.ts that runs named tests, not committed) ran each failing test and the tests that share its data (the matrix tests a, b, c, e, m, o, r,
t; the stacked sweep g, h, i). Full runs of the real aitest.ts after each batch.

Gates at the end: `npm run typecheck` pass, `npm run test:sim` 128/128, `npm run test:net` PASS,
every src/ai/eval/unit/*.ts pass, fast tier 12/14 gated (ba and bf fail as they did before this
work, both improved; see the end).

## Before

aitest 27/44. Failing, in scope: a, b, d, e, g, h, i, o, r, v, y, ag, am. Failing, god only (out of
scope, aevalmere.ts or its data): al, an, ap, aq.

## Loops

| # | test | root cause | fix | result |
|---|---|---|---|---|
| 1 | a, b | UI 1 (s = 0) had stepBudget 0, so every decision was static evaluation: every candidate got the same outcome score and the pick was a softmax over plan bonuses, uniform in practice. A casual dithered between approaches and retreats and a mirror went 20,000 frames without a KO. | levels.ts STEP_BUDGET casual knot 0 -> 240 (about one 24-frame sample per plan of a 4-plan menu). Deviation from 03's "0 (static evaluation)", noted in the knot's comment. | a PASS (KO at 6,860 f); b PASS (0 unfinished, L1 mirror avg 20,980 -> 19,823 f) |
| 2 | d | A ledge hanger is hit only by hitsLedge moves (sim/hits.ts). The ground attack families offered jab and ftilt at the hanger, which pass through it; the ledge traps that know hitsLedge are L3 vocabulary. | plans/neutral.ts groundAttackFamily: against a hanger, only hitsLedge moves (dtilt, dsmash), walked to the lip, as `<move>Ledge` plans in their own family (tilt, smash), ranked with the punishes; main stage only (not from a soft platform). | d PASS (p2 max 6 to 24 %) |
| 3 | d (regression after 7) | goFire fired a ground-only move after the walk carried the fighter off a platform: its code became a dair off the stage and the CPU died. | goFire never fires a groundOnly move in the air. brain.ts: leaving the ground under a plan decided on the ground ends its hold. | d PASS, cpuDied false |
| 4 | y | The tech reflex kept `launched` and `techArmed` from the previous launch when a new hit arrived before the fighter was ever free (consecutive launches): the armed flag re-claimed the frame with no press, so the new landing was never teched. | reflexes.ts: a rise in hitstun is a fresh launch (re-arms, restarts the reaction clock). | y PASS: L9 3/36 (8 %) -> 28/36 (78 %), L1 0 % |
| 5 | v | Two defects. (a) A grab of a shielding target scored about 0: the rollout window ends while we still hold the grab, before the throw, so the payoff was never counted. (b) The passive grab route walked to its spot, overshot, turned and walked back forever next to the shield. (c) The input-rate cap dropped a refused press for good; a script presses once, so a refused grab never came back. | search/outcome.ts: a hold still running at the window end credits the best throw's damage. plans/passive.ts routeFn: a grab route counts as arrived up to 24 px nearer the victim (grab routes only). executor.ts: a refused action press waits for the next token (up to 24 frames) instead of being lost. | v PASS: seed 23 no grab -> 166 to 196 f; seeds 5, 17 131 to 211 f |
| 6 | g, i | Pinned harness opponent in the air: the landing traps and the rollouts let it fall under gravity, so the CPU waited under it for a landing that never came (132 f stalls). | plans/advantage.ts suspendedInAir (raw delayed snapshot: airborne, vx = vy = 0): no landing traps, no landing grab route. search/rollout.ts: such an enemy is held where it was seen until something hits it. | g 91/120 -> 120/120; i PASS (longest no-progress 54 to 87 f) |
| 7 | d, general | A committing plan was re-decided on every free frame after its minFrames (2), so a walk-in-then-fire plan was re-chosen each frame of the approach; at human temperature it swapped every few frames and rarely arrived to fire. | brain.ts needDecision: human tiers hold a committing plan for their planHold (03 2.3) unless it has spent them (busy then free) or they left the ground. God unchanged. | d stable; no aitest regression |
| 8 | e | Nothing in the engine spaced aerials; the harness requires 45 frames between aerial starts at every human level. | executor.ts: human tiers only, no aerial starts within 47 frames of the last (air Attack and C-stick presses and aerial codes held back), applied after the rate cap so a deferred press obeys it too. brain.ts dropRhythm: aerial plans that would fire inside the gap are not offered. | e PASS (1,713 aerial starts, all spaced) |
| 9 | r | Short hops at UI 1 and 2 came from accidents: the humanizer delayed a jump press but not its release (a 5-frame full hop came out as 2 frames), the rate cap refused jump presses, and plan switches in the squat released Jump. | humanizer.ts: a held-back button shifts its whole span (press and release). executor.ts: below the vocabulary that has short hop aerials (03: L2), a jump already held is kept through the squat. | r PASS: L1-2 1.96 -> 0.03 per 1k frames, L9 2.45 |
| 10 | h | Airborne CPU above a standing target: (a) no aerial plan fell onto it (they swung at once, in the air above); (b) the landing family's 11 escape plans (priority 60 to 76) crowded aerials out of the 25-plan prefilter; (c) the rate cap's burst of 2 was spent on the drift and fast-fall presses, so the aerial press waited out its window; (d) the aerial rhythm swallowed an aerial the plan then idled on. | plans/neutral.ts dropAerial plans (drift over, fast fall, fire timed on the gap, payoffAt for human tiers), ranked with punishes. executor.ts RATE_BURST 2 -> 4 (sustained rate unchanged, executor unit window checks pass). dropRhythm (loop 8). | h 82/120 -> 103/120. Still failing: in the first 240 frames the decision budget is capped at 600 steps (tempo.ts ramp), about 24 steps per candidate, too few to see a drop's payoff from 90 px up. With the ramp at 60 frames h reached 113/120 and 117/120 at 30, but x fell under its 25 % floor (24.3 %); the ramp stays at 240. |
| 11 | o | Ledge attacks at L9 ride on a handful of events: 21 to 27 L9 hangs over the matrix, the ledge attack option chosen 0 or 1 times (climb at the invulnerability end dominates). Passed on two intermediate full runs (the counts moved with other loops), 2 on the last. | Checked the aerial rhythm (loop 8) first: its Attack hold-back also covered a hang; limited to 'air' and the jump squat (no change in the count). Tried marking ledge options PF_STALE so the tempo's staleness cost mixes them: 0 ledge attacks still, reverted. | o FAIL (ledgeatk 2 against 3; baseline 2) |
| 12 | ag | The Aeval god's self-destruct was in the god's own play (aevalmere.ts, not editable here); the lead's reading that UI 1 plays too safe did not hold (the test counts level 10 SDs only). | none in scope; the matches' course changed with loops 1 to 10. | ag PASS on the last two full runs (sd 0 on every opponent) |
| 13 | am | The god loses stocks to UI 9: 3 of 20 matches' worth on tidegate with the loop 10 code, and UI 8 (s = 0.875) takes the same 3 per stage, so it is not the UI 9 point on the curve. | none kept. Lowering UI 9's s or weakening it would break c's margins and 03's world's best row; the fix belongs to the god. | am FAIL (tidegate 9/10 won, 2 lost; hearthmoor 4 lost; sd 0) |
| 14 | ladder | UI 1 and 2 mirrors sat at 150 to 250 % for 7,200 frames: casual vocabulary had no smash, so nothing launched far enough to KO. 03's L1 list omits smashes while its percent-knowledge line says L1 and L2 "throw kill moves when a smash is available". | levels.ts: 'smash' (uncharged) moved from the L2 additions to casual vocabulary; charged smashes stay at L3. | L1 mirror avg 19,823 -> 8,808 f; L2 mirror 16,612 -> 11,416 f; still passive at about one hit per 200 frames each, mirrors at 7,200 f mostly still unfinished |
| 15 | x (regression) | x fell to 24.3 % with the opening ramp shortened to 60 frames (loop 10 attempt). | tempo.ts ramp back to 240 frames. | x PASS (28.2 %) |
| 16 | q (regression) | L9 platform drops fell to 8 in one full run (floor 10): a platform drop scored as a walk and rarely won. | plans/neutral.ts: a drop toward a target below ranks and scores as an approach (+3 points). | q PASS on the last run |
| 17 | eval unit | evalbase's shieldOnly check measured shield frames over all live frames; a UI 5 that breaks the shield (the adversary's documented weakness) pushed it to 0.48. | eval/unit/evalbase.ts: the adversary's shield share over the frames it chose its own action in (not broken, hit, grabbed, down or dead); floor 0.5 unchanged (0.97). | unit PASS |
| 18 | eval perf.4p | The drop aerials' payoffAt stretched the god's rollout windows: three gods on four fighters went from 26 to 37 ms summed p99. | payoffAt on drop aerials for human tiers only. | perf.4p PASS (31.6 / 29.6 ms) |
| 19 | eval bf | God (engine) vs a stationary dummy knocked onto the ledge: 2,625 frames without a hit. (a) The passive tracker never samples a hang, so a hanger kept its old 'none' kind and the ledge routes were never offered. (b) The route's spike hop was replanned in the air, where the route family does not generate, and never fired. (c) After the KO, plans aimed "toward" the dead target's x past the blast zone and the god air-dodged off the stage. | plans/passive.ts: a hang held 90 frames with no attack is 'stationary'. brain.ts: an airborne passive route runs on. plans/script.ts preparePlanCtx: a dead or respawning target is not a direction (stage centre instead). | bf stationary gap 2,625 -> 218 f (gate 240); shieldOnly first engagement 248 -> 162 f (gate 120, still failing, as before this work) |

Determinism: bb, bb.order and aitest n, ah, as pass after every batch.

## After

aitest 37/44 (last full run). In scope and failing: h (101/120; 82 before), o (ledgeatk 2, as
before). God only and failing, unchanged: al, am, an, ap, aq. Newly passing: a, b, d, e, g, i, r,
v, y, ag. Matrix: L1 mirror avg 20,980 -> 8,808 f, L2 mirror 14,216 -> 10,848 f, every matrix
match finished, c's margins kept (L9 > L1 +20, L9 > L5 +16, L5 > L1 +19, L7 > L3 +20).

Fast tier: 12/14 gated. unit, aitest.fast, bb, bb.order, bh, perf, perf.4p (32.7 / 30.4 ms), al,
bd, bc, team.mate pass; ba (god median 3-stock 2,095 before this work, 1,838 now, against 1,200)
and bf (above) fail as before this work.

## Open

- h: the opening ramp. A per-decision budget floor for the first decisions of a match, or a smaller
  prefilter while falling, would let the drop aerial's payoff be seen without the ramp change that
  cost x.
- am: god work (aevalmere.ts). UI 8 and UI 9 both take about 3 stocks from the god per 20 matches.
- Ladder passivity at UI 1 to 4: under one hit per 200 frames per side. A casual with K = 1 sample
  per plan values plans by the single most likely reply; a risk-weight scaled by skill made no
  difference (K = 1 makes CVaR equal the mean) and was reverted.
