/**
 * Trekmore balance driver (docs/TREKMORE_BALANCE_LEDGER.md, loops 1 and later). Deterministic, parallel:
 *
 *   npx --yes tsx src/ai/eval/diag/trekbalance.ts [--ui7 100] [--ui5 60] [--ui10 40] [--stocks 3] [--procs 11]
 *
 * Trekmore (player a) against Aeval (player b) at the same UI level, paired seeds with side swap,
 * stages alternating per seed pair, timeouts scored as half wins. Per level it prints the score with
 * its Wilson 95% interval, the average KO percent each way, damage per opening each way, Trekmore's
 * KO share by move (the source of his last hit on Aeval before a credited KO; echo and sword hits are
 * folded into their move), Trekmore's move usage share, and his self-destructs split by cause
 * (dair, sword recall, other).
 *
 * The parent spawns `--procs` children (`--child k/n`); each runs every n-th job and prints one JSON
 * line per job; the parent aggregates.
 */
import '../../characters/index';
import type { GameState, InputFrame } from '../../../core/types';
import type { BrainFactory, MatchSpec } from '../../contracts';
import { CHARACTER_DEFS } from '../../../characters/registry';
import { hintFactory, runMatch, setBrainEngine } from '../runner';
import {
  hintFor, loadNode, pairedJobs, pairTag, refsOf, repoRoot, resolveBrain, runChild, runLimited, setEngineMode,
  tsxCommand, ui, type JobSpec,
} from '../pool';
import { wilson } from '../stats';
import { brainInput, resetBrain, warmBrain } from '../../brain';

declare const process: { argv: string[]; stdout: { write(text: string): void }; exitCode?: number };

setBrainEngine({ brainInput, warmBrain, resetBrain });
setEngineMode('new');

const TREK = 'trekmore';
const AEVAL = 'aeval';
/** Frames a hit keeps KO credit here (only used for the KO on the match's last step, which no brain call sees). */
const RECENT = 240;
/** Frames before a self-destruct that a dair or a recall is blamed for it. */
const SD_BLAME = 180;

interface Args { ui7: number; ui5: number; ui10: number; stocks: number; procs: number; child: [number, number] | null }

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { ui7: 100, ui5: 60, ui10: 40, stocks: 3, procs: 11, child: null };
  for (let k = 0; k < argv.length; k++) {
    const v = argv[k + 1];
    switch (argv[k]) {
      case '--ui7': a.ui7 = Number(v); k++; break;
      case '--ui5': a.ui5 = Number(v); k++; break;
      case '--ui10': a.ui10 = Number(v); k++; break;
      case '--stocks': a.stocks = Number(v); k++; break;
      case '--procs': a.procs = Number(v); k++; break;
      case '--child': { const m = /^(\d+)\/(\d+)$/.exec(v ?? ''); if (m === null) throw new Error('--child k/n'); a.child = [Number(m[1]), Number(m[2])]; k++; break; }
      default: throw new Error(`unknown argument ${argv[k]}`);
    }
  }
  return a;
}

interface DJob { level: number; idx: number; job: JobSpec }

/** UI 10 first (slowest), so the children drain evenly. */
function jobList(a: Args): DJob[] {
  const out: DJob[] = [];
  for (const [level, n] of [[10, a.ui10], [7, a.ui7], [5, a.ui5]] as const) {
    if (n <= 0) continue;
    const js = pairedJobs({ stocks: a.stocks, frameCap: 5400 * a.stocks, a: ui(level), b: ui(level), chars: [TREK, AEVAL] },
      pairTag(ui(level), ui(level), `trekbal|s${a.stocks}`), n);
    js.forEach((job, idx) => out.push({ level, idx, job }));
  }
  return out;
}

interface Row {
  level: number; idx: number; winner: number; timeout: boolean; frames: number; stocksLost: number[]; sds: number[];
  /** Percent of the victim on the frame before each KO: Trekmore's KOs on Aeval, Aeval's on Trekmore. */
  trekKoPct: number[]; aevalKoPct: number[];
  /** Openings and damage each way (index 0 Trekmore as attacker, 1 Aeval). */
  openings: number[]; damage: number[];
  koBy: Record<string, number>; usage: Record<string, number>; sdCause: Record<string, number>;
  /** Trekmore's state on the frame before each Aeval opening on him (attack moves split startup, active, endlag). */
  openedIn: Record<string, number>; ms: number;
}

const STUN: Readonly<Record<string, true>> = {
  hitstun: true, tumble: true, grabbed: true, footstooled: true, finalSmashVictim: true, thrown: true,
};

/** Folds a hit source into its move: echo hits and the sword's projectiles. */
function moveOfSource(src: string | undefined): string {
  if (src === undefined || src === '') return 'unknown';
  if (src.startsWith('echo:')) return src.slice(5);
  if (src === 'shadowSword' || src === 'shadowBurst') return 'nspecial';
  return src;
}

function bump(m: Record<string, number>, k: string, by = 1): void { m[k] = (m[k] ?? 0) + by; }

function runOne(d: DJob): Row {
  const job = d.job;
  const refs = refsOf(job);
  const factories = refs.map(resolveBrain);
  const row: Row = { level: d.level, idx: d.idx, winner: -1, timeout: false, frames: 0, stocksLost: [], sds: [],
    trekKoPct: [], aevalKoPct: [], openings: [0, 0], damage: [0, 0], koBy: {}, usage: {}, sdCause: {}, openedIn: {}, ms: 0 };
  const inner = factories[0];
  let me = -1;
  let foe = -1;
  const prevAct: string[] = [];
  const prevPct: number[] = [];
  let prevMove: string | null = null;
  let prevAF = 0;
  let prevKos = 0;
  let prevSds = 0;
  let lastSrc = '';
  let lastSrcFrame = -1e9;
  let lastMove = '';
  let lastMoveFrame = -1e9;
  let lastRecallFrame = -1e9;
  let seenTrekDeaths = 0;
  let seenAevalDeaths = 0;
  let lastFrame = 0;
  let prevAir = false;
  const stateName = (): string => {
    const act = prevAct[me] ?? 'idle';
    if (act !== 'attack' || prevMove === null) return `${act}${prevAir ? '(air)' : ''}`;
    const mv = CHARACTER_DEFS[TREK].moves[prevMove as keyof typeof CHARACTER_DEFS[string]['moves']];
    let first = Infinity, last = -1;
    if (mv !== undefined) for (const h of mv.hitboxes) { if (h.start < first) first = h.start; if (h.end > last) last = h.end; }
    return `${prevMove}-${prevAF < first ? 'startup' : prevAF > last ? 'endlag' : 'active'}`;
  };
  const sdCauseAt = (frame: number): string => {
    if (frame - lastRecallFrame <= SD_BLAME) return 'recall';
    if (lastMove === 'dair' && frame - lastMoveFrame <= SD_BLAME) return 'dair';
    return `other:${lastMove || '-'}`;
  };
  const trek: BrainFactory = {
    name: inner.name, spec: inner.spec, reset: () => inner.reset(),
    create() {
      const g = inner.create();
      return (s: GameState, slot: number, out: InputFrame): InputFrame => {
        me = slot; foe = 1 - slot;
        const f = s.fighters[slot];
        lastFrame = s.frame;
        for (const e of s.events) {
          if (e.type === 'hit' && e.attacker !== e.victim) {
            const w = e.attacker === slot ? 0 : 1;
            if (STUN[prevAct[e.victim] ?? 'idle'] !== true) {
              row.openings[w]++;
              if (w === 1) bump(row.openedIn, stateName());
            }
            row.damage[w] += e.damage;
            if (w === 0) { lastSrc = moveOfSource(e.source); lastSrcFrame = s.frame; };
          } else if (e.type === 'grab' && e.attacker !== e.victim) {
            const w = e.attacker === slot ? 0 : 1;
            if (STUN[prevAct[e.victim] ?? 'idle'] !== true) {
              row.openings[w]++;
              if (w === 1) bump(row.openedIn, stateName());
            }
            if (w === 0) { lastSrc = 'grab'; lastSrcFrame = s.frame; }
          } else if (e.type === 'teleport' && e.slot === slot && e.kind === 'recall') {
            lastRecallFrame = s.frame;
          } else if (e.type === 'ko') {
            if (e.slot === slot) {
              seenTrekDeaths++;
              row.aevalKoPct.push(prevPct[slot] ?? 0);
              if (f.stats.sds > prevSds) bump(row.sdCause, sdCauseAt(s.frame));
            } else {
              seenAevalDeaths++;
              row.trekKoPct.push(prevPct[e.slot] ?? 0);
              if (f.stats.kos > prevKos) bump(row.koBy, lastSrc || 'unknown');
            }
          }
        }
        prevKos = f.stats.kos; prevSds = f.stats.sds;
        // Move usage: an attack start (a new move, or the same move restarted).
        if (f.action === 'attack' && f.moveId !== null && (prevAct[slot] !== 'attack' || f.moveId !== prevMove || f.actionFrame < prevAF)) {
          bump(row.usage, f.moveId);
          lastMove = f.moveId; lastMoveFrame = s.frame;
        } else if (f.action === 'grab' && prevAct[slot] !== 'grab') {
          bump(row.usage, 'grab');
          lastMove = 'grab'; lastMoveFrame = s.frame;
        }
        prevMove = f.moveId; prevAF = f.actionFrame; prevAir = !f.onGround;
        for (let i = 0; i < s.fighters.length; i++) { prevAct[i] = s.fighters[i].action; prevPct[i] = s.fighters[i].percent; }
        return g(s, slot, out);
      };
    },
  };
  const wrapped = factories.map((fac, p) => hintFactory(p === 0 ? trek : fac, hintFor(refs[p], job.chars?.[p])));
  const spec: MatchSpec = { seed: job.seed, stageId: job.stageId, stocks: job.stocks, frameCap: job.frameCap,
    a: wrapped[0], b: wrapped[1], swap: job.swap, record: false };
  const t0 = performance.now();
  const r = runMatch(spec);
  row.ms = performance.now() - t0;
  // The KO that ends the match is on the last step, which no brain call observes.
  if (r.stocksLost[0] > seenTrekDeaths) {
    row.aevalKoPct.push(prevPct[me] ?? 0);
    if (r.sds[0] > prevSds) bump(row.sdCause, sdCauseAt(r.frames));
  }
  if (r.stocksLost[1] > seenAevalDeaths) {
    row.trekKoPct.push(prevPct[foe] ?? 0);
    if (lastFrame - lastSrcFrame < RECENT) bump(row.koBy, lastSrc || 'unknown');
  }
  row.winner = r.winner; row.timeout = r.timeout; row.frames = r.frames;
  row.stocksLost = r.stocksLost.slice(); row.sds = r.sds.slice();
  return row;
}

const LINE = '@@TREK ';

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const jobs = jobList(a);
  if (a.child !== null) {
    const [k, n] = a.child;
    for (let i = k; i < jobs.length; i += n) process.stdout.write(`${LINE}${JSON.stringify(runOne(jobs[i]))}\n`);
    return;
  }
  const api = await loadNode();
  const root = repoRoot(api);
  const file = api.join(root, 'src', 'ai', 'eval', 'diag', 'trekbalance.ts');
  const pass = process.argv.slice(2);
  const n = Math.max(1, Math.min(a.procs, jobs.length));
  const t0 = performance.now();
  const outs = await runLimited(Array.from({ length: n }, (_x, k) => async () => {
    const c = tsxCommand(file, [...pass, '--child', `${k}/${n}`]);
    return runChild(api, c.cmd, c.args, root);
  }), n);
  const rows: Row[] = [];
  for (const o of outs) {
    for (const l of o.out.split(/\r?\n/)) if (l.startsWith(LINE)) rows.push(JSON.parse(l.slice(LINE.length)) as Row);
    if (o.code !== 0) process.stdout.write(`child exit ${o.code}: ${o.err.split(/\r?\n/).slice(-4).join(' | ')}\n`);
  }
  report(rows, (performance.now() - t0) / 1000, a.stocks);
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;
const mean = (xs: readonly number[]): number => (xs.length > 0 ? xs.reduce((p, q) => p + q, 0) / xs.length : NaN);

function shares(m: Record<string, number>, top = 8): string {
  const total = Object.values(m).reduce((p, q) => p + q, 0);
  if (total === 0) return 'none';
  return Object.entries(m).sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).slice(0, top)
    .map(([k, v]) => `${k} ${v} (${pct(v / total)})`).join(', ');
}

function merge(rows: readonly Row[], key: 'koBy' | 'usage' | 'sdCause' | 'openedIn'): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r[key])) bump(m, k, v);
  return m;
}

function report(rows: Row[], wall: number, stocks: number): void {
  const out: string[] = [];
  out.push(`Trekmore vs Aeval, same UI level, ${stocks} stocks, paired seeds with side swap, both stages; timeouts count half`);
  out.push('');
  out.push('| UI | n | W-L-T | score | Wilson 95% | KO % T on A | KO % A on T | dmg/opening T | dmg/opening A | openings T/A | T SDs (dair/recall/other) | A SDs |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  const levels = [...new Set(rows.map((r) => r.level))].sort((x, y) => y - x);
  for (const lv of [7, 5, 10].filter((x) => levels.includes(x))) {
    const rs = rows.filter((r) => r.level === lv).sort((x, y) => x.idx - y.idx);
    const w = rs.filter((r) => r.winner === 0).length, l = rs.filter((r) => r.winner === 1).length, t = rs.length - w - l;
    const score = w + 0.5 * t;
    const wi = wilson(score, rs.length);
    const op = [0, 1].map((k) => rs.reduce((p, r) => p + r.openings[k], 0));
    const dm = [0, 1].map((k) => rs.reduce((p, r) => p + r.damage[k], 0));
    const sd = merge(rs, 'sdCause');
    const sdT = rs.reduce((p, r) => p + r.sds[0], 0), sdA = rs.reduce((p, r) => p + r.sds[1], 0);
    const other = Object.entries(sd).filter(([k]) => k.startsWith('other')).reduce((p, [, v]) => p + v, 0);
    out.push(`| ${lv} | ${rs.length} | ${w}-${l}-${t} | ${score}/${rs.length} (${pct(score / rs.length)}) | ${wi.lo.toFixed(3)} to ${wi.hi.toFixed(3)} | ` +
      `${mean(rs.flatMap((r) => r.trekKoPct)).toFixed(0)} | ${mean(rs.flatMap((r) => r.aevalKoPct)).toFixed(0)} | ` +
      `${(dm[0] / op[0]).toFixed(1)} | ${(dm[1] / op[1]).toFixed(1)} | ${op[0]}/${op[1]} | ` +
      `${sdT} (${sd.dair ?? 0}/${sd.recall ?? 0}/${other}) | ${sdA} |`);
  }
  for (const lv of [7, 5, 10].filter((x) => levels.includes(x))) {
    const rs = rows.filter((r) => r.level === lv);
    out.push('');
    out.push(`UI ${lv}: Trekmore KOs by move: ${shares(merge(rs, 'koBy'), 10)}`);
    out.push(`UI ${lv}: Trekmore move usage: ${shares(merge(rs, 'usage'), 12)}`);
    out.push(`UI ${lv}: Trekmore SD causes: ${shares(merge(rs, 'sdCause'), 8)}`);
    out.push(`UI ${lv}: Trekmore state when Aeval opened him: ${shares(merge(rs, 'openedIn'), 14)}`);
  }
  const ms = rows.map((r) => r.ms);
  out.push('');
  out.push(`wall ${wall.toFixed(0)} s, ${rows.length} jobs, slowest ${(Math.max(0, ...ms) / 1000).toFixed(0)} s`);
  process.stdout.write(`${out.join('\n')}\n`);
}

main().catch((e: unknown) => {
  process.stdout.write(`trekbalance error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
});
