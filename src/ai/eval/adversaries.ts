/**
 * Scripted adversaries (06 section 3, plan W1.9). Each is a BrainFactory for a human slot with a
 * typed name, so opponent profiles apply to it. No randomness except the two level 0 wrappers,
 * which draw from the sim's seeded RNG exactly like aitest.ts; the same state always gives the
 * same input.
 *
 * The six habits rushdown, turtle, camper, roller, ledgeCamper and jumper are `archInput` from
 * aitest.ts ported line for line (its 'ledge' kind is 'ledgeCamper' here). Documented weaknesses,
 * the counter a competent CPU is expected to find:
 * - rushdown:      walks in and mashes jab, ftilt, dtilt, jab, usmash at 40 px, never shields.
 *                  Weakness: shield the string and punish the usmash end lag, or outspace it.
 * - turtle:        shields anything moving within 110 px and shield-grabs a committed attack.
 *                  Weakness: grabbed (grab beats shield); also never approaches.
 * - camper:        holds 170 to 260 px and alternates nspecial and sspecial every 40 frames.
 *                  Weakness: approached inside its 40-frame clock; cornered at the edge.
 * - roller:        rolls when anyone is within 90 px (two rolls through, one away, 34-frame cadence).
 *                  Weakness: caught on the roll's landing spot.
 * - ledgeCamper:   walks off to hang, cycles get-up, attack, roll, get-up, jump on 40/52/64-frame waits.
 *                  Weakness: ledge-trapped on the cycled option.
 * - jumper:        full hops at the opponent, fair or nair at the apex, double jump on the way down.
 *                  Weakness: anti-aired and landing-trapped.
 * - stationary:    level 0 dummy, stands still. Weakness: everything; the kill-speed target.
 * - wandering:     level 0 with the cpuZeroMoves rule: walks, runs, jumps, never attacks.
 *                  Weakness: never fights back.
 * - shieldOnly:    holds Shield whenever it is on the ground. Weakness: grabbed, or shield-broken.
 * - jumpOnly:      full hops in place over and over. Weakness: landing-trapped, anti-aired.
 * - learnsPattern: counts the opponent's last 12 options and plays the counter to the most frequent
 *                  one (shield-grab a ground attacker, usmash an aerial approach, spot dodge a grabber,
 *                  grab a shielder, smash a dodger, jump over a shooter). Weakness: it only answers
 *                  frequency, so a mixed or baiting opponent (level 4 and up) beats its fixed counter.
 * - changesStyle:  rushdown for the first 30 s (1,800 frames), camper after. Weakness: each half's own;
 *                  exists to test the changepoint reset.
 *
 * Extras outside the frozen AdversaryId union (see EXTRA_ADVERSARIES, reported as a contract gap):
 * - spammer:  aitest.ts `spammerInput`, back-to-back projectiles from just outside 110 px.
 *             Weakness: approach in the 8-frame gap; it only walks away up close.
 * - mashOut:  stationary, mashes four bits every frame while grabbed. Tests the sim mash cap.
 * - diIn, diOut, diNone: stationary; while launched they hold toward the stage centre, away from it,
 *             or nothing. The sim has no knockback DI, so this is launch drift only.
 */
import { Btn, DIRECT_CODES } from '../../core/types';
import type { FighterState, GameState, InputFrame } from '../../core/types';
import { nextFloat } from '../../core/rng';
import { STAGE_DEFS } from '../../stages/registry';
import { cpuInput, resetCpu } from '../index';
import type { AdversaryFn, AdversaryId, BrainFactory } from '../contracts';
import { hintFactory } from './runner';

export const ADVERSARIES: readonly AdversaryId[] = [
  'rushdown', 'turtle', 'camper', 'roller', 'ledgeCamper', 'jumper',
  'stationary', 'wandering', 'shieldOnly', 'jumpOnly', 'learnsPattern', 'changesStyle',
];

/** Scripted policies the lead asked for that the frozen AdversaryId union does not name. */
export const EXTRA_ADVERSARIES = ['spammer', 'mashOut', 'diIn', 'diOut', 'diNone'] as const;

/** Frame the changes-style adversary switches from rushdown to camper (30 s). */
export const STYLE_SWITCH_FRAME = 1800;

const DCODES = DIRECT_CODES as readonly string[];
function dcode(name: string): number { return DCODES.indexOf(name) + 1; }

// ---------------------------------------------------------------------------------------------
// The six aitest.ts habits, ported verbatim
// ---------------------------------------------------------------------------------------------

type ArchKind = 'rushdown' | 'turtle' | 'camper' | 'roller' | 'ledge' | 'jumper';

interface ArchMem { prevHeld: number; step: number; timer: number; phase: number; hang: number; jumpHold: number; mash: number; relL: number; relR: number }

function newArchMem(): ArchMem {
  return { prevHeld: 0, step: 0, timer: 0, phase: 0, hang: 0, jumpHold: 0, mash: 0, relL: -99, relR: -99 };
}

function archFree(f: FighterState): boolean {
  if (f.hitlag > 0) return false;
  return f.action === 'idle' || f.action === 'walk' || f.action === 'dash' || f.action === 'run' ||
    f.action === 'turn' || f.action === 'crouch';
}

/** aitest.ts archInput: shared plumbing (respawn, grabbed, downed, ledge, recovery), then the habit. */
function archInput(kind: ArchKind, state: GameState, slot: number, mem: ArchMem, out: InputFrame): InputFrame {
  let held = 0;
  let direct = 0;
  let me: FighterState | null = null;
  let foe: FighterState | null = null;
  for (let i = 0; i < state.fighters.length; i++) {
    const f = state.fighters[i];
    if (f.slot === slot) me = f; else if (foe === null || f.stocks > 0) foe = f;
  }
  if (mem.timer > 0) mem.timer--;
  if (me !== null && foe !== null && me.stocks > 0 && me.action !== 'dead') {
    const stage = STAGE_DEFS[state.stageId];
    let minX = 0; let maxX = 0;
    for (let i = 0; i < stage.platforms.length; i++) {
      const p = stage.platforms[i];
      if (p.solid) { minX = p.x; maxX = p.x + p.w; break; }
    }
    const cx = (minX + maxX) / 2;
    const dx = foe.x - me.x;
    const adx = Math.abs(dx);
    const toward = dx < 0 ? Btn.Left : Btn.Right;
    const away = dx < 0 ? Btn.Right : Btn.Left;
    const home = me.x < cx ? Btn.Right : Btn.Left;
    const facingFoe = (me.facing === 1) === (dx > 0);
    const off = !me.onGround && (me.x < minX - 2 || me.x > maxX + 2 || me.y > 6);
    if (me.action === 'respawn') {
      if (me.actionFrame > 30) held = Btn.Down;
    } else if (me.action === 'grabbed') {
      mem.mash ^= 1;
      held = mem.mash === 0 ? (Btn.Left | Btn.Jump) : (Btn.Right | Btn.Attack);
    } else if (me.action === 'downed') {
      held = (mem.prevHeld & Btn.Up) === 0 ? Btn.Up : 0;
    } else if (me.action === 'ledgeHang') {
      if (kind === 'ledge') {
        mem.hang++;
        const wait = 40 + (mem.step % 3) * 12;
        if (mem.hang >= wait) {
          const opts = ['ledgeGetUp', 'ledgeAttack', 'ledgeRoll', 'ledgeGetUp', 'ledgeJump'];
          direct = dcode(opts[mem.step % opts.length]);
          mem.step++;
          mem.hang = 0;
          mem.phase = 1;
          mem.timer = 50;
        }
      } else if (me.actionFrame > 8) {
        direct = dcode('ledgeGetUp');
      }
    } else if (off && !(kind === 'ledge' && mem.phase === 0 && me.y < 40)) {
      held = home;
      if (me.action === 'air') {
        if (me.jumpsLeft > 0 && me.vy > 0.5) { if ((mem.prevHeld & Btn.Jump) === 0) held |= Btn.Jump; }
        else if (me.jumpsLeft === 0 && me.vy > 0) direct = dcode('uspecial');
      }
    } else {
      switch (kind) {
        case 'rushdown': {
          held = toward;
          if (!me.onGround || !archFree(me) || adx > 40) break;
          const string = ['jab', 'ftilt', 'dtilt', 'jab', 'usmash'];
          direct = dcode(string[mem.step % string.length]);
          mem.step++;
          break;
        }
        case 'turtle': {
          if (!me.onGround) { held = home; break; }
          const foeBusy = foe.action === 'attack' || foe.action === 'land' || foe.action === 'shieldStun';
          const foeCommitted = foe.action === 'attack' && foe.actionFrame > 8;
          if (me.action === 'shield' && adx < 44 && foeCommitted) { held = Btn.Shield | ((mem.prevHeld & Btn.Attack) === 0 ? Btn.Attack : 0); break; }
          if (adx < 110 && (foeBusy || Math.abs(foe.vx) > 1.2 || foe.action === 'air')) { held = Btn.Shield; mem.timer = 12; break; }
          if (mem.timer > 0 && me.action === 'shield') { held = Btn.Shield; break; }
          if (!archFree(me)) break;
          if (adx > 100) held = toward | Btn.Walk;
          break;
        }
        case 'camper': {
          if (!me.onGround) { held = home; break; }
          if (!archFree(me)) break;
          const nearEdge = me.x < minX + 40 || me.x > maxX - 40;
          if (!nearEdge && (adx < 170 || (mem.phase === 1 && adx < 200))) { held = away; mem.phase = 1; break; }
          mem.phase = 0;
          if (adx < 90 && nearEdge) { held = toward | Btn.Jump; break; }
          if (adx > 260) { held = toward; break; }
          if (!facingFoe) { held = toward; break; }
          if (mem.timer === 0) {
            direct = dcode(mem.step % 2 === 0 ? 'nspecial' : 'sspecial');
            mem.step++;
            mem.timer = 40;
          }
          break;
        }
        case 'roller': {
          if (!me.onGround) { held = home; break; }
          if (!archFree(me)) break;
          if (adx < 90 && mem.timer === 0) {
            const rollIn = mem.step % 3 !== 2;
            direct = dcode(rollIn === facingFoe ? 'rollForward' : 'rollBack');
            mem.step++;
            mem.timer = 34;
            break;
          }
          if (adx < 36) { direct = dcode('jab'); break; }
          if (adx > 120) held = toward;
          break;
        }
        case 'ledge': {
          const leftSide = me.x < cx;
          const edge = leftSide ? minX : maxX;
          const outBit = leftSide ? Btn.Left : Btn.Right;
          const inBit = leftSide ? Btn.Right : Btn.Left;
          if (mem.phase === 1) {
            if (!me.onGround) { held = home; break; }
            if (!archFree(me)) break;
            if (adx < 36) { direct = dcode('jab'); break; }
            if (mem.timer === 0) mem.phase = 0;
            break;
          }
          if (me.onGround) { if (archFree(me) || me.action === 'land') held = outBit; break; }
          held = me.vy > 0 && Math.abs(me.x - edge) < 30 ? inBit : outBit;
          if (me.y > 30 || Math.abs(me.x - edge) > 40) held = inBit;
          break;
        }
        case 'jumper': {
          held = toward;
          if (me.onGround) {
            if (archFree(me) || me.action === 'land') { held |= Btn.Jump; mem.jumpHold = 5; }
            break;
          }
          if (mem.jumpHold > 0) { held |= Btn.Jump; mem.jumpHold--; }
          if (me.action === 'air' && me.vy > -1.5 && me.vy < 1 && adx < 80 && mem.timer === 0) {
            direct = dcode(facingFoe ? 'fair' : 'nair');
            mem.timer = 30;
          } else if (me.action === 'air' && me.vy > 2 && me.jumpsLeft > 0 && (mem.prevHeld & Btn.Jump) === 0 && adx > 30) {
            held |= Btn.Jump;
          }
          break;
        }
        default: break;
      }
    }
  }
  // A direction released less than a roll-tap window ago is not pressed again on the ground.
  if (me !== null && me.onGround) {
    if ((held & Btn.Left) !== 0 && (mem.prevHeld & Btn.Left) === 0 && state.frame - mem.relL <= 14) held &= ~Btn.Left;
    if ((held & Btn.Right) !== 0 && (mem.prevHeld & Btn.Right) === 0 && state.frame - mem.relR <= 14) held &= ~Btn.Right;
  }
  if ((mem.prevHeld & Btn.Left) !== 0 && (held & Btn.Left) === 0) mem.relL = state.frame;
  if ((mem.prevHeld & Btn.Right) !== 0 && (held & Btn.Right) === 0) mem.relR = state.frame;
  out.held = held;
  out.pressed = held & ~mem.prevHeld;
  out.released = mem.prevHeld & ~held;
  out.direct = direct;
  mem.prevHeld = held;
  return out;
}

// ---------------------------------------------------------------------------------------------
// aitest.ts spammerInput, ported verbatim (extra)
// ---------------------------------------------------------------------------------------------

const SPAM_RANGE = 110;
const SPAM_PERIOD = 8;
const SPAM_AIM_FRAMES = 2;

interface SpamMem { aim: number; timer: number; volley: number; prevHeld: number }

function spammerInput(state: GameState, slot: number, mem: SpamMem, out: InputFrame): InputFrame {
  const me = state.fighters[slot];
  const foe = state.fighters[1 - slot];
  let held = 0;
  if (me.action === 'dead' || me.stocks <= 0) {
    held = 0;
  } else if (!me.onGround) {
    held = me.x < 0 ? Btn.Right : Btn.Left;
    if (me.vy > 0.5 && me.jumpsLeft > 0) held |= Btn.Jump;
    else if (me.vy > 0 && me.jumpsLeft === 0) held |= Btn.Special | Btn.Up;
  } else {
    const dx = foe.x - me.x;
    const adx = Math.abs(dx);
    const toward = dx < 0 ? Btn.Left : Btn.Right;
    const away = dx < 0 ? Btn.Right : Btn.Left;
    const nearEdge = me.x < -150 || me.x > 150;
    if (mem.timer > 0) mem.timer--;
    if (me.action === 'attack' || me.action === 'hitstun' || me.action === 'tumble') {
      held = 0;
    } else if (adx < SPAM_RANGE && !nearEdge) {
      held = away;
      mem.aim = 0;
    } else if (mem.timer > 0) {
      held = 0;
    } else if (mem.aim < SPAM_AIM_FRAMES) {
      mem.aim++;
      held = toward;
    } else {
      mem.aim = 0;
      mem.volley++;
      mem.timer = SPAM_PERIOD;
      held = mem.volley % 3 === 0 ? (toward | Btn.Special) : Btn.Special;
    }
  }
  out.pressed = held & ~mem.prevHeld;
  out.released = mem.prevHeld & ~held;
  out.held = held;
  out.direct = 0;
  mem.prevHeld = held;
  return out;
}

// ---------------------------------------------------------------------------------------------
// New policies
// ---------------------------------------------------------------------------------------------

interface Ctx { me: FighterState; foe: FighterState; minX: number; maxX: number; cx: number; dx: number; adx: number;
  toward: number; away: number; home: number; facingFoe: boolean; off: boolean }

function context(state: GameState, slot: number): Ctx | null {
  let me: FighterState | null = null;
  let foe: FighterState | null = null;
  for (let i = 0; i < state.fighters.length; i++) {
    const f = state.fighters[i];
    if (f.slot === slot) me = f; else if (foe === null || f.stocks > 0) foe = f;
  }
  if (me === null || foe === null) return null;
  const stage = STAGE_DEFS[state.stageId];
  let minX = 0; let maxX = 0;
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (p.solid) { minX = p.x; maxX = p.x + p.w; break; }
  }
  const cx = (minX + maxX) / 2;
  const dx = foe.x - me.x;
  return {
    me, foe, minX, maxX, cx, dx, adx: Math.abs(dx),
    toward: dx < 0 ? Btn.Left : Btn.Right, away: dx < 0 ? Btn.Right : Btn.Left,
    home: me.x < cx ? Btn.Right : Btn.Left, facingFoe: (me.facing === 1) === (dx > 0),
    off: !me.onGround && (me.x < minX - 2 || me.x > maxX + 2 || me.y > 6),
  };
}

interface ScriptMem { prevHeld: number; timer: number; mash: number; step: number; relL: number; relR: number;
  ring: number[]; ringLen: number; ringAt: number; foeAction: string; foeMove: string | null }

function newScriptMem(): ScriptMem {
  return { prevHeld: 0, timer: 0, mash: 0, step: 0, relL: -99, relR: -99,
    ring: new Array<number>(12).fill(-1), ringLen: 0, ringAt: 0, foeAction: 'idle', foeMove: null };
}

/**
 * Plumbing shared by the new policies: respawn drop, grab mash, downed get-up, ledge get-up and
 * the recovery home. Returns true when it claimed the frame (held and direct written to `io`).
 */
function plumbing(c: Ctx, mem: ScriptMem, io: { held: number; direct: number }, mashAll: boolean): boolean {
  const me = c.me;
  if (me.stocks <= 0 || me.action === 'dead') return true;
  if (me.action === 'respawn') { if (me.actionFrame > 30) io.held = Btn.Down; return true; }
  if (me.action === 'grabbed') {
    if (mashAll) io.held = (mem.mash ^= 1) === 0 ? (Btn.Left | Btn.Up | Btn.Jump | Btn.Attack) : 0;
    else { mem.mash ^= 1; io.held = mem.mash === 0 ? (Btn.Left | Btn.Jump) : (Btn.Right | Btn.Attack); }
    return true;
  }
  if (me.action === 'downed') { io.held = (mem.prevHeld & Btn.Up) === 0 ? Btn.Up : 0; return true; }
  if (me.action === 'ledgeHang') { if (me.actionFrame > 8) io.direct = dcode('ledgeGetUp'); return true; }
  if (c.off) {
    io.held = c.home;
    if (me.action === 'air') {
      if (me.jumpsLeft > 0 && me.vy > 0.5) { if ((mem.prevHeld & Btn.Jump) === 0) io.held |= Btn.Jump; }
      else if (me.jumpsLeft === 0 && me.vy > 0) io.direct = dcode('uspecial');
    }
    return true;
  }
  return false;
}

function finish(state: GameState, me: FighterState | null, mem: ScriptMem, held: number, direct: number, out: InputFrame): InputFrame {
  if (me !== null && me.onGround) {
    if ((held & Btn.Left) !== 0 && (mem.prevHeld & Btn.Left) === 0 && state.frame - mem.relL <= 14) held &= ~Btn.Left;
    if ((held & Btn.Right) !== 0 && (mem.prevHeld & Btn.Right) === 0 && state.frame - mem.relR <= 14) held &= ~Btn.Right;
  }
  if ((mem.prevHeld & Btn.Left) !== 0 && (held & Btn.Left) === 0) mem.relL = state.frame;
  if ((mem.prevHeld & Btn.Right) !== 0 && (held & Btn.Right) === 0) mem.relR = state.frame;
  out.held = held;
  out.pressed = held & ~mem.prevHeld;
  out.released = mem.prevHeld & ~held;
  out.direct = direct;
  mem.prevHeld = held;
  return out;
}

function shieldOnlyInput(state: GameState, slot: number, mem: ScriptMem, out: InputFrame): InputFrame {
  const c = context(state, slot);
  const io = { held: 0, direct: 0 };
  if (c !== null && !plumbing(c, mem, io, false) && c.me.onGround) io.held = Btn.Shield;
  return finish(state, c === null ? null : c.me, mem, io.held, io.direct, out);
}

function jumpOnlyInput(state: GameState, slot: number, mem: ScriptMem, out: InputFrame): InputFrame {
  const c = context(state, slot);
  const io = { held: 0, direct: 0 };
  if (c !== null && !plumbing(c, mem, io, false)) {
    const me = c.me;
    if (me.onGround && (archFree(me) || me.action === 'land')) { io.held = Btn.Jump; mem.timer = 5; }
    else if (!me.onGround && mem.timer > 0) { io.held = Btn.Jump; mem.timer--; }
  }
  return finish(state, c === null ? null : c.me, mem, io.held, io.direct, out);
}

/** Stationary with a held direction while launched: +1 toward centre, -1 away, 0 none. */
function driftInput(dir: number, mashAll: boolean) {
  return (state: GameState, slot: number, mem: ScriptMem, out: InputFrame): InputFrame => {
    const c = context(state, slot);
    const io = { held: 0, direct: 0 };
    if (c !== null) {
      const me = c.me;
      const launched = me.hitstun > 0 || me.action === 'tumble' || me.action === 'hitstun';
      if (launched && dir !== 0) {
        const toCentre = me.x < c.cx ? Btn.Right : Btn.Left;
        io.held = dir > 0 ? toCentre : (toCentre === Btn.Right ? Btn.Left : Btn.Right);
      } else if (!launched) {
        plumbing(c, mem, io, mashAll);
      }
    }
    return finish(state, c === null ? null : c.me, mem, io.held, io.direct, out);
  };
}

// Option classes the learns-your-pattern adversary counts.
const OPT_GROUND = 0, OPT_AERIAL = 1, OPT_GRAB = 2, OPT_SHIELD = 3, OPT_DODGE = 4, OPT_SHOT = 5, OPT_COUNT = 6;
const AERIALS: Readonly<Record<string, true>> = { nair: true, fair: true, bair: true, uair: true, dair: true };
const SHOTS: Readonly<Record<string, true>> = { nspecial: true, sspecial: true };

function classifyFoe(f: FighterState, prevAction: string, prevMove: string | null): number {
  if (f.action === 'attack' && f.moveId !== null && (prevAction !== 'attack' || prevMove !== f.moveId)) {
    if (SHOTS[f.moveId] === true) return OPT_SHOT;
    if (AERIALS[f.moveId] === true) return OPT_AERIAL;
    return OPT_GROUND;
  }
  if (f.action === prevAction) return -1;
  if (f.action === 'grab') return OPT_GRAB;
  if (f.action === 'shield') return OPT_SHIELD;
  if (f.action === 'roll' || f.action === 'spotDodge') return OPT_DODGE;
  return -1;
}

function learnsPatternInput(state: GameState, slot: number, mem: ScriptMem, out: InputFrame): InputFrame {
  const c = context(state, slot);
  const io = { held: 0, direct: 0 };
  if (c !== null) {
    const foe = c.foe;
    const cls = classifyFoe(foe, mem.foeAction, mem.foeMove);
    mem.foeAction = foe.action;
    mem.foeMove = foe.moveId;
    if (cls >= 0) {
      mem.ring[mem.ringAt] = cls;
      mem.ringAt = (mem.ringAt + 1) % mem.ring.length;
      if (mem.ringLen < mem.ring.length) mem.ringLen++;
    }
    if (mem.timer > 0) mem.timer--;
    if (!plumbing(c, mem, io, false)) {
      const me = c.me;
      let top = -1; let best = 0;
      const counts = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < mem.ringLen; i++) counts[mem.ring[i]]++;
      for (let k = 0; k < OPT_COUNT; k++) if (counts[k] > best) { best = counts[k]; top = k; }
      if (!me.onGround) {
        io.held = c.toward;
      } else {
        const free = archFree(me);
        switch (top) {
          case OPT_GROUND: {
            const committed = foe.action === 'attack' && foe.actionFrame > 8;
            if (me.action === 'shield' && c.adx < 44 && committed) io.held = Btn.Shield | ((mem.prevHeld & Btn.Attack) === 0 ? Btn.Attack : 0);
            else if (c.adx < 80 && (foe.action === 'attack' || Math.abs(foe.vx) > 1.2)) io.held = Btn.Shield;
            else if (free && c.adx > 90) io.held = c.toward | Btn.Walk;
            break;
          }
          case OPT_AERIAL:
            if (free && !foe.onGround && c.adx < 50 && mem.timer === 0) { io.direct = dcode('usmash'); mem.timer = 40; }
            else if (free && c.adx > 90) io.held = c.toward | Btn.Walk;
            break;
          case OPT_GRAB:
            if (free && c.adx < 50 && mem.timer === 0) { io.direct = dcode('spotDodge'); mem.timer = 30; }
            else if (free && c.adx < 36) io.direct = dcode('jab');
            else if (free && c.adx > 90) io.held = c.toward | Btn.Walk;
            break;
          case OPT_SHIELD:
            if (free && c.adx < 40 && mem.timer === 0) { io.held = Btn.Grab; mem.timer = 30; }
            else if (free) io.held = c.toward;
            break;
          case OPT_DODGE:
            if (free && (foe.action === 'roll' || foe.action === 'spotDodge') && foe.actionFrame > 10 && c.adx < 60 && mem.timer === 0) {
              io.direct = dcode('fsmash'); mem.timer = 50;
            } else if (free && c.adx > 90) io.held = c.toward | Btn.Walk;
            break;
          case OPT_SHOT:
            if (free) io.held = c.toward | (c.adx > 60 && c.adx < 140 ? Btn.Jump : 0);
            break;
          default:
            if (free && c.adx < 36) io.direct = dcode('jab');
            else if (free) io.held = c.toward | Btn.Walk;
            break;
        }
      }
    }
  }
  return finish(state, c === null ? null : c.me, mem, io.held, io.direct, out);
}

// ---------------------------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------------------------

type Policy = (state: GameState, slot: number, out: InputFrame) => InputFrame;

function scripted(id: string, playerName: string, make: () => Policy): BrainFactory {
  const f: BrainFactory = { name: `adversary:${id}`, spec: null, create: make, reset() { /* memory lives in create() */ } };
  return hintFactory(f, { cpu: false, cpuLevel: 0, name: playerName });
}

function levelZero(id: string, playerName: string, wander: boolean): BrainFactory {
  const f: BrainFactory = {
    name: `adversary:${id}`,
    spec: null,
    create() {
      let cur: GameState | null = null;
      const rand = (): number => nextFloat((cur as GameState).rng);
      return (state: GameState, slot: number, out: InputFrame): InputFrame => {
        cur = state;
        const o = cpuInput(state, slot, 0, rand);
        out.held = o.held; out.pressed = o.pressed; out.released = o.released; out.direct = o.direct ?? 0;
        return out;
      };
    },
    reset() { resetCpu(); },
  };
  return hintFactory(f, { cpu: false, cpuLevel: 0, name: playerName, zeroMoves: wander });
}

function arch(kind: ArchKind): () => Policy {
  return () => { const mem = newArchMem(); return (s, slot, out) => archInput(kind, s, slot, mem, out); };
}

function withMem(fn: (s: GameState, slot: number, mem: ScriptMem, out: InputFrame) => InputFrame): () => Policy {
  return () => { const mem = newScriptMem(); return (s, slot, out) => fn(s, slot, mem, out); };
}

/** One of the twelve contract adversaries as a named human slot. */
export const adversary: AdversaryFn = (id: AdversaryId, playerName: string): BrainFactory => {
  switch (id) {
    case 'rushdown': return scripted(id, playerName, arch('rushdown'));
    case 'turtle': return scripted(id, playerName, arch('turtle'));
    case 'camper': return scripted(id, playerName, arch('camper'));
    case 'roller': return scripted(id, playerName, arch('roller'));
    case 'ledgeCamper': return scripted(id, playerName, arch('ledge'));
    case 'jumper': return scripted(id, playerName, arch('jumper'));
    case 'stationary': return levelZero(id, playerName, false);
    case 'wandering': return levelZero(id, playerName, true);
    case 'shieldOnly': return scripted(id, playerName, withMem(shieldOnlyInput));
    case 'jumpOnly': return scripted(id, playerName, withMem(jumpOnlyInput));
    case 'learnsPattern': return scripted(id, playerName, withMem(learnsPatternInput));
    case 'changesStyle': return scripted(id, playerName, () => {
      const a = newArchMem(); const b = newArchMem();
      return (s, slot, out) => (s.frame < STYLE_SWITCH_FRAME ? archInput('rushdown', s, slot, a, out) : archInput('camper', s, slot, b, out));
    });
    default: throw new Error(`unknown adversary ${String(id)}`);
  }
};

/** The extra policies (spammer, mash-out, drift variants) as named human slots. */
export function extraAdversary(id: typeof EXTRA_ADVERSARIES[number], playerName: string): BrainFactory {
  switch (id) {
    case 'spammer': return scripted(id, playerName, () => {
      const mem: SpamMem = { aim: 0, timer: 0, volley: 0, prevHeld: 0 };
      return (s, slot, out) => spammerInput(s, slot, mem, out);
    });
    case 'mashOut': return scripted(id, playerName, withMem(driftInput(0, true)));
    case 'diIn': return scripted(id, playerName, withMem(driftInput(1, false)));
    case 'diOut': return scripted(id, playerName, withMem(driftInput(-1, false)));
    case 'diNone': return scripted(id, playerName, withMem(driftInput(0, false)));
    default: throw new Error(`unknown extra adversary ${String(id)}`);
  }
}
