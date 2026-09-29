import type { GameState } from '../core/types';

/**
 * Pooled game state snapshots for rollback, without knowing the sim's field list.
 *
 * `copyInto(dst, src)` makes `dst` a deep structural copy of `src`, reusing every object and
 * array already inside `dst` that this module created (the "owned" set). An object it did not
 * create, such as a character def the sim points at from a fighter, is never written through:
 * it is replaced by a fresh owned copy. After warm up a save or a restore allocates nothing,
 * except when an array grows past its previous high water mark.
 */

type Obj = Record<string, unknown>;

const owned = new WeakSet<object>();

function isObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null;
}

function fresh(src: object): object {
  const out: object = Array.isArray(src) ? [] : {};
  owned.add(out);
  return out;
}

function copyValue(dstSlot: unknown, src: unknown): unknown {
  if (!isObject(src)) return src;
  let dst = dstSlot;
  if (!isObject(dst) || !owned.has(dst) || Array.isArray(dst) !== Array.isArray(src) || dst === src) {
    dst = fresh(src);
  }
  copyInto(dst as object, src);
  return dst;
}

function copyInto(dst: object, src: object): void {
  if (Array.isArray(src)) {
    const d = dst as unknown[];
    const n = src.length;
    for (let i = 0; i < n; i++) d[i] = copyValue(d[i], src[i]);
    d.length = n;
    return;
  }
  const d = dst as Obj;
  const s = src as Obj;
  for (const k in d) {
    if (!(k in s)) delete d[k];
  }
  for (const k in s) d[k] = copyValue(d[k], s[k]);
}

/** Deep copy `src` into `dst` (which must come from `newSnapshot` or an earlier copy). */
export function copyStateInto(dst: GameState, src: GameState): void {
  copyInto(dst, src);
}

/** A new owned, empty snapshot to copy into. */
export function newSnapshot(): GameState {
  const s = {} as GameState;
  owned.add(s);
  return s;
}

/**
 * Makes `live` (the object the sim steps and the renderer reads) take the contents of `snap`,
 * keeping the `live` object identity. Nested objects of `live` that the sim created are
 * replaced, owned ones are reused.
 */
export function restoreInto(live: GameState, snap: GameState): void {
  copyInto(live, snap);
}

/** Ring of pooled snapshots indexed by frame. */
export class StateRing {
  private readonly slots: GameState[] = [];
  private readonly frames: Int32Array;

  constructor(readonly size: number) {
    this.frames = new Int32Array(size).fill(-1);
    for (let i = 0; i < size; i++) this.slots.push(newSnapshot());
  }

  save(frame: number, state: GameState): void {
    const i = frame % this.size;
    copyStateInto(this.slots[i], state);
    this.frames[i] = frame;
  }

  has(frame: number): boolean {
    return frame >= 0 && this.frames[frame % this.size] === frame;
  }

  get(frame: number): GameState | null {
    return this.has(frame) ? this.slots[frame % this.size] : null;
  }
}
