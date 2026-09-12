import type { ResultsData, UiCallbacks, UiDeps, UiScreen } from '../core/types';

/** Cycle order for a character-select slot: Off, Human, CPU. */
export type SlotMode = 'off' | 'human' | 'cpu';

export const SLOT_MODE_CYCLE: SlotMode[] = ['off', 'human', 'cpu'];

/** Highest CPU difficulty the select screen slider allows. */
export const MAX_CPU_LEVEL = 9;

export interface SlotState {
  mode: SlotMode;
  charId: string;
  charIndex: number;
  /** 1..MAX_CPU_LEVEL. Kept even while mode is not 'cpu' so toggling does not lose it. */
  cpuLevel: number;
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
    { mode: 'human', charId: defaultChar, charIndex: 0, cpuLevel: 5 },
    { mode: 'cpu', charId: defaultChar, charIndex: 0, cpuLevel: 5 },
    { mode: 'off', charId: defaultChar, charIndex: 0, cpuLevel: 5 },
    { mode: 'off', charId: defaultChar, charIndex: 0, cpuLevel: 5 },
  ];
  return {
    stocks: 3,
    slots,
    stageIndex: 0,
    controlsReturnTo: 'mode',
  };
}

export function slotLabel(mode: SlotMode): string {
  switch (mode) {
    case 'off':
      return 'Off';
    case 'human':
      return 'Human';
    case 'cpu':
      return 'CPU';
  }
}

const CPU_LEVEL_NAMES = [
  'Rookie',
  'Novice',
  'Steady',
  'Sharp',
  'Skilled',
  'Expert',
  'Ruthless',
  'Merciless',
  'CRACKED',
];

/** Short descriptor for a CPU difficulty level 1..MAX_CPU_LEVEL. */
export function cpuLevelName(level: number): string {
  const idx = Math.round(level) - 1;
  if (idx < 0) return CPU_LEVEL_NAMES[0];
  if (idx >= CPU_LEVEL_NAMES.length) return CPU_LEVEL_NAMES[CPU_LEVEL_NAMES.length - 1];
  return CPU_LEVEL_NAMES[idx];
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
