import type { InputFrame, MatchConfig } from '../core/types';
import { Btn } from '../core/types';
import { createGameState, stepGame } from '../sim';
import { createPacket, encodePacket } from './codec';
import { eliminateFighter } from './eliminate';
import { LEFT_CODE, LobbyCore, MAX_MISSED, type LobbyConn, type LobbyPeer } from './lobbycore';
import { defaultSettings, type ClientMsg, type LobbyInfo, type MatchStart, type ServerMsg } from './protocol';
import { RollbackSession } from './rollback';

/**
 * The shared lobby host (src/net/lobbycore.ts) with no network at all: fake connections shaped
 * like the in-browser mode's WebRTC links (JSON on a reliable channel, binary on a lossy one,
 * any close counts as leaving). server/lobbytest.ts covers the same core behind real WebSockets.
 *
 *   npx --yes tsx src/net/lobbycoretest.ts
 */

declare const process: { stdout: { write(text: string): void }; exitCode?: number };

const VERSION = 'p4-test';

class FakeClient {
  readonly inbox: ServerMsg[] = [];
  readonly binaries: Uint8Array[] = [];
  open = true;
  terminated = false;
  peer: LobbyPeer;
  /** Loss on the host-to-client leg of the unordered channel (0..1), and where it goes. */
  onBinary: ((b: Uint8Array) => void) | null = null;

  constructor(core: LobbyCore, readonly name: string, version = VERSION) {
    const self = this;
    const conn: LobbyConn = {
      get open(): boolean { return self.open; },
      sendText: (text) => { self.inbox.push(JSON.parse(text) as ServerMsg); },
      sendBinary: (bytes) => {
        if (self.onBinary !== null) self.onBinary(bytes);
        else self.binaries.push(bytes);
      },
      terminate: () => {
        if (!self.open) return;
        self.open = false;
        self.terminated = true;
        self.peer.closed(LEFT_CODE);
      },
      probe: () => {},
    };
    this.peer = core.attach(conn);
    this.send({ t: 'hello', name, version });
  }

  send(msg: ClientMsg): void {
    if (this.open) this.peer.text(JSON.stringify(msg));
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.peer.closed(LEFT_CODE);
  }

  take<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true): Extract<ServerMsg, { t: T }> {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      const m = this.inbox[i];
      if (m.t === t && pred(m as Extract<ServerMsg, { t: T }>)) {
        this.inbox.splice(0, i + 1);
        return m as Extract<ServerMsg, { t: T }>;
      }
    }
    throw new Error(`${this.name}: no '${t}' (inbox: ${this.inbox.map((m) => m.t).join(',')})`);
  }

  lobby(): LobbyInfo {
    const l = this.take('lobby').lobby;
    if (l === null) throw new Error(`${this.name}: lobby is null`);
    return l;
  }
}

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, fn: () => string): void {
  try {
    results.push({ name, pass: true, detail: fn() });
  } catch (err) {
    results.push({ name, pass: false, detail: (err as Error).message });
  }
}

function makeCore(): LobbyCore {
  return new LobbyCore({
    agentId: 'test', hostName: 'test', version: VERSION, fallbackStage: 'tidegate', remoteListings: () => [], log: () => {},
    stages: ['tidegate', 'hearthmoor'], characters: ['aeval'],
  });
}

function packet(peer: number, players: number[], firstFrame: number, frames: number): Uint8Array {
  const pk = createPacket();
  pk.peer = peer;
  pk.players = players;
  pk.firstFrame = firstFrame;
  pk.frames = frames;
  pk.inputs = new Int32Array(frames * players.length * 4);
  for (let f = 0; f < frames; f++) for (let k = 0; k < players.length; k++) pk.inputs[(f * players.length + k) * 4] = 100 + f;
  return encodePacket(pk);
}

// ---------------- lobby rules ----------------

const core = makeCore();
/** The lobby as the core holds it right now (the message inboxes may already be read). */
function view(id: number): LobbyInfo {
  const l = (core as unknown as { lobbies: Map<number, { info: LobbyInfo }> }).lobbies.get(id)?.info;
  if (l === undefined) throw new Error(`no lobby ${id}`);
  return l;
}
const host = new FakeClient(core, 'HOST');
let lobbyId = -1;
check('create: welcome, joined, lobby', () => {
  host.take('welcome');
  host.send({ t: 'create', settings: { ...defaultSettings('tidegate'), name: 'TEST' }, charId: 'aeval' });
  lobbyId = host.take('joined').lobbyId;
  const l = host.lobby();
  if (l.members.length !== 1 || l.hostId !== l.members[0].id) throw new Error(JSON.stringify(l));
  return `lobby ${lobbyId}, host is member ${l.hostId}`;
});

check('version guard: a different build is refused with the existing message', () => {
  const old = new FakeClient(core, 'OLD', 'p4-other');
  old.send({ t: 'join', lobbyId, charId: 'aeval' });
  const e = old.take('error');
  old.close();
  if (!/Different game version/.test(e.message)) throw new Error(e.message);
  return e.message;
});

const guests = ['ANA', 'BO', 'CY'].map((n) => new FakeClient(core, n));
check('three guests join; variants default to the first unused colour on the character', () => {
  for (const g of guests) {
    g.send({ t: 'join', lobbyId, charId: 'aeval' });
    g.take('joined');
  }
  const l = host.lobby();
  const variants = l.members.map((m) => m.variant).join(',');
  const slots = l.members.map((m) => m.slot).join(',');
  if (variants !== '0,1,2,3' || slots !== '0,1,2,3') throw new Error(`variants ${variants}, slots ${slots}`);
  return `slots ${slots}, variants ${variants}`;
});

check('a fifth player is refused (full)', () => {
  const late = new FakeClient(core, 'LATE');
  late.send({ t: 'join', lobbyId, charId: 'aeval' });
  const e = late.take('error');
  late.close();
  if (!/full/.test(e.message)) throw new Error(e.message);
  return e.message;
});

check('variant: out of range or fractional values are ignored, 0..3 accepted', () => {
  const g = guests[0];
  for (const v of [7, -1, 1.5, 4]) g.send({ t: 'member', variant: v });
  const before = host.lobby().members.find((m) => m.name === 'ANA')?.variant;
  g.send({ t: 'member', variant: 3 });
  const after = host.lobby().members.find((m) => m.name === 'ANA')?.variant;
  if (before !== 1 || after !== 3) throw new Error(`before ${before}, after ${after}`);
  return `bad values left it at ${before}; 3 set it to ${after}`;
});

check('slot assignment by the host swaps two members; a guest cannot assign', () => {
  const l0 = view(lobbyId);
  const cy = l0.members.find((m) => m.name === 'CY');
  const ana = l0.members.find((m) => m.name === 'ANA');
  if (cy === undefined || ana === undefined) throw new Error('members');
  guests[0].send({ t: 'assign', memberId: cy.id, slot: 0 });
  host.send({ t: 'assign', memberId: cy.id, slot: ana.slot });
  const l = host.lobby();
  const slotOf = (n: string): number => l.members.find((m) => m.name === n)?.slot ?? -1;
  if (slotOf('CY') !== 1 || slotOf('ANA') !== 3 || slotOf('HOST') !== 0) throw new Error(`CY ${slotOf('CY')}, ANA ${slotOf('ANA')}`);
  return `CY now slot ${slotOf('CY') + 1}, ANA slot ${slotOf('ANA') + 1}`;
});

let start: MatchStart | null = null;
check('ready gating: start waits for every guest, then starts for all', () => {
  host.send({ t: 'start' });
  const e = host.take('error');
  for (const g of guests) g.send({ t: 'member', ready: true });
  host.send({ t: 'start' });
  start = host.take('start').start;
  for (const g of guests) g.take('start');
  if (start.config.players.length !== 4) throw new Error(`${start.config.players.length} players`);
  return `refused first ("${e.message}"), then started with ${start.config.players.length} players, delay ${start.inputDelay}`;
});

check('relay: a foreign fighter is refused, the peer byte is stamped, far frames are refused', () => {
  const st = start;
  if (st === null) throw new Error('no match');
  const bo = guests[1];
  const l = view(lobbyId);
  const boMember = l.members.find((m) => m.name === 'BO');
  if (boMember === undefined) throw new Error('no BO');
  const boIdx = st.owners.indexOf(boMember.slot);
  const r0 = core.rejectedPackets;
  host.binaries.length = 0;
  bo.peer.binary(packet(boMember.slot, [0], 0, 5)); // fighter 0 is the host's
  const leaked = host.binaries.length;
  bo.peer.binary(packet(3, [boIdx], 0, 5)); // own fighter, claiming peer 3
  const got = host.binaries[host.binaries.length - 1];
  bo.peer.binary(packet(boMember.slot, [boIdx], 10_000_000, 4));
  const r = core.rejectedPackets - r0;
  if (leaked !== 0 || got === undefined || got[1] !== boMember.slot || r !== 2) {
    throw new Error(`leaked ${leaked}, stamped ${got?.[1]} (want ${boMember.slot}), rejected ${r}`);
  }
  return `foreign fighter and frame 10,000,000 refused (${r}); claimed peer 3 relayed as peer ${got[1]}`;
});

check('a closed link mid-match counts as leaving: peerGone at once with the retirement and tail', () => {
  const st = start;
  if (st === null) throw new Error('no match');
  const l = view(lobbyId);
  const cy = l.members.find((m) => m.name === 'CY');
  if (cy === undefined) throw new Error('no CY');
  const idx = st.owners.indexOf(cy.slot);
  guests[2].peer.binary(packet(cy.slot, [idx], 0, 30));
  guests[2].close();
  if (host.inbox.some((m) => m.t === 'peerDropped')) throw new Error('held the seat');
  const gone = host.take('peerGone');
  const r = gone.retirement;
  if (gone.reason !== 'left' || r.frame !== 30 || r.players.join() !== String(idx) || r.tail?.inputs[0].length !== 30 * 4) {
    throw new Error(JSON.stringify({ reason: gone.reason, frame: r.frame, players: r.players, tail: r.tail?.inputs[0].length }));
  }
  return `peerGone(left) for ${gone.name}: player ${r.players.join()} out from frame ${r.frame}, tail ${r.tail.inputs[0].length / 4} frames`;
});

check('rematch vote: when every member has voted after results, the next match starts', () => {
  for (const c of [host, guests[0], guests[1]]) c.send({ t: 'backToLobby' });
  const l = host.lobby();
  if (l.inMatch) throw new Error('still in match');
  for (const c of [host, guests[0]]) c.send({ t: 'rematch' });
  if (host.inbox.some((m) => m.t === 'start')) throw new Error('started before every vote');
  guests[1].send({ t: 'rematch' });
  const s = host.take('start').start;
  return `restarted with ${s.config.players.length} players after 3 of 3 votes`;
});

check(`liveness: a silent link is dropped after ${MAX_MISSED} missed seconds, a pinging one stays`, () => {
  const c2 = makeCore();
  const quiet = new FakeClient(c2, 'QUIET');
  const talky = new FakeClient(c2, 'TALKY');
  let ticks = 0;
  while (!quiet.terminated && ticks < 20) {
    talky.send({ t: 'ping', ts: ticks, rtt: 3 });
    c2.tick();
    ticks++;
  }
  if (!quiet.terminated || talky.terminated || ticks !== MAX_MISSED + 1) throw new Error(`quiet ${quiet.terminated} talky ${talky.terminated} ticks ${ticks}`);
  c2.dispose();
  return `silent link dropped on tick ${ticks}; the pinging link is still open`;
});

check('the host leaving the lobby closes it for everyone', () => {
  const c3 = makeCore();
  const h = new FakeClient(c3, 'H');
  h.send({ t: 'create', settings: defaultSettings('tidegate'), charId: 'aeval' });
  const id = h.take('joined').lobbyId;
  const g = new FakeClient(c3, 'G');
  g.send({ t: 'join', lobbyId: id, charId: 'aeval' });
  g.take('joined');
  h.send({ t: 'leave' });
  const closed = g.take('lobbyClosed');
  if (c3.counts().lobbies !== 0) throw new Error('lobby still listed');
  return closed.message;
});

// ---------------- a match through the core over lossy unordered links ----------------

function scripted(player: number, t: number): InputFrame {
  const pat = [0, Btn.Left, Btn.Right | Btn.Attack, Btn.Jump, Btn.Special, Btn.Down | Btn.Attack, Btn.Shield];
  const at = (f: number): number => (f < 0 ? 0 : pat[(Math.floor(f / (7 + player * 3)) * 5 + player) % pat.length]);
  const held = at(t);
  const prev = at(t - 1);
  return { held, pressed: held & ~prev, released: prev & ~held, direct: 0 };
}

check('a 2 player match relayed by the core, 15% loss and reordering on every unordered leg, ends in sync', () => {
  const c4 = makeCore();
  const h = new FakeClient(c4, 'HOSTP');
  h.send({ t: 'create', settings: { ...defaultSettings('tidegate'), inputDelay: 2 }, charId: 'aeval' });
  const id = h.take('joined').lobbyId;
  const g = new FakeClient(c4, 'GUESTP');
  g.send({ t: 'join', lobbyId: id, charId: 'aeval' });
  g.take('joined');
  g.send({ t: 'member', ready: true });
  h.send({ t: 'start' });
  const st = h.take('start').start;
  g.take('start');
  let clock = 0;
  let seed = 12345;
  const rand = (): number => {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  const LOSS = 0.15;
  const flight: { at: number; deliver: () => void }[] = [];
  const later = (fn: () => void): void => {
    if (rand() < LOSS) return;
    flight.push({ at: clock + 1 + Math.floor(rand() * 3), deliver: fn });
  };
  const hostInbox: Uint8Array[] = [];
  const guestInbox: Uint8Array[] = [];
  h.onBinary = (b) => hostInbox.push(b); // loopback: no loss
  g.onBinary = (b) => later(() => guestInbox.push(b));
  const mk = (peer: number, sendFn: (b: Uint8Array) => void, inbox: Uint8Array[]): RollbackSession => {
    const config = JSON.parse(JSON.stringify(st.config)) as MatchConfig;
    return new RollbackSession({
      config, sim: { createGameState, stepGame, eliminate: eliminateFighter }, peer, owners: st.owners,
      sources: st.owners.map((o, i) => (o === peer ? (f: number) => scripted(i, f - st.inputDelay) : null)),
      transport: {
        send: sendFn,
        poll: (on) => { for (const p of inbox.splice(0)) on(p); },
      },
      inputDelay: st.inputDelay,
    });
  };
  const hostPeer = st.owners[0];
  const guestPeer = st.owners[1];
  const hs = mk(hostPeer, (b) => h.peer.binary(b), hostInbox);
  const gs = mk(guestPeer, (b) => later(() => g.peer.binary(b)), guestInbox);
  const FRAMES = 1200;
  for (; clock < FRAMES * 4; clock++) {
    for (let i = flight.length - 1; i >= 0; i--) {
      if (flight[i].at <= clock) {
        const f = flight[i];
        flight.splice(i, 1);
        f.deliver();
      }
    }
    hs.tickOnce(hs.tick < FRAMES);
    gs.tickOnce(gs.tick < FRAMES);
    if (hs.tick >= FRAMES && gs.tick >= FRAMES && hs.confirmedFrame() >= FRAMES - 1 && gs.confirmedFrame() >= FRAMES - 1) break;
  }
  const same = hs.liveHash() === gs.liveHash();
  const compared = hs.stats.hashesCompared + gs.stats.hashesCompared;
  const desyncs = hs.stats.desyncs + gs.stats.desyncs;
  if (!same || compared === 0 || desyncs !== 0 || hs.tick !== FRAMES) {
    throw new Error(`same ${same}, compared ${compared}, desyncs ${desyncs}, ticks ${hs.tick}/${gs.tick}`);
  }
  return `${FRAMES} frames, final hash ${hs.liveHash().toString(16)} on both, ${compared} hashes compared, ` +
    `rollbacks ${hs.stats.rollbacks + gs.stats.rollbacks}, max depth ${Math.max(hs.stats.maxRollback, gs.stats.maxRollback)}`;
});

let ok = true;
for (const r of results) {
  ok = ok && r.pass;
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}\n`);
}
process.stdout.write(ok ? 'lobbycoretest: PASS\n' : 'lobbycoretest: FAIL\n');
if (!ok) process.exitCode = 1;
