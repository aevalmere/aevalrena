# CPU plan: one search brain, five levels plus god, four archetypes

Status: plan, 2026-09-29. Source design: `docs/cpu-guide/` (00 to 06). Current code: `src/ai/index.ts` (levels 1 to 9,
rule tables), `src/ai/aevalmere.ts` (level 10, search), `src/ai/profile.ts`, `src/ai/aitest.ts`; described in
`docs/CPU_AEVALMERE.md`. The 2026-09-29 balance and ledge wave (button-only ledge climb, `hitsLedge` on dtilt, dsmash
and dair, dair `bounceOnHit`, nair rework, orb drain heal) is the baseline every number below is measured against.

Workers read this file first, then only the guide sections their task names. Guide references are written `02 §7.4`
(file 02, section 7.4). Test ids (`at` to `bh`) are from 06 §4.

## 1. Gap analysis

Legend: EXISTS (usable as is, port only), PARTIAL (what is missing follows), MISSING.

| Subsystem (guide) | Status | Where it lives today | What is missing |
|---|---|---|---|
| Perception delay (02 §3) | PARTIAL | `aevalmere.ts`: `snapshot`, `perceive`, `AEVALMERE_REACT = 4`, `HIST = 8` ring, `copyGameStateInto` | Delay is fixed at 4 for level 10 only; levels 1 to 9 use `reactMs` 250 to 17 ms (`CPU_PROFILES` in `index.ts`), which is below the 10-frame human floor from level 3 up. No own-input delay compensation for LAN (02 §3.5). |
| Hidden-frame hypotheses (02 §3.3, §3.4) | PARTIAL | `rollout` replays the delay window with the reply model already acting | No explicit hypothesis set (nothing / move m started k ago / shield / dodge / jump), no predictor weighting, no top 4 to 6 cut, no commitment rule. |
| Affordances and threats (02 §4) | PARTIAL | `busyFrames`, `moveStartup`, `recoverable`, `projectedKo`, `hitKillsFrom`, `throwKills`, `killThreat`, `offstage`, `underStage`, `homeSign` in `aevalmere.ts`; `framesToActive`, `vulnerableFor`, `incomingProjectile` in `index.ts` | `framesToHit`, `threatZone`, `whiffPunishable`, measured `safeOnShield`, `killPct` per spot, `canGetBack` from an envelope table plus exact rollout, situation classifier as one function. |
| Candidate plans (02 §5) | PARTIAL | 115 plans via `defPlan` and `planStep` (`P_WAIT` to `P_LT_DAIR`), filtered in `buildCandidates` | Plans are hard-coded per Aeval move id and direct code (breaks hard rule 4). Missing: families generated from profile roles, parameters (orb hold 15/30/45, smash charge n, shield duration, wait n), `legalIn`, affordance prefilter to about 25, vocabulary gating per level. |
| Opponent model, predictor bank (02 §6.1, §6.2) | PARTIAL | `Pred`, `predObserve`, `predict`, `ctxRows`, `scoreComponents`, `record`, six members mixed by hit rate squared, timing vote | Win-stay/lose-shift and counter-me members, log-score weights, fast table (0.85), alphabet additions (jab mash, recovery route, buffered attack out of hitstun), percent bucket and stage zone in the context. |
| Exploit gating (02 §6.3, §6.4) | PARTIAL | `exploitMask` (answer above 55% with 3+ history, +5 bonus), predictor weight cap 0.75 in `pickModels` | Wilson lower bound, break-even `p*`, gift budget, `p = p_max * clamp((LB - 0.4)/0.6)`. |
| Changepoint reset (02 §6.5) | MISSING | none | LLR of fast over slow table with 3.0-nat reset, broken-habit rule, stock-change decay 0.7 for 600 frames, poisoned-prior guard (02 §6.9). |
| Profile store (02 §6.9) | EXISTS (extend) | `profile.ts`: `ProfileStore`, `MemoryProfileStore`, `CappedProfileStore`, `profileKeyFor`; `serializeProfile`, `loadProfile` in `aevalmere.ts` | New members and tables need a v2 format; archetype and skill estimate fields. |
| CVaR search (02 §7) | PARTIAL | `rollout`, `evaluate`, `decide`: `lambda * worst + (1 - lambda) * tail-weighted mean`, 5% stock-loss veto, 8% worst-case floor, `STEP_BUDGET = 2600`, ramp 600 for 240 frames | CVaR at `alpha`, one certain-loss veto (0.5 weight), common window `W` with neutral padding (horizons differ per plan via `PLAN_H`), outcome vector (score is a scalar today), second ply on hit, fictitious-play mix for RPS spots. |
| Neutral (02 §8) | PARTIAL | dash dance, empty hops, spacing and stage terms in `evaluate`, stall pull `STALL_FRAMES = 420` | Spacing from `threatZone`, bait probes with information bonus (02 §6.7), maximin mix at low confidence, adaptive `spacingMul`. |
| Advantage, true combo test (02 §9.1, §9.2) | PARTIAL | `followFits`, `chainSearch`, `buildComboTable`, `launchAfter`, `launchKills`, `bracketOf` (fixed 0/30/60/100), starters by Aeval index | Generic starters from the profile, matchup brackets (04 §5), hit-frame class, dx/dy buckets, lazy per-bracket build. |
| Kill routing (02 §9.3) | PARTIAL | `kcOn`, kill-confirm bonus +10, `aevalmereKillConfirms` | Percent window `[max(p_true, p_koF - d_s), p_upper]`, `ledgeCarry` term, route score formula. |
| Juggle and tech chase (02 §9.4, §9.5) | PARTIAL | tech reply models `OM_T_*`, `OM_D_*` | `predictLanding` policy set, anti-air by coverage, reaction-versus-precommit chase procedure. |
| Ledge trap (02 §9.6, §10.3) | PARTIAL | `ledgeTrap`, `P_LT_DTILT`, `P_LT_DSMASH`, `P_LT_DAIR` timed to invulnerability end; `P_EG_HOG` | Coverage matrix over six options x three timings, roll landing on frame 24, climb frame 29, Dirichlet habit weights, pre-grab hit at `N - 1`. |
| Edgeguard (02 §10) | PARTIAL | `egFair`, `egBair`, `egDair`, `egNair`, `egFairDair`, `egBairDair`, veto when the rollout never returns; `recoverable` heuristic | `recoverBox` envelope table, exact `canGetBack`, `V_STOCK` by stock state, counter-edgeguard hitbox filter, footstool plan, projectile walls as edgeguards. |
| Disadvantage (02 §11) | PARTIAL | tech reflex (`tumbleLandIn`), getup and tumble-exit plans, `recoverStep` with four variants (`REC_JUMP_AT`, `REC_US_AT`) | Recovery matrix solved as a game, delay and hold-direction parameters, waiting out a hog, no route repeat across stocks, landing-policy search, danger-map positioning, OOS ranked by measured advantage, varied downed wait. |
| Projectiles (02 §12) | PARTIAL | `P_NSPEC` (tap), `P_NSPEC_FULL` (60 held), crescent, stale x2 for shots; `planProjectileCounter`, `simulateClash` in `index.ts` (levels 1 to 9 only) | `shootSafe`, `chargeDecision` with holds 0/15/30/45/60, `answerProjectile` cost model, zone term, shot band. |
| Engagement clock, cycles (02 §7.6, §12.4) | PARTIAL | damage clock `STALL_FRAMES`, repetition score over 16 moves, staleness `STALE_DECAY`/`STALE_COST` | Engagement clock reset rules, pressure `p`, cycle detector over 12 tuples, staleness decayed by elapsed frames. |
| Passive-opponent kill routine (02 §13) | PARTIAL | `passivity`, `neutralFree`, kill-threat bonus; measured 2,025 to 2,786 frames for 3 stocks | Half-passive detection (shield only, jump only, roll only), grab-carry-throw-spike route family, gate `bf`. |
| Executor (02 §14.1, §14.3, §14.4) | PARTIAL | `finish`, `press`, `safeDir` (reads the sim's `dirTapAge`), direct codes `C_*`, early-shield gate | Staged pipeline, tap mirror in output-frame coordinates, pre-buffered follow-ups at `iasa - k`, exact spacing stop search, charge release timing. |
| Reflexes (02 §14.2) | PARTIAL | mash four bits per frame, respawn drop at 20, tech reflex, launched plan drop | Mash cap per level, buffer hygiene as one rule, ledge option from hang frame 1, shield floor per level. |
| Input caps (02 §14.5, 03 §2.3) | MISSING | none | Sustained input events per second per level, mash rate per level. |
| Determinism (02 §14.6, 00 rule 3) | PARTIAL | step budgets (not wall clock), tests `n`, `ah`, `as`; no `exp`/`pow`/`log`/`atan2` in decision code (checked: the `**` hits are JSDoc) | Randomness comes from the shared sequential `rand` passed to `cpuInput` (one stream across all CPU slots in `main.ts`); counter-based `u01` hash missing. |
| 3 and 4 players (02 §15) | PARTIAL | `nearestOpp`, team terms in `evaluate`, test `ak` | Target scoring, retarget hysteresis (30 frames), two-opponent rollouts, save bonus. |
| Skill axis level vector (03 §2) | MISSING (as designed) | `CpuProfile` table of 19 hand knobs for levels 1 to 9 | Reaction model with Hick term, execution jitter and lapse, decision knobs, menu and vocabulary, all as curves of one scalar `s` (03 §2.5). |
| Style axis archetypes (03 §3) | MISSING | none (the UI has one difficulty slider, no style) | Four style vectors, candidate filters, tag bias, trigger, stall clock, shot band. |
| Humanizer (03 §2.2, §4) | PARTIAL | `HUMAN_ALT = 0.06` safe-alternate swap in `decide`; `missChance` in the rule brain | Timing jitter as a real offset, lapse with notice-and-retry, error catalogue, bait weakness, recognition gaps, `accidentTolerance`. |
| Character profile derivation (04 §2, §3, §4) | MISSING | Aeval facts spread as constants: `LT_*_SPOT`, `REC_*`, `USE_REACH`, `finisherBox`, `strongest`, combo starters; `calibrate.ts` `measure` probes center kill percent | `deriveAiProfile`, tags, roles, shot and recovery profiles, grab info, matchup profile, cache by data hash. |
| Override file (04 §4, §8) | MISSING | none | `src/characters/aeval/ai.overrides.json`, contradiction check. |
| Test harness, Wilson and SPRT gates (06 §1) | PARTIAL | `aitest.ts`: fixed 5 seeds x 2 sides, `WIN_RATE_FLOOR = 0.7` over 10 matches | Wilson intervals, SPRT, Elo and Bradley-Terry, Cohen's d, Mann-Whitney, tiers, parallel shards. |
| Metrics (06 §2) | PARTIAL | per-case counters in `aitest.ts` (kit use, dodges, combos, KO routing `aq`) | One replay-driven metrics module: openings, conversions, style signatures, reaction histograms, entropy, accidents, cost. |
| Scripted adversaries (06 §3) | PARTIAL | six in `aitest.ts` (rushdown masher, turtle, camper, roller, ledge camper, jumper), level 0 dummy and `cpuZeroMoves` wander | Shield-only, jump-only, "learns your pattern", "changes style at 30 s", as a reusable module. |
| Monotonicity and human-likeness tests (06 §4 `at`, `aw`, `ax`, `ay`, `bg`) | MISSING | test `c` (higher level wins 7 of 10) | All of them. `ay` and the blind test need recorded human data the repo does not have. |

## 2. Fixed decisions for this wave

These are set by the lead and are not reopened by workers.

1. Respawn platform time. `RESPAWN_PLATFORM_FRAMES` is a single constant in `src/core/constants.ts` (180), read only
   by `stepRespawn` in `src/sim/match.ts`. Worker W1.1 sets it to 100 and runs `npm run test:sim` and `npm run
   test:net`. If both pass, it stays at 100 and the passive-kill target is the guide's: median 3-stock time 1,200
   frames or less against the stationary dummy (`ba`), first KO by frame 400. If either fails for a reason other than
   a test that hard-codes 180, it goes back to 180 and the target becomes 1,800 frames median (the guide's "now"
   gate), with 1,450 frames as an informational stretch (02 §13.2 without spikes). A test that hard-codes 180 is
   updated to read the constant, not treated as a failure.
2. No new sim mechanics: no stale-move queue, ledge trump, 2-frame window, post-release grab immunity, charge cancel
   or dodge staleness. The brain keeps its own staleness cost (02 §6.8).
3. Exception: the sim caps mash-out at one credited bit per 2 frames per grabbed victim (`src/sim/grab.ts`, today
   `grabTimer -= mashFrames * bitCount(pressed & MASH_BUTTONS)`). This is a fairness fix and applies to humans and
   CPUs alike. The executor still applies the per-level mash rates of 03 §4 on top (none at guide L1 and L2, one per
   12 frames at L3, one per 3 at L5, one per 2 for god, which the sim cap then equals).
4. Balanced level 5 is the god (Aevalmere). Balanced level 4 is world's best. Aggressive, defensive and countering use
   casual, intermediate, advanced, top player, world's best for levels 1 to 5. The equal-level cross-archetype test
   `au` compares balanced 4 with the others' level 5.
5. One engine everywhere. Levels 1 and 2 run the search brain degraded (level 1: static evaluation, 0 rollout steps).
   The rule brain in `src/ai/index.ts` is deleted once the degraded engine passes the level tests (section 3, W3.2
   gate). `cpuInput(state, slot, level, rand)` keeps its signature; level 0 stays the dummy (`dummyInput` moves to
   `src/ai/dummy.ts`); the UI keeps levels 0 to 10 and their names (`CPU_LEVEL_NAMES` in `src/ui/context.ts`).
6. `jumpsLeft` stays as it is. Recovery probes and `canGetBack` read the live value.

### 2.1 UI level to guide mapping

The UI has no style control, so every UI level is balanced. Guide levels are points on the skill scalar `s` (03 §2.5);
UI levels between guide points interpolate `s` linearly between the calibrated values of the two neighbours.

| UI level | Name | Archetype | Guide level | Skill scalar s (initial, before calibration) |
|---|---|---|---|---|
| 0 | Dummy | none | dummy (unchanged) | n/a |
| 1 | Rookie | balanced | L1 casual | 0.000 |
| 2 | Novice | balanced | between L1 and L2 | 0.125 |
| 3 | Steady | balanced | L2 intermediate | 0.250 |
| 4 | Sharp | balanced | between L2 and L3 | 0.375 |
| 5 | Skilled | balanced | L3 advanced | 0.500 |
| 6 | Expert | balanced | between L3 and top player | 0.625 |
| 7 | Ruthless | balanced | top player (the other archetypes' L4 row) | 0.750 |
| 8 | Merciless | balanced | between top player and world's best | 0.875 |
| 9 | CRACKED | balanced | L4 world's best (balanced) | 1.000 |
| 10 | Aevalmere | balanced | L5 god | god vector |

Archetypes other than balanced are reachable through `CpuSpec` (section 4) from the harness only. Exposing them in the
UI is an owner decision (section 6).

## 3. Work breakdown

Rules for every worker: own only the files listed; import other workers' modules only through the names frozen in
section 4; never edit `docs/cpu-guide/`; no `MoveId` string literal in brain files outside `src/ai/executor.ts`
(direct-code table) and `src/ai/charprofile/*` (role builder); no `Math.random`, `Date.now` or `performance.now` in
decision code (the harness may time calls); no `Math.exp`, `Math.pow`, `Math.log`, `Math.tan`, `Math.atan2` or `**` in
decision code (use tables or the sim's functions); allocation-free per frame after warm-up; `npm run typecheck` clean.
Each worker adds unit checks for its module to `src/ai/eval/unit/<module>.test.ts` (a file it creates and owns)
runnable with `npx --yes tsx`.

Sizes: small (under about 400 lines of new code), medium (400 to 1,200), large (over 1,200).

### Wave 1: contracts, sim fairness, character profile, harness foundations, tables, model

W1.0 lands first (it is the compile dependency of everyone); the rest start when it is merged.

**W1.0 contracts** (small). Files: `src/ai/contracts.ts`, `src/ai/rng.ts`. Read: 00; this plan section 4; 02 §14.6.
Export: section 4 verbatim (types and constants only in `contracts.ts`), `u01`, `skewNormal`, `STREAM` in `rng.ts`.
Accept: `npm run typecheck` clean; `u01` matches the reference in 02 §14.6 bit for bit on 1,000 fixed tuples; mean of
100,000 draws within 0.005 of 0.5; `skewNormal` sample mean within 0.02 of 0 and SD within 0.03 of 1 over 100,000
draws.

**W1.1 sim fairness** (small). Files: `src/sim/grab.ts`, `src/core/constants.ts`, `src/sim/selftest.ts`; if a
per-fighter counter is needed for the mash cap: `src/core/types.ts` (one optional field on `FighterState`) and
`src/sim/state.ts` (initialise and copy it). Prefer a design with no new field. Read: 01 §6 (grab), §7 (respawn); 02
§13.3, §14.5; this plan section 2 items 1 and 3. Export: nothing new; `RESPAWN_PLATFORM_FRAMES` value per decision 1.
Accept: new selftest cases: a victim pressing four mash bits every frame escapes a 0% standing grab in no fewer than
20 frames and a 100% grab in no fewer than 38 (02 §14.5 numbers, adjust if the formula's rounding gives 19 or 37,
state it); a victim mashing one bit every 2 frames escapes in the same time as one mashing four bits per frame;
respawn test reads the constant. `npm run test:sim` and `npm run test:net` pass. Report the platform value kept.

**W1.2 profile core** (medium). Files: `src/ai/charprofile/derive.ts`, `src/ai/charprofile/tags.ts`,
`src/ai/charprofile/overrides.ts`, `src/characters/aeval/ai.overrides.json`, `src/ai/charprofile/cache.ts`, `src/characters/aeval/ai.profile.cache.json` (generated). Read: 04
§1 to §4, §8, §9; 01 §8; 02 §4. Exports: section 4.3. Composes W1.3, W1.4, W1.5 through their frozen names.
Accept: deterministic (same hash in, deep-equal profile out, twice in one process and across two processes); Aeval
tags include `spike` on dair, `recovery` on uspecial, `projectile` on nspecial and sspecial, `commandGrab` on the
Final Smash move if it is a `MoveDef`; `hitsLedge` moves are listed in `roles.ledgeTrap`; an override that contradicts
a derived number by more than 10% prints a warning; `bc` part 1: a copy of Aeval with altered numbers derives with no
code change. Cold derive cost printed; see risk R4 for the cache rule.

**W1.3 hit probes** (medium). Files: `src/ai/charprofile/probeHit.ts`. Read: 04 §2 (shield safety, kill percent); 01
§2, §3, §7; `src/sim/calibrate.ts` (read only). Exports: section 4.3.
Accept: center kill percents within 2% of `calibrate.ts` `measure` for every move it reports (`bc`); ledge percent at
most center percent for every horizontal killer; offstage spot uses the live `StageDef`; total probe cost under 0.5 s
per character and stage.

**W1.4 motion probes** (medium). Files: `src/ai/charprofile/probeMotion.ts`. Read: 04 §2 (recovery, shot profile), §4
`RecoveryProfile`, `ShotProfile`; 01 §4, §5, §8; 02 §10.1; research/05 only for the Aeval probe values to check
against. Exports: section 4.3.
Accept: Aeval full hop 95 to 105 px, short hop 40 to 46, double jump 76 to 86, geyser rise 77 to 87 px, air dodge
sideways 100 to 118 px; recover box: no-jump up-special depth 100 to 150 px at dx 40 to 120, none at dx 260; orb
`range(0)` 180 to 192 and `range(60)` 330 to 350 px; crescent `returns` non-null; `shots` empty for a character with
no projectile.

**W1.5 combo table and matchup** (large). Files: `src/ai/charprofile/combo.ts`, `src/ai/charprofile/matchup.ts`. Read:
02 §9.1 to §9.3; 04 §2 (combo potential), §5; 01 §2; `aevalmere.ts` `followFits`, `chainSearch`, `buildComboTable`,
`launchKills` (read only, port generically). Export: `buildComboTable`, `deriveMatchup` (section 4.3), `ComboTable`
methods.
Accept: starters come from the profile (no Aeval index); brackets `[0, 0.3K, 0.6K, 0.85K, K]`; on Tidegate the table
has at least as many 3-hit entries as the current table reports (`aevalmereComboSummary`, 97) or the worker explains
each loss by the new keying; every listed follow-up is confirmed by a cloned-sim check on 200 random keys (0 false
positives); build time under 1.5 s per character and stage, lazy per bracket allowed.

**W1.6 statistics** (small). Files: `src/ai/eval/stats.ts`. Read: 06 §1; 03 §5. Exports: section 4.5.
Accept: Wilson lower bounds 10/10 0.722, 20/20 0.839, 50/50 0.929, 73/73 0.950, 100/100 0.963, 60/100 0.502 to 0.691
(3 decimals); SPRT(0.5, 0.65, 0.05, 0.05) win step 0.262, loss step -0.357, bounds plus or minus 2.944;
`pFromElo(200)` 0.760; Bradley-Terry recovers three known strengths within 5 Elo on synthetic data.

**W1.7 runner and replay** (medium). Files: `src/ai/eval/runner.ts`, `src/ai/eval/replay.ts`. Read: 06 §2 (cost), §4
`bb`, §6; `aitest.ts` `cpuConfig` and its match loop (read only). Exports: section 4.5.
Accept: `legacyBrain(10)` against `legacyBrain(9)` reproduces `ah` (same seed twice, identical final hash and
identical input streams); side swap and paired seeds; per-call mean, p99 and first call recorded with
`performance.now` only in the runner; a 3,000-frame legacy match with replay capture costs under 1.3x the same match
without it.

**W1.8 metrics** (medium). Files: `src/ai/eval/metrics.ts`. Read: 06 §2; 03 §3.3, §6; 05 (test column only). Exports:
section 4.5.
Accept: on hand-built event logs: an opening is the first hit after 45 free frames; a combo ends after 45 frames
outside stun, tech, knockdown; approaches, threat-range share, shield share, whiff-punish share, dodges, projectiles,
offstage share, mean neutral distance, reaction histogram, entropy per situation, repetition share, accident count
each have one unit check.

**W1.9 scripted adversaries** (medium). Files: `src/ai/eval/adversaries.ts`. Read: 06 §3; `aitest.ts` scripted
policies (read only, port them). Exports: section 4.5.
Accept: the six ported policies reproduce their `aitest.ts` input streams on 3 seeds; the new ones (six: stationary,
wandering, shield-only, jump-only, learns-your-pattern, changes-style-at-30s; stationary and wandering wrap level 0
and `cpuZeroMoves`) have a documented weakness each (twelve adversaries in all; 06 §4 `az` counts eleven because it
folds the stationary dummy into level 0) and a unit check that the weakness is present.

**W1.10 level and style tables** (small). Files: `src/ai/levels.ts`, `src/ai/archetypes.ts`. Read: 03 §1, §2 (all
tables), §2.5, §3.1, §4; this plan section 2.1. Exports: section 4.2.
Accept: every knob is a stated curve of `s` (03 §2.5) and at `s` = 0, 0.25, 0.5, 0.75, 1.0 reproduces the 03 table
rows within rounding; god vector matches the god column; `reactFloor` is 10 at every human `s` and `perceptionAge` 4
for god; `specForUiLevel` implements 2.1; style vectors reproduce 03 §3.1.

**W1.11 predictor bank** (large). Files: `src/ai/model/predictor.ts`. Read: 02 §6.1, §6.2, §6.8; `aevalmere.ts` `Pred`
through `exploitMask` (read only, port). Exports: section 4.4.
Accept: ported members give the same top-guess sequence as `aevalmere.ts` on 3 recorded opponent streams (or within 1
point of accuracy); with the two new members, first-30-second accuracy on each of the six adversaries is not lower
than today's pooled numbers by more than 3 points (camper 49, roller 47, rushdown 64, turtle 69, ledge 62, jumper 53);
counter-me member detects the learns-your-pattern adversary (its score leads within 40 observations).

**W1.12 gating, changepoint, store** (medium). Files: `src/ai/model/gating.ts`, `src/ai/model/changepoint.ts`,
`src/ai/profile.ts`. Read: 02 §6.3 to §6.5, §6.9. Exports: section 4.4.
Accept: `wilsonLB` at z 1.282: 2 of 2 at least 0.5, 4 of 4 at least 0.7, 7 of 7 at least 0.8, 2 of 3 about 0.25;
changepoint fires within 20 s of the changes-style adversary switching (`az` clause) and never on a stationary stream
over 3,000 frames; v1 profiles load as a prior or are discarded with a logged reason (owner decision O6); `be` needs
the brain and is run in wave 3.

### Wave 2: brain subsystems

Starts when every wave 1 worker has merged. Each worker codes against section 4 and the real wave 1 modules. Unit
checks run on cloned states built by `src/ai/eval/unit/fixtures.ts`, owned by W2.16 (other workers may copy its
fixture patterns into their own test files).

**W2.1 perception** (medium). Files: `src/ai/perception.ts`. Read: 02 §3 (all); 03 §2.1 (P column only); 01 §1.
Export: `createPerception`, `Perception.observe`, `Perception.view` (section 4.6).
Accept: never exposes an opponent input younger than `perceptionAge` (property test over 200 seeds); hypotheses sum to
1, at most 6 kept; own fighter exact; own-input delay `d` 1 to 4 rolls own state forward `d` frames and perceives `R -
d` back (floor 0); zero allocation after warm-up (heap delta under 1 KB over 3,000 frames).

**W2.2 affordances** (medium). Files: `src/ai/affordances.ts`. Read: 02 §4, §9.1, §10.1, §11.5; 04 §5 (danger map,
threat ranges). Exports: section 4.6.
Accept: `canGetBack` agrees with 500 exact rollouts on random offstage states in at least 98% and never says yes when
the rollout dies with margin over 40 px; `trueCombo` agrees with the cloned sim on the combo-table keys;
`whiffPunishable` sign matches a sim probe on 50 cases.

**W2.3 reply models** (medium). Files: `src/ai/model/replies.ts`. Read: 02 §7.1; 01 §5, §6; `aevalmere.ts` `oppStep`,
`fixedModels`, `classModel`, `pickModels` (read only, port generically: reach and moves from the opponent's profile).
Exports: section 4.4.
Accept: at least 25% of weight on the fixed set; `optionsCap` from the level vector respected; no reply reads the
opponent's real inputs; ledge, tech, downed and recovery reply sets match 02 §7.1.

**W2.4 plans: registry and neutral** (large). Files: `src/ai/plans/index.ts`, `src/ai/plans/neutral.ts`,
`src/ai/plans/script.ts`. Read: 02 §5, §8, §6.7, §14.3; 03 §2.3 (vocabulary); 04 §3 (roles). Exports: section 4.7.
Accept: from the Aeval profile, the generated set covers every family in 02 §5 for neutral, OOS and airborne;
prefilter returns 25 or fewer per decision on 95% of 2,000 sampled states; vocabulary gating removes families above
the level; a second character with renamed roles generates the same family count with zero brain edits; no `MoveId`
literal in these files.

**W2.5 plans: advantage** (medium). Files: `src/ai/plans/advantage.ts`. Read: 02 §9.1 to §9.5, §9.7; 04 §3 (roles
juggle, techChase, kill); 05 §2. Exports: section 4.7.
Accept: follow-ups first with +6 bonus; kill-confirm families respect the percent window; `predictLanding` covers the
five landing policies and the dodge-spent flag; tech-chase family chooses wait-and-react when every option is
coverable at the level's `R`.

**W2.6 plans: ledge and edgeguard** (large). Files: `src/ai/plans/edge.ts`. Read: 02 §9.6, §10 (all); 01 §5;
research/05 only if a probe number is needed. Exports: section 4.7.
Accept: coverage matrix built over six ledge options x three timings from 90-frame rollouts; a hitbox or grab active
on frame 24 at 34 px inside is offered against the roll; pre-grab hit places the active span to end at `N - 1`; hog
plans leave the ledge before frame 40 unless the rollout shows the recoverer cannot reach; no edgeguard plan where own
`canGetBack` fails (`bd`).

**W2.7 plans: disadvantage** (large). Files: `src/ai/plans/defense.ts`. Read: 02 §11 (all); 01 §5, §6. Exports:
section 4.7.
Accept: recovery routes x delay {0, 6, 12, 18} x hold direction; fictitious play 200 iterations seeded, deterministic;
previous stock's route not repeated on ties; OOS table ranked by first active frame with measured shield advantage;
downed wait `n` drawn from `u01`.

**W2.8 zoning** (medium). Files: `src/ai/zoning.ts`. Read: 02 §12.1 to §12.3; 01 §8 (orb charge); 04 §2 (shot
profile). Exports: section 4.8.
Accept: Aeval tap orb against a 3.1 px/frame runner with reach 34 and startup 5 is safe from about 142 px (plus or
minus 10); at 250 px no hold is both safe and in range; all three return "no shot" with an empty `shots` list.

**W2.9 passive routine** (small). Files: `src/ai/plans/passive.ts`. Read: 02 §13 (all); 01 §7. Exports: section 4.7.
Accept: detects stationary, shield-only, jump-only, roll-only on the W1.9 adversaries within 120 frames of the first
passive window; the route family is a candidate, not a script override.

**W2.10 search: rollout and outcome** (large). Files: `src/ai/search/rollout.ts`, `src/ai/search/outcome.ts`. Read: 02
§7.1 to §7.3, §7.6 (budget); 03 §3.1 (weights); `aevalmere.ts` `rollout`, `evaluate`, `copyGameStateInto` (read only,
port). Exports: section 4.8.
Accept: every candidate scored over the same `W` (45, 60 for kill and spike plans) with neutral padding; steps counted
and the budget never exceeded by more than one rollout; candidate order follows priority; identical output on repeated
calls; `projectedKO` equals the sim's KO on 100 launched states.

**W2.11 search: selection** (medium). Files: `src/ai/search/select.ts`, `src/ai/search/mix.ts`. Read: 02 §7.4, §7.5,
§6.3, §6.4, §8 (mixups). Exports: section 4.8.
Accept: CVaR on hand cases (a reply with weight below `alpha` contributes `w / alpha` of the tail); certain-loss veto
only at combined weight 0.5 or more and only when an alternative exists; tier order reflex, Final Smash, veto, spike
or kill route, value; ties within 2% broken by seeded softmax; `tau = 0` is argmax.

**W2.12 tempo** (small). Files: `src/ai/tempo.ts`. Read: 02 §6.8, §7.6, §12.4. Exports: section 4.8.
Accept: clock resets on 90 px contact without hitstun or on a hit of 8% or more, not on chip; cycle detector flags
period 1 to 4 loops repeated three times with no damage; staleness decays 0.9 per 12 frames.

**W2.13 executor and reflexes** (medium). Files: `src/ai/executor.ts`, `src/ai/reflexes.ts`. Read: 02 §14.1 to §14.5;
01 §3 (roll rules), §4 (buffer, tap windows), §6 (tech, grab); `aevalmere.ts` `finish`, `press`, `safeDir` (read
only). Exports: section 4.9.
Accept: `pressed` derived from `held` and the previous output frame in one place; tap mirror keyed to output frames: 0
accidental rolls over 200 seeds with `inputDelay` 1 to 4 (`bh` part); follow-up pressed at `iasa - k`, k at most 6;
spacing stop error at most 2 px in 95% of 500 cases; mash never faster than the level rate; no Shield or Dodge press
while launched except the tech; no attack press in hitstun (`bd`).

**W2.14 humanizer** (medium). Files: `src/ai/humanizer.ts`. Read: 03 §2.1, §2.2, §4; 02 §14.1. Exports: section 4.9.
Accept: reaction samples never under `reactFloor` at human tiers; means for 0, 1, 2 bits match 03 §2.1 within 1 frame
over 10,000 draws; window success rates per tier within 3 points of the 03 §2.2 table on synthetic windows (the in-sim
check is `bg` in wave 3); no jitter on windows 12 frames or wider at advanced and above; identity at god.

**W2.15 targets** (small). Files: `src/ai/targets.ts`. Read: 02 §15. Exports: section 4.9.
Accept: no retarget flip inside 30 frames without a new event; teammates never targeted; deterministic tie-break by
slot.

**W2.16 harness cases and tiers** (large). Files: `src/ai/eval/main.ts`, `src/ai/eval/pool.ts`,
`src/ai/eval/cases/*.ts`, `src/ai/eval/unit/fixtures.ts`, `package.json` (scripts only). Read: 06 (all); 03 §3.3, §5,
§6; 02 §1; this plan section 5 (R2). Exports: section 4.5.
Accept: every case `at` to `bh` implemented against `BrainFactory`, gated or marked info per section 5 R3; runs end to
end with `legacyBrain` so wave 3 can compare; fast tier under 3 minutes on this machine; full tier under 15 minutes
wall on 12 cores using a process pool; results are identical for any shard count (per-match determinism).

### Wave 3: integration, entry point, calibration, migration

W3.1 to W3.4 start together; W3.5 (calibration) starts when W3.1 merges.

**W3.1 brain** (large). Files: `src/ai/brain.ts`. Read: 02 §2, §7.5, §7.6, §14.1, §15; 03 §1, §4; this plan section 4.
Exports: section 4.1. Accept (with the god spec): `av` god versus the other 19 CPUs, 73 matches each, 0 losses, 0 SDs,
at most 0.5 stocks lost per match against the level 5s, at least 60% against each style's level 5 (nightly tier; full
tier runs 20 each and reports the Wilson bound); `az` god 30 of 30 with 0 stocks lost against each adversary; `ba` per
decision 1; `bb` identical hashes and streams, god p99 at most 4 ms, mean at most 0.15 ms, first call at most 2 ms,
warm-up under 200 ms cold (with the profile cache, R4); `bd` all properties over 200 seeds; `bf` passive route within
120 frames; `ak` no teammate swings; `be` mean gain at least 10 points, no pair below -2 (with W1.12's store).

**W3.2 entry point and retirement** (medium). Files: `src/ai/index.ts`, `src/ai/aevalmere.ts`, `src/ai/dummy.ts`.
Read: this plan section 2 item 5 and 2.1; 03 §1. Export: unchanged public API: `cpuInput`, `resetCpu`,
`cpuIntendedRolls`, `setCpuProjBlockOverrideForTest`, `flushAevalmereProfiles`, `warmAevalmere` (the last two as
aliases over `brain.ts` and the model store so `src/main.ts` and `src/net/nettest.ts` need no edit). Test-only exports
that no longer apply keep their names and become no-ops.
Gate before deleting the rule brain: at UI levels 1 and 3 (guide L1 and L2) the new engine passes `az` (50% at L1, 70%
at L2), `aw` (reaction floor), `bg` (execution), and the adapted `aitest.ts` cases `a`, `b`, `e`, `f`, `p`, `aa`,
`ab`. Until then `cpuInput` routes by a constant `USE_NEW_ENGINE_FROM` (start at 10, lower as gates pass). Delete the
rule tables and the level 1 to 9 code when it reaches 1; keep `dummyInput` in `dummy.ts`.

**W3.3 aitest migration** (medium). Files: `src/ai/aitest.ts`. Read: 06 §4 (existing cases to keep); this plan section
5 R2 and R3.
Accept: existing cases rewritten against the new engine where the concept survives; `c` becomes "UI level k+2 beats UI
level k with Wilson lower bound 0.55" (adjacent UI levels are about 100 Elo apart by design, so 7 of 10 between
adjacent levels is not expected); `w` and `ag` to `as` kept; `aitest.ts` becomes the fast tier's legacy wrapper and
runs under 3 minutes.

**W3.4 net parity** (small). Files: `src/net/nettest.ts`. Read: 06 §4 `bh`; 02 §3.5, §14.6; `docs/LAN.md` §5 and §10.
Accept: `bh`: `inputDelay` 1 to 4 with a UI level 9 CPU (world's best) dash-dancing near a ledge, relay-log replay
hash equals the host hash; CPU fill at level 7 and the level 10 case still pass; `npm run test:net` green.

**W3.5 calibration and report** (medium). Files: `src/ai/levels.ts`, `src/ai/archetypes.ts` (values only, not
signatures), `docs/CPU_AEVALMERE.md` (new section "One engine, 2026-10"). Read: 03 §2.5, §3.3, §5; 06 §1, §4 `at`,
`au`, `ax`, `az`, `ba`, §5 reporting format.
Accept: `at` per archetype: SPRT accepts H1 or Wilson lower bound at least 0.55 at n 200, adjacent Elo gap 200 plus or
minus 30 after bisecting `s`; `au` inside [0.40, 0.60] at levels 1 and 2 and [0.35, 0.65] at 3 to 5; `ax` ratio gates
with Cohen's d at least 0.8 on each archetype's defining metric at levels 2 to 5; `az` win rates 50% at L1, 70% at L2
and L3, 85% at L4, 90% at non-god L5, 0 SDs from L3, learns-your-pattern beaten from L4; `ba` median 3-stock time
falls with level in every archetype; report table per 06 §5.

## 4. Frozen interfaces

Types and constants live in `src/ai/contracts.ts`; each function is implemented in the file named in the comment
above it. Names and signatures are frozen; a worker that needs a change stops and reports to the lead. Field order is not significant. Per-frame functions write
into caller-owned objects (`out`) to stay allocation-free.

### 4.1 Spec and brain entry

```ts
import type { CharacterDef, FighterState, GameState, InputFrame, MatchConfig, MoveId, StageDef, ThrowId } from '../core/types';
import type { TUNING } from '../core/constants';
export type Archetype = 'aggressive' | 'defensive' | 'countering' | 'balanced';
export type GuideLevel = 1 | 2 | 3 | 4 | 5;
export interface CpuSpec { archetype: Archetype; level: GuideLevel; god: boolean; s: number }
// src/ai/brain.ts
export function brainInput(state: GameState, slot: number, spec: CpuSpec, out: InputFrame): InputFrame;
export function warmBrain(config: MatchConfig, specs: ReadonlyMap<number, CpuSpec>): void;
export function resetBrain(slot?: number): void;
export interface BrainStats { decisions: number; steps: number; plan: string; target: number;
  lastReaction: number; alternates: number; mashBits: number }
export function brainStats(slot: number): BrainStats;
// src/ai/index.ts keeps: cpuInput(state: GameState, slot: number, level: number, rand: () => number): InputFrame
// (rand is accepted and ignored by the new engine; all randomness comes from u01)
```

### 4.2 Level and style vectors (`src/ai/levels.ts`, `src/ai/archetypes.ts`)

```ts
export type PlanFamilyId = 'wait' | 'walk' | 'dash' | 'dashDance' | 'emptyHop' | 'poke' | 'tilt' | 'smash'
  | 'chargedSmash' | 'grab' | 'dashGrab' | 'projectile' | 'shAerial' | 'fhAerial' | 'retreatAerial' | 'fastFallAerial'
  | 'platform' | 'shield' | 'spotDodge' | 'roll' | 'oos' | 'drift' | 'airAerial' | 'doubleJump' | 'airDodge' | 'special'
  | 'recovery' | 'ledgeOption' | 'getup' | 'tech' | 'tumbleExit' | 'throw' | 'pummel' | 'respawn' | 'finalSmash'
  | 'comboFollow' | 'killConfirm' | 'landingTrap' | 'techChase' | 'ledgeTrap' | 'preGrabHit' | 'hog' | 'offstageAerial'
  | 'spike' | 'footstool' | 'projectileWall' | 'baitProbe' | 'passiveRoute' | 'shieldPressure';
export interface LevelVector {
  s: number; god: boolean; perceptionAge: number;                 // P, frames
  reactBase: number; reactSd: number; reactFloor: number; surprise: number; hickB: number; kPrp: number;
  sigmaJ: number; lapse: number; kWeber: number; noJitterWidth: number;   // 12 at advanced and up, Infinity below
  tau: number; errorRate: number; menuCap: number; optionsCap: number; planHold: number;
  stepBudget: number; eventsPerSec: number; mashEvery: number;   // 0 steps = static eval; god Infinity; 0 = no mash
  learning: { enabled: boolean; gammaSlow: number; gammaFast: number; z: number; nMin: number };
  exploitCap: number; giftBudget: boolean; openingRate: number; recognition: number; comboDepth: number;
  killPctError: number; vocabulary: ReadonlySet<PlanFamilyId>;    // killPctError NaN = kill map not used
  accidentTolerance: number; baitWeakness: number;
}
export interface ObjectiveWeights { damageDealt: number; damageTaken: number; frameAdvantage: number;
  stageControl: number; killProbability: number; zone: number; shield: number; ledgeControl: number;
  stockRisk: number; repetition: number; continuity: number; healed: number }
export type CandidateFilterId = 'none' | 'aggressive' | 'defensive' | 'countering';
export interface StyleVector {
  archetype: Archetype; w: ObjectiveWeights; lambda: number; alpha: number; lambdaAheadMin: number;
  spacingMul: readonly [number, number] | 'adaptive'; filter: CandidateFilterId; tagBias: Partial<Record<MoveTag, number>>;
  trigger: 'clock' | 'commitment' | 'commitmentZone' | 'both'; clockForceFrames: number; baitShare: number;
  stallT0: number; shotBand: readonly [number, number]; shootSafeMargin: number; retreatAfterShot: readonly [number, number];
  predictorMixCap: number; exploitBias: readonly HabitKind[] | 'all'; edgeguardWillingness: number;
}
export type HabitKind = 'ledge' | 'recovery' | 'approach' | 'shield' | 'roll' | 'spotDodge' | 'airDodge' | 'tech';
export function levelVector(s: number, god: boolean): LevelVector;
export function guideLevelS(archetype: Archetype, level: GuideLevel): number;   // calibrated s
export function specForUiLevel(level: number): CpuSpec;                        // section 2.1
export function styleVector(archetype: Archetype, god: boolean): StyleVector;
export function paramsFor(spec: CpuSpec): { level: LevelVector; style: StyleVector };
```

### 4.3 Character profile (`src/ai/charprofile/*`)

The schema in 04 §4 is frozen verbatim (`MoveTag`, `Spot`, `KillPct`, `MoveAiInfo`, `ShotProfile`, `RecoveryProfile`,
`GrabAiInfo`, `CharacterAiProfile`, `CharacterAiOverrides`) and lives in `contracts.ts`, with `type DeepPartial<T> = {
[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }` and these additions:

```ts
export type StarterId = MoveId | ThrowId;
export interface ComboKey { starter: StarterId; bracket: number; hitClass: 0 | 1 | 2;
  dxBucket: number; dyBucket: number; grounded: boolean; spot: Spot }
export interface ComboRoute { moves: readonly StarterId[]; damage: number; kills: boolean;
  endX: number; endAdvantage: number; offstage: boolean }
export interface ComboTable { readonly brackets: readonly number[]; bracketOf(percent: number): number;
  routes(k: ComboKey): readonly ComboRoute[];            // best first, may build lazily
  killConfirm(starter: StarterId, bracket: number, spot: Spot): boolean;
  summary(): { entries: number; chains3: number; chains4: number; kills: number } }
export interface MatchupProfile { attacker: string; defender: string; stageId: string; K: number;
  brackets: readonly number[]; danger: Partial<Record<MoveId, KillPct>>;  // defender's moves on attacker
  safeVsB: ReadonlySet<MoveId> }
// derive.ts
export function deriveAiProfile(def: CharacterDef, stage: StageDef, tuning: typeof TUNING): CharacterAiProfile;
export function getAiProfile(charId: string, stageId: string): CharacterAiProfile;   // cached by dataHash
export function profileDataHash(def: CharacterDef, stage: StageDef, tuning: typeof TUNING): string;
// overrides.ts
export function applyOverrides(p: CharacterAiProfile, o: CharacterAiOverrides): { profile: CharacterAiProfile; warnings: string[] };
// probeHit.ts
export function probeShieldSafety(def: CharacterDef, stage: StageDef, id: MoveId): { safe: boolean; bySpacing: readonly boolean[] };
export function probeKillPct(def: CharacterDef, victim: CharacterDef, stage: StageDef, id: MoveId,
  recover: boolean): KillPct;
export function probeThrowKillPct(def: CharacterDef, victim: CharacterDef, stage: StageDef, t: ThrowId): KillPct;
// probeMotion.ts
export function probeRecovery(def: CharacterDef, stage: StageDef): RecoveryProfile;
export function probeShots(def: CharacterDef, stage: StageDef): ShotProfile[];
// combo.ts, matchup.ts
export function buildComboTable(p: CharacterAiProfile, victim: CharacterDef, stage: StageDef, brackets: readonly number[]): ComboTable;
export function deriveMatchup(a: CharacterAiProfile, b: CharacterAiProfile, stage: StageDef): MatchupProfile;
```

`CharacterAiProfile.comboTable` holds the mirror-matchup table; `brain.ts` asks `buildComboTable` for other victims
through a cache keyed by (attacker, victim, stage, tuning hash).

### 4.4 Opponent model (`src/ai/model/*`)

```ts
export const ACTION_CLASS_COUNT: number;            // 30 existing + jabMash, recoveryRoute x4, bufferedOOH
export interface ObsContext { sit: number; dist: number; ours: number; last: number; prev: number;
  phase: number; pctBucket: number; zone: number }
export interface Predictor { observe(state: GameState, meI: number, oppI: number, frame: number): void;
  predict(ctx: ObsContext, out: Float64Array): number;  // fills ACTION_CLASS_COUNT probs, returns confidence 0..1
  counts(ctx: ObsContext, cls: number): { k: number; n: number };          // decayed, slow table
  fastCounts(ctx: ObsContext, cls: number): { k: number; n: number };      // 0.85 table
  memberScores(out: Float64Array): void;             // incl. counter-me at a fixed index COUNTER_ME
  scaleCounts(f: number): void; serialize(): string; load(text: string): boolean }
export function createPredictor(level: LevelVector): Predictor;          // predictor.ts
export function makeContext(state: GameState, meI: number, oppI: number, frame: number, out: ObsContext): void;
// gating.ts
export function wilsonLB(k: number, n: number, z: number): number;
export function breakEven(G: number, L: number, vSafe: number, margin: number): number;   // p*
export function restrictedWeight(lb: number, pMax: number): number;
export interface GiftBudget { add(vBestOpp: number, vChosen: number): void; allowance(): number; reset(): void }
export function createGiftBudget(): GiftBudget;
// changepoint.ts
export interface Changepoint { update(pSlow: number, pFast: number, frame: number): boolean;  // true = reset fired
  onStockChange(frame: number): number;                  // count multiplier to apply now (0.7) or 1
  poisoned(frame: number, llrVsPrior: number): boolean }
export function createChangepoint(): Changepoint;
// replies.ts
export interface ReplyModel { kind: number; arg: number; weight: number; name: string;
  step(t: number, self: FighterState, other: FighterState, ctx: PlanCtx, out: Intent): void }
export function buildReplies(view: DecisionView, out: ReplyModel[]): number;   // returns count
// profile.ts keeps ProfileStore, MemoryProfileStore, CappedProfileStore, profileKeyFor, defaultProfileStore;
// PROFILE_PREFIX becomes 'aevalrena.cpu.profile.v2.'
```

### 4.5 Harness (`src/ai/eval/*`)

```ts
export type Tier = 'fast' | 'full' | 'nightly';
export interface BrainFactory { name: string; spec: CpuSpec | null;
  create(): (state: GameState, slot: number, out: InputFrame) => InputFrame; reset(): void }
export function newBrain(spec: CpuSpec): BrainFactory;              // runner.ts, wraps brainInput
export function legacyBrain(level: number): BrainFactory;           // runner.ts, wraps today's cpuInput
export type AdversaryId = 'rushdown' | 'turtle' | 'camper' | 'roller' | 'ledgeCamper' | 'jumper'
  | 'stationary' | 'wandering' | 'shieldOnly' | 'jumpOnly' | 'learnsPattern' | 'changesStyle';
export const ADVERSARIES: readonly AdversaryId[];
export function adversary(id: AdversaryId, playerName: string): BrainFactory;   // adversaries.ts
export interface MatchSpec { seed: number; stageId: string; stocks: number; frameCap: number;
  a: BrainFactory; b: BrainFactory; swap: boolean; record: boolean; inputDelay?: number;
  extraPlayers?: readonly { factory: BrainFactory; team: number }[] }
export interface ReplayEvent { frame: number; kind: string; slot: number; data: Readonly<Record<string, number | string>> }
export interface MatchResult { winner: number; stocksLost: readonly number[]; sds: readonly number[];
  frames: number; timeout: boolean; finalHash: string; inputHash: readonly string[];
  events: readonly ReplayEvent[] | null;
  cost: readonly { mean: number; p99: number; first: number; calls: number }[] }
export function runMatch(m: MatchSpec): MatchResult;                // runner.ts
export function hashState(s: GameState): string;                   // replay.ts
export interface MatchMetrics { [name: string]: number }            // names listed in 06 §2
export function computeMetrics(r: MatchResult, slot: number): MatchMetrics;   // metrics.ts
export interface WilsonResult { k: number; n: number; p: number; lo: number; hi: number }
export function wilson(k: number, n: number, z?: number): WilsonResult;
export interface SprtState { llr: number; n: number; decision: 'H1' | 'H0' | 'continue' }
export function sprt(p0: number, p1: number, alpha: number, beta: number): { add(score: 0 | 0.5 | 1): SprtState };
export function pFromElo(d: number): number; export function eloFromP(p: number): number;
export function bradleyTerry(games: readonly { a: string; b: string; scoreA: number }[]): Map<string, { elo: number; se: number }>;
export function cohensD(a: readonly number[], b: readonly number[]): number;
export function mannWhitney(a: readonly number[], b: readonly number[]): { u: number; p: number };
export interface GateResult { id: string; pass: boolean; info: boolean; detail: string;
  metrics: Readonly<Record<string, number>> }
export interface TestCase { id: string; tiers: readonly Tier[]; run(ctx: { tier: Tier; shard: number; shards: number }): GateResult }
export const TEST_CASES: readonly TestCase[];                      // eval/cases/index.ts
```

### 4.6 Perception and affordances

```ts
export type Situation = 'neutral' | 'advantage' | 'disadvantage' | 'bothOffstage' | 'respawn'
  | 'finalSmash' | 'grabHold' | 'grabbed' | 'ledge' | 'downed' | 'tumble' | 'oos' | 'airborne';
export type HypKind = 'none' | 'move' | 'shield' | 'spotDodge' | 'roll' | 'jump' | 'airDodge';
export interface Hypothesis { kind: HypKind; move: MoveId | null; ago: number; dir: number; weight: number }
export interface Perceived { state: GameState;       // pooled, delayed world rolled to now, own fighter exact
  meI: number; oppI: number; frame: number; age: number; ownDelay: number;
  hyps: readonly Hypothesis[]; passivity: number; framesSinceEdge: number; framesSinceAttack: number;
  newEvent: boolean }                                  // opponent's delayed state visibly changed
export interface Perception { observe(real: GameState, meI: number): void;
  view(real: GameState, meI: number, oppI: number, level: LevelVector, pred: Predictor, out: Perceived): void;
  reset(): void }
export function createPerception(poolFrom: GameState, maxAge: number): Perception;
export interface Affordances { situation: Situation;
  framesToHit(who: 0 | 1, move: MoveId, dx: number, dy: number): number;
  inThreat(who: 0 | 1, x: number, y: number, frames: number): boolean;
  whiffPunish: number; meCanGetBack: number; oppCanGetBack: number;  // frames margin; px slack (negative = none)
  oppInvuln: number; oppBusy: number; meBusy: number; killPctHere(move: MoveId): number; dangerHere: number }
export function computeAffordances(p: Perceived, me: CharacterAiProfile, opp: CharacterAiProfile,
  mu: MatchupProfile, out: Affordances): void;
export function classifySituation(s: GameState, meI: number, oppI: number): Situation;
export function canGetBack(s: GameState, who: number, prof: CharacterAiProfile, work: GameState): number;
export function trueCombo(s: GameState, attacker: number, victim: number, follow: MoveId, work: GameState): number; // budget, <1 = not true
```

### 4.7 Plans (`src/ai/plans/*`)

```ts
export const PF_ATTACK = 1, PF_INTR = 2, PF_TAIL = 4, PF_MOVE = 8, PF_PROJ = 16, PF_EG = 32,
  PF_STALE = 64, PF_SPIKE = 128, PF_KILL = 256, PF_BAIT = 512;
export interface Intent { held: number; direct: number; mash: number }   // pressed is derived by the executor
export interface PlanCtx { dir: number; home: number; edgeX: number; fireAt: number; param: number;
  startFrame: number; frame: number; me: CharacterAiProfile; stage: StageDef }
export interface PlanInstance { family: PlanFamilyId; name: string; move: MoveId | null; param: number;
  minFrames: number; horizon: number; flags: number; bonus: number; priority: number;
  script(t: number, self: FighterState, ctx: PlanCtx, out: Intent): void }   // t advances only when hitlag == 0
export interface PlanFamily { id: PlanFamilyId; situations: readonly Situation[];
  generate(v: DecisionView, out: PlanInstance[]): void }
export interface DecisionView { p: Perceived; aff: Affordances; me: CharacterAiProfile;
  opp: CharacterAiProfile; mu: MatchupProfile; level: LevelVector; style: StyleVector;
  pred: Predictor; tempo: Tempo; seed: number; slot: number; stocksAhead: number }
export const PLAN_FAMILIES: readonly PlanFamily[];                 // plans/index.ts, concatenates the four below
export const ADVANTAGE_FAMILIES: readonly PlanFamily[];            // plans/advantage.ts
export const EDGE_FAMILIES: readonly PlanFamily[];                 // plans/edge.ts
export const DEFENSE_FAMILIES: readonly PlanFamily[];              // plans/defense.ts
export const PASSIVE_FAMILIES: readonly PlanFamily[];              // plans/passive.ts
export function passiveKind(v: DecisionView): 'none' | 'stationary' | 'shieldOnly' | 'jumpOnly' | 'rollOnly' | 'loop';
export function generateCandidates(v: DecisionView, out: PlanInstance[]): number;  // prefiltered, priority order
export function solveRecovery(v: DecisionView, routes: readonly PlanInstance[], seed: number): Float64Array; // mix
```

### 4.8 Search, zoning, tempo

```ts
export interface Outcome { damageDealt: number; damageTaken: number; stockDelta: number; projectedKO: number;
  ourStockRisk: number; frameAdvantage: number; stageControl: number; shieldHealth: number; ledgeControl: number;
  zone: number; repetition: number; continuity: number; healed: number; hitLanded: boolean; hitFrame: number }
export interface Scored { plan: PlanInstance; w: Float64Array; J: Float64Array; n: number;
  cvar: number; mean: number; value: number; stockLossWeight: number; certainLoss: boolean }
export interface SearchResult { best: PlanInstance | null; value: number; steps: number;
  scored: readonly Scored[]; secondPly: boolean; vetoed: number }
export function runRollouts(v: DecisionView, cands: readonly PlanInstance[], replies: readonly ReplyModel[],
  budget: number, out: Scored[]): number;                          // rollout.ts, returns steps used
export function scoreOutcome(o: Outcome, w: ObjectiveWeights): number;   // outcome.ts
export function cvar(w: Float64Array, J: Float64Array, n: number, alpha: number): number;  // select.ts
export function selectPlan(v: DecisionView, scored: readonly Scored[], out: SearchResult): void;
export function fictitiousPlay(M: Float64Array, rows: number, cols: number, iters: number, seed: number, out: Float64Array): void; // mix.ts
export function shootSafe(v: DecisionView, shot: ShotProfile, h: number, range: number):
  { safe: boolean; safeIfAnswered: boolean };                      // zoning.ts
export function chargeDecision(v: DecisionView, shot: ShotProfile, distance: number, shareUsed: number): number; // -1 no shot, -2 no charge shot
export function answerProjectile(v: DecisionView): PlanFamilyId | null;
export interface Tempo { update(s: GameState, meI: number, oppI: number): void; pressure(): number;
  clock(): number; stale(name: string): number; used(name: string, frame: number): void;
  cycle(): boolean; reset(): void }
export function createTempo(style: StyleVector): Tempo;            // tempo.ts
```

### 4.9 Executor, reflexes, humanizer, targets

```ts
export interface Executor { reset(): void; outputFrameOf(tick: number): number;   // tick + inputDelay
  emit(state: GameState, meI: number, intent: Intent, level: LevelVector, out: InputFrame): InputFrame;
  prebuffer(next: PlanInstance, atFrame: number): void }
export function createExecutor(slot: number, inputDelay: number): Executor;   // executor.ts
export function runReflexes(v: DecisionView, exec: Executor, out: Intent): boolean;   // reflexes.ts, true = frame claimed
export interface Stimulus { key: number; frame: number; bits: number; pCue: number; stress: number; alert: boolean }
export function reactionDelay(st: Stimulus, level: LevelVector, seed: number, slot: number): number;
export interface Humanizer { reset(): void;
  apply(intent: Intent, frame: number, windowWidth: number, level: LevelVector, out: Intent): void;
  decisionError(level: LevelVector, frame: number): boolean; mashAllowed(frame: number): boolean }
export function createHumanizer(seed: number, slot: number): Humanizer;       // humanizer.ts
export interface Targeter { pick(s: GameState, meI: number, frame: number): number; reset(): void }
export function createTargeter(): Targeter;                         // targets.ts
// rng.ts
export const STREAM = { reaction: 1, jitter: 2, lapse: 3, softmax: 4, error: 5, mix: 6, opening: 7, bait: 8, wake: 9,
  mash: 10, route: 11, target: 12 } as const;
export function u01(seed: number, slot: number, frame: number, stream: number, k?: number): number;
export function skewNormal(seed: number, slot: number, frame: number, stream: number, k?: number): number;
```

## 5. Risks

**R1. Determinism over the net.** The CPU runs only on the LAN host and its inputs are sent like a human's, so a brain
bug cannot desync peers. It can still break `test:net` reproducibility and the golden-seed tests. Rules: (a) the brain
never mutates the real `GameState`; every rollout writes into pooled copies (`copyGameStateInto` pattern); (b)
randomness only from `u01(config.seed, slot, frame, stream, k)`; the `rand` argument of `cpuInput` is ignored, which
also removes today's cross slot coupling (all CPU slots in `main.ts` share one sequential stream); (c) per-slot memory
resets on a new config object or a backward frame jump, as `aevalmere.ts` does, because `nettest.ts` runs many
scenarios and several peers in one process; (d) the brain is called once per frame per slot by the host's session;
W3.4 asserts the call count equals frames played under rollback; (e) budgets in steps only; (f) module-level caches
(profiles, combo tables) are keyed by data hash and never hold match state. CPU fill in `nettest.ts` uses levels 7 and
10; after W3.2 those route to the new engine, so W3.4 re-baselines any count the test asserts (hit counts are
informational unless the test says otherwise; it must not loosen a hash equality).

**R2. Harness runtime.** Guide-exact counts (`av` 73 x 19 x 2, `az` 11 x 20 x 30, `au` 3,000, `at` SPRT ladders, `ax`
480) are about 15,000 matches; at about 3,000 frames and 0.1 to 0.2 ms of brain time per frame per CPU that is 2 to 3
hours on one core. Three tiers:
- fast (per commit, under 3 minutes, one process): unit files; `bb` on 3 specs x 1 seed x 2 stages; `bd` over 50
  seeds; `bf`; `ba` god on 2 seeds; `bc`; SPRT on two adjacent balanced pairs capped at 64 matches (info if
  undecided); legacy `aitest.ts` fast subset.
- full (before a merge to main, under 15 minutes wall on 12 cores): every case with SPRT early stopping, 2 stocks,
  frame cap 7,200, `av` 20 matches per opponent (Wilson reported, gate is 0 losses), `az` 10 per pair for non-god and
  30 for god, `au` 40 per pair with SPRT, `ax` 16 per cell. Sharded over an 11-process pool (`pool.ts` spawns `tsx
  src/ai/eval/main.ts --shard i/n`); a match is a pure function of its spec, so results do not depend on the shard
  count.
- nightly (no time budget): guide-exact counts and thresholds. A gate that is only met at nightly counts is reported
  as "full: info, nightly: pass or fail".
W2.16 measures the current `aitest.ts` wall time first and records it in its report; if the full tier exceeds 15
minutes, the lead cuts counts in the full tier, never the nightly thresholds.

**R3. Thresholds unreachable under the current sim.** Known cases: `ba` 1,200 frames needs the respawn lever (handled
by decision 1); `ay` and the blind test need recorded human matches the repo does not have (implemented, run as info
until the owner supplies data); `aw` median inside `R` to `R + cadence + 1` depends on how the stimulus is defined in
replays. Procedure when a gate fails after honest effort: (1) the worker records the measured value, the gap and the
cause (brain limit, sim limit, statistics limit) in its report; (2) no threshold is edited by a worker; (3) the lead
either assigns a fix, marks the case info with the reason in `docs/CPU_AEVALMERE.md` (the `ao` precedent), or forwards
it to the owner when the cause is a sim rule, since decision 2 forbids new mechanics this wave. A sim-limited gap is
never closed by giving a human-tier CPU information a human would not have (reaction under the floor, input reading).

**R4. Profile derivation cost versus warm-up.** 04 §4 estimates 1.5 s per character and stage (dominated by the combo
table), while `bb` wants cold warm-up under 200 ms. Default: W1.2 writes a generated cache
(`src/characters/aeval/ai.profile.cache.json`, keyed by `profileDataHash`) produced by a script entry in `derive.ts`;
at load the hash is checked and the cache used; on a mismatch (tuning slider, balance edit) the profile is re-derived
in `warmBrain`, and the 200 ms gate applies to the cached path only. A test fails when the committed cache hash does
not match the live data, so a balance edit forces a regenerate.

**R5. Performance in 3 and 4 player matches.** Step cost grows with fighters; three god CPUs in a four-player match
triple the per-frame brain cost. `brain.ts` scales `stepBudget` by `2 / fighterCount`; `bb` adds a four-player cost
case (p99 per frame across all CPUs at most 8 ms).

**R6. Weaker low levels after the switch.** A degraded search with a 4-plan menu may look robotic or fail `az` at L1.
The W3.2 gate keeps the rule brain routed for any UI level that has not passed, so the product never ships a level
that got worse; if L1 or L2 cannot pass after calibration, the lead reports it to the owner (the guide's fallback is
to keep the rule brain for L1 and L2 only).

**R7. Parallel edits.** File ownership above is exclusive per wave. Shared types change only through the lead amending
section 4 and W1.0's file; a worker that finds a missing field reports it rather than adding a local type.

## 6. Decisions still needing the owner

- O1. Expose archetypes in the UI (a style picker per CPU slot, which needs `cpuStyle` in `MatchConfig` players, the
  LAN protocol and the select screen) or keep UI levels balanced only.
- O2. Human baseline data for `ay` and the blind test in 06 §5: 20 recorded human matches and judges. Without it those
  gates stay informational.
- O3. The slowest target device for the performance gate (06 §6 says measure there, not on the dev machine).
- O4. If the respawn platform stays at 180 (decision 1 fallback), whether to allow the platform change in a later wave
  to reach the 1,200-frame target.
- O5. Any gate the wave proves unreachable without a sim rule (R3), batched at the end of wave 3.
- O6. Persisted player profiles: migrate v1 (`aevalrena.aevalmere.profile.v1.*`) as a weak prior or discard them.
- O7. Whether the level 1 and 2 rule-brain fallback is acceptable if the degraded engine fails its gates (R6), given
  decision 5.

## 7. Outcome (W3.2 to W3.4, 2026-09-30)

- Shipped routing (`src/ai/index.ts`, switch `CPU_ENGINE`: `?cpu=` in the browser, the
  `CPU_ENGINE` env var in node, `setCpuEngine`): UI 1 to 9 run the search engine at
  `specForUiLevel` for every character; UI 10 with Aeval runs the legacy Aevalmere, which picks its
  opponent through the engine's TeamTargeter in matches of three or more (with the engine's
  120 px contact override) and has the engine's teammate guard applied to its output; UI 10 with any
  other character runs the engine's god. `new` puts the Aeval god on the engine too; `legacy`
  restores Aevalmere's own nearest-opponent choice. Decision 5's single engine holds for levels 1
  to 9; the god stays split because Aevalmere measured stronger (1v3 55 against 37 of 73).
- The rule brain is deleted (index.ts is 400 lines: routing, warm-up, the level 0 dummy, test
  hooks); `src/ai/dummy.ts` never existed. `cpuInput`, `resetCpu`, `warmAevalmere` and
  `flushAevalmereProfiles` keep their names; `main.ts`, `lobbycore.ts` and `runner.ts` are unedited.
- Ladder (40 paired matches per pair): every level beats the one two below it (UI 3 over 1
  27.5/40 up to UI 7 over 5 37.5/40), but UI 4 over 2 is 20.5/40 with 39 timeouts; UI 1 to 4 order
  only by stocks. Top step UI 10 over 9: 38/40 with Aevalmere (shipped) and with the engine's god.
- The god-tier 1v3 gate (lb 0.90) is unmet: shipped Aeval god 51/73 (104/146 over two seed sets),
  Aevalmere with nearest-opponent choice 57/73 (112/146), engine god 37/73. The targeter costs the
  Aeval god about 8 wins in 146 in that test; the lead chose the team terms.
- aitest: 27 of 44 gated pass (40 of 45 before). Eleven cases fail on the engine's play at levels 1
  to 9 (`a b d e g h i o r v y`), two on the Aeval god against the new opponents (`ag am`), four
  exactly as before (`al an ap aq`). No threshold was lowered. Details: docs/CPU_AEVALMERE.md
  section 7.
- Net: `npm run test:net` passes 32 of 32; the CPU fill scenarios run levels 3 and 10 (Aeval) and a
  Trekmore level 10 on the host under `auto` and `new`, 0 desyncs, identical hashes, one CPU call per
  frame played.
