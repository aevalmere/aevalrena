/**
 * Strength gates for the god (06 `av`, 02 section 1): the god against every other CPU on both
 * stages, paired seeds with sides swapped. Nightly and the god tier play the guide's 73 matches per
 * opponent; full plays 20 and gates on 0 losses (Wilson reported); fast plays 2 against the level 5
 * and the middle level and only reports.
 */
import type { TestCase } from '../../contracts';
import { pairedJobs, pairTag, runBatch } from '../pool';
import { wilson } from '../stats';
import { byTier, defineCase, f2, gate, GOD_BRAIN, isLevel5, listed, nonGodBrains, tally, wl } from './common';

/** Minimum Wilson lower bound of the win rate against each level 5 (06 `av`). */
export const AV_L5_LB = 0.60;
/** Maximum stocks lost per match against the level 5s. */
export const AV_L5_STOCKS = 0.5;

const av: TestCase = defineCase('av', ['fast', 'full', 'nightly'], ({ tier }) => {
  const all = nonGodBrains();
  const opps = tier === 'fast' ? all.filter((b) => isLevel5(b) || b.label === 'UI5' || b.label === 'balanced L3') : all;
  const n = byTier(tier, { fast: 2, full: 20, nightly: 73 });
  const stocks = tier === 'nightly' ? 3 : 2;
  const frameCap = stocks * 3600;
  let losses = 0; let sds = 0; let games = 0; let wins = 0;
  const parts: string[] = [];
  const fails: string[] = [];
  const metrics: Record<string, number> = {};
  for (const o of opps) {
    const rs = runBatch(pairedJobs({ stocks, frameCap, a: GOD_BRAIN.ref, b: o.ref }, pairTag(GOD_BRAIN.ref, o.ref, `s${stocks}`), n));
    const t = tally(rs, 0);
    losses += t.losses; sds += t.sds; games += t.n; wins += t.wins;
    const lostPer = t.stocksLost / t.n;
    parts.push(`${o.label} ${wl(t.wins, t.n)} lost/match ${f2(lostPer)}${t.draws > 0 ? ` timeouts ${t.draws}` : ''}${t.sds > 0 ? ` SD ${t.sds}` : ''}`);
    metrics[`${o.label}.wins`] = t.wins;
    metrics[`${o.label}.lb`] = wilson(t.wins, t.n).lo;
    if (t.losses > 0) fails.push(`${o.label} lost ${t.losses}`);
    if (isLevel5(o)) {
      if (lostPer > AV_L5_STOCKS) fails.push(`${o.label} stocks lost/match ${f2(lostPer)} > ${AV_L5_STOCKS}`);
      if (wilson(t.wins, t.n).lo < AV_L5_LB) fails.push(`${o.label} lb ${f2(wilson(t.wins, t.n).lo)} < ${AV_L5_LB}`);
    }
  }
  if (sds > 0) fails.push(`${sds} SDs`);
  metrics.losses = losses; metrics.sds = sds; metrics.games = games; metrics.wins = wins;
  const detail = `god vs ${opps.length} CPUs x ${n} (${stocks} stocks): ${listed(parts, 20)}${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`;
  return gate('av', fails.length === 0, detail, metrics, tier === 'fast');
});

export const STRENGTH_CASES: readonly TestCase[] = [av];
