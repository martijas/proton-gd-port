// Teleports: the portals' box, key 54's default, and the options every
// teleport carries — keep x or y (352, 353), gravity (354) and the push
// along the exit (345, 346, 443) — for the portals and the Teleport trigger.
// [gdp GJBaseGameLayer::teleportPlayer, gd-ida-decomp.cpp:462274-462491;
//  TeleportPortalObject::customObjectSetup :303063-303187;
//  GameObject::customSetup LABEL_961 :179044-179052]

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DASH_DEG } from "../src/physics/constants";
import { Player, type PlayerWorld } from "../src/physics/player";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { LEVELS_DIR, loadObjectTable, loadOfficialLevel, makeSim } from "./helpers";
import { buildLevel, emptyLevel, floor, makeHeader, simOn } from "./levelKit";

const LEVELS = existsSync(`${LEVELS_DIR}/20.txt`) ? false : "needs the real install";
const f = Math.fround;

function p1(sim: Sim): Player {
  return (sim as unknown as { p1: Player }).p1;
}

function world(over: Partial<PlayerWorld> = {}): PlayerWorld {
  return { emit: () => {}, spiderJump: () => {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true, ...over };
}

function runToTeleport(sim: Sim, max = 120): number {
  for (let i = 0; i < max; i++) {
    const n = sim.events.length;
    sim.step(NO_INPUT);
    if (sim.events.slice(n).some((e) => e.detail === "teleport")) return sim.tick;
  }
  return -1;
}

test("the teleport portals' box is 25 by 90, its centre 12 along the portal's own x", () => {
  const table = loadObjectTable();
  for (const id of [747, 2902]) {
    assert.deepEqual(table.get(id).hitbox, { type: "box", w: 25, h: 90, ox: 12, oy: 0 }, `${id}`);
  }
  // Turned a quarter, the box is 12 up the world's y: met from below 12 later.
  const sim = simOn(emptyLevel([{ id: 747, x: 200, y: 165, rotation: -90, props: { 54: "0" } }]));
  const box = sim.hitboxOf(sim.level.objects.length - 1);
  assert.ok(box && box.type === "rect");
  assert.deepEqual([box.rect.x + box.rect.w / 2, box.rect.y + box.rect.h / 2, box.rect.w, box.rect.h], [200, 177, 90, 25]);
});

test("a linked portal without key 54 exits level with itself", () => {
  // atof's 0.0; the port used to add 90. [:303108-303113]
  const sim = simOn(emptyLevel([{ id: 747, x: 120, y: 75 }]));
  assert.ok(runToTeleport(sim) > 0);
  assert.equal(sim.state.y, 75);
});

test("key 354 sets the gravity of the player that went through: 2 flipped, 3 the other way, 1 normal", () => {
  for (const [key, before, after] of [
    ["2", false, true],
    ["3", false, true],
    ["1", true, false],
    ["3", true, false],
  ] as const) {
    const sim = simOn(emptyLevel([{ id: 747, x: 120, y: 45, props: { 54: "150", 354: key } }]), { flipped: before }, "ship");
    assert.ok(runToTeleport(sim) > 0);
    assert.equal(sim.state.flipped, after, `354 = ${key} from ${before}`);
  }
});

test("key 352 keeps the player's x and key 353 its y on a group teleport, which lands where the target is now", () => {
  // Group 7's block starts at (900, 300); a Move trigger at x 30 takes it
  // 60 up at once. The 2902 at x 150 then sends the player to (900, 360),
  // (the player's x, 360) or (900, the player's y).
  for (const [keys, expectX, expectY] of [
    [{}, 900, 360],
    [{ 352: "1" }, null, 360],
    [{ 353: "1" }, 900, null],
  ] as const) {
    const level = emptyLevel([
      { id: 901, x: 30, y: 600, props: { 51: "7", 28: "0", 29: "60", 10: "0" } },
      { id: 2902, x: 138, y: 45, props: { 51: "7", ...keys } },
      { id: 1, x: 900, y: 300 },
    ]);
    level.objects[level.objects.length - 1].groups = [7];
    const sim = simOn(level, {}, "ship");
    const before = { x: 0, y: 0 };
    let tp = -1;
    for (let i = 0; i < 120 && tp < 0; i++) {
      before.x = sim.state.x;
      before.y = sim.state.y;
      const n = sim.events.length;
      sim.step(NO_INPUT);
      if (sim.events.slice(n).some((e) => e.detail === "teleport")) tp = sim.tick;
    }
    assert.ok(tp > 0, JSON.stringify(keys));
    const p = p1(sim);
    if (expectX !== null) assert.equal(p.x, expectX, `${JSON.stringify(keys)}: x`);
    else assert.ok(Math.abs(p.x - before.x) < 3, `${JSON.stringify(keys)}: kept x`);
    if (expectY !== null) assert.equal(p.y, expectY, `${JSON.stringify(keys)}: y`);
    else assert.ok(Math.abs(p.y - before.y) < 3, `${JSON.stringify(keys)}: kept y`);
  }
});

test("updateStaticForce: a push along the angle, set or added; no force and no add stops the player", () => {
  const len = (vx: number, vy: number): number => f(Math.sqrt(f(f(vx * vx) + f(vy * vy))));
  const up = new Player(world(), 1);
  up.yVel = 3;
  up.updateStaticForce(90, 18, false);
  const a = f(90 * DASH_DEG);
  const k = f(18 / len(f(Math.cos(a)), f(Math.sin(a))));
  assert.equal(up.yVel, f(f(Math.sin(a)) * k));
  assert.ok(Math.abs(up.yVel - 18) < 1e-5);
  assert.equal(up.isAccelerating, true);
  // Added, in a platformer: both axes, on top of what was there.
  const plat = new Player(world({ platformer: true }), 1);
  plat.xVel = 2;
  plat.yVel = 1;
  plat.updateStaticForce(0, 5, true);
  assert.ok(Math.abs(plat.xVel - 7) < 1e-5 && Math.abs(plat.yVel - 1) < 1e-5);
  // Rotated gameplay swaps the two halves: a push along x lands on y.
  const turned = new Player(world(), 1);
  turned.rotated = true;
  turned.updateStaticForce(0, 5, false);
  assert.ok(Math.abs(turned.yVel - 5) < 1e-5, "the x half on y");
  // No force, no add: a stop.
  const stop = new Player(world({ platformer: true }), 1);
  stop.xVel = 4;
  stop.yVel = -7;
  stop.isAccelerating = true;
  stop.updateStaticForce(45, 0, false);
  assert.deepEqual([stop.xVel, stop.yVel, stop.isAccelerating], [0, 0, false]);
});

test("a Teleport trigger with no group still pushes the player along its own x axis and marks the pass", () => {
  // Rotated -90, its x axis points up: a push of 10 upward. [:462450-462455]
  const sim = simOn(emptyLevel([{ id: 3022, x: 100, y: 300, rotation: -90, props: { 345: "1", 346: "10" } }]));
  let fired = -1;
  for (let i = 0; i < 120 && fired < 0; i++) {
    sim.step(NO_INPUT);
    if (p1(sim).yVel > 5) fired = sim.tick;
  }
  assert.ok(fired > 0);
  assert.ok(Math.abs(sim.state.x - 100) < 2, "no target: it stays where it is");
  assert.ok(Math.abs(p1(sim).yVel - 10) < 1e-4);
  assert.equal(p1(sim).teleported, true, "the next pass skips the band all the same");
});

test("a Teleport trigger's key 345 without key 346 stops a platformer player on both axes", () => {
  const level = buildLevel([...floor(0, 3000), { id: 3022, x: 60, y: 45, props: { 11: "1", 345: "1" } }], makeHeader({ platformer: true }));
  const sim = makeSim(level, undefined, { start: { x: 15, y: 45 } });
  const right = { jump: false, left: false, right: true };
  let stopped = -1;
  for (let i = 0; i < 60 && stopped < 0; i++) {
    const before = p1(sim).xVel;
    sim.step(right);
    if (before > 0 && p1(sim).xVel === 0) stopped = sim.tick;
  }
  assert.ok(stopped > 0, "the touch zeroed the x velocity");
  assert.equal(p1(sim).isAccelerating, false);
});

test("Deadlocked x 20860: the middle lane's teleport is met 12 units later and clears the spike wall", { skip: LEVELS }, async () => {
  // #11697's box starts at 20886.5, so the ship's centre is past 20871.5 when
  // it goes through; the old centred box took it at 20860.98, 1.5 units into
  // spikes #11700/#11701's column (20843.4-20848.6).
  const level = await loadOfficialLevel(20);
  for (const y of [140, 160]) {
    const sim = makeSim(level, undefined, { start: { x: 20790, y, mode: "ship", speed: 2, flipped: true } });
    let at = -1;
    for (let i = 0; i < 200 && !sim.state.dead && sim.state.x < 20930; i++) {
      const n = sim.events.length;
      sim.step(NO_INPUT);
      if (sim.events.slice(n).some((e) => e.detail === "teleport")) at = sim.state.x;
    }
    assert.equal(at, 20872.27734375, `y ${y}`);
    assert.equal(sim.state.dead, false, `y ${y}: alive past the wall`);
  }
});

test("Deadlocked x 22897: the lower lane's teleport clears the spikes at x 22858 the same way", { skip: LEVELS }, async () => {
  const level = await loadOfficialLevel(20);
  const sim = makeSim(level, undefined, { start: { x: 22840, y: 60, mode: "ufo", speed: 2 } });
  let at = -1;
  for (let i = 0; i < 200 && !sim.state.dead && sim.state.x < 22935; i++) {
    const n = sim.events.length;
    sim.step(NO_INPUT);
    if (sim.events.slice(n).some((e) => e.detail === "teleport")) at = sim.state.x;
  }
  assert.equal(at, 22881.9453125);
  assert.equal(sim.state.dead, false);
});

test("Dash's teleports carry their options: #6132 pushes 18 along its exit, the 2902s keep x", { skip: LEVELS }, async () => {
  const level = await loadOfficialLevel(22);
  const tp = level.objects[6132];
  assert.deepEqual([tp.id, tp.rotation, tp.flipX, tp.props[345], tp.props[346], tp.props[354]], [747, 90, true, "1", "18", "1"]);
  for (const i of [6395, 6407]) assert.deepEqual([level.objects[i].id, level.objects[i].props[352]], [2902, "1"]);
});

test("a linked portal pushes along its exit: turned 90 and flipped, as Dash's #6132, that is straight up", () => {
  // The exit is the portal's own 749, turned with it and flipped the other
  // way: 180 - 90 + 0 = 90. Key 354 = 1 rights a flipped ship first, then
  // key 345 sets its velocity to 18 up. [:462351-462374, :462388-462416,
  // :462467-462474; the exit's flip, PlayLayer::addObject :89945-89948]
  const level = emptyLevel([{ id: 747, x: 150, y: 90, rotation: 90, props: { 54: "150", 345: "1", 346: "18", 354: "1" } }]);
  level.objects[level.objects.length - 1].flipX = true;
  const sim = simOn(level, { y: 60, flipped: true }, "ship");
  assert.ok(runToTeleport(sim) > 0);
  assert.equal(sim.state.flipped, false);
  assert.ok(Math.abs(p1(sim).yVel - 18) < 1e-4, String(p1(sim).yVel));
});

test("key 347 takes the place of key 345's push", () => {
  // The portal above with key 347 as well: the force redirect it asks for is
  // not built, but with it set the portal never pushes. [:462467-462474]
  const level = emptyLevel([{ id: 747, x: 150, y: 90, rotation: 90, props: { 54: "150", 345: "1", 346: "18", 347: "1", 354: "1" } }]);
  level.objects[level.objects.length - 1].flipX = true;
  const sim = simOn(level, { y: 60, flipped: true }, "ship");
  assert.ok(runToTeleport(sim) > 0);
  assert.ok(Math.abs(p1(sim).yVel - 18) > 1, String(p1(sim).yVel));
});

test("Teleport triggers that fire together each run, in order: two gravity toggles cancel", () => {
  // Both at x 100, so one pass-by check fires both, and the game runs
  // teleportPlayer inside each. [EffectGameObject::triggerObject :314981;
  //  key 354 = 3 :462351-462374]
  for (const [count, flipped] of [
    [1, true],
    [2, false],
  ] as const) {
    const placed = Array.from({ length: count }, (_, k) => ({ id: 3022, x: 100, y: 300 + 30 * k, props: { 354: "3" } }));
    const sim = simOn(emptyLevel(placed), {}, "ship");
    for (let i = 0; i < 120 && sim.state.x < 110; i++) sim.step(NO_INPUT);
    assert.ok(sim.state.x >= 110 && !sim.state.dead);
    assert.equal(sim.state.flipped, flipped, `${count} toggle(s)`);
    assert.equal(sim.triggers.pendingTeleports.length, 0);
  }
});
