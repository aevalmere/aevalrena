import type { MatchConfig } from '../core/types';

/**
 * Protocol between the browser (src/net/client.ts, src/ui/lan.ts) and a LAN agent
 * (server/lan.ts), and between agents (server/discovery.ts). docs/LAN.md section 3.
 *
 * Browser <-> agent: JSON in WebSocket text frames. Match inputs are binary frames
 * (src/net/codec.ts) that the lobby's agent relays to the other members and logs, so a member
 * that drops can resume from the confirmed input history.
 */

export const LAN_PORT = 5180;
export const LAN_PATH = '/lan';
export const LOBBY_MAX = 4;
export const SIM_LATENCIES = [0, 30, 60, 100] as const;
/** Bump on any wire change. The agent's game version hash also covers the sim sources. */
export const PROTOCOL_VERSION = 3;
/** `inputDelay` value meaning: pick from measured pings at match start. */
export const AUTO_DELAY = -1;
/** How long a dropped player's slot is held for a reconnect during a match. */
export const RECONNECT_MS = 10000;
export const NAME_MAX = 12;
export const FRAME_MS = 1000 / 60;

export interface LobbySettings {
  name: string;
  stocks: number;
  stageId: string;
  /** 0..4 frames, or AUTO_DELAY. */
  inputDelay: number;
  /** Fill empty slots with CPUs at match start (driven by the lobby host's browser). */
  cpuFill: boolean;
  cpuLevel: number;
  /** One-way delay the agent adds to every relayed input packet, for testing rollback. */
  simLatencyMs: number;
}

export interface LobbyMember {
  id: number;
  name: string;
  /** Lobby slot 0..3, assigned by the lobby host. Also the member's peer id in a match. */
  slot: number;
  charId: string;
  /** Team colour index (PLAYER_ACCENTS). Defaults to the slot's own colour. */
  team: number;
  ready: boolean;
  /** Voted Rematch on the results screen; when every member has, the lobby restarts. */
  rematch: boolean;
  /** Round trip to this lobby's agent in ms, -1 unknown. */
  ping: number;
  /** False while the member's socket is down inside the reconnect window. */
  connected: boolean;
}

export interface LobbyInfo {
  id: number;
  hostId: number;
  settings: LobbySettings;
  members: LobbyMember[];
  inMatch: boolean;
}

/** One row of the browser's lobby list: a lobby on this agent or on a discovered one. */
export interface LobbyListing {
  agentId: string;
  /** host:port of the agent holding the lobby; '' = the agent this list came from. */
  address: string;
  lobbyId: number;
  name: string;
  hostName: string;
  stageId: string;
  players: number;
  state: 'open' | 'in-match';
  version: string;
}

export interface MatchStart {
  config: MatchConfig;
  /** Per config.players index: the peer id (lobby slot) that sends that player's input. */
  owners: number[];
  inputDelay: number;
}

/**
 * Players who left a running match: fighter indices, and the first frame they have no input
 * for (their last relayed frame + 1). Every peer eliminates them before simulating `frame`.
 */
export interface Retirement {
  frame: number;
  players: number[];
  /**
   * The last relayed inputs of those players (per player, [held, pressed, released, direct]
   * from frame `from` up to `frame - 1`), so a peer that lost a packet still has them.
   */
  tail?: { from: number; inputs: number[][] };
}

/** Confirmed inputs per fighter index, flattened [held, pressed, released, direct] from frame 0. */
export interface InputHistory {
  players: number[][];
}

export type ClientMsg =
  | { t: 'hello'; name: string; version: string }
  | { t: 'list' }
  | { t: 'create'; settings: LobbySettings; charId: string }
  | { t: 'join'; lobbyId: number; charId: string }
  | { t: 'leave' }
  | { t: 'member'; charId?: string; team?: number; ready?: boolean; name?: string }
  | { t: 'settings'; settings: LobbySettings }
  | { t: 'assign'; memberId: number; slot: number }
  | { t: 'start' }
  /** This client left the match screen (results, or quit) and is back in the lobby. */
  | { t: 'backToLobby' }
  | { t: 'rematch' }
  /** Leaving a running match on purpose (Escape, confirmed): no reconnect window. */
  | { t: 'leaveMatch' }
  | { t: 'resume'; lobbyId: number; memberId: number; token: string; version: string }
  | { t: 'ping'; ts: number; rtt: number };

export type ServerMsg =
  | { t: 'welcome'; id: number; version: string; agentId: string; hostName: string }
  | { t: 'lobbies'; lobbies: LobbyListing[] }
  | { t: 'lobby'; lobby: LobbyInfo | null }
  | { t: 'joined'; lobbyId: number; memberId: number; token: string }
  | { t: 'start'; start: MatchStart }
  | { t: 'peerDropped'; memberId: number; slot: number; name: string; timeoutMs: number }
  | { t: 'peerResumed'; memberId: number; slot: number }
  | { t: 'peerGone'; memberId: number; slot: number; name: string; reason: 'left' | 'timeout'; retirement: Retirement }
  | { t: 'lobbyClosed'; message: string }
  /** Answer to a resume: everything a reloaded page needs to land back in the match. */
  | { t: 'resumed'; start: MatchStart; history: InputHistory; retirements: Retirement[]; lobby: LobbyInfo; memberId: number; token: string }
  | { t: 'pong'; ts: number }
  | { t: 'error'; message: string };

/** UDP discovery datagram (JSON), one per agent per second. */
export interface Announce {
  k: 'aevalrena-lan';
  p: number;
  agentId: string;
  hostName: string;
  ips: string[];
  port: number;
  version: string;
  lobbies: Omit<LobbyListing, 'agentId' | 'address' | 'version'>[];
}

export function defaultSettings(stageId: string): LobbySettings {
  return { name: 'LAN LOBBY', stocks: 3, stageId, inputDelay: 1, cpuFill: false, cpuLevel: 5, simLatencyMs: 0 };
}

/** Clamp untrusted settings from the wire. */
export function sanitizeSettings(s: Partial<LobbySettings>, fallbackStage: string): LobbySettings {
  const d = defaultSettings(fallbackStage);
  const num = (v: unknown, lo: number, hi: number, def: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def;
  const lat = num(s.simLatencyMs, 0, 100, 0);
  return {
    name: typeof s.name === 'string' && s.name.trim() !== '' ? s.name.trim().slice(0, 20) : d.name,
    stocks: num(s.stocks, 1, 5, d.stocks),
    stageId: typeof s.stageId === 'string' && s.stageId !== '' ? s.stageId.slice(0, 32) : d.stageId,
    inputDelay: num(s.inputDelay, AUTO_DELAY, 4, d.inputDelay),
    cpuFill: s.cpuFill === true,
    cpuLevel: num(s.cpuLevel, 0, 10, d.cpuLevel),
    simLatencyMs: (SIM_LATENCIES as readonly number[]).includes(lat) ? lat : 0,
  };
}

/** `name`, or `name 2`, `name 3`... so no two members of a lobby share a name. */
export function uniqueName(name: string, taken: string[]): string {
  const base = name.trim().slice(0, NAME_MAX) || 'PLAYER';
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = base.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * Auto input delay: the worst one-way path between two members (each member's ping to the
 * agent is a round trip, so i -> agent -> j is half of each plus the simulated latency),
 * in frames, rounded up, clamped 1..4.
 */
export function autoDelay(pings: number[], simLatencyMs: number): number {
  const known = pings.filter((p) => p >= 0);
  let worst = 0;
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) worst = Math.max(worst, known[i] / 2 + known[j] / 2);
  }
  const oneWay = worst + simLatencyMs;
  return Math.max(1, Math.min(4, Math.ceil(oneWay / FRAME_MS)));
}

/**
 * The match a lobby starts: members in slot order, then CPU fill for empty slots (owned by the
 * lobby host's peer, whose browser runs the AI and sends its inputs). Teams follow the frozen
 * rule: on when two or more slots share a colour. When the humans have teamed up (two share a
 * colour), the fill CPUs form one team in the first colour no human uses, so two humans plus CPU
 * fill is a 2v2; otherwise each CPU keeps its slot colour. Final Smash stays off this wave.
 */
export function buildMatchStart(lobby: LobbyInfo, seed: number): MatchStart {
  const players: MatchConfig['players'] = [];
  const owners: number[] = [];
  const host = lobby.members.find((m) => m.id === lobby.hostId);
  const hostSlot = host === undefined ? 0 : host.slot;
  const humanTeams = lobby.members.map((m) => m.team);
  const humansTeamed = humanTeams.some((t, i) => humanTeams.indexOf(t) !== i);
  let cpuTeam = -1;
  if (humansTeamed) for (let c = 0; c < LOBBY_MAX && cpuTeam < 0; c++) if (!humanTeams.includes(c)) cpuTeam = c;
  for (let slot = 0; slot < LOBBY_MAX; slot++) {
    const m = lobby.members.find((x) => x.slot === slot);
    if (m !== undefined) {
      players.push({ slot, charId: m.charId, cpu: false, cpuLevel: 0, name: m.name, team: m.team });
      owners.push(slot);
    } else if (lobby.settings.cpuFill) {
      players.push({ slot, charId: 'aeval', cpu: true, cpuLevel: lobby.settings.cpuLevel, team: cpuTeam >= 0 ? cpuTeam : slot });
      owners.push(hostSlot);
    }
  }
  const colours = new Map<number, number>();
  for (const p of players) colours.set(p.team ?? p.slot, (colours.get(p.team ?? p.slot) ?? 0) + 1);
  let teams = false;
  for (const n of colours.values()) if (n >= 2) teams = true;
  const config: MatchConfig = {
    stageId: lobby.settings.stageId,
    players,
    stocks: lobby.settings.stocks,
    timeLimitSec: 0,
    seed: seed >>> 0 || 1,
    finalSmash: false,
    cpuZeroMoves: false,
    teams,
  };
  const delay = lobby.settings.inputDelay === AUTO_DELAY
    ? autoDelay(lobby.members.map((m) => m.ping), lobby.settings.simLatencyMs)
    : lobby.settings.inputDelay;
  return { config, owners, inputDelay: delay };
}
