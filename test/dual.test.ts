// Dual mode: linked gravity, the forced gravity on a shared mode, how player 2
// is spawned and when it first moves, and player 1 taking player 2's place at
// the solo portal — pinned to the 2.206 decompile rather than to measurements
// of this port. The derivation is in data/ref/gd-discrepancies.md §4 and §14.
//
// The levels here run on the plain ground from x 15 with a dual portal at
// (150, 45): the dual starts on tick 77 with a 0..270 band, player 1 on the
// ground at y 15 and player 2 on the band ceiling at y 255. Cube gravity per
// tick 0.216 once rounded; x per tick 1.29825042525 before the float position
// rounds it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Player } from "../src/physics/player";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { makeSim } from "./helpers";
import { buildLevel, floor, HOLD, makeHeader, type Placed, stepN } from "./levelKit";
import type { LevelHeader } from "../src/level/types";

const EPS = 1e-9;
const CUBE_TICK_GRAVITY = 0.216;

/** Object ids. */
const DUAL_PORTAL = 286;
const SOLO_PORTAL = 287;
const SHIP_PORTAL = 13;
const CUBE_PORTAL = 12;
const WAVE_PORTAL = 660;
const GRAVITY_TOGGLE = 2926;
const OPTIONS = 2899;
const RED_PAD = 1332;
const BLUE_PAD = 67;
const SPIDER_PAD = 3005;
const BLUE_ORB = 84;

function near(actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

function p1(sim: Sim): Player {
  return sim.state as Player;
}

function p2(sim: Sim): Player {
  const p = sim.state2;
  assert.ok(p, "no player 2");
  return p as Player;
}

/** Players whose gravity turned over on this tick, in event order. */
function flipsAt(sim: Sim, tick: number): number[] {
  return sim.events.filter((e) => e.tick === tick && e.type === "flip").map((e) => e.player);
}

/** The plain ground, a dual portal at (150, 45), and whatever else. */
function dualLevel(extra: Placed[] = [], header: Partial<LevelHeader> = {}): Sim {
  const level = buildLevel([{ id: 1, x: 2985, y: 15 }, { id: DUAL_PORTAL, x: 150, y: 45 }, ...extra], makeHeader(header));
  return makeSim(level, undefined, { start: { x: 15, y: 15, mode: "cube" } });
}

/** Steps into the dual, then on until player 2 is gone; returns that tick. */
function runToSolo(sim: Sim): number {
  runUntil(sim, (s) => s.state2 !== null);
  return runUntil(sim, (s) => s.state2 === null);
}

/** Steps with no input until `until` holds, and returns that tick. */
function runUntil(sim: Sim, until: (sim: Sim) => boolean, max = 600): number {
  for (let i = 0; i < max; i++) {
    sim.step(NO_INPUT);
    if (until(sim)) return sim.tick;
    if (sim.state.dead) break;
  }
  assert.fail("never happened");
}

const gravityToggleAt = (sim: Sim): boolean => sim.events.some((e) => e.tick === sim.tick && e.type === "portal" && e.detail === "gravityToggle");

test("player 2 spawns upside down, off the ground, and first moves on the next step", () => {
  // [spawnFromPlayer :153349-153373; GJBaseGameLayer::update :469860, :469926]
  const sim = dualLevel();
  const spawn = runUntil(sim, (s) => s.state2 !== null);
  assert.equal(spawn, 77);
  const a = p1(sim);
  const b = p2(sim);
  assert.equal(b.x, a.x, "no lead: player 2 has not moved");
  assert.deepEqual([b.y, b.flipped, b.onGround, b.onGround2, b.lastFlipTick], [15, true, false, false, 77]);
  near(b.yVel, 0, "−0, player 1's 0 negated");
  assert.deepEqual(flipsAt(sim, 77), [2]);
  sim.step(NO_INPUT);
  assert.equal(p2(sim).x, p1(sim).x, "level with player 1 from then on");
  near(p2(sim).x, 116.26348114013672, "x on tick 78");
  near(p2(sim).yVel, CUBE_TICK_GRAVITY, "one tick of upside-down gravity");
});

test("player 2 does not inherit the latch, the boost or the accelerating flag", () => {
  // copyAttributes copies none of +1969, +2060, +1858 [153299-153330]
  const sim = dualLevel([{ id: RED_PAD, x: 60, y: 3 }, { id: DUAL_PORTAL, x: 150, y: 45, scaleY: 4 }]);
  runUntil(sim, (s) => s.state2 !== null);
  assert.equal(sim.tick, 77);
  assert.deepEqual([p1(sim).isAccelerating, p1(sim).maybeIsBoosted], [true, true], "player 1, off the red pad");
  assert.deepEqual([p2(sim).isAccelerating, p2(sim).maybeIsBoosted, p2(sim).onGround, p2(sim).onGround2], [false, false, false, false]);
  near(p2(sim).yVel, -p1(sim).yVel, "the opposite velocity");
});

test("an Options trigger with key 160 spawns player 2 on player 1's gravity", () => {
  // spawnPlayer2 passes !layer+1512 [420883-420895]
  const sim = dualLevel([{ id: OPTIONS, x: 100, y: 45, props: { 160: "1" } }]);
  runUntil(sim, (s) => s.state2 !== null);
  assert.deepEqual([p2(sim).flipped, p2(sim).lastFlipTick], [false, -1e9]);
});

test("linked dual gravity: a gravity portal turns both cubes over", () => {
  // [GJBaseGameLayer::flipGravity :420149-420178]
  const sim = dualLevel([{ id: GRAVITY_TOGGLE, x: 450, y: 30 }]);
  const t = runUntil(sim, gravityToggleAt);
  assert.equal(t, 315);
  assert.deepEqual(flipsAt(sim, t), [1, 2]);
  assert.deepEqual([p1(sim).flipped, p2(sim).flipped, p2(sim).lastFlipTick], [true, false, 315]);
  // 255 − 0.216 × 0.225, as a float at 345 in the game's space.
  near(p2(sim).y, 254.95138549804688, "player 2 already falling from the ceiling");
  // The flip drops the latch and leaves +2044.
  assert.deepEqual([p1(sim).onGround, p1(sim).onGround2], [false, true]);
});

test("unlinked by an Options trigger, and linked again by one with -1", () => {
  const unlinked = dualLevel([{ id: OPTIONS, x: 300, y: 45, props: { 160: "1" } }, { id: GRAVITY_TOGGLE, x: 450, y: 30 }]);
  const t = runUntil(unlinked, gravityToggleAt);
  assert.deepEqual(flipsAt(unlinked, t), [1]);
  assert.equal(p2(unlinked).flipped, true);
  const relinked = dualLevel([
    { id: OPTIONS, x: 250, y: 45, props: { 160: "1" } },
    { id: OPTIONS, x: 300, y: 45, props: { 160: "-1" } },
    { id: GRAVITY_TOGGLE, x: 450, y: 30 },
  ]);
  assert.deepEqual(flipsAt(relinked, runUntil(relinked, gravityToggleAt)), [1, 2]);
});

test("a two-player level never links", () => {
  // LevelSettings +280 [420162]
  const sim = dualLevel([{ id: GRAVITY_TOGGLE, x: 450, y: 30 }], { twoPlayer: true });
  assert.deepEqual(flipsAt(sim, runUntil(sim, gravityToggleAt)), [1]);
});

test("in a two-player level, player 2's button held into the dual is not a press", () => {
  // Outside a dual the game sends player 2's events nowhere, and the dual
  // portal only releases its button: it takes a new press after that.
  // [handleButton :463900-463960; toggleDualMode :462653-462655]
  const sim = dualLevel([], { twoPlayer: true });
  const jumps2 = () => sim.events.filter((e) => e.type === "jump" && e.player === 2).map((e) => e.tick);
  while (sim.state2 === null) sim.step(NO_INPUT, HOLD);
  assert.equal(sim.tick, 77);
  sim.step(NO_INPUT, HOLD);
  assert.deepEqual([p2(sim).holding, p2(sim).rawHeld], [false, true]);
  // Landed on the band ceiling by tick 183, and still not jumping.
  while (sim.tick < 200) sim.step(NO_INPUT, HOLD);
  assert.deepEqual([p2(sim).y, p2(sim).onGround, p2(sim).holding], [255, true, false]);
  assert.deepEqual(jumps2(), []);
  // Let go and press again: that one jumps.
  sim.step(NO_INPUT, NO_INPUT);
  sim.step(NO_INPUT, HOLD);
  assert.equal(p2(sim).holding, true);
  assert.deepEqual(jumps2(), [sim.tick]);
});

test("different modes do not link — but the wave is not compared, so a wave and a cube do", () => {
  // The six flags at :420166-420171 leave out 1964.
  const ship = dualLevel([{ id: SHIP_PORTAL, x: 300, y: 30, scaleY: 0.5 }, { id: GRAVITY_TOGGLE, x: 600, y: 30 }]);
  const ts = runUntil(ship, gravityToggleAt);
  assert.equal(ts, 430);
  assert.deepEqual(flipsAt(ship, ts), [1], "ship and cube");
  const wave = dualLevel([{ id: WAVE_PORTAL, x: 300, y: 30, scaleY: 0.5 }, { id: GRAVITY_TOGGLE, x: 600, y: 30 }]);
  const tw = runUntil(wave, gravityToggleAt);
  assert.equal(tw, 438);
  assert.deepEqual(flipsAt(wave, tw), [1, 2], "wave and cube");
});

test("the blue pad and the blue orb link; the spider pad does not", () => {
  // Blue pad → layer flipGravity [463254]; blue orb [160294-160321]; spider pad is
  // PlayerObject::flipGravity [157061].
  const pad = dualLevel([{ id: BLUE_PAD, x: 450, y: 3 }]);
  const tp = runUntil(pad, (s) => s.events.some((e) => e.tick === s.tick && e.type === "pad"));
  assert.equal(tp, 314);
  assert.deepEqual(flipsAt(pad, tp), [1, 2]);
  near(p1(pad).yVel, 6.4, "player 1 launched and halved");
  const spider = dualLevel([{ id: SPIDER_PAD, x: 450, y: 3 }]);
  const tsp = runUntil(spider, (s) => s.events.some((e) => e.tick === s.tick && e.type === "pad"));
  assert.deepEqual(flipsAt(spider, tsp), [1]);
  assert.deepEqual([p1(spider).flipped, p2(spider).flipped], [true, true]);
  // The orb at the press: player 2's flip is stamped with this step.
  const level = buildLevel([{ id: 1, x: 2985, y: 15 }, { id: DUAL_PORTAL, x: 60, y: 45 }, { id: BLUE_ORB, x: 300, y: 15 }], makeHeader());
  const orb = makeSim(level, undefined, { start: { x: 15, y: 15, mode: "cube" } });
  while (p1(orb).touchingRings.length === 0) orb.step(NO_INPUT);
  orb.step(HOLD);
  assert.equal(orb.tick, 196);
  assert.deepEqual(flipsAt(orb, 196), [1, 2]);
  assert.deepEqual([p1(orb).flipped, p2(orb).flipped, p2(orb).lastFlipTick], [true, false, 196]);
});

test("a mode portal that matches the other player's mode forces the opposite gravity", () => {
  // [playerWillSwitchMode :462534-462594]
  const shipThenToggle: Placed[] = [
    { id: SHIP_PORTAL, x: 300, y: 30, scaleY: 0.5 },
    { id: GRAVITY_TOGGLE, x: 600, y: 30 },
  ];
  const sim = dualLevel([...shipThenToggle, { id: CUBE_PORTAL, x: 640, y: 30, scaleY: 0.5 }]);
  runUntil(sim, gravityToggleAt);
  assert.deepEqual([p1(sim).flipped, p2(sim).flipped], [true, true], "ship turned over alone");
  const t = runUntil(sim, (s) => s.events.some((e) => e.tick === s.tick && e.type === "portal" && e.detail === "cube"));
  assert.equal(t, 457);
  assert.deepEqual(flipsAt(sim, t), [1]);
  assert.deepEqual([p1(sim).flipped, p2(sim).flipped], [false, true], "back to opposite gravity");
  assert.deepEqual([p1(sim).lastFlipTick, p1(sim).lastModeChangeTick], [457, 457]);
  // The same run without the cube portal gives the ship's velocity on that
  // tick. The flip halves it [flipGravity :151158] and leaving the ship halves
  // it again [toggleFlyMode :152819].
  const twin = dualLevel(shipThenToggle);
  stepN(twin, NO_INPUT, t);
  assert.equal(p1(twin).isShip, true);
  near(p1(sim).yVel, p1(twin).yVel * 0.25, "halved by the flip and by leaving the ship");
  // A ship portal while the other is a cube forces nothing.
  const other = dualLevel([
    { id: SHIP_PORTAL, x: 300, y: 30, scaleY: 0.5 },
    { id: GRAVITY_TOGGLE, x: 600, y: 30 },
    { id: SHIP_PORTAL, x: 640, y: 30, scaleY: 0.5 },
  ]);
  runUntil(other, gravityToggleAt);
  const t2 = runUntil(other, (s) => s.tick > 300 && s.events.some((e) => e.tick === s.tick && e.type === "portal" && e.detail === "ship"));
  assert.deepEqual(flipsAt(other, t2), []);
  assert.equal(p1(other).flipped, true);
});

test("player 2 reaching the solo portal first hands player 1 its place", () => {
  // [toggleDualMode :462667-462676 → copyAttributes(p1, p2)]
  const sim = dualLevel([{ id: SOLO_PORTAL, x: 600, y: 255 }]);
  const t = runToSolo(sim);
  assert.equal(t, 424);
  assert.equal(sim.events.find((e) => e.detail === "solo")?.player, 2);
  const a = p1(sim);
  near(a.x, 565.4586791992188, "x");
  assert.deepEqual([a.y, a.flipped, a.onGround, a.onGround2, a.lastFlipTick], [255, true, false, true, 424]);
  assert.deepEqual([sim.floorY, sim.ceilingY], [0, Number.POSITIVE_INFINITY], "the cube's open ground again");
});

test("player 1 reaching it first, or both at once, copies nothing", () => {
  const low = dualLevel([{ id: SOLO_PORTAL, x: 600, y: 15 }]);
  runToSolo(low);
  assert.deepEqual([p1(low).y, p1(low).flipped], [15, false]);
  const tall = dualLevel([{ id: SOLO_PORTAL, x: 600, y: 135, scaleY: 3 }]);
  const t = runToSolo(tall);
  assert.equal(t, 424);
  assert.deepEqual(tall.events.filter((e) => e.detail === "solo").map((e) => e.player), [1]);
  assert.deepEqual([p1(tall).y, p1(tall).flipped], [15, false]);
});

test("unlinking survives a snapshot and changes the state hash", () => {
  const linked = dualLevel();
  stepN(linked, NO_INPUT, 400);
  const unlinked = dualLevel([{ id: OPTIONS, x: 300, y: 45, props: { 160: "1" } }]);
  // Snapshot inside the dual but before the trigger at x 300, then run past it.
  stepN(unlinked, NO_INPUT, 100);
  const snap = unlinked.snapshot();
  const before = unlinked.stateHash();
  stepN(unlinked, NO_INPUT, 300);
  assert.equal(unlinked.triggers.visual.options.unlinkDualGravity, true);
  assert.notEqual(linked.stateHash(), unlinked.stateHash());
  unlinked.restore(snap);
  assert.equal(unlinked.triggers.visual.options.unlinkDualGravity, false, "linked again");
  assert.equal(unlinked.stateHash(), before);
});

test("a restore across the spawn step replays player 2 the same way", () => {
  const sim = dualLevel();
  stepN(sim, NO_INPUT, 76);
  const snap = sim.snapshot();
  stepN(sim, NO_INPUT, 3);
  const once = [p2(sim).x, p2(sim).y, p2(sim).yVel, p2(sim).lastFlipTick];
  sim.restore(snap);
  stepN(sim, NO_INPUT, 3);
  assert.deepEqual([p2(sim).x, p2(sim).y, p2(sim).yVel, p2(sim).lastFlipTick], once);
  near(p2(sim).y, 15.145797729492188, "two ticks of upside-down gravity", 1e-9);
});

/**
 * Rotated gameplay from x 100 (keys 166 3, 167 4): the player then runs up the
 * y axis and falls towards x 0, and collision runs in its mirrored frame.
 */
function rotatedLevel(extra: Placed[]): Sim {
  const level = buildLevel([...floor(0, 3000), { id: 2900, x: 100, y: 45, props: { 166: "3", 167: "4" } }, ...extra], makeHeader());
  return makeSim(level, undefined, { start: { x: 15, y: 45, mode: "cube" } });
}

test("a dual portal taken in rotated gameplay spawns player 2 where player 1 is, unrotated", () => {
  // The reset turns player 2's gameplay back (resetObject → rotateGameplay(2, 4)
  // :153589) and copyAttributes does not copy +1971 [153299-153330]; the
  // position crosses over in world terms although player 1's pass is in its
  // own frame.
  const sim = rotatedLevel([{ id: DUAL_PORTAL, x: 70, y: 140 }]);
  const spawn = runUntil(sim, (s) => s.state2 !== null);
  assert.equal(spawn, 109);
  const a = p1(sim);
  const b = p2(sim);
  assert.deepEqual([a.rotated, b.rotated], [true, false]);
  assert.deepEqual([b.x, b.y, b.lastX, b.lastY], [a.x, a.y, a.lastX, a.lastY]);
  assert.deepEqual([a.flipped, b.flipped], [false, true]);
  near(b.yVel, -a.yVel, "the opposite velocity");
});

test("player 2 leaving in its own rotated pass hands player 1 its place in world terms", () => {
  // Both players turn with the trigger inside the dual; player 2 runs 10 units
  // ahead of player 1 up the y axis and meets the solo portal first.
  const dualThenTurn: Placed[] = [{ id: DUAL_PORTAL, x: 110, y: 90 }];
  const sim = rotatedLevel([...dualThenTurn, { id: SOLO_PORTAL, x: 40, y: 200 }]);
  const t = runToSolo(sim);
  assert.equal(t, 131);
  assert.equal(sim.events.find((e) => e.detail === "solo")?.player, 2);
  // The same run without the solo portal: where player 2 ended that step.
  const twin = rotatedLevel(dualThenTurn);
  stepN(twin, NO_INPUT, t);
  const a = p1(sim);
  const b = p2(twin);
  assert.deepEqual([a.x, a.y, a.yVel, a.flipped, a.rotated], [b.x, b.y, b.yVel, b.flipped, true]);
  assert.notEqual(a.y, p1(twin).y, "not where player 1 was");
});
