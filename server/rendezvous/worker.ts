/**
 * The rendezvous (./handler.ts) as a standalone Cloudflare Worker, for a site hosted somewhere
 * without Functions (GitHub Pages). Deploy with ./wrangler.worker.toml and build the site with
 * VITE_RENDEZVOUS_URL set to the Worker's URL. docs/LAN.md section 11.9.
 */
import { createHandler } from './handler';
import { kvStore, type KvNamespace } from './kv';

export default {
  fetch(request: Request, env: { LOBBY?: KvNamespace }): Promise<Response> {
    if (env.LOBBY === undefined) return Promise.resolve(new Response('{"error":"LOBBY KV binding missing"}', { status: 503, headers: { 'Access-Control-Allow-Origin': '*' } }));
    return createHandler({ store: kvStore(env.LOBBY) })(request);
  },
};
