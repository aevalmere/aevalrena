/**
 * God-strength diagnostic (docs/CPU_STRENGTH_LEDGER.md). Fast, deterministic, parallel:
 *
 *   npx --yes tsx src/ai/eval/diag/strength.ts [--h2h 22] [--v3 20] [--v3stocks 3] [--dummy 4]
 *     [--procs 11] [--only h2h,v3,dummy] [--gate]
 *
 * (a) new god vs legacy god (aevalmere.ts), paired seeds with side swap, 3 stocks;
 * (b) new god alone vs three teamed new-engine UI 4 CPUs;
 * (c) new god vs the stationary dummy, median 3-stock frame;
 * (d) the god's deaths: percent at the KO, the move of the last hit it took and the god's own state
 *     on the frame before that hit (air, endlag, landlag, startup, shield, ledge, dodge, helpless,
 *     stun, ground), and the percent of the enemies the god KO'd (conversion percent).
 * --gate plays the 1v3 on the seeds of the harness case team.1v3.l4 (cases/teams.ts oneVsMany tag),
 * so --only v3 --v3 73 --gate reproduces the god tier gate in parallel.
 * Determinism: the first h2h job runs twice in different processes; the input hashes must match.
 *
 * The parent spawns `--procs` children (`--child k/n`), each runs every n-th job and prints one
 * JSON line per job; the parent aggregates and prints the tables.
 */
import { CHARACTER_DEFS } from '../../../characters/registry';
import type { FighterState, GameState, InputFrame } from '../../../core/types';
import type { BrainFactory, MatchSpec } from '../../contracts';
import { isLedgeAction } from '../../../sim/ledge';
import { hintFactory, runMatch, setBrainEngine } from '../runner';
import {
  GOD, hintFor, refLabel, loadNode, pairedJobs, pairTag, refsOf, repoRoot, resolveBrain, runChild, runLimited, setEngineMode,
  teamsOf, tsxCommand, ui, adv, type JobSpec,
} from '../pool';
import { med, teamOutcome } from '../cases/common';
import { wilson } from '../stats';
import { brainInput, brainStats, resetBrain, warmBrain } from '../../brain';

declare const process: { argv: string[]; stdout: { write(text: string): void }; exitCode?: number };

setBrainEngine({ brainInput, warmBrain, resetBrain });
setEngineMode('new');

interface Args { h2h: number; v3: number; v3stocks: number; dummy: number; procs: number; only: string[]; child: [number, number] | null; gate: boolean }

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { h2h: 22, v3: 20, v3stocks: 3, dummy: 4, procs: 11, only: [], child: null, gate: false };
  for (let k = 0; k < argv.length; k++) {
    const v = argv[k + 1];
    switch (argv[k]) {
      case '--h2h': a.h2h = Number(v); k++; break;
      case '--v3': a.v3 = Number(v); k++; break;
      case '--v3stocks': a.v3stocks = Number(v); k++; break;
      case '--dummy': a.dummy = Number(v); k++; break;
      case '--procs': a.procs = Number(v); k++; break;
      case '--gate': a.gate = true; break;
      case '--only': a.only = (v ?? '').split(',').filter((s) => s !== ''); k++; break;
      case '--child': { const m = /^(\d+)\/(\d+)$/.exec(v ?? ''); if (m === null) throw new Error('--child k/n'); a.child = [Number(m[1]), Number(m[2])]; k++; break; }
      default: throw new Error(`unknown argument ${argv[k]}`);
    }
  }
  return a;
}

interface DJob { kind: 'h2h' | 'v3' | 'dummy' | 'det'; idx: number; job: JobSpec }

/** Heaviest kinds first so the children drain evenly. */
function jobList(a: Args): DJob[] {
  const want = (k: string): boolean => a.only.length === 0 || a.only.includes(k);
  const out: DJob[] = [];
  if (want('v3')) {
    const foes = [ui(4), ui(4), ui(4)];
    const js = pairedJobs({ stocks: a.v3stocks, frameCap: 5400 * a.v3stocks, a: GOD, b: foes[0],
      extras: foes.slice(1).map((ref) => ({ ref, team: 1 })) }, pairTag(GOD, foes[0], a.gate ? `team.1v3.l4|${foes.map(refLabel).join(',')}|s${a.v3stocks}` : `diag1v3|s${a.v3stocks}`), a.v3);
    js.forEach((job, idx) => out.push({ kind: 'v3', idx, job }));
  }
  if (want('h2h')) {
    const leg = { k: 'legacy' as const, level: 10 };
    const js = pairedJobs({ stocks: 3, frameCap: 5400 * 3, a: GOD, b: leg }, pairTag(GOD, leg, 'diagh2h'), a.h2h);
    js.forEach((job, idx) => out.push({ kind: 'h2h', idx, job }));
    if (js.length > 0) out.push({ kind: 'det', idx: 0, job: js[0] });
  }
  if (want('dummy')) {
    const d = adv('stationary', 'kill-stationary');
    const js = pairedJobs({ stocks: 3, frameCap: 7200, a: GOD, b: d }, pairTag(GOD, d, 'diagdummy'), a.dummy);
    js.forEach((job, idx) => out.push({ kind: 'dummy', idx, job }));
  }
  return out;
}

interface Death { pct: number; move: string; state: string; frame: number; opener: string; plan: string }
interface Row {
  kind: string; idx: number; winner: number; frames: number; timeout: boolean; hash: string; stocksLost: number[];
  deaths: Death[]; kills: number[]; dummyKos: number[]; dealt: number; taken: number; ms: number;
}

/** The god's state on the frame before a hit. */
function stateOf(f: FighterState, air: boolean, action: string, moveId: string | null, actionFrame: number): string {
  if (isLedgeAction(f.action) || action.startsWith('ledge')) return 'ledge';
  switch (action) {
    case 'shield': case 'shieldStun': case 'shieldBreak': return 'shield';
    case 'land': return 'landlag';
    case 'airHelpless': return 'helpless';
    case 'airDodge': case 'roll': case 'spotDodge': return 'dodge';
    case 'hitstun': case 'tumble': case 'grabbed': case 'downed': case 'footstooled': return 'stun';
    case 'grab': return 'grabWhiff';
    case 'attack': {
      const mv = moveId !== null ? CHARACTER_DEFS[f.charId].moves[moveId as keyof typeof CHARACTER_DEFS[string]['moves']] : undefined;
      let first = Infinity, last = -1;
      if (mv !== undefined) for (const h of mv.hitboxes) { if (h.start < first) first = h.start; if (h.end > last) last = h.end; }
      const ph = actionFrame < first ? 'startup' : actionFrame > last ? 'endlag' : 'active';
      return `${air ? 'air' : 'gnd'}-${ph}`;
    }
    default: return air ? 'air' : 'ground';
  }
}

function runOne(d: DJob): Row {
  const job = d.job;
  const refs = refsOf(job);
  const factories = refs.map(resolveBrain);
  const row: Row = { kind: d.kind, idx: d.idx, winner: -1, frames: 0, timeout: false, hash: '', stocksLost: [], deaths: [],
    kills: [], dummyKos: [], dealt: 0, taken: 0, ms: 0 };
  // Observer around player 0 (the new god): reads the live state before its own input each frame.
  const inner = factories[0];
  let prevAct = 'idle', prevMove: string | null = null, prevAF = 0, prevAir = false, prevPct = 0;
  const pctPrev: number[] = [];
  const seenKo: number[] = [];
  let godSlot = -1;
  let lastHit: { move: string; state: string; frame: number } | null = null;
  let opener = '-';
  let prevPlan = '';
  const god: BrainFactory = {
    name: inner.name, spec: inner.spec, reset: () => inner.reset(),
    create() {
      const g = inner.create();
      return (s: GameState, slot: number, out: InputFrame): InputFrame => {
        const me = s.fighters[slot];
        godSlot = slot;
        for (const e of s.events) {
          if (e.type === 'hit') {
            if (e.victim === slot && e.attacker !== slot) {
              row.taken += e.damage;
              const a = s.fighters[e.attacker];
              const mv = a === undefined ? 'unknown' : a.action === 'attack' ? (a.moveId ?? 'attack')
                : a.action === 'throw' ? `throw` : `other:${a.action}`;
              const st = stateOf(me, prevAir, prevAct, prevMove, prevAF);
              // The opener: the first hit taken while the god was free (not already in a string).
              if (st !== 'stun') opener = `${st}/${mv}`;
              lastHit = { move: mv, state: st, frame: s.frame };
            } else if (e.attacker === slot && e.victim !== slot) row.dealt += e.damage;
          } else if (e.type === 'ko') {
            if (e.slot === slot) {
              const lh = lastHit as { move: string; state: string; frame: number } | null;
              const recent = lh !== null && s.frame - lh.frame < 240;
              row.deaths.push({ pct: prevPct, move: recent && lh !== null ? lh.move : 'sd', state: recent && lh !== null ? lh.state : '-',
                frame: s.frame, opener: recent ? opener : `sd:${prevPlan}`, plan: prevPlan });
              lastHit = null;
            } else {
              seenKo[e.slot] = (seenKo[e.slot] ?? 0) + 1;
              const pp = pctPrev[e.slot] ?? 0;
              if (d.kind === 'dummy') row.dummyKos.push(s.frame); else row.kills.push(pp);
            }
          }
        }
        prevPlan = brainStats(slot).plan;
        prevAct = me.action; prevMove = me.moveId; prevAF = me.actionFrame; prevAir = !me.onGround; prevPct = me.percent;
        for (let i = 0; i < s.fighters.length; i++) pctPrev[i] = s.fighters[i].percent;
        return g(s, slot, out);
      };
    },
  };
  const wrapped = factories.map((f, p) => hintFactory(p === 0 ? god : f, hintFor(refs[p])));
  const spec: MatchSpec = { seed: job.seed, stageId: job.stageId, stocks: job.stocks, frameCap: job.frameCap,
    a: wrapped[0], b: wrapped[1], swap: job.swap, record: false };
  if (job.extras !== undefined) spec.extraPlayers = job.extras.map((x, i) => ({ factory: wrapped[2 + i], team: x.team }));
  const t0 = performance.now();
  const r = runMatch(spec);
  row.ms = performance.now() - t0;
  row.winner = job.extras !== undefined ? teamOutcome(r, teamsOf(job), job.stocks) : r.winner;
  // The KO that ends the match is on the last step, which no brain call observes.
  const slotOf = (p: number): number => (p < 2 && job.swap ? 1 - p : p);
  for (let p = 0; p < r.stocksLost.length; p++) {
    const sl = slotOf(p);
    if (sl === godSlot) {
      if (r.stocksLost[p] > row.deaths.length) {
        const lh = lastHit as { move: string; state: string; frame: number } | null;
        const recent = lh !== null && r.frames - lh.frame < 240;
        row.deaths.push({ pct: prevPct, move: recent && lh !== null ? lh.move : 'sd', state: recent && lh !== null ? lh.state : '-',
          frame: r.frames, opener: recent ? opener : `sd:${prevPlan}`, plan: prevPlan });
      }
    } else if (r.stocksLost[p] > (seenKo[sl] ?? 0)) {
      if (d.kind === 'dummy') row.dummyKos.push(r.frames); else row.kills.push(pctPrev[sl] ?? 0);
    }
  }
  row.frames = r.frames; row.timeout = r.timeout; row.hash = r.inputHash[0]; row.stocksLost = r.stocksLost.slice();
  return row;
}

const LINE = '@@DIAG ';

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
  const file = api.join(root, 'src', 'ai', 'eval', 'diag', 'strength.ts');
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
  report(rows, (performance.now() - t0) / 1000, a);
}

function report(rows: Row[], wall: number, a: Args): void {
  const of = (k: string): Row[] => rows.filter((r) => r.kind === k).sort((x, y) => x.idx - y.idx);
  const out: string[] = [];
  const h2h = of('h2h');
  if (h2h.length > 0) {
    const w = h2h.filter((r) => r.winner === 0).length, l = h2h.filter((r) => r.winner === 1).length;
    out.push(`(a) h2h new god vs legacy god, 3 stocks: won ${w}/${h2h.length}, lost ${l}, draws ${h2h.length - w - l}` +
      `; stocks lost new/legacy ${sum(h2h.map((r) => r.stocksLost[0]))}/${sum(h2h.map((r) => r.stocksLost[1]))}`);
  }
  const v3 = of('v3');
  if (v3.length > 0) {
    const w = v3.filter((r) => r.winner === 0).length, l = v3.filter((r) => r.winner === 1).length;
    out.push(`(b) 1v3 vs UI4 teamed, ${a.v3stocks} stocks: won ${w}/${v3.length} (wilson lb ${wilson(w, v3.length).lo.toFixed(3)}), lost ${l}, timeouts ${v3.length - w - l}` +
      `; god stocks lost ${sum(v3.map((r) => r.stocksLost[0]))}, dealt/taken ${sum(v3.map((r) => r.dealt)).toFixed(0)}/${sum(v3.map((r) => r.taken)).toFixed(0)}`);
  }
  const dm = of('dummy');
  if (dm.length > 0) {
    const three = dm.map((r) => (r.dummyKos.length >= 3 ? r.dummyKos[2] : 7200));
    out.push(`(c) stationary dummy: median 3-stock frame ${med(three)} (${three.join(' ')}); god deaths ${dm.map((r) => r.deaths.length).join(' ')}` +
      ` (${dm.flatMap((r) => r.deaths.map((x) => x.opener)).join(', ')})`);
  }
  const det = of('det');
  if (det.length > 0 && h2h.length > 0) out.push(`det: h2h[0] input hash ${det[0].hash === h2h[0].hash ? 'MATCH' : `DIFFER ${det[0].hash} vs ${h2h[0].hash}`}`);
  for (const [label, rs] of [['h2h', h2h], ['v3', v3]] as const) {
    if (rs.length === 0) continue;
    const deaths = rs.flatMap((r) => r.deaths);
    const kills = rs.flatMap((r) => r.kills);
    out.push(`(d) ${label}: ${deaths.length} deaths, median death pct ${med(deaths.map((x) => x.pct)).toFixed(0)}; ` +
      `${kills.length} kills, median conversion pct ${med(kills).toFixed(0)}`);
    out.push(`    by state: ${hist(deaths.map((x) => x.state))}`);
    out.push(`    by move:  ${hist(deaths.map((x) => x.move))}`);
    out.push(`    state x move: ${hist(deaths.map((x) => `${x.state}/${x.move}`), 10)}`);
    out.push(`    opener (state/move, or sd:plan): ${hist(deaths.map((x) => x.opener), 12)}`);
  }
  const ms = rows.map((r) => r.ms);
  out.push(`wall ${wall.toFixed(0)} s, ${rows.length} jobs, slowest ${(Math.max(0, ...ms) / 1000).toFixed(0)} s`);
  process.stdout.write(`${out.join('\n')}\n`);
}

function sum(xs: number[]): number { return xs.reduce((p, q) => p + q, 0); }

function hist(xs: string[], top = 12): string {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).slice(0, top).map(([k, v]) => `${k} ${v}`).join(', ');
}

main().catch((e: unknown) => {
  process.stdout.write(`diag error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
});
