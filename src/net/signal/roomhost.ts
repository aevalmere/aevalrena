/**
 * The host tab's side of short-code joining (docs/LAN.md section 11.2). It holds a rendezvous
 * room, polls it for guests, makes one BrowserHost invite per guest, posts that invite's offer
 * code, and hands each answer back to BrowserHost. From there the invite opens like a
 * hand-copied one and the lobby protocol takes over on the reliable channel.
 */
import { startWorkerInterval, type WorkerInterval } from '../bgtick';
import type { BrowserHost } from '../browserhost';
import { LOBBY_MAX } from '../protocol';
import { SignalError, type SignalApi } from './api';

/** Poll cadence while nothing is pending, and while an offer waits for its answer. */
export const HOST_POLL_MS = 700;
export const HOST_FAST_POLL_MS = 300;
/** The room is written again this often so it outlives the 10 minute expiry. */
const RENEW_MS = 4 * 60 * 1000;
/** An offer with no answer after this long is dropped (the guest left or gave up). */
const ANSWER_WAIT_MS = 20000;
/** How long a failed join stays on the host's screen. */
const FAILED_SHOW_MS = 12000;

export type RoomState = 'creating' | 'open' | 'error' | 'closed';

interface Pending {
  n: number;
  invite: number;
  /** When the offer went up; 0 before. */
  offeredAt: number;
  failedAt: number;
  done: boolean;
}

export class RoomHost {
  state: RoomState = 'creating';
  code = '';
  message = '';
  private readonly pending = new Map<string, Pending>();
  private seen = 0;
  private timer: WorkerInterval | null = null;
  private busy = false;
  private lastPoll = 0;
  private lastRenew = 0;
  private readonly unload = (): void => { if (this.code !== '') this.api.closeRoom(this.code, true); };

  constructor(
    private readonly api: SignalApi,
    private readonly host: BrowserHost,
    /** Lobby members (the host included) and whether a match is running. */
    private readonly seats: () => { members: number; inMatch: boolean },
    private readonly changed: () => void,
  ) {}

  start(): void {
    this.state = 'creating';
    this.message = '';
    this.changed();
    void this.api.createRoom().then((code) => {
      if (this.state === 'closed') {
        this.api.closeRoom(code);
        return;
      }
      this.code = code;
      this.state = 'open';
      this.lastRenew = performance.now();
      window.addEventListener('pagehide', this.unload);
      this.timer = startWorkerInterval(() => this.tick(), 100);
      this.changed();
    }, (err: SignalError) => {
      if (this.state === 'closed') return;
      this.state = 'error';
      this.message = err.status === 0 ? 'Could not reach the online helper' : `Could not get a code (${err.message})`;
      this.changed();
    });
  }

  /** Stop polling and remove the room. */
  close(): void {
    const was = this.state;
    this.state = 'closed';
    this.timer?.stop();
    this.timer = null;
    window.removeEventListener('pagehide', this.unload);
    if (was === 'open' && this.code !== '') this.api.closeRoom(this.code);
    for (const [, p] of this.pending) if (!p.done) this.host.cancel(p.invite);
    this.pending.clear();
  }

  /** Joins in progress, for the host's screen. */
  joins(): { connecting: number; failed: number } {
    let connecting = 0;
    let failed = 0;
    for (const inv of this.host.list()) {
      if (inv.tag === '') continue;
      if (inv.state === 'failed') failed++;
      else connecting++;
    }
    return { connecting, failed };
  }

  private waitingForAnswer(): boolean {
    for (const p of this.pending.values()) if (!p.done && p.offeredAt > 0) return true;
    return false;
  }

  private tick(): void {
    if (this.state !== 'open' || this.busy) return;
    const now = performance.now();
    this.sweep(now);
    const { members } = this.seats();
    const open = [...this.pending.values()].filter((p) => !p.done).length;
    // Every slot taken and nothing in flight: no poll until someone leaves.
    if (members >= LOBBY_MAX && open === 0) return;
    const every = this.waitingForAnswer() ? HOST_FAST_POLL_MS : HOST_POLL_MS;
    if (now - this.lastPoll < every) return;
    this.lastPoll = now;
    this.busy = true;
    void this.poll(now).finally(() => { this.busy = false; });
  }

  private async poll(now: number): Promise<void> {
    const code = this.code;
    try {
      if (now - this.lastRenew > RENEW_MS) {
        await this.api.createRoom(code);
        this.lastRenew = now;
      }
      let since = this.seen;
      for (const p of this.pending.values()) if (!p.done) since = Math.min(since, p.n);
      const r = await this.api.hostPoll(code, since);
      if (this.state !== 'open' || this.code !== code) return;
      if (this.message !== '') {
        this.message = '';
        this.changed();
      }
      for (const g of r.guests) {
        this.seen = Math.max(this.seen, g.n + 1);
        if (!this.pending.has(g.id)) this.admit(g.id, g.n);
      }
      for (const [id, answer] of Object.entries(r.answers)) {
        const p = this.pending.get(id);
        if (p === undefined || p.done || p.offeredAt === 0) continue;
        p.done = true;
        const err = this.host.answer(answer);
        if (err !== '') this.host.cancel(p.invite);
      }
    } catch (err) {
      if (this.state !== 'open') return;
      if (err instanceof SignalError && err.status === 404) {
        // The room expired or was removed: put the same code back so guests can still use it.
        await this.api.createRoom(code).catch(() => {});
        this.lastRenew = performance.now();
        return;
      }
      const msg = 'Lost contact with the online helper. Retrying';
      if (this.message !== msg) {
        this.message = msg;
        this.changed();
      }
    }
  }

  /** A new guest: make its invite and post the offer, or tell it why not. */
  private admit(id: string, n: number): void {
    const { members, inMatch } = this.seats();
    const inFlight = this.host.list().filter((i) => i.state !== 'failed').length;
    const p: Pending = { n, invite: 0, offeredAt: 0, failedAt: 0, done: true };
    this.pending.set(id, p);
    if (inMatch || members + inFlight >= LOBBY_MAX) {
      void this.api.putOffer(this.code, id, { error: inMatch ? 'started' : 'full' }).catch(() => {});
      return;
    }
    const invite = this.host.invite(id);
    if (invite === 0) return;
    p.invite = invite;
    p.done = false;
    this.changed();
    const code = this.code;
    void this.host.whenReady(invite).then(async (inv) => {
      if (this.state !== 'open' || this.code !== code || p.done) return;
      if (inv === null || inv.state !== 'code') {
        p.done = true;
        await this.api.putOffer(code, id, { error: 'failed' }).catch(() => {});
        return;
      }
      try {
        await this.api.putOffer(code, id, { code: inv.code });
        p.offeredAt = performance.now();
      } catch {
        p.done = true;
        this.host.cancel(invite);
      }
    });
  }

  /** Drop joins that went nowhere: failed ones after a while, offers never answered. */
  private sweep(now: number): void {
    const invites = this.host.list();
    for (const p of this.pending.values()) {
      if (p.invite === 0) continue;
      const inv = invites.find((i) => i.id === p.invite);
      if (inv === undefined) {
        p.done = true;
        p.invite = 0;
        continue;
      }
      if (inv.state === 'failed') {
        p.done = true;
        if (p.failedAt === 0) p.failedAt = now;
        else if (now - p.failedAt > FAILED_SHOW_MS) {
          this.host.cancel(p.invite);
          p.invite = 0;
        }
      } else if (!p.done && p.offeredAt > 0 && inv.state === 'code' && now - p.offeredAt > ANSWER_WAIT_MS) {
        p.done = true;
        this.host.cancel(p.invite);
        p.invite = 0;
      }
    }
  }
}
