import type { BindDevice, InputAction } from '../core/types';
import { MAX_PLAYERS } from '../core/types';
import { prettyKey, prettyPad, type MenuCtx } from './context';
import { accentVars } from './theme';

/** Controls screen (docs/UI_STYLE.md section 4.4). The panel's --accent follows the active tab. */
export const CSS = `
.aev-screen-controls .ctl-panel {
  width: min(1000px, 94vw);
  height: min(92vh, 900px);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1.3rem 1.8rem 1rem;
}
.ctl-panel .ui-header { display: flex; align-items: center; }
.ctl-tabs {
  display: flex;
  gap: 0.6rem;
  padding: 3px 4px;
  outline: 1px solid transparent;
  outline-offset: 2px;
  transition: outline-color 120ms ease-out;
}
.ctl-tabs.ctl-tabs-selected { outline-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.ctl-tab { --chamfer: 7px; padding: 0.35rem 1.1rem; font-size: 0.8rem; }
.ctl-option { justify-content: space-between; font-size: 0.9rem; padding-top: 0.3rem; padding-bottom: 0.3rem; }
.ctl-option .ui-tag { font-size: 0.75rem; }
.ctl-option.ui-item-selected .ui-tag { color: var(--accent); text-shadow: var(--glow); }
.ctl-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  border-top: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  scrollbar-color: color-mix(in srgb, var(--accent) 50%, transparent) transparent;
  scrollbar-width: thin;
}
.ctl-table { table-layout: fixed; }
.ctl-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--accent) 8%, var(--panel));
}
.ctl-table th:first-child { width: 32%; }
.ctl-table td { padding: 0.3rem 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.8rem; }
.ctl-table td.ctl-cell { overflow: hidden; text-overflow: ellipsis; }
.ctl-table tr.ctl-section td {
  padding-top: 0.8rem;
  font-weight: 700;
  font-size: 0.72rem;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--accent);
  text-shadow: var(--glow);
  border-bottom-color: color-mix(in srgb, var(--accent) 50%, transparent);
}
.ctl-table tr.ctl-note td {
  text-transform: none;
  letter-spacing: 0.02em;
  font-size: 0.7rem;
  line-height: 1.5;
  color: color-mix(in srgb, var(--text) 50%, transparent);
}
.ctl-table tr.ctl-row-selected td { background: color-mix(in srgb, var(--accent) 9%, transparent); }
.ctl-table tr.ctl-row-selected td:first-child { color: var(--accent); }
.ctl-table td.ctl-cell { cursor: pointer; white-space: nowrap; }
.ctl-table td.ctl-cell:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.ctl-table td.ctl-cell.ctl-cell-selected {
  outline: var(--line) solid var(--accent);
  outline-offset: -3px;
  color: var(--accent);
}
.ctl-table td.ctl-cell.ctl-conflict { color: #ff7f7f; }
.ctl-table td.ctl-cell.ctl-listening {
  color: #ffffff;
  background: color-mix(in srgb, var(--accent) 25%, transparent);
  font-size: 0.62rem;
  letter-spacing: 0.04em;
  white-space: normal;
}
.ctl-buttons { display: flex; gap: 0.8rem; }
.ctl-hint { margin: 0; opacity: 0.6; white-space: normal; line-height: 1.6; font-size: 0.62rem; }
`;

type TableRowDef =
  | { kind: 'section'; label: string }
  | { kind: 'note'; text: string }
  | { kind: 'bind'; action: InputAction; label: string };

/** Binding table contents, top to bottom. Section and note rows are not selectable. */
const TABLE_ROWS: TableRowDef[] = [
  { kind: 'section', label: 'Movement' },
  { kind: 'bind', action: 'left', label: 'Left' },
  { kind: 'bind', action: 'right', label: 'Right' },
  { kind: 'bind', action: 'up', label: 'Up' },
  { kind: 'bind', action: 'down', label: 'Down' },
  { kind: 'bind', action: 'walk', label: 'Walk (hold)' },
  { kind: 'bind', action: 'jump', label: 'Jump' },
  {
    kind: 'note',
    text: 'Up also jumps (tap jump). Hold Walk to tilt: Walk + Up + Attack is an up tilt. '
      + 'Double-tap left or right to roll, double-tap down to spot dodge.',
  },
  { kind: 'section', label: 'Buttons' },
  { kind: 'bind', action: 'attack', label: 'Attack' },
  { kind: 'bind', action: 'special', label: 'Special' },
  { kind: 'bind', action: 'shield', label: 'Shield' },
  { kind: 'bind', action: 'grab', label: 'Grab' },
  { kind: 'bind', action: 'dodge', label: 'Dodge' },
  { kind: 'bind', action: 'taunt', label: 'Taunt' },
  { kind: 'bind', action: 'start', label: 'Start / Pause' },
  {
    kind: 'note',
    text: 'Direction + Attack picks the move like Smash: flick + Attack smashes, Walk + Attack tilts, '
      + 'Attack while running is a dash attack, Shield + Attack grabs. Shield only shields; in the air it air dodges.',
  },
  { kind: 'section', label: 'Smash stick' },
  { kind: 'bind', action: 'cUp', label: 'Smash Up' },
  { kind: 'bind', action: 'cDown', label: 'Smash Down' },
  { kind: 'bind', action: 'cLeft', label: 'Smash Left' },
  { kind: 'bind', action: 'cRight', label: 'Smash Right' },
  { kind: 'section', label: 'Shortcuts (optional)' },
  {
    kind: 'note',
    text: 'Hold one key and press another to bind a chord. Defaults: F + J forward smash, F + W up smash, '
      + 'F + S down smash, G + J forward tilt, G + W up tilt, G + S down tilt. '
      + 'In the air a smash or tilt shortcut does the matching aerial.',
  },
  // The full moveset in the owner's order. Context commands (pummel, ledge
  // options, tech...) only act in their context; elsewhere the press is ignored.
  { kind: 'bind', action: 'jab', label: 'Neutral Attack' },
  { kind: 'bind', action: 'ftilt', label: 'Forward Tilt' },
  { kind: 'bind', action: 'utilt', label: 'Up Tilt' },
  { kind: 'bind', action: 'dtilt', label: 'Down Tilt' },
  { kind: 'bind', action: 'dashatk', label: 'Dash Attack' },
  { kind: 'bind', action: 'fsmash', label: 'Forward Smash' },
  { kind: 'bind', action: 'usmash', label: 'Up Smash' },
  { kind: 'bind', action: 'dsmash', label: 'Down Smash' },
  { kind: 'bind', action: 'nair', label: 'Neutral Air' },
  { kind: 'bind', action: 'fair', label: 'Forward Air' },
  { kind: 'bind', action: 'bair', label: 'Back Air' },
  { kind: 'bind', action: 'uair', label: 'Up Air' },
  { kind: 'bind', action: 'dair', label: 'Down Air' },
  { kind: 'bind', action: 'nspecial', label: 'Neutral Special' },
  { kind: 'bind', action: 'sspecial', label: 'Side Special' },
  { kind: 'bind', action: 'uspecial', label: 'Up Special' },
  { kind: 'bind', action: 'dspecial', label: 'Down Special' },
  { kind: 'bind', action: 'pummel', label: 'Pummel' },
  { kind: 'bind', action: 'fthrow', label: 'Forward Throw' },
  { kind: 'bind', action: 'bthrow', label: 'Back Throw' },
  { kind: 'bind', action: 'uthrow', label: 'Up Throw' },
  { kind: 'bind', action: 'dthrow', label: 'Down Throw' },
  { kind: 'bind', action: 'spotDodge', label: 'Spot Dodge' },
  { kind: 'bind', action: 'rollForward', label: 'Forward Roll' },
  { kind: 'bind', action: 'rollBack', label: 'Backward Roll' },
  { kind: 'bind', action: 'airDodge', label: 'Air Dodge' },
  { kind: 'bind', action: 'dirAirDodge', label: 'Directional Air Dodge' },
  { kind: 'bind', action: 'ledgeAttack', label: 'Ledge Attack' },
  { kind: 'bind', action: 'ledgeRoll', label: 'Ledge Roll' },
  { kind: 'bind', action: 'ledgeGetUp', label: 'Ledge Get-Up' },
  { kind: 'bind', action: 'ledgeJump', label: 'Ledge Jump' },
  { kind: 'bind', action: 'getupAttack', label: 'Get-Up Attack' },
  { kind: 'bind', action: 'tech', label: 'Tech' },
  { kind: 'bind', action: 'footstool', label: 'Footstool' },
  { kind: 'bind', action: 'finalSmash', label: 'Final Smash' },
  { kind: 'bind', action: 'taunt2', label: 'Taunt 2' },
  { kind: 'bind', action: 'taunt3', label: 'Taunt 3' },
];

/** The four binding cells of a table row, left to right. */
const CELL_COLUMNS: { device: BindDevice; slot: 0 | 1 }[] = [
  { device: 'keys', slot: 0 },
  { device: 'keys', slot: 1 },
  { device: 'pad', slot: 0 },
  { device: 'pad', slot: 1 },
];

interface BindCellRef {
  action: InputAction;
  device: BindDevice;
  slot: 0 | 1;
  cell: HTMLElement;
}

/**
 * A row the cursor can land on. Binding rows carry their four cells; every other
 * row handles Left/Right and Enter itself.
 */
interface NavEntry {
  el: HTMLElement;
  cells: BindCellRef[] | null;
  step?(dir: -1 | 1): void;
  activate?(): void;
  highlight?(on: boolean): void;
}

const PAD_ID_CHARS = 24;

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const { deps, state } = ctx;
  const input = deps.input;

  const panel = document.createElement('div');
  panel.className = 'ui-frame ctl-panel';
  panel.setAttribute('style', accentVars(0));
  container.appendChild(panel);

  const heading = document.createElement('h1');
  heading.className = 'ui-header';
  const spark = document.createElement('span');
  spark.className = 'ui-spark';
  heading.appendChild(spark);
  heading.appendChild(document.createTextNode('Controls'));
  panel.appendChild(heading);

  const tabs = document.createElement('div');
  tabs.className = 'ctl-tabs';
  panel.appendChild(tabs);

  const tabButtons: HTMLButtonElement[] = [];
  for (let p = 0; p < MAX_PLAYERS; p += 1) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'ui-btn ctl-tab';
    tab.setAttribute('style', accentVars(p));
    tab.textContent = `P${p + 1}`;
    tabs.appendChild(tab);
    tabButtons.push(tab);
  }

  function optionRow(label: string): { row: HTMLElement; value: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'ui-item ctl-option';
    const name = document.createElement('span');
    name.textContent = label;
    row.appendChild(name);
    const value = document.createElement('span');
    value.className = 'ui-tag';
    row.appendChild(value);
    panel.appendChild(row);
    return { row, value };
  }

  const controllerOpt = optionRow('Controller');
  const tapOpt = optionRow('Tap jump');

  const scroll = document.createElement('div');
  scroll.className = 'ctl-scroll';
  panel.appendChild(scroll);
  const table = document.createElement('table');
  table.className = 'ui-table ctl-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Action</th><th>Key 1</th><th>Key 2</th><th>Pad 1</th><th>Pad 2</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  scroll.appendChild(table);

  const buttonRow = document.createElement('div');
  buttonRow.className = 'ctl-buttons';
  panel.appendChild(buttonRow);
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'ui-btn';
  buttonRow.appendChild(resetBtn);
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'ui-btn';
  backBtn.textContent = 'Back';
  buttonRow.appendChild(backBtn);

  const hint = document.createElement('p');
  hint.className = 'ui-tag ctl-hint';
  hint.textContent = 'Click a cell or press Enter to rebind. Hold keys and release to bind a chord. Backspace clears. Esc cancels.';
  panel.appendChild(hint);

  let activePlayer = 0;
  let selected = 0;
  /** Column among CELL_COLUMNS, kept while moving between binding rows. */
  let selectedCol = 0;
  /** 0 = Reset, 1 = Back, on the button row. */
  let selectedButton = 0;
  let capturing = false;
  let disposed = false;

  const bindCells: BindCellRef[] = [];
  const entries: NavEntry[] = [];

  function goBack(): void {
    ctx.go(state.controlsReturnTo);
  }

  /** The connected pad this player's bindings currently read from, if any. */
  function resolvedPad(): { index: number; id: string } | undefined {
    const pads = input.connectedPads();
    const padIndex = input.controls.players[activePlayer]?.padIndex ?? -1;
    return padIndex >= 0 ? pads.find((p) => p.index === padIndex) : pads[activePlayer];
  }

  function bindingText(ref: BindCellRef, padId: string | undefined): string {
    const code = input.controls.players[activePlayer]?.[ref.device]?.[ref.action]?.[ref.slot] ?? '';
    return ref.device === 'keys' ? prettyKey(code) : prettyPad(code, padId);
  }

  function refreshCells(): void {
    const padId = resolvedPad()?.id;
    for (const ref of bindCells) {
      if (ref.cell.classList.contains('ctl-listening')) continue;
      ref.cell.textContent = bindingText(ref, padId);
    }
  }

  function refreshConflicts(): void {
    for (const ref of bindCells) ref.cell.classList.remove('ctl-conflict');
    for (const c of input.conflicts()) {
      if (c.player !== activePlayer) continue;
      const ref = bindCells.find((r) => r.device === c.device && r.action === c.action && r.slot === c.slot);
      ref?.cell.classList.add('ctl-conflict');
    }
  }

  function refreshOptions(): void {
    const padIndex = input.controls.players[activePlayer]?.padIndex ?? -1;
    if (padIndex < 0) {
      controllerOpt.value.textContent = 'Auto';
    } else {
      const pad = input.connectedPads().find((p) => p.index === padIndex);
      controllerOpt.value.textContent = pad
        ? `Pad ${pad.index + 1}: ${pad.id.slice(0, PAD_ID_CHARS)}`
        : `Pad ${padIndex + 1}: not connected`;
    }
    tapOpt.value.textContent = input.controls.players[activePlayer]?.tapJump ? 'On' : 'Off';
  }

  function refreshAll(): void {
    panel.setAttribute('style', accentVars(activePlayer));
    tabButtons.forEach((btn, i) => btn.classList.toggle('ui-btn-selected', i === activePlayer));
    resetBtn.textContent = `Reset P${activePlayer + 1}`;
    refreshOptions();
    refreshCells();
    refreshConflicts();
  }

  function updateSelection(): void {
    entries.forEach((entry, i) => {
      const on = i === selected;
      if (entry.cells) {
        entry.el.classList.toggle('ctl-row-selected', on);
        entry.cells.forEach((ref, c) => ref.cell.classList.toggle('ctl-cell-selected', on && c === selectedCol));
      } else if (entry.highlight) {
        entry.highlight(on);
      } else {
        entry.el.classList.toggle('ui-item-selected', on);
      }
    });
    entries[selected]?.el.scrollIntoView({ block: 'nearest' });
  }

  function applyBinding(ref: BindCellRef, code: string): void {
    input.setBinding(activePlayer, ref.device, ref.action, ref.slot, code);
    input.save();
    ref.cell.textContent = bindingText(ref, resolvedPad()?.id);
    refreshConflicts();
  }

  async function beginCapture(ref: BindCellRef): Promise<void> {
    if (capturing) return;
    capturing = true;
    const original = ref.cell.textContent ?? '';
    ref.cell.textContent = ref.device === 'keys' ? 'press keys, release to bind' : 'press buttons, release to bind';
    ref.cell.classList.add('ctl-listening');
    try {
      const code = ref.device === 'keys'
        ? await input.listenForNextKey()
        : await input.listenForNextPad(resolvedPad()?.index ?? -1);
      if (disposed) return;
      ref.cell.classList.remove('ctl-listening');
      applyBinding(ref, code);
    } catch {
      if (!disposed) ref.cell.textContent = original;
    } finally {
      ref.cell.classList.remove('ctl-listening');
      capturing = false;
    }
  }

  function switchPlayer(p: number): void {
    if (capturing) return;
    activePlayer = p;
    refreshAll();
  }

  function cyclePad(dir: -1 | 1): void {
    const current = input.controls.players[activePlayer]?.padIndex ?? -1;
    const options = [-1, ...input.connectedPads().map((p) => p.index)];
    const pos = Math.max(0, options.indexOf(current));
    input.setPadIndex(activePlayer, options[(pos + dir + options.length) % options.length]);
    input.save();
    refreshOptions();
    refreshCells();
  }

  function toggleTapJump(): void {
    const current = input.controls.players[activePlayer]?.tapJump ?? false;
    input.setTapJump(activePlayer, !current);
    input.save();
    refreshOptions();
  }

  function resetPlayer(): void {
    if (capturing) return;
    input.resetDefaults(activePlayer);
    input.save();
    refreshAll();
  }

  // ---- Navigation entries, in screen order ----

  entries.push({
    el: tabs,
    cells: null,
    step: (dir) => switchPlayer((activePlayer + dir + MAX_PLAYERS) % MAX_PLAYERS),
    activate: () => switchPlayer((activePlayer + 1) % MAX_PLAYERS),
    highlight: (on) => tabs.classList.toggle('ctl-tabs-selected', on),
  });
  entries.push({ el: controllerOpt.row, cells: null, step: cyclePad, activate: () => cyclePad(1) });
  entries.push({ el: tapOpt.row, cells: null, step: toggleTapJump, activate: toggleTapJump });

  for (const def of TABLE_ROWS) {
    const row = document.createElement('tr');
    tbody.appendChild(row);
    if (def.kind !== 'bind') {
      row.className = def.kind === 'section' ? 'ctl-section' : 'ctl-note';
      const td = document.createElement('td');
      td.colSpan = CELL_COLUMNS.length + 1;
      td.textContent = def.kind === 'section' ? def.label : def.text;
      row.appendChild(td);
      continue;
    }

    const nameCell = document.createElement('td');
    nameCell.textContent = def.label;
    row.appendChild(nameCell);

    const entryIndex = entries.length;
    const cells: BindCellRef[] = [];
    CELL_COLUMNS.forEach((col, colIndex) => {
      const cell = document.createElement('td');
      cell.className = 'ctl-cell';
      const ref: BindCellRef = { action: def.action, device: col.device, slot: col.slot, cell };
      ctx.addListener(cell, 'click', () => {
        if (capturing) return;
        selected = entryIndex;
        selectedCol = colIndex;
        updateSelection();
        void beginCapture(ref);
      });
      row.appendChild(cell);
      cells.push(ref);
      bindCells.push(ref);
    });
    entries.push({ el: row, cells });
  }

  const firstBindEntry = entries.findIndex((e) => e.cells !== null);

  entries.push({
    el: buttonRow,
    cells: null,
    step: () => {
      selectedButton = selectedButton === 0 ? 1 : 0;
      updateSelection();
    },
    activate: () => {
      if (selectedButton === 0) resetPlayer();
      else goBack();
    },
    highlight: (on) => {
      resetBtn.classList.toggle('ui-btn-selected', on && selectedButton === 0);
      backBtn.classList.toggle('ui-btn-selected', on && selectedButton === 1);
    },
  });

  // ---- Listeners ----

  tabButtons.forEach((btn, i) => {
    ctx.addListener(btn, 'click', () => switchPlayer(i));
  });
  ctx.addListener(controllerOpt.row, 'click', () => cyclePad(1));
  ctx.addListener(tapOpt.row, 'click', () => toggleTapJump());
  ctx.addListener(resetBtn, 'click', () => resetPlayer());
  ctx.addListener(backBtn, 'click', () => goBack());

  const onPadsChanged = (): void => {
    refreshOptions();
    refreshCells();
  };
  ctx.addListener(window, 'gamepadconnected', onPadsChanged);
  ctx.addListener(window, 'gamepaddisconnected', onPadsChanged);

  ctx.addListener(window, 'keydown', (e: Event) => {
    if (capturing) return;
    const ev = e as KeyboardEvent;
    const entry = entries[selected];
    if (!entry) return;
    switch (ev.code) {
      case 'ArrowUp':
      case 'ArrowDown':
        ev.preventDefault();
        selected = (selected + (ev.code === 'ArrowUp' ? -1 : 1) + entries.length) % entries.length;
        updateSelection();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        ev.preventDefault();
        const dir = ev.code === 'ArrowLeft' ? -1 : 1;
        if (entry.cells) {
          selectedCol = (selectedCol + dir + CELL_COLUMNS.length) % CELL_COLUMNS.length;
          updateSelection();
        } else {
          entry.step?.(dir);
        }
        break;
      }
      case 'Enter':
      case 'Space':
        ev.preventDefault();
        if (entry.cells) {
          const ref = entry.cells[selectedCol];
          if (ref) void beginCapture(ref);
        } else {
          entry.activate?.();
        }
        break;
      case 'Backspace':
      case 'Delete':
        if (entry.cells) {
          ev.preventDefault();
          const ref = entry.cells[selectedCol];
          if (ref) applyBinding(ref, '');
        }
        break;
      case 'Escape':
        ev.preventDefault();
        goBack();
        break;
      default:
        break;
    }
  });

  ctx.onCleanup(() => {
    disposed = true;
    if (capturing) input.cancelCapture();
  });

  selected = firstBindEntry;
  refreshAll();
  updateSelection();
}
