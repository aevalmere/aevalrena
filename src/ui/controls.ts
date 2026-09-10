import type { InputAction } from '../core/types';
import { MAX_PLAYERS } from '../core/types';
import { prettyKey, type MenuCtx } from './context';

const ACTIONS: InputAction[] = [
  'left', 'right', 'up', 'down', 'jump', 'attack', 'special', 'shield', 'taunt', 'start',
];

const ACTION_LABELS: Record<InputAction, string> = {
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  jump: 'Jump',
  attack: 'Attack',
  special: 'Special',
  shield: 'Shield',
  taunt: 'Taunt',
  start: 'Start',
};

/** Row index used for the tap-jump toggle, after all action rows. */
const TAP_JUMP_ROW = ACTIONS.length;
const ROW_COUNT = ACTIONS.length + 1;

interface KeyCellRef {
  action: InputAction;
  cell: HTMLElement;
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const { deps, state } = ctx;

  const panel = document.createElement('div');
  panel.className = 'aev-panel aev-panel-wide';
  container.appendChild(panel);

  const heading = document.createElement('h1');
  heading.className = 'aev-heading';
  heading.textContent = 'Controls';
  panel.appendChild(heading);

  const tabs = document.createElement('div');
  tabs.className = 'aev-tabs';
  panel.appendChild(tabs);

  const tabButtons: HTMLButtonElement[] = [];
  for (let p = 0; p < MAX_PLAYERS; p += 1) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'aev-tab';
    tab.textContent = `P${p + 1}`;
    tabs.appendChild(tab);
    tabButtons.push(tab);
  }

  const table = document.createElement('table');
  table.className = 'aev-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Action</th><th>Key</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  panel.appendChild(table);

  const buttonRow = document.createElement('div');
  buttonRow.className = 'aev-row';
  panel.appendChild(buttonRow);
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'aev-btn';
  buttonRow.appendChild(resetBtn);
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'aev-btn';
  backBtn.textContent = 'Back';
  buttonRow.appendChild(backBtn);

  const hint = document.createElement('p');
  hint.className = 'aev-subtext';
  hint.textContent = 'Up/Down: choose row   Enter: rebind / toggle   Escape: cancel or back';
  panel.appendChild(hint);

  let activePlayer = 0;
  let selectedRow = 0;
  let capturing = false;
  let rowEls: HTMLTableRowElement[] = [];
  let keyCells: KeyCellRef[] = [];
  let tapToggleCell: HTMLElement | null = null;

  function goBack(): void {
    ctx.go(state.controlsReturnTo);
  }

  function refreshConflicts(): void {
    const conflicts = deps.input.conflicts();
    const conflictActions = new Set(
      conflicts.filter((c) => c.player === activePlayer).map((c) => c.action)
    );
    keyCells.forEach(({ action, cell }) => {
      cell.classList.toggle('conflict', conflictActions.has(action));
    });
  }

  function updateRowHighlight(): void {
    rowEls.forEach((row, i) => row.classList.toggle('aev-row-selected', i === selectedRow));
  }

  function updateTabs(): void {
    tabButtons.forEach((btn, i) => btn.classList.toggle('aev-tab-active', i === activePlayer));
    resetBtn.textContent = `Reset P${activePlayer + 1}`;
  }

  async function beginCapture(action: InputAction, cell: HTMLElement): Promise<void> {
    if (capturing) return;
    capturing = true;
    const original = cell.textContent ?? '';
    cell.textContent = 'press a key';
    cell.classList.add('aev-key-listening');
    try {
      const code = await deps.input.listenForNextKey();
      deps.input.setBinding(activePlayer, action, code);
      deps.input.save();
      cell.textContent = prettyKey(code);
      refreshConflicts();
    } catch {
      cell.textContent = original;
    } finally {
      cell.classList.remove('aev-key-listening');
      capturing = false;
    }
  }

  function buildTable(): void {
    tbody.innerHTML = '';
    rowEls = [];
    keyCells = [];
    tapToggleCell = null;

    const bindings = deps.input.controls.players[activePlayer]?.bindings;
    const tapJump = deps.input.controls.players[activePlayer]?.tapJump ?? false;

    ACTIONS.forEach((action) => {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.textContent = ACTION_LABELS[action];
      row.appendChild(nameCell);

      const keyCell = document.createElement('td');
      keyCell.className = 'aev-key-cell';
      keyCell.textContent = bindings ? prettyKey(bindings[action]) : '';
      ctx.addListener(keyCell, 'click', () => {
        void beginCapture(action, keyCell);
      });
      row.appendChild(keyCell);

      tbody.appendChild(row);
      rowEls.push(row);
      keyCells.push({ action, cell: keyCell });
    });

    const tapRow = document.createElement('tr');
    const tapName = document.createElement('td');
    tapName.textContent = 'Tap jump';
    tapRow.appendChild(tapName);
    const tapValue = document.createElement('td');
    tapValue.className = 'aev-toggle-cell';
    tapValue.textContent = tapJump ? 'On' : 'Off';
    ctx.addListener(tapValue, 'click', () => toggleTapJump());
    tapRow.appendChild(tapValue);
    tbody.appendChild(tapRow);
    rowEls.push(tapRow);
    tapToggleCell = tapValue;

    refreshConflicts();
    updateRowHighlight();
  }

  function toggleTapJump(): void {
    const current = deps.input.controls.players[activePlayer]?.tapJump ?? false;
    deps.input.setTapJump(activePlayer, !current);
    deps.input.save();
    if (tapToggleCell) tapToggleCell.textContent = !current ? 'On' : 'Off';
  }

  function switchPlayer(p: number): void {
    activePlayer = p;
    selectedRow = 0;
    updateTabs();
    buildTable();
  }

  tabButtons.forEach((btn, i) => {
    ctx.addListener(btn, 'click', () => switchPlayer(i));
  });

  ctx.addListener(resetBtn, 'click', () => {
    deps.input.resetDefaults(activePlayer);
    deps.input.save();
    buildTable();
  });

  ctx.addListener(backBtn, 'click', () => goBack());

  ctx.addListener(window, 'keydown', (e: Event) => {
    if (capturing) return;
    const ev = e as KeyboardEvent;
    switch (ev.code) {
      case 'ArrowUp':
        ev.preventDefault();
        selectedRow = (selectedRow - 1 + ROW_COUNT) % ROW_COUNT;
        updateRowHighlight();
        break;
      case 'ArrowDown':
        ev.preventDefault();
        selectedRow = (selectedRow + 1) % ROW_COUNT;
        updateRowHighlight();
        break;
      case 'Enter':
      case 'Space':
        ev.preventDefault();
        if (selectedRow === TAP_JUMP_ROW) {
          toggleTapJump();
        } else {
          const ref = keyCells[selectedRow];
          if (ref) void beginCapture(ref.action, ref.cell);
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

  switchPlayer(0);
}
