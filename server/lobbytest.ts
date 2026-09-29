/**
 * Lobby lifecycle test: a real LobbyHost behind a real WebSocket server, driven by `ws` clients.
 * Covers create/join, the full-lobby and in-match refusals, the version guard, duplicate names,
 * a guest leaving (slot reopens), a dropped player resuming with the input history, a dropped
 * player timing out (peerGone after RECONNECT_MS), and the host leaving (lobby closes).
 *
 *   npx --yes tsx server/lobbytest.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createPacket, encodePacket } from '../src/net/codec';
import { defaultSettings, LAN_PATH, RECONNECT_MS, type ClientMsg, type ServerMsg } from '../src/net/protocol';
import { LobbyHost } from './lobbyhost';

const VERSION = 'test-version';

interface Peer {
  ws: WebSocket;
  inbox: ServerMsg[];
  send(msg: ClientMsg): void;
  next(t: ServerMsg['t'], ms?: number, pred?: (m: ServerMsg) => boolean): Promise<ServerMsg>;
}

async function connect(port: number, name: string, version = VERSION): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${LAN_PATH}`);
  const inbox: ServerMsg[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    inbox.push(JSON.parse(data.toString()) as ServerMsg);
    for (const w of waiters.splice(0)) w();
  });
  await new Promise<void>((r) => ws.once('open', () => r()));
  const peer: Peer = {
    ws, inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (t, ms = 2000, pred = () => true) => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`${name}: no '${t}' within ${ms} ms`)), ms);
      const check = (): void => {
        const i = inbox.findIndex((m) => m.t === t && pred(m));
        if (i >= 0) {
          clearTimeout(deadline);
          resolve(inbox.splice(i, 1)[0]);
        } else {
          waiters.push(check);
        }
      };
      check();
    }),
  };
  peer.send({ t: 'hello', name, version });
  return peer;
}

const results: { name: string; pass: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ name, pass: true, detail: await fn() });
  } catch (err) {
    results.push({ name, pass: false, detail: (err as Error).message });
  }
}

function lobbyOf(m: ServerMsg): Extract<ServerMsg, { t: 'lobby' }>['lobby'] {
  return m.t === 'lobby' ? m.lobby : null;
}

async function main(): Promise<void> {
  const host = new LobbyHost({
    agentId: 'test', hostName: 'test', version: VERSION, fallbackStage: 'tidegate', remoteListings: () => [], log: () => {},
  });
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: LAN_PATH });
  wss.on('connection', (ws) => host.attach(ws));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;

  const a = await connect(port, 'ALICE');
  let lobbyId = -1;
  await check('create a lobby', async () => {
    a.send({ t: 'create', settings: { ...defaultSettings('tidegate'), name: 'TEST' }, charId: 'aeval' });
    const j = await a.next('joined');
    if (j.t !== 'joined') throw new Error('no joined');
    lobbyId = j.lobbyId;
    return `lobby ${lobbyId}`;
  });

  const b = await connect(port, 'ALICE');
  await check('duplicate name gets a suffix', async () => {
    b.send({ t: 'join', lobbyId, charId: 'aeval' });
    await b.next('joined');
    const l = lobbyOf(await b.next('lobby', 2000, (m) => (lobbyOf(m)?.members.length ?? 0) === 2));
    const names = l?.members.map((m) => m.name) ?? [];
    if (!names.includes('ALICE') || !names.includes('ALICE 2')) throw new Error(names.join(','));
    return names.join(', ');
  });

  await check('different version is refused', async () => {
    const v = await connect(port, 'OLD', 'other-version');
    v.send({ t: 'join', lobbyId, charId: 'aeval' });
    const e = await v.next('error');
    v.ws.close();
    return e.t === 'error' ? e.message : '';
  });

  const c = await connect(port, 'CARL');
  const d = await connect(port, 'DANA');
  c.send({ t: 'join', lobbyId, charId: 'aeval' });
  d.send({ t: 'join', lobbyId, charId: 'aeval' });
  await c.next('joined');
  await d.next('joined');
  await check('fifth player is refused (full)', async () => {
    const e5 = await connect(port, 'EVE');
    e5.send({ t: 'join', lobbyId, charId: 'aeval' });
    const e = await e5.next('error');
    e5.ws.close();
    if (e.t !== 'error' || !/full/i.test(e.message)) throw new Error(JSON.stringify(e));
    return e.message;
  });

  await check('guest leaving reopens the slot', async () => {
    d.send({ t: 'leave' });
    const l = lobbyOf(await a.next('lobby', 2000, (m) => {
      const names = lobbyOf(m)?.members.map((x) => x.name) ?? [];
      return names.length === 3 && !names.includes('DANA');
    }));
    d.ws.close();
    return `members ${l?.members.map((m) => `${m.name}@${m.slot + 1}`).join(', ')}`;
  });

  let bToken = '';
  let bMember = -1;
  await check('start needs everyone ready, then starts', async () => {
    a.send({ t: 'start' });
    const e = await a.next('error');
    b.send({ t: 'member', ready: true });
    c.send({ t: 'member', ready: true });
    await a.next('lobby', 2000, (m) => (lobbyOf(m)?.members.filter((x) => x.ready).length ?? 0) === 2);
    a.send({ t: 'start' });
    await a.next('start');
    await b.next('start');
    return `first refusal: "${e.t === 'error' ? e.message : ''}"`;
  });
  // b's token and member id, from its 'joined' (already consumed); ask the host's lobby view.
  await check('in-match lobby refuses a new join', async () => {
    const late = await connect(port, 'LATE');
    late.send({ t: 'join', lobbyId, charId: 'aeval' });
    const e = await late.next('error');
    late.ws.close();
    if (e.t !== 'error' || !/match/i.test(e.message)) throw new Error(JSON.stringify(e));
    return e.message;
  });

  await check('relay logs inputs and a dropped player resumes with the history', async () => {
    // b re-joins nothing: fetch its identity from a fresh 'joined'-less path, via the lobby view.
    const lobbyView = lobbyOf(await b.next('lobby', 2000, (m) => lobbyOf(m)?.inMatch === true));
    const bm = lobbyView?.members.find((m) => m.name === 'ALICE 2');
    if (bm === undefined) throw new Error('no member');
    bMember = bm.id;
    // Send 10 frames of input as b (fighter index 1 = slot 1).
    const pk = createPacket();
    pk.peer = bm.slot;
    pk.players = [1];
    pk.firstFrame = 0;
    pk.frames = 10;
    pk.inputs = new Int32Array(40);
    for (let f = 0; f < 10; f++) pk.inputs[f * 4] = f;
    b.ws.send(encodePacket(pk));
    await new Promise((r) => setTimeout(r, 100));
    // Drop b abnormally.
    b.ws.terminate();
    const drop = await a.next('peerDropped', 3000);
    bToken = (host as unknown as { lobbies: Map<number, { tokens: Map<number, string> }> }).lobbies.get(lobbyId)?.tokens.get(bMember) ?? '';
    const b2 = await connect(port, 'ALICE 2');
    b2.send({ t: 'resume', lobbyId, memberId: bMember, token: bToken, version: VERSION });
    const res = await b2.next('resumed');
    const back = await a.next('peerResumed');
    if (res.t !== 'resumed') throw new Error('no resumed');
    const hist = res.history.players[1];
    if (hist.length !== 40 || hist[36] !== 9) throw new Error(`history ${hist.length}`);
    b2.ws.close(1000);
    return `dropped "${drop.t === 'peerDropped' ? drop.name : ''}", resumed with ${hist.length / 4} logged frames, host saw ${back.t}`;
  });

  await check(`a dropped player who never returns is gone after ${RECONNECT_MS / 1000} s`, async () => {
    c.ws.terminate();
    await a.next('peerDropped', 3000, (m) => m.t === 'peerDropped' && m.name === 'CARL');
    const t0 = Date.now();
    const gone = await a.next('peerGone', RECONNECT_MS + 3000, (m) => m.t === 'peerGone' && m.name === 'CARL');
    return `peerGone (${gone.t === 'peerGone' ? gone.reason : ''}) after ${Date.now() - t0} ms`;
  });

  await check('host leaving closes the lobby for everyone', async () => {
    const g = await connect(port, 'GUS');
    // The match ended when the others left; the lobby is open again.
    await new Promise((r) => setTimeout(r, 200));
    a.send({ t: 'backToLobby' });
    await new Promise((r) => setTimeout(r, 200));
    g.send({ t: 'join', lobbyId, charId: 'aeval' });
    await g.next('joined');
    a.ws.close(1000);
    const closed = await g.next('lobbyClosed');
    g.ws.close();
    return closed.t === 'lobbyClosed' ? closed.message : '';
  });

  // ---- R1 / R2: a fresh lobby for reload-resume, leaving, and the host leaving mid-match ----
  const h = await connect(port, 'HOST');
  h.send({ t: 'create', settings: { ...defaultSettings('tidegate'), name: 'R' }, charId: 'aeval' });
  const hj = await h.next('joined');
  const rLobby = hj.t === 'joined' ? hj.lobbyId : -1;
  const g1 = await connect(port, 'GINA');
  g1.send({ t: 'join', lobbyId: rLobby, charId: 'aeval' });
  const g1j = await g1.next('joined');
  const g2 = await connect(port, 'GREG');
  g2.send({ t: 'join', lobbyId: rLobby, charId: 'aeval' });
  await g2.next('joined');
  g1.send({ t: 'member', ready: true });
  g2.send({ t: 'member', ready: true });
  await h.next('lobby', 2000, (m) => (lobbyOf(m)?.members.filter((x) => x.ready).length ?? 0) === 2);
  h.send({ t: 'start' });
  await h.next('start');
  await g1.next('start');
  await g2.next('start');
  const sendInputs = (p: Peer, slot: number, player: number, frames: number): void => {
    const pk = createPacket();
    pk.peer = slot;
    pk.players = [player];
    pk.firstFrame = 0;
    pk.frames = frames;
    pk.inputs = new Int32Array(frames * 4);
    for (let f = 0; f < frames; f++) pk.inputs[f * 4] = 100 + f;
    p.ws.send(encodePacket(pk));
  };
  sendInputs(g1, 1, 1, 20);
  sendInputs(g2, 2, 2, 10);
  await new Promise((r) => setTimeout(r, 150));

  let g1r: Peer | null = null;
  await check('R1: a page close/reload (1001) holds the seat and the stored token resumes it', async () => {
    g1.ws.close(1001, 'page reload');
    const drop = await h.next('peerDropped', 2000);
    // The seat must be held, not given up.
    const early = h.inbox.find((m) => m.t === 'peerGone');
    if (early !== undefined) throw new Error('treated a reload as leaving');
    if (g1j.t !== 'joined') throw new Error('no token');
    const stored = { lobbyId: g1j.lobbyId, memberId: g1j.memberId, token: g1j.token };
    g1r = await connect(port, 'GINA');
    g1r.send({ t: 'resume', ...stored, version: VERSION });
    const res = await g1r.next('resumed');
    await h.next('peerResumed');
    if (res.t !== 'resumed') throw new Error('no resumed');
    const me = res.lobby.members.find((m) => m.id === res.memberId);
    if (!res.lobby.inMatch || me === undefined || res.history.players[1].length !== 80) {
      throw new Error(`inMatch ${res.lobby.inMatch}, me ${me?.name}, history ${res.history.players[1].length / 4}`);
    }
    return `host saw ${drop.t} for ${drop.t === 'peerDropped' ? drop.name : ''}; resumed as ${me.name} (slot ${me.slot + 1}) with 20 logged frames, in match`;
  });

  await check('R2: a player who leaves is retired at its first unrelayed frame, with its input tail', async () => {
    g2.send({ t: 'leaveMatch' });
    const gone = await h.next('peerGone', 2000);
    const gone2 = g1r === null ? null : await (g1r as Peer).next('peerGone', 2000);
    if (gone.t !== 'peerGone' || gone2 === null) throw new Error('no peerGone');
    const r = gone.retirement;
    if (gone.reason !== 'left' || r.frame !== 10 || r.players.join() !== '2' || r.tail?.inputs[0].length !== 40) {
      throw new Error(JSON.stringify({ reason: gone.reason, frame: r.frame, players: r.players, tail: r.tail?.inputs[0].length }));
    }
    return `peerGone(left) for ${gone.name}: players [${r.players.join()}] out from frame ${r.frame}, tail ${r.tail.inputs[0].length / 4} frames`;
  });

  await check('R2: the host leaving mid-match lets the match finish, then closes the lobby', async () => {
    const other = g1r as Peer | null;
    if (other === null) throw new Error('no resumed guest');
    h.ws.close(1000);
    const gone = await other.next('peerGone', 2000);
    await new Promise((r) => setTimeout(r, 300));
    if (other.inbox.some((m) => m.t === 'lobbyClosed')) throw new Error('lobby closed while the match was running');
    other.send({ t: 'backToLobby' });
    const closed = await other.next('lobbyClosed', 2000);
    other.ws.close(1000);
    g2.ws.close(1000);
    return `guest saw peerGone(${gone.t === 'peerGone' ? gone.retirement.players.join() : ''}) and kept playing; after results: "${closed.t === 'lobbyClosed' ? closed.message : ''}"`;
  });

  host.dispose();
  wss.close();
  server.close();
  let ok = true;
  for (const r of results) {
    ok = ok && r.pass;
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}\n`);
  }
  process.stdout.write(ok ? 'lobbytest: PASS\n' : 'lobbytest: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
