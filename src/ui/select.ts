import type { MatchConfig } from '../core/types';
import { MAX_PLAYERS } from '../core/types';
import {
  MAX_CPU_LEVEL,
  MIN_CPU_LEVEL,
  SLOT_MODE_CYCLE,
  cpuLevelName,
  prettyKey,
  slotLabel,
  type MenuCtx,
  type SlotMode,
} from './context';
import { PLAYER_ACCENTS, TEAM_NAMES, accentVars, iconAsset, uiAsset } from './theme';

const CARD_COUNT = MAX_PLAYERS;
/** localStorage key for the typed human names, one per slot. */
const NAMES_KEY = 'aevalrena.names.v1';
/** Longest name a human can type. */
export const NAME_MAX = 12;
/** Anything outside letters, digits, space and a few symbols is dropped while typing. */
const NAME_STRIP = /[^A-Z0-9 .\-_!?#&'+*]/g;

/** Uppercase, allowed characters only, at most NAME_MAX long. Keeps inner spaces. */
export function cleanName(raw: string): string {
  return raw.toUpperCase().replace(NAME_STRIP, '').slice(0, NAME_MAX);
}

function defaultName(slot: number): string {
  return `P${slot + 1}`;
}

function loadNames(): string[] {
  const out: string[] = [];
  for (let i = 0; i < CARD_COUNT; i += 1) out.push(defaultName(i));
  try {
    const raw = localStorage.getItem(NAMES_KEY);
    if (raw === null) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return out;
    for (let i = 0; i < CARD_COUNT; i += 1) {
      const v: unknown = parsed[i];
      if (typeof v !== 'string') continue;
      const name = cleanName(v).trim();
      if (name !== '') out[i] = name;
    }
  } catch {
    /* storage blocked or corrupt: defaults */
  }
  return out;
}

function saveNames(names: string[]): void {
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify(names));
  } catch {
    /* storage blocked or full: names last for this session only */
  }
}
/** Index used for the Start button in the unified focus sequence (0..CARD_COUNT-1 are the cards). */
const START_FOCUS = CARD_COUNT;

/** Character select (docs/UI_STYLE.md section 4.3). */
export const CSS = `
.aev-screen-select .sel-panel {
  width: min(1120px, 94vw);
  max-height: 94vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1.3rem 1.8rem 1.1rem;
}
.sel-panel .ui-header { display: flex; align-items: center; }
.sel-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
}
.sel-tile {
  --chamfer: 10px;
  width: 128px;
  padding: 0.6rem 0.6rem 0.45rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
  background: color-mix(in srgb, var(--accent) 55%, transparent);
  transition: background-color 120ms ease-out;
}
.sel-tile:hover, .sel-tile.sel-tile-hover { background: var(--accent); }
.sel-tile.sel-tile-hover::before { background: color-mix(in srgb, var(--accent) 22%, var(--panel)); }
.sel-tile-art {
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sel-tile-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.sel-tile-placeholder {
  font-family: var(--font-display);
  font-size: 2.2rem;
  color: var(--accent);
}
.sel-tile-name {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 1.05rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text);
  text-shadow: var(--glow);
}
.sel-tile-markers {
  display: flex;
  gap: 4px;
  min-height: 20px;
  flex-wrap: wrap;
  justify-content: center;
}

.sel-cards {
  display: grid;
  grid-template-columns: repeat(${CARD_COUNT}, minmax(0, 1fr));
  gap: 0.9rem;
}
.sel-card {
  cursor: pointer;
  transition: opacity 120ms ease-out, filter 120ms ease-out;
}
.sel-card.sel-card-off { opacity: 0.4; filter: grayscale(0.85); }
.sel-card.sel-card-focus {
  filter: drop-shadow(0 0 7px color-mix(in srgb, var(--accent) 70%, transparent));
}
.sel-card.sel-card-off.sel-card-focus { opacity: 0.65; }
.sel-card-frame {
  --chamfer: 14px;
  height: 100%;
  padding: 0.8rem 0.9rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  background: color-mix(in srgb, var(--accent) 60%, transparent);
}
.sel-card-frame::before {
  background:
    radial-gradient(ellipse at 20% 30%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 65%),
    color-mix(in srgb, var(--panel) 94%, var(--accent));
}
.sel-card-focus .sel-card-frame { --line: 2.5px; background: var(--accent); }
.sel-card-focus .sel-card-frame::before { background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
.sel-card-top {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.sel-portrait {
  position: relative;
  flex: 0 0 auto;
  width: 74px;
  height: 81px;
}
.sel-ring {
  position: absolute;
  inset: 0;
  background: var(--accent);
  -webkit-mask-image: url("${uiAsset('ring-hud.png')}");
  mask-image: url("${uiAsset('ring-hud.png')}");
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--accent) 60%, transparent));
}
.sel-face {
  position: absolute;
  left: 50%;
  top: 52%;
  width: 56px;
  height: 56px;
  transform: translate(-50%, -50%);
}
.sel-face img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.sel-face-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: 1.8rem;
  color: var(--accent);
}
.sel-card-info {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.sel-card-name {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 1.35rem;
  line-height: 1.05;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text);
  text-shadow: var(--glow);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sel-card-underline {
  height: 1px;
  width: 100%;
  background: linear-gradient(90deg, var(--accent), transparent);
}
.sel-card-mode {
  align-self: flex-start;
  --chamfer: 7px;
  padding: 0.3rem 0.9rem;
  font-size: 0.75rem;
}
.sel-id-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-height: 24px;
}
.sel-swatch {
  --chamfer: 6px;
  flex: 0 0 auto;
  width: 30px;
  height: 20px;
  padding: 0;
  border: 0;
  cursor: pointer;
  transition: filter 120ms ease-out;
}
.sel-swatch::before {
  background: linear-gradient(135deg, var(--accent) 20%, color-mix(in srgb, var(--accent) 45%, var(--panel)));
}
.sel-swatch:hover, .sel-swatch:focus-visible {
  outline: none;
  filter: drop-shadow(0 0 5px color-mix(in srgb, var(--accent) 75%, transparent));
}
.sel-swatch[hidden] { display: none; }
.sel-name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0.15rem 0.1rem 0.1rem;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text);
  background: transparent;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 0;
  outline: none;
  cursor: text;
  transition: border-color 120ms ease-out, color 120ms ease-out;
}
.sel-name[hidden] { display: none; }
.sel-name:hover { border-bottom-color: color-mix(in srgb, var(--accent) 70%, transparent); }
.sel-name:focus {
  color: var(--accent);
  border-bottom-color: var(--accent);
  text-shadow: var(--glow);
  box-shadow: 0 1px 0 0 color-mix(in srgb, var(--accent) 55%, transparent);
}
.sel-cpu-row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.sel-marker-home {
  min-height: 20px;
  display: flex;
}

.sel-marker {
  --chamfer: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 7px 1px;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  color: var(--ink);
  background: var(--accent);
  clip-path: polygon(var(--chamfer) 0, 100% 0, 100% calc(100% - var(--chamfer)), calc(100% - var(--chamfer)) 100%, 0 100%, 0 var(--chamfer));
  cursor: grab;
  touch-action: none;
}
.sel-card-off .sel-marker { cursor: default; }
.sel-marker.sel-marker-dragging { opacity: 0.3; }
.sel-marker.sel-marker-ghost {
  position: fixed;
  z-index: 50;
  pointer-events: none;
  cursor: grabbing;
  opacity: 0.9;
}

.sel-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.sel-stage {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.sel-stage-name { color: var(--text); text-shadow: var(--glow); min-width: 8em; text-align: center; }
.sel-chev {
  --chamfer: 6px;
  padding: 0.15rem 0.6rem;
  font-size: 0.9rem;
  letter-spacing: 0;
}
.sel-start { padding: 0.6rem 2.4rem; }
.sel-hint {
  margin: 0;
  opacity: 0.6;
  white-space: normal;
  line-height: 1.7;
  font-size: 0.62rem;
}
`;

interface CardRefs {
  root: HTMLElement;
  swatch: HTMLButtonElement;
  nameInput: HTMLInputElement;
  face: HTMLElement;
  name: HTMLElement;
  tagLine: HTMLElement;
  modeBtn: HTMLButtonElement;
  cpuRow: HTMLElement;
  cpuSlider: HTMLInputElement;
  cpuLabel: HTMLElement;
  keysLine: HTMLElement;
  markerHome: HTMLElement;
  marker: HTMLElement;
  /** Character id the portrait currently shows, so it is rebuilt only on change. */
  faceChar: string | null;
}

interface TileRefs {
  root: HTMLElement;
  markers: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const { deps, callbacks, state } = ctx;
  const uiRoot = container.parentElement ?? container;

  const panel = el('div', 'ui-frame sel-panel');
  panel.setAttribute('style', accentVars(null));
  container.appendChild(panel);

  const heading = el('h1', 'ui-header');
  heading.appendChild(el('span', 'ui-spark'));
  heading.appendChild(document.createTextNode('Character Select'));
  panel.appendChild(heading);
  panel.appendChild(el('div', 'ui-rule'));

  // ---- Character grid ----

  const grid = el('div', 'sel-grid');
  panel.appendChild(grid);

  const tiles: TileRefs[] = [];

  deps.characters.forEach((character, index) => {
    const tile = el('div', 'ui-frame sel-tile');
    tile.dataset.charIndex = String(index);

    const artWrap = el('div', 'sel-tile-art');
    if (character.icon) {
      const img = el('img', 'sel-tile-img');
      img.src = iconAsset(character.icon);
      img.alt = character.name;
      img.draggable = false;
      artWrap.appendChild(img);
    } else {
      artWrap.appendChild(el('div', 'sel-tile-placeholder', character.name.slice(0, 2)));
    }
    tile.appendChild(artWrap);
    tile.appendChild(el('div', 'sel-tile-name', character.name));

    const markers = el('div', 'sel-tile-markers');
    tile.appendChild(markers);

    grid.appendChild(tile);
    tiles.push({ root: tile, markers });
  });

  // ---- Player cards ----

  const cardsWrap = el('div', 'sel-cards');
  panel.appendChild(cardsWrap);

  const cards: CardRefs[] = [];

  for (let slot = 0; slot < CARD_COUNT; slot += 1) {
    const root = el('div', 'sel-card');
    const frame = el('div', 'ui-frame sel-card-frame');
    root.appendChild(frame);

    const top = el('div', 'sel-card-top');
    const portrait = el('div', 'sel-portrait');
    portrait.appendChild(el('div', 'sel-ring'));
    const face = el('div', 'sel-face');
    portrait.appendChild(face);
    top.appendChild(portrait);

    const info = el('div', 'sel-card-info');
    const name = el('div', 'sel-card-name');
    info.appendChild(name);
    info.appendChild(el('div', 'sel-card-underline'));
    const tagLine = el('div', 'ui-tag');
    info.appendChild(tagLine);
    top.appendChild(info);
    frame.appendChild(top);

    // Team colour swatch and, for a human, the typed name.
    const idRow = el('div', 'sel-id-row');
    const swatch = el('button', 'ui-frame sel-swatch');
    swatch.type = 'button';
    idRow.appendChild(swatch);
    const nameInput = el('input', 'sel-name');
    nameInput.type = 'text';
    nameInput.maxLength = NAME_MAX;
    nameInput.spellcheck = false;
    nameInput.autocomplete = 'off';
    nameInput.setAttribute('aria-label', `Player ${slot + 1} name`);
    idRow.appendChild(nameInput);
    frame.appendChild(idRow);

    const modeBtn = el('button', 'ui-btn sel-card-mode');
    modeBtn.type = 'button';
    frame.appendChild(modeBtn);

    const cpuRow = el('div', 'sel-cpu-row');
    const cpuSlider = el('input', 'ui-slider');
    cpuSlider.type = 'range';
    cpuSlider.min = String(MIN_CPU_LEVEL);
    cpuSlider.max = String(MAX_CPU_LEVEL);
    cpuSlider.step = '1';
    const cpuLabel = el('div', 'ui-tag');
    cpuRow.appendChild(cpuSlider);
    cpuRow.appendChild(cpuLabel);
    frame.appendChild(cpuRow);

    const keysLine = el('div', 'ui-tag');
    frame.appendChild(keysLine);

    const markerHome = el('div', 'sel-marker-home');
    frame.appendChild(markerHome);

    const marker = el('div', 'sel-marker', `P${slot + 1}`);
    marker.dataset.slot = String(slot);
    marker.setAttribute('style', accentVars(slot));
    markerHome.appendChild(marker);

    cardsWrap.appendChild(root);
    cards.push({
      root, swatch, nameInput, face, name, tagLine, modeBtn, cpuRow, cpuSlider, cpuLabel, keysLine, markerHome, marker, faceChar: null,
    });
  }

  // ---- Stage + start ----

  const bottom = el('div', 'sel-bottom');
  panel.appendChild(bottom);

  const stageLine = el('div', 'sel-stage');
  bottom.appendChild(stageLine);
  const stagePrev = el('button', 'ui-btn sel-chev', '‹');
  stagePrev.type = 'button';
  stagePrev.setAttribute('aria-label', 'Previous stage');
  const stageName = el('span', 'ui-tag sel-stage-name');
  const stageNext = el('button', 'ui-btn sel-chev', '›');
  stageNext.type = 'button';
  stageNext.setAttribute('aria-label', 'Next stage');
  stageLine.appendChild(el('span', 'ui-tag', 'Stage'));
  stageLine.appendChild(stagePrev);
  stageLine.appendChild(stageName);
  stageLine.appendChild(stageNext);

  const startBtn = el('button', 'ui-btn sel-start', 'Start');
  startBtn.type = 'button';
  bottom.appendChild(startBtn);

  const hint = el('p', 'ui-tag sel-hint');
  hint.appendChild(document.createTextNode('Drag a P marker onto a character, or click a card to set Human / CPU / Off'));
  hint.appendChild(document.createElement('br'));
  hint.appendChild(document.createTextNode(
    'Left/Right: slot   Up/Down: character   - / = : CPU level   Enter: cycle / start   Esc: back'
  ));
  hint.appendChild(document.createElement('br'));
  hint.appendChild(document.createTextNode(
    'N / pad X (Square) or click the name: type a name (Enter / Esc done)   T / pad Y (Triangle) or click the swatch: team colour'
  ));
  panel.appendChild(hint);

  let focusIndex = 0;
  /** Slot whose name field has keyboard focus, -1 when none is being edited. */
  let editingSlot = -1;
  /** Name before the current edit, restored by Escape. */
  let nameBeforeEdit = '';

  const names = loadNames();
  state.slots.forEach((s, slot) => {
    if (s.name === undefined) s.name = names[slot];
    if (s.team === undefined) s.team = slot;
  });

  function teamOf(slot: number): number {
    const t = state.slots[slot].team;
    return t === undefined || t < 0 || t >= PLAYER_ACCENTS.length ? slot : t;
  }

  function nameOf(slot: number): string {
    const n = (state.slots[slot].name ?? '').trim();
    return n === '' ? defaultName(slot) : n;
  }

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

  function refreshFace(card: CardRefs, charIndex: number): void {
    const character = deps.characters[charIndex];
    const id = character ? character.id : '';
    if (card.faceChar === id) return;
    card.faceChar = id;
    card.face.textContent = '';
    if (character && character.icon) {
      card.face.classList.remove('sel-face-fallback');
      // Same bust as the HUD card (tools/uicut/portrait.py), falling back to the plain icon.
      const img = document.createElement('img');
      const icon = iconAsset(character.icon);
      const bust = iconAsset(character.icon.replace(/\.png$/, '-bust.png'));
      img.alt = '';
      img.draggable = false;
      if (bust !== icon) {
        img.onerror = (): void => {
          img.onerror = null;
          img.src = icon;
        };
      }
      img.src = bust;
      card.face.appendChild(img);
    } else {
      card.face.classList.add('sel-face-fallback');
      card.face.textContent = character ? character.name.slice(0, 1) : '?';
    }
  }

  function tagText(slot: number): string {
    const s = state.slots[slot];
    if (s.mode === 'off') return 'Off';
    if (s.mode === 'cpu') return `P${slot + 1} · CPU Lv ${s.cpuLevel}`;
    return `P${slot + 1} · Human`;
  }

  function refreshCpuText(slot: number): void {
    const card = cards[slot];
    const s = state.slots[slot];
    card.tagLine.textContent = tagText(slot);
    card.cpuLabel.textContent = cpuLevelName(s.cpuLevel);
  }

  function refreshCard(slot: number): void {
    const card = cards[slot];
    const s = state.slots[slot];
    const active = s.mode !== 'off';
    const team = teamOf(slot);
    card.root.setAttribute('style', accentVars(active ? team : null));
    card.marker.setAttribute('style', accentVars(team));
    card.root.classList.toggle('sel-card-off', !active);
    card.swatch.hidden = !active;
    card.swatch.disabled = !active;
    const teamLabel = `Team colour: ${TEAM_NAMES[team] ?? ''}`;
    card.swatch.title = teamLabel;
    card.swatch.setAttribute('aria-label', teamLabel);
    card.nameInput.hidden = s.mode !== 'human';
    if (editingSlot !== slot) card.nameInput.value = nameOf(slot);
    card.modeBtn.textContent = slotLabel(s.mode);
    card.cpuRow.hidden = s.mode !== 'cpu';
    card.keysLine.hidden = s.mode !== 'human';
    const charIndex = clampCharIndex(s.charIndex);
    card.name.textContent = deps.characters[charIndex]?.name ?? '';
    refreshFace(card, charIndex);

    if (s.mode === 'cpu') card.cpuSlider.value = String(s.cpuLevel);
    refreshCpuText(slot);

    if (s.mode === 'human') {
      const keys = deps.input.controls.players[slot]?.keys;
      card.keysLine.textContent = keys
        ? `Atk ${prettyKey(keys.attack[0])}   Jump ${prettyKey(keys.jump[0])}`
        : '';
    }

    placeMarker(slot);
  }

  function refreshStart(): void {
    startBtn.disabled = activeSlotCount() < 2;
  }

  function updateFocusVisual(): void {
    cards.forEach((c, i) => c.root.classList.toggle('sel-card-focus', i === focusIndex));
    startBtn.classList.toggle('ui-btn-selected', focusIndex === START_FOCUS);
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

  function cycleTeam(slot: number): void {
    if (state.slots[slot].mode === 'off') return;
    state.slots[slot].team = (teamOf(slot) + 1) % PLAYER_ACCENTS.length;
    refreshCard(slot);
  }

  function persistNames(): void {
    const out: string[] = [];
    for (let i = 0; i < CARD_COUNT; i += 1) out.push(nameOf(i));
    saveNames(out);
  }

  function beginEdit(slot: number): void {
    if (state.slots[slot].mode !== 'human') return;
    const input = cards[slot].nameInput;
    focusIndex = slot;
    updateFocusVisual();
    if (document.activeElement !== input) input.focus();
    input.select();
  }

  /** Leaves edit mode: blur commits (see the blur listener); `revert` restores the old name first. */
  function endEdit(revert: boolean): void {
    if (editingSlot < 0) return;
    const input = cards[editingSlot].nameInput;
    if (revert) {
      state.slots[editingSlot].name = nameBeforeEdit;
      input.value = nameBeforeEdit;
    }
    input.blur();
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
    const next = Math.min(MAX_CPU_LEVEL, Math.max(MIN_CPU_LEVEL, s.cpuLevel + dir));
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
        ...(s.mode === 'human' ? { name: nameOf(slot) } : {}),
        team: teamOf(slot),
      });
    });
    callbacks.startMatch({
      stageId: stage ? stage.id : '',
      players,
      stocks: state.stocks,
      timeLimitSec: 0,
      finalSmash: state.finalSmash,
      cpuZeroMoves: state.cpuZeroMoves,
      teams: state.teams === true,
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
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    return (hit as HTMLElement).closest('.sel-tile');
  }

  function setHoverTile(tile: HTMLElement | null): void {
    if (hoverTile === tile) return;
    if (hoverTile) hoverTile.classList.remove('sel-tile-hover');
    hoverTile = tile;
    if (hoverTile) hoverTile.classList.add('sel-tile-hover');
  }

  function endDrag(): void {
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    setHoverTile(null);
    if (dragSlot >= 0) cards[dragSlot].marker.classList.remove('sel-marker-dragging');
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
      ghost.classList.add('sel-marker-ghost');
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      uiRoot.appendChild(ghost);
      card.marker.classList.add('sel-marker-dragging');
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
    ctx.addListener(card.swatch, 'pointerdown', (e: Event) => e.stopPropagation());
    ctx.addListener(card.swatch, 'click', (e: Event) => {
      e.stopPropagation();
      focusIndex = slot;
      updateFocusVisual();
      cycleTeam(slot);
    });
    ctx.addListener(card.nameInput, 'pointerdown', (e: Event) => e.stopPropagation());
    ctx.addListener(card.nameInput, 'click', (e: Event) => e.stopPropagation());
    ctx.addListener(card.nameInput, 'focus', () => {
      editingSlot = slot;
      nameBeforeEdit = nameOf(slot);
      focusIndex = slot;
      updateFocusVisual();
    });
    ctx.addListener(card.nameInput, 'input', () => {
      const input = card.nameInput;
      const clean = cleanName(input.value);
      if (clean !== input.value) {
        const caret = Math.min(clean.length, input.selectionStart ?? clean.length);
        input.value = clean;
        input.setSelectionRange(caret, caret);
      }
      state.slots[slot].name = clean;
    });
    ctx.addListener(card.nameInput, 'blur', () => {
      const clean = cleanName(card.nameInput.value).trim();
      state.slots[slot].name = clean === '' ? defaultName(slot) : clean;
      card.nameInput.value = nameOf(slot);
      if (editingSlot === slot) editingSlot = -1;
      persistNames();
    });
    // While a name is being typed no key reaches menu navigation, player bindings or the
    // debug keys: everything stops here on the field. Enter and Escape leave edit mode.
    ctx.addListener(card.nameInput, 'keydown', (e: Event) => {
      const ev = e as KeyboardEvent;
      ev.stopPropagation();
      if (ev.code === 'Enter' || ev.code === 'NumpadEnter') {
        ev.preventDefault();
        endEdit(false);
      } else if (ev.code === 'Escape') {
        ev.preventDefault();
        endEdit(true);
      }
    });
    ctx.addListener(card.nameInput, 'keyup', (e: Event) => e.stopPropagation());
    ctx.addListener(card.cpuSlider, 'pointerdown', (e: Event) => e.stopPropagation());
    ctx.addListener(card.cpuSlider, 'click', (e: Event) => e.stopPropagation());
    ctx.addListener(card.cpuSlider, 'input', () => {
      const s = state.slots[slot];
      const raw = Number(card.cpuSlider.value);
      s.cpuLevel = Math.min(MAX_CPU_LEVEL, Math.max(MIN_CPU_LEVEL, Number.isFinite(raw) ? Math.round(raw) : MIN_CPU_LEVEL));
      refreshCpuText(slot);
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
    if (editingSlot >= 0) {
      // Real keys never get here (the field stops them). Pad navigation dispatches synthetic
      // keys on window: its Enter (A / Cross) and Escape (B / Circle) end the edit.
      if (ev.code === 'Enter') {
        ev.preventDefault();
        endEdit(false);
      } else if (ev.code === 'Escape') {
        ev.preventDefault();
        endEdit(true);
      }
      return;
    }
    switch (ev.code) {
      case 'KeyN':
        if (focusIndex < CARD_COUNT && state.slots[focusIndex].mode === 'human') {
          ev.preventDefault();
          beginEdit(focusIndex);
        }
        break;
      case 'KeyT':
        if (focusIndex < CARD_COUNT) {
          ev.preventDefault();
          cycleTeam(focusIndex);
        }
        break;
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
