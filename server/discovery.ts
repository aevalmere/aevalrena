/**
 * LAN discovery between agents (docs/LAN.md section 3). Every agent announces itself and its
 * lobbies once a second as a small JSON datagram to the multicast group 239.255.42.99:41999,
 * and also to the subnet broadcast address of every IPv4 interface (some Wi-Fi access points
 * and Windows setups drop multicast; broadcast is the fallback). Every agent listens on the same
 * port with SO_REUSEADDR, so several agents on one machine all hear each other. An agent that
 * has been silent for EXPIRE_MS drops out of the list.
 */
import dgram from 'node:dgram';
import os from 'node:os';
import type { Announce } from '../src/net/protocol';

export const DISCOVERY_GROUP = '239.255.42.99';
export const DISCOVERY_PORT = 41999;
export const ANNOUNCE_MS = 1000;
export const EXPIRE_MS = 4000;

export interface Iface {
  name: string;
  address: string;
  netmask: string;
  broadcast: string;
}

export interface DiscoveredAgent {
  announce: Announce;
  /** host:port the browser should use for this agent. */
  address: string;
  lastSeen: number;
}

function ipToInt(ip: string): number {
  const p = ip.split('.').map((x) => Number(x));
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Every non-internal IPv4 interface with its subnet broadcast address. */
export function lanInterfaces(): Iface[] {
  const out: Iface[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = ipToInt(a.address);
      const mask = ipToInt(a.netmask);
      out.push({ name, address: a.address, netmask: a.netmask, broadcast: intToIp((ip | (~mask >>> 0)) >>> 0) });
    }
  }
  return out;
}

export function sameSubnet(a: string, b: string, netmask: string): boolean {
  const m = ipToInt(netmask);
  return ((ipToInt(a) & m) >>> 0) === ((ipToInt(b) & m) >>> 0);
}

/**
 * The address to reach a discovered agent at: one of its advertised IPs on the same subnet as
 * one of ours (so a laptop with a VPN or a virtual adapter still picks the Wi-Fi address), else
 * the source address of its datagram.
 */
export function pickAddress(ips: string[], source: string, local: Iface[]): string {
  // The datagram's source is an address the peer really sent from on a network we share.
  if (ips.includes(source) && local.some((l) => sameSubnet(source, l.address, l.netmask))) return source;
  for (const ip of ips) {
    for (const l of local) if (sameSubnet(ip, l.address, l.netmask)) return ip;
  }
  return source;
}

/** Largest announce accepted; a full one (32 lobbies) is well under this. */
const MAX_DATAGRAM = 16 * 1024;
const MAX_IPS = 16;
const MAX_LOBBIES = 32;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function str(v: unknown, max: number, allowEmpty = true): v is string {
  return typeof v === 'string' && v.length <= max && (allowEmpty || v.length > 0);
}

function int(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

/**
 * A validated announce, or null. Every field is checked (type, length, range) and arrays are
 * capped, so a crafted datagram can neither throw later nor bloat the list.
 */
export function parseAnnounce(text: string): Announce | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (a.k !== 'aevalrena-lan' || !int(a.p, 0, 1000) || !str(a.agentId, 64, false) || !str(a.hostName, 64)) return null;
  if (!int(a.port, 1, 65535) || !str(a.version, 64)) return null;
  if (!Array.isArray(a.ips) || a.ips.length > MAX_IPS || !a.ips.every((ip) => typeof ip === 'string' && IPV4.test(ip))) return null;
  if (!Array.isArray(a.lobbies) || a.lobbies.length > MAX_LOBBIES) return null;
  const lobbies: Announce['lobbies'] = [];
  for (const l of a.lobbies as unknown[]) {
    if (typeof l !== 'object' || l === null) return null;
    const o = l as Record<string, unknown>;
    if (!int(o.lobbyId, 0, 2 ** 31) || !str(o.name, 40) || !str(o.hostName, 24) || !str(o.stageId, 32)) return null;
    if (!int(o.players, 0, 4) || (o.state !== 'open' && o.state !== 'in-match')) return null;
    lobbies.push({ lobbyId: o.lobbyId, name: o.name, hostName: o.hostName, stageId: o.stageId, players: o.players, state: o.state });
  }
  return {
    k: 'aevalrena-lan', p: a.p, agentId: a.agentId, hostName: a.hostName, ips: a.ips as string[],
    port: a.port, version: a.version, lobbies,
  };
}

export interface DiscoveryOptions {
  agentId: string;
  build(): Announce;
  groupPort?: number;
  intervalMs?: number;
  expireMs?: number;
  /** Announce to the multicast group. Default true. */
  multicast?: boolean;
  /** Announce to each interface's subnet broadcast address. Default true. */
  broadcast?: boolean;
  log?(line: string): void;
}

export class Discovery {
  private recv: dgram.Socket | null = null;
  private senders: { iface: Iface | null; sock: dgram.Socket }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly agents = new Map<string, DiscoveredAgent>();
  private readonly port: number;
  private readonly expireMs: number;

  constructor(private readonly opts: DiscoveryOptions) {
    this.port = opts.groupPort ?? DISCOVERY_PORT;
    this.expireMs = opts.expireMs ?? EXPIRE_MS;
  }

  async start(): Promise<void> {
    const recv = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.recv = recv;
    recv.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    recv.on('error', (err) => this.opts.log?.(`[discovery] receive error: ${err.message}`));
    await new Promise<void>((resolve, reject) => {
      recv.once('error', reject);
      recv.bind(this.port, () => {
        recv.off('error', reject);
        resolve();
      });
    });
    recv.setBroadcast(true);
    const ifaces = lanInterfaces();
    for (const i of ifaces) {
      try {
        recv.addMembership(DISCOVERY_GROUP, i.address);
      } catch (err) {
        this.opts.log?.(`[discovery] no multicast on ${i.name} ${i.address}: ${(err as Error).message}`);
      }
    }
    try {
      recv.addMembership(DISCOVERY_GROUP, '127.0.0.1');
    } catch {
      // Loopback multicast membership is optional; the default-interface one covers most setups.
    }
    // One sender per interface, so a multi-homed machine announces on every network.
    const targets: (Iface | null)[] = ifaces.length > 0 ? ifaces : [null];
    for (const iface of targets) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      await new Promise<void>((resolve) => sock.bind(0, iface?.address, () => resolve()));
      sock.setBroadcast(true);
      sock.setMulticastTTL(1);
      sock.setMulticastLoopback(true);
      if (iface !== null) {
        try {
          sock.setMulticastInterface(iface.address);
        } catch {
          // Keep the default interface.
        }
      }
      sock.on('error', (err) => this.opts.log?.(`[discovery] send error: ${err.message}`));
      this.senders.push({ iface, sock });
    }
    this.announce();
    this.timer = setInterval(() => this.announce(), this.opts.intervalMs ?? ANNOUNCE_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.senders) s.sock.close();
    this.senders = [];
    this.recv?.close();
    this.recv = null;
  }

  announce(): void {
    const buf = Buffer.from(JSON.stringify(this.opts.build()));
    for (const { iface, sock } of this.senders) {
      if (this.opts.multicast !== false) sock.send(buf, this.port, DISCOVERY_GROUP);
      if (this.opts.broadcast !== false) sock.send(buf, this.port, iface === null ? '255.255.255.255' : iface.broadcast);
    }
  }

  /** Datagrams dropped as malformed (bad JSON, wrong shape, out-of-range fields). */
  rejected = 0;

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const a = msg.length <= MAX_DATAGRAM ? parseAnnounce(msg.toString('utf8')) : null;
      if (a === null) {
        this.rejected++;
        return;
      }
      if (a.agentId === this.opts.agentId) return;
      this.accept(a, rinfo);
    } catch (err) {
      // A datagram must never take the agent down.
      this.rejected++;
      this.opts.log?.(`[discovery] dropped a datagram: ${(err as Error).message}`);
    }
  }

  private accept(a: Announce, rinfo: dgram.RemoteInfo): void {
    // One agent is heard once per interface and path; keep the first address while it stays valid
    // so the list does not flip between a Wi-Fi and a virtual adapter address every second.
    const prev = this.agents.get(a.agentId);
    const prevHost = prev === undefined ? '' : prev.address.slice(0, prev.address.lastIndexOf(':'));
    const host = prev !== undefined && (a.ips.includes(prevHost) || a.ips.length === 0)
      ? prevHost
      : pickAddress(a.ips, rinfo.address, lanInterfaces());
    const address = `${host}:${a.port}`;
    this.agents.set(a.agentId, { announce: a, address, lastSeen: Date.now() });
  }

  /** Agents heard within the expiry window. */
  list(): DiscoveredAgent[] {
    const now = Date.now();
    const out: DiscoveredAgent[] = [];
    for (const [id, a] of this.agents) {
      if (now - a.lastSeen > this.expireMs) this.agents.delete(id);
      else out.push(a);
    }
    return out;
  }
}
