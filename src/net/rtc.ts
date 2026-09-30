/**
 * WebRTC side of the in-browser LAN mode (docs/LAN.md section 11). One RTCPeerConnection per
 * guest, to the lobby host's tab, with two pre-negotiated data channels:
 *
 * - id 0, reliable and ordered: lobby JSON, pings, start, leave and retirement messages;
 * - id 1, unordered with maxRetransmits 0: binary input packets. Packets repeat every unacked
 *   input (src/net/codec.ts), so a lost or late one costs nothing.
 *
 * No iceServers: only host candidates, which is all a LAN needs and all the join codes carry.
 */
import { MAX_PAYLOAD } from './lobbycore';
import { compressSdp, type CodeKind } from './sdpcode';
import type { NetTransport } from './transport';

/** How long a code waits for ICE gathering before it is made from what was found. */
export const GATHER_MS = 3000;
/** Unsent bytes on the input channel past which a packet is skipped (the next one repeats it). */
const FAST_BUFFER_MAX = 64 * 1024;

/** A lobby connection in the in-browser mode: a WebRTC link, or the host tab's own loopback. */
export interface BrowserLink {
  readonly open: boolean;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  /** Close on purpose. `onClose` does not fire for it. */
  close(): void;
  onOpen: (() => void) | null;
  onText: ((text: string) => void) | null;
  onBinary: ((bytes: Uint8Array) => void) | null;
  /** The link went down on its own (the other side left, or the network failed). */
  onClose: (() => void) | null;
}

export class RtcLink implements BrowserLink {
  readonly pc: RTCPeerConnection;
  private readonly reliable: RTCDataChannel;
  private readonly fast: RTCDataChannel;
  private closed = false;
  private opened = false;
  onOpen: (() => void) | null = null;
  onText: ((text: string) => void) | null = null;
  onBinary: ((bytes: Uint8Array) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.reliable = this.pc.createDataChannel('lobby', { negotiated: true, id: 0, ordered: true });
    this.fast = this.pc.createDataChannel('inputs', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    this.fast.binaryType = 'arraybuffer';
    this.reliable.binaryType = 'arraybuffer';
    const maybeOpen = (): void => {
      if (this.opened || this.closed || !this.open) return;
      this.opened = true;
      this.onOpen?.();
    };
    this.reliable.addEventListener('open', maybeOpen);
    this.fast.addEventListener('open', maybeOpen);
    this.reliable.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      if (ev.data.length > MAX_PAYLOAD) {
        this.lost();
        return;
      }
      this.onText?.(ev.data);
    });
    this.fast.addEventListener('message', (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer && ev.data.byteLength <= MAX_PAYLOAD) this.onBinary?.(new Uint8Array(ev.data));
    });
    this.reliable.addEventListener('close', () => this.lost());
    this.fast.addEventListener('close', () => this.lost());
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.lost();
    });
  }

  get open(): boolean {
    return !this.closed && this.reliable.readyState === 'open' && this.fast.readyState === 'open';
  }

  sendText(text: string): void {
    if (this.closed || this.reliable.readyState !== 'open') return;
    try {
      this.reliable.send(text);
    } catch {
      this.lost();
    }
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.closed || this.fast.readyState !== 'open' || this.fast.bufferedAmount > FAST_BUFFER_MAX) return;
    try {
      this.fast.send(bytes as Uint8Array<ArrayBuffer>);
    } catch {
      // A full send queue or a closing channel: the next packet repeats these inputs.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shut();
  }

  /** Close after the reliable channel has flushed what was already queued (at most `ms`). */
  closeAfterFlush(ms = 1000): void {
    if (this.closed) return;
    this.closed = true;
    const deadline = performance.now() + ms;
    const wait = (): void => {
      if (this.reliable.readyState === 'open' && this.reliable.bufferedAmount > 0 && performance.now() < deadline) {
        setTimeout(wait, 50);
        return;
      }
      this.shut();
    };
    wait();
  }

  private shut(): void {
    try {
      this.reliable.close();
      this.fast.close();
      this.pc.close();
    } catch {
      // Already closed.
    }
  }

  private lost(): void {
    if (this.closed) return;
    this.closed = true;
    this.shut();
    this.onClose?.();
  }

  /** The local description as a join (offer) or answer code, once ICE gathering is done. */
  async localCode(kind: CodeKind, invite: number, version: string): Promise<string> {
    await waitForGathering(this.pc, GATHER_MS);
    const sdp = this.pc.localDescription?.sdp ?? '';
    return compressSdp(sdp, kind, invite, version);
  }
}

/** Resolve when ICE gathering is complete, or after `ms` with whatever was gathered. */
export function waitForGathering(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onState);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };
    const onState = (): void => { if (pc.iceGatheringState === 'complete') done(); };
    const onCandidate = (ev: RTCPeerConnectionIceEvent): void => { if (ev.candidate === null) done(); };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

/** Match input packets over a browser link: queued as they arrive, handed over on poll. */
export function createLinkTransport(link: BrowserLink): NetTransport & { dispose(): void } {
  const queue: Uint8Array[] = [];
  const onBinary = (bytes: Uint8Array): void => { queue.push(bytes); };
  link.onBinary = onBinary;
  return {
    send(packet: Uint8Array): void {
      link.sendBinary(packet);
    },
    poll(onPacket: (packet: Uint8Array) => void): void {
      for (let i = 0; i < queue.length; i++) onPacket(queue[i]);
      queue.length = 0;
    },
    dispose(): void {
      // A rematch builds the next transport on the same link before the old one is disposed.
      if (link.onBinary === onBinary) link.onBinary = null;
      queue.length = 0;
    },
  };
}
