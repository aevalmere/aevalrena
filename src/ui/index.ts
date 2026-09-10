import type { ResultsData, UiCallbacks, UiController, UiDeps, UiScreen } from '../core/types';
import { createDefaultMenuState, type MenuCtx } from './context';
import { STYLE_CSS } from './styles';
import { render as renderTitle } from './title';
import { render as renderMode } from './mode';
import { render as renderSelect } from './select';
import { render as renderControls } from './controls';
import { render as renderPause } from './pause';
import { render as renderResults } from './results';

type ScreenRenderer = (container: HTMLElement, ctx: MenuCtx) => void;

const SCREEN_RENDERERS: Record<UiScreen, ScreenRenderer> = {
  title: renderTitle,
  mode: renderMode,
  select: renderSelect,
  controls: renderControls,
  pause: renderPause,
  results: renderResults,
};

let styleInjected = false;

function ensureStyles(): void {
  if (styleInjected) return;
  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE_CSS;
  document.head.appendChild(styleEl);
  styleInjected = true;
}

export function createUi(root: HTMLElement, deps: UiDeps, callbacks: UiCallbacks): UiController {
  ensureStyles();
  root.classList.add('aev-ui-root');
  root.hidden = true;

  let cleanups: (() => void)[] = [];
  let currentScreen: UiScreen | null = null;

  function addListener(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject): void {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  }

  function runCleanup(): void {
    for (const fn of cleanups) fn();
    cleanups = [];
  }

  function go(screen: UiScreen, data?: ResultsData): void {
    show(screen, data);
  }

  const ctx: MenuCtx = {
    deps,
    callbacks,
    go,
    state: createDefaultMenuState(deps),
    results: null,
    addListener,
  };

  function show(screen: UiScreen, data?: ResultsData): void {
    runCleanup();
    root.innerHTML = '';
    if (screen === 'results') ctx.results = data ?? null;
    currentScreen = screen;
    root.hidden = false;
    const container = document.createElement('div');
    container.className = `aev-screen aev-screen-${screen}`;
    root.appendChild(container);
    SCREEN_RENDERERS[screen](container, ctx);
  }

  function hide(): void {
    runCleanup();
    root.hidden = true;
    root.innerHTML = '';
    currentScreen = null;
  }

  function current(): UiScreen | null {
    return root.hidden ? null : currentScreen;
  }

  return { show, hide, current };
}
