/**
 * The committed profile cache (plan risk R4).
 *
 * Deriving a profile runs thousands of short sims, so the derived (pre-override) profile of every
 * shipped character on every stage is generated once and committed next to the character as
 * `src/characters/<id>/ai.profile.cache.json`, keyed by profileDataHash (the CharacterDef, the
 * StageDef, TUNING and the structural sim constants). At load derive.ts reads the entry and uses
 * it only when its hash equals the live one; any balance edit or tuning change misses and
 * re-derives. The unit check src/ai/eval/unit/charprofile.ts fails while the committed hash is
 * stale, so a balance edit forces a regenerate. From the repo root:
 *
 *   npx --yes tsx src/ai/charprofile/cache.ts --write    regenerate every cache file
 *   npx --yes tsx src/ai/charprofile/cache.ts --check    exit 1 when a cache entry is stale
 *
 * Shot curves and the combo table are not stored: shots are re-tabulated from the def on load
 * (arithmetic only) and the combo table builds lazily on first use.
 */
import type { CharacterAiProfile, GrabAiInfo, MoveAiInfo, RecoveryProfile } from '../contracts';
import type { MoveId } from '../../core/types';
import type { StoredComboTable } from './combo';
// JSON modules are bundled by Vite and loaded by tsx; tsconfig has no resolveJsonModule.
// @ts-ignore
import aevalCache from '../../characters/aeval/ai.profile.cache.json';
// @ts-ignore
import trekmoreCache from '../../characters/trekmore/ai.profile.cache.json';

/** Cache files by character id, with their path from the repo root. A new character adds a line. */
const CACHE_FILES: Record<string, { path: string; data: unknown }> = {
  aeval: { path: 'src/characters/aeval/ai.profile.cache.json', data: aevalCache },
  trekmore: { path: 'src/characters/trekmore/ai.profile.cache.json', data: trekmoreCache },
};

export const CACHE_FORMAT = 1;
export const REGENERATE_COMMAND = 'npx --yes tsx src/ai/charprofile/cache.ts --write';

/** A profile as stored: plain JSON, non-finite numbers as the strings "NaN", "Infinity", "-Infinity". */
export interface SerializedProfile {
  charId: string; dataHash: string;
  physics: CharacterAiProfile['physics'];
  moves: Record<string, unknown>;
  grab: unknown;
  recovery: unknown;
  roles: CharacterAiProfile['roles'];
  styleAffinity: CharacterAiProfile['styleAffinity'];
}
/**
 * `combo`: the mirror combo table's canonical entries, built from the profile after the hand
 * overrides; `comboOverrides` is the hash of those overrides (overridesHash), so an override edit
 * falls back to building the table at run time until the cache is regenerated.
 */
export interface CacheEntry { dataHash: string; profile: SerializedProfile; combo?: StoredComboTable; comboOverrides?: string }
export interface CacheFile { format: number; charId: string; regenerate: string; stages: Record<string, CacheEntry> }

function encode(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (v instanceof Float32Array) return Array.from(v, (x) => encode(x));
  if (Array.isArray(v)) return v.map((x) => encode(x));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(v as object);
    for (let i = 0; i < keys.length; i++) {
      const x = (v as Record<string, unknown>)[keys[i]];
      if (x === undefined || typeof x === 'function') continue;
      out[keys[i]] = encode(x);
    }
    return out;
  }
  return v;
}

function decode(v: unknown): unknown {
  if (v === 'NaN') return NaN;
  if (v === 'Infinity') return Infinity;
  if (v === '-Infinity') return -Infinity;
  if (Array.isArray(v)) return v.map((x) => decode(x));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(v as object);
    for (let i = 0; i < keys.length; i++) out[keys[i]] = decode((v as Record<string, unknown>)[keys[i]]);
    return out;
  }
  return v;
}

/** The stored form of a profile (no shot curves, no combo table, no overrides). */
export function serializeProfile(p: CharacterAiProfile): SerializedProfile {
  return encode({
    charId: p.charId, dataHash: p.dataHash, physics: p.physics, moves: p.moves, grab: p.grab,
    recovery: p.recovery, roles: p.roles, styleAffinity: p.styleAffinity,
  }) as SerializedProfile;
}

/** Stored form back to typed data; recoverBox becomes a Float32Array again. */
export function decodeProfileData(s: SerializedProfile): {
  charId: string; dataHash: string; physics: CharacterAiProfile['physics']; moves: Record<MoveId, MoveAiInfo>;
  grab: GrabAiInfo; recovery: RecoveryProfile; roles: CharacterAiProfile['roles']; styleAffinity: CharacterAiProfile['styleAffinity'];
} {
  const d = decode(s) as Record<string, unknown>;
  const rec = d.recovery as Record<string, unknown>;
  const recovery = { ...rec, recoverBox: Float32Array.from(rec.recoverBox as number[]) } as unknown as RecoveryProfile;
  return {
    charId: d.charId as string,
    dataHash: d.dataHash as string,
    physics: d.physics as CharacterAiProfile['physics'],
    moves: d.moves as Record<MoveId, MoveAiInfo>,
    grab: d.grab as GrabAiInfo,
    recovery,
    roles: d.roles as CharacterAiProfile['roles'],
    styleAffinity: d.styleAffinity as CharacterAiProfile['styleAffinity'],
  };
}

function fileOf(charId: string): CacheFile | null {
  const f = CACHE_FILES[charId];
  if (f === undefined || f.data === null || typeof f.data !== 'object') return null;
  const c = f.data as CacheFile;
  if (c.format !== CACHE_FORMAT || c.stages === undefined) return null;
  return c;
}

/** The committed entry for a character and stage, or null. The caller compares the hash. */
export function cachedEntry(charId: string, stageId: string): CacheEntry | null {
  const c = fileOf(charId);
  if (c === null) return null;
  const e = c.stages[stageId];
  return e === undefined ? null : e;
}

/** FNV-1a of the override object's JSON: what `comboOverrides` records. */
export function overridesHash(o: unknown): string {
  const text = JSON.stringify(o ?? {});
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** The committed mirror combo table for this hash and override set, or null. */
export function cachedCombo(charId: string, stageId: string, dataHash: string, ovHash: string): StoredComboTable | null {
  const e = cachedEntry(charId, stageId);
  if (e === null || e.dataHash !== dataHash || e.combo === undefined || e.comboOverrides !== ovHash) return null;
  return e.combo;
}

/** Characters that have a cache file. */
export function cachedCharacters(): string[] {
  return Object.keys(CACHE_FILES).sort();
}

/** JSON text of a cache file: 1-space indent, number arrays and small leaf objects kept on one line. */
export function formatCacheFile(c: CacheFile): string {
  const text = JSON.stringify(c, null, 1);
  return `${text
    .replace(/\[\n\s*((?:-?[\d.e+-]+|"[-A-Za-z]+"),?\n\s*)+\]/g, (m) => m.replace(/\s+/g, '').replace(/,/g, ', '))
    .replace(/\{\n\s*("[a-zA-Z]+": (?:-?[\d.e+-]+|"[-A-Za-z]+"|true|false|null),?\n\s*){1,4}\}/g, (m) => m.replace(/\n\s*/g, ' ').replace(/\{ /, '{').replace(/ \}/, '}'))}\n`;
}

declare const process: { argv: string[]; exitCode?: number; stdout: { write(text: string): void } };

async function main(args: string[]): Promise<void> {
  const write = args.indexOf('--write') >= 0;
  const derive = await import('./derive');
  const overrides = await import('./overrides');
  const combos = await import('./combo');
  const { CHARACTER_DEFS } = await import('../../characters/registry');
  const { STAGE_DEFS } = await import('../../stages/registry');
  const { TUNING_DEFAULTS } = await import('../../core/constants');
  const fsName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync(path: string, text: string): void };
  let stale = 0;
  const chars = cachedCharacters();
  for (let c = 0; c < chars.length; c++) {
    const charId = chars[c];
    const def = CHARACTER_DEFS[charId];
    if (def === undefined) continue;
    const file: CacheFile = { format: CACHE_FORMAT, charId, regenerate: REGENERATE_COMMAND, stages: {} };
    const stageIds = Object.keys(STAGE_DEFS).sort();
    for (let s = 0; s < stageIds.length; s++) {
      const stage = STAGE_DEFS[stageIds[s]];
      // The shipped cache is for default tuning; a live slider change misses and re-derives.
      const hash = derive.profileDataHash(def, stage, TUNING_DEFAULTS);
      const have = cachedEntry(charId, stage.id);
      const ovh = overridesHash(overrides.overridesFor(charId));
      const fresh = have !== null && have.dataHash === hash && have.combo !== undefined && have.comboOverrides === ovh;
      if (!fresh) stale++;
      if (!write) {
        process.stdout.write(`${charId} ${stage.id} ${fresh ? 'fresh' : 'STALE'} ${hash}\n`);
        continue;
      }
      const t0 = performance.now();
      const p = derive.deriveBaseProfile(def, stage, TUNING_DEFAULTS);
      const ms = performance.now() - t0;
      // The mirror combo table as play builds it: on the profile after overrides, at its brackets.
      const t1 = performance.now();
      const fin = overrides.applyOverrides(p, overrides.overridesFor(charId)).profile;
      const combo = combos.exportComboTable(combos.buildComboTable(fin, def, stage, derive.mirrorBrackets(fin.moves)));
      const cms = performance.now() - t1;
      file.stages[stage.id] = { dataHash: p.dataHash, profile: serializeProfile(p), combo, comboOverrides: ovh };
      process.stdout.write(`${charId} ${stage.id} derived in ${ms.toFixed(0)} ms, combo table in ${cms.toFixed(0)} ms, hash ${p.dataHash}\n`);
    }
    if (write) {
      fs.writeFileSync(CACHE_FILES[charId].path, formatCacheFile(file));
      process.stdout.write(`wrote ${CACHE_FILES[charId].path}\n`);
    }
  }
  if (!write && stale > 0) {
    process.stdout.write(`${stale} stale entr${stale === 1 ? 'y' : 'ies'}; run ${REGENERATE_COMMAND}\n`);
    process.exitCode = 1;
  }
}

if (typeof process !== 'undefined' && process.argv[1] !== undefined && /charprofile[\\/]cache\.ts$/.test(process.argv[1])) {
  void main(process.argv.slice(2));
}
