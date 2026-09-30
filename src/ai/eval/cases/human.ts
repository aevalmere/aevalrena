/**
 * Human-likeness at human tiers (06 `aw`, `bg`, section 2; 03 section 6), UI levels 1 to 9 in
 * mirrors on both stages.
 *
 * `aw` reaction floor: responses faster than R - 1 frames, where R is the level vector's
 * reactFloor. A response is the first press of an action button (Jump, Attack, Special, Shield,
 * Dodge, Grab) or a direct code after the stimulus; metrics.ts `reactionsOf` counts any press,
 * including walking taps, and is reported beside it. The median band R to R + cadence + 1 needs the
 * executor cadence, which the BrainFactory surface does not expose, so the median is reported.
 *
 * `hl`: input events per minute under the tier's eventsPerSec cap, 0 accidents from top player up,
 * repetition reported. `bg`: execution-window success needs the executor's intent, not visible in
 * the input stream; reported as info until wave 3 exposes it.
 */
import { Btn } from '../../../core/types';
import type { MatchMetrics, ReplayEvent, TestCase } from '../../contracts';
import { levelVector } from '../../levels';
import { specForUiLevel } from '../../levels';
import { computeMetrics, REACT_MARGIN, REACT_MAX, reactionsOf } from '../metrics';
import { engineMode, pairedJobs, pairTag, runBatch } from '../pool';
import { num } from '../replay';
import { mean } from '../stats';
import { byTier, defineCase, f1, f2, gate, listed, med, uiBrain } from './common';

const RESPONSE_MASK = Btn.Jump | Btn.Attack | Btn.Special | Btn.Shield | Btn.Dodge | Btn.Grab;

/** Latencies (frames) from each stimulus to the first action press by `slot`. */
export function responseLatencies(events: readonly ReplayEvent[], slot: number, isOpp: (p: number) => boolean): number[] {
  const ev = events.slice().sort((a, b) => a.frame - b.frame);
  const stim: number[] = [];
  const presses: number[] = [];
  const busy: [number, number][] = [];
  let busyFrom = -1;
  for (const e of ev) {
    if (e.slot >= 0 && isOpp(e.slot)) {
      if (e.kind === 'move' && num(e, 'adx') <= num(e, 'reach') + REACT_MARGIN && num(e, 'proj') === 0) stim.push(e.frame + num(e, 'act'));
      else if (e.kind === 'shot') stim.push(e.frame);
    }
    if (e.slot !== slot) continue;
    if (e.kind === 'press' && ((num(e, 'b') & RESPONSE_MASK) !== 0 || num(e, 'd') !== 0)) presses.push(e.frame);
    else if (e.kind === 'stun') {
      if (num(e, 'on') === 1) busyFrom = e.frame;
      else if (busyFrom >= 0) { busy.push([busyFrom, e.frame]); busyFrom = -1; }
    }
  }
  if (busyFrom >= 0) busy.push([busyFrom, Infinity]);
  stim.sort((a, b) => a - b);
  const out: number[] = [];
  let pending = -1;
  let pi = 0;
  for (const s of stim) {
    if (s <= pending) continue;
    let stunned = false;
    for (const [a, b] of busy) if (s >= a && s < b) { stunned = true; break; }
    if (stunned) continue;
    while (pi < presses.length && presses[pi] <= s) pi++;
    if (pi < presses.length && presses[pi] - s <= REACT_MAX) { out.push(presses[pi] - s); pending = presses[pi]; }
  }
  return out;
}

interface TierData { ms: MatchMetrics[]; lat: number[]; anyLat: number[] }
const cache = new Map<string, TierData>();

/** Metrics and latencies of both players over `n` mirrors at a UI level, cached per process. */
function tierData(level: number, n: number): TierData {
  const key = `${engineMode()}|${level}|${n}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const b = uiBrain(level);
  const d: TierData = { ms: [], lat: [], anyLat: [] };
  for (const jr of runBatch(pairedJobs({ stocks: 2, frameCap: 7200, a: b.ref, b: b.ref, record: true }, pairTag(b.ref, b.ref, 'mirror'), n))) {
    const ev = jr.result.events ?? [];
    for (let p = 0; p < 2; p++) {
      d.ms.push(computeMetrics(jr.result, p));
      d.lat.push(...responseLatencies(ev, p, (q) => q === 1 - p));
      d.anyLat.push(...reactionsOf(ev.slice().sort((x, y) => x.frame - y.frame), p, (q) => q === 1 - p));
    }
  }
  cache.set(key, d);
  return d;
}

function humanLevels(tier: string): number[] {
  return tier === 'fast' ? [5, 9] : [1, 2, 3, 4, 5, 6, 7, 8, 9];
}

const aw: TestCase = defineCase('aw', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 6, nightly: 20 });
  const rows: string[] = [];
  const fails: string[] = [];
  const metrics: Record<string, number> = {};
  for (const lvl of humanLevels(tier)) {
    const lv = levelVector(specForUiLevel(lvl).s, false);
    const R = lv.reactFloor;
    const d = tierData(lvl, n);
    const under = d.lat.filter((x) => x < R - 1).length;
    const anyUnder = d.anyLat.filter((x) => x < R - 1).length;
    const m = med(d.lat);
    metrics[`UI${lvl}.under`] = under; metrics[`UI${lvl}.median`] = m; metrics[`UI${lvl}.R`] = R;
    rows.push(`UI${lvl} R ${R}: ${under}/${d.lat.length} under ${R - 1}f, median ${f1(m)} (any-press ${anyUnder}/${d.anyLat.length})`);
    if (under > 0) fails.push(`UI${lvl} ${under} responses under ${R - 1}f`);
  }
  const detail = `${n} mirrors per tier: ${rows.join('; ')} | median band R..R+cadence+1 needs the executor cadence (info)` +
    `${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`;
  return gate('aw', fails.length === 0, detail, metrics, tier === 'fast');
});

/** Accident-free from top player (s 0.75, UI 7) up (05 section 5). */
export const HL_ACCIDENT_S = 0.75;
/** Repetition bound reported until the human baseline exists (03 section 6). */
export const HL_REPETITION_INFO = 0.5;

const hl: TestCase = defineCase('hl', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 6, nightly: 20 });
  const rows: string[] = [];
  const fails: string[] = [];
  const metrics: Record<string, number> = {};
  for (const lvl of humanLevels(tier)) {
    const spec = specForUiLevel(lvl);
    const lv = levelVector(spec.s, false);
    const cap = lv.eventsPerSec * 60;
    const d = tierData(lvl, n);
    const ipm = mean(d.ms.map((m) => m.inputsPerMin).filter((x) => Number.isFinite(x)));
    const maxIpm = Math.max(...d.ms.map((m) => m.inputsPerMin).filter((x) => Number.isFinite(x)));
    const acc = d.ms.reduce((a, m) => a + (m.accidents ?? 0), 0);
    const rep = mean(d.ms.map((m) => m.repetition).filter((x) => Number.isFinite(x)));
    metrics[`UI${lvl}.inputsPerMin`] = ipm; metrics[`UI${lvl}.accidents`] = acc; metrics[`UI${lvl}.repetition`] = rep;
    rows.push(`UI${lvl} inputs/min ${f1(ipm)} max ${f1(maxIpm)} cap ${f1(cap)}, accidents ${acc}, repetition ${f2(rep)}`);
    if (maxIpm > cap) fails.push(`UI${lvl} ${f1(maxIpm)} inputs/min over ${f1(cap)}`);
    if (spec.s >= HL_ACCIDENT_S && acc > 0) fails.push(`UI${lvl} ${acc} accidents`);
  }
  const detail = `${n} mirrors per tier: ${rows.join('; ')} | repetition bound ${HL_REPETITION_INFO} is info until a human baseline exists` +
    `${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`;
  return gate('hl', fails.length === 0, detail, metrics, tier === 'fast');
});

const bg: TestCase = defineCase('bg', ['full', 'nightly'], () =>
  gate('bg', true, 'execution windows (short hop, smash flick, jump-cancel usmash) need the executor intent, which BrainFactory does not expose; ' +
    'measure through an executor probe in wave 3', {}, true));

export const HUMAN_CASES: readonly TestCase[] = [aw, hl, bg];
