/**
 * The short-code rendezvous (server/rendezvous/handler.ts, src/net/signal/*): the full host and
 * two-guest exchange in memory (create, join, offer, answer, close), expiry and renewal on a
 * fake clock, the code alphabet and the collision retry, then the same exchange against the
 * Node server on a random port with real fetch through the page's SignalApi.
 *
 *   npx --yes tsx src/net/signaltest.ts
 */
import { createHandler, memoryStore, CODE_TRIES, TTL_S } from '../../server/rendezvous/handler';
import { startRendezvous } from '../../server/rendezvous/node';
import { SignalApi, SignalError } from './signal/api';
import { CODE_ALPHABET, CODE_LENGTH, GUEST_ID_LENGTH, isRoomCode, normalizeCode, randomCode } from './signal/codes';

const results: { name: string; pass: boolean; detail: string }[] = [];

async function check(name: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    results.push({ name, pass: true, detail: await fn() });
  } catch (err) {
    results.push({ name, pass: false, detail: (err as Error).stack ?? String(err) });
  }
}

function expect(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

const BASE = 'http://rv.test';

function client(handle: (req: Request) => Promise<Response>) {
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> => {
    const res = await handle(new Request(`${BASE}/api${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await res.text();
    return { status: res.status, data: text === '' ? {} : JSON.parse(text) as Record<string, unknown> };
  };
}

await check('codes: 4 characters from the unambiguous alphabet', () => {
  expect(CODE_ALPHABET.length === 31, `alphabet has ${CODE_ALPHABET.length}`);
  for (const bad of '0O1IL') expect(!CODE_ALPHABET.includes(bad), `alphabet holds ${bad}`);
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const c = randomCode(CODE_LENGTH);
    expect(isRoomCode(c), `bad code ${c}`);
    for (const ch of c) seen.add(ch);
  }
  expect(seen.size === CODE_ALPHABET.length, `only ${seen.size} letters used`);
  expect(!isRoomCode('ABC') && !isRoomCode('ABCDE') && !isRoomCode('AB0D') && !isRoomCode('abcd'), 'bad codes accepted');
  expect(normalizeCode(' ab-cd ') === 'ABCD', 'normalize');
  return `${CODE_ALPHABET.length} letters, ${CODE_ALPHABET.length ** CODE_LENGTH} codes`;
});

await check('handler: host and two guests exchange offers and answers', async () => {
  const call = client(createHandler({ store: memoryStore() }));
  expect((await call('GET', '/health')).data.ok === true, 'health');
  const created = await call('POST', '/room');
  const code = String(created.data.code);
  expect(created.status === 200 && isRoomCode(code), `create: ${JSON.stringify(created)}`);

  const j1 = await call('POST', `/room/${code}/join`);
  const j2 = await call('POST', `/room/${code}/join`);
  const g1 = String(j1.data.guest);
  const g2 = String(j2.data.guest);
  expect(g1 !== g2 && g1.length === 8, `guest ids ${g1} ${g2}`);
  // A rejoin only leaves the list unchanged while the id is still its last entry (g2 here); see
  // the dedicated race test below for a rejoin that is not last, which must append instead.
  expect((await call('POST', `/room/${code}/join`, { guest: g2 })).data.guest === g2, 'join again keeps the id');

  let poll = await call('GET', `/room/${code}/host?since=0`);
  const guests = poll.data.guests as { id: string; n: number }[];
  expect(guests.length === 2 && guests[0].id === g1 && guests[1].id === g2 && guests[1].n === 1, `host poll: ${JSON.stringify(poll.data)}`);
  expect(((await call('GET', `/room/${code}/host?since=1`)).data.guests as unknown[]).length === 1, 'since skips seen guests');

  expect((await call('GET', `/room/${code}/guest/${g1}`)).data.offer === null, 'offer before the host put it');
  await call('PUT', `/room/${code}/offer/${g1}`, { code: 'offer-one' });
  await call('PUT', `/room/${code}/offer/${g2}`, { code: 'offer-two' });
  expect((await call('GET', `/room/${code}/guest/${g1}`)).data.offer === 'offer-one', 'guest 1 offer');
  expect((await call('GET', `/room/${code}/guest/${g2}`)).data.offer === 'offer-two', 'guest 2 offer');
  await call('PUT', `/room/${code}/answer/${g2}`, { code: 'answer-two' });
  poll = await call('GET', `/room/${code}/host?since=0`);
  let answers = poll.data.answers as Record<string, string>;
  expect(answers[g2] === 'answer-two' && answers[g1] === undefined, `answers: ${JSON.stringify(answers)}`);
  await call('PUT', `/room/${code}/answer/${g1}`, { code: 'answer-one' });
  answers = (await call('GET', `/room/${code}/host?since=0`)).data.answers as Record<string, string>;
  expect(answers[g1] === 'answer-one' && answers[g2] === 'answer-two', 'both answers');

  const j3 = String((await call('POST', `/room/${code}/join`)).data.guest);
  await call('PUT', `/room/${code}/offer/${j3}`, { error: 'full' });
  expect((await call('GET', `/room/${code}/guest/${j3}`)).data.error === 'full', 'full refusal reaches the guest');

  expect((await call('POST', '/room/ZZZZ/join')).status === 404, 'unknown room');
  expect((await call('GET', `/room/${code}/guest/AAAAAAAA`)).status === 404, 'unknown guest');
  expect((await call('PUT', `/room/${code}/answer/${g1}`, { nope: 1 })).status === 400, 'answer without code');
  expect((await call('POST', `/room/${code}/join`, undefined)).status === 200, 'empty body');
  const bad = await createHandler({ store: memoryStore() })(new Request(`${BASE}/api/room`, { method: 'POST', body: '{nope' }));
  expect(bad.status === 400, `bad json ${bad.status}`);

  expect((await call('DELETE', `/room/${code}`)).status === 204, 'delete');
  expect((await call('GET', `/room/${code}/guest/${g1}`)).status === 404, 'guest sees the room closed');
  expect((await call('GET', `/room/${code}/host?since=0`)).status === 404, 'host poll after close');
  return `room ${code}, guests ${g1} ${g2}`;
});

await check('handler: a join race that drops a guest is repaired by rejoin', async () => {
  const store = memoryStore();
  const call = client(createHandler({ store }));
  const code = String((await call('POST', '/room')).data.code);
  const roomKey = `room:${code}`;
  // The room the moment before A joins: B's join below races off this same snapshot.
  const stale = String(await store.get(roomKey));

  const a = String((await call('POST', `/room/${code}/join`)).data.guest);
  const hostSeesA = await call('GET', `/room/${code}/host?since=0`);
  const seenA = hostSeesA.data.guests as { id: string; n: number }[];
  expect(seenA.length === 1 && seenA[0].id === a && seenA[0].n === 0, `host sees A at n=0: ${JSON.stringify(seenA)}`);

  // B's own join computed its new guest list off the pre-A snapshot and its write landed last,
  // so it overwrites the room: B ends up alone, at A's old index 0, and A is gone entirely. The
  // host already advanced its cursor past index 0 (it polled since=1 next), so B sits somewhere
  // it will never poll again.
  const b = randomCode(GUEST_ID_LENGTH);
  const staleRoom = JSON.parse(stale) as { guests: string[] };
  staleRoom.guests.push(b);
  await store.put(roomKey, JSON.stringify(staleRoom), TTL_S);

  expect((await call('GET', `/room/${code}/guest/${a}`)).status === 404, 'A dropped by the race');
  expect((await call('POST', `/room/${code}/join`, { guest: a })).data.guest === a, 'A rejoins');
  let poll = await call('GET', `/room/${code}/host?since=1`);
  let guests = poll.data.guests as { id: string; n: number }[];
  expect(guests.length === 1 && guests[0].id === a && guests[0].n === 1, `host sees A again: ${JSON.stringify(guests)}`);

  // B is still stranded at index 0, which the host's cursor already consumed (it now polls
  // since=2). B is present but no longer the list's last entry (A trails it after the rejoin
  // above), so B's own periodic rejoin (src/net/client.ts REJOIN_MS) must append it again too.
  expect((await call('POST', `/room/${code}/join`, { guest: b })).data.guest === b, 'B rejoins');
  poll = await call('GET', `/room/${code}/host?since=2`);
  guests = poll.data.guests as { id: string; n: number }[];
  expect(guests.length === 1 && guests[0].id === b && guests[0].n === 2, `host sees B too: ${JSON.stringify(guests)}`);

  // Once each id is the list's last entry again, its own rejoin is a true no-op (no more growth).
  const beforeLen = (JSON.parse(String(await store.get(roomKey))) as { guests: string[] }).guests.length;
  await call('POST', `/room/${code}/join`, { guest: b });
  const afterLen = (JSON.parse(String(await store.get(roomKey))) as { guests: string[] }).guests.length;
  expect(beforeLen === afterLen, `rejoin of the last entry does not grow the list: ${beforeLen} -> ${afterLen}`);

  return `room ${code}, A and B both recovered from the race`;
});

await check('handler: a code clash is retried, and all clashes give 503', async () => {
  const store = memoryStore();
  let seq: number[] = [];
  const random = (): number => (seq.length > 0 ? seq.shift()! : 0.5);
  const call = client(createHandler({ store, random }));
  seq = [0, 0, 0, 0];
  const first = String((await call('POST', '/room')).data.code);
  expect(first === 'AAAA', `first ${first}`);
  seq = [0, 0, 0, 0, 0, 0, 0, 0.99];
  const second = String((await call('POST', '/room')).data.code);
  expect(second === `AAA${CODE_ALPHABET[30]}`, `second ${second}`);
  seq = Array.from({ length: CODE_TRIES * 4 }, () => 0);
  const third = await call('POST', '/room');
  expect(third.status === 503, `all clash: ${third.status}`);
  return `${first}, clash retried to ${second}, ${CODE_TRIES} clashes -> 503`;
});

await check('handler: entries expire after 10 minutes; a renew keeps the room', async () => {
  let now = 1_000_000;
  const store = memoryStore(() => now);
  const call = client(createHandler({ store }));
  const code = String((await call('POST', '/room')).data.code);
  const g = String((await call('POST', `/room/${code}/join`)).data.guest);
  await call('PUT', `/room/${code}/offer/${g}`, { code: 'o' });
  now += (TTL_S - 1) * 1000;
  expect((await call('GET', `/room/${code}/guest/${g}`)).data.offer === 'o', 'alive before the TTL');
  now += 2000;
  expect((await call('GET', `/room/${code}/host?since=0`)).status === 404, 'room gone after the TTL');
  expect(store.size() === 0, `store keeps ${store.size()} entries`);

  const code2 = String((await call('POST', '/room')).data.code);
  now += 400_000;
  expect(String((await call('POST', '/room', { code: code2 })).data.code) === code2, 'renew returns the code');
  now += 400_000;
  expect((await call('GET', `/room/${code2}/host?since=0`)).status === 200, 'renewed room outlives the first TTL');
  now += TTL_S * 1000;
  expect((await call('POST', '/room', { code: code2 })).data.code === code2, 'expired code taken back by its host');
  expect((await call('POST', `/room/${code2}/join`)).status === 200, 'join after taking it back');
  return `TTL ${TTL_S} s`;
});

await check('node server: the exchange over real HTTP with the page\'s SignalApi', async () => {
  const server = await startRendezvous(0, '127.0.0.1');
  try {
    const api = new SignalApi(`http://127.0.0.1:${server.port}`);
    expect(await api.health(), 'health');
    const code = await api.createRoom();
    const g1 = await api.join(code);
    const g2 = await api.join(code);
    const poll = await api.hostPoll(code, 0);
    expect(poll.guests.map((g) => g.id).join() === `${g1},${g2}`, `guests ${JSON.stringify(poll)}`);
    await api.putOffer(code, g1, { code: 'offer-1' });
    await api.putOffer(code, g2, { code: 'offer-2' });
    expect((await api.guestPoll(code, g1)).offer === 'offer-1', 'offer 1');
    expect((await api.guestPoll(code, g2)).offer === 'offer-2', 'offer 2');
    await api.putAnswer(code, g1, 'answer-1');
    await api.putAnswer(code, g2, 'answer-2');
    const answers = (await api.hostPoll(code, 0)).answers;
    expect(answers[g1] === 'answer-1' && answers[g2] === 'answer-2', 'answers');
    let status = -1;
    try {
      await api.join('ZZZZ');
    } catch (err) {
      status = err instanceof SignalError ? err.status : -2;
    }
    expect(status === 404, `unknown room status ${status}`);
    const pre = await fetch(`http://127.0.0.1:${server.port}/api/room/${code}/answer/${g1}`, { method: 'OPTIONS' });
    expect(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', 'CORS preflight');
    expect((await fetch(`http://127.0.0.1:${server.port}/api/room/${code}`, { method: 'DELETE' })).status === 204, 'close');
    try {
      await api.guestPoll(code, g1);
      status = 200;
    } catch (err) {
      status = err instanceof SignalError ? err.status : -2;
    }
    expect(status === 404, `after close ${status}`);
    expect(!(await new SignalApi('http://127.0.0.1:9').health(800)), 'a dead helper reads as missing');
    return `port ${server.port}, room ${code}`;
  } finally {
    await server.close();
  }
});

let ok = true;
for (const r of results) {
  ok = ok && r.pass;
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`);
}
console.log(ok ? 'signaltest: PASS' : 'signaltest: FAIL');
if (!ok) process.exitCode = 1;
