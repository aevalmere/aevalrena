/**
 * The rendezvous (./handler.ts) as a plain Node HTTP server with memory storage, for local
 * testing: `npm run rendezvous` (port 8788, or --port N, or RENDEZVOUS_PORT). It listens on
 * every interface so a second machine on the Wi-Fi can reach it next to `npm run dev`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createHandler, memoryStore } from './handler';

export const DEFAULT_PORT = 8788;

export interface RendezvousServer {
  port: number;
  close(): Promise<void>;
}

/** Start the server. Port 0 picks a free one (the tests do). */
export function startRendezvous(port = DEFAULT_PORT, host = '0.0.0.0'): Promise<RendezvousServer> {
  const handle = createHandler({ store: memoryStore() });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const method = req.method ?? 'GET';
      const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
      const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks);
      void handle(new Request(url, { method, body })).then(async (r) => {
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => { headers[k] = v; });
        res.writeHead(r.status, headers);
        res.end(Buffer.from(await r.arrayBuffer()));
      }, () => {
        res.writeHead(500);
        res.end();
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf('--port');
  const port = Number(flag >= 0 ? process.argv[flag + 1] : process.env.RENDEZVOUS_PORT ?? DEFAULT_PORT);
  startRendezvous(port).then((s) => {
    console.log(`Rendezvous on http://localhost:${s.port}/api (memory storage, entries expire after 10 minutes)`);
  }, (err: Error) => {
    console.error(`Could not start the rendezvous: ${err.message}`);
    process.exitCode = 1;
  });
}
