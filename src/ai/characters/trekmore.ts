/**
 * Trekmore plan pack (docs/TREKMORE_PLAN.md F, W3b; plan contract docs/CPU_PLAN.md 4.7).
 *
 * Character plan families the generic brain uses whenever the CPU plays Trekmore. Every family
 * checks `v.me.charId` and generates nothing for any other character, so registering the pack is
 * harmless for everyone else. The rollouts still decide: a family only offers plans whose
 * geometry works from the perceived state, with the numbers read from the character data.
 *
 * Families (plan family ids in brackets; the level's vocabulary gates them as usual):
 * - trekmore.swordRoute [special]: an up-forward (or straight up) Shadow Sword thrown over the
 *   target, the second Special press scripted on the frame whose recall lands Trekmore above,
 *   behind or in front of the target, then dair, bair or fair. Also the charged sword as a zoning
 *   shot at long range.
 * - trekmore.swordRecall [special]: while his sword flies, recall now to strike (dair, bair, fair),
 *   to escape a close threat, or to get back to the stage.
 * - trekmore.swordRecovery [recovery]: offstage, throw the sword up-forward (or up) and recall on
 *   the frame that puts him on or nearest the stage; the tail recovery takes over after it.
 * - trekmore.stepCross [special]: Shadow Step through the target into the backstrike, the air step
 *   as a landing mixup (through or away), the step as a mid-range whiff punish, and the step
 *   approach (overrides slot approachStep).
 * - trekmore.counterRead [special]: Moon Parry when the target's attack becomes active inside the
 *   counter window (seen, or predicted above the break-even probability at the higher levels) and
 *   the repaid damage kills or leads a combo. Never against a grab or a shield.
 * - trekmore.echoChain [tilt]: jab or dtilt into the echo, then the combo table's route.
 * - trekmore.killRoute [killConfirm]: fsmash at the tip or bair on a target behind him at kill
 *   percent; a critical hit is only a small bonus inside a band below the kill percent.
 * - trekmore.dthrowEcho [throw]: dthrow into the table's echo follow-up (overrides slot dthrowEcho).
 * - trekmore.edgeguard [offstageAerial]: the sword aimed at a recovering target, and a ledge-drop
 *   dair (overrides slots edgeguardSword, edgeguardDair).
 *
 * Levels: nothing below UI 4; UI 4 to 6 get the tap sword route, the ground step, the reactive
 * counter and the echo starters; UI 7 and up (and the god) get every family.
 *
 * No MoveId literal appears here (06 `bc`): moves are named by their DIRECT_MOVES index.
 */
import { CHARACTER_DEFS } from '../../characters/registry';
import type { CharacterDef, FighterState, GameState, MoveId, ProjectileDef, ProjectileState, StageDef } from '../../core/types';
import { DIRECT_MOVES } from '../../core/types';
import { TUNING } from '../../core/constants';
import { chargedStat } from '../../sim/projectiles';
import { isLedgeAction } from '../../sim/ledge';
import type { SimFighter } from '../../sim/state';
import { comboLinkInput, comboRouteLinks, comboSpotOf, LK_DASHGRAB, LK_GRAB, makeComboKey, type ComboLink } from '../charprofile/combo';
import type {
  ComboRoute, DecisionView, Intent, PlanCtx, PlanFamily, PlanFamilyId, PlanInstance, Situation, StarterId,
} from '../contracts';
import { PF_ATTACK, PF_INTR, PF_KILL, PF_MOVE, PF_PROJ, PF_TAIL } from '../contracts';
import { specForUiLevel } from '../levels';
import { breakEven } from '../model/gating';
import { makeContext, newContext } from '../model/predictor';
import { comboTableFor } from '../plans/advantage';
import { registerFamilies } from '../plans/index';
import {
  codeOf, D, isOffstage, J, K_APPROACH, K_COMMIT, K_RETREAT, KeyedPlanPool, L, Plan, PlanPool, press, R,
  runState, safeDir, SP, stageGeo, stageOfState, targetIndex, U, type StageGeo,
} from '../plans/script';

/** The character this pack drives. */
export const TREKMORE_ID = 'trekmore';

// ---------------------------------------------------------------------------------------------
// Move names by DIRECT_MOVES index (no literals)
// ---------------------------------------------------------------------------------------------

const DM = DIRECT_MOVES as readonly MoveId[];
const JAB = DM[0];
const DTILT = DM[3];
const FSMASH = DM[5];
const DAIR_I = 12;
const NAIR = DM[8];
const FAIR = DM[9];
const BAIR = DM[10];
const UAIR = DM[11];
const DAIR = DM[DAIR_I];
const NSP = DM[13];
const SSP = DM[14];
const DSP = DM[16];

const C_NSP = codeOf(NSP);
const C_DSP = codeOf(DSP);
const C_FAIR = codeOf(FAIR);
const C_BAIR = codeOf(BAIR);
const C_DAIR = codeOf(DAIR);
const C_FSMASH = codeOf(FSMASH);
const C_DTHROW = codeOf('dthrow');

// ---------------------------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------------------------

const PR_KILL = 88;
const PR_DTHROW = 74;
const PR_RECALL_RECOVER = 66;
const PR_RECOVERY = 62;
const PR_RECALL_STRIKE = 62;
const PR_STEP_PUNISH = 58;
const PR_COUNTER_SEEN = 56;
const PR_EDGE = 50;
const PR_RECALL_ESCAPE = 48;
const PR_COUNTER_READ = 44;
const PR_ECHO = 42;
const PR_STEP_CROSS = 40;
const PR_SWORD = 36;
const PR_KILL_CRIT = 34;
const PR_STEP_APPROACH = 30;
const PR_ZONE = 30;

const ALL_SITS: readonly Situation[] = ['neutral', 'advantage', 'airborne', 'disadvantage', 'bothOffstage', 'oos'];
const GROUND_SITS: readonly Situation[] = ['neutral', 'advantage', 'disadvantage'];
const OFF_SITS: readonly Situation[] = ['disadvantage', 'bothOffstage', 'airborne', 'neutral'];

// ---------------------------------------------------------------------------------------------
// Level tiers
// ---------------------------------------------------------------------------------------------

let S_UI4 = NaN;
let S_UI7 = NaN;

/** 0 none (below UI 4), 1 basic (UI 4 to 6), 2 full (UI 7 and up, god). */
export function trekmoreTier(v: DecisionView): number {
  if (v.level.god) return 2;
  if (S_UI4 !== S_UI4) { S_UI4 = specForUiLevel(4).s; S_UI7 = specForUiLevel(7).s; }
  const s = v.level.s;
  if (s >= S_UI7 - 1e-9) return 2;
  if (s >= S_UI4 - 1e-9) return 1;
  return 0;
}

function isTrekmore(v: DecisionView): boolean { return v.me.charId === TREKMORE_ID; }

/** A named per-character choice from ai.overrides.json `slots`, or `dflt`. */
function slot(v: DecisionView, name: string, dflt: number): number {
  const s = v.me.overrides?.slots;
  if (s === undefined) return dflt;
  const x = s[name];
  return typeof x === 'number' ? x : dflt;
}

// ---------------------------------------------------------------------------------------------
// Character data read once per definition
// ---------------------------------------------------------------------------------------------

interface Kit {
  def: CharacterDef;
  sword: ProjectileDef; swordTotal: number; castFrames: number; recallFoot: number; recallLag: number;
  stepStart: number; stepTravel: number; stepDist: number; stepHit: number;
  counterFrom: number; counterTo: number; counterScale: number; counterMin: number; counterMax: number; counterTotal: number;
}
const KITS = new Map<string, Kit | null>();

function kitOf(charId: string): Kit | null {
  let k = KITS.get(charId);
  if (k !== undefined) return k;
  k = null;
  const def = CHARACTER_DEFS[charId];
  const nsp = def?.moves[NSP];
  const ssp = def?.moves[SSP];
  const dsp = def?.moves[DSP];
  const rc = nsp?.recall;
  const shots = nsp?.projectiles;
  let sword: ProjectileDef | undefined;
  if (shots !== undefined && rc !== undefined) for (const p of shots) if (p.id === rc.projectileId) sword = p;
  if (def !== undefined && nsp !== undefined && rc !== undefined && sword !== undefined && nsp.branch !== undefined
    && ssp?.shadowStep !== undefined && dsp?.counter !== undefined) {
    let hit = 0;
    for (const h of ssp.hitboxes) if (hit === 0 || h.start < hit) hit = h.start;
    k = {
      def, sword, swordTotal: nsp.totalFrames, castFrames: nsp.chargeCastFrames ?? 0, recallFoot: rc.footOffsetY,
      recallLag: nsp.branch.end - nsp.branch.start,
      stepStart: ssp.shadowStep.startFrame, stepTravel: ssp.shadowStep.travelFrames, stepDist: ssp.shadowStep.distance, stepHit: hit,
      counterFrom: dsp.counter.windowStart, counterTo: dsp.counter.windowEnd, counterScale: dsp.counter.scale,
      counterMin: dsp.counter.minDamage, counterMax: dsp.counter.maxDamage, counterTotal: dsp.totalFrames,
    };
  }
  KITS.set(charId, k);
  return k;
}

// ---------------------------------------------------------------------------------------------
// Per-view scratch
// ---------------------------------------------------------------------------------------------

interface Tv {
  s: GameState; me: SimFighter; tg: FighterState | null; ti: number; slot: number; g: StageGeo; stage: StageDef;
  dx: number; adx: number; dy: number; dir: number; vHalf: number; tH: number;
  grounded: boolean; air: boolean; kit: Kit; tier: number; recallLeft: boolean; sword: ProjectileState | null;
}
const TV: Tv = {
  s: null as unknown as GameState, me: null as unknown as SimFighter, tg: null, ti: -1, slot: 0,
  g: null as unknown as StageGeo, stage: null as unknown as StageDef, dx: 0, adx: 0, dy: 0, dir: 1, vHalf: 13, tH: 40,
  grounded: false, air: false, kit: null as unknown as Kit, tier: 0, recallLeft: false, sword: null,
};

/** Fills TV for a Trekmore view at an allowed level; null when the pack does nothing here. */
function tv(v: DecisionView, minTier: number): Tv | null {
  if (!isTrekmore(v)) return null;
  const tier = trekmoreTier(v);
  if (tier < minTier) return null;
  const kit = kitOf(v.me.charId);
  if (kit === null) return null;
  const s = v.p.state;
  const me = s.fighters[v.p.meI] as SimFighter;
  TV.s = s; TV.me = me; TV.slot = v.slot; TV.kit = kit; TV.tier = tier;
  TV.stage = stageOfState(s); TV.g = stageGeo(TV.stage);
  TV.ti = targetIndex(v);
  TV.tg = TV.ti >= 0 ? s.fighters[TV.ti] : null;
  if (TV.tg !== null) {
    TV.dx = TV.tg.x - me.x; TV.adx = Math.abs(TV.dx); TV.dy = TV.tg.y - me.y;
    TV.dir = TV.dx > 0.5 ? 1 : TV.dx < -0.5 ? -1 : me.facing;
  } else { TV.dx = 0; TV.adx = 1e9; TV.dy = 0; TV.dir = me.facing; }
  TV.vHalf = v.opp.physics.hurtbox.w / 2;
  TV.tH = v.opp.physics.hurtbox.h;
  const a = me.action;
  TV.grounded = me.onGround && me.hitstun === 0 && me.hitlag === 0
    && (a === 'idle' || a === 'walk' || a === 'dash' || a === 'run' || a === 'turn' || a === 'crouch' || a === 'land');
  TV.air = !me.onGround && me.hitstun === 0 && me.hitlag === 0 && a === 'air';
  TV.recallLeft = me.onGround || (me.airLock & 2) === 0;
  TV.sword = null;
  for (let i = 0; i < s.projectiles.length; i++) {
    const p = s.projectiles[i];
    if (p.alive && p.owner === me.slot && p.defId === kit.sword.id) { TV.sword = p; break; }
  }
  return TV;
}

function add(out: PlanInstance[], p: Plan, n: Tv): void {
  p.target = n.ti;
  out.push(p);
}

function family(id: PlanFamilyId, situations: readonly Situation[], gen: (v: DecisionView, out: PlanInstance[]) => void): PlanFamily {
  return { id, situations, generate: gen };
}

// ---------------------------------------------------------------------------------------------
// Sword kinematics (sim/moves.ts cast delay, sim/projectiles.ts aim and charge lerp)
// ---------------------------------------------------------------------------------------------

/** Aim codes as the sim's AimDir: 0 forward, 1 up-forward, 2 up, 3 down-forward, 4 down. */
const AIM_FWD = 0;
const AIM_UPFWD = 1;
const AIM_UP = 2;
const AIM_DOWNFWD = 3;
const AIM_COS: readonly number[] = [1, Math.SQRT1_2, 0, Math.SQRT1_2, 0];
const AIM_SIN: readonly number[] = [0, Math.SQRT1_2, 1, -Math.SQRT1_2, -1];

/** Special held this many script frames charges the sword fully (charge counts from frame 1). */
function fullHold(): number { return TUNING.input.chargeMax + 1; }

interface SwordPath {
  /** Script frame of the spawn step, first recall frame, last recall frame. */
  ts: number; tMin: number; tMax: number;
  /** Spawn point and per-frame velocity (world). */
  sx: number; sy: number; vx: number; vy: number; r: number;
}
const PATH: SwordPath = { ts: 0, tMin: 0, tMax: 0, sx: 0, sy: 0, vx: 0, vy: 0, r: 10 };

/** Our own y and x after `n` airborne frames with no input (gravity, max fall, air friction). */
function fallAfter(me: FighterState, n: number, out: { x: number; y: number }, gravity: number, maxFall: number): void {
  let x = me.x; let y = me.y; let vx = me.vx; let vy = me.vy;
  for (let k = 0; k < n; k++) {
    vy = Math.min(vy + gravity, maxFall);
    vx *= 0.965;
    x += vx; y += vy;
  }
  out.x = x; out.y = y;
}
const FALL = { x: 0, y: 0 };

/**
 * The sword's path for a throw started on script frame 0 with `hold` frames of Special (0 = tap),
 * `aim`, facing `f`, from the fighter's current state. Recall pressed on script frame t teleports
 * the feet to (sx + vx (t - ts), sy + vy (t - ts) + footOffset).
 */
function swordPath(v: DecisionView, n: Tv, hold: number, aim: number, f: number): SwordPath {
  const k = n.kit;
  const charge = hold <= 0 ? 0 : Math.min(TUNING.input.chargeMax, hold - 1);
  const frac = charge / TUNING.input.chargeMax;
  const delay = Math.round(k.castFrames * frac);
  const release = hold <= 0 ? 0 : hold;
  const ts = release + k.sword.spawnFrame + delay;
  const speed = chargedStat(k.sword, frac, 'vx');
  const life = Math.round(chargedStat(k.sword, frac, 'lifetime'));
  PATH.ts = ts;
  PATH.tMin = release + k.swordTotal + delay;
  PATH.tMax = ts + life - 1;
  const me = n.me;
  let x = me.x; let y = me.y;
  if (!me.onGround) {
    fallAfter(me, ts, FALL, v.me.physics.gravity, v.me.physics.maxFall);
    x = FALL.x; y = FALL.y;
  }
  PATH.sx = x + k.sword.x * f;
  PATH.sy = y + k.sword.y;
  PATH.vx = speed * AIM_COS[aim] * f;
  PATH.vy = -speed * AIM_SIN[aim];
  PATH.r = k.sword.r;
  return PATH;
}

/** Where a recall on script frame t lands (feet), not counting a platform snap. */
function landX(p: SwordPath, t: number): number { return p.sx + p.vx * (t - p.ts); }
function landY(p: SwordPath, t: number, foot: number): number { return p.sy + p.vy * (t - p.ts) + foot; }

/** True when the flying sword stays clear of a target standing at (tx, ty) on the way to frame t. */
function clearsTarget(p: SwordPath, tEnd: number, tx: number, ty: number, halfW: number, h: number): boolean {
  for (let t = p.ts; t < tEnd; t++) {
    const x = landX(p, t); const y = p.sy + p.vy * (t - p.ts);
    if (Math.abs(x - tx) <= halfW + p.r + 2 && y + p.r + 2 >= ty - h && y - p.r - 2 <= ty) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// The sword script (throw, scripted recall, follow-up), numbers packed in ctx.param
// ---------------------------------------------------------------------------------------------

/** Follow-up modes. */
const FM_NONE = 0;
const FM_DIRECT = 1;
const FM_HOP = 2;
/** Side modes for the aim's horizontal bit. */
const SM_TARGET = 0;
const SM_HOME = 1;
/** Drift modes after the recall (1 would be toward the target). */
const DR_NONE = 0;
const DR_HOME = 2;
/** hold value meaning "no throw": recall on frame 0 (the sword is already out). */
const NO_THROW = 127;
const NO_RECALL = 255;

function packSword(tRecall: number, followCode: number, followMode: number, hold: number, aim: number, side: number,
  drift: number): number {
  return (tRecall & 255) | ((followCode & 63) << 8) | ((followMode & 3) << 14) | ((hold & 127) << 16) | ((aim & 7) << 23)
    | ((side & 3) << 26) | ((drift & 3) << 29);
}

/** The frame the follow-up is pressed: 2 frames before the recall lag ends (the buffer holds it). */
function followAt(tRecall: number, lag: number): number { return tRecall + Math.max(0, lag - 2); }

function swordFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const P = ctx.param;
  const tr = P & 255;
  const fc = (P >> 8) & 63;
  const fm = (P >> 14) & 3;
  const hold = (P >> 16) & 127;
  const aim = (P >> 23) & 7;
  const side = (P >> 26) & 3;
  const drift = (P >> 29) & 3;
  const kit = kitOf(ctx.me.charId);
  const lag = kit === null ? 14 : kit.recallLag;
  const sideDir = side === SM_HOME ? ctx.home : ctx.dir;
  const sideBit = aim === AIM_UP ? 0 : sideDir > 0 ? R : L;
  const vert = aim === AIM_UPFWD || aim === AIM_UP ? U : aim === AIM_DOWNFWD || aim === 4 ? D : 0;
  if (hold !== NO_THROW) {
    if (t === 0) { out.direct = C_NSP; out.held |= sideBit | vert; }
    // The aim follows the stick through the charge and is read again on the release frame.
    if (hold > 0 && t <= hold) out.held |= vert | sideBit;
    if (hold > 0 && t < hold) out.held |= SP;
  }
  if (tr !== NO_RECALL) {
    if (t === tr) out.direct = C_NSP;
    const fa = followAt(tr, lag);
    if (fm === FM_DIRECT && t === fa) out.direct = fc;
    if (fm === FM_HOP) {
      if (t === fa) out.held |= press(J, self);
      if (t === tr + lag + ctx.me.physics.jumpSquat + 1) out.direct = fc;
    }
    if (t > tr && drift !== DR_NONE && !self.onGround) {
      const d = drift === DR_HOME ? ctx.home : ctx.dir;
      out.held |= d > 0 ? R : L;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Sword route: throw over the target, recall above, behind or in front, strike
// ---------------------------------------------------------------------------------------------

const poolSword = new PlanPool();

/** Landing offsets from the target (in the throw's facing): above, behind, in front. */
const ROUTE_OFF: readonly number[] = [0, 30, -34];
const ROUTE_CODE: readonly number[] = [C_DAIR, C_BAIR, C_FAIR];
const ROUTE_HMIN: readonly number[] = [62, 48, 60];
const ROUTE_HMAX: readonly number[] = [140, 110, 110];

const SWORD_ROUTE = family('special', ['neutral', 'advantage', 'airborne'], (v, out) => {
  const n = tv(v, 1);
  if (n === null || n.tg === null || n.sword !== null || !n.recallLeft) return;
  if (!(n.grounded || n.air)) return;
  const tg = n.tg;
  if (tg.action === 'dead' || tg.action === 'respawn') return;
  const g = n.g;
  const k = n.kit;
  const f = n.dir;
  const holds = n.tier >= 2 ? [0, fullHold()] : [0];
  const aims = n.tier >= 2 && n.adx < 40 && n.dy < -50 ? [AIM_UPFWD, AIM_UP] : [AIM_UPFWD];
  let variant = 0;
  let emitted = 0;
  for (let hi = 0; hi < holds.length; hi++) {
    for (let ai = 0; ai < aims.length; ai++) {
      const aim = aims[ai];
      const path = swordPath(v, n, holds[hi], aim, f);
      for (let r = 0; r < ROUTE_OFF.length; r++, variant++) {
        if (emitted >= 4) return;
        // Up aim only lands above.
        if (aim === AIM_UP && r !== 0) continue;
        let tr: number;
        if (aim === AIM_UP) {
          if (Math.abs(path.sx - tg.x) > 22) continue;
          // Land 40 px over the target's head.
          const want = tg.y - n.tH - 40 - k.recallFoot;
          tr = path.ts + Math.round((want - path.sy) / path.vy);
        } else {
          const wantX = tg.x + f * ROUTE_OFF[r];
          tr = path.ts + Math.round((wantX - path.sx) / path.vx);
        }
        if (!(tr >= path.tMin && tr <= path.tMax)) continue;
        const lx = landX(path, tr);
        const ly = landY(path, tr, k.recallFoot);
        const h = tg.y - ly;
        // Height at the teleport the follow-up needs to come out before he lands (recall lag plus
        // startup of falling from rest) and still reach the target.
        if (h < ROUTE_HMIN[r] || h > ROUTE_HMAX[r]) continue;
        if (lx < g.left - 16 || lx > g.right + 16) continue;
        if (ly < n.stage.blast.y + 80) continue;
        if (!clearsTarget(path, tr, tg.x, tg.y, n.vHalf, n.tH)) continue;
        const lag = k.recallLag;
        const p = poolSword.get(n.slot, variant).set('special', r === 0 ? 'tkSwordAbove' : r === 1 ? 'tkSwordBehind' : 'tkSwordFront',
          NSP, followAt(tr, lag) + 1, tr + lag + 26, PF_ATTACK | PF_TAIL, PR_SWORD + (holds[hi] > 0 ? -2 : 0), K_COMMIT);
        if (holds[hi] > 0) p.name = r === 0 ? 'tkSwordAboveCharged' : r === 1 ? 'tkSwordBehindCharged' : 'tkSwordFrontCharged';
        if (aim === AIM_UP) p.name = 'tkSwordUp';
        p.prog = null; p.fn = swordFn; p.prep = null;
        p.param = packSword(tr, ROUTE_CODE[r], FM_DIRECT, holds[hi], aim, SM_TARGET, DR_NONE);
        add(out, p, n);
        emitted++;
      }
    }
  }
  // Charged sword as a zoning shot at long range (the recall stays as the escape).
  if (n.tier >= 2 && n.grounded && n.adx > 200 && Math.abs(n.dy) < 30) {
    const hold = fullHold();
    const path = swordPath(v, n, hold, AIM_FWD, f);
    const reach = Math.abs(path.vx) * (path.tMax - path.ts + 1) + Math.abs(path.sx - n.me.x);
    if (reach + n.vHalf >= n.adx) {
      const p = poolSword.get(n.slot, 40).set('special', 'tkSwordZone', NSP, hold + 2, path.tMin + 4, PF_ATTACK | PF_PROJ, PR_ZONE, K_COMMIT);
      p.prog = null; p.fn = swordFn; p.prep = null;
      p.param = packSword(NO_RECALL, 0, FM_NONE, hold, AIM_FWD, SM_TARGET, DR_NONE);
      add(out, p, n);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Sword out: recall now to strike, escape or get back
// ---------------------------------------------------------------------------------------------

const poolRecall = new PlanPool();

const SWORD_RECALL = family('special', ALL_SITS, (v, out) => {
  const n = tv(v, 1);
  if (n === null || n.sword === null || !n.recallLeft) return;
  const me = n.me;
  if (!(n.grounded || n.air)) return;
  const k = n.kit;
  const sw = n.sword;
  const lx = sw.x;
  const ly = sw.y + k.recallFoot;
  const g = n.g;
  const lag = k.recallLag;
  // Recover: offstage and the sword is nearer the stage.
  if (isOffstage(me, g)) {
    const onStage = lx >= g.left && lx <= g.right;
    const nearer = Math.abs(lx - clampX(lx, g)) + Math.max(0, ly - g.top) < Math.abs(me.x - clampX(me.x, g)) + Math.max(0, me.y - g.top) - 20;
    if ((onStage && ly <= g.bottom + 10) || nearer) {
      const p = poolRecall.get(n.slot, 0).set('recovery', 'tkRecallHome', NSP, 2, lag + 20, PF_TAIL | PF_MOVE, PR_RECALL_RECOVER, K_RETREAT);
      p.prog = null; p.fn = swordFn; p.prep = null;
      p.param = packSword(0, 0, FM_NONE, NO_THROW, 0, SM_HOME, DR_HOME);
      add(out, p, n);
    }
    return;
  }
  const tg = n.tg;
  if (tg === null) return;
  // Strike from where the recall lands (facing is kept through the teleport).
  if (lx >= g.left - 10 && lx <= g.right + 10) {
    const rel = (tg.x - lx) * me.facing;
    const h = tg.y - ly;
    let code = 0; let name = ''; let mode = FM_DIRECT;
    const grounded = ly >= g.top - 1 && lx >= g.left && lx <= g.right && ly <= g.bottom;
    if (Math.abs(rel) < 22 && h >= ROUTE_HMIN[0] && h <= ROUTE_HMAX[0]) { code = C_DAIR; name = 'tkRecallDair'; }
    else if (rel < -10 && rel > -56 && (grounded ? h >= -4 && h <= 30 : h >= ROUTE_HMIN[1] && h <= ROUTE_HMAX[1])) {
      code = C_BAIR; name = 'tkRecallBair'; mode = grounded ? FM_HOP : FM_DIRECT;
    } else if (rel > 14 && rel < 52 && h >= ROUTE_HMIN[2] && h <= ROUTE_HMAX[2] && !grounded) { code = C_FAIR; name = 'tkRecallFair'; }
    if (code !== 0) {
      const p = poolRecall.get(n.slot, 1).set('special', name, NSP, followAt(0, lag) + 1, lag + 30, PF_ATTACK | PF_TAIL, PR_RECALL_STRIKE, K_COMMIT);
      p.prog = null; p.fn = swordFn; p.prep = null;
      p.param = packSword(0, code, mode, NO_THROW, 0, SM_TARGET, DR_NONE);
      add(out, p, n);
    }
  }
  // Escape: the target is on us and the sword is well away from it.
  const tgFree = tg.hitstun === 0 && tg.action !== 'hitstun' && tg.action !== 'tumble';
  if (n.tier >= 2 && tgFree && n.adx < 70 && Math.abs(lx - tg.x) > 140 && lx > g.left + 10 && lx < g.right - 10) {
    const p = poolRecall.get(n.slot, 2).set('special', 'tkRecallEscape', NSP, 2, lag + 6, PF_MOVE, PR_RECALL_ESCAPE, K_RETREAT);
    p.prog = null; p.fn = swordFn; p.prep = null;
    p.param = packSword(0, 0, FM_NONE, NO_THROW, 0, SM_TARGET, DR_NONE);
    add(out, p, n);
  }
});

function clampX(x: number, g: StageGeo): number { return x < g.left ? g.left : x > g.right ? g.right : x; }

// ---------------------------------------------------------------------------------------------
// 3. Recovery: sword up-forward (or up) from offstage, recall on the best frame
// ---------------------------------------------------------------------------------------------

const poolRec = new PlanPool();

const SWORD_RECOVERY = family('recovery', OFF_SITS, (v, out) => {
  const n = tv(v, 2);
  if (n === null || !n.air || n.sword !== null || !n.recallLeft) return;
  const me = n.me;
  const g = n.g;
  if (!isOffstage(me, g)) return;
  const home = me.x < g.cx ? 1 : -1;
  const under = me.x > g.left - 6 && me.x < g.right + 6;
  const aims = under ? [AIM_UP] : [AIM_UPFWD, AIM_UP];
  const blastBottom = n.stage.blast.y + n.stage.blast.h - 40;
  for (let ai = 0; ai < aims.length; ai++) {
    const aim = aims[ai];
    const f = aim === AIM_UP ? me.facing : home;
    const path = swordPath(v, n, 0, aim, f);
    fallAfter(me, path.tMin, FALL, v.me.physics.gravity, v.me.physics.maxFall);
    if (FALL.y > blastBottom) continue;
    let best = -1; let bestScore = Infinity;
    for (let t = path.tMin; t <= path.tMax; t++) {
      const x = landX(path, t); const y = landY(path, t, n.kit.recallFoot);
      const onX = x >= g.left + 4 && x <= g.right - 4;
      let score: number;
      if (onX && y <= g.bottom) score = -1000 + Math.abs(t - path.tMin) * 0.1 + Math.max(0, g.top - y) * 0.05;
      else score = Math.abs(x - clampX(x, g)) + Math.max(0, y - g.top);
      if (score < bestScore) { bestScore = score; best = t; }
    }
    if (best < 0) continue;
    // Only when it beats simply falling: the landing is on the stage or clearly nearer the ledge.
    const nowScore = Math.abs(me.x - clampX(me.x, g)) + Math.max(0, me.y - g.top);
    if (bestScore > -500 && bestScore > nowScore - 30) continue;
    const p = poolRec.get(n.slot, ai).set('recovery', aim === AIM_UP ? 'tkSwordRecoverUp' : 'tkSwordRecover', NSP,
      best + 2, best + n.kit.recallLag + 24, PF_TAIL | PF_MOVE, PR_RECOVERY, K_RETREAT);
    p.prog = null; p.fn = swordFn; p.prep = null;
    p.param = packSword(best, 0, FM_NONE, 0, aim, aim === AIM_UP ? SM_TARGET : SM_HOME, DR_HOME);
    // An up aim keeps the facing: no side bit, so SM_TARGET is only a placeholder.
    add(out, p, n);
  }
});

// ---------------------------------------------------------------------------------------------
// 4. Shadow step: cross-up, landing mixup, whiff punish, approach
// ---------------------------------------------------------------------------------------------

const poolStep = new PlanPool();

/** Mode in ctx.param: 1 toward the target, -1 away (bit 0: 1 = away); higher bits: approach stop gap. */
function stepFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const away = (ctx.param & 1) === 1;
  const d = away ? -ctx.dir : ctx.dir;
  const bit = d > 0 ? R : L;
  if (t === 0) { out.held = bit; out.held |= press(SP, self); return; }
  if (t < 3) out.held = bit;
}

/** Dash toward the target until the gap to it is (param >> 1) px, then step toward it. */
function stepGoFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const rs = runState(p, ctx);
  const bit = ctx.dir > 0 ? R : L;
  if (rs.r[0] === 1) { if (rs.r[1] < 3) { out.held = bit; rs.r[1]++; } return; }
  // ctx.fireAt holds the target's x at plan start (see prepStepGo).
  const gap = Math.abs(ctx.fireAt - self.x);
  const want = ctx.param >> 1;
  if (gap > want && t < p.horizon - 20 && self.onGround) { out.held = safeDir(bit, self); return; }
  rs.r[0] = 1;
  out.held = bit | press(SP, self);
}

function prepStepGo(p: Plan, v: DecisionView, ctx: PlanCtx): void {
  const ti = targetIndex(v);
  ctx.fireAt = ti >= 0 ? v.p.state.fighters[ti].x : ctx.fireAt;
  ctx.param = p.param;
}

/** Travel of a ground step from x in direction d (it stops at the platform edge). */
function stepTravel(n: Tv, x: number, d: number): number {
  const end = x + d * n.kit.stepDist;
  if (end < n.g.left) return x - n.g.left;
  if (end > n.g.right) return n.g.right - x;
  return n.kit.stepDist;
}

const STEP = family('special', ['neutral', 'advantage', 'airborne', 'oos'], (v, out) => {
  const n = tv(v, 1);
  if (n === null || n.tg === null) return;
  const me = n.me;
  const tg = n.tg;
  if (tg.action === 'dead' || tg.action === 'respawn') return;
  const k = n.kit;
  const bs = v.me.moves[SSP];
  if (bs === undefined) return;
  const reach = bs.reach.front + n.vHalf - 6;
  const hitAt = k.stepHit;
  const opening = v.aff.whiffPunish > 0 || v.aff.oppBusy >= hitAt + 2 || tg.action === 'shield' || tg.action === 'shieldStun';
  if (n.grounded && Math.abs(n.dy) < 40) {
    const travel = stepTravel(n, me.x, n.dir);
    const d = n.adx;
    // Cross-up: pass the target and backstrike it on the far side.
    if (travel > d + 12 && travel - d <= reach && d >= 10) {
      const p = poolStep.get(n.slot, 0).set('special', 'tkStepCross', SSP, 2, bs.total + 4, PF_ATTACK, PR_STEP_CROSS, K_COMMIT);
      p.prog = null; p.fn = stepFn; p.prep = null; p.param = 0;
      p.bonus = opening ? 8 : 0;
      add(out, p, n);
    }
    // Whiff punish from mid range: stop short and strike forward.
    const left = Math.max(v.aff.whiffPunish, v.aff.oppBusy);
    if (d > travel && d - travel <= reach && left >= hitAt + 1) {
      const p = poolStep.get(n.slot, 1).set('special', 'punishStep', SSP, 2, bs.total + 4, PF_ATTACK, PR_STEP_PUNISH, K_COMMIT);
      p.prog = null; p.fn = stepFn; p.prep = null; p.param = 0;
      add(out, p, n);
    }
    // Approach with the step instead of the run (heavy default).
    const st = slot(v, 'approachStep', 0);
    if (st > 0 && n.tier >= 1 && d > travel + reach && d < travel + reach + 180) {
      const stop = Math.round(travel + reach - 8);
      const horizon = Math.min(80, Math.ceil((d - stop) / Math.max(1, v.me.physics.dash)) + bs.total + 6);
      const p = poolStep.get(n.slot, 2).set('special', 'tkStepApproach', SSP, 3, horizon, PF_ATTACK, PR_STEP_APPROACH, K_APPROACH);
      p.prog = null; p.fn = stepGoFn; p.prep = prepStepGo; p.param = stop << 1;
      p.bonus = 2 * st;
      add(out, p, n);
    }
  }
  // Air step as a landing mixup: over the target, through it or away from it, landing on stage.
  if (n.tier >= 2 && n.air && (me.airLock & 1) === 0 && tg.onGround && n.dy > 20 && n.adx < 90) {
    for (let side = 0; side < 2; side++) {
      const d = side === 0 ? n.dir : -n.dir;
      const end = me.x + d * k.stepDist;
      if (end < n.g.left + 10 || end > n.g.right - 10) continue;
      const p = poolStep.get(n.slot, 3 + side).set('special', side === 0 ? 'tkAirStepCross' : 'tkAirStepAway', SSP, 2, bs.total + 16,
        side === 0 ? PF_ATTACK : PF_MOVE, side === 0 ? PR_STEP_CROSS : PR_STEP_CROSS - 4, side === 0 ? K_COMMIT : K_RETREAT);
      p.prog = null; p.fn = stepFn; p.prep = null; p.param = side;
      add(out, p, n);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 5. Counter: seen or predicted attacks inside the window
// ---------------------------------------------------------------------------------------------

const poolCounter = new PlanPool();
const PRED_OUT = new Float64Array(64);
const OBS = newContext();

/** Counter damage for an absorbed raw hit (clamp(raw x scale, min, max)). */
function counterDamage(k: Kit, raw: number): number {
  return Math.min(k.counterMax, Math.max(k.counterMin, raw * k.counterScale));
}

/**
 * Worth it when the repaid hit kills (the percent reaches the kill line, interpolated between the
 * overrides' measured kill percents at the counter floor and cap) or leads a combo (low percent,
 * where the 45 degree launch is followable).
 */
function counterWorth(v: DecisionView, k: Kit, dmg: number, pct: number): { worth: boolean; kills: boolean } {
  const atFloor = slot(v, 'counterKillAtFloor', 130);
  const atCap = slot(v, 'counterKillAtCap', 60);
  const span = Math.max(1e-6, k.counterMax - k.counterMin);
  const killAt = atFloor + (atCap - atFloor) * (dmg - k.counterMin) / span;
  const kills = pct + dmg >= killAt;
  const combo = pct <= slot(v, 'counterComboBelow', 60);
  return { worth: kills || combo || dmg >= k.counterMin * 1.3, kills };
}

function isGrabbing(f: FighterState): boolean {
  return f.action === 'grab' || f.action === 'grabHold' || f.action === 'pummel' || f.action === 'throw';
}

const COUNTER = family('special', ['neutral', 'advantage', 'airborne', 'oos', 'disadvantage'], (v, out) => {
  const n = tv(v, 1);
  if (n === null || n.tg === null) return;
  if (!(n.grounded || n.air || n.me.action === 'shield')) return;
  const tg = n.tg;
  const k = n.kit;
  if (tg.action === 'shield' || tg.action === 'shieldStun' || isGrabbing(tg)) return;
  const w0 = k.counterFrom + 1;
  const w1 = k.counterTo + 1;
  const myHalf = v.me.physics.hurtbox.w / 2;
  // Seen: the target's move becomes active inside our window, and we are inside its reach.
  if (tg.action === 'attack' && tg.moveId !== null && tg.hitlag === 0) {
    const om = v.opp.moves[tg.moveId];
    if (om !== undefined && om.maxDamage > 0 && om.tags.indexOf('commandGrab') < 0) {
      const a0 = om.startup - tg.actionFrame;
      const a1 = om.activeEnd - tg.actionFrame;
      const facingUs = (n.me.x - tg.x) * tg.facing >= 0;
      const reach = (facingUs ? om.reach.front : om.reach.back) + myHalf + 8;
      const inRange = n.adx <= reach && n.dy <= om.reach.down + 20 && -n.dy <= om.reach.up + 40;
      if (a1 >= w0 && a0 <= w1 && inRange) {
        const dmg = counterDamage(k, om.maxDamage);
        const cw = counterWorth(v, k, dmg, tg.percent);
        if (cw.worth) {
          const p = poolCounter.get(n.slot, 0).set('special', 'tkCounter', DSP, k.counterTo + 2, k.counterTotal + 6,
            PF_ATTACK, PR_COUNTER_SEEN, K_COMMIT);
          p.prog = null; p.fn = counterFn; p.prep = null; p.bonus = dmg * 0.2 + (cw.kills ? 6 : 0);
          add(out, p, n);
          return;
        }
      }
    }
  }
  // Seen: a projectile of the target's reaching us inside the window.
  for (let i = 0; i < n.s.projectiles.length; i++) {
    const pr = n.s.projectiles[i];
    if (!pr.alive || pr.owner !== tg.slot) continue;
    const closing = (n.me.x - pr.x) * pr.vx;
    if (closing <= 0 || Math.abs(pr.vx) < 0.5) continue;
    const tHit = (Math.abs(n.me.x - pr.x) - myHalf - 10) / Math.abs(pr.vx);
    const yAt = pr.y + pr.vy * tHit;
    if (tHit < w0 || tHit > w1 || yAt > n.me.y + 4 || yAt < n.me.y - v.me.physics.hurtbox.h - 12) continue;
    const p = poolCounter.get(n.slot, 1).set('special', 'tkCounterShot', DSP, k.counterTo + 2, k.counterTotal + 6, PF_ATTACK, PR_COUNTER_SEEN - 4, K_COMMIT);
    p.prog = null; p.fn = counterFn; p.prep = null;
    add(out, p, n);
    return;
  }
  // Predicted: the predictor's top class is an attack that would land in the window.
  if (n.tier < 2 || !v.level.learning.enabled) return;
  const free = tg.hitstun === 0 && tg.hitlag === 0 && (tg.action === 'idle' || tg.action === 'walk' || tg.action === 'dash'
    || tg.action === 'run' || tg.action === 'crouch' || tg.action === 'air' || tg.action === 'turn');
  if (!free || n.adx > 110) return;
  let pred = v.pred;
  if (v.opps !== undefined && v.nOpps !== undefined) {
    for (let i = 0; i < v.nOpps; i++) if (v.opps[i].index === n.ti && v.opps[i].pred !== null) pred = v.opps[i].pred as typeof pred;
  }
  makeContext(n.s, v.p.meI, n.ti, n.s.frame, OBS);
  const conf = pred.predict(OBS, PRED_OUT);
  if (!(conf > 0)) return;
  let top = -1; let pTop = 0;
  for (let c = 0; c < 36; c++) if (PRED_OUT[c] > pTop) { pTop = PRED_OUT[c]; top = c; }
  // Classes: 0..16 direct moves, 30 jab mash; 19 grab and 20 shield never get a counter.
  let mid: MoveId | null = null;
  if (top >= 0 && top < DM.length) mid = DM[top];
  else if (top === 30) mid = JAB;
  if (mid === null) return;
  const om = v.opp.moves[mid];
  if (om === undefined || om.maxDamage <= 0 || om.tags.indexOf('commandGrab') >= 0) return;
  if (om.startup + 1 < w0 || om.startup > w1) return;
  const reach = Math.max(om.reach.front, om.reach.back) + myHalf + 30;
  if (n.adx > reach) return;
  const dmg = counterDamage(k, om.maxDamage);
  const cw = counterWorth(v, k, dmg, tg.percent);
  if (!cw.worth) return;
  const gain = dmg + (cw.kills ? 30 : 0);
  const loss = -Math.max(8, slot(v, 'counterWhiffLoss', 14));
  const pStar = breakEven(gain, loss, 0, 1);
  if (!(pTop * conf >= pStar)) return;
  const p = poolCounter.get(n.slot, 2).set('special', 'tkCounterRead', DSP, k.counterTo + 2, k.counterTotal + 6,
    PF_ATTACK, PR_COUNTER_READ, K_COMMIT);
  p.prog = null; p.fn = counterFn; p.prep = null; p.bonus = (pTop * conf - pStar) * 10;
  add(out, p, n);
});

function counterFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  if (t === 0) out.direct = C_DSP;
}

// ---------------------------------------------------------------------------------------------
// 6. Routes: starter or throw, then the combo table's links (echo included)
// ---------------------------------------------------------------------------------------------

interface RouteData { lead: number; links: readonly ComboLink[]; js: number }
const LINK_IN = { held: 0, pressed: 0, released: 0, direct: 0 };

/**
 * r0 link index (-1 while the lead is pending), r1 clock start frame, r2 previous hitlag, r3
 * previous throw frame, r6 set-up flag. Same timing rules as plans/advantage.ts comboFn: a new
 * hit (hitlag rising, or the throw reaching its release) advances the link when it is the current
 * link's move, else (the echo, a lingering hit) only restarts the clock.
 */
function routeFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const d = p.data as RouteData;
  const rs = runState(p, ctx);
  const r = rs.r;
  if (r[6] === 0) { r[0] = -1; r[1] = ctx.frame; r[2] = self.hitlag; r[3] = -1; r[6] = 1; }
  const sf = self as SimFighter;
  let onset = self.hitlag > r[2];
  const thr = self.action === 'throw' ? self.actionFrame : -1;
  const rel = sf.activeThrow !== undefined && sf.activeThrow !== null ? sf.activeThrow.releaseFrame : -99;
  if (thr >= 0 && thr === rel && r[3] !== rel) onset = true;
  r[2] = self.hitlag; r[3] = thr;
  let k = r[0];
  if (onset) {
    if (k < 0) k = 0;
    else if (k < d.links.length && linkMatches(d.links[k], self)) k++;
    r[0] = k; r[1] = ctx.frame;
  }
  if (k < 0) {
    if (t === 0 || self.action === 'grabHold') out.direct = d.lead;
    return;
  }
  if (k >= d.links.length) return;
  const link = d.links[k];
  const i = ctx.frame - r[1] + 1;
  comboLinkInput(link, i - link.start, sf, ctx.dir, d.js, LINK_IN);
  out.held = LINK_IN.held | LINK_IN.pressed;
  out.direct = LINK_IN.direct;
}

function linkMatches(link: ComboLink, self: FighterState): boolean {
  if (link.kind === LK_GRAB || link.kind === LK_DASHGRAB) return self.action === 'throw';
  return self.action === 'attack' && self.moveId === link.move;
}

/** Route score: damage, a kill, and a fair or uair finisher at kill percent (the plan's preference). */
function routeScore(route: ComboRoute, killPct: boolean): number {
  let s = route.damage + (route.kills ? 40 : 0);
  const last = route.moves[route.moves.length - 1];
  if (killPct && (last === FAIR || last === UAIR)) s += 12;
  for (let i = 0; i < route.moves.length; i++) if (route.moves[i] === NAIR || route.moves[i] === UAIR) s += 2;
  return s;
}

function bestRoute(routes: readonly ComboRoute[], killPct: boolean): ComboRoute | null {
  let best: ComboRoute | null = null; let bs = -Infinity;
  for (let i = 0; i < routes.length; i++) {
    const links = comboRouteLinks(routes[i]);
    if (links === null || links.length === 0) continue;
    const sc = routeScore(routes[i], killPct);
    if (sc > bs) { bs = sc; best = routes[i]; }
  }
  return best;
}

/** True when the target's percent is at the kill percent of one of our kill moves here. */
function atKillPercent(v: DecisionView, pct: number): boolean {
  const kills = v.me.roles.kill;
  for (let i = 0; i < kills.length; i++) {
    const kp = v.aff.killPctHere(kills[i]);
    if (Number.isFinite(kp) && pct >= kp * 0.85) return true;
  }
  return false;
}

const routePool = new KeyedPlanPool<ComboRoute>();

function routePlan(v: DecisionView, n: Tv, route: ComboRoute, lead: number, fam: PlanFamilyId, name: string, move: MoveId | null,
  priority: number): Plan | null {
  const links = comboRouteLinks(route);
  if (links === null || links.length === 0) return null;
  const p = routePool.get(n.slot, route);
  if (p.data === null) {
    const depth = v.level.comboDepth;
    const use = depth === Infinity || depth >= links.length ? links : links.slice(0, Math.max(1, depth));
    p.data = { lead, links: use, js: v.me.physics.jumpSquat } as RouteData;
  }
  const d = p.data as RouteData;
  let span = 0;
  for (let i = 0; i < d.links.length; i++) span += d.links[i].start + d.links[i].d + 30;
  p.set(fam, name, move, 3, Math.min(160, 30 + span), PF_ATTACK | PF_INTR | (route.kills ? PF_KILL : 0), priority, K_COMMIT);
  p.prog = null; p.fn = routeFn; p.prep = null;
  p.bonus = route.damage * 0.1 + (route.kills ? 4 : 0);
  return p;
}

const ECHO_STARTERS: readonly MoveId[] = [JAB, DTILT];

const ECHO = family('tilt', GROUND_SITS, (v, out) => {
  const n = tv(v, 1);
  if (n === null || n.tg === null || !n.grounded) return;
  const tg = n.tg;
  if (n.dy < -30 || n.dy > 20 || tg.action === 'dead' || tg.action === 'respawn') return;
  if (v.level.comboDepth < 1) return;
  if ((tg.x - n.me.x) * n.me.facing < 0) return;
  const table = comboTableFor(v);
  const spot = comboSpotOf(tg.x, n.stage);
  const killPct = atKillPercent(v, tg.percent);
  for (let i = 0; i < ECHO_STARTERS.length; i++) {
    const id = ECHO_STARTERS[i];
    const m = v.me.moves[id];
    if (m === undefined || m.maxDamage <= 0) continue;
    if (n.adx > m.reach.front + n.vHalf - 4) continue;
    const key = makeComboKey(table, id as StarterId, tg.percent, 0, n.adx, n.dy, tg.onGround, spot);
    const routes = table.routesNear !== undefined ? table.routesNear(key) : table.routes(key);
    const route = bestRoute(routes, killPct);
    if (route === null) continue;
    const p = routePlan(v, n, route, codeOf(id), 'tilt', i === 0 ? 'tkEchoJab' : 'tkEchoDtilt', id, PR_ECHO);
    if (p !== null) add(out, p, n);
  }
});

const DTHROW = family('throw', ['grabHold', 'advantage', 'neutral'], (v, out) => {
  const n = tv(v, 1);
  if (n === null || n.tg === null || n.me.action !== 'grabHold') return;
  const want = slot(v, 'dthrowEcho', 0);
  if (want <= 0 || v.level.comboDepth < 1 || v.me.grab.throws.dthrow === undefined) return;
  const tg = n.tg;
  const table = comboTableFor(v);
  const spot = comboSpotOf(tg.x, n.stage);
  const key = makeComboKey(table, 'dthrow', tg.percent, 0, 0, 0, true, spot);
  const routes = table.routesNear !== undefined ? table.routesNear(key) : table.routes(key);
  const route = bestRoute(routes, atKillPercent(v, tg.percent));
  if (route === null) return;
  const p = routePlan(v, n, route, C_DTHROW, 'throw', 'tkDthrowEcho', null, PR_DTHROW);
  if (p === null) return;
  p.bonus += 3 * want;
  add(out, p, n);
});

// ---------------------------------------------------------------------------------------------
// 7. Kill routes: fsmash at the tip, bair on a target behind (crits only a bonus)
// ---------------------------------------------------------------------------------------------

const poolKill = new PlanPool();

function codeFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const hop = (ctx.param & 1) === 1;
  const code = ctx.param >> 1;
  if (!hop) { if (t === 0) out.direct = code; return; }
  if (t === 0) { out.held = press(J, self); return; }
  if (t === ctx.me.physics.jumpSquat + 1) out.direct = code;
}

const KILL = family('killConfirm', ['neutral', 'advantage', 'airborne'], (v, out) => {
  const n = tv(v, 1);
  if (n === null || n.tg === null) return;
  const tg = n.tg;
  if (tg.action === 'dead' || tg.action === 'respawn' || v.aff.oppInvuln > 0) return;
  // A ledge hanger is out of reach of both (neither hits the ledge); the ledge trap families own it.
  if (isLedgeAction(tg.action) || isOffstage(tg, n.g) && !tg.onGround && tg.y > n.g.top + 4) return;
  const err = Number.isFinite(v.level.killPctError) ? v.level.killPctError : 0.25;
  const crit = n.kit.def.crit;
  // A crit multiplies damage by `scale`; the kill percent falls roughly by the same factor.
  const critLine = crit !== undefined ? 1 / crit.scale : 1;
  // fsmash: grounded, facing the target, inside the tip.
  const fs = v.me.moves[FSMASH];
  if (n.grounded && fs !== undefined && (tg.x - n.me.x) * n.me.facing > 0 && n.adx <= fs.reach.front + n.vHalf - 4 && Math.abs(n.dy) < 30) {
    const kp = v.aff.killPctHere(FSMASH);
    if (Number.isFinite(kp)) {
      const sure = tg.percent >= kp * (1 + err);
      const critOnly = !sure && n.tier >= 2 && crit !== undefined && tg.percent >= kp * critLine;
      if (sure || critOnly) {
        const p = poolKill.get(n.slot, 0).set('killConfirm', sure ? 'tkKillFsmash' : 'tkKillFsmashCrit', FSMASH, 2, fs.total + 4,
          PF_ATTACK | (sure ? PF_KILL : 0), sure ? PR_KILL : PR_KILL_CRIT, K_COMMIT);
        p.prog = null; p.fn = codeFn; p.prep = null; p.param = C_FSMASH << 1;
        p.bonus = sure ? 0 : crit!.chance * 10;
        add(out, p, n);
      }
    }
  }
  // bair: the target behind us, close; a short hop from the ground, at once in the air.
  const ba = v.me.moves[BAIR];
  const behind = (tg.x - n.me.x) * n.me.facing < 0;
  if (ba !== undefined && behind && (n.grounded || n.air) && n.adx <= ba.reach.back + n.vHalf - 2 && n.dy > -60 && n.dy < 40) {
    const kp = v.aff.killPctHere(BAIR);
    if (Number.isFinite(kp)) {
      const sure = tg.percent >= kp * (1 + err);
      const critOnly = !sure && n.tier >= 2 && crit !== undefined && tg.percent >= kp * critLine;
      if (sure || critOnly) {
        const p = poolKill.get(n.slot, 1).set('killConfirm', sure ? 'tkKillBair' : 'tkKillBairCrit', BAIR, 2,
          ba.total + v.me.physics.jumpSquat + 4, PF_ATTACK | PF_TAIL | (sure ? PF_KILL : 0), sure ? PR_KILL : PR_KILL_CRIT, K_COMMIT);
        p.prog = null; p.fn = codeFn; p.prep = null; p.param = (C_BAIR << 1) | (n.grounded ? 1 : 0);
        p.bonus = sure ? 0 : crit!.chance * 10;
        add(out, p, n);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 8. Edgeguard: the sword at a recovering target, and a ledge-drop dair
// ---------------------------------------------------------------------------------------------

const poolEdge = new PlanPool();

/** Walk off the ledge toward the target and dair at once, drifting toward it. */
function edgeDairFn(p: Plan, t: number, self: FighterState, ctx: PlanCtx, out: Intent): void {
  const rs = runState(p, ctx);
  const bit = ctx.dir > 0 ? R : L;
  if (self.onGround) { out.held = safeDir(bit, self); return; }
  if (rs.r[0] === 0) { rs.r[0] = 1; out.direct = C_DAIR; }
  out.held = bit;
}

const EDGE = family('offstageAerial', ['neutral', 'advantage'], (v, out) => {
  const n = tv(v, 2);
  if (n === null || n.tg === null || !n.grounded) return;
  const tg = n.tg;
  const g = n.g;
  if (!isOffstage(tg, g) || tg.action === 'dead' || tg.action === 'respawn') return;
  const side = tg.x < g.cx ? -1 : 1;
  const edge = side < 0 ? g.left : g.right;
  if (Math.abs(n.me.x - edge) > 90 || (tg.x - n.me.x) * side <= 0) return;
  if (slot(v, 'edgeguardSword', 0) > 0 && n.sword === null) {
    const aims = [AIM_FWD, AIM_DOWNFWD];
    for (let ai = 0; ai < aims.length; ai++) {
      const path = swordPath(v, n, 0, aims[ai], side);
      // Closest approach to the target's ballistic path while the sword flies.
      let hitT = -1;
      for (let t = path.ts; t <= path.tMax && hitT < 0; t++) {
        fallAfter(tg, t, FALL, v.opp.physics.gravity, v.opp.physics.maxFall);
        const sx = landX(path, t); const sy = path.sy + path.vy * (t - path.ts);
        if (Math.abs(sx - FALL.x) <= path.r + n.vHalf && sy >= FALL.y - n.tH - path.r && sy <= FALL.y + path.r) hitT = t;
      }
      if (hitT < 0) continue;
      const p = poolEdge.get(n.slot, ai).set('projectile', ai === 0 ? 'tkEdgeSword' : 'tkEdgeSwordLow', NSP, 2, n.kit.swordTotal + 4,
        PF_ATTACK | PF_PROJ, PR_EDGE, K_COMMIT);
      p.prog = null; p.fn = swordFn; p.prep = null;
      p.param = packSword(NO_RECALL, 0, FM_NONE, 0, aims[ai], SM_TARGET, DR_NONE);
      add(out, p, n);
    }
  }
  if (slot(v, 'edgeguardDair', 0) > 0 && v.level.vocabulary.has('spike') && Math.abs(n.me.x - edge) < 40
    && tg.y > g.top + 10 && tg.y < g.top + 130 && Math.abs(tg.x - edge) < 80 && n.me.jumpsLeft > 0) {
    const p = poolEdge.get(n.slot, 2).set('spike', 'tkEdgeDair', DAIR, 4, 44, PF_ATTACK | PF_TAIL, PR_EDGE, K_COMMIT);
    p.prog = null; p.fn = edgeDairFn; p.prep = null;
    add(out, p, n);
  }
});

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

/** The pack's families by name (names for reports and tests; ids are the vocabulary ids). */
export const TREKMORE_FAMILY_TABLE: readonly { name: string; family: PlanFamily }[] = [
  { name: 'trekmore.swordRoute', family: SWORD_ROUTE },
  { name: 'trekmore.swordRecall', family: SWORD_RECALL },
  { name: 'trekmore.swordRecovery', family: SWORD_RECOVERY },
  { name: 'trekmore.stepCross', family: STEP },
  { name: 'trekmore.counterRead', family: COUNTER },
  { name: 'trekmore.echoChain', family: ECHO },
  { name: 'trekmore.killRoute', family: KILL },
  { name: 'trekmore.dthrowEcho', family: DTHROW },
  { name: 'trekmore.edgeguard', family: EDGE },
];

export const TREKMORE_FAMILIES: readonly PlanFamily[] = TREKMORE_FAMILY_TABLE.map((e) => e.family);

registerFamilies(TREKMORE_FAMILIES);

/** Exposed for tests: the sword path model and the packed-parameter layout. */
export const TREKMORE_TEST = { swordPath, packSword, NO_THROW, NO_RECALL, AIM_UPFWD, AIM_UP, FM_DIRECT, SM_TARGET, DR_NONE, DAIR_I };
