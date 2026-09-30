import type { GameState } from '../core/types';
import { FS_METER } from '../core/constants';
import { percentColor } from '../render/colors';
import { setVariantSrc } from '../render/varianticon';
import { iconAsset, playerAccentVars, playerTag, uiAsset } from './theme';

/**
 * In-match DOM HUD (docs/UI_STYLE.md section 5). One card per fighter along the bottom of
 * the canvas box. The host is a `container-type: size` element sized to the canvas by
 * main.ts, so every length here is in cqw and scales with the game view. `--s` shrinks a
 * card from 27cqw to 23cqw when four fighters share the row.
 */

export interface HudDeps {
  characters: { id: string; name: string; icon?: string }[];
}

/**
 * Where the world sits on the canvas this frame, for the floating name tags: the camera
 * centre and zoom (world px to logical px) and the logical view size, plus the integer CSS
 * scale of the canvas. The host box is viewW * scale by viewH * scale CSS px.
 */
export interface HudView {
  camX: number;
  camY: number;
  zoom: number;
  viewW: number;
  viewH: number;
  scale: number;
}

export interface Hud {
  start(state: GameState): void;
  /** `view` places the name tags; without it they stay where they were last drawn. */
  update(state: GameState, view?: HudView): void;
  stop(): void;
}

/** Name tag anchor: world px above a fighter's feet (the top of the head plus a gap). */
const TAG_HEAD_Y = 44;
/** Eased follow time constant in ms: settles in about 80 ms, so hitlag shakes do not jitter it. */
const TAG_FOLLOW_MS = 30;
/** Keep tags this many CSS px inside the canvas box. */
const TAG_EDGE = 6;
/** CSS px kept between two tags that would otherwise overlap. */
const TAG_GAP = 2;
/** Card row height plus its inset, in cqw: tags never sit on the player cards. */
const TAG_CARD_ROW_CQW = 16.5;

/** Fighter is reeling or KO'd, so its tag fades to 40%. */
function reeling(action: string, hitstun: number): boolean {
  return hitstun > 0 || action === 'hitstun' || action === 'tumble' || action === 'dead';
}

export const HUD_CSS = `
#hud .hud-row {
  --s: 1;
  position: absolute;
  left: 0;
  right: 0;
  bottom: 1cqw;
  display: flex;
  justify-content: center;
  align-items: flex-end;
  gap: 1.5cqw;
  pointer-events: none;
}
#hud .hud-row.hud-row-4 { --s: 0.852; }
#hud .hud-card {
  position: relative;
  flex: 0 0 auto;
  width: calc(27cqw * var(--s));
  height: calc(15cqw * var(--s));
  color: var(--text);
  transition: opacity 200ms ease-out, filter 200ms ease-out;
}
#hud .hud-card.hud-ko {
  opacity: 0.35;
  filter: grayscale(1);
}
#hud .hud-portrait {
  position: absolute;
  left: 0;
  bottom: 0;
  width: calc(13cqw * var(--s));
  height: calc(15cqw * var(--s));
}
#hud .hud-ring {
  position: absolute;
  left: 0;
  bottom: 0;
  width: calc(13cqw * var(--s));
  height: calc(13cqw * var(--s));
  background: var(--accent);
  -webkit-mask-image: url("${uiAsset('ring-hud.png')}");
  mask-image: url("${uiAsset('ring-hud.png')}");
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  filter: drop-shadow(0 0 calc(0.5cqw * var(--s)) color-mix(in srgb, var(--accent) 60%, transparent));
}
#hud .hud-face {
  position: absolute;
  left: 50%;
  bottom: calc(4.2cqw * var(--s));
  width: calc(9cqw * var(--s));
  height: calc(9cqw * var(--s));
  transform: translateX(-47%);
  object-fit: contain;
  object-position: 50% 100%;
  image-rendering: pixelated;
  -webkit-mask-image: linear-gradient(180deg, #000 78%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 78%, transparent 100%);
}
#hud .hud-face-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: calc(6cqw * var(--s));
  color: var(--accent);
}
#hud .hud-info {
  position: absolute;
  left: calc(11.5cqw * var(--s));
  right: 0;
  bottom: calc(1cqw * var(--s));
  isolation: isolate;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: calc(0.6cqw * var(--s)) 0 calc(0.4cqw * var(--s)) calc(1cqw * var(--s));
}
#hud .hud-info::before {
  content: "";
  position: absolute;
  inset: -25% -12% -20% -18%;
  z-index: -1;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--ink) 66%, transparent) 35%, color-mix(in srgb, var(--ink) 30%, transparent) 70%, transparent);
}
#hud .hud-pct {
  display: flex;
  align-items: baseline;
  font-family: var(--font-display);
  font-weight: 600;
  line-height: 0.9;
  font-variant-numeric: lining-nums;
  white-space: nowrap;
  transform-origin: 0 100%;
  text-shadow: 0 0 calc(0.6cqw * var(--s)) rgba(0, 0, 0, 0.85), 0 0 calc(0.25cqw * var(--s)) rgba(0, 0, 0, 0.9);
}
#hud .hud-pct-int { font-size: calc(6.5cqw * var(--s)); }
#hud .hud-pct-dec { font-size: calc(3.2cqw * var(--s)); margin-left: calc(0.15cqw * var(--s)); }
#hud .hud-pct.hud-pop-a { animation: hud-pop-a 160ms ease-out; }
#hud .hud-pct.hud-pop-b { animation: hud-pop-b 160ms ease-out; }
@keyframes hud-pop-a { from { transform: scale(1.3); } to { transform: scale(1); } }
@keyframes hud-pop-b { from { transform: scale(1.3); } to { transform: scale(1); } }
#hud .hud-underline {
  align-self: stretch;
  height: max(1px, calc(0.13cqw * var(--s)));
  margin: calc(0.35cqw * var(--s)) 0 calc(0.45cqw * var(--s)) calc(-0.6cqw * var(--s));
  background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 55%, transparent) 60%, transparent);
  box-shadow: 0 0 calc(0.4cqw * var(--s)) color-mix(in srgb, var(--accent) 55%, transparent);
}
#hud .hud-name {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: calc(1.9cqw * var(--s));
  letter-spacing: 0.25em;
  text-transform: uppercase;
  line-height: 1.05;
  white-space: nowrap;
  text-shadow: 0 0 calc(0.35cqw * var(--s)) rgba(0, 0, 0, 0.95);
}
#hud .hud-tag {
  font-family: var(--font-ui);
  font-size: calc(1.2cqw * var(--s));
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--accent);
  line-height: 1.4;
  white-space: nowrap;
  text-shadow: 0 0 calc(0.5cqw * var(--s)) color-mix(in srgb, var(--accent) 55%, transparent), 0 0 calc(0.2cqw * var(--s)) rgba(0, 0, 0, 0.9);
}
#hud .hud-stocks {
  display: flex;
  gap: calc(0.3cqw * var(--s));
  margin-top: calc(0.3cqw * var(--s));
}
#hud .hud-stock {
  width: calc(2cqw * var(--s));
  height: calc(2cqw * var(--s));
  object-fit: contain;
  image-rendering: pixelated;
  filter: drop-shadow(0 0 calc(0.15cqw * var(--s)) rgba(0, 0, 0, 0.9));
}
#hud span.hud-stock {
  background: var(--accent);
  clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
}
#hud .hud-stock.hud-stock-lost {
  opacity: 0.25;
  filter: grayscale(1) brightness(0.7);
}
#hud .hud-meter {
  position: relative;
  align-self: stretch;
  height: calc(0.5cqw * var(--s));
  margin-top: calc(0.45cqw * var(--s));
  margin-right: calc(1cqw * var(--s));
  background: color-mix(in srgb, var(--accent) 18%, rgba(0, 0, 0, 0.6));
  overflow: hidden;
}
#hud .hud-meter-fill {
  height: 100%;
  width: 0;
  background: var(--accent);
}
#hud .hud-meter.hud-meter-full .hud-meter-fill {
  animation: hud-meter-pulse 0.5s ease-in-out infinite alternate;
}
/* ---- Floating name tags (docs/UI_STYLE.md 5.1) ---- */
#hud .hud-ntags {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
#hud .hud-ntag {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: max(1px, 0.2cqw);
  will-change: transform;
  transition: opacity 140ms ease-out;
}
#hud .hud-ntag[hidden] { display: none; }
#hud .hud-ntag.hud-ntag-dim { opacity: 0.4; }
#hud .hud-ntag-label {
  position: relative;
  isolation: isolate;
  padding: max(1px, 0.2cqw) max(4px, 0.5cqw) max(1px, 0.15cqw) calc(max(4px, 0.5cqw) + 0.3em);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: max(18px, 1.78cqw);
  line-height: 1.1;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  white-space: nowrap;
  color: color-mix(in srgb, var(--accent) 88%, #fff);
  text-shadow: 0 0 max(8px, 0.75cqw) color-mix(in srgb, var(--accent) 80%, transparent), 0 0 max(2px, 0.2cqw) rgba(0, 0, 0, 0.95);
}
#hud .hud-ntag-label::before {
  content: "";
  position: absolute;
  inset: -30% -8%;
  z-index: -1;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--ink) 55%, transparent) 40%, transparent);
}
#hud .hud-ntag-chev {
  width: max(14px, 1.4cqw);
  height: max(8px, 0.85cqw);
  /* Filters run before clip-path, so the V is cut on ::before and the glow sits on the box. */
  filter: drop-shadow(0 0 max(4px, 0.4cqw) color-mix(in srgb, var(--accent) 85%, transparent));
}
#hud .hud-ntag-chev::before {
  content: "";
  display: block;
  width: 100%;
  height: 100%;
  background: var(--accent);
  clip-path: polygon(0 0, 50% 58%, 100% 0, 100% 42%, 50% 100%, 0 42%);
}
@media (prefers-reduced-motion: reduce) {
  #hud .hud-ntag { transition: none; }
}
@keyframes hud-meter-pulse {
  from { background: var(--accent); box-shadow: none; }
  to { background: #ffffff; box-shadow: 0 0 0.6cqw #ffffff; }
}
`;

interface CardRefs {
  card: HTMLElement;
  pct: HTMLElement;
  pctInt: HTMLElement;
  pctDec: HTMLElement;
  stocks: HTMLElement[];
  meter: HTMLElement | null;
  meterFill: HTMLElement | null;
  /** Last shown percent in tenths, -1 before the first write. */
  lastTenths: number;
  lastColor: string;
  lastStocks: number;
  lastMeter: number;
  lastMeterFull: boolean;
  popFlip: boolean;
}

interface TagRefs {
  root: HTMLElement;
  /** Eased CSS px position of the tag's anchor (chevron tip); NaN until first placed. */
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  /** This frame's clamped target in CSS px, before easing. */
  tx: number;
  ty: number;
  /** Measured CSS px size, 0 until measured. */
  w: number;
  h: number;
  shown: boolean;
  dim: boolean;
}

interface CharArt {
  name: string;
  icon: string | null;
  bust: string | null;
  stock: string | null;
}

function el(tag: string, className: string, parent: HTMLElement | null): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (parent !== null) parent.appendChild(node);
  return node;
}

/**
 * An <img> showing `src` in colour `variant` (src/render/palette.ts) that falls back once to
 * `fallback` if `src` fails to load.
 */
function img(className: string, src: string, fallback: string, parent: HTMLElement, variant: number): HTMLImageElement {
  const node = document.createElement('img');
  node.className = className;
  node.alt = '';
  node.draggable = false;
  if (src !== fallback) {
    node.onerror = (): void => {
      node.onerror = null;
      setVariantSrc(node, fallback, variant);
    };
  }
  setVariantSrc(node, src, variant);
  parent.appendChild(node);
  return node;
}

export function createHud(host: HTMLElement, deps: HudDeps): Hud {
  let cards: CardRefs[] = [];

  function charInfo(id: string): CharArt {
    for (let i = 0; i < deps.characters.length; i++) {
      const c = deps.characters[i];
      if (c.id !== id) continue;
      if (c.icon === undefined) return { name: c.name, icon: null, bust: null, stock: null };
      // icons/<char>.png -> icons/<char>-bust.png and -stock.png (tools/uicut/portrait.py).
      return {
        name: c.name,
        icon: iconAsset(c.icon),
        bust: iconAsset(c.icon.replace(/\.png$/, '-bust.png')),
        stock: iconAsset(c.icon.replace(/\.png$/, '-stock.png')),
      };
    }
    return { name: id, icon: null, bust: null, stock: null };
  }

  function buildCard(row: HTMLElement, state: GameState, index: number): CardRefs {
    const fighter = state.fighters[index];
    const info = charInfo(fighter.charId);

    const card = el('div', 'hud-card', row);
    card.setAttribute('style', playerAccentVars(state.config.players, fighter.slot));

    const portrait = el('div', 'hud-portrait', card);
    el('div', 'hud-ring', portrait);
    if (info.icon !== null && info.bust !== null) {
      img('hud-face', info.bust, info.icon, portrait, fighter.variant);
    } else {
      const face = el('div', 'hud-face hud-face-fallback', portrait);
      face.textContent = info.name.slice(0, 1);
    }

    const infoEl = el('div', 'hud-info', card);
    const pct = el('div', 'hud-pct', infoEl);
    const pctInt = el('span', 'hud-pct-int', pct);
    const pctDec = el('span', 'hud-pct-dec', pct);
    el('div', 'hud-underline', infoEl);
    const name = el('div', 'hud-name', infoEl);
    name.textContent = info.name;
    const tag = el('div', 'hud-tag', infoEl);
    tag.textContent = playerTag(state.config.players, fighter.slot);

    const stockRow = el('div', 'hud-stocks', infoEl);
    const stockCount = Math.max(state.config.stocks, fighter.stocks);
    const stocks: HTMLElement[] = [];
    for (let s = 0; s < stockCount; s++) {
      if (info.icon !== null && info.stock !== null) {
        stocks.push(img('hud-stock', info.stock, info.icon, stockRow, fighter.variant));
      } else {
        stocks.push(el('span', 'hud-stock', stockRow));
      }
    }

    let meter: HTMLElement | null = null;
    let meterFill: HTMLElement | null = null;
    if (state.config.finalSmash === true) {
      meter = el('div', 'hud-meter', infoEl);
      meterFill = el('div', 'hud-meter-fill', meter);
    }

    return {
      card, pct, pctInt, pctDec, stocks, meter, meterFill,
      lastTenths: -1, lastColor: '', lastStocks: -1, lastMeter: -1, lastMeterFull: false, popFlip: false,
    };
  }

  function writeCard(refs: CardRefs, state: GameState, index: number, pop: boolean): void {
    const fighter = state.fighters[index];

    const tenths = Math.max(0, Math.floor(fighter.percent * 10 + 1e-6));
    if (tenths !== refs.lastTenths) {
      const hadValue = refs.lastTenths >= 0;
      refs.lastTenths = tenths;
      refs.pctInt.textContent = String(Math.floor(tenths / 10));
      refs.pctDec.textContent = `.${tenths % 10}%`;
      const color = percentColor(Math.floor(fighter.percent));
      if (color !== refs.lastColor) {
        refs.lastColor = color;
        refs.pct.style.color = color;
      }
      if (pop && hadValue) {
        // Two identical keyframes under different names: swapping restarts the pop without a reflow.
        refs.popFlip = !refs.popFlip;
        refs.pct.classList.remove(refs.popFlip ? 'hud-pop-b' : 'hud-pop-a');
        refs.pct.classList.add(refs.popFlip ? 'hud-pop-a' : 'hud-pop-b');
      }
    }

    if (fighter.stocks !== refs.lastStocks) {
      refs.lastStocks = fighter.stocks;
      for (let s = 0; s < refs.stocks.length; s++) {
        refs.stocks[s].classList.toggle('hud-stock-lost', s >= fighter.stocks);
      }
      refs.card.classList.toggle('hud-ko', fighter.stocks <= 0);
    }

    if (refs.meter !== null && refs.meterFill !== null) {
      const meter = Math.max(0, Math.min(FS_METER.max, fighter.fsMeter));
      if (meter !== refs.lastMeter) {
        refs.lastMeter = meter;
        refs.meterFill.style.width = `${(meter / FS_METER.max) * 100}%`;
        const full = meter >= FS_METER.max;
        if (full !== refs.lastMeterFull) {
          refs.lastMeterFull = full;
          refs.meter.classList.toggle('hud-meter-full', full);
        }
      }
    }
  }

  let tags: TagRefs[] = [];
  let lastTagTime = -1;
  let lastHostW = -1;

  function buildTag(layer: HTMLElement, state: GameState, index: number): TagRefs {
    const fighter = state.fighters[index];
    const root = el('div', 'hud-ntag', layer);
    root.setAttribute('style', playerAccentVars(state.config.players, fighter.slot));
    const label = el('div', 'hud-ntag-label', root);
    label.textContent = playerTag(state.config.players, fighter.slot);
    el('div', 'hud-ntag-chev', root);
    root.hidden = true;
    return {
      root, x: Number.NaN, y: Number.NaN, lastX: Number.NaN, lastY: Number.NaN,
      tx: 0, ty: 0, w: 0, h: 0, shown: false, dim: false,
    };
  }

  /**
   * Places every name tag over its fighter's head: world to CSS px through the camera,
   * clamped inside the canvas box and above the card row, then eased toward that point.
   * Tag sizes are measured only when a tag appears or the view is resized.
   */
  function placeTags(state: GameState, view: HudView): void {
    const now = performance.now();
    const dt = lastTagTime < 0 ? 0 : Math.min(100, now - lastTagTime);
    lastTagTime = now;
    const follow = dt <= 0 ? 1 : 1 - Math.exp(-dt / TAG_FOLLOW_MS);
    const hostW = view.viewW * view.scale;
    const hostH = view.viewH * view.scale;
    const resized = hostW !== lastHostW;
    lastHostW = hostW;
    const cqw = hostW / 100;
    const count = Math.min(tags.length, state.fighters.length);
    for (let i = 0; i < count; i++) {
      const t = tags[i];
      const f = state.fighters[i];
      // Out of stocks: the fighter is parked far outside the blast zone, so the tag goes.
      const show = f.stocks > 0;
      if (show !== t.shown) {
        t.shown = show;
        t.root.hidden = !show;
        t.x = Number.NaN;
        t.w = 0;
      }
      if (!show) continue;
      const dim = reeling(f.action, f.hitstun);
      if (dim !== t.dim) {
        t.dim = dim;
        t.root.classList.toggle('hud-ntag-dim', dim);
      }
      if (t.w === 0 || resized) {
        t.w = t.root.offsetWidth;
        t.h = t.root.offsetHeight;
      }
      let tx = ((f.x - view.camX) * view.zoom + view.viewW / 2) * view.scale;
      let ty = ((f.y - TAG_HEAD_Y - view.camY) * view.zoom + view.viewH / 2) * view.scale;
      const minX = TAG_EDGE + t.w / 2;
      const maxX = hostW - TAG_EDGE - t.w / 2;
      const minY = TAG_EDGE + t.h;
      const maxY = Math.max(minY, hostH - TAG_CARD_ROW_CQW * cqw);
      t.tx = tx < minX ? minX : tx > maxX ? maxX : tx;
      t.ty = ty < minY ? minY : ty > maxY ? maxY : ty;
    }

    // Fighters standing together would stack their tags on one line: a later tag that
    // overlaps an earlier one steps up above it (or below, when there is no room above).
    for (let j = 1; j < count; j++) {
      const b = tags[j];
      if (!b.shown) continue;
      for (let i = 0; i < j; i++) {
        const a = tags[i];
        if (!a.shown) continue;
        if (Math.abs(a.tx - b.tx) >= (a.w + b.w) / 2 + TAG_GAP) continue;
        if (Math.abs(a.ty - b.ty) >= Math.max(a.h, b.h) + TAG_GAP) continue;
        const up = a.ty - a.h - TAG_GAP;
        b.ty = up - b.h >= TAG_EDGE ? up : a.ty + b.h + TAG_GAP;
      }
    }

    for (let i = 0; i < count; i++) {
      const t = tags[i];
      if (!t.shown) continue;
      if (Number.isNaN(t.x)) {
        t.x = t.tx;
        t.y = t.ty;
      } else {
        t.x += (t.tx - t.x) * follow;
        t.y += (t.ty - t.y) * follow;
      }
      const rx = Math.round(t.x * 10) / 10;
      const ry = Math.round(t.y * 10) / 10;
      if (rx !== t.lastX || ry !== t.lastY) {
        t.lastX = rx;
        t.lastY = ry;
        t.root.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -100%)`;
      }
    }
  }

  return {
    start(state: GameState): void {
      host.textContent = '';
      cards = [];
      tags = [];
      lastTagTime = -1;
      lastHostW = -1;
      const tagLayer = el('div', 'hud-ntags', host);
      for (let i = 0; i < state.fighters.length; i++) tags.push(buildTag(tagLayer, state, i));
      const row = el('div', state.fighters.length >= 4 ? 'hud-row hud-row-4' : 'hud-row', host);
      for (let i = 0; i < state.fighters.length; i++) {
        const refs = buildCard(row, state, i);
        writeCard(refs, state, i, false);
        cards.push(refs);
      }
    },

    update(state: GameState, view?: HudView): void {
      const count = Math.min(cards.length, state.fighters.length);
      for (let i = 0; i < count; i++) writeCard(cards[i], state, i, true);
      if (view !== undefined) placeTags(state, view);
    },

    stop(): void {
      host.textContent = '';
      cards = [];
      tags = [];
      lastTagTime = -1;
      lastHostW = -1;
    },
  };
}
