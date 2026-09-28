import type { GameState, InputFrame, InputSystem, LocalSession, MatchConfig, SlotProvider } from '../core/types';
import { MAX_PLAYERS } from '../core/types';
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
