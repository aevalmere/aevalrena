/**
 * Trekmore CPU cases (docs/TREKMORE_PLAN.md F W3b). The character plan pack lives in
 * src/ai/characters/trekmore.ts; these cases play it through the harness.
 *
 * - trek.mirror       god Trekmore mirror: the same match twice gives the same final hash and input
 *                     streams, no throw; per-special use is reported.
 * - trek.vs.aeval.l5, trek.vs.aeval.l7, trek.vs.aeval.l10
 *                     Trekmore against Aeval at the same UI level: win rate with its Wilson 95%
 *                     interval. Informational at the fast tier; the full and nightly tiers gate the
 *                     win rate inside 40 to 60 percent.
 * - trek.1v3.l4       god Trekmore alone against three teamed UI 4 Aevals (informational).
 * - trek.ko.share     Trekmore UI 7 against Aeval UI 7: no single Trekmore move takes more than 40%
 *                     of his KOs (the last hit's `source`, echo and projectile hits folded into
 *                     their move; informational).
 */
import type { GameState, InputFrame } from '../../../core/types';
import type { BrainFactory, MatchResult, TestCase, Tier } from '../../contracts';
import { specForUiLevel } from '../../levels';
import { wilson } from '../stats';
import { hintFactory, newBrain, runMatch } from '../runner';
import { GOD, pairedJobs, pairTag, runBatch, runJob, seedFor, STAGES, teamsOf, ui, type JobSpec } from '../pool';
import { byTier, defineCase, f2, f3, gate, listed, tally, teamOutcome, wl } from './common';

const TREK = 'trekmore';
const AEVAL = 'aeval';
/** Win-rate band the full tier gates Trekmore against Aeval on. */
export const TREK_WIN_LO = 0.40;
export const TREK_WIN_HI = 0.60;
/** Most of Trekmore's KOs one move may take. */
export const TREK_KO_SHARE_MAX = 0.40;

function stocksFor(tier: Tier): number { return tier === 'fast' ? 2 : 3; }

// ---- trek.mirror ------------------------------------------------------------------------------------

function sameResult(a: MatchResult, b: MatchResult): boolean {
  if (a.finalHash !== b.finalHash || a.frames !== b.frames) return false;
  for (let i = 0; i < a.inputHash.length; i++) if (a.inputHash[i] !== b.inputHash[i]) return false;
  return true;
}

const SPECIALS = ['nspecial', 'sspecial', 'uspecial', 'dspecial'];

const mirror: TestCase = defineCase('trek.mirror', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 1, full: 2, nightly: 3 });
  const fails: string[] = [];
  const rows: string[] = [];
  const used = new Map<string, number>();
  let same = 0;
  for (let k = 0; k < n; k++) {
    const job: JobSpec = { seed: seedFor('trek.mirror', k), swap: false, stageId: STAGES[k % STAGES.length], stocks: 2,
      frameCap: 5400, a: GOD, b: GOD, chars: [TREK, TREK], record: true };
    const r1 = runJob(job, true).result;
    const r2 = runJob(job, true).result;
    if (sameResult(r1, r2)) same++;
    else fails.push(`seed ${job.seed}: ${r1.finalHash} vs ${r2.finalHash}`);
    for (const e of r1.events ?? []) {
      if (e.kind !== 'action' || e.data.a !== 'attack') continue;
      const m = String(e.data.m);
      if (SPECIALS.includes(m)) used.set(m, (used.get(m) ?? 0) + 1);
    }
    rows.push(`${r1.frames} frames, winner ${r1.winner}, stocks lost ${r1.stocksLost.join('/')}`);
  }
  const usage = SPECIALS.map((m) => `${m} ${used.get(m) ?? 0}`).join(', ');
  return gate('trek.mirror', fails.length === 0,
    `god Trekmore mirror x ${n}: ${same}/${n} identical reruns; ${rows.join('; ')}; special starts ${usage}` +
    `${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`, { same, n });
});

// ---- trek.vs.aeval.lN ---------------------------------------------------------------------------------

function vsAeval(level: number): TestCase {
  const id = `trek.vs.aeval.l${level}`;
  return defineCase(id, ['fast', 'full', 'nightly'], ({ tier }) => {
    const n = byTier(tier, { fast: 4, full: 20, nightly: 40 });
    const stocks = stocksFor(tier);
    const jobs = pairedJobs({ stocks, frameCap: 5400 * stocks, a: ui(level), b: ui(level), chars: [TREK, AEVAL] },
      pairTag(ui(level), ui(level), `trek|s${stocks}`), n);
    const t = tally(runBatch(jobs), 0);
    const w = wilson(t.score, t.n);
    const inBand = w.p >= TREK_WIN_LO && w.p <= TREK_WIN_HI;
    const detail = `Trekmore UI${level} vs Aeval UI${level}, ${stocks} stocks: won ${t.wins}, lost ${t.losses}, draws ${t.draws} of ${t.n}` +
      ` (score ${f2(w.p)}, Wilson ${f3(w.lo)} to ${f3(w.hi)}; gate ${TREK_WIN_LO} to ${TREK_WIN_HI} at full), Trekmore SDs ${t.sds}`;
    return gate(id, inBand, detail, { wins: t.wins, losses: t.losses, n: t.n, p: w.p, lo: w.lo, hi: w.hi }, tier === 'fast');
  });
}

// ---- trek.1v3.l4 --------------------------------------------------------------------------------------

const oneVsThree: TestCase = defineCase('trek.1v3.l4', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 10, nightly: 30 });
  const stocks = 2;
  const foe = ui(4);
  const jobs = pairedJobs({ stocks, frameCap: 5400 * stocks, a: GOD, b: foe, extras: [{ ref: foe, team: 1 }, { ref: foe, team: 1 }],
    chars: [TREK, AEVAL, AEVAL, AEVAL] }, pairTag(GOD, foe, `trek1v3|s${stocks}`), n);
  let wins = 0; let losses = 0; let draws = 0;
  for (const r of runBatch(jobs)) {
    const w = teamOutcome(r.result, teamsOf(r.job), stocks);
    if (w < 0) draws++; else if (w === 0) wins++; else losses++;
  }
  return gate('trek.1v3.l4', true, `god Trekmore vs three teamed UI4 Aevals, ${stocks} stocks: won ${wl(wins, n)}, lost ${losses}, ` +
    `timeouts ${draws} (report only)`, { wins, losses, draws, n }, true);
});

// ---- trek.ko.share -----------------------------------------------------------------------------------

/** Folds a hit source into the move it belongs to: echo hits and the sword's projectiles. */
function moveOfSource(src: string | undefined): string {
  if (src === undefined || src === '') return 'unknown';
  if (src.startsWith('echo:')) return src.slice(5);
  if (src === 'shadowSword' || src === 'shadowBurst') return 'nspecial';
  return src;
}

/**
 * Wraps player a's brain: each call sees the state whose events are the last step's, keeps the last
 * hit source Trekmore landed on each victim, and credits it when that victim is KO'd.
 */
function koTracker(inner: BrainFactory, kos: Map<string, number>): BrainFactory {
  return {
    name: inner.name, spec: inner.spec,
    create() {
      const f = inner.create();
      const last = new Map<number, string>();
      return (s: GameState, slot: number, out: InputFrame): InputFrame => {
        for (const e of s.events) {
          if (e.type === 'hit' && e.attacker === slot && e.victim !== slot) last.set(e.victim, moveOfSource(e.source));
          if (e.type === 'ko' && e.slot !== slot) {
            const m = last.get(e.slot);
            if (m !== undefined) kos.set(m, (kos.get(m) ?? 0) + 1);
            last.delete(e.slot);
          }
        }
        return f(s, slot, out);
      };
    },
    reset() { inner.reset(); },
  };
}

const koShare: TestCase = defineCase('trek.ko.share', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 10, nightly: 20 });
  const l7 = specForUiLevel(7);
  const kos = new Map<string, number>();
  let wins = 0;
  for (let k = 0; k < n; k++) {
    const a = hintFactory(koTracker(newBrain(l7), kos), { cpu: true, cpuLevel: 7, charId: TREK });
    const b = hintFactory(newBrain(l7), { cpu: true, cpuLevel: 7, charId: AEVAL });
    const r = runMatch({ seed: seedFor('trek.ko.share', k), stageId: STAGES[k % STAGES.length], stocks: 3, frameCap: 16200,
      a, b, swap: false, record: false });
    if (r.winner === 0) wins++;
  }
  let total = 0;
  for (const v of kos.values()) total += v;
  const rows = [...kos.entries()].sort((x, y) => y[1] - x[1]).map(([m, c]) => `${m} ${c}`);
  const top = rows.length > 0 ? [...kos.values()].reduce((x, y) => Math.max(x, y), 0) : 0;
  const share = total > 0 ? top / total : 0;
  return gate('trek.ko.share', share <= TREK_KO_SHARE_MAX,
    `Trekmore UI7 vs Aeval UI7 x ${n} (Trekmore won ${wins}): ${total} KOs credited, by move ${rows.join(', ') || 'none'}; ` +
    `top share ${f2(share)} (max ${TREK_KO_SHARE_MAX}, report only)`, { total, share }, true);
});

export const TREKMORE_CASES: readonly TestCase[] = [
  mirror, vsAeval(5), vsAeval(7), vsAeval(10), oneVsThree, koShare,
];
