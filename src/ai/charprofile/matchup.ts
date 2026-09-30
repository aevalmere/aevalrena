/**
 * Matchup profile for A attacking B (cpu-guide 04 section 5, docs/CPU_PLAN.md W1.5).
 *
 * Kill percents in a profile are measured against the character's own weight (the mirror).
 * Knockback depends on the victim's weight only through the percent term
 *   (p / 10 + p * d / 20) * 200 / (w + 100),
 * with p the percent after the hit, so for the same launch the post-hit percent scales with
 * (w + 100). A pre-hit kill percent k measured on weight wFrom becomes
 *   (k + d) * (wTo + 100) / (wFrom + 100) - d
 * on weight wTo, d being the move's damage. Fall speed and hurtbox size of the other character
 * are not modelled here; the combo table (built per victim) is the precise tool for confirms.
 *
 * - K: the lowest center kill percent against B over A's reliable killers (startup 20 or less,
 *   a throw, or a move the mirror combo table confirms into a kill), 150 when there is none.
 * - brackets: [0, 0.3K, 0.6K, 0.85K, K], rounded.
 * - danger: B's moves on A, each spot rescaled to A's weight.
 * - safeVsB: A's damaging moves whose shield advantage leaves B's fastest out-of-shield option
 *   (its `roles.oos` moves and its standing grab) no frame to hit before A can act.
 */
import type { ThrowId } from '../../core/types';
import type { CharacterAiProfile, DeriveMatchupFn, KillPct, MatchupProfile, MoveAiInfo } from '../contracts';
import type { MoveId } from '../../core/types';

const RELIABLE_STARTUP = 20;
const NO_KILLER_K = 150;

function rescale(k: number, damage: number, wFrom: number, wTo: number): number {
  if (!Number.isFinite(k)) return NaN;
  return Math.max(0, (k + damage) * (wTo + 100) / (wFrom + 100) - damage);
}

function rescaleKp(kp: KillPct, damage: number, wFrom: number, wTo: number): KillPct {
  return {
    center: rescale(kp.center, damage, wFrom, wTo),
    ledge: rescale(kp.ledge, damage, wFrom, wTo),
    offstage: rescale(kp.offstage, damage, wFrom, wTo),
  };
}

function confirmsKill(a: CharacterAiProfile, id: MoveId): boolean {
  const t = a.comboTable;
  for (let b = 0; b < t.brackets.length; b++) if (t.killConfirm(id, b, 'center')) return true;
  return false;
}

/** Lowest center kill percent of A's reliable killers on a victim of weight `wTo`, NaN if none. */
function killFloor(a: CharacterAiProfile, wTo: number): number {
  const wFrom = a.physics.weight;
  let best = NaN;
  const ids = Object.keys(a.moves) as MoveId[];
  for (let i = 0; i < ids.length; i++) {
    const m: MoveAiInfo = a.moves[ids[i]];
    if (!Number.isFinite(m.killPct.center) || m.maxDamage <= 0) continue;
    if (m.startup > RELIABLE_STARTUP && !confirmsKill(a, ids[i])) continue;
    const k = rescale(m.killPct.center, m.maxDamage, wFrom, wTo);
    if (!(k >= best)) best = k;
  }
  const throws = Object.keys(a.grab.throws) as ThrowId[];
  for (let i = 0; i < throws.length; i++) {
    const th = a.grab.throws[throws[i]];
    if (!Number.isFinite(th.killPct.center)) continue;
    const k = rescale(th.killPct.center, th.damage, wFrom, wTo);
    if (!(k >= best)) best = k;
  }
  return best;
}

/** Frames B needs to hit out of shield: its fastest `roles.oos` move or its standing grab. */
function fastestOos(b: CharacterAiProfile): number {
  let best = b.grab.standing.active[0];
  for (let i = 0; i < b.roles.oos.length; i++) {
    const m = b.moves[b.roles.oos[i]];
    if (m !== undefined && m.startup > 0 && m.startup < best) best = m.startup;
  }
  return best;
}

export const deriveMatchup: DeriveMatchupFn = (a, b, stage) => {
  const floor = killFloor(a, b.physics.weight);
  const K = Math.round(Number.isFinite(floor) ? floor : NO_KILLER_K);
  const brackets = [0, Math.round(0.3 * K), Math.round(0.6 * K), Math.round(0.85 * K), K];

  const danger: MatchupProfile['danger'] = {};
  const bIds = Object.keys(b.moves) as MoveId[];
  for (let i = 0; i < bIds.length; i++) {
    const m = b.moves[bIds[i]];
    if (m.maxDamage <= 0) continue;
    const kp = m.killPct;
    if (!Number.isFinite(kp.center) && !Number.isFinite(kp.ledge) && !Number.isFinite(kp.offstage)) continue;
    danger[bIds[i]] = rescaleKp(kp, m.maxDamage, b.physics.weight, a.physics.weight);
  }

  const oos = fastestOos(b);
  const safe = new Set<MoveId>();
  const aIds = Object.keys(a.moves) as MoveId[];
  for (let i = 0; i < aIds.length; i++) {
    const m = a.moves[aIds[i]];
    if (m.maxDamage <= 0) continue;
    if (m.advShield + oos > 0) safe.add(aIds[i]);
  }

  return { attacker: a.charId, defender: b.charId, stageId: stage.id, K, brackets, danger, safeVsB: safe };
};
