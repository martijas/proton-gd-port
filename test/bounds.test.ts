// The ground, the dual band's edges and the level's bounds — the part of
// checkCollisions that runs before any object — pinned to the 2.206 decompile
// rather than to measurements of this port. The derivation is in
// data/ref/gd-discrepancies.md §15.
//
// Most cases put a player straight into the state they test. Cube gravity per
// tick 0.216 once rounded; a y step is yVel × 0.225, added to a float y + 90.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMode, LevelHeader } from "../src/level/types";
import { Player } from "../src/physics/player";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { makeSim } from "./helpers";
import { buildLevel, floor, HOLD, makeHeader, stepN } from "./levelKit";

const EPS = 1e-9;
const LINKED_TELEPORT = 747;

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

/** The plain ground and nothing on it, started on it at x 15. */
function plain(header: Partial<LevelHeader> = {}, mode: GameMode = "cube"): Sim {
  return makeSim(buildLevel([{ id: 1, x: 2985, y: 15 }], makeHeader(header)), undefined, { start: { x: 15, y: 15, mode } });
}

/** A level that starts in a dual on the plain ground: band 0..270 (300 when flying), player 2 on its ceiling. */
function dual(mode: GameMode = "cube"): Sim {
  const sim = makeSim(buildLevel([{ id: 1, x: 2985, y: 15 }], makeHeader({ startDual: true, startMode: mode })), undefined, {
    start: { x: 15, y: 15, mode },
  });
  stepN(sim, NO_INPUT, 40);
  return sim;
}

/** Two steps' worth of what the bounds check leaves behind. */
function twoTicks(sim: Sim, p: Player): Array<{ y: number; out: boolean; dead: boolean }> {
  const rows: Array<{ y: number; out: boolean; dead: boolean }> = [];
  for (let i = 0; i < 2 && !p.dead; i++) {
    sim.step(NO_INPUT);
    rows.push({ y: +p.y.toFixed(9), out: p.wasOutOfBounds, dead: p.dead });
  }
  return rows;
}

test("upside down on the plain ground: caught within 0.1 s of a flip, out of bounds after", () => {
  // [checkCollisions :464734-464748; isSafeFlip :147844-147849 at 0.1]
  const at = (ticksSinceFlip: number | null) => {
    const sim = plain();
    stepN(sim, NO_INPUT, 10);
    const p = p1(sim);
    p.flipped = true;
    p.y = p.lastY = 15.5;
    p.yVel = -5;
    p.onGround = p.onGround2 = false;
    p.lastFlipTick = ticksSinceFlip === null ? -1e9 : 11 - ticksSinceFlip;
    return { sim, p };
  };
  const caught = at(24);
  caught.sim.step(NO_INPUT);
  assert.deepEqual([caught.p.y, caught.p.yVel, caught.p.onGround, caught.p.onGround2, caught.p.wasOutOfBounds], [15, 0, true, false, false]);
  for (const since of [25, null]) {
    const { sim, p } = at(since);
    assert.deepEqual(
      twoTicks(sim, p),
      [
        { y: 14.423599243, out: true, dead: false },
        { y: 13.395797729, out: false, dead: true },
      ],
      `flipped ${since} ticks before`,
    );
    assert.equal(p.killedBy, null);
  }
});

test("an upside-down cube that jumps down to the plain ground dies there", () => {
  // Under a ceiling at y 90: the jump reaches the ground line on tick 44.
  const sim = makeSim(buildLevel(floor(0, 3000, 105), makeHeader()), undefined, { start: { x: 15, y: 75, mode: "cube", flipped: true } });
  stepN(sim, NO_INPUT, 5);
  sim.step(HOLD);
  let outTick = -1;
  while (!sim.state.dead && sim.tick < 200) {
    sim.step(NO_INPUT);
    if (outTick < 0 && p1(sim).wasOutOfBounds) outTick = sim.tick;
  }
  assert.deepEqual([outTick, sim.tick], [44, 45]);
});

test("a boosted player below the ground line is left there", () => {
  // [:464752-464761]
  for (const boosted of [true, false]) {
    const sim = plain();
    stepN(sim, NO_INPUT, 10);
    const p = p1(sim);
    p.y = p.lastY = 10;
    p.yVel = 5;
    p.maybeIsBoosted = boosted;
    p.onGround = false;
    sim.step(NO_INPUT);
    if (boosted) {
      near(p.y, 11.076400756835938, "boosted: not snapped");
      assert.equal(p.onGround, false);
    } else {
      assert.deepEqual([p.y, p.yVel, p.onGround], [15, 0, true]);
    }
  }
});

test("a cube or robot hitting the band ceiling head first is out of bounds unless it is safe", () => {
  // [:464774-464824; destroyFromHitHead :145615-145626; isSafeHeadTest :147910-147912]
  const hit = (mode: GameMode, setup: (p: Player) => void) => {
    const sim = dual(mode);
    const p = p1(sim);
    p.y = p.lastY = 254;
    p.yVel = 8;
    p.onGround = false;
    setup(p);
    return { sim, p };
  };
  const dies = [
    { y: 255.751403809, out: true, dead: false },
    { y: 257.454193115, out: false, dead: true },
  ];
  for (const [label, setup] of [
    ["nothing", () => {}],
    ["mode changed 49 ticks ago", (p: Player) => (p.lastModeChangeTick = 41 - 49)],
    ["flipped 49 ticks ago", (p: Player) => (p.lastFlipTick = 41 - 49)],
  ] as const) {
    const { sim, p } = hit("cube", setup);
    assert.deepEqual(twoTicks(sim, p), dies, label);
  }
  const robot = hit("robot", () => {});
  assert.deepEqual(twoTicks(robot.sim, robot.p).map((r) => [r.out, r.dead]), [
    [true, false],
    [false, true],
  ]);
  for (const [label, setup] of [
    ["mode changed 48 ticks ago", (p: Player) => (p.lastModeChangeTick = 41 - 48)],
    ["flipped 48 ticks ago", (p: Player) => (p.lastFlipTick = 41 - 48)],
  ] as const) {
    const { sim, p } = hit("cube", setup);
    sim.step(NO_INPUT);
    // pushDown: stopped and off the ground, not landed.
    assert.deepEqual([p.y, p.yVel, p.onGround, p.onGround2, p.wasOutOfBounds], [255, 0, false, false, false], label);
  }
  // An H block makes it an ordinary ceiling: snapped and landed, but at 7.8 the latch stays down.
  const h = hit("cube", (p) => (p.stateHitHead = 2));
  h.sim.step(NO_INPUT);
  assert.deepEqual([h.p.y, h.p.yVel, h.p.onGround, h.p.onGround2, h.p.wasOutOfBounds], [255, 0, false, true, false]);
});

test("the band floor is player 2's head side while it is upside down", () => {
  // [:464826-464874]
  const hit = (sinceFlip: number | null) => {
    const sim = dual();
    const p = p2(sim);
    p.y = p.lastY = 16;
    p.yVel = -8;
    p.onGround = false;
    if (sinceFlip !== null) p.lastFlipTick = 41 - sinceFlip;
    return { sim, p };
  };
  const fatal = hit(null);
  assert.deepEqual(twoTicks(fatal.sim, fatal.p), [
    { y: 14.248596191, out: true, dead: false },
    { y: 12.545799255, out: false, dead: true },
  ]);
  assert.equal(fatal.sim.state.dead, true, "and player 1 with it");
  const safe = hit(48);
  safe.sim.step(NO_INPUT);
  assert.deepEqual([safe.p.y, safe.p.yVel, safe.p.onGround, safe.p.wasOutOfBounds], [15, 0, false, false]);
});

test("the ball and the ship meet the band ceiling as a surface", () => {
  for (const [mode, ceiling] of [
    ["ball", 270],
    ["ship", 300],
  ] as const) {
    const sim = dual(mode);
    assert.equal(sim.ceilingY, ceiling);
    const p = p1(sim);
    p.y = p.lastY = ceiling - 16;
    p.yVel = 8;
    p.onGround = false;
    sim.step(NO_INPUT);
    assert.deepEqual([p.y, p.yVel, p.onGround2, p.wasOutOfBounds, p.dead], [ceiling - 15, 0, true, false, false], mode);
  }
});

test("one tick outside the band is forgiven", () => {
  const sim = dual();
  const p = p1(sim);
  p.y = p.lastY = 257;
  p.yVel = -6;
  p.onGround = false;
  assert.deepEqual(twoTicks(sim, p), [
    { y: 255.601409912, out: true, dead: false },
    { y: 254.154205322, out: false, dead: false },
  ]);
});

/**
 * A dual from the start, with a linked teleport on the ground whose box is
 * at x 120 (the portal at 108: its box sits 12 to its right) that lifts
 * whoever enters it by `offset`. Player 1 takes it on tick 60.
 */
function teleportDual(mode: GameMode, offset: number): { sim: Sim; p: Player } {
  const level = buildLevel(
    [{ id: 1, x: 2985, y: 15 }, { id: LINKED_TELEPORT, x: 108, y: 15, props: { 54: String(offset) } }],
    makeHeader({ startDual: true, startMode: mode }),
  );
  const sim = makeSim(level, undefined, { start: { x: 15, y: 15, mode } });
  while (!sim.events.some((e) => e.detail === "teleport" && e.player === 1)) sim.step(NO_INPUT);
  assert.equal(sim.tick, 60);
  return { sim, p: p1(sim) };
}

test("the pass after a teleport leaves the band alone", () => {
  // teleportPlayer marks the player (+1168) and does not clamp it
  // [:462313-462315, :462274-462490]; checkCollisions reads and clears the
  // mark first [:464675-464676] and skips the band while it is set [:464763].
  // A cube lifted past the ceiling keeps its place for one pass, then is
  // head first out of bounds.
  const cube = teleportDual("cube", 250);
  assert.deepEqual([cube.p.y, cube.p.teleported], [265, true], "not pulled back inside");
  cube.sim.step(NO_INPUT);
  assert.deepEqual([+cube.p.y.toFixed(9), cube.p.wasOutOfBounds, cube.p.teleported], [264.951385498, false, false]);
  assert.deepEqual(twoTicks(cube.sim, cube.p), [
    { y: 264.854187012, out: true, dead: false },
    { y: 264.708374023, out: false, dead: true },
  ]);
  // A ship is snapped to the ceiling one pass late.
  const ship = teleportDual("ship", 280);
  assert.equal(ship.p.y, 295);
  ship.sim.step(NO_INPUT);
  near(ship.p.y, 294.9768371582031, "left where it is");
  ship.sim.step(NO_INPUT);
  assert.deepEqual([ship.p.y, ship.p.wasOutOfBounds, ship.p.dead], [285, false, false]);
});

test("a teleport's mark survives a snapshot and changes the state hash", () => {
  const { sim, p } = teleportDual("cube", 250);
  const snap = sim.snapshot();
  const h = sim.stateHash();
  sim.step(NO_INPUT);
  assert.equal(p.teleported, false);
  sim.restore(snap);
  assert.deepEqual([p.teleported, sim.stateHash()], [true, h]);
  p.teleported = false;
  assert.notEqual(sim.stateHash(), h);
});

test("a platformer stops at the left edge and loses its x velocity", () => {
  // [:464708-464717]
  const sim = makeSim(buildLevel([{ id: 1, x: 2985, y: 15 }], makeHeader({ platformer: true })), undefined, {
    start: { x: -29.5, y: 15, mode: "cube" },
  });
  p1(sim).xVel = -3;
  sim.step({ jump: false, left: true, right: false });
  assert.deepEqual([p1(sim).x, p1(sim).xVel], [-30, 0]);
});

test("reversed gameplay: past the left edge is out of bounds, and the second tick out kills", () => {
  // [:464720-464723, then :464877-464879]
  const sim = makeSim(buildLevel([{ id: 1, x: 2985, y: 15 }], makeHeader()), undefined, {
    start: { x: -27, y: 15, mode: "cube", reversed: true },
  });
  const rows: Array<[number, boolean, boolean]> = [];
  for (let i = 0; i < 4 && !sim.state.dead; i++) {
    sim.step(NO_INPUT);
    rows.push([+p1(sim).x.toFixed(9), p1(sim).wasOutOfBounds, p1(sim).dead]);
  }
  assert.deepEqual(rows, [
    [-28.298250198, false, false],
    [-29.596500397, false, false],
    [-30.894750595, true, false],
    [-32.193000793, false, true],
  ]);
  assert.equal(p1(sim).killedBy, null);
});

test("above the level's height is out of bounds; a mini player's allowance grows by what it shrank", () => {
  // y > maxGameplayY + v10, v10 = 30 × (1 − 0.6) / 2 = 6 for a mini cube [:464678-464690, 464729-464732]
  const run = (mini: boolean) => {
    const sim = makeSim(buildLevel([{ id: 1, x: 2985, y: 15 }], makeHeader()), undefined, {
      start: { x: 15, y: 2700 + 3, mode: "cube", mini },
    });
    return twoTicks(sim, p1(sim)).map((r) => [r.out, r.dead]);
  };
  assert.deepEqual(run(false), [
    [true, false],
    [false, true],
  ]);
  assert.deepEqual(run(true), [
    [false, false],
    [false, false],
  ]);
});
