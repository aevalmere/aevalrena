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

/**
 * A projectile def with this spawnFrame never fires from a move's timeline,
 * because move frames start at 0. It exists only to be detonated as another
 * projectile's burst, and still has to sit in the move's `projectiles` list so
 * the sim and the renderer both learn about it. It lives here rather than in
 * the sim so character data can use it without importing the sim, which would
 * close a cycle through the character registry.
 */
export const BURST_ONLY = -1;

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
  /**
   * Def id detonated where this projectile dies, whether it ran out of life or
   * hit something. The water orb uses it to burst.
   */
  burstId?: string;
  /**
   * Age at which the projectile turns around and travels back the way it came: vx is
   * negated, the sprite mirrors, it may hit each target once more, and its damage is
   * multiplied by `returnPower`. Omitted means it never returns.
   */
  returnFrame?: number;
  /** Damage multiplier applied on the return pass. Defaults to 0.5. */
  returnPower?: number;
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
  chargeable?: boolean;     // hold to charge before totalFrames start
  /** Button that must stay held to charge. Defaults to 'attack' (smashes). */
  chargeButton?: 'attack' | 'special';
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
  sheet: ImageSheetData;             // body frames
  fx: ImageSheetData;                // projectiles and effect frames
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
  charging: boolean;             // still holding the charge; the move has not been released yet
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
  /** Damage multiplier for this instance: charge scales it up, a return pass scales it down. */
  power: number;
  /** Hit-circle and sprite size multiplier for this instance. 1 = the def's own size. */
  scale: number;
  /** True once the projectile has turned around, so it only ever turns once. */
  returned: boolean;
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
  characters: { id: string; name: string; icon?: string }[];
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
