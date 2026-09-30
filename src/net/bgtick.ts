/**
 * A tick source that keeps running while the tab is hidden. requestAnimationFrame stops and
 * page timers drop to about 1 Hz in a background tab, which would stall every other peer of a
 * LAN match at the prediction limit. Timers inside a dedicated Worker are not throttled that
 * way, so a tiny inline Worker posts a message every ~8 ms and the page catches up on sim
 * steps from elapsed time. Falls back to a page setInterval if Workers are unavailable.
 */
export interface BackgroundTicker {
  stop(): void;
}

const WORKER_SRC = 'let h=setInterval(()=>postMessage(0),8);onmessage=()=>{clearInterval(h);close();};';

export function startBackgroundTicker(onTick: () => void): BackgroundTicker {
  let worker: Worker | null = null;
  let url = '';
  let interval = 0;
  try {
    url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = () => onTick();
  } catch {
    worker = null;
    interval = window.setInterval(onTick, 8);
  }
  return {
    stop(): void {
      if (worker !== null) {
        worker.postMessage(0);
        worker.terminate();
        worker = null;
      }
      if (url !== '') URL.revokeObjectURL(url);
      if (interval !== 0) window.clearInterval(interval);
    },
  };
}

export interface WorkerInterval {
  stop(): void;
}

/**
 * `fn` every `ms` from a Worker timer, so it keeps its cadence in a hidden tab (lobby pings and
 * liveness in the in-browser LAN mode). Falls back to a page setInterval.
 */
export function startWorkerInterval(fn: () => void, ms: number): WorkerInterval {
  let worker: Worker | null = null;
  let url = '';
  let interval: ReturnType<typeof setInterval> | 0 = 0;
  try {
    const src = `let h=setInterval(()=>postMessage(0),${Math.max(1, Math.round(ms))});onmessage=()=>{clearInterval(h);close();};`;
    url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = () => fn();
  } catch {
    worker = null;
    interval = setInterval(fn, ms);
  }
  return {
    stop(): void {
      if (worker !== null) {
        worker.postMessage(0);
        worker.terminate();
        worker = null;
      }
      if (url !== '') URL.revokeObjectURL(url);
      url = '';
      if (interval !== 0) clearInterval(interval);
      interval = 0;
    },
  };
}
