/**
 * Property tests over random seeds (06 `bd`, 05 section 7). Each seed pairs a brain under test
 * (cycling through every brain) with an opponent (cycling through CPU levels and adversaries) on
 * alternating stages; a read-only probe checks, for the brain under test (player 0):
 * - never a Taunt press;
 * - never a fresh grounded Shield press while an enemy's move is 0 or 1 frames old;
 * - never a roll that ends off the stage without being hit;
 * - never a Shield or Dodge press in a launch beyond the first (the planned tech);
 * - never an Attack, Special or Grab press in hitstun;
 * - no SD from top player up (the proxy for "no edgeguard whose own canGetBack fails");
 * - the god never starts more than five specials offstage in a row.
 */
import type { TestCase } from '../../contracts';
import { adv, engineMode, runBatch, seedFor, STAGES, ui, type BrainRef, type JobSpec } from '../pool';
import { byTier, defineCase, gate, GOD_BRAIN, listed, nonGodBrains, type Brain } from './common';

export const BD_MAX_OFFSTAGE_SPECIALS = 5;
export const BD_SD_FROM_S = 0.75;

const OPPONENTS: readonly BrainRef[] = [
  ui(1), ui(3), ui(5), ui(7), ui(9), adv('rushdown', 'bd-rush'), adv('jumper', 'bd-jump'), adv('turtle', 'bd-turtle'),
  adv('camper', 'bd-camp'), adv('roller', 'bd-roll'), adv('ledgeCamper', 'bd-ledge'),
];

const bd: TestCase = defineCase('bd', ['fast', 'full', 'nightly'], ({ tier }) => {
  const seeds = byTier(tier, { fast: 50, full: 200, nightly: 200 });
  const frameCap = byTier(tier, { fast: 1800, full: 3600, nightly: 7200 });
  const brains: Brain[] = [...nonGodBrains(), GOD_BRAIN];
  const jobs: JobSpec[] = [];
  const who: Brain[] = [];
  for (let i = 0; i < seeds; i++) {
    const b = brains[i % brains.length];
    const o = OPPONENTS[(i * 7 + (i / brains.length | 0)) % OPPONENTS.length];
    who.push(b);
    jobs.push({ seed: seedFor('bd', i), swap: (i & 1) === 1, stageId: STAGES[(i >> 1) % 2], stocks: 2, frameCap, a: b.ref, b: o, probe: 'basic' });
  }
  const rs = runBatch(jobs);
  const count: Record<string, number> = { taunt: 0, earlyShield: 0, rollOff: 0, launchDefense: 0, attackInHitstun: 0, sd: 0, offstageSpecials: 0 };
  const where: string[] = [];
  let frames = 0;
  const hit = (k: string, b: Brain, n: number, seed: number): void => {
    if (n <= 0) return;
    count[k] += n;
    where.push(`${k} x${n} ${b.label} seed ${seed}`);
  };
  for (let i = 0; i < rs.length; i++) {
    const p = rs[i].probe;
    const b = who[i];
    frames += rs[i].result.frames;
    if (p === null) continue;
    hit('taunt', b, p.taunts[0], jobs[i].seed);
    hit('earlyShield', b, p.earlyShields[0], jobs[i].seed);
    hit('rollOff', b, p.rollsOff[0], jobs[i].seed);
    hit('launchDefense', b, p.defInLaunch[0], jobs[i].seed);
    hit('attackInHitstun', b, p.attackInHitstun[0], jobs[i].seed);
    if (b.god || b.s >= BD_SD_FROM_S) hit('sd', b, rs[i].result.sds[0], jobs[i].seed);
    if (b.god && p.maxOffstageSpecials[0] > BD_MAX_OFFSTAGE_SPECIALS) hit('offstageSpecials', b, p.maxOffstageSpecials[0], jobs[i].seed);
  }
  const total = Object.values(count).reduce((a, x) => a + x, 0);
  const summary = Object.entries(count).map(([k, v]) => `${k} ${v}`).join(', ');
  const note = engineMode() === 'legacy' ? ' (legacy archetypes collapse onto UI levels)' : '';
  return gate('bd', total === 0, `${seeds} seeds, ${frames} frames${note}: ${summary}${total > 0 ? ` | ${listed(where, 6)}` : ''}`, count);
});

export const PROPERTY_CASES: readonly TestCase[] = [bd];
