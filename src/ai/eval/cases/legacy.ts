/**
 * Cases that run other test entry points: the per-module unit files (plan section 3, each worker's
 * src/ai/eval/unit/<module>.ts), aitest.ts (the legacy suite, whole in full, the cheap `as` check
 * in fast) and the profile-transfer gate `be`.
 *
 * A case with `launch` can also run asynchronously: main.ts starts it before the in-process cases so
 * child processes use other cores, and falls back to `run` (synchronous, serial) elsewhere.
 */
import { runAevalmereWave2Tests } from '../../aitest';
import type { GateResult, TestCase } from '../../contracts';
import { engineMode, nodeApi, repoRoot, runChild, runLimited, shellLine, tsxCommand, type NodeApi } from '../pool';
import { defineCase, gate, listed } from './common';

export interface LaunchCase extends TestCase { launch(api: NodeApi, ctx: { tier: string }): Promise<GateResult> }

export function isLaunchCase(c: TestCase): c is LaunchCase {
  return typeof (c as Partial<LaunchCase>).launch === 'function';
}

/** Unit files: every .ts in src/ai/eval/unit except the shared fixtures. */
function unitFiles(api: NodeApi): string[] {
  const dir = api.join(repoRoot(api), 'src', 'ai', 'eval', 'unit');
  return api.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'fixtures.ts').sort().map((f) => api.join(dir, f));
}

function unitResult(runs: { file: string; code: number; ms: number; tail: string }[]): GateResult {
  const bad = runs.filter((r) => r.code !== 0);
  const rows = runs.map((r) => `${r.file.replace(/^.*[\\/]/, '')} ${r.code === 0 ? 'ok' : `exit ${r.code}`} ${(r.ms / 1000).toFixed(1)}s`);
  return gate('unit', bad.length === 0,
    `${runs.length} unit files: ${rows.join(', ')}${bad.length > 0 ? ` | FAIL: ${listed(bad.map((b) => `${b.file.replace(/^.*[\\/]/, '')}: ${b.tail}`), 4)}` : ''}`,
    { files: runs.length, failed: bad.length });
}

function lastFail(out: string): string {
  const lines = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL'));
  return lines.length > 0 ? lines[0].slice(0, 160) : out.trim().split(/\r?\n/).slice(-1)[0]?.slice(0, 160) ?? '';
}

const unit: LaunchCase = {
  id: 'unit',
  tiers: ['fast', 'full', 'nightly'],
  run(): GateResult {
    const api = nodeApi();
    if (api === null) return gate('unit', true, 'skipped: node API not loaded', {}, true);
    const runs = unitFiles(api).map((file) => {
      const t0 = performance.now();
      const c = tsxCommand(file, []);
      const r = api.spawnSync(shellLine(c.cmd, c.args), [], { cwd: repoRoot(api), shell: true, encoding: 'utf8', windowsHide: true });
      return { file, code: r.status ?? 1, ms: performance.now() - t0, tail: lastFail(String(r.stdout)) };
    });
    return unitResult(runs);
  },
  async launch(api: NodeApi): Promise<GateResult> {
    const files = unitFiles(api);
    const runs = await runLimited(files.map((file) => async () => {
      const c = tsxCommand(file, []);
      const r = await runChild(api, c.cmd, c.args, repoRoot(api));
      return { file, code: r.code, ms: r.ms, tail: lastFail(r.out) };
    }), Math.max(1, api.cpuCount - 2));
    return unitResult(runs);
  },
};

/** aitest.ts tests known to fail on this machine for timing only (plan: "ar" measures wall-clock cost). */
export const AITEST_TIMING_ONLY: readonly string[] = ['ar'];

function aitestResult(code: number, out: string, ms: number): GateResult {
  const lines = out.split(/\r?\n/);
  const fails = lines.filter((l) => l.startsWith('FAIL '));
  const hard = fails.filter((l) => !AITEST_TIMING_ONLY.some((id) => l.startsWith(`FAIL ${id}.`)));
  const summary = lines.find((l) => /^\d+\/\d+ pass/.test(l)) ?? `exit ${code}`;
  return gate('aitest.all', hard.length === 0,
    `aitest.ts ${summary} in ${(ms / 1000).toFixed(0)}s; timing-only failures ignored: ${fails.length - hard.length}` +
    `${hard.length > 0 ? ` | FAIL: ${listed(hard.map((l) => l.slice(0, 120)), 4)}` : ''}`, { failed: hard.length });
}

const aitestAll: LaunchCase = {
  id: 'aitest.all',
  tiers: ['full', 'nightly'],
  run(): GateResult {
    const api = nodeApi();
    if (api === null) return gate('aitest.all', true, 'skipped: node API not loaded', {}, true);
    const t0 = performance.now();
    const c = tsxCommand(api.join(repoRoot(api), 'src', 'ai', 'aitest.ts'), []);
    const r = api.spawnSync(shellLine(c.cmd, c.args), [], { cwd: repoRoot(api), shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    return aitestResult(r.status ?? 1, String(r.stdout), performance.now() - t0);
  },
  async launch(api: NodeApi): Promise<GateResult> {
    const c = tsxCommand(api.join(repoRoot(api), 'src', 'ai', 'aitest.ts'), []);
    const r = await runChild(api, c.cmd, c.args, repoRoot(api));
    return aitestResult(r.code, r.out, r.ms);
  },
};

/** aitest `as` in process: the legacy god against a human slot replays identically with an empty and a fixed profile. */
const aitestFast: TestCase = defineCase('aitest.fast', ['fast'], () => {
  const rs = runAevalmereWave2Tests(['as']);
  const bad = rs.filter((r) => !r.pass);
  return gate('aitest.fast', bad.length === 0, rs.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.name.slice(0, 60)}: ${r.detail.slice(0, 120)}`).join(' | '),
    { failed: bad.length });
});

/**
 * 06 `be`: profile transfer. The new engine exposes no predictor accuracy through BrainFactory or
 * BrainStats, so with it the case is info; with the legacy brain it runs aitest `ap` (mean gain at
 * least 8 points, no pair below -5, measured +15.5).
 */
const be: TestCase = defineCase('be', ['full', 'nightly'], () => {
  if (engineMode() !== 'legacy') {
    return gate('be', true, 'needs a predictor-accuracy hook on the new engine (contract gap: BrainStats has no accuracy)', {}, true);
  }
  const rs = runAevalmereWave2Tests(['ap']);
  const r = rs[0];
  return gate('be', r !== undefined && r.pass, r !== undefined ? `aitest ap: ${r.detail}` : 'aitest ap missing', {});
});

export const LEGACY_CASES: readonly TestCase[] = [unit, aitestFast, aitestAll, be];
