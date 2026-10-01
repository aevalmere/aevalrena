import { CHARACTER_DEFS } from '../characters/registry';
import { ECHO_TAIL, SHIELD_MAX } from '../core/constants';
import { MAX_PLAYERS } from '../core/types';
import type { FighterState, GameState, MoveDef } from '../core/types';
import { animClock, animFrameIndex, pickAnimName } from './anim';
import { ECHO_PAD, getFrame, getFrameAnchor, getShadowFrame } from './bake';
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
export function echoEndAge(move: MoveDef): number {
  const echo = move.echo;
  if (echo === undefined) return -1;
  let last = -1;
  for (let h = 0; h < move.hitboxes.length; h++) {
    const hb = move.hitboxes[h];
    if (hb.end > last && echo.groups.indexOf(hb.group) >= 0) last = hb.end;
  }
  return last < 0 ? -1 : last + ECHO_TAIL;
}

/** MoveDef.hiddenFrames, read structurally so this compiles before and after the field lands. */
interface MaybeHidden { hiddenFrames?: readonly [number, number] }

/** The move's hidden body frames [start, end] inclusive, or null. */
export function hiddenRange(move: MoveDef): readonly [number, number] | null {
  const h = (move as MoveDef & MaybeHidden).hiddenFrames;
  return h === undefined || h === null || h.length < 2 ? null : h;
}

/** Frames before hiddenFrames over which the body fades out, and after over which it fades in. */
export const HIDE_FADE_OUT = 2;
export const HIDE_FADE_IN = 8;

/**
 * Body opacity for a fighter whose move has hiddenFrames: 0 inside the range, fading out over
 * the HIDE_FADE_OUT frames before it and back in over the HIDE_FADE_IN frames after. 1 otherwise.
 */
export function bodyAlpha(fighter: FighterState): number {
  if (fighter.action !== 'attack' || fighter.moveId === null || fighter.onBranch === true) return 1;
  const def = CHARACTER_DEFS[fighter.charId];
  const move = def === undefined ? undefined : def.moves[fighter.moveId];
  if (move === undefined) return 1;
  const range = hiddenRange(move);
  if (range === null) return 1;
  const af = fighter.actionFrame;
  if (af >= range[0] && af <= range[1]) return 0;
  if (af < range[0] && af >= range[0] - HIDE_FADE_OUT) return (range[0] - af) / (HIDE_FADE_OUT + 1);
  if (af > range[1] && af <= range[1] + HIDE_FADE_IN) return (af - range[1]) / (HIDE_FADE_IN + 1);
  return 1;
}

/**
 * Share of the echo's delay over which the clone darts from his body to its strike point; it
 * waits there, on guard, for the rest of the delay.
 */
export const ECHO_DART_SHARE = 0.7;
/** The clone's opacity on its first visible frame, still overlapping his body. */
const ECHO_SPLIT_ALPHA = 0.4;

/** Reused result of echoPlace. Read it before the next call. */
export interface EchoPlace { x: number; y: number; facing: number; alpha: number; age: number }
const placeOut: EchoPlace = { x: 0, y: 0, facing: 1, alpha: 0, age: 0 };

/**
 * Where the shadow clone stands and how opaque it is, given the owner drawn at (ox, oy). Before
 * its first replayed frame (echoAge < 0) it splits off his body: it starts on him and darts,
 * easing out hard, to its point (echoX/echoY: in front of him along his travel direction; the
 * sim may move it with him every frame, so only the offset from him is used) over the first
 * ECHO_DART_SHARE of the delay, solidifying as it goes. From age 0 it stands on that point and
 * plays the move; it fades over the last ECHO_TAIL frames. The
 * result's `age` is the animation clock (0 while darting). `age` defaults to the fighter's
 * echoAge. Null when there is no echo.
 */
export function echoPlace(
  fighter: FighterState,
  move: MoveDef,
  ox: number,
  oy: number,
  age = fighter.echoAge
): EchoPlace | null {
  const f = fighter;
  if (age === undefined) return null;
  const facing = f.echoFacing === undefined ? fighter.facing : f.echoFacing;
  // The clone's point relative to his sim position, carried onto his drawn position: the sim
  // moves the point with him (it follows him for its whole life), and the offset keeps the
  // clone locked to his interpolated body instead of lagging it by a sim frame.
  const ex = f.echoX === undefined ? ox : ox + (f.echoX - fighter.x);
  const ey = f.echoY === undefined ? oy : oy + (f.echoY - fighter.y);
  placeOut.facing = facing;
  if (age < 0) {
    const delay = move.echo !== undefined && move.echo.delayFrames > 0 ? move.echo.delayFrames : 1;
    let t = (delay + age) / delay;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    let u = t / ECHO_DART_SHARE;
    if (u > 1) u = 1;
    const inv = 1 - u;
    const e = 1 - inv * inv * inv;
    placeOut.x = ox + (ex - ox) * e;
    placeOut.y = oy + (ey - oy) * e;
    const a = ECHO_SPLIT_ALPHA + t * 2;
    placeOut.alpha = t <= 0 ? 0 : a > 1 ? 1 : a;
    placeOut.age = 0;
    return placeOut;
  }
  const end = echoEndAge(move);
  let fade = 1;
  if (end > 0) {
    fade = (end - age) / ECHO_TAIL;
    if (fade > 1) fade = 1;
    if (fade <= 0) return null;
  }
  placeOut.x = ex;
  placeOut.y = ey;
  placeOut.alpha = fade;
  placeOut.age = age;
  return placeOut;
}

/**
 * The shadow clone of a fighter's move (echoPlace for where): the same animation at the echo's
 * age, drawn from the cached clone bake (bake.ts getShadowFrame). Drawn before the fighter's body
 * so the owner stays on top. (ox, oy) is the owner's drawn position. Returns true when something
 * was drawn.
 */
export function drawEcho(ctx: CanvasRenderingContext2D, fighter: FighterState, ox = fighter.x, oy = fighter.y): boolean {
  const moveId = fighter.echoMove;
  if (moveId === undefined || moveId === null) return false;
  const def = CHARACTER_DEFS[fighter.charId];
  if (def === undefined) return false;
  const move: MoveDef | undefined = def.moves[moveId];
  if (move === undefined) return false;
  const place = echoPlace(fighter, move, ox, oy);
  if (place === null || place.alpha <= 0) return false;
  const visual = getCharVisual(fighter.charId, 0);
  if (visual === null) return false;
  const animName = visual.sprites.animFor('attack', moveId, fighter);
  const anim = visual.sprites.anims[animName];
  if (anim === undefined || anim.frames.length === 0) return false;
  const frameName = anim.frames[animFrameIndex(anim, place.age)];
  const flipped = (place.facing === -1) !== (anim.mirror === true);
  const sheetId = visual.baseBodySheetId;
  const shadow = getShadowFrame(sheetId, frameName, flipped, fighter.variant, fighter.charId);
  const anchor = shadow === null ? null : getFrameAnchor(sheetId, frameName, flipped);
  if (shadow === null || anchor === null) return false;
  const prev = ctx.globalAlpha;
  const fade = place.alpha;
  if (fade < 1) ctx.globalAlpha = prev * fade;
  ctx.drawImage(shadow, Math.round(place.x - anchor.ax - ECHO_PAD), Math.round(place.y - anchor.ay - ECHO_PAD));
  if (fade < 1) ctx.globalAlpha = prev;
  return true;
}

/**
 * True while an attacking fighter is inside an invulnerable window its move defines: MoveDef.invuln,
 * the shadow step's invuln, or a recall's invulnFrames from the branch start. Respawn, dodge and
 * other invulnerability still blink.
 */
export function inMoveInvuln(fighter: FighterState): boolean {
  if (fighter.action !== 'attack' || fighter.moveId === null) return false;
  const def = CHARACTER_DEFS[fighter.charId];
  const move = def === undefined ? undefined : def.moves[fighter.moveId];
  if (move === undefined) return false;
  const af = fighter.actionFrame;
  const inv = move.invuln;
  if (inv !== undefined && af >= inv[0] && af <= inv[1]) return true;
  const step = move.shadowStep;
  if (step !== undefined && af >= step.invuln[0] && af <= step.invuln[1]) return true;
  const recall = move.recall;
  const branch = move.branch;
  if (fighter.onBranch === true && recall !== undefined && branch !== undefined) {
    if (af >= branch.start && af < branch.start + recall.invulnFrames) return true;
  }
  return false;
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

    // No blink inside an attack's own invulnerable window (a counter branch, a recall, a step).
    const hidden = fighter.invuln > 0 && blinkOff && !inMoveInvuln(fighter);
    // A move's hiddenFrames skip the body (and its fades around them).
    const alpha = bodyAlpha(fighter);

    // The echo does not blink with its owner: it is a separate shadow clone of the move.
    drawEcho(ctx, fighter, x, y);

    if (!hidden && alpha > 0) {
      const prevAlpha = ctx.globalAlpha;
      if (alpha < 1) ctx.globalAlpha = prevAlpha * alpha;
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
      if (alpha < 1) ctx.globalAlpha = prevAlpha;
    }

    if (fighter.action === 'shield' || fighter.action === 'shieldStun') {
      const hurt = CHARACTER_DEFS[fighter.charId]?.hurtbox;
      drawShieldBubble(ctx, x, y, fighter.shieldHp, color, hurt === undefined ? SHIELD_REF_H : hurt.h);
    }
  }
}
