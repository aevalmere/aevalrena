import type { ControlsConfig } from '../core/types';
import { ACTIONS } from './defaults';

/** Most codes one capture will fold into a chord. A press past this is ignored. */
const MAX_CHORD = 3;

/**
 * True when `slot` is exactly `code` or a chord ('KeyF&KeyJ') containing it as a whole member.
 * Scans in place rather than splitting, so a keydown never allocates.
 */
function slotHasCode(slot: string, code: string): boolean {
  if (slot === code) return true;
  for (let from = 0; ; from++) {
    const at = slot.indexOf(code, from);
    if (at < 0) return false;
    const end = at + code.length;
    const startsMember = at === 0 || slot.charCodeAt(at - 1) === 38 /* '&' */;
    const endsMember = end === slot.length || slot.charCodeAt(end) === 38;
    if (startsMember && endsMember) return true;
    from = at;
  }
}

/**
 * Owns the raw keyboard state for the whole app: which codes are currently held, and which
 * codes were pressed at least once since the last sample (the latch), so a tap between two
 * sim frames is never lost. One instance is shared by the InputSystem and every LocalSession
 * built from it.
 */
export class KeyboardSource {
  readonly held = new Set<string>();
  readonly latch = new Set<string>();

  /**
   * Called on an Escape keydown while no key capture is pending. Returning true consumes the
   * key, so it never reaches held, the latch or any later window listener. The InputSystem
   * uses it to cancel a pad capture.
   */
  onEscape: (() => boolean) | null = null;

  /** Reference count: the InputSystem holds one, every running session holds another. */
  private attachRefs = 0;
  private divertResolve: ((code: string) => void) | null = null;
  private divertReject: ((err: Error) => void) | null = null;
  /** Codes pressed since the current capture started, in press order. Empty when none is pending. */
  private readonly captureDown: string[] = [];

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

  /**
   * Resolves with the next binding the user types: hold keys, release one to bind; codes
   * joined by '&'. Keys already held when the capture starts opened the prompt and are
   * ignored. Backspace and Delete resolve '' (unbind). Escape rejects with Error('cancelled'),
   * and so does starting another listen.
   */
  listenForNextKey(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.cancelListen();
      this.captureDown.length = 0;
      this.divertResolve = resolve;
      this.divertReject = reject;
    });
  }

  /** Rejects a pending listenForNextKey with Error('cancelled'). No-op when none is pending. */
  cancelListen(): void {
    this.settleCapture(null);
  }

  /**
   * Ends a pending capture: `code` resolves it, null rejects it as cancelled. Clears the
   * listening state first, so a resolve handler that starts another capture is not undone.
   */
  private settleCapture(code: string | null): void {
    const resolve = this.divertResolve;
    const reject = this.divertReject;
    this.divertResolve = null;
    this.divertReject = null;
    this.captureDown.length = 0;
    if (code === null) {
      if (reject) reject(new Error('cancelled'));
      return;
    }
    if (resolve) resolve(code);
  }

  isListening(): boolean {
    return this.divertResolve !== null;
  }

  private isBound(code: string): boolean {
    for (const p of this.controls.players) {
      for (const action of ACTIONS) {
        const pair = p.keys[action];
        if (slotHasCode(pair[0], code) || slotHasCode(pair[1], code)) return true;
      }
    }
    return false;
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // This listener is attached before any screen's, and settling a capture clears the
    // screen's capturing flag in a microtask that runs before the next listener. Stopping
    // propagation keeps the key that ended a capture from also driving the screen
    // (Escape leaving Controls, Enter or Space starting a new capture).
    if (this.divertResolve) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') {
        this.settleCapture(null);
      } else if (e.code === 'Backspace' || e.code === 'Delete') {
        this.settleCapture('');
      } else if (!this.held.has(e.code) && this.captureDown.indexOf(e.code) < 0
        && this.captureDown.length < MAX_CHORD) {
        // A key already down when the capture started was used to open the prompt, so it is
        // never part of the chord. The binding settles on the first keyup, not here.
        this.captureDown.push(e.code);
      }
      return;
    }
    if (e.code === 'Escape' && this.onEscape !== null && this.onEscape()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Synthetic events (menu pad navigation dispatches arrows, Enter and Escape on window)
    // drive screens only; they must never reach player inputs.
    if (e.isTrusted === false) return;
    if (this.isTypingTarget(e.target)) return;
    if (e.repeat) return;
    if (this.isBound(e.code)) e.preventDefault();
    this.held.add(e.code);
    this.latch.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    // Releasing any key the capture saw binds every key it saw, in press order. A release of
    // anything else is not part of the chord and only clears `held` below.
    if (this.divertResolve !== null && this.captureDown.indexOf(e.code) >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.settleCapture(this.captureDown.join('&'));
      return;
    }
    if (e.isTrusted === false) return;
    if (this.isTypingTarget(e.target)) return;
    this.held.delete(e.code);
  };

  /** Losing window focus drops all held keys so a stuck key never sticks a held bit. */
  private readonly onBlur = (): void => {
    this.held.clear();
  };
}
