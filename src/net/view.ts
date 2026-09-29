import type { GameState, MatchConfig, SimEvent } from '../core/types';

/**
 * "Everyone is P1 on their own screen" (docs/LAN.md). The sim keeps the lobby's slot numbers;
 * the renderer and the HUD read a view of the live state instead:
 *
 * - colours: the local player's colour index swaps with colour 0 (P1 blue) for every player, so
 *   teammates of the local player turn blue with them and nobody else shares that colour;
 * - names: the local player reads "P1 (you)";
 * - HUD order: the local fighter's card comes first, the rest keep slot order.
 *
 * Only display code gets these objects. The sim, results, teams and stats keep the real state.
 */

export const LOCAL_TAG = 'P1 (you)';

export interface LocalView {
  /** Same fighters and fields as the live state, remapped config. For the renderer. */
  readonly render: GameState;
  /** Like `render`, with the local fighter first. For the HUD (cards and name tags). */
  readonly hud: GameState;
  /**
   * Refresh both views from the live state. Call once per render frame. No allocation.
   * `drainEvents` supplies the renderer's events: it is called only on a render where the
   * frame moved on (the renderer consumes events once per frame change), and its result
   * replaces `state.events`, so rollback re-simulations never replay or drop an effect.
   */
  update(state: GameState, drainEvents?: () => SimEvent[]): void;
}

export function viewConfig(config: MatchConfig, localIndex: number): MatchConfig {
  const colourOf = (i: number): number => config.players[i].team ?? config.players[i].slot;
  const localColour = colourOf(localIndex);
  const swap = (c: number): number => (c === localColour ? 0 : c === 0 ? localColour : c);
  return {
    ...config,
    players: config.players.map((p, i) => {
      const out = { ...p, team: swap(colourOf(i)) };
      if (i === localIndex) out.name = LOCAL_TAG;
      return out;
    }),
  };
}

export function createLocalView(config: MatchConfig, localIndex: number): LocalView {
  const vconfig = viewConfig(config, localIndex);
  const order: number[] = [localIndex];
  for (let i = 0; i < config.players.length; i++) if (i !== localIndex) order.push(i);
  const render = {} as GameState;
  const hud = {} as GameState;
  const hudFighters: GameState['fighters'] = [];
  const noEvents: SimEvent[] = [];
  let lastFrame = -1;

  function copyTop(dst: GameState, src: GameState): void {
    const d = dst as unknown as Record<string, unknown>;
    const s = src as unknown as Record<string, unknown>;
    for (const k in s) d[k] = s[k];
    dst.config = vconfig;
  }

  return {
    render,
    hud,
    update(state: GameState, drainEvents?: () => SimEvent[]): void {
      copyTop(render, state);
      if (drainEvents !== undefined) {
        render.events = state.frame !== lastFrame ? drainEvents() : noEvents;
        lastFrame = state.frame;
      }
      copyTop(hud, state);
      for (let i = 0; i < order.length; i++) hudFighters[i] = state.fighters[order[i]];
      hudFighters.length = order.length;
      hud.fighters = hudFighters;
    },
  };
}
