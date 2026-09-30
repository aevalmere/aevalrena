/**
 * Style distinctness and the human baseline (06 `ax`, `ay`; 03 section 3.3).
 *
 * `ax`: each archetype at levels 2 to 5 against balanced at the same level (balanced 4 stands in for
 * balanced 5, as in `au`). The baseline b is the balanced player's per-match metrics in the balanced
 * mirror at that level. Gates: the 03 3.3 ratio rules on the means, Cohen's d at least 0.8 on each
 * archetype's defining metric, and Mann-Whitney p under 0.05 on it. The legacy brain has one style,
 * so every cell is a mirror and the case is reported as info.
 *
 * `ay`: per-situation option entropy and repetition per human tier. The 0.7 to 1.3 x human band
 * needs recorded human matches (owner decision O2), so the case reports the CPU values only.
 */
import type { Archetype, GuideLevel, MatchMetrics, TestCase } from '../../contracts';
import { computeMetrics } from '../metrics';
import { engineMode, pairedJobs, pairTag, runBatch } from '../pool';
import { cohensD, mannWhitney, mean } from '../stats';
import { byTier, defineCase, f2, gate, guideSpec, listed, specBrain, uiBrain, type Brain } from './common';

interface Rule { metric: string; op: '>=' | '<='; k: number }
/** 03 3.3 ratio form: archetype mean against k x the balanced mean. */
const RULES: Readonly<Record<Exclude<Archetype, 'balanced'>, { defining: string; sign: 1 | -1; rules: Rule[] }>> = {
  aggressive: { defining: 'threatShare', sign: 1, rules: [
    { metric: 'threatShare', op: '>=', k: 1.3 }, { metric: 'shieldShare', op: '<=', k: 0.6 }] },
  defensive: { defining: 'meanNeutralDistance', sign: 1, rules: [
    { metric: 'meanNeutralDistance', op: '>=', k: 1.2 }, { metric: 'shieldShare', op: '>=', k: 1.5 },
    { metric: 'projectilesPerMin', op: '>=', k: 1.3 }] },
  countering: { defining: 'whiffPunishShare', sign: 1, rules: [
    { metric: 'whiffPunishShare', op: '>=', k: 1.4 }, { metric: 'commitmentRate', op: '<=', k: 0.75 }] },
};
export const AX_D = 0.8;
export const AX_P = 0.05;

function col(ms: readonly MatchMetrics[], k: string): number[] {
  return ms.map((m) => m[k]).filter((x) => Number.isFinite(x));
}

function balancedAt(level: number): Brain {
  return specBrain(guideSpec('balanced', (level === 5 ? 4 : level) as GuideLevel));
}

const ax: TestCase = defineCase('ax', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 4, full: 16, nightly: 30 });
  const levels = tier === 'fast' ? [3] : [2, 3, 4, 5];
  const legacy = engineMode() === 'legacy';
  const fails: string[] = [];
  const rows: string[] = [];
  const metrics: Record<string, number> = {};
  for (const lvl of levels) {
    const bal = balancedAt(lvl);
    const base: MatchMetrics[] = [];
    for (const r of runBatch(pairedJobs({ stocks: 2, frameCap: 7200, a: bal.ref, b: bal.ref, record: true }, pairTag(bal.ref, bal.ref, 'ax'), n))) {
      base.push(computeMetrics(r.result, 0), computeMetrics(r.result, 1));
    }
    for (const arch of ['aggressive', 'defensive', 'countering'] as const) {
      const me = specBrain(guideSpec(arch, lvl as GuideLevel));
      const ms = runBatch(pairedJobs({ stocks: 2, frameCap: 7200, a: me.ref, b: bal.ref, record: true }, pairTag(me.ref, bal.ref, 'ax'), n))
        .map((r) => computeMetrics(r.result, 0));
      const spec = RULES[arch];
      const bad: string[] = [];
      for (const rule of spec.rules) {
        const a = mean(col(ms, rule.metric)); const b = mean(col(base, rule.metric));
        const ratio = b !== 0 ? a / b : NaN;
        metrics[`L${lvl}.${arch}.${rule.metric}.ratio`] = ratio;
        const ok = rule.op === '>=' ? ratio >= rule.k : ratio <= rule.k;
        if (!ok) bad.push(`${rule.metric} ${f2(ratio)}b (${rule.op} ${rule.k})`);
      }
      const xa = col(ms, spec.defining); const xb = col(base, spec.defining);
      const d = cohensD(xa, xb) * spec.sign;
      const mw = mannWhitney(xa, xb);
      metrics[`L${lvl}.${arch}.d`] = d; metrics[`L${lvl}.${arch}.p`] = mw.p;
      if (!(d >= AX_D)) bad.push(`d ${f2(d)} < ${AX_D} on ${spec.defining}`);
      if (!(mw.p < AX_P)) bad.push(`MW p ${f2(mw.p)} on ${spec.defining}`);
      rows.push(`L${lvl} ${arch} d ${f2(d)} p ${f2(mw.p)}`);
      if (bad.length > 0) fails.push(`L${lvl} ${arch}: ${bad.join(', ')}`);
    }
  }
  const note = legacy ? 'legacy has one style, so each archetype plays the balanced brain; ' : '';
  return gate('ax', fails.length === 0, `${note}${n} per cell: ${rows.join(', ')}${fails.length > 0 ? ` | FAIL: ${listed(fails, 6)}` : ''}`,
    metrics, legacy || tier === 'fast');
});

const ay: TestCase = defineCase('ay', ['full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 4, nightly: 20 });
  const rows: string[] = [];
  const metrics: Record<string, number> = {};
  for (let lvl = 1; lvl <= 9; lvl++) {
    const b = uiBrain(lvl);
    const ms: MatchMetrics[] = [];
    for (const r of runBatch(pairedJobs({ stocks: 2, frameCap: 7200, a: b.ref, b: b.ref, record: true }, pairTag(b.ref, b.ref, 'mirror'), n))) {
      ms.push(computeMetrics(r.result, 0), computeMetrics(r.result, 1));
    }
    const h = mean(col(ms, 'entropyMean')); const rep = mean(col(ms, 'repetition'));
    metrics[`${b.label}.entropy`] = h; metrics[`${b.label}.repetition`] = rep;
    rows.push(`${b.label} H ${f2(h)} rep ${f2(rep)}`);
  }
  return gate('ay', true, `no human baseline recorded (owner O2); CPU values: ${rows.join(', ')}`, metrics, true);
});

export const STYLE_CASES: readonly TestCase[] = [ax, ay];
