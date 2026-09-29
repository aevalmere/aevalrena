import { decodePacket, createPacket, type InputPacket } from './codec';
import type { InputHistory } from './protocol';

/**
 * The confirmed input history of a match, kept by the lobby's agent from the packets it relays
 * (and by nettest's fake hub). A member that reconnects gets it and re-simulates to the present.
 * Grows by 16 bytes per player per frame: a 10 minute 4 player match is about 2.3 MB.
 */
export class InputLog {
  private readonly data: Int32Array[] = [];
  private readonly known: Uint8Array[] = [];
  /** Per player: highest frame f with every frame 0..f present. */
  readonly last: number[] = [];
  private readonly packet: InputPacket = createPacket();

  constructor(readonly players: number) {
    for (let i = 0; i < players; i++) {
      this.data.push(new Int32Array(4 * 1024));
      this.known.push(new Uint8Array(1024));
      this.last.push(-1);
    }
  }

  put(player: number, frame: number, held: number, pressed: number, released: number, direct: number): void {
    if (player < 0 || player >= this.players || frame < 0 || frame > 1 << 22) return;
    let k = this.known[player];
    if (frame >= k.length) {
      let size = k.length;
      while (size <= frame) size *= 2;
      const nk = new Uint8Array(size);
      nk.set(k);
      this.known[player] = k = nk;
      const nd = new Int32Array(size * 4);
      nd.set(this.data[player]);
      this.data[player] = nd;
    }
    if (k[frame] === 1) return;
    const d = this.data[player];
    d[frame * 4] = held;
    d[frame * 4 + 1] = pressed;
    d[frame * 4 + 2] = released;
    d[frame * 4 + 3] = direct;
    k[frame] = 1;
    let l = this.last[player];
    while (l + 1 < k.length && k[l + 1] === 1) l++;
    this.last[player] = l;
  }

  /**
   * Record a relayed packet. `owns(player)` says whether the sender may speak for that fighter
   * index, so one client cannot write another's inputs.
   */
  record(buf: Uint8Array, owns: (player: number) => boolean): boolean {
    const pk = this.packet;
    if (!decodePacket(buf, pk)) return false;
    const n = pk.players.length;
    for (let j = 0; j < pk.frames; j++) {
      for (let k = 0; k < n; k++) {
        const idx = pk.players[k];
        if (!owns(idx)) continue;
        const o = (j * n + k) * 4;
        this.put(idx, pk.firstFrame + j, pk.inputs[o], pk.inputs[o + 1], pk.inputs[o + 2], pk.inputs[o + 3]);
      }
    }
    return true;
  }

  /** The contiguous confirmed prefix of every player, for a reconnecting member. */
  history(): InputHistory {
    const players: number[][] = [];
    for (let i = 0; i < this.players; i++) {
      const n = this.last[i] + 1;
      players.push(Array.from(this.data[i].subarray(0, n * 4)));
    }
    return { players };
  }

  /** Inputs of `player` for frames from..to inclusive, flattened; stops at the first gap. */
  range(player: number, from: number, to: number): number[] {
    const out: number[] = [];
    const k = this.known[player];
    const d = this.data[player];
    for (let f = Math.max(0, from); f <= to && f < k.length && k[f] === 1; f++) out.push(d[f * 4], d[f * 4 + 1], d[f * 4 + 2], d[f * 4 + 3]);
    return out;
  }

  bytes(): number {
    let b = 0;
    for (let i = 0; i < this.players; i++) b += this.data[i].byteLength + this.known[i].byteLength;
    return b;
  }
}
