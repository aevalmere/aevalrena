/**
 * Unit check for the plan registry, neutral, advantage and passive families (W2.4, W2.5, W2.9).
 * Run: npx --yes tsx src/ai/eval/unit/plans.ts
 *
 * Every check runs the real sim; plans are driven with PlanRunner exactly as the brain drives
 * them (prepare the context once, then script per frame with t advancing outside hitlag).
 * MoveId literals are fine here: this is a test, not brain code.
 *
 * 1. Candidates are deterministic (same state, same list; a rebuilt state, same list), capped at
 *    PREFILTER_CAP, inside the level's vocabulary, and a teammate target yields no attack.
 * 2. A scripted approach reaches the opponent: the approach stops at its spacing, the dash grab
 *    grabs.
 * 3. A combo plan executes a table route and lands every hit.
 * 4. The passive route takes three stocks from a standing dummy inside PASSIVE_TARGET_FRAMES,
 *    open loop (the route family re-generated each decision, no search).
 * 5. In a 1v2 the one-side positioning plan leaves both dummies on one side after 300 frames.
 * 6. An advantage plan aborts when the other opponent's threat window reaches the CPU, and not
 *    when that opponent is far.
 */
import type { GameState, InputFrame, MatchConfig, MoveId } from '../../../core/types';
import { DIRECT_CODES } from '../../../core/types';
import { CHARACTER_DEFS } from '../../../characters/registry';
import { createGameState, stepGame } from '../../../sim';
import { STAGE_DEFS } from '../../../stages/registry';
import type { SimFighter } from '../../../sim/state';
import type { DecisionView, LevelVector, Perceived, PlanInstance } from '../../contracts';
import { PF_ATTACK } from '../../contracts';
import { styleVector } from '../../archetypes';
import { newAffordances, affordancesFor } from '../../affordances';
import { getAiProfile } from '../../charprofile/derive';
import { deriveMatchup } from '../../charprofile/matchup';
import { place } from '../../charprofile/probeHit';
import { levelVector } from '../../levels';
import { createPredictor } from '../../model/predictor';
import { createTempo } from '../../tempo';
import { generateCandidates, PLAN_FAMILIES, PREFILTER_CAP } from '../../plans/index';
import { ADVANTAGE_FAMILIES, advantageAbort, thirdPartyThreat } from '../../plans/advantage';
import { NEUTRAL_FAMILIES } from '../../plans/neutral';
import { PASSIVE_FAMILIES, PASSIVE_TARGET_FRAMES, passiveKind, resetPassive } from '../../plans/passive';
import { Plan, PlanRunner } from '../../plans/script';

declare const process: { exitCode?: number };

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? `: ${detail}` : ''}`);
}

// ---- fixtures ------------------------------------------------------------------------------------

const STAGE = 'tidegate';
const CHAR = 'aeval';
const def = CHARACTER_DEFS[CHAR];
const stage = STAGE_DEFS[STAGE];
const TOP = stage.platforms[0].y;
const prof = getAiProfile(CHAR, STAGE);
const mu = deriveMatchup(prof, prof, stage);
const GOD = levelVector(1, true);
const code = (name: string): number => (DIRECT_CODES as readonly string[]).indexOf(name) + 1;

function makeState(n: number, teams: number[] | null = null): GameState {
  const players: MatchConfig['players'] = [];
  for (let i = 0; i < n; i++) {
    players.push({ slot: i, charId: CHAR, cpu: true, cpuLevel: 10, ...(teams !== null ? { team: teams[i] } : {}) });
  }
  const cfg: MatchConfig = { stageId: STAGE, players, stocks: 3, timeLimitSec: 0, seed: 777, teams: teams !== null };
  const s = createGameState(cfg);
  const empty = players.map(() => ({ held: 0, pressed: 0, released: 0 }));
  for (let k = 0; k < 90; k++) stepGame(s, empty);
  return s;
}

function put(s: GameState, i: number, x: number, facing: 1 | -1, percent = 0): void {
  const f = s.fighters[i] as SimFighter;
  place(f, def, x, TOP, true);
  f.facing = facing;
  f.percent = percent;
  f.inputHeld = 0;
}

const INPUTS: InputFrame[] = [];
function inputs(n: number): InputFrame[] {
  while (INPUTS.length < n) INPUTS.push({ held: 0, pressed: 0, released: 0, direct: 0 });
  for (let i = 0; i < n; i++) { const f = INPUTS[i]; f.held = 0; f.pressed = 0; f.released = 0; f.direct = 0; }
  return INPUTS;
}

function view(s: GameState, meI: number, oppI: number, level: LevelVector = GOD, sinceStart = 0): DecisionView {
  const p: Perceived = { state: s, meI, oppI, frame: s.frame, age: 0, ownDelay: 0,
    hyps: [{ kind: 'none', move: null, ago: 0, dir: 0, weight: 1 }],
    passivity: sinceStart, framesSinceEdge: sinceStart, framesSinceAttack: sinceStart, newEvent: false };
  const aff = newAffordances();
  affordancesFor(p, aff);
  const style = styleVector('balanced', level.god);
  return { p, aff, me: prof, opp: prof, mu, level, style, pred: createPredictor(level), tempo: createTempo(style),
    seed: 4242, slot: s.fighters[meI].slot, stocksAhead: 0 };
}

function gen(v: DecisionView): PlanInstance[] {
  const out: PlanInstance[] = [];
  generateCandidates(v, out);
  return out.slice();
}

function fromFamilies(v: DecisionView, fams: readonly { generate(v: DecisionView, out: PlanInstance[]): void }[]): PlanInstance[] {
  const out: PlanInstance[] = [];
  for (const f of fams) f.generate(v, out);
  return out;
}

// ---- 1. determinism, cap, vocabulary, teammates -------------------------------------------------
{
  const s = makeState(2);
  put(s, 0, -60, 1); put(s, 1, 60, -1);
  const a = gen(view(s, 0, 1)).map((p) => `${p.family}:${p.name}:${p.priority}`);
  const b = gen(view(s, 0, 1)).map((p) => `${p.family}:${p.name}:${p.priority}`);
  const s2 = makeState(2);
  put(s2, 0, -60, 1); put(s2, 1, 60, -1);
  const c = gen(view(s2, 0, 1)).map((p) => `${p.family}:${p.name}:${p.priority}`);
  check('candidates deterministic', a.join('|') === b.join('|') && a.join('|') === c.join('|'), `${a.length} plans`);
  check('candidates capped', a.length > 0 && a.length <= PREFILTER_CAP, `${a.length} <= ${PREFILTER_CAP}`);
  check('registry holds neutral, advantage and passive families',
    PLAN_FAMILIES.length >= NEUTRAL_FAMILIES.length + ADVANTAGE_FAMILIES.length + PASSIVE_FAMILIES.length,
    `${PLAN_FAMILIES.length}`);

  // Every priority is non-increasing (priority order).
  const pl = gen(view(s, 0, 1));
  let ordered = true;
  for (let i = 1; i < pl.length; i++) if (pl[i].priority + pl[i].bonus > pl[i - 1].priority + pl[i - 1].bonus + 1e-9) ordered = false;
  check('candidates in priority order', ordered);

  // Vocabulary gating at the lowest level.
  const low = levelVector(0, false);
  const lp = gen(view(s, 0, 1, low));
  const bad = lp.filter((p) => !low.vocabulary.has(p.family)).map((p) => p.family);
  check('vocabulary gates families', lp.length > 0 && bad.length === 0 && lp.length <= low.menuCap,
    `${lp.length} plans, cap ${low.menuCap}, outside ${bad.join(',') || 'none'}`);

  // Teammate target: no attack plan.
  const t = makeState(4, [0, 0, 1, 1]);
  put(t, 0, -40, 1); put(t, 1, 40, -1); put(t, 2, -200, 1); put(t, 3, 200, -1);
  const tp = gen(view(t, 0, 1));
  const atk = tp.filter((p) => (p.flags & PF_ATTACK) !== 0).map((p) => p.name);
  check('teammate target yields no attack', atk.length === 0, atk.join(',') || `${tp.length} movement plans`);
}

// ---- 2. scripted approach ------------------------------------------------------------------------

function runPlan(s: GameState, meI: number, v: DecisionView, plan: PlanInstance, frames: number,
  onStep?: (s: GameState) => boolean): number {
  const runner = new PlanRunner(prof, stage);
  runner.start(plan, v);
  for (let k = 0; k < frames; k++) {
    const all = inputs(s.fighters.length);
    runner.step(s, meI, all[meI]);
    stepGame(s, all);
    if (onStep !== undefined && onStep(s)) return k + 1;
    if (runner.done()) return k + 1;
  }
  return frames;
}

{
  const s = makeState(2);
  put(s, 0, -170, 1); put(s, 1, 110, -1);
  const v = view(s, 0, 1);
  const cands = fromFamilies(v, NEUTRAL_FAMILIES);
  const ap = cands.find((p) => p.name === 'approach');
  if (ap === undefined) check('approach plan offered', false);
  else {
    const want = (ap as Plan).param;
    runPlan(s, 0, v, ap, ap.horizon);
    for (let k = 0; k < 20; k++) stepGame(s, inputs(2));
    const d = Math.abs(s.fighters[1].x - s.fighters[0].x);
    check('approach reaches its spacing', Math.abs(d - want) <= 16, `distance ${d.toFixed(1)} want ${want.toFixed(1)}`);
  }

  const s2 = makeState(2);
  put(s2, 0, -120, 1); put(s2, 1, 110, -1);
  const v2 = view(s2, 0, 1);
  const dg = fromFamilies(v2, NEUTRAL_FAMILIES).find((p) => p.name === 'dashGrab');
  if (dg === undefined) check('dash grab plan offered', false);
  else {
    let grabbed = false;
    runPlan(s2, 0, v2, dg, dg.horizon, (st) => { if (st.fighters[1].action === 'grabbed') grabbed = true; return grabbed; });
    check('scripted approach grabs the opponent', grabbed,
      `me ${s2.fighters[0].x.toFixed(1)} ${s2.fighters[0].action}, them ${s2.fighters[1].x.toFixed(1)} ${s2.fighters[1].action}`);
  }
}

// ---- 3. combo route -----------------------------------------------------------------------------
{
  const starters: MoveId[] = ['dtilt', 'utilt', 'jab', 'ftilt', 'dspecial'];
  const pcts = [0, 20, 40, 60, 80];
  let tried = 0; let clean = 0; const notes: string[] = [];
  for (const st of starters) {
    for (const pct of pcts) {
      const s = makeState(2);
      const gap = Math.max(12, Math.min(40, prof.moves[st].reach.front + 4));
      put(s, 0, 0, 1); put(s, 1, gap, -1, pct);
      let hitAt = -1;
      for (let k = 0; k < 40 && hitAt < 0; k++) {
        const inp = inputs(2);
        if (k === 0) inp[0].direct = code(st);
        stepGame(s, inp);
        for (const e of s.events) if (e.type === 'hit' && e.attacker === 0 && e.victim === 1) hitAt = s.frame;
      }
      if (hitAt < 0) continue;
      const v = view(s, 0, 1);
      const cands = fromFamilies(v, ADVANTAGE_FAMILIES).filter((p) => p.family === 'comboFollow' || p.family === 'killConfirm');
      const plan = cands.find((p) => p instanceof Plan && (p.data as { links?: unknown[] } | null)?.links !== undefined);
      if (plan === undefined) continue;
      const links = ((plan as Plan).data as { links: unknown[] }).links.length;
      let hits = 0;
      runPlan(s, 0, v, plan, Math.max(plan.horizon, 90), (x) => {
        for (const e of x.events) if (e.type === 'hit' && e.attacker === 0 && e.victim === 1) hits++;
        return false;
      });
      tried++;
      if (hits >= links) clean++;
      notes.push(`${st}@${pct} ${plan.name} ${hits}/${links}`);
      if (tried >= 6) break;
    }
    if (tried >= 6) break;
  }
  check('combo plan runs a table route and lands every hit', tried > 0 && clean === tried, `${clean}/${tried}: ${notes.join('; ')}`);
}

// ---- 4. passive route ---------------------------------------------------------------------------
{
  resetPassive();
  const s = makeState(2);
  const sp = stage.spawns;
  put(s, 0, sp[0].x, 1); put(s, 1, sp[1].x, -1);
  const runner = new PlanRunner(prof, stage);
  let kos = 0; let frames = 0; let firstKind = ''; let firstKindAt = -1;
  const cap = PASSIVE_TARGET_FRAMES + 400;
  let nextDecision = 0;
  for (frames = 0; frames < cap && kos < 3; frames++) {
    if (frames >= nextDecision || runner.plan === null || runner.done()) {
      const v = view(s, 0, 1, GOD, s.frame);
      const out: PlanInstance[] = [];
      PASSIVE_FAMILIES[0].generate(v, out);
      if (firstKindAt < 0) { const k = passiveKind(v); if (k !== 'none') { firstKind = k; firstKindAt = frames; } }
      if (out.length > 0) { runner.start(out[0], v); nextDecision = frames + 4; }
      else if (runner.done()) runner.plan = null;
    }
    const all = inputs(2);
    runner.step(s, 0, all[0]);
    stepGame(s, all);
    for (const e of s.events) if (e.type === 'ko' && e.slot === 1) kos++;
  }
  check('passive kind detected on a standing dummy', firstKind === 'stationary' && firstKindAt <= 120,
    `${firstKind || 'none'} at frame ${firstKindAt}`);
  check('passive route takes three stocks inside its target frames', kos >= 3 && frames <= PASSIVE_TARGET_FRAMES,
    `${kos} KOs in ${frames} frames, target ${PASSIVE_TARGET_FRAMES}; CPU stocks ${s.fighters[0].stocks}`);
}

// ---- 5. 1v2 positioning -------------------------------------------------------------------------
{
  const s = makeState(3, [0, 1, 1]);
  put(s, 0, 0, 1); put(s, 1, -70, 1); put(s, 2, 70, -1);
  const runner = new PlanRunner(prof, stage);
  const multi = NEUTRAL_FAMILIES[1];
  let offered = false;
  for (let k = 0; k < 300; k++) {
    if (k % 10 === 0) {
      const v = view(s, 0, 2);
      const out: PlanInstance[] = [];
      multi.generate(v, out);
      const p = out.find((x) => x.name === 'posOneSide');
      if (p !== undefined) { offered = true; runner.start(p, v); }
    }
    const all = inputs(3);
    runner.step(s, 0, all[0]);
    stepGame(s, all);
  }
  const me = s.fighters[0].x; const a = s.fighters[1].x; const b = s.fighters[2].x;
  const one = (me > a && me > b) || (me < a && me < b);
  check('1v2 positioning keeps both opponents on one side after 300 frames', offered && one && s.fighters[0].stocks === 3,
    `me ${me.toFixed(1)}, opponents ${a.toFixed(1)} and ${b.toFixed(1)}`);
}

// ---- 6. advantage abort on a third party -------------------------------------------------------
{
  const plan = new Plan().set('comboFollow', 'abortProbe', null, 2, 60, PF_ATTACK, 80, 3);
  const near = makeState(3, [0, 1, 1]);
  put(near, 0, 0, 1); put(near, 1, 25, -1); put(near, 2, -30, 1);
  const vn = view(near, 0, 1);
  const far = makeState(3, [0, 1, 1]);
  put(far, 0, 150, 1); put(far, 1, 175, -1); put(far, 2, -240, 1);
  const vf = view(far, 0, 1);
  const tn = thirdPartyThreat(vn); const tf = thirdPartyThreat(vf);
  check('advantage plan aborts when another opponent can reach us', advantageAbort(vn, plan, 40) && !advantageAbort(vf, plan, 20),
    `threat near ${tn}, far ${tf}`);
}

console.log(failures === 0 ? 'plans: all checks passed' : `plans: ${failures} failed`);
if (failures > 0) process.exitCode = 1;
