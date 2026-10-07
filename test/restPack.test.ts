// Persistent items, UI layout helpers, BG effect flag, and the platformer
// camera dead zone — the remaining trigger pack.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEAD_ZONE_DOWN,
  DEAD_ZONE_PLATFORMER_DOWN,
  DEAD_ZONE_PLATFORMER_UP,
  DEAD_ZONE_UP,
  Camera,
  PLATFORMER_TRAVEL_DIVISOR,
} from "../src/render/camera";
import { applyPersistentTrigger, persistentSpecOf, transferPersistent } from "../src/triggers/persistent";
import { uiKeysOf, uiOffsetFromCentre } from "../src/triggers/uiLayout";
import { statusOf } from "../src/triggers/registry";
import { NO_INPUT, type PlayerState } from "../src/physics/types";
import { makeSim } from "./helpers";
import { buildLevel, emptyLevel, makeHeader, simOn, stepN } from "./levelKit";

function player(p: Partial<PlayerState>): PlayerState {
  return { x: 0, y: 15, mode: "cube", flipped: false, reversed: false, rotated: false, ...p } as PlayerState;
}

test("registry: persistent and BG effect are done; Object Control unsupported; UI partial", () => {
  assert.equal(statusOf(3641).status, "done");
  assert.equal(statusOf(1818).status, "done");
  assert.equal(statusOf(1819).status, "done");
  assert.equal(statusOf(3655).status, "unsupported");
  assert.equal(statusOf(3613).status, "partial");
});

test("Persistent Item Setup marks an item so its value survives a transfer", () => {
  const items = new Map<number, number>([[1, 7]]);
  const timers = new Map<number, number>();
  const persistentItems = new Map<number, number>();
  const persistentTimers = new Map<number, number>();
  applyPersistentTrigger(
    persistentSpecOf({ 80: "1", 491: "1" }),
    items,
    timers,
    persistentItems,
    persistentTimers,
    (id) => id,
  );
  assert.equal(persistentItems.get(1), 7);
  items.set(1, 12);
  persistentItems.set(1, 12);
  const nextItems = new Map<number, number>();
  const nextTimers = new Map<number, number>();
  transferPersistent(nextItems, nextTimers, { items: persistentItems, timers: persistentTimers });
  assert.equal(nextItems.get(1), 12);
});

test("Persistent Item Setup reset zeroes a marked item", () => {
  const items = new Map<number, number>([[3, 9]]);
  const persistentItems = new Map<number, number>([[3, 9]]);
  applyPersistentTrigger(
    persistentSpecOf({ 80: "3", 491: "1", 493: "1" }),
    items,
    new Map(),
    persistentItems,
    new Map(),
    (id) => id,
  );
  assert.equal(items.has(3), false);
  assert.equal(persistentItems.get(3), 0);
});

test("a Pickup then Persistent Item keeps the count across a fresh sim carry", () => {
  const level = emptyLevel([
    { id: 1817, x: 0, y: 300, props: { 80: "1", 77: "5" } },
    { id: 3641, x: 1, y: 300, props: { 80: "1", 491: "1" } },
  ]);
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  assert.equal(sim.triggers.itemCount(1), 5);
  const carry = sim.triggers.persistentCarry();
  assert.equal(carry.items.get(1), 5);
});

test("Background Effect Off and On flip visual.bgEffectHidden", () => {
  // Past the start (x 15): reset already fires everything at or behind the
  // player, and one step can clear a wide band.
  const level = emptyLevel([
    { id: 1819, x: 50, y: 300, props: {} },
    { id: 1818, x: 250, y: 300, props: {} },
  ]);
  const sim = simOn(level);
  assert.equal(sim.triggers.visual.bgEffectHidden, false);
  stepN(sim, NO_INPUT, 40);
  assert.equal(sim.triggers.visual.bgEffectHidden, true, "Off hid it");
  stepN(sim, NO_INPUT, 200);
  assert.equal(sim.triggers.visual.bgEffectHidden, false, "On cleared it");
});

test("Ghost Trail before a dual leaves player 2 without one", () => {
  // Enable Ghost (32) before dual: only player 1. Enable while dual is on:
  // both. Dual ending clears player 2's. [PlayLayer::toggleGhostEffect
  //  :92269-92276]
  const level = buildLevel(
    [
      { id: 1, x: 2985, y: 15 },
      { id: 32, x: 40, y: 105 },
      { id: 286, x: 150, y: 45 },
      { id: 32, x: 400, y: 105 },
      { id: 287, x: 700, y: 45 },
    ],
    makeHeader(),
  );
  const sim = makeSim(level, undefined, { start: { x: 15, y: 15, mode: "cube" } });
  stepN(sim, NO_INPUT, 40);
  assert.equal(sim.triggers.visual.ghostTrail, true);
  assert.equal(sim.triggers.visual.ghostTrail2, false, "before dual");
  while (!sim.state2 && !sim.state.dead) sim.step(NO_INPUT);
  assert.ok(sim.state2, "dual started");
  assert.equal(sim.triggers.visual.ghostTrail2, false, "dual does not copy player 1's trail");
  while (sim.state.x < 420 && !sim.state.dead) sim.step(NO_INPUT);
  assert.equal(sim.triggers.visual.ghostTrail, true);
  assert.equal(sim.triggers.visual.ghostTrail2, true, "Enable while dual is on");
  while (sim.state2 && !sim.state.dead) sim.step(NO_INPUT);
  assert.equal(sim.triggers.visual.ghostTrail2, false, "solo clears player 2's");
  assert.equal(sim.triggers.visual.ghostTrail, true, "player 1 keeps it");
});

test("Object Control fires and does nothing", () => {
  const level = emptyLevel([{ id: 3655, x: 0, y: 300, props: { 51: "1" } }]);
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 1);
  assert.equal(sim.triggers.itemCount(1), 0);
});

test("UI layout: centre ref is the offset from the guide", () => {
  const keys = uiKeysOf({ 51: "2", 71: "3", 385: "2", 386: "6" });
  assert.deepEqual(keys, { group: 2, target: 3, xref: 2, yref: 6, scaleX: false, scaleY: false });
  const off = uiOffsetFromCentre(
    { objX: 110, objY: 50, guideX: 100, guideY: 40, xref: 2, yref: 6, scaleX: false, scaleY: false },
    240,
    160,
  );
  assert.deepEqual(off, { dx: 10, dy: 10 });
});

test("a platformer's basic dead zone is 55 / 27.5", () => {
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.reset(player({ x: 500, y: 100 }));
  camera.platformer = true;
  const centre = camera.centre().y;
  camera.follow(player({ x: 500, y: 100 + DEAD_ZONE_PLATFORMER_UP - 1 }));
  assert.equal(camera.centre().y, centre, "inside the platformer zone");
  camera.follow(player({ x: 500, y: 100 + DEAD_ZONE_PLATFORMER_UP + 50 }));
  assert.ok(camera.centre().y > centre, "chases above the platformer zone");
  assert.notEqual(DEAD_ZONE_PLATFORMER_UP, DEAD_ZONE_UP);
  assert.notEqual(DEAD_ZONE_PLATFORMER_DOWN, DEAD_ZONE_DOWN);
  assert.equal(PLATFORMER_TRAVEL_DIVISOR, 8);
});

test("a platformer's travel axis eases instead of snapping", () => {
  const classic = new Camera();
  classic.setAspect(16, 9);
  classic.reset(player({ x: 500 }));
  classic.follow(player({ x: 600 }));
  const platformer = new Camera();
  platformer.setAspect(16, 9);
  platformer.reset(player({ x: 500 }));
  platformer.platformer = true;
  platformer.follow(player({ x: 600 }));
  assert.equal(classic.centre().x, 675);
  assert.ok(platformer.centre().x < 675 && platformer.centre().x > 575);
});
