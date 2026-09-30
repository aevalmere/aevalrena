/**
 * Every harness case in one list (contract 4.5: eval/cases/index.ts exports TEST_CASES). Order is
 * the print order of main.ts; ids are unique.
 */
import type { TestCase } from '../../contracts';
import { ADVERSARY_CASES } from './adversaries';
import { CHARACTER_CASES } from './character';
import { DETERMINISM_CASES } from './determinism';
import { HUMAN_CASES } from './human';
import { KILL_CASES } from './kill';
import { LADDER_CASES } from './ladder';
import { LEGACY_CASES } from './legacy';
import { PERF_CASES } from './perf';
import { PROPERTY_CASES } from './props';
import { STRENGTH_CASES } from './strength';
import { STYLE_CASES } from './style';
import { TEAM_CASES } from './teams';
import { TREKMORE_CASES } from './trekmore';

/** Case groups by file, for the report and `--only <group>`. */
export const CASE_GROUPS: Readonly<Record<string, readonly TestCase[]>> = {
  legacy: LEGACY_CASES,
  determinism: DETERMINISM_CASES,
  perf: PERF_CASES,
  strength: STRENGTH_CASES,
  ladder: LADDER_CASES,
  style: STYLE_CASES,
  human: HUMAN_CASES,
  adversaries: ADVERSARY_CASES,
  kill: KILL_CASES,
  props: PROPERTY_CASES,
  character: CHARACTER_CASES,
  teams: TEAM_CASES,
  trekmore: TREKMORE_CASES,
};

export const TEST_CASES: readonly TestCase[] = Object.values(CASE_GROUPS).flat();

/**
 * Cases the god tier runs at the guide's counts (n 73 where a case has a nightly count): the god's
 * own strength, adversary and team gates, plus determinism and cost.
 */
export const GOD_CASE_IDS: readonly string[] = [
  'bb', 'bb.order', 'perf', 'perf.4p', 'av', 'az.god', 'ba',
  'team.1v3.l4', 'team.1v3.l1to3', 'team.1v2.l5', 'team.mate', 'ffa.god',
  'trek.mirror', 'trek.vs.aeval.l10', 'trek.1v3.l4',
];
