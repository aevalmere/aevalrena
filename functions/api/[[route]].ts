/**
 * Cloudflare Pages Function for every /api/* path: the LAN rendezvous (server/rendezvous/
 * handler.ts) on the KV namespace bound as LOBBY (wrangler.toml, docs/LAN.md section 11.9).
 * Without the binding, /api/health answers 503 and the game falls back to long codes.
 */
import { createHandler } from '../../server/rendezvous/handler';
import { kvStore, type KvNamespace } from '../../server/rendezvous/kv';

export const onRequest = (context: { request: Request; env: { LOBBY?: KvNamespace } }): Promise<Response> => {
  const kv = context.env.LOBBY;
  if (kv === undefined) {
    return Promise.resolve(new Response('{"error":"LOBBY KV binding missing"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    }));
  }
  return createHandler({ store: kvStore(kv) })(context.request);
};
