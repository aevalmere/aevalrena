import { lerp } from '../core/math';
import type {
  DebugFlags,
  FighterState,
  GameState,
  ParallaxLayer,
  PerfSample,
  Renderer,
  StageArt,
  StageDef,
} from '../core/types';
import { MAX_PLAYERS, VIEW_H, VIEW_W } from '../core/types';
import { STAGE_ART, STAGE_DEFS } from '../stages/registry';
import { clearBakes } from './bake';
import { createCamera, snapCamera, updateCamera } from './camera';
import { INK, PALE, PERCENT_RAMP, PLAYER_COLORS } from './colors';
import { drawDebugText, drawDebugWorld } from './debug';
import type { FighterDrawDeps } from './fighters';
import { drawFighters, drawRespawnPlatforms, resolveFighterFrames } from './fighters';
import { bakeFont } from './font';
import {
  clearSparks,
  createSparks,
  drawFighterFx,
  drawProjectiles,
  drawSparks,
  spawnSpark,
  stepSparks,
} from './fx';
import { createHudState, drawHud, resetHudState, stepHud } from './hud';
import {
  clearParticles,
  createParticles,
  drawParticles,
  spawnDashDust,
  spawnDroplets,
  spawnHitSparks,
  spawnKoBurst,
  spawnLandDust,
  stepParticles,
} from './particles';
import { fitCanvas } from './scale';
import { addShake, createShake, resetShake, stepShake } from './shake';
import { buildVisuals } from './visuals';

/**
 * Canvas 2D renderer. One frame is: clear, parallax background, world pass
 * (platforms, respawn platforms, projectiles, fighters, effects, particles),
 * foreground, HUD, debug. Positions interpolate between the previous and the
 * current sim frame; nothing in the frame path allocates.
 */

const PROJECTILE_CAP = 256;
const FLASH_FRAMES = 2;
/** Most sim frames one render call will catch up on, so a stall never lurches. */
const MAX_CATCHUP_FRAMES = 4;
const HIT_SHAKE_BASE = 0.6;
const HIT_SHAKE_PER_KB = 0.03;
const HIT_SHAKE_MAX = 3;
const KO_SHAKE = 4;
const HARD_LAND_SHAKE = 1;
const SHIELD_BREAK_SHAKE = 2;

/** Optional hook a StageArt module can expose so its layers bake during load. */
interface PreparableStageArt extends StageArt {
  prepare?: () => void;
}

function fontColors(): string[] {
  const colors: string[] = [PALE];
  for (const c of PERCENT_RAMP) colors.push(c);
  for (const c of PLAYER_COLORS) colors.push(c);
  return colors;
}

function findFighterBySlot(state: GameState, slot: number): FighterState | null {
  for (let i = 0; i < state.fighters.length; i++) {
    if (state.fighters[i].slot === slot) return state.fighters[i];
  }
  return null;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const maybeCtx = canvas.getContext('2d');
  if (maybeCtx === null) throw new Error('canvas 2d context unavailable');
  const ctx: CanvasRenderingContext2D = maybeCtx;

  const camera = createCamera();
  const shakeState = createShake();
  const particles = createParticles();
  const sparks = createSparks();
  const hud = createHudState(MAX_PLAYERS);

  const posX = new Float32Array(MAX_PLAYERS);
  const posY = new Float32Array(MAX_PLAYERS);
  const velX = new Float32Array(MAX_PLAYERS);
  const live = new Uint8Array(MAX_PLAYERS);
  const flash = new Uint8Array(MAX_PLAYERS);
  const slotToIndex = new Int32Array(MAX_PLAYERS);
  const projX = new Float32Array(PROJECTILE_CAP);
  const projY = new Float32Array(PROJECTILE_CAP);

  const frameNames: string[] = new Array(MAX_PLAYERS).fill('');
  const sheetIds: string[] = new Array(MAX_PLAYERS).fill('');
  const drawDeps: FighterDrawDeps = { sheetIds, frameNames };

  let activeStageId = '';
  let lastConsumedFrame = -1;
  let renderTick = 0;
  let cameraPrimed = false;
  const startedAt = performance.now();

  function stageFor(state: GameState): StageDef | null {
    const byState = STAGE_DEFS[state.stageId];
    if (byState !== undefined) return byState;
    const byActive = STAGE_DEFS[activeStageId];
    return byActive === undefined ? null : byActive;
  }

  function artFor(state: GameState): StageArt | null {
    const byState = STAGE_ART[state.stageId];
    if (byState !== undefined) return byState;
    const byActive = STAGE_ART[activeStageId];
    return byActive === undefined ? null : byActive;
  }

  function resetTransientState(): void {
    clearParticles(particles);
    clearSparks(sparks);
    resetShake(shakeState);
    resetHudState(hud);
    flash.fill(0);
    cameraPrimed = false;
    lastConsumedFrame = -1;
  }

  function indexSlots(state: GameState): void {
    slotToIndex.fill(-1);
    for (let i = 0; i < state.fighters.length; i++) {
      const slot = state.fighters[i].slot;
      if (slot >= 0 && slot < MAX_PLAYERS) slotToIndex[slot] = i;
    }
  }

  function charIdForSlot(state: GameState, slot: number): string {
    if (slot < 0 || slot >= MAX_PLAYERS) return '';
    const i = slotToIndex[slot];
    return i < 0 ? '' : state.fighters[i].charId;
  }

  function consumeEvents(state: GameState): void {
    for (let e = 0; e < state.events.length; e++) {
      const event = state.events[e];
      switch (event.type) {
        case 'hit': {
          spawnHitSparks(particles, event.x, event.y, event.damage);
          spawnDroplets(particles, event.x, event.y, 4);
          spawnSpark(sparks, event.x, event.y, charIdForSlot(state, event.attacker));
          let amount = HIT_SHAKE_BASE + event.kb * HIT_SHAKE_PER_KB;
          if (amount > HIT_SHAKE_MAX) amount = HIT_SHAKE_MAX;
          addShake(shakeState, amount);
          const vi = event.victim >= 0 && event.victim < MAX_PLAYERS ? slotToIndex[event.victim] : -1;
          if (vi >= 0) flash[vi] = FLASH_FRAMES;
          break;
        }
        case 'shieldHit':
          spawnHitSparks(particles, event.x, event.y, 2);
          break;
        case 'shieldBreak':
          spawnHitSparks(particles, event.x, event.y, 12);
          addShake(shakeState, SHIELD_BREAK_SHAKE);
          break;
        case 'ko':
          spawnKoBurst(particles, event.x, event.y);
          addShake(shakeState, KO_SHAKE);
          break;
        case 'land':
          spawnLandDust(particles, event.x, event.y, event.hard);
          if (event.hard) addShake(shakeState, HARD_LAND_SHAKE);
          break;
        case 'dash':
          spawnDashDust(particles, event.x, event.y, event.facing);
          break;
        case 'projectileSpawn':
          spawnDroplets(particles, event.x, event.y, 6);
          break;
        case 'projectileDie':
          spawnDroplets(particles, event.x, event.y, 4);
          break;
        case 'respawn':
          spawnDroplets(particles, event.x, event.y, 8);
          break;
        default:
          break;
      }
    }
  }

  function interpolate(state: GameState, prev: GameState | null, alpha: number): void {
    const count = Math.min(state.fighters.length, MAX_PLAYERS);
    for (let i = 0; i < count; i++) {
      const f = state.fighters[i];
      let x = f.x;
      let y = f.y;
      const frozen = f.action === 'dead' || f.action === 'respawn' || f.hitlag > 0;
      if (prev !== null && !frozen) {
        const p = findFighterBySlot(prev, f.slot);
        if (p !== null) {
          x = lerp(p.x, f.x, alpha);
          y = lerp(p.y, f.y, alpha);
        }
      }
      posX[i] = x;
      posY[i] = y;
      velX[i] = f.vx;
      live[i] = f.action === 'dead' ? 0 : 1;
    }
    for (let i = count; i < MAX_PLAYERS; i++) {
      live[i] = 0;
      velX[i] = 0;
    }

    const pcount = Math.min(state.projectiles.length, PROJECTILE_CAP);
    for (let i = 0; i < pcount; i++) {
      const projectile = state.projectiles[i];
      let x = projectile.x;
      let y = projectile.y;
      if (prev !== null) {
        for (let j = 0; j < prev.projectiles.length; j++) {
          const p = prev.projectiles[j];
          if (p.id !== projectile.id) continue;
          x = lerp(p.x, projectile.x, alpha);
          y = lerp(p.y, projectile.y, alpha);
          break;
        }
      }
      projX[i] = x;
      projY[i] = y;
    }
  }

  /**
   * Advance everything that is measured in sim frames: shake decay, particles,
   * sparks, the hit flash and the invulnerability blink. `steps` is the number
   * of sim frames since the last render call, so these run at the same speed on
   * any display and stand still when a render repeats one sim frame.
   */
  function stepRenderFrame(steps: number): void {
    renderTick += steps;
    stepShake(shakeState, steps);
    stepParticles(particles, steps);
    stepSparks(sparks, steps);
    if (steps <= 0) return;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (flash[i] > 0) flash[i] = flash[i] > steps ? flash[i] - steps : 0;
    }
  }

  function drawLayers(layers: readonly ParallaxLayer[], t: number): void {
    ctx.setTransform(1, 0, 0, 1, shakeState.x, shakeState.y);
    for (let i = 0; i < layers.length; i++) {
      layers[i].draw(ctx, camera.x, camera.y, camera.zoom, t);
    }
  }

  return {
    async load(): Promise<void> {
      clearBakes();
      await buildVisuals();
      bakeFont(fontColors());
      for (const stageId in STAGE_ART) {
        const art = STAGE_ART[stageId] as PreparableStageArt;
        if (typeof art.prepare === 'function') art.prepare();
      }
      fitCanvas(canvas);
      ctx.imageSmoothingEnabled = false;
    },

    setStage(stageId: string): void {
      activeStageId = stageId;
      resetTransientState();
    },

    resize(): void {
      fitCanvas(canvas);
      ctx.imageSmoothingEnabled = false;
    },

    shake(amount: number): void {
      addShake(shakeState, amount);
    },

    render(
      state: GameState,
      prev: GameState | null,
      alpha: number,
      debug: DebugFlags,
      perf: PerfSample
    ): void {
      if (activeStageId === '') activeStageId = state.stageId;

      indexSlots(state);

      if (state.frame < lastConsumedFrame) resetTransientState();

      let steps = state.frame - lastConsumedFrame;
      if (steps < 0) steps = 0;
      if (steps > MAX_CATCHUP_FRAMES) steps = MAX_CATCHUP_FRAMES;

      // Age first, then apply this sim frame's events, so a hit flashes and
      // shakes on the very render that consumes it and for its full duration.
      stepRenderFrame(steps);
      if (state.frame !== lastConsumedFrame) {
        consumeEvents(state);
        lastConsumedFrame = state.frame;
      }
      stepHud(hud, state, steps);

      const clampedAlpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
      interpolate(state, prev, clampedAlpha);

      const stage = stageFor(state);
      const art = artFor(state);
      const t = (performance.now() - startedAt) / 1000;

      if (stage !== null) {
        if (!cameraPrimed) {
          snapCamera(camera, posX, posY, velX, live, MAX_PLAYERS, stage.cameraBounds);
          cameraPrimed = true;
        } else {
          updateCamera(camera, posX, posY, velX, live, MAX_PLAYERS, stage.cameraBounds);
        }
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 1;
      ctx.fillStyle = INK;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      if (art !== null) drawLayers(art.layers, t);

      const tx = Math.round(VIEW_W / 2 - camera.x * camera.zoom) + shakeState.x;
      const ty = Math.round(VIEW_H / 2 - camera.y * camera.zoom) + shakeState.y;
      ctx.setTransform(camera.zoom, 0, 0, camera.zoom, tx, ty);

      if (art !== null && stage !== null) art.drawPlatforms(ctx, stage, t);
      drawRespawnPlatforms(ctx, state, posX, posY);
      drawProjectiles(ctx, state, projX, projY);
      resolveFighterFrames(state, drawDeps);
      drawFighters(ctx, state, posX, posY, flash, drawDeps, renderTick);
      drawFighterFx(ctx, state, posX, posY);
      drawSparks(ctx, sparks);
      drawParticles(ctx, particles);
      if (debug.hitboxes) drawDebugWorld(ctx, state, posX, posY, projX, projY);

      if (art !== null) drawLayers(art.foreground, t);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      drawHud(ctx, state, hud);
      drawDebugText(ctx, state, debug, perf);
    },
  };
}
