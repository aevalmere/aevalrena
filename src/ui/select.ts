import type { MatchConfig } from '../core/types';
import { MAX_PLAYERS } from '../core/types';
import {
  MAX_CPU_LEVEL,
  SLOT_MODE_CYCLE,
  cpuLevelName,
  prettyKey,
  slotLabel,
  type MenuCtx,
  type SlotMode,
} from './context';

const CARD_COUNT = MAX_PLAYERS;
/** Index used for the Start button in the unified focus sequence (0..CARD_COUNT-1 are the cards). */
const START_FOCUS = CARD_COUNT;

/** Per-slot accent colour, used by both the card tag and the draggable marker. */
const SLOT_COLORS = ['#7fb2ff', '#ff7f7f', '#7fff9a', '#ffd97f'];

interface CardRefs {
  root: HTMLElement;
  modeBtn: HTMLButtonElement;
  cpuRow: HTMLElement;
  cpuSlider: HTMLInputElement;
  cpuLabel: HTMLElement;
  keysLine: HTMLElement;
  markerHome: HTMLElement;
  marker: HTMLElement;
}

interface TileRefs {
  root: HTMLElement;
  markers: HTMLElement;
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const { deps, callbacks, state } = ctx;
  const uiRoot = container.parentElement ?? container;

  const panel = document.createElement('div');
  panel.className = 'aev-panel aev-panel-wide';
  container.appendChild(panel);

  const heading = document.createElement('h1');
  heading.className = 'aev-heading';
  heading.textContent = 'Character Select';
  panel.appendChild(heading);

  // ---- Character grid ----

  const grid = document.createElement('div');
  grid.className = 'aev-char-grid';
  panel.appendChild(grid);

  const tiles: TileRefs[] = [];

  deps.characters.forEach((character, index) => {
    const tile = document.createElement('div');
    tile.className = 'aev-char-tile';
    tile.dataset.charIndex = String(index);

    const artWrap = document.createElement('div');
    artWrap.className = 'aev-char-art';
    if (character.icon) {
      const img = document.createElement('img');
      img.className = 'aev-char-img';
      img.src = character.icon;
      img.alt = character.name;
      img.draggable = false;
      artWrap.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'aev-char-placeholder';
      placeholder.textContent = character.name.slice(0, 2).toUpperCase();
      artWrap.appendChild(placeholder);
    }
    tile.appendChild(artWrap);

    const name = document.createElement('div');
    name.className = 'aev-char-name';
    name.textContent = character.name;
    tile.appendChild(name);

    const markers = document.createElement('div');
    markers.className = 'aev-tile-markers';
    tile.appendChild(markers);

    grid.appendChild(tile);
    tiles.push({ root: tile, markers });
  });

  // ---- Player cards ----

  const cardsWrap = document.createElement('div');
  cardsWrap.className = 'aev-cards';
  panel.appendChild(cardsWrap);

  const cards: CardRefs[] = [];

  for (let slot = 0; slot < CARD_COUNT; slot += 1) {
    const root = document.createElement('div');
    root.className = 'aev-card';

    const slotTag = document.createElement('div');
    slotTag.className = 'aev-card-slot';
    slotTag.textContent = `P${slot + 1}`;
    slotTag.style.color = SLOT_COLORS[slot];
    root.appendChild(slotTag);

    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.className = 'aev-card-mode';
    root.appendChild(modeBtn);

    const cpuRow = document.createElement('div');
    cpuRow.className = 'aev-cpu-row';
    const cpuSlider = document.createElement('input');
    cpuSlider.type = 'range';
    cpuSlider.className = 'aev-cpu-slider';
    cpuSlider.min = '1';
    cpuSlider.max = String(MAX_CPU_LEVEL);
    cpuSlider.step = '1';
    const cpuLabel = document.createElement('div');
    cpuLabel.className = 'aev-cpu-label';
    cpuRow.appendChild(cpuSlider);
    cpuRow.appendChild(cpuLabel);
    root.appendChild(cpuRow);

    const keysLine = document.createElement('div');
    keysLine.className = 'aev-card-keys';
    root.appendChild(keysLine);

    const markerHome = document.createElement('div');
    markerHome.className = 'aev-marker-home';
    root.appendChild(markerHome);

    const marker = document.createElement('div');
    marker.className = 'aev-marker';
    marker.textContent = `P${slot + 1}`;
    marker.dataset.slot = String(slot);
    marker.style.background = SLOT_COLORS[slot];
    markerHome.appendChild(marker);

    cardsWrap.appendChild(root);
    cards.push({ root, modeBtn, cpuRow, cpuSlider, cpuLabel, keysLine, markerHome, marker });
  }

  // ---- Stage + start ----

  const stageLine = document.createElement('div');
  stageLine.className = 'aev-stage-line';
  panel.appendChild(stageLine);

  const stageLabel = document.createElement('span');
  stageLabel.textContent = 'Stage:';
  const stagePrev = document.createElement('button');
  stagePrev.type = 'button';
  stagePrev.className = 'aev-stepper-btn';
  stagePrev.textContent = '<';
  const stageName = document.createElement('span');
  stageName.className = 'aev-card-char';
  const stageNext = document.createElement('button');
  stageNext.type = 'button';
  stageNext.className = 'aev-stepper-btn';
  stageNext.textContent = '>';
  stageLine.appendChild(stageLabel);
  stageLine.appendChild(stagePrev);
  stageLine.appendChild(stageName);
  stageLine.appendChild(stageNext);

  const startRow = document.createElement('div');
  startRow.className = 'aev-row';
  panel.appendChild(startRow);
  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'aev-btn aev-btn-accent';
  startBtn.textContent = 'Start';
  startRow.appendChild(startBtn);

  const hint = document.createElement('p');
  hint.className = 'aev-subtext';
  hint.innerHTML = '';
  hint.appendChild(document.createTextNode('Drag a P marker onto a character, or click a card to set Human / CPU / Off'));
  hint.appendChild(document.createElement('br'));
  hint.appendChild(document.createTextNode('Left/Right: slot   Up/Down: character   - / = : CPU level   Enter: cycle / start   Esc: back'));
  panel.appendChild(hint);

  let focusIndex = 0;

  function activeSlotCount(): number {
    return state.slots.filter((s) => s.mode !== 'off').length;
  }

  function clampCharIndex(index: number): number {
    const count = deps.characters.length;
    if (count === 0) return 0;
    return ((index % count) + count) % count;
  }

  /** Put a slot's marker in the tile for its character, or back home when the slot is off. */
  function placeMarker(slot: number): void {
    const s = state.slots[slot];
    const card = cards[slot];
    if (s.mode === 'off') {
      card.markerHome.appendChild(card.marker);
      return;
    }
    const tile = tiles[clampCharIndex(s.charIndex)];
    if (tile) tile.markers.appendChild(card.marker);
    else card.markerHome.appendChild(card.marker);
  }

  function refreshStage(): void {
    const stage = deps.stages[state.stageIndex] ?? deps.stages[0];
    stageName.textContent = stage ? stage.name : 'none';
    const multi = deps.stages.length > 1;
    stagePrev.hidden = !multi;
    stageNext.hidden = !multi;
  }

  function refreshCard(slot: number): void {
    const card = cards[slot];
    const s = state.slots[slot];
    card.modeBtn.textContent = slotLabel(s.mode);
    const active = s.mode !== 'off';
    card.root.classList.toggle('aev-card-dim', !active);
    card.cpuRow.hidden = s.mode !== 'cpu';
    card.keysLine.hidden = s.mode !== 'human';

    if (s.mode === 'cpu') {
      card.cpuSlider.value = String(s.cpuLevel);
      card.cpuLabel.textContent = `Lv ${s.cpuLevel} · ${cpuLevelName(s.cpuLevel)}`;
    }

    if (s.mode === 'human') {
      const bindings = deps.input.controls.players[slot]?.bindings;
      card.keysLine.textContent = bindings
        ? `Atk ${prettyKey(bindings.attack)}  Jump ${prettyKey(bindings.jump)}`
        : '';
    }

    placeMarker(slot);
  }

  function refreshStart(): void {
    startBtn.disabled = activeSlotCount() < 2;
  }

  function updateFocusVisual(): void {
    cards.forEach((c, i) => c.root.classList.toggle('aev-card-selected', i === focusIndex));
    startBtn.classList.toggle('aev-btn-selected', focusIndex === START_FOCUS);
  }

  function refreshAll(): void {
    for (let slot = 0; slot < CARD_COUNT; slot += 1) refreshCard(slot);
    refreshStage();
    refreshStart();
    updateFocusVisual();
  }

  function cycleMode(slot: number, dir: 1 | -1): void {
    const s = state.slots[slot];
    const idx = SLOT_MODE_CYCLE.indexOf(s.mode);
    const nextIdx = (idx + dir + SLOT_MODE_CYCLE.length) % SLOT_MODE_CYCLE.length;
    s.mode = SLOT_MODE_CYCLE[nextIdx] as SlotMode;
    refreshCard(slot);
    refreshStart();
  }

  function setCharacter(slot: number, index: number): void {
    const chars = deps.characters;
    if (chars.length === 0) return;
    const s = state.slots[slot];
    s.charIndex = clampCharIndex(index);
    s.charId = chars[s.charIndex].id;
    refreshCard(slot);
  }

  function cycleCharacter(slot: number, dir: 1 | -1): void {
    if (deps.characters.length <= 1) return;
    setCharacter(slot, state.slots[slot].charIndex + dir);
  }

  function nudgeCpuLevel(slot: number, dir: 1 | -1): void {
    const s = state.slots[slot];
    if (s.mode !== 'cpu') return;
    const next = Math.min(MAX_CPU_LEVEL, Math.max(1, s.cpuLevel + dir));
    if (next === s.cpuLevel) return;
    s.cpuLevel = next;
    refreshCard(slot);
  }

  function cycleStage(dir: 1 | -1): void {
    if (deps.stages.length <= 1) return;
    state.stageIndex = (state.stageIndex + dir + deps.stages.length) % deps.stages.length;
    refreshStage();
  }

  function startMatch(): void {
    if (activeSlotCount() < 2) return;
    const stage = deps.stages[state.stageIndex] ?? deps.stages[0];
    const players: MatchConfig['players'] = [];
    state.slots.forEach((s, slot) => {
      if (s.mode === 'off') return;
      players.push({
        slot,
        charId: s.charId,
        cpu: s.mode === 'cpu',
        cpuLevel: s.mode === 'cpu' ? s.cpuLevel : 0,
      });
    });
    callbacks.startMatch({
      stageId: stage ? stage.id : '',
      players,
      stocks: state.stocks,
      timeLimitSec: 0,
      seed: (Date.now() >>> 0) || 1,
    });
  }

  // ---- Marker dragging (pointer events) ----

  let dragSlot = -1;
  let ghost: HTMLElement | null = null;
  let ghostDx = 0;
  let ghostDy = 0;
  let hoverTile: HTMLElement | null = null;

  function tileUnder(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return (el as HTMLElement).closest('.aev-char-tile');
  }

  function setHoverTile(tile: HTMLElement | null): void {
    if (hoverTile === tile) return;
    if (hoverTile) hoverTile.classList.remove('aev-char-tile-hover');
    hoverTile = tile;
    if (hoverTile) hoverTile.classList.add('aev-char-tile-hover');
  }

  function endDrag(): void {
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    setHoverTile(null);
    if (dragSlot >= 0) cards[dragSlot].marker.classList.remove('aev-marker-dragging');
    dragSlot = -1;
  }

  cards.forEach((card, slot) => {
    ctx.addListener(card.marker, 'click', (e: Event) => e.stopPropagation());
    ctx.addListener(card.marker, 'pointerdown', (e: Event) => {
      const ev = e as PointerEvent;
      if (state.slots[slot].mode === 'off') return;
      ev.preventDefault();
      ev.stopPropagation();
      focusIndex = slot;
      updateFocusVisual();
      dragSlot = slot;
      const rect = card.marker.getBoundingClientRect();
      ghostDx = ev.clientX - rect.left;
      ghostDy = ev.clientY - rect.top;
      ghost = card.marker.cloneNode(true) as HTMLElement;
      ghost.classList.add('aev-marker-ghost');
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      uiRoot.appendChild(ghost);
      card.marker.classList.add('aev-marker-dragging');
      try {
        card.marker.setPointerCapture(ev.pointerId);
      } catch {
        /* pointer capture is best-effort */
      }
    });
  });

  ctx.addListener(window, 'pointermove', (e: Event) => {
    if (dragSlot < 0 || !ghost) return;
    const ev = e as PointerEvent;
    ghost.style.left = `${ev.clientX - ghostDx}px`;
    ghost.style.top = `${ev.clientY - ghostDy}px`;
    setHoverTile(tileUnder(ev.clientX, ev.clientY));
  });

  ctx.addListener(window, 'pointerup', (e: Event) => {
    if (dragSlot < 0) return;
    const ev = e as PointerEvent;
    const slot = dragSlot;
    const tile = tileUnder(ev.clientX, ev.clientY);
    endDrag();
    if (tile && tile.dataset.charIndex !== undefined) {
      setCharacter(slot, Number(tile.dataset.charIndex));
    } else {
      placeMarker(slot);
    }
  });

  ctx.addListener(window, 'pointercancel', () => {
    if (dragSlot < 0) return;
    const slot = dragSlot;
    endDrag();
    placeMarker(slot);
  });

  // ---- Card / button wiring ----

  cards.forEach((card, slot) => {
    ctx.addListener(card.root, 'click', () => {
      focusIndex = slot;
      updateFocusVisual();
      cycleMode(slot, 1);
    });
    ctx.addListener(card.modeBtn, 'click', (e: Event) => {
      e.stopPropagation();
      focusIndex = slot;
      updateFocusVisual();
      cycleMode(slot, 1);
    });
    ctx.addListener(card.cpuSlider, 'pointerdown', (e: Event) => e.stopPropagation());
    ctx.addListener(card.cpuSlider, 'click', (e: Event) => e.stopPropagation());
    ctx.addListener(card.cpuSlider, 'input', () => {
      const s = state.slots[slot];
      const raw = Number(card.cpuSlider.value);
      s.cpuLevel = Math.min(MAX_CPU_LEVEL, Math.max(1, Math.round(raw) || 1));
      card.cpuLabel.textContent = `Lv ${s.cpuLevel} · ${cpuLevelName(s.cpuLevel)}`;
    });
  });

  tiles.forEach((tile, index) => {
    ctx.addListener(tile.root, 'click', () => {
      if (focusIndex >= CARD_COUNT) return;
      if (state.slots[focusIndex].mode === 'off') return;
      setCharacter(focusIndex, index);
    });
  });

  ctx.addListener(stagePrev, 'click', () => cycleStage(-1));
  ctx.addListener(stageNext, 'click', () => cycleStage(1));
  ctx.addListener(startBtn, 'click', () => {
    focusIndex = START_FOCUS;
    updateFocusVisual();
    startMatch();
  });

  ctx.addListener(window, 'keydown', (e: Event) => {
    const ev = e as KeyboardEvent;
    switch (ev.code) {
      case 'ArrowLeft':
        ev.preventDefault();
        focusIndex = (focusIndex - 1 + (CARD_COUNT + 1)) % (CARD_COUNT + 1);
        updateFocusVisual();
        break;
      case 'ArrowRight':
        ev.preventDefault();
        focusIndex = (focusIndex + 1) % (CARD_COUNT + 1);
        updateFocusVisual();
        break;
      case 'ArrowUp':
        ev.preventDefault();
        if (focusIndex < CARD_COUNT) cycleCharacter(focusIndex, -1);
        break;
      case 'ArrowDown':
        ev.preventDefault();
        if (focusIndex < CARD_COUNT) cycleCharacter(focusIndex, 1);
        break;
      case 'Minus':
        if (focusIndex < CARD_COUNT) {
          ev.preventDefault();
          nudgeCpuLevel(focusIndex, -1);
        }
        break;
      case 'Equal':
        if (focusIndex < CARD_COUNT) {
          ev.preventDefault();
          nudgeCpuLevel(focusIndex, 1);
        }
        break;
      case 'Enter':
      case 'Space':
        ev.preventDefault();
        if (focusIndex < CARD_COUNT) cycleMode(focusIndex, 1);
        else startMatch();
        break;
      case 'Escape':
        ev.preventDefault();
        ctx.go('mode');
        break;
      default:
        break;
    }
  });

  refreshAll();
}
