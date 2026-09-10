import { createLoop } from './core/loop';
import { VIEW_H, VIEW_W } from './core/types';

/**
 * Placeholder entry point. The integration worker replaces this file with
 * the real app state machine.
 */
const canvas = document.getElementById('game') as HTMLCanvasElement;
canvas.width = VIEW_W;
canvas.height = VIEW_H;

const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('2D context unavailable');

function draw(): void {
  if (!ctx) return;
  ctx.fillStyle = '#1a1b26';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.fillStyle = '#c9d1e0';
  ctx.font = '16px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('AEVALRENA scaffold', VIEW_W / 2, VIEW_H / 2);
}

function resize(): void {
  const scale = Math.max(
    1,
    Math.floor(Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H))
  );
  canvas.style.width = `${VIEW_W * scale}px`;
  canvas.style.height = `${VIEW_H * scale}px`;
}

window.addEventListener('resize', resize);
resize();

const loop = createLoop({
  step: () => {},
  render: () => draw(),
  hz: 60,
});
loop.start();
