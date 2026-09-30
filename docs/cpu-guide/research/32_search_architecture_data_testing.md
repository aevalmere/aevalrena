# Search architecture, data-driven character profiles and testing for the Aevalrena CPUs

Notation: `computed:` marks arithmetic I did from repo constants or standard formulas. `unverified:` marks claims I could not check against a page I fetched. Repo paths are relative to /home/claude/aevalmere/aevalrena. Reports 02, 07 and 20 are sibling reports in /home/claude/research.

## 1. Real-time search with a cheap forward model

### MCTS basics
- Selection, expansion, simulation with a default policy, backpropagation (https://repository.essex.ac.uk/4117/1/MCTS-Survey.pdf, Browne et al. 2012, section 3.1). UCB1 maximises mean reward plus sqrt(2 ln n / n_j); UCT uses Cp = 1/sqrt(2) for rewards in [0,1] (sections 2.4.2, 3.3.1). Every playout updates the tree, so a move is available at any time (section 3.4.2). Simultaneous moves count as hidden information, and EXP3 there gives mixed policies (section 4.8.10).
- Aevalrena: Aevalmere is flat Monte Carlo over macro-plans: one ply, no tree, no bandit allocation (docs/CPU_AEVALMERE.md). At 1.5 microseconds per step, 2,600 steps is about 3.9 ms `computed:`.

### FightingICE adaptations
- Platform: 60 fps, 16.67 ms per decision, observations 15 frames old, a supplied simulator as forward model, at most 56 actions per character (https://arxiv.org/pdf/2003.13949).
- Results: 2018 winner Thunder (MCTS with per-character heuristics); a finite-state-machine bot placed 8th. 2019: ReiwaThunder (minimax plus heuristics) first, RHEAPI (rolling-horizon evolution, policy-gradient opponent model) second (same paper).
- MCTS settings from the Ritsumeikan group: UCB1 C = 1, 60-frame rollouts, 16.5 ms per frame, expand after 10 visits, depth cap 10, 40 actions, random opponent actions in simulation (https://www.ice.ci.ritsumei.ac.jp/~ruck/PAP/ieeeToG-ishii21.pdf; the 2021 highlight-cues paper, not the persona paper). The persona paper's page holds only videos and a citation (https://www.ice.ci.ritsumei.ac.jp/~ruck/personaGPVs-cig2018.htm), so `unverified:` that personas are evaluation-weight sets and that depth was 2 to 3 (the 2021 cap is 10).
- Kim and Kim action table: 6 contexts (3 distance bands x air or ground), top 5 opponent actions per context (about 70% of observed actions), seeded from 100 games, used to draw opponent actions in rollouts. Over 200 games it won 86% against the sample MCTS, 76% against Ranezi, 40% against Thunder01 (2016 winner) (https://cilab.gist.ac.kr/hp/wp-content/uploads/publications/international_conference/2017/opponent_modeling_based_on_action_table_for_mcts-based_fighting_game_ai.pdf). The survey says a hand-built table struggled against complex opponents (https://arxiv.org/pdf/2003.13949).
- Thunder "predict the top 3 replies and simulate": `unverified:` no readable page found; docs/CPU_AEVALMERE.md attributes it to the 2020 competition slides.
- Aevalrena: the winning family is rollouts plus heuristics, not RHEA. Keep the flat design and spend surplus budget on a second ply and hidden-frame hypotheses.

### Hidden frames as an information set
- ISMCTS searches a tree of information sets, sampling one determinization per iteration. It targets strategy fusion (different choices in different determinizations of the same information) and non-locality (determinizations the opponent would avoid). Multi-observer ISMCTS beat determinized UCT in Phantom (4,4,4) and used 10,000 iterations per decision in Lord of the Rings: The Confrontation (https://eprints.whiterose.ac.uk/75048/1/CowlingPowleyWhitehouse2012.pdf, sections IV to VI).
- Mapping: the hidden data is the opponent's input over the last R frames (R = 4 for the god tier). That set is small enough to enumerate: nothing new; started move X k frames ago (k = 1..R); started shield, dodge or jump. Weight each by the predictor's probability given context, keep the top 4 to 6, replay each through the R frames, then apply the reply model. Open-loop plans cannot suffer strategy fusion.
- Aevalrena: the delay-window replay (docs/CPU_AEVALMERE.md) ties one hidden trajectory to each reply model; weight it by the predictor's probability that the action started in that window.
- Simultaneous choice: rollouts already form a payoff matrix M[plan][reply]; argmax against predicted replies is exploitable. Run regret matching over M (`unverified:` standard algorithm) and sample the mix when predictor confidence is low, best response when high.

### Risk-sensitive objectives
- CVaR at level alpha is the mean of the worst alpha share of outcomes; Rockafellar and Uryasev showed it can be minimised as a convex problem (https://risk.net/journal-risk/2161159/optimization-conditional-value-risk and https://ideas.repec.org/a/rsk/journ4/2161159.html, search hits, unread). For discrete replies with weights w_i and scores s_i: sort ascending by score, take weight until it sums to alpha (partial weight on the last reply), average.
- lambda x worst + (1 - lambda) x mean mixes CVaR near alpha 0 with alpha 1, and depends on which replies are in the set: one new low-weight model moves the minimum. The code patches this with an 8% weight floor and a 5% stock-loss veto (docs/CPU_AEVALMERE.md). CVaR_alpha on the weights removes both thresholds: a reply of weight w below alpha contributes w/alpha of the tail.

### Budget, determinism and Workers
- Budget in sim steps, never wall-clock: a clock ties output to machine load and breaks golden seeds. The LAN host runs CPUs and sends their inputs (report 20), so peers need no reproduction of the brain; tests do.
- No allocation per frame: pooled state ring, generated monomorphic fighter copier, 400 warm-up frames before frame 0 (37 ms warm, 170 to 190 ms cold), steady p99 1.2 to 1.9 ms (docs/CPU_AEVALMERE.md).
- Worker brain: a message round trip has no fixed latency. Decide at tick t from a snapshot of tick t-K, apply at t+d whatever the wall-clock, fall back to plan continuation and reflexes on a late reply, and add K+d to the perception delay. GGPO has no CPU concept: state must follow inputs alone, with RNG and clocks kept out, so a CPU is one more input source (https://github.com/pond3r/ggpo/blob/master/doc/DeveloperGuide.md, read via report 20, not re-fetched).
- Math: many Math functions have implementation-dependent precision, and results can differ between browsers and between OS or architecture on one engine (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math). `unverified:` the ECMAScript wording that + - * / and sqrt are exactly rounded IEEE-754 operations while sin, cos, exp, pow and log are implementation-approximated; I did not fetch the spec. src/sim/hits.ts already calls Math.cos and Math.sin for launch direction, so the sim carries this risk. The brain should add none: no exp, pow, log, tan or atan2 in decision code.

### Critique of the current Aevalmere design
1. 115 candidates, one ply. FightingICE bots pick from 40 to 56 actions. Prefilter by affordance to about 25: 25 plans x 3 to 5 replies x 30 frames is 2,250 to 3,750 steps `computed:`, which leaves room for a second ply on the top 5 after a hit lands.
2. Reply models. The top-5 table lost to the best bot, so keep the 25% fixed habit models and draw the rest from the predictor distribution (stratified, counter-hash seeded).
3. Horizons of 16 to 60 frames. FightingICE scores every candidate over the same 60 frames. Unequal horizons let long plans collect terms short plans cannot. Pad every rollout to a common window (about 45 frames) with the neutral continuation, and use 60 or more only for kill plans.
4. 2,600 steps. Full decisions have a p99 near 2 ms in a 16.7 ms frame; raise the god tier toward 8,000 steps only if p99 stays under about 8 ms on the slowest target device.
5. Lambda 0.55 and the 5% veto. Make lambda an archetype parameter and prefer CVaR. Weights of 4.9% and 5.1% give opposite veto decisions and loss size is ignored; keep a hard veto only for a certain loss (weight 0.5 or more) and price the rest as expected stock loss times the KO bonus already used (400 to 520 points).
6. 4-frame delay replay. It matches the FightingICE method and the Phillip result that 2 to 4 frames stays strong (docs/CPU_AEVALMERE.md). Human tiers need a larger R, stimulus-specific (part 2), plus the enumeration above.

## 2. Architecture

### Layers, utility, trees
- SmashBot's README names Strategies (baiting), Tactics (edgeguarding) and Chains (wavedash, jump-cancelled up smash), one directory each, driving Melee through libmelee controller presses (https://github.com/altf4/SmashBot). docs/CPU_AEVALMERE.md, citing pages I did not read, adds a Goals layer and a punish gate (hitstun left against frames the punish needs).
- Utility AI: score each option in 0..1 per consideration through a response curve (x/m, (x/m)^k, logistic, piecewise linear), average or multiply (a product makes one consideration a veto), weight considerations to express personality, then take the maximum or a weighted random among the top N (https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter09_An_Introduction_to_Utility_Theory.pdf). Dave Mark's Infinite Axis Utility System adds a compensation factor for products of many considerations; `unverified:` formula not read.
- Dual utility (Dill): each option has a rank and a weight; drop zero-weight options, keep only the top rank, drop options far below the best weight, then choose by weight-random (https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter03_Dual-Utility_Reasoning.pdf).
- Behavior trees against HFSMs: a 2024 comparison finds BTs more modular and reactive (a Running status allows preemption) and FSMs prone to transition tangles; in its five-item retrieval task, adding a recharge behavior cost graph-edit distance 6 in the BT and 26 in the FSM (https://arxiv.org/html/2405.16137v1). It is a robotics paper.
- Aevalrena: deliberation is a scored choice, so use neither. Use a fixed-priority selector (a BT fallback node) only in the executor: reflex, then running input program, then new decision.

### Shipped disclosures
- Killer Instinct Shadow AI records movements, jumps, blocks, counters and combos with match state (health, meters, distance, time), finds situations by nearest-neighbour matching over 40+ metrics, sometimes takes a lower-ranked retrieved action, keeps up to 40 matches per opponent at 400 to 700 patterns each, and adapts mid-match when punished repeatedly (https://gamedeveloper.com/programming/the-killer-groove-the-shadow-ai-of-killer-instinct). I did not reach the GDC talk; https://gdcvault.com/play/1022992/Designing-AI-for-Competitive came up (title only, `unverified:` that it is that talk).
- Tekken Ghost: no source read; docs/CPU_AEVALMERE.md summarises Tekken 8 Super Ghost as an action model cloned from one player.
- Rivals of Aether: the default CPU runs from ai_init.gml and ai_update.gml, picks attacks at random from per-character arrays keyed by target position (far_up, far_down, far_side, mid_side, close_up, close_down, close_side, neutral), exposes ai_target, ai_recovering, temp_level (1 to 9) and ai_state, and lets a character override recovery (https://rivalslib.com/workshop_guide/programming/reference/scripts/ai_scripts).

### Proposed stack
Per decision tick:
1. Perception: clone of S(t-R) rolled forward with own known inputs, plus hidden-frame hypotheses.
2. Affordance and threat computer, from move data and geometry. Per own move: frames until it can hit, safe-on-shield flag, kill percent here. Per opponent move: the frame a hit would arrive on if we stay, and which escapes beat it. Output: Situation (neutral, advantage, disadvantage, opponent in hitstun, opponent offstage, ledge, we offstage) and Affordances.
3. Candidate generator: Situation gives allowed tags; tags give plan templates (approach, poke, punish, combo follow-up, kill, edgeguard, defend, recover). Prefilter to at most 25 by affordance.
4. Evaluator: outcome vector o (damage dealt, damage taken, stock difference, kill proximity, frame advantage, stage control, shield health, time) from rollouts or a static estimate; score = w . o.
5. Selector: rank and veto tiers, CVaR_alpha with lambda, expected stock-loss price, softmax over near-best options.
6. Humanizer: R (step 1), replan cadence, timing jitter, dropped presses, near-best noise, press-rate cap.
7. Executor: input programs with frame guards, plus prioritised reflexes (grab mash, tech, respawn drop, ledge).

### One stack, all tiers
`paramsFor(archetype, level)` is a pure function over two axes. Skill (R, cadence, search steps, jitter, temperature, predictor use) is shared by all archetypes, so level N means one strength. Style (weights, tag bias, risk, spacing) belongs to the archetype. Balanced level 5 uses the god row; level 5 of the other archetypes uses row 5. Values are proposals except the "now" cells and the god reaction of 4 frames; R follows report 07 (elite browser reaction about 13.5 frames, expected stimuli 10 to 13).

| Level | R frames | Replan every | Search steps | Jitter SD (frames) | Temperature | Predictor use |
|---|---|---|---|---|---|---|
| 1 | 26 | 12 | 0 (static) | 2.0 | 1.0 | 0 |
| 2 | 20 | 9 | 300 | 1.4 | 0.6 | 0.1 |
| 3 | 16 | 6 | 800 | 1.0 | 0.35 | 0.3 |
| 4 | 13 | 4 | 1,600 | 0.6 | 0.2 | 0.6 |
| 5 | 11 | 3 | 2,600 | 0.35 | 0.1 | 0.9 |
| god | 4 | 1 to 3 | 2,600 to 8,000 | 0 | 0 | 1.0 |

| Style parameter | Aggressive | Balanced | Defensive | Countering |
|---|---|---|---|---|
| damage-taken weight | 0.8 | 1.25 (now) | 1.6 | 1.4 |
| frame-advantage weight | 1.3 | 1.0 | 0.8 | 1.2 |
| lambda | 0.30 | 0.55 (now) | 0.75 | 0.65 |
| CVaR alpha | 0.10 | 0.20 | 0.35 | 0.25 |
| spacing (x own poke reach) | 0.8 | 1.1 | 1.5 | 1.6 |
| tag bias up | poke, comboStarter | none | projectile, oosOption, getOffMe | oosOption, killMove punish |
| predictor mix cap | 0.5 | 0.75 (now) | 0.5 | 0.9 |

## 3. Character-aware, data-driven design

### Derived numbers (from CharacterDef, MoveDef, TUNING, StageDef)
- `startup = min(hitbox.start)` (projectile-only moves: min spawnFrame); aerials from the ground add `jumpSquat`; charged moves add charge frames. `activeEnd = max(hitbox.end)`.
- `R(m, f)`, own lag left after a hit on move frame f: `(iasa ?? totalFrames) - f - 1`; an aerial that lands pays `landingLag`. Whiff window: `(iasa ?? totalFrames) - activeEnd - 1`.
- Reach: `front = max(x + r)`, `back = -min(x - r)`, `up = -min(y - r)`, `down = max(y + r)`; projectiles `x + vx * lifetime + r`. Aeval ftilt reaches 80 px, dash attack and fsmash 102 px (src/characters/aeval/moves.ts comments).
- Safety on shield: `T = floor(0.6 d) + 2` (src/core/constants.ts), `advShield = T - R(m, f)`. The defender's fastest attacking out-of-shield option has startup `S_oos = min(grab 7, usmash, uspecial, jumpSquat + aerial)` (grab active frames 7 to 8 per BRIEF.md). Call the move safe when `R <= T + S_oos`. Aeval `computed:` from its move data: jab T 3, R 9, safe by 1 frame; dtilt T 5, R 12, margin 0; ftilt T 6, R 15, unsafe by 2. The off-by-one convention is unconfirmed, so store a measured value: a shielding sim defender presses its best out-of-shield option on its first free frame; record whether the attacker is hit.
- Knockback (src/sim/hits.ts; p = percent after the hit, w = weight): `kb = (((p/10 + p*d/20) * 200/(w+100) * 1.4) + 18) * kbg/100 + bkb`. Hitstun `floor(0.4 kb)`, tumble at kb 80 or more, launch speed `0.06 kb` px/frame decaying 0.051 per frame in hitstun (src/core/constants.ts). `computed:` Aeval fsmash (damage 15, bkb 19, kbg 46) on a weight-88 victim at 100%: kb 85.5, hitstun 34, 5.1 px/frame, 146 px of travel inside hitstun. That travel is a lower bound because flight continues, so the sim decides.
- Kill percent by probe: per move (strongest hitbox group) and spot (centre stage, ledge, off the stage below it), bisect victim percent in [0, 250] through the real hit path with an idle victim; KO means crossing the blast rect. Repeat with a scripted best-recovery victim for `killPctRecover`. Cost 22 x 3 x 9 x 200 steps, 0.18 s `computed:`.
- Combo potential: `W(m, p) = floor(0.4 kb(p)) - R(m, f)`. A follow-up g is a true combo when `startup(g)` (plus jump squat for aerials) is at most W and g reaches the victim (rule in docs/CPU_AEVALMERE.md, from https://www.ssbwiki.com/Hitstun, not re-read).
- Recovery `computed:` by frame integration for Aeval: jump rise 99.9 px over 36 frames, double jump 85.8 px over 34, short hop 42.6 px. Up special rise and drift come from `MoveDef.velocity` or a probe. Store a recover box (dx, dy from the ledge) found by simulating recovery policies on a grid; cells outside it are the edgeguard zone.

### Tag rules
- `poke`: ground normal or fast aerial, startup 9 or less, measured safe on shield, front reach 0.75 or more of the longest ground normal.
- `antiAir`: up reach at least 0.6 of hurtbox height or angle in [60, 120], startup 12 or less.
- `comboStarter`: W at least the smallest follow-up startup at some p up to 40. `extender`: R 15 or less and the same test at p in [40, 100].
- `killMove`: kill percent at centre stage at most 130, or at the ledge at most 100 (tunable).
- `spike`: air move with any hitbox angle in [230, 310] (HitboxDef: 90 is up).
- `gimpTool`: spike, or a projectile crossing the recover box (reach 150 or more), or offstage kill percent 30 below centre.
- `oosOption`: in the sim's out-of-shield list (jump, grab, up smash, up special, roll, spot dodge) with startup 12 or less.
- `ledgeTrapTool`: probe the four ledge options (climb, jump, attack, roll) from three spacings; tag when it hits two or more with R 25 or less, or a projectile lives 60+ frames.
- `projectile`: MoveDef.projectiles present. `getOffMe`: covers behind or both sides, startup 8 or less, R 20 or less. `recovery`: helplessAfter or invuln, or upward velocity keys totalling 40 px or more.

### Schema and procedure
```ts
type MoveTag = 'poke'|'antiAir'|'comboStarter'|'extender'|'killMove'|'spike'|'gimpTool'
  |'oosOption'|'ledgeTrapTool'|'projectile'|'getOffMe'|'recovery';
type KillPct = { center: number; ledge: number; offstage: number };   // NaN = no kill by 250
interface MoveAiInfo {
  id: MoveId; tags: MoveTag[];
  startup: number; activeEnd: number; endlag: number; landingLag: number;
  reach: { front: number; back: number; up: number; down: number };
  maxDamage: number; advShield: number; safeShield: boolean; measured: boolean;
  killPct: KillPct; killPctRecover: KillPct;
  starterWindow: number[];                       // W at p = 0, 20, ..., 200
}
interface RecoveryProfile { rise: number[]; upSpecialRise: number; helpless: boolean;
  recoverBox: { dx: number; dy: number }[] }
interface CharacterAiProfile {
  charId: string; dataHash: string;              // cache key over CharacterDef and TUNING
  derived: { moves: Record<MoveId, MoveAiInfo>; recovery: RecoveryProfile };
  overrides?: { tags?: Partial<Record<MoveId, { add?: MoveTag[]; remove?: MoveTag[] }>>;
                numbers?: DeepPartial<CharacterAiProfile['derived']>; comboLists?: MoveId[][] };
}
function deriveAiProfile(def: CharacterDef, stage: StageDef, tuning: typeof TUNING): CharacterAiProfile
```
`deriveAiProfile`: (1) hash inputs, return a cache hit; (2) timing and reach per move; (3) shield safety by sim probe; (4) kill probes per stage spot; (5) W tables; (6) recovery grid; (7) tag rules, then `overrides` (hand values win, and a test flags one that contradicts a derived value beyond a margin); (8) freeze and cache. Only steps 4 and 6 depend on the stage.

### Matchup brackets
Kill percent scales with defender weight through 200/(w+100): 1.064 at weight 88, 1.0 at 100, 0.889 at 125, so a 125 defender takes 16% less of the percent term than an 88 one `computed:`. Per pair (A, B), let K = the lowest `killPct.center` among A's reliable killers at B's weight. Bracket edges `[0, 0.3K, 0.6K, 0.85K, K]` replace the fixed 0-30, 30-60, 60-100, 100+ of docs/CPU_AEVALMERE.md. A starter's usable range is the percents where `starterWindow` meets the follow-up threshold.

### How others do it
- Rivals hand-authors position-keyed attack arrays per character and picks at random inside them (URL above). Aevalrena can fill them from tags: far = projectile, gimpTool; mid_side = poke; close_up = antiAir; close_down = low or spike moves; neutral = getOffMe.
- Ultimate: report 02 lists per-fighter `attack_data_param.prc` and `attack_list_param.prc` under `fighter/<name>/ai/param/`, shared `fighter/common/ai/param/*.prc` files (personality, amiibo learning), and about 69 `base_ratio_*` labels plus character-specific ones such as ryu (https://github.com/ultimate-research/archive-hashes and https://github.com/ultimate-research/param-labels, not re-fetched). File contents are unverified. The shape is shared logic, a per-character attack list and a few named ratios; `deriveAiProfile` supplies the first two, `overrides` the third.

## 4. Evaluation and testing

### Win-rate statistics
- Report an N x N win-rate matrix with a Wilson interval per cell. Wilson 95% for k wins in n: `center = (p + z^2/2n)/(1 + z^2/n)`, `half = z*sqrt(p(1-p)/n + z^2/4n^2)/(1 + z^2/n)`, z = 1.96 (standard formula; properties in https://arxiv.org/pdf/2109.12464, search hit, unread). `computed:` 10/10 gives [72.2%, 100%]; 20/20 83.9%; 50/50 92.9%; 100/100 96.3%; 60/100 [50.2%, 69.1%]; 120/200 [53.1%, 66.5%]. The current 10/10 gates prove only 72% or better; a 95% lower bound needs 73 wins in 73.
- Matches for a 10-point difference `computed:` (normal approximation, alpha 0.05 two-sided, power 0.8): 60% against 50% takes 194 matches in one sample, 387 per group for two independent samples; 65% against 50% takes 85; 55% against 50% takes 783. A Wilson half-width of 5 points at p = 0.5 needs 381 matches, 10 points needs 93.
- Sequential gate `computed:` (Wald SPRT, alpha = beta = 0.05, H0 p = 0.5, H1 p = 0.65): a win adds 0.262 to the log-likelihood ratio, a loss subtracts 0.357, stop at plus or minus 2.944; expected 64 matches under H1, 62 under H0. Pair seeds, swap sides, score a timeout as half a win.

### Ratings
- Elo win probability `1/(1 + 10^(-D/400))` (`unverified:` not fetched). `computed:` 60% is 70 points, 64% is 100, 76% is 200, 91% is 400. Target 100 points per level within an archetype: adjacent win rate 64%, level 1 against 5 about 91%. The standard error of a gap at p = 0.64 is 36 points at n = 100, 26 at 200, 18 at 400 `computed:`, so resolving 100-point steps needs 200 or more matches per pair.
- Fit Bradley-Terry by maximum likelihood over the round robin (Elo scale). Bot strength is static, so Glicko-2 and TrueSkill (https://en.wikipedia.org/wiki/TrueSkill, search hit) add little over Wilson intervals; `unverified:` I read neither.

### Metrics
- Slippi: the slippi-js README shows only `getStats()` with no definitions (https://github.com/project-slippi/slippi-js), so define them in the harness from `hit` events and FighterStats (src/core/types.ts). Opening: first hit on a victim free and unhit for 45 frames (Slippi's convention per docs/CPU_AEVALMERE.md, not re-read). openingsPerKill = openings / KOs; damagePerOpening = damage / openings; neutral win = an opening from neutral; IPM = press events per minute.
- Human likeness, from replays:
  - Reaction histogram: per stimulus class (opponent attack's first active frame in reach, projectile spawn), latency to the first response input; report the count under 6 frames and the median.
  - Press rate per minute and repetition (share of the last 16 moves that are one move); cap press rate by tier (report 07 lists Melee humans at 139 to 305 APM by hand count).
  - Option entropy `H = -sum p log2 p` per situation bucket; the 2021 Ritsumeikan paper used Shannon action variety, 3.87 against 3.21 and 2.79 for three AIs (https://www.ice.ci.ritsumei.ac.jp/~ruck/PAP/ieeeToG-ishii21.pdf).
- Blind protocol, after BotPrize: judges tagged players as human or bot and rated humanness; in 2012 UT^2 and MirrorBot each reached 52% against 40% for the human players, and UT^2 used human-trace modelling plus neuroevolution with accuracy limits (https://news.utexas.edu/2012/09/26/artificially-intelligent-game-bots-pass-the-turing-test-on-turings-centenary/). For Aevalrena: unlabeled 30 s clips, human against CPU tiers, judge picks human or bot. About 43 judgments per condition give a Wilson half-width near 15 points `computed:`. Pass: judged human as often as the average human opponent, within that interval.
- Style signatures against balanced at the same level (b); proposed, not measured, calibrate on level 3 first:
  - Aggressive: neutral frames within 1.2 x own longest ground reach 1.3b or more; attack starts per minute 1.25b or more; shield-time share 0.6b or less.
  - Defensive: mean neutral distance 1.2b or more; shield-time share 1.5b or more; projectile share of attack starts 1.3b or more.
  - Countering: damage from hits within 40 frames of an opponent whiff or end lag 50% or more of its total and 1.4b; neutral attack starts per minute 0.75b or less.
  - Balanced: each feature within 15% of the mean of the other three.

### Adversaries and gates
- Scripted adversaries (fixed policies in src/ai/aitest.ts): roll spammer, projectile camper, shield-grab turtle, rushdown masher, ledge camper, jump-happy; add a stationary dummy and the level 0 wanderer.
- Gates: golden seeds (same seed twice gives identical final-state hash and identical `(frame, held, pressed, direct)` streams per brain); level N+1 beats N; zero self-destructs (FighterStats.sds); kill speed; p99 ms per call.
- Kill-speed arithmetic `computed:` an idle victim is unhittable for 60 dead + 180 platform + 120 invulnerable = 360 frames after each KO (canBeHit in src/sim/hits.ts returns false for dead and respawn actions; constants.ts sets RESPAWN_PLATFORM_FRAMES 180 and RESPAWN_INVULN 120; `unverified:` that the respawn action spans the whole platform time). A 20 second three-stock win (1,200 frames) leaves 480 hittable frames, 160 per stock, about 37% per second to reach 100%. The measured rate is about 6% per second and three-stock times are 2,025 to 2,786 frames (docs/CPU_AEVALMERE.md). The target needs kill routes far faster than a 100% damage race (the Final Smash rule, kills below 60%). Gate at 1,800 frames now, target 1,200.

### New cases for 4 archetypes x 5 levels (ids continue after `as`)
| Id | Test | Pass |
|---|---|---|
| at | Ladder: each archetype, level k+1 vs k, k = 1..4, both stages, 100 matches, paired seeds, sides swapped | SPRT (0.5 vs 0.65) accepts H1, or Wilson lower bound 0.55 or more at n = 200 |
| au | Equal level across archetypes: 6 pairs x levels 1..5 (balanced 5 excluded), 100 matches | win rate in [0.40, 0.60] at levels 1 to 2, [0.35, 0.65] at 3 to 5 |
| av | God (balanced 5) vs the 19 other CPUs, 73 matches each, both stages | 0 losses, 0 SDs (95% lower bound); at most 0.5 stocks lost per match against level 5s |
| aw | Reaction floor: 20 matches per human tier | 0 responses under R-1 frames (levels 1 to 4, non-balanced 5); median latency R to R + cadence + 1 |
| ax | Style signature per archetype, levels 2 to 5 | thresholds above, present at every level |
| ay | Human baseline: 20 recorded human matches, per-bucket entropy H_h | CPU entropy 0.7 to 1.3 x H_h below god; blind test above |
| az | Scripted adversaries: 6 x 20 brains, 30 matches each | win rate 50% level 1, 70% levels 2 to 3, 85% level 4, 90% non-god 5; god 30/30, 0 stocks lost (lower bound 88.6%); 0 SDs from level 3 |
| ba | Kill speed vs stationary dummy, 5 seeds x 2 stages | median 3-stock time falls with level within each archetype; god 1,800 frames or less, target 1,200 |
| bb | Determinism and cost: 20 brains x 3 seeds x 2 stages | identical hashes and streams; god p99 4 ms or less, mean 0.15 ms or less after warm-up (now 1.99 and 0.062); first call 2 ms or less |

## Open questions
- The first-actionable-frame convention after iasa, which the shield-safety probe must settle.
- Every table value except the "now" cells and the god reaction of 4 frames is a proposal awaiting measurement.

## Sources
Fetched by me:
- https://repository.essex.ac.uk/4117/1/MCTS-Survey.pdf : MCTS survey. Fetched.
- https://arxiv.org/pdf/2003.13949 : FightingICE survey. Fetched.
- https://eprints.whiterose.ac.uk/75048/1/CowlingPowleyWhitehouse2012.pdf : ISMCTS. Fetched.
- https://cilab.gist.ac.kr/hp/wp-content/uploads/publications/international_conference/2017/opponent_modeling_based_on_action_table_for_mcts-based_fighting_game_ai.pdf : action table. Fetched.
- https://www.ice.ci.ritsumei.ac.jp/~ruck/PAP/ieeeToG-ishii21.pdf : MCTS settings, entropy. Fetched.
- https://www.ice.ci.ritsumei.ac.jp/~ruck/personaGPVs-cig2018.htm : persona page, no technical content. Fetched.
- https://github.com/altf4/SmashBot : layer names, layout. Fetched.
- https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter09_An_Introduction_to_Utility_Theory.pdf : utility AI. Fetched.
- https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter03_Dual-Utility_Reasoning.pdf : dual utility. Fetched.
- https://arxiv.org/html/2405.16137v1 : BT against FSM. Fetched.
- https://gamedeveloper.com/programming/the-killer-groove-the-shadow-ai-of-killer-instinct : Killer Instinct. Fetched.
- https://rivalslib.com/workshop_guide/programming/reference/scripts/ai_scripts : Rivals CPU. Fetched.
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math : Math precision. Fetched.
- https://news.utexas.edu/2012/09/26/artificially-intelligent-game-bots-pass-the-turing-test-on-turings-centenary/ : BotPrize 2012. Fetched.
- https://github.com/project-slippi/slippi-js : README, no stat definitions. Fetched.

Read via a sibling report or repo doc, not re-fetched:
- https://github.com/pond3r/ggpo/blob/master/doc/DeveloperGuide.md : GGPO input-only state (report 20).
- https://github.com/ultimate-research/archive-hashes and https://github.com/ultimate-research/param-labels : Ultimate AI param files (report 02).
- https://www.ssbwiki.com/Hitstun : true-combo rule (docs/CPU_AEVALMERE.md).
- Repo files read: docs/CPU_AEVALMERE.md, src/core/types.ts, src/core/constants.ts, src/sim/hits.ts, src/characters/aeval/moves.ts. Reports read: 02, 07, 20.

Search hits only, unread:
- https://risk.net/journal-risk/2161159/optimization-conditional-value-risk and https://ideas.repec.org/a/rsk/journ4/2161159.html : Rockafellar and Uryasev CVaR.
- https://arxiv.org/pdf/2109.12464 : Wilson score interval.
- https://en.wikipedia.org/wiki/TrueSkill : TrueSkill.
- https://gdcvault.com/play/1022992/Designing-AI-for-Competitive : possible GDC talk, unconfirmed.
