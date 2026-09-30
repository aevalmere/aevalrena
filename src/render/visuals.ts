import { AEVAL_FX_ANIMS } from '../characters/aeval/art/anims';
import type { FxAnimDef } from '../characters/aeval/art/anims';
import { CHARACTER_DEFS, CHARACTER_SPRITES } from '../characters/registry';
import type { CharacterSprites, ImageSheetData, ProjectileDef } from '../core/types';
import { portraitFrameName } from './anim';
import { bakeSheet, bakeVariantSheet, getFrame } from './bake';
import { VARIANT_COUNT } from './palette';

const NO_OUTLINES: readonly string[] = [];

/**
 * Per-character effect animations (frame order and holds), by character id. A character's
 * sprites module may instead carry them itself as `fxAnims` (see fxAnimsOf); a character in
 * neither place probes `<name>0..n` frames with default holds.
 */
const FX_ANIMS: Record<string, Record<string, FxAnimDef>> = {
  aeval: AEVAL_FX_ANIMS,
};
/** Optional field a character's sprites module can export its fx anims on. */
interface SpritesWithFx { fxAnims?: Record<string, FxAnimDef> }

function fxAnimsOf(charId: string): Record<string, FxAnimDef> | undefined {
  const sprites = CHARACTER_SPRITES[charId] as (CharacterSprites & SpritesWithFx) | undefined;
  if (sprites !== undefined && sprites.fxAnims !== undefined) return sprites.fxAnims;
  return FX_ANIMS[charId];
}

/**
 * Effect roles by fx name. The first name a character's fx sheet has fills the role; a role
 * with no match stays empty and simply draws nothing for that character.
 * - rise: world anchored column latched at the uspecial launch (Aeval geyser, Trekmore sword).
 * - stance: loops on the fighter for the whole of dspecial (Aeval whirl).
 * - handCharge: formed in hand while nspecial charges, picked by charge fraction (Aeval orb).
 * - clips: one-shots by name. counterFlash: parry success and crit core. stepTrail: teleport
 *   departure and arrival. shadowBurst: spare burst for effects outside a projectile.
 */
const RISE_FX: readonly string[] = ['geyser', 'swordRise'];
const STANCE_FX: readonly string[] = ['whirl'];
const HAND_CHARGE_FX: readonly string[] = ['orbCharge'];
const CLIP_FX: readonly string[] = ['counterFlash', 'stepTrail', 'shadowBurst'];
/** Hold per frame when a character has no fx anim entry for a role or clip. */
const DEFAULT_CLIP_HOLD = 5;
const FLASH_CLIP_HOLD = 2;
/** Projectile readability halo: silhouette colour and opacity, grown by 1 px. */
const SHADOW_RGB = [0x0b, 0x10, 0x30];
const SHADOW_ALPHA = 140; // ~0.55
const SHADOW_MIN_ALPHA = 24;

/**
 * Per-character render data assembled once at load: baked sheet ids, the
 * effect frame name lists (so the hot path never builds a name string), and a
 * lookup from projectile def id to its def and owning character.
 */

export interface CharVisual {
  charId: string;
  /** Baked body sheet in this visual's colour variant. */
  bodySheetId: string;
  /** The base (variant 0) body sheet: echo shadows bake from it, whatever the variant. */
  baseBodySheetId: string;
  fxSheetId: string;
  sprites: CharacterSprites;
  portrait: string | null;
  /** The uspecial column (RISE_FX), world anchored at the launch. Empty when the sheet has none. */
  rise: string[];
  /** Sim frames each rise frame is shown, counted from the launch. */
  riseHolds: number[];
  /** uspecial frame that launches the fighter (first setY velocity), or -1. */
  riseLaunch: number;
  /** The dspecial loop (STANCE_FX). Empty when the sheet has none. */
  stance: string[];
  /** Frames drawn at the hand while nspecial charges (HAND_CHARGE_FX), picked by charge fraction. */
  handCharge: string[];
  /** One-shot fx clips by name (CLIP_FX) that the sheet has: counter flash, step trail. */
  clips: Map<string, FxClip>;
  /**
   * Dark halo behind each fx frame, baked once at load: [normal, flipped], 1 px
   * larger on every side than the frame (so its anchor is the frame's plus 1).
   */
  shadows: Map<string, [HTMLCanvasElement, HTMLCanvasElement]>;
  hitspark: string[];
  splash: string[];
  ko: string[];
}

/** A one-shot effect resolved once at load: frame names and sim-frame holds. */
export interface FxClip {
  frames: string[];
  holds: number[];
  /** Sum of holds. */
  total: number;
}

/** A projectile's fx anim resolved once at load: frame names and sim-frame holds. */
export interface ProjectileAnim {
  frames: string[];
  holds: number[];
  /** Sum of holds. */
  total: number;
  loop: boolean;
  /** Sim frames before the frame a loop returns to (sum of holds before loopFrom). */
  loopStart: number;
}

export interface ProjectileVisual {
  def: ProjectileDef;
  owner: CharVisual;
  /** Probed `<sprite>0..n` frames, used when the character has no fx anim for the sprite. */
  frames: string[];
  /** The fx anim named after the sprite, or null. */
  anim: ProjectileAnim | null;
  /** The `<sprite>Big` fx anim for charged shots (scale >= 1.2), or null. */
  big: ProjectileAnim | null;
}

const charVisuals = new Map<string, CharVisual>();
const projectileVisuals = new Map<string, ProjectileVisual>();
/**
 * Colour variant visuals per character, index = variant (src/render/palette.ts). Index 0 is
 * the base visual; the others are baked the first time something asks for them, so a match
 * where everyone plays the base colour bakes nothing extra.
 */
const variantVisuals = new Map<string, (CharVisual | null)[]>();

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
  variantVisuals.clear();

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
      baseBodySheetId: bodySheetId,
      fxSheetId,
      sprites,
      portrait: portraitFrameName(sprites),
      rise: [],
      riseHolds: [],
      riseLaunch: -1,
      stance: [],
      handCharge: [],
      clips: new Map(),
      shadows: new Map(),
      hitspark: probeFrames(sprites.fx, 'hitspark'),
      splash: probeFrames(sprites.fx, 'splash'),
      ko: probeFrames(sprites.fx, 'ko'),
    };
    riseTiming(visual, charId);
    const stance = firstClip(charId, sprites.fx, STANCE_FX, DEFAULT_CLIP_HOLD);
    visual.stance = stance === null ? [] : stance.frames;
    const charge = firstClip(charId, sprites.fx, HAND_CHARGE_FX, DEFAULT_CLIP_HOLD);
    visual.handCharge = charge === null ? [] : charge.frames;
    for (const name of CLIP_FX) {
      const clip = resolveClip(charId, sprites.fx, name, FLASH_CLIP_HOLD);
      if (clip !== null) visual.clips.set(name, clip);
    }
    for (const name in sprites.fx.frames) {
      const normal = getFrame(fxSheetId, name, false, false);
      const flipped = getFrame(fxSheetId, name, true, false);
      if (normal !== null && flipped !== null) {
        visual.shadows.set(name, [bakeShadow(normal), bakeShadow(flipped)]);
      }
    }
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
          anim: fxAnim(charId, owner.sprites.fx, projectile.sprite),
          big: fxAnim(charId, owner.sprites.fx, projectile.sprite + 'Big'),
        });
      }
    }
  }
}

/**
 * The character's fx anim `name` with holds in sim frames, or null when there is
 * none or one of its frames is missing from the sheet. Holds fall back to fps.
 */
function fxAnim(charId: string, sheet: ImageSheetData, name: string): ProjectileAnim | null {
  const anims = fxAnimsOf(charId);
  const anim = anims === undefined ? undefined : anims[name];
  if (anim === undefined || anim.frames.length === 0) return null;
  if (!anim.frames.every((n) => sheet.frames[n] !== undefined)) return null;
  const fallback = anim.fps > 0 ? Math.max(1, Math.round(60 / anim.fps)) : 1;
  const holds = anim.frames.map((_, k) =>
    anim.holds !== undefined && anim.holds[k] !== undefined && anim.holds[k] > 0 ? anim.holds[k] : fallback
  );
  let total = 0;
  for (const h of holds) total += h;
  const from = anim.loopFrom !== undefined && anim.loopFrom > 0 && anim.loopFrom < holds.length ? anim.loopFrom : 0;
  let loopStart = 0;
  for (let k = 0; k < from; k++) loopStart += holds[k];
  return { frames: anim.frames.slice(), holds, total, loop: anim.loop, loopStart };
}

/**
 * The frame's silhouette in SHADOW_RGB at SHADOW_ALPHA, dilated by 1 px (8
 * neighbours) onto a canvas 2 px wider and taller. Load time only.
 */
function bakeShadow(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const sctx = src.getContext('2d');
  const out = document.createElement('canvas');
  out.width = w + 2;
  out.height = h + 2;
  const octx = out.getContext('2d');
  if (sctx === null || octx === null) return out;
  const a = sctx.getImageData(0, 0, w, h).data;
  const img = octx.createImageData(w + 2, h + 2);
  const d = img.data;
  const W = w + 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[(y * w + x) * 4 + 3] < SHADOW_MIN_ALPHA) continue;
      // Source (x, y) lands at (x + 1, y + 1); stamp its 3x3 neighbourhood.
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const i = ((y + dy) * W + (x + dx)) * 4;
          d[i] = SHADOW_RGB[0];
          d[i + 1] = SHADOW_RGB[1];
          d[i + 2] = SHADOW_RGB[2];
          d[i + 3] = SHADOW_ALPHA;
        }
      }
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/**
 * Fx `name` as a clip: the fx anim when the character has one, else the probed `<name>0..n`
 * frames at `hold` sim frames each. Null when the sheet has neither.
 */
function resolveClip(charId: string, sheet: ImageSheetData, name: string, hold: number): FxClip | null {
  const anim = fxAnim(charId, sheet, name);
  if (anim !== null) return { frames: anim.frames, holds: anim.holds, total: anim.total };
  const frames = probeFrames(sheet, name);
  if (frames.length === 0) return null;
  const holds = frames.map(() => hold);
  return { frames, holds, total: hold * frames.length };
}

/** The first of `names` the character's fx sheet has, as a clip. */
function firstClip(
  charId: string,
  sheet: ImageSheetData,
  names: readonly string[],
  hold: number
): FxClip | null {
  for (const name of names) {
    const clip = resolveClip(charId, sheet, name, hold);
    if (clip !== null) return clip;
  }
  return null;
}

/**
 * The rise column is world-anchored: it is latched where the fighter took off. Frame order and
 * holds come from the fx anim when there is one, the launch frame from the uspecial move's
 * first vertical-velocity set.
 */
function riseTiming(visual: CharVisual, charId: string): void {
  const clip = firstClip(charId, visual.sprites.fx, RISE_FX, DEFAULT_CLIP_HOLD);
  if (clip === null) return;
  visual.rise = clip.frames;
  visual.riseHolds = clip.holds;
  const def = CHARACTER_DEFS[charId];
  const move = def === undefined ? undefined : def.moves.uspecial;
  const velocity = move === undefined ? undefined : move.velocity;
  if (velocity === undefined) return;
  for (const v of velocity) {
    if (v.setY === true) {
      visual.riseLaunch = v.frame;
      return;
    }
  }
}

/**
 * The character's render data in colour `variant` (0 = the sheet as drawn). A variant is baked
 * from the base sheets on first use and cached; the effect halos are silhouettes, so they are
 * shared with the base visual.
 */
export function getCharVisual(charId: string, variant = 0): CharVisual | null {
  const base = charVisuals.get(charId);
  if (base === undefined) return null;
  if (variant <= 0 || variant >= VARIANT_COUNT) return base;
  let list = variantVisuals.get(charId);
  if (list === undefined) {
    list = new Array<CharVisual | null>(VARIANT_COUNT).fill(null);
    list[0] = base;
    variantVisuals.set(charId, list);
  }
  const cached = list[variant];
  if (cached !== null) return cached;
  const suffix = '#' + variant;
  const bodySheetId = base.bodySheetId + suffix;
  const fxSheetId = base.fxSheetId + suffix;
  if (!bakeVariantSheet(base.bodySheetId, bodySheetId, variant, charId)) return base;
  if (!bakeVariantSheet(base.fxSheetId, fxSheetId, variant, charId)) return base;
  const built: CharVisual = { ...base, bodySheetId, fxSheetId };
  list[variant] = built;
  return built;
}

export function getProjectileVisual(defId: string): ProjectileVisual | null {
  const v = projectileVisuals.get(defId);
  return v === undefined ? null : v;
}
