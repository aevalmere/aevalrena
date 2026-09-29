import {
  LAN_PATH, RECONNECT_MS,
  type ClientMsg, type InputHistory, type LobbyInfo, type LobbyListing, type LobbyMember, type LobbySettings, type MatchStart,
  type Retirement, type ServerMsg,
} from './protocol';

/** sessionStorage key of the lobby seat this tab holds, so a reload mid-match can resume it. */
const SEAT_KEY = 'aevalrena.lan.seat';

/** What a tab needs to take its seat back after a reload. */
interface Seat {
  address: string;
  lobbyId: number;
  memberId: number;
  token: string;
  name: string;
  /** True between the match start and leaving its results; only then does a reload resume. */
  inMatch: boolean;
}

function readSeat(): Seat | null {
  try {
    const raw = sessionStorage.getItem(SEAT_KEY);
    if (raw === null) return null;
    const s = JSON.parse(raw) as Partial<Seat>;
    if (typeof s.address !== 'string' || typeof s.token !== 'string' || typeof s.lobbyId !== 'number' || typeof s.memberId !== 'number') return null;
    return { address: s.address, lobbyId: s.lobbyId, memberId: s.memberId, token: s.token, name: String(s.name ?? 'PLAYER'), inMatch: s.inMatch === true };
  } catch {
    return null;
  }
}

function writeSeat(seat: Seat | null): void {
  try {
    if (seat === null) sessionStorage.removeItem(SEAT_KEY);
    else sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat));
  } catch {
    // Storage blocked: a reload then counts as leaving, as before.
  }
}

/**
 * Browser side of LAN play (docs/LAN.md). Two sockets:
 *
 * - the agent socket, to the `npm run lan` agent that served this page (or one typed in): it
 *   pushes the merged lobby list (its own lobbies plus every agent it discovered) once a second;
 * - the lobby socket, to whichever agent holds the lobby this player is in (possibly the same
 *   agent). Lobby JSON, pings and the match's binary input packets use it.
 *
 * Lives for the whole app (a module singleton), so the lobby socket survives the lobby screen
 * closing when a match starts. UI code reads its fields and listens with `onChange`.
 */

export type LinkStatus = 'idle' | 'connecting' | 'connected' | 'closed';
export type LobbyStatus = 'none' | 'joining' | 'in' | 'reconnecting';

/** A listing with its agent address resolved, plus whether this build can join it. */
export interface LobbyRow extends LobbyListing {
  joinable: boolean;
}

function cleanAddress(address: string): string {
  return address.trim().replace(/^(wss?|https?):\/\//, '').replace(/\/.*$/, '');
}

export class LanClient {
  name = 'PLAYER';

  agentStatus: LinkStatus = 'idle';
  agentAddress = '';
  agentId = '';
  version = '';
  hostName = '';
  private agentWs: WebSocket | null = null;
  private agentListings: LobbyListing[] = [];
  private readonly manual = new Map<string, { ws: WebSocket; listings: LobbyListing[] }>();

  lobbyStatus: LobbyStatus = 'none';
  lobbyAddress = '';
  lobby: LobbyInfo | null = null;
  lobbyId = -1;
  memberId = -1;
  private token = '';
  /** The lobby socket. The match transport reads and writes binary frames on it. */
  ws: WebSocket | null = null;
  /** Round trip to the lobby's agent, ms; -1 unknown. */
  rtt = -1;
  private pingTimer = 0;
  private reconnectTimer = 0;
  private reconnectDeadline = 0;
  /** Test hook: no reconnect attempt before this time (performance.now()). */
  private reconnectHoldUntil = 0;

  /** Last error or notice, shown on the LAN screen; cleared by the next action. */
  message = '';
  /** Set by main.ts while a LAN match runs: a dropped lobby socket then reconnects and resumes. */
  matchActive = false;

  onStart: ((start: MatchStart) => void) | null = null;
  onResumed: ((start: MatchStart, history: InputHistory, retirements: Retirement[]) => void) | null = null;
  onPeerDropped: ((slot: number, name: string, timeoutMs: number) => void) | null = null;
  onPeerResumed: ((slot: number) => void) | null = null;
  onPeerGone: ((slot: number, name: string, reason: 'left' | 'timeout', retirement: Retirement) => void) | null = null;
  onLobbyClosed: ((message: string) => void) | null = null;
  /** The lobby socket went down during a match and could not resume. */
  onLinkLost: ((message: string) => void) | null = null;

  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  // ---------------- agent (lobby list) ----------------

  connectAgent(address: string, name: string): void {
    this.disconnectAgent();
    this.name = name.trim().slice(0, 12) || 'PLAYER';
    const addr = cleanAddress(address);
    this.agentAddress = addr;
    this.agentStatus = 'connecting';
    this.message = '';
    this.changed();
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${addr}${LAN_PATH}`);
    } catch {
      this.agentStatus = 'closed';
      this.message = `Not an address: ${address}`;
      this.changed();
      return;
    }
    this.agentWs = ws;
    ws.addEventListener('open', () => {
      if (this.agentWs !== ws) return;
      this.agentStatus = 'connected';
      this.sendOn(ws, { t: 'hello', name: this.name, version: '' });
      this.changed();
    });
    ws.addEventListener('close', () => {
      if (this.agentWs !== ws) return;
      this.agentWs = null;
      const was = this.agentStatus;
      this.agentStatus = 'closed';
      this.agentListings = [];
      if (was === 'connected') this.message = `Lost the LAN agent at ${addr}. Is "npm run lan" still running?`;
      else this.message = `No LAN agent at ${addr}. Start one with "npm run lan" and open the address it prints.`;
      this.changed();
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (this.agentWs !== ws || typeof ev.data !== 'string') return;
      const msg = parse(ev.data);
      if (msg === null) return;
      if (msg.t === 'welcome') {
        this.agentId = msg.agentId;
        this.version = msg.version;
        this.hostName = msg.hostName;
      } else if (msg.t === 'lobbies') {
        this.agentListings = msg.lobbies;
      } else if (msg.t === 'error') {
        this.message = msg.message;
      }
      this.changed();
    });
  }

  disconnectAgent(): void {
    const ws = this.agentWs;
    this.agentWs = null;
    this.agentStatus = 'idle';
    this.agentListings = [];
    if (ws !== null) ws.close(1000);
    for (const m of this.manual.values()) m.ws.close(1000);
    this.manual.clear();
  }

  /** "Join by address": list the lobbies of an agent discovery did not find. */
  addAgentByAddress(address: string): void {
    const addr = cleanAddress(address);
    if (addr === '' || addr === this.agentAddress || this.manual.has(addr)) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${addr}${LAN_PATH}`);
    } catch {
      this.message = `Not an address: ${address}`;
      this.changed();
      return;
    }
    const entry = { ws, listings: [] as LobbyListing[] };
    this.manual.set(addr, entry);
    this.message = `Looking for lobbies at ${addr}...`;
    this.changed();
    ws.addEventListener('open', () => this.sendOn(ws, { t: 'hello', name: this.name, version: '' }));
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      const msg = parse(ev.data);
      if (msg === null || msg.t !== 'lobbies') return;
      // That agent lists its own lobbies with address ''; they live at the address we typed.
      entry.listings = msg.lobbies.map((l) => (l.address === '' ? { ...l, address: addr } : l));
      if (this.message.startsWith('Looking for')) this.message = entry.listings.length === 0 ? `${addr} has no lobbies yet` : '';
      this.changed();
    });
    ws.addEventListener('close', () => {
      if (this.manual.get(addr) !== entry) return;
      this.manual.delete(addr);
      if (entry.listings.length === 0) this.message = `No LAN agent answered at ${addr}`;
      this.changed();
    });
  }

  /** Every lobby this browser can see, local agent first, de-duplicated. */
  rows(): LobbyRow[] {
    const out: LobbyRow[] = [];
    const seen = new Set<string>();
    const add = (l: LobbyListing): void => {
      const key = `${l.agentId}/${l.lobbyId}`;
      if (seen.has(key)) return;
      seen.add(key);
      const address = l.address === '' ? this.agentAddress : l.address;
      out.push({ ...l, address, joinable: this.version === '' || l.version === this.version });
    };
    for (const l of this.agentListings) add(l);
    for (const m of this.manual.values()) for (const l of m.listings) add(l);
    return out;
  }

  // ---------------- lobby ----------------

  create(settings: LobbySettings, charId: string): void {
    this.openLobby(this.agentAddress, { t: 'create', settings, charId });
  }

  join(row: LobbyRow, charId: string): void {
    if (!row.joinable) {
      this.message = 'That lobby runs a different game version';
      this.changed();
      return;
    }
    this.openLobby(row.address, { t: 'join', lobbyId: row.lobbyId, charId });
  }

  private openLobby(address: string, first: ClientMsg): void {
    this.closeLobbySocket();
    this.lobbyAddress = cleanAddress(address);
    this.lobbyStatus = 'joining';
    this.message = '';
    this.changed();
    this.dial(first);
  }

  /** Open the lobby socket and send `first` after hello. Used for joins and for resumes. */
  private dial(first: ClientMsg): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${this.lobbyAddress}${LAN_PATH}`);
    } catch {
      this.lobbyStatus = 'none';
      this.message = `Not an address: ${this.lobbyAddress}`;
      this.changed();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.sendOn(ws, { t: 'hello', name: this.name, version: this.version });
      this.sendOn(ws, first);
      this.startPings();
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      const msg = parse(ev.data);
      if (msg !== null) this.receive(msg);
    });
    ws.addEventListener('close', (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPings();
      if (this.matchActive && this.token !== '' && ev.code !== 1000) {
        this.beginReconnect();
        return;
      }
      if (this.lobbyStatus === 'reconnecting') return; // a failed resume attempt; the timer retries
      const hadLobby = this.lobby !== null;
      this.lobby = null;
      this.lobbyStatus = 'none';
      if (hadLobby && this.message === '') this.message = `Lost the connection to the lobby at ${this.lobbyAddress}`;
      else if (!hadLobby && this.message === '') this.message = `Could not reach ${this.lobbyAddress}`;
      this.changed();
    });
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'joined':
        this.lobbyId = msg.lobbyId;
        this.memberId = msg.memberId;
        this.token = msg.token;
        this.lobbyStatus = 'in';
        this.saveSeat(false);
        break;
      case 'lobby':
        this.lobby = msg.lobby;
        if (msg.lobby === null) {
          this.lobbyStatus = 'none';
          this.token = '';
          writeSeat(null);
          this.closeLobbySocket();
        }
        break;
      case 'start':
        this.message = '';
        this.saveSeat(true);
        this.onStart?.(msg.start);
        break;
      case 'resumed':
        this.stopReconnect();
        this.lobbyStatus = 'in';
        this.lobby = msg.lobby;
        this.lobbyId = msg.lobby.id;
        this.memberId = msg.memberId;
        this.token = msg.token;
        this.message = '';
        this.saveSeat(true);
        this.onResumed?.(msg.start, msg.history, msg.retirements);
        break;
      case 'peerDropped':
        this.onPeerDropped?.(msg.slot, msg.name, msg.timeoutMs);
        break;
      case 'peerResumed':
        this.onPeerResumed?.(msg.slot);
        break;
      case 'peerGone':
        this.onPeerGone?.(msg.slot, msg.name, msg.reason, msg.retirement);
        break;
      case 'lobbyClosed':
        this.message = msg.message;
        this.lobby = null;
        this.lobbyStatus = 'none';
        this.token = '';
        writeSeat(null);
        this.onLobbyClosed?.(msg.message);
        break;
      case 'pong':
        this.rtt = Math.max(0, Math.round(performance.now() - msg.ts));
        return; // no repaint per pong; the screen reads rtt when it next paints
      case 'error':
        this.message = msg.message;
        if (this.lobbyStatus === 'joining') {
          this.lobbyStatus = 'none';
          this.closeLobbySocket();
        } else if (this.lobbyStatus === 'reconnecting') {
          this.stopReconnect();
          this.lobbyStatus = 'none';
          writeSeat(null);
          this.onLinkLost?.(msg.message);
        }
        break;
      default:
        break;
    }
    this.changed();
  }

  private beginReconnect(): void {
    if (this.lobbyStatus === 'reconnecting') return;
    this.lobbyStatus = 'reconnecting';
    this.reconnectDeadline = performance.now() + RECONNECT_MS;
    this.message = 'Connection lost, reconnecting...';
    this.changed();
    const attempt = (): void => {
      if (this.lobbyStatus !== 'reconnecting') return;
      if (performance.now() > this.reconnectDeadline) {
        this.stopReconnect();
        this.lobbyStatus = 'none';
        this.lobby = null;
        this.token = '';
        this.message = `Could not reconnect to ${this.lobbyAddress}`;
        writeSeat(null);
        this.onLinkLost?.(this.message);
        this.changed();
        return;
      }
      if (this.ws === null && performance.now() >= this.reconnectHoldUntil) {
        this.dial({ t: 'resume', lobbyId: this.lobbyId, memberId: this.memberId, token: this.token, version: this.version });
      }
    };
    attempt();
    this.reconnectTimer = window.setInterval(attempt, 1000);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer !== 0) window.clearInterval(this.reconnectTimer);
    this.reconnectTimer = 0;
  }

  private startPings(): void {
    this.stopPings();
    const ping = (): void => this.send({ t: 'ping', ts: performance.now(), rtt: this.rtt });
    ping();
    this.pingTimer = window.setInterval(ping, 1000);
  }

  private stopPings(): void {
    if (this.pingTimer !== 0) window.clearInterval(this.pingTimer);
    this.pingTimer = 0;
  }

  private closeLobbySocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.stopPings();
    if (ws !== null && ws.readyState <= WebSocket.OPEN) ws.close(1000);
  }

  private sendOn(ws: WebSocket, msg: ClientMsg): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  send(msg: ClientMsg): void {
    if (this.ws !== null) this.sendOn(this.ws, msg);
    // A player action replaces the last notice; bookkeeping messages keep it (a "lobby closed"
    // notice must survive the backToLobby sent on the way off the results screen).
    if (msg.t !== 'ping' && msg.t !== 'list' && msg.t !== 'backToLobby' && msg.t !== 'rematch' && msg.t !== 'leaveMatch') this.message = '';
  }

  private saveSeat(inMatch: boolean): void {
    if (this.token === '') return;
    writeSeat({ address: this.lobbyAddress, lobbyId: this.lobbyId, memberId: this.memberId, token: this.token, name: this.name, inMatch });
  }

  /**
   * After a page load: if this tab held a seat in a running match, dial that lobby's agent and
   * resume exactly as after a network drop (the agent holds a dropped seat for RECONNECT_MS).
   * Returns false when there is nothing to resume.
   */
  resumeSavedSeat(): boolean {
    const seat = readSeat();
    if (seat === null || !seat.inMatch) return false;
    this.name = seat.name;
    this.lobbyAddress = seat.address;
    this.lobbyId = seat.lobbyId;
    this.memberId = seat.memberId;
    this.token = seat.token;
    this.matchActive = true;
    this.beginReconnect();
    return true;
  }

  /** Leave the lobby (the lobby's agent removes us when the socket closes). */
  leave(): void {
    this.send({ t: 'leave' });
    this.lobby = null;
    this.lobbyStatus = 'none';
    this.token = '';
    writeSeat(null);
    this.closeLobbySocket();
    this.changed();
  }

  /** Leave a running match on purpose: the others see "left", no reconnect window. */
  leaveMatch(): void {
    this.matchActive = false;
    this.send({ t: 'leaveMatch' });
    writeSeat(null);
  }

  /** Test hook: drop the lobby socket as a network fault would, stay offline `holdMs`, then resume. */
  simulateDrop(holdMs = 0): void {
    this.reconnectHoldUntil = performance.now() + holdMs;
    this.ws?.close(4000, 'simulated drop');
  }

  me(): LobbyMember | null {
    if (this.lobby === null) return null;
    return this.lobby.members.find((m) => m.id === this.memberId) ?? null;
  }

  isHost(): boolean {
    return this.lobby !== null && this.lobby.hostId === this.memberId;
  }

  setMember(patch: { charId?: string; team?: number; ready?: boolean; name?: string }): void { this.send({ t: 'member', ...patch }); }
  setSettings(settings: LobbySettings): void { this.send({ t: 'settings', settings }); }
  assign(memberId: number, slot: number): void { this.send({ t: 'assign', memberId, slot }); }
  start(): void { this.send({ t: 'start' }); }
  backToLobby(): void {
    this.send({ t: 'backToLobby' });
    this.saveSeat(false);
  }
  rematch(): void { this.send({ t: 'rematch' }); }
}

function parse(data: string): ServerMsg | null {
  try {
    const v: unknown = JSON.parse(data);
    if (typeof v !== 'object' || v === null || typeof (v as { t?: unknown }).t !== 'string') return null;
    return v as ServerMsg;
  } catch {
    return null;
  }
}

/** The app's one LAN client (main.ts drives matches; the LAN screen drives lobbies). */
export const lanClient = new LanClient();
