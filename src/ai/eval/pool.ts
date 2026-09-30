/**
 * Match scheduling for the harness (plan 4.5, W2.16): deterministic seeds, paired seeds with side
 * swap, serializable job specs, batching with a per-process memo, the per-match probe, and the
 * process pool that shards test cases over child processes.
 *
 * A job is plain data (`JobSpec`, brains named by `BrainRef`), so it can cross a process or thread
 * boundary; `runJob` turns it into a MatchSpec and runs it. A match is a pure function of its spec,
 * which is why results do not depend on the order jobs run in or on how cases are sharded. The
 * executor behind `runBatch` is swappable (`setBatchExecutor`) so a worker_threads pool can be
 * added without touching the cases; today it is single-threaded.
 *
 * Engine selection: `BrainRef` kinds 'ui' and 'spec' resolve through the active engine mode.
 * 'legacy' maps them to today's cpuInput (a spec goes to the nearest UI level); 'new' maps them to
 * newBrain and throws EngineNotRegisteredError while no engine is registered.
 */
import type { FighterState, GameState, InputFrame, StageDef } from '../../core/types';
import { Btn } from '../../core/types';
import { STAGE_DEFS } from '../../stages/registry';
import type { AdversaryId, BrainFactory, CpuSpec, MatchResult, MatchSpec } from '../contracts';
import { specForUiLevel } from '../levels';
import { adversary, EXTRA_ADVERSARIES, extraAdversary } from './adversaries';
import { isOffstage } from './replay';
import { hintFactory, legacyBrain, newBrain, runMatch, type SlotHint } from './runner';

// ---------------------------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------------------------

/** 32-bit FNV-1a of a string. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Deterministic seed `i` of a named stream; the same tag and index always give the same seed. */
export function seedFor(tag: string, i: number): number {
  const s = fnv1a(`${tag}#${i}`) & 0x7fffffff;
  return s === 0 ? 1 : s;
}

/** The two arenas every strength gate runs on. */
export const STAGES: readonly string[] = ['tidegate', 'hearthmoor'];

// ---------------------------------------------------------------------------------------------
// Brains by reference
// ---------------------------------------------------------------------------------------------

export type ExtraAdversaryId = typeof EXTRA_ADVERSARIES[number];

/**
 * A brain named by data. 'ui': a UI level 0 to 10 (0 is always the legacy dummy). 'spec': a guide
 * spec. 'legacy': today's cpuInput at a UI level, whatever the engine mode. 'adv' and 'xadv':
 * scripted adversaries on human slots with a typed name.
 */
export type BrainRef =
  | { k: 'ui'; level: number }
  | { k: 'spec'; spec: CpuSpec }
  | { k: 'legacy'; level: number }
  | { k: 'adv'; id: AdversaryId; name?: string }
  | { k: 'xadv'; id: ExtraAdversaryId; name?: string };

export type EngineMode = 'legacy' | 'new';
let mode: EngineMode = 'legacy';

export function setEngineMode(m: EngineMode): void { mode = m; memo.clear(); }
export function engineMode(): EngineMode { return mode; }

export class EngineNotRegisteredError extends Error {
  constructor() { super('engine not registered'); this.name = 'EngineNotRegisteredError'; }
}

/** True when setBrainEngine has installed the new engine (newBrain(...).create() stops throwing). */
export function engineRegistered(): boolean {
  try {
    newBrain(specForUiLevel(5)).create();
    return true;
  } catch {
    return false;
  }
}

/** Nearest UI level for a guide spec, used when the legacy brain stands in for the new engine. */
export function legacyUiForSpec(spec: CpuSpec): number {
  if (spec.god) return 10;
  if (spec.s >= 1) return 9;
  return 1 + Math.round(Math.max(0, spec.s) * 8);
}

export function ui(level: number): BrainRef { return { k: 'ui', level }; }
export function specRef(spec: CpuSpec): BrainRef { return { k: 'spec', spec }; }
export function adv(id: AdversaryId, name?: string): BrainRef { return { k: 'adv', id, name }; }
export function xadv(id: ExtraAdversaryId, name?: string): BrainRef { return { k: 'xadv', id, name }; }
export const GOD: BrainRef = { k: 'ui', level: 10 };

/** Short label, e.g. "UI7", "god", "aggressive L3", "adv:turtle". */
export function refLabel(r: BrainRef): string {
  switch (r.k) {
    case 'ui': return r.level >= 10 ? 'god' : `UI${r.level}`;
    case 'legacy': return `legacy${r.level}`;
    case 'spec': return r.spec.god ? `${r.spec.archetype} god` : `${r.spec.archetype} L${r.spec.level}`;
    case 'adv': return `adv:${r.id}`;
    case 'xadv': return `adv:${r.id}`;
  }
}

/** The factory a ref stands for under the active engine mode. */
export function resolveBrain(r: BrainRef): BrainFactory {
  switch (r.k) {
    case 'legacy': return legacyBrain(r.level);
    case 'adv': return adversary(r.id, r.name ?? r.id);
    case 'xadv': return extraAdversary(r.id, r.name ?? r.id);
    case 'ui':
      if (r.level <= 0) return legacyBrain(0);
      if (mode === 'legacy') return legacyBrain(Math.min(10, Math.round(r.level)));
      if (!engineRegistered()) throw new EngineNotRegisteredError();
      return newBrain(specForUiLevel(r.level));
    case 'spec':
      if (mode === 'legacy') return legacyBrain(legacyUiForSpec(r.spec));
      if (!engineRegistered()) throw new EngineNotRegisteredError();
      return newBrain(r.spec);
  }
}

/** How the ref's player is written into the MatchConfig (mirrors the hints runner.ts and adversaries.ts set). */
export function hintFor(r: BrainRef, charId?: string): SlotHint {
  let h: SlotHint;
  switch (r.k) {
    case 'ui': case 'legacy': h = { cpu: true, cpuLevel: r.level <= 0 ? 0 : Math.min(10, Math.round(r.level)) }; break;
    case 'spec': h = { cpu: true, cpuLevel: legacyUiForSpec(r.spec) }; break;
    case 'adv': h = { cpu: false, cpuLevel: 0, name: r.name ?? r.id, zeroMoves: r.id === 'wandering' }; break;
    case 'xadv': h = { cpu: false, cpuLevel: 0, name: r.name ?? r.id }; break;
  }
  if (charId !== undefined) h.charId = charId;
  return h;
}

/** The name the resolved brain carries; two refs with one name play identically (legacy collapses archetypes). */
export function resolvedName(r: BrainRef): string {
  if (r.k === 'spec' && mode === 'legacy') return `legacy:${legacyUiForSpec(r.spec)}`;
  if (r.k === 'ui' && mode === 'legacy') return `legacy:${r.level <= 0 ? 0 : Math.min(10, Math.round(r.level))}`;
  return refLabel(r);
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

/** 'basic': counters per player. 'track': also a per-frame track of every fighter (larger). */
export type ProbeLevel = 'none' | 'basic' | 'track';

export interface JobSpec {
  seed: number; swap: boolean; stageId: string; stocks: number; frameCap: number;
  a: BrainRef; b: BrainRef;
  /** Players 2 and up with their team; any extra player turns the Teams rule on (runner.ts). */
  extras?: readonly { ref: BrainRef; team: number }[];
  record?: boolean; inputDelay?: number; probe?: ProbeLevel;
  /** Character per player index; default 'aeval'. Scripted adversaries always play 'aeval'. */
  chars?: readonly string[];
}

/** Team of every player index: a is 0, b is 1, extras as given. */
export function teamsOf(job: JobSpec): number[] {
  const t = [0, 1];
  if (job.extras !== undefined) for (const x of job.extras) t.push(x.team);
  return t;
}

export function refsOf(job: JobSpec): BrainRef[] {
  const r = [job.a, job.b];
  if (job.extras !== undefined) for (const x of job.extras) r.push(x.ref);
  return r;
}

/** Player index of sim slot `s` (runner.ts: a and b trade slots on a swap). */
export function playerOfSlot(job: JobSpec, s: number): number {
  return s < 2 && job.swap ? 1 - s : s;
}

/** Per-player counters and, for 'track', the per-frame track. All indices are player indices. */
export interface ProbeData {
  players: number;
  /** Frames the player lost a stock, in order. */
  koFrames: number[][];
  /** Frames the player took damage or was grabbed (engagements against it). */
  hurtFrames: number[][];
  /** Attack starts. */
  moveStarts: number[];
  /** Attack starts at a teammate (aitest `ak` geometry): the nearest fighter is a teammate and every enemy is far and off its line. */
  mateSwings: number[];
  /** Property counters (06 `bd`). */
  taunts: number[];
  earlyShields: number[];
  attackInHitstun: number[];
  /** Shield or Dodge presses in a launch beyond the first (the planned tech). */
  defInLaunch: number[];
  rollsOff: number[];
  /** Longest run of special starts while offstage without touching ground or ledge. */
  maxOffstageSpecials: number[];
  /** 'track' only: x, y, percent per frame per player (Float32, frame-major), TF flags, and 1 while invulnerable. */
  track: { frames: number; x: Float32Array; y: Float32Array; pct: Float32Array; flags: Uint8Array; inv: Uint8Array } | null;
}

/** Track flag bits. */
export const TF = { ground: 1, stun: 2, vulnerable: 4, dead: 8, shield: 16, attack: 32, offstage: 64, grabbed: 128 } as const;

export interface JobResult { job: JobSpec; result: MatchResult; probe: ProbeData | null; ms: number }

/** Key of a job for the memo; includes the engine mode. */
export function jobKey(job: JobSpec): string {
  return `${mode}|${JSON.stringify(job)}`;
}

const MEMO_CAP = 400;
const memo = new Map<string, JobResult>();

export function clearMemo(): void { memo.clear(); }

/**
 * Runs one job. `fresh` skips the memo in both directions (determinism and cost cases). Recorded
 * jobs are never memoized: their event logs are large, so a case keeps the metrics it derives instead.
 */
export function runJob(job: JobSpec, fresh = false): JobResult {
  if (job.record === true) fresh = true;
  const key = fresh ? '' : jobKey(job);
  if (!fresh) {
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
  }
  const factories = refsOf(job).map(resolveBrain);

  const probe = job.probe !== undefined && job.probe !== 'none' ? new Probe(job, job.probe === 'track') : null;
  const refs = refsOf(job);
  const wrapped = factories.map((f, p) => {
    const w = probe !== null ? probe.wrap(f, p) : f;
    const ch = job.chars !== undefined ? job.chars[p] : undefined;
    // A wrapper is a new object, so it carries the hint again; a character override re-hints too.
    return probe !== null || ch !== undefined ? hintFactory(w, hintFor(refs[p], ch)) : w;
  });
  const spec: MatchSpec = {
    seed: job.seed, stageId: job.stageId, stocks: job.stocks, frameCap: job.frameCap,
    a: wrapped[0], b: wrapped[1], swap: job.swap, record: job.record === true,
  };
  if (job.inputDelay !== undefined) spec.inputDelay = job.inputDelay;
  if (job.extras !== undefined) {
    spec.extraPlayers = job.extras.map((x, i) => ({ factory: wrapped[2 + i], team: x.team }));
  }
  const t0 = performance.now();
  const result = runMatch(spec);
  const ms = performance.now() - t0;
  const out: JobResult = { job, result, probe: probe !== null ? probe.finish(result) : null, ms };
  if (!fresh) {
    if (memo.size >= MEMO_CAP) memo.delete(memo.keys().next().value as string);
    memo.set(key, out);
  }
  return out;
}

/** Runs a batch of jobs; results are in job order. */
export type BatchExecutor = (jobs: readonly JobSpec[], fresh: boolean) => JobResult[];

let executor: BatchExecutor = (jobs, fresh) => jobs.map((j) => runJob(j, fresh));

/** Installs another executor (a worker_threads pool); jobs are plain data so they can be posted as is. */
export function setBatchExecutor(e: BatchExecutor): void { executor = e; }

export function runBatch(jobs: readonly JobSpec[], fresh = false): JobResult[] {
  return executor(jobs, fresh);
}

/**
 * `n` matches of one pairing: seed pairs from `tag`, each seed played with a on slot 0 and then
 * swapped, stages alternating per seed pair.
 */
export function pairedJobs(base: Omit<JobSpec, 'seed' | 'swap' | 'stageId'>, tag: string, n: number,
  stages: readonly string[] = STAGES): JobSpec[] {
  const out: JobSpec[] = [];
  for (let i = 0; i < n; i++) {
    const pair = i >> 1;
    out.push({ ...base, seed: seedFor(tag, pair), swap: (i & 1) === 1, stageId: stages[pair % stages.length] });
  }
  return out;
}

/** Tag for a pairing so equal pairings share seeds (and the memo) across cases. */
export function pairTag(a: BrainRef, b: BrainRef, extra = ''): string {
  return `${refLabel(a)}|${refLabel(b)}${extra !== '' ? `|${extra}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Probe: read-only observer of the live state, one wrapper per player
// ---------------------------------------------------------------------------------------------

/** Enemy distance past which a swing near a teammate counts as thrown at the teammate (aitest ak). */
export const TEAM_FAR = 200;
/** Horizontal px either side that count as in line (straight above or below). */
export const TEAM_LINE_X = 24;

const STUN_ACTIONS: Readonly<Record<string, true>> = {
  hitstun: true, tumble: true, grabbed: true, tech: true, techRoll: true, downed: true, getUp: true,
  getUpRoll: true, footstooled: true, finalSmashVictim: true,
};
const VULNERABLE_ACTIONS: Readonly<Record<string, true>> = {
  shieldBreak: true, airHelpless: true, land: true, downed: true, footstooled: true,
};

function teamSide(dx: number): number { return Math.abs(dx) <= TEAM_LINE_X ? 0 : Math.sign(dx); }

function alive(f: FighterState): boolean { return f.stocks > 0 && f.action !== 'dead'; }

interface SlotMem { prevAction: string; prevMove: string | null; prevStocks: number; prevPct: number;
  inLaunch: boolean; launchDef: number; rolling: boolean; offSpecials: number }

class Probe {
  readonly n: number;
  readonly data: ProbeData;
  private readonly mem: SlotMem[] = [];
  private readonly teams: number[];
  private lastFrame = -1;
  private readonly stage: StageDef;
  private readonly capFrames: number;

  constructor(private readonly job: JobSpec, track: boolean) {
    this.teams = teamsOf(job);
    this.n = this.teams.length;
    this.stage = STAGE_DEFS[job.stageId];
    const z = (): number[] => new Array<number>(this.n).fill(0);
    const zz = (): number[][] => { const a: number[][] = []; for (let i = 0; i < this.n; i++) a.push([]); return a; };
    this.capFrames = job.frameCap + 2;
    this.data = {
      players: this.n, koFrames: zz(), hurtFrames: zz(), moveStarts: z(), mateSwings: z(), taunts: z(),
      earlyShields: z(), attackInHitstun: z(), defInLaunch: z(), rollsOff: z(), maxOffstageSpecials: z(),
      track: track ? {
        frames: 0,
        x: new Float32Array(this.capFrames * this.n), y: new Float32Array(this.capFrames * this.n),
        pct: new Float32Array(this.capFrames * this.n), flags: new Uint8Array(this.capFrames * this.n),
        inv: new Uint8Array(this.capFrames * this.n),
      } : null,
    };
  }

  wrap(f: BrainFactory, player: number): BrainFactory {
    const self = this;
    return {
      name: f.name, spec: f.spec, reset: () => f.reset(),
      create() {
        const inner = f.create();
        return (state: GameState, slot: number, out: InputFrame): InputFrame => {
          const o = inner(state, slot, out);
          self.observe(state, slot, player, o);
          return o;
        };
      },
    };
  }

  private memOf(p: number, f: FighterState): SlotMem {
    let m = this.mem[p];
    if (m === undefined) {
      m = { prevAction: f.action, prevMove: f.moveId, prevStocks: f.stocks, prevPct: f.percent, inLaunch: false,
        launchDef: 0, rolling: false, offSpecials: 0 };
      this.mem[p] = m;
    }
    return m;
  }

  private observe(state: GameState, slot: number, p: number, o: InputFrame): void {
    const d = this.data;
    const f = state.fighters[slot];
    const m = this.memOf(p, f);
    const frame = state.frame;
    // World-level bookkeeping once per frame (the first player called this frame does it).
    if (frame !== this.lastFrame) { this.lastFrame = frame; this.world(state); }

    // Stocks and damage.
    if (f.stocks < m.prevStocks) d.koFrames[p].push(frame);
    if (f.percent > m.prevPct + 1e-9 || (f.action === 'grabbed' && m.prevAction !== 'grabbed')) d.hurtFrames[p].push(frame);
    m.prevStocks = f.stocks;
    m.prevPct = f.percent;

    // Attack starts and swings at a teammate.
    const started = f.action === 'attack' && (m.prevAction !== 'attack' || f.moveId !== m.prevMove);
    if (started) {
      d.moveStarts[p]++;
      if (this.swingAtMate(state, slot, f)) d.mateSwings[p]++;
      const off = isOffstage(this.stage, f);
      const special = f.moveId !== null && f.moveId.endsWith('special');
      if (off && special) {
        m.offSpecials++;
        if (m.offSpecials > d.maxOffstageSpecials[p]) d.maxOffstageSpecials[p] = m.offSpecials;
      }
    }
    if (f.onGround || f.action === 'ledgeHang' || f.action === 'ledgeGrab' || f.action === 'dead') m.offSpecials = 0;

    // Rolls that end off the stage without a hit in between.
    if (f.action === 'roll' && m.prevAction !== 'roll') m.rolling = true;
    if (m.rolling && f.action !== 'roll') {
      if (!f.onGround && f.hitstun === 0 && isOffstage(this.stage, f)) d.rollsOff[p]++;
      m.rolling = false;
    }

    // Launches: Shield or Dodge presses beyond the first (the tech) while launched.
    const launched = f.action === 'hitstun' || f.action === 'tumble';
    if (launched && !m.inLaunch) { m.inLaunch = true; m.launchDef = 0; }
    if (!launched) m.inLaunch = false;
    const pressed = o.pressed;
    if (launched && (pressed & (Btn.Shield | Btn.Dodge)) !== 0) {
      m.launchDef++;
      if (m.launchDef > 1) d.defInLaunch[p]++;
    }
    if ((pressed & Btn.Taunt) !== 0) d.taunts[p]++;
    if (f.action === 'hitstun' && f.hitstun > 0 && (pressed & (Btn.Attack | Btn.Special | Btn.Grab)) !== 0) d.attackInHitstun[p]++;
    // A fresh grounded shield while an enemy's move is 0 or 1 frames old (aitest aj).
    if ((pressed & Btn.Shield) !== 0 && f.onGround && f.hitstun === 0 && f.action !== 'shield' && f.action !== 'shieldStun') {
      for (let s = 0; s < state.fighters.length; s++) {
        if (s === slot || this.sameTeam(state, s, slot)) continue;
        const e = state.fighters[s];
        if (e.action === 'attack' && e.actionFrame <= 1 && e.hitlag === 0) { d.earlyShields[p]++; break; }
      }
    }
    m.prevAction = f.action;
    m.prevMove = f.moveId;
  }

  private sameTeam(state: GameState, a: number, b: number): boolean {
    return this.teams[playerOfSlot(this.job, a)] === this.teams[playerOfSlot(this.job, b)] && this.n > 2 && state.config.teams === true;
  }

  /** aitest `ak` geometry: nearest living fighter is a teammate, every enemy past TEAM_FAR and off the line. */
  private swingAtMate(state: GameState, slot: number, f: FighterState): boolean {
    if (f.moveId === 'uspecial' && isOffstage(this.stage, f)) return false;
    let dMate = Infinity; let mate: FighterState | null = null;
    let dFoe = Infinity; let foe: FighterState | null = null;
    for (let s = 0; s < state.fighters.length; s++) {
      if (s === slot) continue;
      const o = state.fighters[s];
      if (!alive(o)) continue;
      const dd = Math.hypot(o.x - f.x, o.y - f.y);
      if (this.sameTeam(state, s, slot)) { if (dd < dMate) { dMate = dd; mate = o; } }
      else if (dd < dFoe) { dFoe = dd; foe = o; }
    }
    if (mate === null) return false;
    const shot = f.moveId === 'nspecial' || f.moveId === 'sspecial';
    const foeSide = foe === null ? NaN : teamSide(foe.x - f.x);
    const inLine = foe !== null && (foeSide === 0 || foeSide === teamSide(mate.x - f.x) || (shot && foeSide === f.facing));
    return dMate < dFoe && dFoe > TEAM_FAR && !inLine;
  }

  private world(state: GameState): void {
    const t = this.data.track;
    if (t === null) return;
    const i = state.frame;
    if (i >= this.capFrames) return;
    if (i + 1 > t.frames) t.frames = i + 1;
    for (let s = 0; s < state.fighters.length; s++) {
      const f = state.fighters[s];
      const p = playerOfSlot(this.job, s);
      const k = i * this.n + p;
      t.x[k] = f.x; t.y[k] = f.y; t.pct[k] = f.percent;
      let fl = 0;
      if (f.onGround) fl |= TF.ground;
      if (f.hitstun > 0 || STUN_ACTIONS[f.action] === true) fl |= TF.stun;
      if (VULNERABLE_ACTIONS[f.action] === true) fl |= TF.vulnerable;
      if (!alive(f) || f.action === 'respawn') fl |= TF.dead;
      if (f.action === 'shield' || f.action === 'shieldStun') fl |= TF.shield;
      if (f.action === 'attack') fl |= TF.attack;
      if (isOffstage(this.stage, f)) fl |= TF.offstage;
      if (f.action === 'grabbed') fl |= TF.grabbed;
      t.flags[k] = fl;
      t.inv[k] = f.invuln > 0 ? 1 : 0;
    }
  }

  finish(r: MatchResult): ProbeData {
    // The last step is not observed by any brain call; a KO on it shows only in stocksLost.
    for (let p = 0; p < this.n; p++) {
      const lost = r.stocksLost[p] ?? 0;
      while (this.data.koFrames[p].length < lost) this.data.koFrames[p].push(r.frames);
    }
    return this.data;
  }
}

// ---------------------------------------------------------------------------------------------
// Node access (the tsconfig for src has no node types; modules are loaded by a computed specifier)
// ---------------------------------------------------------------------------------------------

export interface ChildLike {
  stdout: { on(ev: 'data', cb: (chunk: unknown) => void): void } | null;
  stderr: { on(ev: 'data', cb: (chunk: unknown) => void): void } | null;
  on(ev: 'close', cb: (code: number | null) => void): void;
}
export interface NodeApi {
  spawn(cmd: string, args: readonly string[], opts: Record<string, unknown>): ChildLike;
  spawnSync(cmd: string, args: readonly string[], opts: Record<string, unknown>): { status: number | null; stdout: unknown; stderr: unknown };
  readdirSync(path: string): string[];
  readFileSync(path: string, enc: 'utf8'): string;
  existsSync(path: string): boolean;
  cpuCount: number;
  fileURLToPath(url: string): string;
  join(...parts: string[]): string;
}

let nodeApiValue: NodeApi | null = null;

/** Loads the node modules the harness needs. Call once from main before running cases. */
export async function loadNode(): Promise<NodeApi> {
  if (nodeApiValue !== null) return nodeApiValue;
  const load = async (name: string): Promise<Record<string, unknown>> => {
    const spec = `node:${name}`;
    return (await import(/* @vite-ignore */ spec)) as Record<string, unknown>;
  };
  const cp = await load('child_process');
  const fs = await load('fs');
  const os = await load('os');
  const url = await load('url');
  const path = await load('path');
  const cpus = (os.cpus as () => unknown[])();
  nodeApiValue = {
    spawn: cp.spawn as NodeApi['spawn'],
    spawnSync: cp.spawnSync as NodeApi['spawnSync'],
    readdirSync: fs.readdirSync as NodeApi['readdirSync'],
    readFileSync: fs.readFileSync as NodeApi['readFileSync'],
    existsSync: fs.existsSync as NodeApi['existsSync'],
    cpuCount: cpus.length,
    fileURLToPath: url.fileURLToPath as NodeApi['fileURLToPath'],
    join: path.join as NodeApi['join'],
  };
  return nodeApiValue;
}

/** The loaded node API, or null when main has not loaded it (a case then reports itself as skipped). */
export function nodeApi(): NodeApi | null { return nodeApiValue; }

/** Repo root: two levels above src/ai/eval. */
export function repoRoot(api: NodeApi): string {
  return api.join(api.fileURLToPath(new URL('.', import.meta.url).href), '..', '..', '..');
}

/** `npx --yes tsx <file> ...args` through the shell (npx is a .cmd on Windows). */
export function tsxCommand(file: string, args: readonly string[]): { cmd: string; args: string[] } {
  return { cmd: 'npx', args: ['--yes', 'tsx', `"${file}"`, ...args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))] };
}

/** `cmd` and its (already quoted) args as one shell command line. */
export function shellLine(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].join(' ');
}

/** Output of a child run: exit code and full stdout text. */
export interface ChildRun { code: number; out: string; err: string; ms: number }

/** Spawns a child and resolves when it exits. */
export function runChild(api: NodeApi, cmd: string, args: readonly string[], cwd: string): Promise<ChildRun> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let out = '';
    let err = '';
    // One command string: passing args with shell true is deprecated in node (DEP0190).
    const c = api.spawn(shellLine(cmd, args), [], { cwd, shell: true, windowsHide: true });
    if (c.stdout !== null) c.stdout.on('data', (ch) => { out += String(ch); });
    if (c.stderr !== null) c.stderr.on('data', (ch) => { err += String(ch); });
    c.on('close', (code) => resolve({ code: code ?? 1, out, err, ms: performance.now() - t0 }));
  });
}

/**
 * Runs `tasks` with at most `limit` in flight; results in task order. Used for the case pool
 * (each task is one child process running one case) and for unit files.
 */
export async function runLimited<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
    }
  };
  const lanes: Promise<void>[] = [];
  for (let k = 0; k < Math.max(1, Math.min(limit, tasks.length)); k++) lanes.push(lane());
  await Promise.all(lanes);
  return out;
}

/** Line prefix a child uses to hand a GateResult (JSON) back to the parent. */
export const GATE_LINE = '@@GATE ';
