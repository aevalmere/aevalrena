/**
 * Shared helpers for the case files: tier counts, GateResult builders, win and team scoring, the
 * brain sets each gate runs over (new engine specs, or UI levels when the legacy brain stands in).
 */
import { RESPAWN_PLATFORM_FRAMES } from '../../../core/constants';
import { CHARACTER_DEFS } from '../../../characters/registry';
import type { MoveId } from '../../../core/types';
import type { Archetype, CpuSpec, GateResult, GuideLevel, MatchResult, TestCase, Tier } from '../../contracts';
import { guideLevelS, specForUiLevel } from '../../levels';
import { engineMode, refLabel, specRef, ui, type BrainRef, type JobResult } from '../pool';
import { wilson } from '../stats';

export interface CaseCtx { tier: Tier; shard: number; shards: number }

export function byTier<T>(tier: Tier, v: { fast: T; full: T; nightly: T }): T {
  return v[tier];
}

/** A gated result; `info` true prints it without counting it (fast-tier statistics, missing data). */
export function gate(id: string, pass: boolean, detail: string, metrics: Record<string, number> = {}, info = false): GateResult {
  return { id, pass, info, detail: `[${engineMode()}] ${detail}`, metrics };
}

export function defineCase(id: string, tiers: readonly Tier[], run: (ctx: CaseCtx) => GateResult): TestCase {
  return { id, tiers, run };
}

export const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : String(x));
export const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : String(x));
export const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : String(x));

/** "k/n lb 0.839" with the Wilson 95% lower bound. */
export function wl(k: number, n: number): string {
  return `${Number.isInteger(k) ? k : k.toFixed(1)}/${n} lb ${f3(wilson(k, n).lo)}`;
}

export interface Tally { n: number; wins: number; losses: number; draws: number; score: number; stocksLost: number; sds: number; frames: number }

/** Wins, losses and half points of player `p` over two-sided results (runner `winner`). */
export function tally(rs: readonly JobResult[], p: number): Tally {
  const t: Tally = { n: 0, wins: 0, losses: 0, draws: 0, score: 0, stocksLost: 0, sds: 0, frames: 0 };
  for (const jr of rs) {
    const r = jr.result;
    t.n++;
    if (r.winner < 0) { t.draws++; t.score += 0.5; } else if (r.winner === p) { t.wins++; t.score += 1; } else t.losses++;
    t.stocksLost += r.stocksLost[p] ?? 0;
    t.sds += r.sds[p] ?? 0;
    t.frames += r.frames;
  }
  return t;
}

/**
 * Winning team from stocks left, -1 for a timeout or a draw. Needed when more than two teams play
 * (runner.ts maps a third team's win to -1).
 */
export function teamOutcome(r: MatchResult, teams: readonly number[], stocks: number): number {
  if (r.timeout) return -1;
  let found = -1;
  for (let p = 0; p < teams.length; p++) {
    if (stocks - (r.stocksLost[p] ?? stocks) > 0) {
      if (found >= 0 && found !== teams[p]) return -1;
      found = teams[p];
    }
  }
  return found;
}

/** Median of numbers; Infinity entries (censored) sort last. NaN when empty. */
export function med(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return (s.length & 1) === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function meanOf(xs: readonly number[]): number {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length === 0 ? NaN : v.reduce((a, b) => a + b, 0) / v.length;
}

export const ARCHETYPES: readonly Archetype[] = ['aggressive', 'defensive', 'countering', 'balanced'];

export function guideSpec(archetype: Archetype, level: GuideLevel): CpuSpec {
  if (archetype === 'balanced' && level === 5) return specForUiLevel(10);
  return { archetype, level, god: false, s: guideLevelS(archetype, level) };
}

/** A brain under test with its skill scalar (thresholds key on s). */
export interface Brain { ref: BrainRef; label: string; s: number; god: boolean; guide: GuideLevel }

/** UI level as a Brain; the guide level is the nearest guide point (plan 2.1). */
export function uiBrain(level: number): Brain {
  const spec = specForUiLevel(level);
  return { ref: ui(level), label: refLabel(ui(level)), s: spec.s, god: spec.god, guide: spec.level };
}

export function specBrain(spec: CpuSpec): Brain {
  const r = specRef(spec);
  return { ref: r, label: refLabel(r), s: spec.s, god: spec.god, guide: spec.level };
}

/**
 * The 19 non-god CPUs of 06 (four archetypes x five levels minus balanced 5) with the new engine;
 * under the legacy brain, which has one style, UI levels 1 to 9.
 */
export function nonGodBrains(): Brain[] {
  if (engineMode() === 'legacy') return [1, 2, 3, 4, 5, 6, 7, 8, 9].map(uiBrain);
  const out: Brain[] = [];
  const levels: readonly GuideLevel[] = [1, 2, 3, 4, 5];
  for (const a of ARCHETYPES) for (const l of levels) if (!(a === 'balanced' && l === 5)) out.push(specBrain(guideSpec(a, l)));
  return out;
}

/** A level 5 of 06 (world's best: balanced 4, the others' 5); legacy: UI 9. */
export function isLevel5(b: Brain): boolean {
  return !b.god && b.s >= 1;
}

/** The guide-level points only (legacy: UI 1, 3, 5, 7, 9), for matrices that do not need every UI level. */
export function guidePointBrains(): Brain[] {
  if (engineMode() === 'legacy') return [1, 3, 5, 7, 9].map(uiBrain);
  return nonGodBrains();
}

export const GOD_BRAIN: Brain = uiBrain(10);

/** 06 `ba` target: 1,200 frames once the respawn lever is set (plan decision 1), else 1,800. */
export function killTimeTarget(): number {
  return RESPAWN_PLATFORM_FRAMES <= 100 ? 1200 : 1800;
}

/** Longest ground normal reach of a character, px (the metrics threat range uses 1.2 x this). */
export function groundReach(charId = 'aeval'): number {
  const def = CHARACTER_DEFS[charId];
  const ids: MoveId[] = ['jab', 'ftilt', 'utilt', 'dtilt', 'dashatk', 'fsmash', 'usmash', 'dsmash'];
  let best = 0;
  for (const id of ids) {
    const m = def.moves[id];
    if (m === undefined) continue;
    for (const h of m.hitboxes) if (h.x + h.r > best) best = h.x + h.r;
  }
  return best;
}

/** Keeps the first brain per resolved behaviour (legacy collapses archetypes onto UI levels). */
export function uniqueBy<T>(xs: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) { const k = key(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

/** First `max` items joined, with a "(+k more)" tail. */
export function listed(xs: readonly string[], max = 8): string {
  if (xs.length <= max) return xs.join('; ');
  return `${xs.slice(0, max).join('; ')} (+${xs.length - max} more)`;
}
