/**
 * Unit check for the integrated engine (W3.1, src/ai/brain.ts).
 * Run: npx --yes tsx src/ai/eval/unit/brain.ts
 *
 * 1. A 1v1 god against the legacy level 9 runs 3,000 frames twice with identical final hashes and
 *    input streams.
 * 2. A 1v3 (god against three teamed UI level 4 CPUs on the new engine) runs without throwing and
 *    the god perceives all three opponents.
 * 3. A 2v2 (god and UI 7 against two UI 7) never targets a teammate.
 * 4. A Trekmore CPU (god) against a Trekmore-controlled opponent (UI 7 on the new engine), and an
 *    Aeval god against a Trekmore UI 7, run 1,800 frames each without throwing.
 * 5. Milliseconds per decision for the god and guide level 3 (UI 5) are printed.
 */
import type { GameState, InputFrame } from '../../../core/types';
import type { BrainFactory, CpuSpec, MatchResult } from '../../contracts';
import { brainPerceived, brainStats } from '../../brain';
import '../../characters/index';
import { specForUiLevel } from '../../levels';
import { isTeammate } from '../../perception';
import { hintFactory, legacyBrain, newBrain, runMatch } from '../runner';
import { checker } from './fixtures';

const c = checker();
const GOD = specForUiLevel(10);
const L3 = specForUiLevel(5);

interface Probe { calls: number; ms: number; decisions: number; maxOpps: number; mateTargets: number; frames: number }
function newProbe(): Probe { return { calls: 0, ms: 0, decisions: 0, maxOpps: 0, mateTargets: 0, frames: 0 }; }

/** newBrain(spec) with per-call timing, the opponents it perceives and the targets it picks. */
function probed(spec: CpuSpec, pr: Probe): BrainFactory {
  const inner = newBrain(spec);
  return {
    name: inner.name, spec,
    create() {
      const f = inner.create();
      return (s: GameState, slot: number, out: InputFrame): InputFrame => {
        const t0 = performance.now();
        const r = f(s, slot, out);
        pr.ms += performance.now() - t0;
        pr.calls++;
        const st = brainStats(slot);
        pr.decisions = st.decisions;
        const p = brainPerceived(slot);
        if (p.nOpps > pr.maxOpps) pr.maxOpps = p.nOpps;
        let meI = -1;
        for (let i = 0; i < s.fighters.length; i++) if (s.fighters[i].slot === slot) meI = i;
        if (meI >= 0 && st.target >= 0 && isTeammate(s, meI, st.target)) pr.mateTargets++;
        pr.frames++;
        return r;
      };
    },
    reset() { inner.reset(); },
  };
}

function sameResult(a: MatchResult, b: MatchResult): boolean {
  if (a.finalHash !== b.finalHash || a.frames !== b.frames) return false;
  for (let i = 0; i < a.inputHash.length; i++) if (a.inputHash[i] !== b.inputHash[i]) return false;
  return true;
}

// ---- 1. determinism, 1v1 god against legacy 9 ---------------------------------------------------
const god1 = newProbe();
const r1 = runMatch({ seed: 1234, stageId: 'tidegate', stocks: 3, frameCap: 3000, a: probed(GOD, god1), b: legacyBrain(9),
  swap: false, record: false });
const god2 = newProbe();
const r2 = runMatch({ seed: 1234, stageId: 'tidegate', stocks: 3, frameCap: 3000, a: probed(GOD, god2), b: legacyBrain(9),
  swap: false, record: false });
c.check('1v1 god vs legacy 9: two runs give the same final hash and input streams', sameResult(r1, r2),
  `${r1.finalHash}/${r2.finalHash}, ${r1.frames} frames, winner ${r1.winner}, stocks lost ${r1.stocksLost.join('/')}`);
c.check('1v1 god decided', god1.decisions > 0, `${god1.decisions} decisions over ${god1.calls} calls`);

// ---- 2. 1v3 -----------------------------------------------------------------------------------------
const g3 = newProbe();
let threw = '';
let r3: MatchResult | null = null;
try {
  const l4 = specForUiLevel(4);
  r3 = runMatch({ seed: 77, stageId: 'hearthmoor', stocks: 2, frameCap: 2400, a: probed(GOD, g3), b: newBrain(l4), swap: false,
    record: false, extraPlayers: [{ factory: newBrain(l4), team: 1 }, { factory: newBrain(l4), team: 1 }] });
} catch (e) { threw = String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 400); }
c.check('1v3 (god vs three teamed UI 4) runs without throwing', threw === '' && r3 !== null,
  threw !== '' ? threw : `${r3?.frames} frames, winner ${r3?.winner}, stocks lost ${r3?.stocksLost.join('/')}`);
c.check('1v3: the god perceives all three opponents', g3.maxOpps === 3, `max perceived opponents ${g3.maxOpps}`);

// ---- 3. 2v2, never targets a teammate ----------------------------------------------------------------
const a4 = newProbe();
const m4 = newProbe();
const l7 = specForUiLevel(7);
const r4 = runMatch({ seed: 99, stageId: 'tidegate', stocks: 2, frameCap: 2400, a: probed(GOD, a4), b: newBrain(l7), swap: false,
  record: false, extraPlayers: [{ factory: probed(l7, m4), team: 0 }, { factory: newBrain(l7), team: 1 }] });
c.check('2v2: neither teamed CPU ever targets its teammate', a4.mateTargets === 0 && m4.mateTargets === 0 && a4.frames > 0 && m4.frames > 0,
  `god ${a4.mateTargets}/${a4.frames}, UI7 ${m4.mateTargets}/${m4.frames} frames targeting a teammate; ${r4.frames} frames`);

// ---- 4. Trekmore as the CPU and as the opponent --------------------------------------------------------
function trek(spec: CpuSpec, ui: number): BrainFactory {
  return hintFactory(newBrain(spec), { cpu: true, cpuLevel: ui, charId: 'trekmore' });
}
for (const [label, a, b] of [
  ['Trekmore god vs Trekmore UI 7', trek(GOD, 10), trek(l7, 7)],
  ['Aeval god vs Trekmore UI 7', newBrain(GOD), trek(l7, 7)],
  ['Trekmore UI 5 vs Aeval legacy 9', trek(L3, 5), legacyBrain(9)],
] as [string, BrainFactory, BrainFactory][]) {
  let err = '';
  let r: MatchResult | null = null;
  try {
    r = runMatch({ seed: 31, stageId: 'hearthmoor', stocks: 3, frameCap: 1800, a, b, swap: false, record: false });
  } catch (e) { err = String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 400); }
  c.check(`${label}: 1,800 frames without throwing`, err === '' && r !== null,
    err !== '' ? err : `${r?.frames} frames, winner ${r?.winner}, stocks lost ${r?.stocksLost.join('/')}`);
}

// ---- 5. cost per decision ----------------------------------------------------------------------------
const l3p = newProbe();
runMatch({ seed: 4321, stageId: 'tidegate', stocks: 3, frameCap: 3000, a: probed(L3, l3p), b: legacyBrain(5), swap: false, record: false });
const perDecision = (p: Probe): number => (p.decisions > 0 ? p.ms / p.decisions : 0);
console.log(`ms per decision: god ${perDecision(god1).toFixed(3)} (${god1.decisions} decisions, mean ${(god1.ms / Math.max(1, god1.calls)).toFixed(3)} ms per call), ` +
  `l3 ${perDecision(l3p).toFixed(3)} (${l3p.decisions} decisions, mean ${(l3p.ms / Math.max(1, l3p.calls)).toFixed(3)} ms per call)`);
c.check('cost measured', god1.calls > 0 && l3p.calls > 0);

c.done('brain');
