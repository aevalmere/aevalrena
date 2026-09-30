/**
 * Unit check for the Trekmore plan pack (src/ai/characters/trekmore.ts, docs/TREKMORE_PLAN.md F W3b).
 * Run: npx --yes tsx src/ai/eval/unit/trekmore.ts
 *
 * Every check runs the real sim; plans are driven with PlanRunner exactly as the brain drives them.
 * MoveId literals are fine here: this is a test, not brain code.
 *
 * 1. Each family generates on a Trekmore CPU and nothing on an Aeval CPU in the same scene.
 * 2. The sword route script throws the sword and its scripted recall teleports him to the sword.
 * 3. The ground cross-up passes through the target and the backstrike hits it.
 * 4. The counter plan is offered and fires against a scripted Aeval ftilt, and is not offered
 *    against an Aeval grab.
 * 5. A god Trekmore takes three stocks from a standing Aeval dummy inside GOD_DUMMY_FRAMES (median of
 *    three seeds; the generic god alone measured 1,587 to 1,884 on them).
 */
import type { GameState, InputFrame } from '../../../core/types';
import { Btn } from '../../../core/types';
import { STAGE_DEFS } from '../../../stages/registry';
import { stepGame } from '../../../sim';
import type { SimFighter } from '../../../sim/state';
import type { DecisionView, LevelVector, Perceived, PlanFamily, PlanInstance } from '../../contracts';
import { styleVector } from '../../archetypes';
import { affordancesFor, newAffordances } from '../../affordances';
import { getAiProfile } from '../../charprofile/derive';
import { deriveMatchup } from '../../charprofile/matchup';
import { levelVector, specForUiLevel } from '../../levels';
import { createPredictor } from '../../model/predictor';
import { createTempo } from '../../tempo';
import { PlanRunner } from '../../plans/script';
import '../../brain';
import '../../characters/index';
import { TREKMORE_FAMILY_TABLE } from '../../characters/trekmore';
import { adversary } from '../adversaries';
import { hintFactory, newBrain, runMatch } from '../runner';
import { checker, directCode, makeState, put, putAir, putOffstage, stageBox, stepWith } from './fixtures';

const c = checker();
const GOD: LevelVector = levelVector(1, true);
/** Frame budget for a god Trekmore to take three stocks from a standing dummy (Aeval's `ba` target is 1,200). */
export const GOD_DUMMY_FRAMES = 2700;
const DUMMY_SEEDS: readonly number[] = [11, 12, 13];

// ---- fixtures ------------------------------------------------------------------------------------

type Pair = [string, string];
const TREK_VS_AEVAL: Pair = ['trekmore', 'aeval'];
const AEVAL_VS_AEVAL: Pair = ['aeval', 'aeval'];

function stateFor(chars: Pair): GameState { return makeState(2, { charIds: chars }); }

function view(s: GameState, meI: number, oppI: number, level: LevelVector = GOD): DecisionView {
  const stage = STAGE_DEFS[s.stageId];
  const me = getAiProfile(s.fighters[meI].charId, s.stageId);
  const opp = getAiProfile(s.fighters[oppI].charId, s.stageId);
  const mu = deriveMatchup(me, opp, stage);
  const p: Perceived = { state: s, meI, oppI, frame: s.frame, age: 0, ownDelay: 0,
    hyps: [{ kind: 'none', move: null, ago: 0, dir: 0, weight: 1 }],
    passivity: 0, framesSinceEdge: 0, framesSinceAttack: 0, newEvent: false };
  const aff = newAffordances();
  affordancesFor(p, aff);
  const style = styleVector('balanced', level.god);
  return { p, aff, me, opp, mu, level, style, pred: createPredictor(level), tempo: createTempo(style),
    seed: 4242, slot: s.fighters[meI].slot, stocksAhead: 0 };
}

function genFrom(fam: PlanFamily, v: DecisionView): PlanInstance[] {
  const out: PlanInstance[] = [];
  fam.generate(v, out);
  return out.slice();
}

function familyByName(name: string): PlanFamily {
  const e = TREKMORE_FAMILY_TABLE.find((x) => x.name === name);
  if (e === undefined) throw new Error(`no family ${name}`);
  return e.family;
}

const INPUTS: InputFrame[] = [];
function inputs(n: number): InputFrame[] {
  while (INPUTS.length < n) INPUTS.push({ held: 0, pressed: 0, released: 0, direct: 0 });
  for (let i = 0; i < n; i++) { const f = INPUTS[i]; f.held = 0; f.pressed = 0; f.released = 0; f.direct = 0; }
  return INPUTS;
}

/** Runs `plan` for fighters[meI] for `frames` frames (others idle); `onStep` sees each new state. */
function runPlan(s: GameState, meI: number, v: DecisionView, plan: PlanInstance, frames: number,
  onStep?: (s: GameState, k: number) => boolean): number {
  const runner = new PlanRunner(v.me, STAGE_DEFS[s.stageId]);
  runner.start(plan, v);
  for (let k = 0; k < frames; k++) {
    const all = inputs(s.fighters.length);
    runner.step(s, meI, all[meI]);
    stepGame(s, all);
    if (onStep !== undefined && onStep(s, k)) return k + 1;
  }
  return frames;
}

/** One direct code for fighter i this frame, then `after` idle frames. */
function pressCode(s: GameState, i: number, move: string, after = 0): void {
  const ins = inputs(s.fighters.length);
  ins[i].direct = directCode(move);
  stepGame(s, ins);
  for (let k = 0; k < after; k++) stepGame(s, inputs(s.fighters.length));
}

// Scenes: each builds a state with fighter 0 as the CPU (charIds[0]) and fighter 1 as Aeval, and
// returns it ready for a decision.
type Scene = (chars: Pair) => GameState;

const sceneSwordRoute: Scene = (chars) => {
  const s = stateFor(chars);
  const b = stageBox(s);
  put(s, 0, b.cx - 110, 1); put(s, 1, b.cx, -1);
  return s;
};

const sceneSwordOut: Scene = (chars) => {
  const s = stateFor(chars);
  const b = stageBox(s);
  put(s, 0, b.cx - 140, 1); put(s, 1, b.cx + 160, -1);
  // Up-forward sword, then wait until the thrower is free with the sword still flying.
  stepWith(s, 1, (i) => (i === 0 ? Btn.Right | Btn.Up : 0));
  const ins = inputs(2); ins[0].held = Btn.Right | Btn.Up; ins[0].direct = directCode('nspecial');
  stepGame(s, ins);
  for (let k = 0; k < 34; k++) stepGame(s, inputs(2));
  // The target stands under the sword's recall point.
  const sw = s.projectiles.find((p) => p.alive && p.owner === s.fighters[0].slot);
  if (sw !== undefined) put(s, 1, sw.x, -1);
  return s;
};

const sceneRecovery: Scene = (chars) => {
  const s = stateFor(chars);
  const b = stageBox(s);
  put(s, 1, b.cx, -1);
  putOffstage(s, 0, -1, 90, 70, false, 60);
  (s.fighters[0] as SimFighter).airLock = 0;
  return s;
};

const sceneStep: Scene = (chars) => {
  const s = stateFor(chars);
  const b = stageBox(s);
  put(s, 0, b.cx - 25, 1); put(s, 1, b.cx + 25, -1);
  return s;
};

/** Aeval (fighter 1) starts `move` 40 px away, one frame in. */
function sceneAttack(move: 'ftilt' | 'grab'): Scene {
  return (chars) => {
    const s = stateFor(chars);
    const b = stageBox(s);
    put(s, 0, b.cx - 20, 1); put(s, 1, b.cx + 20, -1, 30);
    if (move === 'grab') stepWith(s, 1, (i) => (i === 1 ? Btn.Grab : 0));
    else pressCode(s, 1, 'ftilt');
    return s;
  };
}

function sceneEcho(pct: number): Scene {
  return (chars) => {
    const s = stateFor(chars);
    const b = stageBox(s);
    put(s, 0, b.cx - 15, 1); put(s, 1, b.cx + 15, -1, pct);
    return s;
  };
}

const sceneKill: Scene = (chars) => {
  const s = stateFor(chars);
  const b = stageBox(s);
  put(s, 0, b.cx - 45, 1); put(s, 1, b.cx + 45, -1, 180);
  return s;
};

function sceneGrab(pct: number): Scene {
  return (chars) => {
    const s = stateFor(chars);
    const b = stageBox(s);
    put(s, 0, b.cx - 12, 1); put(s, 1, b.cx + 12, -1, pct);
    stepWith(s, 30, (i, t) => (i === 0 && t === 0 ? Btn.Grab : 0), (st) => st.fighters[0].action === 'grabHold');
    return s;
  };
}

const sceneEdge: Scene = (chars) => {
  const s = stateFor(chars);
  const b = stageBox(s);
  put(s, 0, b.right - 30, 1);
  putAir(s, 1, b.right + 70, b.top + 20, 0, 0, 90);
  return s;
};

// ---- 1. each family on Trekmore, not on Aeval -----------------------------------------------------
{
  const cases: { name: string; scenes: Scene[] }[] = [
    { name: 'trekmore.swordRoute', scenes: [sceneSwordRoute] },
    { name: 'trekmore.swordRecall', scenes: [sceneSwordOut] },
    { name: 'trekmore.swordRecovery', scenes: [sceneRecovery] },
    { name: 'trekmore.stepCross', scenes: [sceneStep] },
    { name: 'trekmore.counterRead', scenes: [sceneAttack('ftilt')] },
    { name: 'trekmore.echoChain', scenes: [sceneEcho(0), sceneEcho(20), sceneEcho(40), sceneEcho(60)] },
    { name: 'trekmore.killRoute', scenes: [sceneKill] },
    { name: 'trekmore.dthrowEcho', scenes: [sceneGrab(0), sceneGrab(20), sceneGrab(40), sceneGrab(70)] },
    { name: 'trekmore.edgeguard', scenes: [sceneEdge] },
  ];
  for (const cs of cases) {
    const fam = familyByName(cs.name);
    let trekNames: string[] = [];
    let aevalCount = 0;
    for (const sc of cs.scenes) {
      const st = sc(TREK_VS_AEVAL);
      const got = genFrom(fam, view(st, 0, 1));
      if (trekNames.length === 0) trekNames = got.map((p) => p.name);
      const sa = sc(AEVAL_VS_AEVAL);
      aevalCount += genFrom(fam, view(sa, 0, 1)).length;
    }
    c.check(`${cs.name} (${fam.id}) generates on Trekmore and not on Aeval`, trekNames.length > 0 && aevalCount === 0,
      `Trekmore: ${trekNames.join(', ') || 'none'}; Aeval: ${aevalCount}`);
  }
  // Level gate: nothing below UI 4.
  const low = levelVector(specForUiLevel(3).s, false);
  let lowCount = 0;
  const st = sceneSwordRoute(TREK_VS_AEVAL);
  for (const e of TREKMORE_FAMILY_TABLE) lowCount += genFrom(e.family, view(st, 0, 1, low)).length;
  c.check('no Trekmore plans below UI 4', lowCount === 0, `${lowCount} plans at UI 3`);
}

// ---- 2. sword route: the scripted recall teleports him to the sword ----------------------------------
{
  const s = sceneSwordRoute(TREK_VS_AEVAL);
  const v = view(s, 0, 1);
  const plans = genFrom(familyByName('trekmore.swordRoute'), v);
  const plan = plans.find((p) => p.name === 'tkSwordAbove') ?? plans[0];
  if (plan === undefined) c.check('sword route offered', false);
  else {
    let lastSword: { x: number; y: number } | null = null;
    let tele: { x: number; y: number; kind: string } | null = null;
    let at = { x: 0, y: 0 };
    let hit = false;
    const foot = 26;
    runPlan(s, 0, v, plan, plan.horizon, (st) => {
      for (const e of st.events) {
        if (e.type === 'teleport' && e.slot === st.fighters[0].slot && tele === null) {
          tele = { x: e.x, y: e.y, kind: e.kind };
          at = { x: st.fighters[0].x, y: st.fighters[0].y };
        }
        if (e.type === 'hit' && e.attacker === st.fighters[0].slot) hit = true;
      }
      const sw = st.projectiles.find((p) => p.alive && p.owner === st.fighters[0].slot && p.defId === 'shadowSword');
      if (tele === null && sw !== undefined) lastSword = { x: sw.x, y: sw.y };
      return false;
    });
    const t = tele as { x: number; y: number; kind: string } | null;
    const sw = lastSword as { x: number; y: number } | null;
    const ok = t !== null && t.kind === 'recall' && sw !== null && Math.abs(at.x - sw.x) < 0.01 && Math.abs(at.y - (sw.y + foot)) < 1;
    c.check(`${plan.name}: the scripted second press recalls him onto the sword`, ok,
      t === null ? 'no teleport' : `teleport ${t.kind} to ${at.x.toFixed(1)},${at.y.toFixed(1)}; sword was at ${sw?.x.toFixed(1)},${sw?.y.toFixed(1)}; follow-up hit ${hit}`);
  }
}

// ---- 3. cross-up: passes through and hits ----------------------------------------------------------
{
  const s = sceneStep(TREK_VS_AEVAL);
  const v = view(s, 0, 1);
  const plan = genFrom(familyByName('trekmore.stepCross'), v).find((p) => p.name === 'tkStepCross');
  if (plan === undefined) c.check('cross-up offered', false);
  else {
    const side0 = Math.sign(s.fighters[1].x - s.fighters[0].x);
    let passed = false; let hit = false;
    runPlan(s, 0, v, plan, plan.horizon, (st) => {
      if (Math.sign(st.fighters[1].x - st.fighters[0].x) === -side0) passed = true;
      for (const e of st.events) if (e.type === 'hit' && e.attacker === st.fighters[0].slot && e.victim === st.fighters[1].slot) hit = true;
      return hit;
    });
    c.check('tkStepCross passes through the target and the backstrike hits', passed && hit,
      `passed ${passed}, hit ${hit}, me ${s.fighters[0].x.toFixed(1)} them ${s.fighters[1].x.toFixed(1)}`);
  }
}

// ---- 4. counter: fires on a scripted ftilt, never offered on a grab ---------------------------------
{
  const fam = familyByName('trekmore.counterRead');
  const s = sceneAttack('ftilt')(TREK_VS_AEVAL);
  const v = view(s, 0, 1);
  const plan = genFrom(fam, v).find((p) => p.name === 'tkCounter');
  let countered = false; let repaid = false;
  if (plan !== undefined) {
    runPlan(s, 0, v, plan, 80, (st) => {
      for (const e of st.events) {
        if (e.type === 'counter' && e.slot === st.fighters[0].slot) countered = true;
        if (e.type === 'hit' && e.attacker === st.fighters[0].slot && e.victim === st.fighters[1].slot) repaid = true;
      }
      return repaid;
    });
  }
  c.check('counter offered and fires against an Aeval ftilt', plan !== undefined && countered && repaid,
    `offered ${plan !== undefined}, countered ${countered}, repaid hit ${repaid}`);
  const g = sceneAttack('grab')(TREK_VS_AEVAL);
  const gp = genFrom(fam, view(g, 0, 1));
  c.check('counter not offered against an Aeval grab', gp.length === 0,
    `Aeval ${g.fighters[1].action}; plans ${gp.map((p) => p.name).join(', ') || 'none'}`);
  // Shielding target: nothing either.
  const sh = sceneStep(TREK_VS_AEVAL);
  stepWith(sh, 6, (i) => (i === 1 ? Btn.Shield : 0));
  const sp = genFrom(fam, view(sh, 0, 1));
  c.check('counter not offered against a shield', sp.length === 0, `Aeval ${sh.fighters[1].action}; ${sp.length} plans`);
}

// ---- 5. god Trekmore vs a standing dummy -----------------------------------------------------------
{
  const rows: string[] = [];
  const times: number[] = [];
  for (const seed of DUMMY_SEEDS) {
    const god = hintFactory(newBrain(specForUiLevel(10)), { cpu: true, cpuLevel: 10, charId: 'trekmore' });
    const dummy = adversary('stationary', 'dummy');
    const r = runMatch({ seed, stageId: 'tidegate', stocks: 3, frameCap: GOD_DUMMY_FRAMES + 900, a: god, b: dummy,
      swap: false, record: false });
    const three = r.winner === 0 && (r.stocksLost[0] ?? 0) === 0 ? r.frames : Infinity;
    times.push(three);
    rows.push(`seed ${seed}: ${r.frames} frames, winner ${r.winner}, stocks lost ${r.stocksLost.join('/')}`);
  }
  const med = times.slice().sort((a, b) => a - b)[times.length >> 1];
  c.check(`god Trekmore takes 3 stocks from a standing dummy, median of ${DUMMY_SEEDS.length} within ${GOD_DUMMY_FRAMES} frames`,
    med <= GOD_DUMMY_FRAMES, `median ${med}; ${rows.join('; ')}`);
}

c.done('trekmore');
