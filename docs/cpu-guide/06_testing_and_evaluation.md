# 06. Testing and evaluation

How to know the CPUs are strong, monotonic, human-like at human tiers, distinct by archetype,
deterministic and cheap. All of it runs headless in Node against the real sim (`npx --yes tsx
src/ai/aitest.ts` today; steps cost about 1.5 microseconds, so a 3,000-frame match is under 10 ms
of sim time plus the brains).

## 1. Statistics to get right first

- Win rates carry a Wilson interval. For `k` wins in `n`, `z = 1.96`: 10 of 10 gives a lower bound
  of 72.2%; 20 of 20, 83.9%; 50 of 50, 92.9%; 73 of 73, 95.0%; 100 of 100, 96.3%; 60 of 100, 50.2
  to 69.1%; 120 of 200, 53.1 to 66.5% (standard formula, research report 32 arithmetic). The
  current 10-of-10 gates therefore prove "at least 72%", not "unbeatable". God gates use 73 matches.
- Detecting a 10-point difference at alpha 0.05 and power 0.8: 60% versus 50% needs 194 matches in
  one sample; 65% versus 50% needs 85; 55% versus 50% needs 783. A Wilson half-width of 5 points at
  p = 0.5 needs 381 matches, 10 points needs 93.
- Sequential gate (Wald SPRT, alpha = beta = 0.05, H0 p = 0.5, H1 p = 0.65): a win adds 0.262 to
  the log-likelihood ratio, a loss subtracts 0.357, stop at plus or minus 2.944; about 64 matches
  expected under H1, 62 under H0. Pair seeds, swap sides, count a timeout as half a win.
- Elo: `E = 1 / (1 + 10^(-D/400))`; 100 points is 64%, 200 is 76%, 382 is 90%. The standard error
  of a gap at p = 0.64 is about 36 points at n = 100, 26 at 200, 18 at 400, so resolving 100-point
  steps needs 200 or more matches per pair. Fit Bradley-Terry by maximum likelihood over the round
  robin. Bot strength is static, so Glicko-2 and TrueSkill add little over Wilson intervals; use a
  per-player Elo or Glicko-2 for humans (03, section 5).
- Style and human-likeness tests compare distributions over seeds: report effect size (Cohen's d)
  and a nonparametric test (Mann-Whitney) over per-match values, not a single pooled number.

## 2. Metrics computed from replays

Openings and combos follow the Slippi convention as a statistic: an opening is the first hit on a
victim who was free and unhit for 45 frames; a combo continues while the victim is damaged,
grabbed, teching, downed or dying and ends after 45 consecutive frames outside those states
(https://raw.githubusercontent.com/OGoodness/slippi-js/master/src/stats/combos.ts). Define the
rest in the harness from `hit` events and `FighterStats` (`src/core/types.ts`):

- Strength: win rate, stocks lost per match, first-KO frame, 3-stock time, damage per minute,
  average KO percent (theirs and ours), openings per KO, damage per opening, conversion rate
  (openings that reach 2 or more hits), neutral win rate (openings from neutral), counter-hit rate
  (openings inside the opponent's startup), SD count, timeouts.
- Style (03, 3.3): approaches per minute, threat-range share, shield share, first-hit share,
  whiff-punish share, damage taken per minute, dodges per minute, projectiles per minute, offstage
  share, mean neutral distance, jumps per minute, commitment rate (attacks started per minute).
- Human-likeness: reaction histogram per stimulus class (frames from an opponent attack's first
  active frame in reach, or a projectile spawn, to the CPU's first responding input; report the
  count under 6 frames, the median and the 10th percentile), input events per minute, repetition
  (share of the last 16 moves that are one move), per-situation option entropy `H = -sum p log2 p`
  (the Ritsumeikan MCTS paper reports Shannon action variety of 3.87 versus 3.21 and 2.79 across
  three AIs as a diversity measure, https://www.ice.ci.ritsumei.ac.jp/~ruck/PAP/ieeeToG-ishii21.pdf),
  frame-window success rates (short hop, smash flick, jump-cancel), "impossible" action count
  (any response under `R - 1` frames at a human tier), accident count (tilt as smash, dash as roll,
  shield in the air), mash rate.
- Cost: mean and p99 ms per `cpuInput` call after warm-up, first-call ms, warm-up ms, steps per
  decision.

## 3. Scripted adversaries

Fixed policies in `src/ai/aitest.ts`, human slots with a typed name so profiles apply: rushdown
masher, shield-grab turtle, projectile camper, roll spammer, ledge camper, jump-happy (existing),
plus: stationary dummy (level 0, stands still), wandering dummy, shield-only, jump-only, "learns
your pattern" (answers the CPU's most frequent recent option with its counter), and "changes style
at 30 s" (for the changepoint reset). Each has a documented weakness so the expected counter can be
asserted (the turtle is grabbed, the roller is caught on the landing spot, the camper is approached
inside the clock).

## 4. Test cases (ids continue after `as`)

| Id | Test | Pass |
|---|---|---|
| at | Ladder within each archetype: level k+1 versus k, k = 1..4, both stages, paired seeds, sides swapped | SPRT (0.5 versus 0.65) accepts H1, or Wilson lower bound 0.55 or more at n = 200; adjacent Elo gap 200 plus or minus 30 after bisection of the skill scalar |
| au | Equal level across archetypes: 6 pairs x levels 1..5 (balanced 4 stands in for balanced 5), 100 matches | win rate inside [0.40, 0.60] at levels 1 to 2 and [0.35, 0.65] at 3 to 5 |
| av | God (balanced 5) versus the 19 other CPUs, 73 matches each, both stages | 0 losses, 0 SDs; at most 0.5 stocks lost per match against the level 5s; at least 60% against each style's level 5 |
| aw | Reaction floor: 20 matches per human tier, reaction histograms per stimulus | 0 responses under `R - 1` frames; median inside `R` to `R + cadence + 1`; god median at `R` |
| ax | Style signature per archetype, levels 2 to 5, 30 matches each against balanced at the same level | the ratio gates in 03, 3.3, with Cohen's d at least 0.8 on the defining metric of each archetype |
| ay | Human baseline: 20 recorded human matches; per-situation entropy `H_h` | CPU entropy between 0.7 and 1.3 x `H_h` below god; repetition share under the human 90th percentile |
| az | Scripted adversaries: 11 adversaries x 20 brains, 30 matches each | win rate 50% at level 1, 70% at 2 to 3, 85% at 4, 90% at non-god 5; god 30 of 30 with 0 stocks lost (lower bound 88.6%); 0 SDs from level 3; the "learns your pattern" adversary is beaten by level 4 and up; accuracy against "changes style" recovers within 20 s |
| ba | Kill speed versus the stationary dummy, 5 seeds x 2 stages | median 3-stock time falls with level within each archetype; god 1,800 frames or less now, 1,200 once the respawn lever in 02, 13.3 is set; first KO by frame 400 for god |
| bb | Determinism and cost: 20 brains x 3 seeds x 2 stages, each match run twice | identical final-state hashes and identical `(frame, held, pressed, direct)` streams; god p99 4 ms or less and mean 0.15 ms or less after warm-up; first call 2 ms or less; warm-up under 200 ms cold |
| bc | Character contract (04, section 9): load a second character (a copy of Aeval with altered numbers until a real one exists) | every tier plays it with no brain diff; derived kill percents within 2% of `calibrate.ts`; no `MoveId` literals outside the allowed files |
| bd | Property tests over 200 random seeds and states | never taunt; never a fresh grounded shield while an opponent's move is 0 or 1 frames old; never a roll off the stage; never a Shield or Dodge press while launched except the planned tech; never an attack press in hitstun; never an edgeguard plan whose own `canGetBack` fails; god never repeats a special more than five times offstage |
| be | Profile transfer: empty store versus a saved profile, first-15-second prediction accuracy over 36 pairs | mean gain at least 10 points, no pair worse than -2 (measured +17.2 today, `docs/CPU_AEVALMERE.md`) |
| bf | Passivity routine: stationary, shield-only and jump-only dummies | the passive route is chosen within 120 frames of the dummy's first passive window; no stall past the engagement clock |
| bg | Execution windows per tier (short hop, smash flick, jump-cancel up smash), 500 attempts each | measured success within 5 points of the drop table in 03, 2.2 |
| bh | Rollback parity: LAN test with `inputDelay` 1 to 4 and a level 5 CPU dash-dancing near a ledge | the relay-log replay hash equals the host's final hash (`npm run test:net`); no accidental rolls from the tap mirror |

Existing cases to keep: the win matrices, `ah` and `as` determinism, `ai` budget, `ak` no
teammate swings, `al` kill speed, `ao` predictor accuracy (informational), `ap` profile transfer,
`aq` kill routing share.

## 5. Human evaluation

Blind protocol after BotPrize (judges classify play as human or bot; the 2012 winning bots reached
52% humanness against 40% for the human players,
https://news.utexas.edu/2012/09/26/artificially-intelligent-game-bots-pass-the-turing-test-on-turings-centenary/):
record 30-second clips of humans against humans and humans against each CPU tier, unlabeled;
judges tag each clip human or CPU and rate humanness on a scale. About 43 judgments per condition
give a Wilson half-width near 15 points. Pass for a human tier: judged human as often as the
average human opponent, within that interval. Also collect a one-line explanation per clip ("it
rolled the same way every time") and feed the recurring ones back as property tests.

Reporting format to copy from the literature: matches played, win rate with interval, rating with
standard error, stocks lost, first-KO time, and the reaction distribution, per tier and per
opponent, on both stages, as a single table per release (the Melee agent paper reported win rates
and reaction delay experiments, https://ar5iv.arxiv.org/html/1702.06230; FightingICE reports
round-robin rankings, https://arxiv.org/pdf/2003.13949).

## 6. Regression discipline

- Golden seeds per (archetype, level, stage): a change that alters a stream is reviewed, not
  auto-accepted.
- Every sim rule change (a stale queue, a 2-frame window, grab immunity, a mash cap) re-runs the
  full matrix; Project M's CPU air-dodge regressions after its mechanic changes are the cautionary
  case (https://www.ssbwiki.com/Project_M).
- Performance gate on the slowest target device, not the dev machine.
- CI budget: the matrix is about 20 brains x 20 brains x 2 stages x 100 matches x 3,000 frames,
  about 240 million steps, roughly 6 minutes of sim time plus brain cost; run the full matrix
  nightly and the SPRT ladders per commit.
