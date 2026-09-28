import { AEVAL_FX_ANIMS } from '../characters/aeval/art/anims';
import { CHARACTER_DEFS, CHARACTER_SPRITES } from '../characters/registry';
import type { AnimDef, CharacterSprites, ImageSheetData, ProjectileDef } from '../core/types';
import { portraitFrameName } from './anim';
import { bakeSheet } from './bake';

const NO_OUTLINES: readonly string[] = [];

/** Per-character effect animations (frame order and holds), by character id. */
const FX_ANIMS: Record<string, Record<string, AnimDef>> = {
  aeval: AEVAL_FX_ANIMS,
};
/** Hold per geyser frame when a character has no fx anim entry for it. */
const GEYSER_DEFAULT_HOLD = 5;

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
  /** Sim frames each geyser frame is shown, counted from the launch. */
  geyserHolds: number[];
  /** uspecial frame that launches the fighter (first setY velocity), or -1. */
  geyserLaunch: number;
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
function probeFrames(sheet: ImageSheetData, base: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 64; i++) {
    const name = base + i;
    if (sheet.frames[name] === undefined) break;
    out.push(name);
  }
  if (out.length === 0 && sheet.frames[base] !== undefined) out.push(base);
  return out;
}

export async function buildVisuals(): Promise<void> {
  charVisuals.clear();
  projectileVisuals.clear();

  for (const charId in CHARACTER_SPRITES) {
    const sprites = CHARACTER_SPRITES[charId];
    const bodySheetId = charId + ':body';
    const fxSheetId = charId + ':fx';
    // No per-player outlines: sprites carry no coloured outline (owner rule, 2026-09-28).
    await bakeSheet(bodySheetId, sprites.sheet, NO_OUTLINES);
    await bakeSheet(fxSheetId, sprites.fx, NO_OUTLINES);

    const visual: CharVisual = {
      charId,
      bodySheetId,
      fxSheetId,
      sprites,
      portrait: portraitFrameName(sprites),
      geyser: [],
      geyserHolds: [],
      geyserLaunch: -1,
      whirl: probeFrames(sprites.fx, 'whirl'),
      hitspark: probeFrames(sprites.fx, 'hitspark'),
      splash: probeFrames(sprites.fx, 'splash'),
      ko: probeFrames(sprites.fx, 'ko'),
    };
    geyserTiming(visual, charId);
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

/**
 * The geyser is world-anchored: it is latched where the fighter took off. Frame
 * order and holds come from the fx anim when there is one, the launch frame
 * from the uspecial move's first vertical-velocity set.
 */
function geyserTiming(visual: CharVisual, charId: string): void {
  const fx = visual.sprites.fx;
  const anims = FX_ANIMS[charId];
  const anim = anims === undefined ? undefined : anims.geyser;
  if (anim !== undefined && anim.frames.every((n) => fx.frames[n] !== undefined)) {
    visual.geyser = anim.frames.slice();
    visual.geyserHolds = anim.frames.map((_, k) =>
      anim.holds !== undefined && anim.holds[k] !== undefined ? anim.holds[k] : GEYSER_DEFAULT_HOLD
    );
  } else {
    visual.geyser = probeFrames(fx, 'geyser');
    visual.geyserHolds = visual.geyser.map(() => GEYSER_DEFAULT_HOLD);
  }
  const def = CHARACTER_DEFS[charId];
  const move = def === undefined ? undefined : def.moves.uspecial;
  const velocity = move === undefined ? undefined : move.velocity;
  if (velocity === undefined) return;
  for (const v of velocity) {
    if (v.setY === true) {
      visual.geyserLaunch = v.frame;
      return;
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
