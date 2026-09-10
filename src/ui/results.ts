import type { MenuCtx } from './context';

interface ResultButton {
  el: HTMLElement;
  activate: () => void;
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const data = ctx.results;

  const panel = document.createElement('div');
  panel.className = 'aev-panel aev-panel-wide';
  container.appendChild(panel);

  const heading = document.createElement('h1');
  heading.className = 'aev-heading';
  heading.textContent = !data || data.winner === -1 ? 'DRAW' : `P${data.winner + 1} WINS`;
  panel.appendChild(heading);

  const table = document.createElement('table');
  table.className = 'aev-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Slot</th><th>Character</th><th>Stocks</th><th>Percent</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  const players = data ? data.players : [];
  const charName = (charId: string): string => {
    const found = ctx.deps.characters.find((c) => c.id === charId);
    return found ? found.name : charId;
  };

  players
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .forEach((p) => {
      const row = document.createElement('tr');
      const slotCell = document.createElement('td');
      slotCell.textContent = `P${p.slot + 1}`;
      const charCell = document.createElement('td');
      charCell.textContent = charName(p.charId);
      const stocksCell = document.createElement('td');
      stocksCell.textContent = String(p.stocks);
      const percentCell = document.createElement('td');
      percentCell.textContent = `${Math.round(p.percent)}%`;
      row.appendChild(slotCell);
      row.appendChild(charCell);
      row.appendChild(stocksCell);
      row.appendChild(percentCell);
      tbody.appendChild(row);
    });

  table.appendChild(tbody);
  panel.appendChild(table);

  const buttonRow = document.createElement('div');
  buttonRow.className = 'aev-row';
  panel.appendChild(buttonRow);

  const buttons: ResultButton[] = [];
  let selected = 0;

  function updateHighlight(): void {
    buttons.forEach((b, i) => b.el.classList.toggle('aev-btn-selected', i === selected));
  }

  function addButton(label: string, activate: () => void): void {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'aev-btn';
    el.textContent = label;
    buttonRow.appendChild(el);
    const btn: ResultButton = { el, activate };
    buttons.push(btn);
    ctx.addListener(el, 'click', () => {
      selected = buttons.indexOf(btn);
      updateHighlight();
      activate();
    });
  }

  addButton('Rematch', () => ctx.callbacks.rematch());
  addButton('Character Select', () => ctx.go('select'));

  updateHighlight();

  ctx.addListener(window, 'keydown', (e: Event) => {
    const ev = e as KeyboardEvent;
    switch (ev.code) {
      case 'ArrowLeft':
      case 'ArrowUp':
        ev.preventDefault();
        selected = (selected - 1 + buttons.length) % buttons.length;
        updateHighlight();
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        ev.preventDefault();
        selected = (selected + 1) % buttons.length;
        updateHighlight();
        break;
      case 'Enter':
      case 'Space':
        ev.preventDefault();
        buttons[selected]?.activate();
        break;
      default:
        break;
    }
  });
}
