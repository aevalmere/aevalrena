import type { FighterStats, ResultsData } from '../core/types';
import type { MenuCtx } from './context';
import { pickQuote } from './quotes';
import { TEAM_NAMES, accentVars, iconAsset, playerAccentVars, playerTag, uiAsset } from './theme';

/**
 * Results screen (docs/UI_STYLE.md 4.7): one full-height column per player in slot order.
 * The winner's column shows WIN, the win pose in the ring over the splash, and a quote.
 * Loser columns show LOSE over the slumped backdrop. Every column ends with a stats block.
 */

export const CSS = `
.aev-ui-root .aev-screen-results {
  align-items: stretch;
  justify-content: stretch;
  padding: 2.4vh 2.4vw;
  gap: 2vh;
}
.rs-cols {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 1.2rem;
}
.rs-col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rs-content {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3.5vh 1.4rem 0;
}
.rs-lose .rs-content { filter: brightness(0.85); }
.rs-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  width: 100%;
  position: relative;
  z-index: 1;
}
.rs-heading {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.rs-win .rs-heading, .rs-draw .rs-heading {
  font-size: 4rem;
  color: color-mix(in srgb, var(--accent) 70%, #ffffff);
  text-shadow: 0 0 18px color-mix(in srgb, var(--accent) 55%, transparent), var(--glow);
}
.rs-lose .rs-heading {
  font-size: 3.4rem;
  font-weight: 500;
  color: color-mix(in srgb, var(--accent) 60%, #8a8a99);
  text-shadow: 0 0 10px color-mix(in srgb, var(--accent) 35%, transparent);
}
.rs-n3 .rs-win .rs-heading, .rs-n3 .rs-draw .rs-heading,
.rs-n4 .rs-win .rs-heading, .rs-n4 .rs-draw .rs-heading { font-size: clamp(2.2rem, 4.2vw, 3.4rem); }
.rs-n3 .rs-lose .rs-heading, .rs-n4 .rs-lose .rs-heading { font-size: clamp(1.9rem, 3.4vw, 2.8rem); }
.rs-head .ui-rule { width: min(70%, 260px); margin: 0.3rem 0 0.2rem; }
.rs-name {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 1.15rem;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--accent) 75%, #ffffff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.rs-lose .rs-name { font-family: var(--font-ui); font-size: 0.8rem; letter-spacing: 0.3em; }

.rs-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.4rem;
}
.rs-n3 .rs-stage, .rs-n4 .rs-stage { flex-direction: column; gap: 1.6rem; }
.rs-ringwrap {
  position: relative;
  flex-shrink: 0;
  width: min(260px, 100%);
  aspect-ratio: 13 / 10;
}
.rs-ring, .rs-splash {
  position: absolute;
  background: var(--accent);
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  pointer-events: none;
}
.rs-ring {
  inset: 0;
  -webkit-mask-image: url("${uiAsset('ring-win.png')}");
  mask-image: url("${uiAsset('ring-win.png')}");
  opacity: 0.9;
  filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 60%, transparent));
}
.rs-splash {
  left: 50%;
  bottom: -26px;
  width: 360px;
  max-width: calc(100vw / var(--rs-n, 2) - 3rem);
  height: 60px;
  transform: translateX(-50%);
  -webkit-mask-image: url("${uiAsset('splash.png')}");
  mask-image: url("${uiAsset('splash.png')}");
  opacity: 0.8;
}
.rs-pose {
  position: absolute;
  left: 50%;
  bottom: 12px;
  width: 129px;
  height: 150px;
  transform: translateX(-50%);
  image-rendering: pixelated;
  z-index: 1;
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--accent) 45%, transparent));
}
.rs-quote {
  margin: 0;
  max-width: 13rem;
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 500;
  font-size: 1rem;
  line-height: 1.8;
  letter-spacing: 0.04em;
  text-align: center;
  color: color-mix(in srgb, var(--accent) 85%, #ffffff);
  text-shadow: var(--glow);
}
.rs-n3 .rs-quote, .rs-n4 .rs-quote { max-width: 16rem; }

.rs-col .ui-backdrop.rs-lose-bd {
  top: auto;
  bottom: 0;
  width: 100%;
  height: 78%;
  object-fit: cover;
  object-position: right bottom;
  opacity: 0.85;
  /* The slumped figure is painted violet (hue ~254), not the reference blue (215). */
  filter: hue-rotate(calc(var(--hue-shift) - 39deg)) saturate(0.9) brightness(0.95);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 45%);
  mask-image: linear-gradient(90deg, transparent, #000 45%);
}
.rs-col .ui-petals { z-index: 0; }

.rs-stats {
  position: relative;
  z-index: 1;
  flex: 0 1 auto;
  min-height: 0;
  max-height: 46%;
  overflow-y: auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  column-gap: 1.6rem;
  row-gap: 0.3rem;
  margin: 0 1.4rem 1.2rem;
  padding: 0.8rem 0.4rem 0.2rem 0;
  border-top: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--accent) 45%, transparent) transparent;
}
.rs-n2 .rs-stats {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-rows: repeat(var(--rs-rows, 12), auto);
  grid-auto-flow: column;
}
.rs-stats::-webkit-scrollbar { width: 4px; }
.rs-stats::-webkit-scrollbar-track { background: transparent; }
.rs-stats::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--accent) 45%, transparent); }
.rs-stat {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.8rem;
  min-width: 0;
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  line-height: 1.5;
}
.rs-stat-label {
  flex-shrink: 0;
  color: color-mix(in srgb, var(--accent) 45%, #9aa6bf);
}
.rs-stat-label.rs-keepcase { text-transform: none; }
.rs-stat-val {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: color-mix(in srgb, var(--accent) 85%, #ffffff);
  text-shadow: var(--glow);
}

.rs-bar {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 2.4rem;
  flex-shrink: 0;
}
.rs-btnwrap { display: flex; align-items: center; gap: 0.6rem; }
/* Teams rule: the winning team's colour bar over the buttons. */
.rs-teambar {
  align-self: center;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 0.3rem 1.4rem;
  white-space: nowrap;
  color: var(--accent);
  text-shadow: var(--glow);
}
.rs-teambar::before, .rs-teambar::after {
  content: "";
  width: 7rem;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--accent));
  box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 55%, transparent);
}
.rs-teambar::after { background: linear-gradient(90deg, var(--accent), transparent); }
.rs-teambar .ui-tag { color: var(--accent); font-size: 0.8rem; }
.rs-btnwrap .ui-cursor { opacity: 0; transform: translateX(-6px); }
.rs-btnwrap.rs-sel .ui-cursor { opacity: 1; transform: translateX(0); }
`;

type Player = ResultsData['players'][number];

interface ResultButton {
  wrap: HTMLElement;
  el: HTMLButtonElement;
  activate: () => void;
}

const ORDINALS = ['1ST', '2ND', '3RD', '4TH'];

/**
 * Move and throw id -> display name. A copy of the names in src/ui/movelist.ts ROWS,
 * which is not exported; keep the two in step.
 */
const MOVE_NAMES: Record<string, string> = {
  jab: 'Neutral Attack', ftilt: 'Forward Tilt', utilt: 'Up Tilt', dtilt: 'Down Tilt',
  dashatk: 'Dash Attack', fsmash: 'Forward Smash', usmash: 'Up Smash', dsmash: 'Down Smash',
  nair: 'Neutral Air', fair: 'Forward Air', bair: 'Back Air', uair: 'Up Air', dair: 'Down Air',
  nspecial: 'Neutral Special', sspecial: 'Side Special', uspecial: 'Up Special', dspecial: 'Down Special',
  fthrow: 'Forward Throw', bthrow: 'Back Throw', uthrow: 'Up Throw', dthrow: 'Down Throw',
  taunt: 'Taunt', taunt2: 'Taunt', taunt3: 'Taunt', ledgeatk: 'Ledge Attack', getupatk: 'Getup Attack',
  custom: 'Throw',
};

const NONE = 'None';
/** 32 world px = 1 m for DISTANCE RUN. */
const PX_PER_METRE = 32;

function pct1(v: number): string {
  return `${(Math.floor(v * 10) / 10).toFixed(1)}%`;
}

function share(frames: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.round((frames / total) * 100)}%`;
}

function clock(frame: number): string {
  if (frame < 0) return NONE;
  const sec = Math.floor(frame / 60);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** Highest count wins; ties go to the id that comes first alphabetically, so it is stable. */
function mostUsed(moves: Record<string, number>): string {
  let best = '';
  let bestN = 0;
  for (const id of Object.keys(moves).sort()) {
    if (moves[id] > bestN) {
      best = id;
      bestN = moves[id];
    }
  }
  if (bestN === 0) return NONE;
  return MOVE_NAMES[best] ?? best;
}

/** [label, value, keep label case] rows in Smash results order. */
function statRows(p: Player, place: number, matchFrames: number): [string, string, boolean][] {
  const s: FighterStats = p.stats;
  return [
    ['Place', ORDINALS[place - 1] ?? `${place}TH`, false],
    ['Stocks', String(p.stocks), false],
    ['KOs', String(s.kos), true],
    ['Falls', String(s.falls), false],
    ['SDs', String(s.sds), true],
    ['Damage Given', pct1(s.damageGiven), false],
    ['Damage Taken', pct1(s.damageTaken), false],
    ['Peak Damage', pct1(s.peakDamage), false],
    ['Max Combo', `${s.maxCombo} ${s.maxCombo === 1 ? 'hit' : 'hits'}`, false],
    ['Most Used Move', mostUsed(s.mostUsedMove), false],
    ['Grabs', String(s.grabs), false],
    ['Throws', String(s.throws), false],
    ['Shield Breaks', String(s.shieldBreaks), false],
    ['Ledge Grabs', String(s.ledgeGrabs), false],
    ['Techs', String(s.techs), false],
    ['Dodges', String(s.dodges), false],
    ['Final Smashes', `${s.finalSmashes} / ${s.finalSmashHits}`, false],
    ['Projectiles', `${s.projectilesHit} / ${s.projectilesFired}`, false],
    ['Air Time', share(s.airTime, matchFrames), false],
    ['Time in Lead', share(s.timeInLead, matchFrames), false],
    ['First KO', clock(s.firstBloodFrame), false],
    ['Distance Run', `${(s.distanceRun / PX_PER_METRE).toFixed(1)} m`, false],
  ];
}

/** 1-based place: stocks desc, then percent asc; equal players share a place. */
function placeOf(p: Player, all: Player[]): number {
  let better = 0;
  for (const o of all) {
    if (o.stocks > p.stocks || (o.stocks === p.stocks && o.percent < p.percent)) better++;
  }
  return better + 1;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addPetals(parent: HTMLElement, count: number): void {
  const layer = el('div', 'ui-petals');
  for (let i = 0; i < count; i++) {
    const petal = el('span', `ui-petal ui-petal-${(i % 4) + 1}`);
    const left = 12 + ((i * 37) % 80);
    const dur = 9 + ((i * 1.7) % 5);
    const delay = -((i * 2.3) % dur);
    const size = 14 + ((i * 5) % 12);
    petal.style.cssText =
      `left:${left}%;width:${size}px;height:${size}px;--dur:${dur.toFixed(1)}s;` +
      `--delay:${delay.toFixed(1)}s;--dx:${i % 2 === 0 ? -110 : 70}px;--rot:${i % 2 === 0 ? 320 : -280}deg`;
    layer.appendChild(petal);
  }
  parent.appendChild(layer);
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const data = ctx.results;
  const players = data ? data.players.slice().sort((a, b) => a.slot - b.slot) : [];
  const winner = data ? data.winner : -1;
  const winnerTeam = data && data.winnerTeam !== undefined ? data.winnerTeam : -2;
  const teams = winnerTeam !== -2;
  const draw = teams ? winnerTeam < 0 : winner === -1;
  /** Teams rule: every member of the winning team wins; otherwise only the winner does. */
  const wins = (p: Player): boolean => {
    if (draw) return false;
    if (!teams) return p.slot === winner;
    return (p.team === undefined ? p.slot : p.team) === winnerTeam;
  };
  const n = Math.max(1, players.length);

  const charInfo = (charId: string): { name: string; winPose?: string } => {
    const found = ctx.deps.characters.find((c) => c.id === charId) as
      | { name: string; winPose?: string }
      | undefined;
    return found ?? { name: charId };
  };

  const cols = el('div', `rs-cols rs-n${n}`);
  cols.style.setProperty('--rs-n', String(n));
  container.appendChild(cols);

  for (const p of players) {
    const isWin = wins(p);
    const kind = draw ? 'rs-draw' : isWin ? 'rs-win' : 'rs-lose';
    const info = charInfo(p.charId);
    const tag = playerTag(players, p.slot);

    const col = el('section', `ui-frame rs-col ${kind}`);
    col.setAttribute('style', playerAccentVars(players, p.slot));
    cols.appendChild(col);

    const content = el('div', 'rs-content');
    col.appendChild(content);

    if (kind === 'rs-lose') {
      const bd = el('img', 'ui-backdrop rs-lose-bd');
      bd.src = uiAsset('backdrop-lose.png');
      bd.alt = '';
      content.appendChild(bd);
    }
    addPetals(content, isWin ? 5 : 3);

    const head = el('div', 'rs-head');
    content.appendChild(head);
    head.appendChild(el('h1', 'rs-heading ui-scale-in', draw ? 'Draw' : isWin ? 'Win' : 'Lose'));
    head.appendChild(el('div', 'ui-rule'));
    if (kind === 'rs-lose') {
      head.appendChild(el('div', 'rs-name', `${info.name} · ${tag}`));
    } else {
      head.appendChild(el('div', 'rs-name', info.name));
      head.appendChild(el('div', 'ui-tag', tag));
    }

    const stage = el('div', 'rs-stage');
    content.appendChild(stage);
    if (isWin) {
      const ringWrap = el('div', 'rs-ringwrap');
      ringWrap.appendChild(el('div', 'rs-splash'));
      ringWrap.appendChild(el('div', 'rs-ring'));
      if (info.winPose) {
        const pose = el('img', 'rs-pose');
        pose.alt = info.name;
        pose.addEventListener('load', () => {
          if (pose.naturalWidth > 0) {
            pose.style.width = `${pose.naturalWidth * 3}px`;
            pose.style.height = `${pose.naturalHeight * 3}px`;
          }
        });
        pose.src = iconAsset(info.winPose);
        ringWrap.appendChild(pose);
      }
      stage.appendChild(ringWrap);
      stage.appendChild(el('p', 'rs-quote', `“${pickQuote(p.charId, data ? data.seed : 0)}”`));
    }

    const stats = el('div', 'rs-stats');
    const rows = statRows(p, placeOf(p, players), data ? data.matchFrames : 0);
    stats.style.setProperty('--rs-rows', String(Math.ceil(rows.length / 2)));
    for (const [label, value, keepCase] of rows) {
      const row = el('div', 'ui-tag rs-stat');
      row.appendChild(el('span', keepCase ? 'rs-stat-label rs-keepcase' : 'rs-stat-label', label));
      const val = el('span', 'rs-stat-val', value);
      val.title = value;
      row.appendChild(val);
      stats.appendChild(row);
    }
    col.appendChild(stats);
  }

  const bar = el('div', 'rs-bar');
  bar.setAttribute('style', draw ? accentVars(null) : teams ? accentVars(winnerTeam) : playerAccentVars(players, winner));
  container.appendChild(bar);
  if (teams && !draw) {
    const teamBar = el('div', 'rs-teambar');
    teamBar.setAttribute('style', accentVars(winnerTeam));
    teamBar.appendChild(el('span', 'ui-spark'));
    teamBar.appendChild(el('span', 'ui-tag', `${TEAM_NAMES[winnerTeam] ?? ''} team wins`));
    container.insertBefore(teamBar, bar);
  }

  const buttons: ResultButton[] = [];
  let selected = 0;

  function updateHighlight(): void {
    buttons.forEach((b, i) => {
      b.wrap.classList.toggle('rs-sel', i === selected);
      b.el.classList.toggle('ui-btn-selected', i === selected);
    });
  }

  function addButton(label: string, activate: () => void): void {
    const wrap = el('div', 'rs-btnwrap');
    wrap.appendChild(el('span', 'ui-cursor'));
    const button = el('button', 'ui-btn', label);
    button.type = 'button';
    wrap.appendChild(button);
    bar.appendChild(wrap);
    const btn: ResultButton = { wrap, el: button, activate };
    buttons.push(btn);
    ctx.addListener(button, 'click', () => {
      selected = buttons.indexOf(btn);
      updateHighlight();
      activate();
    });
    ctx.addListener(button, 'mouseenter', () => {
      selected = buttons.indexOf(btn);
      updateHighlight();
    });
  }

  addButton('Rematch', () => ctx.callbacks.rematch());
  addButton('Character Select', () => ctx.go('select'));
  updateHighlight();

  ctx.addListener(window, 'keydown', (e: Event) => {
    const ev = e as KeyboardEvent;
    switch (ev.code) {
      case 'ArrowLeft':
      case 'ArrowUp':
        ev.preventDefault();
        selected = (selected - 1 + buttons.length) % buttons.length;
        updateHighlight();
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        ev.preventDefault();
        selected = (selected + 1) % buttons.length;
        updateHighlight();
        break;
      case 'Enter':
      case 'Space':
        ev.preventDefault();
        buttons[selected]?.activate();
        break;
      default:
        break;
    }
  });
}
