/**
 * Replay log vocabulary, the Slippi opening and combo tracker, and the state hash (plan 4.5, 06 section 2).
 *
 * Every event's `slot` is a PLAYER index of the match spec (0 = spec.a, 1 = spec.b, 2+ = extraPlayers
 * in order), never a sim slot, so a side swap does not change how a log reads. -1 = the match itself.
 *
 * Event kinds written by the runner (data fields in braces):
 * - start     {seed, stage, stocks, players}                     slot -1, frame 0
 * - player    {sim, charId, name, cpu, team, reach}              frame 0; reach = longest ground normal reach, px
 * - action    {a, m, g}                                          action changed; m = move id or '-', g = on ground 0/1
 * - move      {m, dx, adx, dy, act, reach, proj}                 an attack started (a restart counts); act = first
 *                                                                active frame offset, adx = distance to the nearest opponent
 * - hit       {v, dmg, kb, ang, pct, vatk, off}                  slot = attacker; vatk 1 = victim was in an attack's startup
 * - shieldHit {}                                                 slot = the shielding victim
 * - grab      {v}   throw {v, t}   tech {roll}   jump {dbl}   dash {}   shieldBreak {}   respawn {}
 * - shot      {def}                                              projectile spawned by slot
 * - ko        {by, sd, pct, side}                                slot = victim; by = credited player or -1
 * - stun      {on}                                               victim entered (1) or left (0) the combo states
 * - press     {b, d, h, g, a}                                    the input the brain sent (frame it applies to);
 *                                                                b = new pressed bits, d = direct code, h = held, a = action
 * - sample    {x, y, g, off}                                     every SAMPLE_EVERY frames per living player
 * - opening   {v, neutral, counter}                              Slippi opening by slot on v
 * - comboEnd  {v, hits, dmg, kill, start}                        the conversion that opening began
 * - end       {winner, frames, timeout}                          slot -1
 */
import type { FighterState, GameState, StageDef } from '../../core/types';
import { hashGameState } from '../../net/hash';
import type { HashStateFn, ReplayEvent } from '../contracts';

/** Frames outside the combo states that end a combo (Slippi's COMBO_STRING_TIMEOUT). */
export const COMBO_RESET_FRAMES = 45;
/** Position sample period, frames. */
export const SAMPLE_EVERY = 4;

/** Final-state fingerprint: the netcode's FNV-1a hash as 8 hex digits. */
export const hashState: HashStateFn = (s: GameState): string => hashGameState(s).toString(16).padStart(8, '0');

/** Actions that count as damaged, grabbed, teching, downed or dying (Slippi combo states). */
const COMBO_ACTIONS: Readonly<Record<string, true>> = {
  hitstun: true, tumble: true, grabbed: true, tech: true, techRoll: true, downed: true, getUp: true,
  getUpRoll: true, footstooled: true, finalSmashVictim: true, dead: true,
};

/** True while the fighter is in a Slippi combo state. */
export function inComboState(f: FighterState): boolean {
  return f.hitstun > 0 || COMBO_ACTIONS[f.action] === true;
}

/** Off the stage: airborne outside the main solid platform, or below its top (the aitest.ts reading). */
export function isOffstage(stage: StageDef, f: FighterState): boolean {
  if (f.onGround || f.action === 'ledgeHang') return false;
  for (let i = 0; i < stage.platforms.length; i++) {
    const p = stage.platforms[i];
    if (!p.solid) continue;
    return f.x < p.x - 2 || f.x > p.x + p.w + 2 || f.y > p.y + 6;
  }
  return false;
}

/** 32-bit FNV-1a over a stream of integers, for the per-player input stream hash. */
export class StreamHash {
  private h = 0x811c9dc5;
  add(v: number): void {
    let h = this.h;
    h = Math.imul(h ^ (v & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193);
    h = Math.imul(h ^ (v >>> 24), 0x01000193);
    this.h = h;
  }
  hex(): string { return (this.h >>> 0).toString(16).padStart(8, '0'); }
}

export interface ComboListener {
  opening(frame: number, attacker: number, victim: number, neutral: boolean, counter: boolean): void;
  end(frame: number, attacker: number, victim: number, hits: number, damage: number, kill: boolean, start: number): void;
}

/**
 * Slippi's opening and combo convention as a statistic (06 section 2). Keyed by victim: a hit on a
 * victim with no live combo is an opening; the combo continues while the victim is in a combo
 * state and ends after COMBO_RESET_FRAMES consecutive frames outside them, or at the victim's KO.
 * An opening is from neutral when its attacker is not itself the victim of a live combo.
 * Feed each frame's events in log order, then call `tick(frame)` once.
 */
export class ComboTracker {
  readonly active: boolean[] = [];
  readonly attacker: number[] = [];
  readonly hits: number[] = [];
  readonly damage: number[] = [];
  readonly start: number[] = [];
  readonly inState: boolean[] = [];
  readonly out: number[] = [];
  constructor(players: number, private readonly listener: ComboListener) {
    for (let i = 0; i < players; i++) {
      this.active.push(false); this.attacker.push(-1); this.hits.push(0); this.damage.push(0);
      this.start.push(-1); this.inState.push(false); this.out.push(0);
    }
  }
  setInState(victim: number, on: boolean): void { this.inState[victim] = on; }
  hit(frame: number, attacker: number, victim: number, damage: number, counter: boolean): void {
    if (!this.active[victim]) {
      this.active[victim] = true;
      this.attacker[victim] = attacker;
      this.hits[victim] = 0;
      this.damage[victim] = 0;
      this.start[victim] = frame;
      const neutral = !this.active[attacker];
      this.listener.opening(frame, attacker, victim, neutral, counter);
    }
    this.hits[victim]++;
    this.damage[victim] += damage;
    this.out[victim] = 0;
  }
  ko(frame: number, victim: number): void {
    if (this.active[victim]) this.finish(frame, victim, true);
  }
  tick(frame: number): void {
    for (let v = 0; v < this.active.length; v++) {
      if (!this.active[v]) continue;
      if (this.inState[v]) { this.out[v] = 0; continue; }
      this.out[v]++;
      if (this.out[v] >= COMBO_RESET_FRAMES) this.finish(frame, v, false);
    }
  }
  /** Closes every live combo (match end). */
  flush(frame: number): void {
    for (let v = 0; v < this.active.length; v++) if (this.active[v]) this.finish(frame, v, false);
  }
  private finish(frame: number, v: number, kill: boolean): void {
    this.active[v] = false;
    this.out[v] = 0;
    this.listener.end(frame, this.attacker[v], v, this.hits[v], this.damage[v], kill, this.start[v]);
  }
}

/** Events of one kind, optionally for one slot. */
export function eventsOf(events: readonly ReplayEvent[], kind: string, slot?: number): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === kind && (slot === undefined || e.slot === slot)) out.push(e);
  }
  return out;
}

/** Numeric field of an event, `fallback` when absent or not a number. */
export function num(e: ReplayEvent, key: string, fallback = 0): number {
  const v = e.data[key];
  return typeof v === 'number' ? v : fallback;
}

/** String field of an event, '' when absent. */
export function str(e: ReplayEvent, key: string): string {
  const v = e.data[key];
  return typeof v === 'string' ? v : v === undefined ? '' : String(v);
}
