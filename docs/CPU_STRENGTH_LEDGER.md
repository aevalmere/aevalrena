# CPU strength ledger (god refinement loop)

Build, measure, fix loop on the new engine's god (src/ai/brain.ts, UI level 10). One root cause per
loop; a change is kept only when (a) or (b) improves without (c) or determinism regressing.

Diagnostic: `npx --yes tsx src/ai/eval/diag/strength.ts` (defaults: --h2h 22 --v3 20 --v3stocks 3
--dummy 4 --procs 11). Seeds are fixed (pool.ts seedFor tags diagh2h, diag1v3|s3, diagdummy), so
every row below plays the same matches.

- (a) new god vs legacy god (aevalmere.ts), 22 paired matches, 3 stocks: new god wins.
- (b) new god alone vs three teamed new-engine UI 4 CPUs, 20 matches, 3 stocks (the god tier's
  stock count): god wins.
- (c) new god vs the stationary dummy, 4 matches: median 3-stock frame (lower is better).
- (d) the god's deaths: percent at the KO, the last hit's move and the god's state on the frame
  before it, the opener of the string, SDs (no hit in the 240 frames before the KO) with the plan
  running; conversion percent is the enemy's percent at the god's KOs.
- det: h2h match 0 is played twice in different processes; the input hashes must match.

Stop: (a) at least 14/22 and (b) at least 16/20, or 8 loops, or two loops in a row without a gain.

## Loop 0: baseline

| metric | value |
|---|---|
| (a) h2h | 3/22 (stocks lost new/legacy 63/35) |
| (b) 1v3 UI4 | 7/20 (lb 0.181), god stocks lost 53, dealt/taken 23613/10095 |
| (c) dummy | median 2546.5 |
| det | MATCH |
| (d) h2h | 63 deaths, median 156%; conversion 151% |
| | by move: uspecial 49, dair 7, uair 3, utilt 2, sd 1, usmash 1 |
| | by state: stun 33, air 10, air-active 9, air-startup 5, helpless 2 |
| (d) 1v3 | 53 deaths, median 166%; conversion 159% |
| | by move: usmash 18, sd 14, fsmash 6, uair 4, utilt 4, ftilt 2 |

Wall 169 s.

Reading: 49 of 63 h2h deaths are the legacy god's up special, 24 of 53 1v3 deaths are smashes.
The rollouts' opponent model never throws either: model/replies.ts `kitOf` leaves chargeable moves
(every smash) and recovery-tagged moves (up special) out of the ATK reply's ground and anti-air
lists, and ATK takes the fastest move in reach. So a plan that lands in front of a smash or under
an up special scores as safe. The second cause is SDs in the 1v3 (14 of 53).

## Loop 1: ATK reply throws the real punish (REVERTED)

Change: model/replies.ts `attackStep` first ran a one-step lookahead punish over every damaging
move in the replier's kit (smashes uncharged and the up special included): forecast the CPU to
each move's first active frame, keep the moves whose reach box covers its hurtbox, pick a kill at
the CPU's percent, then damage, then speed.

| metric | before | after |
|---|---|---|
| (a) h2h | 3/22 | 2/22 |
| (b) 1v3 UI4 | 7/20 | 6/20 |
| (c) dummy | 2546.5 | 2208 |
| det | MATCH | MATCH |
| (d) h2h deaths by uspecial | 49/63 | 43/64 |

Reverted: neither (a) nor (b) improved. Why it could not help: a trace of h2h match 0
(scratch trace of every decision before the first KO) shows the top five candidates with equal
value and cvar equal to mean, i.e. one sample each. Counted over one h2h match (844 god
decisions): samples per candidate K = 1 in 210, 2 in 391, 3 in 123, 4 or more in 120, against a
mean of 9.1 reply cells; mean budget 1,433 steps (routine decisions get half), 10 to 25
candidates, window 24 or 45. With one or two samples the CVaR is the mean of the heaviest reply
(hold or attack-with-a-jab), so no reply model, better or worse, reaches the choice. The punish
reply is kept on file to retry once the search samples the reply set.

## Loop 2: the god screens, then verifies (kept at 20 matches, reverted after the 73-match check)

Root cause: one or two samples per candidate (loop 1 counts). Change: search/rollout.ts, god only
(lower tiers keep their calibrated search bit for bit): phase 1 screens every candidate on the
first K cells from SCREEN_SHARE 0.45 of the budget (K at least 1); phase 2 gives the SCREEN_KEEP 4
best by phase-1 value (plans that lose the stock last; the best passive route plan is kept as a
fifth, because brain.ts reads that family after selection) the further cells the rest of the
budget pays for, and only those go to selection, since values from fewer samples do not compare.
Secondary enemies' reply draws use a golden-ratio sequence so any prefix of the samples follows
their weights (god only). Measured on one h2h match: K now 3 in 241 and 6 in 327 of 689
decisions (was 1 or 2 in 601 of 844).

| metric | before (loop 0) | first try | kept (passive route kept) |
|---|---|---|---|
| (a) h2h | 3/22 (63/35 stocks) | 5/22 (61/39) | 0/22 (66/33) |
| (b) 1v3 UI4 | 7/20 | 4/20 | 8/20 (lb 0.219) |
| (c) dummy | 2546.5 | 2575 (one match 7200) | 2538 |
| det | MATCH | MATCH | MATCH |

The first try dropped the passive route plans in phase 2 and the dummy stopped finishing one match
(7200), so the route plan is kept as a survivor. Kept under the rule ((b) up, (c) not worse,
determinism kept), with a caveat: the stock ratio against the legacy god did not move (63/35,
61/39, 66/33), so the h2h swing from 5 to 0 wins is match-to-match chaos on close games, and the
1v3 moves are inside the noise of 20 matches (one standard deviation is about 2 wins).

## Loop 3: replies act on the hidden frames (delay-window replay; reverted after the 73-match check)

Root cause: the god sees the others 4 frames late (levels.ts GOD_PERCEPTION_AGE); perception rolls
them forward holding their inputs and the hypothesis set keeps "nothing new" plus one option, so a
reply in a rollout started its move at t = 0 of the rollout, up to 4 frames after the real
opponent could have. Traced in h2h match 0: most openers were trades the god thought it won
("me was attack": airuspecial valued 248 into a fair already swinging, fhnair into an active nair).
The legacy god replays the hidden frames with the reply acting and its own inputs, then puts its
true fighter back. Change (god only, no own-input delay): brain.ts keeps its last 8 outputs and
arms search/rollout.ts `setDelayReplay` for the first ply; every rollout then starts at the
observation, the sample's replies act on the hidden frames, our fighter replays what it sent, and
our real fighter is pasted back; hypothesis states are skipped (the replies cover those frames)
and the budget counts the replayed steps.

| metric | loop 2 | loop 3 |
|---|---|---|
| (a) h2h | 0/22 (66/33) | 4/22 (60/30) |
| (b) 1v3 UI4 | 8/20 | 9/20 (lb 0.258), god stocks lost 48 (was 52) |
| (c) dummy | 2538 | 3179 (one match 7200) |
| det | MATCH | MATCH |

(c) regressed: in dummy match 3 the god stood on a platform over the dummy re-choosing a route
grab that had fired once and whiffed (5,000 frames). That is a latent defect the new path ran into,
fixed in loop 4; loop 3 is judged together with it.

## Loop 4: the god stalls against a passive target (kept with loop 3 at 20 matches, reverted after the 73-match check)

Root causes found in the dummy stalls, one defect family (routes that cannot finish):
1. plans/passive.ts routes walk the main stage to a stop x, but were offered with the god on a
   platform (route grab whiffed over the dummy's head; later a ledge spike route re-chosen for
   2,000 frames). Routes now need the god on the main floor, and the standing grab needs the
   target's floor (SAME_FLOOR 4 px).
2. A fired route that whiffed stayed "running" (the brain keeps an interruptible plan it chooses
   again) and pressed nothing more: it now re-arms once the god is free again.
3. The ledge reply set ignored passivity (the sim has no hang limit), so a climb trap waited on a
   hanger that never climbs: a passive hanger is now read as one that keeps hanging (model/
   replies.ts fixedSet, the same passivity blend neutral uses).

| metric | loop 2 (last kept) | loop 3 | loop 3 + 4 |
|---|---|---|---|
| (a) h2h | 0/22 (66/33) | 4/22 (60/30) | 3/22 (62/27) |
| (b) 1v3 UI4 | 8/20 | 9/20 | 5/20 (lb 0.112), god stocks lost 52 |
| (c) dummy | 2538 | 3179 (7200) | 2139 (2418 1649 1860 2612) |
| det | MATCH | MATCH | MATCH |

Kept against loop 2 by the rule ((a) up, (c) better, determinism kept). The 1v3 fell from 9 to 5
between loop 3 and loop 4 although loop 4 only touches passive targets: passive.ts and the ledge
replies serve the UI 4 CPUs too, so their play (and every 1v3 trajectory) changed. SDs in the 1v3
rose to 12 of 52 deaths; a traced one was an offstage orb with no jumps left, a late up special
and a footstool by a UI 4 (a footstool is not a hit event, so it counts as an SD here).

## Loop 5: the god's ATK reply throws the real punish (loop 1 retried; kept at 20 matches, reverted after the 73-match check)

Root cause unchanged from loop 1 (smashes and the up special missing from the ATK reply; the
largest killers: up special 47 of 62 h2h deaths, up smash plus forward smash 20 of 52 in the
1v3), now that loops 2 and 3 let replies reach the choice. Same one-step lookahead punish as
loop 1, built only into the god's reply sets (Reply.punish, set from the view's level), so the
UI 4 CPUs of the 1v3 keep their calibrated models.

| metric | loop 4 | loop 5 |
|---|---|---|
| (a) h2h | 3/22 (62/27) | 4/22 (62/35) |
| (b) 1v3 UI4 | 5/20 | 5/20, god stocks lost 53 |
| (c) dummy | 2139 | 2139 |
| det | MATCH | MATCH |

Kept: (a) up, the legacy god lost 35 stocks instead of 27, (c) and determinism unchanged; up
special deaths in the h2h fell from 47 to 39. In the 1v3 SDs rose to 15 of 53, 8 of them with the
plan "wait": traced, the god chose an attacking up special far off the stage (x 500 against a
ledge at 248) and fell helpless, every recovery already a certain loss.

## Loop 6: recovery judged past the neutral window (REVERTED)

Root cause from the SD traces and the lead's note: the 24-frame neutral window ends long before a
recovery (or any late payoff) is decided. Change: brain.ts used a 60-frame window whenever our
fighter was off the stage; search/rollout.ts learned an optional PlanInstance.payoffAt (contracts.ts)
that stretches the window to the payoff plus PAYOFF_SLACK 6, at most WINDOW_MAX 60, while the budget
pays one sample per candidate.

| metric | loop 5 | loop 6 |
|---|---|---|
| (a) h2h | 4/22 (62/35) | 4/22 (62/34) |
| (b) 1v3 UI4 | 5/20 | 4/20, god stocks lost 56 |
| (c) dummy | 2139 | 2139 |
| det | MATCH | MATCH |

Reverted the offstage window (SDs 15 to 10, but more helpless deaths and no gain in (a) or
(b)). The payoffAt hint stays: no plan sets it yet, so it changes nothing measured here; it is
the hook the character plan packs asked for (the Trekmore recall route pays off near frame 60).

## Loop 7: jumps judged at the landing (REVERTED)

Root cause: Aeval's full hop lasts about 70 frames and a short hop about 40 (gravity 0.15, jump
5.4, short hop 3.5), so the 24-frame neutral window scores every jump at its apex; 30 of 62 h2h
openers hit the god airborne. Change (god only): a rollout whose window ends with our fighter
airborne ran on until it landed, up to 60 frames, phase 2 sizing its samples from the cost phase 1
measured.

| metric | loop 5 | loop 7 |
|---|---|---|
| (a) h2h | 4/22 (62/35) | 0/22 (66/21) |
| (b) 1v3 UI4 | 5/20 | 4/20 |
| (c) dummy | 2139 | 1843.5 |
| det | MATCH | MATCH |

Reverted: (a) and (b) worse. Loops 6 and 7 are two failed loops in a row: stop.

## Gates on the loop 5 state, and the 73-match check that overturned it

- perf failed: god p99 21 ms (gate 12). Profiled: the punishing replies (loop 5) took the god to
  kill range (45-frame window) and edge-guard spots more often, where a routine decision ran the
  window plus the edge-guard generators (plans/edge.ts stepAllowance, 4 x budget per family) at
  15 to 25 ms. A god-only routine generator factor of 0.05 brought it to 11.2 to 11.6 ms.
- unit search.ts expected all 20 candidates scored; the two-phase search verifies 4 or 5.
- bd (lower tiers) found one SD for a defensive L4 after loop 4, whose route and ledge edits also
  served lower tiers; gating them to the god restored bd (0 SDs).

With those fixed, the kept state played the god-tier gate itself: team.1v3.l4 seeds (cases/teams.ts
tag), 73 matches, 3 stocks, in parallel with `--only v3 --v3 73 --gate`. The loop 0 code, rebuilt
in a copy from snapshots, played the same seeds:

| 1v3 UI4, 73 matches | gate seeds | second seed set (diag tag) |
|---|---|---|
| loop 0 (baseline) | 37/73 (lb 0.395) | 28/73 (lb 0.281) |
| kept state (loops 2, 3, 4, 5 and the perf factor) | 25/73 (lb 0.244) | 25/73 (lb 0.244) |
| kept state without the two-phase search | 27/73 | |
| kept state without the replay | 33/73 | |
| kept state without the replay and the punish reply | 24/73 | |
| loop 0 plus the punish reply only | 29/73 | |
| loop 0 plus the loop 4 stall fixes only | 27/73 | |

Reading: the 20-match diagnostic cannot see effects of this size. Loop 0's 37 on the gate seeds
is high against its own 28 on the second set and against every variant (24 to 33), and each
change reshuffles every match, so single variants are not separable. Pooled over both seed sets
the kept state won 50/146 against loop 0's 65/146, and the h2h did not move (3/22 at 63/35 stocks
before, 4/22 at 62/35 after). No change reached the keep rule at the sample size the owner gate
uses, so every behavior change was reverted and the code plays exactly as loop 0 (the diagnostic
reproduces loop 0 bit for bit: 3/22, 7/20, 2546.5, same stocks and deaths; gate seeds 37/73).

## Final state

Kept: the diagnostic (src/ai/eval/diag/strength.ts, with `--gate` for the team.1v3.l4 seeds), this
ledger, the inert PlanInstance.payoffAt hook in contracts.ts and search/rollout.ts (no Aeval plan
sets it; it is for the character packs), and brain.ts importing ./characters/index so the packs
register.

| metric | value |
|---|---|
| (a) h2h | 3/22 |
| (b) 1v3 UI4, 20 | 7/20 |
| (b) 1v3 UI4, god tier seeds, 73 | 37/73, Wilson lb 0.395 (gate 0.90) |
| (c) dummy | 2546.5 |
| det | MATCH |
| fast tier | 12/14 gated pass: unit, bb, bb.order, perf (god p99 7.2 / 9.4 ms), perf.4p, bd pass; ba and bf fail as on loop 0 (god median 3-stock 2095.5 against 1200; shieldOnly first engagement 248 f against 120) |

What the loops established, for the next attempt:
1. The god searches with one or two samples per candidate in 70% of decisions (mean budget 1,433
   steps, 10 to 25 candidates, window 24 or 45); its CVaR is then the heaviest reply's outcome.
   Screening then verifying (loop 2) fixes the count but did not show a gain.
2. Its rollouts start the others' replies at the perceived "now", up to 4 frames after the real
   opponent could act; the legacy god replays those frames (loop 3 ports it).
3. Its ATK reply never throws a smash or the up special, which kill it (loop 5 punish reply).
4. Passive-target stalls exist: a route grab offered from a platform, a fired route that never
   re-arms, a climb trap on a hanger that never climbs (loop 4; seen on 2 of 4 dummy seeds once
   the path changed).
5. The measurement is the bottleneck: one change reshuffles every match, so 20 matches carry about
   plus or minus 2 wins of noise and 73 about plus or minus 4, and loop 0 itself scores 37 or 28
   on two seed sets. A keep rule on 20-match counts accepts noise; a sound one needs about 150
   paired matches per variant or a lower-variance measure (per-exchange outcomes, damage ratios
   over fixed positions).
