/**
 * Owner requirements for teams and free-for-all (this wave), with the Teams rule of the sim: a
 * teammate's hitboxes, grabs, projectiles and Final Smash pass through (src/sim/hits.ts `sameTeam`),
 * so friendly fire does not exist and the teammate check is on wasted swings instead (aitest `ak`
 * geometry, pool.ts probe).
 *
 * - team.1v3.l4       god alone against three teamed UI level 4 CPUs must win.
 * - team.1v3.l1to3    god alone against teamed UI levels 1, 2 and 3 must win.
 *   Both gate on the Wilson lower bound at 73 matches (god tier); fast plays 4 and reports.
 *
 * Fast-tier counts are small (4 matches for the 1v3, 1v2 and 2v2 pairings, 3 and 2 free-for-alls)
 * so the whole fast tier stays under four minutes with the search brain, whose four-player matches
 * cost 30 to 40 s each; the full and god tiers play the counts the gates are defined on.
 * - team.1v2.l5       god against two teamed UI level 5 CPUs: reported only, the lead sets the bound.
 * - team.2v2.l7       two teamed UI level 7 CPUs against two independent UI level 7 CPUs win more than
 *                     they lose.
 * - team.mate         teamed CPUs never start an attack at a teammate's position (0 tolerance).
 * - ffa.focus         four UI level 7 CPUs: no CPU puts more than 70% of its openings on one opponent
 *                     when a more exposed opponent existed.
 * - ffa.god           the god in a four-player free-for-all takes the most stocks.
 *
 * The runner turns the Teams rule on for any match with more than two players, so a free-for-all
 * is four players on four distinct teams; the winner then comes from stocks left (`teamOutcome`).
 */
import type { TestCase, Tier } from '../../contracts';
import { openingsOf } from '../metrics';
import { num } from '../replay';
import { wilson } from '../stats';
import {
  GOD, pairedJobs, pairTag, refLabel, runBatch, TF, teamsOf, ui, type BrainRef, type JobResult, type JobSpec,
} from '../pool';
import { byTier, defineCase, f2, f3, gate, groundReach, listed, teamOutcome, wl } from './common';

/** Wilson lower bound the 1v3 cases must reach at the god tier's 73 matches. */
export const TEAM_1V3_LB = 0.90;
/** Share of a CPU's contested openings allowed on its most-hit opponent. */
export const FFA_FOCUS_MAX = 0.70;
/** Contested openings a CPU needs before its focus share is gated. */
export const FFA_FOCUS_MIN_N = 10;

function stocksFor(tier: Tier): number { return tier === 'nightly' ? 3 : 2; }

/** God (team 0, player a) against CPUs on team 1: b and the extras. */
function oneVsMany(tag: string, foes: readonly BrainRef[], n: number, stocks: number): JobSpec[] {
  const extras = foes.slice(1).map((ref) => ({ ref, team: 1 }));
  return pairedJobs({ stocks, frameCap: 5400 * stocks, a: GOD, b: foes[0], extras, probe: 'basic' },
    pairTag(GOD, foes[0], `${tag}|${foes.map(refLabel).join(',')}|s${stocks}`), n);
}

interface Side { wins: number; losses: number; draws: number; n: number; mateSwings: number; mateStarts: number }

function sideOf(rs: readonly JobResult[], team: number, stocks: number): Side {
  const s: Side = { wins: 0, losses: 0, draws: 0, n: 0, mateSwings: 0, mateStarts: 0 };
  for (const r of rs) {
    const teams = teamsOf(r.job);
    const w = teamOutcome(r.result, teams, stocks);
    s.n++;
    if (w < 0) s.draws++; else if (w === team) s.wins++; else s.losses++;
    if (r.probe !== null) {
      for (let p = 0; p < teams.length; p++) {
        const mates = teams.filter((t, q) => q !== p && t === teams[p]).length;
        if (mates === 0) continue;
        s.mateSwings += r.probe.mateSwings[p];
        s.mateStarts += r.probe.moveStarts[p];
      }
    }
  }
  return s;
}

function oneVsThree(id: string, foes: readonly BrainRef[]): TestCase {
  return defineCase(id, ['fast', 'full', 'nightly'], ({ tier }) => {
    const n = byTier(tier, { fast: 4, full: 20, nightly: 73 });
    const stocks = stocksFor(tier);
    const s = sideOf(runBatch(oneVsMany(id, foes, n, stocks)), 0, stocks);
    const lb = wilson(s.wins, s.n).lo;
    const detail = `god vs ${foes.map(refLabel).join('+')} teamed, ${stocks} stocks: won ${wl(s.wins, s.n)}, lost ${s.losses}, timeouts ${s.draws}` +
      ` (gate lb >= ${TEAM_1V3_LB} at n = 73); teamed CPUs' swings at a teammate ${s.mateSwings}/${s.mateStarts}`;
    return gate(id, lb >= TEAM_1V3_LB, detail, { wins: s.wins, n: s.n, lb, mateSwings: s.mateSwings }, tier !== 'nightly');
  });
}

const oneVsTwo: TestCase = defineCase('team.1v2.l5', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 4, full: 20, nightly: 73 });
  const stocks = stocksFor(tier);
  const s = sideOf(runBatch(oneVsMany('team.1v2.l5', [ui(5), ui(5)], n, stocks)), 0, stocks);
  const w = wilson(s.wins, s.n);
  return gate('team.1v2.l5', true, `god vs UI5+UI5 teamed, ${stocks} stocks: won ${wl(s.wins, s.n)} (hi ${f3(w.hi)}), lost ${s.losses}, ` +
    `timeouts ${s.draws}; report only, the lead sets the bound`, { wins: s.wins, n: s.n, lb: w.lo }, true);
});

/** a UI7 + extra UI7 on team 0; b UI7 on team 1; extra UI7 on team 2. */
function twoVsTwoJobs(n: number, stocks: number): JobSpec[] {
  const l7 = ui(7);
  return pairedJobs({ stocks, frameCap: 5400 * stocks, a: l7, b: l7, extras: [{ ref: l7, team: 0 }, { ref: l7, team: 2 }], probe: 'basic' },
    pairTag(l7, l7, `2v2|s${stocks}`), n);
}

/** Matches of the 2v2 pairing per tier; team.mate gates the same matches for teammate swings. */
function twoVsTwoN(tier: Tier): number { return byTier(tier, { fast: 4, full: 30, nightly: 73 }); }

const twoVsTwo: TestCase = defineCase('team.2v2.l7', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = twoVsTwoN(tier);
  const stocks = stocksFor(tier);
  const s = sideOf(runBatch(twoVsTwoJobs(n, stocks)), 0, stocks);
  const decisive = s.wins + s.losses;
  return gate('team.2v2.l7', s.wins > s.losses,
    `UI7 pair (team) vs two independent UI7, ${stocks} stocks: team won ${s.wins}, lost ${s.losses}, timeouts ${s.draws} of ${s.n}` +
    ` (decisive ${wl(s.wins, decisive)}); swings at a teammate ${s.mateSwings}/${s.mateStarts}`,
    { wins: s.wins, losses: s.losses, draws: s.draws, mateSwings: s.mateSwings }, tier === 'fast');
});

/** aitest `ak` (god + UI9 against UI9) and the 2v2 team: teamed CPUs never swing at a teammate. */
const mate: TestCase = defineCase('team.mate', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 10, nightly: 20 });
  const stocks = 2;
  const ak = pairedJobs({ stocks, frameCap: 10800, a: GOD, b: ui(9), extras: [{ ref: ui(9), team: 0 }], probe: 'basic' },
    pairTag(GOD, ui(9), 'ak'), n);
  const rsAk = runBatch(ak);
  const sAk = sideOf(rsAk, 0, stocks);
  const s2 = sideOf(runBatch(twoVsTwoJobs(twoVsTwoN(tier), stocksFor(tier))), 0, stocksFor(tier));
  const swings = sAk.mateSwings + s2.mateSwings;
  return gate('team.mate', swings === 0,
    `god+UI9 vs UI9: team won ${sAk.wins}/${sAk.n}, swings at a teammate ${sAk.mateSwings}/${sAk.mateStarts}; ` +
    `2v2 UI7 x ${s2.n}: ${s2.mateSwings}/${s2.mateStarts} (no friendly fire in the sim, so wasted swings are gated at 0)`,
    { swings, akWins: sAk.wins, akN: sAk.n }, false);
});

/** Four players on distinct teams. */
function ffaJobs(first: BrainRef, rest: BrainRef, n: number, tag: string, record: boolean): JobSpec[] {
  return pairedJobs({ stocks: 2, frameCap: 10800, a: first, b: rest, extras: [{ ref: rest, team: 2 }, { ref: rest, team: 3 }],
    record, probe: record ? 'track' : 'basic' }, pairTag(first, rest, tag), n);
}

const EXPOSED = TF.stun | TF.vulnerable | TF.grabbed;

/**
 * Exposure of `v` to `a` on frame `f`: 2 when stunned, helpless, landing, downed or grabbed; 1 when
 * inside a's threat range (1.2 x ground reach, 80 px vertically); 0 otherwise or when not attackable.
 */
function exposure(r: JobResult, f: number, a: number, v: number, range: number): number {
  const t = r.probe?.track;
  if (t === undefined || t === null || f < 0 || f >= t.frames) return 0;
  const n = r.probe!.players;
  const kv = f * n + v; const ka = f * n + a;
  const fl = t.flags[kv];
  if ((fl & TF.dead) !== 0 || t.inv[kv] === 1) return 0;
  if ((fl & EXPOSED) !== 0) return 2;
  return Math.abs(t.x[kv] - t.x[ka]) <= range && Math.abs(t.y[kv] - t.y[ka]) <= 80 ? 1 : 0;
}

const ffaFocus: TestCase = defineCase('ffa.focus', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 3, full: 20, nightly: 40 });
  const l7 = ui(7);
  const range = 1.2 * groundReach();
  const rs = runBatch(ffaJobs(l7, l7, n, 'ffa7', true));
  const top = [0, 0, 0, 0]; const contested = [0, 0, 0, 0]; const all = [0, 0, 0, 0];
  for (const r of rs) {
    const ev = r.result.events ?? [];
    const ops = openingsOf(ev.slice().sort((x, y) => x.frame - y.frame), 4, r.result.frames);
    const per: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (const o of ops) {
      if (o.attacker < 0 || o.attacker > 3 || o.victim < 0 || o.victim > 3) continue;
      all[o.attacker]++;
      const ev0 = exposure(r, o.frame - 1, o.attacker, o.victim, range);
      let more = false;
      for (let w = 0; w < 4; w++) {
        if (w === o.attacker || w === o.victim) continue;
        if (exposure(r, o.frame - 1, o.attacker, w, range) > ev0) more = true;
      }
      if (more) per[o.attacker][o.victim]++;
    }
    for (let p = 0; p < 4; p++) {
      const tot = per[p].reduce((a, b) => a + b, 0);
      contested[p] += tot;
      top[p] += Math.max(...per[p]);
    }
  }
  const rows: string[] = [];
  const fails: string[] = [];
  const metrics: Record<string, number> = {};
  for (let p = 0; p < 4; p++) {
    const share = contested[p] > 0 ? top[p] / contested[p] : 0;
    metrics[`p${p}.share`] = share; metrics[`p${p}.contested`] = contested[p];
    rows.push(`P${p} ${f2(share)} of ${contested[p]} contested (${all[p]} openings)`);
    if (contested[p] >= FFA_FOCUS_MIN_N && share > FFA_FOCUS_MAX) fails.push(`P${p} ${f2(share)} > ${FFA_FOCUS_MAX}`);
  }
  return gate('ffa.focus', fails.length === 0,
    `4 x UI7 free-for-all x ${n}: top-victim share of openings made while a more exposed opponent existed: ${rows.join(', ')}` +
    ` (gated from ${FFA_FOCUS_MIN_N} contested)${fails.length > 0 ? ` | FAIL: ${listed(fails)}` : ''}`, metrics, tier === 'fast');
});

const ffaGod: TestCase = defineCase('ffa.god', ['fast', 'full', 'nightly'], ({ tier }) => {
  const n = byTier(tier, { fast: 2, full: 20, nightly: 40 });
  const rs = runBatch(ffaJobs(GOD, ui(7), n, 'ffagod', true));
  const kos = [0, 0, 0, 0];
  let lastStanding = 0;
  for (const r of rs) {
    for (const e of r.result.events ?? []) {
      if (e.kind !== 'ko') continue;
      const by = num(e, 'by', -1);
      if (by >= 0 && by < 4 && by !== e.slot) kos[by]++;
    }
    if (teamOutcome(r.result, teamsOf(r.job), r.job.stocks) === 0) lastStanding++;
  }
  const most = kos[0] > Math.max(kos[1], kos[2], kos[3]);
  return gate('ffa.god', most,
    `god + 3 x UI7 free-for-all x ${n}: stocks taken god ${kos[0]}, others ${kos.slice(1).join('/')}; god last standing ${wl(lastStanding, n)}`,
    { godKos: kos[0], maxOther: Math.max(kos[1], kos[2], kos[3]), lastStanding }, tier === 'fast');
});

export const TEAM_CASES: readonly TestCase[] = [
  oneVsThree('team.1v3.l4', [ui(4), ui(4), ui(4)]),
  oneVsThree('team.1v3.l1to3', [ui(1), ui(2), ui(3)]),
  oneVsTwo, twoVsTwo, mate, ffaFocus, ffaGod,
];
