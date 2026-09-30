# Aevalmere: the level 10 CPU

Code: `src/ai/aevalmere.ts`. Level 10 is routed there by `cpuInput` in `src/ai/index.ts`.
Tests: `src/ai/aitest.ts`, cases `ae` to `as` (`npx --yes tsx src/ai/aitest.ts`). The wave 2 gates
(`am` to `as`) run on both arenas, `tidegate` and `hearthmoor`. The opponent profile store lives in
`src/ai/profile.ts`.

Levels 1 to 9 are rule tables: a profile of weights feeding hand-written situations. Aevalmere
does not use them. It searches. The sim is deterministic and cheap: one `stepGame` of a two-fighter
match costs about 1.5 microseconds on the dev machine. That makes the FightingICE recipe practical
here: copy the state, play each candidate forward against a few opponent replies, and keep the best.
The rest of this file covers what the research said, how the brain works, and what it measured.

## 1. Research

About 30 sources were read (fetched pages, or search snippets where a page was blocked). They are
grouped by topic below, with the technique each one contributed.

### SmashBot (Melee, altf4 / libmelee)
- Four layers, each re-run every frame: Goals, then Strategies (e.g. bait), then Tactics (Defend,
  Edgeguard, Recover, Punish, Juggle, KeepDistance, Mitigate and others), then Chains (button
  sequences such as Wavedash, JC up smash, Powershield, DashDance, EdgeStall). Its only edge over a
  human is speed and precision through a virtual controller.
  https://github.com/altf4/SmashBot , https://github.com/altf4/SmashBot/blob/master/Readme.md , https://deepwiki.com/altf4/SmashBot
- Punish gate: `framesleft()` (hitstun left; simulated fall for airborne victims; windup, active and
  cooldown from frame data for attacks) against `framesneeded` for the punish. It commits only when
  `framesneeded <= framesleft`, and otherwise dash-dances to the victim's predicted end position (slide,
  roll end). It does not model DI. https://github.com/altf4/SmashBot/blob/master/Tactics/punish.py
- Defend: works out which frame the hit arrives on from the move's range, powershields when the hit
  is 2 frames or less away, spot dodges grabs, and otherwise dash-dances back past `range_forward`.
  https://github.com/altf4/SmashBot/blob/master/Tactics/defend.py
- Edgeguard: can the opponent get back (double jump height plus up-B height, and the frames to snap
  to the ledge)? It ledge-stalls while its own invincibility outlasts their time to the ledge.
  https://github.com/altf4/SmashBot/blob/master/Tactics/edgeguard.py

### Frame data, true combos, DI
- Hitstun is 0.4 x knockback in Melee; Ultimate uses the same minus 1 frame. A true combo holds when
  the attacker's remaining lag plus the next move's startup fits inside the victim's remaining
  hitstun. https://www.ssbwiki.com/Hitstun
- Slippi counts a combo or punish string until the victim has been actionable and unhit for 45
  frames. https://github.com/project-slippi/slippi-js , https://www.scribd.com/document/482548903/Slippi-Stats-Definitions-docx
- DI rotates the launch by up to about 18 degrees. Survival DI and combo DI pull in opposite
  directions, which is where DI mixups come from. SDI shifts the fighter during hitlag.
  https://www.ssbwiki.com/Directional_influence , https://www.ssbwiki.com/Smash_directional_influence

### Smash Ultimate level 9 and amiibo
- The level 9 CPU has a 1-frame reaction; it does not read inputs. Level scales both reaction speed
  and follow-through. Players call it cheating because it perfect-shields and dodges on the first
  visible frame. https://www.ssbwiki.com/Artificial_intelligence , https://www.ssbwiki.com/Perfect_shield
- Amiibo run the base CPU plus trainable personality weights. Moves that connect get likelier and
  moves that get avoided get rarer, so an amiibo copies its trainer's style.
  https://exionvault.com/2021/04/30/ssbu-amiibo-general/ , https://goozamiibo.com/blog/training-smash-amiibo-figure-players/

### Utility scoring
- The Infinite Axis Utility System: normalised considerations through response curves, multiplied,
  with a compensation factor. https://en.wikipedia.org/wiki/Utility_system
- Dual utility (Dill, Game AI Pro 2): rank tiers as vetoes and priorities, then a weighted pick among
  the options near the best. https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter03_Dual-Utility_Reasoning.pdf
- In fighting games the terms are frame advantage, expected damage, knockback toward the blast zone
  and the whiff-punish risk of your own end lag.
  https://www.ice.ci.ritsumei.ac.jp/~ruck/PAP/ieeeToG-ishii21.pdf

### Rollout search (FightingICE)
- Competitors get 16.67 ms per frame and see the state 15 frames late (the human-reaction model). A
  forward-model simulator is supplied, which is why MCTS bots have won since 2016. Typical settings:
  UCB1 with C = 1, 60-frame rollouts, 16.5 ms budget. The final pick is the best mean value.
  https://arxiv.org/pdf/2003.13949 , https://www.ice.ci.ritsumei.ac.jp/~ruck/PAP/ieeeToG-ishii21.pdf
- Thunder, GigaThunder and ReiwaThunder (Eita Aoki, winners 2016 to 2019) predict the opponent's 3
  likeliest actions and use the simulator to pick the best reply to them.
  https://www.slideshare.net/slideshow/2020-fighting-game-ai-competition/238325035 , https://www.ice.ci.ritsumei.ac.jp/~ftgaic/index-2.html
- Delay handling: before planning, run the forward model from the delayed observation up to "now".
  Rolling-horizon evolution with an opponent model trained between rounds is the alternative.
  https://arxiv.org/pdf/2003.13949 , https://ieeexplore.ieee.org/document/8080432/

### Movement and ledge tech
- Dash dance to bait and punish whiffs; wavedash; empty hops; shield drop (removed in Ultimate); ledge
  trump; the 2-frame punish on a ledge catch; tech chasing on reaction (about 15 frames is the human
  limit). https://www.ssbwiki.com/Dash-dancing , https://www.ssbwiki.com/Wavedash , https://www.ssbwiki.com/Shield_dropping ,
  https://www.ssbwiki.com/Edge , https://www.ssbwiki.com/Edge-hog , https://supersmashbros.fandom.com/wiki/Two_Frame_Punish ,
  https://smashboards.com/threads/tech-chasing-like-a-man-complete-breakdown.382475/

### Humanizing a perfect bot
- Reacting to one known stimulus takes about 265 ms (16 frames); reactions under about 200 ms are not
  human. https://ki.infil.net/reaction.html
- Phillip (deep RL Melee) beat pros with a 2-frame reaction. With 2 to 4 frames of added delay it
  stayed competitive; with 6 to 10 it fell off. https://ar5iv.arxiv.org/html/1702.06230
- Believable mistakes: choose probabilistically, hand the player a deliberate opening rather than a
  random blunder, and never make a mistake no human would make.
  https://www.gamedeveloper.com/programming/intelligent-mistakes-how-to-incorporate-stupidity-into-your-ai-code ,
  https://games.slashdot.org/story/09/03/18/1438231/believable-stupidity-in-game-ai , https://en.wikipedia.org/wiki/Artificial_stupidity
- Superhuman speed is what makes players call an AI unfair (AlphaStar's APM caps).
  https://arxiv.org/pdf/2503.15514

### Wave 2 sources: learning the player (2026-09-29)
- N-gram player prediction: keep the last n actions, count what followed each window, predict the
  likeliest next one; the chapter notes this is what makes fighting-game AIs "very nearly
  unbeatable" when they read a human. https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter48_Implementing_N-Grams_for_Player_Prediction_Proceedural_Generation_and_Stylized_AI.pdf ,
  https://www.taylorfrancis.com/chapters/mono/10.1201/b16725-54/implementing-grams-player-prediction-procedural-generation-stylized-ai-steven-rabin
- Adaptive fighting-game AI learning the player's move tendencies (Stanford CS229 project).
  https://cs229.stanford.edu/proj2008/RicciardiThill-AdaptiveAIForFightingGames.pdf
- FightingICE: an action table of the opponent's predicted actions fed into MCTS beat the top three
  2016 entries; the winners since plan against a predicted reply policy, not a fixed one.
  https://researchgate.net/publication/320742121_Opponent_modeling_based_on_action_table_for_MCTS-based_fighting_game_AI ,
  https://www.semanticscholar.org/paper/Monte-Carlo-Tree-Search-Implementation-of-Fighting-Ishii-Ito/ed182da2e64f0a2be27fb38997bae1dba071a53d
- Tekken 8 Super Ghost: an action model cloned from one player's play, which only does what it saw
  that player do (the "ghost" idea: the sequence of actions is the model).
  https://en.bandainamcoent.eu/tekken/news/tekken-8-discover-about-super-ghost-battles ,
  https://medium.com/@200wordessay/tekken-8s-super-ghost-battle-a-i-fighting-games-aab5f1d67a44 ,
  https://sites.google.com/site/fightinggameai/ghost-ai
- Iocaine Powder (winner of the first RoShamBo programming competition): run several predictors at
  once, keep score of which one has been guessing right, and follow the best.
  https://github.com/MrValdez/Roshambo/blob/master/rsb-iocaine.c , https://news.ycombinator.com/item?id=20073703
- Witten-Bell smoothing: interpolate a context's own counts with its back-off by count against the
  number of distinct outcomes the context has produced. https://www.cl.uni-heidelberg.de/courses/ss15/smt/scribe6.pdf ,
  https://www.geeksforgeeks.org/nlp/advanced-smoothing-techniques-in-language-models/
- CVaR: the mean of the worst alpha share of outcomes, the standard risk-averse objective.
  https://arxiv.org/html/2405.01718v1 , https://dl.acm.org/doi/10.5220/0008175604120423
- SmashBot's punish gate (above) is still the basis of the kill confirms: a chain only counts when
  frames needed fit in hitstun left.

### What was taken from this
1. Rollout search on a copied state against a small set of opponent reply models, following
   FightingICE and the Thunder bots. Aevalrena's sim makes this cheap.
2. Plan on a delayed observation rolled forward to now (FightingICE), with a 4-frame floor instead
   of 15. The owner asked for 4, and Phillip's result says 2 to 4 frames keeps a bot strong.
3. SmashBot's `framesleft >= framesneeded` punish gate, turned into two things: a precomputed
   true-combo table, and a no-whiff rule checked against the rollouts.
4. Frame advantage and knockback toward the blast zone as scoring terms.
5. Opponent habit tables weighting the reply models: amiibo-style learning and Thunder-style
   prediction of the opponent's likeliest actions.
6. Rank-and-veto selection (dual utility): hard vetoes for whiffs, for edgeguards that never come
   back, and for a Final Smash that does not catch; then a blend of the worst and the expected reply.
7. Humanizing by a reaction floor and deliberate safe alternatives, not random blunders.
8. (Wave 2) A situation-conditioned n-gram predictor of the opponent's next action, Witten-Bell
   interpolated, plus a ghost-style action-pair model and a rhythm model, mixed Iocaine-style by
   their running hit rates; its top replies become the rollout reply set. Saved per player.
9. (Wave 2) A CVaR-style tail weight in the objective and a hard veto on any candidate that loses a
   stock in a reply the model rates above 5%.

## 2. Design: what Aevalmere does each frame

1. **Match check.** A new config, or the frame counter jumping back, resets the slot's memory (the
   pooled states are kept).
2. **Snapshot.** The real state is copied into an 8-slot history ring (`copyGameStateInto`, no
   allocation once the pool exists).
3. **Observe.** It watches the opponent's action transitions and updates decaying habit tables:
   ledge option, tech option, get-up option, what it does when hitstun ends, what it starts from
   neutral or after landing, what it does out of shield (roll direction included). It also keeps
   a 16-move history for a repetition score, which is how it spots a CPU running a loop. It notes
   which of our moves last hit them (the combo-table starter) and when damage last happened (the
   stall clock).
4. **Reflexes.** These run outside the search:
   - Grabbed: mash a fresh group of four buttons every frame, the most the sim counts. Shield and
     Dodge are never mashed, because they are tech presses.
   - Respawn platform: drop after 20 frames.
   - Tumbling toward the floor: step a copy of the state to predict the landing. Once it is 8 frames
     out or less, choose tech in place, left or right with rollouts, then hold the tech plan through
     the landing. It always techs.
   - Launched (hitstun above 1): drop whatever plan was running, so no stale press ends the tumble or
     uses up the tech window.
5. **Decide or keep going.** It searches only when it is actionable and one of these holds: the plan
   has finished; the plan can be interrupted and 3 frames have passed (6 while recovering); or the
   opponent's delayed state has visibly changed (a new move, action or projectile). Otherwise it plays
   the next frame of the cached plan.
6. **Perceive.** It takes the state from 4 frames ago, plays it forward 4 frames with its own real
   inputs and the opponent holding what it held then, and pastes its own true fighter on top. Anything
   the opponent started in the last 4 frames cannot be seen.
7. **Candidates.** 115 plans exist. Each one is a small input program, or a policy that reads its own
   fighter, and it drives both the rollouts and the real output. The candidates are filtered by
   situation: grounded (movement, dash dance, walk, tilts, smashes including charged ones, grab, dash
   grab, specials, short-hop and full-hop aerials including retreating and fast-falling ones, empty
   hops, shield, spot dodge, rolls, platform drop, edgeguards and ledge hog); out of shield (grab, up
   smash, up special, jump aerials, dodges); airborne (drift, fast fall, aerials, double jump, air
   dodges, specials, four recovery policies); ledge; downed; grab hold (four throws and pummel);
   tumble exit; Final Smash. Follow-ups from the combo table come first and carry a small bonus.
8. **Reply models.** They are chosen from the opponent's perceived situation and weighted by its
   habits:
   - Neutral: continue (keep holding what it holds), attack (close in and hit with its fastest option
     that reaches), and defend (shield or air dodge, then grab out of shield).
   - In shield: add rolls toward and away.
   - On the ledge: climb, attack, roll, jump or wait.
   - Launched: its tech options, or its escape options.
   - Downed: its get-up options.
   - Off the stage: recover.
9. **Rollouts.** Each candidate plays forward against each model for 16 to 60 frames, depending on
   the plan. Movement plays against 2 models and commitments against all of them. The deterministic
   budget is 2600 sim steps per decision.
10. **Score.**
    - Damage dealt minus 1.25x damage taken, and KOs.
    - A projected KO for anyone still launched at the end: their hitstun trajectory is stepped the
      way the sim steps it, against the stage's blast rect, read live.
    - Recovery feasibility for anyone off the stage.
    - Frame advantage (their busy frames minus ours), and a penalty for standing in reach while
      busy.
    - Shield health and shield breaks.
    - Small stage-control and spacing terms, and a pull toward the opponent once nobody has taken
      damage for 7 seconds.
11. **Select.**
    - Vetoes: an attack that connects in no reply and is not safe when shielded; a shot that connects
      in no reply and gets punished by the attack reply; an edgeguard whose rollout never gets back
      to the stage.
    - A Final Smash is taken the moment it catches in every reply.
    - The rest are ranked by λ x worst + (1 - λ) x weighted mean. λ is 0.55 in neutral, lower on
      reads and against a repetitive opponent.
    - Adjustments: a continuity bonus against jitter, a staleness cost for commitments used a lot
      lately (twice as much for projectiles), and a quarter point of seeded noise.
12. **Humanize.** On neutral decisions, 6% of the time it takes a safe movement option within 25
    points of the best, if there is one. That comes to about 2% of all decisions (2.0% measured
    against level 9).
13. **Output.** It never taunts. As a hard gate, it never makes a fresh grounded shield press while
    an opponent's move is 0 or 1 frames old. Directions never become an accidental double-tap roll:
    `safeDir` holds a press back while the sim's own tap timer would read it as a second tap. Moves go
    out as direct codes (the same shortcut keys a player can bind), so a smash is never misread as a
    tilt and the smash tap window never comes into play.

### Wave 2 additions (E1 to E5)

**Stage awareness (E1).** `stageInfo` (aevalmere) and `getGround` (levels 1 to 9) re-read the live
`StageDef` every call into one cached object per stage, so nothing assumes Tidegate. The stage's
underside (`botY`) is read too: both arenas are thin 24 px slabs, and a fighter knocked under one
has to drift out past the nearer edge before it climbs (`homeSign`, `underStage`). Before this the
recovery policy steered home toward the centre from under the stage and lost a stock at 14%.

**Move data (E1).** `busyFrames` adds the orb's `chargeCastFrames` share. Follow-ups in the combo
table may connect with any circle of a chain (ftilt to 80 px, dash attack and fsmash to 102 px), not
only the strongest one. The orb is two starters, a tap and a full charge (`orbTap`, `orbFull`), with
the `charged` values lerped the way the sim lerps them. A full-charge plan (`orbFull`, 60 held
frames, 104-frame horizon) is offered at 170 to 380 px, or at any range against a recovering or
ledge-hanging opponent; the crescent's horizon is 72 frames and it is offered to 240 px, and to
300 px as offstage coverage. Air dodges honour the new one-per-airborne-period rule everywhere
(plans, recovery, reply models, and the level 1 to 9 `airDodgeSafe`); `busyFrames` reads
`AIR_DODGE.total`.

**Opponent model (E2).**
- Classes: 17 attacks by move id plus ledge attack and get-up attack, grab, shield, roll toward,
  roll away, spot dodge, jump, air dodge, drift in, drift out, nothing, stand/climb/tech (30).
- Observation: every frame, for every enemy. An action is recorded when it starts (a roll's direction
  is read a frame or two in). While the enemy starts nothing, its drift is sampled from the direction
  it holds (the same public field the continue reply replays), never from leftover launch speed:
  on a change held 6 frames, or every 12 frames, and only after 8 frames free.
- Context of an observation: the frame before it (where the choice was made). Order 1 = (situation
  bucket x7, distance x4, our state x3, last action, phase x4); order 2 adds the action before; both
  hashed into 1024 rows each. The phase is the frames since the opponent's last action started,
  bucketed 0-10 / 11-25 / 26-60 / 60+: a roller rolls on a beat and a camper throws on one, so the
  same situation early and late in the rhythm are different choices. Counts decay 0.97 per
  observation in their row.
- Prediction: six components, each a distribution: the situation alone (Laplace 0.5); order 1 and
  order 2 over it (Witten-Bell); the last two actions alone (ghost sequence model); the full chain
  2 -> 1 -> pair -> situation; and a rhythm model (last action x phase). Each component keeps a
  0.9-decayed hit rate; the prediction is their mixture weighted by hit rate squared. A timing vote
  then rescales it: per (last action, phase), how often the opponent acted versus still did nothing
  (drift, stand, hang), Witten-Bell weighted, sets the share of the distribution on action classes
  versus movement classes. Top guess accuracy is scored on every observation
  (`aevalmerePredictorStats`). A second variant, the phase as a separate seventh component instead
  of inside order 1, was measured and was worse on the roller and the jumper.
- Reply models: the fixed habit-weighted set keeps at least 25% of the weight; the predictor's top 5
  classes take up to 75%, scaled by context confidence and by how far its recent accuracy is above
  25% (a coin-flip record earns nothing). New reply policies: use a named move, grab, spot dodge, jump,
  air dodge, move in, move out, and three recovery variants. The attacking reply now hops off after
  us when we are off the stage within reach, and footstools when falling onto our head.
- Delay-window replay: every rollout starts from the observation REACT (4) frames old with the reply
  model already acting, replays our own known inputs for those frames, and then restores our true
  fighter. "It jumped four frames ago and is about to footstool us" is checked like any reply, and no
  unseen input is read.
- Exploit tables: trigger (dash in, shield pressure, shot, aerial) x answer (shield, roll, spot
  dodge, jump, air dodge, attack, nothing) within 30 frames, decay 0.94. An answer above 55% (with 3+
  history) adds its counter with a +5 bonus: grab vs shield, dash attack/dash grab/fsmash vs roll,
  up smash/utilt/uair vs jump, dash attack/usmash/dsmash vs air dodge, charged fsmash/dtilt vs spot
  dodge, retreating bair/ftilt vs attack.
- Lambda comes down by up to 0.25 against an opponent the model reads well (confidence x accuracy).
- Profile (`src/ai/profile.ts`): an injectable `ProfileStore { load, save }`; localStorage only when
  `typeof localStorage !== 'undefined'`, an in-memory store otherwise. Key
  `aevalrena.aevalmere.profile.v1.<typed name>`, or `slot<n>`; only human (cpu false) enemies are
  stored. Value: `{"v":1,"o0","o1","o2","sq","rh","tm","cp","ex","hb"}`, fixed-size arrays rounded
  to 2 decimals (about 190 KB of JSON, mostly zeros); `cp` is each component's hit rate, so a known
  player's best-reading component is trusted from the first guess. Saved on every KO, when the next
  match starts, and by `flushAevalmereProfiles()`, which `src/main.ts` calls when the results screen
  opens; loaded at match start, each context row capped at 60 observations of
  weight, then decayed by fresh play like any count. The store is bound to the predictor at load, so a
  save always goes back where it came from.

**Kill routing (E3).**
- Combo table: a fourth victim spot, off the stage below the ledge, where a launch that leaves the
  victim deeper than a double jump plus the geyser can climb counts as a KO (the dair spike case).
- Kill confirms: per stage, per starter and bracket, 1 when the starter or its best chain launches past
  the blast rect. Grab (any throw), dtilt, utilt and nair get +6 and are examined first when the victim
  is in a confirming bracket.
- A rollout in which a starter lands whose table chain kills from the victim's bracket and spot is
  worth 400 (a raw launch that would KO: 360; a KO seen inside the horizon: 520).
- Spike routes: `egFairDair`, `egBairDair`, `egDair`, `dairSpike` (airborne), `ledgeDropDair`. A
  spike plan is taken at once when every reply ends in a KO and we end on the stage or the ledge.

**Loss avoidance (E4).**
- Objective: lambda x worst + (1 - lambda) x tail-weighted mean, the worst 25% of reply weight counted
  2x when a stock ahead, 1x even, 0.5x behind.
- Hard veto: a stock lost (KO, a launch that projects a KO, or off the stage with no way back) in any
  reply above 5% of the weight vetoes the candidate whenever a candidate without one exists.
- Recovering: +0.4 per px of the smallest margin to any blast line over the rollout (to 200 px). The
  air dodge onto the ledge is only offered once the jumps are spent (and the dodge is unused).
- A stock ahead with no timer: lambda at least 0.7 (less against a passive opponent, so the kill
  speed test still holds).

**Human-looking (E5).** The 4-frame floor stays. The safe alternate is never one that a reply above
5% punishes (any damage to us) or that loses a stock.

**Budget.** Candidates are examined in priority order at full horizon; when the 2600-step budget
runs low the last ones get shorter horizons, then none. Shrinking every horizon evenly to fit the
larger reply set was tried and measured worse (first KO on a wandering dummy 1361 vs 921 frames
mean over 8 seeds): kill moves need their whole horizon to show the launch. The fighter copy used by
every rollout is now a copier generated from the learned field list (monomorphic property access);
it was 10% of all run time and is now off the profile's top list. Where a content security policy
forbids `new Function`, the generic loop is used.

### Combo table
It is built once per stage and knockback tuning, from Aeval's move data. The key is every starter
(the strongest hitbox of each of 14 moves, plus the 4 throws), crossed with the victim percent
bracket (0-30, 30-60, 60-100, 100+) and the victim spot (mid-stage, near a ledge, airborne above).

For each key it lists the follow-ups that are true combos by the sim's hitstun formula: remaining
lag plus startup (plus jump squat for aerials) has to fit inside the hitstun, and the hitbox has to
be able to reach the victim's launched body.

The follow-ups are ranked by the best chain of up to 4 hits each one opens. A chain that ends in a
launch past the blast rect gets a bonus. At runtime the entry for the last hit becomes the first
candidates, and the rollouts check each hit against where the victim is actually flying. That means
the chain is re-planned at every hit.

Current table: 69 starter entries with a follow-up. 55 of them open 3-hit chains, 46 open 4-hit
chains, and 39 end in a KO. Example: utilt at 15% leads into uair (a 4-hit chain, 30%).

### DI
Aevalrena's sim has no launch-angle DI and no SDI: `knockbackDecay` sets the velocity outright while
hitstun lasts. "Survival DI" therefore means choosing what happens when hitstun ends:
- tumble exits: jump home, air dodge home, drift, fast fall, nair, or stay in tumble;
- the tech direction;
- the recovery policy.

All of these are chosen by rollouts against the blast rect and the edgeguarder's reply.

## 3. Measured

### Wave 2 (2026-09-29, both arenas, after both balance batches)
From `npx --yes tsx src/ai/aitest.ts` (44 hard cases, all pass; `ao` is informational, see section 4).

Level 10 vs level 9, 5 seeds x both sides, 2 stocks:

| Stage | Wins | Stocks lost | SDs | Avg length |
|---|---|---|---|---|
| tidegate | 10/10 | 0 | 0 | 3059f |
| hearthmoor | 10/10 | 0 | 0 | 2759f |

The older sweep on tidegate: L10 vs L9 / L5 / L1 all 10/10 with 0.00 stocks lost (vs L9: longest
combo 3.9 on average, 1.9 three-hit true combos per match), L10 mirror 8/10 slot-side, 0 SDs, 0
early shields, 1.6 to 2.2% safe alternates.

Scripted archetypes (fixed policies in `aitest.ts`, human slots with a typed name, fresh profile
store each, 3 seeds per stage, 2 stocks). The accuracy column is the predictor's top-guess hit rate
over its last 30 guesses at 30 s (printed for reference). The `ao` floor uses the cumulative rate
over the first 30 s, both stages pooled: camper 49%/45%, roller 47%/35%, rushdown 64%/50%, turtle
69%/62%, ledge 62%/55%, jumper 53%/47% (mean/worst).

| Archetype | Stage | Wins | Stocks lost | First KO frames | Accuracy at 30 s, mean / worst |
|---|---|---|---|---|---|
| rushdown masher | tidegate | 3/3 | 0 | 791 / 566 / 881 | 63% / 53% |
| rushdown masher | hearthmoor | 3/3 | 0 | 624 / 819 / 658 | 69% / 63% |
| shield-grab turtle | tidegate | 3/3 | 0 | 1019 / 2161 / 1179 | 69% / 60% |
| shield-grab turtle | hearthmoor | 3/3 | 0 | 1387 / 1351 / 1936 | 78% / 73% |
| projectile camper | tidegate | 3/3 | 0 | 998 / 1028 / 1722 | **52%** / 50% |
| projectile camper | hearthmoor | 3/3 | 0 | 1133 / 654 / 1543 | 56% / 50% |
| roll spammer | tidegate | 3/3 | 0 | 617 / 1325 / 1053 | **54%** / 43% |
| roll spammer | hearthmoor | 3/3 | 0 | 1199 / 930 / 1380 | 62% / 50% |
| ledge camper | tidegate | 3/3 | 0 | 1990 / 1534 / 1276 | 73% / 67% |
| ledge camper | hearthmoor | 3/3 | 0 | 1416 / 2471 / 1239 | 60% / 57% |
| jump-happy | tidegate | 3/3 | 0 | 528 / 1463 / 791 | **53%** / 43% |
| jump-happy | hearthmoor | 3/3 | 0 | 1028 / 843 / 784 | 56% / 47% |

Profile transfer (`ap`): predictor accuracy over the first 15 s of the same match, empty store ->
the profile a previous full match saved. 36 pairs (6 archetypes x 3 seeds x 2 stages): mean gain
+17.2 points (tidegate +17.5, hearthmoor +16.9), worst pair -1.0. Per archetype: rushdown +14,
turtle +9, camper +23, roller +31, ledge +17, jumper +9. Saving each component predictor's hit rate
in the profile (`cp`) is what closed the last gap: before it, one ledge pair was 5.1 points worse.

Kill routing (`aq`), over the 72 KOs of the 36 archetype matches: 47% routed. By type: 2+ hit true
combo 31, edgeguard hit off the stage 3, spike 0, single hit on the stage 38, no hit (self-destruct)
0. Before edgeguards, spike routes and kill-confirm starters were moved to the front of the candidate
list with a bonus (edgeguard +6, kill confirm +10, combo-table follow-up +6), the share was 36%.
Standing dummy: median first KO 596f (9.9 s) over 5 seeds x 2 stages.

Combo table (tidegate / hearthmoor): 125 starter entries, 97 / 95 open 3+ hit chains, 89 / 87 open
4-hit chains, 57 / 54 end in a KO. Kill confirms from the lowest bracket: dtilt and utilt from 45% mid
and at the ledge (15% off the stage), uthrow 45%, dthrow 80%, dair 45%, bthrow only off the stage at
120% on tidegate and at the ledge on hearthmoor, full orb off the stage at 120%.

Budget, with a host warm-up before frame 0, 3000 frames against level 9:

| Stage | Mean | p99 | First call |
|---|---|---|---|
| tidegate | 0.062 ms | 1.99 ms | 0.39 ms |
| hearthmoor | 0.069 ms | 1.82 ms | 0.38 ms |

Determinism: the same seed gives an identical final state against a human slot with an empty store
and with a fixed profile (tests `ah`, `as`).

### Wave 1 measurements (kept for comparison)

The harness uses 5 seeds x both sides and 2 stocks for each matchup (`npx --yes tsx src/ai/aitest.ts`).

| Matchup | L10 wins | Stocks lost / match | SDs | Longest true combo (avg) | 3+ hit combos / match | Early shields |
|---|---|---|---|---|---|---|
| L10 vs L9 | 10/10 (100%) | 0.00 | 0 | 4.10 | 2.70 | 0 |
| L10 vs L5 | 10/10 (100%) | 0.00 | 0 | 3.80 | 3.20 | 0 |
| L10 vs L1 | 10/10 (100%) | 0.00 | 0 | 3.90 | 2.70 | 0 |
| L10 vs L10 | 4/10 slot-side wins (mirror) | 1.60 | 0 | 3.20 | 1.20 | 0 |

- **Budget:** 0.084 to 0.186 ms mean per level 10 `cpuInput` call over a 3000-frame match against
  level 9 (305 decisions, harness test `ai`). The spread is machine load across runs. That is 8 to 18x
  under the 1.5 ms target, so the step budget never had to be cut.
  - Latency spread in a separate 3000-frame run: median 0.007 ms (frames that only replay the cached
    plan), p99 about 3.3 ms (a full decision).
  - The very first call costs about 33 ms (pool cloning plus JIT), and a few decisions in the first
    4 seconds cost 8 to 15 ms while the JIT warms up. Every one of them fits inside a 16.7 ms frame
    except that first call.
- **Determinism:** the same seed gives an identical final state JSON, for L10 vs L9 and for the mirror.
- **Every level 10 match finishes**, the mirror included. The first version stalled in crescent wars
  until the staleness cost and the no-whiff rule for projectiles went in.
- **Plan mix against level 9** (decisions over 10 matches):
  - Movement: wait 379, dash out 357, drift in 337, drift 299, drift out 256, dash in 244, walk out
    72, shield 66, dash dance 54, empty hops 45, dash grab 22.
  - Commitments: air crescent 69, crescent 39, and a long tail of aerials, tilts, smashes, throws,
    ledge and out-of-shield options.
- **Move starts:** sspecial 108, fair 32, nspecial 27, nair 25, dashatk 24, dair 20, uspecial 17,
  uair 14, usmash 12, bair 11, utilt 8, dtilt 6, jab 6, fsmash 5, ftilt 4, dsmash 1.

### Start-of-match cost (warm-up and budget ramp)
- `warmAevalmere(config)` allocates the pooled states, builds the combo table for the current tuning,
  and plays 400 throwaway frames of Aevalmere against itself on a scratch match that has its own
  config and its own random. The search code is compiled before frame 0, and no real outcome changes:
  the real first call sees a new config and resets the slot's memory, keeping only the pools.
- The function is idempotent per config object. `cpuInput` calls it lazily on the first level 10
  frame, and a host can call it earlier.
- Budget ramp: for the first 240 sim frames a decision may spend 600 steps; after that, 2600.
- Measured with a pre-match warm-up, over 3000 frames:

  | Match | Warm-up | First call | Max call, frames 1-299 | Steady p99 |
  |---|---|---|---|---|
  | Warmed match (2nd and later in the process) | 37 ms | 0.33 ms | 1.6 to 1.8 ms | 1.2 to 1.9 ms |
  | First match in a cold process | 170 to 190 ms | 1.6 ms | 2.3 to 6.5 ms | 2.2 to 2.6 ms |

  In the cold process the whole sim and the level 9 code are still being JIT-compiled.
- With the lazy path only, the warm-up cost lands in the first call instead: 40 to 195 ms, a
  one-frame hitch. Calling it from the host before frame 0 avoids that.
- A dodge now goes stale like an attack. Without that, the budget ramp let one mirror seed lock
  into a mutual spot-dodge loop.

### Kill speed (test al)
The owner saw a human who pressed nothing sit at 100% after 95 s with no KO. The harness reproduced
it on some seeds against a level 0 dummy: after a KO the brain parked on a side platform above the
dummy and shielded, spot dodged or waited for the rest of the stock (about 1% per second).

Cause: the habit tables only counted actions the opponent started, so a player who does nothing was
never learned. The attacking and shielding replies kept their full weight and, as the worst case,
vetoed every approach that ended near the target. The stall pull that should have broken it measured
horizontal distance only, so a fighter 84 px straight above the target counted as close.

Fix:
- Doing nothing is a neutral habit: every 20 frames free in neutral without an attack, grab, shield
  or dodge counts as one "nothing" answer. Passivity moves weight to the keep-going reply, lowers
  lambda by up to 0.45 and makes the stall clock run up to 5x faster.
- A reply with under 8% of the weight no longer sets the worst case.
- The stall pull uses real distance; platform drop is offered out to 120 px.
- Kill terms, all read against the live blast rect: holding a grab is worth a KO when a throw would
  kill from there, and a rollout that ends free next to a grounded target that usmash, fsmash or a
  throw would KO gets a kill-threat bonus, which walks the brain toward the ledge and into range.
- Hitstun and frame-advantage credit scale with reach (full inside 90 px, none past 250 px), and a
  launch that is no KO pays 0.06 per px the victim ends beyond 90 px. Parking the victim high under
  the tall ceiling buys nothing.
- A fighter hovering on the stage lip (a sim quirk, see DECISIONS.md) counts as standing, and the
  geyser is not thrown at targets more than 130 px above.

Measured (level 10 on slot 0, 3 stocks, 3600-frame cap):

| Dummy | Seed 5 | Seed 17 | Seed 23 |
|---|---|---|---|
| Standing, first KO / all 3 | 1038f / 2786f | 370f / 2025f | 654f / 2677f |
| Wandering, first KO | 518f | 1223f | 872f |

Over 30 extra seeds against a standing human slot, median first KO is about 600 frames and no seed
stalls. Damage runs at about 6% per second; with the raised ceiling the moves themselves put kills at
about 100% (bthrow at the ledge) to 140% (usmash), so the floor on a stock is set by the move data.
Against level 9: still 10/10, 0 SDs, 0 early shields, 0.09 ms per call.

### Retune for the 2026-09-29 balance and ledge wave
The move pass (BALANCE_GUIDE.md) and the ledge rules (SPEC 4.5) broke five cases: `d`, `j`, `al`,
`ap` and `aq`. The common cause was the ledge. A fighter falling past a ledge with no input now
grabs it, and a hanger is out of reach of every melee hitbox except dtilt, dsmash and dair
(`hitsLedge`). A standing level 0, the scripted spammer and the ledge-test dummy all ended up
hanging for the rest of the match while the CPUs threw forward smashes and crescents over them.

What changed:
- Ledge traps (level 10): three plans, `ledgeTrapDtilt`, `ledgeTrapDsmash` and `ledgeTrapDair`,
  offered first (with the edgeguard bonus) against a hanger within 260 px. Each runs to the spot
  (dtilt 16 px inward of the corner, dsmash 24, dair 3), then walks the last 50 px, and swings so
  the first active frame lands as the hanger's ledge invincibility ends. That time is read off the
  perceived state when the plan is chosen, like the plan direction. Rollouts still pick among
  them, so dtilt pops the hanger up for a follow-up and dsmash sends it out at 30 degrees.
- Ledge punish (levels 1 to 9): `ledgeApproach` has a hanging branch. The CPU walks to 16 px
  inward, where dtilt and dsmash both reach the hang hurtbox, and uses dsmash (always from 60%,
  otherwise by smash accuracy) or dtilt, timed past the invincibility. Disciplined profiles wait
  at 44 px, outside the ledge attack, until the invincibility is nearly over. The charged forward
  smash at a hanger is gone: it can no longer hit one.
- Helpless over the stage (levels 1 to 9): drift to the middle. Chasing a hanger from there
  drifted off the lip with the ledge taken, a self-destruct the new rules made common.
- Predictor: a hanging or lying opponent can only climb, attack, roll, jump or drop, stay or stand.
  Guesses outside that set (the rhythm and sequence models know nothing of the situation) are
  masked out. That fixed `ap`, whose worst pair was a rushdown hanging more often than before.
- Orb drain: a rollout credits percent healed at the same 1.25 weight as damage taken, so a
  landed orb is worth more than one thrown for space.
- Frame data: the combo table, kill confirms and every rollout read `moves.ts`, so the slower
  utilt, usmash and uair, the stronger fair and bair, the new nair and the dair bounce are picked
  up without table edits: the table is rebuilt at module init and the rollouts score fair and
  bair kills, nair starters and post-bounce dair follow-ups on what the sim actually does. The
  level 1 to 9 juggle reads startup and reach from the move data, so no constants changed there.

Measured after the retune (same harness): `d` 36% on the hanger, `j` 6/6 against the spammer,
`al` standing first KOs 455/501/463 f, `ap` mean gain 15.7 points with the worst pair -2.5,
`aq` 43% routed and a median first KO of 630 f (10.5 s) against a standing dummy. `ar` still fails
on p99 alone inside the full harness (about 5 ms); run on its own the same match measures 0.12 ms
mean and 2.7 ms p99. It failed the same way before this retune. No threshold was changed.

## 4. Known limits
- What the wave 2 gates mean (coordinator decision, 2026-09-29): the substantive gates are 0 stocks
  lost to the six archetypes (36/36 matches won, 0 stocks, 0 SDs) and the profile transfer (+17
  points of first-15 s accuracy over 36 pairs). The accuracy check `ao` is informational only: a
  30-guess window swings 5 to 10 points between runs, so it pools both stages per archetype (6
  matches) and asks for a mean cumulative first-30 s accuracy of 50% and every match at 40%.
- `ao` is informational (coordinator decision, 2026-09-29): it prints its numbers with an INFO prefix
  and never fails the suite. Last run: camper 49% mean (worst 45%) and roller 47% (worst 35%) sit
  under the 50% / 40% reference; rushdown 64/50, turtle 69/62, ledge 62/55, jumper 53/47 are over
  it. The camper and the roller act on a beat after long stretches of drifting, and every match
  starts cold (nothing learned), so 30 s of guesses is too small a sample to gate on. One timing
  iteration (phase in the context, a rhythm model, a still-nothing-vs-acts-now vote) did not close
  the gap.
- The predictor and the profile make the brain safer more than faster: turning the predicted replies
  off entirely moved the archetype mean first KO from 1172 to 1106 frames (within noise), and 0
  stocks were lost either way.
- Decision (accepted 2026-09-29): a fighter spiked while standing can rest in `tumble` on the floor,
  hitstun spent, until it presses something. That is sim behaviour and stays. The brain treats a
  grounded tumble with no hitstun or hitlag left as a free, passive opponent (`neutralFree`), so it
  is read as "doing nothing" and approached; before, the level 10 whiffed up smashes at one for
  150 s.
- Harness decisions (accepted): test `x` counts level 1 projectiles actually shot down, not clash
  events, because under the strength tiers a clash no longer means a shot came down. Test `ak` does
  not count a projectile thrown toward the enemy, or an up special started off the stage (a
  recovery), as a swing at a teammate.
- The profile is about 190 KB of JSON per player and is serialised on every KO (a few ms on that
  frame) and when the results screen opens (`src/main.ts` calls `flushAevalmereProfiles()`).
- The reply models are simple policies, not the opponent's real brain. Against an opponent that
  breaks every model at once, the search falls back to its worst-case blend.
- Rollouts inside `stepGame` still allocate the sim's own event objects. The brain itself allocates
  nothing per frame once the pool exists.
- The combo table only knows Aeval's own moves (the only character). A second character needs its own
  starters, which `buildComboTable` can take from the registry.
- There is no perfect shield or parry in the sim, so none is used. If one is added, the reply models
  and the shield plan need a timing variant.
