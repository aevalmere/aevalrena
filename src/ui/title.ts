import type { MenuCtx } from './context';
import { uiAsset } from './theme';

const VERSION = '0.1.0';

/** Petal layout: [variant, left %, delay s, duration s, drift px]. Fixed so the screen never jumps between visits. */
const PETALS: [number, number, number, number, number][] = [
  [1, 14, 0, 12, -140],
  [2, 32, 3.5, 10, -90],
  [3, 55, 1.2, 13, -160],
  [4, 72, 6, 11, -110],
  [2, 88, 8.5, 14, -180],
];

export const CSS = `
.aev-screen-title { cursor: pointer; }
.aev-title-stage {
  position: absolute;
  right: 0;
  bottom: 0;
  width: min(52vw, 640px);
  height: auto;
  opacity: 0.35;
  pointer-events: none;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 40%), linear-gradient(0deg, #000 70%, transparent);
  -webkit-mask-composite: source-in;
  mask-image: linear-gradient(90deg, transparent, #000 40%), linear-gradient(0deg, #000 70%, transparent);
  mask-composite: intersect;
}
.aev-title-wrap {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.1rem;
}
.aev-title-logo {
  position: relative;
  font-family: var(--font-display);
  font-weight: 500;
  font-size: clamp(3rem, 9vw, 6.5rem);
  line-height: 1;
  letter-spacing: 0.35em;
  /* letter-spacing trails after the last glyph; pad the left so the word stays centred */
  padding-left: 0.35em;
  color: var(--accent);
  text-shadow: 0 0 10px color-mix(in srgb, var(--accent) 60%, transparent),
    0 0 28px color-mix(in srgb, var(--accent) 30%, transparent);
}
.aev-title-splash {
  position: absolute;
  left: 50%;
  top: 72%;
  width: min(90vw, 760px);
  aspect-ratio: 6 / 1;
  transform: translateX(-50%);
  z-index: -1;
  opacity: 0.25;
  background: var(--accent);
  -webkit-mask-image: url("${uiAsset('splash.png')}"), radial-gradient(closest-side, #000 55%, transparent);
  -webkit-mask-size: 100% 100%, 100% 100%;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-composite: source-in;
  mask-image: url("${uiAsset('splash.png')}"), radial-gradient(closest-side, #000 55%, transparent);
  mask-size: 100% 100%, 100% 100%;
  mask-repeat: no-repeat;
  mask-composite: intersect;
  pointer-events: none;
}
.aev-title-wrap .ui-rule { width: min(70vw, 560px); }
.aev-title-press {
  margin-top: 1.8rem;
  font-family: var(--font-ui);
  font-size: 0.95rem;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--text);
  text-shadow: var(--glow);
}
.aev-title-version {
  position: absolute;
  right: 1.4rem;
  bottom: 1rem;
}
`;

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const stage = document.createElement('img');
  stage.className = 'aev-title-stage';
  stage.src = uiAsset('backdrop-stage.png');
  stage.alt = '';
  container.appendChild(stage);

  const petals = document.createElement('div');
  petals.className = 'ui-petals';
  for (const [variant, left, delay, dur, dx] of PETALS) {
    const p = document.createElement('span');
    p.className = `ui-petal ui-petal-${variant}`;
    p.style.cssText = `left:${left}%;--delay:${delay}s;--dur:${dur}s;--dx:${dx}px`;
    petals.appendChild(p);
  }
  container.appendChild(petals);

  const wrap = document.createElement('div');
  wrap.className = 'aev-title-wrap';

  const logo = document.createElement('h1');
  logo.className = 'aev-title-logo';
  logo.style.margin = '0';
  logo.textContent = 'AEVALRENA';
  const splash = document.createElement('span');
  splash.className = 'aev-title-splash';
  logo.appendChild(splash);
  wrap.appendChild(logo);

  const rule = document.createElement('div');
  rule.className = 'ui-rule';
  wrap.appendChild(rule);

  const press = document.createElement('div');
  press.className = 'aev-title-press ui-blink';
  press.textContent = 'Press any key';
  wrap.appendChild(press);

  container.appendChild(wrap);

  const version = document.createElement('div');
  version.className = 'ui-tag aev-title-version';
  version.textContent = `v${VERSION}`;
  container.appendChild(version);

  const advance = (): void => {
    ctx.go('mode');
  };

  ctx.addListener(window, 'keydown', advance);
  ctx.addListener(container, 'click', advance);
}
