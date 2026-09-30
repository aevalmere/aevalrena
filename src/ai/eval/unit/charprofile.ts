/**
 * Unit checks for the character AI profile (W1.2 profile core, W1.3 hit probes, W1.4 motion
 * probes; 04 sections 2 to 4 and 9, plan risk R4). Run from the repo root:
 *
 *   npx --yes tsx src/ai/eval/unit/charprofile.ts
 *
 * Exit code 1 on any failure. Derived numbers are compared with hand arithmetic written out
 * here from src/characters/aeval/moves.ts, kill percents with src/sim/calibrate.ts, and the
 * committed cache with a fresh derive (which also proves the derive is stable across processes).
 */
import { aevalDef } from '../../../characters/aeval/moves';
import { TUNING } from '../../../core/constants';
import type { CharacterDef, MoveDef, MoveId } from '../../../core/types';
import { STAGE_DEFS } from '../../../stages/registry';
import { measure } from '../../../sim/calibrate';
import { stepGame } from '../../../sim/index';
import { startMove } from '../../../sim/moves';
import { simFighters } from '../../../sim/state';
import type { CharacterAiProfile, MoveAiInfo } from '../../contracts';
import { cachedEntry, REGENERATE_COMMAND, serializeProfile } from '../../charprofile/cache';
import {
  deriveAiProfile, deriveBaseProfile, getAiProfile, profileDataHash, profileFromCache, stableStringify,
} from '../../charprofile/derive';
import { applyOverrides } from '../../charprofile/overrides';
import { place, trialState, withProbeWorld } from '../../charprofile/probeHit';
import { probeShots, RECOVER_DX_BIN, RECOVER_NONE, recoverBoxIndex } from '../../charprofile/probeMotion';
import { MOVE_ORDER } from '../../charprofile/tags';

declare const process: { exitCode?: number };

const failures: string[] = [];
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures.push(`${name}${detail !== '' ? `: ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ` (${detail})` : ''}`);
}
function near(a: number, b: number, eps: number): boolean { return Math.abs(a - b) <= eps; }
function info(line: string): void { console.log(`info ${line}`); }

const tide = STAGE_DEFS.tidegate;
const hearth = STAGE_DEFS.hearthmoor;

// ---------------------------------------------------------------------------------------------
// R4: hash, cache, cold load, derive cost
// ---------------------------------------------------------------------------------------------

const h1 = profileDataHash(aevalDef, tide, TUNING);
const h2 = profileDataHash(aevalDef, tide, TUNING);
check('hash stable within a run', h1 === h2, h1);
const hHearth = profileDataHash(aevalDef, hearth, TUNING);
check('hash is stage-aware', hHearth !== h1);
const tidEntry = cachedEntry('aeval', 'tidegate');
const hearthEntry = cachedEntry('aeval', 'hearthmoor');
check('committed cache hash matches live data (tidegate)', tidEntry !== null && tidEntry.dataHash === h1,
  tidEntry === null ? `no entry; run ${REGENERATE_COMMAND}` : `cache ${tidEntry.dataHash} live ${h1}; run ${REGENERATE_COMMAND}`);
check('committed cache hash matches live data (hearthmoor)', hearthEntry !== null && hearthEntry.dataHash === hHearth,
  hearthEntry === null ? `no entry; run ${REGENERATE_COMMAND}` : `cache ${hearthEntry.dataHash} live ${hHearth}`);

let t0 = performance.now();
const cold = getAiProfile('aeval', 'tidegate');
const coldMs = performance.now() - t0;
check('cold getAiProfile reads the cache', profileFromCache('aeval', 'tidegate') === true);
check('cold getAiProfile under 200 ms', coldMs < 200, `${coldMs.toFixed(1)} ms`);
t0 = performance.now();
const again = getAiProfile('aeval', 'tidegate');
check('getAiProfile memoized', again === cold, `${(performance.now() - t0).toFixed(2)} ms`);

t0 = performance.now();
const baseA = deriveBaseProfile(aevalDef, tide, TUNING);
const deriveMs = performance.now() - t0;
info(`cold derive (every probe) aeval on tidegate: ${deriveMs.toFixed(0)} ms`);
t0 = performance.now();
const baseB = deriveBaseProfile(aevalDef, tide, TUNING);
info(`second derive: ${(performance.now() - t0).toFixed(0)} ms`);
const sA = stableStringify(serializeProfile(baseA));
check('derive deterministic in one process', sA === stableStringify(serializeProfile(baseB)));
check('derive equals the committed cache (another process)', tidEntry !== null && sA === stableStringify(tidEntry.profile));
check('cached profile equals derived profile', stableStringify(serializeProfile(cold)) === stableStringify(serializeProfile(applyOverrides(baseA, cold.overrides ?? {}).profile)));

// ---------------------------------------------------------------------------------------------
// Hand arithmetic (04 section 2)
// ---------------------------------------------------------------------------------------------

/** kb of the sim (src/sim/hits.ts) for a victim at p before a hit of d, weight 88. */
function kb(p: number, d: number, bkb: number, kbg: number): number {
  const q = p + d;
  return (((q / 10 + (q * d) / 20) * (200 / 188) * 1.4) + 18) * (kbg / 100) + bkb;
}
function W(p: number, d: number, bkb: number, kbg: number, lag: number): number {
  return Math.floor(0.4 * kb(p, d, bkb, kbg)) - lag;
}
const P = cold.moves;

function expectMove(id: MoveId, want: Partial<Record<keyof MoveAiInfo, number>>): void {
  const m = P[id];
  const keys = Object.keys(want) as (keyof MoveAiInfo)[];
  for (const k of keys) check(`${id}.${k} = ${want[k]}`, near(m[k] as number, want[k] as number, 1e-9), String(m[k]));
}
// ftilt: circles r 10 from x 12 to 70 at y -18, frames 10-14, 30 total, iasa 26, 8 dmg, bkb 19 kbg 51.
expectMove('ftilt', { startup: 10, activeEnd: 14, endlag: 26 - 10 - 1, total: 30, landingLag: 0, maxDamage: 8,
  advShield: Math.floor(8 * 0.6) + 2 - (26 - 10 - 1) });
check('ftilt reach front 80 up 28', P.ftilt.reach.front === 80 && P.ftilt.reach.up === 28, JSON.stringify(P.ftilt.reach));
check('ftilt starterWindow at 0 and 100', P.ftilt.starterWindow[0] === W(0, 8, 19, 51, 15) && P.ftilt.starterWindow[5] === W(100, 8, 19, 51, 15),
  `${P.ftilt.starterWindow[0]} ${P.ftilt.starterWindow[5]}`);
// fsmash: circles r 13 from x 16 to 89 at y -18, frames 18-23, 48 total, no iasa, 15 dmg, chargeable.
expectMove('fsmash', { startup: 18, activeEnd: 23, endlag: 48 - 18 - 1, total: 48, maxDamage: 15,
  advShield: Math.floor(15 * 0.6) + 2 - (48 - 18 - 1) });
check('fsmash reach front 102', P.fsmash.reach.front === 102);
check('fsmash charge 60 frames x1.4', P.fsmash.chargeable && P.fsmash.charge !== null
  && P.fsmash.charge.maxFrames === 60 && near(P.fsmash.charge.damageMul, 1.4, 1e-12));
check('fsmash starterWindow at 60', P.fsmash.starterWindow[3] === W(60, 15, 19, 46, 29), String(P.fsmash.starterWindow[3]));
// uair: javelin to y -110, frames 14-18, 37 total, landing lag 12, 8 dmg, bkb 26 kbg 79.
expectMove('uair', { startup: 14, activeEnd: 18, endlag: 37 - 14 - 1, total: 37, landingLag: 12, maxDamage: 8,
  advShield: Math.floor(8 * 0.6) + 2 - Math.min(22, 12) });
check('uair reach up 110', P.uair.reach.up === 110, String(P.uair.reach.up));
check('uair starterWindow at 0 uses landing lag', P.uair.starterWindow[0] === W(0, 8, 26, 79, 12), String(P.uair.starterWindow[0]));

// The orb: tap 3.5 px/f for 48 f from 18 px ahead; full 9.5 px/f for 34 f; cast 3 + 12 * c.
const orb = cold.shots.find((s) => s.defId === 'orb');
check('orb shot present', orb !== undefined);
if (orb !== undefined) {
  check('orb range(0) = 18 + 3.5 * 48 = 186', near(orb.range(0), 186, 1e-9), String(orb.range(0)));
  check('orb range(60) = 18 + 9.5 * 34 = 341', near(orb.range(60), 341, 1e-9), String(orb.range(60)));
  check('orb range(0) in 180..192, range(60) in 330..350 (W1.4)', orb.range(0) >= 180 && orb.range(0) <= 192 && orb.range(60) >= 330 && orb.range(60) <= 350);
  check('orb castFrames 3 / 15, totalFrames 12 / 24', orb.castFrames(0) === 3 && orb.castFrames(60) === 15
    && orb.totalFrames(0) === 12 && orb.totalFrames(60) === 24);
  check('orb damage 4 / 16, speed 3.5 / 9.5, strength 2 / 10', near(orb.damage(0), 4, 1e-9) && near(orb.damage(60), 16, 1e-9)
    && near(orb.speed(0), 3.5, 1e-9) && near(orb.speed(60), 9.5, 1e-9) && near(orb.strength(0), 2, 1e-9) && near(orb.strength(60), 10, 1e-9));
  check('orb radius 8 x 0.6 / 12 x 1.5', near(orb.radius(0), 4.8, 1e-9) && near(orb.radius(60), 18, 1e-9));
  check('orb burst and drain facts', orb.burstId === 'orbBurst' && !orb.pierces && orb.returns === null && orb.height === 20);
  // The same number from the sim: where a tapped orb dies (and bursts), px ahead of the thrower.
  const flown = withProbeWorld(aevalDef, aevalDef, tide, (w) => {
    const st = trialState(w);
    const [f, o] = simFighters(st);
    place(f, aevalDef, -200, 0, true);
    f.facing = 1;
    place(o, aevalDef, 240, 0, true);
    startMove(st, f, aevalDef, 'nspecial');
    let far = 0;
    for (let t = 0; t < 80; t++) {
      stepGame(st, [{ held: 0, pressed: 0, released: 0 }, { held: 0, pressed: 0, released: 0 }]);
      for (const e of st.events) if (e.type === 'projectileDie' && e.defId === 'orb') far = Math.max(far, e.x - f.x);
    }
    return far;
  });
  check('orb range(0) matches the sim', near(flown, orb.range(0), 0.5), `sim ${flown}`);
}
const crescent = cold.shots.find((s) => s.defId === 'crescent');
check('crescent returns (W1.4)', crescent !== undefined && crescent.returns === 57 && crescent.pierces
  && near(crescent.range(0), 20 + 3.2 * 57, 1e-9), crescent === undefined ? 'missing' : String(crescent.range(0)));

// ---------------------------------------------------------------------------------------------
// Tags and roles (W1.2)
// ---------------------------------------------------------------------------------------------

const tagged = (id: MoveId, t: string): boolean => P[id].tags.indexOf(t as never) >= 0;
check('dair tagged spike', tagged('dair', 'spike'), P.dair.tags.join(','));
check('uspecial tagged recovery', tagged('uspecial', 'recovery'), P.uspecial.tags.join(','));
check('nspecial and sspecial tagged projectile', tagged('nspecial', 'projectile') && tagged('sspecial', 'projectile'));
check('no commandGrab (the Final Smash is not a MoveDef)', MOVE_ORDER.every((id) => !tagged(id, 'commandGrab')));
const hitsLedge = MOVE_ORDER.filter((id) => aevalDef.moves[id].hitsLedge === true);
check('hitsLedge moves in roles.ledgeTrap', hitsLedge.length > 0 && hitsLedge.every((id) => cold.roles.ledgeTrap.indexOf(id) >= 0),
  `${hitsLedge.join(',')} vs ${cold.roles.ledgeTrap.join(',')}`);
check('every role lists moves with tags', cold.roles.recovery.indexOf('uspecial') >= 0 && cold.roles.kill.length > 0
  && cold.roles.oos.length > 0 && cold.roles.neutral.length > 0);
check('tags only from the tag set', MOVE_ORDER.every((id) => P[id].tags.every((t) => typeof t === 'string')));
const tagTable = MOVE_ORDER.map((id) => `${id}:${P[id].tags.join('+')}`).join(' ');
info(`tags ${tagTable}`);
check('overrides from ai.overrides.json attached', cold.overrides !== undefined && Array.isArray(cold.overrides.preferredHolds));

// ---------------------------------------------------------------------------------------------
// Kill percents and shield safety (W1.3)
// ---------------------------------------------------------------------------------------------

let calRows = 0;
for (const id of MOVE_ORDER) {
  const mv: MoveDef = aevalDef.moves[id];
  if (mv.hitboxes.length === 0 && (mv.projectiles === undefined || mv.projectiles.length === 0)) continue;
  const cal = measure(id).koPercent;
  const ours = P[id].killPct.center;
  calRows++;
  if (cal < 0 || cal > 250) check(`${id} center kill vs calibrate (none)`, Number.isNaN(ours), `ours ${ours} cal ${cal}`);
  else check(`${id} center kill within 2% of calibrate`, Math.abs(ours - cal) <= 0.02 * cal, `ours ${ours} cal ${cal}`);
}
check('calibrate compared on every move with output', calRows >= 17, String(calRows));
for (const id of MOVE_ORDER) {
  const k = P[id].killPct;
  if (Number.isNaN(k.center) || Number.isNaN(k.ledge)) continue;
  check(`${id} ledge kill <= center kill`, k.ledge <= k.center, `${k.ledge} vs ${k.center}`);
}
const H = deriveAiProfile(aevalDef, hearth, TUNING);
check('kill percents are stage-aware', MOVE_ORDER.some((id) => P[id].killPct.center !== H.moves[id].killPct.center));
check('dair gimps offstage (recovering victim)', P.dair.killPctRecover.offstage < 100, String(P.dair.killPctRecover.offstage));
check('shield safety measured on attacks', P.jab.safeShieldMeasured && P.ftilt.safeShieldMeasured && !P.taunt.safeShieldMeasured);
info(`shield safe: ${MOVE_ORDER.filter((id) => P[id].safeShield).join(',')}`);
check('throws carry kill percents', Object.values(cold.grab.throws).some((t) => Number.isFinite(t.killPct.center)));

// ---------------------------------------------------------------------------------------------
// Motion (W1.4)
// ---------------------------------------------------------------------------------------------

const R = cold.recovery;
/** Rise of a jump in the sim's integration: vy set, gravity added the same frame, until vy >= 0. */
function riseOf(v: number, g: number): number {
  let y = 0;
  let vy = -v;
  let top = 0;
  for (let i = 0; i < 200; i++) {
    vy = Math.min(vy + g, Math.max(3.2, vy));
    y += vy;
    if (y < top) top = y;
    if (vy >= 0) break;
  }
  return -top;
}
check('full hop = sim arithmetic', near(R.rise.fullHop, riseOf(5.4, 0.15), 1e-6), R.rise.fullHop.toFixed(2));
check('short hop = sim arithmetic', near(R.rise.shortHop, riseOf(3.5, 0.15), 1e-6), R.rise.shortHop.toFixed(2));
check('double jump 76..86 (W1.4)', R.rise.airJump >= 76 && R.rise.airJump <= 86, R.rise.airJump.toFixed(2));
info(`full hop ${R.rise.fullHop.toFixed(1)} (plan W1.4 range 95..105), short hop ${R.rise.shortHop.toFixed(1)} (plan 40..46): the sim's integration gives 94.5 and 39.1`);
check('geyser rise 77..87 in 48 frames, helpless', R.upSpecial.rise >= 77 && R.upSpecial.rise <= 87 && R.upSpecial.frames === 48
  && R.upSpecial.helpless && R.upSpecial.grabsBefore === 48, `${R.upSpecial.rise.toFixed(1)} ${R.upSpecial.frames}`);
check('air dodge sideways 100..118 (W1.4)', Math.abs(R.airDodge.r.dx) >= 100 && Math.abs(R.airDodge.r.dx) <= 118
  && near(R.airDodge.l.dx, -R.airDodge.r.dx, 1e-9), R.airDodge.r.dx.toFixed(1));
const J = aevalDef.jumps;
let upbOk = true;
const upbRow: number[] = [];
for (let b = 0; b < 16; b++) upbRow.push(R.recoverBox[recoverBoxIndex(0, 1, 0, b, J)]);
for (let dx = 40; dx <= 120; dx += RECOVER_DX_BIN) {
  const d = R.recoverBox[recoverBoxIndex(0, 1, 0, dx / RECOVER_DX_BIN, J)];
  if (!(d >= 100 && d <= 150)) upbOk = false;
}
check('recover box: no jump, up special, depth 100..150 at dx 40..120', upbOk, upbRow.join(' '));
check('recover box: none at dx 260', R.recoverBox[recoverBoxIndex(0, 1, 0, 260 / RECOVER_DX_BIN, J)] === RECOVER_NONE);
check('recover box: more resources never worse', (() => {
  for (let b = 0; b < 16; b++) {
    if (R.recoverBox[recoverBoxIndex(1, 1, 1, b, J)] < R.recoverBox[recoverBoxIndex(0, 1, 0, b, J)]) return false;
  }
  return true;
})());
check('fall to blast from ledge height', R.fallToBlast > 60 && R.fallToBlast < 200, String(R.fallToBlast));

const noShots: CharacterDef = { ...aevalDef, id: 'aevalNoShots', moves: { ...aevalDef.moves } };
for (const id of MOVE_ORDER) noShots.moves[id] = { ...aevalDef.moves[id], projectiles: undefined };
check('shots empty without projectiles', probeShots(noShots, tide).length === 0);

// ---------------------------------------------------------------------------------------------
// Overrides (04 section 4, 8)
// ---------------------------------------------------------------------------------------------

const o1 = applyOverrides(cold, { numbers: { moves: { ftilt: { startup: 14 } } } });
check('override contradicting by more than 10% warns', o1.warnings.some((w) => w.indexOf('moves.ftilt.startup') >= 0), o1.warnings.join('; '));
check('override value wins', o1.profile.moves.ftilt.startup === 14 && cold.moves.ftilt.startup === 10);
const o2 = applyOverrides(cold, { numbers: { moves: { ftilt: { startup: 10.5 } } } });
check('override within 10% is silent', o2.warnings.length === 0, o2.warnings.join('; '));
const o3 = applyOverrides(cold, { tags: { fsmash: { add: ['poke'], remove: ['killMove'] } } });
check('tag override add and remove', o3.profile.moves.fsmash.tags.indexOf('poke') >= 0 && o3.profile.moves.fsmash.tags.indexOf('killMove') < 0);
check('roles rebuilt after tag override', o3.profile.roles.kill.indexOf('fsmash') < 0 && o3.profile.roles.neutral.indexOf('fsmash') >= 0
  && hitsLedge.every((id) => o3.profile.roles.ledgeTrap.indexOf(id) >= 0));

// ---------------------------------------------------------------------------------------------
// bc part 1: a copy of Aeval with altered numbers derives with no code change
// ---------------------------------------------------------------------------------------------

const altered: CharacterDef = {
  ...aevalDef, id: 'aevalAltered', weight: 110, jumpVel: 6,
  moves: { ...aevalDef.moves, ftilt: { ...aevalDef.moves.ftilt, hitboxes: aevalDef.moves.ftilt.hitboxes.map((h) => ({ ...h, damage: 12 })) } },
};
t0 = performance.now();
const alt: CharacterAiProfile = deriveAiProfile(altered, tide, TUNING);
info(`altered copy derive: ${(performance.now() - t0).toFixed(0)} ms`);
check('altered copy derives', alt.charId === 'aevalAltered' && alt.physics.weight === 110 && alt.moves.ftilt.maxDamage === 12
  && alt.dataHash !== cold.dataHash && alt.recovery.rise.fullHop > cold.recovery.rise.fullHop);
check('probe registry restored', getAiProfile('aeval', 'tidegate') === cold);

console.log(`\n${checks - failures.length}/${checks} checks passed; cold derive ${deriveMs.toFixed(0)} ms; cold cached load ${coldMs.toFixed(1)} ms`);
if (failures.length > 0) {
  console.log(`FAILED:\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
}
