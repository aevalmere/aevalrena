import type { GameState, InputFrame, InputSystem, LocalSession, MatchConfig, SlotProvider } from '../core/types';
import { MAX_PLAYERS } from '../core/types';
import type { KeyboardSource } from './keyboard';
import { PlayerMapper } from './mapper';

function zeroFrame(out: InputFrame): void {
  out.held = 0;
  out.pressed = 0;
  out.released = 0;
}

/**
 * Local (single-keyboard) session adapter. `inputsForFrame` reuses one preallocated array and
 * the InputFrame objects inside it, mutating them in place every call, so it never allocates.
 */
export function createLocalSessionImpl(
  source: KeyboardSource,
  input: InputSystem,
  config: MatchConfig,
): LocalSession {
  const playerCount = config.players.length;

  const frames: InputFrame[] = [];
  for (let i = 0; i < playerCount; i++) frames.push({ held: 0, pressed: 0, released: 0 });

  const mappers: PlayerMapper[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) mappers.push(new PlayerMapper());

  const providers: (SlotProvider | null)[] = new Array(MAX_PLAYERS).fill(null);
  let state: GameState | null = null;
  let started = false;

  return {
    kind: 'local',

    start(): void {
      if (started) return;
      source.attach();
      started = true;
    },

    stop(): void {
      if (!started) return;
      source.detach();
      started = false;
    },

    setSlotProvider(slot: number, provider: SlotProvider | null): void {
      providers[slot] = provider;
    },

    setState(s: GameState): void {
      state = s;
    },

    inputsForFrame(frame: number): InputFrame[] {
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
          } else {
            zeroFrame(out);
          }
        } else {
          const playerControls = input.controls.players[slot];
          mappers[slot].sample(source, playerControls.bindings, playerControls.tapJump, out);
        }
      }
      source.latch.clear();
      return frames;
    },
  };
}
