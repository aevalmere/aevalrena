/**
 * Unit checks for the opponent model (W1.11, W1.12): predictor bank, gating, changepoint, v2
 * profile store. Run: npx --yes tsx src/ai/eval/unit/model.ts (exit code 1 on any failure).
 */
import type { InputFrame, MatchConfig } from '../../../core/types';
import { Btn } from '../../../core/types';
import { createGameState, stepGame } from '../../../sim';
import { ACTION_CLASS_COUNT, COUNTER_ME, type ObsContext } from '../../contracts';
import { levelVector } from '../../levels';
import { u01 } from '../../rng';
import {
  AC_IN, AC_NONE, AC_ROLL_AWAY, AC_SHIELD, AC_SPOT, AC_GRAB, AC_JUMP, MEMBER_NAMES, N_MEMBERS,
  createPredictorBank, makeContext, newContext, type PredictorBank,
} from '../../model/predictor';
import { breakEven, createGiftBudget, exploitAllowed, expDet, lnDet, restrictedWeight, wilsonLB } from '../../model/gating';
import { createChangepoint, createChangepointState } from '../../model/changepoint';
import {
  CappedProfileStore, MemoryProfileStore, PROFILE_PREFIX, V1_INDEX_KEY, V1_PROFILE_PREFIX, decodeProfile,
  discardV1Profiles, encodeProfile, profileKeyFor,
} from '../../profile';

const failures: string[] = [];
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures.push(`${name}${detail !== '' ? `: ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ` (${detail})` : ''}`);
}
function near(a: number, b: number, eps: number): boolean { return Math.abs(a - b) <= eps; }

const GOD = levelVector(1, true);
const Z = GOD.learning.z;

function ctxFixed(): ObsContext {
  const c = newContext();
  c.sit = 0; c.dist = 1; c.ours = 0; c.pctBucket = 0; c.zone = 0;
  return c;
}

// ---- deterministic math ------------------------------------------------------------------------
{
  let maxErr = 0;
  for (const x of [1e-4, 0.01, 0.3, 0.5, 1, 1.7, 2, 3.14159, 20, 1e6]) maxErr = Math.max(maxErr, Math.abs(lnDet(x) - Math.log(x)));
  for (const x of [-40, -10, -3.3, -0.5, 0, 0.5, 2, 10]) maxErr = Math.max(maxErr, Math.abs(expDet(x) - Math.exp(x)) / Math.exp(x));
  check('lnDet and expDet match Math to 1e-12', maxErr < 1e-12, `max err ${maxErr.toExponential(2)}`);
}

// ---- gating --------------------------------------------------------------------------------------
{
  const z = 1.282;
  const lb22 = wilsonLB(2, 2, z), lb44 = wilsonLB(4, 4, z), lb77 = wilsonLB(7, 7, z), lb23 = wilsonLB(2, 3, z);
  check('wilsonLB 2 of 2 >= 0.5 at z 1.282', lb22 >= 0.5, lb22.toFixed(3));
  check('wilsonLB 4 of 4 >= 0.7 at z 1.282', lb44 >= 0.7, lb44.toFixed(3));
  check('wilsonLB 7 of 7 >= 0.8 at z 1.282', lb77 >= 0.8, lb77.toFixed(3));
  check('wilsonLB 2 of 3 is thin evidence (< 0.35 at z 1.282, about 0.25 at z 1.645)',
    lb23 < 0.35 && near(wilsonLB(2, 3, 1.645), 0.25, 0.02), `${lb23.toFixed(3)}, ${wilsonLB(2, 3, 1.645).toFixed(3)}`);
  let n70 = 1;
  while (wilsonLB(0.7 * n70, n70, z) < 0.5) n70++;
  console.log(`info wilsonLB: a 70% habit reaches LB 0.5 at n = ${n70} (z 1.282)`);
  check('wilsonLB n = 0 is 0', wilsonLB(0, 0, z) === 0);
  // Break-even: a counter that opens us to a kill needs a lot of evidence, a cheap one little.
  const pRisky = breakEven(10, -40, 2, 0);
  const pCheap = breakEven(10, 0, 1, 0);
  check('breakEven risky counter p* = 0.84', near(pRisky, 0.84, 1e-9), pRisky.toFixed(3));
  check('breakEven cheap counter p* = 0.1', near(pCheap, 0.1, 1e-9), pCheap.toFixed(3));
  check('breakEven counter never worse than safe is 0', breakEven(5, 3, 2, 0) === 0);
  check('breakEven counter with no upside is Infinity', breakEven(-1, 0, 1, 0) === Infinity);
  check('gate refuses a 7 of 10 habit below break-even (risky counter)', !exploitAllowed(7, 10, z, 4, pRisky),
    `LB ${wilsonLB(7, 10, z).toFixed(3)} < p* ${pRisky.toFixed(2)}`);
  check('gate accepts the same habit for a cheap counter', exploitAllowed(7, 10, z, 4, pCheap));
  check('gate refuses below nMin', !exploitAllowed(3, 3, z, 4, 0));
  check('restrictedWeight', restrictedWeight(0.4, 0.75) === 0 && near(restrictedWeight(0.7, 0.75), 0.375, 1e-12)
    && restrictedWeight(1, 0.75) === 0.75 && restrictedWeight(0.2, 0.75) === 0);
  const g = createGiftBudget();
  g.add(5, 2); g.add(3, 2.5);
  const a1 = g.allowance();
  g.add(1, 4);        // spend 3 on an exploitative plan's worst case
  const a2 = g.allowance();
  g.add(0, 10);       // overspend clamps at 0
  const a3 = g.allowance();
  g.add(4, 1); g.reset();
  check('gift budget accumulates, spends, floors at 0, resets', a1 === 3.5 && a2 === 0.5 && a3 === 0 && g.allowance() === 0,
    `${a1} ${a2} ${a3}`);
}

// ---- periodic habit ------------------------------------------------------------------------------
const PERIOD = [1, AC_SHIELD, AC_ROLL_AWAY];
function runPeriodic(bank: PredictorBank, n: number, trace: number[] | null): { firstStable: number; lbAt2: number } {
  const ctx = ctxFixed();
  ctx.phase = 1;      // 20 frames between actions; the query and the record then share a row
  const out = new Float64Array(ACTION_CLASS_COUNT);
  let firstStable = -1;
  let lbAt2 = -1;
  for (let i = 0; i < n; i++) {
    const cls = PERIOD[i % PERIOD.length];
    bank.predict(ctx, out);
    if (trace !== null) for (let a = 0; a < ACTION_CLASS_COUNT; a++) trace.push(out[a]);
    const top = bank.topClass();
    if (top === cls) { if (firstStable < 0) firstStable = i; } else firstStable = -1;
    // The habit's own context has now been seen i / period times.
    if (lbAt2 < 0 && Math.floor(i / PERIOD.length) === 3) {
      const kn = bank.counts(ctx, cls);
      lbAt2 = wilsonLB(kn.k, kn.n, Z);
    }
    bank.recordAction(cls, ctx, 100 + i * 20, false);
  }
  return { firstStable, lbAt2 };
}
{
  const bank = createPredictorBank(GOD);
  const r = runPeriodic(bank, 60, null);
  // Guide 02 section 6.3: an always-observed option reaches LB 0.5 at 2 observations (z 1.282).
  const limit = 2 * PERIOD.length;
  check(`periodic habit: top guess right on every observation from ${limit} on (2 per context)`,
    r.firstStable >= 0 && r.firstStable <= limit, `stable from observation ${r.firstStable}`);
  check('periodic habit: its context counts reach Wilson LB 0.5 after 2 observations', r.lbAt2 >= 0.5, r.lbAt2.toFixed(3));
}

// ---- gating on the predictor's own counts ---------------------------------------------------------
{
  const bank = createPredictorBank(GOD);
  const ctx = ctxFixed();
  ctx.last = AC_NONE; ctx.prev = AC_NONE; ctx.phase = 2;      // one fixed row
  const seq = [AC_SPOT, AC_SPOT, AC_JUMP, AC_SPOT, AC_JUMP];   // 60% spot dodge
  for (let i = 0; i < 40; i++) bank.recordAction(seq[i % seq.length], ctx, 100 + i * 30, false);
  const kn = bank.counts(ctx, AC_SPOT);
  const lb = wilsonLB(kn.k, kn.n, Z);
  const pStarRisky = breakEven(10, -40, 2, 0);
  const pStarCheap = breakEven(10, 0, 1, 0);
  check('predictor counts: a 60% habit is refused against a risky counter', !exploitAllowed(kn.k, kn.n, Z, GOD.learning.nMin, pStarRisky),
    `k ${kn.k.toFixed(2)} n ${kn.n.toFixed(2)} LB ${lb.toFixed(3)} p* ${pStarRisky.toFixed(2)}`);
  check('predictor counts: the same habit passes for a cheap counter', exploitAllowed(kn.k, kn.n, Z, GOD.learning.nMin, pStarCheap));
  const slowN = kn.n;
  const fk = bank.fastCounts(ctx, AC_SPOT);
  check('fast table has the smaller effective sample', fk.n < slowN && fk.n > 5 && fk.n < 11, `fast n ${fk.n.toFixed(2)}, slow n ${slowN.toFixed(2)}`);
}

// ---- changepoint -----------------------------------------------------------------------------------
{
  const cp = createChangepoint();
  let fired = false;
  for (let i = 0; i < 500; i++) fired = cp.update(0.6, 0.6, i) || fired;
  check('changepoint: equal slow and fast never fires', !fired);
  let at = -1;
  for (let i = 0; i < 10 && at < 0; i++) if (cp.update(0.02, 0.4, 1000 + i)) at = i;
  check('changepoint: fires once the fast model is ~20x better (3 nats)', at === 0 || at === 1, `at ${at}`);
  const cs = createChangepointState();
  const f1 = cs.onStockChange(100), f2 = cs.onStockChange(400), f3 = cs.onStockChange(800);
  check('onStockChange: 0.7, then 1 within 600 frames, then 0.7', f1 === 0.7 && f2 === 1 && f3 === 0.7, `${f1} ${f2} ${f3}`);
  const p1 = cs.poisoned(100, 2), p2 = cs.poisoned(200, 3.5), p3 = cs.poisoned(300, 9), c2 = createChangepoint();
  check('poisoned: true once inside 30 s above 3 nats, never after 1800 frames',
    !p1 && p2 && !p3 && !c2.poisoned(1801, 50));
}
function runSwitch(stationaryFrames: number, switchTo: number, pattern: readonly number[]): { resetsBefore: number; framesToReset: number } {
  const bank = createPredictorBank(GOD);
  const ctx = ctxFixed();
  const step = 12;       // one observation per 12 frames (the drift sample rate)
  let f = 100, i = 0;
  for (; f < 100 + stationaryFrames; f += step, i++) bank.recordAction(pattern[i % pattern.length], ctx, f, false);
  const before = bank.stats().resets;
  const switchFrame = f;
  let framesToReset = -1;
  for (let j = 0; j < 400 && framesToReset < 0; j++, f += step) {
    bank.recordAction(switchTo, ctx, f, false);
    if (bank.stats().resets > before) framesToReset = f - switchFrame;
  }
  return { resetsBefore: before, framesToReset };
}
{
  const a = runSwitch(3000, AC_GRAB, [AC_SHIELD]);
  check('changepoint: no reset over 3,000 frames of a constant habit', a.resetsBefore === 0, `${a.resetsBefore} resets`);
  check('changepoint: resets within 20 s (1,200 frames) of a switch', a.framesToReset >= 0 && a.framesToReset <= 1200,
    `${a.framesToReset} frames`);
  const b = runSwitch(3000, AC_IN, [1, AC_SHIELD, AC_ROLL_AWAY, AC_SHIELD]);
  check('changepoint: no reset over 3,000 frames of a periodic habit', b.resetsBefore === 0, `${b.resetsBefore} resets`);
  check('changepoint: periodic habit switch resets within 1,200 frames', b.framesToReset >= 0 && b.framesToReset <= 1200,
    `${b.framesToReset} frames`);
  // Informational: an i.i.d. 60/30/10 mix (the plan gate is on stationary adversaries, not noise).
  const bank = createPredictorBank(GOD);
  const ctx = ctxFixed();
  const opts = [AC_SHIELD, AC_SPOT, AC_JUMP];
  for (let i = 0; i < 250; i++) {
    const u = u01(7, 0, i, 99);
    bank.recordAction(opts[u < 0.6 ? 0 : u < 0.9 ? 1 : 2], ctx, 100 + i * 12, false);
  }
  console.log(`info changepoint on an i.i.d. 60/30/10 stream over 3,000 frames: ${bank.stats().resets} resets`);
}

// ---- counter-me ------------------------------------------------------------------------------------
{
  const bank = createPredictorBank(GOD);
  const ctx = ctxFixed();
  const OURS = [AC_GRAB, AC_SHIELD, 8];                   // our options: grab, shield, nair
  const ANS = [AC_SPOT, 1, AC_JUMP];                      // the reader's answer to each
  const scores = new Float64Array(N_MEMBERS);
  let leadAt = -1;
  for (let i = 0; i < 40; i++) {
    const pick = Math.floor(u01(11, 0, i, 98) * 3);
    for (let k = 0; k < 9; k++) bank.recordOwn(OURS[pick]);   // our most frequent recent option is now OURS[pick]
    bank.recordAction(ANS[pick], ctx, 100 + i * 30, false);
    bank.memberScores(scores);
    let best = 0;
    for (let c = 1; c < N_MEMBERS; c++) if (scores[c] > scores[best]) best = c;
    if (best === COUNTER_ME) { if (leadAt < 0) leadAt = i + 1; } else leadAt = -1;
  }
  let s = 0;
  for (let c = 0; c < N_MEMBERS; c++) s += scores[c];
  check('counter-me leads against a reader within 40 observations', leadAt > 0 && leadAt <= 40,
    `leads from observation ${leadAt}, weight ${scores[COUNTER_ME].toFixed(3)}`);
  check('memberScores has 8 members summing to 1', N_MEMBERS === 8 && MEMBER_NAMES[COUNTER_ME] === 'counterMe' && near(s, 1, 1e-9));
}

// ---- determinism -----------------------------------------------------------------------------------
{
  const t1: number[] = [], t2: number[] = [];
  const b1 = createPredictorBank(GOD), b2 = createPredictorBank(GOD);
  runPeriodic(b1, 90, t1); runPeriodic(b2, 90, t2);
  let same = t1.length === t2.length;
  for (let i = 0; same && i < t1.length; i++) if (!Object.is(t1[i], t2[i])) same = false;
  check('determinism: same stream, same predictions bit for bit', same && b1.serialize() === b2.serialize(), `${t1.length} values`);

  // The same through observe() on a live sim state.
  const config: MatchConfig = { stageId: 'tidegate', stocks: 3, timeLimitSec: 0, seed: 5,
    players: [{ slot: 0, charId: 'aeval', cpu: true, cpuLevel: 10 }, { slot: 1, charId: 'aeval', cpu: false, cpuLevel: 0, name: 'Tess' }] };
  function simRun(): { preds: number[]; ser: string; total: number } {
    const st = createGameState(config);
    const bank = createPredictorBank(GOD);
    const ctx = newContext();
    const out = new Float64Array(ACTION_CLASS_COUNT);
    const preds: number[] = [];
    const inputs: InputFrame[] = [{ held: 0, pressed: 0, released: 0 }, { held: 0, pressed: 0, released: 0 }];
    let prevHeld = 0;
    for (let f = 0; f < 900; f++) {
      let held = (f % 90) < 45 ? Btn.Right : Btn.Left;
      if (f % 50 === 10) held |= Btn.Attack;
      if (f % 170 === 60) held |= Btn.Shield;
      if (f % 130 === 90) held |= Btn.Jump;
      inputs[1].held = held; inputs[1].pressed = held & ~prevHeld; inputs[1].released = prevHeld & ~held;
      prevHeld = held;
      stepGame(st, inputs);
      bank.observe(st, 0, 1, st.frame);
      if (f % 10 === 0) {
        makeContext(st, 0, 1, st.frame, ctx);
        preds.push(bank.predict(ctx, out));
        for (let a = 0; a < ACTION_CLASS_COUNT; a++) preds.push(out[a]);
      }
    }
    return { preds, ser: bank.serialize(), total: bank.stats().total };
  }
  const r1 = simRun(), r2 = simRun();
  let simSame = r1.preds.length === r2.preds.length && r1.ser === r2.ser;
  for (let i = 0; simSame && i < r1.preds.length; i++) if (!Object.is(r1.preds[i], r2.preds[i])) simSame = false;
  check('determinism: observe() on a live match twice gives identical predictions', simSame && r1.total > 20,
    `${r1.total} observations`);
}

// ---- profile store -----------------------------------------------------------------------------------
{
  check('v2 prefix', PROFILE_PREFIX === 'aevalrena.cpu.profile.v2.');
  const bank = createPredictorBank(GOD);
  runPeriodic(bank, 60, null);
  const model = bank.serialize();
  const mem = new MemoryProfileStore();
  const store = new CappedProfileStore(mem);
  const config: MatchConfig = { stageId: 'tidegate', stocks: 3, timeLimitSec: 0, seed: 1,
    players: [{ slot: 0, charId: 'aeval', cpu: false, cpuLevel: 0, name: ' Rin ' }, { slot: 1, charId: 'aeval', cpu: true, cpuLevel: 10 }] };
  const key = profileKeyFor(config, 0);
  check('profile key by typed name, none for a CPU', key === `${PROFILE_PREFIX}Rin` && profileKeyFor(config, 1) === null, String(key));
  store.save(key as string, encodeProfile({ model, archetype: 'countering', skill: 1234, matches: 3 }));
  const dec = decodeProfile(store.load(key as string));
  check('profile round trip: envelope', dec.profile !== null && dec.profile.model === model && dec.profile.archetype === 'countering'
    && dec.profile.skill === 1234 && dec.profile.matches === 3, dec.reason);
  const fresh = createPredictorBank(GOD);
  const loaded = dec.profile !== null && fresh.load(dec.profile.model);
  check('profile round trip: model loads and re-serializes identically', loaded && fresh.serialize() === model,
    `${model.length} chars`);
  const q = ctxFixed();
  q.last = AC_SHIELD; q.prev = 1; q.phase = 1;
  const k1 = bank.counts(q, AC_ROLL_AWAY), a = { k: k1.k, n: k1.n };
  const k2 = fresh.counts(q, AC_ROLL_AWAY);
  check('profile round trip: habit counts survive', near(a.k, k2.k, 0.02) && near(a.n, k2.n, 0.1),
    `k ${a.k.toFixed(2)}/${k2.k.toFixed(2)} n ${a.n.toFixed(2)}/${k2.n.toFixed(2)}`);
  // v1 is ignored.
  const v1 = JSON.stringify({ v: 1, o0: [0, 1], o1: [], cp: [0.5], hb: [] });
  const d1 = decodeProfile(v1);
  const b1 = createPredictorBank(GOD);
  check('v1 blob: decode rejects with a reason, predictor refuses it', d1.profile === null && d1.reason.includes('v1') && !b1.load(v1)
    && b1.stats().total === 0, d1.reason);
  check('garbage blob refused', !b1.load('{nope') && !b1.load('null') && decodeProfile('{nope').reason === 'corrupt');
  const legacy = new MemoryProfileStore();
  legacy.save(`${V1_PROFILE_PREFIX}Rin`, v1);
  legacy.save(`${V1_PROFILE_PREFIX}Kai`, v1);
  legacy.save(V1_INDEX_KEY, JSON.stringify({ v: 1, e: [[`${V1_PROFILE_PREFIX}Rin`, 1], [`${V1_PROFILE_PREFIX}Kai`, 2]] }));
  legacy.save(`${PROFILE_PREFIX}Rin`, 'keep');
  const removed = discardV1Profiles(legacy);
  check('v1 keys discarded, v2 kept', removed === 2 && legacy.keys().length === 1 && legacy.load(`${PROFILE_PREFIX}Rin`) === 'keep',
    `removed ${removed}, left ${legacy.keys().join(',')}`);
  // Size and count bounds.
  const small = new MemoryProfileStore();
  const capped = new CappedProfileStore(small, 3, 1000);
  capped.save(`${PROFILE_PREFIX}big`, 'x'.repeat(1001));
  for (let i = 0; i < 5; i++) capped.save(`${PROFILE_PREFIX}p${i}`, `{"n":${i}}`);
  const kept = small.keys().filter((k) => k.startsWith(PROFILE_PREFIX));
  check('store bounded by size and count', small.load(`${PROFILE_PREFIX}big`) === null && kept.length === 3
    && small.load(`${PROFILE_PREFIX}p4`) !== null && small.load(`${PROFILE_PREFIX}p0`) === null, kept.join(','));
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  ${f}`).join('\n'));
  throw new Error(`${failures.length} model check(s) failed`);
}
