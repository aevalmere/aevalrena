import { createLoop, type Loop } from './core/loop';
import { createRng, nextFloat } from './core/rng';
import { Btn, MAX_PLAYERS } from './core/types';
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
import { CHARACTER_DEFS, CHARACTER_LIST } from './characters/registry';
import { STAGE_LIST } from './stages/registry';
import { cpuInput, flushAevalmereProfiles, warmAevalmere } from './ai';
import { createInputSystem, createLocalSession, padStartPressed } from './input';
import { createTuner, type Tuner } from './debug/tuner';
import { createRenderer } from './render';
import { createCamera, snapCamera, updateCamera } from './render/camera';
import { liveView } from './render/scale';
import { STAGE_DEFS } from './stages/registry';
import { cloneGameState, createGameState, stepGame } from './sim';
import { createUi } from './ui';
import { createHud, type HudView } from './ui/hud';
import { createLanSessionImpl, p1OnlyConfig, type LanSession } from './input/session';
import { startBackgroundTicker, type BackgroundTicker } from './net/bgtick';
import { lanClient } from './net/client';
import { eliminateFighter } from './net/eliminate';
import type { InputHistory, MatchStart, Retirement } from './net/protocol';
import { RollbackSession, type LocalSource, type RollbackOptions } from './net/rollback';
import type { NetTransport } from './net/transport';
import { createLocalView, type LocalView } from './net/view';
import { createLanOverlay, type LanOverlay } from './ui/lan';

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
  /** Present for a LAN match (docs/LAN.md): the rollback engine steps the sim, not step(). */
  lan?: LanMatch;
}

interface LanMatch {
  session: LanSession;
  rollback: RollbackSession;
  view: LocalView;
  transport: NetTransport & { dispose(): void };
  overlay: LanOverlay;
  /** Steps the match from a Worker while the tab is hidden (rAF stops there). */
  ticker: BackgroundTicker;
  /** Slots whose player dropped, with their name and the time the reconnect window closes. */
  dropped: Map<number, { name: string; until: number }>;
  /**
   * Players who left for good, by slot, with when the news arrived. They are eliminated in the
   * sim (RollbackSession.retire), so the match plays on or ends by the normal rule.
   */
  left: Map<number, { name: string; at: number }>;
  /** When this browser lost the lobby for good (0 = never): results follow a short banner. */
  lostAt: number;
  /** Consecutive ticks the engine could not advance (a peer is behind). */
  waitTicks: number;
  desyncFrame: number;
  offKey: () => void;
}

/**
 * Longest catch-up per background tick, in sim frames, and the most elapsed time one tick may
 * cover. A background browser can deliver Worker messages as rarely as once a second or two,
 * so a hidden peer must be able to catch up a full second at once (a step costs ~50 us).
 */
const BG_MAX_STEPS = 90;
const BG_MAX_ELAPSED_MS = 1500;
/** The rAF loop counts as stalled after this long without a step. */
const LOOP_STALL_MS = 120;
const FRAME_MS = 1000 / 60;
/** How long a "left the match" banner stays up. */
const LEFT_BANNER_MS = 3000;
/** How long "You lost the connection" shows before results. */
const LOST_BANNER_MS = 1800;

const debugFlags: DebugFlags = { hitboxes: false, frameData: false, perf: false };
const perf: PerfSample = { simMs: 0, renderMs: 0, fps: 0 };
/** Handed to every CPU slot while the tuner freezes them. Never mutated. */
const ZERO_INPUT: InputFrame = { held: 0, pressed: 0, released: 0 };

function nextSeed(seed: number): number {
  const next = (Math.imul(seed, SEED_STEP_MUL) + SEED_STEP_ADD) >>> 0;
  return next === 0 ? 1 : next;
}

/**
 * True when a raw keydown code fires a binding slot. The input system exposes no keyboard
 * held set, so a chord slot ('KeyP&KeyO') matches on its last code, the one that completes
 * the chord; the earlier codes cannot be checked from here.
 */
function slotFiredBy(slot: string, code: string): boolean {
  if (slot === '' || code === '') return false;
  const cut = slot.lastIndexOf('&');
  return cut < 0 ? slot === code : slot.slice(cut + 1) === code;
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

/**
 * A copy of the renderer's camera, fed the same interpolated fighter positions on the same
 * render frames, so the DOM name tags can map world to screen without reaching into the
 * renderer. It leaves out screen shake on purpose: the tags should not shake.
 */
interface TagCamera {
  cam: ReturnType<typeof createCamera>;
  posX: Float32Array;
  posY: Float32Array;
  velX: Float32Array;
  live: Uint8Array;
  primed: boolean;
  view: HudView;
}

function createTagCamera(): TagCamera {
  return {
    cam: createCamera(),
    posX: new Float32Array(MAX_PLAYERS),
    posY: new Float32Array(MAX_PLAYERS),
    velX: new Float32Array(MAX_PLAYERS),
    live: new Uint8Array(MAX_PLAYERS),
    primed: false,
    view: { camX: 0, camY: 0, zoom: 1, viewW: liveView.w, viewH: liveView.h, scale: liveView.scale },
  };
}

/** Mirrors the renderer's interpolate + camera step (src/render/index.ts) for one frame. */
function stepTagCamera(tc: TagCamera, state: GameState, prev: GameState, alpha: number): HudView {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const count = Math.min(state.fighters.length, MAX_PLAYERS);
  for (let i = 0; i < count; i++) {
    const f = state.fighters[i];
    let x = f.x;
    let y = f.y;
    const frozen = f.action === 'dead' || f.action === 'respawn' || f.hitlag > 0;
    const p = prev.fighters[i];
    if (!frozen && p !== undefined && p.slot === f.slot) {
      x = p.x + (f.x - p.x) * a;
      y = p.y + (f.y - p.y) * a;
    }
    tc.posX[i] = x;
    tc.posY[i] = y;
    tc.velX[i] = f.vx;
    tc.live[i] = f.action === 'dead' ? 0 : 1;
  }
  for (let i = count; i < MAX_PLAYERS; i++) {
    tc.live[i] = 0;
    tc.velX[i] = 0;
  }
  const stage = STAGE_DEFS[state.stageId];
  if (stage !== undefined) {
    if (!tc.primed) {
      snapCamera(tc.cam, tc.posX, tc.posY, tc.velX, tc.live, MAX_PLAYERS, stage.cameraBounds);
      tc.primed = true;
    } else {
      updateCamera(tc.cam, tc.posX, tc.posY, tc.velX, tc.live, MAX_PLAYERS, stage.cameraBounds);
    }
  }
  const v = tc.view;
  v.camX = tc.cam.x;
  v.camY = tc.cam.y;
  v.zoom = tc.cam.zoom;
  v.viewW = liveView.w;
  v.viewH = liveView.h;
  v.scale = liveView.scale;
  return v;
}

function buildResults(state: GameState): ResultsData {
  const players: ResultsData['players'] = [];
  for (let i = 0; i < state.fighters.length; i++) {
    const f = state.fighters[i];
    let cpu = false;
    let cpuLevel = 0;
    let name: string | undefined;
    let team: number | undefined;
    for (let j = 0; j < state.config.players.length; j++) {
      const p = state.config.players[j];
      if (p.slot !== f.slot) continue;
      cpu = p.cpu;
      cpuLevel = p.cpuLevel;
      name = p.name;
      team = p.team;
      break;
    }
    const stats = { ...f.stats, mostUsedMove: { ...f.stats.mostUsedMove } };
    const row: ResultsData['players'][number] = {
      slot: f.slot, charId: f.charId, stocks: f.stocks, percent: f.percent, cpu, cpuLevel, stats,
    };
    if (name !== undefined) row.name = name;
    if (team !== undefined) row.team = team;
    if (f.variant !== 0) row.variant = f.variant;
    players.push(row);
  }
  const matchFrames = state.endFrame >= 0 ? state.endFrame : state.frame;
  const data: ResultsData = { winner: state.winner, seed: state.config.seed, players, matchFrames };
  if (state.config.teams === true) data.winnerTeam = state.winnerTeam === undefined ? -1 : state.winnerTeam;
  return data;
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
  const hudEl = document.getElementById('hud');
  const appEl = document.getElementById('app');
  if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error('missing #game canvas');
  if (uiRoot === null) throw new Error('missing #ui root');
  if (hudEl === null || appEl === null) throw new Error('missing #hud or #app');
  const canvas: HTMLCanvasElement = canvasEl;
  const hudHost: HTMLElement = hudEl;
  const app: HTMLElement = appEl;
  const hud = createHud(hudHost, { characters: CHARACTER_LIST });
  const tagCam = createTagCamera();

  /** Fit the renderer, then lay the DOM HUD host exactly over the canvas box. */
  function resizeView(): void {
    renderer.resize();
    const c = canvas.getBoundingClientRect();
    const a = app.getBoundingClientRect();
    hudHost.style.left = `${c.left - a.left}px`;
    hudHost.style.top = `${c.top - a.top}px`;
    hudHost.style.width = `${c.width}px`;
    hudHost.style.height = `${c.height}px`;
  }

  const input = createInputSystem();
  const renderer: Renderer = createRenderer(canvas);

  let phase: Phase = 'menu';
  let match: Match | null = null;
  let ui: UiController | null = null;

  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  let freezeCpu = false;

  function endMatch(sendBackToLobby = true): void {
    hud.stop();
    hudHost.hidden = true;
    if (match === null) return;
    match.session.stop();
    const lan = match.lan;
    if (lan !== undefined) {
      lan.session.stop();
      lan.transport.dispose();
      lan.overlay.dispose();
      lan.ticker.stop();
      lan.offKey();
      lanClient.matchActive = false;
      if (sendBackToLobby) lanClient.backToLobby();
    }
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
    flushAevalmereProfiles();
    phase = 'results';
    hudHost.hidden = true;
    ui.show('results', data);
  }

  function step(): void {
    if (match === null || phase !== 'match') return;
    const m = match;
    if (m.lan !== undefined) {
      stepLan(m, m.lan);
      return;
    }
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

    // A CPU-only match samples no pad for Start either, so read player 0's pad Start directly.
    if (startPressed(inputs) || (!m.hasHuman && padStartPressed(input))) pauseMatch();
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
      if (screen !== null && screen !== 'results' && match !== null && match.lan !== undefined) {
        // After a LAN match every way off the results screen leads back to the lobby.
        leaveLanMatch(false);
        return;
      }
      if (screen !== null && screen !== 'results') {
        loop.stop();
        endMatch();
        phase = 'menu';
        clearCanvas();
        return;
      }
    }

    const renderStart = performance.now();
    if (match !== null && match.lan !== undefined) {
      // LAN: display code reads the local-P1 view; the sim state itself is untouched.
      const view = match.lan.view;
      const rb = match.lan.rollback;
      view.update(match.state, () => rb.drainEvents());
      renderer.render(view.render, match.prev, alpha, debugFlags, perf);
      hud.update(view.hud, stepTagCamera(tagCam, match.state, match.prev, alpha));
    } else if (match !== null) {
      renderer.render(match.state, match.prev, alpha, debugFlags, perf);
      hud.update(match.state, stepTagCamera(tagCam, match.state, match.prev, alpha));
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

  /** When the rAF loop last stepped; a LAN match falls back to the Worker ticker if it stops. */
  let lastLoopStepAt = 0;
  const loop: Loop = createLoop({
    step: () => {
      lastLoopStepAt = performance.now();
      step();
    },
    render,
    hz: 60,
  });

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
    // Pre-build every CPU brain (search engine levels 1 to 10, Aevalmere) so frame 0 does not hitch.
    if (config.players.some((p) => p.cpu && p.cpuLevel >= 1)) warmAevalmere(config);

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
    tagCam.primed = false;
    hud.start(state);
    hudHost.hidden = false;
    ui.hide();
    phase = 'match';
    // Swallow the key press that started the match so it is not read as a jump.
    drainInputs();
    loop.setPaused(false);
    loop.start();
  }

  // ---------------- LAN (docs/LAN.md) ----------------

  function openLanScreen(): void {
    ui?.show('lan');
  }

  /** Leave a finished or abandoned LAN match for the LAN screen; `vote` also votes Rematch. */
  function leaveLanMatch(vote: boolean): void {
    loop.stop();
    endMatch();
    if (vote) lanClient.rematch();
    phase = 'menu';
    clearCanvas();
    openLanScreen();
  }

  /**
   * Results for every peer. Players who left were eliminated in the sim, so the winner is the
   * sim's own; they are tagged "(left)". A browser that lost the lobby shows what it had.
   */
  function showLanResults(m: Match, lan: LanMatch): void {
    if (ui === null) return;
    const data = buildResults(m.state);
    const mySlot = lanClient.me()?.slot ?? -1;
    for (const p of data.players) {
      if (!lan.left.has(p.slot) && !(lan.lostAt > 0 && p.slot === mySlot)) continue;
      p.name = `${p.name ?? `P${p.slot + 1}`} (left)`;
    }
    lan.overlay.dispose();
    phase = 'results';
    hudHost.hidden = true;
    ui.show('results', data);
  }

  function stepLan(m: Match, lan: LanMatch): void {
    snapshotPrev(m.prev, m.state);
    const simStart = performance.now();
    const advanced = lan.session.tick();
    perf.simMs = performance.now() - simStart;
    lan.waitTicks = advanced ? 0 : lan.waitTicks + 1;

    const rb = lan.rollback;
    const now = performance.now();
    let text = '';
    let color = '#ffd27f';
    let recentLeft = '';
    for (const l of lan.left.values()) if (now - l.at < LEFT_BANNER_MS) recentLeft = l.name;
    if (lan.lostAt > 0) {
      text = 'You lost the connection';
      color = '#ffb38a';
      if (now - lan.lostAt > LOST_BANNER_MS) {
        showLanResults(m, lan);
        return;
      }
    } else if (recentLeft !== '') {
      text = `${recentLeft} left the match`;
      color = '#ffb38a';
    } else if (lanClient.lobbyStatus === 'reconnecting') {
      text = 'Connection lost. Reconnecting...';
    } else if (lan.dropped.size > 0) {
      const d = lan.dropped.values().next().value;
      if (d !== undefined) text = `Waiting for ${d.name}... (${Math.max(0, Math.ceil((d.until - now) / 1000))} s)`;
    } else if (lan.desyncFrame >= 0) {
      text = `Desync at frame ${lan.desyncFrame}`;
      color = '#ff7f7f';
    } else if (lan.waitTicks > 20) {
      text = 'Waiting for players...';
    }
    lan.overlay.banner(text, color);
    if ((rb.tick & 15) === 0) {
      lan.overlay.stat(`Ping ${lanClient.rtt < 0 ? '--' : lanClient.rtt} ms · delay ${rb.inputDelay} · rollback ${rb.stats.maxRollback}`);
    }
    if (!advanced) return;

    // A finish seen on predicted inputs can still be rolled back; wait until it is confirmed.
    if (m.state.finished && rb.confirmedFrame() >= m.state.endFrame - 1) {
      if (!m.ended) {
        m.ended = true;
        m.endTimer = RESULTS_DELAY;
      } else if (m.endTimer > 0) {
        m.endTimer--;
        if (m.endTimer === 0) showLanResults(m, lan);
      }
    }
  }

  let bgLast = 0;
  let bgAcc = 0;
  /** Test hook: act as if the tab were hidden (the rAF loop is paused and the Worker drives). */
  let forceBackground = false;

  /**
   * Worker-driven step whenever the rAF loop is not stepping: a hidden tab, and also a visible
   * but occluded or throttled one (rAF can drop to a few frames a second without the page
   * reporting hidden). A stalled peer would freeze everyone. Catch-up is capped per tick.
   */
  function backgroundTick(): void {
    const now = performance.now();
    const loopStalled = now - lastLoopStepAt > LOOP_STALL_MS;
    if (!(document.hidden || forceBackground || loopStalled) || phase !== 'match' || match === null || match.lan === undefined) {
      bgLast = now;
      bgAcc = 0;
      return;
    }
    bgAcc += Math.min(BG_MAX_ELAPSED_MS, now - bgLast);
    bgLast = now;
    let n = 0;
    while (bgAcc >= FRAME_MS && n < BG_MAX_STEPS) {
      step();
      bgAcc -= FRAME_MS;
      n++;
    }
    if (n === BG_MAX_STEPS) bgAcc = 0;
  }

  /**
   * A match config from the wire with every stage and character id this build has: an unknown
   * id (an older agent, a crafted message) falls back to the first stage or character instead of
   * throwing inside the sim. Every peer runs the same version, so every peer falls back alike.
   */
  function knownIds(config: MatchConfig): MatchConfig {
    if (STAGE_DEFS[config.stageId] === undefined) {
      const fallback = STAGE_LIST[0]?.id ?? 'tidegate';
      console.warn(`[lan] unknown stage "${config.stageId}", using ${fallback}`);
      config.stageId = fallback;
    }
    for (const p of config.players) {
      if (CHARACTER_DEFS[p.charId] !== undefined) continue;
      const fallback = CHARACTER_LIST[0]?.id ?? 'aeval';
      console.warn(`[lan] unknown character "${p.charId}" in slot ${p.slot + 1}, using ${fallback}`);
      p.charId = fallback;
    }
    return config;
  }

  /** Start (or, with `history`, rejoin) a LAN match from the lobby agent's start message. */
  function startLanMatch(start: MatchStart, history?: InputHistory, retirements: Retirement[] = []): void {
    if (ui === null) return;
    const me = lanClient.me();
    // The agent's WebSocket, or in the browser mode the WebRTC link (the loopback on the host).
    const transport = lanClient.createMatchTransport();
    if (me === null || transport === null) return;
    // Replacing a finished LAN match: the agent already counts us in the new one.
    endMatch(false);

    const config = knownIds(start.config);
    const peer = me.slot;
    const localIndex = Math.max(0, config.players.findIndex((p) => p.slot === peer && !p.cpu));
    // The local player always plays on Player 1's keys and pad (docs/LAN.md).
    const p1 = createLocalSession(input, p1OnlyConfig(config));
    const lanSession = createLanSessionImpl(p1);
    const cpuRng = createRng((config.seed ^ 0x9e3779b9) >>> 0);
    const rand = (): number => nextFloat(cpuRng);
    const ownsCpu = config.players.some((p, i) => p.cpu && start.owners[i] === peer);
    if (ownsCpu && config.players.some((p) => p.cpu && p.cpuLevel >= 1)) warmAevalmere(config);
    // CPU slots belong to the lobby host's peer: it runs the AI once per frame and sends the
    // result like a human input, so the AI is never re-run by a rollback.
    const sources: (LocalSource | null)[] = config.players.map((p, i) => {
      if (start.owners[i] !== peer) return null;
      if (p.cpu) return (_frame: number, st: GameState) => cpuInput(st, p.slot, p.cpuLevel, rand);
      return () => lanSession.localSource();
    });
    const lan: LanMatch = {
      session: lanSession,
      rollback: null as unknown as RollbackSession,
      view: createLocalView(config, localIndex),
      transport,
      overlay: createLanOverlay(app),
      ticker: startBackgroundTicker(backgroundTick),
      dropped: new Map(),
      left: new Map(),
      lostAt: 0,
      waitTicks: 0,
      desyncFrame: -1,
      offKey: () => {},
    };
    const opts: RollbackOptions = {
      config,
      sim: { createGameState, stepGame, eliminate: eliminateFighter },
      peer,
      owners: start.owners,
      sources,
      transport,
      inputDelay: start.inputDelay,
      onDesync: (frame, from, local, remote) => {
        if (lan.desyncFrame < 0) lan.desyncFrame = frame;
        console.warn(`[lan] desync at frame ${frame} vs peer ${from}: local ${local.toString(16)} remote ${remote.toString(16)}`);
      },
    };
    lan.rollback = history === undefined ? new RollbackSession(opts) : RollbackSession.fromHistory(opts, history, retirements);
    // A resumed page learns who already left from the agent, for the results tags.
    for (const r of retirements) {
      for (const i of r.players) {
        const p = config.players[i];
        if (p !== undefined && !p.cpu) lan.left.set(p.slot, { name: p.name ?? `P${p.slot + 1}`, at: 0 });
      }
    }
    lanSession.setEngine(lan.rollback);
    const state = lan.rollback.state;
    lan.view.update(state);

    // No pause in a LAN match: Escape asks before leaving, and the match keeps running meanwhile.
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape' || phase !== 'match' || lan.overlay.confirming()) return;
      e.preventDefault();
      void lan.overlay.confirmLeave().then((leave) => {
        if (!leave || match === null || match.lan !== lan) return;
        lanClient.leaveMatch();
        leaveLanMatch(false);
      });
    };
    window.addEventListener('keydown', onKey);
    lan.offKey = () => window.removeEventListener('keydown', onKey);

    match = { config, state, prev: cloneGameState(state), session: p1, hasHuman: true, endTimer: 0, ended: false, lan };
    lanClient.matchActive = true;
    renderer.setStage(config.stageId);
    tagCam.primed = false;
    hud.start(lan.view.hud);
    hudHost.hidden = false;
    ui.hide();
    phase = 'match';
    lanSession.start();
    drainInputs();
    bgLast = performance.now();
    bgAcc = 0;
    lastLoopStepAt = bgLast;
    loop.setPaused(false);
    loop.start();
  }

  // Test hook for the LAN browser checks, only with ?lantest in the URL. Automation runs in an
  // isolated world, so it talks through a DOM event and answers in a data attribute.
  if (new URLSearchParams(location.search).has('lantest')) {
    document.addEventListener('aevlantest', (e: Event) => {
      const cmd = String((e as CustomEvent<unknown>).detail ?? '');
      if (cmd.startsWith('drop')) lanClient.simulateDrop(Number(cmd.slice(4)) || 0);
      if (cmd === 'background' || cmd === 'foreground') {
        forceBackground = cmd === 'background';
        loop.setPaused(forceBackground);
      }
      const lan = match?.lan;
      document.documentElement.dataset.aevlan = JSON.stringify({
        phase,
        hidden: document.hidden,
        mode: lanClient.mode,
        agentStatus: lanClient.agentStatus,
        lobbyStatus: lanClient.lobbyStatus,
        message: lanClient.message,
        rtt: lanClient.rtt,
        lobby: lanClient.lobby,
        match: lan === undefined ? null : {
          tick: lan.rollback.tick, confirmed: lan.rollback.confirmedFrame(), delay: lan.rollback.inputDelay, stats: lan.rollback.stats,
          finished: lan.rollback.state.finished, endFrame: lan.rollback.state.endFrame, winner: lan.rollback.state.winner,
          stocks: lan.rollback.state.fighters.map((f) => f.stocks),
        },
      });
    });
  }

  lanClient.onStart = (start: MatchStart): void => {
    if (match !== null && match.lan !== undefined && phase === 'match') return;
    startLanMatch(start);
  };
  lanClient.onResumed = (start: MatchStart, history: InputHistory, retirements: Retirement[]): void => {
    startLanMatch(start, history, retirements);
  };
  lanClient.onPeerDropped = (slot: number, name: string, timeoutMs: number): void => {
    match?.lan?.dropped.set(slot, { name, until: performance.now() + timeoutMs });
  };
  lanClient.onPeerResumed = (slot: number): void => {
    match?.lan?.dropped.delete(slot);
  };
  lanClient.onPeerGone = (slot: number, name: string, _reason: 'left' | 'timeout', retirement: Retirement): void => {
    const lan = match?.lan;
    if (lan === undefined || lan.left.has(slot)) return;
    lan.dropped.delete(slot);
    lan.left.set(slot, { name, at: performance.now() });
    // Eliminated at the agreed frame on every peer; the sim decides who won.
    lan.rollback.retire(retirement.players, retirement.frame, retirement.tail);
  };
  lanClient.onLinkLost = (): void => {
    const lan = match?.lan;
    if (lan === undefined) {
      // A reload whose seat could not be resumed: show the LAN screen with the reason.
      if (match === null && phase === 'menu') openLanScreen();
      return;
    }
    if (lan.lostAt > 0 || phase !== 'match') return;
    lan.lostAt = performance.now();
  };

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
    // LAN: Rematch is a vote; the lobby restarts with the same settings once everyone votes.
    if (match.lan !== undefined) {
      leaveLanMatch(true);
      return;
    }
    const previous = match.config;
    const players: MatchConfig['players'] = previous.players.map((p) => ({
      slot: p.slot,
      charId: p.charId,
      cpu: p.cpu,
      cpuLevel: p.cpuLevel,
      ...(p.name === undefined ? {} : { name: p.name }),
      ...(p.team === undefined ? {} : { team: p.team }),
      ...(p.variant === undefined ? {} : { variant: p.variant }),
    }));
    startMatch({
      stageId: previous.stageId,
      players,
      stocks: previous.stocks,
      timeLimitSec: previous.timeLimitSec,
      seed: nextSeed(previous.seed),
      // Final Smash is disabled this wave (owner request): always false, whatever was saved.
      finalSmash: false,
      cpuZeroMoves: previous.cpuZeroMoves,
      // Teams is automatic (contract 9); the previous match already computed it from the same
      // slots and colours, so a rematch just carries it forward.
      teams: previous.teams,
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
    const startKeys = input.controls.players[0].keys.start;
    if (
      match !== null &&
      !match.hasHuman &&
      phase === 'match' &&
      e.code !== '' &&
      (slotFiredBy(startKeys[0], e.code) || slotFiredBy(startKeys[1], e.code))
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

  window.addEventListener('resize', resizeView);

  renderer
    .load()
    .then(() => {
      resizeView();
      if (ui !== null) ui.show('title');
      // A reload in the middle of a LAN match: take the seat back and land in the match.
      lanClient.resumeSavedSeat();
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
