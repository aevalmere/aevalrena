import type { GameState, InputFrame, MatchConfig, SimEvent } from '../core/types';
import { createPacket, decodePacket, encodePacket, MAX_PEERS, type InputPacket } from './codec';
import { hashGameState } from './hash';
import { InputRing, inputsEqual } from './inputs';
import { restoreInto, StateRing } from './snapshot';
import type { InputHistory, Retirement } from './protocol';
import type { NetTransport } from './transport';

/**
 * GGPO-style rollback session (docs/LAN.md section 2). Every peer runs the whole sim; remote
 * inputs are predicted (last held, no edges) and, when the real one differs, the saved state
 * for that frame is restored and the sim re-runs to the present inside the same tick.
 *
 * Frame numbering: tick `t` steps the sim from state.frame t to t + 1 using inputs[t]. The state
 * ring slot for t holds the state before that step.
 */

/** The only sim entry points netcode uses. */
export interface RollbackSim {
  createGameState(config: MatchConfig): GameState;
  stepGame(state: GameState, inputs: InputFrame[]): void;
  /**
   * Take fighter `index` out of the match through the sim's own KO path (a player left or timed
   * out). Called at the same frame on every peer, before that frame's step, so the sim's match
   * end rule decides the winner. Omitted: retired players only stop sending inputs.
   */
  eliminate?(state: GameState, index: number): void;
}

/** Input for one owned player at `frame`. `state` is the live (possibly predicted) state. */
export type LocalSource = (frame: number, state: GameState) => InputFrame;

export interface RollbackOptions {
  config: MatchConfig;
  sim: RollbackSim;
  /** This peer's id, 0..3. */
  peer: number;
  /** Per fighter index (config.players order): the peer id that sends that player's input. */
  owners: number[];
  /** Per fighter index: the input source for players this peer owns, null for the rest. */
  sources: (LocalSource | null)[];
  transport: NetTransport;
  /** Frames between sampling a local input and simulating it. 0..4, LAN default 1. */
  inputDelay: number;
  onDesync?(frame: number, peer: number, local: number, remote: number): void;
}

export interface RollbackStats {
  rollbacks: number;
  maxRollback: number;
  resimFrames: number;
  /** Ticks not advanced because a remote player fell MAX_PREDICTION frames behind. */
  stalls: number;
  /** Ticks skipped by time sync to let a slower peer catch up. */
  waits: number;
  hashesCompared: number;
  desyncs: number;
  lastDesyncFrame: number;
  packetsIn: number;
  packetsOut: number;
}

export const STATE_RING = 32;
/** Frames a remote player may be predicted ahead of its last confirmed input before we stall. */
export const MAX_PREDICTION = 12;
export const HASH_INTERVAL = 60;
/** Remote input further than this past its confirmed frame is dropped (< INPUT_RING). */
const MAX_ACCEPT_AHEAD = 100;
/** Most input frames repeated per packet. */
const MAX_SEND = 24;
/** Fewest recent frames repeated per packet even when acked, for loss tolerance. */
const MIN_SEND = 4;
const SYNC_WINDOW = 32;
/** Frames of emitted-event records kept, more than any rollback can reach back. */
const EVENT_RING = 64;
/** Fields that may shift when a frame is re-simulated with corrected inputs; left out of an event's identity. */
const EVENT_LOOSE_FIELDS = new Set(['x', 'y', 'kb', 'angle', 'damage']);
/**
 * Pending effects older than this many frames are dropped instead of drawn: a tab that was
 * hidden (the Worker keeps simulating, nothing renders) must not replay minutes of sparks.
 */
const EVENT_MAX_AGE = 8;

/** Identity of a sim event for de-duplication across re-simulations: its type and participants. */
export function eventSignature(e: SimEvent): string {
  let sig: string = e.type;
  const rec = e as unknown as Record<string, unknown>;
  for (const k in rec) {
    if (k === 'type' || EVENT_LOOSE_FIELDS.has(k)) continue;
    sig += `|${k}=${String(rec[k])}`;
  }
  return sig;
}
/** Ticks between two time sync waits, so a correction is spread out and never visible. */
const WAIT_SPACING = 12;

class Advantage {
  private readonly local = new Float32Array(SYNC_WINDOW);
  private readonly remote = new Float32Array(SYNC_WINDOW);
  private li = 0;
  private ri = 0;
  private ln = 0;
  private rn = 0;
  addLocal(v: number): void {
    this.local[this.li] = v;
    this.li = (this.li + 1) % SYNC_WINDOW;
    if (this.ln < SYNC_WINDOW) this.ln++;
  }
  addRemote(v: number): void {
    this.remote[this.ri] = v;
    this.ri = (this.ri + 1) % SYNC_WINDOW;
    if (this.rn < SYNC_WINDOW) this.rn++;
  }
  /** GGPO timesync: frames this side should wait, (local - remote) / 2. 0 until both sides have data. */
  recommendWait(): number {
    if (this.ln < SYNC_WINDOW / 2 || this.rn < SYNC_WINDOW / 2) return 0;
    let l = 0;
    let r = 0;
    for (let i = 0; i < this.ln; i++) l += this.local[i];
    for (let i = 0; i < this.rn; i++) r += this.remote[i];
    return (l / this.ln - r / this.rn) / 2;
  }
}

export class RollbackSession {
  /** The live state. Same object for the whole match; the renderer can hold on to it. */
  readonly state: GameState;
  readonly stats: RollbackStats = {
    rollbacks: 0, maxRollback: 0, resimFrames: 0, stalls: 0, waits: 0,
    hashesCompared: 0, desyncs: 0, lastDesyncFrame: -1, packetsIn: 0, packetsOut: 0,
  };
  /** Frames simulated so far (== state.frame while no rollback is in flight). */
  tick = 0;
  /** True when the last tick() call could not advance because a remote peer is behind. */
  waiting = false;

  private readonly opts: RollbackOptions;
  private readonly rings: InputRing[] = [];
  private readonly used: InputRing[] = [];
  private readonly states = new StateRing(STATE_RING);
  private readonly frameInputs: InputFrame[] = [];
  private readonly scratch: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };
  private readonly scratch2: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };
  private readonly lastRemoteHashFrame = new Int32Array(MAX_PEERS).fill(-1);
  private readonly remotePeers: number[] = [];
  private readonly ownedBy: number[][] = [];
  private readonly seenTick = new Int32Array(MAX_PEERS).fill(-1);
  private readonly ackOfMe = new Int32Array(MAX_PEERS).fill(-1);
  private readonly sync: Advantage[] = [];
  private readonly remoteHashes: Map<number, number>[] = [];
  private readonly localHashes = new Map<number, number>();
  private readonly packetIn: InputPacket = createPacket();
  private readonly packetOut: InputPacket = createPacket();
  private rollbackTo = Number.MAX_SAFE_INTEGER;
  private lastLocalFrame = -1;
  private nextHashFrame = HASH_INTERVAL;
  private sendHashFrame = -1;
  private sendHash = 0;
  private lastWaitTick = -WAIT_SPACING;
  private readonly evFrame = new Int32Array(EVENT_RING).fill(-1);
  private readonly evCounts: Map<string, number>[] = [];
  private readonly evSeen = new Map<string, number>();
  private pendingEvents: SimEvent[] = [];
  private spareEvents: SimEvent[] = [];
  /** Frame of each pending event, parallel to pendingEvents. */
  private pendingFrames: number[] = [];
  private spareFrames: number[] = [];
  private readonly koScratch: SimEvent[] = [];
  private collectEvents = true;
  /** Per fighter index: frame from which the player is retired, or MAX when playing. */
  private readonly retiredFrom: number[] = [];
  private readonly retirements: Retirement[] = [];

  constructor(opts: RollbackOptions) {
    this.opts = opts;
    this.state = opts.sim.createGameState(opts.config);
    const n = opts.config.players.length;
    for (let p = 0; p < MAX_PEERS; p++) {
      this.ownedBy.push([]);
      this.sync.push(new Advantage());
      this.remoteHashes.push(new Map());
    }
    for (let i = 0; i < EVENT_RING; i++) this.evCounts.push(new Map());
    for (let i = 0; i < n; i++) {
      this.rings.push(new InputRing());
      this.used.push(new InputRing());
      this.frameInputs.push({ held: 0, pressed: 0, released: 0, direct: 0 });
      this.retiredFrom.push(Number.MAX_SAFE_INTEGER);
      const owner = opts.owners[i];
      this.ownedBy[owner].push(i);
      if (owner !== opts.peer && this.remotePeers.indexOf(owner) < 0) this.remotePeers.push(owner);
    }
    // Frames before the input delay have no sampled input: they are confirmed empty.
    const delay = Math.max(0, Math.min(4, Math.floor(opts.inputDelay)));
    for (const i of this.ownedBy[opts.peer]) {
      for (let f = 0; f < delay; f++) this.rings[i].put(f, 0, 0, 0, 0);
    }
    this.lastLocalFrame = delay - 1;
    this.packetOut.peer = opts.peer;
    this.packetOut.players = this.ownedBy[opts.peer].slice();
  }

  /**
   * A session for a member that reconnects mid-match: simulate the confirmed history (no
   * events, no network) up to the last frame every player has, keep the last STATE_RING
   * states, then continue as a normal session. Own inputs already in the history are not
   * re-sampled.
   */
  static fromHistory(opts: RollbackOptions, history: InputHistory, retirements: Retirement[] = []): RollbackSession {
    const s = new RollbackSession(opts);
    for (const r of retirements) s.retire(r.players, r.frame);  // the history already holds their inputs
    s.loadHistory(history);
    return s;
  }

  /**
   * Players left the match (the lobby's agent names them and the first frame they have no
   * input for). From `frame` their inputs are empty and confirmed, and before simulating
   * `frame` they are eliminated, so the match end rule gives the win to the remaining side.
   * A frame already simulated is corrected by a rollback.
   */
  retire(players: number[], frame: number, tail?: Retirement['tail']): void {
    const list = players.filter((p) => p >= 0 && p < this.rings.length && this.retiredFrom[p] === Number.MAX_SAFE_INTEGER);
    if (list.length === 0) return;
    const at = Math.max(0, frame);
    // The leaver's last inputs, straight from the relay's log: a packet this peer lost can no
    // longer be re-sent by a peer that is gone.
    if (tail !== undefined) {
      tail.inputs.forEach((d, k) => {
        const idx = players[k];
        if (idx === undefined || idx < 0 || idx >= this.rings.length) return;
        for (let j = 0; j * 4 < d.length; j++) {
          const f = tail.from + j;
          if (f < at) this.accept(idx, f, d[j * 4], d[j * 4 + 1], d[j * 4 + 2], d[j * 4 + 3]);
        }
      });
    }
    for (const p of list) this.retiredFrom[p] = at;
    this.retirements.push({ frame: at, players: list });
    // A peer with nobody left in the match no longer counts for time sync or stalls.
    for (let k = this.remotePeers.length - 1; k >= 0; k--) {
      const q = this.remotePeers[k];
      if (this.ownedBy[q].every((i) => this.isRetired(i))) this.remotePeers.splice(k, 1);
    }
    if (at < this.tick && at < this.rollbackTo) this.rollbackTo = at;
  }

  /** Whether fighter `index` has left the match. */
  isRetired(index: number): boolean {
    return this.retiredFrom[index] !== Number.MAX_SAFE_INTEGER;
  }

  /** Confirmed through: a retired player counts as confirmed once its last real input arrived. */
  private confirmedOf(i: number): number {
    const last = this.rings[i].lastConfirmed;
    return last >= this.retiredFrom[i] - 1 ? Number.MAX_SAFE_INTEGER : last;
  }

  private inputAt(i: number, frame: number, out: InputFrame): void {
    if (frame >= this.retiredFrom[i]) {
      out.held = 0; out.pressed = 0; out.released = 0; out.direct = 0;
      return;
    }
    this.rings[i].inputFor(frame, out);
  }

  /**
   * Eliminates players retiring at `frame`. Returns the events that produced (the KO), taken
   * out of state.events because stepGame clears them first thing; stepFrame puts them back
   * after the step so the frame's effects include the leaver's KO.
   */
  private applyRetirements(frame: number): SimEvent[] {
    const out = this.koScratch;
    out.length = 0;
    const eliminate = this.opts.sim.eliminate;
    if (eliminate === undefined) return out;
    const events = this.state.events;
    for (const r of this.retirements) {
      if (r.frame !== frame) continue;
      const before = events.length;
      for (const p of r.players) eliminate(this.state, p);
      for (let e = before; e < events.length; e++) out.push(events[e]);
      events.length = before;
    }
    return out;
  }

  private loadHistory(history: InputHistory): void {
    const n = this.rings.length;
    const lens: number[] = [];
    for (let i = 0; i < n; i++) lens.push(Math.floor((history.players[i]?.length ?? 0) / 4));
    let target = Number.MAX_SAFE_INTEGER;
    // A retired player's history ends where it left; it does not hold the replay back.
    for (let i = 0; i < n; i++) if (!(this.isRetired(i) && lens[i] >= this.retiredFrom[i])) target = Math.min(target, lens[i]);
    if (!(target > 0) || target === Number.MAX_SAFE_INTEGER) return;
    this.collectEvents = false;
    for (let f = 0; f < target; f++) {
      for (let i = 0; i < n; i++) {
        const d = history.players[i];
        const out = this.frameInputs[i];
        if (f >= this.retiredFrom[i] || f >= lens[i]) {
          out.held = 0; out.pressed = 0; out.released = 0; out.direct = 0;
        } else {
          out.held = d[f * 4]; out.pressed = d[f * 4 + 1]; out.released = d[f * 4 + 2]; out.direct = d[f * 4 + 3];
        }
        this.used[i].set(f, out.held, out.pressed, out.released, out.direct);
      }
      if (f >= target - STATE_RING) this.states.save(f, this.state);
      this.applyRetirements(f);
      this.opts.sim.stepGame(this.state, this.frameInputs);
    }
    this.collectEvents = true;
    this.tick = target;
    const from = Math.max(0, target - 64);
    for (let i = 0; i < n; i++) {
      const ring = this.rings[i];
      ring.seed(from);
      const d = history.players[i];
      for (let f = from; f < lens[i]; f++) ring.put(f, d[f * 4], d[f * 4 + 1], d[f * 4 + 2], d[f * 4 + 3]);
    }
    // Own frames between the end of what the relay heard and the first frame this session will
    // sample (tick + delay) were never sent: fill them with a release of whatever was held,
    // confirmed, so every peer simulates the same thing there.
    const firstSample = target + this.inputDelay;
    for (const i of this.ownedBy[this.opts.peer]) {
      const ring = this.rings[i];
      const d = history.players[i];
      const lastHeld = lens[i] > 0 ? d[(lens[i] - 1) * 4] : 0;
      for (let f = lens[i]; f < firstSample; f++) ring.put(f, 0, 0, f === lens[i] ? lastHeld : 0, 0);
    }
    this.lastLocalFrame = firstSample - 1;
    this.nextHashFrame = Math.ceil(target / HASH_INTERVAL) * HASH_INTERVAL;
  }

  /**
   * Sim events to show since the last call, each exactly once (docs/LAN.md, rollback visuals):
   * a frame's events go out the first time it is simulated; a re-simulation only adds events
   * the earlier run of that frame did not have (a hit that only exists in the corrected
   * timeline), so a resim never repeats a spark and a corrected hit still shows.
   */
  drainEvents(): SimEvent[] {
    this.pruneEvents(this.tick - EVENT_MAX_AGE);
    const out = this.pendingEvents;
    this.pendingEvents = this.spareEvents;
    this.pendingEvents.length = 0;
    this.spareEvents = out;
    const frames = this.pendingFrames;
    this.pendingFrames = this.spareFrames;
    this.pendingFrames.length = 0;
    this.spareFrames = frames;
    return out;
  }

  /** Effects waiting to be drawn (bounded by EVENT_MAX_AGE frames of play). */
  pendingEventCount(): number {
    return this.pendingEvents.length;
  }

  /** Drop pending effects from frames before `oldest`. */
  private pruneEvents(oldest: number): void {
    const frames = this.pendingFrames;
    let cut = 0;
    while (cut < frames.length && frames[cut] < oldest) cut++;
    if (cut === 0) return;
    this.pendingEvents.splice(0, cut);
    frames.splice(0, cut);
  }

  private recordEvents(frame: number): void {
    const events = this.state.events;
    const i = frame % EVENT_RING;
    const counts = this.evCounts[i];
    if (this.evFrame[i] !== frame) {
      this.evFrame[i] = frame;
      counts.clear();
    }
    if (events.length === 0) return;
    const seen = this.evSeen;
    seen.clear();
    for (let e = 0; e < events.length; e++) {
      const sig = eventSignature(events[e]);
      const n = (seen.get(sig) ?? 0) + 1;
      seen.set(sig, n);
      if (n > (counts.get(sig) ?? 0)) {
        counts.set(sig, n);
        this.pendingEvents.push(events[e]);
        this.pendingFrames.push(frame);
      }
    }
    if (this.pendingFrames[0] < frame - EVENT_MAX_AGE) this.pruneEvents(frame - EVENT_MAX_AGE);
  }

  get inputDelay(): number {
    return Math.max(0, Math.min(4, Math.floor(this.opts.inputDelay)));
  }

  /** Highest frame for which every player's input is confirmed. */
  confirmedFrame(): number {
    let m = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < this.rings.length; i++) m = Math.min(m, this.confirmedOf(i));
    return m;
  }

  /**
   * One fixed step: read the network, roll back and re-simulate if a prediction was wrong, then
   * advance one frame unless a remote peer is too far behind (or `advance` is false). Returns
   * true when the sim advanced.
   */
  tickOnce(advance = true): boolean {
    this.receive();
    this.applyRollback();

    let advanced = false;
    this.waiting = false;
    if (advance) {
      if (this.predictionExhausted()) {
        this.stats.stalls++;
        this.waiting = true;
      } else if (this.shouldWait()) {
        this.stats.waits++;
        this.lastWaitTick = this.tick;
      } else {
        this.sampleLocal();
        this.states.save(this.tick, this.state);
        this.stepFrame(this.tick);
        this.tick++;
        advanced = true;
      }
    }
    for (const q of this.remotePeers) if (this.seenTick[q] >= 0) this.sync[q].addLocal(this.tick - this.seenTick[q]);
    this.checkHashes();
    this.send();
    return advanced;
  }

  private receive(): void {
    this.opts.transport.poll((buf) => {
      const pk = this.packetIn;
      if (!decodePacket(buf, pk)) return;
      const peer = pk.peer;
      if (peer === this.opts.peer || peer >= MAX_PEERS) return;
      this.stats.packetsIn++;
      if (pk.tick > this.seenTick[peer]) this.seenTick[peer] = pk.tick;
      const me = this.opts.peer;
      if (pk.seenTick[me] >= 0) this.sync[peer].addRemote(pk.tick - pk.seenTick[me]);
      if (pk.ack[me] > this.ackOfMe[peer]) this.ackOfMe[peer] = pk.ack[me];
      const n = pk.players.length;
      for (let j = 0; j < pk.frames; j++) {
        const frame = pk.firstFrame + j;
        for (let k = 0; k < n; k++) {
          const idx = pk.players[k];
          if (idx >= this.rings.length || this.opts.owners[idx] !== peer) continue;
          const o = (j * n + k) * 4;
          this.accept(idx, frame, pk.inputs[o], pk.inputs[o + 1], pk.inputs[o + 2], pk.inputs[o + 3]);
        }
      }
      if (pk.hashFrame > this.lastRemoteHashFrame[peer]) {
        this.lastRemoteHashFrame[peer] = pk.hashFrame;
        this.remoteHashes[peer].set(pk.hashFrame, pk.hash);
        this.compareHash(pk.hashFrame);
      }
    });
  }

  /** Store a confirmed input; if that frame was simulated with something else, roll back to it. */
  private accept(idx: number, frame: number, held: number, pressed: number, released: number, direct: number): void {
    const ring = this.rings[idx];
    // The input ring holds INPUT_RING frames; a frame that far past what is confirmed would
    // overwrite live entries. An honest peer never sends more than MAX_SEND past our ack.
    if (frame > ring.lastConfirmed + MAX_ACCEPT_AHEAD) return;
    if (!ring.put(frame, held, pressed, released, direct)) return;
    if (frame >= this.tick) return;
    ring.read(frame, this.scratch);
    const used = this.used[idx];
    used.read(frame, this.scratch2);
    if (!used.has(frame) || !inputsEqual(this.scratch, this.scratch2)) {
      if (frame < this.rollbackTo) this.rollbackTo = frame;
    }
  }

  private applyRollback(): void {
    const from = this.rollbackTo;
    this.rollbackTo = Number.MAX_SAFE_INTEGER;
    if (from >= this.tick) return;
    const snap = this.states.get(from);
    if (snap === null) {
      // Outside the ring: cannot happen while MAX_PREDICTION < STATE_RING. Count it loudly.
      this.stats.desyncs++;
      this.stats.lastDesyncFrame = from;
      this.opts.onDesync?.(from, -1, 0, 0);
      return;
    }
    restoreInto(this.state, snap);
    const depth = this.tick - from;
    this.stats.rollbacks++;
    this.stats.resimFrames += depth;
    if (depth > this.stats.maxRollback) this.stats.maxRollback = depth;
    for (let f = from; f < this.tick; f++) {
      if (f > from) this.states.save(f, this.state);
      this.stepFrame(f);
    }
  }

  private stepFrame(frame: number): void {
    for (let i = 0; i < this.rings.length; i++) {
      const out = this.frameInputs[i];
      this.inputAt(i, frame, out);
      this.used[i].set(frame, out.held, out.pressed, out.released, out.direct ?? 0);
    }
    const ko = this.applyRetirements(frame);
    this.opts.sim.stepGame(this.state, this.frameInputs);
    for (let e = 0; e < ko.length; e++) this.state.events.push(ko[e]);
    if (this.collectEvents) this.recordEvents(frame);
  }

  private predictionExhausted(): boolean {
    for (const q of this.remotePeers) {
      for (const i of this.ownedBy[q]) {
        if (this.tick - this.confirmedOf(i) > MAX_PREDICTION) return true;
      }
    }
    return false;
  }

  private shouldWait(): boolean {
    if (this.tick - this.lastWaitTick < WAIT_SPACING) return false;
    let wait = 0;
    for (const q of this.remotePeers) wait = Math.max(wait, this.sync[q].recommendWait());
    return wait >= 1;
  }

  private sampleLocal(): void {
    const frame = this.tick + this.inputDelay;
    if (frame <= this.lastLocalFrame) return;
    for (const i of this.ownedBy[this.opts.peer]) {
      const src = this.opts.sources[i];
      const inp = src === null || src === undefined ? this.scratch : src(frame, this.state);
      if (src === null || src === undefined) {
        inp.held = 0; inp.pressed = 0; inp.released = 0; inp.direct = 0;
      }
      this.rings[i].put(frame, inp.held, inp.pressed, inp.released, inp.direct ?? 0);
    }
    this.lastLocalFrame = frame;
  }

  private send(): void {
    const pk = this.packetOut;
    const mine = pk.players;
    const last = this.lastLocalFrame;
    let from = last + 1;
    for (const q of this.remotePeers) from = Math.min(from, this.ackOfMe[q] + 1);
    from = Math.max(0, Math.min(from, last - MIN_SEND + 1));
    const to = Math.min(last, from + MAX_SEND - 1);
    const frames = mine.length === 0 || to < from ? 0 : to - from + 1;
    pk.firstFrame = from;
    pk.frames = frames;
    pk.tick = this.tick;
    for (let q = 0; q < MAX_PEERS; q++) {
      pk.seenTick[q] = this.seenTick[q];
      let ack = -1;
      const owned = this.ownedBy[q];
      if (owned.length > 0 && q !== this.opts.peer) {
        ack = Number.MAX_SAFE_INTEGER;
        for (const i of owned) ack = Math.min(ack, this.rings[i].lastConfirmed);
      }
      pk.ack[q] = ack;
    }
    pk.hashFrame = this.sendHashFrame;
    pk.hash = this.sendHash;
    const need = frames * mine.length * 4;
    if (pk.inputs.length < need) pk.inputs = new Int32Array(Math.max(need, MAX_SEND * MAX_PEERS * 4));
    const s = this.scratch;
    for (let j = 0; j < frames; j++) {
      for (let k = 0; k < mine.length; k++) {
        this.rings[mine[k]].read(from + j, s);
        const o = (j * mine.length + k) * 4;
        pk.inputs[o] = s.held;
        pk.inputs[o + 1] = s.pressed;
        pk.inputs[o + 2] = s.released;
        pk.inputs[o + 3] = s.direct ?? 0;
      }
    }
    this.opts.transport.send(encodePacket(pk));
    this.stats.packetsOut++;
  }

  private checkHashes(): void {
    const confirmed = this.confirmedFrame();
    while (this.nextHashFrame < this.tick && this.nextHashFrame <= confirmed + 1) {
      const frame = this.nextHashFrame;
      this.nextHashFrame += HASH_INTERVAL;
      const snap = this.states.get(frame);
      if (snap === null) continue;
      const h = hashGameState(snap);
      this.localHashes.set(frame, h);
      this.sendHashFrame = frame;
      this.sendHash = h;
      this.compareHash(frame);
      // Keep a few seconds of history for late remote hashes.
      this.localHashes.delete(frame - HASH_INTERVAL * 8);
    }
  }

  private compareHash(frame: number): void {
    const local = this.localHashes.get(frame);
    if (local === undefined) return;
    for (const q of this.remotePeers) {
      const map = this.remoteHashes[q];
      const remote = map.get(frame);
      if (remote === undefined) continue;
      map.delete(frame);
      this.stats.hashesCompared++;
      if (remote !== local) {
        this.stats.desyncs++;
        this.stats.lastDesyncFrame = frame;
        this.opts.onDesync?.(frame, q, local, remote);
      }
    }
  }

  /** Hash of the live state, for tests and the debug overlay. */
  liveHash(): number {
    return hashGameState(this.state);
  }
}
