/**
 * Game version for the LAN version guard: an FNV-1a hash over every source file that decides
 * what the sim does (sim, core, character and stage data, balance numbers, netcode), plus the
 * protocol version. Two agents with different hashes could desync, so their lobbies show as
 * "different version" and refuse joins. Art and UI files are left out: they cannot desync.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../src/net/protocol';

const ROOTS = ['src/sim', 'src/core', 'src/characters', 'src/stages', 'src/net', 'balance'];

function skip(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  // Art cannot desync; tests, and underscore-prefixed local scratch files, are not the game.
  return p.includes('/art/') || /\/(art|layers)[^/]*\.ts$/.test(p) || /test\.ts$/.test(p) || /\/_[^/]*$/.test(p);
}

/**
 * The files to hash: those git tracks under ROOTS, so an untracked scratch file on one machine
 * does not split the version. Without git (a zip download), every file under ROOTS.
 */
function sourceFiles(repoRoot: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\0').filter((f) => /\.(ts|json)$/.test(f)).map((f) => path.join(repoRoot, f));
    if (files.length > 0) return files.filter((f) => fs.existsSync(f));
  } catch {
    // No git, or not a checkout: fall back to the directory walk.
  }
  const files: string[] = [];
  for (const r of ROOTS) walk(path.join(repoRoot, r), files);
  return files;
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|json)$/.test(e.name)) out.push(full);
  }
}

export function gameVersion(repoRoot: string): string {
  const files = sourceFiles(repoRoot).map((f) => path.relative(repoRoot, f).replace(/\\/g, '/'));
  files.sort();
  let h = 0x811c9dc5;
  for (const rel of files) {
    if (skip(rel)) continue;
    const bytes = fs.readFileSync(path.join(repoRoot, rel));
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 13) continue; // CRLF vs LF checkouts are the same game
      h = Math.imul(h ^ b, 0x01000193);
    }
  }
  return `p${PROTOCOL_VERSION}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}
