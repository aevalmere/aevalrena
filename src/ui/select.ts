import type { MatchConfig } from '../core/types';
import { MAX_PLAYERS } from '../core/types';
import { SLOT_MODE_CYCLE, prettyKey, slotCpuLevel, slotLabel, type MenuCtx, type SlotMode } from './context';

const CARD_COUNT = MAX_PLAYERS;
/** Index used for the Start button in the unified focus sequence (0..CARD_COUNT-1 are the cards). */
const START_FOCUS = CARD_COUNT;

interface CardRefs {
  root: HTMLElement;
  modeLabel: HTMLElement;
  charRow: HTMLElement;
  charName: HTMLElement;
  charPrev: HTMLButtonElement;
  charNext: HTMLButtonElement;
  keysLine: HTMLElement;
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const { deps, callbacks, state } = ctx;

  const panel = document.createElement('div');
  panel.className = 'aev-panel aev-panel-wide';
  container.appendChild(panel);

  const heading = document.createElement('h1');
  heading.className = 'aev-heading';
  heading.textContent = 'Character Select';
  panel.appendChild(heading);

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
    root.appendChild(slotTag);

    const modeLabel = document.createElement('div');
    modeLabel.className = 'aev-card-mode';
    root.appendChild(modeLabel);

    const charRow = document.createElement('div');
    charRow.className = 'aev-row';
    const charPrev = document.createElement('button');
    charPrev.type = 'button';
    charPrev.className = 'aev-stepper-btn';
    charPrev.textContent = '<';
    const charName = document.createElement('span');
    charName.className = 'aev-card-char';
    const charNext = document.createElement('button');
    charNext.type = 'button';
    charNext.className = 'aev-stepper-btn';
    charNext.textContent = '>';
    charRow.appendChild(charPrev);
    charRow.appendChild(charName);
    charRow.appendChild(charNext);
    root.appendChild(charRow);

    const keysLine = document.createElement('div');
    keysLine.className = 'aev-card-keys';
    root.appendChild(keysLine);

    cardsWrap.appendChild(root);
    cards.push({ root, modeLabel, charRow, charName, charPrev, charNext, keysLine });
  }

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
  hint.textContent = 'Left/Right: choose slot   Up/Down: character   Enter: cycle / start   Escape: back';
  panel.appendChild(hint);

  let focusIndex = 0;

  function activeSlotCount(): number {
    return state.slots.filter((s) => s.mode !== 'off').length;
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
    card.modeLabel.textContent = slotLabel(s.mode);
    const active = s.mode !== 'off';
    card.charRow.hidden = !active;
    card.keysLine.hidden = !active || s.mode !== 'human';

    if (active) {
      const chars = deps.characters;
      const character = chars[s.charIndex] ?? chars[0];
      card.charName.textContent = character ? character.name : 'none';
      const multi = chars.length > 1;
      card.charPrev.hidden = !multi;
      card.charNext.hidden = !multi;
    }

    if (active && s.mode === 'human') {
      const bindings = deps.input.controls.players[slot]?.bindings;
      if (bindings) {
        card.keysLine.textContent = `Atk ${prettyKey(bindings.attack)}  Jump ${prettyKey(bindings.jump)}`;
      } else {
        card.keysLine.textContent = '';
      }
    }
  }

  function refreshStart(): void {
    startBtn.disabled = activeSlotCount() < 2;
  }

  function refreshAll(): void {
    for (let slot = 0; slot < CARD_COUNT; slot += 1) refreshCard(slot);
    refreshStage();
    refreshStart();
    updateFocusVisual();
  }

  function updateFocusVisual(): void {
    cards.forEach((c, i) => c.root.classList.toggle('aev-card-selected', i === focusIndex));
    startBtn.classList.toggle('aev-btn-selected', focusIndex === START_FOCUS);
  }

  function cycleMode(slot: number, dir: 1 | -1): void {
    const s = state.slots[slot];
    const idx = SLOT_MODE_CYCLE.indexOf(s.mode);
    const nextIdx = (idx + dir + SLOT_MODE_CYCLE.length) % SLOT_MODE_CYCLE.length;
    s.mode = SLOT_MODE_CYCLE[nextIdx] as SlotMode;
    refreshCard(slot);
    refreshStart();
  }

  function cycleCharacter(slot: number, dir: 1 | -1): void {
    const chars = deps.characters;
    if (chars.length <= 1) return;
    const s = state.slots[slot];
    s.charIndex = (s.charIndex + dir + chars.length) % chars.length;
    s.charId = chars[s.charIndex].id;
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
        cpu: s.mode !== 'human',
        cpuLevel: slotCpuLevel(s.mode),
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

  cards.forEach((card, slot) => {
    ctx.addListener(card.root, 'click', () => {
      focusIndex = slot;
      updateFocusVisual();
      cycleMode(slot, 1);
    });
    ctx.addListener(card.charPrev, 'click', (e: Event) => {
      e.stopPropagation();
      focusIndex = slot;
      updateFocusVisual();
      cycleCharacter(slot, -1);
    });
    ctx.addListener(card.charNext, 'click', (e: Event) => {
      e.stopPropagation();
      focusIndex = slot;
      updateFocusVisual();
      cycleCharacter(slot, 1);
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
