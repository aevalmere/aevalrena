import { startWorkerInterval, type WorkerInterval } from './bgtick';
import { BrowserHost, NETWORK_HINT } from './browserhost';
import { BUILD_VERSION } from './buildversion';
import { MAX_MISSED } from './lobbycore';
import {
  LAN_PATH, RECONNECT_MS,
  type ClientMsg, type InputHistory, type LobbyInfo, type LobbyListing, type LobbyMember, type LobbySettings, type MatchStart,
  type Retirement, type ServerMsg,
} from './protocol';
import { createLinkTransport, RtcLink, type BrowserLink } from './rtc';
import { CodeError, expandCode, versionHash } from './sdpcode';
import { SignalApi, SignalError } from './signal/api';
import { isRoomCode, normalizeCode } from './signal/codes';
import { RoomHost } from './signal/roomhost';
import { createWebSocketTransport, type NetTransport } from './transport';

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
/** 'agent': lobbies live on `npm run lan` agents. 'browser': WebRTC to the host's tab (no agent). */
export type LanMode = 'none' | 'agent' | 'browser';

/**
 * A guest's side of joining in the browser mode. Short code: waiting (for the host's offer),
 * connecting, connected. Long code: answering, answer (shown for the host to copy). Both: failed.
 */
export interface GuestJoin {
  state: 'idle' | 'waiting' | 'connecting' | 'connected' | 'answering' | 'answer' | 'failed';
  /** The answer code to show the host (long codes). */
  code: string;
  message: string;
  /** The failure was the connection itself: show the Wi-Fi hint. */
  network?: boolean;
}

/** How long a guest waits for the host to enter its answer code (long codes). */
export const GUEST_WAIT_MS = 120000;
/** Short codes: how long each step may take before the join fails. */
export const ROOM_STEP_MS = 10000;
/** Short codes: the guest's poll for its offer. */
const GUEST_POLL_MS = 400;
/** Short codes: register again when no offer came this long after registering (heals a lost write). */
const REJOIN_MS = 3000;

/** Whether the rendezvous answers: short codes need it. */
export type HelperState = 'unknown' | 'checking' | 'ok' | 'none';

/** A listing with its agent address resolved, plus whether this build can join it. */
export interface LobbyRow extends LobbyListing {
  joinable: boolean;
}

function cleanAddress(address: string): string {
  return address.trim().replace(/^(wss?|https?):\/\//, '').replace(/\/.*$/, '');
}

export class LanClient {
  name = 'PLAYER';
  mode: LanMode = 'none';

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

  /** Browser mode: the lobby link (a WebRTC link, or the host tab's loopback to its own lobby). */
  private link: BrowserLink | null = null;
  private linkTimer: WorkerInterval | null = null;
  private lastRx = 0;
  /** Browser mode guest: the character to join with once the host's lobby list arrives. */
  private joinChar = '';
  /** Browser mode: the host tab's lobby (LobbyCore plus one WebRTC link per guest). */
  readonly host = new BrowserHost(() => this.changed());
  guest: GuestJoin = { state: 'idle', code: '', message: '' };
  private guestLink: RtcLink | null = null;
  private guestTimer = 0;
  /** Bumped to stop a short-code join's polling. */
  private guestRun = 0;
  /** Short codes: the rendezvous, whether it answers, and the host's room. */
  readonly signal = new SignalApi();
  helper: HelperState = 'unknown';
  room: RoomHost | null = null;

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
    const link = this.link;
    this.link = null;
    this.linkTimer?.stop();
    this.linkTimer = null;
    link?.close();
    this.closeRoom();
  }

  private sendOn(ws: WebSocket, msg: ClientMsg): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  send(msg: ClientMsg): void {
    if (this.link !== null) this.link.sendText(JSON.stringify(msg));
    else if (this.ws !== null) this.sendOn(this.ws, msg);
    // A player action replaces the last notice; bookkeeping messages keep it (a "lobby closed"
    // notice must survive the backToLobby sent on the way off the results screen).
    if (msg.t !== 'ping' && msg.t !== 'list' && msg.t !== 'backToLobby' && msg.t !== 'rematch' && msg.t !== 'leaveMatch') this.message = '';
  }

  private saveSeat(inMatch: boolean): void {
    // Browser mode has no resume: a reload counts as leaving.
    if (this.token === '' || this.link !== null) return;
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
    if (this.guest.state === 'connected') this.guest = { state: 'idle', code: '', message: '' };
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

  /** The match's input transport over whichever lobby connection this client has. */
  createMatchTransport(): (NetTransport & { dispose(): void }) | null {
    if (this.link !== null) return createLinkTransport(this.link);
    if (this.ws !== null) return createWebSocketTransport(this.ws);
    return null;
  }

  // ---------------- browser mode (WebRTC, no agent) ----------------

  /** Pick the LAN mode. Leaving a mode leaves its lobby and drops its connections. */
  setMode(mode: LanMode): void {
    if (mode === this.mode) return;
    if (this.lobby !== null || this.link !== null || this.ws !== null) this.leave();
    this.disconnectAgent();
    this.cancelGuest();
    this.mode = mode;
    this.message = '';
    this.changed();
  }

  /** Host: start a lobby in this tab. Guests join it with codes from `host.invite()`. */
  createInBrowser(settings: LobbySettings, charId: string, ids: { stages: string[]; characters: string[] }): void {
    if (this.host.busy) {
      this.message = 'Your last lobby still has a match running. Try again when it ends';
      this.changed();
      return;
    }
    this.closeLobbySocket();
    this.cancelGuest();
    const link = this.host.start({
      hostName: this.name, version: BUILD_VERSION, fallbackStage: ids.stages[0] ?? settings.stageId,
      stages: ids.stages, characters: ids.characters,
    });
    this.attachLink(link, { t: 'create', settings, charId });
  }

  /** Ask the rendezvous whether it is there (the LAN screen does on open). */
  checkHelper(): void {
    if (this.helper === 'checking' || this.helper === 'ok') return;
    this.helper = 'checking';
    this.changed();
    void this.signal.health().then((ok) => {
      this.helper = ok ? 'ok' : 'none';
      this.changed();
    });
  }

  /** Host with a short code: the lobby opens at once, the code arrives a moment later. */
  hostGame(settings: LobbySettings, charId: string, ids: { stages: string[]; characters: string[] }): void {
    this.createInBrowser(settings, charId, ids);
    if (this.link === null) return;
    const room = new RoomHost(this.signal, this.host, () => ({
      members: this.lobby?.members.length ?? 1,
      inMatch: this.lobby?.inMatch ?? false,
    }), () => this.changed());
    this.room = room;
    room.start();
  }

  /** Host: try again for a code after the helper could not be reached. */
  retryRoom(): void {
    if (this.room === null || this.room.state !== 'error') return;
    this.room.start();
  }

  private closeRoom(): void {
    const room = this.room;
    this.room = null;
    room?.close();
  }

  /** Guest with a short code: register, wait for the host's offer, answer, connect. */
  joinRoom(text: string, charId: string): void {
    this.cancelGuest();
    this.message = '';
    const code = normalizeCode(text);
    if (!isRoomCode(code)) {
      this.guest = { state: 'failed', code: '', message: 'A game code is 4 letters or digits' };
      this.changed();
      return;
    }
    const run = ++this.guestRun;
    const live = (): boolean => this.guestRun === run;
    const api = this.signal;
    this.guest = { state: 'waiting', code: '', message: '' };
    this.changed();
    const fail = (message: string, network = false): void => {
      if (!live()) return;
      this.guestFailed(message, network);
    };
    const signalFail = (err: unknown, what: string): void => {
      const e = err instanceof SignalError ? err : new SignalError(0, String(err));
      if (e.status === 404) fail(what);
      else if (e.status === 0) fail('Could not reach the online helper. Check the internet connection');
      else fail(`The online helper refused that (${e.message})`);
    };
    void (async () => {
      let guest = '';
      try {
        guest = await api.join(code);
      } catch (err) {
        signalFail(err, 'No game with that code. Check it with the host');
        return;
      }
      const started = performance.now();
      let registered = started;
      let offer: string | null = null;
      while (live() && offer === null) {
        await new Promise((r) => setTimeout(r, GUEST_POLL_MS));
        if (!live()) return;
        try {
          const r = await api.guestPoll(code, guest);
          if (r.error === 'full') return fail('That game is full');
          if (r.error === 'started') return fail('That game has started. Try again when it ends');
          if (r.error !== undefined && r.error !== '') return fail('The host could not make a connection for you', true);
          offer = r.offer;
        } catch (err) {
          if (err instanceof SignalError && err.status === 404 && err.message === 'no such guest') {
            // This registration lost a race with another join on the room's guest list: register
            // again with the same id rather than failing.
            registered = performance.now();
            await api.join(code, guest).catch(() => {});
            continue;
          }
          if (err instanceof SignalError && err.status === 404) return fail('The host closed that game');
          // A missed poll: the next one tries again.
        }
        const now = performance.now();
        if (offer === null && now - started > ROOM_STEP_MS) {
          return fail('The host did not answer. Check the code, and that the host is still in the lobby');
        }
        if (offer === null && now - registered > REJOIN_MS) {
          registered = now;
          await api.join(code, guest).catch(() => {});
        }
      }
      if (!live() || offer === null) return;
      this.answerOffer(offer, charId, run, (answer) => api.putAnswer(code, guest, answer));
    })();
  }

  /** Short codes: answer the host's offer and connect (fails after ROOM_STEP_MS). */
  private answerOffer(text: string, charId: string, run: number, send: (answer: string) => Promise<void>): void {
    const live = (): boolean => this.guestRun === run;
    let offerSdp = '';
    let invite = 0;
    try {
      const code = expandCode(text);
      if (code.kind !== 'offer') throw new CodeError('The host sent something that is not an offer');
      if (code.versionHash !== versionHash(BUILD_VERSION)) {
        this.guestFailed('Different version: the host runs another build of the game. Reload both pages');
        return;
      }
      offerSdp = code.sdp;
      invite = code.invite;
    } catch (err) {
      this.guestFailed(err instanceof CodeError ? err.message : 'The host sent an offer this page cannot read');
      return;
    }
    let link: RtcLink;
    try {
      link = new RtcLink();
    } catch (err) {
      this.guestFailed(`This browser cannot open a WebRTC connection: ${(err as Error).message}`);
      return;
    }
    this.guestLink = link;
    this.guest = { state: 'connecting', code: '', message: '' };
    this.changed();
    const netFail = (message: string): void => {
      if (!live() || this.guestLink !== link) return;
      this.guestFailed(message, true);
    };
    this.guestTimer = window.setTimeout(() => netFail('Could not connect within 10 seconds'), ROOM_STEP_MS);
    link.onOpen = () => {
      if (this.guestLink !== link) return;
      this.clearGuestTimer();
      this.guestLink = null;
      this.guest = { state: 'connected', code: '', message: '' };
      this.joinChar = charId;
      this.attachLink(link, null);
    };
    link.onClose = () => netFail('The connection closed before it opened');
    void (async () => {
      try {
        await link.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        await link.pc.setLocalDescription(await link.pc.createAnswer());
        const answer = await link.localCode('answer', invite, BUILD_VERSION);
        if (this.guestLink !== link) return;
        await send(answer);
      } catch (err) {
        if (this.guestLink !== link) return;
        if (err instanceof SignalError) netFail(err.status === 404 ? 'The host closed that game' : 'Could not reach the online helper');
        else netFail(`Could not answer the host: ${(err as Error).message}`);
      }
    })();
  }

  /** Guest: read the host's long join code and make the answer code for it. */
  joinWithCode(text: string, charId: string): void {
    this.cancelGuest();
    this.message = '';
    let offerSdp = '';
    let invite = 0;
    try {
      const code = expandCode(text);
      if (code.kind !== 'offer') return this.guestFailed('That is an answer code. Enter the join code the host shows');
      if (code.versionHash !== versionHash(BUILD_VERSION)) {
        return this.guestFailed('Different version: the host runs another build of the game. Reload both pages');
      }
      offerSdp = code.sdp;
      invite = code.invite;
    } catch (err) {
      return this.guestFailed(err instanceof CodeError ? err.message : 'That is not a join code');
    }
    let link: RtcLink;
    try {
      link = new RtcLink();
    } catch (err) {
      return this.guestFailed(`This browser cannot open a WebRTC connection: ${(err as Error).message}`);
    }
    this.guestLink = link;
    this.guest = { state: 'answering', code: '', message: '' };
    this.changed();
    link.onOpen = () => {
      if (this.guestLink !== link) return;
      this.clearGuestTimer();
      this.guestLink = null;
      this.guest = { state: 'idle', code: '', message: '' };
      this.joinChar = charId;
      this.attachLink(link, null);
    };
    link.onClose = () => {
      if (this.guestLink === link) this.guestFailed('The connection closed before it opened.');
    };
    void (async () => {
      try {
        await link.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        await link.pc.setLocalDescription(await link.pc.createAnswer());
        const answer = await link.localCode('answer', invite, BUILD_VERSION);
        if (this.guestLink !== link) return;
        this.guest = { state: 'answer', code: answer, message: '' };
        this.guestTimer = window.setTimeout(() => {
          if (this.guestLink === link) this.guestFailed('The host did not connect within 2 minutes.');
        }, GUEST_WAIT_MS);
        this.changed();
      } catch (err) {
        if (this.guestLink !== link) return;
        this.guestFailed(err instanceof CodeError ? err.message : `Could not answer that code: ${(err as Error).message}`);
      }
    })();
  }

  /** Guest: give up on the pending join. */
  cancelGuest(): void {
    this.guestRun++;
    this.dropGuestLink();
    if (this.guest.state !== 'idle') {
      this.guest = { state: 'idle', code: '', message: '' };
      this.changed();
    }
  }

  private guestFailed(message: string, network = false): void {
    this.guestRun++;
    this.dropGuestLink();
    this.guest = { state: 'failed', code: '', message, network };
    this.changed();
  }

  private dropGuestLink(): void {
    if (this.guestTimer !== 0) window.clearTimeout(this.guestTimer);
    this.guestTimer = 0;
    const link = this.guestLink;
    this.guestLink = null;
    if (link === null) return;
    link.onOpen = null;
    link.onClose = null;
    link.close();
  }

  private clearGuestTimer(): void {
    if (this.guestTimer !== 0) window.clearTimeout(this.guestTimer);
    this.guestTimer = 0;
  }

  /** Talk to a lobby over a browser link: hello, then `first` (a guest joins once it has the list). */
  private attachLink(link: BrowserLink, first: ClientMsg | null): void {
    this.closeLobbySocket();
    this.link = link;
    this.version = BUILD_VERSION;
    this.lobbyAddress = '';
    this.lobbyStatus = 'joining';
    this.message = '';
    this.lastRx = performance.now();
    link.onText = (text) => {
      if (this.link !== link) return;
      this.lastRx = performance.now();
      const msg = parse(text);
      if (msg === null) return;
      if (msg.t === 'lobbies' && this.lobbyStatus === 'joining' && this.joinChar !== '') {
        // The host tab holds exactly one lobby: join it.
        const charId = this.joinChar;
        this.joinChar = '';
        const target = msg.lobbies[0];
        if (target === undefined) {
          this.message = 'That lobby has closed';
          this.lobbyStatus = 'none';
          this.closeLobbySocket();
          this.changed();
          return;
        }
        this.sendLink(link, { t: 'join', lobbyId: target.lobbyId, charId });
        return;
      }
      if (msg.t === 'welcome' || msg.t === 'lobbies') return;
      this.receive(msg);
    };
    link.onClose = () => {
      if (this.link === link) this.linkLost();
    };
    this.sendLink(link, { t: 'hello', name: this.name, version: BUILD_VERSION });
    if (first !== null) this.sendLink(link, first);
    // Pings measure the round trip and keep the host's liveness count at zero; silence from the
    // host for MAX_MISSED seconds drops the link. A Worker timer keeps this going in a hidden tab.
    const tick = (): void => {
      if (this.link !== link) return;
      if (performance.now() - this.lastRx > MAX_MISSED * 1000 + 500) {
        link.close();
        this.linkLost();
        return;
      }
      this.sendLink(link, { t: 'ping', ts: performance.now(), rtt: this.rtt });
    };
    this.linkTimer = startWorkerInterval(tick, 1000);
    tick();
    this.changed();
  }

  private sendLink(link: BrowserLink, msg: ClientMsg): void {
    link.sendText(JSON.stringify(msg));
  }

  /** The browser link went down: no resume in this mode, so the lobby (or match) is over. */
  private linkLost(): void {
    this.link = null;
    this.closeRoom();
    if (this.guest.state === 'connected') this.guest = { state: 'idle', code: '', message: '' };
    this.linkTimer?.stop();
    this.linkTimer = null;
    const hadLobby = this.lobby !== null;
    this.lobby = null;
    this.lobbyStatus = 'none';
    this.token = '';
    if (this.matchActive) {
      this.message = 'Lost the connection to the host';
      this.onLinkLost?.(this.message);
    } else if (this.message === '') {
      this.message = hadLobby ? `Lost the connection to the host. ${NETWORK_HINT}` : 'Could not reach the host';
    }
    this.changed();
  }

  me(): LobbyMember | null {
    if (this.lobby === null) return null;
    return this.lobby.members.find((m) => m.id === this.memberId) ?? null;
  }

  isHost(): boolean {
    return this.lobby !== null && this.lobby.hostId === this.memberId;
  }

  setMember(patch: { charId?: string; team?: number; variant?: number; ready?: boolean; name?: string }): void { this.send({ t: 'member', ...patch }); }
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
