// Pads, orbs, the way they face and the accelerating flag, pinned to the 2.206
// decompile rather than to measurements of this port. Each case names the
// lines it reads; the derivation is in data/ref/gd-discrepancies.md §8, §12
// and §17.
//
// Constants at 1x: yStart 11.1800318, which a launch rounds to 11.18; flying
// gravity 0.958199024; JUMP_DT 0.225 as a float. Every launch goes through
// setYVelocity's three decimals, and the slow modes' share after it is raw.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMode, Level } from "../src/level/types";
import { applyGroupTransform, F_FLIP_Y, F_MULTI, F_SHARED, K_ORB, K_PAD, K_PORTAL, ObjectSet } from "../src/physics/collision";
import { JUMP_DT } from "../src/physics/constants";
import { isFacingDown, isFacingLeft } from "../src/physics/geometry";
import { Player, type LaunchOrb, type PlayerWorld } from "../src/physics/player";
import { getBumpMod } from "../src/physics/sim";
import { NO_INPUT, type Sim, type StartState } from "../src/physics/types";
import { loadObjectTable, makeSim } from "./helpers";
import { buildLevel, emptyLevel, floor, HOLD, makeHeader, type Placed, simOn, stepN } from "./levelKit";

const EPS = 1e-9;
const YSTART = 11.18;

const MODES: GameMode[] = ["cube", "ship", "ball", "ufo", "wave", "robot", "spider", "swing"];

/** Object ids. */
const PAD = { yellow: 35, pink: 140, red: 1332, blue: 67, spider: 3005 } as const;
const ORB = { yellow: 36, spider: 3004, toggle: 1594 } as const;
const SPEED_PORTAL = { slow: 200, normal: 201, double: 202, fast: 203 } as const;
const DUAL_PORTAL = 286;
const SHIP_PORTAL = 13;
const WAVE_PORTAL = 660;
const SWING_PORTAL = 1933;
const GRAVITY_NORMAL_PORTAL = 10;

const RIGHT = { jump: false, left: false, right: true };
const LEFT = { jump: false, left: true, right: false };

function world(platformer = false): PlayerWorld {
  return { emit: () => {}, spiderJump: () => {}, platformer, dual: false, fixGravityBug: false, boostSlide: true };
}

function player(mode: GameMode, opts: { mini?: boolean; flipped?: boolean; platformer?: boolean } = {}): Player {
  const p = new Player(world(opts.platformer), 1);
  p.setMode(mode);
  p.mini = opts.mini ?? false;
  p.flipped = opts.flipped ?? false;
  return p;
}

function near(actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

/** Player 1 as the sim holds it, for the fields PlayerState does not list. */
function p1(sim: Sim): Player {
  return sim.state as Player;
}

// --- the tables ---------------------------------------------------------------

test("getBumpMod matches the game's table", () => {
  // [gd-ida-decomp.cpp:421316-421366]
  for (const mode of MODES) {
    for (const mini of [false, true]) {
      const p = player(mode, { mini });
      const tag = `${mini ? "mini " : ""}${mode}`;
      assert.equal(getBumpMod(p, "yellow"), 1, `yellow ${tag}`);
      // getBumpMod returns a float.
      const pink = mode === "ship" ? 0.35 : mode === "ufo" ? 0.4 : mode === "ball" || mode === "spider" ? 0.7 : 0.65;
      assert.equal(getBumpMod(p, "pink"), Math.fround(pink), `pink ${tag}`);
      const red = mode === "ship" ? (mini ? 0.95 : 0.63) : mode === "ufo" ? (mini ? 0.98 : 0.6) : 1.25;
      assert.equal(getBumpMod(p, "red"), Math.fround(red), `red ${tag}`);
    }
  }
});

test("isFacingDown and isFacingLeft follow the game's integer test and flipY", () => {
  // [gd-ida-decomp.cpp:170986-171050; both read flipY, neither flipX]
  const down: Array<[number, boolean, boolean]> = [
    [0, false, false],
    [0, true, true],
    [180, false, true],
    [-180, false, true],
    [180, true, false],
    [90, false, false],
    [270, false, false],
    [29, false, false],
    [91, false, true],
    [269, false, true],
    [-91, false, true],
    [-45, false, false],
    [135, true, false],
    // The rotation is truncated as it stands, never wrapped first.
    [-90.5, false, false],
    [-269.5, false, true],
    [540, false, false],
    [180.5, false, true],
  ];
  for (const [rot, flipY, want] of down) assert.equal(isFacingDown(rot, flipY), want, `isFacingDown(${rot}, ${flipY})`);
  const left: Array<[number, boolean, boolean]> = [
    [270, false, true],
    [270, true, false],
    [-90, false, true],
    [90, false, false],
    [90, true, true],
    [-270, false, false],
    [0, false, false],
    [0, true, false],
    [180, true, false],
    [135, false, true],
    [45, false, false],
    [200, true, false],
    [-90.5, false, true],
    [630, false, false],
    [-450, false, false],
  ];
  for (const [rot, flipY, want] of left) assert.equal(isFacingLeft(rot, flipY), want, `isFacingLeft(${rot}, ${flipY})`);
});

test("pads and orbs keep their rotation unwrapped, rotate triggers included", () => {
  // getObjectRotation is key 6 plus every turn a rotate trigger has added,
  // with no wrap. [gd-ida-decomp.cpp:163874-163876, 170742-170746]
  const level = buildLevel([
    { id: PAD.blue, x: 100, y: 100, rotation: -90.5 },
    { id: ORB.yellow, x: 200, y: 100, rotation: 350 },
  ]);
  const base = new ObjectSet(level, loadObjectTable());
  assert.equal(base.rawRot[0], -90.5);
  near(base.rotDeg[0], 269.5, "the geometry's own angle is still wrapped");
  const live = base.cloneForMotion();
  const identity = Float64Array.of(1, 0, 0, 1, 0, 0);
  applyGroupTransform(base, live, 1, identity, 190, 1, 1);
  assert.equal(live.rawRot[1], 540, "a trigger turn adds to the raw rotation");
  near(live.rotDeg[1], 180, "and wraps the geometry's");
  assert.equal(base.rawRot[1], 350, "the shared set is not written");
  const mirror = base.cloneReflected();
  assert.equal(mirror.rawRot[0], -90.5, "the mirror keeps the world's rotation");
});

// --- launches on the player alone -------------------------------------------------

test("propellPlayer is 16 × bumpMod, × 0.8 mini, × 0.6 ball/spider/swing, and leaves the accelerating flag", () => {
  // [gdp PlayerObject::propellPlayer, gd-ida-decomp.cpp:147666-147712]
  const cases: Array<{ mode: GameMode; mini?: boolean; flipped?: boolean; mod: number; want: number }> = [
    { mode: "ship", mini: true, mod: 0.95, want: 12.16 },
    { mode: "cube", flipped: true, mod: 1, want: -16 },
    // 11.2 and 16, then the float 0.6 raw on the double.
    { mode: "ball", mod: 0.7, want: 6.720000267028809 },
    { mode: "swing", mod: 1, want: 9.600000381469727 },
    { mode: "wave", mod: 1, want: 16 },
  ];
  for (const c of cases) {
    for (const acc of [true, false]) {
      const p = player(c.mode, c);
      p.isAccelerating = acc;
      p.onGround = true;
      p.onGround2 = true;
      p.propellPlayer(c.mod);
      const tag = `${c.mini ? "mini " : ""}${c.flipped ? "flipped " : ""}${c.mode}`;
      near(p.yVel, c.want, tag);
      assert.equal(p.isAccelerating, acc, `${tag}: the accelerating flag is bumpPlayer's to write`);
      assert.equal(p.maybeIsBoosted, true, `${tag}: boosted`);
      assert.equal(p.onGround, false, `${tag}: off the ground`);
      assert.equal(p.onGround2, false, `${tag}: off the ground (2)`);
    }
  }
});

test("a pad or an orb spins the cube at the ordinary rate: 180 / 0.43333, mini 180 / 0.33333", () => {
  // propellPlayer and ringJump both call runRotateAction, which runs
  // runNormalRotation; boostPlayer's backwards spin is the slope's alone.
  // The divisor is 0.33333 unless the scale is exactly 1.
  // [gd-ida-decomp.cpp:147694, 160263-160266, 160374-160377; runNormalRotation
  //  :144512-144540]
  for (const mini of [false, true]) {
    for (const flipped of [false, true]) {
      const want = (flipped ? -1 : 1) * (mini ? 540.00537109375 : 415.3878173828125);
      const tag = `${mini ? "mini " : ""}${flipped ? "flipped " : ""}cube`;
      const pad = player("cube", { mini, flipped });
      pad.propellPlayer(1);
      assert.deepEqual([pad.spinning, pad.spinSpeed], [true, want], `${tag}: pad`);
      const orb = player("cube", { mini, flipped });
      orb.ringLaunch("yellow");
      assert.deepEqual([orb.spinning, orb.spinSpeed], [true, want], `${tag}: orb`);
      const black = player("cube", { mini, flipped });
      black.dropRingLaunch();
      assert.deepEqual([black.spinning, black.spinSpeed], [true, want], `${tag}: black orb`);
    }
  }
});

test("ringLaunch is the game's orb table", () => {
  // [gdp PlayerObject::ringJump, gd-ida-decomp.cpp:160141-160350]
  const cases: Array<{ type: LaunchOrb; mode: GameMode; mini?: boolean; want: number }> = [
    { type: "yellow", mode: "ship", want: YSTART },
    { type: "yellow", mode: "ship", mini: true, want: 8.944 },
    { type: "yellow", mode: "ufo", want: YSTART },
    { type: "yellow", mode: "robot", want: 10.062 },
    { type: "red", mode: "ship", mini: true, want: 12.522 },
    { type: "red", mode: "ufo", mini: true, want: 12.164 },
    { type: "red", mode: "ufo", want: 11.404 },
    // 8.05 and 8.609, then the float 0.7 raw on the double.
    { type: "pink", mode: "spider", want: 5.634999904036523 },
    { type: "pink", mode: "ball", want: 6.026299897372723 },
    { type: "green", mode: "robot", want: YSTART },
    // 11.18, then the float 0.6 raw on the double.
    { type: "green", mode: "swing", want: 6.708000266551971 },
    { type: "green", mode: "ufo", want: YSTART },
    { type: "blue", mode: "cube", want: 8.944 },
  ];
  for (const c of cases) {
    for (const acc of [true, false]) {
      const p = player(c.mode, c);
      p.onGround = true;
      p.holding = true;
      p.stateRingJump = true;
      p.isAccelerating = acc;
      p.ringLaunch(c.type);
      const tag = `${c.type} orb, ${c.mini ? "mini " : ""}${c.mode}`;
      near(p.yVel, c.want, tag);
      const letsGo = c.mode === "ball" || c.mode === "spider" || c.mode === "swing";
      assert.equal(p.holding, !letsGo, `${tag}: button`);
      assert.equal(p.stateRingJump, false, `${tag}: the press is spent`);
      assert.equal(p.maybeIsBoosted, true, `${tag}: boosted`);
      assert.equal(p.onGround, false, `${tag}: off the ground`);
      assert.equal(p.isAccelerating, c.type === "red" ? true : acc, `${tag}: accelerating flag`);
    }
  }
});

test("the black orb: −15, spider −16.5, flying −14, UFO −11.2, and nothing else", () => {
  // [gdp PlayerObject::ringJump, gd-ida-decomp.cpp:160352-160383]
  const cases: Array<{ mode: GameMode; flipped?: boolean; want: number }> = [
    { mode: "cube", want: -15 },
    { mode: "cube", flipped: true, want: 15 },
    { mode: "robot", want: -15 },
    { mode: "ball", want: -15 },
    { mode: "spider", want: -16.5 },
    { mode: "ship", want: -14 },
    { mode: "ufo", want: -11.2 },
    { mode: "wave", want: -14 },
    { mode: "swing", want: -14 },
  ];
  for (const c of cases) {
    const p = player(c.mode, c);
    p.maybeIsBoosted = false;
    p.onGround = true;
    p.holding = true;
    p.dropRingLaunch();
    const tag = `${c.flipped ? "flipped " : ""}${c.mode}`;
    near(p.yVel, c.want, tag);
    assert.equal(p.isAccelerating, true, `${tag}: accelerating`);
    assert.equal(p.maybeIsBoosted, false, `${tag}: the boost is left alone`);
    assert.equal(p.onGround, true, `${tag}: the ground flag is left alone`);
    assert.equal(p.holding, !(c.mode === "ball" || c.mode === "swing"), `${tag}: button`);
  }
  // A spider that was not boosted is held to 15 again by its next tick.
  const s = player("spider");
  s.dropRingLaunch();
  s.holding = false;
  s.onGround = false;
  s.updateJump(JUMP_DT);
  assert.equal(s.yVel, -15);
});

test("the fly cap takes an orb or pad launch back on the next tick, unless the red one set the flag", () => {
  // [gdp updateJump, gd-ida-decomp.cpp:155477-155600; thrust base :155527-155531]
  const a = player("ship");
  a.ringLaunch("yellow");
  a.updateJump(JUMP_DT);
  near(a.yVel, 8, "yellow orb, ship");

  const b = player("ship", { mini: true });
  b.ringLaunch("yellow");
  b.updateJump(JUMP_DT);
  near(b.yVel, 8.822, "yellow orb, mini ship (8.944 is inside its cap)");

  const c = player("ship", { mini: true });
  c.ringLaunch("red");
  c.updateJump(JUMP_DT);
  near(c.yVel, 12.4, "red orb, mini ship");
  assert.equal(c.isAccelerating, true, "the red orb keeps the ship past its cap");

  // Accelerating and moving down, released: the thrust back is at 0.4, not 0.5.
  const d = player("ship");
  d.isAccelerating = true;
  d.yVel = -10;
  d.updateJump(JUMP_DT);
  near(d.yVel, -9.914, "accelerating ship, released");

  // A released platformer ship falls at 0.4 too.
  const e = player("ship", { platformer: true });
  e.yVel = -1;
  e.updateJump(JUMP_DT);
  near(e.yVel, -1.055, "platformer ship, released");

  // Held and falling is the one case with 0.5.
  const f = player("ship");
  f.yVel = -1;
  f.holding = true;
  f.updateJump(JUMP_DT);
  near(f.yVel, -0.892, "held ship, falling");
});

test("landing leaves the accelerating flag alone", () => {
  // hitGround has no write to +1858. [gd-ida-decomp.cpp:149979-150200]
  const p = player("cube");
  p.isAccelerating = true;
  p.hitGround(-1, false);
  assert.equal(p.isAccelerating, true);
});

// --- pads in a level ----------------------------------------------------------------

interface Run {
  sim: Sim;
  pads: number[];
  portals: number[];
}

function run(level: Level, start: Partial<StartState>): Run {
  const out: Run = { sim: null as unknown as Sim, pads: [], portals: [] };
  out.sim = makeSim(level, undefined, {
    start: { x: 15, y: 45, ...start },
    onEvent: (e) => {
      if (e.type === "pad") out.pads.push(e.tick);
      if (e.type === "portal") out.portals.push(e.tick);
    },
  });
  return out;
}

test("a yellow pad clears the flag and the fly cap brings a flyer to 8 on the next tick", () => {
  // The pad sets 16 × 0.8 when mini (× 0.6 for the swing) and clears +1858; the
  // next updateJump clamps. [gd-ida-decomp.cpp:147691, 157084, 155559-155596]
  const cases: Array<{ mode: GameMode; mini?: boolean; first: number; second: number }> = [
    { mode: "ship", first: 16, second: 8 },
    { mode: "ship", mini: true, first: 12.8, second: 9.412 },
    { mode: "ufo", first: 16, second: 8 },
    { mode: "swing", first: 9.600000381469727, second: 8 },
  ];
  for (const c of cases) {
    const tag = `${c.mini ? "mini " : ""}${c.mode}`;
    const r = run(emptyLevel([{ id: PAD.yellow, x: 15, y: 100 }]), { y: 100, mode: c.mode, mini: c.mini ?? false });
    p1(r.sim).isAccelerating = true;
    r.sim.step(NO_INPUT);
    assert.deepEqual(r.pads, [1], `${tag}: the pad fires on the first tick`);
    near(r.sim.state.yVel, c.first, `${tag}: launch`);
    assert.equal(p1(r.sim).isAccelerating, false, `${tag}: the yellow pad clears the flag`);
    r.sim.step(NO_INPUT);
    near(r.sim.state.yVel, c.second, `${tag}: next tick`);
  }
});

test("a red pad lets a mini ship and UFO past the cap", () => {
  // getBumpMod 0.95 / 0.98 for mini, and +1858 = 1. [gd-ida-decomp.cpp:421343-421362, 157077-157079]
  const cases: Array<{ mode: GameMode; first: number; second: number }> = [
    { mode: "ship", first: 12.16, second: 12.038 },
    { mode: "ufo", first: 12.544, second: 12.392 },
  ];
  for (const c of cases) {
    const r = run(emptyLevel([{ id: PAD.red, x: 15, y: 100 }]), { y: 100, mode: c.mode, mini: true });
    r.sim.step(NO_INPUT);
    assert.deepEqual(r.pads, [1], `mini ${c.mode}: the pad fires on the first tick`);
    near(r.sim.state.yVel, c.first, `mini ${c.mode}: launch`);
    assert.equal(p1(r.sim).isAccelerating, true, `mini ${c.mode}: the red pad sets the flag`);
    r.sim.step(NO_INPUT);
    near(r.sim.state.yVel, c.second, `mini ${c.mode}: next tick, uncapped`);
  }
});

test("a mode portal leaves the accelerating flag and the boost alone", () => {
  // No mode toggle writes +1858 or +2060. [gd-ida-decomp.cpp:152569-153290, 462507-462600]
  // A cube falling at 15 enters a ship portal: halved to 7.5, then capped at 6.4.
  const falling = run(emptyLevel([{ id: SHIP_PORTAL, x: 200, y: 300, scaleY: 8 }]), { y: 600 });
  for (let i = 0; i < 400 && falling.portals.length === 0; i++) falling.sim.step(NO_INPUT);
  assert.equal(falling.portals.length, 1, "the cube never reached the portal");
  assert.equal(falling.sim.state.mode, "ship");
  near(falling.sim.state.yVel, -7.5, "on the portal tick");
  falling.sim.step(NO_INPUT);
  near(falling.sim.state.yVel, -6.4, "the ship's first tick holds it to its cap");

  // A cube rising from a jump keeps its boost through a ship portal.
  const rising = run(emptyLevel([{ id: SHIP_PORTAL, x: 75, y: 110 }]), {});
  stepN(rising.sim, NO_INPUT, 12);
  rising.sim.step(HOLD);
  for (let i = 0; i < 60 && rising.portals.length === 0; i++) rising.sim.step(NO_INPUT);
  assert.equal(rising.portals.length, 1, "the cube never reached the portal");
  assert.ok(rising.sim.state.yVel > 4, `expected to enter while rising, yVel ${rising.sim.state.yVel}`);
  assert.equal(p1(rising.sim).maybeIsBoosted, true, "the portal leaves the boost set");
});

test("a pad fires once per player; a multi-activate pad on every entry", () => {
  // [gdp canBeActivatedByPlayer, gd-ida-decomp.cpp:456752-456765; loop skip :463439]
  // A 250-wide pad the cube starts on and lands back on.
  const fired = (props?: Record<number, string>): number[] => {
    const r = run(emptyLevel([{ id: PAD.yellow, x: 150, y: 31, scaleX: 10, props }]), {});
    for (let i = 0; i < 1000 && r.sim.state.x < 700; i++) r.sim.step(NO_INPUT);
    return r.pads;
  };
  assert.deepEqual(fired(), [1], "landing back on a used pad does nothing");
  assert.equal(fired({ 99: "1" }).length, 2, "with key 99 the landing fires it again");
});

test("orbs, pads and portals default to multi-activate in a platformer, and key 444 turns it off", () => {
  // canMultiActivate = platformer ? !key444 : key99. [gd-ida-decomp.cpp:164106-164112, 181776-181785]
  // A speed portal is a trigger underneath, and only key 87 re-arms it. Where
  // canMultiActivate says no, triggerActivated marks it used for both players;
  // where it says yes, the trigger's own record decides, per player unless key
  // 284 shares it. [collisionCheckObjects :463439, :463671-463674;
  // playerTouchedTrigger :456781-456825; triggerActivated :298093-298099,
  // :164128-164132; +1548 = key 284 at :298689-298692]
  const variants: Array<Record<number, string>> = [{}, { 99: "1" }, { 444: "1" }, { 99: "1", 444: "1" }, { 87: "1" }, { 284: "1" }];
  const placed: Placed[] = [];
  for (const id of [PAD.yellow, SHIP_PORTAL, ORB.yellow, SPEED_PORTAL.slow]) {
    variants.forEach((props, k) => placed.push({ id, x: 100 + placed.length * 60, y: 100, props, flipY: k % 2 === 1 }));
  }
  for (const platformer of [false, true]) {
    const level = buildLevel(placed, makeHeader({ platformer }));
    const set = new ObjectSet(level, loadObjectTable());
    level.objects.forEach((o, i) => {
      assert.ok([K_ORB, K_PAD, K_PORTAL].includes(set.kind[i]), `object ${o.id} kind`);
      const has99 = o.props[99] === "1";
      const has444 = o.props[444] === "1";
      const canMulti = platformer ? !has444 : has99;
      const speed = o.id === SPEED_PORTAL.slow;
      const multi = speed ? o.props[87] === "1" : canMulti;
      const shared = speed && !multi && (!canMulti || o.props[284] === "1");
      const tag = `${platformer ? "platformer" : "classic"} id ${o.id} ${JSON.stringify(o.props)}`;
      assert.equal((set.flags[i] & F_MULTI) !== 0, multi, tag);
      assert.equal((set.flags[i] & F_SHARED) !== 0, shared, `shared: ${tag}`);
      assert.equal((set.flags[i] & F_FLIP_Y) !== 0, o.flipY, `flipY on id ${o.id}`);
    });
  }
});

test("a speed portal fires once per player in a platformer, walking back through it included, unless key 87 is set", () => {
  // playerTouchedTrigger fires a touch trigger once per player and re-arms it
  // on a fresh entry only with +1476 (key 87). [gd-ida-decomp.cpp:456781-456822, 298685-298688]
  const walk = (fastProps?: Record<number, string>): { events: string[]; speed: number } => {
    const events: string[] = [];
    const level = buildLevel(
      [...floor(0, 3000), { id: SPEED_PORTAL.fast, x: 150, y: 60, props: fastProps }, { id: SPEED_PORTAL.normal, x: 300, y: 60 }],
      makeHeader({ platformer: true }),
    );
    const sim = makeSim(level, undefined, {
      start: { x: 15, y: 45 },
      onEvent: (e) => {
        if (e.type === "portal") events.push(String(e.detail));
      },
    });
    for (let i = 0; i < 2000 && sim.state.x < 400; i++) sim.step(RIGHT);
    for (let i = 0; i < 4000 && sim.state.x > 100; i++) sim.step(LEFT);
    assert.ok(sim.state.x <= 100, `never walked back, x ${sim.state.x}`);
    return { events, speed: sim.state.speed };
  };
  const plain = walk();
  assert.deepEqual(plain.events, ["speed3", "speed1"], "each portal fires once");
  assert.equal(plain.speed, 1, "and the player keeps the last one");
  const multi = walk({ 87: "1" });
  assert.deepEqual(multi.events, ["speed3", "speed1", "speed3"], "key 87 fires it again on the way back");
  assert.equal(multi.speed, 3);
});

test("a speed portal sets both players' speed once the step is done; in a classic level one touch spends it for both", () => {
  // triggerObject only queues the speed; the next sub-step hands it to player 1
  // and, in a dual, player 2. triggerActivated marks the portal used for both
  // players, which the collision loop honours unless canMultiActivate says yes,
  // as it does for every portal in a platformer.
  // [gd-ida-decomp.cpp:315460-315481, 421462-421485, 469847-469848,
  //  456825, 164128-164132, 165257-165270, 463439]
  const cross = (platformer: boolean, tall: boolean) => {
    // A dual from x 150 puts player 2 on the ceiling. A plain portal on the
    // floor is only in player 1's way; a tall one is in both players' way.
    const portal: Placed = tall
      ? { id: SPEED_PORTAL.double, x: 450, y: 150, scaleY: 6 }
      : { id: SPEED_PORTAL.double, x: 450, y: 45 };
    const level = buildLevel([...floor(0, 3000), { id: DUAL_PORTAL, x: 150, y: 90 }, portal], makeHeader({ platformer }));
    const fired: Array<{ tick: number; player: number; speedThen: number }> = [];
    const sim: Sim = makeSim(level, undefined, {
      start: { x: 15, y: 45, mode: "cube" },
      onEvent: (e) => {
        if (e.type === "portal" && e.detail === "speed2") fired.push({ tick: e.tick, player: e.player, speedThen: sim.state.speed });
      },
    });
    let after: Array<number | undefined> | null = null;
    for (let i = 0; i < 1500 && sim.state.x < 600; i++) {
      sim.step(platformer ? RIGHT : NO_INPUT);
      if (after === null && fired.length > 0) after = [sim.state.speed, sim.state2?.speed];
    }
    assert.ok(sim.state2 !== null, "the dual never started");
    assert.ok(sim.state.x >= 600, `never got past the portal, x ${sim.state.x}`);
    return { fired, after };
  };
  const low = cross(false, false);
  assert.deepEqual(low.fired.map((f) => f.player), [1], "only player 1 touches the low portal");
  assert.equal(low.fired[0].speedThen, 1, "the speed is queued, not applied, while the collision pass runs");
  assert.deepEqual(low.after, [2, 2], "player 2 gets the speed player 1 touched, at the end of the same step");

  const classic = cross(false, true);
  assert.equal(classic.fired.length, 1, "in a classic level the first touch spends the portal for both players");
  assert.deepEqual(classic.after, [2, 2]);

  const plat = cross(true, true);
  assert.deepEqual(plat.fired.map((f) => f.player).sort(), [1, 2], "in a platformer each player fires it once");
  assert.deepEqual(plat.after, [2, 2]);
});

test("a platformer passes over wave and swing portals", () => {
  // Cases 0x1A and 0x29 break on the platformer flag before anything else.
  // [gd-ida-decomp.cpp:463733-463740, 463815-463822]
  for (const [id, mode] of [
    [WAVE_PORTAL, "wave"],
    [SWING_PORTAL, "swing"],
    [SHIP_PORTAL, "ship"],
  ] as const) {
    for (const platformer of [false, true]) {
      const portals: string[] = [];
      const level = emptyLevel([{ id, x: 80, y: 45 }], makeHeader({ platformer }));
      const sim = makeSim(level, undefined, {
        start: { x: 15, y: 45 },
        onEvent: (e) => {
          if (e.type === "portal") portals.push(String(e.detail));
        },
      });
      for (let i = 0; i < 400 && portals.length === 0 && sim.state.x < 150; i++) sim.step(RIGHT);
      const skipped = platformer && mode !== "ship";
      const tag = `${platformer ? "platformer" : "classic"} ${mode} portal`;
      if (skipped) assert.ok(sim.state.x >= 150, `${tag}: never walked past the portal`);
      assert.deepEqual(portals, skipped ? [] : [mode], tag);
      assert.equal(sim.state.mode, skipped ? "cube" : mode, tag);
    }
  }
});

// --- the blue pad --------------------------------------------------------------------

/** A ceiling of blocks at 150..180 over x 0..900, and a flipped cube standing under it. */
function ceilingLevel(extra: Placed[], header = makeHeader()): Level {
  return buildLevel([...floor(0, 3000), ...floor(0, 900, 165), ...extra], header);
}
const UNDER_CEILING: Partial<StartState> = { y: 135, flipped: true };

test("a blue pad does nothing when the player already has its gravity", () => {
  // gravBumpPlayer: target = !isFacingDown(pad); nothing when upsideDown == target.
  // [gd-ida-decomp.cpp:463231-463237] The facing test reads the rotation
  // unwrapped, so 540 and −90.5 point up here, not down.
  for (const pad of [{}, { rotation: 540 }, { rotation: -90.5 }] as Array<Partial<Placed>>) {
    const tag = JSON.stringify(pad);
    const r = run(ceilingLevel([{ id: PAD.blue, x: 200, y: 121, ...pad }]), UNDER_CEILING);
    let touched = false;
    for (let i = 0; i < 1000 && r.sim.state.x < 400; i++) {
      r.sim.step(NO_INPUT);
      if (Math.abs(r.sim.state.x - 200) < 20) touched = true;
      assert.equal(r.sim.state.flipped, true, `${tag}: flipped at x ${r.sim.state.x}`);
      near(r.sim.state.y, 135, `${tag}: y at x ${r.sim.state.x}`, 1e-6);
    }
    assert.ok(touched, `${tag}: the cube never passed the pad`);
    assert.deepEqual(r.pads, [], `${tag}: the pad should not have fired`);
  }
});

test("a blue pad facing down sends a flipped player to normal gravity at −6.4", () => {
  // propellPlayer(0.8) = −12.8 under flipped gravity, then flipGravity halves it.
  // flipY turns the pad over as surely as a 180° rotation does. [gd-ida-decomp.cpp:463253-463254]
  for (const pad of [
    { flipY: true },
    { rotation: 180 },
    { rotation: -180 },
    { rotation: -269.5 },
  ] as Array<Partial<Placed>>) {
    const r = run(ceilingLevel([{ id: PAD.blue, x: 200, y: 121, ...pad }]), UNDER_CEILING);
    for (let i = 0; i < 1000 && r.pads.length === 0 && r.sim.state.x < 400; i++) r.sim.step(NO_INPUT);
    assert.equal(r.pads.length, 1, `${JSON.stringify(pad)}: the pad never fired`);
    assert.equal(r.sim.state.flipped, false, `${JSON.stringify(pad)}: normal gravity`);
    near(r.sim.state.yVel, -6.4, `${JSON.stringify(pad)}: launch`);
  }
});

test("a blue pad that did nothing keeps its activation", () => {
  // The return at :463237 comes before canBeActivatedByPlayer, so the pad is
  // still there to use once a gravity portal inside it turns the player over.
  const r = run(
    ceilingLevel([
      { id: PAD.blue, x: 300, y: 121, scaleX: 10 },
      { id: GRAVITY_NORMAL_PORTAL, x: 250, y: 135 },
    ]),
    UNDER_CEILING,
  );
  for (let i = 0; i < 1000 && r.sim.state.x < 600; i++) r.sim.step(NO_INPUT);
  assert.equal(r.portals.length, 1, "the cube never reached the portal");
  assert.equal(r.pads.length, 1, `the pad should fire exactly once, got ${r.pads.length}`);
  assert.ok(r.pads[0] >= r.portals[0], `the pad fired at tick ${r.pads[0]}, before the portal at ${r.portals[0]}`);
  assert.equal(r.sim.state.flipped, true, "back under the ceiling");
  assert.equal(r.sim.state.onGround, true, "standing on it");
  near(r.sim.state.y, 135, "y", 1e-6);
});

// --- the robot's held jump and pads -------------------------------------------------

/** Where a robot is 30 ticks into a held jump, after 20 ticks to settle. */
function heldRobotPoint(platformer: boolean): { x: number; y: number } {
  const probe = simOn(emptyLevel([], makeHeader({ platformer })), {}, "robot");
  stepN(probe, NO_INPUT, 20);
  stepN(probe, HOLD, 30);
  return { x: probe.state.x, y: probe.state.y };
}

/** A held robot jump into `padId`, still holding: yVel on the pad tick and the ones after. */
function robotIntoPad(padId: number, header = makeHeader()): { velocities: number[]; flipped: boolean } {
  const at = heldRobotPoint(header.platformer);
  const r = run(emptyLevel([{ id: padId, x: header.platformer ? 15 : at.x, y: at.y }], header), { mode: "robot" });
  stepN(r.sim, NO_INPUT, 20);
  for (let i = 0; i < 60 && r.pads.length === 0; i++) stepN(r.sim, HOLD, 1);
  assert.equal(r.pads.length, 1, "the robot never reached the pad");
  const velocities = [r.sim.state.yVel];
  const flipped = r.sim.state.flipped;
  for (let i = 0; i < 80; i++) {
    stepN(r.sim, HOLD, 1);
    velocities.push(r.sim.state.yVel);
  }
  return { velocities, flipped };
}

test("robot: without kA34 a pad keeps the held jump; with kA34 or in platformer it ends it", () => {
  // bumpPlayer ends the hold only when platformer || !+2408, and +2408 = !kA34.
  // [gd-ida-decomp.cpp:157053-157054, 430562-430563]
  const plain = robotIntoPad(PAD.yellow).velocities;
  near(plain[0], 16, "pad tick");
  near(plain[1], 16, "the hold cancels gravity on the next tick");
  let held = 0;
  while (held < plain.length && Math.abs(plain[held] - 16) <= EPS) held++;
  assert.ok(held >= 10 && held < 67, `the pad's speed held for ${held} ticks, the rest of the 67-tick window`);

  const fixed = robotIntoPad(PAD.yellow, makeHeader({ fixRobotJump: true })).velocities;
  near(fixed[1], 15.806, "kA34: gravity is back on the next tick");

  const platformer = robotIntoPad(PAD.yellow, makeHeader({ platformer: true })).velocities;
  near(platformer[1], 15.806, "platformer: gravity is back on the next tick");
});

test("robot: the blue pad never ends the held jump, even with kA34", () => {
  // gravBumpPlayer and propellPlayer never write +1932. [gd-ida-decomp.cpp:463221-463262, 147666-147712]
  const r = robotIntoPad(PAD.blue, makeHeader({ fixRobotJump: true }));
  assert.equal(r.flipped, true, "the upright blue pad turns the robot over");
  near(r.velocities[0], 6.4, "pad tick");
  near(r.velocities[1], 6.4, "the hold still cancels gravity on the next tick");
});

// --- the spider pad ------------------------------------------------------------------

test("the spider pad jumps the way it faces, flipY included", () => {
  // bumpPlayer: face the pad's way (isFacingDown, flipY included), then
  // spiderTestJump against that gravity. [gd-ida-decomp.cpp:157055-157064]
  // The spider's box is 27: it lands 13.5 off the floor's top (30) or the
  // band's ceiling (270). [toggleSpiderMode :152721-152723]
  const cases: Array<{ pad: Partial<Placed>; y: number; flipped: boolean }> = [
    { pad: { flipY: true }, y: 43.5, flipped: false },
    { pad: { rotation: 180 }, y: 43.5, flipped: false },
    { pad: {}, y: 256.5, flipped: true },
    { pad: { rotation: 180, flipY: true }, y: 256.5, flipped: true },
  ];
  for (const c of cases) {
    const r = run(emptyLevel([{ id: PAD.spider, x: 15, y: 265, ...c.pad }]), { y: 255, mode: "spider", flipped: true });
    r.sim.step(NO_INPUT);
    const tag = JSON.stringify(c.pad);
    assert.deepEqual(r.pads, [1], `${tag}: the pad fires on the first tick`);
    near(r.sim.state.y, c.y, `${tag}: y`);
    assert.equal(r.sim.state.flipped, c.flipped, `${tag}: gravity`);
    assert.equal(r.sim.state.lastFlipTick, 1, `${tag}: turned over on the pad tick`);
  }
});

// --- orbs in a level -----------------------------------------------------------------

/** A sim that records the tick of every orb it fires. */
function orbRun(level: Level, start: Partial<StartState>): { sim: Sim; orbs: number[] } {
  const orbs: number[] = [];
  const sim = makeSim(level, undefined, {
    start: { x: 15, y: 45, ...start },
    onEvent: (e) => {
      if (e.type === "orb") orbs.push(e.tick);
    },
  });
  return { sim, orbs };
}

test("a multi-activate orb fires again on every press, even without leaving it", () => {
  // pushButton empties the used-ring set on each press, and nothing marks a
  // multi-activate orb used. [gd-ida-decomp.cpp:160447-160453, 159898-159918, 165225-165240]
  for (const [label, header, props] of [
    ["platformer", makeHeader({ platformer: true }), {}],
    ["classic, key 99", makeHeader(), { 99: "1" }],
    ["platformer, key 444", makeHeader({ platformer: true }), { 444: "1" }],
  ] as const) {
    // A 432-unit orb the cube never leaves: three presses, the first on the
    // ground. That one takes the orb rather than jumping, because the passes
    // before it touched the orb. [pushButton, gd-ida-decomp.cpp:160455-160531]
    const r = orbRun(emptyLevel([{ id: ORB.yellow, x: 15, y: 150, scaleX: 12, scaleY: 12, props }], header), {});
    stepN(r.sim, NO_INPUT, 20);
    r.sim.step(HOLD);
    stepN(r.sim, NO_INPUT, 5);
    r.sim.step(HOLD);
    stepN(r.sim, NO_INPUT, 5);
    r.sim.step(HOLD);
    assert.deepEqual(r.orbs, label.endsWith("444") ? [21] : [21, 27, 33], label);
  }
});

test("a multi-activate orb does not fire again on the same press", () => {
  // The used-ring set is emptied by a press and by nothing else, so leaving
  // the orb and coming back on one held press does nothing. A toggle orb with
  // kA40 on leaves the press unspent, which is what lets the return count.
  // [gd-ida-decomp.cpp:160447-160453, 159943-159946]
  const JUMP_RIGHT = { jump: true, left: false, right: true };
  const JUMP_LEFT = { jump: true, left: true, right: false };
  // The orb reaches rows away from the section it is filed in, so it needs
  // extended collision (key 511) to be met from up there.
  // [checkCollisions :464880-464970]
  const level = emptyLevel(
    [{ id: ORB.toggle, x: 60, y: 600, scaleY: 30, props: { 511: "1" } }],
    makeHeader({ platformer: true, enable22Changes: true }),
  );
  // Falling from high up inside the orb's column, with the press made in the air.
  const r = orbRun(level, { y: 900 });
  r.sim.step(HOLD);
  for (let i = 0; i < 100 && r.orbs.length === 0; i++) r.sim.step(JUMP_RIGHT);
  assert.equal(r.orbs.length, 1, "the cube never reached the orb");
  for (let i = 0; i < 200 && r.sim.state.x > 10; i++) r.sim.step(JUMP_LEFT);
  assert.ok(r.sim.state.x <= 10, "the cube never left the orb");
  for (let i = 0; i < 200 && r.sim.state.x < 40; i++) r.sim.step(JUMP_RIGHT);
  assert.ok(r.sim.state.x >= 40 && !r.sim.state.onGround, "the cube should be back inside, still in the air");
  assert.equal(r.orbs.length, 1, "coming back on the same press does nothing");
  r.sim.step(NO_INPUT);
  r.sim.step(HOLD);
  assert.equal(r.orbs.length, 2, "a new press fires it again");
});

test("a toggle orb spends the press without kA40, and never in Dash or an official platformer level", () => {
  // It clears +1910 only while +2497 = !kA40 is set; the game forces kA40 on
  // for official levels that are platformers or Dash. [gd-ida-decomp.cpp:159943-159946,
  // 462937-462940, 462962-462964]
  const orb: Placed = { id: ORB.toggle, x: 15, y: 200, scaleX: 4, scaleY: 4 };
  const cases: Array<{ label: string; level: Level; spends: boolean }> = [
    { label: "a level without kA40", level: emptyLevel([orb]), spends: true },
    { label: "kA40", level: emptyLevel([orb], makeHeader({ enable22Changes: true })), spends: false },
    { label: "Dash", level: { ...emptyLevel([orb]), officialId: 22 }, spends: false },
    { label: "Stereo Madness", level: { ...emptyLevel([orb]), officialId: 1 }, spends: true },
    { label: "The Sewers", level: { ...emptyLevel([orb], makeHeader({ platformer: true })), officialId: 5002 }, spends: false },
    { label: "a platformer of anyone's", level: emptyLevel([orb], makeHeader({ platformer: true })), spends: true },
  ];
  for (const c of cases) {
    // Pressed in the air, so no ground jump takes the press first.
    const r = orbRun(c.level, { y: 200 });
    r.sim.step(HOLD);
    assert.deepEqual(r.orbs, [1], `${c.label}: the orb fires on the press`);
    assert.equal(p1(r.sim).stateRingJump, !c.spends, `${c.label}: the press`);
  }
});

test("the spider orb lets go of the button and leaves the press alone", () => {
  // spiderTestJumpInternal writes +1909 and nothing else of the kind; the
  // orb's own branch goes on without touching +1910. [gd-ida-decomp.cpp:155208-155216, 160079-160087]
  const r = orbRun(emptyLevel([{ id: ORB.spider, x: 15, y: 200, scaleX: 4, scaleY: 4, rotation: 180 }]), { y: 200, mode: "spider" });
  r.sim.step(HOLD);
  assert.deepEqual(r.orbs, [1], "the orb fires on the press");
  near(r.sim.state.y, 43.5, "down to the floor");
  assert.equal(r.sim.state.holding, false, "the button is let go");
  assert.equal(p1(r.sim).stateRingJump, true, "the press is not spent");
});

// --- rotated gameplay ----------------------------------------------------------------

test("a quarter turn of gameplay sets the accelerating flag and the boost, unless key 585 takes the flag back", () => {
  // rotateGameplay hands the velocity over through updatePlayerForce (+1858 = 1)
  // and sets +2060; with the trigger's +1665 (key 585, "Dont Slide") it then
  // runs handlePlayerCommand(543), which clears +1858 again.
  // [gd-ida-decomp.cpp:152492, 152531-152535, 147384, 142373-142379; key 585 → +1665 at :301464-301467]
  const turned = (extra: Record<number, string>, mode: GameMode, y: number): Sim => {
    const level = emptyLevel([{ id: 2900, x: 100, y: 45, props: { 166: "3", 167: "4", ...extra } }]);
    const sim = simOn(level, { y }, mode);
    for (let i = 0; i < 200 && !p1(sim).rotated; i++) sim.step(NO_INPUT);
    assert.equal(p1(sim).rotated, true, "the trigger never fired");
    return sim;
  };
  const plain = turned({}, "cube", 45);
  assert.equal(p1(plain).isAccelerating, true, "accelerating");
  assert.equal(p1(plain).maybeIsBoosted, true, "boosted");
  const dontSlide = turned({ 585: "1" }, "cube", 45);
  assert.equal(p1(dontSlide).isAccelerating, false, "key 585: not accelerating");
  assert.equal(p1(dontSlide).maybeIsBoosted, true, "key 585: still boosted");

  // A ship handed 12 (keys 169/584/583) stays past its cap of 8 without the
  // key and is held to it on the next tick with it.
  const handed = { 169: "1", 584: "1", 583: "12" };
  const slides = turned(handed, "ship", 200);
  near(slides.state.yVel, 12, "handed over");
  slides.step(NO_INPUT);
  near(slides.state.yVel, 11.897, "no key 585: past the cap");
  const held = turned({ ...handed, 585: "1" }, "ship", 200);
  near(held.state.yVel, 12, "handed over, key 585");
  held.step(NO_INPUT);
  near(held.state.yVel, 8, "key 585: held to the cap");
});

// --- dash orbs -----------------------------------------------------------------------

const DASH_ORB = 1704;
const ROTATE_TRIGGER = 1346;
const PLATFORMER = makeHeader({ platformer: true });
/** tan 70° as the float tanf gives, the slope past the clamp. */
const TAN70 = 2.7474772930145264;
/** 5.77 as a float: a platformer dash's speed per unit of key 586. */
const DASH_SPEED = Math.fround(5.77);

/** Presses on the step after one that stood the player on the orb: the dash starts at the press. */
function dashFrom(level: Level, start: Partial<StartState>, input = HOLD): Sim {
  const sim = simOn(level, start);
  sim.step(NO_INPUT);
  sim.step(input);
  assert.equal(sim.state.dashing, true, "the press starts the dash");
  return sim;
}

test("a classic dash runs along the orb's placed angle, negated and clamped raw to 70", () => {
  // v6 = −(+828). Past 70 and short of 180 it dashes at 70, from 180 on at
  // −70, and the mirror of that below −70; the slope is tanf of what is
  // left, 1 / tanf at exactly 45. The player is drawn at −v6.
  // [startDashing, gd-ida-decomp.cpp:148639-148690; updateDashArt :144971-144988]
  const cases: Array<[rotation: number, angle: number, slope: number]> = [
    [0, 0, 0],
    [-45, 45, 1],
    [45, -45, -1],
    [-30.5, 30.5, 0.5890450477600098],
    [100, -70, -TAN70],
    [-100, 70, TAN70],
    [200, 70, TAN70],
    [-200, -70, -TAN70],
    [450, 70, TAN70],
  ];
  for (const [rotation, angle, slope] of cases) {
    const sim = dashFrom(emptyLevel([{ id: DASH_ORB, x: 15, y: 150, rotation }]), { y: 150 });
    const p = p1(sim);
    near(p.dashAngle, angle, `${rotation}°: the angle kept`);
    assert.equal(p.dashVelY, slope, `${rotation}°: the slope`);
    near(p.rotation, -angle, `${rotation}°: drawn along it`);
    const { y } = sim.state;
    sim.step(HOLD);
    near(sim.state.y - y, slope * 1.29825, `${rotation}°: y per step`, 1e-4);
  }
});

test("a reversed classic dash climbs the way the orb points, not the mirror of it", () => {
  // The slope multiplies the forward step before the facing turns it round.
  // [update, gd-ida-decomp.cpp:161044, 161060, 161082-161083]
  const sim = dashFrom(emptyLevel([{ id: DASH_ORB, x: 300, y: 150, rotation: -45 }]), { x: 300, y: 150, reversed: true });
  const { x, y } = sim.state;
  sim.step(HOLD);
  assert.ok(sim.state.x < x, "still going backwards");
  near(sim.state.y - y, 1.29825, "and up", 1e-4);
});

test("in rotated gameplay a classic dash runs straight along the forward axis, whatever its angle", () => {
  // The slope is 0 whenever the player is rotated; the angle is kept as it
  // is, unclamped, drawn from 90 and turned half round outside 90..270.
  // [startDashing :148640-148643; updateDashArt :144971-144988]
  for (const [rotation, angle, drawn] of [
    [-45, 45, 225],
    [200, -200, 470],
  ] as const) {
    const level = buildLevel([
      ...floor(0, 3000),
      { id: 2900, x: 100, y: 45, props: { 166: "3", 167: "4" } },
      { id: DASH_ORB, x: 107, y: 100, rotation },
    ]);
    const sim = makeSim(level, undefined, { start: { x: 15, y: 45 } });
    for (let i = 0; i < 200 && p1(sim).touchingRings.length === 0; i++) sim.step(NO_INPUT);
    assert.equal(p1(sim).rotated, true, `${rotation}°: in rotated gameplay`);
    sim.step(HOLD);
    const p = p1(sim);
    assert.equal(p.dashing, true, `${rotation}°: dashing`);
    assert.deepEqual([p.dashVelY, p.dashAngle, p.rotation], [0, angle, drawn], `${rotation}°`);
    const { x, y } = sim.state;
    sim.step(HOLD);
    assert.equal(sim.state.x, x, `${rotation}°: nothing along the gravity axis`);
    near(sim.state.y - y, 1.29825, `${rotation}°: the forward step`, 1e-4);
  }
});

test("a gameplay turn mid-dash trades the dash's pair and turns its angle half round", () => {
  // A classic dash's slope trades with +1184, which only a platformer dash
  // writes, so it runs on straight. [rotateGameplay :152539-152549]
  const level = buildLevel([
    ...floor(0, 3000),
    { id: 2900, x: 100, y: 45, props: { 166: "3", 167: "4" } },
    { id: DASH_ORB, x: 90, y: 150, rotation: -45 },
  ]);
  const sim = dashFrom(level, { x: 90, y: 150 });
  for (let i = 0; i < 20 && !p1(sim).rotated; i++) sim.step(HOLD);
  const p = p1(sim);
  assert.equal(p.rotated, true);
  assert.deepEqual([p.dashing, p.dashVelX, p.dashVelY, p.dashAngle, p.rotation], [true, 1, 0, 225, 45]);
  const { x } = sim.state;
  sim.step(HOLD);
  assert.equal(sim.state.x, x, "straight on");
});

test("a platformer dash moves by the orb's own velocity pair, whatever the player was doing", () => {
  // ccpForAngle(v6) × speed × 5.77, v6 the orb's angle wrapped and negated.
  // Each step writes x into the x velocity and y raw over the rounded 0, and
  // moves both over v24; steering does nothing while it runs.
  // [startDashing :148598-148636; update :161050-161058; updateMove
  //  :149478-149481]
  const steer = { jump: true, left: true, right: false };
  for (const [rotation, vx, vy, x, y, angle, drawn] of [
    [0, DASH_SPEED, 0, 16.298250198364258, 45, 0, 0],
    // −45 wraps to 315, so v6 = −315, up and to the right.
    [-45, 4.080005168914795, 4.0800065994262695, 15.918001174926758, 45.917999267578125, -315, 315],
  ] as const) {
    const orb: Placed = { id: DASH_ORB, x: 15, y: 45, rotation, props: { 586: "1", 588: "1" } };
    const sim = dashFrom(emptyLevel([orb], PLATFORMER), {}, steer);
    const p = p1(sim);
    assert.deepEqual([p.dashVelX, p.dashVelY, p.dashAngle, p.rotation], [vx, vy, angle, drawn], `${rotation}°: the pair`);
    assert.deepEqual([p.xVel, p.yVel], [vx, vy], `${rotation}°: written over both velocities`);
    assert.deepEqual([sim.state.x, sim.state.y], [x, y], `${rotation}°: one step of it from a standstill`);
    assert.equal(p.reversed, false, `${rotation}°: facing the way it goes, not the way it is steered`);
    sim.step(steer);
    near(sim.state.x - x, Math.fround(vx * JUMP_DT), `${rotation}°: again`, 1e-5);
    near(sim.state.y - y, Math.fround(vy * JUMP_DT), `${rotation}°: again, y`, 1e-5);
  }
  // flipX turns it half round, and faces the player the way it goes; with no
  // speed key the dash holds the player where it is.
  const level = emptyLevel([{ id: DASH_ORB, x: 15, y: 45, props: { 586: "2", 588: "1" } }], PLATFORMER);
  level.objects[level.objects.length - 1].flipX = true;
  const back = dashFrom(level, {});
  assert.deepEqual([p1(back).dashVelX, p1(back).dashAngle, p1(back).reversed], [Math.fround(2 * DASH_SPEED) * -1, -180, true], "flipX");
  assert.ok(back.state.x < 15, "flipX: going left");
  const still = dashFrom(emptyLevel([{ id: DASH_ORB, x: 15, y: 45 }], PLATFORMER), {});
  assert.deepEqual([still.state.x, still.state.y, still.state.xVel], [15, 45, 0], "no key 586: speed 0");
});

test("a rotate trigger's turn steers a platformer dash, never a classic one", () => {
  // The platformer reads the angle as it is now (vfunc +780), the classic one
  // the angle it was placed at (+828). [:148601, 148639]
  for (const platformer of [false, true]) {
    const orb: Placed = { id: DASH_ORB, x: 15, y: platformer ? 45 : 150, props: { 586: "1", 588: "1" } };
    const level = emptyLevel([{ id: ROTATE_TRIGGER, x: 0, y: 300, props: { 51: "5", 68: "45", 10: "0" } }, orb], makeHeader({ platformer }));
    level.objects[level.objects.length - 1].groups = [5];
    const sim = simOn(level, { y: orb.y });
    stepN(sim, NO_INPUT, 3);
    sim.step(HOLD);
    const p = p1(sim);
    assert.equal(p.dashing, true, `platformer ${platformer}`);
    if (platformer) assert.deepEqual([p.dashAngle, p.dashVelY < 0], [-45, true], "platformer: turned down 45");
    else assert.equal(p.dashVelY, 0, "classic: flat, as placed");
  }
});

test("releasing a platformer dash hands its pair over, times the end boost", () => {
  // updatePlayerForce(end boost × the pair): floats, raw, the accelerating
  // flag set, which stop slide (key 589) takes back. A cube then spins,
  // forced, at 0.5 + 1.5 × speed / 17.31 times the rate, 2 from 17.31 up;
  // a ship does not spin. A classic dash hands nothing over.
  // [stopDashing, gd-ida-decomp.cpp:149800-149812, 149888-149898;
  //  updatePlayerForce :147375-147395; handlePlayerCommand :142373-142379;
  //  runNormalRotation :144512-144540]
  const dashing = (mode: GameMode, platformer: boolean, vx: number, vy: number, boost: number, stopSlide = false): Player => {
    const p = player(mode, { platformer });
    p.dashing = true;
    p.dashOrbIdx = 0;
    p.dashVelX = vx;
    p.dashVelY = vy;
    p.dashEndBoost = Math.fround(boost);
    p.dashStopSlide = stopSlide;
    p.stopDashing();
    return p;
  };
  const spin = (factor: number): number => Math.fround(Math.fround(180 * factor) / Math.fround(0.43333));
  const cube = dashing("cube", true, 4, 3, 1.5);
  assert.deepEqual([cube.dashing, cube.xVel, cube.yVel, cube.isAccelerating], [false, 6, 4.5, true], "the pair, times 1.5");
  assert.equal(cube.spinning, true, "spinning");
  near(cube.spinSpeed, spin(Math.fround(Math.fround(Math.fround(5 / 17.31) * 1.5) + 0.5)), "speed 5: 0.93 times the rate", 1e-4);
  near(dashing("cube", true, 20, 0, 1).spinSpeed, spin(2), "past 17.31: twice", 1e-4);
  assert.equal(dashing("cube", true, 4, 3, 1, true).isAccelerating, false, "stop slide");
  const ship = dashing("ship", true, 4, 3, 1);
  assert.deepEqual([ship.yVel, ship.spinning], [3, false], "a ship: the pair, no spin");
  const classic = dashing("cube", false, 4, 3, 1.5);
  assert.deepEqual([classic.xVel, classic.yVel, classic.isAccelerating, classic.spinning], [0, 0, false, false], "classic: nothing");

  // In a level: the release step starts from the dash's y, where a classic
  // one falls from 0 (input.test.ts, §16).
  const orb: Placed = { id: DASH_ORB, x: 15, y: 45, rotation: -45, props: { 586: "1", 588: "1" } };
  const sim = dashFrom(emptyLevel([orb], PLATFORMER), {});
  sim.step(HOLD);
  sim.step(NO_INPUT);
  assert.equal(sim.state.dashing, false);
  // 4.0800066 less a tick of gravity, 0.2155948, to three decimals.
  near(sim.state.yVel, 3.864, "carries its y");
  assert.equal(p1(sim).isAccelerating, true);
});

test("a platformer dash ends at a wall unless its orb allows collisions, and after its longest time", () => {
  // Either way it lets go of the button. [collidedWithObjectInternal
  //  :152324-152331; update :161296-161307; keys 587 and 590 :303028-303031,
  //  303037-303046]
  const wall = (props: Record<number, string>): Sim => {
    const orb: Placed = { id: DASH_ORB, x: 15, y: 45, props: { 586: "1", 588: "1", ...props } };
    const sim = dashFrom(emptyLevel([orb, { id: 1, x: 90, y: 45 }], PLATFORMER), {});
    stepN(sim, HOLD, 38);
    return sim;
  };
  const stopped = wall({});
  assert.deepEqual([stopped.state.x, stopped.state.dashing, stopped.state.holding], [60, false, false], "stopped by the wall");
  const through = wall({ 587: "1" });
  assert.deepEqual([through.state.x, through.state.dashing, through.state.holding], [60, true, true], "key 587: still dashing");

  // Key 590 at 0.1 s: over once 25 ticks have passed (24 is exactly 0.1).
  const orb: Placed = { id: DASH_ORB, x: 15, y: 45, props: { 586: "1", 588: "1", 590: "0.1" } };
  const timed = dashFrom(emptyLevel([orb], PLATFORMER), {});
  const started = timed.tick;
  for (let i = 0; i < 40 && timed.state.dashing; i++) timed.step(HOLD);
  assert.equal(timed.tick - started, 25);
  assert.equal(timed.state.holding, false);
});

test("a platformer dash survives a snapshot and shows in the state hash", () => {
  // The autoplayer rewinds with snapshots; a dash must come back whole, and
  // a dashing player must not hash like one that is not.
  const orb: Placed = { id: DASH_ORB, x: 15, y: 45, rotation: -45, props: { 586: "1", 588: "2", 589: "1", 590: "1" } };
  const sim = dashFrom(emptyLevel([orb], PLATFORMER), {});
  const snap = sim.snapshot();
  const h = sim.stateHash();
  const run = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      sim.step(i < 2 ? HOLD : NO_INPUT);
      out.push(sim.state.x, sim.state.y, sim.state.xVel, sim.state.yVel);
    }
    return out;
  };
  const first = run();
  sim.restore(snap);
  assert.equal(sim.stateHash(), h, "the same hash after the restore");
  assert.deepEqual(run(), first, "the same dash and the same hand-over");
  sim.restore(snap);
  p1(sim).dashing = false;
  assert.notEqual(sim.stateHash(), h, "dashing is part of the hash");
});
