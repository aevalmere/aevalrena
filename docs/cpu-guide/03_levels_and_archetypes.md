# 03. Levels and archetypes: fair, derivable, human-like CPUs

Four archetypes (aggressive, defensive, countering, balanced), five levels each. Balanced level 5
is the god CPU of 02. Every other CPU must play like a human of its level. This document defines
the two axes, the parameter tables, the derivation recipe, the calibration procedure, and the
rules that keep the traits visible at every level.

## 1. Two axes, one engine

Nintendo's Figure Players separate skill from style: the hidden CPU level sets reaction,
follow-through, mash rate and option vocabulary, while the amiibo behaviour values and the
recomputed personality label set style (https://www.ssbwiki.com/Figure_Player,
https://exionvault.com/2021/04/30/ssbu-amiibo-general/). Aevalrena does the same:

- Skill axis (level 1 to 5, plus god): perception delay, reaction variance, timing jitter, dropped
  inputs, decision temperature, option-menu size, option vocabulary, search budget, learning rate,
  exploit cap, deliberate-opening rate. Shared by all archetypes, so level N means one strength.
- Style axis (archetype): objective weights, risk (`lambda`, CVaR `alpha`), candidate filters and
  priors, reaction trigger (commitment-driven or clock-driven), spacing multiplier, bait-probe
  share, stall clock base, exploit bias. Independent of level.

`paramsFor(archetype, level)` is a pure function of the two. One engine (the search brain of 02)
runs every tier; the parameters degrade it. The rule-table brain in `src/ai/index.ts` (levels 1 to
9 today) is kept only as an optional fallback for levels 1 and 2 if a 4-to-6-plan menu looks
unnatural in playtests; its `reactMs` values for levels 3 to 9 (155 down to 17 ms, 9 down to 1
frames) are already below the human floor and would have to be replaced anyway (research report
07). Recommendation: one engine, and delete the rule brain once level 1 and 2 pass the blind test in
06.

Which level is "world's best": the owner's wording is that the tier just below god should play
like one of the best players in the world, and that the other archetypes' level 5 are ordinary
CPUs. Default mapping: rows casual, intermediate, advanced, top player, world's best for levels 1 to
5 of aggressive, defensive and countering; balanced uses casual, intermediate, advanced, world's
best, god. Balanced level 4 then equals the other archetypes' level 5 and the equal-level
cross-archetype test in 06 compares balanced L4 with the others' L5. A config flag can switch to the
uniform mapping (world's best at level 5 everywhere, god replacing only balanced 5) if the owner
prefers strictly comparable levels.

## 2. Skill axis

### 2.1 Reaction (perception and response)

Model (research report 07): per opponent event, sample once and cache by event key. `R = max(floor,
round(R_base + S_eff + b * H + stress + refractory - alert + SD * z))`, where `H` is the entropy in
bits of the CPU's predicted distribution over the opponent's options (capped at `optionsCap`), `S`
is a surprise term reduced by how strongly the predictor expected the cue (`S_eff = S * (1 -
min(1, p_cue / 0.6))`), and `z` is a unit-variance right-skewed draw (`0.7 * (Exp(1) - 1) + 0.7 *
N(0, 1)`) from the counter-based hash (02, 14.6). A better read means a faster reaction, which is
Hick's law used as intended (https://en.wikipedia.org/wiki/Hick%27s_law).

| Tier | P snapshot age | R_base mean (frames, ms) | R SD | Floor | Surprise S | Hick b (frames/bit) | Anchor |
|---|---|---|---|---|---|---|---|
| casual (L1) | 5 | 16 (267) | 3.0 | 10 | 6 | 8.0 | non-gamers 278 ms, casual players 249 ms in a browser reaction test of Ultimate players (https://digitalcommons.wku.edu/cgi/viewcontent.cgi?article=9254&context=ijesab) |
| intermediate (L2) | 5 | 15 (250) | 2.5 | 10 | 4 | 6.0 | same study; 265 ms single-stimulus figure (https://ki.infil.net/reaction.html) |
| advanced (L3) | 4 | 14 (233) | 2.2 | 10 | 3 | 4.5 | between casual and elite |
| top player (L4) | 4 | 13 (217) | 2.0 | 10 | 2 | 3.5 | elite players 225 ms in the same study |
| world's best (L5) | 4 | 12 (200) | 1.7 | 10 | 1 | 2.5 | claimed 180 to 190 ms for top players (unverified, https://ssbworld.com/blog/185/the-importance-or-lack-thereof-of-relative-reaction-time); sprinters 166 ms to a sound (https://en.wikipedia.org/wiki/Mental_chronometry) |
| god | 1 to 4, ship 4 | equals P | 0 | equals P | 0 | 0 | Melee agent at 2 frames (https://ar5iv.arxiv.org/html/1702.06230) |

Resulting means for common cases (single expected cue; one bit unprimed; two bits): casual 16, 30,
38; intermediate 15, 25, 31; advanced 14, 21.5, 26; top 13, 18.5, 22; world's best 12, 15.5, 18.
Population visual simple reaction time is about 213 ms hardware-corrected with a within-person SD
of 40 ms (https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2015.00131/full);
these rows sit on that evidence. A browser game has no console input lag (Ultimate adds about 6
frames, https://www.ssbwiki.com/Frame_delay), so Ultimate reactability folklore ("18 frames to
react to a tech") is 3 to 4 frames too slow for this game.

Two paths, kept separate: the reaction gate above applies to stimuli the CPU had no reason to
expect; the anticipation path acts on the predictor before the cue with no latency, and can be
wrong. A tier that reads well is not also given a reaction under the floor.

Modifiers: stress `s` in 0..1 (last stock, trailing, high percent): jitter x(1 + 0.35 s), lapse
x(1 + s), R + 2s, error rate x(1 + 0.5 s); alert (opponent in threat range and actionable):
R - 1; refractory: a second reaction within 9 frames of the first costs `(9 - delta) * k_prp`
(0.5 below world's best, 0.3 for world's best, 0 for god), after the psychological refractory
period (https://en.wikipedia.org/wiki/Psychological_refractory_period). All three are calibrated
proposals with sourced direction and unsourced magnitude.

What a tier can and cannot punish on reaction (Aevalrena frame data, 1-bit unprimed cue; the
number is the largest usable startup, "no" means the window closed): spot dodge tail (frames 18 to
22): no, no, no, 1, 4; roll tail (17 to 24): no, no, 0, 3, 6; air dodge exit (32 to 34): 2, 7,
10, 13, 16; ledge climb (29 to 30): no, 3, 6, 9, 12; tech in place (21 to 25): no, no, 2, 5, 8;
tech roll (21 to 39): 8, 13, 16, 19, 22; getup (23 to 29): no, 3, 6, 9, 12. So a level-3 CPU
covers tech rolls on reaction and must read spot dodges; a level-5 human catches a spot dodge only
with a 4-frame move, on the last frame. That is the mechanism by which levels feel different.

### 2.2 Execution

Timing error is Gaussian around the intended frame with SD `sigma_j`; a lapse is a skipped press.
For a window of width `w` aimed at its center, `P(hit) = (1 - lapse) * erf(w / (2 * sqrt(2) *
sigma_eff))` with `sigma_eff = sqrt(sigma_j^2 + 1/12)`.

| Tier | sigma_j | lapse | 1-frame drop | 2-frame | 3-frame (short hop) | 5-frame (smash flick) | 12-frame |
|---|---|---|---|---|---|---|---|
| casual | 3.0 | 4% | 87% | 75% | 63% | 43% | 8.5% |
| intermediate | 1.8 | 2% | 79% | 59% | 42% | 19% | 2.1% |
| advanced | 1.1 | 1% | 66% | 38% | 20% | 3.8% | 1.0% |
| top player | 0.7 | 0.5% | 51% | 19% | 5.2% | 0.6% | 0.5% |
| world's best | 0.4 | 0.2% | 31% | 4.5% | 0.4% | 0.2% | 0.2% |
| god | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

No published measurement of frame-window success rates for skilled players exists in the sources
read; the rows bracket the forum anchors (70% L-cancels after three months, 85% as a good-player
minimum, https://smashboards.com/threads/after-3-months-of-training.434576) and the qualitative
statement that 1 frame is the hardest window and 2 frames is consistently learnable
(https://critpoints.net/2016/08/19/frame-trainer-tool-how-long-are-frames/). Closed forms: `sigma_j
= 3.0 * 0.6^t`, `lapse = 0.04 * 0.5^t`, `t` = 0 for casual to 4 for world's best.

Implement jitter as a real timing offset of the emitted press (`round(N(0, sigma_j))` frames early
or late, never before the decision frame) and a lapse as a skipped press that the executor notices
and repeats, so success or failure comes out of the sim's real windows instead of a hidden coin
flip. Reaction-triggered presses use the reaction SD instead of `sigma_j`. Inputs timed off a long
known interval (waiting out a 30-frame climb) use `sigma_int = sqrt(sigma_j^2 + (k_W * interval)^2)`
with `k_W` 0.10 (casual) to 0.04 (world's best), a Weber-law proposal. Do not jitter inputs whose sim
window is 12 frames or wider at advanced and above (tech press, roll retap): the table shows the
drop is under 1.5%, so tech failures at those tiers are decision errors, not timing errors.

Human-style error catalogue (each at a level rate, from real Smash accidents, so mistakes look like
a person's, https://www.gamedeveloper.com/programming/intelligent-mistakes-how-to-incorporate-stupidity-into-your-ai-code):
dropped press (retried after `notice` frames), wrong-direction on a reversal within 8 frames of the
last reversal (delayed 1 to 3 frames or skipped), extra adjacent press, buffered leak (a press that
lands in the buffer window before actionability, the human mash that gets caught), accidental roll
from a double tap (allowed only at levels 1 to 3 through the guard's `accidentTolerance`). Never a
blunder no human makes (walking off the stage, taunting in hitstun).

### 2.3 Decision quality, menu and knowledge

| Knob | L1 | L2 | L3 | L4 | L5 | god |
|---|---|---|---|---|---|---|
| Temperature tau (softmax over near-best plans, `T = tau * (best - median)`) | 0.6 | 0.35 | 0.15 | 0.04 | 0.02 | 0 |
| Decision error rate (take a rank 2 to 3 plan) | 0.30 | 0.17 | 0.09 | 0.05 | 0.025 | 0 |
| Menu cap k (plans that compete) | 4 | 6 | 10 | 24 | all | all |
| Options cap (opponent replies considered) | 2 | 3 | 4 | 5 | 6 | all hypotheses |
| Plan hold (frames between replans) | 24 | 20 | 16 | 13 | 10 | 1 to 3 |
| Search steps per decision | 0 (static evaluation) | 300 | 800 | 1,600 | 2,600 | 2,600 to 8,000 |
| Sustained input events per second | 2.5 | 3.0 | 3.5 | 4.5 | 5.5 | uncapped (mash capped, 02 14.5) |
| Habit learning | none | none | gamma 0.98, z 1.96, n_min 10 | gamma 0.95, z 1.645, n_min 5 | gamma 0.95, z 1.645, n_min 5 (0.90/0.98 pair for changepoint) | gamma 0.90 and 0.98, z 1.282, n_min 4 |
| Exploit cap p_max | 0 | 0 | 0.3 | 0.6 | 0.6 | 0.75 plus gift budget |
| Deliberate opening rate (abandon a follow-up after winning an exchange) | 0.30 | 0.20 | 0.10 | 0.02 | 0.01 | 0 |
| Recognition of unusual move classes (multi-hit, command grab, invulnerable startup) | 0.3 | 0.5 | 0.7 | 0.9 | 0.95 | 1.0 |

Anchors: replanning every 20 to 26 frames for typical players and one counted action every 12 to
26 frames in hand-counted Melee APM (139 to 305 per minute,
https://smashboards.com/threads/apm-of-smashers-july-update-the-fastest-peach.234508/,
https://critpoints.net/2017/06/26/how-to-read-a-book-reads-in-competitive-games/); AlphaStar's
human-scale cap of 22 actions per 5 s (https://storage.googleapis.com/deepmind-media/research/alphastar/AlphaStar_unformatted.pdf).
The decision error never draws from a veto set (self-destructs, stock-losing plans).

Option vocabulary by level (what the candidate generator is allowed to offer; this is Brawlhalla's
named-technique tiers, https://brawlhalla.com/news/new-cosmetic-items-and-advanced-ai-patch-4-04,
applied to plan families):

- L1: walk, run, jump, jab, tilts, one aerial, grab and one throw, shield, basic recovery (jump then
  up special), no dodges on purpose, ledge climb only.
- L2: plus smashes (uncharged), spot dodge and roll, short hop aerials, all throws, ledge jump and
  roll, fast fall, tech (decision-gated).
- L3: plus combo-table follow-ups (depth 2), simple edgeguards (onstage trap, one offstage aerial),
  dash dance, charged smashes, projectile holds 0 and 60, ledge trap stance, tech chase by reaction
  on wide windows.
- L4: plus combo depth 4, kill confirms, spike routes, edge-hog, intermediate projectile holds,
  bait probes, landing traps, recovery mixups by matrix.
- L5: everything the god has, executed with the world's-best rows above.

Percent knowledge scales with level: the kill percent map (04) is read exactly at L4 and up; L3
reads it with a plus or minus 10% error; L1 and L2 do not use it (they throw kill moves when a
smash is "available", which is how casual players behave).

### 2.4 Which knobs are derived, not set

Punish rate, tech success, combo drop rate and edgeguard success are never set directly. They emerge
from `R`, `sigma_j`, the menu cap and the vocabulary, so a level cannot be "cheating in one
situation and dumb in another", which is the Nintendo complaint (02, 16). Test it: the measured
punish rate per tier must rise monotonically and match the feasibility table in 2.1.

### 2.5 Derivation from one scalar

Define `s` in [0, 1] per level (initial 0, 0.25, 0.5, 0.75, 1.0) and every knob as a stated curve
of `s`: `R_base = 16 - 4s`, `R_SD = 3.0 - 1.3s`, `sigma_j = 3.0 * 0.6^(4s)`, `lapse = 0.04 *
0.5^(4s)`, `tau = 0.6 * 0.03^s`, `k = round(4 * 6^s)`, steps `= 300 * 8.67^s` for `s > 0`, and so
on. Calibration (section 5) then bisects `s` per level instead of re-tuning twelve numbers. Nintendo's
own ladder is an irregular hand table (internal values 0, 15, 21, 31, 42, 48, 60, 75, 100,
https://www.ssbwiki.com/Artificial_intelligence); a curve is what makes levels "easy to derive".

## 3. Style axis: the four archetypes

Definitions map onto the FGC taxonomy in SSBWiki's glossary: rushdown (fast, combo-oriented
pressure) is aggressive; zoner, camping and turtling are defensive; bait-and-punish and counter
are countering; all-rounder is balanced (https://www.ssbwiki.com/SmashWiki:Glossary). Ultimate's
amiibo labels are the shipped precedent: eight groups of three plus Normal (defensive: Cautious,
Realistic, Unflappable; offensive: Enthusiastic, Aggressive, Offensive; the "Cool, Logical, Sly"
group waits out approaches and counters misses; Versatile, Tricky, Technician are the general
group) (https://exionvault.com/ssbu-amiibo-personality/, https://www.ssbwiki.com/Figure_Player).
The label is recomputed from behaviour values, never stored; Aevalrena should do the same for any
display label.

### 3.1 Parameter vectors (level 5; balanced = the god's true objective)

| Parameter | Aggressive | Defensive | Countering | Balanced |
|---|---|---|---|---|
| w_damageDealt | 1.0 | 0.8 | 0.9 | 1.0 |
| w_damageTaken | 0.6 | 1.6 | 1.2 | 1.25 (current) |
| w_frameAdvantage | 1.4 | 0.8 | 1.2 | 1.0 |
| w_stageControl | 1.2 | 0.7 | 0.6 | 1.0 |
| w_killProbability | 1.3 | 0.8 | 1.1 | 1.0 |
| w_zone (projectile wall) | 0.3 | 1.0 | 0.6 | 0.6 |
| lambda (weight on CVaR) | 0.35 | 0.80 | 0.60 | 0.50; 0.7 or more a stock ahead |
| CVaR alpha | 0.10 | 0.40 | 0.30 | 0.20 |
| Preferred spacing (x own poke reach) | 0.6 to 0.8 | 1.5 | 1.1 to 1.6 | adaptive |
| Candidate filter | all approaches; retreat only in kill range | zoning, retreat, platforms; approach only in kill range or when the lead is lost | hold spacing, shield, dodge, bait; commit only into opponent endlag, after a read above threshold, or when the stall clock expires | none |
| Tag bias up | poke, comboStarter, dash grab | projectile, oosOption, getOffMe, retreat aerials | oosOption, killMove as punish, whiff-punish moves | none |
| Reaction trigger | clock: force the best approach after 60 frames without a threat exchange | commitment plus zone timer | commitment: any opponent startup triggers a punish search | both, by rollouts |
| Bait-probe share | 0.05 | 0.10 | 0.30 | 0.10 |
| Stall clock base T0 (frames) | 210 | 720 | 540 | 420 |
| Shot band (share of range) | 0.15 to 0.6 | 0.55 to 1.0 | 0.4 to 0.85 | 0.3 to 0.9 |
| shootSafe margin (frames) | -6 (accepts trades) | +12 | +4, 0 when a punish plan is ready | +6 |
| Retreat after a shot (frames) | 0 | 20 to 30 | 10 | 10 |
| Predictor mix cap | 0.5 | 0.5 | 0.9 | 0.75 |
| Exploit bias | ledge and recovery habits | approach and shield habits | roll, spot dodge, air dodge habits | all, by LB - p* |
| Edgeguard willingness | high (offstage aerials, spikes) | low (onstage traps, walls, hog) | medium (trap, pre-grab hit) | by rollout |

Every value is a proposal to be calibrated with the signature test in 3.3; the "current" cells are
in the code today.

### 3.2 How each archetype reads on screen

- Aggressive: closes distance on a clock, initiates first, dives offstage, takes trades, uses
  point-blank pressure. On a zoner kit it fires to gain ground and runs in behind the shot (the
  Villager Lloid Rocket approach and Doramigi's Min Min are the documented models,
  https://www.ssbwiki.com/Villager_(SSBU), https://www.ssbwiki.com/Smasher:Doramigi). "Orb into
  grab" is a full-charge plan only (02, 12.1).
- Defensive: keeps maximum range, walls with projectiles and retreating aerials, shields and dodges
  more, takes little damage per minute, edgeguards from the stage, jumps to platforms to lengthen
  approaches. It has the longest stall clock but never an infinite one, and when cornered (under
  about 60 px of stage behind it) it switches to counter play instead of more shots.
- Countering: holds spacing, does not initiate, reacts to commitments: whiff punishes, out-of-shield
  punishes, anti-airs, covers rolls and spot dodges. Shots are bait. Dabuz's Rosalina and Olimar
  are the documented pattern (https://www.ssbwiki.com/Smasher:Dabuz). Its first-hit share is low
  and its whiff-punish share of openings is the highest.
- Balanced: each above by state. The god (balanced 5) uses the union of every candidate set with the
  true objective; at each decision its pick has true-objective value at least equal to any single
  style's pick under the same forward model, because that pick is in its set. Caveats: relative to
  the model, not a real human; finite horizons can under-value patience, which is why the stall
  clock and habit terms are inside the objective; per-decision dominance is not match-level proof.
  Test: balanced 5 wins at least 60% against each style's level 5 (06).

### 3.3 Visible-trait signatures

Measured per minute of frames where both fighters are actionable, against balanced at the same
level (b). Proposed bands; the acceptance test is the ordering, and measured values replace the
bands after the first scripted runs.

| Metric | Aggressive | Defensive | Countering | Balanced |
|---|---|---|---|---|
| Approaches per minute (closing 60 px or more within 30 frames, opponent not in hitstun) | 10 to 16 | 1 to 4 | 2 to 5 | 5 to 9 |
| Share of neutral frames inside own fast-move threat range | 0.45 to 0.65 | 0.10 to 0.25 | 0.25 to 0.40 | 0.30 to 0.45 |
| Shield share of grounded actionable frames | 0.03 to 0.07 | 0.12 to 0.22 | 0.10 to 0.18 | 0.06 to 0.12 |
| First-hit share of neutral exchanges | 0.50 to 0.60 | 0.40 to 0.50 | 0.40 to 0.50 | 0.55 to 0.70 |
| Whiff-punish share of openings (hit within 40 frames of an opponent whiff or endlag) | 0.10 to 0.25 | 0.30 to 0.45 | 0.50 to 0.70 | 0.30 to 0.45 |
| Damage taken per minute | highest | lowest | low | middle |
| Dodges per minute | 1 to 3 | 4 to 8 | 5 to 10 | 3 to 6 |
| Projectiles per minute (Aeval) | 3 to 8 | 15 to 30 | 5 to 12 | 8 to 15 |
| Offstage frame share | 0.03 to 0.08 | 0.005 to 0.02 | 0.01 to 0.03 | 0.02 to 0.05 |
| Mean neutral distance (x b) | 0.7 | 1.2 or more | 1.0 | 1.0 |

Ratio form for the gates (06): aggressive threat-range share 1.3b or more and shield share 0.6b or
less; defensive distance 1.2b or more, shield share 1.5b or more, projectile share 1.3b or more;
countering whiff-punish share 1.4b or more and neutral attack starts 0.75b or less; balanced within
15% of the mean of the other three on each feature. Traits must be present at every level from 2
up; level 1 is allowed to be noisy.

## 4. Humanizer and guard placement

Order per frame (02, 14.1): reflexes, plan, pre-buffered follow-up, humanizer, guard, emit. The
humanizer injects the level's errors on purpose; the guard enforces mechanical invariants
(consistent frame, one action press per frame, tap mirror, no presses in hitstun except the tech)
and an `accidentTolerance` per level. God has tolerance 0. Rates and seeds come from the
counter-based hash keyed on (seed, slot, event frame, stream), so rollback replays and golden seeds
agree. Human tiers also cap mash at Nintendo's ladder (none at L1 and L2, one press per 12 frames at
L3, per 3 frames at L5, https://www.ssbwiki.com/Button_mashing).

Two rules from the amiibo and CPU research that make a level feel like a person rather than a
weaker robot (https://www.ssbwiki.com/Flaws_in_artificial_intelligence,
https://exionvault.com/amiibo-wiki-ssbu-metagame/): keep a bait weakness at every human level (a
probability of committing to a punish on an empty hop, a shield poke or an intangible roll, falling
to 0 only for god), and keep recognition gaps for unusual move classes (2.3). Lower levels vary
wake-up, ledge and recovery timing by sampling with jitter; a fixed timing is the first thing a
player learns to punish.

## 5. Calibration and monotonicity

- Elo expected score `E = 1 / (1 + 10^(-D/400))`: 100 points is 64%, 200 is 76%, 382 is 90%
  (standard; the page was not fetched). Targets: adjacent human levels about 200 Elo apart (76%),
  L5 beats L4 at 90% or more, god beats every L5 with 0 stocks lost, same-level archetype pairs
  inside 40 to 60% (70 Elo).
- Matches for plus or minus 5 points at 95%: about 280 near p = 0.76, 138 near 0.90, 384 near 0.5.
  A sequential test (SPRT, H0 0.5 versus H1 0.65, alpha = beta = 0.05) accepts in about 64 matches
  on average (research report 32 arithmetic). Pair seeds, swap sides, score a timeout as half.
- Procedure: fix the archetype vector; play the round robin over levels with paired seeds on both
  stages; fit Bradley-Terry; bisect the skill scalar `s` per level until adjacent gaps are 200 plus
  or minus 30; reject any adjacent pair under 65%; repeat per archetype; then verify the equal-level
  cross-archetype band. Also test against the scripted adversaries, because self-play ratings can be
  non-transitive.
- Human calibration: a per-player rating from match outcomes and in-match signals (damage ratio,
  openings) recommends a level; Rivals of Aether II's Bot Match Lite steps the bot level up on a
  win and down on a loss (https://steamdb.info/patchnotes/16564997). No in-match rubber-banding:
  fixed knob vectors per level keep levels fair and derivable, and a mid-match strength change is a
  hidden handicap the player can detect as the CPU declining punishes; the only adaptation allowed
  inside a match is what the CPU models about the human.

## 6. Human-likeness gates

From replays (06 has the exact tests): reaction histograms per stimulus class with zero responses
under `R - 1` frames at human tiers and a median near `R + cadence`; input events per minute under
the tier cap; per-situation option entropy between 0.7 and 1.3 times a recorded human baseline;
repetition (share of the last 16 moves that are one move) under a bound; a blind test where judges
tag 30-second clips human or CPU and human tiers are tagged human as often as the average human
opponent (the BotPrize protocol; the 2012 winners reached 52% humanness against 40% for humans,
https://news.utexas.edu/2012/09/26/artificially-intelligent-game-bots-pass-the-turing-test-on-turings-centenary/).

## 7. Summary table: who is who

| Archetype x level | Reaction row | Style vector | What the player sees |
|---|---|---|---|
| Aggressive 1 to 5 | casual to world's best | aggressive | a rusher that gets better at closing, converting and not dying offstage |
| Defensive 1 to 5 | casual to world's best | defensive | a waller and turtle whose walls get safer and whose escapes get sharper |
| Countering 1 to 5 | casual to world's best | countering | a punisher whose reads and whiff punishes arrive earlier each level |
| Balanced 1 to 3 | casual to advanced | balanced | a rounded player |
| Balanced 4 | world's best | balanced | one of the best players in the world |
| Balanced 5 (Aevalmere) | god | true objective, all candidate sets | beyond human |
