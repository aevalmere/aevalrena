/**
 * The LAN agent's lobby host (docs/LAN.md): the shared LobbyCore (src/net/lobbycore.ts) behind
 * WebSockets. One LobbyConn per browser WebSocket. A browser keeps one socket to its own agent
 * for the lobby list and opens another to whichever agent holds the lobby it is in.
 */
import { WebSocket, type RawData } from 'ws';
import { LobbyCore, MAX_PAYLOAD, type LobbyCoreOptions, type LobbyConn } from '../src/net/lobbycore';
import type { Announce, LobbyListing } from '../src/net/protocol';

export { MAX_PAYLOAD };
export type LobbyHostOptions = LobbyCoreOptions;

export class LobbyHost {
  readonly core: LobbyCore;
  private readonly sockets = new Set<WebSocket>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(opts: LobbyHostOptions) {
    this.core = new LobbyCore(opts);
    this.timer = setInterval(() => this.core.tick(), 1000);
  }

  get rejectedPackets(): number {
    return this.core.rejectedPackets;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.core.dispose();
    for (const ws of this.sockets) ws.terminate();
  }

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    const sock = (ws as unknown as { _socket?: { setNoDelay?(v: boolean): void } })._socket;
    sock?.setNoDelay?.(true); // an input packet must leave now, not with the next one
    const conn: LobbyConn = {
      get open() { return ws.readyState === WebSocket.OPEN; },
      sendText: (text) => ws.send(text),
      sendBinary: (bytes) => ws.send(bytes, { binary: true }),
      terminate: () => ws.terminate(),
      probe: () => ws.ping(),
    };
    const peer = this.core.attach(conn);
    ws.on('pong', () => peer.alive());
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = toBuffer(data);
      if (isBinary) peer.binary(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      else peer.text(buf.toString('utf8'));
    });
    ws.on('close', (code: number) => {
      this.sockets.delete(ws);
      peer.closed(code);
    });
    ws.on('error', () => { /* 'close' follows */ });
  }

  /** This agent's lobbies for the UDP announce. */
  announceLobbies(): Announce['lobbies'] {
    return this.core.announceLobbies();
  }

  ownListings(): LobbyListing[] {
    return this.core.ownListings();
  }

  counts(): { clients: number; lobbies: number } {
    return this.core.counts();
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
