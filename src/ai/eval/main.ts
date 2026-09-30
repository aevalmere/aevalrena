/**
 * CPU harness entry (plan 4.5 and section 5 R2).
 *
 *   npx --yes tsx src/ai/eval/main.ts --tier fast|full|god|nightly [--only <id or group>[,...]]
 *     [--engine auto|legacy|new] [--jobs N] [--shard i/n]
 *
 * Tiers pick the cases and their counts; every tier runs one child process per case, at most
 * `--jobs` at once (default cores - 1, capped at 11), and `--jobs 1` runs everything in this process
 * (unit files and aitest still go to child processes alongside). god runs the god's gates
 * (cases/index.ts GOD_CASE_IDS) at the guide's counts, which is the nightly Tier of the contract. `--shard i/n` runs every n-th case from
 * i in this process and prints each result as a GATE_LINE, which is how a parent collects results;
 * since a match is a pure function of its spec, results do not depend on the shard count.
 *
 * Engine: auto (default) loads src/ai/brain.ts when it exists and exports the engine entry points,
 * then uses the new engine when registered and the legacy brain otherwise. `--engine new` without a
 * registered engine reports every engine-dependent case as "engine not registered" (info), not as a
 * failure.
 *
 * Exit code: 1 when any gated (non-info) case fails, else 0.
 */
import type { GateResult, TestCase, Tier } from '../contracts';
import { setBrainEngine, type BrainEngine } from './runner';
import '../characters/index';
import { CASE_GROUPS, GOD_CASE_IDS, TEST_CASES } from './cases/index';
import { isLaunchCase } from './cases/legacy';
import {
  EngineNotRegisteredError, engineMode, engineRegistered, GATE_LINE, loadNode, repoRoot, runChild, runLimited,
  setEngineMode, tsxCommand, type NodeApi,
} from './pool';

declare const process: {
  argv: string[];
  stdout: { write(text: string): void };
  exitCode?: number;
};

type CliTier = 'fast' | 'full' | 'god' | 'nightly';
type EngineArg = 'auto' | 'legacy' | 'new';

interface Args { tier: CliTier; only: string[]; engine: EngineArg; jobs: number; shard: { i: number; n: number } | null }

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { tier: 'fast', only: [], engine: 'auto', jobs: 0, shard: null };
  for (let k = 0; k < argv.length; k++) {
    const v = argv[k + 1];
    switch (argv[k]) {
      case '--tier':
        if (v !== 'fast' && v !== 'full' && v !== 'god' && v !== 'nightly') throw new Error(`--tier fast|full|god|nightly, got ${v}`);
        a.tier = v; k++; break;
      case '--only': a.only.push(...(v ?? '').split(',').filter((s) => s !== '')); k++; break;
      case '--engine':
        if (v !== 'auto' && v !== 'legacy' && v !== 'new') throw new Error(`--engine auto|legacy|new, got ${v}`);
        a.engine = v; k++; break;
      case '--jobs': a.jobs = Math.max(1, Number(v) | 0); k++; break;
      case '--shard': {
        const m = /^(\d+)\/(\d+)$/.exec(v ?? '');
        if (m === null || Number(m[2]) < 1 || Number(m[1]) >= Number(m[2])) throw new Error(`--shard i/n with 0 <= i < n, got ${v}`);
        a.shard = { i: Number(m[1]), n: Number(m[2]) }; k++; break;
      }
      default: throw new Error(`unknown argument ${argv[k]}`);
    }
  }
  return a;
}

function contractTier(t: CliTier): Tier { return t === 'god' || t === 'nightly' ? 'nightly' : t; }

/** Cases of the tier, narrowed by --only (case ids or group names). */
function selectCases(args: Args): TestCase[] {
  const tier = contractTier(args.tier);
  let cs = TEST_CASES.filter((c) => c.tiers.includes(tier));
  if (args.tier === 'god') cs = cs.filter((c) => GOD_CASE_IDS.includes(c.id));
  if (args.only.length > 0) {
    const want = new Set<string>();
    for (const o of args.only) {
      const g = CASE_GROUPS[o];
      if (g !== undefined) for (const c of g) want.add(c.id);
      else want.add(o);
    }
    const known = new Set(TEST_CASES.map((c) => c.id));
    const unknown = [...want].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`unknown case ${unknown.join(', ')}; known: ${[...known].join(' ')}`);
    // An explicit --only runs the case even when the tier does not list it.
    cs = TEST_CASES.filter((c) => want.has(c.id));
  }
  return cs;
}

/** Loads src/ai/brain.ts when present and registers it when it exports the three entry points. */
async function tryRegisterEngine(api: NodeApi): Promise<string> {
  const path = api.join(repoRoot(api), 'src', 'ai', 'brain.ts');
  if (!api.existsSync(path)) return 'src/ai/brain.ts not present';
  try {
    const url = new URL('../brain.ts', import.meta.url).href;
    const m = (await import(/* @vite-ignore */ url)) as Partial<BrainEngine>;
    if (typeof m.brainInput === 'function' && typeof m.warmBrain === 'function' && typeof m.resetBrain === 'function') {
      if (!engineRegistered()) setBrainEngine({ brainInput: m.brainInput, warmBrain: m.warmBrain, resetBrain: m.resetBrain });
      return 'registered from src/ai/brain.ts';
    }
    return 'src/ai/brain.ts lacks brainInput, warmBrain or resetBrain';
  } catch (e) {
    return `src/ai/brain.ts failed to load: ${String(e).slice(0, 160)}`;
  }
}

function isEngineMissing(e: unknown): boolean {
  return e instanceof EngineNotRegisteredError || (e instanceof Error && /no engine registered/.test(e.message));
}

interface Timed { gate: GateResult; ms: number }

/** Runs one case, turning a missing engine into an info row and any other throw into a failure. */
async function runCase(c: TestCase, tier: Tier, api: NodeApi, shard: number, shards: number): Promise<Timed> {
  const t0 = performance.now();
  let g: GateResult;
  try {
    g = isLaunchCase(c) ? await c.launch(api, { tier }) : c.run({ tier, shard, shards });
  } catch (e) {
    g = isEngineMissing(e)
      ? { id: c.id, pass: true, info: true, detail: `[${engineMode()}] engine not registered`, metrics: {} }
      : { id: c.id, pass: false, info: false, detail: `[${engineMode()}] threw: ${e instanceof Error ? (e.stack ?? e.message).split('\n').slice(0, 3).join(' | ') : String(e)}`, metrics: {} };
  }
  return { gate: g, ms: performance.now() - t0 };
}

/** Cases known to take longest under the legacy brain (measured), scheduled first in the pool. */
const HEAVY: readonly string[] = ['aitest.all', 'team.1v3.l1to3', 'team.1v3.l4', 'av', 'au', 'team.1v2.l5', 'unit', 'az.god', 'az',
  'ffa.god', 'ax', 'at'];
/** Cases that measure wall-clock cost: run alone after the pool, never next to other matches. */
const SOLO: readonly string[] = ['perf', 'perf.4p'];
function heavyRank(id: string): number { const i = HEAVY.indexOf(id); return i < 0 ? HEAVY.length : i; }

const yieldLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Child process per case, results read back from GATE_LINE lines. */
async function runInChildren(api: NodeApi, cases: readonly TestCase[], args: Args, mode: string, jobs: number): Promise<Timed[]> {
  const root = repoRoot(api);
  const main = api.join(root, 'src', 'ai', 'eval', 'main.ts');
  return runLimited(cases.map((c) => async (): Promise<Timed> => {
    const cmd = tsxCommand(main, ['--tier', args.tier, '--only', c.id, '--engine', mode, '--shard', '0/1']);
    const r = await runChild(api, cmd.cmd, cmd.args, root);
    const line = r.out.split(/\r?\n/).find((l) => l.startsWith(GATE_LINE));
    if (line === undefined) {
      const tail = `${r.out}\n${r.err}`.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300);
      return { gate: { id: c.id, pass: false, info: false, detail: `child exit ${r.code} without a result: ${tail}`, metrics: {} }, ms: r.ms };
    }
    return JSON.parse(line.slice(GATE_LINE.length)) as Timed;
  }), jobs);
}

function status(g: GateResult): string {
  if (g.info) return g.pass ? 'INFO' : 'info-fail';
  return g.pass ? 'PASS' : 'FAIL';
}

function printTable(rows: readonly Timed[]): void {
  const idW = Math.max(4, ...rows.map((r) => r.gate.id.length));
  const out: string[] = [];
  out.push(`${'case'.padEnd(idW)}  ${'result'.padEnd(9)}  ${'sec'.padStart(6)}  detail`);
  out.push(`${'-'.repeat(idW)}  ${'-'.repeat(9)}  ${'-'.repeat(6)}  ${'-'.repeat(40)}`);
  for (const r of rows) {
    out.push(`${r.gate.id.padEnd(idW)}  ${status(r.gate).padEnd(9)}  ${(r.ms / 1000).toFixed(1).padStart(6)}  ${r.gate.detail}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const api = await loadNode();
  const t0 = performance.now();
  const engineNote = args.engine === 'legacy' ? 'legacy requested' : await tryRegisterEngine(api);
  const registered = engineRegistered();
  const mode = args.engine === 'legacy' ? 'legacy' : args.engine === 'new' ? 'new' : registered ? 'new' : 'legacy';
  setEngineMode(mode);
  const tier = contractTier(args.tier);
  const cases = selectCases(args);

  if (args.shard !== null) {
    // Child or manual shard: results as GATE_LINE JSON, nothing else parsed.
    const { i, n } = args.shard;
    const mine = cases.filter((_c, k) => k % n === i);
    for (const c of mine) {
      const r = await runCase(c, tier, api, i, n);
      process.stdout.write(`${GATE_LINE}${JSON.stringify(r)}\n`);
    }
    return;
  }

  process.stdout.write(`CPU harness: tier ${args.tier} (contract tier ${tier}), engine ${mode}` +
    ` (${registered ? 'registered' : 'not registered'}; ${engineNote}), ${cases.length} cases\n`);

  const jobs = args.jobs > 0 ? args.jobs : Math.max(1, Math.min(11, api.cpuCount - 1));
  let rows: Timed[];
  if (jobs === 1) {
    // One process: launch cases start first so their child processes use other cores meanwhile.
    const launched = cases.map((c) => (isLaunchCase(c) ? runCase(c, tier, api, 0, 1) : null));
    rows = new Array<Timed>(cases.length);
    for (let k = 0; k < cases.length; k++) {
      if (launched[k] !== null) continue;
      await yieldLoop();
      rows[k] = await runCase(cases[k], tier, api, 0, 1);
      process.stdout.write(`  ${cases[k].id} ${status(rows[k].gate)} ${(rows[k].ms / 1000).toFixed(1)}s
`);
    }
    for (let k = 0; k < cases.length; k++) {
      const p = launched[k];
      if (p !== null) rows[k] = await p;
    }
  } else {
    process.stdout.write(`  ${jobs} processes, one case each
`);
    // Longest cases start first so the pool drains evenly; rows go back to list order. Wall-clock
    // cost cases wait for the pool to drain and run here alone, since a loaded machine inflates them.
    const all = cases.map((c, k) => ({ c, k }));
    const order = all.filter((o) => !SOLO.includes(o.c.id))
      .sort((x, y) => heavyRank(x.c.id) - heavyRank(y.c.id) || x.k - y.k);
    const got = await runInChildren(api, order.map((o) => o.c), args, mode, jobs);
    rows = new Array<Timed>(cases.length);
    order.forEach((o, j) => { rows[o.k] = got[j]; });
    for (const o of all) {
      if (!SOLO.includes(o.c.id)) continue;
      rows[o.k] = await runCase(o.c, tier, api, 0, 1);
    }
  }

  const wall = (performance.now() - t0) / 1000;
  process.stdout.write('\n');
  printTable(rows);
  const gated = rows.filter((r) => !r.gate.info);
  const failed = gated.filter((r) => !r.gate.pass);
  const info = rows.length - gated.length;
  process.stdout.write(`\n${gated.length - failed.length}/${gated.length} gated pass, ${info} info, ${failed.length} fail;` +
    ` wall ${wall.toFixed(1)} s (tier ${args.tier}, engine ${mode})\n`);
  if (failed.length > 0) process.stdout.write(`FAILED: ${failed.map((r) => r.gate.id).join(', ')}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  process.stdout.write(`harness error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
});
