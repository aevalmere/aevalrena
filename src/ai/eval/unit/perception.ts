/**
 * Unit checks for perception, affordances and targets (W2.1, W2.2, W2.15): the delayed view, the
 * no-leak property, hidden-frame hypotheses for a jumping opponent, the sandwich read with two
 * flanking opponents, and target switching (kill percent, whiff punish, teammates never targeted).
 * Run: npx --yes tsx src/ai/eval/unit/perception.ts (exit code 1 on any failure).
 */
import type { GameState, InputFrame, MatchConfig, MoveId } from '../../../core/types';
import { Btn } from '../../../core/types';
import { createGameState, stepGame } from '../../../sim';
import type { SimFighter } from '../../../sim/state';
import { STAGE_DEFS } from '../../../stages/registry';
import { levelVector } from '../../levels';
import { u01 } from '../../rng';
import { createPredictorBank } from '../../model/predictor';
import { stageGeo } from '../../charprofile/probeHit';
import { createPerception, newPerceived } from '../../perception';
import {
  affordancesFor, canGetBack, classifySituation, newAffordances, newTeamThreat, profileFor, teamThreat, trueCombo,
} from '../../affordances';
import { createTargeter, RETARGET_FRAMES } from '../../targets';
import { hashState } from '../replay';

declare const process: { stdout: { write(text: string): void }; exitCode?: number; memoryUsage?: () => { heapUsed: number } };

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? `: ${detail}` : ''}\n`);
}

const STAGE = 'hearthmoor';
const GEO = stageGeo(STAGE_DEFS[STAGE]);
const GOD = levelVector(1, true);
const P = GOD.perceptionAge;

function config(n: number, teams: number[] | null, seed = 7): MatchConfig {
  const players: MatchConfig['players'] = [];
  for (let i = 0; i < n; i++) {
    const p: MatchConfig['players'][number] = { slot: i, charId: 'aeval', cpu: true, cpuLevel: 9 };
    if (teams !== null) p.team = teams[i];
    players.push(p);
  }
  return { stageId: STAGE, players, stocks: 3, timeLimitSec: 0, seed, teams: teams !== null };
}

function inputs(n: number): InputFrame[] {
  const a: InputFrame[] = [];
  for (let i = 0; i < n; i++) a.push({ held: 0, pressed: 0, released: 0, direct: 0 });
  return a;
}

function setInput(inp: InputFrame, prevHeld: number, held: number): void {
  inp.held = held; inp.pressed = held & ~prevHeld; inp.released = prevHeld & ~held; inp.direct = 0;
}

function place(f: SimFighter, x: number): void {
  f.x = x; f.y = GEO.top; f.vx = 0; f.vy = 0; f.onGround = true; f.action = 'idle'; f.actionFrame = 0;
  f.moveId = null; f.hitstun = 0; f.hitlag = 0; f.invuln = 0; f.highDodge = 0; f.respawnTimer = 0;
  f.facing = x < GEO.center ? 1 : -1;
}

/** Steps a few idle frames so spawn landing settles. */
function settle(s: GameState, frames: number): void {
  const inp = inputs(s.fighters.length);
  for (let i = 0; i < frames; i++) stepGame(s, inp);
}

// ---- 1. delayed view: S(now - 4) exactly; own fighter exact; a fresh opponent input stays hidden ----
{
  const s = createGameState(config(2, null));
  settle(s, 30);
  const per = createPerception(s, 8);
  const pred = createPredictorBank(GOD);
  const out = newPerceived();
  const hashes: string[] = [];
  const inp = inputs(2);
  let prev0 = 0; let prev1 = 0;
  let snapOk = true; let ownOk = true; let hiddenOk = true; let ageOk = true; let hiddenChecked = 0;
  for (let t = 0; t < 240; t++) {
    per.observe(s, 0);
    hashes[s.frame] = hashState(s);
    if (t >= P) {
      const d = per.delayedAt(s.frame - P);
      if (d === null || hashState(d) !== hashes[s.frame - P]) snapOk = false;
      per.view(s, 0, 1, GOD, pred, out);
      if (out.age !== P || out.delayed === null || out.delayed.frame !== s.frame - P) ageOk = false;
      const a = out.state.fighters[0]; const b = s.fighters[0];
      if (a.x !== b.x || a.y !== b.y || a.action !== b.action || a.actionFrame !== b.actionFrame || a.percent !== b.percent) ownOk = false;
      // Opponent pressed jump 2 frames ago (inputs applied at frames t % 60 === 58): real shows it, view must not.
      const realOpp = s.fighters[1];
      if (realOpp.action === 'jumpsquat' && realOpp.actionFrame <= 1) {
        hiddenChecked++;
        if (out.state.fighters[1].action === 'jumpsquat') hiddenOk = false;
      }
    }
    // Me walks right and left; opponent jumps every 60 frames.
    const h0 = (t % 80) < 40 ? Btn.Right : Btn.Left;
    const h1 = t % 60 === 0 ? Btn.Jump : 0;
    setInput(inp[0], prev0, h0); setInput(inp[1], prev1, h1);
    prev0 = h0; prev1 = h1;
    stepGame(s, inp);
  }
  check('4-frame delayed snapshot equals the real state of 4 frames ago (hash)', snapOk);
  check('view age is P = 4 and exposes the delayed snapshot', ageOk, `P ${P}`);
  check('own fighter is exact in the view', ownOk);
  check('an opponent jump younger than P is not in the view', hiddenOk && hiddenChecked > 0, `${hiddenChecked} cases`);
}

// ---- 1b. no-leak property: changing the opponent's last P inputs never changes its view ----
{
  let ok = true; let cases = 0;
  const pred = createPredictorBank(GOD);
  for (let seed = 1; seed <= 60; seed++) {
    const a = createGameState(config(2, null, seed));
    const b = createGameState(config(2, null, seed));
    settle(a, 20); settle(b, 20);
    place(a.fighters[0] as SimFighter, GEO.left + 40); place(b.fighters[0] as SimFighter, GEO.left + 40);
    place(a.fighters[1] as SimFighter, GEO.right - 40); place(b.fighters[1] as SimFighter, GEO.right - 40);
    const pa = createPerception(a, 8); const pb = createPerception(b, 8);
    const oa = newPerceived(); const ob = newPerceived();
    const ia = inputs(2); const ib = inputs(2);
    let pa1 = 0; let pb1 = 0;
    const T = 40 + Math.floor(u01(seed, 0, 0, 1) * 30);
    for (let t = 0; t <= T; t++) {
      pa.observe(a, 0); pb.observe(b, 0);
      if (t === T) {
        pa.view(a, 0, 1, GOD, pred, oa); pb.view(b, 0, 1, GOD, pred, ob);
        const x = oa.state.fighters[1]; const y = ob.state.fighters[1];
        cases++;
        if (x.x !== y.x || x.y !== y.y || x.action !== y.action || x.actionFrame !== y.actionFrame || x.vx !== y.vx) ok = false;
        break;
      }
      const bits = [0, Btn.Left, Btn.Right, Btn.Jump, Btn.Attack, Btn.Shield, Btn.Left | Btn.Jump];
      const hA = bits[Math.floor(u01(seed, 1, t, 2) * bits.length)];
      // In the last P frames the second world's opponent does something else.
      const hB = t >= T - P ? bits[Math.floor(u01(seed, 2, t, 3) * bits.length)] : hA;
      setInput(ia[1], pa1, hA); setInput(ib[1], pb1, hB);
      pa1 = hA; pb1 = hB;
      stepGame(a, ia); stepGame(b, ib);
    }
  }
  check('opponent view is independent of its last P inputs (60 seeds)', ok && cases === 60, `${cases} cases`);
}

// ---- 2. hypotheses cover the hidden frames for a jumping opponent ----
{
  const s = createGameState(config(2, null, 11));
  settle(s, 30);
  place(s.fighters[0] as SimFighter, GEO.center - 120);
  place(s.fighters[1] as SimFighter, GEO.center + 60);
  const per = createPerception(s, 8);
  const pred = createPredictorBank(GOD);
  const out = newPerceived();
  const inp = inputs(2);
  let prev1 = 0;
  let jumpStart = -1;
  let covered = 0; let tested = 0; let sumOk = true; let capOk = true; let noneFirst = true;
  const missing: string[] = [];
  for (let t = 0; t < 1500; t++) {
    per.observe(s, 0);
    pred.observe(s, 0, 1, s.frame);
    const o = s.fighters[1];
    if (o.action === 'jumpsquat' && o.actionFrame === 0) jumpStart = s.frame;
    if (t > 60) {
      per.view(s, 0, 1, GOD, pred, out);
      let sum = 0;
      for (let i = 0; i < out.hyps.length; i++) sum += out.hyps[i].weight;
      if (Math.abs(sum - 1) > 1e-9) sumOk = false;
      if (out.hyps.length > 6 || out.hyps.length < 1) capOk = false;
      if (out.hyps[0].kind !== 'none') noneFirst = false;
      const realAgo = jumpStart >= 0 ? s.frame - jumpStart + 1 : -1;
      if (t > 900 && realAgo >= 1 && realAgo <= P) {
        tested++;
        let hit = false;
        for (let i = 0; i < out.hyps.length; i++) if (out.hyps[i].kind === 'jump' && out.hyps[i].ago === realAgo) hit = true;
        if (hit) covered++;
        else if (missing.length < 3) missing.push(`ago ${realAgo}: ${out.hyps.map((h) => `${h.kind}${h.move ?? ''}@${h.ago}`).join(' ')}`);
      }
    }
    // Opponent: a jump every 24 frames when grounded, otherwise nothing.
    const h1 = t % 24 === 0 && o.onGround ? Btn.Jump : 0;
    setInput(inp[1], prev1, h1);
    prev1 = h1;
    stepGame(s, inp);
  }
  check('hypotheses sum to 1, at most 6 kept, "nothing new" first', sumOk && capOk && noneFirst);
  check('a jump started inside the hidden window is among the hypotheses at its true age', tested > 0 && covered === tested,
    `${covered}/${tested}${missing.length > 0 ? `; ${missing.join(' | ')}` : ''}`);
}

// ---- 3. affordances: sandwich with two flanking opponents ----
{
  const s = createGameState(config(3, [0, 1, 1]));
  settle(s, 30);
  const me = s.fighters[0] as SimFighter;
  place(me, GEO.center);
  place(s.fighters[1] as SimFighter, GEO.center - 50);
  place(s.fighters[2] as SimFighter, GEO.center + 55);
  const tt = newTeamThreat();
  teamThreat(s, 0, tt);
  check('two flanking opponents: sandwich flagged', tt.sandwich && tt.sandwichRisk >= 0.5 && tt.n === 2,
    `risk ${tt.sandwichRisk.toFixed(2)}, side ${tt.threatSide.toFixed(2)}, frames ${tt.opps[0].threatFrames.toFixed(1)}/${tt.opps[1].threatFrames.toFixed(1)}`);
  check('flanked evenly: threatSide near 0, not one-sided', Math.abs(tt.threatSide) < 0.3 && !tt.oneSided);
  // Through the perception and affordance path too.
  const per = createPerception(s, 8);
  const out = newPerceived();
  const aff = newAffordances();
  for (let i = 0; i < 6; i++) { per.observe(s, 0); settle(s, 1); }
  place(me, GEO.center);
  place(s.fighters[1] as SimFighter, GEO.center - 50);
  place(s.fighters[2] as SimFighter, GEO.center + 55);
  for (let i = 0; i < 6; i++) { per.observe(s, 0); settle(s, 1); }
  per.view(s, 0, 1, GOD, createPredictorBank(GOD), out);
  affordancesFor(out, aff);
  check('computeAffordances: neutral, sandwich in the team block, 2 opponents, 0 teammates',
    aff.situation === 'neutral' && aff.team.sandwich && out.nOpps === 2 && out.nMates === 0,
    `${aff.situation}, sandwich ${aff.team.sandwich}, opps ${out.nOpps}`);
  place(s.fighters[2] as SimFighter, GEO.right - 10);
  s.fighters[2].x = GEO.center + 420;
  teamThreat(s, 0, tt);
  check('one flanker leaves: no sandwich, threat from the left', !tt.sandwich && tt.threatSide < -0.5,
    `risk ${tt.sandwichRisk.toFixed(2)}, side ${tt.threatSide.toFixed(2)}`);
  check('free space and one-side spot are on the stage', tt.freeX >= GEO.left && tt.freeX <= GEO.right
    && (Number.isNaN(tt.oneSideX) || (tt.oneSideX >= GEO.left && tt.oneSideX <= GEO.right)));
}

// ---- 3b. canGetBack and trueCombo sanity ----
{
  const s = createGameState(config(2, null));
  settle(s, 30);
  const work = createGameState(config(2, null));
  const prof = profileFor('aeval', STAGE);
  const f = s.fighters[1] as SimFighter;
  place(s.fighters[0] as SimFighter, GEO.center);
  place(f, GEO.center + 100);
  const onStage = canGetBack(s, 1, prof, work);
  f.onGround = false; f.action = 'air'; f.x = GEO.right + 40; f.y = GEO.top + 30; f.jumpsLeft = 1; f.airDodgeUsed = false;
  const near = canGetBack(s, 1, prof, work);
  f.x = GEO.right + 700; f.y = GEO.top + 380; f.jumpsLeft = 0; f.airDodgeUsed = true; f.action = 'airHelpless';
  const far = canGetBack(s, 1, prof, work);
  check('canGetBack: on stage yes, just off the ledge yes, far below and spent no', onStage > 0 && near > 0 && far < 0,
    `${onStage}, ${near.toFixed(0)}, ${far.toFixed(0)}`);
  check('classifySituation: opponent offstage and helpless is advantage', classifySituation(s, 0, 1) === 'advantage');
  // Opponent in long hitstun right next to the CPU: jab connects; standing idle far away: nothing true.
  place(f, GEO.center + 20);
  f.action = 'hitstun'; f.hitstun = 40;
  const ids = Object.keys(prof.moves) as MoveId[];
  let fastest: MoveId = ids[0];
  for (const id of ids) {
    const m = prof.moves[id];
    if (m.maxDamage > 0 && m.startup >= 0 && m.reach.front >= 20 && (prof.moves[fastest].maxDamage <= 0 || m.startup < prof.moves[fastest].startup)) fastest = id;
  }
  (s.fighters[0] as SimFighter).facing = 1;
  const tc = trueCombo(s, 0, 1, fastest, work);
  place(f, GEO.center + 150);
  const notTc = trueCombo(s, 0, 1, fastest, work);
  check('trueCombo: fastest move into 40 frames of hitstun is true, into an idle opponent is not', tc >= 1 && notTc < 1,
    `${fastest}: ${tc}, ${notTc}`);
}

// ---- 4. targeter: kill percent, whiff punish, teammates never targeted, hysteresis ----
{
  // me 0 and mate 1 on team 0; opponents 2 and 3 on team 1.
  const s = createGameState(config(4, [0, 0, 1, 1]));
  settle(s, 30);
  const fs = s.fighters as SimFighter[];
  place(fs[0], GEO.center);
  place(fs[1], GEO.center + 60);           // teammate right next to the CPU
  place(fs[2], GEO.center - 150);          // A: nearest opponent
  place(fs[3], GEO.center + 260);          // B: farther
  const tg = createTargeter();
  let frame = 1000;
  const first = tg.pick(s, 0, frame);
  check('targeter: nearest opponent first, never the teammate', first === 2, `picked ${first}, reason ${tg.info().reason}`);
  // Without an event, a closer B inside 30 frames does not flip the target.
  fs[3].x = GEO.center + 100;
  const held = tg.pick(s, 0, ++frame);
  check('no flip inside 30 frames without a new event', held === 2);
  fs[3].x = GEO.center + 260;
  // B enters kill range: switch at once.
  fs[3].percent = 230;
  const kill = tg.pick(s, 0, ++frame);
  check('switches to the opponent that enters kill range', kill === 3 && tg.info().reason === 'kill', `picked ${kill}, ${tg.info().reason}`);
  // A whiffs a slow move next to the CPU: switch to the punishable one.
  const prof = profileFor('aeval', STAGE);
  const ids = Object.keys(prof.moves) as MoveId[];
  let slow: MoveId = ids[0];
  for (const id of ids) {
    const m = prof.moves[id];
    if (m.maxDamage > 0 && m.endlag > prof.moves[slow].endlag) slow = id;
  }
  fs[2].x = GEO.center - 45;
  fs[2].action = 'attack'; fs[2].moveId = slow; fs[2].actionFrame = prof.moves[slow].activeEnd + 1;
  const pun = tg.pick(s, 0, ++frame);
  check('switches to the opponent that whiffs a punishable move', pun === 2 && tg.info().reason === 'exposed',
    `picked ${pun}, ${tg.info().reason}, move ${slow}, margin ${tg.threat().opps[0].punish.toFixed(1)}`);
  // Share the load: a teammate committing on B while A is available; converge when B is one hit from a KO.
  place(fs[2], GEO.center - 150);
  fs[3].percent = 40;
  place(fs[3], GEO.center + 120);
  place(fs[1], GEO.center + 70);
  fs[1].facing = 1; fs[1].action = 'attack'; fs[1].moveId = slow; fs[1].actionFrame = 2;
  frame += RETARGET_FRAMES + 5;
  const share = tg.pick(s, 0, frame);
  check('shares the load: avoids the opponent a teammate is on', share === 2 && tg.info().mateOn[3], `picked ${share}`);
  fs[3].percent = 240;
  const conv = tg.pick(s, 0, ++frame);
  check('converges when that opponent is one hit from a KO', conv === 3, `picked ${conv}`);
  // Random sweep: teammates never returned, ties deterministic.
  let mateNever = true; let det = true;
  for (let k = 0; k < 300; k++) {
    for (let i = 0; i < 4; i++) {
      place(fs[i], GEO.left + 20 + u01(9, i, k, 1) * (GEO.right - GEO.left - 40));
      fs[i].percent = Math.floor(u01(9, i, k, 2) * 250);
    }
    const a = tg.pick(s, 0, frame + k * 40);
    const t2 = createTargeter();
    const b = t2.pick(s, 0, frame + k * 40);
    const c = createTargeter().pick(s, 0, frame + k * 40);
    if (a === 1 || a === 0 || b === 1 || b === 0) mateNever = false;
    if (b !== c) det = false;
  }
  check('teammates and self never returned as targets (300 random states)', mateNever);
  check('fresh targeters agree on the same state (deterministic tie-break)', det);
}

// ---- 5. allocation after warm-up (informational) ----
{
  const s = createGameState(config(4, [0, 0, 1, 1]));
  settle(s, 30);
  const per = createPerception(s, 8);
  const pred = createPredictorBank(GOD);
  const out = newPerceived();
  const inp = inputs(4);
  for (let t = 0; t < 3000; t++) { per.observe(s, 0); per.view(s, 0, 2, GOD, pred, out); stepGame(s, inp); }
  const mu = process.memoryUsage;
  if (mu !== undefined) {
    const before = mu().heapUsed;
    for (let t = 0; t < 3000; t++) { per.observe(s, 0); per.view(s, 0, 2, GOD, pred, out); stepGame(s, inp); }
    const delta = mu().heapUsed - before;
    process.stdout.write(`info heap delta over 3000 idle frames (sim included, no GC forced): ${(delta / 1024).toFixed(1)} KB\n`);
  }
}

process.stdout.write(`${checks - failures}/${checks} checks passed\n`);
if (failures > 0) process.exitCode = 1;
