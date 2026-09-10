import type { MenuCtx } from './context';

interface PauseItem {
  el: HTMLElement;
  activate: () => void;
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const panel = document.createElement('div');
  panel.className = 'aev-panel aev-panel-narrow';
  container.appendChild(panel);

  const heading = document.createElement('h1');
  heading.className = 'aev-heading';
  heading.textContent = 'Paused';
  panel.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'aev-list';
  panel.appendChild(list);

  const items: PauseItem[] = [];
  let selected = 0;

  function updateHighlight(): void {
    items.forEach((it, i) => it.el.classList.toggle('aev-item-selected', i === selected));
  }

  function addItem(label: string, activate: () => void): void {
    const el = document.createElement('div');
    el.className = 'aev-item';
    el.textContent = label;
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
  addItem('Controls', () => {
    ctx.state.controlsReturnTo = 'pause';
    ctx.go('controls');
  });
  addItem('Quit to Title', () => ctx.callbacks.quit());

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
