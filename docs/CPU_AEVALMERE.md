# Aevalmere: the level 10 CPU

Code: `src/ai/aevalmere.ts`. Level 10 is routed there by `cpuInput` in `src/ai/index.ts`.
Tests: `src/ai/aitest.ts`, cases `ae` to `al` (`npx --yes tsx src/ai/aitest.ts`).

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

## 4. Known limits
- The reply models are simple policies, not the opponent's real brain. Against an opponent that
  breaks every model at once, the search falls back to its worst-case blend.
- Rollouts inside `stepGame` still allocate the sim's own event objects. The brain itself allocates
  nothing per frame once the pool exists.
- The combo table only knows Aeval's own moves (the only character). A second character needs its own
  starters, which `buildComboTable` can take from the registry.
- There is no perfect shield or parry in the sim, so none is used. If one is added, the reply models
  and the shield plan need a timing variant.
