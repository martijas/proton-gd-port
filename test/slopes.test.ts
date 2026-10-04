// Leaving a slope — PlayerObject::postCollision in the 2.206 decompile — and
// the two small slope writes that go with it: flipGravity turning the "going
// down it" flag over, and a pad leaving the slope's velocity alone. The
// derivation is in data/ref/gd-discrepancies.md §9.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMode } from "../src/level/types";
import { Player, type PlayerWorld } from "../src/physics/player";
import { xSpeedFor } from "../src/physics/constants";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { buildLevel, floor, makeHeader, simOn, type Placed } from "./levelKit";

const EPS = 1e-9;
/** 1x: playerSpeed × speedMultiplier, the x speed a slope's y speed is measured against (5.193). */
const X_SPEED_1X = xSpeedFor(1);

function near(actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

function world(over: Partial<PlayerWorld> = {}): PlayerWorld {
  return { emit: () => {}, spiderJump: () => {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true, ...over };
}

/**
 * A player on the pass it leaves a slope: `sv` is the slope's velocity, `ySpeed`
 * its y speed (+1832), `solidAbove` its +1859, `platformer` the level's. The
 * slope was ridden long ago, so the hand-over is the whole velocity.
 */
function leaving(
  mode: GameMode,
  over: Partial<Player> & { sv: number; ySpeed?: number; solidAbove?: boolean; platformer?: boolean },
): Player {
  const p = new Player(world({ platformer: over.platformer ?? false }), 1);
  p.setMode(mode);
  p.tick = 1000;
  p.clock = 1000;
  p.wasOnSlope = true;
  p.onSlope = false;
  p.slopeStartTick = 0;
  p.slopeIdx = 7;
  p.slopeRotation = 0.5;
  p.slopeVelocity = over.sv;
  p.currentSlopeYVel = over.ySpeed ?? 3;
  p.slopeSolidAbove = over.solidAbove ?? false;
  Object.assign(p, over);
  return p;
}

test("off the top of a floor slope: the slope's velocity is handed over", () => {
  // v15: sv > 0, yVel < sv, and the slope's floor-top byte clear.
  // [postCollision :158446-158478]
  const p = leaving("cube", { sv: 4, yVel: 1 });
  p.leaveSlope();
  near(p.yVel, 4, "yVel");
  assert.deepEqual([p.maybeIsBoosted, p.isAccelerating, p.onGround, p.onGround2], [true, true, false, false]);
});

test("a player still rising from a jump takes no hand-over, unless it is flying or a ball", () => {
  // (!+2060 || isFlying || ball) && v15. [:158460]
  for (const [mode, launched] of [
    ["cube", false],
    ["robot", false],
    ["ball", true],
    ["ship", true],
  ] as const) {
    const p = leaving(mode, { sv: 4, yVel: 1, maybeIsBoosted: true });
    p.leaveSlope();
    near(p.yVel, launched ? 4 : 1, `${mode}: yVel`);
  }
});

test("the hand-over follows the slope's solid side, not the player's gravity", () => {
  // Upside down on a floor slope pushing up: the game launches (v15 reads
  // +1859); gravity is only isBoostValid's business.
  // [:158446-158458; isBoostValid :142563-142579]
  const p = leaving("cube", { sv: 4, yVel: 1, flipped: true, slopeDescending: true });
  p.leaveSlope();
  near(p.yVel, 4, "flipped player off a floor slope");
  // And on a ceiling slope (+1859 set) only a slope velocity below the
  // player's own launches.
  const q = leaving("cube", { sv: 4, yVel: 1, solidAbove: true });
  q.leaveSlope();
  near(q.yVel, 1, "no launch off a ceiling slope pushing up");
});

test("off the low end of a slope: the player leaves at the slope's y speed", () => {
  // sv·flipMod < 0, not boosted, button up, press spent, +1859 == gravity:
  // yVel = −(+1832)·flipMod, both ground flags down, the spin starts.
  // [:158481-158503]
  const p = leaving("cube", { sv: -4, yVel: -0.2, ySpeed: X_SPEED_1X, onGround: true, onGround2: true });
  p.leaveSlope();
  near(p.yVel, -5.193, "yVel");
  assert.deepEqual([p.onGround, p.onGround2, p.spinning], [false, false, true]);
  const flipped = leaving("cube", { sv: 4, yVel: 0.2, ySpeed: X_SPEED_1X, flipped: true, solidAbove: true });
  flipped.leaveSlope();
  near(flipped.yVel, 5.193, "upside down, off a ceiling slope");
  // A ceiling slope needs a yVel at or below the slope's: above it, the
  // launch test (v15) would take the other branch and never reach the drop.
  for (const [what, over] of [
    ["holding", { holding: true }],
    ["an unspent press", { stateRingJump: true }],
    ["boosted", { maybeIsBoosted: true }],
    ["a ceiling slope", { solidAbove: true, yVel: -5 }],
  ] as const) {
    const q = leaving("cube", { sv: -4, yVel: -0.2, ...over });
    const yVel = q.yVel;
    q.leaveSlope();
    near(q.yVel, yVel, `${what}: yVel`);
  }
});

test("a platformer's hand-over is worked out from its run speed, and needs a direction held", () => {
  // |tan(angle) × xVel| × 1.1, signed like the slope's own, and only with left
  // or right held and |xVel| ≥ cos(angle) × 5 − 1. [postCollision :158466-158477]
  const angle = Math.atan(0.5);
  const off = (over: Partial<Player>): Player => {
    const p = leaving("cube", { sv: 4, yVel: 1, platformer: true, slopeAngle: angle, ...over });
    p.leaveSlope();
    return p;
  };
  // 2.75000006, as a float, then setYVelocity. [:147576]
  near(off({ xVel: 5, rightHeld: true }).yVel, 2.75, "running right");
  near(off({ xVel: -5, leftHeld: true }).yVel, 2.75, "running left, still up");
  near(off({ xVel: 5 }).yVel, 1, "no direction held: no hand-over");
  near(off({ xVel: 3, rightHeld: true }).yVel, 1, "too slow for the slope: no hand-over");
});

test("leaving a slope forgets it", () => {
  // +1832, +1956, +1824 and +1384 go to zero; +2304 takes the time. [:158446, 158523-158526]
  const p = leaving("cube", { sv: -4, yVel: -0.2, holding: true });
  p.leaveSlope();
  assert.deepEqual(
    [p.currentSlopeYVel, p.slopeVelocity, p.slopeRotation, p.slopeIdx, p.slopeEndTick],
    [0, 0, 0, -1, 1000],
  );
  // Still on it, or never on one: nothing happens.
  const on = leaving("cube", { sv: 4, yVel: 1, onSlope: true });
  on.leaveSlope();
  assert.deepEqual([on.yVel, on.slopeVelocity, on.slopeIdx], [1, 4, 7]);
});

test("running off the low end of a 2:1 slope into the air", () => {
  // Four 2:1 slopes down to the right, x 300..540, the last ending over air.
  const placed: Placed[] = [...floor(0, 3000)];
  const slopes: number[] = [];
  for (let k = 0; k < 4; k++) {
    slopes.push(placed.length);
    placed.push({ id: 291, x: 330 + 60 * k, y: 195 - 30 * k });
  }
  const level = buildLevel(placed);
  for (const i of slopes) level.objects[i].flipX = true;
  const sim: Sim = simOn(level, { x: 305, y: 240 });
  const p = sim.state as Player;
  let was = false;
  for (let t = 0; t < 400; t++) {
    sim.step(NO_INPUT);
    if (was && !p.onSlope) break;
    was = p.onSlope;
  }
  assert.equal(sim.tick, 208, "leaves the slope");
  // −2.5965008 to thousandths, then a rounded tick of gravity.
  near(p.yVel, -2.597, "at the slope's own y speed");
  assert.deepEqual([p.onGround, p.onGround2], [false, false]);
  sim.step(NO_INPUT);
  near(p.yVel, -2.813, "then under gravity", 1e-9);
});

test("upside down, a ceiling slope is ridden in one go: only its bottom edge lets go", () => {
  // Hexagon Force's mini ball at x 19840: a flat ceiling, then a 45° ceiling
  // slope going down. Flipped, the still-attached test is the bottom edge
  // alone; the top-edge test belongs to the upright branch, and applying it
  // too let go of the slope on the tick after it was met, restarting the ride
  // and cutting the launch off its far end. [collideSlope :157381-157391]
  // A ceiling along y 180 out to x 330, the slope under its last block from
  // (300, 180) down to (330, 150). The ball's corridor ceiling, at 240, is
  // out of the way.
  const placed: Placed[] = [...floor(0, 3000)];
  for (let x = 15; x < 330; x += 30) placed.push({ id: 1, x, y: 195 });
  placed.push({ id: 289, x: 315, y: 165, flipY: true });
  const sim: Sim = simOn(buildLevel(placed), { x: 200, y: 165, flipped: true }, "ball");
  const p = sim.state as Player;
  const riding: number[] = [];
  const starts = new Set<number>();
  let launch = 0;
  for (let t = 0; t < 200 && p.x < 400; t++) {
    sim.step(NO_INPUT);
    if (p.onSlope) {
      riding.push(sim.tick);
      starts.add(p.slopeStartTick);
    } else if (riding.length > 0 && launch === 0) launch = p.yVel;
  }
  assert.ok(riding.length > 20, `rode the slope for ${riding.length} ticks`);
  assert.equal(riding[riding.length - 1] - riding[0] + 1, riding.length, "no tick off it in the middle");
  assert.equal(starts.size, 1, "one ride, started once");
  // The old test let go three times, started the ride over each time and left at −4.17.
  assert.ok(launch < -5.5, `sent off the far end at the whole ride's ${launch}`);
});

test("a gravity flip on a slope turns the slope's direction over; off one it does not", () => {
  // [PlayerObject::flipGravity :151153-151154]
  const on = new Player(world(), 1);
  on.onSlope = true;
  on.slopeDescending = true;
  on.flipGravity(true);
  assert.equal(on.slopeDescending, false);
  const off = new Player(world(), 1);
  off.slopeDescending = true;
  off.flipGravity(true);
  assert.equal(off.slopeDescending, true);
});

test("a pad takes the player off its slope but leaves the slope's velocity", () => {
  // propellPlayer writes +1952/+1953 only. [:147684-147685]
  const p = new Player(world(), 1);
  p.onSlope = true;
  p.wasOnSlope = true;
  p.slopeVelocity = 3.5;
  p.propellPlayer(1);
  assert.deepEqual([p.onSlope, p.wasOnSlope, p.slopeVelocity], [false, false, 3.5]);
});

test("a platformer's jump off a slope takes the slope's bonus only when moving faster than 4, either way", () => {
  // The ground jump's bonus is gated on !platformer || |+2216| > 4; the
  // UFO's hop has no such gate. [updateJump :155815-155848; UFO :155707-155721]
  const header = makeHeader({ platformer: true });
  const placed: Placed[] = [...floor(0, 3000)];
  for (let k = 0; k < 6; k++) placed.push({ id: 289, x: 105 + 30 * k, y: 45 + 30 * k });
  const jump = (xVel: number): number => {
    const sim = simOn(buildLevel(placed, header), { x: 150, y: 110 });
    const p = sim.state as Player;
    for (let t = 0; t < 60; t++) sim.step(NO_INPUT);
    assert.deepEqual([p.onSlope, p.onGround, p.xVel], [true, true, 0], "standing on the slope");
    assert.ok(p.slopeVelocity > 0, "a slope going up pushes");
    p.xVel = xVel;
    sim.step({ jump: true, left: false, right: false });
    return p.yVel;
  };
  const ground = simOn(buildLevel(floor(0, 3000), header), { x: 30 });
  for (let t = 0; t < 30; t++) ground.step(NO_INPUT);
  ground.step({ jump: true, left: false, right: false });
  const plain = ground.state.yVel;
  near(plain, 10.964, "the plain jump, one tick on");
  assert.equal(jump(0), plain, "standing still");
  assert.equal(jump(4), plain, "at 4");
  assert.ok(jump(4.5) > plain + 1, "moving right at 4.5");
  assert.ok(jump(-4.5) > plain + 1, "moving left at 4.5");
});
