/**
 * Changepoint reset (02 section 6.5, research 31 section 1.6).
 *
 * Two timescales watch the same context rows: a slow table (gammaSlow) and a fast one
 * (gammaFast). After each observation the caller passes the probability each gave to what the
 * opponent actually did. The log-likelihood ratio fast over slow is accumulated with a floor at
 * zero; when it passes 3.0 nats (about ln 20) the opponent has changed: `update` returns true
 * and the caller multiplies its slow counts by RESET_SCALE (0.3). Stock changes and a poisoned
 * prior are softer versions of the same idea.
 */
import type { Changepoint, CreateChangepointFn } from '../contracts';
import { lnDet } from './gating';

/** Nats of evidence that the fast model explains recent play better than the slow one. */
export const CP_THRESHOLD = 3.0;
/** Slow-count multiplier when the reset fires, and the poisoned-prior weight. */
export const RESET_SCALE = 0.3;
/** Count multiplier after a stock is lost or taken. */
export const STOCK_SCALE = 0.7;
/** A stock change within this many frames of the last applied one is not applied again. */
export const STOCK_WINDOW = 600;
/** The poisoned-prior guard looks at the first 30 s of a match. */
export const POISON_WINDOW = 1800;
/** Floor on a probability before its log, so one impossible observation cannot dominate. */
const P_FLOOR = 1e-4;

class Cp implements Changepoint {
  private llr = 0;
  private lastStock = -Infinity;
  private poisonDone = false;
  /** Frame of the last reset, -1 if none. */
  lastReset = -1;
  resets = 0;

  update(pSlow: number, pFast: number, frame: number): boolean {
    const a = pFast > P_FLOOR ? pFast : P_FLOOR;
    const b = pSlow > P_FLOOR ? pSlow : P_FLOOR;
    const v = this.llr + lnDet(a) - lnDet(b);
    this.llr = v > 0 ? v : 0;
    if (this.llr < CP_THRESHOLD) return false;
    this.llr = 0;
    this.lastReset = frame;
    this.resets++;
    return true;
  }

  /**
   * 0.7 when a stock change should down-weight the counts now; 1 when one was already applied
   * within the last 600 frames (a double KO or a trade counts once).
   */
  onStockChange(frame: number): number {
    if (frame - this.lastStock < STOCK_WINDOW) return 1;
    this.lastStock = frame;
    return STOCK_SCALE;
  }

  /**
   * True once, on the first call inside the first 30 s of the match where the evidence against
   * the stored prior (`llrVsPrior`, nats) passes the changepoint threshold. The caller then drops
   * the prior to RESET_SCALE weight. False afterwards and outside the window.
   */
  poisoned(frame: number, llrVsPrior: number): boolean {
    if (this.poisonDone || frame > POISON_WINDOW) return false;
    if (!(llrVsPrior > CP_THRESHOLD)) return false;
    this.poisonDone = true;
    return true;
  }

  /** Current accumulated evidence in nats. */
  evidence(): number { return this.llr; }

  /** Back to the state of a fresh object (a new match). */
  reset(): void {
    this.llr = 0; this.lastStock = -Infinity; this.poisonDone = false; this.lastReset = -1; this.resets = 0;
  }
}

export type ChangepointState = Changepoint & { lastReset: number; resets: number; evidence(): number; reset(): void };

export const createChangepoint: CreateChangepointFn = (): Changepoint => new Cp();

/** Same object with its counters visible, for the predictor and the harness. */
export function createChangepointState(): ChangepointState { return new Cp(); }
