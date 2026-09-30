/**
 * Unit check for the harness base (W1.6 to W1.9): statistics worked examples from 06 section 1,
 * metrics on hand-built logs, a recorded legacy match, replay determinism, and every adversary.
 * Run: npx --yes tsx src/ai/eval/unit/evalbase.ts
 */
import type { MatchResult, ReplayEvent } from '../../contracts';
import { ADVERSARIES, EXTRA_ADVERSARIES, adversary, extraAdversary } from '../adversaries';
import { actionFrames, computeMetrics, openingsOf } from '../metrics';

/** Actions a fighter is put in by its opponent (or the rules), not by its own choice. */
const NOT_ITS_OWN: readonly string[] = ['dead', 'respawn', 'shieldBreak', 'hitstun', 'tumble', 'grabbed', 'downed',
  'footstooled', 'finalSmashVictim'];
import { legacyBrain, runMatch } from '../runner';
import {
  bradleyTerry, cohensD, eloFromP, eloSe, mannWhitney, oneSampleN, pFromElo, sprt, sprtSteps, wilson, wilsonNForHalfWidth,
} from '../stats';

declare const process: { stdout: { write(text: string): void }; exitCode?: number };

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? `: ${detail}` : ''}\n`);
}
const r3 = (x: number): string => x.toFixed(3);

// ---- statistics (06 section 1) ----
const lows: [number, number, string][] = [[10, 10, '0.722'], [20, 20, '0.839'], [50, 50, '0.929'], [73, 73, '0.950'], [100, 100, '0.963']];
for (const [k, n, want] of lows) check(`wilson ${k}/${n} lower bound ${want}`, r3(wilson(k, n).lo) === want, r3(wilson(k, n).lo));
const w60 = wilson(60, 100);
check('wilson 60/100 is 0.502 to 0.691', r3(w60.lo) === '0.502' && r3(w60.hi) === '0.691', `${r3(w60.lo)} to ${r3(w60.hi)}`);
const w120 = wilson(120, 200);
check('wilson 120/200 is 0.531 to 0.665', r3(w120.lo) === '0.531' && r3(w120.hi) === '0.665', `${r3(w120.lo)} to ${r3(w120.hi)}`);
check('wilson half-width 0.05 needs 381, 0.10 needs 93',
  wilsonNForHalfWidth(0.05) === 381 && wilsonNForHalfWidth(0.10) === 93, `${wilsonNForHalfWidth(0.05)}, ${wilsonNForHalfWidth(0.10)}`);
check('one-sample n: 194, 85, 783', oneSampleN(0.5, 0.6) === 194 && oneSampleN(0.5, 0.65) === 85 && oneSampleN(0.5, 0.55) === 783,
  `${oneSampleN(0.5, 0.6)}, ${oneSampleN(0.5, 0.65)}, ${oneSampleN(0.5, 0.55)}`);
const st = sprtSteps(0.5, 0.65, 0.05, 0.05);
check('SPRT(0.5, 0.65, 0.05, 0.05) win +0.262, loss -0.357, bounds +-2.944',
  r3(st.win) === '0.262' && r3(st.loss) === '-0.357' && r3(st.upper) === '2.944' && r3(st.lower) === '-2.944',
  `${r3(st.win)} ${r3(st.loss)} ${r3(st.upper)} ${r3(st.lower)}`);
{
  const s = sprt(0.5, 0.65, 0.05, 0.05);
  let last = s.add(1);
  for (let i = 1; i < 12; i++) last = s.add(1);
  const t = sprt(0.5, 0.65, 0.05, 0.05);
  let lt = t.add(0);
  for (let i = 1; i < 9; i++) lt = t.add(0);
  const h = sprt(0.5, 0.65, 0.05, 0.05).add(0.5);
  check('SPRT: 12 straight wins accept H1, 9 straight losses accept H0, a half point moves half of each',
    last.decision === 'H1' && last.n === 12 && lt.decision === 'H0' && lt.n === 9 && Math.abs(h.llr - (st.win + st.loss) / 2) < 1e-12,
    `${last.decision}@${last.n}, ${lt.decision}@${lt.n}, half ${h.llr.toFixed(4)}`);
}
check('pFromElo 100/200/382 = 0.640/0.760/0.900', r3(pFromElo(100)) === '0.640' && r3(pFromElo(200)) === '0.760' && r3(pFromElo(382)) === '0.900',
  `${r3(pFromElo(100))} ${r3(pFromElo(200))} ${r3(pFromElo(382))}`);
check('eloFromP inverts pFromElo; 0.6 is 70 points', Math.abs(eloFromP(pFromElo(137)) - 137) < 1e-6 && Math.round(eloFromP(0.6)) === 70,
  `${eloFromP(0.6).toFixed(1)}`);
check('Elo SE at p 0.64: 36 / 26 / 18 at n 100 / 200 / 400',
  Math.round(eloSe(0.64, 100)) === 36 && Math.round(eloSe(0.64, 200)) === 26 && Math.round(eloSe(0.64, 400)) === 18,
  `${eloSe(0.64, 100).toFixed(1)} ${eloSe(0.64, 200).toFixed(1)} ${eloSe(0.64, 400).toFixed(1)}`);
{
  // Synthetic round robin with fractional scores at the true expectation, plus a deterministic
  // noisy version: 400 games per pair drawn from a fixed LCG.
  const truth: Record<string, number> = { a: -150, b: 0, c: 150 };
  const names = Object.keys(truth);
  const games: { a: string; b: string; scoreA: number }[] = [];
  const noisy: { a: string; b: string; scoreA: number }[] = [];
  let lcg = 12345;
  const rnd = (): number => { lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0; return lcg / 4294967296; };
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const p = pFromElo(truth[names[i]] - truth[names[j]]);
    for (let g = 0; g < 50; g++) games.push({ a: names[i], b: names[j], scoreA: p });
    for (let g = 0; g < 4000; g++) noisy.push({ a: names[i], b: names[j], scoreA: rnd() < p ? 1 : 0 });
  }
  const fit = bradleyTerry(games);
  const fitN = bradleyTerry(noisy);
  let worst = 0; let worstN = 0;
  for (const nm of names) {
    worst = Math.max(worst, Math.abs((fit.get(nm)?.elo ?? NaN) - truth[nm]));
    worstN = Math.max(worstN, Math.abs((fitN.get(nm)?.elo ?? NaN) - truth[nm]));
  }
  check('Bradley-Terry recovers three strengths within 5 Elo (expected scores; 4,000 noisy games per pair)',
    worst < 5 && worstN < 15, `exact ${worst.toFixed(2)}, noisy ${worstN.toFixed(2)} (se ${fitN.get('a')?.se.toFixed(1)})`);
}
{
  const d = cohensD([2, 4, 6], [1, 3, 5]);
  const mw = mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
  const mwTie = mannWhitney([1, 2, 3], [1, 2, 3]);
  check('Cohen d of [2,4,6] vs [1,3,5] is 0.5; Mann-Whitney U 0 with p < 0.05 on separated samples, p about 1 on equal ones',
    Math.abs(d - 0.5) < 1e-12 && mw.u === 0 && mw.p < 0.05 && mwTie.p > 0.999 && mwTie.u === 4.5,
    `d ${d.toFixed(3)} U ${mw.u} p ${mw.p.toFixed(4)} tie U ${mwTie.u} p ${mwTie.p}`);
}

// ---- metrics on hand-built logs ----
{
  const ev = (frame: number, kind: string, slot: number, data: Record<string, number | string>): ReplayEvent => ({ frame, kind, slot, data });
  const base: ReplayEvent[] = [
    ev(0, 'player', 0, { reach: 40, team: 0 }), ev(0, 'player', 1, { reach: 40, team: 1 }),
    ev(100, 'hit', 0, { v: 1, dmg: 5, vatk: 0 }), ev(100, 'stun', 1, { on: 1 }), ev(110, 'stun', 1, { on: 0 }),
    // 44 free frames later: still the same combo.
    ev(154, 'hit', 0, { v: 1, dmg: 7, vatk: 0 }), ev(154, 'stun', 1, { on: 1 }), ev(160, 'stun', 1, { on: 0 }),
    // 45 free frames (160..204): combo ended at 204; this hit is a new opening.
    ev(206, 'hit', 0, { v: 1, dmg: 3, vatk: 1 }), ev(206, 'stun', 1, { on: 1 }), ev(215, 'stun', 1, { on: 0 }),
  ];
  const ops = openingsOf(base, 2, 400);
  check('metrics: a hit after 44 free frames extends the combo, after 45 it is a new opening',
    ops.length === 2 && ops[0].hits === 2 && ops[0].damage === 12 && ops[1].frame === 206 && ops[1].counter,
    ops.map((o) => `${o.frame}:${o.hits}h/${o.damage}`).join(' '));
  const r: MatchResult = { winner: 0, stocksLost: [0, 1], sds: [0, 0], frames: 3600, timeout: false, finalHash: '', inputHash: ['', ''],
    events: [...base, ev(300, 'ko', 1, { by: 0, sd: 0, pct: 15 })], cost: [{ mean: 0, p99: 0, first: 0, calls: 0 }, { mean: 0, p99: 0, first: 0, calls: 0 }] };
  const m = computeMetrics(r, 0);
  check('metrics: openings, conversion rate, damage per opening, counter-hit rate, first KO frame',
    m.openings === 2 && m.conversionRate === 0.5 && m.damagePerOpening === 7.5 && m.counterHitRate === 0.5 && m.firstKoFrame === 300 && m.damagePerMin === 15,
    `openings ${m.openings} conv ${m.conversionRate} dpo ${m.damagePerOpening} ch ${m.counterHitRate} ko ${m.firstKoFrame} dpm ${m.damagePerMin}`);
}

// ---- recorded legacy match: level 5 vs the standing dummy ----
let msPerMatch = 0;
{
  const spec = { seed: 17, stageId: 'tidegate', stocks: 3, frameCap: 7200, swap: false, record: true } as const;
  const t0 = performance.now();
  const r = runMatch({ ...spec, a: legacyBrain(5), b: adversary('stationary', 'Dummy') });
  msPerMatch = performance.now() - t0;
  const m = computeMetrics(r, 0);
  check('legacy L5 vs standing dummy: recorded, openings and a first-KO frame',
    r.events !== null && m.openings > 0 && m.firstKoFrame > 0,
    `${r.frames}f winner ${r.winner} openings ${m.openings} firstKO ${m.firstKoFrame} 3-stock ${m.threeStockTime} dpm ${m.damagePerMin.toFixed(1)}` +
    ` conv ${m.conversionRate.toFixed(2)} react n ${m.reactN} ipm ${m.inputsPerMin.toFixed(0)} rep ${m.repetition.toFixed(2)} H ${m.entropyNeutral.toFixed(2)}` +
    ` events ${r.events?.length} cost mean ${r.cost[0].mean.toFixed(4)} ms p99 ${r.cost[0].p99.toFixed(3)} first ${r.cost[0].first.toFixed(3)}; ${msPerMatch.toFixed(0)} ms`);
  const r2 = runMatch({ ...spec, a: legacyBrain(5), b: adversary('stationary', 'Dummy') });
  check('replaying the same seed gives the same final hash and input streams',
    r.finalHash === r2.finalHash && r.inputHash.join() === r2.inputHash.join() && r.frames === r2.frames,
    `${r.finalHash} / ${r2.finalHash}`);
  const plain = runMatch({ ...spec, record: false, a: legacyBrain(5), b: adversary('stationary', 'Dummy') });
  check('recording does not change the match', plain.finalHash === r.finalHash && plain.inputHash.join() === r.inputHash.join());
  const sw = runMatch({ ...spec, swap: true, a: legacyBrain(5), b: adversary('stationary', 'Dummy') });
  const ms = computeMetrics(sw, 0);
  check('side swap: player 0 is still the level 5 and still wins', sw.winner === 0 && ms.openings > 0, `winner ${sw.winner} openings ${ms.openings}`);
}
{
  // ah: level 10 vs level 9, same seed twice (3,000-frame cap).
  const spec = { seed: 23, stageId: 'tidegate', stocks: 2, frameCap: 3000, swap: false } as const;
  const a = runMatch({ ...spec, record: false, a: legacyBrain(10), b: legacyBrain(9) });
  const b = runMatch({ ...spec, record: true, a: legacyBrain(10), b: legacyBrain(9) });
  check('ah: legacy 10 vs 9 twice gives identical hashes and input streams',
    a.finalHash === b.finalHash && a.inputHash.join() === b.inputHash.join(),
    `${a.finalHash} ${a.frames}f; L10 mean ${a.cost[0].mean.toFixed(3)} ms p99 ${a.cost[0].p99.toFixed(2)} first ${a.cost[0].first.toFixed(1)}`);
  // Capture overhead, both warm: best of three each way.
  let plain = Infinity; let rec = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    runMatch({ ...spec, record: false, a: legacyBrain(10), b: legacyBrain(9) });
    const t1 = performance.now();
    runMatch({ ...spec, record: true, a: legacyBrain(10), b: legacyBrain(9) });
    const t2 = performance.now();
    plain = Math.min(plain, t1 - t0); rec = Math.min(rec, t2 - t1);
  }
  check('replay capture costs under 1.3x a plain 3,000-frame legacy match', rec < 1.3 * plain,
    `plain ${plain.toFixed(0)} ms, recorded ${rec.toFixed(0)} ms (${(rec / plain).toFixed(2)}x)`);
}

// ---- adversaries ----
{
  const ids: string[] = [];
  const fails: string[] = [];
  for (const id of ADVERSARIES) {
    try {
      const r = runMatch({ seed: 5, stageId: 'hearthmoor', stocks: 3, frameCap: 600, swap: false, record: true, a: legacyBrain(5), b: adversary(id, 'Tester') });
      const m = computeMetrics(r, 1);
      if (id === 'shieldOnly') {
        // The adversary's own policy: shield share of the frames it chose its action in. Frames its
        // opponent took from it (shield broken, hit, grabbed, down, dead) are the opponent's doing:
        // a UI 5 that breaks the shield (its documented weakness) is not the adversary failing.
        const af = actionFrames((r.events ?? []).slice().sort((x, y) => x.frame - y.frame), 2, r.frames)[1];
        let lost = 0;
        for (const a of NOT_ITS_OWN) lost += af.get(a) ?? 0;
        const own = Math.max(1, r.frames - lost);
        const share = ((af.get('shield') ?? 0) + (af.get('shieldStun') ?? 0)) / own;
        if (!(share > 0.5)) fails.push(`shieldOnly shield share ${share.toFixed(2)} of its own frames (${m.shieldShare.toFixed(2)} of all)`);
      }
      if (id === 'jumpOnly' && !(m.jumpsPerMin > 60)) fails.push(`jumpOnly jumps/min ${m.jumpsPerMin.toFixed(0)}`);
      if (id === 'camper' && !(m.projectilesPerMin > 0)) fails.push('camper never shot');
      ids.push(id);
    } catch (e) { fails.push(`${id} threw ${String(e)}`); }
  }
  for (const id of EXTRA_ADVERSARIES) {
    try {
      runMatch({ seed: 5, stageId: 'tidegate', stocks: 3, frameCap: 600, swap: true, record: true, a: legacyBrain(5), b: extraAdversary(id, 'Tester') });
      ids.push(id);
    } catch (e) { fails.push(`${id} threw ${String(e)}`); }
  }
  check(`every adversary runs 600 frames (${ids.length})`, fails.length === 0, fails.length === 0 ? ids.join(', ') : fails.join('; '));
}

process.stdout.write(`${checks - failures}/${checks} pass; runner ms per match (L5 vs dummy, recorded) ${msPerMatch.toFixed(0)}\n`);
if (failures > 0) process.exitCode = 1;
