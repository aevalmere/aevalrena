/**
 * Lobby lifecycle test: a real LobbyHost behind a real WebSocket server, driven by `ws` clients.
 * Covers create/join, the full-lobby and in-match refusals, the version guard, duplicate names,
 * a guest leaving (slot reopens), a dropped player resuming with the input history, a dropped
 * player timing out (peerGone after RECONNECT_MS), and the host leaving (lobby closes).
 * Hardening (review R7-R18): malformed text frames, forged and out-of-range input packets,
 * oversize messages, unknown stage and character ids, and bad static-file paths must all be
 * refused without crashing the agent.
 *
 *   npx --yes tsx server/lobbytest.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createPacket, encodePacket } from '../src/net/codec';
import { defaultSettings, LAN_PATH, RECONNECT_MS, type ClientMsg, type ServerMsg } from '../src/net/protocol';
import { LobbyHost, MAX_PAYLOAD } from './lobbyhost';
import { serveStatic } from './static';

const VERSION = 'test-version';

interface Peer {
  ws: WebSocket;
  inbox: ServerMsg[];
  /** Binary frames received (relayed input packets). */
  binaries: Buffer[];
  send(msg: ClientMsg): void;
  next(t: ServerMsg['t'], ms?: number, pred?: (m: ServerMsg) => boolean): Promise<ServerMsg>;
}

async function connect(port: number, name: string, version = VERSION): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${LAN_PATH}`);
  const inbox: ServerMsg[] = [];
  const binaries: Buffer[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      binaries.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    inbox.push(JSON.parse(data.toString()) as ServerMsg);
    for (const w of waiters.splice(0)) w();
  });
  await new Promise<void>((r) => ws.once('open', () => r()));
  const peer: Peer = {
    ws, inbox, binaries,
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
    stages: ['tidegate', 'hearthmoor'], characters: ['aeval'],
  });
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: LAN_PATH, maxPayload: MAX_PAYLOAD });
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
    bToken = (host.core as unknown as { lobbies: Map<number, { tokens: Map<number, string> }> }).lobbies.get(lobbyId)?.tokens.get(bMember) ?? '';
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

  // ---- Hardening (review R7, R8, R11, R12, R15, R18) ----
  const pong = async (p: Peer): Promise<boolean> => {
    p.send({ t: 'ping', ts: 1, rtt: -1 });
    return (await p.next('pong', 1500)).t === 'pong';
  };

  await check('R7: malformed text frames are refused and the agent keeps serving', async () => {
    const x = await connect(port, 'FUZZ');
    await x.next('lobbies');
    const frames = ['null', '42', '"text"', '[]', '{}', '{"t":5}', '{"t":"nope"}', '{"t":"join"}',
      '{"t":"create","settings":null,"charId":7}', '{"t":"assign"}', '{"t":"resume"}', 'not json', '{"t":"member","team":"x"}'];
    for (const f of frames) x.ws.send(f);
    await new Promise((r) => setTimeout(r, 300));
    const errors = x.inbox.filter((m) => m.t === 'error').length;
    const alive = await pong(x);
    const fresh = await connect(port, 'AFTER');
    const freshOk = (await fresh.next('welcome', 1500)).t === 'welcome';
    fresh.ws.close(1000);
    x.ws.close(1000);
    if (!alive || !freshOk || errors < 8) throw new Error(`alive ${alive}, fresh ${freshOk}, errors ${errors}`);
    return `${frames.length} bad frames, ${errors} error replies, same socket still answers ping, new sockets still accepted`;
  });

  await check('R15: unknown stage and character ids fall back to known ones', async () => {
    const a2 = await connect(port, 'IDS');
    a2.send({ t: 'create', settings: { ...defaultSettings('tidegate'), stageId: 'no-such-stage' }, charId: 'ghost' });
    await a2.next('joined');
    const l = lobbyOf(await a2.next('lobby'));
    a2.send({ t: 'member', charId: 'also-ghost' });
    const l2 = lobbyOf(await a2.next('lobby'));
    a2.ws.close(1000);
    const stage = l?.settings.stageId;
    const chars = [l?.members[0]?.charId, l2?.members[0]?.charId];
    if (stage !== 'tidegate' || chars.some((c) => c !== 'aeval')) throw new Error(`${stage} ${chars.join()}`);
    return `stage "no-such-stage" became ${stage}; characters "ghost", "also-ghost" became ${chars.join(', ')}`;
  });

  // A two-player match for the relay checks.
  const p0 = await connect(port, 'P0');
  p0.send({ t: 'create', settings: { ...defaultSettings('tidegate'), name: 'RELAY' }, charId: 'aeval' });
  const p0j = await p0.next('joined');
  const relayLobby = p0j.t === 'joined' ? p0j.lobbyId : -1;
  const p1 = await connect(port, 'P1');
  p1.send({ t: 'join', lobbyId: relayLobby, charId: 'aeval' });
  await p1.next('joined');
  p1.send({ t: 'member', ready: true });
  await p0.next('lobby', 2000, (m) => lobbyOf(m)?.members.find((x) => x.name === 'P1')?.ready === true);
  p0.send({ t: 'start' });
  await p0.next('start');
  await p1.next('start');
  const packet = (peer: number, players: number[], firstFrame: number, frames: number): Uint8Array => {
    const pk = createPacket();
    pk.peer = peer;
    pk.players = players;
    pk.firstFrame = firstFrame;
    pk.frames = frames;
    pk.inputs = new Int32Array(frames * players.length * 4);
    return encodePacket(pk);
  };
  const quiet = async (p: Peer, ms: number): Promise<number> => {
    const before = p.binaries.length;
    await new Promise((r) => setTimeout(r, ms));
    return p.binaries.length - before;
  };

  await check('R11: a packet for a fighter the sender does not own is dropped; the peer byte is stamped', async () => {
    const rejected0 = host.rejectedPackets;
    p1.ws.send(packet(0, [0], 0, 5)); // P1 (slot 2) speaking for P0's fighter
    const leaked = await quiet(p0, 300);
    p1.ws.send(packet(3, [1], 0, 5)); // its own fighter, but claiming peer 3
    await quiet(p0, 300);
    const got = p0.binaries[p0.binaries.length - 1];
    if (leaked !== 0 || host.rejectedPackets !== rejected0 + 1 || got === undefined || got[1] !== 1) {
      throw new Error(`leaked ${leaked}, rejected +${host.rejectedPackets - rejected0}, relayed peer byte ${got?.[1]}`);
    }
    return 'forged fighter: not relayed and counted as rejected; claimed peer 3 relayed as peer 1 (the sender\'s slot)';
  });

  await check('R12: frames far past the confirmed ones and oversize messages are refused', async () => {
    const rejected0 = host.rejectedPackets;
    p1.ws.send(packet(1, [1], 10_000_000, 4));
    const leaked = await quiet(p0, 300);
    if (leaked !== 0 || host.rejectedPackets !== rejected0 + 1) throw new Error(`leaked ${leaked}, rejected +${host.rejectedPackets - rejected0}`);
    const big = await connect(port, 'BIG');
    const code = await new Promise<number>((resolve) => {
      big.ws.once('close', (c: number) => resolve(c));
      big.ws.send(Buffer.alloc(MAX_PAYLOAD + 1024));
    });
    const alive = await pong(p0);
    if (code !== 1009 || !alive) throw new Error(`close code ${code}, agent alive ${alive}`);
    return `first frame 10,000,000 dropped (not relayed, not logged); a ${Math.round((MAX_PAYLOAD + 1024) / 1024)} KiB message closed that socket with 1009; agent still answers`;
  });
  p0.ws.close(1000);
  p1.ws.close(1000);

  await check('R8 + R18: bad escapes get 400, and paths may not leave the static root', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aev-static-'));
    const root = path.join(tmp, 'site');
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(tmp, 'site-x'));
    fs.writeFileSync(path.join(root, 'index.html'), '<p>ok</p>');
    fs.writeFileSync(path.join(tmp, 'site-x', 'secret.txt'), 'secret');
    const srv = http.createServer((req, res) => serveStatic(root, req, res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const sp = (srv.address() as AddressInfo).port;
    const get = (p: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: sp, path: p, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
    const bad = await get('/%');
    const sibling = await get('/%2e%2e/site-x/secret.txt');
    const ok = await get('/index.html');
    srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (bad.status !== 400 || sibling.status !== 403 || sibling.body.includes('secret') || ok.status !== 200) {
      throw new Error(`/% ${bad.status}, sibling ${sibling.status}, index ${ok.status}`);
    }
    return `GET /% -> 400, GET /../site-x/secret.txt -> 403, GET /index.html -> 200`;
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
