import type { GameState, InputFrame, InputSystem, LocalSession, MatchConfig, SessionAdapter, SlotProvider } from '../core/types';
import { Btn, MAX_PLAYERS } from '../core/types';
import type { GamepadSource } from './gamepad';
import type { KeyboardSource } from './keyboard';
import { PlayerMapper } from './mapper';

function zeroFrame(out: InputFrame): void {
  out.held = 0;
  out.pressed = 0;
  out.released = 0;
  out.direct = 0;
}

/**
 * Local (shared keyboard, one pad per player) session adapter. `inputsForFrame` reuses one
 * preallocated array and the InputFrame objects inside it, mutating them in place every call,
 * so it never allocates. The keyboard and gamepad sources are the InputSystem's own, shared by
 * every session built from it.
 */
export function createLocalSessionImpl(
  keys: KeyboardSource,
  pads: GamepadSource,
  input: InputSystem,
  config: MatchConfig,
): LocalSession {
  const playerCount = config.players.length;

  const frames: InputFrame[] = [];
  for (let i = 0; i < playerCount; i++) frames.push({ held: 0, pressed: 0, released: 0, direct: 0 });

  const mappers: PlayerMapper[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) mappers.push(new PlayerMapper());

  const providers: (SlotProvider | null)[] = new Array(MAX_PLAYERS).fill(null);
  let state: GameState | null = null;
  let started = false;

  return {
    kind: 'local',

    start(): void {
      if (started) return;
      keys.attach();
      started = true;
    },

    stop(): void {
      if (!started) return;
      keys.detach();
      started = false;
    },

    setSlotProvider(slot: number, provider: SlotProvider | null): void {
      providers[slot] = provider;
    },

    setState(s: GameState): void {
      state = s;
    },

    inputsForFrame(frame: number): InputFrame[] {
      // One snapshot per sim frame, so every player reads the same pad state.
      pads.poll();
      for (let i = 0; i < playerCount; i++) {
        const slot = config.players[i].slot;
        const out = frames[i];
        const provider = providers[slot];
        if (provider) {
          if (state) {
            const result = provider(frame, state);
            out.held = result.held;
            out.pressed = result.pressed;
            out.released = result.released;
            out.direct = result.direct ?? 0;
          } else {
            zeroFrame(out);
          }
        } else {
          mappers[slot].sample(keys, pads, input.controls.players[slot], slot, out);
        }
      }
      keys.latch.clear();
      return frames;
    },
  };
}

// ---------------- LAN ----------------

/**
 * A one-player config that makes a LocalSession sample Player 1's keys and pad. In a LAN match
 * the local player always plays on P1's bindings, whatever lobby slot they hold (docs/LAN.md).
 */
export function p1OnlyConfig(config: MatchConfig): MatchConfig {
  const first = config.players[0];
  return { ...config, players: [{ slot: 0, charId: first === undefined ? '' : first.charId, cpu: false, cpuLevel: 0 }] };
}

/** What the LAN adapter drives: the rollback session in src/net. */
export interface LanEngine {
  tickOnce(advance?: boolean): boolean;
  readonly state: GameState;
}

/**
 * LAN session adapter. The sim is stepped by the rollback engine (with re-simulation), so a
 * match loop calls `tick()` instead of `inputsForFrame` + `stepGame`. `inputsForFrame` still
 * samples Player 1 once, which is how a menu drains the keyboard latch. `localSource` is the
 * rollback engine's input source for the local slot: Player 1's sample, Start stripped (a LAN
 * match has no pause).
 */
export interface LanSession extends SessionAdapter {
  readonly kind: 'lan';
  tick(): boolean;
  localSource(): InputFrame;
  setEngine(engine: LanEngine): void;
}

export function createLanSessionImpl(p1: LocalSession): LanSession {
  let engine: LanEngine | null = null;
  const out: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };
  return {
    kind: 'lan',
    start(): void {
      p1.start();
    },
    stop(): void {
      p1.stop();
    },
    inputsForFrame(frame: number): InputFrame[] | null {
      return p1.inputsForFrame(frame);
    },
    setEngine(e: LanEngine): void {
      engine = e;
    },
    tick(): boolean {
      return engine === null ? false : engine.tickOnce(true);
    },
    localSource(): InputFrame {
      const frames = p1.inputsForFrame(engine === null ? 0 : engine.state.frame);
      const f = frames === null ? null : frames[0];
      out.held = f === null || f === undefined ? 0 : f.held & ~Btn.Start;
      out.pressed = f === null || f === undefined ? 0 : f.pressed & ~Btn.Start;
      out.released = f === null || f === undefined ? 0 : f.released & ~Btn.Start;
      out.direct = f === null || f === undefined ? 0 : f.direct ?? 0;
      return out;
    },
  };
}
