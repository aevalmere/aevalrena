import type { CharacterDef, InputAction, MoveDef, MoveId } from '../core/types';
import { BURST_ONLY } from '../core/types';
import { CHARACTER_DEFS } from '../characters/registry';
import { grabKitOf } from '../characters/common/grabkit';
import { prettyKey, type MenuCtx } from './context';

/** Move list (UI_STYLE.md section 4.6): MOVE | INPUT | DAMAGE for the current character. */

type Source =
  | { kind: 'move'; id: MoveId }
  | { kind: 'grab' }
  | { kind: 'pummel' }
  | { kind: 'throw'; id: 'fthrow' | 'bthrow' | 'uthrow' | 'dthrow' }
  | { kind: 'final' };

interface Row {
  name: string;
  input: string;
  /** Binding whose P1 shortcut chord is shown next to the input, when bound. */
  bind?: InputAction;
  source: Source;
}

const ROWS: Row[] = [
  { name: 'Neutral Attack', input: 'Attack', bind: 'jab', source: { kind: 'move', id: 'jab' } },
  { name: 'Forward Tilt', input: 'Side + Attack', bind: 'ftilt', source: { kind: 'move', id: 'ftilt' } },
  { name: 'Up Tilt', input: 'Walk + Up + Attack', bind: 'utilt', source: { kind: 'move', id: 'utilt' } },
  { name: 'Down Tilt', input: 'Down + Attack', bind: 'dtilt', source: { kind: 'move', id: 'dtilt' } },
  { name: 'Dash Attack', input: 'Dash + Attack', bind: 'dashatk', source: { kind: 'move', id: 'dashatk' } },
  { name: 'Forward Smash', input: 'Flick Side + Attack', bind: 'fsmash', source: { kind: 'move', id: 'fsmash' } },
  { name: 'Up Smash', input: 'Flick Up + Attack', bind: 'usmash', source: { kind: 'move', id: 'usmash' } },
  { name: 'Down Smash', input: 'Flick Down + Attack', bind: 'dsmash', source: { kind: 'move', id: 'dsmash' } },
  { name: 'Neutral Air', input: 'Air + Attack', bind: 'nair', source: { kind: 'move', id: 'nair' } },
  { name: 'Forward Air', input: 'Air + Side + Attack', bind: 'fair', source: { kind: 'move', id: 'fair' } },
  { name: 'Back Air', input: 'Air + Back + Attack', bind: 'bair', source: { kind: 'move', id: 'bair' } },
  { name: 'Up Air', input: 'Air + Up + Attack', bind: 'uair', source: { kind: 'move', id: 'uair' } },
  { name: 'Down Air', input: 'Air + Down + Attack', bind: 'dair', source: { kind: 'move', id: 'dair' } },
  { name: 'Neutral Special', input: 'Special', bind: 'nspecial', source: { kind: 'move', id: 'nspecial' } },
  { name: 'Side Special', input: 'Side + Special', bind: 'sspecial', source: { kind: 'move', id: 'sspecial' } },
  { name: 'Up Special', input: 'Up + Special', bind: 'uspecial', source: { kind: 'move', id: 'uspecial' } },
  { name: 'Down Special', input: 'Down + Special', bind: 'dspecial', source: { kind: 'move', id: 'dspecial' } },
  { name: 'Grab', input: 'Shield + Attack or Grab', source: { kind: 'grab' } },
  { name: 'Pummel', input: 'Attack while holding', bind: 'pummel', source: { kind: 'pummel' } },
  { name: 'Forward Throw', input: 'Side while holding', bind: 'fthrow', source: { kind: 'throw', id: 'fthrow' } },
  { name: 'Back Throw', input: 'Back while holding', bind: 'bthrow', source: { kind: 'throw', id: 'bthrow' } },
  { name: 'Up Throw', input: 'Up while holding', bind: 'uthrow', source: { kind: 'throw', id: 'uthrow' } },
  { name: 'Down Throw', input: 'Down while holding', bind: 'dthrow', source: { kind: 'throw', id: 'dthrow' } },
  // Final Smash is disabled this wave (owner request): no shortcut chord shown.
  { name: 'Final Smash', input: 'Unavailable', source: { kind: 'final' } },
];

const MAX_HITS_SHOWN = 3;

function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}

/**
 * Damage of each separate hit: hitboxes sharing a group are one hit (sweet and sour spots,
 * both sides of a down smash), so the first hitbox of each group by start frame counts.
 * A move with no hitboxes falls back to its first projectile that fires from the timeline.
 */
function moveHits(move: MoveDef): number[] {
  if (move.hitboxes.length > 0) {
    const firstPerGroup = new Map<number, { start: number; damage: number }>();
    for (const hb of move.hitboxes) {
      const prev = firstPerGroup.get(hb.group);
      if (!prev || hb.start < prev.start) firstPerGroup.set(hb.group, { start: hb.start, damage: hb.damage });
    }
    return [...firstPerGroup.values()].sort((a, b) => a.start - b.start).map((h) => h.damage);
  }
  const proj = move.projectiles?.find((p) => p.spawnFrame !== BURST_ONLY);
  return proj ? [proj.damage] : [];
}

function formatHits(hits: number[]): string {
  if (hits.length === 0) return '-';
  const shown = hits.slice(0, MAX_HITS_SHOWN).map(pct).join(' + ');
  return hits.length > MAX_HITS_SHOWN ? `${shown} + ...` : shown;
}

function damageText(def: CharacterDef | undefined, source: Source): string {
  if (!def) return '-';
  switch (source.kind) {
    case 'move': {
      const move = def.moves[source.id];
      return move ? formatHits(moveHits(move)) : '-';
    }
    case 'grab':
      return '-';
    case 'pummel':
      return pct(grabKitOf(def).pummel.damage);
    case 'throw':
      return pct(grabKitOf(def).throws[source.id].damage);
    case 'final': {
      const fs = def.finalSmash;
      if (!fs) return '-';
      let total = 0;
      for (const h of fs.hits) total += h.damage;
      if (fs.launch.damage !== undefined) total += fs.launch.damage;
      return pct(total);
    }
  }
}

export const CSS = `
.aev-movelist-panel {
  width: min(94vw, 54rem);
  padding: 1.3rem 1.6rem 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.aev-movelist-head {
  display: flex;
  align-items: baseline;
  gap: 1.2rem;
}
.aev-movelist-char {
  font-family: var(--font-display);
  font-size: 1.35rem;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--text);
  text-shadow: var(--glow);
}
.aev-movelist-scroll {
  max-height: 62vh;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--accent) 45%, transparent) transparent;
}
.aev-movelist-scroll .ui-table th {
  position: sticky;
  top: 0;
  background: var(--panel);
  z-index: 1;
}
.aev-movelist-scroll .ui-table td {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.78rem;
}
.aev-movelist-scroll .ui-table td:first-child { color: var(--accent); white-space: nowrap; }
.aev-movelist-scroll .ui-table td:last-child,
.aev-movelist-scroll .ui-table th:last-child { text-align: right; white-space: nowrap; }
.aev-movelist-scroll .ui-table tr.aev-movelist-group td { border-top: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); }
.aev-movelist-chord { margin-left: 0.8rem; }
.aev-movelist-panel .ui-btn { align-self: flex-start; }
`;

/** P1's character: slot 0 when it is human, else the first human slot, else the first character. */
function currentCharacter(ctx: MenuCtx): { id: string; name: string } | undefined {
  const slots = ctx.state.slots;
  const human = slots[0]?.mode === 'human' ? slots[0] : slots.find((s) => s.mode === 'human');
  if (human) {
    const found = ctx.deps.characters.find((c) => c.id === human.charId);
    if (found) return found;
  }
  return ctx.deps.characters[0];
}

/** Row names that start a new section (smashes, aerials, specials, grab, final smash). */
const GROUP_STARTS = new Set(['Forward Smash', 'Neutral Air', 'Neutral Special', 'Grab', 'Final Smash']);

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const returnTo = ctx.state.movelistReturnTo;
  if (returnTo === 'pause') container.classList.add('aev-screen-movelist-over');

  const panel = document.createElement('div');
  panel.className = 'ui-frame aev-movelist-panel';
  container.appendChild(panel);

  const head = document.createElement('div');
  head.className = 'aev-movelist-head';
  const header = document.createElement('h1');
  header.className = 'ui-header';
  const spark = document.createElement('span');
  spark.className = 'ui-spark';
  header.appendChild(spark);
  header.appendChild(document.createTextNode('Move list'));
  head.appendChild(header);
  panel.appendChild(head);

  const character = currentCharacter(ctx);
  const def = character ? CHARACTER_DEFS[character.id] : undefined;

  const charLine = document.createElement('div');
  charLine.className = 'aev-movelist-head';
  const charName = document.createElement('span');
  charName.className = 'aev-movelist-char';
  charName.textContent = character?.name ?? '';
  charLine.appendChild(charName);
  const tag = document.createElement('span');
  tag.className = 'ui-tag';
  tag.textContent = 'P1';
  charLine.appendChild(tag);
  panel.appendChild(charLine);

  const rule = document.createElement('div');
  rule.className = 'ui-rule';
  panel.appendChild(rule);

  const scroll = document.createElement('div');
  scroll.className = 'aev-movelist-scroll';
  const table = document.createElement('table');
  table.className = 'ui-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Move', 'Input', 'Damage']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const keys = ctx.deps.input.controls.players[0]?.keys;
  const tbody = document.createElement('tbody');
  for (const row of ROWS) {
    const tr = document.createElement('tr');
    if (GROUP_STARTS.has(row.name)) tr.className = 'aev-movelist-group';

    const nameTd = document.createElement('td');
    nameTd.textContent = row.name;
    tr.appendChild(nameTd);

    const inputTd = document.createElement('td');
    inputTd.appendChild(document.createTextNode(row.input));
    const chord = row.bind && keys ? keys[row.bind]?.[0] ?? '' : '';
    if (chord !== '') {
      const chordTag = document.createElement('span');
      chordTag.className = 'ui-tag aev-movelist-chord';
      chordTag.textContent = prettyKey(chord);
      inputTd.appendChild(chordTag);
    }
    tr.appendChild(inputTd);

    const dmgTd = document.createElement('td');
    dmgTd.textContent = damageText(def, row.source);
    tr.appendChild(dmgTd);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  panel.appendChild(scroll);

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'ui-btn ui-btn-selected';
  back.textContent = 'Back';
  panel.appendChild(back);

  const leave = (): void => ctx.go(ctx.state.movelistReturnTo);
  ctx.addListener(back, 'click', leave);
  ctx.addListener(window, 'keydown', (e: Event) => {
    const ev = e as KeyboardEvent;
    if (ev.code === 'Escape' || ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.code === 'Space') {
      ev.preventDefault();
      leave();
    } else if (ev.code === 'ArrowDown' || ev.code === 'ArrowUp' || ev.code === 'KeyS' || ev.code === 'KeyW') {
      ev.preventDefault();
      const dir = ev.code === 'ArrowDown' || ev.code === 'KeyS' ? 1 : -1;
      scroll.scrollBy({ top: dir * 60 });
    }
  });
}
