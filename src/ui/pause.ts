import type { MenuCtx } from './context';
import { buildMenuPanel, menuRow } from './mode';

/** Pause menu: the mode panel look (its CSS lives in mode.ts), over the frozen match. */

/** Row to restore when coming back from MOVE LIST or CONTROLS; a fresh pause starts on RESUME. */
let returnIndex = 0;

interface PauseItem {
  el: HTMLElement;
  activate: () => void;
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const { panel, list } = buildMenuPanel(container, 'Pause menu');
  panel.classList.add('aev-menu-compact');

  const items: PauseItem[] = [];
  let selected = returnIndex;
  returnIndex = 0;

  function updateHighlight(): void {
    items.forEach((it, i) => it.el.classList.toggle('ui-item-selected', i === selected));
  }

  function addItem(label: string, activate: () => void): void {
    const el = menuRow(label);
    list.appendChild(el);
    const item: PauseItem = { el, activate };
    items.push(item);
    ctx.addListener(el, 'click', () => {
      selected = items.indexOf(item);
      updateHighlight();
      activate();
    });
  }

  addItem('Resume', () => ctx.callbacks.resume());
  addItem('Move list', () => {
    ctx.state.movelistReturnTo = 'pause';
    returnIndex = selected;
    ctx.go('movelist');
  });
  addItem('Controls', () => {
    ctx.state.controlsReturnTo = 'pause';
    returnIndex = selected;
    ctx.go('controls');
  });
  addItem('Quit', () => ctx.callbacks.quit());

  updateHighlight();

  ctx.addListener(window, 'keydown', (e: Event) => {
    const ev = e as KeyboardEvent;
    switch (ev.code) {
      case 'ArrowUp':
      case 'KeyW':
        ev.preventDefault();
        selected = (selected - 1 + items.length) % items.length;
        updateHighlight();
        break;
      case 'ArrowDown':
      case 'KeyS':
        ev.preventDefault();
        selected = (selected + 1) % items.length;
        updateHighlight();
        break;
      case 'Enter':
      case 'Space':
        ev.preventDefault();
        items[selected]?.activate();
        break;
      case 'Escape':
        ev.preventDefault();
        ctx.callbacks.resume();
        break;
      default:
        break;
    }
  });
}
