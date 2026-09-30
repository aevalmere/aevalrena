/**
 * The rendezvous for the in-browser LAN mode (docs/LAN.md section 11.2): a host gets a short
 * game code, guests register under it, and the WebRTC offer and answer codes pass through here
 * so nobody copies them by hand. Once the data channels open, nothing goes through it again.
 *
 * Pure: a Request in, a Response out, storage behind `RoomStore`. It runs as a Cloudflare Pages
 * Function (functions/api/[[route]].ts, KV binding LOBBY), a Worker (./worker.ts) and a Node
 * server (./node.ts, `npm run rendezvous`, memory storage).
 *
 * Routes (all JSON, CORS open):
 *   GET    /api/health                    {ok}
 *   POST   /api/room                      {code?}   -> {code}  new room; with a code, renew or recreate that room
 *   POST   /api/room/{code}/join          {guest?}  -> {guest} register a guest (again, with its id)
 *   GET    /api/room/{code}/host?since=n            -> {guests: [{id, n}], answers: {id: code}}
 *   PUT    /api/room/{code}/offer/{guest} {code} or {error}
 *   GET    /api/room/{code}/guest/{guest}           -> {offer, error}
 *   PUT    /api/room/{code}/answer/{guest} {code}
 *   DELETE /api/room/{code}
 *
 * Every entry expires TTL_S after its last write. No auth and no rate limit, on purpose: the
 * codes only let someone join a lobby, and the owner accepts that.
 */
import { CODE_LENGTH, GUEST_ID_LENGTH, isGuestId, isRoomCode, randomCode } from '../../src/net/signal/codes';

export interface RoomStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Entry lifetime: 10 minutes after the last write. */
export const TTL_S = 600;
/** New codes tried before giving up (31^4 = 923521 codes, so a clash is rare). */
export const CODE_TRIES = 8;
/** Guest registrations kept per room (retries make new ones). */
export const MAX_GUESTS = 32;
/** Largest request body taken. A signal code is under 400 characters. */
const MAX_BODY = 4096;
/** Longest signal code stored. */
const MAX_CODE = 2048;

export interface HandlerOptions {
  store: RoomStore;
  /** [0, 1); tests pass a fixed sequence to force a code clash. */
  random?: () => number;
}

interface Room {
  guests: string[];
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function fail(status: number, error: string): Response {
  return json({ error }, status);
}

const roomKey = (code: string): string => `room:${code}`;
const offerKey = (code: string, guest: string): string => `offer:${code}:${guest}`;
const answerKey = (code: string, guest: string): string => `answer:${code}:${guest}`;

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new RangeError('body too large');
  if (text.trim() === '') return {};
  const v: unknown = JSON.parse(text);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('body must be an object');
  return v as Record<string, unknown>;
}

export function createHandler(opts: HandlerOptions): (req: Request) => Promise<Response> {
  const { store } = opts;
  const random = opts.random ?? Math.random;

  async function loadRoom(code: string): Promise<Room | null> {
    const raw = await store.get(roomKey(code));
    if (raw === null) return null;
    try {
      const v = JSON.parse(raw) as Partial<Room>;
      return { guests: Array.isArray(v.guests) ? v.guests.filter((g): g is string => typeof g === 'string') : [] };
    } catch {
      return null;
    }
  }

  const saveRoom = (code: string, room: Room): Promise<void> => store.put(roomKey(code), JSON.stringify(room), TTL_S);

  async function createRoom(body: Record<string, unknown>): Promise<Response> {
    const wanted = typeof body.code === 'string' ? body.code : '';
    if (wanted !== '') {
      if (!isRoomCode(wanted)) return fail(400, 'bad code');
      // Renew (or recreate after expiry) the host's own code, keeping its guest list. A guest
      // can join in the window between this read and the write below, so after writing, read
      // the room back and fold in any guest that landed there rather than lose it.
      const before = (await loadRoom(wanted)) ?? { guests: [] };
      await saveRoom(wanted, before);
      const after = await loadRoom(wanted);
      if (after !== null) {
        const extra = after.guests.filter((g) => !before.guests.includes(g));
        if (extra.length > 0) await saveRoom(wanted, { guests: [...before.guests, ...extra] });
      }
      return json({ code: wanted, ttl: TTL_S });
    }
    for (let i = 0; i < CODE_TRIES; i++) {
      const code = randomCode(CODE_LENGTH, random);
      if ((await store.get(roomKey(code))) !== null) continue;
      await saveRoom(code, { guests: [] });
      return json({ code, ttl: TTL_S });
    }
    return fail(503, 'no free code, try again');
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter((p) => p !== '');
    if (parts[0] !== 'api') return fail(404, 'not found');
    const m = req.method;
    if (m === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (parts.length === 2 && parts[1] === 'health' && m === 'GET') return json({ ok: true });
    if (parts[1] !== 'room') return fail(404, 'not found');
    if (parts.length === 2) {
      if (m !== 'POST') return fail(405, 'method not allowed');
      return createRoom(await readBody(req));
    }
    const code = parts[2];
    if (!isRoomCode(code)) return fail(404, 'no such room');
    if (parts.length === 3) {
      if (m !== 'DELETE') return fail(405, 'method not allowed');
      const room = await loadRoom(code);
      await store.delete(roomKey(code));
      for (const g of room?.guests ?? []) {
        await store.delete(offerKey(code, g));
        await store.delete(answerKey(code, g));
      }
      return new Response(null, { status: 204, headers: CORS });
    }
    const room = await loadRoom(code);
    if (room === null) return fail(404, 'no such room');
    const action = parts[3];

    if (action === 'join' && parts.length === 4 && m === 'POST') {
      const body = await readBody(req);
      const again = typeof body.guest === 'string' && isGuestId(body.guest) ? body.guest : '';
      // A rejoin with an id that is still the list's last entry is already the host's most
      // recent view of it: nothing to do. An id that is elsewhere in the list (or missing
      // entirely) lost a race with another join's read-modify-write on this same list, so it
      // needs a fresh entry past whatever the host has already polled (the host's own poll
      // dedupes by id, so a leftover earlier entry for the same id is harmless).
      if (again !== '' && room.guests[room.guests.length - 1] === again) return json({ guest: again });
      if (room.guests.length >= MAX_GUESTS) return fail(409, 'room full');
      const guest = again !== '' ? again : randomCode(GUEST_ID_LENGTH, random);
      room.guests.push(guest);
      await saveRoom(code, room);
      return json({ guest });
    }

    if (action === 'host' && parts.length === 4 && m === 'GET') {
      const since = Math.max(0, Math.floor(Number(url.searchParams.get('since') ?? '0')) || 0);
      const guests: { id: string; n: number }[] = [];
      const answers: Record<string, string> = {};
      for (let n = since; n < room.guests.length; n++) {
        const id = room.guests[n];
        guests.push({ id, n });
        const answer = await store.get(answerKey(code, id));
        if (answer !== null) answers[id] = answer;
      }
      return json({ guests, answers, count: room.guests.length });
    }

    const guest = parts[4] ?? '';
    if (parts.length !== 5 || !isGuestId(guest)) return fail(404, 'not found');
    if (!room.guests.includes(guest)) return fail(404, 'no such guest');

    if (action === 'offer' && m === 'PUT') {
      const body = await readBody(req);
      const value = typeof body.code === 'string' && body.code.length <= MAX_CODE ? { code: body.code }
        : typeof body.error === 'string' ? { error: body.error.slice(0, 32) } : null;
      if (value === null) return fail(400, 'need code or error');
      await store.put(offerKey(code, guest), JSON.stringify(value), TTL_S);
      return json({ ok: true });
    }
    if (action === 'guest' && m === 'GET') {
      const raw = await store.get(offerKey(code, guest));
      if (raw === null) return json({ offer: null });
      const v = JSON.parse(raw) as { code?: string; error?: string };
      return json({ offer: v.code ?? null, error: v.error ?? '' });
    }
    if (action === 'answer' && m === 'PUT') {
      const body = await readBody(req);
      if (typeof body.code !== 'string' || body.code === '' || body.code.length > MAX_CODE) return fail(400, 'need code');
      await store.put(answerKey(code, guest), body.code, TTL_S);
      return json({ ok: true });
    }
    return fail(405, 'method not allowed');
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof TypeError || err instanceof RangeError) return fail(400, err.message);
      return fail(500, 'server error');
    }
  };
}

/** Storage in this process's memory, for the Node server and the tests. `now` is in ms. */
export function memoryStore(now: () => number = Date.now): RoomStore & { size(): number } {
  const map = new Map<string, { value: string; until: number }>();
  let puts = 0;
  const live = (key: string): { value: string; until: number } | null => {
    const e = map.get(key);
    if (e === undefined) return null;
    if (e.until <= now()) {
      map.delete(key);
      return null;
    }
    return e;
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async put(key, value, ttlSeconds) {
      // Drop expired entries now and then, so a long-running server does not grow.
      if (++puts % 256 === 0) for (const k of [...map.keys()]) live(k);
      map.set(key, { value, until: now() + ttlSeconds * 1000 });
    },
    async delete(key) {
      map.delete(key);
    },
    size() {
      for (const k of [...map.keys()]) live(k);
      return map.size;
    },
  };
}
