/**
 * Unit check for the search (W2.10 rollout and outcome, W2.11 selection and mix).
 * Run: npx --yes tsx src/ai/eval/unit/search.ts
 *
 * Every rollout check runs the real sim on cloned states with hand-built plan instances and reply
 * models (MoveId literals are fine here: this is a test, not brain code).
 */
import type { FighterState, GameState, MatchConfig } from '../../../core/types';
import { Btn, DIRECT_CODES } from '../../../core/types';
import { CHARACTER_DEFS } from '../../../characters/registry';
import { createGameState, stepGame } from '../../../sim';
import { STAGE_DEFS } from '../../../stages/registry';
import type { SimFighter } from '../../../sim/state';
import type {
  Affordances, DecisionView, Hypothesis, Intent, LevelVector, Perceived, PlanCtx, PlanInstance, ReplyModel, Scored,
  SearchResult, Tempo,
} from '../../contracts';
import { PF_ATTACK, PF_INTR, PF_MOVE } from '../../contracts';
import { styleVector } from '../../archetypes';
import { getAiProfile } from '../../charprofile/derive';
import { deriveMatchup } from '../../charprofile/matchup';
import { place } from '../../charprofile/probeHit';
import { levelVector } from '../../levels';
import { createPredictor } from '../../model/predictor';
import { fictitiousPlay, mixValue } from '../../search/mix';
import { newOutcome, scoreOutcome, stageInfo } from '../../search/outcome';
import { WINDOW, WINDOW_KILL, lastRolloutStats, runRollouts } from '../../search/rollout';
import { blendValue, cvar, resetSelect, selectPlan, weightedMean } from '../../search/select';

declare const process: { exitCode?: number };

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? `: ${detail}` : ''}`);
}
const f2 = (x: number): string => x.toFixed(2);

// ---- fixtures ------------------------------------------------------------------------------------

const STAGE = 'tidegate';
const CHAR = 'aeval';
const def = CHARACTER_DEFS[CHAR];
const si = stageInfo(STAGE);
const prof = getAiProfile(CHAR, STAGE);
const mu = deriveMatchup(prof, prof, STAGE_DEFS[STAGE]);
const code = (name: string): number => (DIRECT_CODES as readonly string[]).indexOf(name) + 1;

function makeState(n: number, teams = false): GameState {
  const players: MatchConfig['players'] = [];
  for (let i = 0; i < n; i++) players.push({ slot: i, charId: CHAR, cpu: true, cpuLevel: 10 });
  const cfg: MatchConfig = { stageId: STAGE, players, stocks: 3, timeLimitSec: 0, seed: 777, teams };
  const s = createGameState(cfg);
  const empty = players.map(() => ({ held: 0, pressed: 0, released: 0 }));
  for (let k = 0; k < 90; k++) stepGame(s, empty);
  return s;
}

function put(s: GameState, i: number, x: number, facing: 1 | -1, percent = 0): void {
  const f = s.fighters[i] as SimFighter;
  place(f, def, x, si.topY, true);
  f.facing = facing;
  f.percent = percent;
  f.inputHeld = 0;
}

const tempo: Tempo = {
  update(): void { /* stub */ }, pressure: () => 0, clock: () => 0, stale: () => 0, used(): void { /* stub */ },
  cycle: () => false, reset(): void { /* stub */ },
};

function view(state: GameState, meI: number, oppI: number, level: LevelVector, hyps: readonly Hypothesis[], seed = 4242): DecisionView {
  const p: Perceived = { state, meI, oppI, frame: state.frame, age: level.perceptionAge, ownDelay: 0, hyps,
    passivity: 0, framesSinceEdge: 0, framesSinceAttack: 0, newEvent: false };
  return { p, aff: {} as Affordances, me: prof, opp: prof, mu, level, style: styleVector('balanced', level.god),
    pred: createPredictor(level), tempo, seed, slot: state.fighters[meI].slot, stocksAhead: 0 };
}

function plan(name: string, flags: number, horizon: number,
  fn: (t: number, self: FighterState, ctx: PlanCtx, out: Intent) => void): PlanInstance {
  return { family: 'wait', name, move: null, param: 0, minFrames: 1, horizon, flags, bonus: 0, priority: 0,
    script(t, self, ctx, out): void { out.held = 0; out.direct = 0; out.mash = 0; fn(t, self, ctx, out); } };
}

const dirBit = (d: number): number => (d > 0 ? Btn.Right : Btn.Left);

const P_WAIT = plan('wait', PF_INTR | PF_MOVE, 45, () => { /* stand */ });
const P_SHIELD = plan('shield', PF_INTR, 45, (_t, _s, _c, out) => { out.held = Btn.Shield; });
const P_WALK_IN = plan('walkIn', PF_INTR, 45, (_t, _s, ctx, out) => { out.held = dirBit(ctx.dir) | Btn.Walk; });
const P_ROLL_OUT = plan('rollThrough', PF_MOVE, 30, (t, _s, ctx, out) => { out.held = dirBit(ctx.dir) | (t === 0 ? Btn.Dodge : 0); });
const P_JAB_BACK = plan('jabBehind', PF_ATTACK, 20, (t, _s, _c, out) => { if (t === 0) out.direct = code('jab'); });

function reply(name: string, kind: number, weight: number,
  fn: (t: number, self: FighterState, other: FighterState, out: Intent) => void): ReplyModel {
  return { kind, arg: 0, weight, name,
    step(t, self, other, _ctx, out): void { out.held = 0; out.direct = 0; out.mash = 0; fn(t, self, other, out); } };
}
/** Closes in and jabs every 6 frames once inside 40 px. */
const R_ATTACK = reply('attack', 1, 0.6, (t, self, other, out) => {
  const dx = other.x - self.x;
  if (Math.abs(dx) > 40) out.held = dx > 0 ? Btn.Right : Btn.Left;
  else if (t % 6 === 0) { out.held = dx > 0 ? Btn.Right : Btn.Left; out.direct = code('jab'); }
});
const R_CONT = reply('continue', 0, 0.4, () => { /* hold nothing */ });
const R_SHIELD = reply('shield', 2, 0.2, (_t, _s, _o, out) => { out.held = Btn.Shield; });

const GOD = levelVector(1, true);
const MID = levelVector(0.5, false);
const NONE: Hypothesis[] = [{ kind: 'none', move: null, ago: 0, dir: 0, weight: 1 }];

function newResult(): SearchResult { return { best: null, value: 0, steps: 0, scored: [], secondPly: false, vetoed: 0 }; }
function byName(sc: readonly Scored[], name: string): Scored | undefined { return sc.find((s) => s.plan.name === name); }

// ---- 1. determinism ---------------------------------------------------------------------------------
{
  const s = makeState(2);
  put(s, 0, si.cx - 50, 1); put(s, 1, si.cx + 50, -1);
  const hyps: Hypothesis[] = [
    { kind: 'none', move: null, ago: 0, dir: 0, weight: 0.6 },
    { kind: 'move', move: 'ftilt', ago: 3, dir: -1, weight: 0.25 },
    { kind: 'shield', move: null, ago: 2, dir: 0, weight: 0.15 },
  ];
  const cands = [P_JAB_BACK, P_WALK_IN, P_SHIELD, P_WAIT, P_ROLL_OUT];
  const replies = [R_ATTACK, R_CONT, R_SHIELD];
  const run = (lv: LevelVector): { name: string; value: number; steps: number; js: string } => {
    resetSelect();
    const v = view(s, 0, 1, lv, hyps);
    const out: Scored[] = [];
    const steps = runRollouts(v, cands, replies, lv.stepBudget, out);
    const res = newResult();
    selectPlan(v, out, res);
    const js = out.map((x) => Array.from(x.J.subarray(0, x.n)).map((j) => j.toFixed(6)).join(',')).join('|');
    return { name: res.best?.name ?? 'null', value: res.value, steps, js };
  };
  const frameBefore = s.frame, pctBefore = s.fighters[1].percent, xBefore = s.fighters[0].x;
  const a = run(GOD), b = run(GOD);
  check('same state and seed give the same selection twice (god)', a.name === b.name && a.value === b.value && a.js === b.js && a.steps === b.steps,
    `${a.name} ${f2(a.value)} / ${b.name} ${f2(b.value)}, steps ${a.steps}`);
  const c = run(MID), d = run(MID);
  check('same state and seed give the same selection twice (seeded softmax, s 0.5)', c.name === d.name && c.value === d.value && c.js === d.js,
    `${c.name} / ${d.name}`);
  check('rollouts never touch the perceived state', s.frame === frameBefore && s.fighters[1].percent === pctBefore && s.fighters[0].x === xBefore);
  check('hypothesis preparation ran and was counted', lastRolloutStats().prepSteps > 0 || lastRolloutStats().samples < 3,
    `prep ${lastRolloutStats().prepSteps}, samples ${lastRolloutStats().samples}`);
}

// ---- 2. walking into a hitbox scores below shielding ----------------------------------------------
{
  const s = makeState(2);
  put(s, 0, si.cx - 45, 1); put(s, 1, si.cx + 45, -1);
  resetSelect();
  const v = view(s, 0, 1, GOD, NONE);
  const out: Scored[] = [];
  runRollouts(v, [P_WALK_IN, P_SHIELD], [R_ATTACK, R_CONT], 2600, out);
  const walk = byName(out, 'walkIn'), sh = byName(out, 'shield');
  check('a candidate that walks into a hitbox scores below one that shields (real sim rollouts)',
    walk !== undefined && sh !== undefined && walk.value < sh.value && walk.cvar < sh.cvar,
    `walkIn V ${f2(walk?.value ?? NaN)} cvar ${f2(walk?.cvar ?? NaN)}, shield V ${f2(sh?.value ?? NaN)} cvar ${f2(sh?.cvar ?? NaN)}`);
  const res = newResult();
  selectPlan(v, out, res);
  check('selection takes the shield there', res.best?.name === 'shield', res.best?.name ?? 'null');
}

// ---- 3. CVaR ---------------------------------------------------------------------------------------
{
  const w = new Float64Array([0.8, 0.2]), J = new Float64Array([100, -200]);
  const c = cvar(w, J, 2, 0.25);
  check('CVaR 0.25 of {0.8: 100, 0.2: -200} is -140', Math.abs(c - -140) < 1e-9, f2(c));
  const w2 = new Float64Array([0.1, 0.9]), J2 = new Float64Array([-100, 0]);
  const c2 = cvar(w2, J2, 2, 0.25);
  check('a reply of weight 0.1 below alpha 0.25 contributes w / alpha of the tail', Math.abs(c2 - (-100 * 0.1 / 0.25)) < 1e-9, f2(c2));
  check('CVaR at alpha 1 is the mean, at alpha 0 the worst', Math.abs(cvar(w, J, 2, 1) - 40) < 1e-9 && cvar(w, J, 2, 0) === -200);
  check('CVaR ignores the order of the samples', cvar(new Float64Array([0.2, 0.8]), new Float64Array([-200, 100]), 2, 0.25) === c);

  // Ranking: a risky high-mean plan against a safe one, alpha 0.25, lambda 0.5.
  const mk = (name: string, ws: number[], js: number[]): Scored => {
    const wa = new Float64Array(ws), ja = new Float64Array(js);
    const cv = cvar(wa, ja, ws.length, 0.25), mean = weightedMean(wa, ja, ws.length);
    return { plan: plan(name, PF_ATTACK, 30, () => { /* none */ }), w: wa, J: ja, n: ws.length, cvar: cv, mean,
      value: blendValue(cv, mean, 0.5), stockLossWeight: 0, certainLoss: false };
  };
  const risky = mk('risky', [0.8, 0.2], [100, -200]);
  const safe = mk('safe', [0.8, 0.2], [20, 20]);
  const s = makeState(2);
  resetSelect();
  const v = view(s, 0, 1, { ...MID, tau: 0, god: false }, NONE);
  const res = newResult();
  selectPlan(v, [risky, safe], res);
  check('CVaR at alpha 0.25 ranks a risky high-mean plan below a safe one',
    risky.mean > safe.mean && risky.value < safe.value && res.best?.name === 'safe',
    `risky mean ${f2(risky.mean)} V ${f2(risky.value)}, safe V ${f2(safe.value)}, picked ${res.best?.name}`);
  // tau = 0 is argmax, independent of the seed.
  let same = true;
  for (let seed = 0; seed < 20; seed++) {
    resetSelect();
    const r2 = newResult();
    selectPlan(view(s, 0, 1, { ...MID, tau: 0, god: false }, NONE, seed), [mk('a', [1], [10]), mk('b', [1], [10.1])], r2);
    if (r2.best?.name !== 'b') same = false;
  }
  check('tau = 0 is argmax', same);
  // Certain-loss veto only when an alternative exists.
  const loss = { ...mk('loss', [1], [500]), stockLossWeight: 0.6, certainLoss: true };
  resetSelect();
  const r3 = newResult();
  selectPlan(v, [loss, safe], r3);
  resetSelect();
  const r4 = newResult();
  selectPlan(v, [loss], r4);
  check('certain-loss veto only when an alternative exists', r3.best?.name === 'safe' && r3.vetoed === 1 && r4.best?.name === 'loss' && r4.vetoed === 0);
}

// ---- 4. multi-opponent: between two opponents scores below moving them to one side ---------------
{
  const s = makeState(3);
  put(s, 0, si.cx, 1); put(s, 1, si.cx + 45, -1); put(s, 2, si.cx - 45, 1);
  resetSelect();
  const v = view(s, 0, 1, GOD, NONE);
  const out: Scored[] = [];
  runRollouts(v, [P_WAIT, P_ROLL_OUT], [R_ATTACK, R_CONT], 2600, out);
  const stay = byName(out, 'wait'), move = byName(out, 'rollThrough');
  check('1v2: a plan that stays between two opponents scores below one that moves them to one side',
    stay !== undefined && move !== undefined && stay.value < move.value,
    `stay V ${f2(stay?.value ?? NaN)} (cvar ${f2(stay?.cvar ?? NaN)}), roll through V ${f2(move?.value ?? NaN)} (cvar ${f2(move?.cvar ?? NaN)}), enemies ${lastRolloutStats().enemies}`);

  // Damage on the opponent who is not the target counts.
  const s2 = makeState(3);
  put(s2, 0, si.cx, -1); put(s2, 1, si.cx + 160, -1); put(s2, 2, si.cx - 30, 1);
  resetSelect();
  const v2 = view(s2, 0, 1, GOD, NONE);
  const out2: Scored[] = [];
  runRollouts(v2, [P_JAB_BACK, P_WAIT], [R_CONT], 2600, out2);
  const jab = byName(out2, 'jabBehind'), wait = byName(out2, 'wait');
  check('damage on a non-target opponent counts', jab !== undefined && wait !== undefined && jab.mean > wait.mean,
    `jab ${f2(jab?.mean ?? NaN)} vs wait ${f2(wait?.mean ?? NaN)}`);

  // Teams: a teammate is never a reply target and continues its input.
  const s3 = makeState(3, true);
  s3.config.players[0].team = 0; s3.config.players[1].team = 1; s3.config.players[2].team = 0;
  put(s3, 0, si.cx, 1); put(s3, 1, si.cx + 45, -1); put(s3, 2, si.cx - 45, 1);
  resetSelect();
  runRollouts(view(s3, 0, 1, GOD, NONE), [P_WAIT], [R_ATTACK], 2600, []);
  check('teams: only the enemy replies', lastRolloutStats().enemies === 1, `enemies ${lastRolloutStats().enemies}`);
}

// ---- 5. budget ---------------------------------------------------------------------------------------
{
  const s = makeState(2);
  put(s, 0, si.cx - 60, 1); put(s, 1, si.cx + 60, -1);
  const many: PlanInstance[] = [];
  for (let i = 0; i < 24; i++) {
    const base = [P_WAIT, P_SHIELD, P_WALK_IN, P_ROLL_OUT, P_JAB_BACK][i % 5];
    many.push({ ...base, name: `${base.name}${i}` });
  }
  const hyps: Hypothesis[] = [
    { kind: 'none', move: null, ago: 0, dir: 0, weight: 0.5 },
    { kind: 'move', move: 'jab', ago: 4, dir: -1, weight: 0.2 },
    { kind: 'jump', move: null, ago: 3, dir: -1, weight: 0.15 },
    { kind: 'roll', move: null, ago: 2, dir: 1, weight: 0.15 },
  ];
  const replies = [R_ATTACK, R_CONT, R_SHIELD];
  let ok = true;
  const lines: string[] = [];
  for (const budget of [0, 30, 45, 100, 300, 800, 1600, 2600, 5000, 8000]) {
    resetSelect();
    const out: Scored[] = [];
    const steps = runRollouts(view(s, 0, 1, GOD, hyps), many, replies, budget, out);
    const st = lastRolloutStats();
    if (steps > budget + st.window) ok = false;
    if (steps !== st.steps) ok = false;
    lines.push(`${budget}:${steps}/${out.length}x${st.samples}`);
  }
  check('the step budget is never exceeded by more than one common window', ok, lines.join(' '));
  const kill = { ...P_JAB_BACK, name: 'killish', flags: PF_ATTACK | 256 };
  runRollouts(view(s, 0, 1, GOD, NONE), [P_WAIT, kill], replies, 2600, []);
  check('the window is 45, or 60 when a kill or spike plan is among the candidates',
    lastRolloutStats().window === WINDOW_KILL && (runRollouts(view(s, 0, 1, GOD, NONE), [P_WAIT], replies, 2600, []), lastRolloutStats().window === WINDOW));
  // God: a realistic decision (20 candidates, 6 replies, 3 hypotheses) at the level's step budget.
  const replies6 = [R_ATTACK, R_CONT, R_SHIELD, { ...R_ATTACK, name: 'a2', weight: 0.1 }, { ...R_CONT, name: 'c2', weight: 0.1 }, { ...R_SHIELD, name: 's2', weight: 0.1 }];
  resetSelect();
  const t0 = Date.now();
  const steps = runRollouts(view(s, 0, 1, GOD, hyps.slice(0, 3)), many.slice(0, 20), replies6, GOD.stepBudget, []);
  const ms = Date.now() - t0;
  const st = lastRolloutStats();
  console.log(`info god decision: budget ${GOD.stepBudget}, steps ${steps} (prep ${st.prepSteps}), ${st.scored} candidates x ${st.samples} samples x ${st.window} frames, ${ms} ms`);
  check('god decision stays inside its budget', steps <= GOD.stepBudget && st.scored === 20, `${steps} of ${GOD.stepBudget}`);
}

// ---- 6. fictitious play ---------------------------------------------------------------------------------
{
  // Matching pennies: the row mix converges to one half each.
  const M = new Float64Array([1, -1, -1, 1]);
  const out = new Float64Array(4);
  fictitiousPlay(M, 2, 2, 2000, 9, out);
  const out2 = new Float64Array(4);
  fictitiousPlay(M, 2, 2, 2000, 9, out2);
  check('fictitious play: matching pennies mixes near 50/50, deterministic', Math.abs(out[0] - 0.5) < 0.03 && out.join() === out2.join(),
    `${f2(out[0])} ${f2(out[1])}`);
  // Rock paper scissors: every row near a third, value near 0.
  const R = new Float64Array([0, -1, 1, 1, 0, -1, -1, 1, 0]);
  const o3 = new Float64Array(3);
  fictitiousPlay(R, 3, 3, 3000, 5, o3);
  check('fictitious play: rock paper scissors near a third each', Math.abs(o3[0] - 1 / 3) < 0.05 && Math.abs(o3[1] - 1 / 3) < 0.05 && Math.abs(mixValue(R, 3, 3, o3)) < 0.1,
    `${f2(o3[0])} ${f2(o3[1])} ${f2(o3[2])}`);
  // A dominant row gets all the weight.
  const D = new Float64Array([5, 5, 1, 1]);
  const od = new Float64Array(2);
  fictitiousPlay(D, 2, 2, 200, 1, od);
  check('fictitious play: a dominant row takes the whole mix', od[0] > 0.99, f2(od[0]));
}

// ---- 7. score sanity ----------------------------------------------------------------------------------
{
  const w = styleVector('balanced', true).w;
  const o = newOutcome();
  o.damageDealt = 10;
  const a = scoreOutcome(o, w);
  o.damageDealt = 0; o.damageTaken = 10;
  const b = scoreOutcome(o, w);
  check('score: 10% dealt is +10, 10% taken is -12.5 with the balanced weights', a === 10 && b === -12.5, `${a} ${b}`);
}

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
