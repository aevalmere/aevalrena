# Aevalrena CPU design guide

Context package for the coding agent that designs and implements the CPU opponents for Aevalrena
(https://github.com/aevalmere/aevalrena). Read the documents in order. Every claim is either cited
to a source, marked as arithmetic from the game's own constants, or labelled unverified.

## Files

| File | What it is | Read it when |
|---|---|---|
| 01_sim_facts_and_ultimate_reference.md | The rules of the game as the code implements them, the Ultimate number beside each, the mechanics the sim lacks, and the spec-versus-code discrepancies | first, and again before any frame arithmetic |
| 02_aevalmere_god_cpu.md | The god CPU: perception with a 4-frame delay, affordances, candidate plans, the opponent model and pattern learning, rollout search with a CVaR objective, neutral, advantage, edgeguarding, disadvantage, projectiles, the passive-opponent kill routine, execution and determinism | when building or changing the brain |
| 03_levels_and_archetypes.md | The skill axis (five levels plus god: reaction, execution, decision knobs, option vocabulary) and the style axis (aggressive, defensive, countering, balanced), the derivation recipe, calibration, human-likeness gates | when building the tiers |
| 04_character_profiles_and_scalability.md | The data-driven character profile: derived numbers, tag rules, schema, matchup brackets, override file, tests that keep the brain generic | when adding or tuning a character |
| 05_pro_skills_acceptance_checklist.md | Every skill a professional Ultimate player is praised for, mapped to the subsystem that implements it, with the Aevalrena frame numbers and the tier that must show it | as the reviewer's checklist |
| 06_testing_and_evaluation.md | Statistics, metrics, scripted adversaries, the test cases with pass thresholds, human evaluation, regression discipline | before claiming anything is done |
| 07_sources.md | Every cited URL with verification status | when a citation needs checking |
| research/ | The nine underlying research reports with their own source lists and probe results | for depth on any topic |

## The design in one paragraph

One search brain runs every CPU. It perceives the opponent a few frames late, enumerates
hypotheses for the hidden frames, generates candidate input programs from the character's derived
profile, plays each against a set of opponent reply models weighted by a learned habit predictor,
scores the outcomes with a risk-sensitive objective, and executes the winner with a frame-exact
controller. The god CPU (balanced level 5) runs it with a 4-frame delay, no execution error, the
whole option menu, and the full model. Every other tier runs the same brain degraded by a level
vector (reaction distribution at or above the human floor, timing jitter, dropped inputs, decision
temperature, menu size, vocabulary, learning rate) and shaped by an archetype vector (objective
weights, risk, candidate filters, reaction trigger, spacing, stall clock). Characters are data:
tags and numbers derived from move data by running the sim at load, with hand overrides.

## Hard rules

1. The forward model decides; formulas prefilter. Every frame-dependent choice is confirmed by
   cloning the state and stepping it.
2. No input reading. Perception delay is never under 4 frames at god and never under the human
   floor (10 frames) at human tiers.
3. Determinism: the brain is a pure function of (state history, seed, level); randomness comes
   from a counter-based hash, never a sequential stream; budgets are counted in sim steps, never
   wall-clock; no transcendental functions in decision code.
4. The brain reads tags and derived numbers, never a move id or a character name.
5. Levels change quality (skill vector); archetypes change intent (style vector); neither changes
   the other.
6. Style: no em dashes, no emoji, no marketing words, plain headings (the repository's own rule in
   `docs/SPEC.md` section 13).

## Owner decisions the guides depend on

Each is stated where it matters; collected here so they can be settled early.

1. Respawn platform time for a fighter that presses nothing (currently 180 frames): the 20-second
   3-stock target on a stationary opponent is not reachable by any brain at 180; 100 frames makes
   it reachable (02, section 13).
2. Whether to add a stale-move queue, ledge trump or a 2-frame window, post-release grab immunity,
   a charge cancel, and dodge staleness to the sim (01, section 9). Each changes CPU logic and
   re-runs the test matrix.
3. Whether to cap the mash-out rate (the sim credits every simultaneous bit; the god tier escapes a
   grab in about 4 frames today; a cap of one bit per 2 frames is proposed) (02, section 14.5).
4. Which level is "world's best" for the balanced archetype (default: balanced 4, with balanced 5
   as the god; alternative: uniform rows with god replacing only balanced 5) (03, section 1).
5. Whether the rule-table brain for levels 1 and 2 survives (default: one engine everywhere) (03,
   section 1).
6. Whether a fighter launched off the stage without jumping should have two midair jumps
   (`jumpsLeft` resets to 2 on landing but a ground jump leaves 1) (01, section 4).

## What is not in this package

Video analysis of professional play (no video was readable), Ultimate's per-level reaction values
below level 9 (not public), the contents of Ultimate's AI parameter files (not public), and
measured frame-window success rates for skilled humans (none published). The guides say where each
gap sits and what a local measurement would replace.
