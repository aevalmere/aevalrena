/**
 * Discovery test (node): two agents on this machine, as two `npm run lan` processes on ports
 * 5180 and 5181 would be, announce one lobby each. Each must see the other's lobby within 2 s,
 * and must drop it within 5 s of the other stopping. Run for multicast + broadcast together,
 * then each path alone, so a network that blocks one path is visible in the report.
 *
 *   npx --yes tsx src/net/discoverytest.ts
 */
import { Discovery } from '../../server/discovery';
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

async function main(): Promise<void> {
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
  const ok = results[0].pass;
  process.stdout.write(`${JSON.stringify({ pass: ok, results })}\n`);
  process.stdout.write(ok ? 'discoverytest: PASS\n' : 'discoverytest: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
