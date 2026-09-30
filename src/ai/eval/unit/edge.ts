/**
 * Unit check for the edge and defense plans (W2.6 plans/edge.ts, W2.7 plans/defense.ts).
 * Run: npx --yes tsx src/ai/eval/unit/edge.ts
 *
 * Every claim is checked by running the real sim on cloned states: canGetBack against the
 * victim's own recovery scripts, a ledge trap against a hanger that climbs on its first frame,
 * recovery routes from three offstage starts, and the recovery solver against one and two
 * covering opponents.
 */
import type { GameState, MatchConfig } from '../../../core/types';
import { CHARACTER_DEFS } from '../../../characters/registry';
import { createGameState, stepGame } from '../../../sim';
import type { SimFighter } from '../../../sim/state';
import type { Affordances, DecisionView, LevelVector, Perceived, PlanInstance, Tempo } from '../../contracts';
import { styleVector } from '../../archetypes';
import { getAiProfile } from '../../charprofile/derive';
import { deriveMatchup } from '../../charprofile/matchup';
import { place } from '../../charprofile/probeHit';
import { levelVector } from '../../levels';
import { createPredictor } from '../../model/predictor';
import { STAGE_DEFS } from '../../../stages/registry';
import {
  DODGE_TOWARD, EDGE_FAMILIES, H_EARLY, O_CLIMB, OptionDriver, PlanDriver, PolicyDriver, STOP_RECOVER, Watch,
  canGetBack, geoOf, ltBit, makePolicy, recoveryCode, simulate,
} from '../../plans/edge';
import type { Driver, LocalPlan } from '../../plans/edge';
import { DEFENSE_FAMILIES, lastSolve, solveRecovery } from '../../plans/defense';
import { PLAN_FAMILIES } from '../../plans/index';
import { cloneGameState } from '../../../sim/index';

declare const process: { exitCode?: number; argv: string[] };
const DEBUG = process.argv.indexOf('--debug') >= 0;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? `: ${detail}` : ''}`);
}

// ---- fixtures ------------------------------------------------------------------------------------

const STAGE = 'tidegate';
const CHAR = 'aeval';
const def = CHARACTER_DEFS[CHAR];
const prof = getAiProfile(CHAR, STAGE);
const mu = deriveMatchup(prof, prof, STAGE_DEFS[STAGE]);
const g = geoOf(STAGE);

function makeState(n: number, teams: readonly number[] | null = null): GameState {
  const players: MatchConfig['players'] = [];
  for (let i = 0; i < n; i++) {
    players.push(teams === null ? { slot: i, charId: CHAR, cpu: true, cpuLevel: 10 }
      : { slot: i, charId: CHAR, cpu: true, cpuLevel: 10, team: teams[i] });
  }
  const cfg: MatchConfig = { stageId: STAGE, players, stocks: 3, timeLimitSec: 0, seed: 777, teams: teams !== null };
  const s = createGameState(cfg);
  const empty = players.map(() => ({ held: 0, pressed: 0, released: 0 }));
  for (let k = 0; k < 90; k++) stepGame(s, empty);
  return s;
}

function ground(s: GameState, i: number, x: number, facing: 1 | -1): void {
  const f = s.fighters[i] as SimFighter;
  place(f, def, x, g.top, true);
  f.facing = facing; f.inputHeld = 0; f.invuln = 0; f.jumpsLeft = def.jumps; f.ledge = -1; f.ledgeRegrabs = 0;
}

function air(s: GameState, i: number, x: number, y: number, jumps: number, facing: 1 | -1): void {
  const f = s.fighters[i] as SimFighter;
  place(f, def, x, y, false);
  f.facing = facing; f.inputHeld = 0; f.invuln = 0; f.jumpsLeft = jumps; f.airDodgeUsed = false; f.ledge = -1;
  f.ledgeRegrabs = 0; f.hitstun = 0; f.hitlag = 0; f.fastFalling = false;
}

const tempo: Tempo = {
  update(): void { /* stub */ }, pressure: () => 0, clock: () => 0, stale: () => 0, used(): void { /* stub */ },
  cycle: () => false, reset(): void { /* stub */ },
};

const GOD: LevelVector = levelVector(1, true);

function view(state: GameState, meI: number, oppI: number, seed = 4242): DecisionView {
  const p: Perceived = { state, meI, oppI, frame: state.frame, age: 0, ownDelay: 0, hyps: [],
    passivity: 0, framesSinceEdge: 0, framesSinceAttack: 0, newEvent: false };
  return { p, aff: { situation: 'advantage', dangerHere: 0 } as Affordances, me: prof, opp: prof, mu, level: GOD,
    style: styleVector('balanced', true), pred: createPredictor(GOD), tempo, seed, slot: state.fighters[meI].slot,
    stocksAhead: 0 };
}

function familyOf(list: readonly { id: string; generate(v: DecisionView, out: PlanInstance[]): void }[], id: string) {
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  throw new Error(`no family ${id}`);
}

const drivers: (Driver | null)[] = [null, null, null, null];
const watch = new Watch();
function clearDrivers(): void { for (let i = 0; i < 4; i++) drivers[i] = null; }

// ---- 1. canGetBack -------------------------------------------------------------------------------

const VICTIM_POLICIES = [
  makePolicy('mid', 0, 40), makePolicy('early', -1000, 0), makePolicy('low', 40, 90),
  makePolicy('dodge', 20, 60, DODGE_TOWARD, 130),
];

/** Does any recovery script bring fighter `who` back in the sim (others idle)? */
function simGetsBack(s: GameState, who: number): boolean {
  const code = recoveryCode(prof);
  for (let p = 0; p < VICTIM_POLICIES.length; p++) {
    const w = cloneGameState(s);
    clearDrivers();
    drivers[who] = new PolicyDriver().set(VICTIM_POLICIES[p], code);
    simulate(w, 400, drivers, watch, who, STOP_RECOVER, code);
    if ((watch.ko & (1 << who)) === 0 && (watch.ledgeAt[who] >= 0 || watch.landAt[who] >= 0)) return true;
  }
  return false;
}

{
  const s = makeState(2);
  ground(s, 0, 0, 1);
  air(s, 1, g.right + 30, g.top + 30, 1, -1);
  const work = cloneGameState(s);
  const cgb = canGetBack(s, 1, prof, work);
  const sim = simGetsBack(s, 1);
  check('canGetBack: ledge-adjacent with a jump is true', cgb > 0, `slack ${cgb.toFixed(1)}`);
  check('canGetBack: ledge-adjacent case gets back in the sim', sim);

  const s2 = makeState(2);
  ground(s2, 0, 0, 1);
  air(s2, 1, g.right + 330, g.top + 140, 0, -1);
  (s2.fighters[1] as SimFighter).vx = 2.5;
  (s2.fighters[1] as SimFighter).vy = 2;
  const cgb2 = canGetBack(s2, 1, prof, cloneGameState(s2));
  const sim2 = simGetsBack(s2, 1);
  check('canGetBack: sent far with no jump is false', cgb2 < 0, `slack ${cgb2.toFixed(1)}`);
  check('canGetBack: far case dies in the sim', !sim2);
}

// ---- 2. Ledge trap against a hanger that climbs on its first frame --------------------------------

{
  const s = makeState(2);
  ground(s, 0, g.right - 120, 1);
  air(s, 1, g.right + 8, g.top + 12, 1, -1);
  (s.fighters[1] as SimFighter).vy = 1;
  const empty = [{ held: 0, pressed: 0, released: 0 }, { held: 0, pressed: 0, released: 0 }];
  for (let k = 0; k < 30 && s.fighters[1].action !== 'ledgeHang'; k++) stepGame(s, empty);
  const hanging = s.fighters[1].action === 'ledgeHang';
  check('ledge trap fixture: dummy hangs', hanging, `action ${s.fighters[1].action}, invuln ${s.fighters[1].invuln}`);
  const v = view(s, 0, 1);
  const out: PlanInstance[] = [];
  familyOf(EDGE_FAMILIES, 'ledgeTrap').generate(v, out);
  const bit = ltBit(O_CLIMB, H_EARLY);
  const claims = out.filter((p) => ((p as LocalPlan).mask & bit) !== 0) as LocalPlan[];
  check('ledge trap: a plan claims the first-frame climb', claims.length > 0, `${out.length} plans: ${out.map((p) => p.name).join(', ')}`);
  let hits = 0;
  let best = '';
  for (let i = 0; i < claims.length; i++) {
    const w = cloneGameState(s);
    clearDrivers();
    drivers[0] = new PlanDriver(prof, STAGE_DEFS[STAGE]).set(claims[i], prof, w);
    drivers[1] = new OptionDriver().set(O_CLIMB, 0);
    simulate(w, 90, drivers, watch);
    if (watch.hits[0 * 4 + 1] > 0) { hits++; if (best === '') best = claims[i].name; }
  }
  check('ledge trap: the claimed trap hits the climbing dummy in the sim', hits > 0 && hits === claims.length,
    `${hits}/${claims.length} hit (${best})`);
}

// ---- 3. Recovery from three offstage starts ---------------------------------------------------------

const STARTS: readonly (readonly [number, number, number, string])[] = [
  [g.right + 100, g.top + 80, 1, 'near and low, jump left'],
  [g.right + 150, g.top + 50, 1, 'far, jump left'],
  [g.right + 50, g.top + 110, 0, 'low, no jump'],
];

function recoveryPlans(s: GameState, meI: number, oppI: number): PlanInstance[] {
  const out: PlanInstance[] = [];
  familyOf(DEFENSE_FAMILIES, 'recovery').generate(view(s, meI, oppI), out);
  return out;
}

function topPlan(list: readonly PlanInstance[]): PlanInstance | null {
  let best: PlanInstance | null = null;
  for (let i = 0; i < list.length; i++) if (best === null || list[i].priority + list[i].bonus > best.priority + best.bonus) best = list[i];
  return best;
}

for (let k = 0; k < STARTS.length; k++) {
  const [x, y, jumps, label] = STARTS[k];
  const s = makeState(2);
  air(s, 0, x, y, jumps, -1);
  ground(s, 1, g.left + 60, 1);
  const plans = recoveryPlans(s, 0, 1);
  const mix = lastSolve.rows === plans.length ? plans.map((p) => (p as LocalPlan).value) : [];
  const sum = mix.reduce((a, b) => a + b, 0);
  const pick = topPlan(plans);
  let ok = false;
  let detail = `${plans.length} routes`;
  if (pick !== null) {
    const w = cloneGameState(s);
    clearDrivers();
    drivers[0] = new PlanDriver(prof, STAGE_DEFS[STAGE]).set(pick, prof, w);
    simulate(w, 300, drivers, watch, 0, STOP_RECOVER, recoveryCode(prof));
    ok = (watch.ko & 1) === 0 && watch.ledgeAt[0] >= 0;
    detail += `, ${pick.name}: ledge at ${watch.ledgeAt[0]}, land at ${watch.landAt[0]}, ko ${(watch.ko & 1) !== 0}`;
  }
  check(`recovery (${label}): the chosen route reaches the ledge in the sim`, ok, detail);
  if (plans.length > 1) check(`recovery (${label}): the mix sums to 1`, Math.abs(sum - 1) < 1e-9, sum.toFixed(6));
}

// ---- 4. One covering opponent against two -----------------------------------------------------------

function argmax(a: Float64Array, n: number): number {
  let b = 0;
  for (let i = 1; i < n; i++) if (a[i] > a[b]) b = i;
  return b;
}

function dumpSolve(label: string, plans: readonly PlanInstance[]): void {
  if (!DEBUG) return;
  console.log(`-- ${label}: ${lastSolve.rows} x ${lastSolve.cols}`);
  for (let r = 0; r < lastSolve.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < lastSolve.cols; c++) row.push(lastSolve.M[r * lastSolve.cols + c].toFixed(2));
    console.log(`${plans[r].name.padEnd(34)} ${row.join(' ')}`);
  }
}

{
  const [x, y, jumps] = [g.right + 150, g.top + 50, 1];
  // One opponent at the corner.
  const s1 = makeState(2);
  air(s1, 0, x, y, jumps, -1);
  ground(s1, 1, g.right - 30, 1);
  // The same, plus a second opponent covering from the other stage spot.
  const s2 = makeState(3);
  air(s2, 0, x, y, jumps, -1);
  ground(s2, 1, g.right - 30, 1);
  ground(s2, 2, g.right - 60, 1);
  const routes = recoveryPlans(s1, 0, 1).slice();
  const m1 = Float64Array.from(solveRecovery(view(s1, 0, 1, 99), routes, 99));
  dumpSolve('one opponent', routes);
  const m2 = Float64Array.from(solveRecovery(view(s2, 0, 1, 99), routes, 99));
  dumpSolve('two opponents', routes);
  const a1 = argmax(m1, routes.length);
  const a2 = argmax(m2, routes.length);
  check('solver: two covering opponents change the chosen route', routes.length > 1 && a1 !== a2,
    `one: ${routes[a1]?.name}, two: ${routes[a2]?.name}`);
}

// ---- 5. Teammates are never covers or targets ------------------------------------------------------

{
  // Us and a teammate at the corner against one foe far away: the solver drives only the foe.
  const s = makeState(3, [0, 0, 1]);
  air(s, 0, g.right + 150, g.top + 50, 1, -1);
  ground(s, 1, g.right - 30, 1);
  ground(s, 2, g.left + 40, 1);
  const routes = recoveryPlans(s, 0, 2);
  check('teams: the solver counts only foes as covers', lastSolve.foes === 1 && routes.length > 0, `foes ${lastSolve.foes}`);
  // A teammate recovering is not an edgeguard target.
  const s2 = makeState(2, [0, 0]);
  ground(s2, 0, g.right - 40, 1);
  air(s2, 1, g.right + 60, g.top + 40, 1, -1);
  const out: PlanInstance[] = [];
  const v2 = view(s2, 0, 1);
  for (let i = 0; i < EDGE_FAMILIES.length; i++) EDGE_FAMILIES[i].generate(v2, out);
  check('teams: no edgeguard plan against a teammate', out.length === 0, `${out.length} plans`);
}

// ---- 6. Other defense families generate in their situations ---------------------------------------

{
  const s = makeState(2);
  ground(s, 1, g.right - 60, -1);
  const f = s.fighters[0] as SimFighter;
  const names: string[] = [];
  const run = (id: string): number => {
    const out: PlanInstance[] = [];
    familyOf(DEFENSE_FAMILIES, id).generate(view(s, 0, 1), out);
    for (let i = 0; i < out.length; i++) names.push(out[i].name);
    return out.length;
  };
  air(s, 0, 0, g.top - 60, 1, 1); f.action = 'tumble'; f.hitstun = 0; f.vy = 2;
  const nTech = run('tech');
  const nLand = run('tumbleExit');
  ground(s, 0, 0, 1); f.action = 'downed'; f.downTimer = 3;
  const nGetup = run('getup');
  air(s, 0, g.right + 8, g.top + 12, 1, -1); f.vy = 1;
  const empty = [{ held: 0, pressed: 0, released: 0 }, { held: 0, pressed: 0, released: 0 }];
  for (let k = 0; k < 30 && (f.action as string) !== 'ledgeHang'; k++) stepGame(s, empty);
  const nLedge = run('ledgeOption');
  const stall = names.indexOf('ledge:stall') >= 0;
  check('defense: tech, landing, getup and ledge options generate', nTech === 3 && nLand > 3 && nGetup === 8 && nLedge > 10 && stall,
    `tech ${nTech}, landing ${nLand}, getup ${nGetup}, ledge ${nLedge}, stall ${stall}`);
  f.ledgeRegrabs = 3;
  for (let k = 0; k < 6; k++) stepGame(s, empty);   // past the family's refresh window, still hanging
  const before = names.length;
  run('ledgeOption');
  check('defense: no ledge stall past the regrab limit', names.length > before && names.slice(before).indexOf('ledge:stall') < 0);
}

// ---- 7. Registration ------------------------------------------------------------------

{
  const ids = new Set(PLAN_FAMILIES.map((f) => f.id));
  check('registry: edge and defense families registered', ids.has('ledgeTrap') && ids.has('recovery') && ids.has('ledgeOption'));
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
