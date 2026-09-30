/**
 * Killing passive targets (06 `ba`, `bf`; aitest `al`; 02 section 13).
 *
 * `ba`: against the stationary dummy, 3 stocks: the god's median 3-stock time at or under 1,200
 * frames with the respawn lever set (RESPAWN_PLATFORM_FRAMES 100, plan decision 1; 1,800 without)
 * and median first KO by frame 400; full and nightly also require the median 3-stock time to fall
 * with level (censored runs count as the frame cap).
 *
 * `bf`: the passive-kill routine against the stationary, shield-only and jump-only dummies. The
 * first passive window is the first frame the dummy is alive, not invulnerable and inside 1.2 x the
 * brain's ground reach (80 px vertically); the routine must land its first engagement (damage or a
 * grab) within 120 frames of it, in every life of the dummy, and never go more than BF_STALL frames
 * between engagements while the dummy is attackable (the engagement-clock proxy).
 *
 * `al`: aitest's kill speed: standing dummy first KO by 1,200 and 3 stocks by 3,600; wandering dummy
 * first KO by 1,800.
 */
import type { AdversaryId, TestCase } from '../../contracts';
import { adv, engineMode, pairedJobs, pairTag, runBatch, STAGES, TF, type JobResult } from '../pool';
import {
  byTier, defineCase, f1, gate, GOD_BRAIN, groundReach, guidePointBrains, killTimeTarget, listed, med, type Brain,
} from './common';

export const BA_FIRST_KO = 400;
export const BF_WINDOW = 120;
export const BF_STALL = 240;
const KILL_CAP = 7200;

function killJobs(b: Brain, id: AdversaryId, n: number) {
  const opp = adv(id, `kill-${id}`);
  return pairedJobs({ stocks: 3, frameCap: KILL_CAP, a: b.ref, b: opp, probe: 'basic' }, pairTag(b.ref, opp, 'kill'), n);
}

/** KO frames of the dummy (player 1) and the censored 3-stock time. */
function koTimes(rs: readonly JobResult[]): { first: number[]; three: number[] } {
  const first: number[] = []; const three: number[] = [];
  for (const r of rs) {
    const ko = r.probe !== null ? r.probe.koFrames[1] : [];
    first.push(ko.length > 0 ? ko[0] : KILL_CAP);
    three.push(ko.length >= 3 ? ko[2] : KILL_CAP);
  }
  return { first, three };
}

const ba: TestCase = defineCase('ba', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 10, nightly: 10 });
  const target = killTimeTarget();
  const fails: string[] = [];
  const metrics: Record<string, number> = {};
  const god = koTimes(runBatch(killJobs(GOD_BRAIN, 'stationary', n)));
  const gm3 = med(god.three); const gm1 = med(god.first);
  metrics.godMedian3 = gm3; metrics.godMedianFirst = gm1;
  if (gm3 > target) fails.push(`god median 3-stock ${f1(gm3)} > ${target}`);
  if (gm1 > BA_FIRST_KO) fails.push(`god median first KO ${f1(gm1)} > ${BA_FIRST_KO}`);
  let ladder = '';
  if (tier !== 'fast') {
    // Order within each archetype (legacy: the UI ladder), god last on the balanced line.
    const brains = guidePointBrains();
    const lines = new Map<string, { b: Brain; m: number }[]>();
    for (const b of brains) {
      const key = engineMode() === 'legacy' ? 'ui' : b.label.split(' ')[0];
      const m = med(koTimes(runBatch(killJobs(b, 'stationary', n))).three);
      metrics[`${b.label}.median3`] = m;
      if (!lines.has(key)) lines.set(key, []);
      (lines.get(key) as { b: Brain; m: number }[]).push({ b, m });
    }
    const balKey = engineMode() === 'legacy' ? 'ui' : 'balanced';
    if (!lines.has(balKey)) lines.set(balKey, []);
    (lines.get(balKey) as { b: Brain; m: number }[]).push({ b: GOD_BRAIN, m: gm3 });
    const parts: string[] = [];
    for (const [key, xs] of lines) {
      xs.sort((a, b) => a.b.s - b.b.s || Number(a.b.god) - Number(b.b.god));
      parts.push(`${key}: ${xs.map((x) => `${x.b.label} ${f1(x.m)}`).join(' > ')}`);
      for (let i = 1; i < xs.length; i++) {
        if (xs[i].m > xs[i - 1].m && xs[i - 1].m < KILL_CAP) fails.push(`${xs[i].b.label} ${f1(xs[i].m)} slower than ${xs[i - 1].b.label} ${f1(xs[i - 1].m)}`);
      }
    }
    ladder = ` | median 3-stock by level: ${parts.join('; ')}`;
  }
  const detail = `god vs stationary x ${n}: median 3-stock ${f1(gm3)} (target ${target}), median first KO ${f1(gm1)} (target ${BA_FIRST_KO}); ` +
    `3-stock ${god.three.join('/')}${ladder}${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`;
  return gate('ba', fails.length === 0, detail, metrics);
});

interface Routine { latency: number[]; stall: number }

/** First-engagement latency per life of the dummy and the longest gap between engagements. */
function routineOf(r: JobResult, reach: number): Routine {
  const out: Routine = { latency: [], stall: 0 };
  const p = r.probe;
  if (p === null || p.track === null) return out;
  const t = p.track;
  const n = p.players;
  const hurt = p.hurtFrames[1];
  let hi = 0;
  let life = false;
  let window = -1;
  let last = -1;
  for (let f = 0; f < t.frames; f++) {
    const k0 = f * n; const k1 = f * n + 1;
    const dead = (t.flags[k1] & TF.dead) !== 0 || (t.flags[k0] & TF.dead) !== 0;
    if (dead) {
      if (life && window >= 0 && last < 0) out.latency.push(f - window);
      life = false; window = -1; last = -1;
      continue;
    }
    life = true;
    const open = t.inv[k1] === 0 && Math.abs(t.x[k1] - t.x[k0]) <= reach && Math.abs(t.y[k1] - t.y[k0]) <= 80;
    if (window < 0 && open) window = f;
    while (hi < hurt.length && hurt[hi] < f) hi++;
    const engaged = hi < hurt.length && hurt[hi] === f;
    if (engaged && window >= 0) {
      if (last < 0) out.latency.push(f - window);
      const gap = f - (last < 0 ? window : last);
      if (gap > out.stall) out.stall = gap;
      last = f;
    }
  }
  if (life && window >= 0 && last < 0) out.latency.push(t.frames - window);
  return out;
}

const bf: TestCase = defineCase('bf', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 1, full: 4, nightly: 10 });
  const reach = 1.2 * groundReach();
  const dummies: AdversaryId[] = ['stationary', 'shieldOnly', 'jumpOnly'];
  const rows: string[] = [];
  const fails: string[] = [];
  const metrics: Record<string, number> = {};
  for (const id of dummies) {
    const opp = adv(id, `bf-${id}`);
    const rs = runBatch(pairedJobs({ stocks: 3, frameCap: 3600, a: GOD_BRAIN.ref, b: opp, probe: 'track' }, pairTag(GOD_BRAIN.ref, opp, 'bf'), n, STAGES));
    let worst = 0; let stall = 0; let lives = 0;
    for (const r of rs) {
      const ro = routineOf(r, reach);
      lives += ro.latency.length;
      for (const l of ro.latency) worst = Math.max(worst, l);
      stall = Math.max(stall, ro.stall);
    }
    metrics[`${id}.worstLatency`] = worst; metrics[`${id}.stall`] = stall;
    rows.push(`${id}: worst first-engagement ${worst}f over ${lives} lives, longest gap ${stall}f`);
    if (worst > BF_WINDOW) fails.push(`${id} first engagement ${worst}f > ${BF_WINDOW}`);
    if (stall > BF_STALL) fails.push(`${id} gap ${stall}f > ${BF_STALL}`);
  }
  return gate('bf', fails.length === 0, `god x ${n}: ${rows.join('; ')}${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`, metrics);
});

export const AL_FIRST = 1200;
export const AL_ALL = 3600;
export const AL_WANDER = 1800;

const al: TestCase = defineCase('al', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 6, nightly: 10 });
  const fails: string[] = [];
  const stand = koTimes(runBatch(killJobs(GOD_BRAIN, 'stationary', n)));
  const wander = koTimes(runBatch(killJobs(GOD_BRAIN, 'wandering', n)));
  for (let i = 0; i < n; i++) {
    if (stand.first[i] > AL_FIRST) fails.push(`standing #${i} first KO ${stand.first[i]}`);
    if (stand.three[i] > AL_ALL) fails.push(`standing #${i} 3 stocks ${stand.three[i]}`);
    if (wander.first[i] > AL_WANDER) fails.push(`wandering #${i} first KO ${wander.first[i]}`);
  }
  return gate('al', fails.length === 0,
    `god x ${n}: standing first ${stand.first.join('/')} all ${stand.three.join('/')}; wandering first ${wander.first.join('/')}` +
    `${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`,
    { standMedianFirst: med(stand.first), wanderMedianFirst: med(wander.first) });
});

export const KILL_CASES: readonly TestCase[] = [ba, bf, al];
