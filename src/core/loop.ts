export interface LoopConfig {
  step: () => void;
  render: (alpha: number) => void;
  hz: number;
}

export interface Loop {
  start(): void;
  stop(): void;
  running(): boolean;
  setPaused(p: boolean): void;
  paused(): boolean;
}

const MAX_ELAPSED_MS = 100;
const MAX_STEPS_PER_FRAME = 4;

export function createLoop(config: LoopConfig): Loop {
  const stepDurationMs = 1000 / config.hz;
  let rafHandle = 0;
  let isRunning = false;
  let isPaused = false;
  let lastTime = 0;
  let accumulatorMs = 0;

  function frame(now: number): void {
    if (!isRunning) return;
    let elapsed = now - lastTime;
    lastTime = now;
    if (elapsed > MAX_ELAPSED_MS) elapsed = MAX_ELAPSED_MS;

    const stepping = !isPaused && !document.hidden;
    if (stepping) {
      accumulatorMs += elapsed;
      let steps = 0;
      while (accumulatorMs >= stepDurationMs && steps < MAX_STEPS_PER_FRAME) {
        config.step();
        accumulatorMs -= stepDurationMs;
        steps++;
      }
    }

    const alpha = clamp01(accumulatorMs / stepDurationMs);
    config.render(alpha);

    rafHandle = requestAnimationFrame(frame);
  }

  function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  return {
    start(): void {
      if (isRunning) return;
      isRunning = true;
      accumulatorMs = 0;
      lastTime = performance.now();
      rafHandle = requestAnimationFrame(frame);
    },
    stop(): void {
      isRunning = false;
      cancelAnimationFrame(rafHandle);
    },
    running(): boolean {
      return isRunning;
    },
    setPaused(p: boolean): void {
      isPaused = p;
    },
    paused(): boolean {
      return isPaused;
    },
  };
}
