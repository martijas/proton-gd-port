// The old falling test the levels without kA32 keep, and what reads it, pinned
// to the 2.206 decompile rather than to measurements of this port. Levels 1–21
// and The Challenge have no kA32; Dash and the later Tower floors do. The
// derivation is in data/ref/gd-discrepancies.md §3.
//
// Constants at 1x: gravity 0.958199024, so 2g = 1.916398048; cube and flying
// gravity per tick 0.958199024 × 0.225 = 0.2155948, which setYVelocity makes
// 0.216 from a velocity on thousandths; x per tick 1.29825042525.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMode } from "../src/level/types";
import { JUMP_DT } from "../src/physics/constants";
import { Player, type PlayerWorld } from "../src/physics/player";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { makeSim } from "./helpers";
import { buildLevel, floor, HOLD, makeHeader } from "./levelKit";

const EPS = 1e-9;
const CUBE_TICK_GRAVITY = 0.216;

function near(actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

function world(over: Partial<PlayerWorld> = {}): PlayerWorld {
  return { emit: () => {}, spiderJump: () => {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true, ...over };
}

function p1(sim: Sim): Player {
  return sim.state as Player;
}

test("the falling test: symmetric with kA32, the old one upside down and in a dual without", () => {
  // [playerIsFallingBugged :144334-144360; playerIsFalling :144307-144319]
  const cases: Array<{ label: string; w?: Partial<PlayerWorld>; flipped: boolean; yVel: number; swing?: boolean; rotated?: boolean; falling: boolean }> = [
    { label: "normal, rising at 1.9", flipped: false, yVel: 1.9, falling: true },
    { label: "normal, rising at 1.92", flipped: false, yVel: 1.92, falling: false },
    { label: "upside down, old, rising at 1.9", flipped: true, yVel: -1.9, falling: false },
    { label: "upside down, old, falling at 1.9", flipped: true, yVel: 1.9, falling: false },
    { label: "upside down, old, falling at 1.92", flipped: true, yVel: 1.92, falling: true },
    { label: "upside down, kA32, rising at 1.9", w: { fixGravityBug: true }, flipped: true, yVel: -1.9, falling: true },
    { label: "upside down, kA32, rising at 1.92", w: { fixGravityBug: true }, flipped: true, yVel: -1.92, falling: false },
    { label: "dual, old, falling at 1.9", w: { dual: true }, flipped: false, yVel: -1.9, falling: false },
    { label: "dual, old, falling at 1.92", w: { dual: true }, flipped: false, yVel: -1.92, falling: true },
    { label: "dual, old, upside down, falling at 1.92", w: { dual: true }, flipped: true, yVel: 1.92, falling: true },
    { label: "dual, kA32, falling at 1.9", w: { dual: true, fixGravityBug: true }, flipped: false, yVel: -1.9, falling: true },
    { label: "upside down, platformer", w: { platformer: true }, flipped: true, yVel: 1.9, falling: true },
    { label: "upside down, rotated gameplay", flipped: true, yVel: 1.9, rotated: true, falling: true },
    { label: "upside down, swing", flipped: true, yVel: 1.9, swing: true, falling: true },
  ];
  for (const c of cases) {
    const p = new Player(world(c.w), 1);
    if (c.swing) p.setMode("swing");
    p.rotated = c.rotated ?? false;
    p.flipped = c.flipped;
    p.yVel = c.yVel;
    assert.equal(p.fallingBugged(), c.falling, c.label);
  }
});

test("flipped ship and UFO in the ±2g band: 0.4 and 1.2 without kA32, 0.5 and 0.8 with", () => {
  // [updateJump :155520-155531 (ship), :155674 (UFO)]
  const run = (mode: GameMode, w: Partial<PlayerWorld>, flipped: boolean, held: boolean): number => {
    const p = new Player(world(w), 1);
    p.setMode(mode);
    p.flipped = flipped;
    p.yVel = 0;
    p.holding = held;
    p.updateJump(JUMP_DT);
    return p.yVel;
  };
  // A tick of flying gravity, 0.2155948, times the factors, to thousandths.
  near(run("ship", {}, true, true), -0.086, "old, held");
  near(run("ship", {}, true, false), 0.103, "old, released");
  near(run("ship", { fixGravityBug: true }, true, true), -0.108, "kA32, held");
  near(run("ship", { fixGravityBug: true }, true, false), 0.069, "kA32, released");
  near(run("ufo", {}, true, false), 0.129, "old UFO");
  near(run("ufo", { fixGravityBug: true }, true, false), 0.086, "kA32 UFO");
  // In a dual the normal-gravity ship has the same band.
  near(run("ship", { dual: true }, false, true), 0.086, "dual, held");
  near(run("ship", { dual: true }, false, false), -0.103, "dual, released");
  near(run("ship", {}, false, true), 0.108, "solo, held");
});

/**
 * An upside-down player walks off the end of a ceiling slab (blocks at y 105
 * over x 0..300, so its underside is at 90). Returns the last tick it touched
 * the slab and the first tick its jump latch was down.
 */
function ceilingLedge(mode: GameMode, kA32: boolean, dual = false): { contact: number; off: number } {
  const level = buildLevel(floor(0, 300, 105), makeHeader({ fixGravityBug: kA32, startDual: dual }));
  const sim = makeSim(level, undefined, { start: { x: 15, y: dual ? 135 : 75, mode, flipped: !dual } });
  const p = p1(sim);
  let contact = -1;
  let off = -1;
  for (let t = 1; t <= 300 && off < 0; t++) {
    sim.step(NO_INPUT);
    if (p.lastLandTick === sim.tick) contact = sim.tick;
    if (contact > 0 && sim.tick > contact && !p.onGround) off = sim.tick;
  }
  return { contact, off };
}

test("walking off a ceiling ledge keeps the latch 9, 10 or 15 ticks longer without kA32", () => {
  // Cube 9, robot 10, ball and spider 15. The spider's box is 27, so its last
  // contact is two ticks sooner. [updateJump :155949-155953, :155983-155987;
  // toggleSpiderMode :152721-152723]
  const expected: Record<string, number> = { cube: 241, robot: 242, ball: 247, spider: 245 };
  for (const mode of ["cube", "robot", "ball", "spider"] as const) {
    const contact = mode === "spider" ? 229 : 231;
    assert.deepEqual(ceilingLedge(mode, false), { contact, off: expected[mode] }, `${mode}, old`);
    assert.deepEqual(ceilingLedge(mode, true), { contact, off: contact + 1 }, `${mode}, kA32`);
  }
  // The normal-gravity twin in a dual walks off an ordinary ledge the same way.
  assert.deepEqual(ceilingLedge("cube", false, true), { contact: 231, off: 241 }, "dual twin, old");
  assert.deepEqual(ceilingLedge("cube", true, true), { contact: 231, off: 232 }, "dual twin, kA32");
});

test("a press inside that window still jumps", () => {
  const pressAt = (mode: GameMode, kA32: boolean, tick: number): { jumped: boolean; yVel: number } => {
    const level = buildLevel(floor(0, 300, 105), makeHeader({ fixGravityBug: kA32 }));
    const sim = makeSim(level, undefined, { start: { x: 15, y: 75, mode, flipped: true } });
    while (sim.tick < tick - 1) sim.step(NO_INPUT);
    sim.step(HOLD);
    const jumped = sim.events.some((e) => e.tick === tick && e.player === 1 && e.type === "jump");
    return { jumped, yVel: p1(sim).yVel };
  };
  const cube = pressAt("cube", false, 241);
  assert.equal(cube.jumped, true, "cube, old, tick 241");
  near(cube.yVel, -10.964, "cube jump");
  assert.equal(pressAt("cube", false, 242).jumped, false, "cube, old, tick 242");
  assert.equal(pressAt("robot", false, 242).jumped, true, "robot, old, tick 242");
  assert.equal(pressAt("robot", false, 243).jumped, false, "robot, old, tick 243");
  assert.equal(pressAt("ball", false, 247).jumped, true, "ball, old, tick 247");
  assert.equal(pressAt("ball", false, 248).jumped, false, "ball, old, tick 248");
  assert.equal(pressAt("spider", false, 245).jumped, true, "spider, old, tick 245");
  assert.equal(pressAt("spider", false, 246).jumped, false, "spider, old, tick 246");
  assert.equal(pressAt("cube", true, 232).jumped, true, "cube, kA32, tick 232");
  assert.equal(pressAt("cube", true, 233).jumped, false, "cube, kA32, tick 233");
});

test("a landing keeps the boost; the next update ends it unless the old test says the player is not falling", () => {
  // hitGround writes no +2060 [149979-150200]; the boosted branch ends it [155949-155953].
  const land = (w: Partial<PlayerWorld>, flipped: boolean): { landed: boolean; next: boolean; yVel: number } => {
    const p = new Player(world(w), 1);
    p.setMode("cube");
    p.flipped = flipped;
    p.yVel = flipped ? 3 : -3;
    p.maybeIsBoosted = true;
    p.hitGround(-1, false);
    const landed = p.maybeIsBoosted;
    p.updateJump(JUMP_DT);
    return { landed, next: p.maybeIsBoosted, yVel: p.yVel };
  };
  const normal = land({}, false);
  assert.deepEqual([normal.landed, normal.next], [true, false], "normal gravity");
  near(normal.yVel, -CUBE_TICK_GRAVITY, "normal gravity: one tick of gravity");
  const old = land({}, true);
  assert.deepEqual([old.landed, old.next], [true, true], "upside down, old");
  near(old.yVel, CUBE_TICK_GRAVITY, "upside down, old");
  const fixed = land({ fixGravityBug: true }, true);
  assert.deepEqual([fixed.landed, fixed.next], [true, false], "upside down, kA32");
});

test("an upside-down robot still holding floats for what is left of its hold without kA32", () => {
  // Boosted branch, hold cancels gravity until +1680 reaches 1.5 [155914-155928]
  const hover = (kA32: boolean): { ticks: number; yVel: number; hold: number } => {
    const p = new Player(world({ fixGravityBug: kA32 }), 1);
    p.setMode("robot");
    p.flipped = true;
    p.yVel = 0;
    p.holding = true;
    p.robotHold = 0;
    p.maybeIsBoosted = true;
    let ticks = 0;
    for (let t = 0; t < 100; t++) {
      p.updateJump(JUMP_DT);
      if (p.yVel !== 0) break;
      ticks++;
    }
    return { ticks, yVel: p.yVel, hold: p.robotHold };
  };
  const old = hover(false);
  assert.equal(old.ticks, 67, "old: 67 ticks at 0");
  // 67 × (float)(0.225 × 0.1). [:155926]
  near(old.hold, 1.507499935105443, "old: the hold is spent");
  near(old.yVel, 0.194, "old: then it falls");
  const fixed = hover(true);
  assert.equal(fixed.ticks, 1, "kA32: one tick, then the boost is gone");
  near(fixed.yVel, 0.194, "kA32");
});
