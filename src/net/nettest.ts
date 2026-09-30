import { cpuInput, warmAevalmere } from '../ai';
import { createRng, nextFloat } from '../core/rng';
import { Btn } from '../core/types';
import type { GameState, InputFrame, MatchConfig } from '../core/types';
import { createGameState, stepGame } from '../sim';
import { eliminateFighter } from './eliminate';
import { hashGameState } from './hash';
import { InputLog } from './inputlog';
import type { InputHistory, Retirement } from './protocol';
import { RollbackSession, type LocalSource, type RollbackOptions } from './rollback';
import type { NetTransport } from './transport';

/**
 * Rollback harness (docs/LAN.md section 6). In-process peers over a fake relay with one-way
 * delay, jitter and packet loss play scripted matches. Every scenario checks that:
 *
 * - every peer ends on the same state as an offline replay of the confirmed input log (the log
 *   the relay keeps, the same class the LAN agent uses for reconnects);
 * - for fully scripted scenarios, that log also equals the scripted inputs;
 * - no 60-frame hash differs, and at least one was compared;
 * - no hit effect is lost or duplicated: every hit of the replay is emitted, and extra emitted
 *   hits (predicted, then corrected away) stay a small fraction.
 *
 * Run: npx --yes tsx src/net/nettest.ts
 */

declare const process: {
  stdout: { write(text: string): void };
  exitCode?: number;
  memoryUsage(): { heapUsed: number };
};

const INPUT_DELAY = 1;

/** xorshift32, seeded, for loss decisions. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * A relay like src/net/lobbycore.ts. Two link kinds:
 *
 * - 'ws' (the LAN agent): every packet reaches the relay (TCP) and is logged there, then goes to
 *   each other peer after the one-way delay, with jitter, and may be lost on that leg;
 * - 'rtc' (the in-browser mode): the relay runs in peer 0's tab, so peer 0's own packets reach it
 *   at once. A guest's packet crosses the unordered, maxRetransmits 0 data channel twice, guest
 *   to host (lost there: never logged, never relayed) and host to guest, each leg lossy and
 *   jittered by up to 3 frames, so packets also arrive out of order. Lobby messages (the
 *   retirement) use the reliable channel and are not simulated here: the scenario delivers them.
 *
 * A blocked peer is cut off in both directions and nothing it sends is logged.
 */
class FakeHub {
  now = 0;
  private queue: { at: number; to: number; data: Uint8Array }[] = [];
  private inbox: Uint8Array[][] = [];
  private readonly rand: () => number;
  readonly blocked = new Set<number>();
  readonly log: InputLog;
  sent = 0;
  dropped = 0;

  constructor(readonly peers: number, readonly delay: number, readonly loss: number, seed: number, private readonly owners: number[],
    readonly link: 'ws' | 'rtc' = 'ws') {
    this.rand = rng(seed);
    this.log = new InputLog(owners.length);
    for (let i = 0; i < peers; i++) this.inbox.push([]);
  }

  transport(peer: number): NetTransport {
    return {
      send: (data: Uint8Array) => {
        if (this.blocked.has(peer)) return;
        const rtc = this.link === 'rtc';
        if (rtc && peer !== 0) {
          // Guest to host leg of the unordered channel.
          this.sent++;
          if (this.rand() < this.loss) { this.dropped++; return; }
        }
        this.log.record(data, (idx) => this.owners[idx] === peer);
        for (let to = 0; to < this.peers; to++) {
          if (to === peer || this.blocked.has(to)) continue;
          if (rtc && to === 0) {
            // Arrived at the host tab: its own session reads it after the uplink delay.
            this.queue.push({ at: this.now + this.delay, to, data: data.slice() });
            continue;
          }
          this.sent++;
          if (this.rand() < this.loss) { this.dropped++; continue; }
          const jitter = rtc ? Math.floor(this.rand() * 4) : this.delay > 0 && this.rand() < 0.2 ? 1 : 0;
          this.queue.push({ at: this.now + this.delay + jitter, to, data: data.slice() });
        }
      },
      poll: (onPacket: (p: Uint8Array) => void) => {
        const box = this.inbox[peer];
        this.inbox[peer] = [];
        for (const p of box) onPacket(p);
      },
    };
  }

  deliver(): void {
    const keep: typeof this.queue = [];
    for (const q of this.queue) {
      if (q.at > this.now) keep.push(q);
      else if (!this.blocked.has(q.to)) this.inbox[q.to].push(q.data);
    }
    this.queue = keep;
  }
}

const PATTERNS = [
  0, Btn.Left, Btn.Right, Btn.Left | Btn.Attack, Btn.Right | Btn.Special, Btn.Jump, Btn.Up | Btn.Special,
  Btn.Down, Btn.Shield, Btn.Attack, Btn.Right | Btn.Jump, Btn.Left | Btn.Grab, Btn.Down | Btn.Attack,
  Btn.Special, Btn.Left | Btn.Jump | Btn.Attack, Btn.Right | Btn.Down,
];

function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** What a scripted player holds on sample `t` (changes every 5..12 frames). */
function heldAt(player: number, t: number): number {
  if (t < 0) return 0;
  const block = Math.floor(t / (5 + (player % 4) * 2 + 1));
  return PATTERNS[mix(player * 7919, block) % PATTERNS.length];
}

function scripted(player: number, t: number): InputFrame {
  const held = heldAt(player, t);
  const prev = heldAt(player, t - 1);
  return { held, pressed: held & ~prev, released: prev & ~held, direct: 0 };
}

function makeConfig(players: number, cpus: number[], stocks: number): MatchConfig {
  const list: MatchConfig['players'] = [];
  for (let i = 0; i < players; i++) {
    const cpu = cpus.includes(i);
    list.push({ slot: i, charId: 'aeval', cpu, cpuLevel: cpu ? 7 : 0, ...(cpu ? {} : { name: `N${i}` }), team: i < 2 ? 0 : 1 });
  }
  return { stageId: 'tidegate', players: list, stocks, timeLimitSec: 0, seed: 12345, finalSmash: false, teams: players === 4 };
}

/** Offline replay of a history; returns the state and the number of hit events. */
/**
 * Offline replay of a history. Retired players get empty input from their frame on and are
 * eliminated right before it, as every peer does. `finishedAt` is the frame the match ended on.
 */
function replay(config: MatchConfig, history: InputHistory, frames: number, retirements: Retirement[] = []): { state: GameState; hits: number } {
  const state = createGameState(config);
  const inputs: InputFrame[] = config.players.map(() => ({ held: 0, pressed: 0, released: 0, direct: 0 }));
  const retiredFrom = config.players.map(() => Number.MAX_SAFE_INTEGER);
  for (const r of retirements) for (const p of r.players) retiredFrom[p] = r.frame;
  let hits = 0;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < inputs.length; i++) {
      const d = history.players[i];
      if (f >= retiredFrom[i] || f * 4 >= d.length) {
        inputs[i].held = 0; inputs[i].pressed = 0; inputs[i].released = 0; inputs[i].direct = 0;
      } else {
        inputs[i].held = d[f * 4]; inputs[i].pressed = d[f * 4 + 1]; inputs[i].released = d[f * 4 + 2]; inputs[i].direct = d[f * 4 + 3];
      }
    }
    for (const r of retirements) if (r.frame === f) for (const p of r.players) eliminateFighter(state, p);
    stepGame(state, inputs);
    for (const e of state.events) if (e.type === 'hit') hits++;
  }
  return { state, hits };
}

function scriptedHistory(players: number, frames: number): InputHistory {
  const out: number[][] = [];
  for (let i = 0; i < players; i++) {
    const arr: number[] = [];
    for (let f = 0; f < frames; f++) {
      const x = f < INPUT_DELAY ? { held: 0, pressed: 0, released: 0, direct: 0 } : scripted(i, f - INPUT_DELAY);
      arr.push(x.held, x.pressed, x.released, x.direct ?? 0);
    }
    out.push(arr);
  }
  return { players: out };
}

interface Scenario {
  name: string;
  peers: number;
  /** Per fighter index, the owning peer. */
  owners: number[];
  delay: number;
  loss: number;
  startLag: number[];
  seed: number;
  frames: number;
  /** Fighter indices driven by the real CPU (owned by their owner peer, like CPU fill). */
  cpus?: number[];
  stocks?: number;
  /** Cut this peer off at `from` for `clocks` ticks, then rebuild it from the relay's log. */
  drop?: { peer: number; from: number; clocks: number };
  /** This peer leaves for good at clock `at`; the others retire its players (R2). */
  leave?: { peer: number; at: number };
  /** Expected after a leave: the fighter index that wins (-1 = the match must still be running at the end). */
  expectWinner?: number;
  corruptPeer?: number;
  /** Sample heap every N frames (soak). */
  heapEvery?: number;
  /** 'rtc': the in-browser mode's links (see FakeHub). Default 'ws'. */
  link?: 'ws' | 'rtc';
}

interface ScenarioResult {
  name: string;
  pass: boolean;
  finalHashes: string[];
  referenceHash: string;
  scriptedMatch: boolean | null;
  maxRollback: number;
  rollbacks: number;
  resimFrames: number;
  stalls: number;
  waits: number;
  hashesCompared: number;
  desyncs: number;
  hitsReference: number;
  hitsEmitted: number[];
  packetsSent: number;
  packetsDropped: number;
  clocks: number;
  resumed?: boolean;
  leave?: { frame: number; finished: boolean; winnerSlot: number; winnerTeam: number };
  heapMB?: number[];
  logKB?: number;
  ms: number;
}

function gc(): void {
  const g = (globalThis as unknown as { gc?: () => void }).gc;
  if (g !== undefined) g();
}

function heapMB(): number {
  gc();
  return Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10;
}

function runScenario(sc: Scenario): ScenarioResult {
  const t0 = performance.now();
  const players = sc.owners.length;
  const cpus = sc.cpus ?? [];
  const config = makeConfig(players, cpus, sc.stocks ?? 3);
  const hub = new FakeHub(sc.peers, sc.delay, sc.loss, sc.seed, sc.owners, sc.link ?? 'ws');
  let desyncLog = '';
  const hits: number[] = new Array(sc.peers).fill(0);
  const cpuRng = createRng(0xc0ffee);
  const rand = (): number => nextFloat(cpuRng);

  /** The config object each peer's session was built with (R10: it must survive every rollback). */
  const configs: MatchConfig[] = [];
  function options(p: number): RollbackOptions {
    const sources: (LocalSource | null)[] = [];
    for (let i = 0; i < players; i++) {
      const idx = i;
      if (sc.owners[i] !== p) sources.push(null);
      else if (cpus.includes(i)) sources.push((_f: number, st: GameState) => cpuInput(st, config.players[idx].slot, config.players[idx].cpuLevel, rand));
      else sources.push((frame: number) => scripted(idx, frame - INPUT_DELAY));
    }
    configs[p] = JSON.parse(JSON.stringify(config)) as MatchConfig;
    return {
      config: configs[p],
      sim: {
        createGameState,
        eliminate: eliminateFighter,
        // A deliberately broken peer: nudges one fighter once, to prove the hash check fires.
        stepGame: p === sc.corruptPeer
          ? (st: GameState, inp: InputFrame[]) => { stepGame(st, inp); if (st.frame === 500) st.fighters[0].x += 0.001; }
          : stepGame,
      },
      peer: p,
      owners: sc.owners,
      sources,
      transport: hub.transport(p),
      inputDelay: INPUT_DELAY,
      onDesync: (frame, peer, local, remote) => {
        desyncLog += ` [peer ${p} vs ${peer} frame ${frame}: ${local.toString(16)} != ${remote.toString(16)}]`;
      },
    };
  }

  const sessions: RollbackSession[] = [];
  for (let p = 0; p < sc.peers; p++) sessions.push(new RollbackSession(options(p)));
  const heap: number[] = [];
  if (sc.heapEvery !== undefined) heap.push(heapMB());
  let resumed = false;
  const leaverSlots = new Set<number>();
  const koSeen: number[] = new Array(sc.peers).fill(0);
  const retirements: Retirement[] = [];
  const left = new Set<number>();

  let clock = 0;
  const LIMIT = sc.frames * 6 + 1000;
  for (; clock < LIMIT; clock++) {
    hub.now = clock;
    if (sc.drop !== undefined) {
      if (clock === sc.drop.from) hub.blocked.add(sc.drop.peer);
      if (clock === sc.drop.from + sc.drop.clocks) {
        hub.blocked.delete(sc.drop.peer);
        sessions[sc.drop.peer] = RollbackSession.fromHistory(options(sc.drop.peer), hub.log.history());
        resumed = true;
      }
    }
    if (sc.leave !== undefined && clock === sc.leave.at) {
      // Like server/lobbyhost.ts gone(): the leaver's players retire at the first frame the
      // relay has no input for, and every remaining peer is told.
      const lp = sc.leave.peer;
      hub.blocked.add(lp);
      left.add(lp);
      const players = sc.owners.map((o, i) => (o === lp ? i : -1)).filter((i) => i >= 0);
      for (const i of players) leaverSlots.add(config.players[i].slot);
      const frame = Math.min(...players.map((i) => hub.log.last[i])) + 1;
      const from = Math.max(0, frame - 48);
      const tail = { from, inputs: players.map((i) => hub.log.range(i, from, frame - 1)) };
      retirements.push({ frame, players });
      for (let p = 0; p < sc.peers; p++) if (!left.has(p)) sessions[p].retire(players, frame, tail);
    }
    hub.deliver();
    let done = true;
    for (let p = 0; p < sc.peers; p++) {
      const s = sessions[p];
      if (left.has(p)) continue;
      if (clock < sc.startLag[p] || hub.blocked.has(p)) { done = false; continue; }
      s.tickOnce(s.tick < sc.frames);
      for (const e of s.drainEvents()) {
        if (e.type === 'hit') hits[p]++;
        if (e.type === 'ko' && leaverSlots.has(e.slot)) koSeen[p]++;
      }
      if (s.tick < sc.frames || s.confirmedFrame() < sc.frames - 1) done = false;
    }
    if (sc.heapEvery !== undefined && clock > 0 && clock % sc.heapEvery === 0) heap.push(heapMB());
    if (done) break;
  }
  if (sc.heapEvery !== undefined) heap.push(heapMB());

  const history = hub.log.history();
  const ref = replay(config, history, sc.frames, retirements);
  const refHash = hashGameState(ref.state);
  let scriptedMatch: boolean | null = null;
  // A resumed peer releases its buttons across the gap, so its log legitimately leaves the script.
  if (cpus.length === 0 && sc.drop === undefined && sc.leave === undefined) {
    const sh = scriptedHistory(players, sc.frames);
    scriptedMatch = hashGameState(replay(config, sh, sc.frames).state) === refHash;
  }
  const staying = sessions.filter((_s, p) => !left.has(p));
  const hashes = staying.map((s) => s.liveHash());
  let rollbacks = 0, maxRollback = 0, resim = 0, stalls = 0, waits = 0, compared = 0, desyncs = 0;
  for (const s of staying) {
    rollbacks += s.stats.rollbacks;
    resim += s.stats.resimFrames;
    stalls += s.stats.stalls;
    waits += s.stats.waits;
    compared += s.stats.hashesCompared;
    desyncs += s.stats.desyncs;
    maxRollback = Math.max(maxRollback, s.stats.maxRollback);
  }
  const allTicked = staying.every((s) => s.tick === sc.frames && s.state.frame === sc.frames);
  let leaveInfo: ScenarioResult['leave'];
  let leaveOk = true;
  // R10: every session still holds the config object it was built with, after all rollbacks.
  const configOk = sessions.every((s, p) => left.has(p) || s.state.config === configs[p]);
  if (sc.leave !== undefined) {
    // R14: every remaining peer drew the leaver's KO.
    leaveOk = sessions.every((_s, p) => left.has(p) || koSeen[p] > 0);
    const st = staying[0].state;
    const winnerIdx = st.fighters.findIndex((f) => f.slot === st.winner);
    leaveInfo = { frame: retirements[0]?.frame ?? -1, finished: st.finished, winnerSlot: st.winner, winnerTeam: st.winnerTeam ?? -1 };
    leaveOk = leaveOk && (sc.expectWinner === -1 ? !st.finished || st.endFrame > (retirements[0]?.frame ?? 0) + 1 : st.finished && winnerIdx === sc.expectWinner && st.endFrame === (retirements[0]?.frame ?? -1) + 1);
  }
  // A resumed peer re-simulated the history silently, so its effect count restarts there.
  const hitsOk = hits.every((n, p) => left.has(p) || (resumed && p === sc.drop?.peer) || (n >= ref.hits && n <= ref.hits * 1.25 + 5));
  const pass = sc.corruptPeer !== undefined
    ? desyncs > 0
    : allTicked && hashes.every((h) => h === refHash) && desyncs === 0 && compared > 0 && scriptedMatch !== false && hitsOk &&
      (sc.drop === undefined || resumed) && leaveOk && configOk;
  if (!configOk) process.stdout.write('  config identity lost across a rollback\n');
  if (sc.leave !== undefined) process.stdout.write(`  leaver KO effects seen per peer: ${koSeen.join('/')}\n`);
  if (desyncLog !== '' && sc.corruptPeer === undefined) process.stdout.write(`  desync log:${desyncLog.slice(0, 200)}\n`);
  return {
    name: sc.name, pass,
    finalHashes: hashes.map((h) => h.toString(16)), referenceHash: refHash.toString(16), scriptedMatch,
    maxRollback, rollbacks, resimFrames: resim, stalls, waits, hashesCompared: compared, desyncs,
    hitsReference: ref.hits, hitsEmitted: hits,
    packetsSent: hub.sent, packetsDropped: hub.dropped, clocks: clock,
    ...(sc.drop !== undefined ? { resumed } : {}),
    ...(leaveInfo !== undefined ? { leave: leaveInfo } : {}),
    ...(sc.heapEvery !== undefined ? { heapMB: heap, logKB: Math.round(hub.log.bytes() / 1024) } : {}),
    ms: Math.round(performance.now() - t0),
  };
}

const SCENARIOS: Scenario[] = [
  ...[0, 2, 6].map((delay): Scenario => ({
    name: `2 peers, ${delay}f one-way, 5% loss`, peers: 2, owners: [0, 1], delay, loss: 0.05, startLag: [0, 3], seed: 1000 + delay, frames: 1800,
  })),
  { name: '3 peers / 4 players (peer 0 owns 2), 3f, 5% loss', peers: 3, owners: [0, 1, 0, 2], delay: 3, loss: 0.05, startLag: [0, 2, 5], seed: 77, frames: 1800 },
  { name: '4 peers, 4f one-way, 10% loss', peers: 4, owners: [0, 1, 2, 3], delay: 4, loss: 0.1, startLag: [0, 1, 3, 6], seed: 404, frames: 1800 },
  { name: 'reconnect: peer 1 drops for 90 frames at 600, resumes from the relay log', peers: 2, owners: [0, 1], delay: 2, loss: 0.05, startLag: [0, 0], seed: 90, frames: 1800, drop: { peer: 1, from: 600, clocks: 90 } },
  { name: 'CPU fill: 2 humans + 2 real CPUs (level 7) run by the host, 2v2 teams, 2f, 5% loss', peers: 2, owners: [0, 1, 0, 0], delay: 2, loss: 0.05, startLag: [0, 2], seed: 22, frames: 1800, cpus: [2, 3] },
  { name: 'leave: peer 1 of 2 leaves at 900; the remaining player wins on the next frame', peers: 2, owners: [0, 1], delay: 2, loss: 0.05, startLag: [0, 1], seed: 31, frames: 1800, leave: { peer: 1, at: 900 }, expectWinner: 0 },
  { name: 'leave, teams: 2v2 over 3 peers, peer 2 (player 4) leaves at 900; its teammate plays on', peers: 3, owners: [0, 0, 1, 2], delay: 2, loss: 0.05, startLag: [0, 1, 2], seed: 32, frames: 1800, leave: { peer: 2, at: 900 }, expectWinner: -1 },
  { name: 'soak: 5 minutes (18000 frames), 2f one-way, 5% loss', peers: 2, owners: [0, 1], delay: 2, loss: 0.05, startLag: [0, 1], seed: 5, frames: 18000, stocks: 99, heapEvery: 3000 },
  { name: 'desync control (peer 1 drifts at frame 500)', peers: 2, owners: [0, 1], delay: 2, loss: 0.05, startLag: [0, 0], seed: 5, frames: 900, corruptPeer: 1 },
];

/**
 * The in-browser mode: the same scenarios over the WebRTC-like fake links, with loss on both
 * legs of the unordered channel and reordering. The reconnect scenario is left out: that mode
 * has no resume (a reload counts as leaving).
 */
const RTC_SCENARIOS: Scenario[] = SCENARIOS
  .filter((sc) => sc.drop === undefined)
  .map((sc) => ({ ...sc, name: `rtc: ${sc.name}`, link: 'rtc' as const, seed: sc.seed + 7000 }));
RTC_SCENARIOS.push({
  name: 'rtc: 4 peers, 2f one-way, 20% loss per leg of the unordered channel', peers: 4, owners: [0, 1, 2, 3], delay: 2, loss: 0.2,
  startLag: [0, 1, 2, 4], seed: 2020, frames: 1800, link: 'rtc',
});

// Tick cost, for the report.
{
  const s = new RollbackSession({
    config: makeConfig(4, [], 3), sim: { createGameState, stepGame }, peer: 0, owners: [0, 0, 0, 0],
    sources: [0, 1, 2, 3].map((i) => (f: number) => scripted(i, f)), transport: { send() {}, poll() {} }, inputDelay: 0,
  });
  const t0 = performance.now();
  for (let i = 0; i < 3600; i++) s.tickOnce(true);
  const perTick = ((performance.now() - t0) / 3600) * 1000;
  process.stdout.write(`tick cost (4 players, save + step + packet): ${perTick.toFixed(1)} us\n`);
}

/**
 * R13: a tab that simulates without rendering (hidden) must not pile up effects. 4 scripted
 * players, 3600 frames, nothing drained: the pending list stays within EVENT_MAX_AGE frames.
 */
function pendingBoundCheck(): { pass: boolean; detail: string } {
  const s = new RollbackSession({
    config: makeConfig(4, [], 99), sim: { createGameState, stepGame }, peer: 0, owners: [0, 0, 0, 0],
    sources: [0, 1, 2, 3].map((i) => (f: number) => scripted(i, f)), transport: { send() {}, poll() {} }, inputDelay: 0,
  });
  let maxPending = 0;
  let total = 0;
  for (let i = 0; i < 3600; i++) {
    s.tickOnce(true);
    total += s.state.events.length;
    maxPending = Math.max(maxPending, s.pendingEventCount());
  }
  const drained = s.drainEvents().length;
  const pass = total > 0 && maxPending <= 64 && drained <= maxPending;
  return { pass, detail: `${total} events over 3600 undrawn frames, at most ${maxPending} pending, ${drained} drawn on return` };
}

/**
 * R10: a level 10 CPU on the host warms once per match. The AI keys a new match on the config
 * object, so a rollback that swapped it would re-warm mid-match (a hitch as long as a warm).
 * The host's slowest tick must stay well under one warm, measured on this machine.
 */
function warmOnceCheck(): { pass: boolean; detail: string } {
  const base = makeConfig(3, [1], 3);
  base.players[1].cpuLevel = 10;
  base.teams = false;
  const owners = [0, 0, 1];
  const hub = new FakeHub(2, 2, 0.05, 99, owners);
  const cpuRng = createRng(7);
  const rand = (): number => nextFloat(cpuRng);
  const cfg0 = JSON.parse(JSON.stringify(base)) as MatchConfig;
  warmAevalmere(cfg0);
  const mk = (p: number, cfg: MatchConfig): RollbackSession => new RollbackSession({
    config: cfg, sim: { createGameState, stepGame }, peer: p, owners,
    sources: [0, 1, 2].map((i) => {
      if (owners[i] !== p) return null;
      if (i === 1) return (_f: number, st: GameState) => cpuInput(st, 1, 10, rand);
      return (f: number) => scripted(i, f - INPUT_DELAY);
    }),
    transport: hub.transport(p), inputDelay: INPUT_DELAY,
  });
  const host = mk(0, cfg0);
  const guest = mk(1, JSON.parse(JSON.stringify(base)) as MatchConfig);
  let maxTick = 0;
  for (let clock = 0; clock < 900; clock++) {
    hub.now = clock;
    hub.deliver();
    const t0 = performance.now();
    host.tickOnce(true);
    const dt = performance.now() - t0;
    if (clock > 30) maxTick = Math.max(maxTick, dt);
    guest.tickOnce(true);
  }
  const tw = performance.now();
  warmAevalmere(JSON.parse(JSON.stringify(base)) as MatchConfig);
  const warmMs = performance.now() - tw;
  const identity = host.state.config === cfg0;
  const pass = identity && host.stats.rollbacks > 0 && maxTick < warmMs / 2;
  return {
    pass,
    detail: `config kept ${identity} over ${host.stats.rollbacks} rollbacks; slowest host tick ${maxTick.toFixed(1)} ms vs one warm ${warmMs.toFixed(0)} ms`,
  };
}

let ok = true;
const results: ScenarioResult[] = [];
for (const [name, check] of [['R13 pending effects stay bounded while hidden', pendingBoundCheck], ['R10 level 10 CPU warms once per match', warmOnceCheck]] as const) {
  const r = check();
  ok = ok && r.pass;
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${name}: ${r.detail}\n`);
}
for (const sc of [...SCENARIOS, ...RTC_SCENARIOS]) {
  const r = runScenario(sc);
  results.push(r);
  ok = ok && r.pass;
  const extra = [
    r.resumed !== undefined ? `resumed ${r.resumed}` : '',
    r.leave !== undefined ? `left at frame ${r.leave.frame}, finished ${r.leave.finished}, winner slot ${r.leave.winnerSlot}${r.leave.winnerTeam >= 0 ? ` team ${r.leave.winnerTeam}` : ''}` : '',
    r.heapMB !== undefined ? `heap MB ${r.heapMB.join(' > ')}, relay log ${r.logKB} KB` : '',
    r.scriptedMatch !== null ? `log = script ${r.scriptedMatch}` : '',
  ].filter((x) => x !== '').join(', ');
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: maxRollback ${r.maxRollback}, rollbacks ${r.rollbacks}, stalls ${r.stalls}, ` +
    `waits ${r.waits}, hashes ${r.hashesCompared}, desyncs ${r.desyncs}, hits ref ${r.hitsReference} emitted ${r.hitsEmitted.join('/')}, ` +
    `dropped ${r.packetsDropped}/${r.packetsSent}, final ${r.finalHashes.join('/')} ref ${r.referenceHash}${extra !== '' ? `, ${extra}` : ''} (${r.ms} ms)\n`);
}
process.stdout.write(`${JSON.stringify({ pass: ok, results })}\n`);
process.stdout.write(ok ? 'nettest: PASS\n' : 'nettest: FAIL\n');
if (!ok) process.exitCode = 1;
