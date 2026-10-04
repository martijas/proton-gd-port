// The player's boxes, the grown-back snap and the saw rule, pinned to the
// 2.206 decompile rather than to measurements of this port. The derivation is
// in data/ref/gd-discrepancies.md §6, §7 and §17.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMode } from "../src/level/types";
import { ObjectSet, collideSolid, R_LAND } from "../src/physics/collision";
import { rectCornersHitCircle, rectHitsCircle } from "../src/physics/geometry";
import { Player, type PlayerWorld } from "../src/physics/player";
import { NO_INPUT, type PlayerInput, type Sim } from "../src/physics/types";
import { loadObjectTable, makeSim } from "./helpers";
import { buildLevel, emptyLevel, floor, HOLD, makeHeader, settle, simOn, stepN } from "./levelKit";

const EPS = 1e-9;
const RIGHT: PlayerInput = Object.freeze({ jump: false, left: false, right: true });

function near(actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

function p1(sim: Sim): Player {
  return sim.state as Player;
}

function world(over: Partial<PlayerWorld> = {}): PlayerWorld {
  return { emit: () => {}, spiderJump: () => {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true, ...over };
}

function player(mode: GameMode, mini = false, over: Partial<PlayerWorld> = {}): Player {
  const p = new Player(world(over), 1);
  p.setMode(mode);
  p.mini = mini;
  return p;
}

// --- §6, §7: the boxes -------------------------------------------------------------

test("box, inner box and ground size by mode and size", () => {
  // Box = +648 × vehicle scale; inner = +648 × 0.3, never scaled; ground = +2160.
  // [toggleSpiderMode :152721-152723, toggleDartMode :153041-153043,
  //  resetPlayerIcon :148112-148114; getObjectRect(0.3, 0.3) :170812-170848]
  const rows: Array<[GameMode, boolean, number, number, number]> = [
    ["cube", false, 30, 9, 30],
    ["cube", true, 18, 9, 30],
    ["ship", true, 18, 9, 30],
    ["spider", false, 27, 8.1, 27],
    ["spider", true, 16.2, 8.1, 27],
    ["wave", false, 10, 3, 20],
    ["wave", true, 6, 3, 20],
  ];
  for (const [mode, mini, box, inner, ground] of rows) {
    const p = player(mode, mini);
    const tag = `${mode}${mini ? " mini" : ""}`;
    near(p.hitboxSize(), box, `${tag}: box`);
    near(p.innerSize(), inner, `${tag}: inner box`);
    near(p.groundSize(), ground, `${tag}: ground size`);
  }
});

test("a spider stands 13.5 off a block and off the plain ground, 8.1 when mini", () => {
  // Blocks land the player by its real box; the plain ground measures by +2160,
  // which for the spider is the same 27. [checkCollisions :464678-464690]
  for (const [mini, onBlocks, plainGround] of [
    [false, 43.5, 13.5],
    // Floats in the game's space, where y is 90 higher.
    [true, Math.fround(128.1) - 90, Math.fround(98.1) - 90],
  ] as const) {
    const sim = simOn(emptyLevel(), { y: 60, mini }, "spider");
    settle(sim);
    near(sim.state.y, onBlocks, `${mini ? "mini " : ""}spider on a block`);
    const plain = makeSim(buildLevel([{ id: 1, x: 2985, y: 15 }]), undefined, { start: { x: 15, y: 40, mode: "spider", mini } });
    stepN(plain, NO_INPUT, 60);
    near(plain.state.y, plainGround, `${mini ? "mini " : ""}spider on the plain ground`);
  }
});

test("the wave rides 10 units off the ground and its band, 6 mini", () => {
  // +2160 = 20 against a box of 10. [toggleDartMode :153041; checkCollisions :464678-464866]
  for (const [mini, low, high] of [
    [false, 10, 290],
    [true, 6, 294],
  ] as const) {
    const level = buildLevel([{ id: 1, x: 2985, y: 15 }], makeHeader({ startMode: "wave", startMini: mini }));
    const down = makeSim(level, undefined, { start: { x: 15, y: 150, mode: "wave", mini } });
    stepN(down, NO_INPUT, 200);
    near(down.state.y, low, `${mini ? "mini " : ""}wave released`);
    const up = makeSim(level, undefined, { start: { x: 15, y: 150, mode: "wave", mini } });
    stepN(up, HOLD, 200);
    near(up.state.y, high, `${mini ? "mini " : ""}wave held`);
  }
});

test("a mini cube's inner box is 9: it runs into a wall on the same tick a big one does", () => {
  // getObjectRect(0.3, 0.3) never reads the vehicle scale, so the inner box
  // is 9 at both sizes and the death x is 90 − 4.5 either way.
  // [collidedWithObjectInternal :152369-152417; getObjectRect :170812-170848]
  const deathOf = (mini: boolean, mode: GameMode = "cube"): { tick: number; x: number } => {
    const sim = simOn(emptyLevel([{ id: 1, x: 105, y: 45 }]), { y: mini ? 39 : 45, mini }, mode);
    for (let t = 0; t < 120 && !sim.state.dead; t++) sim.step(NO_INPUT);
    assert.ok(sim.state.dead, `${mode}${mini ? " mini" : ""} never died`);
    return { tick: sim.tick, x: +sim.state.x.toFixed(6) };
  };
  const big = deathOf(false);
  assert.deepEqual(big, { tick: 55, x: 86.40377 });
  assert.deepEqual(deathOf(true), big, "mini cube");
  assert.deepEqual(deathOf(false, "spider"), big, "spider, inner 8.1");
  assert.deepEqual(deathOf(true, "spider"), big, "mini spider, inner 8.1");
});

// --- §17: the grown-back snap ---------------------------------------------------------

test("growing back from mini in a platformer lands with a 15-unit threshold for two passes", () => {
  // togglePlayerScale sets +2212 = 2 on growing back in a platformer; the
  // threshold is 15 while it is above 0, and each update takes one off.
  // [togglePlayerScale :150416-150418; collidedWithObjectInternal :151523-151524;
  //  updateStateVariables :153706]
  const table = loadObjectTable();
  const level = buildLevel([{ id: 1, x: 45, y: 15 }], makeHeader({ platformer: true }));
  const o = new ObjectSet(level, table);
  for (const [passes, landed] of [
    [2, true],
    [1, true],
    [0, false],
  ] as const) {
    const p = player("cube", false, { platformer: true });
    p.scaleSnapPasses = passes;
    // Feet 12 below the block's top (30), moving down.
    p.x = 45;
    p.y = 33;
    p.lastY = 33;
    p.yVel = -1;
    const r = collideSolid(p, o, 0, true);
    assert.equal(r === R_LAND, landed, `passes ${passes}: landed`);
    if (landed) near(p.y, 45, `passes ${passes}: y`);
  }
  // setMini: only growing, and only in a platformer.
  const plat = player("cube", true, { platformer: true });
  plat.setMini(false);
  assert.equal(plat.scaleSnapPasses, 2, "platformer, grown back");
  const shrink = player("cube", false, { platformer: true });
  shrink.setMini(true);
  assert.equal(shrink.scaleSnapPasses, 0, "platformer, shrunk");
  const classic = player("cube", true);
  classic.setMini(false);
  assert.equal(classic.scaleSnapPasses, 0, "classic, grown back");
});

test("the grown-back snap covers the portal's own pass and the next one", () => {
  // The portal is met before the solids, so its own pass already has it.
  const level = buildLevel([...floor(0, 600), { id: 99, x: 60, y: 45 }], makeHeader({ platformer: true, startMini: true }));
  const sim = makeSim(level, undefined, { start: { x: 15, y: 39, mini: true } });
  const seen: number[] = [];
  let portalTick = -1;
  for (let t = 0; t < 120 && seen.length < 4; t++) {
    sim.step(RIGHT);
    if (portalTick < 0 && !sim.state.mini) portalTick = sim.tick;
    if (portalTick > 0) seen.push(p1(sim).scaleSnapPasses);
  }
  assert.deepEqual(seen, [2, 1, 0, 0]);
});

test("a platformer starts with the grown-back snap armed, player 2 included", () => {
  // resetObject sets the scale to 0.6 and grows the player back, which in a
  // platformer sets +2212 = 2. The first update takes one off, so the first
  // pass lands a cube whose feet are 12 into the floor, which the platformer's
  // 5 would not. A dual resets player 2 the same way before it spawns.
  // [resetObject :153659-153660 → togglePlayerScale :150416-150418;
  //  toggleDualMode :462652; updateStateVariables :153706]
  const level = buildLevel(floor(0, 600), makeHeader({ platformer: true }));
  const sim = makeSim(level, undefined, { start: { x: 45, y: 33 } });
  assert.equal(p1(sim).scaleSnapPasses, 2, "armed at the start");
  sim.step(NO_INPUT);
  assert.deepEqual([sim.state.y, sim.state.onGround, p1(sim).scaleSnapPasses], [45, true, 1], "the first pass lands it");
  sim.step(NO_INPUT);
  assert.equal(p1(sim).scaleSnapPasses, 0, "worn off after the second update");
  const unarmed = makeSim(level, undefined, { start: { x: 45, y: 33 } });
  p1(unarmed).scaleSnapPasses = 0;
  unarmed.step(NO_INPUT);
  assert.equal(unarmed.state.onGround, false, "without it, the first pass does not land it");

  for (const platformer of [true, false]) {
    const dual = makeSim(buildLevel(floor(0, 600), makeHeader({ platformer, startDual: true })), undefined, { start: { x: 45, y: 45 } });
    const passes = platformer ? 2 : 0;
    assert.deepEqual([p1(dual).scaleSnapPasses, (dual.state2 as Player).scaleSnapPasses], [passes, passes], `platformer ${platformer}`);
  }
});

// --- saws -------------------------------------------------------------------------

test("a round hazard hits only through the box's corners or its own centre", () => {
  // objectIntersectsCircle: centre in the rect (edges included), or a corner
  // strictly inside. [gd-ida-decomp.cpp:419666-419706]
  // Rim across the middle of the top face: the exact test hits, this does not.
  assert.equal(rectHitsCircle(0, 0, 30, 30, 15, 50, 21), true);
  assert.equal(rectCornersHitCircle(0, 0, 30, 30, 15, 50, 21), false);
  // A corner inside.
  assert.equal(rectCornersHitCircle(0, 0, 30, 30, 40, 40, 15), true);
  // A corner exactly on the rim does not count; the centre on an edge does.
  assert.equal(rectCornersHitCircle(0, 0, 30, 30, 30, 40, 10), false);
  assert.equal(rectCornersHitCircle(0, 0, 30, 30, 30, 15, 1), true);
});

test("running at a saw level with the player dies when the leading corners reach it", () => {
  // Saw 88 (radius 32.3) centred at the player's height: the rim meets the
  // front face first, 3.7 units before the corners enter it.
  const sim = simOn(emptyLevel([{ id: 88, x: 300, y: 45 }]));
  for (let t = 0; t < 400 && !sim.state.dead; t++) sim.step(NO_INPUT);
  assert.equal(sim.state.dead, true);
  assert.equal(sim.tick, 186);
  near(sim.state.x, 256.475, "x", 1e-3);
  // kA39 keeps the circle-against-circle rule, which dies at the first touch.
  // [playerIntersectsCircle :419722-419735]
  const fixed = simOn(emptyLevel([{ id: 88, x: 300, y: 45 }], makeHeader({ fixRadiusCollision: true })));
  for (let t = 0; t < 400 && !fixed.state.dead; t++) fixed.step(NO_INPUT);
  assert.equal(fixed.tick, 184);
});
