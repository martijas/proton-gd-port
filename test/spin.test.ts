// How fast the player turns, and what starts and stops it, pinned to the 2.206
// decompile. The angle matters to physics because the player's own box turns
// with it (rotatedbox.test.ts). The derivation is in
// data/ref/gd-discrepancies.md §11.
//
// The rates are floats: 180 / 0.43333f = 415.3878173828125, 180 / 0.33333f =
// 540.00537109375, −180 / 0.86667f = −207.69151306152344, −180 / 0.66667f =
// −269.9986267089844. One step turns by rate / 240. The ball's rolls share
// the rate: 120 / 0.2 = 600 on the ground (mini 750), −340 / 0.8 = −425 in
// the air (mini −531.25), both at speed 1.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMode } from "../src/level/types";
import { BALL_ROLL_SPEED_FACTOR, FRAME_DT, JUMP_DT, ROTATION_SLERP_BASE } from "../src/physics/constants";
import { DEG, slerp2D } from "../src/physics/geometry";
import { Player, type PlayerWorld } from "../src/physics/player";
import { NO_INPUT, type PlayerInput, type Sim } from "../src/physics/types";
import { makeSim } from "./helpers";
import { buildLevel, emptyLevel, floor, HOLD, makeHeader, settle, simOn } from "./levelKit";

const SPIN = 415.3878173828125;
const SPIN_MINI = 540.00537109375;
const BOOST_SPIN = -207.69151306152344;
const BOOST_SPIN_MINI = -269.9986267089844;
const ROLL = 600;
const ROLL_MINI = 750;
const AIR_ROLL = -425;
const AIR_ROLL_MINI = -531.25;
const CUBE_PORTAL = 12;
const BALL_PORTAL = 47;
const ROTATE_GAMEPLAY = 2900;
const LEFT: PlayerInput = { jump: false, left: true, right: false };
const RIGHT: PlayerInput = { jump: false, left: false, right: true };
const BOTH: PlayerInput = { jump: false, left: true, right: true };

function world(platformer = false): PlayerWorld {
  return { emit: () => {}, spiderJump: () => {}, platformer, dual: false, fixGravityBug: false, boostSlide: true };
}

function player(mode: GameMode = "cube", opts: { platformer?: boolean } = {}): Player {
  const p = new Player(world(opts.platformer), 1);
  p.setMode(mode);
  return p;
}

function near(actual: number, expected: number, what: string, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

function p1(sim: Sim): Player {
  return sim.state as Player;
}

test("runNormalRotation: half a turn in 0.43333 s, mini 0.33333, turned by direction, gravity and rotated gameplay", () => {
  // rate = reverseMod·180·flipMod·(rotated ? −1 : 1)·gravityMod·mult / (scale == 1 ? 0.43333 : 0.33333)
  // [gd-ida-decomp.cpp:144512-144540]
  for (const mini of [false, true]) {
    for (const flipped of [false, true]) {
      for (const reversed of [false, true]) {
        for (const rotated of [false, true]) {
          const p = player();
          Object.assign(p, { mini, flipped, reversed, rotated });
          p.runNormalRotation();
          const sign = (flipped ? -1 : 1) * (reversed ? -1 : 1) * (rotated ? -1 : 1);
          const tag = JSON.stringify({ mini, flipped, reversed, rotated });
          assert.deepEqual([p.spinning, p.spinSpeed], [true, sign * (mini ? SPIN_MINI : SPIN)], tag);
        }
      }
    }
  }
  const half = player();
  half.gravityMod = 0.5;
  half.runNormalRotation();
  assert.equal(half.spinSpeed, 207.69390869140625, "the gravity multiplier scales it");
});

test("runNormalRotation leaves flying, robot, spider and dashing players, and a platformer with no direction held", () => {
  // [gd-ida-decomp.cpp:144521-144531; +2224/+2225 are the held directions, :159449-159464]
  for (const mode of ["ship", "ufo", "wave", "swing", "robot", "spider"] as GameMode[]) {
    const p = player(mode);
    p.runNormalRotation();
    assert.equal(p.spinning, false, mode);
  }
  const dash = player();
  dash.dashing = true;
  dash.runNormalRotation();
  assert.equal(dash.spinning, false, "dashing");
  const plat = player("cube", { platformer: true });
  plat.runNormalRotation();
  assert.equal(plat.spinning, false, "platformer, nothing held");
  plat.leftHeld = true;
  plat.runNormalRotation();
  assert.deepEqual([plat.spinning, plat.spinSpeed], [true, SPIN], "platformer, left held");
});

test("runRotateAction stops what is running and starts afresh: the ball rolls, anything else spins", () => {
  // [gd-ida-decomp.cpp:144577-144590]
  const cube = player();
  cube.boostPlayer(3);
  cube.runRotateAction();
  assert.deepEqual([cube.spinning, cube.spinSpeed], [true, SPIN], "the backwards spin is replaced");
  const robot = player("robot");
  robot.spinning = true;
  robot.spinSpeed = SPIN;
  robot.runRotateAction();
  assert.deepEqual([robot.spinning, robot.spinSpeed], [false, 0], "a robot's spin stops and none starts");
  const ball = player("ball");
  ball.runBallRotation(0.5);
  ball.runRotateAction();
  assert.deepEqual([ball.spinning, ball.ballRotating, ball.rotateSpeed, ball.spinSpeed], [true, false, 1, ROLL], "the ball rolls at speed 1");
  ball.runBallRotation2();
  ball.runRotateAction();
  assert.deepEqual([ball.spinning, ball.ballAirRoll, ball.spinSpeed], [true, false, ROLL], "its air roll ends too");
  const dash = player();
  dash.spinning = true;
  dash.spinSpeed = 1;
  dash.dashing = true;
  dash.runRotateAction();
  assert.deepEqual([dash.spinning, dash.spinSpeed], [true, 1], "a dash is left alone");
});

test("a slope launch spins the cube backwards, by the gravity alone", () => {
  // boostPlayer: −180·flipMod / (scale == 1 ? 0.86667 : 0.66667); no reverseMod,
  // no rotated gameplay, no gravity multiplier, no platformer guard.
  // [gd-ida-decomp.cpp:147578-147599]
  for (const mini of [false, true]) {
    for (const flipped of [false, true]) {
      for (const reversed of [false, true]) {
        for (const rotated of [false, true]) {
          const p = player("cube", { platformer: rotated });
          Object.assign(p, { mini, flipped, reversed, rotated });
          p.gravityMod = 2;
          p.boostPlayer(5);
          const want = (flipped ? -1 : 1) * (mini ? BOOST_SPIN_MINI : BOOST_SPIN);
          assert.deepEqual([p.spinning, p.spinSpeed], [true, want], JSON.stringify({ mini, flipped, reversed, rotated }));
        }
      }
    }
  }
  for (const mode of ["ship", "ball", "robot", "spider", "swing"] as GameMode[]) {
    const p = player(mode);
    p.boostPlayer(5);
    assert.deepEqual([p.spinning, p.spinSpeed], [false, 0], mode);
  }
});

test("a jump turns the cube by rate / 240 a step until it lands", () => {
  // updateRotation adds dt / 60 · rate after the collision pass. [:144904-144912, :469949]
  for (const mini of [false, true]) {
    const sim = simOn(emptyLevel(), { mini });
    settle(sim);
    // The landing's settle may not have finished; the jump turns from there.
    const from = sim.state.rotation;
    sim.step(HOLD);
    const rate = mini ? SPIN_MINI : SPIN;
    assert.deepEqual([p1(sim).spinning, p1(sim).spinSpeed], [true, rate]);
    near(sim.state.rotation - from, rate / 240, `${mini ? "mini" : "full"}, first step`);
    for (let i = 0; i < 9; i++) sim.step(HOLD);
    near(sim.state.rotation - from, (10 * rate) / 240, `${mini ? "mini" : "full"}, ten steps`, 1e-9);
  }
});

test("in the air a cube that is not spinning keeps its angle; on the ground the spin ends and it settles", () => {
  // [updateRotation :144872-144890]
  const air = player();
  Object.assign(air, { rotation: 30, onGround2: false, yVel: 5 });
  air.updateRotation(FRAME_DT);
  assert.equal(air.rotation, 30, "in the air");
  const ground = player();
  Object.assign(ground, { rotation: 30, onGround2: true, yVel: 0 });
  ground.spinning = true;
  ground.spinSpeed = SPIN;
  ground.updateRotation(FRAME_DT);
  assert.equal(ground.spinning, false, "the spin ends");
  // The slerp's rate reads the float playerSpeed, 0.89999998.
  near(ground.rotation, 26.456250093877312, "and it settles towards 0", 1e-9);
  const plat = player("cube", { platformer: true });
  Object.assign(plat, { rotation: 30, onGround2: true, yVel: 0 });
  plat.spinning = true;
  plat.spinSpeed = SPIN;
  plat.updateRotation(FRAME_DT);
  assert.equal(plat.spinning, true, "a platformer's spin runs on");
  near(plat.rotation, 30 + SPIN / 240, "platformer");
});

test("the fall spin waits while a platformer player is still on the ground", () => {
  // [updateJump :156011-156020]
  for (const [platformer, onGround2, spins] of [
    [false, true, true],
    [true, false, true],
    [true, true, false],
  ] as const) {
    const p = player("cube", { platformer });
    p.rightHeld = true;
    Object.assign(p, { onGround: false, onGround2, yVel: -1 });
    p.updateJump(JUMP_DT);
    assert.equal(p.spinning, spins, JSON.stringify({ platformer, onGround2 }));
  }
});

test("leaving the ship, UFO, wave or swing for the cube starts the spin; no other change does", () => {
  // The flying toggles' resetPlayerIcon runs runRotateAction on the way out,
  // and the cube has no toggle of its own to stop it. [:148115, :152883,
  //  :152981, :153085, :152627; the spider's is stopped at :152775]
  const all: GameMode[] = ["cube", "ship", "ball", "ufo", "wave", "robot", "spider", "swing"];
  for (const from of all) {
    for (const to of all) {
      if (from === to) continue;
      const p = player(from);
      p.spinning = true;
      p.spinSpeed = 1;
      p.setMode(to);
      const spins = to === "cube" && ["ship", "ufo", "wave", "swing"].includes(from);
      assert.deepEqual([p.spinning, p.spinSpeed], spins ? [true, SPIN] : [false, 0], `${from} -> ${to}`);
    }
  }
});

test("a ship through a cube portal comes out spinning", () => {
  const sim = makeSim(emptyLevel([{ id: CUBE_PORTAL, x: 30, y: 200 }]), undefined, { start: { x: 15, y: 200, mode: "ship" } });
  for (let i = 0; i < 20 && sim.state.mode !== "cube"; i++) sim.step(NO_INPUT);
  assert.equal(sim.state.mode, "cube");
  assert.deepEqual([p1(sim).spinning, p1(sim).spinSpeed], [true, SPIN]);
  near(sim.state.rotation, SPIN / 240, "one step's turn from 0");
});

test("a twin leaving a flying mode spins at the size it had, the size coming after the mode", () => {
  // copyAttributes: flip, reverse, the mode toggles, the speed, then the size.
  // [gd-ida-decomp.cpp:153316-153328]
  const ship = player("ship");
  const cube = player("cube");
  cube.mini = true;
  ship.copyAttributes(cube);
  assert.deepEqual([ship.mode, ship.mini, ship.spinning, ship.spinSpeed], ["cube", true, true, SPIN]);
});

test("a quarter turn of gameplay spins a cube that is not spinning, the rotated way", () => {
  // [PlayerObject::rotateGameplay :152536-152538]
  const level = buildLevel([...floor(0, 3000), { id: ROTATE_GAMEPLAY, x: 100, y: 45, props: { 166: "3", 167: "4" } }], makeHeader());
  const sim = makeSim(level, undefined, { start: { x: 95, y: 150, mode: "cube" } });
  Object.assign(p1(sim), { yVel: 8, onGround: false, onGround2: false });
  for (let i = 0; i < 20 && !p1(sim).rotated; i++) {
    sim.step(NO_INPUT);
    if (!p1(sim).rotated) assert.equal(p1(sim).spinning, false, "rising, nothing spins it");
  }
  assert.equal(p1(sim).rotated, true);
  assert.deepEqual([p1(sim).spinning, p1(sim).spinSpeed], [true, -SPIN]);
});

test("a quarter turn of gameplay rolls a ball afresh, the rotated way", () => {
  // rotateGameplay sets +1971, then flips and runs doReversePlayer, which
  // rolls a ball whatever the direction does; the roll reads +1971.
  // [rotateGameplay :152481-152490; doReversePlayer :148342-148343;
  //  runBallRotation :143763-143765]
  for (const [orientation, want] of [
    ["3", -ROLL],
    ["4", ROLL],
  ] as const) {
    const level = buildLevel([...floor(0, 3000), { id: ROTATE_GAMEPLAY, x: 100, y: 45, props: { 166: orientation, 167: "4" } }], makeHeader());
    const sim = makeSim(level, undefined, { start: { x: 15, y: 45, mode: "ball" } });
    for (let i = 0; i < 200 && !p1(sim).rotated; i++) {
      sim.step(NO_INPUT);
      if (!p1(sim).rotated) assert.equal(p1(sim).spinSpeed, ROLL, `tick ${sim.tick}: on the floor`);
    }
    const p = p1(sim);
    assert.equal(p.rotated, true);
    assert.deepEqual([p.flipped, p.spinning, p.ballAirRoll, p.spinSpeed], [orientation === "4", true, false, want], `orientation ${orientation}`);
  }
});

test("a size change rolls a ball whose ground roll runs afresh, at speed 1 and the new size's rate", () => {
  // togglePlayerScale sends a ball with +1480 set through runRotateAction; a
  // twin taking the other's size comes this way too, after the mode. A flip
  // clears +1480, so the air roll it starts is left alone.
  // [gd-ida-decomp.cpp:150499-150502; copyAttributes :153326; flipGravity
  //  :151196-151199]
  const ball = player("ball");
  ball.runBallRotation(0.5);
  ball.setMini(true);
  assert.deepEqual([ball.rotateSpeed, ball.ballRotating, ball.spinSpeed], [1, false, ROLL_MINI], "mini");
  const twin = player("ball");
  const small = player("ball");
  small.setMini(true);
  twin.copyAttributes(small);
  assert.equal(twin.spinSpeed, ROLL_MINI, "a twin taking a mini ball's size");
  const air = player("ball");
  air.hitGround(-1, false);
  air.flipGravity(true);
  air.setMini(true);
  assert.deepEqual([air.spinning, air.ballAirRoll, air.spinSpeed], [false, true, -AIR_ROLL], "in the air after a flip");
});

test("a ball rolls from the first time it meets the ground, not from its portal", () => {
  // toggleRollMode ends in stopRotation; hitGround rolls a ball with no roll
  // running, and leaves one that has. [:153170; hitGround :150179-150180]
  const p = player();
  p.setMode("ball");
  assert.deepEqual([p.spinning, p.spinSpeed], [false, 0], "entering");
  p.hitGround(-1, false);
  assert.deepEqual([p.spinning, p.spinSpeed], [true, ROLL], "landing");
  p.rotation = 10;
  p.hitGround(-1, false);
  assert.deepEqual([p.spinSpeed, p.rotation], [ROLL, 10], "standing on");
  const sim = makeSim(emptyLevel([{ id: BALL_PORTAL, x: 30, y: 105 }]), undefined, { start: { x: 15, y: 105, mode: "cube" } });
  let landed = false;
  for (let i = 0; i < 200 && !landed; i++) {
    sim.step(NO_INPUT);
    if (sim.state.mode !== "ball") continue;
    landed = p1(sim).onGround2;
    if (!landed) assert.equal(p1(sim).spinSpeed, 0, `tick ${sim.tick}: falling, it does not roll`);
  }
  assert.equal(landed, true);
  assert.equal(p1(sim).spinSpeed, ROLL);
});

test("a ball's flip turns its roll into the air roll, by the new gravity, and the landing rolls it the new way", () => {
  // flipGravity: stopRotation, then runBallRotation2 — reverseMod·−340·flipMod
  // ·gravityMod / (0.8 at full size, 0.64 otherwise, × the speed factor),
  // with +1481 and not +1480. hitGround ends +1481 and, nothing rolling,
  // runs runRotateAction. [:151196-151199; :143785-143826; :150177-150180]
  for (const mini of [false, true]) {
    for (const reversed of [false, true]) {
      const tag = JSON.stringify({ mini, reversed });
      const p = player("ball");
      Object.assign(p, { mini, reversed });
      p.hitGround(-1, false);
      p.flipGravity(true);
      const sign = reversed ? -1 : 1;
      assert.deepEqual([p.spinning, p.ballAirRoll, p.spinSpeed], [false, true, -sign * (mini ? AIR_ROLL_MINI : AIR_ROLL)], tag);
      p.hitGround(-1, true);
      assert.deepEqual([p.spinning, p.ballAirRoll, p.spinSpeed], [true, false, -sign * (mini ? ROLL_MINI : ROLL)], `${tag}, landed`);
    }
  }
  const slow = player("ball");
  slow.setSpeed(0);
  slow.gravityMod = 0.5;
  slow.flipGravity(true);
  near(slow.spinSpeed, 170 / (0.8 * BALL_ROLL_SPEED_FACTOR[0]), "half gravity at 0.7x");
  // A ball on the floor under a ceiling: the click flips it, it turns on the
  // same way at 425°/s, and the ceiling rolls it back at 600°/s.
  const sim = makeSim(buildLevel([...floor(0, 3000), ...floor(0, 3000, 135)], makeHeader()), undefined, {
    start: { x: 15, y: 45, mode: "ball" },
  });
  settle(sim);
  assert.equal(p1(sim).spinSpeed, ROLL, "on the floor");
  sim.step(HOLD);
  assert.deepEqual([sim.state.flipped, p1(sim).spinSpeed], [true, -AIR_ROLL], "clicked");
  const from = sim.state.rotation;
  sim.step(NO_INPUT);
  near(sim.state.rotation - from, -AIR_ROLL / 240, "a step in the air");
  for (let i = 0; i < 200 && !p1(sim).onGround2; i++) sim.step(NO_INPUT);
  assert.deepEqual([sim.state.dead, sim.state.flipped, p1(sim).onGround2, p1(sim).spinSpeed], [false, true, true, -ROLL], "on the ceiling");
});

test("an orb gives a ball its air roll and leaves +1480 as it was", () => {
  // ringJump runs runBallRotation2 for the ball with no stop first, so a
  // ground roll still counts as running and a size change rolls it afresh.
  // [:160263-160266, :160374-160377; togglePlayerScale :150499-150502]
  for (const black of [false, true]) {
    const tag = black ? "black orb" : "yellow orb";
    const p = player("ball");
    p.hitGround(-1, false);
    if (black) p.dropRingLaunch();
    else p.ringLaunch("yellow");
    assert.deepEqual([p.spinning, p.ballAirRoll, p.spinSpeed], [true, true, AIR_ROLL], tag);
    p.setMini(true);
    assert.deepEqual([p.spinning, p.ballAirRoll, p.spinSpeed], [true, false, ROLL_MINI], `${tag}, then a size change`);
  }
});

test("a landing ends a ball's slope-speed roll once off the slope; on it the roll turns that much faster", () => {
  // hitGround stops a ball with +1376 set when +1952 is not, then rolls it;
  // updateRotation scales the rate by +1476 while +1376 is set.
  // [hitGround :150175-150176, :150179-150180; updateRotation :144903-144912]
  const on = player("ball");
  on.runBallRotation(1.5);
  on.onSlope = true;
  on.hitGround(-1, false);
  assert.deepEqual([on.ballRotating, on.rotateSpeed, on.spinSpeed], [true, 1.5, ROLL], "on the slope");
  on.updateRotation(FRAME_DT);
  near(on.rotation, (ROLL * 1.5) / 240, "a step at 1.5×");
  const off = player("ball");
  off.runBallRotation(1.5);
  off.hitGround(-1, false);
  assert.deepEqual([off.spinning, off.ballRotating, off.rotateSpeed, off.spinSpeed], [true, false, 1, ROLL], "off it");
  off.updateRotation(FRAME_DT);
  near(off.rotation, ROLL / 240, "a step at 1×");
});

test("a reverse rolls a ball afresh the other way, and leaves a cube's spin alone", () => {
  // doReversePlayer runs runRotateAction for a ball, whether or not the
  // direction changed. [:148342-148343]
  const ball = player("ball");
  ball.hitGround(-1, false);
  ball.doReversePlayer(true);
  assert.deepEqual([ball.reversed, ball.spinSpeed], [true, -ROLL]);
  const air = player("ball");
  air.flipGravity(true);
  air.doReversePlayer(false);
  assert.deepEqual([air.spinning, air.ballAirRoll, air.spinSpeed], [true, false, -ROLL], "an air roll, the direction unchanged");
  const cube = player();
  cube.runRotateAction();
  cube.doReversePlayer(true);
  assert.deepEqual([cube.reversed, cube.spinSpeed], [true, SPIN]);
});

test("a speed change rolls a ball the ground's way, in the air too; so does the end of a dash", () => {
  // updateTimeMod runs runRotateAction for any ball; stopDashing runs
  // runBallRotation(1), the start having stopped it. [:150569-150570;
  //  startDashing :148585, stopDashing :149901-149902]
  const p = player("ball");
  p.flipGravity(true);
  p.setSpeed(2);
  assert.deepEqual([p.spinning, p.ballAirRoll], [true, false]);
  near(p.spinSpeed, -120 / (0.2 * BALL_ROLL_SPEED_FACTOR[2]), "flipped, at 2x");
  const dash = player("ball");
  dash.hitGround(-1, false);
  dash.dashing = true;
  dash.stopRotation();
  dash.stopDashing();
  assert.deepEqual([dash.spinning, dash.spinSpeed], [true, ROLL]);
});

// --- the platformer's facing (updateMove) ------------------------------------------

function platformerSim(): Sim {
  const level = buildLevel(floor(-600, 3000), makeHeader({ platformer: true }));
  const sim = makeSim(level, undefined, { start: { x: 300, y: 45, mode: "cube" } });
  for (let i = 0; i < 20; i++) sim.step(NO_INPUT);
  return sim;
}

test("steering left faces a platformer player left, so its jump spins backwards; steering right faces it back", () => {
  // updateMove reverses the player the way it steers, through doReversePlayer,
  // and runNormalRotation's reverseMod turns the spin. [:149483-149499; :144538]
  const sim = platformerSim();
  for (let i = 0; i < 20; i++) sim.step(LEFT);
  assert.equal(sim.state.reversed, true);
  sim.step({ jump: true, left: true, right: false });
  assert.deepEqual([p1(sim).spinning, p1(sim).spinSpeed], [true, -SPIN]);
  sim.step(RIGHT);
  assert.equal(sim.state.reversed, false);
  assert.deepEqual([p1(sim).spinning, p1(sim).spinSpeed], [true, -SPIN], "a turn in the air leaves the spin running");
});

test("a platformer cube that jumps standing still spins once it steers", () => {
  // runNormalRotation refuses a platformer with nothing held; updateMove
  // starts the spin for a cube that moves, is not spinning, has a direction
  // held and goes faster than 1 up or down. [:144519-144528; :149536, :149558]
  const sim = platformerSim();
  sim.step(HOLD);
  for (let i = 0; i < 4; i++) {
    assert.equal(p1(sim).spinning, false, "no direction held");
    sim.step(NO_INPUT);
  }
  sim.step(RIGHT);
  assert.deepEqual([p1(sim).spinning, p1(sim).spinSpeed], [true, SPIN]);
});

test("with nothing held, a platformer cube in the air that is not spinning settles towards a right angle", () => {
  // [updateMove :149538-149551, updateRotation(dt·0.9, convertToClosestRotation(0))]
  const p = player("cube", { platformer: true });
  Object.assign(p, { rotation: 30, onGround: false, onGround2: false, yVel: 5 });
  p.update(FRAME_DT);
  near(p.rotation, slerp2D(30 * DEG, 0, Math.min(JUMP_DT, JUMP_DT * p.playerSpeed * ROTATION_SLERP_BASE)) / DEG, "settling");
  const spinning = player("cube", { platformer: true });
  Object.assign(spinning, { rotation: 30, onGround: false, onGround2: false, yVel: 5, spinning: true, spinSpeed: SPIN });
  spinning.update(FRAME_DT);
  assert.equal(spinning.rotation, 30, "a spin running holds it");
});

test("turning round turns a cube that is not spinning half round off the right angles, and a ship's angle over", () => {
  // [updateMove :149502-149528]
  for (const [mode, from, spinning, want] of [
    ["cube", 90, false, 270],
    ["cube", 30, false, 30],
    ["cube", 90, true, 90],
    ["ship", 20, false, -20],
    ["wave", 20, false, 20],
  ] as const) {
    const p = player(mode, { platformer: true });
    Object.assign(p, { rotation: from, onGround: true, onGround2: true, leftHeld: true, spinning });
    p.update(FRAME_DT);
    assert.deepEqual([p.reversed, p.rotation], [true, want], JSON.stringify({ mode, from, spinning }));
  }
});

test("with both directions held, the one pressed last steers and faces", () => {
  // switchedDirTo records which was pressed last (+2226); updateMove lets it
  // win while both are down. [:159446-159466; :149048-149084]
  for (const [first, last] of [
    [RIGHT, "left"],
    [LEFT, "right"],
  ] as const) {
    const sim = platformerSim();
    for (let i = 0; i < 10; i++) sim.step(first);
    for (let i = 0; i < 20; i++) sim.step(BOTH);
    const left = last === "left";
    assert.deepEqual(
      [p1(sim).leftPressedLast, sim.state.reversed, Math.sign(sim.state.xVel)],
      [left, left, left ? -1 : 1],
      `${last} pressed last`,
    );
  }
});

test("a running spin, its direction, the air roll and the last direction pressed are part of the state hash", () => {
  const sim = simOn(emptyLevel());
  const snap = sim.snapshot();
  const h0 = sim.stateHash();
  p1(sim).spinning = true;
  p1(sim).spinSpeed = SPIN;
  const h1 = sim.stateHash();
  p1(sim).spinSpeed = -SPIN;
  const h2 = sim.stateHash();
  p1(sim).ballAirRoll = true;
  const h3 = sim.stateHash();
  p1(sim).leftPressedLast = true;
  const h4 = sim.stateHash();
  assert.equal(new Set([h0, h1, h2, h3, h4]).size, 5);
  sim.restore(snap);
  assert.equal(sim.stateHash(), h0);
});
