/**
 * Tag rules and role lists for the character AI profile (04 section 3).
 *
 * This file and derive.ts are the only brain-side places that name moves: MOVE_ORDER fixes the
 * iteration order (so profiles are deterministic) and the move classes say which slot of the fixed
 * MoveId set a move occupies (ground normal, aerial, special, utility). Everything the brain reads
 * afterwards is a tag or a number.
 */
import type { CharacterAiProfile, MoveAiInfo, MoveTag, ShotProfile } from '../contracts';
import type { CharacterDef, MoveDef, MoveId } from '../../core/types';

/** Every MoveId in a fixed order: iteration, tie-breaks and role lists follow it. */
export const MOVE_ORDER: readonly MoveId[] = [
  'jab', 'ftilt', 'utilt', 'dtilt', 'dashatk', 'fsmash', 'usmash', 'dsmash',
  'nair', 'fair', 'bair', 'uair', 'dair', 'nspecial', 'sspecial', 'uspecial', 'dspecial',
  'taunt', 'taunt2', 'taunt3', 'ledgeatk', 'getupatk',
];

/** Jab and tilts: the reference for a poke's reach. */
const GROUND_NORMALS: readonly MoveId[] = ['jab', 'ftilt', 'utilt', 'dtilt'];
/** Moves that may be poked with (ground normals plus the dash attack). */
const POKE_GROUND: readonly MoveId[] = ['jab', 'ftilt', 'utilt', 'dtilt', 'dashatk'];
/** Taunts and the situational ledge and getup attacks carry no combat tags. */
const UTILITY: readonly MoveId[] = ['taunt', 'taunt2', 'taunt3', 'ledgeatk', 'getupatk'];
/** Out-of-shield list of the sim (01 section 3): jump aerials, up smash, up special. */
const OOS_DIRECT: readonly MoveId[] = ['usmash', 'uspecial'];

/**
 * Move slots plan code names by role (every character fills the same slots). Brain files outside
 * charprofile/ carry no MoveId literals (harness case bc), so they read the slot from here.
 */
export const MOVE_SLOT: { readonly upSmash: MoveId; readonly ledgeAttack: MoveId; readonly jab: MoveId } = {
  upSmash: 'usmash', ledgeAttack: 'ledgeatk', jab: 'jab',
};

/** The special a Special press starts with this stick: up, down, side (left or right), else neutral. */
export function specialForStick(up: boolean, down: boolean, side: boolean): MoveId {
  return up ? 'uspecial' : down ? 'dspecial' : side ? 'sspecial' : 'nspecial';
}

export function isUtility(id: MoveId): boolean {
  return UTILITY.indexOf(id) >= 0;
}

export function isAerial(mv: MoveDef): boolean {
  return mv.airOnly === true;
}

/** Endlag used by the tag rules: an aerial that lands pays its landing lag instead. */
export function effectiveEndlag(info: MoveAiInfo, mv: MoveDef): number {
  if (isAerial(mv) && mv.landingLag !== undefined) return Math.min(info.endlag, info.landingLag);
  return info.endlag;
}

/** Frames from an actionable grounded fighter to the first active frame (aerials jump first). */
export function groundStartup(info: MoveAiInfo, mv: MoveDef, jumpSquat: number): number {
  return isAerial(mv) ? info.startup + jumpSquat + 1 : info.startup;
}

/** Inputs of the tag rules for one move that are not on MoveAiInfo. */
export interface TagFacts {
  def: CharacterDef;
  /** probeLedgeCoverage mask. */
  ledgeMask: number;
  /** probeMoveRise, px. */
  rise: number;
  /** Smallest follow-up startup of the character (ground startup, jump aerials included). */
  minFollow: number;
  /** Longest front reach among jab and tilts. */
  normalReach: number;
  /** This move's shot profiles. */
  shots: readonly ShotProfile[];
}

function hasHitbox(mv: MoveDef): boolean {
  return mv.hitboxes.length > 0;
}

function angleIn(mv: MoveDef, lo: number, hi: number): boolean {
  for (let i = 0; i < mv.hitboxes.length; i++) {
    const a = mv.hitboxes[i].angle;
    if (a !== 361 && a >= lo && a <= hi) return true;
  }
  return false;
}

/**
 * The antiAir reach clause. `reach.up` is measured from the feet, where 0.6 of the hurtbox height
 * is chest level and every body-centred hitbox passes; the rule is read as reach above the head
 * top of at least 0.6 of the hurtbox height.
 */
export function reachesOverHead(up: number, hurtboxH: number): boolean {
  return up - hurtboxH >= TAG_RULES.antiAirUpShare * hurtboxH;
}

function bits(n: number): number {
  let c = 0;
  for (let b = n; b !== 0; b &= b - 1) c++;
  return c;
}

function pctOr(v: number, fallback: number): number {
  return Number.isNaN(v) ? fallback : v;
}

/** Tunable thresholds of 04 section 3. */
export const TAG_RULES = {
  pokeStartup: 9, pokeReachShare: 0.75,
  antiAirUpShare: 0.6, antiAirStartup: 12,
  starterMaxPct: 40, extenderEndlag: 15, extenderPct: [40, 100] as const,
  killCenter: 130, killLedge: 100,
  spikeAngle: [230, 310] as const,
  gimpShotReach: 150, gimpOffstageGain: 30,
  oosStartup: 12,
  ledgeTrapOptions: 2, ledgeTrapEndlag: 25, ledgeTrapShotLife: 60,
  getOffMeStartup: 8, getOffMeEndlag: 20,
  recoveryRise: 40,
  landingLagMax: 10,
};

/** 04 section 3, one move. `info.tags` is ignored. */
export function moveTags(id: MoveId, info: MoveAiInfo, f: TagFacts): MoveTag[] {
  const mv = f.def.moves[id];
  const out: MoveTag[] = [];
  if (hasHitbox(mv)) {
    for (let i = 0; i < mv.hitboxes.length; i++) {
      if (mv.hitboxes[i].grab !== undefined) {
        out.push('commandGrab');
        break;
      }
    }
  }
  const shots = f.shots;
  if (shots.length > 0) out.push('projectile');
  if (isUtility(id) || (!hasHitbox(mv) && shots.length === 0)) return out;

  const R = effectiveEndlag(info, mv);
  const aerial = isAerial(mv);
  const h = f.def.hurtbox.h;
  const reach = info.reach;
  const T = TAG_RULES;

  const pokeShape = POKE_GROUND.indexOf(id) >= 0 || (aerial && info.startup <= T.pokeStartup);
  if (pokeShape && info.startup <= T.pokeStartup && info.safeShield && Math.max(reach.front, aerial ? reach.back : 0) >= T.pokeReachShare * f.normalReach) {
    out.push('poke');
  }
  if ((reachesOverHead(reach.up, h) || angleIn(mv, 60, 120)) && info.startup <= T.antiAirStartup) out.push('antiAir');

  const W = info.starterWindow;
  let starter = false;
  let extender = false;
  for (let i = 0; i < W.length; i++) {
    const p = i * 20;
    if (W[i] < f.minFollow) continue;
    if (p <= T.starterMaxPct) starter = true;
    if (p >= T.extenderPct[0] && p <= T.extenderPct[1]) extender = true;
  }
  if (starter) out.push('comboStarter');
  if (extender && R <= T.extenderEndlag) out.push('extender');

  if (info.killPct.center <= T.killCenter || info.killPctRecover.ledge <= T.killLedge) out.push('killMove');

  const spike = aerial && angleIn(mv, T.spikeAngle[0], T.spikeAngle[1]);
  if (spike) out.push('spike');
  let longShot = false;
  let longLife = false;
  for (let i = 0; i < shots.length; i++) {
    if (shots[i].range(0) >= T.gimpShotReach) longShot = true;
    if (shots[i].lifetime(0) >= T.ledgeTrapShotLife) longLife = true;
  }
  const offGain = pctOr(info.killPctRecover.offstage, 251) <= pctOr(info.killPctRecover.center, 251) - T.gimpOffstageGain;
  if (spike || longShot || offGain) out.push('gimpTool');

  const oos = aerial || OOS_DIRECT.indexOf(id) >= 0;
  if (oos && groundStartup(info, mv, f.def.jumpSquat) <= T.oosStartup) out.push('oosOption');

  if ((bits(f.ledgeMask) >= T.ledgeTrapOptions && R <= T.ledgeTrapEndlag) || longLife) out.push('ledgeTrapTool');

  if (reach.back >= f.def.hurtbox.w / 2 && info.startup <= T.getOffMeStartup && R <= T.getOffMeEndlag) out.push('getOffMe');

  if (mv.helplessAfter === true || mv.invuln !== undefined || f.rise >= T.recoveryRise) out.push('recovery');

  if (aerial && mv.landingLag !== undefined && mv.landingLag <= T.landingLagMax && hasHitbox(mv)) out.push('landingOption');
  return out;
}

/** Smallest follow-up startup: ground startup of every non-utility move with output. */
export function minFollowStartup(def: CharacterDef, moves: Partial<Record<MoveId, MoveAiInfo>>): number {
  let best = Infinity;
  for (let i = 0; i < MOVE_ORDER.length; i++) {
    const id = MOVE_ORDER[i];
    const info = moves[id];
    const mv = def.moves[id];
    if (info === undefined || isUtility(id)) continue;
    if (mv.hitboxes.length === 0 && (mv.projectiles === undefined || mv.projectiles.length === 0)) continue;
    const s = groundStartup(info, mv, def.jumpSquat);
    if (s < best) best = s;
  }
  return best;
}

/** Longest front reach among jab and tilts. */
export function normalReach(moves: Partial<Record<MoveId, MoveAiInfo>>): number {
  let best = 0;
  for (let i = 0; i < GROUND_NORMALS.length; i++) {
    const info = moves[GROUND_NORMALS[i]];
    if (info !== undefined && info.reach.front > best) best = info.reach.front;
  }
  return best;
}

type Roles = CharacterAiProfile['roles'];

function has(info: MoveAiInfo, t: MoveTag): boolean {
  return info.tags.indexOf(t) >= 0;
}

function sorted(ids: MoveId[], key: (id: MoveId) => number): MoveId[] {
  return ids.slice().sort((a, b) => {
    const d = key(a) - key(b);
    if (d !== 0 && !Number.isNaN(d)) return d;
    return MOVE_ORDER.indexOf(a) - MOVE_ORDER.indexOf(b);
  });
}

function pick(moves: Record<MoveId, MoveAiInfo>, test: (id: MoveId, m: MoveAiInfo) => boolean): MoveId[] {
  const out: MoveId[] = [];
  for (let i = 0; i < MOVE_ORDER.length; i++) {
    const id = MOVE_ORDER[i];
    const m = moves[id];
    if (m !== undefined && test(id, m)) out.push(id);
  }
  return out;
}

/**
 * Role lists read by the candidate generator (04 section 3), built from tags and numbers only.
 * `ledgeExtra`: moves listed in ledgeTrap whatever their tags (the `hitsLedge` moves).
 * `hurtboxH` and `jumpSquat` come from the profile's physics.
 */
export function buildRoles(moves: Record<MoveId, MoveAiInfo>, hurtboxH: number, jumpSquat: number,
  ledgeExtra: readonly MoveId[]): Roles {
  const nan = (v: number): number => (Number.isNaN(v) ? 1e9 : v);
  const startup = (id: MoveId): number => moves[id].startup;
  // Landing lag marks an aerial, which comes out of shield after a jump.
  const oosStart = (id: MoveId): number => moves[id].startup + (moves[id].landingLag > 0 ? jumpSquat + 1 : 0);
  const ledge = pick(moves, (id, m) => has(m, 'ledgeTrapTool') || ledgeExtra.indexOf(id) >= 0);
  return {
    neutral: sorted(pick(moves, (_, m) => has(m, 'poke') || has(m, 'projectile')), startup),
    antiAir: sorted(pick(moves, (_, m) => has(m, 'antiAir')), startup),
    juggle: sorted(pick(moves, (_, m) => has(m, 'antiAir') && reachesOverHead(m.reach.up, hurtboxH)), startup),
    landing: sorted(pick(moves, (_, m) => has(m, 'landingOption')), startup),
    edgeguard: sorted(pick(moves, (id, m) => !isUtility(id) && (has(m, 'gimpTool')
      || (m.landingLag > 0 && !Number.isNaN(m.killPctRecover.offstage)))), (id) => nan(moves[id].killPctRecover.offstage)),
    ledgeTrap: sorted(ledge, startup),
    techChase: sorted(pick(moves, (id, m) => !isUtility(id) && m.landingLag === 0 && m.maxDamage > 0
      && m.activeEnd - m.startup + 1 >= 5), startup),
    kill: sorted(pick(moves, (_, m) => has(m, 'killMove')), (id) => nan(moves[id].killPct.center)),
    oos: sorted(pick(moves, (_, m) => has(m, 'oosOption')), oosStart),
    getOffMe: sorted(pick(moves, (_, m) => has(m, 'getOffMe')), startup),
    recovery: sorted(pick(moves, (_, m) => has(m, 'recovery')), (id) => -moves[id].reach.up * 1000 - moves[id].reach.front),
  };
}

/** Informational style affinity: shares of tagged moves, each in [0, 1]. */
export function styleAffinity(moves: Record<MoveId, MoveAiInfo>, shots: readonly ShotProfile[]): CharacterAiProfile['styleAffinity'] {
  let n = 0;
  let agg = 0;
  let def = 0;
  let cnt = 0;
  for (let i = 0; i < MOVE_ORDER.length; i++) {
    const m = moves[MOVE_ORDER[i]];
    if (m === undefined || isUtility(MOVE_ORDER[i]) || m.tags.length === 0) continue;
    n++;
    if (has(m, 'comboStarter') || has(m, 'extender') || has(m, 'poke')) agg++;
    if (has(m, 'projectile') || m.safeShield) def++;
    if (has(m, 'oosOption') || has(m, 'getOffMe') || has(m, 'antiAir')) cnt++;
  }
  if (n === 0) return { aggressive: 0, defensive: 0, countering: 0 };
  const shotBonus = shots.length > 0 ? 0.1 : 0;
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return { aggressive: r(agg / n), defensive: r(Math.min(1, def / n + shotBonus)), countering: r(cnt / n) };
}
