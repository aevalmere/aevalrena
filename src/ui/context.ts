import type { ResultsData, UiCallbacks, UiDeps, UiScreen } from '../core/types';

/** Cycle order for a character-select slot: Off, Human, CPU level 1-3. */
export type SlotMode = 'off' | 'human' | 'cpu1' | 'cpu2' | 'cpu3';

export const SLOT_MODE_CYCLE: SlotMode[] = ['off', 'human', 'cpu1', 'cpu2', 'cpu3'];

export interface SlotState {
  mode: SlotMode;
  charId: string;
  charIndex: number;
}

/** Menu state shared across screens for the lifetime of the UiController. */
export interface MenuState {
  stocks: number;
  slots: SlotState[];
  stageIndex: number;
  /** Where the controls screen returns to: the mode screen, or pause during a match. */
  controlsReturnTo: UiScreen;
}

/** Context passed into every screen's render function. */
export interface MenuCtx {
  deps: UiDeps;
  callbacks: UiCallbacks;
  go(screen: UiScreen, data?: ResultsData): void;
  state: MenuState;
  /** Set by the controller right before rendering the 'results' screen. */
  results: ResultsData | null;
  /** Attach a listener and register its removal in the controller's cleanup list. */
  addListener(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject): void;
}

export function createDefaultMenuState(deps: UiDeps): MenuState {
  const defaultChar = deps.characters[0]?.id ?? '';
  const slots: SlotState[] = [
    { mode: 'human', charId: defaultChar, charIndex: 0 },
    { mode: 'cpu1', charId: defaultChar, charIndex: 0 },
    { mode: 'off', charId: defaultChar, charIndex: 0 },
    { mode: 'off', charId: defaultChar, charIndex: 0 },
  ];
  return {
    stocks: 3,
    slots,
    stageIndex: 0,
    controlsReturnTo: 'mode',
  };
}

export function slotCpuLevel(mode: SlotMode): number {
  switch (mode) {
    case 'cpu1':
      return 1;
    case 'cpu2':
      return 2;
    case 'cpu3':
      return 3;
    default:
      return 0;
  }
}

export function slotLabel(mode: SlotMode): string {
  switch (mode) {
    case 'off':
      return 'Off';
    case 'human':
      return 'Human';
    case 'cpu1':
      return 'CPU 1';
    case 'cpu2':
      return 'CPU 2';
    case 'cpu3':
      return 'CPU 3';
  }
}

const SPECIAL_KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ShiftLeft: 'LShift',
  ShiftRight: 'RShift',
  ControlLeft: 'LCtrl',
  ControlRight: 'RCtrl',
  AltLeft: 'LAlt',
  AltRight: 'RAlt',
  MetaLeft: 'LMeta',
  MetaRight: 'RMeta',
  Enter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Del',
  CapsLock: 'Caps',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  NumpadEnter: 'Num Enter',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Home: 'Home',
  End: 'End',
  Insert: 'Ins',
};

/** Format a KeyboardEvent.code into a short label for display, e.g. KeyA -> A, ArrowLeft -> Left. */
export function prettyKey(code: string): string {
  if (code in SPECIAL_KEY_NAMES) return SPECIAL_KEY_NAMES[code];
  const keyMatch = /^Key([A-Z])$/.exec(code);
  if (keyMatch) return keyMatch[1];
  const digitMatch = /^Digit([0-9])$/.exec(code);
  if (digitMatch) return digitMatch[1];
  const numpadMatch = /^Numpad([0-9])$/.exec(code);
  if (numpadMatch) return `Num ${numpadMatch[1]}`;
  return code;
}
