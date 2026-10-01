/**
 * Plan registry and candidate generation (docs/CPU_PLAN.md W2.4, section 4.7; cpu-guide 02
 * section 5).
 *
 * Registry. `PLAN_FAMILIES` is one live array of every registered family, in registration order.
 * This module registers the families it can import without a cycle: NEUTRAL_FAMILIES,
 * ADVANTAGE_FAMILIES and PASSIVE_FAMILIES. plans/edge.ts and plans/defense.ts register their own
 * lists at the end of their module body:
 *
 *   import { registerFamilies } from './index';
 *   registerFamilies(EDGE_FAMILIES);      // or DEFENSE_FAMILIES
 *
 * and the brain imports those two modules once (`import './plans/edge'; import './plans/defense';`)
 * so they register before the first decision. index.ts never imports them, so there is no import
 * cycle. `registerFamilies` is idempotent by object identity: registering the same family twice
 * keeps one entry.
 *
 * Script format. Families here build plans with plans/script.ts: a `Plan` carries either a static
 * `Program` (ops of held, tapped and direct-code inputs on script-frame spans, with relative
 * direction bits) or a script function with per-run registers (`runState`). Before a chosen plan
 * runs, the brain calls `preparePlanCtx(plan, view, frame, ctx)` once; each frame it sets
 * `ctx.frame` and calls `plan.script(t, self, ctx, out)` with `t` advancing only outside hitlag.
 * Any other PlanInstance (edge.ts `LocalPlan`) works as long as its script follows the same rule;
 * `preparePlanCtx` fills the context for it too.
 *
 * generateCandidates (prefiltered, priority order):
 * 1. Families whose `situations` contain `v.aff.situation` and whose id is in the level's
 *    vocabulary generate into a scratch list.
 * 2. Dropped: plans whose own family id is outside the vocabulary (a family object may emit plans
 *    under a neighbouring id), attacks when the target is not a live opponent (never aim at a
 *    teammate), plans generated against a teammate, duplicates by name.
 * 3. Style filter (03 section 3.1 candidate filter) on neutral plans only, never emptying the set.
 * 4. Ordered by priority + bonus, minus the tempo staleness of PF_STALE plans; ties keep
 *    registration order.
 * 5. Capped to PREFILTER_CAP and the level's menu cap. Under a menu cap smaller than the list,
 *    the best half is kept and the rest are drawn from the remainder with `u01`, so low levels
 *    see a varied menu rather than always the same top few.
 */
import type { DecisionView, PlanFamily, PlanFamilyId, PlanInstance } from '../contracts';
import type { GenerateCandidatesFn } from '../contracts';
import { PF_ATTACK, PF_PROJ, PF_STALE } from '../contracts';
import { STREAM, u01 } from '../rng';
import { NEUTRAL_FAMILIES } from './neutral';
import { ADVANTAGE_FAMILIES } from './advantage';
import { PASSIVE_FAMILIES } from './passive';
import { isOpponent, K_APPROACH, K_COMMIT, K_RETREAT, Plan, targetIndex } from './script';

export { preparePlanCtx, newPlanCtx, PlanRunner, toInputFrame } from './script';
export { advantageAbort, predictLanding, thirdPartyThreat } from './advantage';
export { passiveKind } from './passive';

/** Most candidates one decision hands to the search (02 section 5). */
export const PREFILTER_CAP = 25;

const REGISTRY: PlanFamily[] = [];

/** Every registered family, in registration order (live: edge.ts and defense.ts append). */
export const PLAN_FAMILIES: readonly PlanFamily[] = REGISTRY;

/** Adds families to the registry, skipping ones already present; returns how many were added. */
export function registerFamilies(fams: readonly PlanFamily[]): number {
  let added = 0;
  for (let i = 0; i < fams.length; i++) {
    if (REGISTRY.indexOf(fams[i]) >= 0) continue;
    REGISTRY.push(fams[i]);
    added++;
  }
  return added;
}

/**
 * Candidate vetoes a character pack registers (the Trekmore sword throttle): a candidate any of
 * them rejects is dropped with the vocabulary and teammate rules. Same no-cycle rule as
 * registerFamilies: the pack imports this module, never the reverse.
 */
const VETOES: ((v: DecisionView, p: PlanInstance) => boolean)[] = [];

/** Adds a candidate veto (true = drop the plan); a function already present is skipped. */
export function registerCandidateVeto(fn: (v: DecisionView, p: PlanInstance) => boolean): void {
  if (VETOES.indexOf(fn) < 0) VETOES.push(fn);
}

function vetoed(v: DecisionView, p: PlanInstance): boolean {
  for (let i = 0; i < VETOES.length; i++) if (VETOES[i](v, p)) return true;
  return false;
}

registerFamilies(NEUTRAL_FAMILIES);
registerFamilies(ADVANTAGE_FAMILIES);
registerFamilies(PASSIVE_FAMILIES);

// ---------------------------------------------------------------------------------------------
// Style filter
// ---------------------------------------------------------------------------------------------

/** Families the style filter may prune (neutral play only). */
const FILTERED: ReadonlySet<PlanFamilyId> = new Set<PlanFamilyId>([
  'wait', 'walk', 'dash', 'dashDance', 'emptyHop', 'poke', 'tilt', 'smash', 'chargedSmash', 'grab', 'dashGrab',
  'projectile', 'shAerial', 'fhAerial', 'retreatAerial', 'fastFallAerial', 'platform', 'shield', 'spotDodge', 'roll',
  'baitProbe', 'special',
]);

/** Plan names the filter never prunes: whiff punishes and multi-opponent positioning. */
function exempt(name: string): boolean {
  return name.startsWith('punish') || name.startsWith('pos');
}

/** Kind of a plan for the filter, -1 when it is not one of ours. */
function kindOf(p: PlanInstance): number {
  return p instanceof Plan ? p.kind : -1;
}

/** True when `p` passes the style filter in this view. */
function passesStyle(v: DecisionView, p: PlanInstance, meInKill: boolean, tgInKill: boolean, opening: boolean): boolean {
  const f = v.style.filter;
  if (f === 'none' || !FILTERED.has(p.family) || exempt(p.name)) return true;
  const k = kindOf(p);
  if (k < 0) return true;
  if (f === 'aggressive') return k !== K_RETREAT || meInKill;
  if (f === 'defensive') return k !== K_APPROACH || tgInKill || v.stocksAhead < 0;
  // countering: hold spacing, shield, dodge, bait; commit only into an opening or on the clock.
  if (k === K_COMMIT || k === K_APPROACH) return opening;
  if ((p.flags & PF_PROJ) !== 0) return opening;
  return true;
}

function targetInKillRange(v: DecisionView, ti: number): boolean {
  if (ti < 0) return false;
  const f = v.p.state.fighters[ti];
  const kills = v.me.roles.kill;
  for (let i = 0; i < kills.length; i++) {
    const kp = v.aff.killPctHere(kills[i]);
    if (Number.isFinite(kp) && f.percent >= kp) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------------------------

const SCRATCH: PlanInstance[] = [];
const KEYS: number[] = [];
const ORDER: number[] = [];
const KEEP: PlanInstance[] = [];
const NAMES = new Set<string>();

function scoreOf(v: DecisionView, p: PlanInstance): number {
  let s = p.priority + p.bonus;
  if ((p.flags & PF_STALE) !== 0) s -= v.tempo.stale(p.name);
  return s;
}

/** Prefiltered candidates in priority order; returns the count (see the file comment). */
export const generateCandidates: GenerateCandidatesFn = (v, out) => {
  out.length = 0;
  SCRATCH.length = 0;
  const sit = v.aff.situation;
  const vocab = v.level.vocabulary;
  for (let i = 0; i < REGISTRY.length; i++) {
    const fam = REGISTRY[i];
    if (fam.situations.indexOf(sit) < 0 || !vocab.has(fam.id)) continue;
    fam.generate(v, SCRATCH);
  }
  const s = v.p.state;
  const meI = v.p.meI;
  const ti = targetIndex(v);
  // Drop by vocabulary and teammate rules, score, then order (insertion sort, stable).
  KEEP.length = 0; KEYS.length = 0; ORDER.length = 0;
  for (let i = 0; i < SCRATCH.length; i++) {
    const p = SCRATCH[i];
    if (!vocab.has(p.family)) continue;
    if (ti < 0 && (p.flags & PF_ATTACK) !== 0) continue;
    if (p instanceof Plan && p.target >= 0 && !isOpponent(s, meI, p.target)) continue;
    if (VETOES.length > 0 && vetoed(v, p)) continue;
    KEEP.push(p);
    KEYS.push(scoreOf(v, p));
    let j = ORDER.length;
    ORDER.push(KEEP.length - 1);
    const key = KEYS[KEEP.length - 1];
    while (j > 0 && KEYS[ORDER[j - 1]] < key) { ORDER[j] = ORDER[j - 1]; j--; }
    ORDER[j] = KEEP.length - 1;
  }
  // Dedupe by name and apply the style filter (neutral only), keeping order.
  const styled = sit === 'neutral' && v.style.filter !== 'none';
  const meInKill = v.aff.dangerHere >= 1;
  const tgInKill = styled ? targetInKillRange(v, ti) : false;
  const opening = v.aff.whiffPunish > 0 || v.aff.oppBusy > 0 || v.tempo.clock() >= v.style.clockForceFrames;
  let n = 0;
  for (let pass = 0; pass < 2 && n === 0; pass++) {
    NAMES.clear();
    for (let i = 0; i < ORDER.length; i++) {
      const p = KEEP[ORDER[i]];
      if (NAMES.has(p.name)) continue;
      if (pass === 0 && styled && !passesStyle(v, p, meInKill, tgInKill, opening)) continue;
      NAMES.add(p.name);
      SCRATCH[n++] = p;
    }
  }
  // Cap: best first, then a seeded draw from the rest under a small menu cap.
  const cap = Math.min(PREFILTER_CAP, v.level.menuCap);
  if (n <= cap) {
    for (let i = 0; i < n; i++) out.push(SCRATCH[i]);
    return out.length;
  }
  const top = Math.max(1, Math.ceil(cap / 2));
  for (let i = 0; i < top; i++) out.push(SCRATCH[i]);
  let rest = n - top;
  const frame = s.frame;
  for (let k = 0; out.length < cap && rest > 0; k++) {
    const r = top + Math.floor(u01(v.seed, v.slot, frame, STREAM.mix, k) * rest);
    out.push(SCRATCH[r]);
    SCRATCH[r] = SCRATCH[top + rest - 1];
    rest--;
  }
  // Keep the draw in priority order for the search.
  for (let i = top + 1; i < out.length; i++) {
    const p = out[i];
    const key = p.priority + p.bonus;
    let j = i;
    while (j > top && out[j - 1].priority + out[j - 1].bonus < key) { out[j] = out[j - 1]; j--; }
    out[j] = p;
  }
  return out.length;
};

