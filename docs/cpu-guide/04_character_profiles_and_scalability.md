# 04. Character profiles and scalability

The brain is generic. Everything character-specific is data, derived from `CharacterDef` at load
by running the sim, with hand overrides on top. A second character must load with zero brain
changes. This document specifies the derived profile, the tag rules, the derivation procedure, the
matchup profile, the override file, and the tests that hold the brain to that contract.

## 1. What the source data provides

`CharacterDef` (`src/core/types.ts`): weight, walk, run, dash speed and frames, ground accel and
friction, air speed, accel and friction, gravity, max fall, fast fall, jump, short hop and double
jump velocities, jump count, jump squat, hurtboxes (standing, crouch), ledge grab box, `moves`
keyed by `MoveId` with `totalFrames`, `hitboxes` (id, start, end, x, y, r, damage, angle, bkb, kbg,
group, hitlagMul, shieldDamage), `projectiles` (spawn frame, offsets, vx, vy, gravity, lifetime,
r, damage, angle, bkb, kbg, destroyOnHit, `strength`, `charged` fields, `chargeCastFrames`,
returns), `velocity` keys, `landingLag`, `iasa`, `chargeable`, `invuln`, `helplessAfter`,
`airOnly`, `groundOnly`, and an optional `grabKit` (grab and dash grab frames and reach, hold
frames, mash frames, pummel, four throws with release frame, damage, angle, bkb, kbg).

The `MoveId` set is fixed by the type (jab, three tilts, dash attack, three smashes, five aerials,
four specials, taunt, ledge attack, getup attack); a character can leave a move weak or unusual but
not absent. The brain reads tags and numbers, never a `MoveId` string, except in the executor's
direct-code table.

## 2. Derived numbers per move

All from `MoveDef`, `CharacterDef`, `TUNING` and `StageDef`; `computed:` marks arithmetic, `probe:`
marks a sim run.

- Timing: `startup = min(hitbox.start)` (projectile-only: min spawn frame); aerials from the ground
  add `jumpSquat`; charged smashes add the charge. `activeEnd = max(hitbox.end)`. Lag after a hit on
  frame `f`: `R(m, f) = (iasa ?? totalFrames) - f - 1`; an aerial that lands pays `landingLag`
  instead. Whiff window: `(iasa ?? totalFrames) - activeEnd - 1`.
- Reach: `front = max(x + r)`, `back = -min(x - r)`, `up = -min(y - r)`, `down = max(y + r)` over
  hitboxes; projectiles `x + vx * lifetime + r` (with charge lerps). Aeval: ftilt 80 px, dash
  attack and fsmash 102 px (`src/characters/aeval/moves.ts` comments).
- Shield safety, probe: a shielding sim defender presses its best out-of-shield option on its first
  free frame; record whether the attacker is hit, per spacing bucket. Store the measured flag and
  the computed `advShield = floor(0.6 d) + 2 - R(m, f)` for reference. Do not trust the formula's
  off-by-one alone (Aeval jab computes safe by 1 frame, dtilt margin 0, ftilt unsafe by 2).
- Kill percent, probe: per move (strongest hitbox group) and spot (center, ledge, offstage below the
  ledge), bisect victim percent in [0, 250] through the real hit path against an idle victim; KO
  means crossing `stage.blast`. Repeat against a scripted best-recovery victim for
  `killPctRecover`. Cost about 22 moves x 3 spots x 9 bisection steps x 200 frames, about 0.2 s
  per character and stage. This is what `src/sim/calibrate.ts` already does for center stage.
- Combo potential: `W(m, p) = floor(0.4 * kb(p)) - R(m, f)` for `p` in 0, 20, ..., 200: the victim
  hitstun left after our lag. A follow-up `g` is a true combo when `startup(g)` (plus jump squat
  plus one for jump aerials) is at most `W` and `g` reaches the launched body (02, 9.1).
- Recovery profile, probe: rise per jump by frame integration (Aeval: full hop about 100 px, double
  jump 81, short hop 43), up special rise and drift from `velocity` keys or a probe (Aeval geyser 82
  px in 48 frames, no ledge grab before frame 48), air dodge displacement per direction, and the
  recover box: on a grid of (dx beyond the corner, depth below the top) and (jumps left, up special
  available, dodge available), the deepest cell from which some script reaches `ledgeHang` or
  `onGround`. Cells outside are the edgeguard zone (02, 10.1).
- Shot profile per projectile: `castFrames(h)`, `totalFrames(h)`, `tail(h)`, speed, lifetime,
  range, radius, spawn height, damage, `strength(h)`, frozen frames on hit and on shield, pierces,
  returns (return frame), low flag, burst id, and `cost`/`cap` fields for characters whose zoning is
  resource-bounded (Robin's tomes, Hero's MP and Steve's materials are the shipped precedents,
  https://www.ssbwiki.com/Robin_(SSBU), https://www.ssbwiki.com/Hero_(SSBU),
  https://www.ssbwiki.com/Steve_(SSBU)).

## 3. Tag rules (automatic, hand-overridable)

| Tag | Rule |
|---|---|
| poke | ground normal or fast aerial, startup 9 or less, measured safe on shield at its spacing, front reach at least 0.75 of the longest ground normal |
| antiAir | up reach at least 0.6 of the hurtbox height or angle in [60, 120], startup 12 or less |
| comboStarter | `W` at least the smallest follow-up startup at some `p` up to 40 |
| extender | `R` 15 or less and the same test at `p` in [40, 100] |
| killMove | kill percent at center at most 130, or at the ledge at most 100 (tunable) |
| spike | air move with any hitbox angle in [230, 310] (90 is up in `HitboxDef`) |
| gimpTool | spike, or a projectile crossing the recover box (reach 150 or more), or offstage kill percent 30 below center |
| oosOption | in the sim's out-of-shield list (jump aerials, grab, up smash, up special, roll, spot dodge), startup 12 or less |
| ledgeTrapTool | probe the four ledge options from three spacings; tag when it hits two or more with `R` 25 or less, or a projectile lives 60 frames or more |
| projectile | `MoveDef.projectiles` present |
| getOffMe | covers behind or both sides, startup 8 or less, `R` 20 or less |
| recovery | `helplessAfter` or `invuln`, or upward velocity keys totalling 40 px or more |
| landingOption | aerial with landing lag 10 or less and a hitbox active in its last 8 frames before landing |
| commandGrab | any hitbox with a `GrabSpec` |

Role lists the candidate generator reads: neutral tools (poke, projectile), anti-airs, juggle
tools (antiAir with up reach), landing tools, edgeguard tools with reach and own-risk, ledge trap
tools, tech-chase tools (moves whose active window is 5 frames or longer or which cover a roll
landing), kill moves with percent windows per spot, out-of-shield table ranked by first active
frame, get-off-me options, recovery options ordered by height then distance. Rivals of Aether's
default CPU picks at random from hand-authored per-character arrays keyed by target position
(far_up, far_side, mid_side, close_up, close_down, close_side, neutral,
https://rivalslib.com/workshop_guide/programming/reference/scripts/ai_scripts); Aevalrena fills the
same zones from tags instead (far: projectile, gimpTool; mid side: poke; close up: antiAir; close
down: low and spike moves; neutral: getOffMe), which is the fallback for a brand-new character
before any tuning.

## 4. Schema

```ts
type MoveTag = 'poke' | 'antiAir' | 'comboStarter' | 'extender' | 'killMove' | 'spike' | 'gimpTool'
  | 'oosOption' | 'ledgeTrapTool' | 'projectile' | 'getOffMe' | 'recovery' | 'landingOption' | 'commandGrab';
type Spot = 'center' | 'ledge' | 'offstage';
type KillPct = Record<Spot, number>;                  // NaN = no kill by 250

interface MoveAiInfo {
  id: MoveId; tags: MoveTag[];
  startup: number; activeEnd: number; endlag: number; landingLag: number; total: number;
  reach: { front: number; back: number; up: number; down: number };
  maxDamage: number; advShield: number; safeShield: boolean; safeShieldMeasured: boolean;
  killPct: KillPct; killPctRecover: KillPct;
  starterWindow: number[];                            // W at p = 0, 20, ..., 200
  chargeable: boolean; charge: { maxFrames: number; damageMul: number } | null;
}
interface ShotProfile {
  moveId: MoveId; defId: string;
  castFrames(h: number): number; totalFrames(h: number): number; tail(h: number): number;
  speed(h: number): number; lifetime(h: number): number; range(h: number): number; radius(h: number): number;
  height: number; damage(h: number): number; strength(h: number): number;
  frozenOnHit(h: number, pct: number): number; frozenOnShield(h: number): number;
  pierces: boolean; returns: number | null; low: boolean; burstId: string | null;
  cost: number; cap: number;                          // 0 and Infinity when unbounded
}
interface RecoveryProfile {
  rise: { fullHop: number; shortHop: number; airJump: number };
  upSpecial: { rise: number; frames: number; helpless: boolean; grabsBefore: number };
  airDodge: Record<'l' | 'r' | 'u' | 'd' | 'lu' | 'ld' | 'ru' | 'rd' | 'n', { dx: number; dy: number }>;
  recoverBox: Float32Array;                           // [jumpsLeft][upB][dodge][dxBin] -> max depth px
  fallToBlast: number;                                // frames from ledge height, no fast fall
}
interface GrabAiInfo {
  standing: { total: number; active: [number, number]; reach: number };
  dash: { total: number; active: [number, number]; reach: number };
  holdBase: number; holdPerPercent: number; mashFrames: number;
  throws: Record<ThrowId, { release: number; damage: number; angle: number; bkb: number; kbg: number;
                            killPct: KillPct; starterWindow: number[] }>;
}
interface CharacterAiProfile {
  charId: string; dataHash: string;                   // hash of CharacterDef + TUNING + StageDef
  physics: { weight: number; walk: number; run: number; dash: number; dashFrames: number; airSpeed: number;
             gravity: number; maxFall: number; fastFall: number; jumpSquat: number; hurtbox: { w: number; h: number } };
  moves: Record<MoveId, MoveAiInfo>;
  shots: ShotProfile[];
  grab: GrabAiInfo;
  recovery: RecoveryProfile;
  roles: { neutral: MoveId[]; antiAir: MoveId[]; juggle: MoveId[]; landing: MoveId[]; edgeguard: MoveId[];
           ledgeTrap: MoveId[]; techChase: MoveId[]; kill: MoveId[]; oos: MoveId[]; getOffMe: MoveId[]; recovery: MoveId[] };
  comboTable: ComboTable;                             // 02, 9.2; keyed by matchup brackets at run time
  styleAffinity: { aggressive: number; defensive: number; countering: number };   // informational
  overrides?: CharacterAiOverrides;
}
interface CharacterAiOverrides {
  tags?: Partial<Record<MoveId, { add?: MoveTag[]; remove?: MoveTag[] }>>;
  numbers?: DeepPartial<Pick<CharacterAiProfile, 'moves' | 'shots' | 'grab' | 'recovery'>>;
  comboLists?: MoveId[][];                            // hand routes, still gated by the true-combo test
  spacingMul?: number; preferredHolds?: number[];     // e.g. [0, 15, 30, 45, 60]
  slots?: Record<string, number>;                     // named per-character choices, like Ultimate's fighter slots
}
function deriveAiProfile(def: CharacterDef, stage: StageDef, tuning: typeof TUNING): CharacterAiProfile
```

`deriveAiProfile`: (1) hash inputs and return a cache hit; (2) timing and reach per move; (3)
shield safety by probe; (4) kill probes per spot; (5) `W` tables; (6) recovery grid and shot
profiles; (7) grab data; (8) tag rules, then apply `overrides` (hand values win, and a test flags an
override that contradicts a derived value by more than a margin); (9) role lists and the combo
table; (10) freeze and cache. Only steps 4, 6 and the combo table depend on the stage. Total cost:
about 1.5 s per character and stage at load (dominated by the combo table); build at warm-up, and
lazily per bracket if a stage is added at run time.

## 5. Matchup profile and brackets

Knockback scales with the defender's weight through `200 / (w + 100)`: 1.064 at weight 88, 1.0 at
100, 0.889 at 125, so a weight-125 defender takes about 16% less of the percent term than a
weight-88 one (01, section 2). Per pair (A attacking B):

- `K = min over A's reliable killers of killPct.center against B's weight` (reliable: startup 20 or
  less or a confirm exists). Combo-table brackets for B are `[0, 0.3K, 0.6K, 0.85K, K]` instead of
  the fixed 0-30-60-100 (`docs/CPU_AEVALMERE.md`).
- Danger map for A: the percent at which each of B's moves kills A at each spot, from B's profile
  against A's weight; the survival logic (02, 11.5) reads it.
- Threat ranges for A: B's `framesToHit` tables at A's current state, used by `threatZone`.
- Matchup-specific tags: a move of A is `safeVsB` on shield if B's fastest out-of-shield option
  cannot reach it inside the measured advantage.

The `MatchupProfile` is derived, cached by (A, B, stage, tuning hash), and never hand-written.

## 6. Precedents

- Ultimate ships shared AI logic with per-fighter data: the cracked archive lists
  `fighter/common/ai/param/{attack_data_param, attack_list_param, common_param, fighter_param,
  nfp_learning_param, nfp_param, personality_param, stage_param}.prc` and, for each of 94 fighters,
  `fighter/<name>/ai/param/attack_data_param.prc` and `attack_list_param.prc`
  (https://github.com/ultimate-research/archive-hashes). Label names include about 69
  `base_ratio_*` decision ratios (weak, strong, smash, special and aerial attacks by direction,
  catch, throws, shield, escapes, approach_run, cliff_out, return_hi) and character-specific ones
  (`base_ratio_shulk_monad_*`, `base_ratio_ryu_*`, `base_ratio_gaogaen_revenge_*`)
  (https://github.com/ultimate-research/param-labels). File contents are not public; the shape is
  the point: shared logic, a per-character attack list with per-attack data, a few named ratios.
  `deriveAiProfile` supplies the first two automatically; `overrides.slots` is the third.
- Amiibo move weights are per-character arrays over grounded and aerial move classes with an
  implicit remainder (jab, neutral air), plus five per-character slots for special choices
  (https://docs.google.com/document/d/1L3c-QKr46ATTSxaicPHNFq5uW-uRytVViPRvdM93IQo/edit). Style
  weights over tags are the Aevalrena equivalent.
- Rivals of Aether II's CPU recovery asks each character for its viable recovery moves with a
  hand-measured range and drift slope and picks at random among the valid ones with a last-ditch
  fallback (https://rivals2.com/workshop/knowledge-base/character-creation/set-up-character-ai-coming-soon/);
  the forward model replaces the hand measurement with a probe and the random pick with the matrix
  in 02, 11.3, but the per-character list and the last-ditch fallback stay.
- Hard-coded follow-up lists are the documented failure mode: Smash 4 and Ultimate CPUs keep
  attempting a set down-throw follow-up at percents where it no longer connects
  (https://www.ssbwiki.com/Flaws_in_artificial_intelligence). Hand routes in `comboLists` are
  therefore still gated by the true-combo test at the victim's real percent.

## 7. How Ultimate characters differ, and what the profile captures

Weight (Pichu lightest to Bowser heaviest), fall speed and gravity (fast fallers are combo food and
easy to juggle; floaties escape combos and survive vertical kills), air and run speed, jump height,
hurtbox size, recovery type and distance, kill power, projectile presence, grab range, out-of-shield
speed, and disjoint reach are the attribute axes the community uses
(https://www.ssbwiki.com/Fast_fall, https://www.ssbwiki.com/Air_dodge, https://ultimateframedata.com/stats).
Every one of them is a field or a probe above: weight and gravity enter `kb` and the launch
integration; hurtbox size enters reach tests; recovery enters the recover box; disjoint is the gap
between reach and hurtbox extent, which the shield-safety and whiff-punish probes measure
implicitly. Nothing in the brain names a character.

## 8. Per-character tuning workflow

1. Add the `CharacterDef`; run `deriveAiProfile`; inspect the printed tag table and kill-percent
   table (extend `src/sim/calibrate.ts` to print them).
2. Run the harness (06) with the new character in every archetype and level against Aeval and in
   the mirror: win-rate ladder, style signatures, kill-speed, self-destructs, cost.
3. Fix balance in `CharacterDef`, not in the brain, when a tag is wrong because a move is wrong.
   Use `overrides` only for judgment calls the rules cannot express (a special that is a recovery in
   spirit but has no upward velocity key; a poke that is safe only from one spacing).
4. Commit the override file next to the character (`src/characters/<id>/ai.overrides.json`) and a
   golden-seed replay per archetype so later changes are diffed.

## 9. Tests that hold the contract

- A new character loads and plays every tier with no diff outside `src/characters/<id>/`.
- `deriveAiProfile` is deterministic (same hash in, same profile out) and stage-aware.
- Every derived kill percent agrees with `calibrate.ts` within 2%.
- No brain source file contains a `MoveId` string literal outside the direct-code table and the
  role-list builder.
- The style signatures (03, 3.3) hold for the new character at levels 2 to 5.
- The zoner archetype logic (02, 12) degrades to nothing when `shots` is empty, and the aggressive
  archetype remains aggressive on a character with no projectile (measured by approaches per
  minute).
