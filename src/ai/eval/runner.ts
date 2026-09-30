/**
 * Headless match runner (plan 4.5, W1.7). A match is a pure function of its MatchSpec: brains are
 * reset before frame 0, the legacy level 10 gets a fresh in-memory profile store, and every
 * randomness source is the sim's seeded state. `performance.now` is used here only, to time brain calls.
 *
 * Player indices: 0 = spec.a, 1 = spec.b, 2+ = extraPlayers in order. With `swap` the sim slots of
 * a and b are exchanged; every MatchResult array and every replay event is still indexed by player.
 * `winner` is a player index (with teams, 0 or 1 for the team of a or b), -1 for a draw or a
 * timeout; score a timeout or draw as half a win (`scoreOf`).
 */
import { CHARACTER_DEFS } from '../../characters/registry';
import { BURST_ONLY } from '../../core/types';
import type { CharacterDef, FighterState, GameState, InputFrame, MatchConfig, MoveId } from '../../core/types';
import { nextFloat } from '../../core/rng';
import { createGameState, stepGame } from '../../sim';
import { STAGE_DEFS } from '../../stages/registry';
import { setAevalmereProfileStore } from '../aevalmere';
import { cpuInput, resetCpu } from '../index';
import { MemoryProfileStore } from '../profile';
import type {
  BrainFactory, BrainInputFn, CpuSpec, LegacyBrainFn, MatchResult, MatchSpec, NewBrainFn, ReplayEvent, ResetBrainFn,
  RunMatchFn, WarmBrainFn,
} from '../contracts';
import { ComboTracker, hashState, inComboState, isOffstage, SAMPLE_EVERY, StreamHash } from './replay';

// ---------------------------------------------------------------------------------------------
// Slot hints: how a factory's player appears in the MatchConfig
// ---------------------------------------------------------------------------------------------

/**
 * How a factory's slot is written into the MatchConfig. Adversaries are human slots with a typed
 * name (so profiles apply); CPUs carry their UI level. `zeroMoves` turns on the cpuZeroMoves rule
 * for the match (the wandering dummy); `charId` defaults to 'aeval'.
 */
export interface SlotHint { cpu: boolean; cpuLevel: number; name?: string; zeroMoves?: boolean; charId?: string }

const hints = new WeakMap<BrainFactory, SlotHint>();

/** Registers how `f` appears in the config. Unhinted factories are CPUs at level 0 (or their spec's UI level). */
export function hintFactory(f: BrainFactory, hint: SlotHint): BrainFactory {
  hints.set(f, hint);
  return f;
}

function uiLevelOf(spec: CpuSpec): number {
  return spec.god ? 10 : 1 + Math.round(Math.max(0, Math.min(1, spec.s)) * 8);
}

function hintOf(f: BrainFactory): SlotHint {
  const h = hints.get(f);
  if (h !== undefined) return h;
  return { cpu: true, cpuLevel: f.spec !== null ? uiLevelOf(f.spec) : 0 };
}

// ---------------------------------------------------------------------------------------------
// Brain factories
// ---------------------------------------------------------------------------------------------

function copyInput(src: InputFrame, out: InputFrame): InputFrame {
  out.held = src.held;
  out.pressed = src.pressed;
  out.released = src.released;
  out.direct = src.direct === undefined ? 0 : src.direct;
  return out;
}

/**
 * Today's rule brain (levels 0 to 9) and Aevalmere (10), through `cpuInput`. `rand` draws from the
 * sim's own RNG exactly as aitest.ts does, so a legacy match reproduces the aitest streams.
 */
export const legacyBrain: LegacyBrainFn = (level: number): BrainFactory => {
  const f: BrainFactory = {
    name: `legacy:${level}`,
    spec: null,
    create() {
      let cur: GameState | null = null;
      const rand = (): number => nextFloat((cur as GameState).rng);
      return (state: GameState, slot: number, out: InputFrame): InputFrame => {
        cur = state;
        return copyInput(cpuInput(state, slot, level, rand), out);
      };
    },
    reset() {
      resetCpu();
      // Aevalmere keeps opponent profiles across matches; a fresh store keeps each match independent.
      if (level >= 10) setAevalmereProfileStore(new MemoryProfileStore());
    },
  };
  return hintFactory(f, { cpu: true, cpuLevel: level });
};

/** The new engine's entry points (src/ai/brain.ts), registered by the integration step (W3). */
export interface BrainEngine { brainInput: BrainInputFn; warmBrain: WarmBrainFn; resetBrain: ResetBrainFn }
let engine: BrainEngine | null = null;

/** Installs the new engine for `newBrain`. Until then `newBrain(...).create()` throws. */
export function setBrainEngine(e: BrainEngine | null): void { engine = e; }

/** The new search brain for `spec`. Warms lazily on its first call of a match, which the first-call cost includes. */
export const newBrain: NewBrainFn = (spec: CpuSpec): BrainFactory => {
  const f: BrainFactory = {
    name: `brain:${spec.archetype}:${spec.god ? 'god' : `L${spec.level}`}:s${spec.s.toFixed(3)}`,
    spec,
    create() {
      const e = engine;
      if (e === null) throw new Error('newBrain: no engine registered (setBrainEngine)');
      let warmed: MatchConfig | null = null;
      return (state: GameState, slot: number, out: InputFrame): InputFrame => {
        if (warmed !== state.config) {
          warmed = state.config;
          e.warmBrain(state.config, new Map([[slot, spec]]));
        }
        return e.brainInput(state, slot, spec, out);
      };
    },
    reset() { if (engine !== null) engine.resetBrain(); },
  };
  return f;
};

// ---------------------------------------------------------------------------------------------
// Per-character data the log needs
// ---------------------------------------------------------------------------------------------

interface MoveInfo { act: number; reach: number; proj: number; chargeable: boolean }
interface CharInfo { moves: Record<string, MoveInfo>; groundReach: number }
const charCache = new Map<string, CharInfo>();
const GROUND_NORMALS: readonly MoveId[] = ['jab', 'ftilt', 'utilt', 'dtilt', 'dashatk', 'fsmash', 'usmash', 'dsmash'];

function charInfo(def: CharacterDef): CharInfo {
  const hit = charCache.get(def.id);
  if (hit !== undefined) return hit;
  const moves: Record<string, MoveInfo> = {};
  for (const id of Object.keys(def.moves) as MoveId[]) {
    const m = def.moves[id];
    let act = Infinity;
    let reach = 0;
    for (let i = 0; i < m.hitboxes.length; i++) {
      const h = m.hitboxes[i];
      if (h.start < act) act = h.start;
      if (h.x + h.r > reach) reach = h.x + h.r;
    }
    let proj = 0;
    if (m.projectiles !== undefined) {
      for (let i = 0; i < m.projectiles.length; i++) {
        const p = m.projectiles[i];
        if (p.spawnFrame === BURST_ONLY) continue;
        proj = 1;
        if (p.spawnFrame < act) act = p.spawnFrame;
      }
    }
    moves[id] = { act: act === Infinity ? 0 : act, reach, proj, chargeable: m.chargeable === true };
  }
  let groundReach = 0;
  for (let i = 0; i < GROUND_NORMALS.length; i++) {
    const mi = moves[GROUND_NORMALS[i]];
    if (mi !== undefined && mi.reach > groundReach) groundReach = mi.reach;
  }
  const info = { moves, groundReach };
  charCache.set(def.id, info);
  return info;
}

// ---------------------------------------------------------------------------------------------
// runMatch
// ---------------------------------------------------------------------------------------------

/** Score of player `p` in a two-sided result: 1 win, 0.5 draw or timeout, 0 loss. */
export function scoreOf(r: MatchResult, p: number): 0 | 0.5 | 1 {
  if (r.winner < 0) return 0.5;
  return r.winner === p ? 1 : 0;
}

interface Recorder {
  events: ReplayEvent[];
  prevAction: string[]; prevMove: (string | null)[]; prevFrameNo: number[]; prevStun: boolean[];
  prevPct: number[]; prevSds: number[]; prevKos: number[];
  combos: ComboTracker;
}

/**
 * Runs one match. The brain of each player is called once per frame, in sim slot order, on the
 * live state (brains must not mutate it). With `inputDelay` d the input produced at tick t is
 * applied d frames later.
 */
export const runMatch: RunMatchFn = (m: MatchSpec): MatchResult => {
  const factories: BrainFactory[] = [m.a, m.b];
  const teamOfPlayer: number[] = [0, 1];
  if (m.extraPlayers !== undefined) {
    for (const x of m.extraPlayers) { factories.push(x.factory); teamOfPlayer.push(x.team); }
  }
  const n = factories.length;
  const teams = n > 2;
  // simSlot -> player index
  const playerOfSlot: number[] = [];
  for (let s = 0; s < n; s++) playerOfSlot.push(s < 2 && m.swap ? 1 - s : s);
  const slotOfPlayer: number[] = new Array<number>(n);
  for (let s = 0; s < n; s++) slotOfPlayer[playerOfSlot[s]] = s;

  const players: MatchConfig['players'] = [];
  let zeroMoves = false;
  for (let s = 0; s < n; s++) {
    const p = playerOfSlot[s];
    const h = hintOf(factories[p]);
    if (h.zeroMoves === true) zeroMoves = true;
    const entry: MatchConfig['players'][number] = { slot: s, charId: h.charId ?? 'aeval', cpu: h.cpu, cpuLevel: h.cpuLevel };
    if (h.name !== undefined) entry.name = h.name;
    if (teams) entry.team = teamOfPlayer[p];
    players.push(entry);
  }
  const config: MatchConfig = { stageId: m.stageId, players, stocks: m.stocks, timeLimitSec: 0, seed: m.seed };
  if (zeroMoves) config.cpuZeroMoves = true;
  if (teams) config.teams = true;

  for (let p = 0; p < n; p++) factories[p].reset();
  const state = createGameState(config);
  const fns: ((s: GameState, slot: number, out: InputFrame) => InputFrame)[] = [];
  for (let s = 0; s < n; s++) fns.push(factories[playerOfSlot[s]].create());

  const delay = Math.max(0, Math.floor(m.inputDelay ?? 0));
  const qlen = delay + 1;
  const queue: InputFrame[][] = [];
  const scratch: InputFrame[] = [];
  const inputs: InputFrame[] = [];
  for (let s = 0; s < n; s++) {
    const q: InputFrame[] = [];
    for (let i = 0; i < qlen; i++) q.push({ held: 0, pressed: 0, released: 0, direct: 0 });
    queue.push(q);
    scratch.push({ held: 0, pressed: 0, released: 0, direct: 0 });
    inputs.push(q[0]);
  }
  const streams: StreamHash[] = [];
  const times: Float64Array[] = [];
  for (let p = 0; p < n; p++) { streams.push(new StreamHash()); times.push(new Float64Array(Math.max(1, m.frameCap))); }
  const calls = new Array<number>(n).fill(0);

  const stage = STAGE_DEFS[m.stageId];
  const rec: Recorder | null = m.record ? startRecorder(m, state, playerOfSlot, n) : null;

  let frames = 0;
  for (let tick = 0; tick < m.frameCap; tick++) {
    const qi = tick % qlen;
    for (let s = 0; s < n; s++) {
      const p = playerOfSlot[s];
      const t0 = performance.now();
      const o = fns[s](state, s, scratch[s]);
      const dt = performance.now() - t0;
      times[p][calls[p]++] = dt;
      const target = queue[s][qi];
      copyInput(o, target);
      const h = streams[p];
      h.add(state.frame + 1); h.add(target.held); h.add(target.pressed); h.add(target.direct ?? 0);
      if (rec !== null && (target.pressed !== 0 || (target.direct ?? 0) !== 0)) {
        const f = state.fighters[s];
        rec.events.push({ frame: state.frame + delay + 1, kind: 'press', slot: p,
          data: { b: target.pressed, d: target.direct ?? 0, h: target.held, g: f.onGround ? 1 : 0, a: f.action } });
      }
      // The input applied now is the one produced `delay` ticks ago.
      inputs[s] = queue[s][(tick + 1) % qlen];
    }
    if (rec !== null) snapshotBefore(rec, state);
    stepGame(state, inputs);
    frames = tick + 1;
    if (rec !== null) recordFrame(rec, state, stage, playerOfSlot);
    if (state.finished) break;
  }

  const timeout = !state.finished;
  let winner = -1;
  if (!timeout) {
    if (teams) {
      const wt = state.winnerTeam ?? -1;
      winner = wt < 0 ? -1 : wt === teamOfPlayer[0] ? 0 : wt === teamOfPlayer[1] ? 1 : -1;
    } else {
      winner = state.winner < 0 ? -1 : playerOfSlot[state.winner];
    }
  }
  const stocksLost: number[] = [];
  const sds: number[] = [];
  const cost: { mean: number; p99: number; first: number; calls: number }[] = [];
  for (let p = 0; p < n; p++) {
    const f = state.fighters[slotOfPlayer[p]];
    stocksLost.push(m.stocks - f.stocks);
    sds.push(f.stats.sds);
    cost.push(costOf(times[p], calls[p]));
  }
  if (rec !== null) {
    rec.combos.flush(state.frame);
    rec.events.push({ frame: state.frame, kind: 'end', slot: -1, data: { winner, frames, timeout: timeout ? 1 : 0 } });
  }
  return {
    winner, stocksLost, sds, frames, timeout, finalHash: hashState(state),
    inputHash: streams.map((h) => h.hex()),
    events: rec !== null ? rec.events : null,
    cost,
  };
};

/** Mean, p99 and first call in ms. Mean and p99 skip the first call (warm-up). */
function costOf(t: Float64Array, calls: number): { mean: number; p99: number; first: number; calls: number } {
  if (calls === 0) return { mean: 0, p99: 0, first: 0, calls: 0 };
  const first = t[0];
  if (calls === 1) return { mean: first, p99: first, first, calls };
  const rest = Array.from(t.subarray(1, calls)).sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < rest.length; i++) sum += rest[i];
  return { mean: sum / rest.length, p99: rest[Math.min(rest.length - 1, Math.floor(rest.length * 0.99))], first, calls };
}

function startRecorder(m: MatchSpec, state: GameState, playerOfSlot: readonly number[], n: number): Recorder {
  const events: ReplayEvent[] = [];
  events.push({ frame: 0, kind: 'start', slot: -1, data: { seed: m.seed, stage: m.stageId, stocks: m.stocks, players: n } });
  const rec: Recorder = {
    events, prevAction: [], prevMove: [], prevFrameNo: [], prevStun: [], prevPct: [], prevSds: [], prevKos: [],
    combos: new ComboTracker(n, {
      opening(frame, attacker, victim, neutral, counter) {
        events.push({ frame, kind: 'opening', slot: attacker, data: { v: victim, neutral: neutral ? 1 : 0, counter: counter ? 1 : 0 } });
      },
      end(frame, attacker, victim, hits, damage, kill, start) {
        events.push({ frame, kind: 'comboEnd', slot: attacker, data: { v: victim, hits, dmg: damage, kill: kill ? 1 : 0, start } });
      },
    }),
  };
  for (let s = 0; s < n; s++) {
    const f = state.fighters[s];
    const cfg = state.config.players[s];
    const def = CHARACTER_DEFS[f.charId];
    events.push({ frame: 0, kind: 'player', slot: playerOfSlot[s], data: {
      sim: s, charId: f.charId, name: cfg.name ?? '', cpu: cfg.cpu ? 1 : 0, team: cfg.team ?? playerOfSlot[s],
      reach: def !== undefined ? charInfo(def).groundReach : 0 } });
    rec.prevAction.push(f.action);
    rec.prevMove.push(f.moveId);
    rec.prevFrameNo.push(f.actionFrame);
    rec.prevStun.push(false);
    rec.prevPct.push(f.percent);
    rec.prevSds.push(f.stats.sds);
    rec.prevKos.push(f.stats.kos);
  }
  return rec;
}

function snapshotBefore(rec: Recorder, state: GameState): void {
  for (let s = 0; s < state.fighters.length; s++) {
    const f = state.fighters[s];
    rec.prevPct[s] = f.percent;
    rec.prevSds[s] = f.stats.sds;
    rec.prevKos[s] = f.stats.kos;
  }
}

function nearestOpponent(state: GameState, s: number): FighterState | null {
  const me = state.fighters[s];
  let best: FighterState | null = null;
  let bd = Infinity;
  for (let i = 0; i < state.fighters.length; i++) {
    if (i === s) continue;
    const o = state.fighters[i];
    if (o.stocks <= 0 || o.action === 'dead') continue;
    const d = Math.abs(o.x - me.x);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

function recordFrame(rec: Recorder, state: GameState, stage: typeof STAGE_DEFS[string], playerOfSlot: readonly number[]): void {
  const frame = state.frame;
  const ev = rec.events;
  const n = state.fighters.length;
  // Sim events first, in the order the sim raised them.
  for (let i = 0; i < state.events.length; i++) {
    const e = state.events[i];
    switch (e.type) {
      case 'hit': {
        const victim = state.fighters[e.victim];
        const vdef = CHARACTER_DEFS[victim.charId];
        let vatk = 0;
        if (rec.prevAction[e.victim] === 'attack') {
          const mid = rec.prevMove[e.victim];
          if (mid !== null && vdef !== undefined) {
            const mi = charInfo(vdef).moves[mid];
            if (mi !== undefined && rec.prevFrameNo[e.victim] < mi.act) vatk = 1;
          }
        }
        const a = e.attacker >= 0 ? playerOfSlot[e.attacker] : -1;
        const v = playerOfSlot[e.victim];
        ev.push({ frame, kind: 'hit', slot: a, data: {
          v, dmg: e.damage, kb: e.kb, ang: e.angle, pct: victim.percent, vatk, off: isOffstage(stage, victim) ? 1 : 0 } });
        if (a >= 0 && e.damage > 0) rec.combos.hit(frame, a, v, e.damage, vatk === 1);
        break;
      }
      case 'shieldHit': ev.push({ frame, kind: 'shieldHit', slot: playerOfSlot[e.victim], data: {} }); break;
      case 'grab': ev.push({ frame, kind: 'grab', slot: playerOfSlot[e.attacker], data: { v: playerOfSlot[e.victim] } }); break;
      case 'throw': ev.push({ frame, kind: 'throw', slot: playerOfSlot[e.attacker], data: { v: playerOfSlot[e.victim], t: e.throwId } }); break;
      case 'tech': ev.push({ frame, kind: 'tech', slot: playerOfSlot[e.slot], data: { roll: e.roll ? 1 : 0 } }); break;
      case 'jump': ev.push({ frame, kind: 'jump', slot: playerOfSlot[e.slot], data: { dbl: e.double ? 1 : 0 } }); break;
      case 'dash': ev.push({ frame, kind: 'dash', slot: playerOfSlot[e.slot], data: {} }); break;
      case 'shieldBreak': ev.push({ frame, kind: 'shieldBreak', slot: playerOfSlot[e.slot], data: {} }); break;
      case 'respawn': ev.push({ frame, kind: 'respawn', slot: playerOfSlot[e.slot], data: {} }); break;
      case 'projectileSpawn': ev.push({ frame, kind: 'shot', slot: playerOfSlot[e.slot], data: { def: e.defId } }); break;
      case 'ko': {
        const f = state.fighters[e.slot];
        let by = -1;
        for (let k = 0; k < n; k++) if (k !== e.slot && state.fighters[k].stats.kos > rec.prevKos[k]) by = playerOfSlot[k];
        const sd = f.stats.sds > rec.prevSds[e.slot] ? 1 : 0;
        const v = playerOfSlot[e.slot];
        ev.push({ frame, kind: 'ko', slot: v, data: { by, sd, pct: rec.prevPct[e.slot], side: e.side } });
        rec.combos.ko(frame, v);
        break;
      }
      default: break;
    }
  }
  // State changes.
  for (let s = 0; s < n; s++) {
    const f = state.fighters[s];
    const p = playerOfSlot[s];
    const act = f.action;
    const id = f.moveId;
    if (act !== rec.prevAction[s]) {
      ev.push({ frame, kind: 'action', slot: p, data: { a: act, m: id ?? '-', g: f.onGround ? 1 : 0 } });
    }
    if (id !== null && act === 'attack') {
      const def = CHARACTER_DEFS[f.charId];
      const mi = def !== undefined ? charInfo(def).moves[id] : undefined;
      const restarted = f.actionFrame <= rec.prevFrameNo[s] && f.hitlag === 0 && !(mi !== undefined && mi.chargeable);
      if (id !== rec.prevMove[s] || rec.prevAction[s] !== 'attack' || restarted) {
        const o = nearestOpponent(state, s);
        const dx = o === null ? 0 : (o.x - f.x) * f.facing;
        ev.push({ frame, kind: 'move', slot: p, data: {
          m: id, dx, adx: Math.abs(dx), dy: o === null ? 0 : o.y - f.y,
          act: mi !== undefined ? mi.act : 0, reach: mi !== undefined ? mi.reach : 0, proj: mi !== undefined ? mi.proj : 0 } });
      }
    }
    const stun = inComboState(f);
    if (stun !== rec.prevStun[s]) {
      ev.push({ frame, kind: 'stun', slot: p, data: { on: stun ? 1 : 0 } });
      rec.combos.setInState(p, stun);
      rec.prevStun[s] = stun;
    }
    if (frame % SAMPLE_EVERY === 0 && f.stocks > 0 && act !== 'dead') {
      ev.push({ frame, kind: 'sample', slot: p, data: { x: f.x, y: f.y, g: f.onGround ? 1 : 0, off: isOffstage(stage, f) ? 1 : 0 } });
    }
    rec.prevAction[s] = act;
    rec.prevMove[s] = id;
    rec.prevFrameNo[s] = f.actionFrame;
  }
  rec.combos.tick(frame);
}

/** Both sides of every seed: for each seed, a on slot 0, then a on slot 1 (paired seeds, side swap). */
export function runPaired(base: Omit<MatchSpec, 'seed' | 'swap'>, seeds: readonly number[]): MatchResult[] {
  const out: MatchResult[] = [];
  for (const seed of seeds) {
    out.push(runMatch({ ...base, seed, swap: false }));
    out.push(runMatch({ ...base, seed, swap: true }));
  }
  return out;
}
