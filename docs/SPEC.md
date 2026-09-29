# Aevalrena. Master Spec (MVP 0.1)

Aevalrena is a browser platform fighter in the style of Super Smash Bros: percent damage, knockback
growth, blast zones, stocks. Pixel art, Canvas 2D, no 3D, no WebGL, no heavy GPU work. It must run at a
locked 60 Hz simulation on an integrated-graphics laptop.

This document is the single source of truth. Workers build to it. If something is not in here, the
worker asks or picks the simplest option and records the choice in `docs/DECISIONS.md`.

Reference for feel and scope: bandit.rip (a browser Smash-like). We ship a cleaner engine.

---

## 1. Scope of the MVP

In scope now:

- Local multiplayer on one keyboard, 2 to 4 players (2 default). CPU fill-in for empty slots.
- One character: **Aeval**, the Water Mage (reference art in `art/aeval/reference/aevalmere.png`). Small body, big waves.
- One stage: **Tidegate**, a Battlefield-style layout (main platform, two side platforms, one top).
- Full Smash move set: jab, 3 tilts, dash attack, 3 smashes (chargeable), 5 aerials, 4 specials, taunt.
- Shield, spot dodge, roll, air dodge, ledge grab/hang/climb, double jump, fast fall, short hop.
- Percent, knockback formula, hitstun, hitlag, tumble, blast zone KO, stocks, respawn with invuln.
- Fully remappable keyboard controls per player, saved to localStorage.
- Menus: title, mode select, character select, controls, pause, results.
- Debug overlays: hitboxes, frame data, perf.
- Deployable as a static site to GitHub Pages and Cloudflare Pages.

Deferred (keep the seams open, do not build):

- LAN multiplayer, server multiplayer, rollback netcode. The `SessionAdapter` seam exists for them.
- Grabs and throws. Teching. Directional influence. Items. More characters and stages.
- Gamepad input (the input layer maps to an abstract `InputFrame`, so it slots in later).
- Sound. A `SimEvent` stream exists so audio can subscribe later.

---

## 2. Architecture

Three layers with a hard boundary between them. The boundary is what makes rollback netcode possible
later without a rewrite.

```
input  -->  InputFrame[]  -->  SIM (pure, deterministic, no DOM)  -->  GameState  -->  RENDER (Canvas 2D)
                               ^                                                        |
                        SessionAdapter                                            SimEvent[] (fx, shake)
```

Rules that every worker obeys:

1. `src/sim/**` never imports from `src/render/**`, `src/input/**`, `src/ui/**`, or touches `window`,
   `document`, `Date`, `Math.random`, or `performance`. Randomness comes from `state.rng`.
2. The sim advances only through `stepGame(state, inputs)`. One call = one frame at 60 Hz.
3. Render reads `GameState` and never mutates it.
4. Every shared type lives in `src/core/types.ts`. That file is frozen after scaffold. Workers add
   internal types inside their own directories only.
5. No frameworks. No React. Plain TypeScript, Vite for bundling, Canvas 2D for the game, plain DOM
   for menus (menus are outside the hot path).
6. Hot path allocation discipline: no per-frame object churn in sim step or render. Reuse arrays, pool
   particles, precompute sprite canvases at load.

### 2.1 Directory ownership

Each wave-2 worker owns exactly one directory. Nobody edits another worker's directory.

| Path | Owner | Contents |
|---|---|---|
| `src/core/` | scaffold | `types.ts` (frozen contract), `constants.ts`, `loop.ts`, `math.ts`, `rng.ts` |
| `src/input/` | input worker | keyboard capture, bindings, remap, localStorage, `LocalSession` adapter |
| `src/sim/` | sim worker | physics, fighter state machine, hit detection, knockback, match rules, projectiles |
| `src/characters/aeval/moves.ts` | sim worker | Aeval frame data (sim half) |
| `src/characters/aeval/sprites.ts` | art worker | Aeval pixel sprites and effect sprites (render half) |
| `src/characters/registry.ts` | scaffold | maps character id to def and sprites |
| `src/stages/tidegate/data.ts` | scaffold | platform layout, blast zones, spawns (sim half) |
| `src/stages/tidegate/art.ts` | render worker | parallax layers, platform art (render half) |
| `src/stages/registry.ts` | scaffold | maps stage id to data and art |
| `src/render/` | render worker | canvas setup, camera, sprite baker, particles, HUD, debug overlay |
| `src/ai/` | ai worker | `cpuInput(state, slot, rng): InputFrame` |
| `src/ui/` | ui worker | DOM menus, controls remap screen, pause, results |
| `src/main.ts` | integration | wires everything, owns the app state machine |
| `docs/` | lead | this spec, decisions log, roadmap |
| `.github/workflows/` | scaffold | Pages deploy |

---

## 3. Shared contract: `src/core/types.ts`

The scaffold worker creates this file exactly. Wave-2 workers import from it and never edit it.
Use plain `const` objects for flags, not `const enum` (esbuild does not inline const enums).

```ts
export const SIM_HZ = 60;
export const VIEW_W = 640;   // logical pixels, 16:9, integer-scaled to the window
export const VIEW_H = 360;
export const MAX_PLAYERS = 4;

// ---------------- Input ----------------
export const Btn = {
  Left: 1 << 0, Right: 1 << 1, Up: 1 << 2, Down: 1 << 3,
  Jump: 1 << 4, Attack: 1 << 5, Special: 1 << 6, Shield: 1 << 7,
  Taunt: 1 << 8, Start: 1 << 9,
} as const;

/** One player's input for one sim frame. Bitmasks of Btn. */
export interface InputFrame { held: number; pressed: number; released: number }

export type InputAction =
  'left' | 'right' | 'up' | 'down' | 'jump' | 'attack' | 'special' | 'shield' | 'taunt' | 'start';
/** KeyboardEvent.code per action, e.g. { left: 'KeyA', ... } */
export type Bindings = Record<InputAction, string>;
export interface PlayerControls { bindings: Bindings; tapJump: boolean }
export interface ControlsConfig { players: PlayerControls[] }   // length MAX_PLAYERS

/** Seam for local / LAN / online. Only 'local' is implemented in the MVP. */
export interface SessionAdapter {
  readonly kind: 'local' | 'lan' | 'online';
  start(): void;
  stop(): void;
  /** Inputs for every slot (length = player count) for this sim frame, or null to stall. */
  inputsForFrame(frame: number): InputFrame[] | null;
}

// ---------------- Geometry ----------------
export interface Vec2 { x: number; y: number }
/** Axis-aligned box. x,y is top-left. y grows downward. */
export interface Rect { x: number; y: number; w: number; h: number }

// ---------------- Characters (sim half) ----------------
export type Facing = 1 | -1;

export type MoveId =
  'jab' | 'ftilt' | 'utilt' | 'dtilt' | 'dashatk' |
  'fsmash' | 'usmash' | 'dsmash' |
  'nair' | 'fair' | 'bair' | 'uair' | 'dair' |
  'nspecial' | 'sspecial' | 'uspecial' | 'dspecial' |
  'taunt' | 'ledgeatk' | 'getupatk';

/** Circle hitbox in fighter-local space, facing right. Mirror x when facing left. */
export interface HitboxDef {
  id: number;             // unique within the move
  start: number;          // first active frame (inclusive, 0-based move frame)
  end: number;            // last active frame (inclusive)
  x: number; y: number;   // offset from fighter origin (origin = feet center)
  r: number;              // radius, px
  damage: number;
  angle: number;          // degrees, 0 = away from attacker, 90 = straight up. 361 = Sakurai angle
  bkb: number;            // base knockback
  kbg: number;            // knockback growth
  group: number;          // a victim can be hit by only one hitbox per group per move use
  hitlagMul?: number;     // default 1
  shieldDamage?: number;  // default = damage
}

export interface ProjectileDef {
  id: string;
  spawnFrame: number;
  x: number; y: number;     // fighter-local spawn offset, facing right
  vx: number; vy: number;   // px/frame, mirrored by facing
  gravity: number;
  lifetime: number;         // frames
  r: number;                // hit circle radius, centered on projectile
  damage: number; angle: number; bkb: number; kbg: number;
  destroyOnHit: boolean;
  sprite: string;           // key into the character's effect sheet
  animFps?: number;
}

export interface MoveDef {
  id: MoveId;
  totalFrames: number;
  hitboxes: HitboxDef[];
  projectiles?: ProjectileDef[];
  /** Momentum injected on given frames, fighter-local (x mirrored by facing). */
  velocity?: { frame: number; vx?: number; vy?: number; setX?: boolean; setY?: boolean }[];
  landingLag?: number;      // aerials only
  iasa?: number;            // frame after which other actions may interrupt
  chargeable?: boolean;     // smashes: hold to charge before totalFrames start
  invuln?: [number, number];
  helplessAfter?: boolean;  // up-special: fall helpless when done in air
  airOnly?: boolean;
  groundOnly?: boolean;
}

export interface CharacterDef {
  id: string;
  name: string;
  weight: number;           // 100 = Mario-ish. Higher = harder to launch
  walkSpeed: number; runSpeed: number; dashSpeed: number; dashFrames: number;
  groundAccel: number; groundFriction: number;
  airSpeed: number; airAccel: number; airFriction: number;
  gravity: number; maxFall: number; fastFall: number;
  jumpVel: number; shortHopVel: number; doubleJumpVel: number; jumps: number; jumpSquat: number;
  hurtbox: { w: number; h: number };        // standing, centered on x, feet at y
  crouchHurtbox: { w: number; h: number };
  ledgeGrabBox: { w: number; h: number; yOff: number };
  moves: Record<MoveId, MoveDef>;
}

// ---------------- Characters (render half) ----------------
/**
 * Sprite atlas. One packed PNG plus a frame table; `frames` maps a frame name
 * to its [x, y, w, h] rect in atlas pixels. The atlas arrives as a data URL so
 * no asset path is involved and a Pages deploy under a sub-path still works.
 *
 * `origin` says where a frame's rect anchors when drawn. Body frames are baked
 * so the bottom row is the character's heel line and the horizontal middle is
 * the body's middle; effect frames anchor at their middle in both axes.
 */
export interface ImageSheetData {
  url: string;
  origin: 'bottom-center' | 'center';
  frames: Record<string, [number, number, number, number]>;
  /**
   * Colours the player-colour outline ring skips, as '#rrggbb'. Aeval's attack
   * frames have their water drawn into them; ringing every droplet in the
   * player colour turns a clean sweep into confetti, so the ring traces the
   * fighter and lets the water alone.
   */
  outlineIgnore?: string[];
}
export interface AnimDef { frames: string[]; fps: number; loop: boolean }
export type AnimName = string;
export interface CharacterSprites {
  sheet: ImageSheetData;              // body frames
  fx: ImageSheetData;                 // projectiles and effect frames
  anims: Record<AnimName, AnimDef>;
  /** Map a sim action + move to an animation name. Must never return undefined. */
  animFor(action: ActionId, moveId: MoveId | null): AnimName;
}

// ---------------- Stages ----------------
export interface Platform {
  x: number; y: number; w: number; h: number;
  solid: boolean;                  // false = pass-through from below, drop-through with down
  ledgeLeft: boolean; ledgeRight: boolean;
}
export interface StageDef {
  id: string;
  name: string;
  platforms: Platform[];
  blast: Rect;                     // outside this = KO
  spawns: Vec2[];                  // length MAX_PLAYERS, feet positions
  respawn: Vec2;                   // respawn platform position (feet)
  cameraBounds: Rect;              // camera never shows outside this
}
export interface ParallaxLayer {
  parallax: number;                // 0 = fixed to screen, 1 = moves with world
  draw(ctx: CanvasRenderingContext2D, camX: number, camY: number, zoom: number, t: number): void;
}
export interface StageArt {
  layers: ParallaxLayer[];         // back to front, drawn before fighters
  foreground: ParallaxLayer[];     // drawn after fighters
  drawPlatforms(ctx: CanvasRenderingContext2D, stage: StageDef, t: number): void;
}

// ---------------- Sim state ----------------
export type ActionId =
  'idle' | 'walk' | 'dash' | 'run' | 'turn' | 'crouch' | 'jumpsquat' |
  'air' | 'airHelpless' | 'land' |
  'attack' |
  'shield' | 'shieldStun' | 'shieldBreak' | 'spotDodge' | 'roll' | 'airDodge' |
  'hitstun' | 'tumble' | 'ledgeGrab' | 'ledgeHang' | 'ledgeClimb' | 'ledgeRoll' | 'ledgeJump' |
  'dead' | 'respawn';

export interface FighterState {
  slot: number;
  charId: string;
  x: number; y: number;          // feet center, world px
  vx: number; vy: number;
  facing: Facing;
  onGround: boolean;
  action: ActionId;
  actionFrame: number;           // frames spent in current action
  moveId: MoveId | null;
  charge: number;                // smash charge frames
  percent: number;
  stocks: number;
  jumpsLeft: number;
  fastFalling: boolean;
  hitstun: number;               // frames remaining
  hitlag: number;                // freeze frames remaining
  invuln: number;                // frames remaining (respawn / dodge)
  shieldHp: number;              // 0..SHIELD_MAX
  ledge: number;                 // index into stage platform list * 2 + side, or -1
  ledgeRegrabs: number;
  lastHitBy: number;             // slot or -1
  hitGroups: number;             // bitmask of hitbox groups already landed this move use
  respawnTimer: number;
  buffer: { btn: number; age: number };   // input buffer for the next action
  inputHeld: number;             // last InputFrame.held, for renderer/AI convenience
  dirTapAge: number;             // frames since last left/right press, for smash detection
  dirTapDir: number;             // -1, 0, 1
}

export interface ProjectileState {
  id: number;
  owner: number;                 // slot
  defId: string;
  x: number; y: number; vx: number; vy: number;
  facing: Facing;
  age: number;
  hitSlots: number;              // bitmask of slots already hit
  alive: boolean;
}

export type SimEvent =
  | { type: 'hit'; x: number; y: number; attacker: number; victim: number; damage: number; kb: number; angle: number }
  | { type: 'shieldHit'; x: number; y: number; victim: number }
  | { type: 'ko'; x: number; y: number; slot: number; side: 'left' | 'right' | 'top' | 'bottom' }
  | { type: 'land'; x: number; y: number; slot: number; hard: boolean }
  | { type: 'jump'; x: number; y: number; slot: number; double: boolean }
  | { type: 'dash'; x: number; y: number; slot: number; facing: Facing }
  | { type: 'projectileSpawn'; x: number; y: number; slot: number; defId: string }
  | { type: 'projectileDie'; x: number; y: number; defId: string }
  | { type: 'shieldBreak'; x: number; y: number; slot: number }
  | { type: 'respawn'; x: number; y: number; slot: number }
  | { type: 'matchEnd'; winner: number };

export interface MatchConfig {
  stageId: string;
  players: { slot: number; charId: string; cpu: boolean; cpuLevel: number }[];
  stocks: number;
  timeLimitSec: number;          // 0 = none
  seed: number;
}

export interface GameState {
  frame: number;
  rng: { s: number };            // xorshift state; sim owns it
  config: MatchConfig;
  stageId: string;
  fighters: FighterState[];      // index = slot order in config.players
  projectiles: ProjectileState[];
  events: SimEvent[];            // cleared at the start of every step, filled during it
  finished: boolean;
  winner: number;                // slot or -1
  timeLeft: number;              // frames, or -1
  nextProjectileId: number;
}
```

Module public APIs (also in `src/core/types.ts`, frozen). Each worker's `index.ts` exports exactly
these; the scaffold creates stubs with these signatures that throw `new Error('not implemented')`.

```ts
// ---- src/sim/index.ts ----
export interface SimApi {
  createGameState(config: MatchConfig): GameState;
  stepGame(state: GameState, inputs: InputFrame[]): void;
  cloneGameState(state: GameState): GameState;     // deep copy, for rollback later
}

// ---- src/render/index.ts ----
export interface DebugFlags { hitboxes: boolean; frameData: boolean; perf: boolean }
export interface PerfSample { simMs: number; renderMs: number; fps: number }
export interface Renderer {
  load(): Promise<void>;                            // bake sprites, fonts, stage layers
  setStage(stageId: string): void;
  /** prev may be null on the first frame. alpha in [0,1] interpolates prev -> state. */
  render(state: GameState, prev: GameState | null, alpha: number, debug: DebugFlags, perf: PerfSample): void;
  resize(): void;                                   // recompute integer scale from window size
  shake(amount: number): void;                      // hint from events, clamped inside
}
// factory: createRenderer(canvas: HTMLCanvasElement): Renderer

// ---- src/input/index.ts ----
export interface InputSystem {
  controls: ControlsConfig;
  save(): void;
  resetDefaults(player: number): void;
  setBinding(player: number, action: InputAction, code: string): void;
  setTapJump(player: number, on: boolean): void;
  listenForNextKey(): Promise<string>;              // resolves with KeyboardEvent.code; Escape cancels (rejects)
  conflicts(): { player: number; action: InputAction; code: string }[];
  /** true while any bound key for any player is down; UI uses it for "press any key" */
  anyKeyDown(): boolean;
}
export type SlotProvider = (frame: number, state: GameState) => InputFrame;
export interface LocalSession extends SessionAdapter {
  setSlotProvider(slot: number, provider: SlotProvider | null): void;   // CPU hook
  setState(state: GameState): void;                                     // so providers can read it
}
// factories: createInputSystem(): InputSystem
//            createLocalSession(input: InputSystem, config: MatchConfig): LocalSession

// ---- src/ai/index.ts ----
// export function cpuInput(state: GameState, slot: number, level: number, rand: () => number): InputFrame

// ---- src/ui/index.ts ----
export type UiScreen = 'title' | 'mode' | 'select' | 'controls' | 'pause' | 'results';
export interface ResultsData { winner: number; players: { slot: number; charId: string; stocks: number; percent: number }[] }
export interface UiDeps {
  characters: { id: string; name: string }[];
  stages: { id: string; name: string }[];
  input: InputSystem;
}
export interface UiCallbacks {
  startMatch(config: MatchConfig): void;
  resume(): void;
  quit(): void;
  rematch(): void;
}
export interface UiController {
  show(screen: UiScreen, data?: ResultsData): void;
  hide(): void;
  current(): UiScreen | null;
}
// factory: createUi(root: HTMLElement, deps: UiDeps, callbacks: UiCallbacks): UiController
```

`src/core/constants.ts` (scaffold creates, sim and render read):

```ts
export const INPUT_BUFFER = 6;        // frames an input stays buffered
export const SMASH_TAP_WINDOW = 5;    // frames since direction press that turns attack into a smash
export const SMASH_CHARGE_MAX = 60;   // frames
export const SMASH_CHARGE_BONUS = 0.4;  // +40% damage at full charge
export const SHIELD_MAX = 60;
export const SHIELD_DECAY = 0.12;     // per frame held
export const SHIELD_REGEN = 0.07;     // per frame not held
export const SHIELD_BREAK_STUN = 180;
export const SHIELD_STUN_PER_DAMAGE = 0.6;  // frames of shield stun per damage point, +2 floor
export const SPOT_DODGE = { total: 22, invStart: 3, invEnd: 17 };
export const ROLL = { total: 30, invStart: 4, invEnd: 19, distance: 44 };
export const AIR_DODGE = { total: 34, invStart: 2, invEnd: 31 };   // one per airborne period, no cooldown
export const LEDGE_HANG_INVULN = 40;
export const LEDGE_MAX_REGRABS = 3;
export const RESPAWN_INVULN = 120;
export const RESPAWN_PLATFORM_FRAMES = 180;
export const KB_DECAY = 0.051;        // px/frame of launch speed lost per frame
export const KB_TO_VEL = 0.06;        // launch speed px/frame per knockback unit
export const HITSTUN_PER_KB = 0.4;
export const TUMBLE_KB = 80;          // knockback above which victim tumbles
export const HITLAG = (damage: number) => Math.min(20, Math.floor(damage * 0.5) + 4);
export const SAKURAI_WEAK_ANGLE = 0;
export const SAKURAI_STRONG_ANGLE = 40;
export const SAKURAI_KB_THRESHOLD = 60;
```

---

## 4. Simulation rules (sim worker)

### 4.1 Frame step order

For each `stepGame(state, inputs)`:

1. `events.length = 0`. `frame++`. Tick `timeLeft`.
2. For each fighter in slot order: consume `inputs[slot]` (update buffer, dirTap age, inputHeld).
3. For each fighter with `hitlag > 0`: decrement, skip movement this frame (still allow buffered input).
4. Fighter update: state machine transition, then physics (gravity, friction, velocity, platform
   collision, ledge grab check, blast-zone check).
5. Projectile update: move, age, die on lifetime/blast.
6. Hit detection: every active hitbox (fighter moves and projectiles) against every other fighter's
   hurtbox. Resolve hits (damage, knockback, hitlag to both, hitstun, shield).
7. Match rules: stocks, KO events, respawn timers, finished/winner.

The step must be deterministic given `(state, inputs)`. Iterate fighters and projectiles in index
order. Never use `Map` iteration where order could vary.

### 4.2 Physics

- Units: world px, px/frame. y grows downward. Feet at `(x, y)`.
- Ground: a fighter is on a platform when its feet are within 4 px above the platform top, moving
  downward or stationary, and horizontally inside `[x, x+w]`. Pass-through platforms only catch a
  fighter whose previous-frame feet were above the platform top. Down + pass-through = drop through
  (unless shielding; shield + down = spot dodge).
- Solid platform sides and underside block movement.
- Gravity applies in the air. Fast fall: pressing down while airborne and moving downward sets
  `vy = fastFall` and `fastFalling = true` until landing.
- Ground movement: walk when direction held (speed walkSpeed), dash when direction tapped
  (dirTapAge <= SMASH_TAP_WINDOW) from idle, dash lasts dashFrames then becomes run while held.
  Turning during dash = dash the other way (dash dance). Run stops with a 6-frame skid when released.
- Air drift: accelerate toward held direction by airAccel up to airSpeed; airFriction otherwise.
- Jump: jumpsquat frames on ground, then `vy = -jumpVel`; if jump released before the end of
  jumpsquat, `vy = -shortHopVel`. Double jump in air: `vy = -doubleJumpVel`, resets horizontal air
  momentum toward held direction, decrements jumpsLeft. `jumpsLeft` resets on landing and ledge grab.
- Landing: `land` action with lag 4 frames (normal) or the move's `landingLag` if landing during an
  aerial. Hard landing when `vy >= fastFall` shows dust (event `land.hard`).
- Knockback velocity: on hit set `(vx, vy)` from launch speed and angle. While in hitstun, each frame
  decay the speed by `KB_DECAY` along the launch direction and add gravity to vy. Fighters in hitstun
  cannot act. Tumble when kb >= `TUMBLE_KB`: hitstun ends but fighter stays in `tumble` until they
  press any button (then `air`) or land (then a 12-frame getup).
- Blast zones: feet position outside `stage.blast` = KO. Side of exit is reported in the event.

### 4.3 Action selection (the Smash decision table)

Input buffer: a button press stays buffered for `TUNING.input.buffer` frames (6) and is consumed by
the first action that accepts it. Directions are read from `held`. A direction pressed within
`TUNING.input.smashTapWindow` frames (5) of Attack is a smash instead of a tilt, unless Walk is held:
holding Walk always downgrades that flick to a tilt, whatever the timing, because a walking stick is
tilted, not flicked. The C-stick and the smash/tilt shortcut keys (F and G modifiers, see Shortcuts
below) reach the same moves with no timing at all, and are not gated by Walk.

Ground, actionable (idle, walk, run, dash, turn, crouch, land after lag):

| Input | Move |
|---|---|
| Attack, no direction | jab |
| Attack, left/right held while Walk is held, even on a fresh flick, or G&J | ftilt (faces that way) |
| Attack, left/right within the smash tap window while Walk is not held (a flick, even out of a dash), C-stick left/right, or F&J | fsmash (chargeable) |
| Attack, Up held | utilt (Up alone jumps; Walk suppresses tap jump so this is reachable on keyboard) |
| Attack, Up within the smash tap window while Walk is not held, C-stick up, F&W, jump-cancelled from jumpsquat, or out of shield | usmash (chargeable) |
| Attack, Down held, or G&S | dtilt |
| Attack, Down within the smash tap window while Walk is not held, C-stick down, or F&S | dsmash (chargeable) |
| Attack while dashing or running | dash attack |
| Special, no direction | nspecial | 40 (56 full charge) | projectile f11 (f27 full charge) | 4 (16 full) | 40 | 14 / 30 (40 / 36 full) | Water Orb: vx 3.5 to 9.5, lifetime 48 to 34, r 8 to 12, clash strength 2 to 10, chargeCastFrames 16; `charged` fields lerp on the exponential charge curve and power stays 1 (no double scaling), scale 0.6-1.5 sizes the circle and sprite; destroyOnHit; bursts (2 dmg on a tap to 8 at full, same strength and scale as the orb) and the burst skips every fighter the orb hit |
| Special + a side | sspecial (faces that way) |
| Special + Up, jump-cancelled from jumpsquat, or out of shield | uspecial (`helplessAfter` in the air) |
| Special + Down | dspecial |
| Grab, or Shield + Attack out of shield (unless Up is held or the tap reads as a vertical smash) | grab |
| Jump, or Up when tap jump is on and Walk is not held | jumpsquat |
| Shield | shield |
| Double-tap left/right, or Dodge + a held direction | roll (toward that direction) |
| Double-tap Down, or Dodge with no direction held | spot dodge |
| Taunt, or Taunt + a side/Down | taunt / taunt2 / taunt3 |

Air, actionable (air with no hitstun, not helpless):

| Input | Move |
|---|---|
| Attack, no direction, or C-stick with none | nair |
| Attack toward the held facing direction, C-stick the same side, or the ftilt/fsmash/dashatk shortcut key held toward facing | fair |
| Attack away from facing, C-stick the opposite side, or that same shortcut key held away from facing | bair |
| Attack up, C-stick up, or the utilt/usmash shortcut key | uair |
| Attack down, C-stick down, or the dtilt/dsmash shortcut key | dair |
| Special (+ direction) | specials, same as on the ground |
| Jump | double jump if `jumpsLeft > 0` |
| Shield, or Dodge | air dodge toward the held direction |
| Down while falling | fast fall |

Smash charge: a `chargeable` move holds at frame 0 for up to `chargeMax` frames (60) while its charge
button is held down. That button is Special for a move whose `chargeButton` is `'special'`; otherwise
it depends on how the smash started. A smash started with Attack held (a flick, or a jump-cancelled /
out-of-shield smash) charges on Attack. A smash started without Attack down at all — the F&W up
smash, the F&S down smash, or the C-stick — has no Attack key in its input, so it charges instead on
its own direction: Up for up smash, Down for down smash, the facing side (or the matching C-stick
direction) for forward smash. Damage scales by `1 + chargeBonus * charge/max` (chargeBonus 0.4).

Moves end at `totalFrames`, or earlier at `iasa` if a new action is requested. Aerials that reach the
ground apply `landingLag`. A shortcut move (its own key or a chord) that lands within
`SHORTCUT_REPLACE_FRAMES` frames (3) of a button-started attack replaces that attack, so a chord
pressed "together", in either order, still comes out as the chord's move.

#### Grab, pummel, throws

The Grab button grabs on the ground only. Out of shield, Attack grabs unless Up is held or the tap
reads as a vertical smash, in which case it is an up smash instead. Attack while holding pummels. A
throw direction still held after the grab's hold-frame delay picks that throw (fthrow, bthrow,
uthrow, dthrow); bthrow turns the holder to face the other way first.

#### Shield

Shield only shields on the ground (`stepShield`). A Shield press in the air air dodges toward the
held direction instead, the same as the Dodge button would. Out of shield, only Jump (jumps), Grab
(grabs), Attack without Up or a vertical smash tap (grabs), Attack with Up or a vertical smash tap
(usmash), Special with Up (uspecial), C-stick up (usmash), a direct usmash/uspecial key, and the
double-tap roll/spot-dodge or the Dodge button (roll or spot dodge) come out; every other attack,
special, C-stick direction, direct-move key, or taunt is dropped and shield HP keeps decaying.

#### Dodges

A double-tap of Left or Right on the ground rolls; a double-tap of Down spot dodges (the first tap of
either never dodges by itself). The Dodge button rolls toward a held direction, spot dodges with
none held, and air dodges toward the held direction in the air. Shield in the air also air dodges
toward the held direction; Shield on the ground never rolls or spot dodges. A roll is `ROLL.total`
frames long (24), dodges (`highDodge`) on frames `ROLL.invStart` to `ROLL.invEnd` (3 to 16), and
covers `ROLL.distance` px (60). A roll's dodge does not stop a low hit: dtilt, dsmash, any hit
centered within `LOW_HIT_HEIGHT` px (14) above the victim's feet from a grounded attacker, or a
projectile flagged `low`, all still connect. In tumble, Shield is only a tech press (it does not end
tumble or dodge by itself); Dodge (or the `airDodge` / `dirAirDodge` commands) air dodges out of
tumble while airborne.

Air dodge: one per airborne period, no cooldown timer. Every way in (Shield or Dodge in the air, the
`airDodge` / `dirAirDodge` commands, a dodge out of tumble) starts only while the fighter field
`airDodgeUsed` is false, and sets it. Landing, a ledge grab and a respawn clear it; being hit does
not. `AIR_DODGE.total` is 34 frames, invulnerable on frames 2 to 31.

#### Shortcuts

A chord is two or more `KeyboardEvent.code`s (or pad codes) joined by `&` in a binding, e.g.
`'KeyF&KeyJ'` ('&' is the separator because pad axis codes already use '+'). A chord is down while
every member code is down, and it fires (counts as pressed) on the sample it becomes down, whichever
member key was the last one pressed, so it fires the same whichever order the keys go down in. The
plain presses of its member codes are suppressed on that sample, so bindings that share those codes
do not also fire (the codes still count as held). A shortcut (its own key or a chord) that arrives
within `SHORTCUT_REPLACE_FRAMES` frames of a button-started attack replaces it. Only the up smash and up special shortcuts, plus Up + Attack, Up + Special, or C-stick up, cancel a
jumpsquat into their grounded move; this is the only jump-cancel Smash has. Any other shortcut
pressed during jumpsquat stays buffered and comes out once airborne as its aerial (a forward shortcut
becomes a fair, or a bair with back held).

#### Tap jump

Up jumps by default. A Jump key that is also bound to Up, and stick tap jump
(`PlayerControls.tapJump`), are both suppressed while the Walk bit is held, so Walk + Up + Attack
reaches up tilt on keyboard instead of jumping. On a gamepad, a stick tilted up but short of the walk
threshold (`TUNING.input.walkAxis`) does not tap jump either, so a pad player can hold a gentle
upward tilt and press Attack for an up tilt instead; only a full push up jumps.

### 4.4 Hit resolution

Circle hitbox vs rect hurtbox (nearest-point distance test). For every attacker-victim pair, only the
first active hitbox in `id` order can connect this frame; a victim is hit by at most one hitbox per
`group` per move use (tracked in `hitGroups`). Projectiles track `hitSlots`.

Damage: `d = hitbox.damage * chargeMul`. Victim percent += d (cap 999).

Knockback (Smash 4 / Ultimate formula):

```
p = victim.percent (after damage)
w = victim weight
kb = ((((p / 10) + (p * d / 20)) * (200 / (w + 100)) * 1.4) + 18) * (kbg / 100) + bkb
```

Launch speed = `kb * KB_TO_VEL` px/frame. Angle = hitbox angle, mirrored by attacker facing. Sakurai
angle (361): `SAKURAI_WEAK_ANGLE` when `kb < SAKURAI_KB_THRESHOLD` or victim grounded and weak,
otherwise `SAKURAI_STRONG_ANGLE`. A grounded victim launched at angle < 15 stays grounded and slides
unless kb >= TUMBLE_KB. Hitstun = `floor(kb * HITSTUN_PER_KB)`. Both attacker and victim get
`HITLAG(d) * hitlagMul` freeze frames. Victim becomes `hitstun` (or `tumble` if kb >= TUMBLE_KB).

Shield: if victim is in `shield` and the hit comes from the front or back (shield covers all), shield
loses `shieldDamage`, victim gets `shieldStun = floor(d * SHIELD_STUN_PER_DAMAGE) + 2` frames, slight
pushback (2 px/frame decaying). Shield HP <= 0 = `shieldBreak` for `SHIELD_BREAK_STUN` frames.

Invulnerable victims (invuln > 0, dodge inv frames, ledge hang invuln) are not hit.

Projectile clashes compare `ProjectileDef.strength` only (lerped by charge through `charged.strength`
where a def has one). Two opposing shots whose hit circles touch: the strictly stronger destroys the
weaker and flies on untouched; equal strength destroys both. A destroyed shot still bursts. Aeval's
tiers: jabDrop 1, orb 2 (tap) to 10 (full), orbBurst the same 2 to 10 as its orb (it rides the inherited charge, so it never out-ranks its orb), crescent 4.

### 4.5 Ledges

A platform with `ledgeLeft/ledgeRight` has a grab point at its top corner. A fighter that is airborne,
falling (vy > 0), not in hitstun, not attacking, and whose `ledgeGrabBox` overlaps a grab point (and
is facing it or moving toward it) snaps to `ledgeHang` at the ledge with `LEDGE_HANG_INVULN` frames
of invuln. From hang: up or toward-stage = `ledgeClimb` (30f, invulnerable for its first 28),
jump = `ledgeJump` (invulnerable for 12 frames from the frame it leaves), attack = `ledgeatk`
(invulnerable on move frames 0 to 21), shield = `ledgeRoll` (invulnerable through `ROLL.invEnd + 6`),
down or away = drop (regain double jump). A hang never times out: nothing but the fighter's own
ledge option or a KO ends it (ledge stalling is allowed). Each regrab without landing increments
`ledgeRegrabs`; above `LEDGE_MAX_REGRABS` the ledge does not grant invuln.

### 4.6 Match

Stocks mode. KO: stocks--, `dead` for 60 frames, then `respawn` on the respawn platform for up to
`RESPAWN_PLATFORM_FRAMES` (leaves early on any input), `RESPAWN_INVULN` frames of invuln from the
moment of respawn. 0 stocks = out. Last fighter with stocks wins. Time limit optional: when
`timeLeft` hits 0, most stocks then lowest percent wins. `finished = true`, `matchEnd` event once.

### 4.7 CPU (ai worker)

`cpuInput(state, slot, level): InputFrame` returns a synthesized input frame each sim frame. Level
1 to 3. Behaviour: walk toward nearest opponent, attack when within range with tilts and aerials,
jump when opponent is above, recover with double jump and up special when off stage, shield or dodge
sometimes when an opponent starts an attack (level 3 only), never walk off the stage on purpose.
Use `state.rng` through a passed-in function, never `Math.random`. Keep it under 250 lines.

#### CPU level 0

Level 0 is a training dummy, not a difficulty: `cpuInput` hands it straight to `dummyInput` before
any `CpuProfile` is looked up. It never presses Attack, Special, Grab, Shield, Dodge, Taunt, the
C-stick, or Down. With the match rule `cpuZeroMoves` off (the Mode screen's "Lv 0 CPU" row reads
"Stands still") it presses nothing at all, including while downed, so a knocked-down dummy lies there
until the knockdown timer runs out on its own. With the rule on ("Wanders") it walks, runs, and jumps
at random, turns back before walking off a ledge, and while off-stage drifts back toward the middle
and spends a jump on the way down to recover; if it gets knocked down it presses Jump every
`WANDER_JUMP_CD` frames to stand back up instead of lying there for the full knockdown timer. The
`cpuZeroMoves` choice itself carries into a rematch (`rematch()` in `main.ts` copies it into the next
`MatchConfig`), so Wanders stays chosen without returning to Mode Select. It uses `rand()` (backed by
`state.rng`) for every choice, so it still replays deterministically for a given seed.

---

## 5. Aeval move set (sim worker writes `moves.ts`, art worker draws to the same names)

Body: 26 px wide hurtbox, 40 px tall standing, 26 tall crouched. Weight 88 (light). Fast fall,
floaty double jump. Water mage: mid-range zoning with big projectiles, weak up close.

Frame data guide (60 fps). Damage in percent. Angles in degrees, bkb/kbg per section 4.4. Tune so a
fresh (0%) opponent is KO'd by a full-charge fsmash around 90% from center stage.

| Move | Total | Active | Dmg | Angle | bkb / kbg | Notes |
|---|---|---|---|---|---|---|
| jab | 18 | 4-7 | 3 | 361 | 20 / 40 | short water slap, iasa 14 |
| ftilt | 30 | 10-14 | 8 | 361 | 19 / 51 | forward splash, chain of r 10 circles x 12 to 70 at y -18 (reach 80), iasa 26 |
| utilt | 24 | 6-11 | 7 | 90 | 37 / 90 | upward ripple |
| dtilt | 22 | 5-9 | 6 | 80 | 34 / 95 | low puddle poke, pops up |
| dashatk | 36 | 8-18 | 9 | 60 | 32 / 50 | slide on a wave, velocity +3 vx on frame 4, chain of r 11 circles x 14 to 91 at y -16 (reach 102) |
| fsmash | 48 | 18-23 | 15 | 361 | 19 / 46 | chargeable, big crescent wave, chain of r 13 circles x 16 to 89 at y -18 (reach 102) |
| usmash | 40 | 12-18 | 14 | 88 | 30 / 74 | chargeable, geyser burst |
| dsmash | 42 | 12-15 both sides | 12 | 30 | 21 / 52 | chargeable, ring wave both sides |
| nair | 34 | 5-22 | 7 | 60 | 21 / 63 | orbiting bubble, landing lag 8 |
| fair | 30 | 9-13 | 10 | 45 | 18 / 54 | forward wave slash, landing lag 12 |
| bair | 28 | 7-10 | 11 | 361 | 21 / 56 | back splash, landing lag 12 |
| uair | 30 | 8-12 | 9 | 85 | 26 / 79 | upward flick, landing lag 11 |
| dair | 36 | 12-16 | 12 | 270 (spike) | 30 / 85 | downward drop, landing lag 16 |
| nspecial | 40 (56 full charge) | projectile f11 (f27 full charge) | 4 (11 full) | 40 | 14 / 30 (40 / 84 full) | Water Orb: vx 3.5 to 9.5, lifetime 48 to 34, r 8 to 12, clash strength 2 to 10, chargeCastFrames 16; stats lerp on the exponential charge curve, then power 0.25-1.4 and scale 0.6-1.5 on top; destroyOnHit, bursts with the orb's power and scale |
| sspecial | 42 | projectile f10 | 9 | 361 | 24 / 44 | Tidal Crescent: vx 3.2, lifetime 146, returns on age 57 (about 202 px out) for half damage, dies about 82 px behind; clash strength 4; pierces (destroyOnHit false); no fighter movement |
| uspecial | 48 | 8-20 | 8 | 80 | 55 / 66 | Geyser: velocity setY -6.5 on f8, then +0.3 drift; helplessAfter |
| dspecial | 50 | 10-46 multi (4 pull windows of 8f, then a 5f launcher) | 2 x5 | 90 then 60 last | 6 / 10, last 68 / 153 | Whirlpool: pulls in, last hit launches |
| taunt | 90 | none | | | | small water orb floats above hand |
| ledgeatk | 40 | 18-24 | 8 | 361 | 20 / 47 | invulnerable frames 0-21 |
| getupatk | 34 | 14-20 | 7 | 361 | 22 / 51 | |

The bkb / kbg column was resynced from the KO-calibration pass; `src/characters/aeval/moves.ts` is
authoritative for knockback.

Physics numbers for Aeval:

```
weight 88, walkSpeed 1.3, runSpeed 2.6, dashSpeed 2.8, dashFrames 12,
groundAccel 0.35, groundFriction 0.22,
airSpeed 1.7, airAccel 0.12, airFriction 0.03,
gravity 0.15, maxFall 3.2, fastFall 5.0,
jumpVel 5.4, shortHopVel 3.5, doubleJumpVel 5.0, jumps 2, jumpSquat 3
```

Sanity: full jump height = 5.4^2 / (2 * 0.15) = 97 px, about 2.4 body heights. Side platforms sit
around 70 px above the main stage so a full hop reaches them and a short hop does not.

---

## 6. Stage: Tidegate (scaffold writes data, render worker draws it)

World origin at stage center. Main platform: x -180..180, top y = 0, thickness 24, solid, ledges both
sides. Side platforms: x -150..-70 and 70..150 at y = -72, pass-through. Top platform: x -40..40 at
y = -140, pass-through. Blast zone: x -420..420, y -300..240. Spawns: (-120,0), (120,0), (-40,-72),
(40,-72) facing center. Respawn platform at (0, -160). Camera bounds x -330..330, y -260..150.

Art direction (render worker): dusk over a flooded ruin. Layers back to front:

1. Sky: banded gradient, deep navy to dusty violet to a thin warm band at the horizon. Stars as
   single bright pixels, sparse.
2. Distant mountains, two shades of blue-gray, parallax 0.1.
3. Ruined arches and towers silhouette, parallax 0.3, a few lit windows (2 px warm dots).
4. Ocean: horizontal bands with a 2-frame animated highlight row, parallax 0.5.
5. The stage itself: mossy stone slabs with a blue-glow rune strip along the top edge, side
   platforms are floating stone with water dripping (2 px drops, animated).
6. Foreground mist wisps, parallax 1.15, low alpha, drawn after fighters.

Palette base (from the reference art): `#1a1b26 #2b2d42 #6e7a94 #9aa5b8 #c9d1e0 #f0ead6 #5b7fbf
#7fb2ff #b8e3ff #3a4a6b #5a2e3e`. Water glow: `#7fb2ff` to `#b8e3ff`.

---

## 7. Aeval sprites (art worker)

The character art is being rebuilt from the ground up (2026-09-14: every old
frame, preview and atlas was deleted; fighters draw as placeholder boxes until
the new atlases are packed). The prompt the art agent follows is
`art/aeval/PROMPT.md`; the frozen animation manifest (names, frame counts,
per-frame holds, loop flags, hit circles) is `art/aeval/anims.json`. Read
those; do not duplicate them here. One approval gate: the owner approves the
character design (idle) before anything else is drawn.

Summary of the contract (details and the animation table live in the prompt
and the manifest):

- Reference sheet: `art/aeval/reference/aevalmere.png` (the "Water Mage" sheet).
- Engine: the claude-code-sprite-maker plugin, driven through `tools/spritemaker/sm.mjs`.
- Frames are crops from the four generated sheets in `art/aeval/sheets`, cut by `tools/sheetcut/cut.py` (per-crop heel anchor in `crops/manifest.json`).
- `tools/sheetcut/pack.py` packs them into the body and fx atlases plus `anims.ts` in `src/characters/aeval/art/` (generated, do not edit).
- Which crops, holds, loop and mirror flags make each animation is mapped by `art/aeval/sheetmap.json` (lead-owned).
- The locked palette is `art/aeval/palette.json`. Water keys are the only
  colours the player outline ring skips (`outlineIgnore`).
- Attack water is drawn into the body frame (the sweep is the frame); only
  water that travels or outlives the move is on the effect sheet.
- Animation names are the contract with the renderer through `animFor`; the
  full list, frame counts and holds are in the brief.

Anti-slop rules: hard 1 px ink outline on the body, no anti-aliasing, no
gradients, readable silhouette at 1x, chibi proportions with the hair cloud as
the primary read.

---

## 8. Rendering (render worker)

- One `<canvas>` sized to `VIEW_W x VIEW_H`, upscaled by the largest integer that fits the window,
  centered, `image-rendering: pixelated`, `imageSmoothingEnabled = false`.
- Camera: frames all live fighters plus 60 px margin, zoom between 1.0 and 1.8, position and zoom
  smoothed with a 0.12 lerp per render frame, clamped to `stage.cameraBounds`. Round the final
  translate to whole screen pixels.
- Sprite baking: at load, every `atlas` frame becomes an offscreen canvas; a flipped copy for
  facing left. Drawing a fighter is one `drawImage`.
- Interpolation: `render(state, prevState, alpha)` lerps fighter and projectile positions between
  the previous and current sim frames for smooth motion at any refresh rate. Only positions
  interpolate; animation frames come from the current state.
- Flash white for 2 frames on hit (use a pre-baked white silhouette per frame, not per-pixel work).
- Shield bubble: translucent circle scaled by shieldHp, color tinted per player slot.
- Particles: fixed pool of 512, structs of arrays (Float32Array x, y, vx, vy, life, type). Spawned
  from `SimEvent`s: hit sparks, KO burst, landing dust, dash dust, water droplets on specials.
- Screen shake on hit and KO, decays over 12 frames, max 4 px, never during menus.
- HUD: the renderer no longer draws one. The in-match HUD is a DOM layer built by `src/ui/hud.ts`
  (`createHud(host, deps)`) in the `#hud` host, which `main.ts` keeps sized to the canvas box on
  every resize. Its look and card layout are fixed by `docs/UI_STYLE.md` section 5, the UI
  contract. Player colors: P1 `#7fb2ff`, P2 `#ff7f7f`, P3 `#ffd27f`, P4 `#9fff7f`. Fighters get a
  1 px outline tint in their player color so identical characters are distinguishable.
- Debug overlay (toggle keys handled by main): F1 hitboxes (red circles) and hurtboxes (yellow
  boxes) and ledge boxes, F2 action name, actionFrame, percent, vx/vy per fighter, F3 sim ms, render
  ms, fps.
- Pixel font: bake a 3x5 or 5x7 glyph set for digits and capitals into a sheet at load. No web fonts
  in the game canvas.

Budget: render + sim under 4 ms per frame on a 2020 integrated-GPU laptop at 1x zoom with 4
fighters and 200 particles. No `ctx.filter`, no `shadowBlur`, no per-frame `getImageData`.

---

## 9. Input (input worker)

- `KeyboardSource`: listens on `window` keydown/keyup, tracks `KeyboardEvent.code` set, calls
  `preventDefault` for bound keys so the page never scrolls. Ignores repeats.
- `InputMapper`: per player, maps the held key set to an `InputFrame` (held, pressed, released)
  once per sim frame. Pressed/released are computed against the previous sim frame, not per event,
  so a key tapped between frames still counts (latch presses until sampled).
- `ControlsStore`: load and save `ControlsConfig` to localStorage key `aevalrena.controls.v3` (see
  `src/input/defaults.ts` for the full per-action tables, including chords and direct-move keys).
  Saves under the earlier `v1` or `v2` keys are ignored, not migrated, and left untouched in storage.
  Every keyboard player has a Walk key, so every player can reach forward tilt and up tilt; only P1
  also has the F/G smash/tilt chords. Defaults:

```
P1: left KeyA, right KeyD, up/jump KeyW, jump also Space, down KeyS, walk ShiftLeft, attack KeyJ,
    special KeyK, shield KeyL, grab Semicolon, dodge KeyE, taunt KeyT, start Escape, tapJump true
P2: left ArrowLeft, right ArrowRight, up ArrowUp, down ArrowDown, walk ShiftRight,
    jump ArrowUp and ControlRight, attack Comma, special Period, shield Slash, grab Quote,
    taunt BracketRight, start Enter, tapJump true
P3: left/right/up/down Numpad4/Numpad6/Numpad8/Numpad5, walk Numpad2, jump Numpad0,
    attack Numpad7, special Numpad9, shield NumpadAdd, grab Numpad1, dodge Numpad3,
    taunt NumpadDecimal, start NumpadEnter, tapJump true
P4: left KeyB, right KeyM, up KeyH, down KeyN, walk KeyX, jump KeyH and KeyR, attack KeyY,
    special KeyU, shield KeyI, grab KeyV, dodge KeyC, taunt KeyO, start KeyP, tapJump true
```

- `LocalSession implements SessionAdapter`: `inputsForFrame(frame)` samples every mapper and
  returns an array. CPU slots get `cpuInput` from `src/ai` (integration wires this, input worker
  leaves a hook: `setSlotProvider(slot, fn)`).
- Remap API for the UI worker: `listenForNextKey(): Promise<string>` resolves with the next
  `KeyboardEvent.code`, `setBinding(player, action, code)`, `resetDefaults(player)`,
  `conflicts(config): {player, action, code}[]`.

---

## 10. UI (ui worker)

`docs/UI_STYLE.md` is the UI contract; every screen follows it and this section only points there.
The UI is a DOM overlay (`#ui`) above the canvas with thin chamfered frames, uppercase mono labels
and serif display type, recolored per player through `--accent`. Screens: title, mode select,
character select, controls, pause, the `movelist` screen (reached from pause or mode select), and
split-screen results with one column per player. The in-match HUD is DOM too, in `src/ui/hud.ts`
over the canvas (section 8). Fonts are bundled woff2 files under `public/fonts` (no CDN at
runtime). Image assets live under `public/ui` and are cut from the owner references in
`art/ui/ref` by `tools/uicut/cut.py`; the bust and stock icons under `public/icons` come from
`tools/uicut/portrait.py`. The UI exports `UiController` (`show(screen, data)`, `hide()`, and the
`onStartMatch`, `onQuit`, `onResume` callbacks) and never touches the sim.

---

## 11. Main loop and app state (integration worker)

`src/core/loop.ts` (scaffold): fixed-step accumulator. `requestAnimationFrame` drives it. Each
animation frame: add elapsed time (cap 100 ms), run `step()` while accumulated >= 1/60 s, at most 4
steps, then `render(alpha)`. Uses `performance.now()`. Pauses when the tab is hidden.

`src/main.ts` (integration): app state machine `title -> menu -> select -> match -> results`. On
match start: build `MatchConfig`, `createGameState`, `LocalSession`, register CPU providers, start
loop. Each step: `inputs = session.inputsForFrame(frame)`, if null skip (stall), else `stepGame`.
Keep `prevState` by copying fighter and projectile positions only (not a deep clone) for
interpolation. Debug keys F1/F2/F3. Pause toggles the loop. In a CPU-only match no slot can ever
press Start, so `main.ts` pauses instead from a raw `keydown` listener matching player 1's Start
binding directly; when that binding is a chord, the match pauses on the chord's last key rather than
needing every member key held down together.

---

## 12. Build, deploy, repo

- `npm create vite` equivalent: `vite`, `typescript` only. `tsconfig` strict, `noUnusedLocals`.
- `vite.config.ts`: `base: './'` so the build works under any subpath (GitHub Pages project site
  and Cloudflare Pages root). Output `dist/`. Target `es2020`.
- `index.html` at root: canvas, UI root div, dark background, viewport meta, no external requests.
- `.github/workflows/deploy.yml`: on push to `main`, `npm ci`, `npm run build`, upload `dist`,
  deploy with `actions/deploy-pages`. Include the `permissions` block and `concurrency` group.
- Cloudflare Pages: connect the repo, build command `npm run build`, output `dist`. Documented in
  `README.md`.
- `.gitignore`: node_modules, dist, .DS_Store, *.local.
- `package.json` scripts: `dev`, `build`, `preview`, `typecheck` (`tsc --noEmit`).
- Git: scaffold initializes the repo on branch `main`, one commit per wave. GitHub Desktop will
  publish it.

---

## 13. Quality gates (every worker runs before returning)

1. `npm run typecheck` passes for files in your own directory (other directories may still be stubs;
   report their errors, do not fix them).
2. `npm run build` succeeds at integration time.
3. No `any` outside a justified comment. No `console.log` left in sim or render.
4. No em dashes, no emoji, no marketing words in code comments, UI copy, or docs.
5. Your return message is the JSON status block your contract asks for, nothing else.

---

## 14. Roadmap after MVP

1. Feedback pass on feel: tune Aeval numbers, camera, hitlag, particles.
2. Grabs and throws, teching, DI, wall jump.
3. Gamepad support through the same `InputFrame`.
4. Rollback netcode: `GameState` clone/serialize, input delay, LAN via WebRTC data channels, online
   via a small relay. The `SessionAdapter` seam is where it plugs in.
5. Second character and stage using the registries.
6. Sound through `SimEvent`.

---

## 15. Pending animations

The full animation overhaul is underway (see `art/aeval/PROMPT.md` and `art/aeval/anims.json`).
Until the new atlases land, `src/characters/aeval/sprites.ts` exposes empty sheets and the renderer
draws every fighter as a placeholder box. The table is the list the new art must cover; the manifest
names for each row are in `anims.json` (throws are `throwF/B/U/D`, Final Smash phases are
`fsStart/fsTsunami/fsTornado/fsLaunch/fsVictim`).

| Action or move | Reuses now | Real anim should show |
|---|---|---|
| `tech` | `roll` | Aeval slaps the ground on landing and pops back up in place. |
| `techRoll` | `roll` | A quick roll along the ground out of the landing. |
| `downed` | `tumble` | Lying flat on the ground, face up. |
| `getUp` | `ledgeClimb` | Pushing up from lying flat to standing. |
| `getUpRoll` | `roll` | Rolling sideways from lying flat to a crouch. |
| `footstooled` | `hitLight` | Knocked flat or squashed down by a foot on the head. |
| `grab` | `jab` | Reaching forward with one hand, a water tendril at the fingertips. |
| `grabHold` | `idle` | Holding the victim at arm's length in a water grip. |
| `pummel` | `jab` | A short knee or water squeeze on the held victim. |
| `throw` | `ftilt` | One pose per throw: fling forward, turn and fling back, heave up, slam down. |
| `grabbed` | `hitLight` | Struggling in the grip, limbs flailing. |
| `taunt2` | `taunt` | A second taunt: spinning a small water orb on one finger. |
| `taunt3` | `taunt` | A third taunt: a crouched pose with water pooling around the boots. |
| `ledgeatk` | `ftilt` | Climbing onto the stage with a low water sweep. |
| `getupatk` | `ftilt` | Sweeping water to both sides while rising from the ground. |
| `finalSmash` startup (frames 0 to 20) | `nspecial` | Aeval raises both hands and a water grip lunges out to catch. |
| `finalSmash` tsunami (frames 20 to 80) | `nspecial` | A wave rises under the victim and carries them forward and up. |
| `finalSmash` tornado (frames 80 to 150) | `nspecial` | A water tornado spirals the victim higher. |
| `finalSmash` launch (frame 152) | `nspecial` | Aeval swings both arms up and the tornado bursts, launching the victim. |
| `finalSmashVictim` | `tumble` | Tumbling helpless inside the water, carried along the path. |

The sim sends a `finalSmash` event with phase `start`, then `tsunami`, `tornado`, then `launch`, so the
renderer can switch frames and effects on those events.
