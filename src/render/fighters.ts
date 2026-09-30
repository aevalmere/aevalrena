import { CHARACTER_DEFS } from '../characters/registry';
import { ECHO_TAIL, SHIELD_MAX } from '../core/constants';
import { MAX_PLAYERS } from '../core/types';
import type { FighterState, GameState, MoveDef } from '../core/types';
import { animClock, animFrameIndex, pickAnimName } from './anim';
import { getFrame, getFrameAnchor, getShadowFrame } from './bake';
import { INK, STONE, STONE_LIGHT, WHITE, glowFor, slotColor } from './colors';
import { getCharVisual } from './visuals';

/**
 * Fighter drawing in world space: body, white flash, shield bubble,
 * invulnerability blink and the respawn platform. Sprites carry no player-colour
 * outline (owner rule, 2026-09-28); the DOM name tag tells fighters apart.
 */

const BLINK_PERIOD = 8;
const BLINK_ON = 4;
const SHIELD_MIN_R = 9;
const SHIELD_MAX_R = 24;
const SHIELD_ALPHA = 0.34;
// The bubble radii above are sized for a 40 px tall hurtbox (Aeval). A taller fighter gets a
// bubble scaled to its hurtbox and centred on it, so Trekmore's helmet sits inside it too.
const SHIELD_REF_H = 40;
const RESPAWN_PLAT_W = 44;
const RESPAWN_PLAT_H = 5;

// Placeholder box drawn in place of a body sprite when a frame is missing from
// the baked sheet (a character without art, or a bad frame name).
const PLACEHOLDER_W_FALLBACK = 26;
const PLACEHOLDER_H_FALLBACK = 40;
const PLACEHOLDER_FILL_ALPHA = 0.35;
const PLACEHOLDER_FLASH_ALPHA = 0.8;
const PLACEHOLDER_MARK_SIZE = 3;
const PLACEHOLDER_MARK_INSET = 4;

/** Respawn platforms sit under any fighter waiting to drop back in. */
export function drawRespawnPlatforms(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  posX: Float32Array,
  posY: Float32Array
): void {
  const count = Math.min(state.fighters.length, posX.length);
  for (let i = 0; i < count; i++) {
    const fighter = state.fighters[i];
    if (fighter.action !== 'respawn') continue;
    const x = Math.round(posX[i] - RESPAWN_PLAT_W / 2);
    const y = Math.round(posY[i]);
    ctx.fillStyle = INK;
    ctx.fillRect(x, y + 2, RESPAWN_PLAT_W, RESPAWN_PLAT_H);
    ctx.fillStyle = STONE;
    ctx.fillRect(x, y, RESPAWN_PLAT_W, 2);
    ctx.fillStyle = STONE_LIGHT;
    ctx.fillRect(x + 2, y + 2, RESPAWN_PLAT_W - 4, 1);
    ctx.fillStyle = glowFor(fighter.variant, fighter.charId);
    ctx.fillRect(x + 6, y - 1, RESPAWN_PLAT_W - 12, 1);
  }
}

function drawShieldBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  shieldHp: number,
  color: string,
  hurtH: number
): void {
  let ratio = shieldHp / SHIELD_MAX;
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;
  const size = hurtH > SHIELD_REF_H ? hurtH / SHIELD_REF_H : 1;
  const r = (SHIELD_MIN_R + (SHIELD_MAX_R - SHIELD_MIN_R) * ratio) * size;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = SHIELD_ALPHA;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(Math.round(x), Math.round(y - (SHIELD_REF_H / 2) * size), r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = prevAlpha;
}

/**
 * Stand-in for a fighter with no body sprite: a translucent box sized to the
 * character's hurtbox filled in the player colour (no outline), and a small
 * ink mark near the top on the side the fighter faces. Draws with no per-frame
 * allocation: every value here is a number, and colours come from existing
 * constants or `slotColor`.
 */
function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  fighter: FighterState,
  x: number,
  y: number,
  color: string,
  white: boolean
): void {
  const def = CHARACTER_DEFS[fighter.charId];
  const box = def === undefined ? undefined : fighter.action === 'crouch' ? def.crouchHurtbox : def.hurtbox;
  const w = box === undefined ? PLACEHOLDER_W_FALLBACK : box.w;
  const h = box === undefined ? PLACEHOLDER_H_FALLBACK : box.h;
  const left = Math.round(x - w / 2);
  const top = Math.round(y - h);
  const prevAlpha = ctx.globalAlpha;

  ctx.globalAlpha = white ? PLACEHOLDER_FLASH_ALPHA : PLACEHOLDER_FILL_ALPHA;
  ctx.fillStyle = white ? WHITE : color;
  ctx.fillRect(left, top, w, h);

  ctx.globalAlpha = 1;
  const markX = fighter.facing === 1
    ? left + w - PLACEHOLDER_MARK_INSET - PLACEHOLDER_MARK_SIZE
    : left + PLACEHOLDER_MARK_INSET;
  const markY = top + Math.round(h / 6);
  ctx.fillStyle = INK;
  ctx.fillRect(markX, markY, PLACEHOLDER_MARK_SIZE, PLACEHOLDER_MARK_SIZE);

  ctx.globalAlpha = prevAlpha;
}

export interface FighterDrawDeps {
  /** Baked body sheet id per fighter index, empty string when the char is unknown. */
  sheetIds: string[];
  /** Frame name per fighter index, empty string when nothing resolves. */
  frameNames: string[];
}

/** Per fighter index: 1 when the resolved animation is drawn mirrored (AnimDef.mirror). */
const animMirror = new Uint8Array(MAX_PLAYERS);

/**
 * Resolve the frame name for every fighter once per render frame. Kept out of
 * the draw loop so the debug overlay can reuse the same strings.
 */
export function resolveFighterFrames(state: GameState, deps: FighterDrawDeps): void {
  const count = Math.min(state.fighters.length, deps.frameNames.length);
  for (let i = 0; i < count; i++) {
    const fighter = state.fighters[i];
    // The body sheet in the fighter's colour variant (baked on first use).
    const visual = getCharVisual(fighter.charId, fighter.variant);
    if (i < animMirror.length) animMirror[i] = 0;
    deps.sheetIds[i] = visual === null ? '' : visual.bodySheetId;
    deps.frameNames[i] = '';
    if (visual === null) continue;
    const animName = pickAnimName(visual.sprites, fighter);
    if (animName === null) continue;
    const def = visual.sprites.anims[animName];
    if (def === undefined || def.frames.length === 0) continue;
    deps.frameNames[i] = def.frames[animFrameIndex(def, animClock(fighter, animName))];
    if (def.mirror === true && i < animMirror.length) animMirror[i] = 1;
  }
}

/**
 * Echo age at which the sim drops the echo: the last replayed hitbox's end plus ECHO_TAIL.
 * -1 when the move has no echo. A loop over the move's hitboxes, no allocation.
 */
function echoEndAge(move: MoveDef): number {
  const echo = move.echo;
  if (echo === undefined) return -1;
  let last = -1;
  for (let h = 0; h < move.hitboxes.length; h++) {
    const hb = move.hitboxes[h];
    if (hb.end > last && echo.groups.indexOf(hb.group) >= 0) last = hb.end;
  }
  return last < 0 ? -1 : last + ECHO_TAIL;
}

/**
 * The shadow echo of a fighter's move: the same animation, echoAge frames in, at the latched
 * point, drawn from the cached shadow bake (bake.ts getShadowFrame). It fades out over the last
 * ECHO_TAIL frames. Drawn before the fighter's body so the owner stays on top. Returns true when
 * something was drawn.
 */
export function drawEcho(ctx: CanvasRenderingContext2D, fighter: FighterState): boolean {
  const f = fighter;
  const moveId = f.echoMove;
  const age = f.echoAge;
  if (moveId === undefined || moveId === null || age === undefined || age < 0) return false;
  const def = CHARACTER_DEFS[fighter.charId];
  if (def === undefined) return false;
  const move: MoveDef | undefined = def.moves[moveId];
  if (move === undefined) return false;
  const visual = getCharVisual(fighter.charId, 0);
  if (visual === null) return false;
  const animName = visual.sprites.animFor('attack', moveId, fighter);
  const anim = visual.sprites.anims[animName];
  if (anim === undefined || anim.frames.length === 0) return false;
  const frameName = anim.frames[animFrameIndex(anim, age)];
  const facing = f.echoFacing === undefined ? fighter.facing : f.echoFacing;
  const flipped = (facing === -1) !== (anim.mirror === true);
  const sheetId = visual.baseBodySheetId;
  const shadow = getShadowFrame(sheetId, frameName, flipped, fighter.variant, fighter.charId);
  const anchor = shadow === null ? null : getFrameAnchor(sheetId, frameName, flipped);
  if (shadow === null || anchor === null) return false;
  const end = echoEndAge(move);
  let fade = 1;
  if (end > 0) {
    fade = (end - age) / ECHO_TAIL;
    if (fade > 1) fade = 1;
    if (fade <= 0) return false;
  }
  const ex = f.echoX === undefined ? fighter.x : f.echoX;
  const ey = f.echoY === undefined ? fighter.y : f.echoY;
  const prev = ctx.globalAlpha;
  if (fade < 1) ctx.globalAlpha = prev * fade;
  ctx.drawImage(shadow, Math.round(ex - anchor.ax), Math.round(ey - anchor.ay));
  if (fade < 1) ctx.globalAlpha = prev;
  return true;
}

export function drawFighters(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  posX: Float32Array,
  posY: Float32Array,
  flash: Uint8Array,
  deps: FighterDrawDeps,
  renderTick: number
): void {
  const blinkOff = renderTick % BLINK_PERIOD >= BLINK_ON;
  const count = Math.min(state.fighters.length, posX.length);

  for (let i = 0; i < count; i++) {
    const fighter = state.fighters[i];
    if (fighter.action === 'dead') continue;

    const sheetId = deps.sheetIds[i];
    const frameName = deps.frameNames[i];
    const color = slotColor(state.config.players, fighter.slot);
    const x = posX[i];
    const y = posY[i];

    const hidden = fighter.invuln > 0 && blinkOff;

    // The echo does not blink with its owner: it is a separate shadow standing where the move began.
    drawEcho(ctx, fighter);

    if (!hidden) {
      const white = flash[i] > 0;
      let drew = false;
      if (sheetId !== '' && frameName !== '') {
        // Sheets face right. Flip for a left-facing fighter, and flip again for
        // an animation drawn mirrored (back-facing moves).
        const flipped = (fighter.facing === -1) !== (i < animMirror.length && animMirror[i] === 1);
        const body = getFrame(sheetId, frameName, flipped, white);
        const anchor = body === null ? null : getFrameAnchor(sheetId, frameName, flipped);
        if (body !== null && anchor !== null) {
          const dx = Math.round(x - anchor.ax);
          const dy = Math.round(y - anchor.ay);
          ctx.drawImage(body, dx, dy);
          drew = true;
        }
      }
      if (!drew) drawPlaceholder(ctx, fighter, x, y, color, white);
    }

    if (fighter.action === 'shield' || fighter.action === 'shieldStun') {
      const hurt = CHARACTER_DEFS[fighter.charId]?.hurtbox;
      drawShieldBubble(ctx, x, y, fighter.shieldHp, color, hurt === undefined ? SHIELD_REF_H : hurt.h);
    }
  }
}
