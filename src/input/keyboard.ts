import type { ControlsConfig } from '../core/types';
import { ACTIONS } from './defaults';

/**
 * Owns the raw keyboard state for the whole app: which codes are currently held, and which
 * codes were pressed at least once since the last sample (the latch), so a tap between two
 * sim frames is never lost. One instance is shared by the InputSystem and every LocalSession
 * built from it.
 */
export class KeyboardSource {
  readonly held = new Set<string>();
  readonly latch = new Set<string>();

  /** Reference count: the InputSystem holds one, every running session holds another. */
  private attachRefs = 0;
  private divertResolve: ((code: string) => void) | null = null;
  private divertReject: ((err: Error) => void) | null = null;

  constructor(private readonly controls: ControlsConfig) {}

  attach(): void {
    this.attachRefs++;
    if (this.attachRefs > 1) return;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    if (this.attachRefs === 0) return;
    this.attachRefs--;
    // A stale tap must never carry into whatever runs next.
    this.latch.clear();
    if (this.attachRefs > 0) return;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.held.clear();
  }

  anyKeyDown(): boolean {
    return this.held.size > 0;
  }

  /** Resolves with the next raw keydown code. Escape rejects with Error('cancelled'). */
  listenForNextKey(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.divertReject) this.divertReject(new Error('cancelled'));
      this.divertResolve = resolve;
      this.divertReject = reject;
    });
  }

  private isBound(code: string): boolean {
    for (const p of this.controls.players) {
      for (const action of ACTIONS) {
        if (p.bindings[action] === code) return true;
      }
    }
    return false;
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.divertResolve) {
      const resolve = this.divertResolve;
      const reject = this.divertReject as (err: Error) => void;
      this.divertResolve = null;
      this.divertReject = null;
      e.preventDefault();
      if (e.code === 'Escape') {
        reject(new Error('cancelled'));
      } else {
        resolve(e.code);
      }
      return;
    }
    if (this.isTypingTarget(e.target)) return;
    if (e.repeat) return;
    if (this.isBound(e.code)) e.preventDefault();
    this.held.add(e.code);
    this.latch.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.isTypingTarget(e.target)) return;
    this.held.delete(e.code);
  };

  /** Losing window focus drops all held keys so a stuck key never sticks a held bit. */
  private readonly onBlur = (): void => {
    this.held.clear();
  };
}
