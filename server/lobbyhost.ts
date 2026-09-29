/**
 * Lobbies held by one LAN agent, and the input relay for their matches (docs/LAN.md).
 * One Client per browser WebSocket. A browser keeps one socket to its own agent for the lobby
 * list and opens another to whichever agent holds the lobby it is in.
 */
import crypto from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { InputLog } from '../src/net/inputlog';
import {
  buildMatchStart, LOBBY_MAX, NAME_MAX, RECONNECT_MS, sanitizeSettings, uniqueName,
  type Announce, type ClientMsg, type LobbyInfo, type LobbyListing, type LobbyMember, type MatchStart, type Retirement, type ServerMsg,
} from '../src/net/protocol';

/**
 * Close codes that mean "left on purpose": a normal close (the client sends it after leaveMatch
 * or leave) and our explicit leave code. 1001 ("going away") is a reload as often as a closed
 * tab, so it counts as a drop: the slot is held for RECONNECT_MS and a reload resumes.
 */
const LEFT_CODES = new Set([1000, 4001]);
/** Heartbeats (1 s apart) a socket may miss before it counts as dropped. */
const MAX_MISSED = 4;

interface Client {
  id: number;
  ws: WebSocket;
  name: string;
  version: string;
  lobby: Lobby | null;
  /** Member id this socket speaks for (a resumed socket takes over its old member id). */
  memberId: number;
  missed: number;
  /** Superseded by a resumed socket: its close must not drop the member. */
  replaced: boolean;
}

interface Lobby {
  info: LobbyInfo;
  clients: Set<Client>;
  /** Members still on the match screen. The lobby reads "in match" until this empties. */
  playing: Set<number>;
  start: MatchStart | null;
  log: InputLog | null;
  tokens: Map<number, string>;
  dropTimers: Map<number, ReturnType<typeof setTimeout>>;
  /** Players who left the running match, replayed to anyone who resumes. */
  retirements: Retirement[];
  /** Set when the host left mid-match: the lobby closes with this message once the match ends. */
  closing: string;
}

export interface LobbyHostOptions {
  agentId: string;
  hostName: string;
  version: string;
  fallbackStage: string;
  /** Lobbies discovered on other agents, for the merged list. */
  remoteListings(): LobbyListing[];
  log(line: string): void;
}

export class LobbyHost {
  private nextClientId = 1;
  private nextLobbyId = 1;
  private readonly clients = new Set<Client>();
  private readonly lobbies = new Map<number, Lobby>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: LobbyHostOptions) {
    this.timer = setInterval(() => this.everySecond(), 1000);
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.ws.terminate();
  }

  attach(ws: WebSocket): void {
    const c: Client = {
      id: this.nextClientId++, ws, name: 'PLAYER', version: this.opts.version, lobby: null,
      memberId: 0, missed: 0, replaced: false,
    };
    c.memberId = c.id;
    this.clients.add(c);
    const sock = (ws as unknown as { _socket?: { setNoDelay?(v: boolean): void } })._socket;
    sock?.setNoDelay?.(true); // an input packet must leave now, not with the next one
    ws.on('pong', () => { c.missed = 0; });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      c.missed = 0;
      if (isBinary) {
        this.relay(c, toBuffer(data));
        return;
      }
      let msg: ClientMsg;
      try {
        msg = JSON.parse(toBuffer(data).toString('utf8')) as ClientMsg;
      } catch {
        this.send(c, { t: 'error', message: 'Bad message' });
        return;
      }
      this.handle(c, msg);
    });
    ws.on('close', (code: number) => this.onClose(c, code));
    ws.on('error', () => { /* 'close' follows */ });
    this.send(c, { t: 'welcome', id: c.id, version: this.opts.version, agentId: this.opts.agentId, hostName: this.opts.hostName });
  }

  /** This agent's lobbies for the UDP announce. */
  announceLobbies(): Announce['lobbies'] {
    return this.ownListings().map(({ lobbyId, name, hostName, stageId, players, state }) => ({ lobbyId, name, hostName, stageId, players, state }));
  }

  ownListings(): LobbyListing[] {
    const out: LobbyListing[] = [];
    for (const l of this.lobbies.values()) {
      const host = l.info.members.find((m) => m.id === l.info.hostId);
      out.push({
        agentId: this.opts.agentId, address: '', lobbyId: l.info.id, name: l.info.settings.name,
        hostName: host?.name ?? '', stageId: l.info.settings.stageId, players: l.info.members.length,
        state: l.info.inMatch ? 'in-match' : 'open', version: this.opts.version,
      });
    }
    return out;
  }

  counts(): { clients: number; lobbies: number } {
    return { clients: this.clients.size, lobbies: this.lobbies.size };
  }

  // ---------------- plumbing ----------------

  private send(c: Client, msg: ServerMsg): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private broadcastLobby(l: Lobby): void {
    for (const c of l.clients) this.send(c, { t: 'lobby', lobby: l.info });
  }

  private pushList(): void {
    const msg: ServerMsg = { t: 'lobbies', lobbies: [...this.ownListings(), ...this.opts.remoteListings()] };
    for (const c of this.clients) if (c.lobby === null) this.send(c, msg);
  }

  private everySecond(): void {
    for (const c of this.clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      if (++c.missed > MAX_MISSED) {
        this.opts.log(`[lan] ${c.name} missed ${MAX_MISSED} heartbeats, dropping the socket`);
        c.ws.terminate();
        continue;
      }
      c.ws.ping();
    }
    this.pushList();
  }

  private member(l: Lobby, id: number): LobbyMember | undefined {
    return l.info.members.find((m) => m.id === id);
  }

  private freeSlot(l: Lobby): number {
    for (let s = 0; s < LOBBY_MAX; s++) if (!l.info.members.some((m) => m.slot === s)) return s;
    return -1;
  }

  // ---------------- lifecycle ----------------

  private onClose(c: Client, code: number): void {
    this.clients.delete(c);
    if (c.replaced) return;
    const l = c.lobby;
    if (l === null) return;
    l.clients.delete(c);
    const m = this.member(l, c.memberId);
    if (m === undefined) return;
    if (l.info.inMatch && l.playing.has(m.id)) {
      if (LEFT_CODES.has(code)) {
        this.gone(l, m.id, 'left');
      } else {
        m.connected = false;
        this.opts.log(`[lan] ${m.name} dropped from lobby ${l.info.id} (code ${code}), holding the slot ${RECONNECT_MS / 1000} s`);
        for (const o of l.clients) this.send(o, { t: 'peerDropped', memberId: m.id, slot: m.slot, name: m.name, timeoutMs: RECONNECT_MS });
        l.dropTimers.set(m.id, setTimeout(() => this.gone(l, m.id, 'timeout'), RECONNECT_MS));
        this.broadcastLobby(l);
      }
      return;
    }
    this.removeMember(l, m.id);
  }

  /** A member leaves a lobby outside a match. The host leaving closes the lobby. */
  private removeMember(l: Lobby, memberId: number): void {
    const m = this.member(l, memberId);
    if (m === undefined) return;
    if (l.info.hostId === memberId) {
      const othersPlaying = [...l.playing].some((id) => id !== memberId);
      if (!(l.info.inMatch && othersPlaying)) {
        this.closeLobby(l, `${m.name} closed the lobby`);
        return;
      }
      // The match plays on without the host; the lobby closes when everyone leaves results.
      l.closing = `${m.name} left, so the lobby closed`;
    }
    l.info.members = l.info.members.filter((x) => x.id !== memberId);
    l.playing.delete(memberId);
    l.tokens.delete(memberId);
    for (const c of l.clients) {
      if (c.memberId === memberId) {
        l.clients.delete(c);
        c.lobby = null;
        this.send(c, { t: 'lobby', lobby: null });
      }
    }
    if (l.playing.size === 0) this.endMatch(l);
    this.broadcastLobby(l);
    this.pushList();
  }

  /** A member is out of a running match for good: left on purpose or never came back. */
  private gone(l: Lobby, memberId: number, reason: 'left' | 'timeout'): void {
    const t = l.dropTimers.get(memberId);
    if (t !== undefined) clearTimeout(t);
    l.dropTimers.delete(memberId);
    const m = this.member(l, memberId);
    if (m === undefined || !this.lobbies.has(l.info.id)) return;
    // Every fighter this member sent input for (its own, plus the CPUs when it hosted) leaves at
    // the first frame the relay has no input for. Peers eliminate them there, so the sim's match
    // end rule hands the win to whoever remains.
    const players: number[] = [];
    let last = Number.MAX_SAFE_INTEGER;
    if (l.start !== null && l.log !== null) {
      l.start.owners.forEach((owner, i) => {
        if (owner !== m.slot) return;
        players.push(i);
        last = Math.min(last, l.log?.last[i] ?? -1);
      });
    }
    const retirement: Retirement = { frame: players.length === 0 ? 0 : last + 1, players };
    const log = l.log;
    if (log !== null && players.length > 0) {
      const from = Math.max(0, last - 47);
      retirement.tail = { from, inputs: players.map((i) => log.range(i, from, last)) };
    }
    if (players.length > 0) l.retirements.push(retirement);
    this.opts.log(`[lan] ${m.name} ${reason === 'left' ? 'left' : 'timed out of'} the match in lobby ${l.info.id}, out from frame ${retirement.frame}`);
    const msg: ServerMsg = { t: 'peerGone', memberId, slot: m.slot, name: m.name, reason, retirement };
    const targets = [...l.clients].filter((c) => c.memberId !== memberId);
    // Behind any input packets still held by the simulated latency, so peers have them first.
    const latency = l.info.settings.simLatencyMs;
    const notify = (): void => { for (const c of targets) this.send(c, msg); };
    if (latency > 0) setTimeout(notify, latency + 5);
    else notify();
    this.removeMember(l, memberId);
  }

  private closeLobby(l: Lobby, message: string): void {
    for (const t of l.dropTimers.values()) clearTimeout(t);
    for (const c of l.clients) {
      c.lobby = null;
      this.send(c, { t: 'lobbyClosed', message });
      this.send(c, { t: 'lobby', lobby: null });
    }
    l.clients.clear();
    this.lobbies.delete(l.info.id);
    this.opts.log(`[lan] lobby ${l.info.id} closed: ${message}`);
    this.pushList();
  }

  private endMatch(l: Lobby): void {
    l.info.inMatch = false;
    l.start = null;
    l.log = null;
    l.playing.clear();
    l.retirements = [];
    if (l.closing !== '' && this.lobbies.has(l.info.id)) this.closeLobby(l, l.closing);
  }

  private join(c: Client, l: Lobby, charId: string): void {
    if (c.version !== this.opts.version) return this.send(c, { t: 'error', message: 'Different game version: update both machines to the same build' });
    if (l.info.inMatch) return this.send(c, { t: 'error', message: `${l.info.settings.name} is in a match. Try again when it ends` });
    const slot = this.freeSlot(l);
    if (slot < 0) return this.send(c, { t: 'error', message: `${l.info.settings.name} is full (${LOBBY_MAX}/${LOBBY_MAX})` });
    if (c.lobby !== null) this.removeMember(c.lobby, c.memberId);
    const name = uniqueName(c.name, l.info.members.map((m) => m.name));
    const token = crypto.randomBytes(12).toString('hex');
    c.lobby = l;
    c.memberId = c.id;
    l.clients.add(c);
    l.tokens.set(c.id, token);
    l.info.members.push({
      id: c.id, name, slot, charId: charId.slice(0, 32) || 'aeval', team: slot,
      ready: false, rematch: false, ping: -1, connected: true,
    });
    l.info.members.sort((a, b) => a.slot - b.slot);
    this.send(c, { t: 'joined', lobbyId: l.info.id, memberId: c.id, token });
    this.broadcastLobby(l);
    this.pushList();
  }

  private startMatch(l: Lobby): string {
    const start = buildMatchStart(l.info, crypto.randomBytes(4).readUInt32LE(0));
    if (start.config.players.length < 2) return 'Need two players, or turn on CPU fill';
    l.info.inMatch = true;
    l.start = start;
    l.log = new InputLog(start.config.players.length);
    l.playing = new Set(l.info.members.map((m) => m.id));
    for (const m of l.info.members) {
      m.ready = false;
      m.rematch = false;
    }
    for (const o of l.clients) this.send(o, { t: 'start', start });
    this.broadcastLobby(l);
    this.pushList();
    this.opts.log(`[lan] lobby ${l.info.id} "${l.info.settings.name}" started: ${start.config.players.length} players, ` +
      `delay ${start.inputDelay}${l.info.settings.inputDelay < 0 ? ' (auto)' : ''}, sim latency ${l.info.settings.simLatencyMs} ms`);
    return '';
  }

  private tryRematch(l: Lobby): void {
    if (!this.lobbies.has(l.info.id) || l.info.inMatch || l.info.members.length === 0) return;
    if (!l.info.members.every((m) => m.rematch)) return;
    const err = this.startMatch(l);
    if (err !== '') for (const c of l.clients) this.send(c, { t: 'error', message: err });
  }

  private relay(c: Client, data: Buffer): void {
    const l = c.lobby;
    if (l === null || !l.info.inMatch || l.start === null) return;
    const m = this.member(l, c.memberId);
    if (m === undefined) return;
    const owners = l.start.owners;
    l.log?.record(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), (idx) => owners[idx] === m.slot);
    const out = (): void => {
      for (const o of l.clients) {
        if (o !== c && o.ws.readyState === WebSocket.OPEN) o.ws.send(data, { binary: true });
      }
    };
    const latency = l.info.settings.simLatencyMs;
    if (latency > 0) setTimeout(out, latency);
    else out();
  }

  // ---------------- messages ----------------

  private handle(c: Client, msg: ClientMsg): void {
    const l = c.lobby;
    switch (msg.t) {
      case 'hello':
        c.name = String(msg.name ?? '').trim().slice(0, NAME_MAX) || 'PLAYER';
        if (typeof msg.version === 'string' && msg.version !== '') c.version = msg.version;
        this.send(c, { t: 'lobbies', lobbies: [...this.ownListings(), ...this.opts.remoteListings()] });
        return;
      case 'list':
        this.send(c, { t: 'lobbies', lobbies: [...this.ownListings(), ...this.opts.remoteListings()] });
        return;
      case 'ping': {
        this.send(c, { t: 'pong', ts: Number(msg.ts) || 0 });
        const m = l === null ? undefined : this.member(l, c.memberId);
        const rtt = Math.round(Number(msg.rtt));
        if (l !== null && m !== undefined && rtt >= 0 && rtt !== m.ping) {
          m.ping = rtt;
          if (!l.info.inMatch) this.broadcastLobby(l);
        }
        return;
      }
      case 'create': {
        if (c.version !== this.opts.version) return this.send(c, { t: 'error', message: 'Different game version' });
        const lobby: Lobby = {
          info: { id: this.nextLobbyId++, hostId: c.id, settings: sanitizeSettings(msg.settings ?? {}, this.opts.fallbackStage), members: [], inMatch: false },
          clients: new Set(), playing: new Set(), start: null, log: null, tokens: new Map(), dropTimers: new Map(),
          retirements: [], closing: '',
        };
        this.lobbies.set(lobby.info.id, lobby);
        this.join(c, lobby, String(msg.charId ?? 'aeval'));
        if (!lobby.info.members.some((m) => m.id === c.id)) this.lobbies.delete(lobby.info.id);
        return;
      }
      case 'join': {
        const target = this.lobbies.get(Number(msg.lobbyId));
        if (target === undefined) return this.send(c, { t: 'error', message: 'That lobby has closed' });
        this.join(c, target, String(msg.charId ?? 'aeval'));
        return;
      }
      case 'leave':
        if (l === null) return;
        if (l.info.inMatch && l.playing.has(c.memberId)) this.gone(l, c.memberId, 'left');
        else this.removeMember(l, c.memberId);
        return;
      case 'leaveMatch':
        if (l !== null && l.info.inMatch && l.playing.has(c.memberId)) this.gone(l, c.memberId, 'left');
        return;
      case 'member': {
        if (l === null || l.info.inMatch) return;
        const m = this.member(l, c.memberId);
        if (m === undefined) return;
        if (typeof msg.charId === 'string' && msg.charId !== '') m.charId = msg.charId.slice(0, 32);
        if (typeof msg.team === 'number' && msg.team >= 0 && msg.team < LOBBY_MAX) m.team = Math.floor(msg.team);
        if (typeof msg.ready === 'boolean') {
          m.ready = msg.ready;
          if (!msg.ready) m.rematch = false;
        }
        if (typeof msg.name === 'string') {
          m.name = uniqueName(msg.name, l.info.members.filter((x) => x.id !== m.id).map((x) => x.name));
          c.name = m.name;
        }
        this.broadcastLobby(l);
        return;
      }
      case 'settings':
        if (l === null || l.info.hostId !== c.memberId || l.info.inMatch) return;
        l.info.settings = sanitizeSettings(msg.settings ?? {}, this.opts.fallbackStage);
        for (const m of l.info.members) if (m.id !== c.memberId) { m.ready = false; m.rematch = false; }
        this.broadcastLobby(l);
        this.pushList();
        return;
      case 'assign': {
        if (l === null || l.info.hostId !== c.memberId || l.info.inMatch) return;
        const m = this.member(l, Number(msg.memberId));
        const slot = Math.floor(Number(msg.slot));
        if (m === undefined || !(slot >= 0 && slot < LOBBY_MAX)) return;
        const other = l.info.members.find((x) => x.slot === slot);
        if (other !== undefined) other.slot = m.slot;
        m.slot = slot;
        l.info.members.sort((a, b) => a.slot - b.slot);
        this.broadcastLobby(l);
        return;
      }
      case 'start': {
        if (l === null || l.info.hostId !== c.memberId || l.info.inMatch) return;
        const notReady = l.info.members.filter((m) => m.id !== c.memberId && !m.ready);
        if (notReady.length > 0) return this.send(c, { t: 'error', message: `Waiting for ${notReady.map((m) => m.name).join(', ')} to ready up` });
        const err = this.startMatch(l);
        if (err !== '') this.send(c, { t: 'error', message: err });
        return;
      }
      case 'backToLobby':
        if (l === null) return;
        l.playing.delete(c.memberId);
        if (l.playing.size === 0 && l.info.inMatch) {
          this.endMatch(l);
          this.broadcastLobby(l);
          this.pushList();
          this.tryRematch(l);
        }
        return;
      case 'rematch': {
        const m = l === null ? undefined : this.member(l, c.memberId);
        if (l === null || m === undefined) return;
        m.rematch = true;
        m.ready = true;
        this.broadcastLobby(l);
        this.tryRematch(l);
        return;
      }
      case 'resume':
        this.resume(c, msg);
        return;
      default:
        return;
    }
  }

  private resume(c: Client, msg: Extract<ClientMsg, { t: 'resume' }>): void {
    const l = this.lobbies.get(Number(msg.lobbyId));
    const memberId = Number(msg.memberId);
    const m = l === undefined ? undefined : this.member(l, memberId);
    if (l === undefined || m === undefined || l.tokens.get(memberId) !== msg.token) {
      return this.send(c, { t: 'error', message: 'The match you were in has ended' });
    }
    if (!l.info.inMatch || l.start === null || l.log === null || !l.playing.has(memberId)) {
      return this.send(c, { t: 'error', message: 'The match you were in has ended' });
    }
    // The old socket may not have noticed it is dead yet: it no longer speaks for the member.
    for (const o of l.clients) {
      if (o.memberId === memberId) {
        o.replaced = true;
        l.clients.delete(o);
        o.ws.terminate();
      }
    }
    const t = l.dropTimers.get(memberId);
    if (t !== undefined) clearTimeout(t);
    l.dropTimers.delete(memberId);
    c.lobby = l;
    c.memberId = memberId;
    c.name = m.name;
    c.version = typeof msg.version === 'string' && msg.version !== '' ? msg.version : c.version;
    m.connected = true;
    // Sent before this socket joins the relay set, so no packet falls between the history and
    // the live stream (the event loop runs both synchronously).
    this.send(c, { t: 'resumed', start: l.start, history: l.log.history(), retirements: l.retirements, lobby: l.info, memberId, token: msg.token });
    l.clients.add(c);
    for (const o of l.clients) if (o !== c) this.send(o, { t: 'peerResumed', memberId, slot: m.slot });
    this.broadcastLobby(l);
    this.opts.log(`[lan] ${m.name} resumed in lobby ${l.info.id}`);
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
