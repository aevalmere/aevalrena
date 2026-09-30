/**
 * Determinism (06 `bb`, `bh`; aitest `n`, `ah`, `as`).
 *
 * `bb`: every match runs twice, the second time recorded and probed, and must give the same final
 * hash, the same per-player input-stream hashes and the same length (so recording and probing do
 * not perturb a match). `bb.order`: a batch run forward and then in reverse gives identical
 * results, which is what makes results independent of the shard count. `bh`: input delay 1 to 4
 * reproduces, and neither player rolls without asking (the tap mirror); the full tier also runs
 * `npm run test:net` for the relay-log hash.
 */
import type { TestCase } from '../../contracts';
import { computeMetrics } from '../metrics';
import {
  adv, GOD, nodeApi, repoRoot, runJob, seedFor, STAGES, ui, type JobResult, type JobSpec,
} from '../pool';
import { byTier, defineCase, gate, guidePointBrains, listed, nonGodBrains, uiBrain, type Brain } from './common';

function same(a: JobResult, b: JobResult): boolean {
  const x = a.result; const y = b.result;
  if (x.finalHash !== y.finalHash || x.frames !== y.frames || x.winner !== y.winner) return false;
  if (x.inputHash.length !== y.inputHash.length) return false;
  for (let i = 0; i < x.inputHash.length; i++) if (x.inputHash[i] !== y.inputHash[i]) return false;
  return true;
}

const bb: TestCase = defineCase('bb', ['fast', 'full', 'nightly'], ({ tier }) => {
  const brains: Brain[] = tier === 'fast' ? [uiBrain(3), uiBrain(7), uiBrain(10)] : [...nonGodBrains(), uiBrain(10)];
  const seeds = byTier(tier, { fast: 1, full: 3, nightly: 3 });
  const jobs: JobSpec[] = [];
  for (const b of brains) {
    for (let k = 0; k < seeds; k++) {
      for (const stageId of STAGES) {
        jobs.push({ seed: seedFor(`bb|${b.label}`, k), swap: k % 2 === 1, stageId, stocks: 2, frameCap: 3600, a: b.ref, b: ui(5) });
      }
    }
  }
  // Human-slot opponents with a profile store (aitest `as`): the god against a named adversary.
  jobs.push({ seed: seedFor('bb|as', 0), swap: false, stageId: 'tidegate', stocks: 2, frameCap: 3600, a: GOD, b: adv('learnsPattern', 'bb-human') });
  const bad: string[] = [];
  let frames = 0;
  for (const j of jobs) {
    const r1 = runJob(j, true);
    const r2 = runJob({ ...j, record: true, probe: 'basic' }, true);
    frames += r1.result.frames;
    if (!same(r1, r2)) bad.push(`${JSON.stringify(j.a)} seed ${j.seed} ${j.stageId}: ${r1.result.finalHash}/${r2.result.finalHash}`);
  }
  return gate('bb', bad.length === 0,
    `${jobs.length} matches run twice (plain, then recorded and probed), ${frames} frames: ${bad.length === 0 ? 'all identical' : `DIFF ${listed(bad, 4)}`}`,
    { matches: jobs.length, diffs: bad.length });
});

const bbOrder: TestCase = defineCase('bb.order', ['fast', 'full', 'nightly'], () => {
  const jobs: JobSpec[] = [
    { seed: seedFor('order', 0), swap: false, stageId: 'tidegate', stocks: 2, frameCap: 2400, a: GOD, b: adv('learnsPattern', 'order-a') },
    { seed: seedFor('order', 1), swap: true, stageId: 'hearthmoor', stocks: 2, frameCap: 2400, a: ui(5), b: ui(3) },
    { seed: seedFor('order', 2), swap: false, stageId: 'tidegate', stocks: 2, frameCap: 2400, a: GOD, b: ui(9) },
    { seed: seedFor('order', 3), swap: true, stageId: 'hearthmoor', stocks: 2, frameCap: 2400, a: ui(7), b: adv('turtle', 'order-b') },
    { seed: seedFor('order', 4), swap: false, stageId: 'tidegate', stocks: 2, frameCap: 2400, a: ui(9), b: ui(9),
      extras: [{ ref: ui(4), team: 0 }, { ref: ui(4), team: 1 }] },
  ];
  const fwd = jobs.map((j) => runJob(j, true));
  const rev = jobs.slice().reverse().map((j) => runJob(j, true)).reverse();
  const bad: string[] = [];
  for (let i = 0; i < jobs.length; i++) if (!same(fwd[i], rev[i])) bad.push(`job ${i}: ${fwd[i].result.finalHash} vs ${rev[i].result.finalHash}`);
  return gate('bb.order', bad.length === 0, `${jobs.length} jobs forward and reversed: ${bad.length === 0 ? 'identical' : listed(bad)}`,
    { diffs: bad.length });
});

const bh: TestCase = defineCase('bh', ['fast', 'full', 'nightly'], ({ tier }) => {
  const b = guidePointBrains().find((x) => x.s >= 1) ?? uiBrain(9);
  const bad: string[] = [];
  let rolls = 0;
  const seeds = byTier(tier, { fast: 1, full: 2, nightly: 4 });
  for (let d = 1; d <= 4; d++) {
    for (let k = 0; k < seeds; k++) {
      const j: JobSpec = { seed: seedFor(`bh|${d}`, k), swap: k % 2 === 1, stageId: STAGES[k % 2], stocks: 2, frameCap: 2400,
        a: b.ref, b: b.ref, inputDelay: d };
      const r1 = runJob(j, true);
      const r2 = runJob({ ...j, record: true }, true);
      if (!same(r1, r2)) bad.push(`delay ${d} seed ${j.seed} differs`);
      rolls += (computeMetrics(r2.result, 0).accidentalRolls ?? 0) + (computeMetrics(r2.result, 1).accidentalRolls ?? 0);
    }
  }
  let net = 'test:net runs in the full tier';
  let netOk = true;
  const api = nodeApi();
  if (tier !== 'fast') {
    if (api === null) { net = 'test:net skipped (node API not loaded)'; }
    else {
      const res = api.spawnSync('npm run test:net', [], { cwd: repoRoot(api), shell: true, encoding: 'utf8', windowsHide: true });
      netOk = res.status === 0;
      net = `npm run test:net exit ${res.status}`;
    }
  }
  const pass = bad.length === 0 && rolls === 0 && netOk;
  return gate('bh', pass, `${b.label} mirror, input delay 1..4 x ${seeds}: ${bad.length === 0 ? 'reproducible' : listed(bad)}; accidental rolls ${rolls}; ${net}`,
    { diffs: bad.length, accidentalRolls: rolls, net: netOk ? 1 : 0 });
});

export const DETERMINISM_CASES: readonly TestCase[] = [bb, bbOrder, bh];
