/**
 * Character contract (06 `bc`, 04 section 9).
 *
 * 1. No MoveId string literal in brain files: every .ts under src/ai except the allowed places
 *    (executor.ts, charprofile/*, eval/*, contracts.ts) and the legacy files W3.2 retires (index.ts,
 *    aevalmere.ts, aitest.ts, dummy.ts).
 * 2. A second character: a copy of Aeval with altered numbers ('aevalAlt': weight +10%, ground
 *    speeds +5%, hitbox damage x0.9) registered for the case only. Every tier plays it without a
 *    brain edit: the match runs, and the god on it neither loses nor self-destructs.
 * 3. Full tier: derived center kill percents of every Aeval move within 2% of calibrate.ts.
 */
import { CHARACTER_DEFS } from '../../../characters/registry';
import type { CharacterDef, MoveDef, MoveId } from '../../../core/types';
import { calibrate } from '../../../sim/calibrate';
import { getAiProfile } from '../../charprofile/derive';
import type { TestCase } from '../../contracts';
import { nodeApi, repoRoot, runBatch, seedFor, STAGES, ui, type JobSpec } from '../pool';
import { byTier, defineCase, f1, gate, listed, tally } from './common';

export const ALT_ID = 'aevalAlt';

/** Files and folders (relative to src/ai, forward slashes) where MoveId literals are allowed. */
const ALLOWED: readonly string[] = ['executor.ts', 'contracts.ts', 'charprofile/', 'eval/', 'index.ts', 'aevalmere.ts', 'aitest.ts', 'dummy.ts'];

function scanLiterals(): { files: number; hits: string[]; skipped: boolean } {
  const api = nodeApi();
  if (api === null) return { files: 0, hits: [], skipped: true };
  const root = api.join(repoRoot(api), 'src', 'ai');
  const ids = Object.keys(CHARACTER_DEFS.aeval.moves);
  const re = new RegExp(`['"\`](${ids.join('|')})['"\`]`, 'g');
  const hits: string[] = [];
  let files = 0;
  const walk = (rel: string): void => {
    const dir = api.join(root, rel);
    for (const name of api.readdirSync(dir)) {
      const r = rel === '' ? name : `${rel}/${name}`;
      if (!name.includes('.')) { if (!ALLOWED.includes(`${r}/`)) walk(r); continue; }
      if (!name.endsWith('.ts') || ALLOWED.includes(r)) continue;
      files++;
      const text = api.readFileSync(api.join(dir, name), 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m !== null) hits.push(`${r}:${i + 1} ${m[0]}`);
      }
    }
  };
  walk('');
  return { files, hits, skipped: false };
}

function altDef(base: CharacterDef): CharacterDef {
  const moves = {} as Record<MoveId, MoveDef>;
  for (const id of Object.keys(base.moves) as MoveId[]) {
    const m = base.moves[id];
    moves[id] = { ...m, hitboxes: m.hitboxes.map((h) => ({ ...h, damage: h.damage * 0.9 })) };
  }
  return { ...base, id: ALT_ID, name: 'Aeval Alt', weight: base.weight * 1.1, walkSpeed: base.walkSpeed * 1.05,
    runSpeed: base.runSpeed * 1.05, dashSpeed: base.dashSpeed * 1.05, moves };
}

const bc: TestCase = defineCase('bc', ['fast', 'full', 'nightly'], ({ tier }) => {
  const fails: string[] = [];
  const parts: string[] = [];
  const metrics: Record<string, number> = {};

  const scan = scanLiterals();
  metrics.literalHits = scan.hits.length;
  parts.push(scan.skipped ? 'literal scan skipped (node API not loaded)' : `MoveId literals in ${scan.files} brain files: ${scan.hits.length}`);
  if (scan.hits.length > 0) fails.push(`literals: ${listed(scan.hits, 5)}`);

  CHARACTER_DEFS[ALT_ID] = altDef(CHARACTER_DEFS.aeval);
  try {
    const levels = tier === 'fast' ? [5, 10] : [1, 3, 5, 7, 9, 10];
    const n = byTier(tier, { fast: 1, full: 2, nightly: 4 });
    const played: string[] = [];
    for (const lvl of levels) {
      const jobs: JobSpec[] = [];
      for (let k = 0; k < n; k++) {
        jobs.push({ seed: seedFor(`bc|${lvl}`, k), swap: k % 2 === 1, stageId: STAGES[k % 2], stocks: 2, frameCap: 7200,
          a: ui(lvl), b: ui(Math.min(lvl, 5)), chars: [ALT_ID, 'aeval'] });
      }
      let t;
      try {
        t = tally(runBatch(jobs, true), 0);
      } catch (e) {
        fails.push(`UI${lvl} on ${ALT_ID} threw: ${(e as Error).message}`);
        continue;
      }
      played.push(`UI${lvl} ${t.wins}-${t.losses}${t.sds > 0 ? ` SD ${t.sds}` : ''}`);
      if (lvl >= 10 && (t.losses > 0 || t.sds > 0)) fails.push(`god on ${ALT_ID}: ${t.losses} losses, ${t.sds} SDs`);
    }
    parts.push(`${ALT_ID} vs aeval: ${played.join(', ')}`);
    if (tier !== 'fast') {
      try {
        const alt = getAiProfile(ALT_ID, 'tidegate');
        parts.push(`derived ${ALT_ID} profile (${Object.keys(alt.moves).length} moves)`);
      } catch (e) {
        fails.push(`profile derive for ${ALT_ID} threw: ${(e as Error).message}`);
      }
    }
  } finally {
    delete CHARACTER_DEFS[ALT_ID];
  }

  if (tier !== 'fast') {
    const prof = getAiProfile('aeval', 'tidegate');
    const off: string[] = [];
    let compared = 0;
    for (const row of calibrate()) {
      const info = prof.moves[row.move];
      if (info === undefined) continue;
      const derived = info.killPct.center;
      compared++;
      // Same rule as unit/charprofile.ts: no kill by 250 means NaN, else within 2% of calibrate.
      if (row.koPercent < 0 || row.koPercent > 250) { if (!Number.isNaN(derived)) off.push(`${row.move} ${f1(derived)} vs none`); continue; }
      if (!(Math.abs(derived - row.koPercent) <= 0.02 * row.koPercent)) off.push(`${row.move} ${f1(derived)} vs ${row.koPercent}`);
    }
    metrics.killPctOff = off.length;
    parts.push(`kill percents vs calibrate.ts: ${compared - off.length}/${compared} within 2%`);
    if (off.length > 0) fails.push(`kill percents: ${listed(off, 5)}`);
  }
  return gate('bc', fails.length === 0, `${parts.join('; ')}${fails.length > 0 ? ` | FAIL: ${listed(fails, 4)}` : ''}`, metrics);
});

export const CHARACTER_CASES: readonly TestCase[] = [bc];
