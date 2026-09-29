/**
 * Discovery test (node): two agents on this machine, as two `npm run lan` processes on ports
 * 5180 and 5181 would be, announce one lobby each. Each must see the other's lobby within 2 s,
 * and must drop it within 5 s of the other stopping. Run for multicast + broadcast together,
 * then each path alone, so a network that blocks one path is visible in the report.
 *
 *   npx --yes tsx src/net/discoverytest.ts
 */
import dgram from 'node:dgram';
import { Discovery, parseAnnounce } from '../../server/discovery';
import { PROTOCOL_VERSION, type Announce } from './protocol';

function agent(id: string, port: number, lobbyName: string, paths: { multicast: boolean; broadcast: boolean }): Discovery {
  const build = (): Announce => ({
    k: 'aevalrena-lan', p: PROTOCOL_VERSION, agentId: id, hostName: `host-${id}`, ips: [], port, version: 'test',
    lobbies: [{ lobbyId: 1, name: lobbyName, hostName: `host-${id}`, stageId: 'tidegate', players: 1, state: 'open' }],
  });
  return new Discovery({ agentId: id, build, ...paths, log: (l) => process.stdout.write(`  ${l}\n`) });
}

async function waitFor(pred: () => boolean, ms: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
  }
  return -1;
}

interface Result { paths: string; seenAB: number; seenBA: number; addressAB: string; expire: number; pass: boolean }

async function run(paths: { multicast: boolean; broadcast: boolean }): Promise<Result> {
  const suffix = Math.random().toString(16).slice(2, 8);
  const a = agent(`A-${suffix}`, 5180, 'Lobby A', paths);
  const b = agent(`B-${suffix}`, 5181, 'Lobby B', paths);
  await a.start();
  await b.start();
  const seesB = (): boolean => a.list().some((x) => x.announce.agentId === `B-${suffix}` && x.announce.lobbies[0]?.name === 'Lobby B');
  const seesA = (): boolean => b.list().some((x) => x.announce.agentId === `A-${suffix}` && x.announce.lobbies[0]?.name === 'Lobby A');
  const [seenAB, seenBA] = await Promise.all([waitFor(seesB, 2000), waitFor(seesA, 2000)]);
  const addressAB = a.list().find((x) => x.announce.agentId === `B-${suffix}`)?.address ?? '';
  b.stop();
  const expire = seenAB >= 0 ? await waitFor(() => !seesB(), 5000) : -1;
  a.stop();
  const label = [paths.multicast ? 'multicast' : '', paths.broadcast ? 'broadcast' : ''].filter((x) => x !== '').join(' + ');
  return { paths: label, seenAB, seenBA, addressAB, expire, pass: seenAB >= 0 && seenBA >= 0 && expire >= 0 };
}

/**
 * R9: malformed announces must be dropped without throwing. First the validator on its own,
 * then live datagrams at an agent listening on a private port: every bad one is counted and
 * ignored, the agent keeps running, and a good one still gets listed.
 */
async function hostileDatagrams(): Promise<{ pass: boolean; detail: string }> {
  const good: Announce = {
    k: 'aevalrena-lan', p: PROTOCOL_VERSION, agentId: 'good', hostName: 'h', ips: ['192.168.1.5'], port: 5180, version: 'v',
    lobbies: [{ lobbyId: 1, name: 'L', hostName: 'H', stageId: 'tidegate', players: 1, state: 'open' }],
  };
  const bad: string[] = [
    'null', '[]', '42', 'not json', '{}',
    JSON.stringify({ ...good, ips: [1, 2] }),
    JSON.stringify({ ...good, ips: [{}] }),
    JSON.stringify({ ...good, ips: ['999.1.1.1'] }),
    JSON.stringify({ ...good, ips: new Array(100).fill('10.0.0.1') }),
    JSON.stringify({ ...good, port: 70000 }),
    JSON.stringify({ ...good, port: '5180' }),
    JSON.stringify({ ...good, agentId: 5 }),
    JSON.stringify({ ...good, agentId: 'x'.repeat(500) }),
    JSON.stringify({ ...good, lobbies: [null] }),
    JSON.stringify({ ...good, lobbies: [{ ...good.lobbies[0], players: 99 }] }),
    JSON.stringify({ ...good, lobbies: [{ ...good.lobbies[0], state: 'weird' }] }),
    JSON.stringify({ ...good, lobbies: new Array(500).fill(good.lobbies[0]) }),
    JSON.stringify({ ...good, lobbies: 'x' }),
  ];
  const unitBad = bad.filter((t) => parseAnnounce(t) !== null).length;
  const unitGood = parseAnnounce(JSON.stringify(good)) !== null;

  const PORT = 42999;
  const d = new Discovery({ agentId: 'listener', build: () => ({ ...good, agentId: 'listener', lobbies: [] }), groupPort: PORT, multicast: false, broadcast: false });
  await d.start();
  const sock = dgram.createSocket('udp4');
  const send = (text: string): Promise<void> => new Promise((r) => sock.send(Buffer.from(text), PORT, '127.0.0.1', () => r()));
  for (const t of bad) await send(t);
  await send('x'.repeat(20000).replace(/^x/, '{'));
  await new Promise((r) => setTimeout(r, 300));
  const afterBad = d.list().length;
  const rejected = d.rejected;
  await send(JSON.stringify(good));
  await new Promise((r) => setTimeout(r, 300));
  const afterGood = d.list().map((a) => a.announce.agentId);
  sock.close();
  d.stop();
  const pass = unitBad === 0 && unitGood && afterBad === 0 && rejected >= bad.length && afterGood.includes('good');
  return {
    pass,
    detail: `validator: ${bad.length} bad refused (${unitBad} slipped through), good accepted ${unitGood}; ` +
      `live: ${rejected} datagrams rejected, ${afterBad} listed after the bad ones, then [${afterGood.join(', ')}] after a good one`,
  };
}

async function main(): Promise<void> {
  const hostile = await hostileDatagrams();
  process.stdout.write(`${hostile.pass ? 'PASS' : 'FAIL'} R9 hostile datagrams: ${hostile.detail}\n`);
  const results: Result[] = [];
  for (const paths of [
    { multicast: true, broadcast: true },
    { multicast: true, broadcast: false },
    { multicast: false, broadcast: true },
  ]) {
    const r = await run(paths);
    results.push(r);
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.paths}: A saw B in ${r.seenAB} ms (at ${r.addressAB}), B saw A in ${r.seenBA} ms, ` +
      `B expired from A's list ${r.expire} ms after it stopped\n`);
  }
  // The shipped configuration (both paths) is the gate; the single-path runs are diagnostics.
  const ok = results[0].pass && hostile.pass;
  process.stdout.write(`${JSON.stringify({ pass: ok, results })}\n`);
  process.stdout.write(ok ? 'discoverytest: PASS\n' : 'discoverytest: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
