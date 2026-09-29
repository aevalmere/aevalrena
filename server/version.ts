/**
 * Game version for the LAN version guard: an FNV-1a hash over every source file that decides
 * what the sim does (sim, core, character and stage data, balance numbers, netcode), plus the
 * protocol version. Two agents with different hashes could desync, so their lobbies show as
 * "different version" and refuse joins. Art and UI files are left out: they cannot desync.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../src/net/protocol';

const ROOTS = ['src/sim', 'src/core', 'src/characters', 'src/stages', 'src/net', 'balance'];

function skip(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  return p.includes('/art/') || /\/(art|layers)[^/]*\.ts$/.test(p) || /test\.ts$/.test(p);
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
  const files: string[] = [];
  for (const r of ROOTS) walk(path.join(repoRoot, r), files);
  files.sort();
  let h = 0x811c9dc5;
  for (const f of files) {
    const rel = path.relative(repoRoot, f);
    if (skip(rel)) continue;
    const bytes = fs.readFileSync(f);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 13) continue; // CRLF vs LF checkouts are the same game
      h = Math.imul(h ^ b, 0x01000193);
    }
  }
  return `p${PROTOCOL_VERSION}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}
