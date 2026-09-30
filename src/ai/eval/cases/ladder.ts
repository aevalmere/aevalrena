/**
 * Monotonicity and calibration (06 `at`, `au`; 03 section 5): adjacent levels by SPRT, the UI
 * ladder 1 to 10 by a Bradley-Terry fit, and equal-level archetype pairs inside their band.
 */
import type { GuideLevel, TestCase } from '../../contracts';
import { engineMode, pairedJobs, pairTag, resolvedName, runJob, runBatch, type JobSpec } from '../pool';
import { bradleyTerry, eloFromP, sprt, wilson } from '../stats';
import { scoreOf } from '../runner';
import {
  ARCHETYPES, byTier, defineCase, f1, f2, gate, guideSpec, listed, specBrain, uiBrain, uniqueBy, wl, type Brain,
} from './common';

const SPRT_P0 = 0.5;
const SPRT_P1 = 0.65;
/** Alternative pass for `at`: Wilson lower bound at the cap. */
export const AT_LB = 0.55;
/** Adjacent Elo gap target (03 section 5), reported: calibration (W3.5) owns it. */
export const AT_ELO = 200;
export const AT_ELO_TOL = 30;

/** Adjacent pairs (higher, lower): per archetype with the new engine, the guide points of the UI ladder with legacy. */
function ladderPairs(): [Brain, Brain][] {
  if (engineMode() === 'legacy') {
    const pts = [1, 3, 5, 7, 9, 10].map(uiBrain);
    const out: [Brain, Brain][] = [];
    for (let i = 1; i < pts.length; i++) out.push([pts[i], pts[i - 1]]);
    return out;
  }
  const out: [Brain, Brain][] = [];
  for (const a of ARCHETYPES) {
    for (let l = 1; l < 5; l++) {
      out.push([specBrain(guideSpec(a, (l + 1) as GuideLevel)), specBrain(guideSpec(a, l as GuideLevel))]);
    }
  }
  return out;
}

const at: TestCase = defineCase('at', ['fast', 'full', 'nightly'], ({ tier }) => {
  const all = ladderPairs();
  // Fast: two adjacent balanced pairs (L2 over L1, L3 over L2).
  const pairs = tier === 'fast'
    ? all.filter(([hi]) => hi.label === 'UI3' || hi.label === 'UI5' || hi.label === 'balanced L2' || hi.label === 'balanced L3')
    : all;
  // Fast caps at 24 to keep the fast tier under four minutes (it is info there).
  const cap = byTier(tier, { fast: 24, full: 200, nightly: 400 });
  const parts: string[] = [];
  const fails: string[] = [];
  const metrics: Record<string, number> = {};
  for (const [hi, lo] of pairs) {
    const jobs = pairedJobs({ stocks: 2, frameCap: 7200, a: hi.ref, b: lo.ref }, pairTag(hi.ref, lo.ref, 'ladder'), cap);
    const test = sprt(SPRT_P0, SPRT_P1, 0.05, 0.05);
    let score = 0; let n = 0; let decision = 'continue';
    for (const j of jobs) {
      const s = scoreOf(runJob(j).result, 0);
      score += s; n++;
      decision = test.add(s).decision;
      if (decision !== 'continue') break;
    }
    const p = n > 0 ? score / n : 0;
    const lb = wilson(score, n).lo;
    const elo = eloFromP(p);
    const ok = decision === 'H1' || lb >= AT_LB;
    parts.push(`${hi.label}>${lo.label} ${wl(score, n)} SPRT ${decision} Elo ${f1(elo)}`);
    metrics[`${hi.label}>${lo.label}.p`] = p;
    metrics[`${hi.label}>${lo.label}.elo`] = elo;
    if (!ok) fails.push(`${hi.label}>${lo.label} ${decision}, lb ${f2(lb)}`);
  }
  const detail = `${listed(parts, 20)} | Elo target ${AT_ELO}+-${AT_ELO_TOL} is calibration info${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`;
  return gate('at', fails.length === 0, detail, metrics, tier === 'fast');
});

/** UI levels 1 to 10: adjacent and skip-one pairs, Bradley-Terry, strictly increasing Elo. */
const mono: TestCase = defineCase('mono', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 10, nightly: 40 });
  const levels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const games: { a: string; b: string; scoreA: number }[] = [];
  const pairRates: string[] = [];
  const fails: string[] = [];
  const metrics: Record<string, number> = {};
  const gaps = tier === 'fast' ? [1] : [1, 2];
  for (const gap of gaps) {
    for (let i = gap; i < levels.length; i++) {
      const hi = uiBrain(levels[i]); const lo = uiBrain(levels[i - gap]);
      const rs = runBatch(pairedJobs({ stocks: 2, frameCap: 7200, a: hi.ref, b: lo.ref }, pairTag(hi.ref, lo.ref, 'ladder'), n));
      let s = 0;
      for (const r of rs) { const sc = scoreOf(r.result, 0); s += sc; games.push({ a: hi.label, b: lo.label, scoreA: sc }); }
      if (gap === 1) {
        pairRates.push(`${hi.label}>${lo.label} ${f2(s / rs.length)}`);
        if (s / rs.length < 0.5) fails.push(`${hi.label} scored ${f2(s / rs.length)} vs ${lo.label}`);
      }
    }
  }
  const bt = bradleyTerry(games);
  const elos = levels.map((l) => bt.get(uiBrain(l).label)?.elo ?? NaN);
  for (let i = 0; i < elos.length; i++) metrics[`elo.${uiBrain(levels[i]).label}`] = elos[i];
  for (let i = 1; i < elos.length; i++) {
    if (!(elos[i] > elos[i - 1])) fails.push(`Elo ${uiBrain(levels[i]).label} ${f1(elos[i])} <= ${uiBrain(levels[i - 1]).label} ${f1(elos[i - 1])}`);
  }
  const detail = `${n} per pair, gaps ${gaps.join('+')}: Elo ${elos.map((e, i) => `${uiBrain(levels[i]).label} ${f1(e)}`).join(', ')} | ${pairRates.join(', ')}` +
    `${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`;
  return gate('mono', fails.length === 0, detail, metrics, tier === 'fast');
});

/** 06 `au`: equal level across archetypes, 6 pairs x levels 1 to 5 (balanced 4 stands in for 5). */
const au: TestCase = defineCase('au', ['full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 0, full: 40, nightly: 100 });
  const cells: { lvl: number; a: Brain; b: Brain }[] = [];
  for (let l = 1; l <= 5; l++) {
    for (let i = 0; i < ARCHETYPES.length; i++) for (let j = i + 1; j < ARCHETYPES.length; j++) {
      const lvA = (ARCHETYPES[i] === 'balanced' && l === 5 ? 4 : l) as GuideLevel;
      const lvB = (ARCHETYPES[j] === 'balanced' && l === 5 ? 4 : l) as GuideLevel;
      cells.push({ lvl: l, a: specBrain(guideSpec(ARCHETYPES[i], lvA)), b: specBrain(guideSpec(ARCHETYPES[j], lvB)) });
    }
  }
  const legacy = engineMode() === 'legacy';
  const run = uniqueBy(cells, (c) => `${resolvedName(c.a.ref)}|${resolvedName(c.b.ref)}`);
  const parts: string[] = [];
  const fails: string[] = [];
  const metrics: Record<string, number> = {};
  for (const c of run) {
    const jobs: JobSpec[] = pairedJobs({ stocks: 2, frameCap: 7200, a: c.a.ref, b: c.b.ref }, pairTag(c.a.ref, c.b.ref, 'au'), n);
    const rs = runBatch(jobs);
    let s = 0;
    for (const r of rs) s += scoreOf(r.result, 0);
    const p = s / rs.length;
    const band: [number, number] = c.lvl <= 2 ? [0.40, 0.60] : [0.35, 0.65];
    const name = legacy ? `L${c.lvl} mirror (${resolvedName(c.a.ref)})` : `${c.a.label} v ${c.b.label}`;
    parts.push(`${name} ${f2(p)}`);
    metrics[name] = p;
    if (p < band[0] || p > band[1]) fails.push(`${name} ${f2(p)} outside ${band[0]}..${band[1]}`);
  }
  const note = legacy ? 'legacy has one style, so every cell is a mirror; ' : '';
  return gate('au', fails.length === 0, `${note}${n} per cell: ${listed(parts, 30)}${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`,
    metrics, legacy);
});

export const LADDER_CASES: readonly TestCase[] = [at, mono, au];
