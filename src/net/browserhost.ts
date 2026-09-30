/**
 * The lobby host's browser tab in the in-browser LAN mode (docs/LAN.md section 11). It runs the
 * same LobbyCore the Node agent runs: lobby state, ready gating, slot assignment, the checked
 * input relay, the input log and retirements. Guests reach it over one RtcLink each; the host's
 * own LanClient reaches it through an in-page loopback.
 *
 * Invites: each guest needs its own RTCPeerConnection, so the host makes one offer code per
 * guest. The guest's answer code names the invite it answers, so answers can arrive in any
 * order. With the rendezvous (src/net/signal/roomhost.ts) invites are made and answered
 * automatically, tagged with the guest's rendezvous id; without it, the host copies them by hand.
 */
import { startWorkerInterval, type WorkerInterval } from './bgtick';
import { LEFT_CODE, LobbyCore, type LobbyConn, type LobbyPeer } from './lobbycore';
import { LOBBY_MAX } from './protocol';
import { RtcLink, type BrowserLink } from './rtc';
import { CodeError, expandCode, versionHash } from './sdpcode';

/** How long a connection may take to open after the answer is entered. */
export const CONNECT_MS = 10000;
export const NETWORK_HINT = 'Both devices must be on the same Wi-Fi. Guest and public networks often block this.';

export type InviteState = 'preparing' | 'code' | 'connecting' | 'failed';

export interface Invite {
  id: number;
  state: InviteState;
  /** The join code (base64url) once it is ready. */
  code: string;
  message: string;
  /** The rendezvous guest id this invite is for; '' for a hand-copied invite. */
  tag: string;
}

interface InviteSlot extends Invite {
  link: RtcLink;
  timer: ReturnType<typeof setTimeout> | 0;
  /** Settles once the code is made (or making it failed). */
  ready: Promise<void>;
}

export interface BrowserHostOptions {
  hostName: string;
  version: string;
  fallbackStage: string;
  stages: string[];
  characters: string[];
}

/** The host tab's own client end: text goes through a microtask so neither side re-enters. */
class LoopbackLink implements BrowserLink {
  closed = false;
  peer: LobbyPeer | null = null;
  onOpen: (() => void) | null = null;
  onText: ((text: string) => void) | null = null;
  onBinary: ((bytes: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;

  get open(): boolean {
    return !this.closed;
  }

  sendText(text: string): void {
    if (this.closed) return;
    queueMicrotask(() => { if (!this.closed) this.peer?.text(text); });
  }

  sendBinary(bytes: Uint8Array): void {
    if (!this.closed) this.peer?.binary(bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.peer?.closed(LEFT_CODE);
  }

  /** The core end: what LobbyCore sees for the host's own client. */
  conn(): LobbyConn {
    const self = this;
    return {
      get open(): boolean { return !self.closed; },
      sendText: (text) => queueMicrotask(() => { if (!self.closed) self.onText?.(text); }),
      sendBinary: (bytes) => { if (!self.closed) self.onBinary?.(bytes); },
      terminate: () => {
        if (self.closed) return;
        self.closed = true;
        self.peer?.closed(LEFT_CODE);
        self.onClose?.();
      },
      // The loopback cannot go quiet on its own.
      probe: () => self.peer?.alive(),
    };
  }
}

export class BrowserHost {
  core: LobbyCore | null = null;
  private opts: BrowserHostOptions | null = null;
  private ticker: WorkerInterval | null = null;
  private readonly invites: InviteSlot[] = [];
  private readonly guests = new Set<RtcLink>();
  private nextInvite = 1;
  private hadLobby = false;

  constructor(private readonly changed: () => void) {}

  get running(): boolean {
    return this.core !== null;
  }

  /** A lobby of a previous session still has a match running (the host left it mid-match). */
  get busy(): boolean {
    return this.core !== null && this.core.counts().lobbies > 0;
  }

  /** Start a fresh core and return the host's own client link to it. */
  start(opts: BrowserHostOptions): BrowserLink {
    this.stop();
    this.opts = opts;
    const agentId = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    this.core = new LobbyCore({
      agentId, hostName: opts.hostName, version: opts.version, fallbackStage: opts.fallbackStage,
      stages: opts.stages, characters: opts.characters, remoteListings: () => [],
      log: (line) => console.info(line),
    });
    this.hadLobby = false;
    // Liveness and the list push, from a Worker so a hidden host tab keeps its 1 s cadence.
    this.ticker = startWorkerInterval(() => this.tick(), 1000);
    const link = new LoopbackLink();
    link.peer = this.core.attach(link.conn());
    return link;
  }

  private tick(): void {
    const core = this.core;
    if (core === null) return;
    core.tick();
    const lobbies = core.counts().lobbies;
    if (lobbies > 0) this.hadLobby = true;
    else if (this.hadLobby) this.stop();
  }

  /** Close every guest link and the core. */
  stop(): void {
    this.ticker?.stop();
    this.ticker = null;
    for (const inv of this.invites) this.dropInvite(inv);
    this.invites.length = 0;
    for (const g of this.guests) g.closeAfterFlush();
    this.guests.clear();
    this.core?.dispose();
    this.core = null;
    this.changed();
  }

  list(): Invite[] {
    return this.invites.map(({ id, state, code, message, tag }) => ({ id, state, code, message, tag }));
  }

  /** Room for another invite: members plus open invites stay within the lobby size. */
  canInvite(members: number): boolean {
    return this.core !== null && members + this.invites.length < LOBBY_MAX;
  }

  /** Make a new join code. Returns the invite id, or 0 when there is no lobby. */
  invite(tag = ''): number {
    if (this.core === null || this.opts === null) return 0;
    const id = this.nextInvite;
    this.nextInvite = this.nextInvite >= 255 ? 1 : this.nextInvite + 1;
    this.prepare(this.slot(id, tag));
    return id;
  }

  /** The invite once its code is made (state 'code', or 'failed'); null if it is gone. */
  async whenReady(id: number): Promise<Invite | null> {
    const inv = this.invites.find((x) => x.id === id);
    if (inv === undefined) return null;
    await inv.ready;
    return this.list().find((x) => x.id === id) ?? null;
  }

  private slot(id: number, tag: string): InviteSlot {
    return { id, state: 'preparing', code: '', message: '', tag, link: new RtcLink(), timer: 0, ready: Promise.resolve() };
  }

  private prepare(inv: InviteSlot): void {
    const opts = this.opts;
    if (opts === null) return;
    const existing = this.invites.findIndex((x) => x.id === inv.id);
    if (existing >= 0) this.invites[existing] = inv;
    else this.invites.push(inv);
    this.changed();
    inv.ready = (async () => {
      try {
        await inv.link.pc.setLocalDescription(await inv.link.pc.createOffer());
        inv.code = await inv.link.localCode('offer', inv.id, opts.version);
        if (inv.state === 'preparing') inv.state = 'code';
      } catch (err) {
        this.fail(inv, err instanceof CodeError ? err.message : `Could not make a join code: ${(err as Error).message}`);
      }
      this.changed();
    })();
  }

  /** Make a fresh code for an invite that failed (a used offer cannot be reused). */
  retry(id: number): void {
    const inv = this.invites.find((x) => x.id === id);
    if (inv === undefined) return;
    this.dropInvite(inv);
    this.prepare(this.slot(id, inv.tag));
  }

  cancel(id: number): void {
    const i = this.invites.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.dropInvite(this.invites[i]);
    this.invites.splice(i, 1);
    this.changed();
  }

  /** The host entered a guest's answer code. Returns an error message, or '' when it was taken. */
  answer(text: string): string {
    const opts = this.opts;
    if (opts === null) return 'Create a lobby first';
    let code;
    try {
      code = expandCode(text);
    } catch (err) {
      return err instanceof CodeError ? err.message : 'That is not an answer code';
    }
    if (code.kind !== 'answer') return 'That is a join code. Enter the answer code the guest shows';
    if (code.versionHash !== versionHash(opts.version)) return 'Different version: the guest runs another build of the game';
    const inv = this.invites.find((x) => x.id === code.invite);
    if (inv === undefined) return 'That answer belongs to an invite that is gone. Make a new code';
    if (inv.state !== 'code') return inv.state === 'connecting' ? 'That guest is already connecting' : 'Make a new code for that guest';
    inv.state = 'connecting';
    inv.message = '';
    const link = inv.link;
    link.onOpen = () => this.connected(inv);
    link.onClose = () => this.fail(inv, 'The connection closed before it opened.');
    inv.timer = setTimeout(() => this.fail(inv, 'The connection did not open within 10 seconds.'), CONNECT_MS);
    link.pc.setRemoteDescription({ type: 'answer', sdp: code.sdp }).catch((err: unknown) => {
      this.fail(inv, `The answer code was refused: ${(err as Error).message}`);
    });
    this.changed();
    return '';
  }

  private fail(inv: InviteSlot, message: string): void {
    if (!this.invites.includes(inv) || inv.state === 'failed') return;
    if (inv.timer !== 0) clearTimeout(inv.timer);
    inv.timer = 0;
    inv.state = 'failed';
    inv.message = message;
    inv.link.onOpen = null;
    inv.link.onClose = null;
    inv.link.close();
    this.changed();
  }

  private dropInvite(inv: InviteSlot): void {
    if (inv.timer !== 0) clearTimeout(inv.timer);
    inv.timer = 0;
    inv.link.onOpen = null;
    inv.link.onClose = null;
    inv.link.close();
  }

  /** Both channels are open: the guest becomes a LobbyCore connection like any other. */
  private connected(inv: InviteSlot): void {
    const core = this.core;
    const i = this.invites.indexOf(inv);
    if (i < 0 || core === null) return;
    if (inv.timer !== 0) clearTimeout(inv.timer);
    this.invites.splice(i, 1);
    const link = inv.link;
    this.guests.add(link);
    const conn: LobbyConn = {
      get open(): boolean { return link.open; },
      sendText: (text) => link.sendText(text),
      sendBinary: (bytes) => link.sendBinary(bytes),
      terminate: () => {
        link.close();
        this.guests.delete(link);
        peer.closed(LEFT_CODE);
      },
      probe: () => {},
    };
    const peer = core.attach(conn);
    link.onText = (text) => peer.text(text);
    link.onBinary = (bytes) => peer.binary(bytes);
    // A closed tab, a reload or a network failure all count as leaving (no resume in this mode).
    link.onClose = () => {
      this.guests.delete(link);
      peer.closed(LEFT_CODE);
    };
    this.changed();
  }
}
