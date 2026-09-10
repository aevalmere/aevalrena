import { createLoop, type Loop } from './core/loop';
import { createRng, nextFloat } from './core/rng';
import { Btn } from './core/types';
import type {
  DebugFlags,
  GameState,
  InputFrame,
  LocalSession,
  MatchConfig,
  PerfSample,
  ResultsData,
  Renderer,
  UiController,
} from './core/types';
import { CHARACTER_LIST } from './characters/registry';
import { STAGE_LIST } from './stages/registry';
import { cpuInput } from './ai';
import { createInputSystem, createLocalSession } from './input';
import { createTuner, type Tuner } from './debug/tuner';
import { createRenderer } from './render';
import { cloneGameState, createGameState, stepGame } from './sim';
import { createUi } from './ui';

/**
 * App entry point and state machine: title -> mode -> select (all owned by the
 * UI) -> match -> results. Owns the fixed-step loop, the previous-frame
 * snapshot used for render interpolation, the CPU input providers, the debug
 * overlay flags and the live tuning panel.
 */

type Phase = 'menu' | 'match' | 'paused' | 'results';

/** Frames the match keeps running after the last KO before results appear. */
const RESULTS_DELAY = 90;
const FPS_WINDOW_MS = 1000;
/** Seed step for a rematch: a linear congruential jump off the previous seed. */
const SEED_STEP_MUL = 1664525;
const SEED_STEP_ADD = 1013904223;

interface Match {
  config: MatchConfig;
  state: GameState;
  prev: GameState;
  session: LocalSession;
  /** False when every slot is a CPU, so no slot can ever press Start. */
  hasHuman: boolean;
  endTimer: number;
  ended: boolean;
}

const debugFlags: DebugFlags = { hitboxes: false, frameData: false, perf: false };
const perf: PerfSample = { simMs: 0, renderMs: 0, fps: 0 };
/** Handed to every CPU slot while the tuner freezes them. Never mutated. */
const ZERO_INPUT: InputFrame = { held: 0, pressed: 0, released: 0 };

function nextSeed(seed: number): number {
  const next = (Math.imul(seed, SEED_STEP_MUL) + SEED_STEP_ADD) >>> 0;
  return next === 0 ? 1 : next;
}

/**
 * Copy only the fields the renderer interpolates from. The snapshot object is
 * created once per match, so no frame allocates unless the projectile count
 * reaches a new high water mark.
 */
function snapshotPrev(prev: GameState, state: GameState): void {
  prev.frame = state.frame;
  const fcount = state.fighters.length;
  for (let i = 0; i < fcount; i++) {
    const src = state.fighters[i];
    const dst = prev.fighters[i];
    if (dst === undefined) continue;
    dst.slot = src.slot;
    dst.x = src.x;
    dst.y = src.y;
    dst.vx = src.vx;
    dst.vy = src.vy;
    dst.action = src.action;
    dst.hitlag = src.hitlag;
  }
  const pcount = state.projectiles.length;
  for (let i = 0; i < pcount; i++) {
    const src = state.projectiles[i];
    if (i >= prev.projectiles.length) prev.projectiles.push({ ...src });
    const dst = prev.projectiles[i];
    dst.id = src.id;
    dst.x = src.x;
    dst.y = src.y;
  }
}

function buildResults(state: GameState): ResultsData {
  const players: ResultsData['players'] = [];
  for (let i = 0; i < state.fighters.length; i++) {
    const f = state.fighters[i];
    players.push({ slot: f.slot, charId: f.charId, stocks: f.stocks, percent: f.percent });
  }
  return { winner: state.winner, players };
}

function anyHuman(config: MatchConfig): boolean {
  for (let i = 0; i < config.players.length; i++) {
    if (!config.players[i].cpu) return true;
  }
  return false;
}

function startPressed(inputs: InputFrame[]): boolean {
  for (let i = 0; i < inputs.length; i++) {
    if ((inputs[i].pressed & Btn.Start) !== 0) return true;
  }
  return false;
}

function boot(): void {
  const canvasEl = document.getElementById('game');
  const uiRoot = document.getElementById('ui');
  if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error('missing #game canvas');
  if (uiRoot === null) throw new Error('missing #ui root');
  const canvas: HTMLCanvasElement = canvasEl;

  const input = createInputSystem();
  const renderer: Renderer = createRenderer(canvas);

  let phase: Phase = 'menu';
  let match: Match | null = null;
  let ui: UiController | null = null;

  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  let freezeCpu = false;

  function endMatch(): void {
    if (match === null) return;
    match.session.stop();
    match = null;
  }

  /**
   * Sample and discard one input frame. Clears the keyboard latch so a key
   * pressed inside a menu is not replayed as a game input on the next step.
   */
  function drainInputs(): void {
    if (match === null) return;
    match.session.inputsForFrame(match.state.frame);
  }

  function showResults(): void {
    if (match === null || ui === null) return;
    const data = buildResults(match.state);
    phase = 'results';
    ui.show('results', data);
  }

  function step(): void {
    if (match === null || phase !== 'match') return;
    const m = match;
    const inputs = m.session.inputsForFrame(m.state.frame);
    if (inputs === null) return;

    snapshotPrev(m.prev, m.state);

    const simStart = performance.now();
    stepGame(m.state, inputs);
    perf.simMs = performance.now() - simStart;
    m.session.setState(m.state);

    if (m.state.finished) {
      if (!m.ended) {
        m.ended = true;
        m.endTimer = RESULTS_DELAY;
      } else if (m.endTimer > 0) {
        m.endTimer--;
        if (m.endTimer === 0) showResults();
      }
      return;
    }

    if (startPressed(inputs)) pauseMatch();
  }

  /** Wipe the last match frame so a menu never sits over a frozen battle. */
  function clearCanvas(): void {
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0e0f17';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function render(alpha: number): void {
    // The results screen can navigate to character select on its own; drop the
    // finished match once the UI has moved off it.
    if (phase === 'results' && ui !== null) {
      const screen = ui.current();
      if (screen !== null && screen !== 'results') {
        loop.stop();
        endMatch();
        phase = 'menu';
        clearCanvas();
        return;
      }
    }

    const renderStart = performance.now();
    if (match !== null) {
      renderer.render(match.state, match.prev, alpha, debugFlags, perf);
    }
    perf.renderMs = performance.now() - renderStart;

    fpsFrames++;
    const elapsed = renderStart - fpsWindowStart;
    if (elapsed >= FPS_WINDOW_MS) {
      perf.fps = (fpsFrames * 1000) / elapsed;
      fpsFrames = 0;
      fpsWindowStart = renderStart;
    }
  }

  const loop: Loop = createLoop({ step, render, hz: 60 });

  function pauseMatch(): void {
    if (match === null || ui === null || phase !== 'match') return;
    phase = 'paused';
    loop.setPaused(true);
    ui.show('pause');
  }

  function startMatch(config: MatchConfig): void {
    if (ui === null) return;
    endMatch();

    const state = createGameState(config);
    const prev = cloneGameState(state);
    const session = createLocalSession(input, config);
    const cpuRng = createRng((config.seed ^ 0x9e3779b9) >>> 0);
    const rand = (): number => nextFloat(cpuRng);

    for (let i = 0; i < config.players.length; i++) {
      const player = config.players[i];
      if (!player.cpu) continue;
      const slot = player.slot;
      const level = player.cpuLevel;
      session.setSlotProvider(slot, (_frame, st) => (
        freezeCpu ? ZERO_INPUT : cpuInput(st, slot, level, rand)
      ));
    }

    session.setState(state);
    session.start();

    match = { config, state, prev, session, hasHuman: anyHuman(config), endTimer: 0, ended: false };
    renderer.setStage(config.stageId);
    ui.hide();
    phase = 'match';
    // Swallow the key press that started the match so it is not read as a jump.
    drainInputs();
    loop.setPaused(false);
    loop.start();
  }

  function resume(): void {
    if (match === null || ui === null || phase !== 'paused') return;
    ui.hide();
    phase = 'match';
    // Swallow the key press that closed the pause menu so it does not re-pause.
    drainInputs();
    loop.setPaused(false);
  }

  function quit(): void {
    if (ui === null) return;
    loop.stop();
    endMatch();
    phase = 'menu';
    clearCanvas();
    ui.show('title');
  }

  function rematch(): void {
    if (match === null) return;
    const previous = match.config;
    const players: MatchConfig['players'] = previous.players.map((p) => ({
      slot: p.slot,
      charId: p.charId,
      cpu: p.cpu,
      cpuLevel: p.cpuLevel,
    }));
    startMatch({
      stageId: previous.stageId,
      players,
      stocks: previous.stocks,
      timeLimitSec: previous.timeLimitSec,
      seed: nextSeed(previous.seed),
    });
  }

  ui = createUi(
    uiRoot,
    { characters: CHARACTER_LIST, stages: STAGE_LIST, input },
    { startMatch, resume, quit, rematch }
  );

  // The panel sits outside the UI root, which is hidden while a match runs.
  const tuner: Tuner = createTuner({
    root: document.body,
    getState: () => (match === null ? null : match.state),
    setTimeScale: (scale: number) => loop.setTimeScale(scale),
    setFreezeCpu: (frozen: boolean) => { freezeCpu = frozen; },
  });
  tuner.applySaved();

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    // A CPU-only match has no slot that can press Start, so the pause key has
    // to come off the window or the match cannot be left.
    if (
      match !== null &&
      !match.hasHuman &&
      phase === 'match' &&
      e.code === input.controls.players[0].bindings.start
    ) {
      e.preventDefault();
      pauseMatch();
      return;
    }
    switch (e.code) {
      case 'F1':
        e.preventDefault();
        debugFlags.hitboxes = !debugFlags.hitboxes;
        break;
      case 'F2':
        e.preventDefault();
        debugFlags.frameData = !debugFlags.frameData;
        break;
      case 'F3':
        e.preventDefault();
        debugFlags.perf = !debugFlags.perf;
        break;
      case 'F4':
        e.preventDefault();
        tuner.toggle();
        break;
      default:
        break;
    }
  });

  window.addEventListener('resize', () => renderer.resize());

  renderer
    .load()
    .then(() => {
      renderer.resize();
      if (ui !== null) ui.show('title');
    })
    .catch((err: unknown) => {
      showBootError(uiRoot, err);
    });
}

function showBootError(root: HTMLElement, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  root.hidden = false;
  root.textContent = `Startup failed: ${message}`;
  root.style.color = '#ff7f7f';
  root.style.font = '14px monospace';
  root.style.padding = '16px';
  console.error(err);
}

try {
  boot();
} catch (err) {
  const root = document.getElementById('ui');
  if (root !== null) showBootError(root, err);
  else console.error(err);
}
