import type { ResultsData, UiCallbacks, UiDeps, UiScreen } from '../core/types';

/** Cycle order for a character-select slot: Off, Human, CPU. */
export type SlotMode = 'off' | 'human' | 'cpu';

export const SLOT_MODE_CYCLE: SlotMode[] = ['off', 'human', 'cpu'];

/** Highest CPU difficulty the select screen slider allows. */
export const MAX_CPU_LEVEL = 10;
/** Lowest CPU difficulty the select screen slider allows: a non-attacking dummy. */
export const MIN_CPU_LEVEL = 0;

export interface SlotState {
  mode: SlotMode;
  charId: string;
  charIndex: number;
  /** MIN_CPU_LEVEL..MAX_CPU_LEVEL. Kept even while mode is not 'cpu' so toggling does not lose it. */
  cpuLevel: number;
  /** Typed human name (select.ts loads it from localStorage); absent means 'P<n>'. */
  name?: string;
  /** Team colour, an index into PLAYER_ACCENTS; absent means the slot's own colour. */
  team?: number;
}

/** Menu state shared across screens for the lifetime of the UiController. */
export interface MenuState {
  stocks: number;
  /** Final Smash match rule. Disabled this wave: false by default, and Mode select forces it off. */
  finalSmash: boolean;
  /** Level 0 CPU rule: wander (walk, jump, never attack) instead of standing still. */
  cpuZeroMoves: boolean;
  slots: SlotState[];
  stageIndex: number;
  /** Where the controls screen returns to: the mode screen, or pause during a match. */
  controlsReturnTo: UiScreen;
  /** Where the move list returns to: the mode screen, or pause during a match. */
  movelistReturnTo: UiScreen;
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
  /** Register a function the controller runs when this screen is torn down. */
  onCleanup(fn: () => void): void;
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
    finalSmash: false,
    cpuZeroMoves: false,
    slots,
    stageIndex: 0,
    controlsReturnTo: 'mode',
    movelistReturnTo: 'mode',
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
  'Dummy',
  'Rookie',
  'Novice',
  'Steady',
  'Sharp',
  'Skilled',
  'Expert',
  'Ruthless',
  'Merciless',
  'CRACKED',
  'Aevalmere',
];

/** Short descriptor for a CPU difficulty level MIN_CPU_LEVEL..MAX_CPU_LEVEL. */
export function cpuLevelName(level: number): string {
  const idx = Math.round(level);
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

/** Format one KeyboardEvent.code into a short label for display, e.g. KeyA -> A, ArrowLeft -> Left. '' (unbound) -> '-'. */
function prettyKeyOne(code: string): string {
  if (code === '') return '-';
  if (code in SPECIAL_KEY_NAMES) return SPECIAL_KEY_NAMES[code];
  const keyMatch = /^Key([A-Z])$/.exec(code);
  if (keyMatch) return keyMatch[1];
  const digitMatch = /^Digit([0-9])$/.exec(code);
  if (digitMatch) return digitMatch[1];
  const numpadMatch = /^Numpad([0-9])$/.exec(code);
  if (numpadMatch) return `Num ${numpadMatch[1]}`;
  return code;
}

/**
 * Format a KeyboardEvent.code, or a chord of them joined by '&', into a short label for
 * display, e.g. KeyA -> A, ArrowLeft -> Left, KeyF&KeyJ -> F + J. '' (unbound) -> '-'.
 */
export function prettyKey(code: string): string {
  if (code.includes('&')) return code.split('&').map(prettyKeyOne).join(' + ');
  return prettyKeyOne(code);
}

/** Standard-mapping button names, index = button number. */
const PLAYSTATION_BUTTON_NAMES = [
  'Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2',
  'Create', 'Options', 'L3', 'R3', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'PS', 'Pad',
];

const XBOX_BUTTON_NAMES = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'View', 'Menu', 'LS', 'RS', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Guide',
];

const PAD_AXIS_NAMES: Record<string, string> = {
  'A0-': 'LS Left',
  'A0+': 'LS Right',
  'A1-': 'LS Up',
  'A1+': 'LS Down',
  'A2-': 'RS Left',
  'A2+': 'RS Right',
  'A3-': 'RS Up',
  'A3+': 'RS Down',
};

const PLAYSTATION_ID = /dualsense|dualshock|playstation|054c|wireless controller/i;

/**
 * Format one pad code ('B<n>', 'A<n>+', 'A<n>-') for display. Button names follow
 * the pad family guessed from its Gamepad.id: PlayStation, else Xbox.
 * '' (unbound) -> '-'. Unknown codes are returned raw.
 */
function prettyPadOne(code: string, padId: string | undefined): string {
  if (code === '') return '-';
  if (code in PAD_AXIS_NAMES) return PAD_AXIS_NAMES[code];
  const buttonMatch = /^B(\d+)$/.exec(code);
  if (buttonMatch) {
    const names = padId !== undefined && PLAYSTATION_ID.test(padId) ? PLAYSTATION_BUTTON_NAMES : XBOX_BUTTON_NAMES;
    const name = names[Number(buttonMatch[1])];
    if (name !== undefined) return name;
  }
  return code;
}

/**
 * Format a pad code, or a chord of them joined by '&', for display. Button names follow
 * the pad family guessed from its Gamepad.id: PlayStation, else Xbox.
 * '' (unbound) -> '-'. Unknown codes are returned raw.
 */
export function prettyPad(code: string, padId: string | undefined): string {
  if (code.includes('&')) return code.split('&').map((part) => prettyPadOne(part, padId)).join(' + ');
  return prettyPadOne(code, padId);
}
