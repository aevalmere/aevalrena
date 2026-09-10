import { CHARACTER_DEFS } from '../characters/registry';
import { TUNING, TUNING_DEFAULTS } from '../core/constants';
import type { CharacterDef, GameState } from '../core/types';

/**
 * Live tuning panel (F4).
 *
 * Every row writes straight into TUNING or into the Aeval character def, both of
 * which the sim reads at use time, so a slider changes the game on the next frame
 * without restarting the match. The panel is plain DOM, no framework, and it
 * swallows its own key events so typing in a number box cannot reach the game.
 */

export interface TunerOptions {
  root: HTMLElement;
  getState: () => GameState | null;
  setTimeScale: (s: number) => void;
  setFreezeCpu: (f: boolean) => void;
}

export interface Tuner {
  toggle(): void;
  visible(): boolean;
  applySaved(): void;
}

const STORAGE_KEY = 'aevalrena.tuning.v1';
const CHAR_ID = 'aeval';
const READOUT_MS = 100;
const TIME_SCALES = [0.25, 0.5, 1];

type PhysicsKey =
  'weight' | 'walkSpeed' | 'runSpeed' | 'dashSpeed' | 'dashFrames' | 'groundAccel'
  | 'groundFriction' | 'airSpeed' | 'airAccel' | 'airFriction' | 'gravity' | 'maxFall'
  | 'fastFall' | 'jumpVel' | 'shortHopVel' | 'doubleJumpVel' | 'jumpSquat';

interface Knob { key: PhysicsKey; min: number; max: number; step: number }

const PHYSICS_KNOBS: Knob[] = [
  { key: 'weight', min: 60, max: 140, step: 1 },
  { key: 'walkSpeed', min: 0.5, max: 3, step: 0.05 },
  { key: 'runSpeed', min: 1, max: 5, step: 0.05 },
  { key: 'dashSpeed', min: 1, max: 5, step: 0.05 },
  { key: 'dashFrames', min: 4, max: 24, step: 1 },
  { key: 'groundAccel', min: 0.1, max: 1, step: 0.01 },
  { key: 'groundFriction', min: 0.05, max: 0.6, step: 0.01 },
  { key: 'airSpeed', min: 0.5, max: 3.5, step: 0.05 },
  { key: 'airAccel', min: 0.02, max: 0.4, step: 0.01 },
  { key: 'airFriction', min: 0, max: 0.1, step: 0.005 },
  { key: 'gravity', min: 0.05, max: 0.4, step: 0.005 },
  { key: 'maxFall', min: 1, max: 6, step: 0.1 },
  { key: 'fastFall', min: 2, max: 9, step: 0.1 },
  { key: 'jumpVel', min: 3, max: 8, step: 0.1 },
  { key: 'shortHopVel', min: 2, max: 6, step: 0.1 },
  { key: 'doubleJumpVel', min: 3, max: 8, step: 0.1 },
  { key: 'jumpSquat', min: 1, max: 8, step: 1 },
];

const CSS = `
.aev-tuner {
  position: fixed;
  top: 0;
  right: 0;
  width: 300px;
  max-height: 100vh;
  overflow-y: auto;
  z-index: 40;
  background: #1a1b26;
  border-left: 2px solid #6e7a94;
  color: #c9d1e0;
  font: 11px "Courier New", Consolas, monospace;
  line-height: 1.4;
  user-select: none;
  -webkit-user-select: none;
}
.aev-tuner[hidden] { display: none; }
.aev-tuner * { box-sizing: border-box; font: inherit; color: inherit; }
.aev-tuner-title {
  padding: 6px 8px;
  border-bottom: 2px solid #6e7a94;
  color: #7fb2ff;
  letter-spacing: 1px;
}
.aev-tuner-group { border-bottom: 1px solid #6e7a94; }
.aev-tuner-head {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 8px;
  background: #1a1b26;
  border: 0;
  border-left: 3px solid #7fb2ff;
  cursor: pointer;
}
.aev-tuner-head:hover { background: #23253a; }
.aev-tuner-body { padding: 4px 8px 8px 8px; }
.aev-tuner-body[hidden] { display: none; }
.aev-tuner-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 2px 0;
}
.aev-tuner-row span { width: 106px; flex: none; overflow: hidden; }
.aev-tuner-row input[type="range"] { flex: 1 1 auto; min-width: 0; height: 12px; accent-color: #7fb2ff; }
.aev-tuner-row input[type="number"] {
  width: 52px;
  flex: none;
  background: #0e0f17;
  border: 1px solid #6e7a94;
  padding: 1px 2px;
}
.aev-tuner-btn {
  background: #0e0f17;
  border: 1px solid #6e7a94;
  padding: 3px 6px;
  cursor: pointer;
}
.aev-tuner-btn:hover { border-color: #7fb2ff; color: #7fb2ff; }
.aev-tuner-btn-on { border-color: #7fb2ff; color: #7fb2ff; }
.aev-tuner-line { display: flex; gap: 6px; align-items: center; margin: 4px 0; flex-wrap: wrap; }
.aev-tuner-readout { white-space: pre; padding: 2px 0; color: #9aa6bf; }
.aev-tuner-note { padding: 4px 8px; color: #9aa6bf; }
.aev-tuner-copy {
  width: 100%;
  height: 90px;
  background: #0e0f17;
  border: 1px solid #6e7a94;
  resize: none;
}
.aev-tuner-copy[hidden] { display: none; }
`;

let styleInjected = false;

function ensureStyles(): void {
  if (styleInjected) return;
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.appendChild(el);
  styleInjected = true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function physicsOf(def: CharacterDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < PHYSICS_KNOBS.length; i++) {
    const key = PHYSICS_KNOBS[i].key;
    out[key] = def[key];
  }
  return out;
}

function applyNumbers(target: Record<string, number>, source: unknown): void {
  if (!isRecord(source)) return;
  const keys = Object.keys(target);
  for (let i = 0; i < keys.length; i++) {
    const value = source[keys[i]];
    if (typeof value === 'number' && Number.isFinite(value)) target[keys[i]] = value;
  }
}

function applyPhysics(def: CharacterDef, source: unknown): void {
  if (!isRecord(source)) return;
  for (let i = 0; i < PHYSICS_KNOBS.length; i++) {
    const key = PHYSICS_KNOBS[i].key;
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) def[key] = value;
  }
}

/** Everything the panel saves: the four TUNING groups plus the Aeval physics fields. */
function toJson(def: CharacterDef): string {
  return JSON.stringify({
    knockback: TUNING.knockback,
    hitlag: TUNING.hitlag,
    input: TUNING.input,
    camera: TUNING.camera,
    physics: physicsOf(def),
  }, null, 2);
}

export function createTuner(opts: TunerOptions): Tuner {
  ensureStyles();
  const def = CHARACTER_DEFS[CHAR_ID];
  const physicsDefaults = physicsOf(def);
  const refreshers: (() => void)[] = [];
  let readoutTimer = 0;

  const panel = document.createElement('div');
  panel.className = 'aev-tuner';
  panel.hidden = true;

  const title = document.createElement('div');
  title.className = 'aev-tuner-title';
  title.textContent = 'TUNING  F4';
  panel.appendChild(title);

  function group(name: string, open: boolean): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'aev-tuner-group';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'aev-tuner-head';
    const body = document.createElement('div');
    body.className = 'aev-tuner-body';
    body.hidden = !open;
    head.textContent = `${open ? '-' : '+'} ${name}`;
    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      head.textContent = `${body.hidden ? '+' : '-'} ${name}`;
    });
    wrap.appendChild(head);
    wrap.appendChild(body);
    panel.appendChild(wrap);
    return body;
  }

  function row(
    parent: HTMLElement, label: string, read: () => number, write: (value: number) => void,
    min: number, max: number, step: number,
  ): void {
    const decimals = decimalsOf(step);
    const line = document.createElement('div');
    line.className = 'aev-tuner-row';
    const text = document.createElement('span');
    text.textContent = label;
    const range = document.createElement('input');
    range.type = 'range';
    const number = document.createElement('input');
    number.type = 'number';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    number.min = String(min);
    number.max = String(max);
    number.step = String(step);

    const show = (value: number): void => {
      range.value = String(value);
      number.value = value.toFixed(decimals);
    };
    const take = (raw: string): number | null => {
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed)) return null;
      const value = clamp(parsed, min, max);
      write(value);
      return value;
    };

    range.addEventListener('input', () => {
      const value = take(range.value);
      if (value !== null) number.value = value.toFixed(decimals);
    });
    // Half-typed text is not rewritten while the box has focus, or the caret
    // would jump on every keystroke. The box normalizes when it is committed.
    number.addEventListener('input', () => {
      const value = take(number.value);
      if (value !== null) range.value = String(value);
    });
    number.addEventListener('change', () => show(read()));
    show(read());
    refreshers.push(() => show(read()));

    line.appendChild(text);
    line.appendChild(range);
    line.appendChild(number);
    parent.appendChild(line);
  }

  /** Row bound to one numeric field of a TUNING group. */
  function fieldRow(
    parent: HTMLElement, label: string, target: Record<string, number>, key: string,
    min: number, max: number, step: number,
  ): void {
    row(parent, label, () => target[key], (value) => { target[key] = value; }, min, max, step);
  }

  const knockback = group('Knockback', true);
  const kb: Record<string, number> = TUNING.knockback;
  fieldRow(knockback, 'toVel', kb, 'toVel', 0.02, 0.15, 0.005);
  fieldRow(knockback, 'decay', kb, 'decay', 0.01, 0.12, 0.001);
  fieldRow(knockback, 'hitstunPerKb', kb, 'hitstunPerKb', 0.2, 0.7, 0.01);
  fieldRow(knockback, 'tumbleKb', kb, 'tumbleKb', 40, 160, 1);
  fieldRow(knockback, 'damageMul', kb, 'damageMul', 0.5, 2, 0.05);
  fieldRow(knockback, 'kbMul', kb, 'kbMul', 0.5, 2, 0.05);
  fieldRow(knockback, 'sakuraiThresh', kb, 'sakuraiThreshold', 20, 120, 1);

  const hitlag = group('Hitlag', false);
  const hl: Record<string, number> = TUNING.hitlag;
  fieldRow(hitlag, 'base', hl, 'base', 0, 10, 1);
  fieldRow(hitlag, 'perDamage', hl, 'perDamage', 0, 1.5, 0.05);
  fieldRow(hitlag, 'max', hl, 'max', 5, 30, 1);

  const inputGroup = group('Input', false);
  const inp: Record<string, number> = TUNING.input;
  fieldRow(inputGroup, 'buffer', inp, 'buffer', 1, 12, 1);
  fieldRow(inputGroup, 'smashTapWindow', inp, 'smashTapWindow', 2, 12, 1);
  fieldRow(inputGroup, 'dashRetapWindow', inp, 'dashRetapWindow', 6, 24, 1);
  fieldRow(inputGroup, 'chargeMax', inp, 'chargeMax', 20, 120, 1);
  fieldRow(inputGroup, 'chargeBonus', inp, 'chargeBonus', 0, 1, 0.05);

  const camera = group('Camera', false);
  const cam: Record<string, number> = TUNING.camera;
  fieldRow(camera, 'lerp', cam, 'lerp', 0.02, 0.4, 0.01);
  fieldRow(camera, 'zoomMin', cam, 'zoomMin', 0.6, 1.5, 0.05);
  fieldRow(camera, 'zoomMax', cam, 'zoomMax', 1, 3, 0.05);
  fieldRow(camera, 'margin', cam, 'margin', 20, 160, 1);
  fieldRow(camera, 'shakeMax', cam, 'shakeMax', 0, 10, 1);
  fieldRow(camera, 'shakeFrames', cam, 'shakeFrames', 4, 30, 1);

  const physics = group('Aeval physics', false);
  for (let i = 0; i < PHYSICS_KNOBS.length; i++) {
    const knob = PHYSICS_KNOBS[i];
    row(
      physics, knob.key,
      () => def[knob.key], (value) => { def[knob.key] = value; },
      knob.min, knob.max, knob.step,
    );
  }

  const session = group('Session', true);
  const scaleLine = document.createElement('div');
  scaleLine.className = 'aev-tuner-line';
  const scaleLabel = document.createElement('span');
  scaleLabel.textContent = 'time';
  scaleLine.appendChild(scaleLabel);
  const scaleButtons: HTMLButtonElement[] = [];
  for (let i = 0; i < TIME_SCALES.length; i++) {
    const value = TIME_SCALES[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aev-tuner-btn';
    btn.textContent = `${value}x`;
    if (value === 1) btn.classList.add('aev-tuner-btn-on');
    btn.addEventListener('click', () => {
      opts.setTimeScale(value);
      for (let k = 0; k < scaleButtons.length; k++) {
        scaleButtons[k].classList.toggle('aev-tuner-btn-on', scaleButtons[k] === btn);
      }
    });
    scaleButtons.push(btn);
    scaleLine.appendChild(btn);
  }
  session.appendChild(scaleLine);

  const freezeLine = document.createElement('label');
  freezeLine.className = 'aev-tuner-line';
  const freeze = document.createElement('input');
  freeze.type = 'checkbox';
  freeze.addEventListener('change', () => opts.setFreezeCpu(freeze.checked));
  freezeLine.appendChild(freeze);
  const freezeText = document.createElement('span');
  freezeText.textContent = 'freeze CPU';
  freezeLine.appendChild(freezeText);
  session.appendChild(freezeLine);

  const readout = document.createElement('div');
  readout.className = 'aev-tuner-readout';
  readout.textContent = 'no match running';
  session.appendChild(readout);

  const actions = document.createElement('div');
  actions.className = 'aev-tuner-line';
  actions.style.padding = '6px 8px';
  const note = document.createElement('div');
  note.className = 'aev-tuner-note';
  const copyBox = document.createElement('textarea');
  copyBox.className = 'aev-tuner-copy';
  copyBox.hidden = true;

  function refreshAll(): void {
    for (let i = 0; i < refreshers.length; i++) refreshers[i]();
  }

  function button(label: string, onClick: () => void): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aev-tuner-btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    actions.appendChild(btn);
  }

  button('Save', () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, toJson(def));
      note.textContent = 'saved';
    } catch (err) {
      note.textContent = `save failed: ${err instanceof Error ? err.message : 'storage blocked'}`;
    }
  });

  button('Reset all', () => {
    applyNumbers(TUNING.knockback, TUNING_DEFAULTS.knockback);
    applyNumbers(TUNING.hitlag, TUNING_DEFAULTS.hitlag);
    applyNumbers(TUNING.input, TUNING_DEFAULTS.input);
    applyNumbers(TUNING.camera, TUNING_DEFAULTS.camera);
    applyPhysics(def, physicsDefaults);
    let message = 'reset to defaults';
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      message = 'reset, but the saved values could not be cleared';
    }
    refreshAll();
    note.textContent = message;
  });

  button('Copy JSON', () => {
    const text = toJson(def);
    copyBox.hidden = true;
    const fallback = (): void => {
      copyBox.value = text;
      copyBox.hidden = false;
      copyBox.select();
      note.textContent = 'copy failed, select the text below';
    };
    if (navigator.clipboard === undefined) {
      fallback();
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => { note.textContent = 'copied to clipboard'; },
      () => { fallback(); },
    );
  });

  panel.appendChild(actions);
  panel.appendChild(note);
  panel.appendChild(copyBox);

  // Keep typing inside the panel away from the game and the menus.
  const swallow = (e: KeyboardEvent): void => { e.stopPropagation(); };
  panel.addEventListener('keydown', swallow);
  panel.addEventListener('keyup', swallow);

  function updateReadout(): void {
    const state = opts.getState();
    if (state === null) {
      readout.textContent = 'no match running';
      return;
    }
    let text = '';
    for (let i = 0; i < state.fighters.length; i++) {
      const f = state.fighters[i];
      text += `P${f.slot + 1} ${f.action} ${Math.round(f.percent)}% hs${f.hitstun}\n`;
    }
    readout.textContent = text;
  }

  function startReadout(): void {
    if (readoutTimer !== 0) return;
    updateReadout();
    readoutTimer = window.setInterval(updateReadout, READOUT_MS);
  }

  function stopReadout(): void {
    if (readoutTimer === 0) return;
    window.clearInterval(readoutTimer);
    readoutTimer = 0;
  }

  opts.root.appendChild(panel);

  return {
    toggle(): void {
      panel.hidden = !panel.hidden;
      if (panel.hidden) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && panel.contains(active)) active.blur();
        stopReadout();
        return;
      }
      note.textContent = '';
      copyBox.hidden = true;
      refreshAll();
      startReadout();
    },
    visible(): boolean {
      return !panel.hidden;
    },
    applySaved(): void {
      let raw: string | null = null;
      try {
        raw = window.localStorage.getItem(STORAGE_KEY);
      } catch {
        raw = null;
      }
      if (raw === null) return;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;
      applyNumbers(TUNING.knockback, parsed.knockback);
      applyNumbers(TUNING.hitlag, parsed.hitlag);
      applyNumbers(TUNING.input, parsed.input);
      applyNumbers(TUNING.camera, parsed.camera);
      applyPhysics(def, parsed.physics);
      refreshAll();
    },
  };
}
