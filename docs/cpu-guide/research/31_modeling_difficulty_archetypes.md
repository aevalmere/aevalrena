# Opponent modeling, difficulty scaling and playstyle archetypes

Tags: `[C]` is a calibrated estimate or arithmetic done in this report, not a measurement. `unverified:` marks a claim I could not read a source for. Sibling reports are cited by file name: 02 (amiibo), 07 (reaction and motor limits), 21 (zoning levers). The search and fetch budget was capped, so some sources were seen only as titles; the Sources section says which.

## 1. Opponent modeling

### 1.1 Context-conditioned n-grams and back-off

- Game AI Pro chapter 48 (n-grams): slide a window over the opponent's action stream, count each length-N pattern, and predict the Nth event from the most frequent match of the previous N-1. Storage is E^N patterns (E = 10, N = 6 is about one million). Smoothing is add-one, `P = (count + 1) / (matches + E)`. Forgetting is a bounded queue plus a bonus for recently completed patterns. It sets no minimum-observation rule and says to ignore predictions when tracked accuracy is poor (https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter48_Implementing_N-Grams_for_Player_Prediction_Proceedural_Generation_and_Stylized_AI.pdf). The fetch tool credited the text to "Vasquez", not Rabin (Rabin edits the series); byline unconfirmed. The chapter uses add-one smoothing, not Witten-Bell.
- Witten-Bell back-off (standard NLP formula, unverified: no page read): `P(a|h) = (c(h,a) + T(h) * P(a|h')) / (c(h) + T(h))`. `T(h)` is the number of distinct actions seen after context `h`; `h'` is `h` with its least predictive feature dropped. The weight on the specific context is `c(h)/(c(h)+T(h))`, so a context seen 4 times with one distinct action gets 0.8. That is fast trust, which is why betting on a prediction needs its own gate (1.4).
- Decay: on each observation in a context, multiply that context's counts by `gamma`, then add 1. Steady-state effective sample is `1/(1-gamma)` and half-life is `ln 0.5 / ln gamma` observations (computed): gamma 0.98 gives 50 and 34, 0.95 gives 20 and 13.5, 0.90 gives 10 and 6.6, 0.85 gives 6.7 and 4.3.

Aevalrena: `docs/CPU_AEVALMERE.md` already has 30 action classes, order 1 and 2 tables keyed by situation x7, distance x4, own state x3, last action and phase x4 (Witten-Bell), decay 0.97 per observation in the row, six components with 0.9-decayed hit rates mixed by hit rate squared, and a 190 KB profile capped at 60 observations per row. Additions worth making: percent bucket and stage zone as back-off-first features, per-level `gamma`, and sections 1.4 to 1.6.

### 1.2 Mixture of predictors scored by recent success

- Iocaine Powder won the RoShamBo programming competition. My fetches of Dan Egnor's write-up failed (http://www.ofb.net/~egnor/iocaine.html returned 404; an archive copy was blocked), so this is from memory and unverified: many predictors (frequency, longest-history match at several lengths), each wrapped in meta-strategies that assume the opponent predicts us with the same predictor and counter that (second-guess, third-guess), all scored by decayed recent success, top scorer plays. The transferable part is the structure: a predictor bank, an "opponent is reading me" layer, selection by recent success.
- Procedure `[C]`: (1) predictors emit distributions over opponent options: order 0, order 1, order 2, situation key with back-off, echo, win-stay/lose-shift, cycle (period 2 to 4), counter-me (opponent answers the CPU's most frequent recent option), persisted prior; (2) after each opponent choice, `s_j = rho * s_j + log q_j(actual)`, `rho = 0.9`; (3) weights `w_j` proportional to `exp(eta * s_j)`, `eta` about 1 (exponential weighting, unverified: standard, not read); (4) if counter-me wins the race, the opponent is adapting to the CPU, so lower `p_max` (1.5) and raise the mixed share.

Aevalrena: the existing mixture is this minus win-stay/lose-shift and counter-me; add both.

### 1.3 Bayesian counting with a Dirichlet prior

- Posterior mean `p_i = (alpha_i + c_i) / (sum alpha + sum c)` with `alpha_i = s0 * q_i`, `q` the level's default mixed strategy or a population prior, `s0` = 3 to 6 pseudo-observations `[C]`. Add-one smoothing is `alpha_i = 1`. Forgetting as in 1.1; `n_eff = sum c` feeds the gate.
- Persisted rows are capped at 60 weight on load (the repo's cap) so an old style cannot outvote fresh play.

### 1.4 Confidence gating with Wilson lower bounds

- `LB = (p + z^2/(2n) - z * sqrt(p(1-p)/n + z^2/(4n^2))) / (1 + z^2/n)`, `p = k/n`, `n` the decayed effective count (standard formula, unverified: no page read). z is 1.282, 1.645, 1.960 for one-sided 90%, one-sided 95%, two-sided 95%.
- Computed minimum observations when all observations are the same option:

| Required LB | z 1.282 | z 1.645 | z 1.960 |
|---|---|---|---|
| 0.5 | 2 | 3 | 4 |
| 0.6 | 3 | 5 | 6 |
| 0.7 | 4 | 7 | 9 |
| 0.8 | 7 | 11 | 16 |

- A noisy habit needs more: 70% reaches LB 0.5 at about 8, 17 and 21 observations for the three z values; 60% reaches LB 0.4 at about 8, 16 and 21 (computed). Two hits of three has LB 0.25 at z 1.645, so the current "above 55% with 3+ history" exploit trigger acts on thin evidence.
- Gate: exploit habit `a` only if `LB(a) >= p*`, where `p* = (V_safe + m - L) / (G - L)`. `G` is the rollout value of the counter if the habit occurs, `L` its reply-weighted value otherwise, `V_safe` the best non-exploiting plan, `m` a margin. A cheap counter needs little evidence; a counter that opens the CPU to a kill needs a lot.

Aevalrena: replace the fixed trigger with `LB >= p*`, using rollout values the search already computes. The god should use z 1.282 and `n_min` 4, because it can afford to lose a guess `[C]`.

### 1.5 Safe exploitation: counter a habit or play the mixed strategy

- Ganzfried and Sandholm: a safe strategy guarantees at least the equilibrium value per period in expectation. "Gifts" are opponent actions that are not a best response to any equilibrium strategy. Risk What You've Won (spend accumulated profit as exploitability) is proved unsafe because realized profit mixes luck with skill; the fix counts expected payoff over the agent's own randomization. In plain rock-paper-scissors safe exploitation is impossible; it becomes possible once the opponent has a gift action (https://www.cs.cmu.edu/~sandholm/safeExploitation.teac15.pdf). A later paper of the same title extends this to epsilon-equilibrium play: accumulate gift value `k`, play the best response when its exploitability is at most `k`, otherwise revert (https://ar5iv.labs.arxiv.org/html/2307.12338; authors unconfirmed).
- Johanson et al.'s restricted Nash response: the agent best-responds to a mixture where the opponent follows a model with probability `p` and is arbitrary otherwise. `p` near 1 approaches best response, near 0 approaches Nash; the exploitation-versus-exploitability curve is strongly concave, and the poker authors pick `p` for exploitability near 100 millibets per hand (https://webdocs.cs.ualberta.ca/~games/poker/publications/NIPS07-rnash.pdf).
- Rule for Smash `[C]`:
  1. Gift regime (safe): the opponent picks an option whose rollout value against the CPU's mixed reply is below their best option's. Accumulate `k += V_best_opp - V_chosen` in expected value, never from realized damage. Take an exploitative plan whose worst-case value is under `V_safe` by at most `k`.
  2. Guessing regime (unsafe by the theorem): shield, grab and attack triangles and roll versus spot-dodge guesses are rock-paper-scissors-like, so any exploitation is a bet. Reply model = `p * habit + (1 - p) * worst-case`, `p = p_max * clamp((LB - 0.4) / 0.6, 0, 1)`. Because the curve is concave, `p_max` of 0.6 gives up little.
- Cost: 6 CPU replies x 8 opponent options x 30 frames x 1.5 microseconds is 2.2 ms per opponent decision (computed). Run it on decisions, not every frame.

Aevalrena: the reply model already keeps 25% fixed weight and gives the predictor up to 75%, scaled by confidence and by accuracy above 25%. That is a restricted response with `p_max` 0.75. Keep it for the god; use 0.6 at L4 and 0.3 at L3.

### 1.6 Changepoint reset

- Two timescales `[C]`: a fast model (gamma 0.85, `n_eff` 6.7) and a slow one (gamma 0.98, `n_eff` 50). Accumulate the log-likelihood ratio fast over slow with a floor at zero; when it passes `ln 20` (3.0 nats), multiply the slow counts by 0.3 and restart.
- Cheap test: a habit that predicted at 0.6 or better is declared broken after 1 hit in the last 6 predictions (probability 0.041 if the rate is still 0.6) or 2 in the last 8 (0.050), computed.
- Soft trigger `[C]`: after a stock is lost or taken, multiply counts by 0.7 for 600 frames. The persisted profile is a prior, never a fixed model.

### 1.7 Smash habits to track

Frame facts are from the game brief. Reactive windows assume the world's-best reaction of 12 frames (report 07), input on frame 13, so a move of startup `s` first hits on frame `12 + s` `[C]`.

| Habit | Context | Counter and timing |
|---|---|---|
| Roll away under pressure | opponent shielding or just hit, under 60 px | Roll is 24 f, invulnerable 3 to 16, moves 60 px; frames 17 to 24 are open. Reactive catch works for startups 5 to 12; a habit read widens the menu. Track direction. |
| Ledge option | percent bucket | Climb (30 f, invuln 28), jump, attack, roll, drop after 40 invulnerable frames; the hang never times out. Cover the modal option. |
| Airdodge when juggled | combo hit count, height | 34 f, invulnerable 2 to 31, one per airborne period; open 32 to 34. After it is spent, follow up as a rule. |
| Spot dodge on approach | approach speed and distance | 22 f, invulnerable 3 to 17, open 18 to 22. Reactive catch works for startups 6 to 10; a grab (first active frame 7) needs input at least 11 f after the dodge input. |
| Jab mash | inside jab range, CPU landing or shielding | Shield then grab, or space out. Out-of-shield options are only jump, grab, up smash, up special, roll, spot dodge. |
| Recovery timing and route | height vs ledge, time offstage | First action frame, high or low route, double jump before up special. Drives edgeguard placement (report 05). |
| Buffered aerial at hitstun end | knockback bucket | No hitstun cancelling and no DI, so the first actionable frame is exactly `floor(0.4 * knockback)` plus hitlag after the hit. Predict the aerial, time a hitbox for it. |
| Tech and getup option | position, percent | Tech window 20 f, lockout 40; in place 26 f, roll 40 f; getup, getup attack, getup roll. |

Aevalrena: the brain already tracks ledge, tech, getup, hitstun-exit action, neutral starters and out-of-shield choices with roll direction. Missing: jab mash, combo hit count as a context feature, recovery route.

### 1.8 Persistent profiles in shipped games

| System | Stores | Play needed | Source |
|---|---|---|---|
| Killer Instinct Shadow Lab | every action of every match with health, distance and time context | 3 dojo sessions for a baseline; up to 40 matches per opponent matchup as read (scope unconfirmed), 400 to 700 patterns per match, up to 28,000 | https://gamedeveloper.com/programming/the-killer-groove-the-shadow-ai-of-killer-instinct |
| Forza Drivatar | braking timing, cornering, lines; in Horizon 2 aggression and shortcut willingness; cloud-processed | not stated | https://news.xbox.com/en-us/?p=8232 |
| Tekken 8 Ghost | how the player fights, quirks included | more matches, more accuracy; no numbers, no style labels found | https://en.bandainamcoent.eu/tekken/news/tekken-8-discover-about-super-ghost-battles |
| amiibo | level 1 to 50, stats, spirit effects, 3 support slots, personality; learning can be switched off | see below | https://www.ssbwiki.com/Figure_Player |

- Shadow Lab picks actions by case-based reasoning: nearest neighbours over more than 40 metrics, actions ranked by perceived value, lower-ranked picks sometimes used to trick the opponent, a similar overlapping pattern as fallback. The article says even 40 matches may be too few for a rich behavior set.
- amiibo (from report 02, fetched there): behavior fields are 4 to 7 bits and move weights 9 to 10 bits (https://gist.github.com/xSke/979dabd395c39eff36bcaccf87d66a3e); hidden CPU level 1 to 9 advances at experience 0, 63, 210, 434, 749, 1141, 1603, 2065, 2765 (https://docs.google.com/document/d/1L3c-QKr46ATTSxaicPHNFq5uW-uRytVViPRvdM93IQo/edit); learning weights the FP's own connecting attacks most and has no per-matchup memory (https://exionvault.com/amiibo-wiki-level/). In Smash 4 an FP facing a rushdown player adds defensive techniques within a match, faster at higher levels (https://www.ssbwiki.com/Figure_Player).

## 2. Difficulty scaling and humanization

### 2.1 What the sources say

- "Intelligent Mistakes" (Game Developer, Mick West per the page): work out the good move, then deviate only where the deviation does not look stupid, so the player feels they beat an opponent that tried. The part I read gives no numeric parameters (https://www.gamedeveloper.com/game-platforms/bonus-feature-intelligent-mistakes-key-to-believable-ai).
- Lidén, "Artificial Stupidity: The Art of Intentional Mistakes" (AI Game Programming Wisdom 2): not read. unverified, from memory: miss the first shot, telegraph before attacking, take turns rather than swarm, leave deliberate openings. Treat as design prompts.
- BotPrize 2012, Unreal Tournament 2004: UT^2 and MirrorBot each reached 52% humanness against 40% for humans. They used recorded human behavior and neuroevolution, deliberately limited accuracy, and irrational persistence chasing particular opponents (https://news.utexas.edu/2012/09/26/artificially-intelligent-game-bots-pass-the-turing-test-on-turings-centenary/). Humans are not reliably judged human, so aim for human-like imperfection drawn from human limits and data, not random noise.
- Dynamic difficulty adjustment: Hunicke's Hamlet paper is at https://users.cs.northwestern.edu/~hunicke/pubs/Hamlet.pdf, seen only as a search result; unverified: what it measures and adjusts. I saw only titles of a thesis on hidden versus upfront adjustment (https://aaltodoc.aalto.fi/items/940fd4e0-96c6-491a-8613-e0983008f1cf) and a dynamic-scripting brawler paper (https://openaccess.cms-conferences.org/publications/book/978-1-964867-76-2/article/978-1-964867-76-2_9). unverified: that players dislike detectable rubber-banding; I found no page that states it.

### 2.2 Fixed levels

Design argument `[C]`, not sourced: the owner needs levels that are fair and derivable, which needs a fixed knob vector per level; a mid-match strength change is a hidden handicap the player can detect as the CPU declining punishes; archetype traits must stay noticeable; adaptive strength state would have to live in the deterministic rollback state. Adaptation belongs in what the CPU models about the human. Allowed: a between-match level suggestion from win history.

### 2.3 Knobs

1. Snapshot age `P`, response delay mean and SD, sampled once per opponent event and cached by event key (report 07).
2. Timing jitter `sigma_j` and lapse; drop probability is derived from them (report 07).
3. Decision temperature: choose among scored plans with `P(i)` proportional to `exp(score_i / T)`, `T = tau * (best - median)` `[C]`. Veto plans whose worst-case score is far below the best so noise never selects an obviously suicidal plan.
4. Menu cap `k`: only the top `k` filtered plans compete `[C]`.
5. Option vocabulary: which techniques exist at the level.
6. Learning: `gamma`, `z`, `n_min`, `p_max`, or none.
7. Risk `lambda` and CVaR tail: style, not skill. Level does not change them except through score noise.
8. Deliberate openings: probability of abandoning a follow-up after winning an exchange `[C]`.
9. Derived, never set: punish rate. It emerges from `R`, jitter and window width, so levels stay derivable.

### 2.4 Monotonicity calibration

- Elo expected score `E = 1 / (1 + 10^(-D/400))` (standard). Computed: D = 100 gives 0.640, 200 gives 0.760, 300 gives 0.849, 382 gives 0.900, 512 gives 0.950, 982 gives 0.997.
- Targets `[C]`: adjacent levels L1 to L4 about 200 Elo apart (76%); L5 beats L4 at 90% or more (382 Elo or more), putting L5 near 99.7% against L1. Same-level archetype pairs within 40% to 60% (70 Elo).
- Games needed for plus or minus 0.05 at 95%: about 280 near 0.76, 138 near 0.90, 384 near 0.5 (computed). Run 280 side-swapped, seed-randomized games on both stages for each of 16 adjacent same-archetype pairs (4,480 matches) and 100 for other pairs.
- Procedure: one skill scalar `s` in [0,1] interpolates every knob; play the round-robin; fit Bradley-Terry or Elo; bisect `s` per level until adjacent gaps are 200 plus or minus 30; assert monotone ratings per archetype and reject any adjacent pair under 65%. Also test against scripted reference bots, since self-play ratings can be non-transitive.

### 2.5 Five-level table

`[S]` means the anchor comes from report 07's reaction studies; everything else in the row is `[C]`. L4 sits at the human floor: 12 f (200 ms) for a known cue, 15.5 to 18 f for a one- or two-bit choice, floor 10 f (report 07; the single-stimulus average of 265 ms or 16 f is at https://ki.infil.net/reaction.html). L5 is 1 to 4 f: a Melee agent reacted in 2 f and beat professionals (https://ar5iv.arxiv.org/html/1702.06230), and the current level 10 uses 4.

| Knob | L1 | L2 | L3 | L4 | L5 |
|---|---|---|---|---|---|
| Human reference | casual | intermediate | advanced | world's best | beyond human |
| Snapshot age P (f) | 5 | 5 | 4 | 4 | 1 to 4, ship 3 |
| Known-cue R mean (f) [S] | 16 | 15 | 14 | 12 | equals P |
| R SD (f) | 3.0 | 2.5 | 2.2 | 1.7 | 0 |
| Floor (f) | 10 | 10 | 10 | 10 | P |
| One-bit choice, unprimed (f) | 30 | 25 | 21.5 | 15.5 | P |
| Timing jitter sigma_j (f) | 3.0 | 1.8 | 1.1 | 0.4 | 0 |
| Lapse rate | 4% | 2% | 1% | 0.2% | 0 |
| 2-frame window drop (07) | 75% | 59% | 38.5% | 4.5% | 0 |
| Temperature tau | 0.6 | 0.35 | 0.15 | 0.04 | 0 |
| Menu cap k | 4 | 6 | 10 | 24 | all (about 115) |
| Vocabulary | normals, one aerial, grab, shield, jump | + smashes, dodges, basic recovery, ledge | + combos, edgeguard, ledge options | all incl. kill confirms, ledge traps, spikes | all, zero execution error |
| Habit learning | none | none | gamma 0.98, z 1.96, n_min 10 | gamma 0.95, z 1.645, n_min 5 | gammas 0.90 and 0.98, z 1.282, n_min 4 |
| Exploit cap p_max | 0 | 0 | 0.3 | 0.6 | 0.75 plus gift budget |
| Deliberate opening rate | 0.30 | 0.20 | 0.10 | 0.02 | 0 |

If calibration shows an L3 to L4 gap over 200 Elo, use report 07's top-player row for L3 (13 f, sigma_j 0.7). All four archetypes share this table; archetypes change style only.

Aevalrena: levels 1 to 9 are now one weight table with hand-written rules and level 10 is search. One engine with these knobs for every level keeps the archetypes character-independent; L1 and L2 may stay rule-based if a 4 to 6 plan menu looks unnatural. Draw reaction and noise from a hash of (match seed, fighter slot, event start frame, event kind), as report 07 specifies, so rollback replays agree.

## 3. Playstyle archetypes

### 3.1 Taxonomy

- SmashWiki's glossary: rushdown is fast, combo-oriented pressure; a zoner keeps the opponent away with long or disjointed moves and projectiles; camping is staying away, generally in one place, to prolong the fight; bait is tricking the opponent into an action to punish; bait and punish is baiting then hitting the vulnerable foe; a grappler's strongest moves are throws; counter is a matchup advantage or a move that waits to be struck; a read is predicting the next action; stalling is avoiding all conflict; planking is hanging on the ledge for safety (https://www.ssbwiki.com/SmashWiki:Glossary). My extraction found no entries for turtle, all-rounder or trapper. Core-A Gaming and Sirlin were not found or read: unverified: their categories. Other taxonomies exist (https://lucio.bearblog.dev/fgc-archetype-three-structure/, https://smashboards.com/guides/ssb4-character-types.1112/; titles only).
- Mapping: rushdown is aggressive; zoner, camping and turtle are defensive; bait and punish and counter are countering; all-rounder is balanced. Grappler and trapper are character features handled by filters and move weights.

### 3.2 Shipped labels

- amiibo in Ultimate: 25 labels, Normal plus eight groups of three in mild, mid, extreme order (Exion Vault's guide, fetched by report 02: https://exionvault.com/ssbu-amiibo-personality/). Defensive: Cautious, Realistic, Unflappable. Agile: Light, Quick, Lightning Fast. Offensive: Enthusiastic, Aggressive, Offensive. Risky: Reckless, Thrill Seeker, Daredevil. General: Versatile, Tricky, Technician. Entertaining: Show-Off, Flashy, Entertainer. Cool group: Cool, Logical, Sly. Dynamic: Laid Back, Wild, Lively. The game's label list runs personal_0 to personal_24, matching 25 (https://github.com/ultimate-research/param-labels, via report 02). The label is recomputed from behavior values on scan, not stored (https://docs.google.com/document/d/1L3c-QKr46ATTSxaicPHNFq5uW-uRytVViPRvdM93IQo/edit).
- Version check: no source I reached ties this list to update 13.0.0; unverified: that names are unchanged in 13.0.0 or 13.0.1. The SmashWiki page lists personalities under defensive, neutral and offensive headings and my extraction counted 27 names against 25 data labels; unreconciled. Use the 25.
- Tekken 8 Ghost: unverified: any style label; the Bandai Namco page I read names none. A 2025 update added a Ghost vs. Ghost mode (title only: https://eventhubs.com/news/2025/mar/12/tekken-update-content-heihachi).

### 3.3 Measurable signatures

Measure per minute when both fighters are actionable unless noted. Bands are `[C]` starting values for L4 and L5; the acceptance test is the ordering, and the bands get replaced by measured values after scripted runs.

| Metric | Aggressive | Defensive | Countering | Balanced |
|---|---|---|---|---|
| Approaches per minute (close 60 px or more in 30 f, opponent not in hitstun) | 10 to 16 | 1 to 4 | 2 to 5 | 5 to 9 |
| Share of frames inside own fast-move threat range | 0.45 to 0.65 | 0.10 to 0.25 | 0.25 to 0.40 | 0.30 to 0.45 |
| Shield share of grounded actionable frames | 0.03 to 0.07 | 0.12 to 0.22 | 0.10 to 0.18 | 0.06 to 0.12 |
| First-hit share of neutral exchanges | 0.50 to 0.60 | 0.40 to 0.50 | 0.40 to 0.50 | 0.55 to 0.70 |
| Whiff-punish share of combo starts | 0.10 to 0.25 | 0.30 to 0.45 | 0.50 to 0.70 | 0.30 to 0.45 |
| Damage taken per minute | highest | lowest | low | middle |
| Dodges per minute (roll, spot, air) | 1 to 3 | 4 to 8 | 5 to 10 | 3 to 6 |
| Projectiles per minute (Aeval) | 3 to 8 | 15 to 30 | 5 to 12 | 8 to 15 |
| Offstage frame share | 0.03 to 0.08 | 0.005 to 0.02 | 0.01 to 0.03 | 0.02 to 0.05 |
| Jumps per minute | medium | high | low | medium |

### 3.4 Mapping onto the search-based CPU

Objective per rollout: `J = w_dmg * damage_dealt - w_taken * damage_taken + w_adv * frame_advantage/10 + w_stage * stage_control + w_kill * kill_probability`, combined as `lambda * worst + (1 - lambda) * tail_mean`, where the tail is the worst `alpha` share of reply weight (the repo uses 0.25). Weights are relative to balanced = 1.0 and are proposals `[C]`. Parameter vectors at level 5:

| Parameter | Aggressive | Defensive | Countering | Balanced (god) |
|---|---|---|---|---|
| w_dmg | 1.0 | 0.8 | 0.9 | 1.0 |
| w_taken | 0.6 | 1.6 | 1.2 | 1.0 |
| w_adv | 1.4 | 0.8 | 1.2 | 1.0 |
| w_stage | 1.2 | 0.7 | 0.6 | 1.0 |
| w_kill | 1.3 | 0.8 | 1.1 | 1.0 |
| lambda | 0.35 | 0.80 | 0.60 | 0.50; 0.7 or more a stock ahead; down 0.25 vs a read opponent |
| CVaR tail alpha | 0.10 | 0.40 | 0.30 | 0.25 |
| Candidate filter | all approaches; retreat only in kill range | zoning, retreat, platforms; approach only in kill range or when the lead is lost | hold spacing, shield, dodge, bait; approach only into opponent endlag or after the stall clock | none |
| Bait probes (share of shots or approaches meant to draw a response) | 0.05 | 0.10 | 0.30 | 0.10 |
| Reaction trigger | clock: force the best approach after 60 f without a threat exchange | commitment, plus zone timer | commitment: any opponent startup triggers a punish search | both, by rollouts |
| Stall clock base (f without engagement) | 210 | 720 | 540 | 420 |
| Preferred spacing / own fast-move reach | 0.6 | 1.5 | 1.1 | adaptive |
| Exploit bias | ledge and recovery habits | approach and shield habits | roll, spot dodge, airdodge habits | all, by `LB - p*` |

Stall clock bases match report 21; the clock forces engagement when it runs out, so defensive waits longest but never forever. Countering reads opponent commitments and aggressive acts on its own clock; the difference is what a player notices.

### 3.5 Balanced level 5 versus single styles

Define each L5 style as the god with a restricted candidate set and a biased objective. Balanced uses the union of all candidate sets and the true objective (equal weights, the repo's scoring). At each decision the balanced pick then has true-objective value at least equal to any style's pick under the same forward model and reply models, since that pick is one of its candidates. Caveats: it holds relative to the model, not a real human; finite horizons (16 to 60 f) can miss the value of patience, so the stall clock and habit terms must sit inside the true objective; per-decision dominance is not match-level proof. Test: balanced L5 wins at least 60% against each style's L5 `[C]`, and every L5 wins at least 90% against any L4.

## Open questions

- Game AI Pro chapter 48 uses add-one smoothing, not Witten-Bell; confirm the owner means that chapter.
- Iocaine Powder's constants were not read.
- Whether all four archetypes at L5 are beyond human or only balanced; this report assumes all four.
- The 13.0.0 personality list, 25 versus 27 names, and Tekken 8 Ghost labels remain unverified.

## Sources

Fetched:
- https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter48_Implementing_N-Grams_for_Player_Prediction_Proceedural_Generation_and_Stylized_AI.pdf : n-gram counting, add-one smoothing (fetched)
- https://www.cs.cmu.edu/~sandholm/safeExploitation.teac15.pdf : safe strategies, gifts, RWYW, RPS (fetched)
- https://ar5iv.labs.arxiv.org/html/2307.12338 : gift accumulation for epsilon-equilibrium (fetched)
- https://webdocs.cs.ualberta.ca/~games/poker/publications/NIPS07-rnash.pdf : restricted Nash response (fetched)
- https://gamedeveloper.com/programming/the-killer-groove-the-shadow-ai-of-killer-instinct : Shadow Lab (fetched)
- https://news.xbox.com/en-us/?p=8232 : Drivatar (fetched)
- https://en.bandainamcoent.eu/tekken/news/tekken-8-discover-about-super-ghost-battles : Tekken 8 Ghost (fetched)
- https://www.ssbwiki.com/Figure_Player : amiibo levels, learning, adaptation (fetched)
- https://www.gamedeveloper.com/game-platforms/bonus-feature-intelligent-mistakes-key-to-believable-ai : Intelligent Mistakes (fetched, excerpt)
- https://news.utexas.edu/2012/09/26/artificially-intelligent-game-bots-pass-the-turing-test-on-turings-centenary/ : BotPrize 2012 (fetched)
- https://www.ssbwiki.com/SmashWiki:Glossary : term definitions (fetched)

Attempted, not read:
- http://www.ofb.net/~egnor/iocaine.html : Iocaine Powder (404)
- https://users.cs.northwestern.edu/~hunicke/pubs/Hamlet.pdf : Hamlet (search result; fetch redirected, budget ended)

Title only (search snippet):
- https://aaltodoc.aalto.fi/items/940fd4e0-96c6-491a-8613-e0983008f1cf : hidden vs upfront DDA thesis
- https://openaccess.cms-conferences.org/publications/book/978-1-964867-76-2/article/978-1-964867-76-2_9 : dynamic scripting in a brawler
- https://lucio.bearblog.dev/fgc-archetype-three-structure/ : FGC archetypes
- https://smashboards.com/guides/ssb4-character-types.1112/ : Smash 4 character types
- https://eventhubs.com/news/2025/mar/12/tekken-update-content-heihachi : Ghost vs. Ghost mode

Not fetched here, taken from sibling reports that fetched them:
- https://exionvault.com/ssbu-amiibo-personality/ : 25 labels (report 02)
- https://github.com/ultimate-research/param-labels : personal_0 to personal_24 (report 02)
- https://gist.github.com/xSke/979dabd395c39eff36bcaccf87d66a3e : bit widths (report 02)
- https://docs.google.com/document/d/1L3c-QKr46ATTSxaicPHNFq5uW-uRytVViPRvdM93IQo/edit : CPU experience thresholds (report 02)
- https://exionvault.com/amiibo-wiki-level/ : learning weights (report 02)
- https://ki.infil.net/reaction.html : 265 ms, 16 f (report 07)
- https://ar5iv.arxiv.org/html/1702.06230 : Melee agent 2 f reaction (report 07)

Local files: `/home/claude/research/BRIEF.md`, reports 02, 07 and 21 in the same folder, and `/home/claude/aevalmere/aevalrena/docs/CPU_AEVALMERE.md`. Wilson, Elo, Witten-Bell and exponential-weighting formulas are standard and were not read from a page; all derived numbers were computed in this session.
