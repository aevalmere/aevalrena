/**
 * Aevalrena LAN agent (docs/LAN.md). Every player runs one on their own machine:
 *
 *   npm run lan                 # port 5180
 *   npm run lan -- --port 5181  # another port (a second agent on the same machine)
 *
 * It builds the game once at start and serves it to the browser, hosts lobbies and
 * relays match inputs on ws://<ip>:<port>/lan, and announces its lobbies over UDP multicast and
 * subnet broadcast while listening for other agents, so every browser on the Wi-Fi sees every
 * lobby. `--no-discovery` turns the UDP part off; `--quiet` hides per-lobby logs.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LAN_PATH, LAN_PORT, PROTOCOL_VERSION, type Announce, type LobbyListing } from '../src/net/protocol';
import { Discovery, DISCOVERY_GROUP, DISCOVERY_PORT, lanInterfaces } from './discovery';
import { CHARACTER_DEFS } from '../src/characters/registry';
import { STAGE_DEFS } from '../src/stages/registry';
import { LobbyHost, MAX_PAYLOAD } from './lobbyhost';
import { gameVersion } from './version';
import { serveStatic } from './static';

const FALLBACK_STAGE = 'tidegate';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv: string[]): { port: number; discovery: boolean; quiet: boolean } {
  let port = Number(process.env.LAN_PORT ?? LAN_PORT);
  let discovery = true;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') port = Number(argv[++i]);
    else if (a.startsWith('--port=')) port = Number(a.slice(7));
    else if (a === '--no-discovery') discovery = false;
    else if (a === '--quiet') quiet = true;
    else if (/^\d+$/.test(a)) port = Number(a);
  }
  if (!(port > 0 && port < 65536)) port = LAN_PORT;
  return { port, discovery, quiet };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const version = gameVersion(repoRoot);
  const agentId = crypto.randomBytes(6).toString('hex');
  const hostName = os.hostname().slice(0, 24);
  const log = (line: string): void => { if (!args.quiet) console.log(line); };

  let discovery: Discovery | null = null;
  const remoteListings = (): LobbyListing[] => {
    if (discovery === null) return [];
    const out: LobbyListing[] = [];
    for (const a of discovery.list()) {
      for (const l of a.announce.lobbies) out.push({ ...l, agentId: a.announce.agentId, address: a.address, version: a.announce.version });
    }
    return out;
  };
  const host = new LobbyHost({
    agentId, hostName, version, fallbackStage: FALLBACK_STAGE, remoteListings, log,
    stages: Object.keys(STAGE_DEFS), characters: Object.keys(CHARACTER_DEFS),
  });

  // A production build of the current sources, per port so two agents on one machine never race.
  const outDir = path.join(repoRoot, 'node_modules', '.cache', `aevalrena-lan-${args.port}`);
  console.log('Building the game for LAN play...');
  const { build } = await import('vite');
  await build({ root: repoRoot, logLevel: 'error', build: { outDir, emptyOutDir: true } });
  const httpServer = http.createServer((req, res) => {
    try {
      serveStatic(outDir, req, res);
    } catch (err) {
      log(`[lan] http error on ${String(req.url).slice(0, 80)}: ${(err as Error).message}`);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  });

  // maxPayload: a bigger message closes that socket (1009) instead of buffering it.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
  httpServer.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== LAN_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => host.attach(ws));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(args.port, '0.0.0.0', () => resolve());
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${args.port} is in use. Another agent may already be running; try: npm run lan -- --port ${args.port + 1}`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  const ifaces = lanInterfaces();
  console.log(`Aevalrena LAN agent (version ${version}, protocol ${PROTOCOL_VERSION})`);
  console.log(`  Open http://localhost:${args.port}/ in your browser, then Mode select > LAN.`);
  for (const i of ifaces) console.log(`  Others can join by address: ${i.address}:${args.port}   (${i.name})`);
  if (ifaces.length === 0) console.log('  No LAN interface found: only this machine can play.');

  if (args.discovery) {
    const build = (): Announce => ({
      k: 'aevalrena-lan', p: PROTOCOL_VERSION, agentId, hostName,
      ips: lanInterfaces().map((i) => i.address), port: args.port, version, lobbies: host.announceLobbies(),
    });
    discovery = new Discovery({ agentId, build, log });
    try {
      await discovery.start();
      console.log(`  Discovery on UDP ${DISCOVERY_PORT} (multicast ${DISCOVERY_GROUP} + subnet broadcast). Lobbies on the Wi-Fi appear automatically.`);
    } catch (err) {
      discovery = null;
      console.log(`  Discovery off (${(err as Error).message}). Join by address still works.`);
    }
  }
  console.log('  Windows: if a firewall prompt appears, allow Node.js on Private networks.');

  const shutdown = (): void => {
    discovery?.stop();
    host.dispose();
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Last line of defence: log and keep serving. A crash here would end every lobby on this agent.
process.on('uncaughtException', (err: Error) => {
  console.error(`[lan] uncaught exception, agent keeps running: ${err.stack ?? err.message}`);
});
process.on('unhandledRejection', (reason: unknown) => {
  console.error(`[lan] unhandled rejection, agent keeps running: ${String(reason)}`);
});

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
