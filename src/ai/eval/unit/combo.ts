/**
 * Unit checks for src/ai/charprofile/combo.ts and matchup.ts (W1.5).
 * Run: npx --yes tsx src/ai/eval/unit/combo.ts
 *
 * The profile here is a stub built straight from the CharacterDef so the check does not depend
 * on derive.ts; buildComboTable reads only charId, the move ids, the throw ids and overrides.
 *
 * Checks:
 * 1. At least one true combo at low percent from a known starter (nair clean or dtilt).
 * 2. No route claims a follow-up the victim's jump escapes: every route of every built entry is
 *    replayed here, with this file's own stepping loop, against a victim that presses Jump
 *    (holding away) every frame from the starter on, at the bracket's low, middle and high percent.
 * 3. Kill confirms only where the sim KOs: every kill route and every killing starter is replayed
 *    at the bracket's low and high percent and must end in a KO event within 300 frames.
 * 4. Determinism: a second build gives the same summary and the same routes for the same keys.
 * 5. deriveMatchup: brackets are [0, 0.3K, 0.6K, 0.85K, K] and a heavier defender raises K.
 */
import { CHARACTER_DEFS } from '../../../characters/registry';
import { grabKitOf } from '../../../characters/common/grabkit';
import { STAGE_DEFS } from '../../../stages/registry';
import { Btn } from '../../../core/types';
import type { CharacterDef, GameState, InputFrame, MoveId, ThrowId } from '../../../core/types';
import { cloneGameState, stepGame } from '../../../sim/index';
import { simFighters } from '../../../sim/state';
import type { CharacterAiProfile, ComboKey, ComboRoute, ComboTable, KillPct, MoveAiInfo } from '../../contracts';
import {
  buildAllComboEntries, buildComboTable, comboJumpSquat, comboLinkInput, comboRouteLinks, comboSetupState,
  comboTableEntries, comboTableSteps, LK_DASHGRAB, LK_GRAB,
} from '../../charprofile/combo';
import { deriveMatchup } from '../../charprofile/matchup';

declare const process: { exitCode?: number; stdout: { write(s: string): void } };

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}\n`);
  if (!ok) failures++;
}

const NAN_KP: KillPct = { center: NaN, ledge: NaN, offstage: NaN };

function stubProfile(def: CharacterDef, killCenter: Partial<Record<MoveId, number>>): CharacterAiProfile {
  const moves = {} as Record<MoveId, MoveAiInfo>;
  const ids = Object.keys(def.moves) as MoveId[];
  for (const id of ids) {
    const mv = def.moves[id];
    let startup = Infinity; let activeEnd = 0; let maxDamage = 0;
    for (const h of mv.hitboxes) { startup = Math.min(startup, h.start); activeEnd = Math.max(activeEnd, h.end); maxDamage = Math.max(maxDamage, h.damage); }
    if (startup === Infinity) startup = 0;
    const kc = killCenter[id];
    moves[id] = {
      id, tags: [], startup, activeEnd, endlag: 0, landingLag: mv.landingLag ?? 0, total: mv.totalFrames,
      reach: { front: 0, back: 0, up: 0, down: 0 }, maxDamage, advShield: -10, safeShield: false, safeShieldMeasured: false,
      killPct: kc === undefined ? NAN_KP : { center: kc, ledge: kc * 0.8, offstage: kc * 0.6 }, killPctRecover: NAN_KP,
      starterWindow: [], chargeable: mv.chargeable === true, charge: null,
    };
  }
  const kit = grabKitOf(def);
  const throws = {} as CharacterAiProfile['grab']['throws'];
  for (const t of Object.keys(kit.throws) as ThrowId[]) {
    const th = kit.throws[t];
    throws[t] = { release: th.releaseFrame, damage: th.damage, angle: th.angle, bkb: th.bkb, kbg: th.kbg, killPct: NAN_KP, starterWindow: [] };
  }
  const emptyTable: ComboTable = {
    brackets: [0], bracketOf: () => 0, routes: () => [], killConfirm: () => false,
    summary: () => ({ entries: 0, chains3: 0, chains4: 0, kills: 0 }),
  };
  return {
    charId: def.id, dataHash: 'stub',
    physics: { weight: def.weight, walk: def.walkSpeed, run: def.runSpeed, dash: def.dashSpeed, dashFrames: def.dashFrames,
      airSpeed: def.airSpeed, gravity: def.gravity, maxFall: def.maxFall, fastFall: def.fastFall, jumpSquat: def.jumpSquat,
      hurtbox: { w: def.hurtbox.w, h: def.hurtbox.h } },
    moves, shots: [],
    grab: { standing: { total: kit.stand.totalFrames, active: [kit.stand.start, kit.stand.end], reach: kit.stand.x + kit.stand.r },
      dash: { total: kit.dash.totalFrames, active: [kit.dash.start, kit.dash.end], reach: kit.dash.x + kit.dash.r },
      holdBase: kit.holdBase, holdPerPercent: kit.holdPerPercent, mashFrames: kit.mashFrames, throws },
    recovery: { rise: { fullHop: 0, shortHop: 0, airJump: 0 }, upSpecial: { rise: 0, frames: 0, helpless: true, grabsBefore: 0 },
      airDodge: { l: { dx: 0, dy: 0 }, r: { dx: 0, dy: 0 }, u: { dx: 0, dy: 0 }, d: { dx: 0, dy: 0 }, lu: { dx: 0, dy: 0 },
        ld: { dx: 0, dy: 0 }, ru: { dx: 0, dy: 0 }, rd: { dx: 0, dy: 0 }, n: { dx: 0, dy: 0 } },
      recoverBox: new Float32Array(0), fallToBlast: 0 },
    roles: { neutral: [], antiAir: [], juggle: [], landing: [], edgeguard: [], ledgeTrap: [], techChase: [], kill: [],
      oos: ['usmash', 'nair'], getOffMe: [], recovery: [] },
    comboTable: emptyTable,
    styleAffinity: { aggressive: 0, defensive: 0, countering: 0 },
  };
}

// ------------------------------------------------------------------------------------------
// Independent replay: this file's own stepping loop over the route's input scripts.
// ------------------------------------------------------------------------------------------

const A: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };
const V: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };

type Victim = 'none' | 'jump';

function victimInput(kind: Victim, s: GameState): void {
  V.held = 0; V.pressed = 0; V.released = 0; V.direct = 0;
  if (kind !== 'jump') return;
  const [a, v] = simFighters(s);
  V.pressed = Btn.Jump;
  V.held = Btn.Jump | (v.x >= a.x ? Btn.Right : Btn.Left);
}

function stepOnce(s: GameState): { ourHit: boolean; caught: boolean; ko: boolean; theirHit: boolean } {
  stepGame(s, [A, V]);
  const r = { ourHit: false, caught: false, ko: false, theirHit: false };
  for (const e of s.events) {
    if (e.type === 'hit' && e.attacker === 0 && e.victim === 1) r.ourHit = true;
    if (e.type === 'hit' && e.attacker === 1 && e.victim === 0) r.theirHit = true;
    if (e.type === 'grab' && e.attacker === 0) r.caught = true;
    if (e.type === 'ko' && e.slot === 1) r.ko = true;
  }
  return r;
}

/**
 * Plays the route from the key setup. Before each link the node is settled the same way the
 * builder does (lingering hits of the move that landed are let through with no attacker input);
 * that settle is re-implemented here: step idle until the victim is free or a hit of the old move
 * lands, and restart the link clock after such a hit. Returns links landed, or -1 on no setup.
 */
function playRoute(t: ComboTable, key: ComboKey, route: ComboRoute, percent: number, victim: Victim,
  wantKo: boolean): { landed: number; ko: boolean } {
  const s = comboSetupState(t, key, percent);
  if (s === null) return { landed: -1, ko: false };
  const links = comboRouteLinks(route);
  if (links === null) return { landed: -1, ko: false };
  const js = comboJumpSquat(t);
  let landed = 0;
  for (let k = 0; k < links.length; k++) {
    const link = links[k];
    // Settle: find the step a lingering hit lands on (with idle inputs), on a copy.
    for (let guard = 0; guard < 8; guard++) {
      const probe = cloneGameState(s);
      let linger = 0;
      for (let i = 1; i <= 150; i++) {
        const pv = simFighters(probe)[1];
        if (!(pv.hitlag > 0 || pv.hitstun >= 2 || pv.action === 'grabbed')) break;
        A.held = 0; A.pressed = 0; A.released = 0; A.direct = 0;
        victimInput(victim, probe);
        if (stepOnce(probe).ourHit) { linger = i; break; }
      }
      if (linger === 0) break;
      for (let i = 0; i < linger; i++) {
        A.held = 0; A.pressed = 0; A.released = 0; A.direct = 0;
        victimInput(victim, s);
        stepOnce(s);
      }
    }
    const [atk, vic] = simFighters(s);
    let toward = 1;
    let ok = false;
    let caught = false;
    for (let i = 1; i <= 260 && !ok; i++) {
      if (i === link.start) { const d = vic.x - atk.x; toward = d > 0.5 ? 1 : d < -0.5 ? -1 : atk.facing; }
      comboLinkInput(link, i - link.start, atk, toward, js, A);
      victimInput(victim, s);
      const r = stepOnce(s);
      if (r.theirHit) return { landed, ko: false };
      if (r.caught) caught = true;
      if (r.ourHit) {
        const grabKind = link.kind === LK_GRAB || link.kind === LK_DASHGRAB;
        if (grabKind && !caught) return { landed, ko: false };
        ok = true;
      }
      if (!caught && i > link.start + 120) break;
    }
    if (!ok) return { landed, ko: false };
    landed++;
  }
  let ko = false;
  if (wantKo) {
    for (let i = 0; i < 300 && !ko; i++) {
      A.held = 0; A.pressed = 0; A.released = 0; A.direct = 0;
      V.held = 0; V.pressed = 0; V.released = 0; V.direct = 0;
      if (stepOnce(s).ko) ko = true;
    }
  }
  return { landed, ko };
}

function percentsOf(t: ComboTable, b: number): number[] {
  const lo = t.brackets[b];
  let hi: number;
  if (b + 1 < t.brackets.length) hi = Math.max(lo, t.brackets[b + 1] - 1);
  else hi = lo + Math.max(10, b > 0 ? t.brackets[b] - t.brackets[b - 1] : 20) - 1;
  return [lo, Math.round((lo + hi) / 2), hi];
}

// ------------------------------------------------------------------------------------------

const aeval = CHARACTER_DEFS.aeval;
const stage = STAGE_DEFS.tidegate;
const profile = stubProfile(aeval, { fsmash: 118, usmash: 120, bair: 140, fair: 160, dsmash: 150, uspecial: 150 });
const brackets = [0, 30, 60, 85, 100];

const t0 = performance.now();
const table = buildComboTable(profile, aeval, stage, brackets);
buildAllComboEntries(table);
const sum = table.summary();
const buildMs = performance.now() - t0;
const entries = comboTableEntries(table).slice();
const snapshot = JSON.stringify(entries.map((e) => [e.key, e.routes, e.starterKills]));
let routeCount = 0; let killRoutes = 0; let killStarters = 0;
const starters = new Set<string>();
for (const e of entries) {
  starters.add(e.key.starter);
  routeCount += e.routes.length;
  for (const r of e.routes) if (r.kills) killRoutes++;
  if (e.starterKills) killStarters++;
}
process.stdout.write(`build ${buildMs.toFixed(0)} ms, ${comboTableSteps(table)} sim steps, ${entries.length} keys, `
  + `${starters.size} starters, ${routeCount} routes, summary ${JSON.stringify(sum)}, kill routes ${killRoutes}, killing starters ${killStarters}\n`);

// 1. A true combo at low percent from nair (clean hit, class 0) or dtilt.
{
  const hits: string[] = [];
  for (const e of entries) {
    if (e.key.bracket !== 0 || e.key.hitClass !== 0) continue;
    if (e.key.starter !== 'nair' && e.key.starter !== 'dtilt') continue;
    for (const r of e.routes) hits.push(`${e.key.starter}(${e.key.spot}${e.key.grounded ? ',g' : ',a'}) -> ${r.moves.join(' > ')} ${r.damage}%`);
  }
  check('true combo at low percent', hits.length > 0, hits.slice(0, 4).join('; ') || 'none');
}

// 2. No route survives a victim that jumps every frame. 3. Kill claims KO in the sim.
{
  let played = 0; let escaped = 0; let koClaims = 0; let koFail = 0;
  const bad: string[] = [];
  for (const e of entries) {
    const pcts = percentsOf(table, e.key.bracket);
    for (const r of e.routes) {
      for (const p of pcts) {
        const res = playRoute(table, e.key, r, p, 'jump', false);
        played++;
        if (res.landed < r.moves.length) { escaped++; if (bad.length < 5) bad.push(`${e.key.starter}@${p} ${r.moves.join('>')} landed ${res.landed}`); }
      }
      if (r.kills) {
        for (const p of [pcts[0], pcts[2]]) {
          koClaims++;
          const res = playRoute(table, e.key, r, p, 'none', true);
          if (res.landed < r.moves.length || !res.ko) koFail++;
        }
      }
    }
    if (e.starterKills) {
      for (const p of [pcts[0], pcts[2]]) {
        koClaims++;
        const s = comboSetupState(table, e.key, p);
        let ko = false;
        if (s !== null) for (let i = 0; i < 300 && !ko; i++) { A.held = 0; A.pressed = 0; A.direct = 0; victimInput('none', s); if (stepOnce(s).ko) ko = true; }
        if (!ko) koFail++;
      }
    }
  }
  check('jump never escapes a listed follow-up', played > 0 && escaped === 0, `${played} replays, ${escaped} escaped ${bad.join('; ')}`);
  check('kill confirms KO in the sim', koClaims > 0 && koFail === 0, `${koClaims} kill claims replayed, ${koFail} without a KO`);
  let confirms = 0;
  for (let b = 0; b < brackets.length; b++) for (const st of starters) for (const sp of ['center', 'ledge', 'offstage'] as const) if (table.killConfirm(st as MoveId, b, sp)) confirms++;
  process.stdout.write(`kill confirms (starter, bracket, spot): ${confirms}\n`);
}

// 2b. Keys built on demand (random buckets): same jump test on every route they list.
{
  let seed = 12345;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ids = [...starters];
  const spots = ['center', 'ledge', 'offstage'] as const;
  let keys = 0; let withRoutes = 0; let played = 0; let escaped = 0;
  const t1 = performance.now();
  for (let i = 0; i < 60; i++) {
    const key: ComboKey = {
      starter: ids[rnd(ids.length)] as MoveId, bracket: rnd(brackets.length), hitClass: rnd(3) as 0 | 1 | 2,
      dxBucket: rnd(9) - 4, dyBucket: rnd(7) - 4, grounded: rnd(2) === 0, spot: spots[rnd(3)],
    };
    keys++;
    const rs = table.routes(key);
    if (rs.length > 0) withRoutes++;
    for (const r of rs) {
      for (const p of percentsOf(table, key.bracket)) {
        played++;
        if (playRoute(table, key, r, p, 'jump', false).landed < r.moves.length) escaped++;
      }
    }
  }
  check('on-demand keys hold against jump', escaped === 0, `${keys} random keys, ${withRoutes} with routes, ${played} replays, `
    + `${escaped} escaped, ${(performance.now() - t1).toFixed(0)} ms`);
}

// 4. Determinism.
{
  const t2 = buildComboTable(profile, aeval, stage, brackets);
  buildAllComboEntries(t2);
  const s2 = t2.summary();
  const e2 = comboTableEntries(t2);
  const same = JSON.stringify(s2) === JSON.stringify(sum)
    && JSON.stringify(e2.map((e) => [e.key, e.routes, e.starterKills])) === snapshot;
  check('deterministic rebuild', same, `summary ${JSON.stringify(s2)}`);
}

// 5. Matchup brackets.
{
  const heavy: CharacterDef = { ...aeval, id: 'aevalHeavy', weight: 125 };
  const pHeavy = stubProfile(heavy, { fsmash: 118, usmash: 120, bair: 140, fair: 160, dsmash: 150, uspecial: 150 });
  pHeavy.charId = 'aevalHeavy';
  const mu = deriveMatchup(profile, profile, stage);
  const muH = deriveMatchup(profile, pHeavy, stage);
  const K = mu.K;
  const shape = mu.brackets.length === 5 && mu.brackets[0] === 0 && Math.abs(mu.brackets[1] - 0.3 * K) <= 1
    && Math.abs(mu.brackets[2] - 0.6 * K) <= 1 && Math.abs(mu.brackets[3] - 0.85 * K) <= 1 && mu.brackets[4] === K;
  check('matchup brackets', shape && muH.K > K, `mirror K ${K} brackets ${mu.brackets.join(',')}; weight 125 K ${muH.K}; `
    + `danger keys ${Object.keys(mu.danger).length}; safeVsB ${[...mu.safeVsB].join(',') || 'none'}`);
}

// 6. A victim def outside the registry (a heavier copy) and the second stage.
{
  const heavy: CharacterDef = { ...aeval, id: 'aevalHeavyVictim', weight: 125 };
  const t3 = buildComboTable(profile, heavy, STAGE_DEFS.hearthmoor, brackets);
  const key: ComboKey = { starter: 'dtilt', bracket: 2, hitClass: 0, dxBucket: 1, dyBucket: 0, grounded: true, spot: 'center' };
  const rs = t3.routes(key);
  const restored = CHARACTER_DEFS.aevalHeavyVictim === undefined;
  check('foreign victim and second stage', restored && t3.summary().entries > 0,
    `hearthmoor vs weight 125: dtilt b2 -> ${rs.map((r) => r.moves.join('>')).join(', ') || 'none'}; summary ${JSON.stringify(t3.summary())}; registry restored ${restored}`);
}

process.stdout.write(`${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`);
if (failures > 0) process.exitCode = 1;
