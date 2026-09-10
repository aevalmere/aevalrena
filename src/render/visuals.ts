import { CHARACTER_DEFS, CHARACTER_SPRITES } from '../characters/registry';
import type { CharacterSprites, PixelSheet, ProjectileDef } from '../core/types';
import { portraitFrameName } from './anim';
import { bakeSheet } from './bake';
import { PLAYER_COLORS } from './colors';

const NO_OUTLINES: readonly string[] = [];

/**
 * Per-character render data assembled once at load: baked sheet ids, the
 * effect frame name lists (so the hot path never builds a name string), and a
 * lookup from projectile def id to its def and owning character.
 */

export interface CharVisual {
  charId: string;
  bodySheetId: string;
  fxSheetId: string;
  sprites: CharacterSprites;
  portrait: string | null;
  geyser: string[];
  whirl: string[];
  hitspark: string[];
  splash: string[];
  ko: string[];
}

export interface ProjectileVisual {
  def: ProjectileDef;
  owner: CharVisual;
  frames: string[];
}

const charVisuals = new Map<string, CharVisual>();
const projectileVisuals = new Map<string, ProjectileVisual>();

/** Collect `base0`, `base1`, ... while the sheet has them. */
function probeFrames(sheet: PixelSheet, base: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 64; i++) {
    const name = base + i;
    if (sheet.frames[name] === undefined) break;
    out.push(name);
  }
  if (out.length === 0 && sheet.frames[base] !== undefined) out.push(base);
  return out;
}

export function buildVisuals(): void {
  charVisuals.clear();
  projectileVisuals.clear();

  for (const charId in CHARACTER_SPRITES) {
    const sprites = CHARACTER_SPRITES[charId];
    const bodySheetId = charId + ':body';
    const fxSheetId = charId + ':fx';
    bakeSheet(bodySheetId, sprites.sheet, PLAYER_COLORS);
    bakeSheet(fxSheetId, sprites.fx, NO_OUTLINES);

    const visual: CharVisual = {
      charId,
      bodySheetId,
      fxSheetId,
      sprites,
      portrait: portraitFrameName(sprites),
      geyser: probeFrames(sprites.fx, 'geyser'),
      whirl: probeFrames(sprites.fx, 'whirl'),
      hitspark: probeFrames(sprites.fx, 'hitspark'),
      splash: probeFrames(sprites.fx, 'splash'),
      ko: probeFrames(sprites.fx, 'ko'),
    };
    charVisuals.set(charId, visual);
  }

  for (const charId in CHARACTER_DEFS) {
    const def = CHARACTER_DEFS[charId];
    const owner = charVisuals.get(charId);
    if (owner === undefined) continue;
    for (const moveId in def.moves) {
      const move = def.moves[moveId as keyof typeof def.moves];
      const projectiles = move.projectiles;
      if (projectiles === undefined) continue;
      for (const projectile of projectiles) {
        if (projectileVisuals.has(projectile.id)) continue;
        projectileVisuals.set(projectile.id, {
          def: projectile,
          owner,
          frames: probeFrames(owner.sprites.fx, projectile.sprite),
        });
      }
    }
  }
}

export function getCharVisual(charId: string): CharVisual | null {
  const v = charVisuals.get(charId);
  return v === undefined ? null : v;
}

export function getProjectileVisual(defId: string): ProjectileVisual | null {
  const v = projectileVisuals.get(defId);
  return v === undefined ? null : v;
}
