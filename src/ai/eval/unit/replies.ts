/**
 * Unit check for the reply model, zoning, tempo and the humanizer (W2.3, W2.8, W2.12, W2.14).
 * Run: npx --yes tsx src/ai/eval/unit/replies.ts
 *
 * Every zoning claim is checked by stepping the real sim on cloned states (MoveId literals are fine
 * here: this is a test, not brain code).
 */
import type { GameState, InputFrame, MatchConfig } from '../../../core/types';
import { Btn, DIRECT_CODES } from '../../../core/types';
import { CHARACTER_DEFS } from '../../../characters/registry';
import { cloneGameState, createGameState, stepGame } from '../../../sim';
import { STAGE_DEFS } from '../../../stages/registry';
import type { SimFighter } from '../../../sim/state';
import type {
  Affordances, DecisionView, Intent, LevelVector, Perceived, PlanCtx, ReplyModel, ShotProfile, Stimulus,
} from '../../contracts';
import { styleVector } from '../../archetypes';
import { getAiProfile } from '../../charprofile/derive';
import { deriveMatchup } from '../../charprofile/matchup';
import { place, stageGeo } from '../../charprofile/probeHit';
import { guideLevelS, levelVector, paramsFor } from '../../levels';
import { createPredictor } from '../../model/predictor';
import {
  RK, buildReplies, buildRepliesFor, buildReplySets, createReplySets, fixedShare, jointAt, jointCount, replyCap,
  sampleJoint, FIXED_FLOOR,
} from '../../model/replies';
import {
  ANS, NO_CHARGE_SHOT, NO_SHOT, chargeHoldAnalytic, answerProjectile, answerProjectileDetail, answerScript, chargeDecision,
  newAnswerDetail, shootSafe, shotCommit, shotHeal, zoneTerm, zoningGeo,
} from '../../zoning';
import { createTempoExt, shouldDecide, staleDecay, stepBudgetAt } from '../../tempo';
import {
  createHumanizerExt, lapsed, reactionDelay, reactionSample, resetReactionMemory, softmaxPick, timingOffset,
} from '../../humanizer';

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
const geo = stageGeo(STAGE_DEFS[STAGE]);
const prof = getAiProfile(CHAR, STAGE);
const mu = deriveMatchup(prof, prof, STAGE_DEFS[STAGE]);
const code = (name: string): number => (DIRECT_CODES as readonly string[]).indexOf(name) + 1;

function makeState(n: number, teams = false): GameState {
  const players: MatchConfig['players'] = [];
  for (let i = 0; i < n; i++) players.push({ slot: i, charId: CHAR, cpu: true, cpuLevel: 10, team: teams ? i & 1 : undefined });
  const cfg: MatchConfig = { stageId: STAGE, players, stocks: 3, timeLimitSec: 0, seed: 777, teams };
  const s = createGameState(cfg);
  const empty = players.map(() => ({ held: 0, pressed: 0, released: 0 }));
  for (let k = 0; k < 90; k++) stepGame(s, empty);
  return s;
}

function put(s: GameState, i: number, x: number, facing: 1 | -1, percent = 0): void {
  const f = s.fighters[i] as SimFighter;
  place(f, def, x, geo.top, true);
  f.facing = facing;
  f.percent = percent;
  f.inputHeld = 0;
}

function view(state: GameState, meI: number, oppI: number, level: LevelVector, seed = 4242): DecisionView {
  const p: Perceived = { state, meI, oppI, frame: state.frame, age: level.perceptionAge, ownDelay: 0, hyps: [],
    passivity: 0, framesSinceEdge: 0, framesSinceAttack: 0, newEvent: false };
  const style = styleVector('balanced', level.god);
  return { p, aff: {} as Affordances, me: prof, opp: prof, mu, level, style,
    pred: createPredictor(level), tempo: createTempoExt(style), seed, slot: state.fighters[meI].slot, stocksAhead: 0 };
}

const GOD = levelVector(1, true);
const LV = [0, 0.25, 0.5, 0.75, 1].map((s) => levelVector(s, false));

/** Steps `s` one frame with `held`/`direct` per fighter (pressed and released derived from `prev`). */
function stepWith(s: GameState, held: number[], direct: number[], prev: number[]): void {
  const inputs: InputFrame[] = [];
  for (let i = 0; i < s.fighters.length; i++) {
    inputs.push({ held: held[i], pressed: held[i] & ~prev[i], released: prev[i] & ~held[i], direct: direct[i] });
    prev[i] = held[i];
  }
  stepGame(s, inputs);
}

// ---- 1. reply sets: deterministic, capped, fixed floor --------------------------------------------
{
  const s = makeState(2);
  put(s, 0, geo.center - 60, 1); put(s, 1, geo.center + 60, -1);
  const sig = (set: readonly ReplyModel[], n: number): string =>
    set.slice(0, n).map((r) => `${r.name}:${r.weight.toFixed(9)}`).join(',');
  let det = true, capped = true, sums = true, floor = true;
  const details: string[] = [];
  for (const lv of [...LV, GOD]) {
    const a: ReplyModel[] = [], b: ReplyModel[] = [];
    const na = buildReplies(view(s, 0, 1, lv), a);
    const nb = buildReplies(view(s, 0, 1, lv), b);
    if (na !== nb || sig(a, na) !== sig(b, nb)) det = false;
    const cap = replyCap(lv);
    if (na > cap || na < 1) capped = false;
    let tot = 0;
    for (let i = 0; i < na; i++) tot += a[i].weight;
    if (Math.abs(tot - 1) > 1e-9) sums = false;
    if (fixedShare(a, na) < FIXED_FLOOR - 1e-9) floor = false;
    details.push(`s${lv.god ? 'god' : lv.s} n${na}/cap${cap}`);
  }
  check('reply sets are deterministic for the same view', det);
  check('reply sets are capped by the level (optionsCap, REPLY_MAX)', capped, details.join(' '));
  check('reply weights sum to 1', sums);
  check('at least 25% of the weight stays on the fixed set', floor);

  // Casual: 2 replies, the attack among them in neutral.
  const c: ReplyModel[] = [];
  const nc = buildReplies(view(s, 0, 1, LV[0]), c);
  check('casual neutral set keeps the attack reply', nc === 2 && c.some((r) => r.kind === RK.ATK), c.slice(0, nc).map((r) => r.name).join(','));

  // Situations: ledge hang gets ledge options, offstage gets recovery variants.
  const s2 = makeState(2);
  put(s2, 0, geo.center, 1);
  const o = s2.fighters[1] as SimFighter;
  place(o, def, geo.right + 60, geo.top + 40, false);
  const off: ReplyModel[] = [];
  const noff = buildRepliesFor(view(s2, 0, 1, GOD), 1, off, false, 12);
  check('off the stage the set is the recovery variants',
    noff === 4 && off.every((r) => r.kind === RK.REC || r.kind === RK.REC_E || r.kind === RK.REC_L || r.kind === RK.REC_AD),
    off.slice(0, noff).map((r) => r.name).join(','));

  // Several opponents: free for all with 4 fighters, and teams.
  const s4 = makeState(4);
  put(s4, 0, geo.center - 100, 1); put(s4, 1, geo.center + 40, -1); put(s4, 2, geo.center + 120, -1); put(s4, 3, geo.center - 180, 1);
  const sets = createReplySets(3);
  const v4 = view(s4, 0, 1, GOD);
  const n4 = buildReplySets(v4, sets);
  // Fighter 1 is the target; fighters 3 (80 px) and 2 (220 px) are the other live opponents.
  const setOf = (fi: number): number => { for (let i = 0; i < n4; i++) if (sets.fighter[i] === fi) return i; return -1; };
  const primary = sets.n[setOf(1)], second = sets.n[setOf(3)], third = sets.n[setOf(2)];
  check('free for all: primary full set, every other live opponent a half set',
    n4 === 3 && primary <= replyCap(GOD) && primary > second && second >= 2 && second <= (replyCap(GOD) >> 1) && third === second
      && sets.sets[setOf(2)][0].kind !== RK.CONT,
    `sizes ${primary}/${second}/${third}`);
  let jt = 0;
  const idx = new Int32Array(3);
  const jc = jointCount(sets);
  for (let j = 0; j < jc; j++) jt += jointAt(sets, j, idx);
  check('joint outcomes enumerate with weights summing to 1', jc === primary * second * third && Math.abs(jt - 1) < 1e-9,
    `${jc} outcomes, total ${jt.toFixed(9)}`);
  const i1 = new Int32Array(3), i2 = new Int32Array(3);
  let jsame = true;
  const p0 = sets.n[0];
  const hist = new Float64Array(p0);
  for (let k = 0; k < 4000; k++) {
    const w1 = sampleJoint(sets, 99, 0, 1234, k, i1);
    const w2 = sampleJoint(sets, 99, 0, 1234, k, i2);
    if (w1 !== w2 || i1[0] !== i2[0] || i1[1] !== i2[1] || i1[2] !== i2[2]) jsame = false;
    hist[i1[0]]++;
  }
  let histOk = true;
  for (let r = 0; r < p0; r++) if (Math.abs(hist[r] / 4000 - sets.sets[0][r].weight) > 0.03) histOk = false;
  check('joint sampling is deterministic and follows the weights', jsame && histOk,
    Array.from(hist).map((h, r) => `${(h / 4000).toFixed(2)}~${sets.sets[0][r].weight.toFixed(2)}`).join(' '));

  const st = makeState(4, true);
  put(st, 0, geo.center - 100, 1); put(st, 1, geo.center + 40, -1); put(st, 2, geo.center - 20, 1); put(st, 3, geo.center + 120, -1);
  (st.fighters[2] as SimFighter).inputHeld = Btn.Right | Btn.Shield;
  const vt = view(st, 0, 1, GOD);
  const setsT = createReplySets(3);
  const nt = buildReplySets(vt, setsT);
  let tIdx = -1;
  for (let i = 0; i < nt; i++) if (setsT.fighter[i] === 2) tIdx = i;
  const tr = tIdx >= 0 ? setsT.sets[tIdx][0] : null;
  const it: Intent = { held: 0, direct: 0, mash: 0 };
  const ctx: PlanCtx = { dir: 1, home: 0, edgeX: 0, fireAt: 0, param: 0, startFrame: 0, frame: 0, me: prof, stage: STAGE_DEFS[STAGE] };
  if (tr !== null) tr.step(0, st.fighters[2], st.fighters[0], ctx, it);
  check('teams: the teammate gets one "continue current input" reply',
    tIdx >= 0 && setsT.teammate[tIdx] === 1 && setsT.n[tIdx] === 1 && tr !== null && tr.kind === RK.TEAM
      && it.held === (Btn.Right | Btn.Shield),
    tr === null ? 'none' : `${tr.name} held ${it.held}`);
}

// ---- 2. shootSafe by forward sim ------------------------------------------------------------------
const orb: ShotProfile | undefined = prof.shots.find((x) => x.moveId === 'nspecial');
const crescent: ShotProfile | undefined = prof.shots.find((x) => x.moveId === 'sspecial');
check('profile has the orb and crescent shots', orb !== undefined && crescent !== undefined);

/** Independent sim: we fire `shot` at hold h, the opponent runs the attack reply; true when we are hit. */
function simHit(shot: ShotProfile, h: number, range: number, frames: number): boolean {
  const s = makeState(2);
  put(s, 0, geo.center - range / 2, 1); put(s, 1, geo.center + range / 2, -1);
  const v = view(s, 0, 1, GOD);
  const set: ReplyModel[] = [];
  const n = buildRepliesFor(v, 1, set, false, 12);
  const atk = set.slice(0, n).find((r) => r.kind === RK.ATK);
  if (atk === undefined) return false;
  const c = cloneGameState(s);
  const prev = [0, 0];
  const it: Intent = { held: 0, direct: 0, mash: 0 };
  const ctx: PlanCtx = { dir: 1, home: 0, edgeX: 0, fireAt: 0, param: 0, startFrame: 0, frame: 0, me: prof, stage: STAGE_DEFS[STAGE] };
  const pct0 = c.fighters[0].percent;
  const cb = def.moves[shot.moveId]?.chargeButton === 'special' ? Btn.Special : Btn.Attack;
  for (let t = 0; t < frames; t++) {
    atk.step(t, c.fighters[1], c.fighters[0], ctx, it);
    stepWith(c, [t <= h && h > 0 ? cb : 0, it.held], [t === 0 ? code(shot.moveId) : 0, it.direct], prev);
    for (const p of c.projectiles) if (p.owner === c.fighters[0].slot) p.alive = false;
    if (c.fighters[0].percent > pct0 || c.fighters[0].hitstun > 0) return true;
  }
  return false;
}

if (orb !== undefined) {
  const full = 60;
  const sClose = makeState(2);
  put(sClose, 0, geo.center - 40, 1); put(sClose, 1, geo.center + 40, -1);
  const rClose = shootSafe(view(sClose, 0, 1, GOD), orb, full, 80);
  const hitClose = simHit(orb, full, 80, shotCommit(orb, full) + 6);
  check('shootSafe refuses a full-charge orb from 80 px (punishable tail)', !rClose.safe && hitClose,
    `safe ${rClose.safe}, sim hit ${hitClose}, commit ${shotCommit(orb, full)}`);
  // Farthest room on the stage for a safe tap.
  const far = Math.floor(geo.right - geo.left - 40);
  let safeRange = -1;
  let rFar = { safe: false, safeIfAnswered: false };
  for (let r = 160; r <= far; r += 20) {
    const sFar = makeState(2);
    put(sFar, 0, geo.center - r / 2, 1); put(sFar, 1, geo.center + r / 2, -1);
    rFar = shootSafe(view(sFar, 0, 1, GOD), orb, 0, r);
    if (rFar.safe) { safeRange = r; break; }
  }
  const hitFar = safeRange > 0 ? simHit(orb, 0, safeRange, shotCommit(orb, 0) + 6) : true;
  check('shootSafe allows a tap orb from range, and the sim agrees', safeRange > 0 && !hitFar,
    `safe from ${safeRange} px, sim hit ${hitFar}, commit ${shotCommit(orb, 0)}`);
  check('the drain heal of the orb is known', shotHeal(orb, 60) > shotHeal(orb, 0) && shotHeal(orb, 0) > 0,
    `${f2(shotHeal(orb, 0))} / ${f2(shotHeal(orb, 60))}`);
}

// ---- 3. chargeDecision: intermediate holds, level shapes ------------------------------------------
if (orb !== undefined) {
  const holds: number[] = [];
  const res: string[] = [];
  let l1None = true, l3Shape = true, l4Shape = true;
  for (let d = 100; d <= 320; d += 20) {
    const s = makeState(2);
    put(s, 0, geo.center - d / 2, 1); put(s, 1, geo.center + d / 2, -1);
    const hG = chargeDecision(view(s, 0, 1, GOD), orb, d, 1);
    const hHalf = chargeDecision(view(s, 0, 1, GOD), orb, d, 0.5);
    holds.push(hG, hHalf);
    res.push(`${d}:${hG}/${hHalf}`);
    if (chargeDecision(view(s, 0, 1, LV[0]), orb, d, 1) !== NO_SHOT) l1None = false;
    const h3 = chargeDecision(view(s, 0, 1, LV[2]), orb, d, 1);
    if (h3 >= 0 && h3 !== 0 && h3 !== 60) l3Shape = false;
    const h4 = chargeDecision(view(s, 0, 1, LV[3]), orb, d, 1);
    if (h4 >= 0 && h4 % 15 !== 0) l4Shape = false;
  }
  check('god chargeDecision uses an intermediate hold somewhere', holds.some((h) => h > 0 && h < 60), res.join(' '));
  // Explicit threat numbers (an opponent at 4 px/f, 280 px away): the hold moves with the share used.
  const slow = { react: 5, reach: 40, startup: 10, speed: 4, halfWidth: 13 };
  const hA = chargeHoldAnalytic(orb, 280, slow, 6, 0), hB = chargeHoldAnalytic(orb, 280, slow, 6, 0.8),
    hC = chargeHoldAnalytic(orb, 280, slow, 6, 1);
  check('intermediate holds: the smallest reaching hold, a middle one and the longest safe one',
    hA > 0 && hA < hB && hB < hC && hC < 60 && orb.range(hA) >= 280 - 13 && shotCommit(orb, hC) + 6 <= 5 + 240 / 4 + 10 && shotCommit(orb, hC + 1) + 6 > 5 + 240 / 4 + 10,
    `${hA} / ${hB} / ${hC}`);
  check('chargeDecision returns only holds, NO_SHOT or NO_CHARGE_SHOT',
    holds.every((h) => h === NO_SHOT || h === NO_CHARGE_SHOT || (h >= 0 && h <= 60)));
  check('level 1 never shoots; level 3 holds tap or full; level 4 holds in steps of 15', l1None && l3Shape && l4Shape);
}

// ---- 4. answerProjectile per strength tier at three distances --------------------------------------
interface Tier { name: string; move: string; hold: number; strength: number; dists: number[] }
const TIERS: Tier[] = [
  { name: 'jabDrop', move: 'jab', hold: 0, strength: 1, dists: [50, 58, 66] },
  { name: 'tap orb', move: 'nspecial', hold: 0, strength: 2, dists: [80, 130, 180] },
  { name: 'crescent', move: 'sspecial', hold: 0, strength: 4, dists: [80, 140, 200] },
  { name: 'full orb', move: 'nspecial', hold: 60, strength: 10, dists: [120, 210, 300] },
];

/** The opponent (slot 1) starts its shot; returns the state `lead` frames before the shot spawns. */
function throwState(t: Tier, d: number, lead: number): GameState | null {
  const s = makeState(2);
  put(s, 0, geo.center - d / 2, 1); put(s, 1, geo.center + d / 2, -1);
  const prev = [0, 0];
  const cb = def.moves[t.move as 'jab']?.chargeButton === 'special' ? Btn.Special : Btn.Attack;
  // Find the spawn frame on a scratch copy first.
  let spawnAt = -1;
  {
    const c = cloneGameState(s);
    const pv = [0, 0];
    for (let k = 0; k < 120 && spawnAt < 0; k++) {
      stepWith(c, [0, k <= t.hold && t.hold > 0 ? cb : 0], [0, k === 0 ? code(t.move) : 0], pv);
      if (c.projectiles.some((p) => p.alive && p.owner === c.fighters[1].slot)) spawnAt = k;
    }
  }
  if (spawnAt < 0) return null;
  const stop = spawnAt - lead;
  for (let k = 0; k < stop; k++) stepWith(s, [0, k <= t.hold && t.hold > 0 ? cb : 0], [0, k === 0 ? code(t.move) : 0], prev);
  (s.fighters[1] as SimFighter).inputHeld = prev[1];
  return s;
}

/** Steps a clone with our answer script and the opponent releasing; true when we take no damage. */
function answerHolds(s: GameState, d: ReturnType<typeof newAnswerDetail>, holdOpp: number, frames: number): boolean {
  const c = cloneGameState(s);
  const prev = [0, c.fighters[1].inputHeld];
  const it: Intent = { held: 0, direct: 0, mash: 0 };
  const g = zoningGeo(STAGE);
  const pct0 = c.fighters[0].percent;
  for (let t = 0; t < frames; t++) {
    answerScript(d, t, c.fighters[0], g, it);
    stepWith(c, [it.held, t < holdOpp ? prev[1] : 0], [it.direct, 0], prev);
    if (c.fighters[0].percent > pct0 + 1e-9 || c.fighters[0].hitstun > 0) return false;
  }
  return true;
}

{
  const lines: string[] = [];
  let allOk = true, anyThreat = 0;
  for (const t of TIERS) {
    for (const d of t.dists) {
      const s = throwState(t, d, 2);
      if (s === null) { allOk = false; lines.push(`${t.name}@${d}: no spawn`); continue; }
      const holdLeft = t.hold > 0 ? t.hold + 1 - s.frame : 0;
      const v = view(s, 0, 1, GOD);
      const det = newAnswerDetail();
      const fam = answerProjectileDetail(v, det);
      const fam2 = answerProjectile(view(s, 0, 1, GOD));
      // Doing nothing: is the shot a real threat?
      const idle = newAnswerDetail();
      const eatSafe = answerHolds(s, idle, holdLeft > 0 ? holdLeft : 0, 120);
      let ok: boolean;
      if (fam === null) ok = eatSafe;                                   // nothing reaches us: no answer needed
      else {
        anyThreat += eatSafe ? 0 : 1;
        // Through the first pass of the shot (a returning shot is answered again by the next decision).
        ok = det.works && det.kind !== ANS.EAT && answerHolds(s, det, holdLeft > 0 ? holdLeft : 0, det.tEnd + 20) && fam === fam2;
      }
      if (!ok) allOk = false;
      lines.push(`${t.name}@${d}: ${fam ?? 'none'}${fam !== null ? `(k${det.kind} st${det.startIn} hit${det.tHit} str${det.strength})` : ''} idle-safe ${eatSafe} ${ok ? 'ok' : 'BAD'}`);
    }
  }
  for (const l of lines) console.log(`  ${l}`);
  check('answerProjectile picks a working answer per tier at three distances (sim verified)', allOk && anyThreat >= 8,
    `${anyThreat} real threats`);
}

// ---- 5. zone term -----------------------------------------------------------------------------------
{
  const s = throwState(TIERS[1], 200, -3);
  if (s !== null) {
    // Our shot is slot 1's here: look from fighter 1 at fighter 0.
    const z0 = zoneTerm(s, 1, 0, 0), zHi = zoneTerm(s, 1, 0, 0.8), zOpp = zoneTerm(s, 0, 1, 0);
    check('zone term counts own shots in the lane, off at high pressure', z0 > 0 && zHi === 0 && zOpp === 0,
      `${f2(z0)} ${f2(zHi)} ${f2(zOpp)}`);
  } else check('zone term setup', false);
}

// ---- 6. tempo: engagement clock, anti-stall, staleness, cycles, cadence -----------------------------
{
  const s = makeState(2);
  put(s, 0, geo.center - 150, 1); put(s, 1, geo.center + 150, -1);
  const tp = createTempoExt(styleVector('balanced', false));
  tp.setPassivity(0);
  const T0 = tp.t0();
  const f0 = s.frame;
  let pAtT0 = -1, pMid = -1, pEnd = -1;
  for (let k = 0; k <= 2 * T0; k++) {
    s.frame = f0 + k;
    tp.update(s, 0, 1);
    if (k === T0) pAtT0 = tp.pressure();
    if (k === Math.round(1.5 * T0)) pMid = tp.pressure();
  }
  pEnd = tp.pressure();
  check('engagement clock: pressure 0 at T0, 0.5 at 1.5 T0, 1 at 2 T0 when apart',
    pAtT0 === 0 && Math.abs(pMid - 0.5) < 0.01 && pEnd === 1, `${f2(pAtT0)} ${f2(pMid)} ${f2(pEnd)}`);
  put(s, 1, geo.center - 100, -1);
  s.frame++;
  tp.update(s, 0, 1);
  check('the clock resets on contact', tp.clock() === 0 && tp.pressure() < 0.5, `clock ${tp.clock()}`);
  // Anti-stall: close but no damage for 20 s raises pressure to at least 0.5.
  const tp2 = createTempoExt(styleVector('balanced', false));
  tp2.setPassivity(0);
  for (let k = 0; k < 1300; k++) { s.frame++; tp2.update(s, 0, 1); }
  check('anti-stall: no damage for 20 s gives pressure >= 0.5 even in contact', tp2.clock() === 0 && tp2.pressure() >= 0.5,
    `clock ${tp2.clock()} p ${f2(tp2.pressure())}`);
  // Passivity shortens T0.
  const tp3 = createTempoExt(styleVector('balanced', false));
  tp3.setPassivity(1);
  check('a passive opponent shortens T0 to 20%', Math.abs(tp3.t0() - 0.2 * T0) < 1e-9, `${f2(tp3.t0())}`);
  // Staleness decays 0.9 per 12 frames.
  tp.used('poke', s.frame);
  const st0 = tp.stale('poke');
  s.frame += 12; tp.update(s, 0, 1);
  check('staleness decays 0.9 per 12 frames', Math.abs(st0 - 1) < 1e-12 && Math.abs(tp.stale('poke') - 0.9) < 1e-9
    && Math.abs(staleDecay(24) - 0.81) < 1e-9, `${tp.stale('poke').toFixed(4)}`);
  // Cycle: a b a b a b at the same distance with no damage.
  const tp4 = createTempoExt(styleVector('balanced', false));
  put(s, 1, geo.center + 150, -1);
  for (let k = 0; k < 6; k++) { s.frame += 10; tp4.update(s, 0, 1); tp4.used(k % 2 === 0 ? 'a' : 'b', s.frame); }
  check('cycle detector fires on a repeated period-2 loop and penalizes it', tp4.cycle() && tp4.cyclePenalty('a') > 0,
    `penalty ${f2(tp4.cyclePenalty('a'))}`);
  // Cadence.
  const base = { planEnded: false, interruptible: true, recovering: false, runFrames: 0, newEvent: false, sinceDecision: 0 };
  const L1 = LV[0], L5 = LV[4];
  check('cadence: plan end decides; casual waits its plan hold, god replans fast',
    shouldDecide({ ...base, planEnded: true }, L1)
      && !shouldDecide({ ...base, runFrames: 10, sinceDecision: 10 }, L1)
      && shouldDecide({ ...base, runFrames: 24, sinceDecision: 24 }, L1)
      && shouldDecide({ ...base, runFrames: 3, sinceDecision: 3 }, GOD)
      && !shouldDecide({ ...base, runFrames: 8, sinceDecision: 8 }, L5)
      && shouldDecide({ ...base, runFrames: 10, sinceDecision: 10 }, L5)
      && shouldDecide({ ...base, newEvent: true, sinceDecision: 3 }, L1)
      && !shouldDecide({ ...base, interruptible: false, runFrames: 99, sinceDecision: 99 }, GOD));
  check('step budget ramps at match start', stepBudgetAt(GOD, 10) === 600 && stepBudgetAt(GOD, 400) === GOD.stepBudget);
}

// ---- 7. humanizer ------------------------------------------------------------------------------------
{
  const N = 10000;
  const TABLE_PRIMED = [16, 15, 14, 13];
  const TABLE_ONE_BIT = [30, 25, 21.5, 18.5];
  let floorOk = true, meanOk = true;
  const out: string[] = [];
  for (let L = 1; L <= 4; L++) {
    const lv = levelVector(guideLevelS('aggressive', L as 1 | 2 | 3 | 4), false);
    resetReactionMemory();
    let sumP = 0, sumB = 0, minR = Infinity;
    for (let i = 0; i < N; i++) {
      const st: Stimulus = { key: i + 1, frame: 100 + i * 20, bits: 0, pCue: 1, stress: 0, alert: false };
      const r = reactionDelay(st, lv, 31337, 0);
      const st1: Stimulus = { key: i + 1, frame: 100 + i * 20, bits: 1, pCue: 0, stress: 0, alert: false };
      const r1 = reactionSample(st1, lv, 31337, 1);
      sumP += r; sumB += r1;
      if (r < minR) minR = r;
      if (r1 < minR) minR = r1;
    }
    const mP = sumP / N, mB = sumB / N;
    if (minR < lv.reactFloor || lv.reactFloor < 10) floorOk = false;
    if (Math.abs(mP - TABLE_PRIMED[L - 1]) > 1 || Math.abs(mB - TABLE_ONE_BIT[L - 1]) > 1) meanOk = false;
    out.push(`L${L} primed ${f2(mP)}~${TABLE_PRIMED[L - 1]} 1bit ${f2(mB)}~${TABLE_ONE_BIT[L - 1]} min ${minR}`);
  }
  check('levels 1 to 4: reaction delays never under the human floor', floorOk);
  check('levels 1 to 4: mean reaction within 1 frame of the 03 table (10,000 draws)', meanOk, out.join('; '));
  resetReactionMemory();
  const stA: Stimulus = { key: 7, frame: 500, bits: 1, pCue: 0.2, stress: 0.5, alert: false };
  const a1 = reactionDelay(stA, LV[1], 5, 2), a2 = reactionDelay(stA, LV[1], 5, 2);
  check('one event gets one delay', a1 === a2);
  const stB: Stimulus = { key: 8, frame: 503, bits: 1, pCue: 0.2, stress: 0.5, alert: false };
  check('a second event within 9 frames pays the refractory cost',
    reactionDelay(stB, LV[1], 5, 2) >= reactionSample(stB, LV[1], 5, 2));

  // Jitter and lapses at level 1: presses delayed or dropped then repeated, never invented.
  const h1 = createHumanizerExt(9, 0);
  const inI: Intent = { held: 0, direct: 0, mash: 0 }, outI: Intent = { held: 0, direct: 0, mash: 0 };
  let inPress = 0, outPress = 0, prevIn = 0, prevOut = 0, delayed = 0, invented = false, everHeld = 0;
  for (let f = 0; f < 6000; f++) {
    inI.held = (f % 20) < 3 ? Btn.Attack : 0;
    h1.apply(inI, f, 3, LV[0], outI);
    everHeld |= inI.held;
    if ((inI.held & ~prevIn & Btn.Attack) !== 0) inPress++;
    if ((outI.held & ~prevOut & Btn.Attack) !== 0) outPress++;
    if ((outI.held & ~everHeld) !== 0) invented = true;
    if ((inI.held & Btn.Attack) !== 0 && (outI.held & Btn.Attack) === 0) delayed++;
    prevIn = inI.held; prevOut = outI.held;
  }
  check('level 1 humanizer delays presses and never invents one', delayed > 0 && !invented && outPress <= inPress + 1,
    `in ${inPress} out ${outPress} held-back frames ${delayed}`);
  let lapses = 0, sd = 0;
  for (let f = 0; f < N; f++) {
    if (lapsed(LV[0], 3, 0, f)) lapses++;
    const o = timingOffset(LV[0], 3, 0, f, 3);
    sd += o * o;
  }
  check('level 1 lapse rate and timing SD match the 03 table', Math.abs(lapses / N - 0.04) < 0.008 && Math.abs(Math.sqrt(sd / N) - 3.0) < 0.2,
    `lapse ${(lapses / N).toFixed(3)} sd ${f2(Math.sqrt(sd / N))}`);
  check('advanced and up: 12-frame windows get no jitter', timingOffset(LV[2], 3, 0, 5, 12) === 0 && timingOffset(LV[4], 3, 0, 5, 20) === 0);
  // Temperature.
  const vals = [10, 9.9, 5, 1];
  let hot = 0;
  for (let k = 0; k < 1000; k++) if (softmaxPick(vals, 4, LV[0].tau, 1, 0, k) !== 0) hot++;
  check('temperature spreads the casual pick over near-best plans; tau 0 is argmax',
    hot > 100 && softmaxPick(vals, 4, 0, 1, 0, 5) === 0, `non-best ${hot}/1000`);

  // God and level 5 (balanced level 5 is the god column): identity.
  const godVecs = [GOD, paramsFor({ archetype: 'balanced', level: 5, god: true, s: guideLevelS('balanced', 5) }).level];
  let ident = true;
  for (const gv of godVecs) {
    const hg = createHumanizerExt(1, 3);
    for (let f = 0; f < 5000; f++) {
      inI.held = ((f * 2654435761) >>> 7) & 0xffff; inI.direct = f % 7 === 0 ? (f % 23) : 0; inI.mash = f % 5 === 0 ? 1 : 0;
      hg.apply(inI, f, 1, gv, outI);
      if (outI.held !== inI.held || outI.direct !== inI.direct || outI.mash !== inI.mash) ident = false;
      if (hg.decisionError(gv, f)) ident = false;
      if (timingOffset(gv, 1, 3, f, 1) !== 0 || lapsed(gv, 1, 3, f)) ident = false;
    }
    const r = reactionDelay({ key: 1, frame: 10, bits: 3, pCue: 0, stress: 1, alert: false }, gv, 1, 3);
    if (r !== gv.perceptionAge) ident = false;
  }
  check('god and level 5 humanizer is the identity', ident);
  // The guard sits after the humanizer (03 section 4).
  check('mash is gated at the level rate (none at L1, every 12 at advanced)', (() => {
    const hm = createHumanizerExt(2, 0);
    hm.setLevel(LV[0]);
    if (hm.mashAllowed(100)) return false;
    hm.setLevel(LV[2]);
    return hm.mashAllowed(100) && !hm.mashAllowed(105) && hm.mashAllowed(112);
  })());
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
