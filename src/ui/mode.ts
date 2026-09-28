import type { MenuCtx } from './context';
import { uiAsset } from './theme';

/**
 * Mode select. Also exports the left-anchored menu panel (header, face backdrop, cursor rows)
 * that the pause menu shares, so both screens stay identical to the pause reference.
 */

export const CSS = `
.aev-menu-panel {
  width: min(92vw, 34rem);
  min-height: 24rem;
  padding: 1.3rem 1.6rem 1.6rem 1.3rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.aev-menu-panel.aev-menu-compact { min-height: 0; padding-bottom: 2rem; }
.aev-menu-bg {
  position: absolute;
  inset: var(--line);
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
  clip-path: polygon(var(--chamfer-in) 0, 100% 0, 100% calc(100% - var(--chamfer-in)),
    calc(100% - var(--chamfer-in)) 100%, 0 100%, 0 var(--chamfer-in));
}
.aev-menu-bg .ui-backdrop {
  width: 66%;
  object-fit: cover;
  object-position: 35% center;
}
.aev-menu-panel .ui-header { padding-left: 0.2rem; }
.aev-menu-headline {
  height: 1px;
  margin: 0 -1.6rem 0.4rem -1.3rem;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 70%, transparent),
    color-mix(in srgb, var(--accent) 15%, transparent) 70%, transparent);
  flex-shrink: 0;
}
.aev-menu-list {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.aev-menu-row { padding-left: 0.3rem; min-height: 2.5rem; }
.aev-menu-row .ui-cursor {
  opacity: 0;
  transform: translateX(-8px);
}
.aev-menu-row.ui-item-selected .ui-cursor {
  opacity: 1;
  transform: translateX(0);
}
.aev-menu-row .ui-tag { margin-left: 0.4rem; text-shadow: none; }
.aev-menu-list .ui-rule { margin: 0.45rem 0; width: 88%; align-self: center; }
.aev-step {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
}
.aev-step-btn {
  appearance: none;
  -webkit-appearance: none;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-ui);
  font-size: 1rem;
  line-height: 1;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 0;
  cursor: pointer;
  transition: background-color 120ms ease-out, border-color 120ms ease-out;
}
.aev-step-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 28%, transparent);
  border-color: var(--accent);
}
.aev-step-btn:disabled { opacity: 0.3; cursor: default; }
.aev-step-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
.aev-step-value {
  min-width: 12.5em;
  text-align: center;
  font-size: 0.9rem;
}
`;

/** Build the chamfered menu panel with its face backdrop and header. Rows go into `list`. */
export function buildMenuPanel(container: HTMLElement, title: string): { panel: HTMLElement; list: HTMLElement } {
  const panel = document.createElement('div');
  panel.className = 'ui-frame aev-menu-panel';
  container.appendChild(panel);

  const bg = document.createElement('div');
  bg.className = 'aev-menu-bg';
  const face = document.createElement('img');
  face.className = 'ui-backdrop';
  face.src = uiAsset('backdrop-face.png');
  face.alt = '';
  bg.appendChild(face);
  panel.appendChild(bg);

  const header = document.createElement('h1');
  header.className = 'ui-header';
  const spark = document.createElement('span');
  spark.className = 'ui-spark';
  header.appendChild(spark);
  header.appendChild(document.createTextNode(title));
  panel.appendChild(header);

  const headline = document.createElement('div');
  headline.className = 'aev-menu-headline';
  panel.appendChild(headline);

  const list = document.createElement('div');
  list.className = 'aev-menu-list';
  panel.appendChild(list);

  return { panel, list };
}

/** A menu row: cursor slot, then the label. Callers append tags or steppers after it. */
export function menuRow(label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ui-item aev-menu-row';
  const cursor = document.createElement('span');
  cursor.className = 'ui-cursor';
  el.appendChild(cursor);
  const text = document.createElement('span');
  text.textContent = label;
  el.appendChild(text);
  return el;
}

interface ModeItem {
  el: HTMLElement;
  disabled: boolean;
  /** Left/Right handler for stepper rows. */
  step?: (dir: -1 | 1) => void;
  activate?: () => void;
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const { list } = buildMenuPanel(container, 'Mode select');

  const items: ModeItem[] = [];
  let selected = 0;

  function updateHighlight(): void {
    items.forEach((it, i) => {
      it.el.classList.toggle('ui-item-selected', i === selected);
    });
  }

  function addBasicItem(label: string, opts: { disabled?: boolean; tag?: string; activate?: () => void }): void {
    const el = menuRow(label);
    if (opts.disabled) el.classList.add('ui-item-disabled');
    if (opts.tag) {
      const tag = document.createElement('span');
      tag.className = 'ui-tag';
      tag.textContent = opts.tag;
      el.appendChild(tag);
    }
    list.appendChild(el);
    const item: ModeItem = { el, disabled: !!opts.disabled, activate: opts.activate };
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
  addBasicItem('LAN', { disabled: true, tag: 'soon' });
  addBasicItem('Online', { disabled: true, tag: 'soon' });
  addBasicItem('Controls', {
    activate: () => {
      ctx.state.controlsReturnTo = 'mode';
      ctx.go('controls');
    },
  });

  const rule = document.createElement('div');
  rule.className = 'ui-rule';
  list.appendChild(rule);

  /**
   * A rules row with small chevron buttons around the value. `step` changes the setting;
   * `refresh` writes the value text and enables or disables the buttons.
   */
  function addStepperItem(
    label: string,
    step: (dir: -1 | 1) => void,
    refresh: (valueEl: HTMLElement, minusBtn: HTMLButtonElement, plusBtn: HTMLButtonElement) => void
  ): void {
    const el = menuRow(label);

    const stepper = document.createElement('span');
    stepper.className = 'aev-step';
    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'aev-step-btn';
    minusBtn.textContent = '‹';
    minusBtn.setAttribute('aria-label', `${label} previous`);
    const valueEl = document.createElement('span');
    valueEl.className = 'aev-step-value';
    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'aev-step-btn';
    plusBtn.textContent = '›';
    plusBtn.setAttribute('aria-label', `${label} next`);
    stepper.appendChild(minusBtn);
    stepper.appendChild(valueEl);
    stepper.appendChild(plusBtn);
    el.appendChild(stepper);
    list.appendChild(el);

    const item: ModeItem = {
      el,
      disabled: false,
      step: (dir) => {
        step(dir);
        refresh(valueEl, minusBtn, plusBtn);
      },
    };
    items.push(item);
    refresh(valueEl, minusBtn, plusBtn);

    function select(): void {
      selected = items.indexOf(item);
      updateHighlight();
    }
    ctx.addListener(el, 'click', select);
    ctx.addListener(minusBtn, 'click', (e: Event) => {
      e.stopPropagation();
      select();
      item.step?.(-1);
    });
    ctx.addListener(plusBtn, 'click', (e: Event) => {
      e.stopPropagation();
      select();
      item.step?.(1);
    });
  }

  addStepperItem(
    'Stocks',
    (dir) => {
      ctx.state.stocks = Math.max(1, Math.min(5, ctx.state.stocks + dir));
    },
    (valueEl, minusBtn, plusBtn) => {
      valueEl.textContent = String(ctx.state.stocks);
      minusBtn.disabled = ctx.state.stocks <= 1;
      plusBtn.disabled = ctx.state.stocks >= 5;
    }
  );

  // A two-state rule: either arrow flips it, so neither button is ever disabled.
  addStepperItem(
    'Final Smash',
    () => {
      ctx.state.finalSmash = !ctx.state.finalSmash;
    },
    (valueEl) => {
      valueEl.textContent = ctx.state.finalSmash ? 'On' : 'Off';
    }
  );

  // A two-state rule: either arrow flips it, so neither button is ever disabled.
  addStepperItem(
    'Lv 0 CPU',
    () => {
      ctx.state.cpuZeroMoves = !ctx.state.cpuZeroMoves;
    },
    (valueEl) => {
      valueEl.textContent = ctx.state.cpuZeroMoves ? 'Wanders' : 'Stands still';
    }
  );

  // A two-state rule: same team colour on Character Select = one side, no friendly fire.
  addStepperItem(
    'Teams',
    () => {
      ctx.state.teams = ctx.state.teams !== true;
    },
    (valueEl) => {
      valueEl.textContent = ctx.state.teams === true ? 'On' : 'Off';
    }
  );

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
      case 'ArrowRight': {
        const item = items[selected];
        if (item?.step) {
          ev.preventDefault();
          item.step(ev.code === 'ArrowLeft' ? -1 : 1);
        }
        break;
      }
      case 'Enter':
      case 'Space': {
        ev.preventDefault();
        const item = items[selected];
        if (item && !item.disabled) {
          if (item.activate) item.activate();
          else item.step?.(1);
        }
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
