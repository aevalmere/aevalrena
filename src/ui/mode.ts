import type { MenuCtx } from './context';

interface ModeItem {
  el: HTMLElement;
  disabled: boolean;
  isStepper: boolean;
  activate?: () => void;
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const panel = document.createElement('div');
  panel.className = 'aev-panel aev-panel-narrow';
  container.appendChild(panel);

  const heading = document.createElement('h1');
  heading.className = 'aev-heading';
  heading.textContent = 'Mode Select';
  panel.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'aev-list';
  panel.appendChild(list);

  const items: ModeItem[] = [];
  let selected = 0;

  function updateHighlight(): void {
    items.forEach((it, i) => {
      it.el.classList.toggle('aev-item-selected', i === selected);
    });
  }

  function addBasicItem(label: string, opts: { disabled?: boolean; suffix?: string; activate?: () => void }): void {
    const el = document.createElement('div');
    el.className = 'aev-item';
    if (opts.disabled) el.classList.add('aev-item-disabled');
    const text = document.createElement('span');
    text.textContent = label;
    el.appendChild(text);
    if (opts.suffix) {
      const suffix = document.createElement('span');
      suffix.className = 'aev-item-suffix';
      suffix.textContent = opts.suffix;
      el.appendChild(suffix);
    }
    list.appendChild(el);
    const item: ModeItem = { el, disabled: !!opts.disabled, isStepper: false, activate: opts.activate };
    items.push(item);
    if (!opts.disabled) {
      ctx.addListener(el, 'click', () => {
        selected = items.indexOf(item);
        updateHighlight();
        item.activate?.();
      });
    }
  }

  addBasicItem('Local', { activate: () => ctx.go('select') });
  addBasicItem('LAN', { disabled: true, suffix: 'soon' });
  addBasicItem('Online', { disabled: true, suffix: 'soon' });
  addBasicItem('Controls', {
    activate: () => {
      ctx.state.controlsReturnTo = 'mode';
      ctx.go('controls');
    },
  });

  function clampStocks(v: number): number {
    return Math.max(1, Math.min(5, v));
  }

  function changeStocks(delta: number): void {
    ctx.state.stocks = clampStocks(ctx.state.stocks + delta);
    refreshStepper();
  }

  const stepperEl = document.createElement('div');
  stepperEl.className = 'aev-item';
  const stepperLabel = document.createElement('span');
  stepperLabel.textContent = 'Stocks';
  stepperEl.appendChild(stepperLabel);

  const stepper = document.createElement('div');
  stepper.className = 'aev-stepper';
  const minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.className = 'aev-stepper-btn';
  minusBtn.textContent = '<';
  const valueEl = document.createElement('span');
  valueEl.className = 'aev-stepper-value';
  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'aev-stepper-btn';
  plusBtn.textContent = '>';
  stepper.appendChild(minusBtn);
  stepper.appendChild(valueEl);
  stepper.appendChild(plusBtn);
  stepperEl.appendChild(stepper);
  list.appendChild(stepperEl);

  function refreshStepper(): void {
    valueEl.textContent = String(ctx.state.stocks);
    minusBtn.disabled = ctx.state.stocks <= 1;
    plusBtn.disabled = ctx.state.stocks >= 5;
  }
  refreshStepper();

  const stepperItem: ModeItem = { el: stepperEl, disabled: false, isStepper: true };
  items.push(stepperItem);

  ctx.addListener(stepperEl, 'click', () => {
    selected = items.indexOf(stepperItem);
    updateHighlight();
  });
  ctx.addListener(minusBtn, 'click', (e: Event) => {
    e.stopPropagation();
    selected = items.indexOf(stepperItem);
    updateHighlight();
    changeStocks(-1);
  });
  ctx.addListener(plusBtn, 'click', (e: Event) => {
    e.stopPropagation();
    selected = items.indexOf(stepperItem);
    updateHighlight();
    changeStocks(1);
  });

  function enabledIndices(): number[] {
    const out: number[] = [];
    items.forEach((it, i) => {
      if (!it.disabled) out.push(i);
    });
    return out;
  }

  function moveSelection(dir: 1 | -1): void {
    const enabled = enabledIndices();
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(selected);
    let nextPos = pos === -1 ? 0 : pos + dir;
    if (nextPos < 0) nextPos = enabled.length - 1;
    if (nextPos >= enabled.length) nextPos = 0;
    selected = enabled[nextPos];
    updateHighlight();
  }

  updateHighlight();

  ctx.addListener(window, 'keydown', (e: Event) => {
    const ev = e as KeyboardEvent;
    switch (ev.code) {
      case 'ArrowUp':
      case 'KeyW':
        ev.preventDefault();
        moveSelection(-1);
        break;
      case 'ArrowDown':
      case 'KeyS':
        ev.preventDefault();
        moveSelection(1);
        break;
      case 'ArrowLeft':
        if (items[selected]?.isStepper) {
          ev.preventDefault();
          changeStocks(-1);
        }
        break;
      case 'ArrowRight':
        if (items[selected]?.isStepper) {
          ev.preventDefault();
          changeStocks(1);
        }
        break;
      case 'Enter':
      case 'Space': {
        ev.preventDefault();
        const item = items[selected];
        if (item && !item.disabled) item.activate?.();
        break;
      }
      case 'Escape':
        ev.preventDefault();
        ctx.go('title');
        break;
      default:
        break;
    }
  });
}
