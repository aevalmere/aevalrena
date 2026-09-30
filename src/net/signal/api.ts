/**
 * The page's side of the rendezvous (server/rendezvous/handler.ts): typed fetch calls.
 *
 * Where it lives comes from the build (vite.config.ts, VITE_RENDEZVOUS_URL): empty means this
 * page's own origin (Cloudflare Pages, where functions/api serves it); `:8788` means port 8788
 * on this page's host (the dev server next to `npm run rendezvous`); anything else is a full URL.
 */

declare const __AEV_RENDEZVOUS_URL__: string;

const CONFIGURED = typeof __AEV_RENDEZVOUS_URL__ === 'string' ? __AEV_RENDEZVOUS_URL__ : '';
/** A request that takes longer than this counts as failed (the next poll tries again). */
const REQUEST_MS = 5000;

export function rendezvousBase(configured = CONFIGURED): string {
  const c = configured.trim().replace(/\/+$/, '');
  if (c.startsWith(':')) return `${location.protocol}//${location.hostname}${c}`;
  if (c !== '') return c;
  return typeof location !== 'undefined' ? location.origin : '';
}

export class SignalError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface HostPoll {
  guests: { id: string; n: number }[];
  answers: Record<string, string>;
  count: number;
}

export interface GuestPoll {
  offer: string | null;
  error?: string;
}

export class SignalApi {
  constructor(readonly base: string = rendezvousBase()) {}

  private async call<T>(method: string, path: string, body?: unknown, ms = REQUEST_MS): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(`${this.base}/api${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        signal: ctl.signal,
        cache: 'no-store',
      });
      const text = await res.text();
      const data = (text === '' ? {} : JSON.parse(text)) as T & { error?: string };
      if (!res.ok) throw new SignalError(res.status, data.error ?? `HTTP ${res.status}`);
      return data;
    } catch (err) {
      if (err instanceof SignalError) throw err;
      throw new SignalError(0, (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  /** True when the rendezvous answers. */
  async health(ms = 2500): Promise<boolean> {
    try {
      const r = await this.call<{ ok?: boolean }>('GET', '/health', undefined, ms);
      return r.ok === true;
    } catch {
      return false;
    }
  }

  /** A new room, or (with `code`) renew that room. */
  async createRoom(code?: string): Promise<string> {
    return (await this.call<{ code: string }>('POST', '/room', code === undefined ? {} : { code })).code;
  }

  async join(code: string, guest?: string): Promise<string> {
    return (await this.call<{ guest: string }>('POST', `/room/${code}/join`, guest === undefined ? {} : { guest })).guest;
  }

  hostPoll(code: string, since: number): Promise<HostPoll> {
    return this.call<HostPoll>('GET', `/room/${code}/host?since=${since}`);
  }

  async putOffer(code: string, guest: string, value: { code: string } | { error: string }): Promise<void> {
    await this.call('PUT', `/room/${code}/offer/${guest}`, value);
  }

  guestPoll(code: string, guest: string): Promise<GuestPoll> {
    return this.call<GuestPoll>('GET', `/room/${code}/guest/${guest}`);
  }

  async putAnswer(code: string, guest: string, answer: string): Promise<void> {
    await this.call('PUT', `/room/${code}/answer/${guest}`, { code: answer });
  }

  /** Close the room. `keepalive` lets it go out while the page unloads. */
  closeRoom(code: string, keepalive = false): void {
    try {
      void fetch(`${this.base}/api/room/${code}`, { method: 'DELETE', keepalive }).catch(() => {});
    } catch {
      // Unloading: the room expires on its own.
    }
  }
}
