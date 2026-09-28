import { Btn, DIRECT_CODES, DIRECT_MOVES } from '../core/types';
import type { ControlsConfig, InputFrame } from '../core/types';
import { DEFAULT_CONTROLS, cloneControls } from './defaults';
import { GamepadSource } from './gamepad';
import { KeyboardSource } from './keyboard';
import { PlayerMapper } from './mapper';
import { loadControls } from './store';

/**
 * Input layer self-test. Runs under node with no window:
 *   npx --yes tsx src/input/inputtest.ts
 * The keyboard is a real KeyboardSource that is never attached; tests write its held and
 * latch sets directly. Pads come from a fake getPads.
 */

declare const process: {
  argv: string[];
  stdout: { write(text: string): void };
  exitCode?: number;
};

interface TestResult { name: string; pass: boolean; detail: string }

/** A mutable fake pad: tests set `buttons[n]` and `axes[n]` then poll. */
interface FakePad { buttons: number[]; axes: number[] }

function fakePad(): FakePad {
  return { buttons: new Array<number>(18).fill(0), axes: [0, 0, 0, 0] };
}

function padsFrom(list: (FakePad | null)[]): GamepadSource {
  return new GamepadSource(() => list.map((p, index) => (p === null ? null : {
    id: `fake pad ${index}`,
    index,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: p.axes.slice(),
    buttons: p.buttons.map((v) => ({ pressed: v >= 0.5, touched: v > 0, value: v })),
  } as unknown as Gamepad)));
}

/** Drives one player's mapper the way a session does: poll, sample, clear the latch. */
class Rig {
  readonly keys: KeyboardSource;
  readonly mapper = new PlayerMapper();
  readonly out: InputFrame = { held: 0, pressed: 0, released: 0, direct: 0 };

  constructor(readonly controls: ControlsConfig, readonly pads: GamepadSource, readonly player = 0) {
    this.keys = new KeyboardSource(controls);
  }

  down(code: string): void {
    this.keys.held.add(code);
    this.keys.latch.add(code);
  }

  /** Held with no latch entry: the key was already down before this sample. */
  hold(code: string): void {
    this.keys.held.add(code);
  }

  up(code: string): void {
    this.keys.held.delete(code);
  }

  step(): InputFrame {
    this.pads.poll();
    this.mapper.sample(this.keys, this.pads, this.controls.players[this.player], this.player, this.out);
    this.keys.latch.clear();
    return this.out;
  }
}

function noPads(): GamepadSource {
  return padsFrom([]);
}

function has(mask: number, bit: number): boolean {
  return (mask & bit) !== 0;
}

function result(name: string, pass: boolean, detail: string): TestResult {
  return { name, pass, detail };
}

function testKeyAttack(): TestResult {
  const rig = new Rig(cloneControls(DEFAULT_CONTROLS), noPads());
  rig.down('KeyJ');
  const f1 = rig.step();
  const ok1 = has(f1.pressed, Btn.Attack) && has(f1.held, Btn.Attack);
  const f2 = rig.step();
  const ok2 = !has(f2.pressed, Btn.Attack) && has(f2.held, Btn.Attack);
  rig.up('KeyJ');
  const f3 = rig.step();
  const ok3 = has(f3.released, Btn.Attack) && !has(f3.held, Btn.Attack);
  return result('default P1 KeyJ attack', ok1 && ok2 && ok3, `press=${ok1} hold=${ok2} release=${ok3}`);
}

function testSecondarySlot(): TestResult {
  // Attack, not jump: the default jump pair is full ('KeyW' tap jump plus 'Space').
  const controls = cloneControls(DEFAULT_CONTROLS);
  controls.players[0].keys.attack[1] = 'KeyZ';
  const rig = new Rig(controls, noPads());
  rig.down('KeyZ');
  const f = rig.step();
  const primaryStillWorks = (() => {
    const r2 = new Rig(controls, noPads());
    r2.down('KeyJ');
    return has(r2.step().pressed, Btn.Attack);
  })();
  const defaultsUntouched = DEFAULT_CONTROLS.players[0].keys.attack[1] === '';
  const pass = has(f.pressed, Btn.Attack) && primaryStillWorks && defaultsUntouched;
  return result('secondary key slot', pass,
    `slot1=${has(f.pressed, Btn.Attack)} slot0=${primaryStillWorks} defaultsUntouched=${defaultsUntouched}`);
}

function testPadButton(): TestResult {
  const pad = fakePad();
  const rig = new Rig(cloneControls(DEFAULT_CONTROLS), padsFrom([pad]));
  rig.step();
  pad.buttons[0] = 1;
  // step() hands back the same frame object each call, so read each sample before the next.
  const f1 = rig.step();
  const held1 = f1.held;
  const pressed1 = f1.pressed;
  const f2 = rig.step();
  const pass = has(pressed1, Btn.Attack) && has(held1, Btn.Attack)
    && has(f2.held, Btn.Attack) && !has(f2.pressed, Btn.Attack);
  return result('pad B0 attack', pass, `held=${held1} pressed=${pressed1} next=${f2.pressed}`);
}

function testAnalogWalk(): TestResult {
  const pad = fakePad();
  const rig = new Rig(cloneControls(DEFAULT_CONTROLS), padsFrom([pad]));
  pad.axes[0] = 0.5;
  const tilt = rig.step();
  const tiltOk = has(tilt.held, Btn.Right) && has(tilt.held, Btn.Walk);
  pad.axes[0] = 0.95;
  const full = rig.step();
  const fullOk = has(full.held, Btn.Right) && !has(full.held, Btn.Walk);
  // A d-pad press alongside a small tilt is digital, so it runs.
  pad.axes[0] = 0.5;
  pad.buttons[15] = 1;
  const dpad = rig.step();
  const dpadOk = has(dpad.held, Btn.Right) && !has(dpad.held, Btn.Walk);
  return result('analog walk threshold', tiltOk && fullOk && dpadOk,
    `tilt 0.5=${tiltOk} full 0.95=${fullOk} dpad+tilt=${dpadOk}`);
}

function testDirectMove(): TestResult {
  // A single-code direct binding, since the default fsmash slot is the chord 'KeyF&KeyJ'.
  const controls = cloneControls(DEFAULT_CONTROLS);
  controls.players[0].keys.fsmash[0] = 'KeyF';
  const rig = new Rig(controls, noPads());
  const want = DIRECT_MOVES.indexOf('fsmash') + 1;
  rig.down('KeyF');
  const d1 = rig.step().direct;
  const d2 = rig.step().direct;
  rig.up('KeyF');
  const d3 = rig.step().direct;
  const pass = d1 === want && d2 === 0 && d3 === 0;
  return result('direct fsmash key', pass, `want=${want} press=${d1} hold=${d2} release=${d3}`);
}

function testLeftWins(): TestResult {
  const rig = new Rig(cloneControls(DEFAULT_CONTROLS), noPads());
  rig.down('KeyA');
  rig.down('KeyD');
  const f = rig.step();
  const pass = has(f.held, Btn.Left) && !has(f.held, Btn.Right)
    && has(f.pressed, Btn.Left) && !has(f.pressed, Btn.Right);
  return result('left and right: left wins', pass, `held=${f.held} pressed=${f.pressed}`);
}

function testV1SaveIgnored(): TestResult {
  const store = new Map<string, string>();
  store.set('aevalrena.controls.v1', JSON.stringify({
    players: [{
      bindings: {
        left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS', jump: 'Space',
        attack: 'KeyX', special: 'KeyK', shield: 'KeyL', taunt: 'KeyT', start: 'Escape',
      },
      tapJump: false,
    }],
  }));
  const fake = {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => { store.set(k, v); },
    removeItem: (k: string): void => { store.delete(k); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  try {
    const loaded = loadControls(DEFAULT_CONTROLS);
    const p0 = loaded.players[0];
    const attack = p0.keys.attack;
    const jump = p0.keys.jump;
    const pass = attack[0] === 'KeyJ' && attack[1] === ''
      && jump[0] === 'KeyW' && jump[1] === 'Space'
      && p0.tapJump
      && p0.keys.fsmash[0] === 'KeyF&KeyJ'
      && p0.keys.walk[0] === 'ShiftLeft'
      && p0.pad.attack[0] === 'B0'
      && loaded.players[1].keys.attack[0] === 'Comma';
    return result('v1 save ignored, not migrated', pass,
      `attack=${attack.join('|')} jump=${jump.join('|')} tapJump=${p0.tapJump} fsmash=${p0.keys.fsmash[0]}`);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

function testCommandKey(): TestResult {
  const controls = cloneControls(DEFAULT_CONTROLS);
  controls.players[0].keys.tech[0] = 'KeyZ';
  // Single-code fsmash so the "two direct codes on one sample" case below needs one key.
  controls.players[0].keys.fsmash[0] = 'KeyF';
  const rig = new Rig(controls, noPads());
  const want = DIRECT_CODES.indexOf('tech') + 1;
  rig.down('KeyZ');
  const d1 = rig.step().direct;
  const d2 = rig.step().direct;
  rig.up('KeyZ');
  const d3 = rig.step().direct;
  // Two direct codes pressed on one sample: the earlier one in DIRECT_CODES wins.
  rig.down('KeyZ');
  rig.down('KeyF');
  const both = rig.step().direct;
  const fsmash = DIRECT_CODES.indexOf('fsmash') + 1;
  const pass = want > DIRECT_MOVES.length && d1 === want && d2 === 0 && d3 === 0 && both === fsmash;
  return result('tech command key', pass, `want=${want} press=${d1} hold=${d2} release=${d3} both=${both}`);
}

function testCommandPad(): TestResult {
  const controls = cloneControls(DEFAULT_CONTROLS);
  controls.players[0].pad.finalSmash[0] = 'B10';
  const pad = fakePad();
  const rig = new Rig(controls, padsFrom([pad]));
  const want = DIRECT_CODES.indexOf('finalSmash') + 1;
  rig.step();
  pad.buttons[10] = 1;
  const d1 = rig.step().direct;
  const d2 = rig.step().direct;
  pad.buttons[10] = 0;
  rig.step();
  pad.buttons[10] = 1;
  const d3 = rig.step().direct;
  const pass = d1 === want && d2 === 0 && d3 === want;
  return result('finalSmash command pad slot', pass, `want=${want} press=${d1} hold=${d2} repress=${d3}`);
}

async function testPadCaptureIgnoresHeld(): Promise<TestResult> {
  // Drive capture ticks by hand: a fake requestAnimationFrame queues callbacks, flush() runs them.
  const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  const savedRaf = g.requestAnimationFrame;
  const savedCaf = g.cancelAnimationFrame;
  let queue: (() => void)[] = [];
  g.requestAnimationFrame = (fn: () => void): number => queue.push(fn);
  g.cancelAnimationFrame = (): void => { queue = []; };
  const flush = (): void => {
    const run = queue;
    queue = [];
    for (const fn of run) fn();
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  try {
    const pad = fakePad();
    pad.buttons[0] = 1;   // the press that opened the prompt, still down
    const pads = padsFrom([pad]);
    const capture = pads.capture(-1);
    // Widened by the cast: the callbacks assign it, which control-flow narrowing cannot see.
    let got = null as string | null;
    capture.promise.then((code) => { got = code; }, () => { got = 'rejected'; });
    for (let i = 0; i < 5; i++) flush();
    await settle();
    const ignoredHeld = got === null;
    pad.buttons[2] = 1;
    flush();
    await settle();
    // Buttons now settle on release, so the press alone must not resolve.
    const heldNotYet = got === null;
    pad.buttons[2] = 0;
    flush();
    await settle();
    const freshOk = got === 'B2';
    capture.cancel();
    return result('pad capture ignores held button', ignoredHeld && heldNotYet && freshOk,
      `ignoredHeld=${ignoredHeld} waitsForRelease=${heldNotYet} onRelease=${String(got)}`);
  } finally {
    g.requestAnimationFrame = savedRaf;
    g.cancelAnimationFrame = savedCaf;
    if (savedRaf === undefined) delete g.requestAnimationFrame;
    if (savedCaf === undefined) delete g.cancelAnimationFrame;
  }
}

function testUntrustedKey(): TestResult {
  const keys = new KeyboardSource(cloneControls(DEFAULT_CONTROLS));
  const handlers = keys as unknown as { onKeyDown(e: unknown): void; onKeyUp(e: unknown): void };
  const event = (code: string, isTrusted: boolean): unknown => ({
    code, isTrusted, repeat: false, target: null,
    preventDefault: (): void => {}, stopImmediatePropagation: (): void => {},
  });
  handlers.onKeyDown(event('ArrowLeft', false));
  const ignored = !keys.held.has('ArrowLeft') && !keys.latch.has('ArrowLeft');
  handlers.onKeyDown(event('ArrowLeft', true));
  const trustedHeld = keys.held.has('ArrowLeft') && keys.latch.has('ArrowLeft');
  handlers.onKeyUp(event('ArrowLeft', false));
  const untrustedUpIgnored = keys.held.has('ArrowLeft');
  const pass = ignored && trustedHeld && untrustedUpIgnored;
  return result('untrusted keydown ignored', pass,
    `untrustedDown=${ignored} trustedDown=${trustedHeld} untrustedUp=${untrustedUpIgnored}`);
}

const FSMASH = DIRECT_CODES.indexOf('fsmash') + 1;
const USMASH = DIRECT_CODES.indexOf('usmash') + 1;
const DTILT = DIRECT_CODES.indexOf('dtilt') + 1;

function p1(): ControlsConfig {
  return cloneControls(DEFAULT_CONTROLS);
}

function testChordFires(): TestResult {
  const rig = new Rig(p1(), noPads());
  rig.hold('KeyF');
  rig.down('KeyJ');
  const f = rig.step();
  const pass = f.direct === FSMASH && !has(f.pressed, Btn.Attack) && has(f.held, Btn.Attack);
  return result('chord fires', pass,
    `direct=${f.direct} want=${FSMASH} pressedAttack=${has(f.pressed, Btn.Attack)} heldAttack=${has(f.held, Btn.Attack)}`);
}

function testChordOrderIndependent(): TestResult {
  const rig = new Rig(p1(), noPads());
  rig.down('KeyJ');
  const a = rig.step();
  const aOk = has(a.pressed, Btn.Attack) && a.direct === 0;
  rig.down('KeyF');
  const b = rig.step();
  const bOk = b.direct === FSMASH && !has(b.pressed, Btn.Attack);
  return result('chord order independent', aOk && bOk, `attackFirst=${aOk} thenF=${bOk} direct=${b.direct}`);
}

function testChordNoRepeat(): TestResult {
  const rig = new Rig(p1(), noPads());
  rig.hold('KeyF');
  rig.down('KeyJ');
  const d1 = rig.step().direct;
  const d2 = rig.step().direct;
  const d3 = rig.step().direct;
  const pass = d1 === FSMASH && d2 === 0 && d3 === 0;
  return result('chord does not repeat', pass, `press=${d1} hold=${d2} hold=${d3}`);
}

function testChordRetaps(): TestResult {
  const rig = new Rig(p1(), noPads());
  rig.hold('KeyF');
  rig.down('KeyJ');
  const d1 = rig.step().direct;
  rig.down('KeyJ');
  const d2 = rig.step().direct;
  rig.down('KeyJ');
  const d3 = rig.step().direct;
  const pass = d1 === FSMASH && d2 === FSMASH && d3 === FSMASH;
  return result('chord retaps', pass, `taps=${d1},${d2},${d3} want=${FSMASH}`);
}

function testTapJumpW(): TestResult {
  const rig = new Rig(p1(), noPads());
  rig.down('KeyW');
  const f = rig.step();
  const pass = has(f.pressed, Btn.Up) && has(f.pressed, Btn.Jump)
    && has(f.held, Btn.Up) && has(f.held, Btn.Jump);
  return result('W jumps', pass, `pressed=${f.pressed} held=${f.held}`);
}

function testWalkBlocksTapJump(): TestResult {
  const rig = new Rig(p1(), noPads());
  rig.hold('ShiftLeft');
  rig.down('KeyW');
  const f = rig.step();
  const pass = has(f.pressed, Btn.Up) && !has(f.pressed, Btn.Jump) && has(f.held, Btn.Walk);
  return result('Shift+W does not jump', pass,
    `up=${has(f.pressed, Btn.Up)} jump=${has(f.pressed, Btn.Jump)} walk=${has(f.held, Btn.Walk)}`);
}

function testUpSmashChord(): TestResult {
  const rig = new Rig(p1(), noPads());
  rig.hold('KeyF');
  rig.down('KeyW');
  const f = rig.step();
  const pass = f.direct === USMASH && !has(f.pressed, Btn.Up) && !has(f.pressed, Btn.Jump)
    && has(f.held, Btn.Up);
  return result('F&W up smash, not a jump', pass,
    `direct=${f.direct} want=${USMASH} pressed=${f.pressed} heldUp=${has(f.held, Btn.Up)}`);
}

function testSpaceJumpsUnderWalk(): TestResult {
  const rig = new Rig(p1(), noPads());
  rig.hold('ShiftLeft');
  rig.down('Space');
  const f = rig.step();
  return result('Space jumps under Shift', has(f.pressed, Btn.Jump), `pressed=${f.pressed}`);
}

function testDownTiltChord(): TestResult {
  const rig = new Rig(p1(), noPads());
  rig.hold('KeyG');
  rig.down('KeyS');
  const f = rig.step();
  const pass = f.direct === DTILT && !has(f.pressed, Btn.Down) && has(f.held, Btn.Down);
  return result('G&S down tilt', pass,
    `direct=${f.direct} want=${DTILT} pressedDown=${has(f.pressed, Btn.Down)} heldDown=${has(f.held, Btn.Down)}`);
}

function testPlainAttackKey(): TestResult {
  const rig = new Rig(p1(), noPads());
  rig.down('KeyJ');
  const f = rig.step();
  const pass = has(f.pressed, Btn.Attack) && f.direct === 0;
  return result('plain J attacks', pass, `pressed=${f.pressed} direct=${f.direct}`);
}

function testTapJumpOff(): TestResult {
  const controls = p1();
  controls.players[0].tapJump = false;
  const solo = new Rig(controls, noPads());
  solo.down('KeyW');
  const jumped = has(solo.step().pressed, Btn.Jump);
  const walked = new Rig(controls, noPads());
  walked.hold('ShiftLeft');
  walked.down('KeyW');
  const walkJumped = has(walked.step().pressed, Btn.Jump);
  return result('tapJump off keeps the W binding', jumped && !walkJumped,
    `W=${jumped} shiftW=${walkJumped}`);
}

function testPadChord(): TestResult {
  const controls = p1();
  controls.players[0].pad.grab[0] = 'B6&B0';
  const pad = fakePad();
  pad.buttons[6] = 1;
  pad.buttons[0] = 1;
  const rig = new Rig(controls, padsFrom([pad]));
  const f = rig.step();
  const chordOk = has(f.pressed, Btn.Grab) && !has(f.pressed, Btn.Attack) && !has(f.pressed, Btn.Shield);
  const solo = fakePad();
  solo.buttons[0] = 1;
  const soloOk = has(new Rig(controls, padsFrom([solo])).step().pressed, Btn.Attack);
  return result('pad chord', chordOk && soloOk, `chord=${chordOk} soloAttack=${soloOk} pressed=${f.pressed}`);
}

async function testKeyCaptureChord(): Promise<TestResult> {
  const keys = new KeyboardSource(cloneControls(DEFAULT_CONTROLS));
  const handlers = keys as unknown as { onKeyDown(e: unknown): void; onKeyUp(e: unknown): void };
  const event = (code: string): unknown => ({
    code, isTrusted: true, repeat: false, target: null,
    preventDefault: (): void => {}, stopImmediatePropagation: (): void => {},
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  const got: string[] = [];
  const watch = (p: Promise<string>): void => {
    p.then((code) => { got.push(code); }, () => { got.push('rejected'); });
  };
  watch(keys.listenForNextKey());
  handlers.onKeyDown(event('KeyF'));
  handlers.onKeyDown(event('KeyJ'));
  handlers.onKeyUp(event('KeyJ'));
  await settle();
  const chordOk = got[0] === 'KeyF&KeyJ';
  watch(keys.listenForNextKey());
  handlers.onKeyDown(event('KeyJ'));
  handlers.onKeyUp(event('KeyJ'));
  await settle();
  const soloOk = got[1] === 'KeyJ';
  return result('key capture chord', chordOk && soloOk, `chord=${String(got[0])} solo=${String(got[1])}`);
}

function testGentleStickUpNoTapJump(): TestResult {
  // Up is 'A1-', so axes[1] = -0.5 is a 0.5 tilt: past the deadzone, short of walkAxis 0.7.
  const gentle = fakePad();
  gentle.axes[1] = -0.5;
  const soft = new Rig(p1(), padsFrom([gentle])).step();
  const softOk = has(soft.pressed, Btn.Up) && !has(soft.pressed, Btn.Jump);
  const shoved = fakePad();
  shoved.axes[1] = -0.95;
  const full = new Rig(p1(), padsFrom([shoved])).step();
  const fullOk = has(full.pressed, Btn.Up) && has(full.pressed, Btn.Jump);
  return result('gentle stick up does not tap jump', softOk && fullOk,
    `tilt 0.5 up=${has(soft.pressed, Btn.Up)} jump=${has(soft.pressed, Btn.Jump)} full 0.95 jump=${has(full.pressed, Btn.Jump)}`);
}

function testPlayer2WalkKey(): TestResult {
  const p2Walk = DEFAULT_CONTROLS.players[1].keys.walk[0];
  const p4Walk = DEFAULT_CONTROLS.players[3].keys.walk[0];
  const p4Jump = DEFAULT_CONTROLS.players[3].keys.jump;
  const noG = p4Jump[0] !== 'KeyG' && p4Jump[1] !== 'KeyG';
  const pass = p2Walk === 'ShiftRight' && p4Walk === 'KeyX' && noG;
  return result('player 2 has a walk key', pass,
    `p2Walk=${p2Walk} p4Walk=${p4Walk} p4Jump=${p4Jump.join('|')}`);
}

export async function runInputSelfTest(): Promise<TestResult[]> {
  return [
    testKeyAttack(),
    testSecondarySlot(),
    testPadButton(),
    testAnalogWalk(),
    testDirectMove(),
    testLeftWins(),
    testV1SaveIgnored(),
    testCommandKey(),
    testCommandPad(),
    await testPadCaptureIgnoresHeld(),
    testUntrustedKey(),
    testChordFires(),
    testChordOrderIndependent(),
    testChordNoRepeat(),
    testChordRetaps(),
    testTapJumpW(),
    testWalkBlocksTapJump(),
    testUpSmashChord(),
    testSpaceJumpsUnderWalk(),
    testDownTiltChord(),
    testPlainAttackKey(),
    testTapJumpOff(),
    testPadChord(),
    await testKeyCaptureChord(),
    testGentleStickUpNoTapJump(),
    testPlayer2WalkKey(),
  ];
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('inputtest.ts')) {
  void runInputSelfTest().then((results) => {
    let passed = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.pass) passed++;
      process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}\n`);
    }
    process.stdout.write(`${passed}/${results.length} pass\n`);
    if (passed !== results.length) process.exitCode = 1;
  });
}
