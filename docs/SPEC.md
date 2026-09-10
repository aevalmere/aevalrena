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
- One character: **Aeval**, the Water Mage (reference art in `art/reference/`). Small body, big waves.
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
 * Pixel sheet: each frame is an array of equal-length strings; each char indexes `palette`;
 * '.' is transparent. Origin is bottom-center of the frame.
 */
export interface PixelSheet { palette: Record<string, string>; frames: Record<string, string[]> }
export interface AnimDef { frames: string[]; fps: number; loop: boolean }
export type AnimName = string;
export interface CharacterSprites {
  sheet: PixelSheet;                 // body frames
  fx: PixelSheet;                    // projectiles and effect frames
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
export const AIR_DODGE = { total: 30, invStart: 3, invEnd: 27 };
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

Input buffer: a button press stays buffered for `INPUT_BUFFER` frames and is consumed by the first
action that accepts it. Directions are read from `held`.

Ground, actionable (idle, walk, run, crouch, land after lag):

| Input | Result |
|---|---|
| attack, no direction | jab |
| attack, left/right held, dirTapAge > window | ftilt (faces that way first) |
| attack, left/right tapped within window | fsmash (chargeable) |
| attack, up held | utilt; up tapped within window: usmash |
| attack, down held | dtilt; down tapped within window: dsmash |
| attack during dash/run | dashatk |
| special (+ direction) | nspecial / sspecial / uspecial / dspecial |
| jump (or up if tapJump) | jumpsquat |
| shield | shield |
| shield + down | spotDodge |
| shield + left/right | roll (direction) |
| taunt | taunt |

Air, actionable (air with no hitstun, not helpless):

| Input | Result |
|---|---|
| attack, no direction | nair |
| attack, forward (facing dir) | fair |
| attack, backward | bair |
| attack, up | uair |
| attack, down | dair |
| special (+ direction) | specials. uspecial sets `helplessAfter` |
| jump | double jump if jumpsLeft > 0 |
| shield | airDodge |
| down (while falling) | fast fall |

Smash charge: if `chargeable` and attack is still held on the frame the move would start, hold at
frame 0 for up to `SMASH_CHARGE_MAX` frames. Damage scales by `1 + SMASH_CHARGE_BONUS * charge/max`.

Moves end at `totalFrames`, or earlier at `iasa` if a new action is requested. Aerials that reach the
ground apply `landingLag`.

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

### 4.5 Ledges

A platform with `ledgeLeft/ledgeRight` has a grab point at its top corner. A fighter that is airborne,
falling (vy > 0), not in hitstun, not attacking, and whose `ledgeGrabBox` overlaps a grab point (and
is facing it or moving toward it) snaps to `ledgeHang` at the ledge with `LEDGE_HANG_INVULN` frames
of invuln. From hang: up or toward-stage = `ledgeClimb` (30f), jump = `ledgeJump`, attack =
`ledgeatk`, shield = `ledgeRoll`, down or away = drop (regain double jump). Each regrab without
landing increments `ledgeRegrabs`; above `LEDGE_MAX_REGRABS` the ledge does not grant invuln.

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

---

## 5. Aeval move set (sim worker writes `moves.ts`, art worker draws to the same names)

Body: 26 px wide hurtbox, 40 px tall standing, 26 tall crouched. Weight 88 (light). Fast fall,
floaty double jump. Water mage: mid-range zoning with big projectiles, weak up close.

Frame data guide (60 fps). Damage in percent. Angles in degrees, bkb/kbg per section 4.4. Tune so a
fresh (0%) opponent is KO'd by a full-charge fsmash around 90% from center stage.

| Move | Total | Active | Dmg | Angle | bkb / kbg | Notes |
|---|---|---|---|---|---|---|
| jab | 18 | 4-7 | 3 | 361 | 20 / 40 | short water slap, iasa 14 |
| ftilt | 26 | 8-12 | 8 | 361 | 30 / 80 | forward splash |
| utilt | 24 | 6-11 | 7 | 90 | 35 / 85 | upward ripple |
| dtilt | 22 | 5-9 | 6 | 80 | 25 / 70 | low puddle poke, pops up |
| dashatk | 32 | 6-16 | 9 | 60 | 45 / 70 | slide on a wave, velocity +3 vx on frame 4 |
| fsmash | 44 | 16-21 | 15 | 361 | 40 / 100 | chargeable, big crescent wave |
| usmash | 40 | 12-18 | 14 | 88 | 40 / 98 | chargeable, geyser burst |
| dsmash | 42 | 12-15 both sides | 12 | 30 | 38 / 95 | chargeable, ring wave both sides |
| nair | 34 | 5-22 | 7 | 60 | 25 / 75 | orbiting bubble, landing lag 8 |
| fair | 30 | 9-13 | 10 | 45 | 30 / 90 | forward wave slash, landing lag 12 |
| bair | 28 | 7-10 | 11 | 361 | 35 / 95 | back splash, landing lag 12 |
| uair | 26 | 6-10 | 9 | 85 | 30 / 90 | upward flick, landing lag 9 |
| dair | 36 | 12-16 | 12 | 270 (spike) | 30 / 85 | downward drop, landing lag 16 |
| nspecial | 40 | projectile f18 | 6 | 40 | 30 / 60 | Water Orb: vx 3.5, lifetime 90, destroyOnHit |
| sspecial | 42 | projectile f12 | 9 | 361 | 40 / 70 | Tidal Crescent: vx 5, lifetime 45, pierces (destroyOnHit false), fighter gets +2 vx on f8 |
| uspecial | 48 | 8-20 | 8 | 80 | 50 / 60 | Geyser: velocity setY -6.5 on f8, then +0.3 drift; helplessAfter |
| dspecial | 50 | 10-40 multi (group per 8f) | 2 x5 | 90 then 60 last | 15 / 40, last 40 / 90 | Whirlpool: pulls in, last hit launches |
| taunt | 90 | none | | | | small water orb floats above hand |
| ledgeatk | 40 | 18-24 | 8 | 361 | 30 / 70 | |
| getupatk | 34 | 14-20 | 7 | 361 | 30 / 70 | |

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

The reference sheet is `art/reference/aeval-ref.png`: gray-blue messy hair with a dark hairband and
one antenna strand, blue eyes, pale skin, dark navy coat with white trim, white scarf, black
trousers, gray boots, blue water orb in the right hand. Chibi proportions: head is about 45% of the
height.

Sprite frame size: 32 wide x 40 tall (feet at bottom-center). Draw every frame facing right; the
renderer flips for left. Palette keys: `h` hair light `#9aa5b8`, `H` hair shade `#6e7a94`, `b` hairband
`#5a2e3e`, `s` skin `#f0ead6`, `e` eye `#5b7fbf`, `c` coat `#2b2d42`, `C` coat shade `#1a1b26`, `w`
white trim/scarf `#c9d1e0`, `t` trousers `#1a1b26`, `g` boots `#6e7a94`, `o` outline `#0e0f17`, `a`
water `#7fb2ff`, `A` water bright `#b8e3ff`.

Required animations (names are the contract with the renderer; `animFor` maps sim actions to these):

```
idle(3f, 6fps loop)  walk(4f, 10fps loop)  run(4f, 14fps loop)  turn(1f)  crouch(1f)
jumpsquat(1f)  jump(1f)  fall(1f)  land(1f)  helpless(1f)
jab(2f)  ftilt(2f)  utilt(2f)  dtilt(2f)  dashatk(2f)
fsmash(3f: charge, swing, follow)  usmash(3f)  dsmash(3f)
nair(2f)  fair(2f)  bair(2f)  uair(2f)  dair(2f)
nspecial(2f)  sspecial(2f)  uspecial(2f)  dspecial(2f)
shield(1f, renderer draws the bubble)  spotDodge(1f)  roll(2f)  airDodge(1f)
hitLight(1f)  hitStrong(1f)  tumble(2f, 8fps loop)  ledgeHang(1f)  ledgeClimb(2f)
taunt(2f, 4fps loop)  dead(1f)
```

Reuse frames where the pose is the same (a `walk` frame can serve as `ledgeClimb`). Fewer, better
frames beat many bad ones. Effect sheet (`fx`) frames: `orb` (3f, 12x12), `crescent` (2f, 36x20),
`geyser` (3f, 24x48), `whirl` (3f, 40x24), `splash` (3f, 16x12), `hitspark` (3f, 12x12),
`dust` (3f, 12x6), `ko` (4f, 32x32).

Anti-slop rules for pixel art: hard outlines in `o` on the body, no anti-aliasing, no gradients,
readable silhouette at 1x, water effects use only `a` and `A` plus outline.

---

## 8. Rendering (render worker)

- One `<canvas>` sized to `VIEW_W x VIEW_H`, upscaled by the largest integer that fits the window,
  centered, `image-rendering: pixelated`, `imageSmoothingEnabled = false`.
- Camera: frames all live fighters plus 60 px margin, zoom between 1.0 and 1.8, position and zoom
  smoothed with a 0.12 lerp per render frame, clamped to `stage.cameraBounds`. Round the final
  translate to whole screen pixels.
- Sprite baking: at load, every `PixelSheet` frame becomes an offscreen canvas; a flipped copy for
  facing left. Drawing a fighter is one `drawImage`.
- Interpolation: `render(state, prevState, alpha)` lerps fighter and projectile positions between
  the previous and current sim frames for smooth motion at any refresh rate. Only positions
  interpolate; animation frames come from the current state.
- Flash white for 2 frames on hit (use a pre-baked white silhouette per frame, not per-pixel work).
- Shield bubble: translucent circle scaled by shieldHp, color tinted per player slot.
- Particles: fixed pool of 512, structs of arrays (Float32Array x, y, vx, vy, life, type). Spawned
  from `SimEvent`s: hit sparks, KO burst, landing dust, dash dust, water droplets on specials.
- Screen shake on hit and KO, decays over 12 frames, max 4 px, never during menus.
- HUD (bottom): one card per player: portrait (idle frame 0), percent in a chunky pixel font that
  tints from white to yellow to red with percent and scales up briefly when it changes, stock icons.
  Player colors: P1 `#7fb2ff`, P2 `#ff7f7f`, P3 `#ffd27f`, P4 `#9fff7f`. Fighters get a 1 px
  outline tint in their player color so identical characters are distinguishable.
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
- `ControlsStore`: load and save `ControlsConfig` to localStorage key `aevalrena.controls.v1`.
  Defaults:

```
P1: left KeyA, right KeyD, up KeyW, down KeyS, jump Space, attack KeyJ, special KeyK,
    shield KeyL, taunt KeyT, start Escape, tapJump false
P2: left ArrowLeft, right ArrowRight, up ArrowUp, down ArrowDown, jump ShiftRight,
    attack Comma, special Period, shield Slash, taunt Quote, start Enter, tapJump false
P3: left KeyF, right KeyH, up KeyT... (pick non-conflicting keys; P3/P4 defaults may overlap
    P1/P2 keys only if the doc says so; prefer numpad for P4)
```

- `LocalSession implements SessionAdapter`: `inputsForFrame(frame)` samples every mapper and
  returns an array. CPU slots get `cpuInput` from `src/ai` (integration wires this, input worker
  leaves a hook: `setSlotProvider(slot, fn)`).
- Remap API for the UI worker: `listenForNextKey(): Promise<string>` resolves with the next
  `KeyboardEvent.code`, `setBinding(player, action, code)`, `resetDefaults(player)`,
  `conflicts(config): {player, action, code}[]`.

---

## 10. UI (ui worker)

DOM overlay above the canvas, pixel-art styled (chunky borders, the palette in section 6, a pixel
web font is allowed here: use a system monospace fallback stack, no external font CDN dependency at
runtime). Screens:

1. Title: logo text AEVALRENA, "press any key". Small version string.
2. Mode select: Local (enabled), LAN (disabled, label "soon"), Online (disabled, label "soon"),
   Controls, and a Stocks selector (1 to 5, default 3).
3. Character select: 4 slots. Each slot toggles Off / Human / CPU (level 1-3). Only Aeval exists;
   the grid is built from the registry so more characters appear automatically. Each human slot
   shows its attack and jump keys. Start needs at least 2 active slots.
4. Controls: per player table of action -> key, click a cell then press a key to rebind, conflict
   cells highlighted, tap-jump toggle, reset to defaults, back.
5. Pause (Escape or Enter during a match): resume, controls, quit to title.
6. Results: winner, per player stocks left and percent, rematch, back to character select.

The UI worker exports a small `UiController` with methods `show(screen, data)`, `hide()`, and
callbacks (`onStartMatch(config)`, `onQuit()`, `onResume()`). It never touches the sim.

---

## 11. Main loop and app state (integration worker)

`src/core/loop.ts` (scaffold): fixed-step accumulator. `requestAnimationFrame` drives it. Each
animation frame: add elapsed time (cap 100 ms), run `step()` while accumulated >= 1/60 s, at most 4
steps, then `render(alpha)`. Uses `performance.now()`. Pauses when the tab is hidden.

`src/main.ts` (integration): app state machine `title -> menu -> select -> match -> results`. On
match start: build `MatchConfig`, `createGameState`, `LocalSession`, register CPU providers, start
loop. Each step: `inputs = session.inputsForFrame(frame)`, if null skip (stall), else `stepGame`.
Keep `prevState` by copying fighter and projectile positions only (not a deep clone) for
interpolation. Debug keys F1/F2/F3. Pause toggles the loop.

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
