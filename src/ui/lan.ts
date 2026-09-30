import { NETWORK_HINT, type Invite } from '../net/browserhost';
import { lanClient, type LobbyRow } from '../net/client';
import {
  AUTO_DELAY, defaultSettings, LAN_PORT, LOBBY_MAX, SIM_LATENCIES, type LobbyMember, type LobbySettings,
} from '../net/protocol';
import { LOCAL_TAG } from '../net/view';
import { VARIANT_COUNT, VARIANT_NAMES, VARIANT_SWATCHES, clampVariant } from '../render/palette';
import type { MenuCtx } from './context';
import { encodeQr, qrSvg } from './qr';
import { accentVars, PLAYER_ACCENTS, TEAM_NAMES, uiAsset } from './theme';

/**
 * LAN screen (docs/LAN.md). Views, picked from the LAN client's state:
 *
 * - connect: only when no agent answers at this page's address (the page came from the Vite dev
 *   server, say): type the agent address and a name;
 * - lobby list: every lobby on the Wi-Fi (this agent's and every discovered agent's), refreshed
 *   each second, plus "join by address" and the create form;
 * - lobby: settings (the host edits), the four slots with pings, ready or start, rematch votes.
 *
 * The local player's card is always first, coloured as P1 and tagged "P1 (you)"; the host's slot
 * numbers stay authoritative underneath.
 */

const NAME_KEY = 'aevalrena.lan.name';
const ADDR_KEY = 'aevalrena.lan.address';
const CHAR_KEY = 'aevalrena.lan.char';
const DRAFT_KEY = 'aevalrena.lan.draft';
const MODE_KEY = 'aevalrena.lan.mode';

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the value just is not remembered.
  }
}

export const CSS = `
.aev-screen-lan { align-items: center; justify-content: center; }
.lan-panel {
  width: min(94vw, 64rem);
  max-height: 94vh;
  overflow-y: auto;
  padding: 1.3rem 1.6rem 1.2rem 1.3rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.lan-panel .aev-menu-bg { position: absolute; inset: var(--line); z-index: -1; overflow: hidden; pointer-events: none; }
.lan-panel .aev-menu-bg .ui-backdrop { width: 46%; object-fit: cover; object-position: 35% center; }
.lan-sub { font-size: 0.66rem; letter-spacing: 0.22em; text-transform: uppercase; color: color-mix(in srgb, var(--accent) 55%, #7d8699); }
.lan-cols { display: grid; grid-template-columns: minmax(18rem, 1.2fr) minmax(16rem, 1fr); gap: 1.4rem; align-items: start; }
@media (max-width: 760px) { .lan-cols { grid-template-columns: 1fr; } }
.lan-list { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.lan-row { min-height: 2.2rem; font-size: 0.86rem; padding-left: 0.3rem; }
.lan-row .ui-cursor { opacity: 0; transform: translateX(-8px); width: 28px; height: 18px; }
.lan-row.ui-item-selected .ui-cursor, .lan-row:focus-visible .ui-cursor { opacity: 1; transform: translateX(0); }
.lan-row:focus { outline: none; }
.lan-row:focus-visible { color: var(--accent); text-shadow: var(--glow); }
.lan-row:focus-visible::before { opacity: 1; }
.lan-lobby-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lan-value { margin-left: auto; display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.78rem; flex-shrink: 0; }
.lan-value .aev-step-value { min-width: 8.5em; text-align: center; }
.lan-meta { margin-left: auto; text-align: right; font-size: 0.62rem; letter-spacing: 0.2em; line-height: 1.5; flex-shrink: 0; color: color-mix(in srgb, var(--accent) 70%, #7d8699); }
.lan-meta-off { color: #ffb38a; }
.lan-field {
  font-family: var(--font-ui); font-weight: 700; font-size: 0.82rem; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--text); background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 0; border-bottom: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  padding: 0.3rem 0.4rem; width: 14em; outline: none;
}
.lan-field:focus { border-bottom-color: var(--accent); box-shadow: 0 1px 0 var(--accent); }
.lan-field-wide { width: 100%; }
.lan-inline { display: flex; gap: 0.6rem; align-items: center; margin-top: 0.3rem; }
.lan-actions { display: flex; flex-wrap: wrap; gap: 0.8rem; margin-top: 0.3rem; }
.lan-msg { min-height: 1.2em; font-size: 0.72rem; letter-spacing: 0.16em; text-transform: uppercase; color: #ffb38a; }
.lan-slots { display: grid; grid-template-columns: 1fr 1fr; gap: 0.7rem; margin-top: 0.4rem; }
.lan-card { --chamfer: 10px; padding: 0.65rem 0.8rem 0.75rem; min-height: 6.8rem; display: flex; flex-direction: column; gap: 0.3rem; }
.lan-card-empty { opacity: 0.4; }
.lan-card-off { opacity: 0.55; }
.lan-card-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.lan-card-name { font-family: var(--font-display); font-size: 1.25rem; letter-spacing: 0.12em; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lan-card-line { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.lan-chip {
  appearance: none; border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: 0;
  background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent);
  font-family: var(--font-ui); font-size: 0.64rem; letter-spacing: 0.2em; text-transform: uppercase;
  padding: 0.22rem 0.5rem; cursor: pointer;
}
.lan-chip:hover:not(:disabled), .lan-chip:focus-visible { background: color-mix(in srgb, var(--accent) 28%, transparent); border-color: var(--accent); outline: none; }
.lan-chip:disabled { cursor: default; opacity: 0.85; }
.lan-variant-dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; margin-right: 0.4rem; vertical-align: -0.05rem; }
.lan-ok { color: #9fff7f; text-shadow: 0 0 6px rgba(159, 255, 127, 0.5); }
.lan-host { color: #ffd27f; }
.lan-warn { color: #ffb38a; }
.lan-hint { font-size: 0.62rem; letter-spacing: 0.2em; text-transform: uppercase; color: #7d8699; }
.lan-field.lan-code-field { text-transform: none; letter-spacing: 0.02em; font-weight: 400; min-width: 0; flex: 1; }
.lan-codebox { display: flex; gap: 0.9rem; align-items: flex-start; margin-top: 0.3rem; }
@media (max-width: 560px) { .lan-codebox { flex-direction: column; } }
.lan-qr { flex-shrink: 0; width: 11rem; height: 11rem; line-height: 0; }
.lan-qr svg { width: 100%; height: 100%; image-rendering: pixelated; }
.lan-codeside { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; flex: 1; }
.lan-code {
  font-family: var(--font-ui); font-size: 0.72rem; line-height: 1.45; letter-spacing: 0.02em; text-transform: none;
  word-break: break-all; user-select: all; color: var(--text); padding: 0.4rem 0.5rem;
  background: color-mix(in srgb, var(--accent) 8%, transparent); border-left: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
}
.lan-invites { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.2rem; }
.lan-invite { --chamfer: 10px; padding: 0.65rem 0.8rem 0.75rem; display: flex; flex-direction: column; gap: 0.35rem; }
.lan-note { font-size: 0.72rem; letter-spacing: 0.08em; line-height: 1.5; color: #9aa4b8; }
`;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== '') e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent !== null) parent.appendChild(e);
  return e;
}

/** Colour index a member shows in on this screen: the local player's colour swaps with P1 blue. */
function displayColour(team: number, localTeam: number): number {
  return team === localTeam ? 0 : team === 0 ? localTeam : team;
}

function delayLabel(d: number): string {
  if (d === AUTO_DELAY) return 'Auto';
  return `${d} ${d === 1 ? 'frame' : 'frames'}`;
}

function pingLabel(ms: number): string {
  return ms < 0 ? '-- ms' : `${ms} ms`;
}

function loadDraft(stageId: string): LobbySettings {
  const d = defaultSettings(stageId);
  try {
    const saved = JSON.parse(load(DRAFT_KEY, '{}')) as Partial<LobbySettings>;
    return { ...d, ...saved };
  } catch {
    return d;
  }
}

/** Where this page's own agent is: the page's host when an agent served it, else the default port. */
function defaultAgentAddress(): string {
  const host = location.hostname === '' ? 'localhost' : location.hostname;
  return location.port === '5173' || location.port === '' ? `${host}:${LAN_PORT}` : location.host;
}

let autoTried = false;
/** Browser mode: the join code being typed, and the answer code the host is typing. */
let joinCode = '';
let answerCode = '';

/** The link a join code's QR carries: this page with the code after #join=. */
function joinLink(code: string): string {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return code;
  return `${location.origin}${location.pathname}#join=${code}`;
}

function copyText(text: string, done: (ok: boolean) => void): void {
  const fallback = (): void => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    done(ok);
  };
  if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(() => done(true), fallback);
  } else {
    fallback();
  }
}

export function render(container: HTMLElement, ctx: MenuCtx): void {
  const client = lanClient;
  const characters = ctx.deps.characters;
  const stages = ctx.deps.stages;

  let name = load(NAME_KEY, 'PLAYER').slice(0, 12);
  client.name = name;
  let address = load(ADDR_KEY, defaultAgentAddress());
  let joinAddress = '';
  let charId = load(CHAR_KEY, characters[0]?.id ?? 'aeval');
  if (!characters.some((c) => c.id === charId)) charId = characters[0]?.id ?? 'aeval';
  let draft = loadDraft(stages[0]?.id ?? 'tidegate');
  if (!stages.some((s) => s.id === draft.stageId)) draft.stageId = stages[0]?.id ?? 'tidegate';
  let focusKey = '';
  const steppers = new Map<HTMLElement, (dir: -1 | 1) => void>();

  const stageName = (id: string): string => stages.find((s) => s.id === id)?.name ?? id;
  const charName = (id: string): string => characters.find((c) => c.id === id)?.name ?? id;

  // A scanned #join= link: the browser mode's join field starts filled in.
  if (client.pendingJoinCode !== '') {
    joinCode = client.pendingJoinCode;
    client.pendingJoinCode = '';
  }

  /** Agent mode: talk to the agent that served this page without asking. */
  function autoConnect(): void {
    if (client.mode !== 'agent' || client.lobby !== null) return;
    if (client.agentStatus === 'idle' || (client.agentStatus === 'closed' && !autoTried)) {
      autoTried = true;
      client.connectAgent(defaultAgentAddress(), name);
    }
  }
  autoConnect();

  function nav(el: HTMLElement, key: string): void {
    el.dataset.nav = key;
    if (el.tabIndex < 0) el.tabIndex = 0;
    el.addEventListener('focus', () => { focusKey = key; });
  }

  function row(list: HTMLElement, label: string, key: string, activate?: () => void): HTMLElement {
    const el = h('div', 'ui-item lan-row', list);
    h('span', 'ui-cursor', el);
    h('span', 'lan-lobby-name', el, label);
    nav(el, key);
    if (activate !== undefined) {
      el.addEventListener('click', activate);
      el.addEventListener('keydown', (e) => {
        if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); activate(); }
      });
    }
    return el;
  }

  /** A settings row with ‹ value › buttons (or plain text when `step` is null). */
  function stepRow(list: HTMLElement, label: string, key: string, value: string, step: ((dir: -1 | 1) => void) | null): void {
    const el = row(list, label, key);
    const box = h('span', 'lan-value aev-step', el);
    if (step === null) {
      h('span', 'aev-step-value', box, value);
      return;
    }
    const mk = (text: string, dir: -1 | 1): void => {
      const b = h('button', 'aev-step-btn', box, text);
      b.type = 'button';
      b.tabIndex = -1;
      b.setAttribute('aria-label', `${label} ${dir < 0 ? 'previous' : 'next'}`);
      b.addEventListener('click', (e) => { e.stopPropagation(); focusKey = key; step(dir); });
    };
    mk('‹', -1);
    h('span', 'aev-step-value', box, value);
    mk('›', 1);
    steppers.set(el, step);
    el.addEventListener('keydown', (e) => {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        step(e.code === 'ArrowLeft' ? -1 : 1);
      }
    });
  }

  function button(parent: HTMLElement, label: string, key: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const b = h('button', 'ui-btn', parent, label);
    b.type = 'button';
    b.disabled = disabled;
    b.dataset.nav = key;
    b.addEventListener('focus', () => { focusKey = key; });
    b.addEventListener('click', () => { focusKey = key; onClick(); });
    return b;
  }

  function field(parent: HTMLElement, value: string, label: string, max: number, onInput: (v: string) => void, onEnter?: () => void): HTMLInputElement {
    const inp = h('input', 'lan-field', parent);
    inp.value = value;
    inp.maxLength = max;
    inp.spellcheck = false;
    inp.setAttribute('aria-label', label);
    inp.addEventListener('input', () => onInput(inp.value));
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') { inp.blur(); onEnter?.(); }
      if (e.code === 'Escape') inp.blur();
    });
    return inp;
  }

  function settingsRows(list: HTMLElement, s: LobbySettings, editable: boolean, apply: (next: LobbySettings) => void): void {
    const edit = (fn: (dir: -1 | 1) => void): ((dir: -1 | 1) => void) | null => (editable ? fn : null);
    const stageIdx = Math.max(0, stages.findIndex((x) => x.id === s.stageId));
    stepRow(list, 'Stocks', 'set-stocks', String(s.stocks), edit((d) => apply({ ...s, stocks: Math.max(1, Math.min(5, s.stocks + d)) })));
    stepRow(list, 'Stage', 'set-stage', stageName(s.stageId), edit((d) => {
      const n = stages.length;
      apply({ ...s, stageId: stages[(stageIdx + d + n) % n].id });
    }));
    const delays = [AUTO_DELAY, 0, 1, 2, 3, 4];
    const di = Math.max(0, delays.indexOf(s.inputDelay));
    stepRow(list, 'Input delay', 'set-delay', delayLabel(s.inputDelay), edit((d) => {
      apply({ ...s, inputDelay: delays[(di + d + delays.length) % delays.length] });
    }));
    stepRow(list, 'CPU fill', 'set-cpufill', s.cpuFill ? 'On' : 'Off', edit(() => apply({ ...s, cpuFill: !s.cpuFill })));
    stepRow(list, 'CPU level', 'set-cpulevel', String(s.cpuLevel), edit((d) => apply({ ...s, cpuLevel: Math.max(0, Math.min(10, s.cpuLevel + d)) })));
    const li = Math.max(0, (SIM_LATENCIES as readonly number[]).indexOf(s.simLatencyMs));
    stepRow(list, 'Sim latency', 'set-latency', s.simLatencyMs === 0 ? 'Off' : `+${s.simLatencyMs} ms`, edit((d) => {
      const n = SIM_LATENCIES.length;
      apply({ ...s, simLatencyMs: SIM_LATENCIES[(li + d + n) % n] });
    }));
  }

  function renderConnect(panel: HTMLElement): void {
    h('div', 'lan-sub', panel, client.agentStatus === 'connecting'
      ? `Looking for the LAN agent at ${client.agentAddress}...`
      : 'Run "npm run lan" on this machine, then open the address it prints. Or type an agent address here.');
    const list = h('div', 'lan-list', panel);
    const addrRow = row(list, 'Agent', 'addr');
    const addrIn = field(addrRow, address, 'LAN agent address', 64, (v) => { address = v; }, connect);
    addrIn.placeholder = `localhost:${LAN_PORT}`;
    addrIn.classList.add('lan-value');
    const nameRow = row(list, 'Your name', 'name');
    field(nameRow, name, 'Your name', 12, (v) => { name = v; }, connect).classList.add('lan-value');
    const actions = h('div', 'lan-actions', panel);
    button(actions, client.agentStatus === 'connecting' ? 'Connecting' : 'Connect', 'connect', connect, client.agentStatus === 'connecting');
    button(actions, 'Back', 'back', back);
  }

  function connect(): void {
    name = name.trim().slice(0, 12) || 'PLAYER';
    store(NAME_KEY, name);
    store(ADDR_KEY, address.trim());
    focusKey = 'lobby-create';
    client.connectAgent(address, name);
  }

  function lobbyRow(list: HTMLElement, r: LobbyRow): void {
    const full = r.players >= LOBBY_MAX;
    const blocked = !r.joinable || full || r.state === 'in-match';
    const el = row(list, r.name, `lobby-${r.agentId}-${r.lobbyId}`, blocked ? undefined : () => {
      focusKey = 'ready';
      client.name = name;
      client.join(r, charId);
    });
    const meta = h('span', 'lan-meta', el);
    const local = r.agentId === client.agentId;
    h('div', '', meta, `${r.hostName || 'host'} · ${local ? 'this PC' : r.address}`);
    const state = !r.joinable ? 'Different version' : full ? 'Full' : r.state === 'in-match' ? 'In match' : 'Open';
    const line = h('div', blocked ? 'lan-meta-off' : '', meta, `${stageName(r.stageId)} · ${r.players}/${LOBBY_MAX} · ${state}`);
    line.style.whiteSpace = 'nowrap';
    if (blocked) el.classList.add('ui-item-disabled');
  }

  function renderList(panel: HTMLElement): void {
    h('div', 'lan-sub', panel, `Agent ${client.agentAddress}${client.hostName !== '' ? ` on ${client.hostName}` : ''} · lobbies on this network update every second`);
    const cols = h('div', 'lan-cols', panel);
    const left = h('div', 'lan-list', cols);
    h('div', 'lan-hint', left, 'Lobbies on the network');
    const rows = client.rows();
    if (rows.length === 0) h('div', 'lan-hint', left, 'None yet. Create one, or wait for a friend to create theirs.');
    for (const r of rows) lobbyRow(left, r);
    const byAddr = h('div', 'lan-inline', left);
    const addrIn = field(byAddr, joinAddress, 'Join by address', 64, (v) => { joinAddress = v; }, () => client.addAgentByAddress(joinAddress));
    addrIn.placeholder = `192.168.1.20:${LAN_PORT}`;
    button(byAddr, 'Find', 'join-find', () => client.addAgentByAddress(joinAddress));
    h('div', 'lan-hint', left, 'Not listed? Type the address the other machine\'s agent printed.');

    youAndDraft(h('div', 'lan-list', cols));
    const actions = h('div', 'lan-actions', panel);
    button(actions, 'Create lobby', 'lobby-create', () => {
      focusKey = 'start';
      client.name = name.trim().slice(0, 12) || 'PLAYER';
      store(DRAFT_KEY, JSON.stringify(draft));
      client.create(draft, charId);
    });
    button(actions, 'Back', 'back', back);
  }

  /** Name, character and the new lobby's settings (both modes). */
  function youAndDraft(right: HTMLElement): void {
    h('div', 'lan-hint', right, 'You');
    const nameRow = row(right, 'Name', 'my-name');
    field(nameRow, name, 'Your name', 12, (v) => {
      name = v;
      client.name = v.trim().slice(0, 12) || 'PLAYER';
      store(NAME_KEY, client.name);
    }).classList.add('lan-value');
    stepRow(right, 'Character', 'my-char', charName(charId), characters.length > 1 ? (d) => {
      const i = characters.findIndex((c) => c.id === charId);
      charId = characters[(i + d + characters.length) % characters.length].id;
      store(CHAR_KEY, charId);
      paint(true);
    } : null);
    h('div', 'lan-hint', right, 'New lobby');
    const lobbyNameRow = row(right, 'Lobby', 'set-name');
    field(lobbyNameRow, draft.name, 'Lobby name', 20, (v) => { draft = { ...draft, name: v }; }).classList.add('lan-value');
    settingsRows(right, draft, true, (next) => {
      draft = next;
      store(DRAFT_KEY, JSON.stringify(draft));
      paint(true);
    });
  }

  /** First view: how this device plays on the LAN. */
  function renderChoose(panel: HTMLElement): void {
    h('div', 'lan-sub', panel, 'Pick how this device plays on the LAN');
    if (focusKey === '') focusKey = load(MODE_KEY, 'browser') === 'agent' ? 'mode-agent' : 'mode-browser';
    const list = h('div', 'lan-list', panel);
    const browserRow = row(list, 'In browser', 'mode-browser', () => {
      focusKey = 'lobby-create';
      store(MODE_KEY, 'browser');
      client.setMode('browser');
    });
    h('span', 'lan-meta', browserRow, 'No install. The host sends each guest a join code');
    const agentRow = row(list, 'Local agent', 'mode-agent', () => {
      focusKey = 'lobby-create';
      store(MODE_KEY, 'agent');
      client.setMode('agent');
      autoConnect();
    });
    h('span', 'lan-meta', agentRow, location.protocol === 'https:'
      ? 'Needs "npm run lan" and the page it serves (http)'
      : 'Every player runs "npm run lan". Lobbies are found automatically');
    const actions = h('div', 'lan-actions', panel);
    button(actions, 'Back', 'back', back);
  }

  /** A code as text, a QR code and a Copy button. */
  function codeBlock(parent: HTMLElement, code: string, qrText: string, key: string): void {
    const box = h('div', 'lan-codebox', parent);
    const qr = h('div', 'lan-qr', box);
    qr.setAttribute('role', 'img');
    qr.setAttribute('aria-label', 'QR code of the code');
    qr.innerHTML = qrSvg(encodeQr(qrText, 'L'));
    const side = h('div', 'lan-codeside', box);
    h('div', 'lan-code', side, code);
    const copy = button(side, 'Copy', key, () => {
      copyText(code, (ok) => {
        copy.textContent = ok ? 'Copied' : 'Select the text and copy it';
        window.setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      });
    });
  }

  /** Browser mode, not in a lobby: join with a code, or create a lobby in this tab. */
  function renderBrowser(panel: HTMLElement): void {
    h('div', 'lan-sub', panel, 'In browser · automatic lobby discovery is not available in this mode. The host gives each guest a join code');
    const cols = h('div', 'lan-cols', panel);
    const left = h('div', 'lan-list', cols);
    h('div', 'lan-hint', left, 'Join with code');
    const g = client.guest;
    const join = (): void => {
      if (joinCode.trim() === '') {
        client.message = "Paste the host's join code first";
        paint(true);
        return;
      }
      client.name = name.trim().slice(0, 12) || 'PLAYER';
      focusKey = 'join-copy';
      client.joinWithCode(joinCode, charId);
    };
    if (g.state === 'answering') {
      h('div', 'lan-note', left, 'Making your answer code...');
    } else if (g.state === 'answer') {
      h('div', 'lan-note', left, 'Give this answer code to the host. The host enters it to connect you.');
      codeBlock(left, g.code, g.code, 'join-copy');
      h('div', 'lan-note', left, 'Waiting for the host...');
      const actions = h('div', 'lan-actions', left);
      button(actions, 'Cancel', 'join-cancel', () => client.cancelGuest());
    } else {
      const line = h('div', 'lan-inline', left);
      const inp = field(line, joinCode, 'Join code', 1000, (v) => { joinCode = v; }, join);
      inp.classList.add('lan-code-field');
      inp.placeholder = 'Paste the host\'s join code';
      button(line, g.state === 'failed' ? 'Retry' : 'Join', 'join-go', join);
      if (g.state === 'failed') {
        h('div', 'lan-note lan-warn', left, g.message);
        h('div', 'lan-note', left, NETWORK_HINT);
      } else {
        h('div', 'lan-note', left, 'The host makes one code per guest. Paste it here, or scan the host\'s QR code with this device\'s camera.');
      }
    }
    youAndDraft(h('div', 'lan-list', cols));
    const actions = h('div', 'lan-actions', panel);
    button(actions, 'Create lobby', 'lobby-create', () => {
      focusKey = 'invite';
      client.name = name.trim().slice(0, 12) || 'PLAYER';
      store(DRAFT_KEY, JSON.stringify(draft));
      client.createInBrowser(draft, charId, { stages: stages.map((s) => s.id), characters: characters.map((c) => c.id) });
    });
    button(actions, 'Back', 'back', back);
  }

  /** Browser mode host: one join code per guest, and the answer codes coming back. */
  function renderInvites(panel: HTMLElement, members: number, inMatch: boolean): void {
    const box = h('div', 'lan-invites', panel);
    h('div', 'lan-hint', box, 'Invite players · each guest needs their own join code');
    const invites: Invite[] = client.host.list();
    for (const inv of invites) {
      const card = h('div', 'ui-frame lan-invite', box);
      card.setAttribute('style', accentVars(null));
      const head = h('div', 'lan-card-head', card);
      h('span', 'ui-tag', head, `Invite ${inv.id}`);
      const stateText = inv.state === 'preparing' ? 'Making the code' : inv.state === 'code' ? 'Waiting for an answer'
        : inv.state === 'connecting' ? 'Connecting' : 'Failed';
      h('span', `ui-tag${inv.state === 'failed' ? ' lan-warn' : ''}`, head, stateText);
      if (inv.state === 'code') {
        h('div', 'lan-note', card, 'Send this code to one guest (or let them scan it), then enter the answer code they get below.');
        codeBlock(card, inv.code, joinLink(inv.code), `invite-copy-${inv.id}`);
      } else if (inv.state === 'failed') {
        h('div', 'lan-note lan-warn', card, inv.message);
        h('div', 'lan-note', card, NETWORK_HINT);
      }
      const actions = h('div', 'lan-actions', card);
      if (inv.state === 'failed') button(actions, 'Retry', `invite-retry-${inv.id}`, () => client.host.retry(inv.id));
      button(actions, 'Cancel', `invite-cancel-${inv.id}`, () => client.host.cancel(inv.id));
    }
    if (invites.some((i) => i.state === 'code')) {
      const connect = (): void => {
        const err = answerCode.trim() === '' ? "Paste a guest's answer code first" : client.host.answer(answerCode);
        if (err === '') answerCode = '';
        client.message = err;
        focusKey = 'answer-go';
        paint(true);
      };
      const line = h('div', 'lan-inline', box);
      const inp = field(line, answerCode, 'Answer code', 1000, (v) => { answerCode = v; }, connect);
      inp.classList.add('lan-code-field');
      inp.placeholder = 'Paste a guest\'s answer code';
      button(line, 'Connect', 'answer-go', connect);
    }
    const actions = h('div', 'lan-actions', box);
    button(actions, 'Invite a player', 'invite', () => {
      focusKey = 'invite';
      client.host.invite();
    }, inMatch || !client.host.canInvite(members));
  }

  function renderLobby(panel: HTMLElement): void {
    const lobby = client.lobby;
    if (lobby === null) return;
    const me = client.me();
    const host = client.isHost();
    const localTeam = me === null ? 0 : me.team;
    const hostMember = lobby.members.find((m) => m.id === lobby.hostId);
    const sub = h('div', 'lan-sub', panel,
      `${lobby.settings.name} · hosted by ${hostMember?.name ?? '?'}${client.mode === 'browser' ? ' in their browser' : ` at ${client.lobbyAddress}`}${lobby.inMatch ? ' · match running' : ''} · your ping `);
    h('span', '', sub, pingLabel(client.rtt)).dataset.ping = 'me';
    const cols = h('div', 'lan-cols', panel);

    const left = h('div', 'lan-list', cols);
    h('div', 'lan-hint', left, host ? 'Lobby settings (you host)' : 'Lobby settings (the host decides)');
    settingsRows(left, lobby.settings, host && !lobby.inMatch, (next) => client.setSettings(next));

    const right = h('div', '', cols);
    h('div', 'lan-hint', right, host ? 'Slots. Click another player\'s slot tag to move them.' : 'Slots');
    const grid = h('div', 'lan-slots', right);
    const ordered: LobbyMember[] = [];
    if (me !== null) ordered.push(me);
    for (const m of lobby.members) if (me === null || m.id !== me.id) ordered.push(m);
    for (const m of ordered) {
      const isMe = me !== null && m.id === me.id;
      const card = h('div', `ui-frame lan-card${m.connected ? '' : ' lan-card-off'}`, grid);
      card.setAttribute('style', accentVars(displayColour(m.team, localTeam)));
      const head = h('div', 'lan-card-head', card);
      const slotTag = h('button', 'lan-chip', head, isMe ? LOCAL_TAG : `Slot ${m.slot + 1}`);
      slotTag.type = 'button';
      slotTag.title = `Lobby slot ${m.slot + 1}`;
      if (host && !lobby.inMatch) {
        nav(slotTag, `slot-${m.id}`);
        slotTag.addEventListener('click', () => {
          focusKey = `slot-${m.id}`;
          client.assign(m.id, (m.slot + 1) % LOBBY_MAX);
        });
      } else {
        slotTag.disabled = true;
      }
      if (m.id === lobby.hostId) h('span', 'ui-tag lan-host', head, 'Host');
      if (!m.connected) h('span', 'ui-tag lan-warn', head, 'Reconnecting');
      else if (m.rematch) h('span', 'ui-tag lan-ok', head, 'Rematch');
      else if (m.ready && m.id !== lobby.hostId) h('span', 'ui-tag lan-ok', head, 'Ready');
      h('div', 'lan-card-name', card, m.name);
      const line = h('div', 'lan-card-line', card);
      const charChip = h('button', 'lan-chip', line, charName(m.charId));
      charChip.type = 'button';
      const teamChip = h('button', 'lan-chip', line, `${TEAM_NAMES[m.team] ?? 'Team'} team`);
      teamChip.type = 'button';
      // variant: the member's outfit colour, a swatch circle and its name; the owner cycles it.
      const variant = clampVariant(m.variant);
      const variantChip = h('button', 'lan-chip', line);
      variantChip.type = 'button';
      h('span', 'lan-variant-dot', variantChip).style.background = VARIANT_SWATCHES[variant];
      variantChip.appendChild(document.createTextNode(VARIANT_NAMES[variant]));
      h('span', 'ui-tag', line, pingLabel(isMe ? client.rtt : m.ping)).dataset.ping = isMe ? 'me' : String(m.id);
      if (isMe && !lobby.inMatch) {
        nav(charChip, 'char');
        charChip.disabled = characters.length < 2;
        charChip.addEventListener('click', () => {
          focusKey = 'char';
          const i = characters.findIndex((c) => c.id === m.charId);
          charId = characters[(i + 1) % characters.length]?.id ?? m.charId;
          store(CHAR_KEY, charId);
          client.setMember({ charId });
        });
        nav(variantChip, 'variant');
        variantChip.title = 'Outfit colour';
        variantChip.addEventListener('click', () => {
          focusKey = 'variant';
          client.setMember({ variant: (variant + 1) % VARIANT_COUNT });
        });
        nav(teamChip, 'team');
        teamChip.title = 'Same colour = team';
        teamChip.addEventListener('click', () => {
          focusKey = 'team';
          client.setMember({ team: (m.team + 1) % PLAYER_ACCENTS.length });
        });
      } else {
        charChip.disabled = true;
        teamChip.disabled = true;
        variantChip.disabled = true;
      }
    }
    for (let s = 0; s < LOBBY_MAX; s++) {
      if (lobby.members.some((m) => m.slot === s)) continue;
      const card = h('div', 'ui-frame lan-card lan-card-empty', grid);
      card.setAttribute('style', accentVars(null));
      h('span', 'ui-tag', h('div', 'lan-card-head', card), `Slot ${s + 1}`);
      h('div', 'lan-card-name', card, lobby.settings.cpuFill ? `CPU LV ${lobby.settings.cpuLevel}` : 'Open');
    }

    if (host && client.mode === 'browser') renderInvites(panel, lobby.members.length, lobby.inMatch);

    const others = lobby.members.filter((m) => m.id !== lobby.hostId);
    const votes = lobby.members.filter((m) => m.rematch).length;
    const actions = h('div', 'lan-actions', panel);
    if (host) {
      const count = lobby.members.length + (lobby.settings.cpuFill ? LOBBY_MAX - lobby.members.length : 0);
      const allReady = others.every((m) => m.ready);
      button(actions, 'Start', 'start', () => client.start(), lobby.inMatch || !allReady || count < 2);
    } else if (me !== null) {
      button(actions, me.ready ? 'Unready' : 'Ready', 'ready', () => client.setMember({ ready: !me.ready }), lobby.inMatch);
    }
    button(actions, 'Leave lobby', 'leave', () => client.leave());
    const status = lobby.inMatch
      ? (votes > 0
        ? `Rematch votes ${votes}/${lobby.members.length}. Waiting for everyone to leave the results screen.`
        : 'Match running. Waiting for everyone to leave the results screen.')
      : votes > 0
        ? `Rematch votes ${votes}/${lobby.members.length}. It starts by itself when everyone votes.`
        : host
          ? (others.every((m) => m.ready) ? 'Everyone is ready.' : `Waiting for ${others.filter((m) => !m.ready).map((m) => m.name).join(', ')} to ready up.`)
          : 'The host starts the match once everyone is ready.';
    h('div', 'lan-hint', panel, status);
  }

  function back(): void {
    if (client.lobby !== null) client.leave();
    autoTried = false;
    if (client.mode !== 'none') {
      // Back from a mode returns to the mode choice (and drops that mode's connections).
      focusKey = '';
      client.setMode('none');
      return;
    }
    ctx.go('mode');
  }

  let pending = false;
  let lastSig = '';

  /** What the screen shows, minus pings (those update in place), to skip identical rebuilds. */
  function signature(): string {
    const lobby = client.lobby === null ? null : {
      ...client.lobby, members: client.lobby.members.map((m) => ({ ...m, ping: 0 })),
    };
    return JSON.stringify([client.agentStatus, client.lobbyStatus, client.message, client.agentAddress,
      client.rows(), lobby, draft, charId, client.mode, client.guest, client.host.list()]);
  }

  function updatePings(): void {
    for (const el of container.querySelectorAll<HTMLElement>('[data-ping]')) {
      const key = el.dataset.ping;
      const ms = key === 'me' ? client.rtt : client.lobby?.members.find((m) => String(m.id) === key)?.ping ?? -1;
      const text = pingLabel(ms);
      if (el.textContent !== text) el.textContent = text;
    }
  }

  function paint(force = false): void {
    const sig = signature();
    if (!force && sig === lastSig && container.firstChild !== null) {
      updatePings();
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && container.contains(active)) {
      // Never clobber typing; repaint shortly after the field loses focus.
      if (!pending) {
        pending = true;
        active.addEventListener('blur', () => window.setTimeout(() => { pending = false; paint(true); }, 150), { once: true });
      }
      return;
    }
    lastSig = sig;
    steppers.clear();
    container.textContent = '';
    const panel = h('div', 'ui-frame lan-panel', container);
    panel.setAttribute('style', accentVars(null));
    const bg = h('div', 'aev-menu-bg', panel);
    const face = h('img', 'ui-backdrop', bg);
    face.src = uiAsset('backdrop-face.png');
    face.alt = '';
    const header = h('h1', 'ui-header', panel);
    h('span', 'ui-spark', header);
    const inLobby = client.lobby !== null;
    header.appendChild(document.createTextNode(inLobby ? 'LAN lobby' : 'LAN'));
    h('div', 'aev-menu-headline', panel);

    if (inLobby) renderLobby(panel);
    else if (client.mode === 'none') renderChoose(panel);
    else if (client.mode === 'browser') renderBrowser(panel);
    else if (client.agentStatus !== 'connected') renderConnect(panel);
    else renderList(panel);

    let note = client.message;
    if (note === '' && client.lobbyStatus === 'joining') note = client.mode === 'browser' ? 'Joining...' : `Joining ${client.lobbyAddress}...`;
    h('div', 'lan-msg', panel, note);
    h('div', 'lan-hint', panel, 'Arrows move · Enter selects · Esc goes back');

    // Restore focus to the same control; never park it in a text field on its own, because a
    // focused field holds off repaints while the player types.
    const target = focusKey === '' ? null : container.querySelector<HTMLElement>(`[data-nav="${focusKey}"]`);
    const first = navigable()[0] ?? null;
    (target ?? first)?.focus({ preventScroll: true });
  }

  function navigable(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-nav]'))
      .filter((e) => !(e as HTMLButtonElement).disabled && !e.classList.contains('ui-item-disabled'));
  }

  ctx.addListener(window, 'keydown', (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (e.target instanceof HTMLInputElement) return;
    const active = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
      ? document.activeElement : null;
    switch (e.code) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'KeyW':
      case 'KeyS': {
        e.preventDefault();
        const list = navigable();
        if (list.length === 0) return;
        const i = active === null ? -1 : list.indexOf(active);
        const dir = e.code === 'ArrowUp' || e.code === 'KeyW' ? -1 : 1;
        list[(i + dir + list.length) % list.length].focus();
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        // Pad navigation dispatches on window, so steppers are driven from here too.
        if (e.isTrusted || active === null) return;
        const step = steppers.get(active);
        if (step !== undefined) {
          e.preventDefault();
          step(e.code === 'ArrowLeft' ? -1 : 1);
        }
        return;
      }
      case 'Enter':
      case 'Space':
        // A real key already activates the focused element; a pad press arrives only here.
        if (e.isTrusted || active === null) return;
        e.preventDefault();
        active.click();
        return;
      case 'Escape':
        e.preventDefault();
        if (client.lobby !== null) client.leave();
        else back();
        return;
      default:
        return;
    }
  });

  ctx.onCleanup(client.onChange(() => paint()));
  // Pings change without a lobby event; keep them fresh.
  const timer = window.setInterval(() => paint(), 1000);
  ctx.onCleanup(() => window.clearInterval(timer));
  paint();
}

// ---------------- In-match overlay ----------------

export const LAN_OVERLAY_CSS = `
.lan-ov {
  position: absolute; inset: 0; z-index: 6; pointer-events: none;
  --accent: #8fd3ff; --line: 1.5px; --chamfer: 14px; --panel: #0b1020; --text: #c9d4ea; --ink: #070a16;
  --font-ui: "Space Mono", Consolas, "Courier New", monospace;
  --font-display: "Cormorant Garamond", Georgia, "Times New Roman", serif;
  --glow: 0 0 8px color-mix(in srgb, var(--accent) 55%, transparent);
  font-family: var(--font-ui); color: var(--text);
}
.lan-ov [hidden] { display: none !important; }
.lan-ov-banner {
  position: absolute; left: 50%; top: 4%; transform: translateX(-50%); z-index: 6; pointer-events: none;
  font: 700 13px var(--font-ui, "Space Mono", Consolas, monospace); letter-spacing: 0.24em; text-transform: uppercase;
  padding: 7px 16px; background: rgba(7, 10, 22, 0.86); border: 1px solid currentColor; white-space: nowrap;
}
.lan-ov-stat {
  position: absolute; right: 1%; top: 1%; z-index: 6; pointer-events: none;
  font: 400 10px var(--font-ui, "Space Mono", Consolas, monospace); letter-spacing: 0.18em; text-transform: uppercase;
  color: #8a93a8; text-shadow: 0 0 3px #000;
}
.lan-ov-confirm {
  position: absolute; inset: 0; z-index: 7; display: flex; align-items: center; justify-content: center;
  background: rgba(7, 10, 22, 0.55); pointer-events: auto;
}
.lan-ov-box { padding: 1.2rem 1.6rem 1.3rem; display: flex; flex-direction: column; gap: 0.9rem; min-width: 20rem; }
.lan-ov-box .lan-ov-note { font-size: 0.66rem; letter-spacing: 0.2em; text-transform: uppercase; color: #8a93a8; }
.lan-ov-actions { display: flex; gap: 0.8rem; }
`;

export interface LanOverlay {
  /** '' hides the banner. */
  banner(text: string, color: string): void;
  stat(text: string): void;
  /** Ask "Leave match?". Resolves true on Leave, false on Stay (or Escape). */
  confirmLeave(): Promise<boolean>;
  confirming(): boolean;
  dispose(): void;
}

let overlayCss = false;

/** Banner, corner readout and the leave confirmation, laid over the match inside `host`. */
export function createLanOverlay(host: HTMLElement): LanOverlay {
  if (!overlayCss) {
    const st = document.createElement('style');
    st.textContent = LAN_OVERLAY_CSS;
    document.head.appendChild(st);
    overlayCss = true;
  }
  const root = h('div', 'lan-ov', host);
  const bannerEl = h('div', 'lan-ov-banner', root);
  bannerEl.hidden = true;
  const statEl = h('div', 'lan-ov-stat', root);
  let confirmEl: HTMLElement | null = null;
  let settle: ((leave: boolean) => void) | null = null;

  function closeConfirm(leave: boolean): void {
    if (confirmEl === null) return;
    confirmEl.remove();
    confirmEl = null;
    window.removeEventListener('keydown', onKey, true);
    const s = settle;
    settle = null;
    s?.(leave);
  }

  function onKey(e: KeyboardEvent): void {
    if (confirmEl === null) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeConfirm(false);
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      const buttons = Array.from(confirmEl.querySelectorAll<HTMLButtonElement>('button'));
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.code === 'Enter' && !e.isTrusted) {
      (document.activeElement as HTMLElement | null)?.click();
    }
  }

  return {
    banner(text: string, color: string): void {
      if (bannerEl.textContent !== text) bannerEl.textContent = text;
      bannerEl.hidden = text === '';
      bannerEl.style.color = color;
    },
    stat(text: string): void {
      if (statEl.textContent !== text) statEl.textContent = text;
    },
    confirmLeave(): Promise<boolean> {
      if (confirmEl !== null) return Promise.resolve(false);
      const wrap = h('div', 'lan-ov-confirm', root);
      confirmEl = wrap;
      const box = h('div', 'ui-frame lan-ov-box', wrap);
      box.setAttribute('style', accentVars(null));
      const header = h('h1', 'ui-header', box);
      h('span', 'ui-spark', header);
      header.appendChild(document.createTextNode('Leave match?'));
      h('div', 'lan-ov-note', box, 'The match keeps running. Leaving ends it for everyone.');
      const actions = h('div', 'lan-ov-actions', box);
      const stay = h('button', 'ui-btn', actions, 'Stay');
      stay.type = 'button';
      const leave = h('button', 'ui-btn', actions, 'Leave');
      leave.type = 'button';
      stay.addEventListener('click', () => closeConfirm(false));
      leave.addEventListener('click', () => closeConfirm(true));
      window.addEventListener('keydown', onKey, true);
      stay.focus();
      return new Promise((resolve) => { settle = resolve; });
    },
    confirming(): boolean {
      return confirmEl !== null;
    },
    dispose(): void {
      closeConfirm(false);
      root.remove();
    },
  };
}
