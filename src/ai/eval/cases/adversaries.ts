/**
 * Scripted adversary matrix (06 `az`, section 3): every brain against the twelve adversaries on
 * human slots, thresholds by skill (50% at L1, 70% at L2 and L3, 85% at top player, 90% at world's
 * best), 0 SDs from L3, "learns your pattern" beaten from top player up. The god plays each
 * adversary 30 times and must win all with 0 stocks lost. `az.spam` keeps the aitest `j` spammer.
 */
import type { AdversaryId, TestCase } from '../../contracts';
import { ADVERSARIES } from '../adversaries';
import { adv, pairedJobs, pairTag, runBatch, xadv } from '../pool';
import { byTier, defineCase, f2, gate, GOD_BRAIN, guidePointBrains, listed, tally, uiBrain, wl, type Brain } from './common';

/** 06 `az` threshold for a brain's skill scalar. */
export function azThreshold(b: Brain): number {
  if (b.s >= 1) return 0.90;
  if (b.s >= 0.75) return 0.85;
  if (b.s >= 0.25) return 0.70;
  return 0.50;
}

function azJobs(b: Brain, id: AdversaryId, n: number) {
  const opp = adv(id, `az-${id}`);
  return pairedJobs({ stocks: 2, frameCap: 7200, a: b.ref, b: opp }, pairTag(b.ref, opp, 'az'), n);
}

const az: TestCase = defineCase('az', ['fast', 'full', 'nightly'], ({ tier }) => {
  const brains = tier === 'fast' ? [uiBrain(5), uiBrain(9)] : guidePointBrains();
  const n = byTier(tier, { fast: 1, full: 10, nightly: 30 });
  const fails: string[] = [];
  const rows: string[] = [];
  const metrics: Record<string, number> = {};
  for (const b of brains) {
    const thr = azThreshold(b);
    let sum = 0; let cnt = 0; let sds = 0;
    const weak: string[] = [];
    for (const id of ADVERSARIES) {
      const t = tally(runBatch(azJobs(b, id, n)), 0);
      const rate = t.score / t.n;
      sum += t.score; cnt += t.n; sds += t.sds;
      metrics[`${b.label}.${id}`] = rate;
      if (rate < thr) weak.push(`${id} ${f2(rate)}`);
      if (id === 'learnsPattern' && b.s >= 0.75 && rate <= 0.5) fails.push(`${b.label} not beating learnsPattern (${f2(rate)})`);
    }
    if (weak.length > 0) fails.push(`${b.label} under ${thr}: ${weak.join(', ')}`);
    if (b.s >= 0.5 && sds > 0) fails.push(`${b.label} ${sds} SDs`);
    rows.push(`${b.label} ${f2(sum / cnt)} (need ${thr} each)${sds > 0 ? ` SD ${sds}` : ''}`);
  }
  const detail = `${brains.length} brains x ${ADVERSARIES.length} adversaries x ${n}: ${rows.join(', ')}` +
    ' | changesStyle recovery within 20 s needs predictor accuracy (info)' +
    `${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`;
  return gate('az', fails.length === 0, detail, metrics, tier === 'fast');
});

/** 06 `az` god clause: 30 of 30 with 0 stocks lost against each adversary (lower bound 88.6%). */
const azGod: TestCase = defineCase('az.god', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 1, full: 30, nightly: 30 });
  const fails: string[] = [];
  const rows: string[] = [];
  const metrics: Record<string, number> = {};
  for (const id of ADVERSARIES) {
    const t = tally(runBatch(azJobs(GOD_BRAIN, id, n)), 0);
    rows.push(`${id} ${wl(t.wins, t.n)}${t.stocksLost > 0 ? ` lost ${t.stocksLost}` : ''}`);
    metrics[`${id}.wins`] = t.wins; metrics[`${id}.stocksLost`] = t.stocksLost;
    if (t.wins < t.n || t.stocksLost > 0 || t.sds > 0) fails.push(`${id} won ${t.wins}/${t.n}, stocks lost ${t.stocksLost}, SD ${t.sds}`);
  }
  return gate('az.god', fails.length === 0, `god x ${n}: ${rows.join(', ')}${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`,
    metrics, tier === 'fast');
});

/** aitest `j`: the world's-best tier beats the projectile spammer on both sides. */
const azSpam: TestCase = defineCase('az.spam', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 6, nightly: 20 });
  const b = uiBrain(9);
  const opp = xadv('spammer', 'az-spammer');
  const t = tally(runBatch(pairedJobs({ stocks: 2, frameCap: 7200, a: b.ref, b: opp }, pairTag(b.ref, opp, 'az'), n)), 0);
  return gate('az.spam', t.wins === t.n, `${b.label} vs spammer ${wl(t.wins, t.n)} stocks lost ${t.stocksLost}`,
    { wins: t.wins, n: t.n }, tier === 'fast');
});

export const ADVERSARY_CASES: readonly TestCase[] = [az, azGod, azSpam];
