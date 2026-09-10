import type { UiCallbacks, UiController, UiDeps } from '../core/types';

export function createUi(root: HTMLElement, deps: UiDeps, callbacks: UiCallbacks): UiController {
  throw new Error('not implemented: ui');
}
