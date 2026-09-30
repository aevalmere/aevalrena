/**
 * Join and answer codes for the in-browser LAN mode (docs/LAN.md section 11). With no
 * signaling server, the WebRTC offer and answer travel by hand: the host shows a code (and a QR
 * code), the guest pastes it, the guest shows an answer code, the host pastes that.
 *
 * A code is the SDP cut down to the lines a data-channel-only connection with host candidates
 * needs, packed into bytes, then base64url. `expandCode` rebuilds a full SDP from it. Layout
 * (little endian):
 *
 *   u8   magic 0xAE
 *   u8   format (high 4 bits, CODE_FORMAT) | kind (low 4 bits: 0 offer, 1 answer)
 *   u8   invite number: which host invite this offer (or the answer to it) belongs to
 *   u32  FNV-1a of the game version string (the version guard)
 *   u8   a=setup: 0 actpass, 1 active, 2 passive
 *   u16  a=sctp-port
 *   str  a=mid                 (str = u8 length + ASCII bytes)
 *   str  a=ice-ufrag
 *   str  a=ice-pwd
 *   u8   a=fingerprint hash: 1 sha-1, 2 sha-224, 3 sha-256, 4 sha-384, 5 sha-512
 *   u8   digest length, then the digest bytes
 *   u8   candidate count, each:
 *          u8  address kind: 4 IPv4 (4 bytes), 6 IPv6 (16 bytes), 1 mDNS name <uuid>.local
 *              (16 bytes), 2 any other name (str)
 *          u16 port
 *
 * Only UDP host candidates for component 1 are kept (no STUN or TURN servers are configured, so
 * there are no others worth sending). Foundation and priority are rebuilt.
 */

export const CODE_FORMAT = 1;
const MAGIC = 0xae;
export const MAX_CANDIDATES = 8;

export type CodeKind = 'offer' | 'answer';

export interface SignalCode {
  kind: CodeKind;
  invite: number;
  /** FNV-1a of the sender's game version. */
  versionHash: number;
  sdp: string;
}

interface Candidate {
  address: string;
  port: number;
}

interface SdpParts {
  setup: 'actpass' | 'active' | 'passive';
  sctpPort: number;
  mid: string;
  ufrag: string;
  pwd: string;
  hash: string;
  digest: number[];
  candidates: Candidate[];
}

const SETUPS = ['actpass', 'active', 'passive'] as const;
const HASHES = ['', 'sha-1', 'sha-224', 'sha-256', 'sha-384', 'sha-512'];
const MDNS = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** FNV-1a over the UTF-16 code units of `s`, for the version guard. */
export function versionHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export class CodeError extends Error {}

function parseSdp(sdp: string): SdpParts {
  const lines = sdp.split(/\r?\n/);
  const get = (prefix: string): string => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line === undefined ? '' : line.slice(prefix.length).trim();
  };
  const setup = get('a=setup:');
  const fp = get('a=fingerprint:').split(' ');
  const out: SdpParts = {
    setup: (SETUPS as readonly string[]).includes(setup) ? setup as SdpParts['setup'] : 'actpass',
    sctpPort: Number(get('a=sctp-port:')) || 5000,
    mid: get('a=mid:') || '0',
    ufrag: get('a=ice-ufrag:'),
    pwd: get('a=ice-pwd:'),
    hash: (fp[0] ?? '').toLowerCase(),
    digest: (fp[1] ?? '').split(':').filter((x) => x !== '').map((x) => parseInt(x, 16)),
    candidates: [],
  };
  if (out.ufrag === '' || out.pwd === '') throw new CodeError('The connection offer has no ICE credentials');
  if (HASHES.indexOf(out.hash) < 1 || out.digest.length === 0 || out.digest.some((b) => !(b >= 0 && b <= 255))) {
    throw new CodeError('The connection offer has no usable fingerprint');
  }
  for (const l of lines) {
    if (!l.startsWith('a=candidate:')) continue;
    // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
    const f = l.slice('a=candidate:'.length).trim().split(/\s+/);
    if (f.length < 8 || f[1] !== '1' || f[2].toLowerCase() !== 'udp' || f[6] !== 'typ' || f[7] !== 'host') continue;
    const port = Number(f[5]);
    if (!(port > 0 && port < 65536)) continue;
    if (out.candidates.some((c) => c.address === f[4] && c.port === port)) continue;
    if (out.candidates.length < MAX_CANDIDATES) out.candidates.push({ address: f[4], port });
  }
  return out;
}

class Writer {
  readonly bytes: number[] = [];
  u8(v: number): void { this.bytes.push(v & 255); }
  u16(v: number): void { this.u8(v); this.u8(v >>> 8); }
  u32(v: number): void { this.u16(v & 0xffff); this.u16(v >>> 16); }
  str(s: string): void {
    if (s.length > 255 || !/^[\x20-\x7e]*$/.test(s)) throw new CodeError('An SDP field is too long or not ASCII');
    this.u8(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
}

class Reader {
  private i = 0;
  constructor(private readonly b: Uint8Array) {}
  u8(): number {
    if (this.i >= this.b.length) throw new CodeError('The code is cut short. Copy all of it');
    return this.b[this.i++];
  }
  u16(): number { return this.u8() | (this.u8() << 8); }
  /** Big endian, for IPv6 groups. */
  u16BE(): number { return (this.u8() << 8) | this.u8(); }
  u32(): number { return (this.u16() | (this.u16() << 16)) >>> 0; }
  str(): string {
    const n = this.u8();
    let s = '';
    for (let k = 0; k < n; k++) s += String.fromCharCode(this.u8());
    return s;
  }
  done(): boolean { return this.i === this.b.length; }
}

function writeAddress(w: Writer, address: string): void {
  const m4 = IPV4.exec(address);
  if (m4 !== null) {
    w.u8(4);
    for (let k = 1; k <= 4; k++) w.u8(Number(m4[k]));
    return;
  }
  const md = MDNS.exec(address);
  if (md !== null) {
    w.u8(1);
    const hex = md.slice(1).join('');
    for (let k = 0; k < 32; k += 2) w.u8(parseInt(hex.slice(k, k + 2), 16));
    return;
  }
  const v6 = parseIpv6(address);
  if (v6 !== null) {
    w.u8(6);
    for (const b of v6) w.u8(b);
    return;
  }
  w.u8(2);
  w.str(address);
}

function readAddress(r: Reader): string {
  const kind = r.u8();
  if (kind === 4) return [r.u8(), r.u8(), r.u8(), r.u8()].join('.');
  if (kind === 1) {
    let hex = '';
    for (let k = 0; k < 16; k++) hex += r.u8().toString(16).padStart(2, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.local`;
  }
  if (kind === 6) {
    const groups: string[] = [];
    for (let k = 0; k < 8; k++) groups.push(r.u16BE().toString(16));
    return groups.join(':');
  }
  if (kind === 2) return r.str();
  throw new CodeError('The code has an unknown address kind');
}

/** 16 bytes of an IPv6 literal (with :: and an optional %zone, which is dropped), or null. */
function parseIpv6(s: string): number[] | null {
  const addr = s.replace(/%.*$/, '');
  if (!/^[0-9a-f:]+$/i.test(addr) || !addr.includes(':')) return null;
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...new Array<string>(Math.max(0, fill)).fill('0'), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const v = parseInt(g, 16);
    out.push(v >>> 8, v & 255);
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64url(bytes: number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let k = 0; k < chars; k++) s += B64[(n >>> (18 - 6 * k)) & 63];
  }
  return s;
}

function fromBase64url(text: string): Uint8Array {
  const s = text.replace(/[\s=]/g, '');
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new CodeError('That is not a join code. Copy all of it, with nothing else');
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4);
    let n = 0;
    for (let k = 0; k < 4; k++) n = (n << 6) | (k < chunk.length ? B64.indexOf(chunk[k]) : 0);
    out.push((n >>> 16) & 255);
    if (chunk.length > 2) out.push((n >>> 8) & 255);
    if (chunk.length > 3) out.push(n & 255);
  }
  return new Uint8Array(out);
}

/** Pack an SDP (after ICE gathering) into a code. */
export function compressSdp(sdp: string, kind: CodeKind, invite: number, version: string): string {
  const p = parseSdp(sdp);
  if (p.candidates.length === 0) throw new CodeError('No network address found. Check that this device is on the Wi-Fi');
  const w = new Writer();
  w.u8(MAGIC);
  w.u8((CODE_FORMAT << 4) | (kind === 'offer' ? 0 : 1));
  w.u8(invite);
  w.u32(versionHash(version));
  w.u8(SETUPS.indexOf(p.setup));
  w.u16(p.sctpPort);
  w.str(p.mid);
  w.str(p.ufrag);
  w.str(p.pwd);
  w.u8(HASHES.indexOf(p.hash));
  w.u8(p.digest.length);
  for (const b of p.digest) w.u8(b);
  w.u8(p.candidates.length);
  for (const c of p.candidates) {
    writeAddress(w, c.address);
    w.u16(c.port);
  }
  return toBase64url(w.bytes);
}

/** Pull a code out of pasted text: a bare code, or a link carrying one after #join= or #answer=. */
export function extractCode(text: string): string {
  const t = text.trim();
  const m = /#(?:join|answer)=([A-Za-z0-9_-]+)/.exec(t);
  return m !== null ? m[1] : t;
}

/** Unpack a code and rebuild a full SDP from it. Throws CodeError with a readable message. */
export function expandCode(text: string): SignalCode {
  const r = new Reader(fromBase64url(extractCode(text)));
  if (r.u8() !== MAGIC) throw new CodeError('That is not an Aevalrena join code');
  const head = r.u8();
  if (head >> 4 !== CODE_FORMAT) throw new CodeError('Different version: that code comes from another build');
  const kindBits = head & 15;
  if (kindBits > 1) throw new CodeError('That is not an Aevalrena join code');
  const kind: CodeKind = kindBits === 0 ? 'offer' : 'answer';
  const invite = r.u8();
  const vHash = r.u32();
  const setupIdx = r.u8();
  const setup = SETUPS[setupIdx];
  if (setup === undefined) throw new CodeError('That code is damaged');
  const sctpPort = r.u16();
  const mid = r.str();
  const ufrag = r.str();
  const pwd = r.str();
  const hash = HASHES[r.u8()];
  if (hash === undefined || hash === '') throw new CodeError('That code is damaged');
  const n = r.u8();
  const digest: number[] = [];
  for (let k = 0; k < n; k++) digest.push(r.u8());
  const count = r.u8();
  if (count === 0 || count > MAX_CANDIDATES) throw new CodeError('That code is damaged');
  const candidates: Candidate[] = [];
  for (let k = 0; k < count; k++) {
    const address = readAddress(r);
    candidates.push({ address, port: r.u16() });
  }
  if (!r.done()) throw new CodeError('That code has extra characters. Copy only the code');
  return { kind, invite, versionHash: vHash, sdp: buildSdp({ setup, sctpPort, mid, ufrag, pwd, hash, digest, candidates }) };
}

function buildSdp(p: SdpParts): string {
  const fp = p.digest.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
  const lines = [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${p.mid}`,
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
  ];
  p.candidates.forEach((c, i) => {
    // Host candidate priority: type preference 126, falling local preference, component 1.
    const priority = ((126 << 24) + ((65535 - i) << 8) + 255) >>> 0;
    lines.push(`a=candidate:${i + 1} 1 udp ${priority} ${c.address} ${c.port} typ host`);
  });
  lines.push(
    'a=end-of-candidates',
    `a=ice-ufrag:${p.ufrag}`,
    `a=ice-pwd:${p.pwd}`,
    `a=fingerprint:${p.hash} ${fp}`,
    `a=setup:${p.setup}`,
    `a=mid:${p.mid}`,
    `a=sctp-port:${p.sctpPort}`,
  );
  return `${lines.join('\r\n')}\r\n`;
}
