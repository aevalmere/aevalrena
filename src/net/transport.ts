/**
 * What the rollback engine needs from a network: broadcast a packet to every other peer in the
 * match, and hand over whatever arrived since the last call. Ordering and reliability are not
 * assumed (packets repeat unacked inputs). Implementations: the WebSocket relay client below,
 * the WebRTC and loopback links of the in-browser mode (createLinkTransport in rtc.ts), and the
 * fake hub in nettest.ts.
 */
export interface NetTransport {
  send(packet: Uint8Array): void;
  /** Calls `onPacket` for each packet received since the last poll, oldest first. */
  poll(onPacket: (packet: Uint8Array) => void): void;
}

/** Binary frames over an already open WebSocket (the LAN relay). Text frames are ignored here. */
export function createWebSocketTransport(ws: WebSocket): NetTransport & { dispose(): void } {
  ws.binaryType = 'arraybuffer';
  const queue: Uint8Array[] = [];
  const onMessage = (ev: MessageEvent): void => {
    if (ev.data instanceof ArrayBuffer) queue.push(new Uint8Array(ev.data));
  };
  ws.addEventListener('message', onMessage);
  return {
    send(packet: Uint8Array): void {
      if (ws.readyState === WebSocket.OPEN) ws.send(packet as Uint8Array<ArrayBuffer>);
    },
    poll(onPacket: (packet: Uint8Array) => void): void {
      for (let i = 0; i < queue.length; i++) onPacket(queue[i]);
      queue.length = 0;
    },
    dispose(): void {
      ws.removeEventListener('message', onMessage);
      queue.length = 0;
    },
  };
}
