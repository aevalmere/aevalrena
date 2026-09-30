/**
 * Lobbies and the input relay for their matches, independent of the transport (docs/LAN.md).
 * Two hosts run this same code:
 *
 * - the Node LAN agent (server/lobbyhost.ts), one LobbyConn per browser WebSocket;
 * - the lobby host's browser tab in the in-browser mode (src/net/browserhost.ts), one LobbyConn
 *   per guest RTCPeerConnection plus an in-page loopback for the host's own client.
 *
 * Nothing here may import from Node (no ws, dgram, fs, http, node:*): the browser bundles it.
 */
import { createPacket, decodePacket, MAX_PEERS } from './codec';
import { InputLog, LOG_MAX_AHEAD } from './inputlog';
import {
  buildMatchStart, freeVariant, LOBBY_MAX, NAME_MAX, RECONNECT_MS, sanitizeSettings, uniqueName, VARIANT_MAX,
  type Announce, type ClientMsg, type LobbyInfo, type LobbyListing, type LobbyMember, type LobbySettings, type MatchStart, type Retirement,
  type ServerMsg,
} from './protocol';

/**
 * Close codes that mean "left on purpose": a normal close (the client sends it after leaveMatch
 * or leave) and our explicit leave code. 1001 ("going away") is a reload as often as a closed
 * tab, so over WebSocket it counts as a drop: the slot is held for RECONNECT_MS and a reload
 * resumes. A WebRTC link always closes with LEFT_CODE (no resume in that mode).
 */
const LEFT_CODES = new Set([1000, 4001]);
export const LEFT_CODE = 4001;
/** Liveness probes (1 s apart) a connection may miss before it counts as dropped. */
export const MAX_MISSED = 4;
/** Largest message a host accepts; an input packet is under 2 KiB. */
export const MAX_PAYLOAD = 64 * 1024;

/** One connection to a client, as the transport sees it. */
export interface LobbyConn {
  readonly open: boolean;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  /** Drop the connection now; the transport then reports the close through `LobbyPeer.closed`. */
  terminate(): void;
  /**
   * Once a second. A WebSocket sends a ping frame (its pong calls `LobbyPeer.alive`). A WebRTC
   * link does nothing: its client pings every second on the reliable channel.
   */
  probe(): void;
}

/** What the transport reports back for one attached connection. */
export interface LobbyPeer {
  text(data: string): void;
  binary(bytes: Uint8Array): void;
  closed(code: number): void;
  /** Any sign of life that is not a message (a WebSocket pong). */
  alive(): void;
}

interface Client {
  id: number;
  conn: LobbyConn;
  name: string;
  version: string;
  lobby: Lobby | null;
  /** Member id this connection speaks for (a resumed connection takes over its old member id). */
  memberId: number;
  missed: number;
  /** Superseded by a resumed connection: its close must not drop the member. */
  replaced: boolean;
  gone: boolean;
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

export interface LobbyCoreOptions {
  agentId: string;
  hostName: string;
  version: string;
  fallbackStage: string;
  /** Stage and character ids this build knows (STAGE_DEFS, CHARACTER_DEFS); others are replaced. */
  stages: string[];
  characters: string[];
  /** Lobbies discovered on other agents, for the merged list. */
  remoteListings(): LobbyListing[];
  log(line: string): void;
}

const MESSAGE_TYPES = new Set<string>([
  'hello', 'list', 'create', 'join', 'leave', 'member', 'settings', 'assign', 'start', 'backToLobby',
  'rematch', 'leaveMatch', 'resume', 'ping',
]);

/** A parsed text message, if it is an object with a known string `t`. */
function asClientMsg(value: unknown): ClientMsg | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const t = (value as { t?: unknown }).t;
  return typeof t === 'string' && MESSAGE_TYPES.has(t) ? (value as ClientMsg) : null;
}

function randomToken(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function randomSeed(): number {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return b[0];
}

export class LobbyCore {
  private readonly packet = createPacket();
  private nextClientId = 1;
  private nextLobbyId = 1;
  private readonly clients = new Set<Client>();
  private readonly lobbies = new Map<number, Lobby>();

  /** Packets refused by the relay (malformed, foreign players, frames out of range). */
  rejectedPackets = 0;

  constructor(private readonly opts: LobbyCoreOptions) {}

  /** Stop every timer and drop every connection. */
  dispose(): void {
    for (const l of this.lobbies.values()) for (const t of l.dropTimers.values()) clearTimeout(t);
    for (const c of [...this.clients]) c.conn.terminate();
  }

  attach(conn: LobbyConn): LobbyPeer {
    const c: Client = {
      id: this.nextClientId++, conn, name: 'PLAYER', version: this.opts.version, lobby: null,
      memberId: 0, missed: 0, replaced: false, gone: false,
    };
    c.memberId = c.id;
    this.clients.add(c);
    const peer: LobbyPeer = {
      text: (data: string) => this.guard(c, () => {
        c.missed = 0;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }
        const msg = asClientMsg(parsed);
        if (msg === null) {
          this.send(c, { t: 'error', message: 'Bad message' });
          return;
        }
        this.handle(c, msg);
      }),
      binary: (bytes: Uint8Array) => this.guard(c, () => {
        c.missed = 0;
        this.relay(c, bytes);
      }),
      closed: (code: number) => {
        if (c.gone) return;
        c.gone = true;
        try {
          this.onClose(c, code);
        } catch (err) {
          this.opts.log(`[lan] error closing ${c.name} (#${c.id}): ${(err as Error).message}`);
        }
      },
      alive: () => { c.missed = 0; },
    };
    this.send(c, { t: 'welcome', id: c.id, version: this.opts.version, agentId: this.opts.agentId, hostName: this.opts.hostName });
    return peer;
  }

  /** One bad client must never take the host (and every lobby on it) down. */
  private guard(c: Client, fn: () => void): void {
    if (c.gone) return;
    try {
      fn();
    } catch (err) {
      this.opts.log(`[lan] dropped ${c.name} (#${c.id}) after an error handling its message: ${(err as Error).message}`);
      c.conn.terminate();
    }
  }

  /** Once a second: liveness and the lobby list push. */
  tick(): void {
    for (const c of [...this.clients]) {
      if (!c.conn.open) continue;
      if (++c.missed > MAX_MISSED) {
        this.opts.log(`[lan] ${c.name} missed ${MAX_MISSED} heartbeats, dropping the connection`);
        c.conn.terminate();
        continue;
      }
      c.conn.probe();
    }
    this.pushList();
  }

  /** This host's lobbies for the UDP announce. */
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
    if (c.conn.open) c.conn.sendText(JSON.stringify(msg));
  }

  private broadcastLobby(l: Lobby): void {
    for (const c of l.clients) this.send(c, { t: 'lobby', lobby: l.info });
  }

  private pushList(): void {
    const msg: ServerMsg = { t: 'lobbies', lobbies: [...this.ownListings(), ...this.opts.remoteListings()] };
    for (const c of this.clients) if (c.lobby === null) this.send(c, msg);
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
    const token = randomToken();
    c.lobby = l;
    c.memberId = c.id;
    l.clients.add(c);
    l.tokens.set(c.id, token);
    const char = this.character(charId);
    l.info.members.push({
      id: c.id, name, slot, charId: char, team: slot,
      // variant: a second player on the same character starts in the first unused colour.
      variant: freeVariant(l.info.members, char),
      ready: false, rematch: false, ping: -1, connected: true,
    });
    l.info.members.sort((a, b) => a.slot - b.slot);
    this.send(c, { t: 'joined', lobbyId: l.info.id, memberId: c.id, token });
    this.broadcastLobby(l);
    this.pushList();
  }

  private startMatch(l: Lobby): string {
    const start = buildMatchStart(l.info, randomSeed());
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

  /**
   * Relay an input packet to the other members, after checking it: it must decode, carry only
   * fighters the sender owns, and stay within LOG_MAX_AHEAD of what is confirmed. The peer id
   * byte is stamped with the sender's real slot, so nobody can speak for another peer.
   */
  private relay(c: Client, bytes: Uint8Array): void {
    const l = c.lobby;
    if (l === null || !l.info.inMatch || l.start === null || l.log === null) return;
    const m = this.member(l, c.memberId);
    if (m === undefined) return;
    const owners = l.start.owners;
    const log = l.log;
    const pk = this.packet;
    let ok = bytes.byteLength <= MAX_PAYLOAD && decodePacket(bytes, pk) && m.slot < MAX_PEERS && pk.firstFrame >= 0;
    for (let k = 0; ok && k < pk.players.length; k++) {
      const idx = pk.players[k];
      if (owners[idx] !== m.slot || pk.firstFrame + pk.frames - 1 > log.last[idx] + LOG_MAX_AHEAD) ok = false;
    }
    if (!ok) {
      this.rejectedPackets++;
      return;
    }
    const stamped = bytes.slice();
    stamped[1] = m.slot;
    log.record(stamped, (idx) => owners[idx] === m.slot);
    const out = (): void => {
      for (const o of l.clients) {
        if (o !== c && o.conn.open) o.conn.sendBinary(stamped);
      }
    };
    const latency = l.info.settings.simLatencyMs;
    if (latency > 0) setTimeout(out, latency);
    else out();
  }

  /** Clamped settings whose stage exists in this build. */
  private settings(raw: unknown): LobbySettings {
    const s = sanitizeSettings(typeof raw === 'object' && raw !== null ? raw as Partial<LobbySettings> : {}, this.opts.fallbackStage);
    if (!this.opts.stages.includes(s.stageId)) {
      this.opts.log(`[lan] unknown stage "${s.stageId}", using ${this.opts.fallbackStage}`);
      s.stageId = this.opts.fallbackStage;
    }
    return s;
  }

  /** A character id this build has, else the first one. */
  private character(id: unknown): string {
    const fallback = this.opts.characters[0] ?? 'aeval';
    if (typeof id === 'string' && this.opts.characters.includes(id)) return id;
    this.opts.log(`[lan] unknown character "${String(id).slice(0, 32)}", using ${fallback}`);
    return fallback;
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
          info: { id: this.nextLobbyId++, hostId: c.id, settings: this.settings(msg.settings), members: [], inMatch: false },
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
        if (typeof msg.charId === 'string' && msg.charId !== '') m.charId = this.character(msg.charId);
        if (typeof msg.team === 'number' && msg.team >= 0 && msg.team < LOBBY_MAX) m.team = Math.floor(msg.team);
        // variant: validated 0..3; anything else is ignored.
        if (typeof msg.variant === 'number' && Number.isInteger(msg.variant) && msg.variant >= 0 && msg.variant < VARIANT_MAX) {
          m.variant = msg.variant;
        }
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
        l.info.settings = this.settings(msg.settings);
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
    // The old connection may not have noticed it is dead yet: it no longer speaks for the member.
    for (const o of l.clients) {
      if (o.memberId === memberId) {
        o.replaced = true;
        l.clients.delete(o);
        o.conn.terminate();
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
    // Sent before this connection joins the relay set, so no packet falls between the history
    // and the live stream (both run synchronously).
    this.send(c, { t: 'resumed', start: l.start, history: l.log.history(), retirements: l.retirements, lobby: l.info, memberId, token: msg.token });
    l.clients.add(c);
    for (const o of l.clients) if (o !== c) this.send(o, { t: 'peerResumed', memberId, slot: m.slot });
    this.broadcastLobby(l);
    this.opts.log(`[lan] ${m.name} resumed in lobby ${l.info.id}`);
  }
}
