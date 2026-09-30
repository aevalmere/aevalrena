/** A Cloudflare KV namespace as a RoomStore. Only the three calls the rendezvous uses are typed. */
import type { RoomStore } from './handler';

export interface KvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function kvStore(kv: KvNamespace): RoomStore {
  return {
    get: (key) => kv.get(key),
    // KV refuses a TTL under 60 s.
    put: (key, value, ttlSeconds) => kv.put(key, value, { expirationTtl: Math.max(60, ttlSeconds) }),
    delete: (key) => kv.delete(key),
  };
}
