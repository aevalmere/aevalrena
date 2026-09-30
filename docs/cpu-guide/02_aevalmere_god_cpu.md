# 02. Aevalmere, the god CPU

This is the design for balanced level 5, the CPU called Aevalmere. It is meant to be unbeatable by
a human under this game's rules: it perceives the world a few frames late and then plays perfectly
against what it saw, it learns the opponent's habits within the match and across matches, it never
misses an input, and it converts every opening into the most valuable outcome the forward model can
find. Everything a professional Super Smash Bros. Ultimate player is praised for (spacing, whiff
punishing, conditioning, juggling, ledge trapping, edgeguarding, spiking, kill confirms, survival)
is implemented here as a computation over the sim, not as a script per situation.

Read 01 first for the rules of the game. Character-specific numbers come from the profile described
in 04; this document never assumes a move id. 03 explains how the same machinery, degraded, produces
the four archetypes at five levels. 06 gives the tests that decide whether this design is done.

## 1. What "unbeatable" means here, in numbers

Acceptance targets (measured by the harness in 06):

1. Zero stocks lost across 73 matches against every other CPU tier on both stages (95% lower bound
   on a 100% win rate is 96.3% at 73 wins; a 10-of-10 gate only proves 72%). Against the six scripted
   adversaries (roller, camper, turtle, masher, ledge camper, jumper): 30 of 30 with 0 stocks lost.
2. Against a stationary target: median 3-stock time at or under 1,800 frames now, 1,200 frames
   (20 s) once the sim levers in section 13 are set. Section 13 shows the arithmetic; 1,200 is not
   reachable with the current respawn constants by any brain.
3. Zero self-destructs, zero taunts, zero "early shields" (a fresh grounded shield while an
   opponent's move is 0 or 1 frames old, which reads as input reading).
4. Human tests: experienced players lose every game, and post-match they describe what beat them in
   terms of reads and positioning ("it knew I would roll", "it never let me land") rather than
   speed. That is the difference between beyond-human and cheating, and it is the reason for the
   4-frame perception floor rather than 1.

Beyond-human is defined as: perception delay 4 frames (adjustable 1 to 4), zero input jitter, zero
dropped inputs, unlimited option menu, full search budget, full opponent model. The Melee agent
that beat professionals reacted in 2 frames and stayed strong with 2 to 4 frames of added delay
(https://ar5iv.arxiv.org/html/1702.06230); 4 frames is well under the 10-frame human floor
(research report 07) and still leaves every reaction humanly explainable after the fact.

## 2. What exists and what changes

`src/ai/aevalmere.ts` already implements most of the skeleton described in `docs/CPU_AEVALMERE.md`:
an 8-slot state ring, a 4-frame delayed observation replayed to now, about 115 candidate input
programs filtered by situation, a set of opponent reply models weighted by learned habits, rollouts
of 16 to 60 frames under a 2,600-step budget, a score of damage, KOs, projected KOs, recovery
feasibility, frame advantage, shield and stage terms, selection by `lambda * worst + (1 - lambda)
* mean` with hard vetoes, a six-component n-gram predictor with Witten-Bell back-off, exploit tables,
per-player profiles in localStorage, a combo table built from the sim, and a warm-up.

This guide keeps that shape (it is the FightingICE recipe, which has won that competition since
2016, https://arxiv.org/pdf/2003.13949) and changes the following, each justified in its section:

| Change | Section |
|---|---|
| Affordance prefilter to about 25 candidates, then a second ply after a hit | 5, 7 |
| Hidden-frame hypotheses weighted by the predictor instead of one replay per reply model | 3 |
| CVaR objective replacing the worst/mean blend and the 5% veto threshold | 7 |
| Common rollout window padded with the neutral continuation | 7 |
| Wilson lower bound with a break-even threshold for every exploit; restricted-response mixing; changepoint reset; win-stay/lose-shift and counter-me predictors | 6 |
| Engagement clock and cycle detector replacing the damage clock | 7, 12 |
| Intermediate orb holds, `shootSafe`, `chargeDecision`, zone term | 12 |
| Ledge trap coverage matrix, pre-grab hit, recovery matrix solved as a game | 9, 10, 11 |
| Passive-opponent kill routine | 13 |
| Executor with pre-buffered follow-ups, tap mirror in output coordinates, counter-based RNG, mash cap | 14 |
| Character profile derived from move data; brackets per matchup | 04 |

## 3. Perception

The brain never reads inputs. It reads state, and it reads the opponent's state `R` frames late.

1. Snapshot ring. Every frame, copy the real state into a ring of `R + 1` pooled states
   (`copyGameStateInto`, no allocation after warm-up).
2. Delayed observation. Take `S(t - R)`. Roll it forward `R` frames with the brain's own known
   inputs for those frames and a hypothesis for the opponent's inputs, then paste the brain's own
   true fighter on top (own state is exact; only the world is late, the same split FightingICE uses,
   `isControl` undelayed and frame data delayed 15 frames,
   https://github.com/TeamFightingICE/FightingICE/blob/master/src/aiinterface/AIController.java).
3. Hidden-frame hypotheses. The unknown is the opponent's input during the last `R` frames. The set
   is small enough to enumerate: nothing new; started move `m` `k` frames ago for `k` in 1..R and each
   `m` the predictor gives probability to; started shield, spot dodge, roll, jump or air dodge `k`
   frames ago. Weight each by the predictor's probability given the delayed context, keep the top 4
   to 6, and run every candidate plan against every kept hypothesis crossed with the reply model
   that hypothesis implies. This is determinized information-set search over a tiny set
   (https://eprints.whiterose.ac.uk/75048/1/CowlingPowleyWhitehouse2012.pdf); open-loop input
   programs cannot suffer strategy fusion, so a flat determinization is sound here.
4. Commitment rule. Commit to an attack only when it is good under every kept hypothesis whose
   weight is above a floor; otherwise hold a movement plan that is safe under all of them. This is
   what makes the 4-frame delay invisible: the brain never gets caught by something that started
   inside the delay window, because it planned for it.
5. Own-input delay on a LAN. `sampleLocal` gives the CPU the same input delay `d` as a human
   (1 to 4 frames, `src/net/rollback.ts`). Roll the own fighter forward `d` frames with the
   already-sampled inputs before deciding, and perceive the opponent `R - d` frames back (floor 0),
   so a level behaves the same offline and online (research report 20).
6. Passivity. Count frames since the opponent's last input edge, last movement of more than a few
   px, and last attack. Passivity drives the stall clock, the reply-model weights (the "continue"
   reply gains weight) and the passive-kill routine in section 13.

## 4. Affordances and threats

Computed from the character profiles (04) and the live state every decision, cheap enough to run
before any rollout. They are what a professional calls "knowing the matchup".

- `framesToHit(move, dx, dy)`: frames until move `m` can first connect from here, including travel
  (walk, run, dash, short hop, full hop, drift), from the move's reach table and the physics numbers.
- `threatZone(opp, N)`: the region the opponent can hit within `N` frames from their current
  state, the union over their moves of reach after startup plus travel. Neutral is played by
  standing where `threatZone(opp, R + our fastest startup)` does not contain us while our own
  poke reaches them: that is the definition of spacing
  (https://www.ssbwiki.com/Spacing).
- `whiffPunishable(oppMove, ourMove)`: the opponent's remaining frames after their last active
  frame (`iasa - activeEnd - 1`) minus our travel and startup, positive means a punish exists.
- `safeOnShield(move, spacing)`: measured by a sim probe at load, not by the formula (04).
- `killPct(move, spot)` and `killPctRecover`: probed per stage spot (center, ledge, offstage).
- `canGetBack(fighter)`: the recovery envelope table plus an exact rollout for close calls (10.1).
- `hitstunBudget(starter, follow, victim)`: the true-combo test (9.1).
- Invulnerability flags: never plan a hit into `invuln > 0`, a dodge window, ledge hang
  invulnerability or respawn; Ultimate's CPU challenges armor and rolls in lockstep with intangible
  opponents, and players notice
  (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)).

Situation is classified from these: neutral (nobody committed, both actionable), we-advantage
(opponent in hitstun, tumble, landing lag, downed, ledge hang, offstage, shield stun, grabbed),
we-disadvantage (mirror), both-offstage, and special states (respawn, Final Smash, grab hold).

## 5. Candidates: plans as input programs

A plan is `{ id, minFrames, flags, legalIn(state), script(t, self, ctx) }`. The script reads the
brain's own exact state and emits an intent per output frame, and the same function drives both
the rollouts and the real controller, so what was evaluated is what gets pressed (the level 10
design, keep it). Flags: attack, interruptible, tail (recovery takes over off the stage), movement,
projectile, edgeguard, stale, spike. Scripts keyed to move frames advance only on frames with
`hitlag == 0` (hitlag freezes the fighter, not the brain).

Plan catalog by situation (each entry is a family with parameters; the brain generates instances
from the character profile):

- Neutral, grounded: wait, walk in/out, dash in/out, dash dance (period from the profile),
  empty short hop and full hop (bait probes), pokes (tagged `poke`), tilts, smashes with charge
  `n`, grab, dash grab, projectiles at hold 0, 15, 30, 45, 60 (Aeval), retreating aerials, rising
  and falling short-hop aerials, fast-fall variants, platform drop, jump to platform, shield
  (with a duration), spot dodge, roll toward and away.
- Out of shield: jump aerials, grab, up smash, up special, roll, spot dodge, hold.
- Advantage: combo-table follow-ups (first, with a bonus), kill confirms, ledge trap stances and
  timed covers, tech-chase covers, landing-trap anti-airs, edge-hog, offstage aerials, spike routes,
  projectile walls over the recovery path, footstool.
- Airborne: drift in/out, fast fall, each aerial, double jump, air dodge (four directions), specials,
  four recovery policies with delay and hold-direction parameters.
- Ledge: climb, jump, attack, roll, drop-regrab, drop-aerial, wait `n`.
- Downed: getup, getup attack, getup roll (two directions), wait `n`.
- Tumble exit: jump home, air dodge home, drift, fast fall, nair, stay.
- Grab hold: pummel `k` then each throw.
- Respawn: drop now; or drop at frame `n` (used only by lower tiers).
- Final Smash: fire when it catches in every reply.

Prefilter by affordance to about 25 instances per decision: drop attacks that cannot reach in
their horizon, projectiles that `shootSafe` rejects (12), edgeguards that `canGetBack` rejects for
us, follow-ups the combo table rules out, and duplicates. FightingICE bots choose from 40 to 56
actions per character (https://arxiv.org/pdf/2003.13949); 25 well-chosen instances times 4 to 6
hypotheses times a 45-frame window is 4,500 to 6,750 steps, under 10 ms, and it leaves budget for
a second ply on the top 5 when a hit lands (7.4).

## 6. The opponent model: reading patterns

This is the part that makes Aevalmere feel like it knows the player. It is also the part that must
never over-fit three observations into a habit.

### 6.1 Action alphabet and observation

Classes (the current 30 are right): each attack by move id, ledge attack, getup attack, grab,
shield, roll toward, roll away, spot dodge, jump, air dodge (by direction), drift in, drift out,
nothing, stand/climb/tech. An action is recorded on the frame it starts; while nothing starts,
drift is sampled from the held direction on a change held 6 frames or every 12 frames, after 8 free
frames (existing rule). Add: jab mash (a second jab within 20 frames of the first), recovery route
(high/low/early/late, recorded when the recovery ends), and "buffered attack out of hitstun" (an
attack that starts on the first actionable frame after hitstun).

Context of an observation is the frame before it: situation bucket (7), distance bucket (4), our
state (3), their last action, phase since their last action started (0 to 10, 11 to 25, 26 to 60,
60+), plus two additions: percent bucket (relative to their kill percent bracket, 04) and stage
zone (center, near ledge, platform, offstage). Order 1 uses the full key, order 2 adds the action
before; both hashed into 1,024 rows (existing).

### 6.2 Predictor bank

Keep the mixture, add two members, and score by recent success (the Iocaine Powder structure from
the RoShamBo competition: a bank of predictors, an "opponent is reading me" layer, selection by
decayed recent performance; the original write-up could not be fetched, treat the structure as
unverified from memory and the mathematics below as standard):

1. Situation-only (Laplace 0.5), order 1 and order 2 over it with Witten-Bell back-off
   `P(a|h) = (c(h,a) + T(h) * P(a|h')) / (c(h) + T(h))`, ghost sequence model (last two actions),
   full chain, rhythm model (last action x phase). All existing.
2. Win-stay/lose-shift: after an action that worked (dealt damage or avoided a hit), predict the
   same action in the same situation; after one that failed, predict a different one. Humans do
   this.
3. Counter-me: predict the answer to our own most frequent recent option (the opponent is reading
   us). If this member's score climbs above the others, the human is adapting: lower the exploit
   cap and raise the mixed share (6.4).
4. Persisted prior from the profile.

Each member keeps `s_j = 0.9 * s_j + log q_j(actual)`; weights `w_j` proportional to `exp(s_j)`
(computed once per observation, not per frame, so the transcendental is off the decision path; or
use the existing hit-rate-squared rule, which needs no exp). Decay counts by 0.97 per observation in
the row (effective sample about 33, half-life about 23 observations). A second, fast table at 0.85
(effective sample 6.7) feeds the changepoint test.

### 6.3 Exploit gating: when a habit is real

Never act on a raw frequency. For a habit `a` with `k` of `n` decayed observations:

```
p = k/n
LB = (p + z^2/(2n) - z*sqrt(p*(1-p)/n + z^2/(4n^2))) / (1 + z^2/n)    # Wilson lower bound
```

With `z = 1.282` (one-sided 90%), an always-observed option reaches LB 0.5 at 2 observations,
0.7 at 4, 0.8 at 7; a 70% habit needs about 8 to reach LB 0.5 (research report 31 arithmetic).
The current trigger ("above 55% with 3+ history") acts on thin evidence: two of three has LB 0.25.

Exploit `a` only if `LB(a) >= p*`, where

```
p* = (V_safe + m - L) / (G - L)
G      = rollout value of the counter-plan if the habit occurs
L      = its reply-weighted value if it does not
V_safe = value of the best non-exploiting plan
m      = margin (0 for the god tier)
```

A cheap counter (a poke that is safe anyway) needs almost no evidence; a counter that opens us to a
kill needs a lot. The search already computes `G`, `L` and `V_safe`, so the gate costs nothing.
The god tier uses `z = 1.282` and `n_min = 4`; it can afford a wrong guess.

### 6.4 Safe exploitation: how much to bet on a read

Two regimes, from the safe-exploitation results of Ganzfried and Sandholm
(https://www.cs.cmu.edu/~sandholm/safeExploitation.teac15.pdf) and Johanson's restricted Nash
response (https://webdocs.cs.ualberta.ca/~games/poker/publications/NIPS07-rnash.pdf):

1. Gift regime. When the opponent chooses an option whose rollout value against our mixed reply is
   below their best option's, that is a gift. Accumulate `k += V_best_opp - V_chosen` in expected
   value (never realized damage; "risk what you've won" on realized profit is proven unsafe). We may
   take an exploitative plan whose worst-case value is below `V_safe` by at most `k`. This is safe:
   the worst the human can do is take the gift back.
2. Guessing regime. Shield/grab/attack triangles and roll-versus-spot-dodge coverage are
   rock-paper-scissors: exploitation there is a bet. Reply model = `p * habit + (1 - p) * worst-case`
   with `p = p_max * clamp((LB - 0.4) / 0.6, 0, 1)`, `p_max = 0.75` (the current predictor cap).
   Because the exploitation-versus-exploitability curve is strongly concave, a cap of 0.6 to 0.75
   gives up almost nothing against a reading opponent.

The existing rule (25% fixed habit weight, predictor up to 75% scaled by confidence and accuracy
above 25%) is a restricted response with `p_max` 0.75. Keep it; add the gift budget and the LB gate.

### 6.5 Changepoint reset

Humans change after they get punished. Accumulate the log-likelihood ratio of the fast table over
the slow one with a floor at zero; when it passes 3.0 nats, multiply the slow counts by 0.3 and
restart. Cheap version: a habit that predicted at 0.6 or better is declared broken after 1 hit in
the last 6 predictions or 2 in the last 8. After any stock change, multiply counts by 0.7 for 600
frames (the human re-plans on a new stock). The persisted profile is a prior, never a fixed model.

### 6.6 Habits worth tracking, with the counter and its timing

Reactive windows below assume a beyond-human `R = 4` and are exact from the Aevalrena frame data in
01 (research report 31 computed the human-tier versions):

| Habit | Context | Counter |
|---|---|---|
| Roll away under pressure | opponent shielding or just hit, under 60 px | roll is 24 frames, dodges non-low hits 3 to 16, moves 80 px; low pokes (dtilt, dsmash) beat it on any frame; otherwise a hitbox active on frames 17 to 24 at the landing spot; track direction |
| Ledge option | percent bucket, trapper position | cover the modal option (9.5); the roll lands 34 px inside on frame 24 with no vulnerable frame, so the answer is a hitbox or grab active on frame 24 at that spot |
| Air dodge when juggled | hit count, height, dodge unspent | exit window is frames 32 to 33; once spent, follow up as a rule |
| Spot dodge on approach | approach speed and distance | vulnerable 18 to 22; a grab needs input at least 11 frames after the dodge input |
| Jab mash | inside jab range, we land or shield | shield, then grab; or space out |
| Recovery route | height versus ledge, time offstage | drives edgeguard placement (10) |
| Buffered aerial out of hitstun | knockback bucket | the first actionable frame is exactly `floor(0.4 * kb)` plus hitlag; time a hitbox for it |
| Tech and getup option | position, percent | tech in place vulnerable 21 to 25, tech roll 21 to 39, getup 23 to 29, getup roll 26 to 34, getup attack hitboxes 14 to 20 |
| Approach after a projectile | shot type, range | trap the landing of a jump-over, grab the shield, out-shoot the counter-shot |
| Panic options at high percent | percent bucket, stocks | reads change with stock state; keep percent bucket in every context |

### 6.7 Conditioning the human

Reads go both ways. Aevalmere may deliberately establish a pattern (three retreating orbs from the
same range) so that the human's answer becomes predictable, then break it. This is the only place
where the brain chooses a plan that is not the best-valued one, and it is bounded: the "bait
probe" candidate family (empty hops, dash-in-dash-out, a shot meant to be shielded) is offered
with a small prior bonus proportional to how much the predictor's uncertainty about the human's
answer would fall if the probe were answered, capped so that it never selects a plan the search
rates as losing a stock in any hypothesis. Community writing describes the same idea as encroaching
then switching to immediate aggression after conditioning
(https://www.ssbwiki.com/Neutral_game, https://www.ssbwiki.com/Mindgame).

### 6.8 Being unreadable

The human can learn Aevalmere too. Three rules: choose among near-equal candidates by a seeded
softmax with a small temperature so identical situations do not always get identical answers
(entropy per situation bucket is measured in 06); never repeat the previous stock's recovery route
or ledge option when the matrix (11.3) gives them equal value; apply a staleness cost to
commitments used recently, decayed by elapsed frames (0.9 per 12 frames) rather than per decision,
so the same cost means the same thing in a mirror and against a dummy.

### 6.9 Profiles across matches

Keep the existing store (`src/ai/profile.ts`): saved per typed player name, on every KO and at match
end, rows capped at 60 observations of weight on load, then decayed by fresh play; per-member hit
rates saved so a known player's best-reading member is trusted from the first guess (measured:
+17 points of first-15-second accuracy over 36 pairs, `docs/CPU_AEVALMERE.md`). Add: a stored
archetype estimate and skill estimate (a per-player rating, see 06), a "poisoned" guard (if the
first 30 s of a new match disagree with the stored prior by more than the changepoint threshold,
drop the prior to 0.3 weight), and a user-facing toggle. Killer Instinct's Shadow Lab stores every
action with match context and needs about 40 matches per opponent, 400 to 700 patterns each
(https://gamedeveloper.com/programming/the-killer-groove-the-shadow-ai-of-killer-instinct); the
190 KB profile here is the same idea at n-gram resolution.

## 7. Search and evaluation

### 7.1 Reply set and hypotheses

For each candidate plan `c`, for each kept hidden-frame hypothesis `h` (3.3) and each reply model
`r` drawn for that hypothesis, clone the state, replay the delay window, run `c` against `r` for a
common window `W`, and record an outcome vector `o(c, h, r)`.

Reply models are fixed policies weighted by the predictor: continue, attack (close and hit with the
fastest reaching move), defend (shield or air dodge then grab out of shield), roll toward, roll
away, spot dodge, jump, air dodge, move in, move out, named-move replies from the predictor's top
classes, and, off the stage, three recovery variants; at the ledge, the five ledge options; when
launched, the tech options; when downed, the getup options. Keep at least 25% of the weight on the
fixed set (the action-table result: a hand-built top-5 table lost to the best competition bot
when used alone, https://cilab.gist.ac.kr/hp/wp-content/uploads/publications/international_conference/2017/opponent_modeling_based_on_action_table_for_mcts-based_fighting_game_ai.pdf).

### 7.2 Common window

Score every candidate over the same `W` (about 45 frames; 60 or more for kill and spike plans),
padding shorter plans with the neutral continuation. Unequal horizons let long plans collect terms
short plans cannot. The FightingICE MCTS bots evaluate every candidate over the same 60-frame
rollout with a 16.5 ms budget (https://www.ice.ci.ritsumei.ac.jp/~ruck/PAP/ieeeToG-ishii21.pdf).

### 7.3 Outcome vector and score

`o = (damageDealt, damageTaken, stockDelta, projectedKO, ourStockRisk, frameAdvantage,
stageControl, shieldHealth, ledgeControl, zone, repetition, continuity)`.

- `projectedKO`: for a victim still launched at the end of `W`, step the launch to the blast rect
  (exact) and, if it does not cross, test their recovery reach (10.1); a launch that leaves no
  way back is a KO.
- `ourStockRisk`: our own `canGetBack` slack at the end of the window, and any KO on us.
- `frameAdvantage`: their busy frames minus ours at the end, scaled by reach (full inside 90 px,
  none past 250 px, existing rule).
- `stageControl`: distance of the opponent from center minus ours, plus a cornered bonus.
- `ledgeControl`: we hold the ledge or the trap stance while they are off the stage.
- `zone`: shots in flight covering the lane between the fighters, capped, switched off when the
  engagement clock is high (12.4).
- `repetition`: staleness cost of the commitment (6.8) and cycle penalty (7.6).
- `continuity`: a small bonus for continuing the running plan, against jitter.

Score `J = w . o` with the balanced weights (03 lists the archetype weights). Kill terms as today:
a launch that projects a KO 360, a KO inside the window 520, a starter whose table chain kills from
the victim's bracket and spot 400.

### 7.4 Aggregation: CVaR instead of a worst/mean blend

Let the outcomes for `c` be `{(w_i, J_i)}` over hypotheses and replies. Sort ascending by `J`,
take weight until it sums to `alpha` (partial weight on the last), average: that is CVaR at
`alpha` (Rockafellar and Uryasev's risk measure; the page was seen only as a search hit, the
definition is standard). Final value `V(c) = lambda * CVaR_alpha(c) + (1 - lambda) * mean(c)`. For
the god tier `alpha = 0.20`, `lambda = 0.50`, `lambda >= 0.7` when a stock ahead with no timer,
`lambda` down by up to 0.25 against an opponent the model reads well.

This removes two thresholds the current code needs (a reply under 8% of weight cannot set the
worst case; a stock loss in any reply above 5% vetoes): a reply of weight `w < alpha` now
contributes `w / alpha` of the tail. Keep only one hard veto: a certain loss (a stock lost under
hypotheses and replies whose combined weight is 0.5 or more) when any candidate without one exists.
Price every other stock loss as expected stock loss times the KO bonus.

Second ply: after a hit lands in the top candidate's rollout, re-expand the top 5 candidates at the
hit frame with the combo table's follow-ups and the victim's real launched state, and re-score. This
is what turns "hit" into "convert" (9.2).

### 7.5 Selection

Rank tiers, then value (Dill's dual utility: rank as veto, weight-random among the top,
https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter03_Dual-Utility_Reasoning.pdf):

1. Reflex tier (14.2) preempts everything.
2. A Final Smash that catches in every hypothesis and reply is taken at once.
3. Certain-loss vetoes removed.
4. A spike or kill route that KOs in every reply and leaves us on the stage or ledge is taken at
   once.
5. Otherwise argmax of `V(c)` plus the exploit bonus (6.3), the bait-probe bonus (6.7), continuity
   and the stall pressure terms; ties within 2% broken by seeded softmax (temperature 0 means
   argmax; the god tier uses a small positive temperature only for the anti-readability rule).

### 7.6 Budget, cadence, anti-stall

- Budget in sim steps, never wall-clock (a clock ties decisions to machine load and breaks golden
  seeds). God: 2,600 steps per decision now, raise toward 8,000 only if p99 per call stays under
  about 8 ms on the slowest target device; the current mean is 0.06 ms and p99 about 2 ms
  (`docs/CPU_AEVALMERE.md`). First 240 frames: 600 steps (ramp), warm-up 400 throwaway frames
  before frame 0.
- Cadence: decide when the plan ended, when an interruptible plan has run 3 frames (6 recovering),
  or when the opponent's delayed state visibly changed (new move, action or projectile).
- Candidates in priority order at full horizon (follow-ups, kill confirms, edgeguards first); when
  the budget runs low the last ones get shorter horizons, then none (measured better than shrinking
  every horizon evenly, `docs/CPU_AEVALMERE.md`).
- Engagement clock (12.4) raises approach weight, lowers `lambda` and raises projectile staleness
  continuously; a cycle detector over the last 12 (plan class, distance bucket, outcome) tuples
  penalizes any period-1 to period-4 loop repeated three times with no damage.

## 8. Neutral

Neutral is where the opponent model and the threat computation meet. The plan families are in
section 5; this section is the evaluation logic that makes them behave like a top player's neutral.

- Spacing. Preferred distance is `spacingMul * ownPokeReach` (balanced 1.1, adaptive for the god
  tier: it is whatever the rollouts prefer, which is just outside the opponent's fastest reaching
  move plus their travel over `R + our startup` frames). The stage-control term pulls toward center
  and pushes the opponent toward a ledge; corners are where kill percents fall (01, section 2).
- Whiff punishing. A candidate that starts inside the opponent's endlag and connects before their
  `iasa` scores as a free hit in every hypothesis; `whiffPunishable` (4) prefilters. The god tier
  reacts to a whiff in `R` frames; the human tiers need the reaction gate in 03.
- Bait. Empty hops, dash-in then dash-back and shield-poke probes are candidates whose value is
  the opponent's predicted reply (a jump we can anti-air, a roll we can cover, a shield we can
  grab) rather than damage; see 6.7. SSBWiki's baiting and bait-and-punish definitions
  (https://www.ssbwiki.com/SmashWiki:Glossary).
- Shield pressure and out-of-shield. A hit on shield is scored by the measured on-shield advantage;
  when the advantage is negative the rollouts against the defend reply show the grab or up smash
  out of shield, so unsafe pokes lose value on their own. The set of out-of-shield options here is
  small (01, section 3), so the counter-hit rollouts are cheap.
- Projectiles. `shootSafe` and `chargeDecision` (12) decide the shot and the hold; the zone term
  values a wall; the engagement clock prevents a wall from becoming a stall.
- Platforms. Both stages are Battlefield-style. Candidates include platform drop, jump to platform
  and platform-edge landings; the affordance table includes hits from above and below. Platform
  camping with a projectile is a documented strong pattern (https://www.ssbwiki.com/Camping) and a
  documented stall, so the engagement clock applies to it.
- Cross-ups and mixups. In a rock-paper-scissors situation the rollouts already form a payoff
  matrix `M[plan][reply]`. When predictor confidence is low, play the maximin mix (fictitious play,
  200 iterations, seeded); when high, best-respond under the restricted-response cap (6.4).
- Movement precision. Ground movement is digital, so an exact stop is a search over hold lengths
  (14.4), once per approach.

## 9. Advantage: converting every opening

### 9.1 True combo test

Exact for this sim (no DI, hitstun `floor(0.4 * kb)`, hitlag freezes both):

```
T  = floor(0.4 * kb)                    # victim hitstun after the starter
E  = iasa - hitFrame                    # our frames until actionable after the hit
J  = jump squat plus one if the follow-up is a jump aerial (measured 4 on Aeval)
S  = follow-up's first active frame
Tr = travel frames to legal spacing
budget = T - (E + J + S + Tr) + 1       # victim hitstun left when the follow-up lands
true combo  <=>  budget >= 1 and the hitbox overlaps the launched hurtbox on that frame
```

The closed form prefilters; the cloned sim decides, because the follow-up also has to reach the
launched body (a full hop rises past a low victim; report 30 measured Aeval utilt into uair: true
from about 12.6% before the hit with a frame-6 utilt, and at 0% only with a late-frame utilt into a
short hop). The Slippi definition of a combo (a reset counter of 45 frames outside stun, tech and
knockdown) is a statistic, not a guarantee; use it only in the harness
(https://raw.githubusercontent.com/OGoodness/slippi-js/master/src/stats/combos.ts).

### 9.2 Combo table and per-hit replanning

Key: (starter hitbox group, victim percent bracket, hit-frame class early/mid/late, dx bucket
10 px, dy bucket, grounded or airborne, stage spot). Value: the best sequences up to 4 hits by
damage, kill flag, end position and end advantage; BFS with pruning by `budget >= 1` and
dominance, depth at most 4, at most 240 frames, stop at a KO. Cost about one second at load per
character and stage (report 30 arithmetic); build lazily per bracket if needed. Percent brackets
come from the matchup (04), not fixed 0-30-60-100.

At runtime the entry for the last hit is the first candidate set with a bonus (+6), and the second
ply (7.4) re-checks each follow-up against where the victim is actually flying. Chains are
re-planned at every hit; the table is a prior. Follow-ups are pressed inside the buffer window
before `iasa` (14.3) so no frame is lost.

### 9.3 Kill routing

Precompute kill confirms per (starter, follow-up chain, percent window, spot): a chain counts when
its last launch crosses the blast rect within hitstun or leaves no recovery (10.1). The percent
window is `[max(p_true, p_koF - d_s), p_upper]` (report 30, section 1.6). Prefer routes that end
offstage or past the rect over raw on-stage kills; break ties toward the nearer blast line. Score
`wD * damage + wK * P(KO) + wO * offstage + wL * ledgeCarry - wR * risk`, with `ledgeCarry =
clamp((|x_end| - stageHalfWidth) / 100, 0, 1)` plus a bonus when the victim ends at a ledge our trap
covers. Grab (any throw), dtilt, utilt and nair keep the +6 confirm bonus and are examined first
when the victim is in a confirming bracket (existing). Kill-threat bonus for ending free next to a
grounded target that a smash or throw would KO walks the brain into range (existing).

### 9.4 Juggling and landing traps

Being above is disadvantage: in this sim the victim has one air dodge per airtime (not refunded by
a hit), an exit window of 2 frames (32 to 33) after it, and no landing-lag mercy. Procedure:

```
predictLanding(victim):
  for policy in {none, driftToStage, fastFall, doubleJumpAt(t), airDodgeAt(t, dir)}:
      clone; run until onGround; record (x, t, landingLag)
  weight the set by the habit predictor (exact for the god tier when the dodge is spent)
pick the anti-air maximizing lambda * worstHit + (1 - lambda) * meanHit over the set
```

Rules: read the dodge-spent flag and time the hitbox for the exit window, not the approach; hold a
hitbox active at the predicted landing spot for the landing lag; cover directional dodges with wide
or lingering hitboxes; catch the double jump at its start. Ultimate CPUs juggle by standing under
and up-smashing, which players learn to bait (https://www.ssbwiki.com/Flaws_in_artificial_intelligence);
the difference here is that every anti-air is chosen against the predicted landing set.

### 9.5 Tech chase

The option and its roll direction are visible on frame 0 of the tech; only the timing of a
lying-down getup is hidden. With `R = 4` every option is coverable on reaction (vulnerable windows
in 6.6). A reply started when the option is seen hits option `o` if `[R + Tr + S, R + Tr + S + A - 1]`
overlaps `o`'s vulnerable window and the hitbox contains `o`'s end position. Procedure:

```
chase(victim landing L, R):
  Rset = { o : exists m with hit(m, o, R) }
  if Rset == all options: wait; at L + R play the best m for the observed o
  else: pre-commit c maximizing sum_o P(o) * payoff[c][o] from cloned rollouts
```

Tech rolls and getup rolls stop at platform edges (`docs/DECISIONS.md` 2026-09-13), so a victim
near an edge has fewer options; the table reflects that automatically because the rollouts use the
real geometry. Post-grab immunity is absent (01), so a chain grab on a predictable tech is legal
until the owner adds it.

### 9.6 Ledge trapping

Aevalrena's ledge options (01, section 5) make the roll the hard case: it has no vulnerable frame
and lands 34 px inside on frame 24, actionable. Coverage matrix:

```
vulnerableInterval(o, h):   # h = frames since their grab when they input o
  leftover = max(0, 40 - h) on grabs 1 to 3, else 0
  climb  -> [max(leftover, 29), 30)     attack -> [max(leftover, 23), 40)
  roll   -> empty; landing spot known on frame 24    jump -> [max(leftover, 12), inf)
  drop   -> [leftover, 12) then regrab   wait -> [leftover, inf) at the hang hurtbox
chooseTrap:
  p[o] = Dirichlet-smoothed habit counts with a quantal-response prior exp(-beta * loss_o)
  for trap in {stand at d with shield, spaced tilt, timed aerial, orb hold h, crescent, hog}:
      for o, for h in {early, at invulnerability end, late}: simulate 90 frames; gain[trap][o][h]
  return argmax lambda * min_o + (1 - lambda) * sum_o p[o] * mean_h gain
```

Answers that fall out of the numbers: a hitbox or grab active on frame 24 at 34 px inside covers
the roll; a move active on frames 23 to 24 after the option punishes the ledge attack; a move
active on frame 29 catches the climb's single vulnerable frame (only the god tier can time it on
reaction); a low poke at the corner after frame 40 forces an option out of a waiting hanger. Shield
at the ledge covers four of the six Ultimate options
(https://www.ssbwiki.com/Edge); here the same stance covers climb and attack and leaves roll and
jump to reaction. Sword-style retreating aerials are the community's standard trap tool
(https://rangothemercenary.medium.com/smash-ultimate-tips-ledgetrapping-51f551c949aa); Aeval's
equivalent is a retreating bair or a full orb held at the landing spot.

### 9.7 Shield pressure and shield breaks

A shielding opponent loses 0.12 HP per frame plus shield damage per hit; a break is 180 stunned
frames, a guaranteed stock. Rollouts against the defend reply price shield breaks (existing shield
term); a full orb into shield costs 16 of 60 HP and 23 frozen frames (report 21 table), so two full
orbs and a smash break a held shield. Grabs beat shields (https://www.ssbwiki.com/Grab), which the
grab candidates express. Never poke a shield with a move whose measured on-shield advantage lets
their fastest out-of-shield option (grab active frame 7) connect first, unless the rollouts show the
follow-up trade in our favor.

## 10. Edgeguarding

### 10.1 Can the opponent get back

```
Env.maxDepth[jumpsLeft][upSpecialAvailable][airDodgeAvailable][dxBin]   # per character and stage, at load
canGetBack(st, who):
  if onGround or ledge action: ok
  dx = px beyond the nearer corner; depth = y - platformTop
  margin = Env.maxDepth[...][bin(dx)] - depth
  if |margin| > 40: return margin > 0
  exact: for script in SCRIPTS (jump frames, up special frames, air dodge frame and direction,
         stick toward stage, optional fast fall), for delay in 0..30 step 3:
         rollout; ok if ledgeHang or onGround before a KO
```

Aeval envelope probes (report 05, Hearthmoor, depth below the ledge top): with no jumps and only
the up special, about 110 px at dx 40 and 140 at dx 80 to 120, none at dx 260; with one jump 130 to
230; with two jumps 140 to 310. The up special rises about 82 px in 48 frames and cannot grab the
ledge before its last frame; an air dodge travels about 109 px sideways. Build the table by the same
probe for every character. A hit is a gimp if `canGetBack` flips after the hit's hitstun is applied
in a clone; a hit that flips it only when the dodge is spent is worth more, because the dodge is
never refunded here.

### 10.2 Choosing the edgeguard

```
PLANS = [hogWait, hogThenAct, trapStand(d, move), orbHold(h), crescent, egFair, egBair, egDair,
         egFairDair, egBairDair, footstoolIfUnder, retreatToStage]
for plan: for reply in recovery scripts (weighted by habit and an adversarial set):
    simulate 60 to 90 frames; value = V_STOCK * oppKO - V_STOCK * riskWeight * meDead
                                      + W_DMG * (dealt - taken) - W_CTRL * lostLedgeControl
score = CVaR blend; take a spike route at once if every reply ends in a KO and we end on stage or ledge
```

`V_STOCK` scales with the stock state: on last stocks a trade is neutral, so raise it above
`riskWeight`; ahead, raise `riskWeight`; behind, lower it. Never go off the stage when the best
onstage plan (trap, hog, projectile) beats the best offstage plan by a margin; the Cloud guide's
argument for staying on stage against weak recoveries generalizes
(https://dignitas.gg/articles/blogs/smash/14080/lord-of-sword-a-guide-to-cloud-in-super-smash-bros-ultimate).
Counter-edgeguard filter: extract the opponent's active recovery hitboxes per frame from each reply
(Aeval's geyser is active frames 8 to 20 up to about 76 px above its feet) and reject any plan whose
hurtbox overlaps them unless the rollout survives. Add our own `canGetBack` at the plan's last frame
as the risk term.

### 10.3 Edge-hog and the pre-grab hit

There is no trump, so taking the ledge first is a legal, decisive edgeguard: the recoverer cannot
grab an occupied ledge, and the hog is invulnerable for 40 frames (three grabs). Ultimate removed
hogging in favor of trumping (https://www.ssbwiki.com/Edgeguarding); this sim did not, and the
brain uses it (`ledgeHog` exists). A hanger with expired invulnerability is hittable at the hang
hurtbox, so a hog that outlasts its invulnerability is itself a target; the plan ends by climbing,
rolling or dropping before frame 40 unless the recoverer cannot reach a hitbox in time.

The 2-frame equivalent: a hit that resolves on the frame before the grab frame gives hitstun and
cancels the grab. Predict the grab frame `N` under each recovery hypothesis (clone, step until
`ledgeHang`), then place a move whose active span ends at `N - 1` under the likeliest hypothesis
and starts no earlier than `N - 1 - sigma_N`. At `N - 1` the victim's feet are 2 to 72 px below the
top and within 30 px outside the corner, so ground-level hitboxes reach shallow approaches and only
low or downward hitboxes reach deep ones. Long active windows, orbs already in flight and the
crescent's returning pass are the natural tools.

### 10.4 Spikes and footstools

`dair` is a spike (angle 270) and there is no meteor cancel. A spiked fighter keeps its downward
speed after hitstun (01, section 2), so a spike at 20% ends the stock in roughly half the frames of
free fall. Spike routes (`egFairDair`, `egBairDair`, `egDair`, `dairSpike`, `ledgeDropDair`) are
taken outright when every reply ends in a KO and we get back. Footstool: an airborne victim under
our feet loses 20 frames of control and drops about 120 px, the cheapest gimp in the sim; offer it
whenever `tryFootstool`'s geometry holds off the stage. Ultimate's meteor rule (a meteor on a
grounded fighter cannot be teched, 5% less knockback, https://www.ssbwiki.com/Meteor_smash) does
not exist here; downward hits on grounded victims slide or tumble by the normal rules.

## 11. Disadvantage and survival

### 11.1 Tech and knockdown

Always tech (window 20 frames, arm when the predicted landing is within about 10 frames; press
once; the sim ignores presses for 40 frames after). Choose in place or roll by rollouts against the
attacker's predicted coverage; roll away from their fastest reach, in place when they are far. When
downed, choose among getup, getup attack and getup roll by the same coverage rollouts, and vary
the wait `n` (a fixed wakeup timing is one of the documented CPU tells,
https://www.ssbwiki.com/Flaws_in_artificial_intelligence).

### 11.2 Escaping juggles and landing

Enumerate landing policies (drift, fast fall, double jump at `t`, air dodge at `t` and direction,
aerial to land, platform landing) against the attacker's predicted anti-airs; pick the best worst
case. The air dodge is scarce: use it when the alternative is a combo or kill, never on every
visible attack (the Smash 4 and Ultimate CPUs' reflexive air dodge is what humans bait,
https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)). Never press an attack in
hitstun or tumble except the tech; a buffered aerial out of hitstun is the mash humans get caught
by (14.2).

### 11.3 Recovery as a game

```
ROUTES = [highEarly, highLate, lowSnap, airDodgeSnap, jumpThenUpB(t), upBThenJump, dropRegrab, landOnStage]
         x delay {0, 6, 12, 18} x hold-direction {toward, neutral, away for k frames}
COVERS = edgeguarder replies: hog, trap stance, offstage aerial at several timings, projectile wall, spike try, idle
A[route][cover] = survived ? 1 - damageTaken / CAP : 0    (150-frame rollouts)
if the edgeguarder can react to the first commit within R_opp frames: solve the tree backward
else: maximin mix by fictitious play (200 iterations, seeded); sample from it
```

Facts that shape the routes (report 05 probes): every ledge grab needs `vy > 0`, so all grabs happen
on the way down; a geyser from 77 to 147 px below the ledge with inward steering ends inside the
grab region; an air dodge can snap the ledge mid-dodge with no vulnerable gap; a drop-regrab gives
66 invulnerable frames. Wait out the hog: a hog's invulnerability ends 40 frames after its grab and
a hang never times out, so a recoverer with one jump can hover about 68 frames and time the geyser
so its hitboxes (frames 8 to 20) rise through the hang hurtbox after the hog's invulnerability
expires. Never repeat the previous stock's route when values tie (6.8).

### 11.4 Shield and out of shield

Drop the shield before HP falls below a floor (god: 20 of 60, the existing top row); a break is a
stock. Out of shield, rank by frames to the first active hitbox (up special from data, grab 7,
jump plus aerial 4 plus startup, up smash 12) and pick the fastest whose reach covers the attacker
and whose start is at or under the measured on-shield advantage. Against a predicted grab, spot
dodge (invulnerable 3 to 17) or jump; against a predicted string, hold.

### 11.5 Survival at high percent

Without DI, survival is decided before the hit: position (never stand near a ledge at a percent
where the opponent's kill moves connect there, from `killPct` of their moves against our weight,
04), stock-aware `lambda` (0.7 or more when ahead), and the certain-loss veto. The danger
threshold per matchup is a derived number, not a guess.

## 12. Projectiles and zoning

Aeval is a zoner; future characters may not be. All of this reads the shot profile in 04.

### 12.1 Shoot only when the tail is safe

```
shootSafe(range, oppSpeed, ourTotalFrames, o):
  v = max(oppSpeed, o.walkSpeed) ; gap = max(0, range - o.oppReach)
  tHit = o.oppReact + gap / v + o.oppStartup                    # earliest they can hit us
  tShot = shot.castFrames + (range - shot.spawnOffset - shot.radius - o.halfWidth) / (shot.speed + max(oppSpeed, 0))
  credit = (shot.range >= range - o.halfWidth and tShot < tHit) ? shot.frozenOnShield : 0
  m0 = tHit - ourTotalFrames ; m1 = m0 + credit
  return { safe: m0 >= margin, safeIfAnswered: m1 >= margin }
```

Aeval's tap orb against a 3.1 px/frame runner with reach 34 and startup 5 is safe from about 142 px
(report 21). The god tier does not need the formula for decisions (rollouts against the attack reply
test it) but uses it as the prefilter. The measured point-blank truth for Aeval: the orb never gives
advantage on shield at any charge (-18 tap to -5 full), a tap orb never gives point-blank hit
advantage, a near-full orb that hits is +5 at 0% and +17 at 60% (report 21 arithmetic). "Orb into
grab" is therefore a full-charge-only plan and must be confirmed by rollout.

### 12.2 Charge decision with intermediate holds

```
chargeDecision(distance, oppApproachSpeed, o, shot, margin, shareUsed):
  if not chargeIsFree(): return 0         # inbound shot, opponent airborne over us, opponent in startup near us
  tHit as above
  hMax = largest h with h + shot.total(h) + margin <= tHit
  hReach = smallest h with shot.range(h) >= distance - o.halfWidth
  if hMax < 0: NO_SHOT ; if hReach > hMax: NO_CHARGE_SHOT
  h = clamp(round(shareUsed * hMax), hReach, hMax); re-run every held frame and release early when hMax falls below frames held
```

Against a 3.1 px/frame runner, at 250 px the safe hold is at most 20 frames while 25 are needed to
reach, so the orb cannot be both safe and in range (report 21). Offer holds 0, 15, 30, 45, 60 as
candidates; the last quarter of the hold is worth the most (01, section 8).

### 12.3 Answering a projectile

Per option, feasibility `tHit - R >= option.ready` (shield 1, spot dodge 3, roll 3, air dodge 2,
short hop 3 plus rise, counter-shot at its spawn frame if our strength beats theirs, walk-in 0),
cost `wDmg * damage + wShield * shieldLoss + wTempo * lockedFrames + wRisk * P(punished) -
wProgress * pxTowardShooter`. Out of range: do nothing (a tap orb dies after about 186 px, a full
one after 341). Shielding a full orb costs 16 of 60 HP and 23 frames; a short hop clears a tap orb
from frame 12 after the press but not a full orb at close range; a roll gains 80 px toward the
shooter with 8 frames of ending lag after invulnerability. The god tier (R 4) can answer any shot
spawned farther than about 66 px for a full orb.

### 12.4 Engagement clock, zone term, cycles

Replace the damage clock with an engagement clock: reset when either fighter is within 90 px with
neither in hitstun, or when a hit of 8% or more lands; a chip from range does not reset it. Rate
check: damage per second over the last 20 s below a floor counts as a stall. Pressure
`p = clamp((clock - T0) / T0, 0, 1)` with `T0 = 420 * (1 - 0.8 * passivity)` for balanced; effects
are continuous: approach weight x(1 + 3p), `lambda` down 0.2p, projectile staleness x(1 + p), shot
band shrinks toward close range. Zone term: shots in flight covering the lane, capped, off when
`p` is high. Cycle detector as in 7.6. Never repeat the same special more than five times off the
stage without returning (the Supernova 2025 stalling rule, https://www.ssbwiki.com/Tournament_rulesets_(SSBU)).
Balanced level 5 never plays for a timeout.

## 13. Killing a passive or half-passive opponent fast

### 13.1 Detection

Passive: no input edge for 60 frames and no attack started for 120, or a repetitive loop (the
repetition score). Half-passive variants the brain must also recognize: shield only (grab), jump
only (anti-air and juggle), roll only (low pokes and landing-spot hits), taunt loops. The
reply-model weights already move toward "continue" with passivity; the passive routine below is a
candidate family, offered when passivity is high, and evaluated like any other plan, so a victim
who wakes up is handled by the ordinary search.

### 13.2 The route

A victim that presses nothing does not recover. The fastest kill is therefore "put them past the
ledge with hitstun, then let them fall or spike them", not a damage race:

1. Stock 1 (spawns 330 px apart at (-165, 0) and (165, 0)): dash to grab range (about 100 frames),
   grab (active frame 7), hold 8 frames, back-throw (release frame 14) aimed so the victim crosses
   the corner while still rising. Bthrow at 9%: kb 81.5, launch 4.9 px/frame at 40 degrees, hitstun
   32, about 99 px horizontal during hitstun and about 100 px more while falling (01 closed forms),
   so a grab within about 60 px of the ledge sends them well past the grab region. A passive victim
   facing away never grabs the ledge; one facing the stage can grab if it enters the region while
   falling, and then hangs forever: after 40 frames the hang hurtbox is exposed and a poke launches
   them off again. Fall from ledge height to the lower blast line takes about 120 frames; a dair
   spike after the throw (jump off, dair startup 12) ends it in about half that, because the spiked
   velocity persists after hitstun. Expected: KO near frame 280 to 330.
2. Later stocks: the victim is unhittable for 240 frames (60 dead plus 180 on the platform;
   invulnerability runs concurrently and expires first), then falls from (0, -160) to the floor
   (about 60 frames, hittable in the air) and lands at center, 248 px from either ledge. Stand at
   x 0; grab on landing; forward-throw toward the nearer ledge (8%: about 200 px total travel, they
   land near x 190 to 200 standing, since kb 74 is below the tumble threshold); dash after them
   (about 70 frames, in parallel with their flight); grab; back-throw off; spike or let fall.
   Expected: about 240 + 60 + 17 + 70 + 24 + 130 = 540 frames per later stock with a spike.
3. Total: about 280 + 2 x 540 = 1,360 frames, 23 s. Without spikes about 1,450 frames.

This already beats the measured 2,025 to 2,786 frames (`docs/CPU_AEVALMERE.md`), which came from
a brain that races damage on a standing target.

### 13.3 Why 20 s needs a sim lever

`T = t1 + 2 * (60 + P) + 2 * t2` where `P` is the platform time a passive victim sits out and `t2`
is the center-to-KO route. With `P = 180` and `t2` about 300, `T` is about 1,360. To reach 1,200:

- `RESPAWN_PLATFORM_FRAMES` 180 to 100 saves 160 frames (about 1,200 with spikes). This is the
  cleanest lever; Ultimate's revival platform also drops after a few seconds without input
  (report 16 could not be run; the exact Ultimate value is unverified).
- A respawn point nearer a ledge, or spawns nearer the ledges, shortens `t2`.
- Higher `bkb` on throws at low percent shortens the drift-to-death.
- A gimp that does not need the ledge: a footstool on the falling respawn victim at x 0 pushes them
  down 120 px onto the stage, which does nothing; so the ledge carry is unavoidable at center.

State the choice in the tests (06): gate at 1,800 frames now, target 1,200 after the lever is set.
No brain change closes the gap on its own.

## 14. Execution

### 14.1 Executor stages

Per frame: reflexes, then plan continuation or a new decision, then the pre-buffered follow-up,
then the humanizer (identity for the god tier), then the guard, then emit. `pressed` and
`released` are derived in one place from `held` and the previous output frame; the sim rejects an
inconsistent frame. The tap mirror lives in output-frame coordinates (the frame the input will be
consumed at, `tick + inputDelay`), never read back from `dirTapAge`, so it is delay-invariant.

### 14.2 Reflexes (run outside search, claim the frame)

- Grabbed: mash, capped at one fresh bit every 2 frames (14.5); never Shield or Dodge (each starts
  the 40-frame tech lockout, and the throw launches into a tumble that needs the tech).
- Launched with hitstun above 1: drop the plan; emit nothing but the planned tech press.
- Tumbling toward the floor: predict the landing, arm the tech at 8 frames out, choose in place or
  roll by rollouts, hold the plan through the landing.
- Respawn: drop after 20 frames (the platform is safe but every frame on it is a frame not
  fighting; the god tier drops early, human tiers vary).
- Ledge: option chosen from hang frame 1 by 9.6 and 11.3 logic; leftover invulnerability is tracked.
- Shield floor: drop before HP 20.
- Buffer hygiene: in hitlag, hitstun and tumble, emit nothing except the tech press; the buffer
  keeps ageing through hitlag, so a press made early in a 10-frame hitlag expires before it ends.

### 14.3 Frame-perfect endings

Moves end at `totalFrames` or at `iasa` when a new action is requested. Press the follow-up at
`iasa - k` with `k` at most 6 (the buffer), and after a hit within the last 6 frames of hitlag; the
frame that ends hitlag is exact. Jump-cancel up smash: Jump on frame 0 and the up smash code on
frame 1 (test `bg` in `src/sim/selftest.ts`). Short hop: release Jump on squat frame 1. Direct move
codes for every smash and tilt so a flick is never misread; the smash's charge key is its own
direction for direct-coded smashes (`docs/SPEC.md` 4.3), which is why the existing `P_USMASH_C`
holds Up for 13 frames.

### 14.4 Perfect spacing and charge release

Ground movement is digital, so an exact stop is a search: for `k` in 0..30 clone, hold the
direction `k` frames, release, step until `vx` is 0, keep the `k` with least error; about 900 steps,
once per approach. In the air, alternate hold and neutral to trim drift. Smash charge: choose
`n = clamp(T_target - now - startup, 0, 60)` so the first active frame lands on the opponent's
committed frame (a ledge roll landing at frame 24, a getup at 23), and hold the charge key `n`
frames.

### 14.5 Mash and input-rate caps

The sim credits every distinct mash bit per frame; level 10 mashes four bits per frame and leaves a
grab in about 4 frames, which no human holder can pummel or throw against (report 20 table: 4
frames at 0% versus 60 with no mashing). Cap the god tier at one fresh bit every 2 frames (escape
in 20 frames at 0%, 38 at 100%), which is still above Ultimate's own input limits (same button every
2 frames, https://www.ssbwiki.com/Button_mashing) and leaves a holder who throws inside 11 frames a
chance. Ask the owner whether to close the sim loophole (`bitCount` credits simultaneous bits).

### 14.6 Determinism and randomness

All brain randomness comes from a counter-based hash keyed on (match seed, slot, input frame,
stream, k), not a sequential stream, so a skipped frame, a stall or a re-simulation never shifts
later draws (Random123 counter-based generators, https://www.thesalmons.org/john/random123/papers/random123sc11.pdf):

```ts
function u01(seed, slot, frame, stream, k = 0) {
  let h = (seed ^ Math.imul(slot + 1, 0x9e3779b1) ^ Math.imul(frame, 0x85ebca6b)
         ^ Math.imul(stream + 1, 0xc2b2ae35) ^ Math.imul(k + 1, 0x27d4eb2f)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
```

Golden-seed test: the same seed twice gives identical final-state hashes and identical
`(frame, held, pressed, direct)` streams per brain (06). Rollback engines have no CPU concept; the
CPU is an input source (https://github.com/pond3r/ggpo/blob/master/doc/DeveloperGuide.md), which is
what the LAN layer does today; keep it.

### 14.7 Off-thread search (optional)

If the budget must grow past what a frame allows: decide at tick `t` from the snapshot of `t - K`
in a Worker, apply at `t + d`, add `K + d` to the perception delay, fall back to plan continuation
and reflexes when the Worker is late. With `R = 4` and `d = 1`, `K = 3` frames of wall time (50 ms)
is available. Without it, the 3-frame replan cadence is what makes 2,600 steps affordable.

## 15. Three and four players

Target scoring per opponent: distance, their percent and stocks, their current vulnerability, our
kill options on them, their threat to us, whether someone else is already attacking them;
retarget with hysteresis (no flips inside 30 frames without a new event). Rollouts model the two
most relevant opponents' replies and treat the rest as "continue". Team terms: teammate damage
negative, saves (hitting a teammate back toward the stage) positive, no swings at teammates (the
harness test `ak` counts them). Ultimate's CPUs ignore CPU teammates and flock to any edgeguard
(https://www.ssbwiki.com/Flaws_in_artificial_intelligence); identical logic must run whether the
target is human or CPU.

## 16. What makes it feel like a god, and what to avoid

Feel: every hit is converted; the same mistake is never allowed twice; ledge and recovery choices
feel pre-empted; kills come at the percent the move data allows, from the position it forced;
neutral is never idle (the engagement clock) but never reckless (the certain-loss veto). Reads are
explainable after the fact because they are bets on evidence with a stated threshold.

Avoid: input reading (perception delay under 4 frames is not necessary and reads as cheating);
shielding on an opponent's first active frame (the early-shield gate); reflexive air dodges;
fixed wake-up, ledge and recovery timings; one projectile range; the same throw for every kill;
flocking to edgeguard when our own recovery cannot make it back; taunting; playing for a timeout.
Each of these is a documented Ultimate CPU tell (https://www.ssbwiki.com/Flaws_in_artificial_intelligence,
https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)).

## 17. Acceptance

The tests in 06 (cases `av`, `az`, `ba`, `bb` and the human-likeness gates) decide when this is
done. The skills checklist in 05 is the reviewer's list: every row marked "god" must be
demonstrable in a replay.
