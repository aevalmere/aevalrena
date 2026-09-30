# 05. Professional skills inventory and acceptance checklist

What top Super Smash Bros. Ultimate players are good at, each mapped to the subsystem that
implements it, the frame numbers that govern it in Aevalrena, and the tier that must show it. This
is the reviewer's list: a row marked "god" must be demonstrable in a replay of balanced level 5,
and a row marked "L5" must appear at the world's-best tier at human rates.

Sources are the SSBWiki mechanic and player pages read in the research (cited per row); no video
analysis was readable, so player tendencies are as SSBWiki documents them. Tier columns: L1
casual, L2 intermediate, L3 advanced, L4 top player, L5 world's best, G god (03, section 1). "rate"
means the skill is present but succeeds at the tier's execution and reaction rates.

## 1. Neutral

| Skill | How a human does it | Aevalrena numbers | Subsystem | Tiers | Test |
|---|---|---|---|---|---|
| Spacing outside the opponent's threat range while inside own poke reach (https://www.ssbwiki.com/Spacing) | muscle memory plus matchup knowledge | own poke reach (Aeval ftilt 80 px, fsmash 102) versus their fastest reaching move plus travel over `R + startup` frames | affordances, stage-control term | L3 rate, L4, L5, G | share of neutral frames inside their threat range but outside own reach is low; rises with level |
| Dash-dance baiting and empty hops (https://www.ssbwiki.com/Dash-dancing, https://www.ssbwiki.com/SmashWiki:Glossary bait) | conditioning then a whiff punish | dash 12 frames at 2.8 px/frame, reversal restarts the dash; short hop 3-frame release window | bait-probe candidates, predictor uncertainty bonus | L3 rate, L4, L5, G | probe count per minute and the whiff-punish rate that follows probes |
| Whiff punishing (https://www.ssbwiki.com/SmashWiki:Glossary punish) | reaction to endlag | their `iasa - activeEnd - 1` minus our travel and startup; reactable at L3 for windows 16 frames or wider (03, 2.1) | whiffPunishable prefilter, rollouts | L2 rate, L3, L4, L5, G | share of openings that start inside opponent endlag |
| Shield pressure and safe pokes | knowing what is safe on shield | measured on-shield advantage; grab active frame 7 out of shield | shield-safety probe, defend reply | L3, L4, L5, G | count of pokes punished out of shield per minute falls with level |
| Cross-ups and mixups as rock-paper-scissors (https://www.ssbwiki.com/Mindgame) | mixed strategy | payoff matrix from rollouts | maximin mix when confidence is low, best response when high | L4 rate, L5, G | per-situation option entropy above the floor |
| Projectile zoning and anti-zoning (https://www.ssbwiki.com/Projectile, https://www.ssbwiki.com/Approach, https://www.ssbwiki.com/Camping) | firing from a safe range, answering with the cheapest option | tap orb safe from about 142 px against a 3.1 px/frame runner; full orb reaches a 200 px target in about 19 frames | shootSafe, chargeDecision, answerProjectile | L2 rate, L3, L4, L5, G | shots punished per shot; answers per incoming shot by cost |
| Platform use (https://www.ssbwiki.com/Camping platform camping) | landing on and dropping through platforms to control approach angles | side discs at y -84, one full hop up; pass-through | platform candidates, affordances from above and below | L3, L4, L5, G | platform landings per minute; juggles won from below |
| Stage control and cornering (https://www.ssbwiki.com/Neutral_game) | pushing the opponent to the ledge where kill percents fall | kill percent at the ledge is lower than at center for every horizontal killer (probe) | stage-control term, kill-threat bonus | L3, L4, L5, G | mean opponent distance from center while we hold center |
| Conditioning: establish a pattern, then break it (https://www.ssbwiki.com/Neutral_game, https://www.ssbwiki.com/Mindgame) | deliberate | bounded bait-probe family | 02, 6.7 | L5 rate, G | a scripted "learns your pattern" adversary is beaten by the break |

## 2. Advantage

| Skill | How a human does it | Aevalrena numbers | Subsystem | Tiers | Test |
|---|---|---|---|---|---|
| True combos by percent (https://www.ssbwiki.com/Combo, https://www.ssbwiki.com/Hitstun) | percent knowledge and reaction to the hit | `budget = floor(0.4 kb) - (E + J + S + Tr) + 1`; Aeval utilt to uair true from about 12.6% | combo table, per-hit replanning | L3 depth 2, L4 depth 4, L5, G | three-hit true combos per match; combo drops per tier match the execution table |
| Kill confirms (https://www.ssbwiki.com/Combo, Fox nair to usmash example) | knowing the starter's confirm window | window `[max(p_true, p_koF - d_s), p_upper]` per spot | kill routing | L4 rate, L5, G | share of KOs that were routed (2+ hit or edgeguard); god 47% today, target higher |
| Juggling and landing traps (https://www.ssbwiki.com/Air_dodge, one dodge per airtime; https://www.ssbwiki.com/Edgeguarding on Ultimate's weaker offstage escapes) | staying under, catching the dodge or the jump | air dodge exit frames 32 to 33, no refund by a hit; double jump apex 32 frames | predictLanding, anti-air choice by coverage | L3 rate, L4, L5, G | hits landed on a falling opponent per juggle; dodges baited |
| Tech chasing (https://www.ssbwiki.com/Tech-chasing) | reaction to the option, read of the rest | tech window 20 frames; in place vulnerable 21 to 25, roll 21 to 39 (40 px), getup 23 to 29, getup roll 26 to 34; rolls stop at platform edges | chase procedure | L3 (wide windows), L4, L5, G (all on reaction) | punish rate per tech option per tier matches the feasibility table |
| Ledge trapping, covering several options with one placement (https://www.ssbwiki.com/Edge ledgetrapping) | position that covers the modal options, react to the rest | climb 30 (vulnerable frame 29), attack 40 (23 to 24 active and vulnerable), roll lands 34 px inside on frame 24, jump 12 invulnerable frames, hang hurtbox exposed after 40 | coverage matrix | L3 rate, L4, L5, G | damage per ledge grab suffered by the opponent; roll punished at L5 and G |
| The 2-frame equivalent: hitting before the grab (https://www.ssbwiki.com/Edge two-frame punish) | timing a tilt or smash to the snap | a hit on frame `N - 1` cancels the grab; feet 2 to 72 px below the top within 30 px of the corner | predictGrabFrame, placeHitbox | L4 rate, L5, G | pre-grab hits per recovery |
| Edge-hogging (Aevalrena has no trump; https://www.ssbwiki.com/Edgeguarding) | taking the ledge first | occupied ledge cannot be grabbed; 40 invulnerable frames | hog plans | L3, L4, L5, G | hogs that end in a KO |
| Edgeguarding offstage with aerials and spikes (https://www.ssbwiki.com/Edgeguarding, https://www.ssbwiki.com/Spike, https://www.ssbwiki.com/Meteor_smash) | knowing when the opponent cannot make it back, and when we can | dair angle 270, startup 12, landing lag 16; recover box per character; geyser counter-hitbox frames 8 to 20 | canGetBack for both, edgeguard chooser, counter-edgeguard filter | L3 (one aerial), L4, L5, G | edgeguard KOs per stock; own SDs from edgeguards is 0 at L4 and up |
| Gimps and footstools (https://www.ssbwiki.com/Gimp, https://www.ssbwiki.com/Footstool_Jump) | hitting the double jump, footstooling below the ledge | footstool: feet 0 to 12 px above their hurtbox top, victim loses 20 airborne frames and 120 px | gimp test, footstool plan | L4, L5, G | gimps per stock |
| Ledge carry: sending the victim offstage low (https://www.ssbwiki.com/Semi-spike) | choosing launch angle and position | `ledgeCarry` scoring | kill routing | L4, L5, G | share of kills that end offstage |
| Percent knowledge: knowing every kill percent at every position | study | kill percent map per spot per matchup | 04 probes; L3 reads with error, L4 up exact | L3 rate, L4, L5, G | kill moves thrown below their kill percent at the position per tier |
| Closing a stock: kill-move selection by position and staleness | judgment | staleness cost (no sim stale queue yet) | selection, staleness term | L4, L5, G | KO percent distribution by tier |
| Shield break setups (https://www.ssbwiki.com/Shield) | pressure on a holding shield | 0.12 HP per frame plus shield damage; full orb costs 16 of 60 | shield term | L4, L5, G | shield breaks caused per 10 matches against the turtle adversary |

## 3. Disadvantage

| Skill | How a human does it | Aevalrena numbers | Subsystem | Tiers | Test |
|---|---|---|---|---|---|
| Survival DI and SDI (https://www.ssbwiki.com/Directional_influence) | stick timing on the last hitlag frame | absent from the sim: survival is position and stock-aware risk | 02, 11.5 | n/a | kills suffered at the ledge below the danger threshold |
| Teching consistently (https://www.ssbwiki.com/Tech) | anticipating the landing | window 20 frames, lockout 40; tech in place 26, roll 40 | tech reflex | L2 rate, L3, L4, L5, G always | tech rate per tier; god 100% |
| Choosing the tech and getup option against coverage | reading the chaser | option coverage rollouts | tech decision | L3, L4, L5, G | punished tech options per tier |
| Escaping juggles: drift, fast fall, timing, dodge discipline (https://www.ssbwiki.com/Air_dodge) | not air dodging on every attack | one dodge per airtime, 34 frames, invulnerable 2 to 31 | landing policy search, dodge scarcity | L3, L4, L5, G | air dodges used per juggle; dodges baited per match falls with level |
| Ledge option mixing (https://www.ssbwiki.com/Edge_getup) | not being read | roll is the safest option in this sim; jump the fastest | ledge choice by matrix and anti-repeat | L3 rate, L4, L5, G | entropy of ledge options per situation |
| Recovery mixups: high, low, early, late, air dodge snap, drop and regrab (https://www.ssbwiki.com/Recovery) | route choice against the guarder | geyser from 77 to 147 px depth reaches the region; air dodge snaps mid-dodge; 66-frame stall | recovery matrix | L2 (one route), L3 (two), L4, L5, G | SD rate by tier; route entropy |
| Waiting out an edge-hog | hovering until the hog's invulnerability ends | 40 frames from the hog's grab; one jump gives about 68 frames | recovery routes with delay | L4, L5, G | stocks lost to hogs |
| Out-of-shield punishes at the fastest option (https://www.ssbwiki.com/Out_of_shield) | frame knowledge | grab 7, jump plus aerial 4 plus startup, up smash 12, up special from data | OOS table | L3, L4, L5, G | punish rate after a shielded unsafe poke |
| Never panic: no buffered attacks in hitstun (https://www.ssbwiki.com/Buffer) | discipline | buffer 6 frames keeps ageing through hitlag; any non-tech press in tumble throws away the tech | buffer hygiene reflex | L3 rate, L4, L5, G | count of attacks that start on the first actionable frame after hitstun (humans do this; god never) |
| Shield health management (https://www.ssbwiki.com/Shield) | dropping before a break | HP 60, break 180 frames | shield floor reflex | L2, L3, L4, L5, G | shield breaks suffered per tier |
| Resetting to neutral instead of challenging | risk judgment | certain-loss veto, CVaR | selection | L4, L5, G | trades taken while a stock behind |

## 4. Mental game

| Skill | How a human does it | Subsystem | Tiers | Test |
|---|---|---|---|---|
| Reading habits within a game (https://www.ssbwiki.com/SmashWiki:Glossary read) | pattern memory | n-gram predictor, Wilson-gated exploits | L3 rate, L4, L5, G | first-30-second prediction accuracy against the scripted adversaries |
| Adapting between games and stocks (MkLeo's documented comeback adaptation, https://www.ssbwiki.com/Smasher:MkLeo) | between-game adjustment | changepoint reset, per-player profile | L4, L5, G | profile-transfer accuracy gain (+17 points measured) |
| Baiting and punishing (https://www.ssbwiki.com/Smasher:Dabuz) | patience | countering archetype filters; bait probes | L4, L5, G | whiff-punish share of openings |
| Playing the percent: no trades that lose the stock | risk arithmetic | stock-aware lambda, veto | L4, L5, G | trades taken at a losing percent |
| Tempo: slowing down when ahead, closing when behind | judgment | lambda by stock lead, engagement clock | L4, L5, G | approach rate by stock state |
| Not being read: varying options and timings (Sparg0's documented aerial variation, https://www.ssbwiki.com/Smasher:Sparg0) | deliberate variation | anti-repeat rules, seeded softmax, staleness | L4, L5, G | option entropy; repetition share under bound |
| Reacting rather than guessing when reaction suffices (Light's documented reaction to ledge getups, https://www.ssbwiki.com/Smasher:Light_(Connecticut)) | speed | reaction gate versus anticipation path | L4, L5, G | reaction histogram per stimulus |
| Calculated all-ins when the stock state favors it (Sparg0) | judgment | V_STOCK by stock state in the edgeguard chooser | L5, G | sacrificial trades taken only when ahead or even on last stocks |

## 5. Execution

| Skill | Aevalrena numbers | Subsystem | Tiers | Test |
|---|---|---|---|---|
| Frame-tight inputs: short hop (3-frame window), smash flick (5), jump-cancel up smash (frames 1 to 2 of the squat) | drop rates per tier in 03, 2.2 | humanizer, direct codes | L4 rate (95% on 3 frames), L5 (99.6%), G (100%) | measured success on each window per tier |
| Follow-ups pressed inside the buffer window (`iasa - k`, k at most 6) | buffer 6 | pre-buffered next plan | L4, L5, G | frames lost between actionable and the next press |
| Exact spacing stops | digital movement; hold-length search | executor | L5 rate, G | px error at the intended stop |
| Charge release on the opponent's committed frame | charge up to 60 frames, +40% | charge timing | L4, L5, G | charged smashes landing on ledge roll landings (frame 24) and getups (frame 23) |
| Mash-out | god one bit per 2 frames (20 frames at 0%), L5 per 3, L3 per 12, L1 and L2 none | mash cap | all | escape time per tier |
| No accidental moves (tilt as smash, dash as roll, shield in the air) | tap mirror, direct codes | guard | all | accident count is 0 at L4 and up |

## 6. Character and matchup knowledge

| Skill | Subsystem | Tiers | Test |
|---|---|---|---|
| Knowing the opponent character's options and ranges | matchup profile: their `framesToHit`, threat zones | L3 rate, L4, L5, G | hits taken inside the opponent's documented reach per minute |
| Knowing the opponent's kill percents on us | danger map | L4, L5, G | kills suffered at a position below the danger threshold |
| Punishing character-specific recoveries | recover box per character, recovery-route habit | L4, L5, G | edgeguard KOs per stock by opponent character |
| Answering multi-hit, command grabs, invulnerable startups | recognition score (03, 2.3) | L3 partial, L4, L5, G | punished by the Final Smash command grab or the whirlpool multi-hit per tier |

## 7. What no tier may do

Taunt; read inputs (perception under 4 frames at any tier, under the human floor at human tiers);
shield on an opponent's first active frame; roll off the stage; edgeguard when our own recovery
cannot return; play for a timeout at balanced 5; repeat a special more than five times offstage
without returning; hold shield to a break; stand still on the respawn platform for its full time at
L4 and up.
