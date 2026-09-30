export const SIM_HZ = 60;
export const VIEW_W = 640;   // logical pixels, 16:9, integer-scaled to the window
export const VIEW_H = 360;
export const MAX_PLAYERS = 4;

// ---------------- Input ----------------
export const Btn = {
  Left: 1 << 0, Right: 1 << 1, Up: 1 << 2, Down: 1 << 3,
  Jump: 1 << 4, Attack: 1 << 5, Special: 1 << 6, Shield: 1 << 7,
  Taunt: 1 << 8, Start: 1 << 9,
  Walk: 1 << 10, Dodge: 1 << 11, Grab: 1 << 12,
  CUp: 1 << 13, CDown: 1 << 14, CLeft: 1 << 15, CRight: 1 << 16,
} as const;

/**
 * One player's input for one sim frame. Bitmasks of Btn.
 * `direct` is (index in DIRECT_CODES) + 1 of a direct-move or command binding
 * pressed this frame; 0 or undefined means none.
 */
export interface InputFrame { held: number; pressed: number; released: number; direct?: number }

export type ButtonAction =
  'left' | 'right' | 'up' | 'down' | 'walk' | 'jump' | 'attack' | 'special' | 'shield' | 'grab' |
  'dodge' | 'taunt' | 'start' | 'cUp' | 'cDown' | 'cLeft' | 'cRight';
/** Anything bindable: a button action, a move fired directly by its own key, or a command. */
export type InputAction = ButtonAction | DirectMoveId | CommandAction;
/**
 * Two binding slots per action. Each slot is '' (unbound), one code, or a chord: two or
 * more codes joined by '&', for example 'KeyF&KeyJ'. A chord is down while every code in
 * it is down, and it fires on the sample it becomes down. When a chord fires, the plain
 * presses of its member codes are suppressed for that sample. '&' is the separator
 * because pad axis codes already contain '+'.
 */
export type BindingPair = [string, string];
export type Bindings = Record<InputAction, BindingPair>;
export type BindDevice = 'keys' | 'pad';
/**
 * `keys` holds KeyboardEvent.code strings. `pad` holds pad codes: 'B<n>' for
 * button n, 'A<n>+' / 'A<n>-' for axis n past the deadzone (W3C standard mapping).
 * padIndex -1 = auto, the Nth connected pad for player N.
 */
export interface PlayerControls { keys: Bindings; pad: Bindings; padIndex: number; tapJump: boolean }
export interface ControlsConfig { players: PlayerControls[] }   // length MAX_PLAYERS
export interface BindConflict { player: number; device: BindDevice; action: InputAction; slot: 0 | 1; code: string }

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
  'taunt' | 'taunt2' | 'taunt3' | 'ledgeatk' | 'getupatk';

/** Moves a player can bind to their own key. Their DIRECT_CODES index is their index here. */
export const DIRECT_MOVES = [
  'jab', 'ftilt', 'utilt', 'dtilt', 'dashatk', 'fsmash', 'usmash', 'dsmash',
  'nair', 'fair', 'bair', 'uair', 'dair', 'nspecial', 'sspecial', 'uspecial', 'dspecial',
] as const;
export type DirectMoveId = typeof DIRECT_MOVES[number];

/**
 * Context commands a player can bind to their own key. Each one only does
 * something in its context (pummel and throws while holding a grab, ledge
 * options while hanging, getupAttack while downed...); outside it the press is
 * consumed and ignored.
 */
export const COMMAND_ACTIONS = [
  'pummel', 'fthrow', 'bthrow', 'uthrow', 'dthrow', 'spotDodge', 'rollForward', 'rollBack',
  'airDodge', 'dirAirDodge', 'ledgeAttack', 'ledgeRoll', 'ledgeGetUp', 'ledgeJump', 'getupAttack',
  'tech', 'footstool', 'finalSmash', 'taunt2', 'taunt3',
] as const;
export type CommandAction = typeof COMMAND_ACTIONS[number];

/**
 * Every code an InputFrame's `direct` can carry, as index + 1. DIRECT_MOVES come
 * first so they keep the codes they had before commands existed.
 */
export const DIRECT_CODES = [...DIRECT_MOVES, ...COMMAND_ACTIONS] as const;

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
  low?: boolean;          // counts as a low hit, so rolls do not dodge it
  grab?: GrabSpec;        // catches the victim instead of hitting
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
  /**
   * Clash tier. Two opposing projectiles that touch compare strength only: the strictly
   * stronger one destroys the other and flies on untouched, equal strength destroys both.
   */
  strength: number;
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
  /** Counts as a low hit, so rolls do not dodge it. */
  low?: boolean;
  /**
   * Values at full charge. Each field lerps from the base value above to this one on the
   * projectile charge curve (exponential, so the last quarter of the charge matters most).
   * Omitted fields keep the base value at every charge. Only a chargeable move charges.
   */
  charged?: { vx?: number; lifetime?: number; damage?: number; bkb?: number; kbg?: number; r?: number; strength?: number };
  /**
   * Drain: on a hit that lands on a fighter (not a shield), the owner's percent drops by this
   * fraction of the damage dealt, floored at 0. Omitted means no heal.
   */
  healFraction?: number;
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
  /**
   * Extra frames added to both every projectile spawnFrame and totalFrames at full charge,
   * scaled linearly by the charge fraction and rounded. A charged cast takes longer.
   */
  chargeCastFrames?: number;
  invuln?: [number, number];
  helplessAfter?: boolean;  // up-special: fall helpless when done in air
  airOnly?: boolean;
  groundOnly?: boolean;
  /**
   * Hits a fighter hanging on a ledge. Only down attacks set it; every other melee hitbox
   * passes over a ledge hanger. Projectiles ignore it and use the hurtbox overlap alone.
   */
  hitsLedge?: boolean;
  /**
   * Bounce on hit (the dair hop): when a hitbox of this move lands on a fighter (not a shield),
   * the attacker's vy is set to `vy` (negative is up), a fast fall is cancelled, the air dodge
   * comes back (the double jump does not) and the move ends `actionableIn` frames later.
   */
  bounceOnHit?: { vy: number; actionableIn: number };
}

export type ThrowId = 'fthrow' | 'bthrow' | 'uthrow' | 'dthrow';

/** One throw. holdX/holdY place the victim, fighter-local, facing right. */
export interface ThrowDef {
  totalFrames: number;
  releaseFrame: number;     // frame the victim is launched
  damage: number; angle: number; bkb: number; kbg: number;
  holdX: number; holdY: number;
}

/**
 * Turns a hitbox into a grab. `force` = command grab: no mash out.
 * `throwNow` throws on catch instead of holding. `holdFrames` overrides the hold length.
 */
export interface GrabSpec { force?: boolean; throwNow?: ThrowId | ThrowDef; holdFrames?: number }

/** Grab reach circle, fighter-local, facing right, active from start to end inclusive. */
export interface GrabBoxDef { totalFrames: number; start: number; end: number; x: number; y: number; r: number }

/** Everything a character needs to grab, hold, pummel and throw. */
export interface GrabKit {
  stand: GrabBoxDef;
  dash: GrabBoxDef;
  holdX: number; holdY: number;
  holdBase: number; holdPerPercent: number;
  mashFrames: number;
  pummel: { damage: number; totalFrames: number; hitFrame: number };
  throws: Record<ThrowId, ThrowDef>;
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
  /** Grab and throw data. Undefined = DEFAULT_GRAB_KIT. */
  grabKit?: GrabKit;
  /** Final Smash data. Undefined = no Final Smash: Special stays a special, the meter still fills. */
  finalSmash?: FinalSmashDef;
}

/**
 * A cinematic Final Smash: catch one opponent, carry them along a path while
 * dealing damage, then launch. The attacker is invulnerable for the whole action.
 */
export interface FinalSmashDef {
  /** Closest living opponent with (victim.x - attacker.x) * facing >= -8, any distance. */
  target: 'nearestFacing';
  startup: number;          // frames before the catch
  totalFrames: number;
  /** Victim offset from attacker feet, facing right, linear between keys, held after the last key. */
  path: { frame: number; x: number; y: number }[];
  /** Damage only, no knockback: the victim stays caught. */
  hits: { frame: number; damage: number }[];
  launch: { frame: number; damage: number; angle: number; bkb: number; kbg: number };
  /** Labels for future animation and fx, e.g. 'tsunami', 'tornado'. */
  phases: { name: string; start: number; end: number }[];
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
  /**
   * Frame name -> [x, y, w, h] or [x, y, w, h, ax, ay]. The optional ax, ay is
   * the anchor inside the frame, in frame pixels: the point that sits on the
   * fighter's position (body frames: the heel point) or the effect's centre.
   * Absent, the anchor follows `origin`: (w/2, h) or (w/2, h/2).
   */
  frames: Record<string, [number, number, number, number] | [number, number, number, number, number, number]>;
  /**
   * Extra colours the player-colour outline ring skips, as '#rrggbb'. The ring
   * already treats only fully opaque pixels (alpha 255) as solid, and the water
   * drawn into Aeval's crops is capped at alpha 254, so the ring traces the
   * body and skips the water without any list. This is for anything opaque
   * that should still be skipped.
   */
  outlineIgnore?: string[];
}
export interface AnimDef {
  frames: string[];
  fps: number;
  loop: boolean;
  /** Sim frames (60/s) each frame is held. When present it wins over fps. */
  holds?: number[];
  /** Draw the whole animation mirrored (back-facing moves). */
  mirror?: boolean;
}
export type AnimName = string;
export interface CharacterSprites {
  sheet: ImageSheetData;             // body frames
  fx: ImageSheetData;                // projectiles and effect frames
  anims: Record<AnimName, AnimDef>;
  /**
   * Map a sim action + move to an animation name. Must never return undefined.
   * `fighter` is the full state for cases action and move cannot tell apart
   * (a mid-air jump versus ordinary airtime).
   */
  animFor(action: ActionId, moveId: MoveId | null, fighter: FighterState): AnimName;
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
  'dead' | 'respawn' |
  'grab' | 'grabHold' | 'pummel' | 'throw' | 'grabbed' |
  'tech' | 'techRoll' | 'downed' | 'getUp' | 'getUpRoll' | 'footstooled' |
  'finalSmash' | 'finalSmashVictim';

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
  /**
   * True while the current 'air' action was entered by a mid-air jump. Set by
   * the sim's double jump after it restarts the action; any later action change
   * clears it, so actionFrame counts frames since that jump.
   */
  airJumped: boolean;
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
  fsMeter: number;               // 0..FS_METER.max, public so the HUD can draw it
  /** Match records for the results screen. Sim-owned, deterministic, cloned with the state. */
  stats: FighterStats;
  /** Colour variant 0..3 (blue, purple, white, pink). Cosmetic: only the renderer reads it. */
  variant: number;
}

/**
 * Per-fighter match records, the Smash results/records set. Frame counts are sim frames
 * (60/s); damage is percent; distanceRun is world px of walking and running on the ground.
 */
export interface FighterStats {
  kos: number;               // opponents KO'd (last hitter within KO_CREDIT_FRAMES gets it)
  falls: number;             // times this fighter was KO'd
  sds: number;               // KO'd with no valid last-hitter credit
  damageGiven: number;
  damageTaken: number;
  peakDamage: number;        // highest percent reached in any stock
  maxCombo: number;          // longest chain of hits on one victim still in hitstun or held
  totalHits: number;
  hitsTaken: number;
  mostUsedMove: Record<string, number>;   // move or throw id -> starts
  grabs: number;             // grabs landed
  throws: number;
  shieldBreaks: number;      // inflicted on others
  ledgeGrabs: number;
  techs: number;
  dodges: number;            // spot dodge + roll + air dodge starts
  shieldTime: number;        // frames
  airTime: number;           // frames
  groundTime: number;        // frames
  distanceRun: number;       // px
  jumps: number;
  finalSmashes: number;      // used
  finalSmashHits: number;    // victims caught
  projectilesFired: number;
  projectilesHit: number;
  timeInLead: number;        // frames holding the unique best stocks-then-percent standing
  firstBloodFrame: number;   // frame of this fighter's first KO, -1 none
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
  /**
   * Charge fraction it was thrown with, 0 (a tap, or any move that cannot charge) to 1 (full),
   * set at spawn and inherited by its burst. A def's `charged` values lerp on this. Optional
   * only so older pooled copies type-check; the sim always writes it and reads a missing one as 0.
   */
  charge?: number;
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
  | { type: 'grab'; x: number; y: number; attacker: number; victim: number }
  | { type: 'throw'; x: number; y: number; attacker: number; victim: number; throwId: ThrowId | 'custom' }
  /** winner = owner slot whose projectile survived, -1 if both died. */
  | { type: 'projectileClash'; x: number; y: number; ownerA: number; ownerB: number; winner: number }
  /** roll = the tech travelled (techRoll) rather than staying in place. */
  | { type: 'tech'; x: number; y: number; slot: number; roll: boolean }
  | { type: 'footstool'; x: number; y: number; attacker: number; victim: number }
  /**
   * phase 'start' at activation (victim -1 on a whiff), then each FinalSmashDef
   * phases[] name as it begins, then 'launch'.
   */
  | { type: 'finalSmash'; x: number; y: number; attacker: number; victim: number; phase: string }
  | { type: 'matchEnd'; winner: number };

export interface MatchConfig {
  stageId: string;
  players: {
    slot: number; charId: string; cpu: boolean; cpuLevel: number;
    /** Typed display name for a human slot (max 12 chars); absent for CPUs. */
    name?: string;
    /** Team colour, an index into PLAYER_COLORS; absent = the slot's own colour. */
    team?: number;
    /** Colour variant 0..3 (blue, purple, white, pink); absent = 0. Cosmetic only. */
    variant?: number;
  }[];
  stocks: number;
  timeLimitSec: number;          // 0 = none
  seed: number;
  finalSmash?: boolean;          // rule; the sim treats anything but true as off
  cpuZeroMoves?: boolean;        // rule; level 0 CPUs wander (walk, jump, never attack) instead of standing still
  teams?: boolean;               // rule; players sharing a team colour are one side, no friendly fire
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
  /** Frame the match finished on (stats stop there), -1 while running. */
  endFrame: number;
  /** Teams rule only: the winning team colour index, -1 on a draw. Absent otherwise. */
  winnerTeam?: number;
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
  setBinding(player: number, device: BindDevice, action: InputAction, slot: 0 | 1, code: string): void;
  setTapJump(player: number, on: boolean): void;
  setPadIndex(player: number, index: number): void;  // -1 = auto
  /** Resolves with KeyboardEvent.code. Backspace/Delete resolve '' (unbind). Escape rejects Error('cancelled'). */
  listenForNextKey(): Promise<string>;
  /** -1 = any pad. Resolves a pad code. Escape key or cancelCapture() rejects Error('cancelled'). */
  listenForNextPad(padIndex: number): Promise<string>;
  cancelCapture(): void;
  isCapturing(): boolean;
  conflicts(): BindConflict[];
  connectedPads(): { index: number; id: string }[];
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
export type UiScreen = 'title' | 'mode' | 'select' | 'controls' | 'pause' | 'results' | 'movelist' | 'lan';
export interface ResultsData {
  winner: number;
  seed: number;
  players: {
    slot: number; charId: string; stocks: number; percent: number; cpu: boolean; cpuLevel: number;
    stats: FighterStats;
    /** Typed display name for a human slot. */
    name?: string;
    /** Team colour index (PLAYER_COLORS); the slot's own colour when absent. */
    team?: number;
    /** Colour variant 0..3; 0 when absent. */
    variant?: number;
  }[];
  /** Teams rule only: the winning team colour index, -1 on a draw. */
  winnerTeam?: number;
  /** Frames the match ran, for time-share stats. */
  matchFrames: number;
}
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
