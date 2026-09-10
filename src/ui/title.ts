import type { MenuCtx } from './context';

const VERSION = '0.1.0';

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const wrap = document.createElement('div');
  wrap.className = 'aev-title-wrap';

  const logo = document.createElement('div');
  logo.className = 'aev-title-logo';
  logo.textContent = 'AEVALRENA';
  wrap.appendChild(logo);

  const blink = document.createElement('div');
  blink.className = 'aev-title-blink';
  blink.textContent = 'press any key';
  wrap.appendChild(blink);

  container.appendChild(wrap);

  const version = document.createElement('div');
  version.className = 'aev-version';
  version.textContent = VERSION;
  container.appendChild(version);

  const advance = (): void => {
    ctx.go('mode');
  };

  ctx.addListener(window, 'keydown', advance);
  ctx.addListener(container, 'click', advance);
}
