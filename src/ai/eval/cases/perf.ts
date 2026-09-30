/**
 * Cost per decision (06 `bb` cost clause, aitest `ai`/`ar`, plan R5). Matches run fresh (no memo),
 * unrecorded and unprobed, so the timing is the brain alone. The runner times every brain call;
 * mean and p99 skip the first call, which is reported on its own as the cold warm-up.
 *
 * The guide targets (god p99 4 ms, mean 0.15 ms, first call 2 ms; four players p99 8 ms per frame)
 * are printed as info: 06 section 6 wants them measured on the slowest target device (owner O3).
 * The gates are generous margins this development machine meets, to catch a regression.
 */
import type { TestCase } from '../../contracts';
import { GOD, runJob, seedFor, STAGES, ui, type JobSpec } from '../pool';
import { byTier, defineCase, f2, f3, gate, listed } from './common';

export const PERF_GOD_MEAN_MS = 1.0;
export const PERF_GOD_P99_MS = 12;
export const PERF_FIRST_MS = 1500;
export const PERF_HUMAN_MEAN_MS = 0.5;
/** Sum of the per-CPU p99s in a four-player match with three gods. */
export const PERF_4P_P99_MS = 36;
export const GUIDE = { godMean: 0.15, godP99: 4, first: 2, fourP99: 8 } as const;

const perf: TestCase = defineCase('perf', ['fast', 'full', 'nightly'], ({ tier }) => {
  const seeds = byTier(tier, { fast: 1, full: 2, nightly: 4 });
  const rows: string[] = [];
  const fails: string[] = [];
  const metrics: Record<string, number> = {};
  const probe = (label: string, j: JobSpec, meanCap: number, p99Cap: number): void => {
    let mean = 0; let p99 = 0; let first = 0; let calls = 0;
    const r = runJob(j, true).result;
    const c = r.cost[0];
    mean = c.mean; p99 = c.p99; first = c.first; calls = c.calls;
    rows.push(`${label} ${j.stageId}: mean ${f3(mean)} ms, p99 ${f2(p99)} ms, first ${f2(first)} ms, ${calls} calls`);
    metrics[`${label}.${j.stageId}.mean`] = mean; metrics[`${label}.${j.stageId}.p99`] = p99; metrics[`${label}.${j.stageId}.first`] = first;
    if (mean > meanCap) fails.push(`${label} mean ${f3(mean)} > ${meanCap}`);
    if (p99 > p99Cap) fails.push(`${label} p99 ${f2(p99)} > ${p99Cap}`);
    if (first > PERF_FIRST_MS) fails.push(`${label} first ${f2(first)} > ${PERF_FIRST_MS}`);
  };
  for (let k = 0; k < seeds; k++) {
    for (const stageId of STAGES) {
      // Many stocks so the match is still running when the frame cap ends it.
      probe('god', { seed: seedFor('perf', k), swap: false, stageId, stocks: 9, frameCap: 3600, a: GOD, b: ui(9) }, PERF_GOD_MEAN_MS, PERF_GOD_P99_MS);
      probe('UI7', { seed: seedFor('perf7', k), swap: false, stageId, stocks: 9, frameCap: 3600, a: ui(7), b: ui(7) }, PERF_HUMAN_MEAN_MS, PERF_GOD_P99_MS);
    }
  }
  const detail = `${rows.join('; ')} | guide on target device: god mean ${GUIDE.godMean}, p99 ${GUIDE.godP99}, first ${GUIDE.first} ms (info)` +
    `${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`;
  return gate('perf', fails.length === 0, detail, metrics);
});

const perf4p: TestCase = defineCase('perf.4p', ['fast', 'full', 'nightly'], () => {
  const rows: string[] = [];
  const metrics: Record<string, number> = {};
  let worst = 0;
  for (const stageId of STAGES) {
    const r = runJob({ seed: seedFor('perf4p', 0), swap: false, stageId, stocks: 9, frameCap: 2400, a: GOD, b: GOD,
      extras: [{ ref: GOD, team: 2 }, { ref: ui(5), team: 3 }] }, true).result;
    const sumP99 = r.cost.reduce((a, c) => a + c.p99, 0);
    const sumMean = r.cost.reduce((a, c) => a + c.mean, 0);
    worst = Math.max(worst, sumP99);
    metrics[`${stageId}.sumP99`] = sumP99; metrics[`${stageId}.sumMean`] = sumMean;
    rows.push(`${stageId}: per-frame mean ${f3(sumMean)} ms, sum of p99 ${f2(sumP99)} ms`);
  }
  return gate('perf.4p', worst <= PERF_4P_P99_MS,
    `3 gods + UI5 free-for-all: ${rows.join('; ')} (gate ${PERF_4P_P99_MS} ms; guide ${GUIDE.fourP99} ms per frame on target, info)`, metrics);
});

export const PERF_CASES: readonly TestCase[] = [perf, perf4p];
