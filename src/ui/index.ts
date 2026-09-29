import type { ResultsData, UiCallbacks, UiController, UiDeps, UiScreen } from '../core/types';
import { createDefaultMenuState, type MenuCtx } from './context';
import { createPadNav } from './padnav';
import { STYLE_CSS } from './styles';
import { THEME_CSS } from './theme';
import { HUD_CSS } from './hud';
import * as title from './title';
import * as mode from './mode';
import * as select from './select';
import * as controls from './controls';
import * as pause from './pause';
import * as results from './results';
import * as movelist from './movelist';
import * as lan from './lan';

type ScreenRenderer = (container: HTMLElement, ctx: MenuCtx) => void;

const SCREEN_RENDERERS: Record<UiScreen, ScreenRenderer> = {
  title: title.render,
  mode: mode.render,
  select: select.render,
  controls: controls.render,
  pause: pause.render,
  results: results.render,
  movelist: movelist.render,
  lan: lan.render,
};

/** Screen modules may export a CSS string with their own rules. */
const SCREEN_MODULES: object[] = [title, mode, select, controls, pause, results, movelist, lan];

function screenCss(mod: object): string {
  const css = (mod as Record<string, unknown>).CSS;
  return typeof css === 'string' ? css : '';
}

let styleInjected = false;

function ensureStyles(): void {
  if (styleInjected) return;
  const styleEl = document.createElement('style');
  styleEl.textContent = THEME_CSS + STYLE_CSS + HUD_CSS + SCREEN_MODULES.map(screenCss).join('\n');
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

  function onCleanup(fn: () => void): void {
    cleanups.push(fn);
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
    onCleanup,
  };

  // UiController has no destroy path, so pad navigation runs for the app's lifetime.
  createPadNav(
    () => !root.hidden && currentScreen !== null,
    () => deps.input.isCapturing()
  );

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
