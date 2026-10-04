// The order of checkCollisions' object phase, pinned to the 2.206 decompile:
// everything that acts on a touch first, in the order the game keeps its
// objects; then the solids, last met first; then the hazards against where
// the solids left the player. The derivation is in
// data/ref/gd-discrepancies.md §10.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Level } from "../src/level/types";
import { Player } from "../src/physics/player";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { makeSim } from "./helpers";
import { buildLevel, emptyLevel, floor, HOLD, makeHeader, simOn, type Placed } from "./levelKit";

const EPS = 1e-9;
const YELLOW_PAD = 35;
const PINK_PAD = 140;
const SPIDER_PAD = 3005;
const SPIKE = 8;
const LINKED_TELEPORT = 747;
const TELEPORT_ENTRY = 2902;
const TELEPORT_EXIT = 2064;
const TELEPORT_ORB = 3027;
const GRAVITY_UP_PORTAL = 11;
const SLOPE_45 = 289;

function near(actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

function p1(sim: Sim): Player {
  return sim.state as Player;
}

function eventsAt(sim: Sim, tick: number): string[] {
  return sim.events.filter((e) => e.tick === tick).map((e) => (e.object === undefined ? e.type : `${e.type}#${e.object}`));
}

/** A level of the given objects and a far block that sets its length. */
function level(placed: Placed[]): Level {
  return buildLevel([...placed, { id: 1, x: 2985, y: 15 }]);
}

test("a pad under a landing fires before the landing", () => {
  // collisionCheckObjects (the pad) runs before the solids (the floor), and a
  // rising player is not landed. [checkCollisions :464959 before :464974-465003;
  // collidedWithObjectInternal LABEL_300 :151851-151914]
  const sim = simOn(emptyLevel([{ id: YELLOW_PAD, x: 15, y: 32 }]));
  const pad = sim.level.objects.length - 1;
  sim.step(NO_INPUT);
  assert.deepEqual(eventsAt(sim, 1), [`pad#${pad}`], "no landing on the pad tick");
  near(sim.state.y, 44.95140075683594, "the launch starts where the tick's gravity left the cube");
});

test("solids are met last-collected first, a section column at a time", () => {
  // Two blocks under a landing: the one met second is the one the stair snap
  // remembers. Within a section the game meets objects in level order; across
  // sections, column by column. [checkCollisions :464974-465003 (reverse walk),
  // :464929-464966 (sections); checkSnapJumpToObject]
  const landOn = (a: Placed, b: Placed, x: number): number => {
    const sim = makeSim(level([a, b]), undefined, { start: { x, y: 50 } });
    for (let t = 0; t < 60 && !sim.state.onGround; t++) sim.step(NO_INPUT);
    assert.ok(sim.state.onGround, "never landed");
    return p1(sim).snapObj;
  };
  // Both land on tick 14, 18.18 units on. Same section: level order, so block
  // 1 goes first and block 0 last, though block 0 is the nearer.
  assert.equal(landOn({ id: 1, x: 15, y: 15 }, { id: 1, x: 45, y: 15 }, 10), 0, "one section");
  // Block 0 in column 1 (x 105), block 1 in column 0 (x 75): column 0 is met
  // first, so block 0 goes first and block 1 last, though block 1 is the nearer.
  assert.equal(landOn({ id: 1, x: 105, y: 15 }, { id: 1, x: 75, y: 15 }, 70), 1, "two sections");
});

test("pads a pass meets together fire column by column, whatever their level order", () => {
  // The yellow pad is listed first but sits in column 1 (x 101); the pink pad
  // in column 0 (x 99) is met first, so the yellow one fires last and wins.
  const sim = makeSim(level([...floor(0, 300), { id: YELLOW_PAD, x: 101, y: 32 }, { id: PINK_PAD, x: 99, y: 32 }]), undefined, {
    start: { x: 100, y: 45 },
  });
  const yellow = 10;
  const pink = 11;
  sim.step(NO_INPUT);
  assert.deepEqual(
    sim.events.filter((e) => e.type === "pad").map((e) => e.object),
    [pink, yellow],
  );
  near(sim.state.yVel, 16, "the yellow pad's launch, 16 × 1 for a cube");
});

test("a hazard the player only reaches by sinking into a block is cleared by the landing", () => {
  // Spikes under the floor's top, reaching to 1 unit below it: the landing puts
  // the player back on the top before the hazards are looked at.
  // [checkCollisions :464974-465003 then :465008-465057]
  const spikes: Placed[] = [];
  for (let x = 10; x <= 200; x += 10) spikes.push({ id: SPIKE, x, y: 23 });
  const sim = simOn(emptyLevel(spikes), { y: 120 });
  for (let t = 0; t < 120 && !sim.state.onGround && !sim.state.dead; t++) sim.step(NO_INPUT);
  assert.equal(sim.state.dead, false, `killed by ${sim.state.killedBy}`);
  assert.equal(sim.state.y, 45);
});

test("a spider pad onto a spike: the same pass meets the spike at the new place", () => {
  // The pad fires in collisionCheckObjects; the jump lands the spider on the
  // spike in its way; the hazards, looked for after, kill it that pass.
  // [spiderTestJumpInternal :155171-155200; checkCollisions :465008-465057]
  const sim = simOn(
    emptyLevel([
      { id: SPIDER_PAD, x: 15, y: 35 },
      ...floor(0, 90, 195),
      { id: SPIKE, x: 15, y: 150, rotation: 180 },
    ]),
    { y: 43.5 },
    "spider",
  );
  const spike = sim.level.objects.length - 1;
  sim.step(NO_INPUT);
  assert.equal(sim.state.dead, true, "dead on the pad tick");
  assert.equal(sim.state.killedBy, spike);
  near(sim.state.y, 150, "on the spike");
});

// --- the box the walk reads --------------------------------------------------

test("a teleport is seen by the objects after it in its own section", () => {
  // collisionCheckObjects reads the player's box once per section, and again
  // after a teleport portal fires or a teleport orb is touched. A gravity
  // portal at the entry, next in level order, is then tested against the box
  // at the exit and never touched. The entry stands at 108, so that its box,
  // 12 to its right, covers the gravity portal's. [collisionCheckObjects
  // :463381-463386, :463749-463760 (the portal), :463858-463860 (the orb);
  // the box, GameObject::customSetup :179044-179052]
  const portal = emptyLevel([
    { id: TELEPORT_ENTRY, x: 108, y: 45, props: { 51: "7" } },
    { id: TELEPORT_EXIT, x: 1215, y: 45 },
    { id: GRAVITY_UP_PORTAL, x: 120, y: 45 },
  ]);
  portal.objects[portal.objects.length - 2].groups = [7];
  const viaPortal = simOn(portal);
  for (let t = 0; t < 80; t++) viaPortal.step(NO_INPUT);
  const entry = portal.objects.length - 3;
  assert.deepEqual(
    viaPortal.events.filter((e) => e.type === "portal").map((e) => `${e.tick}:${e.detail}#${e.object}`),
    [`60:teleport#${entry}`],
    "the portal: only the teleport",
  );
  assert.equal(viaPortal.state.flipped, false, "the portal: not flipped");

  // The orb, pressed on the pass the falling cube first touches it. Unpressed,
  // it still has the box read again, which finds the cube where it was.
  for (const [press, flipped] of [
    [true, false],
    [false, true],
  ] as const) {
    const orb = emptyLevel([
      { id: TELEPORT_ORB, x: 30, y: 150, props: { 51: "7" } },
      { id: TELEPORT_EXIT, x: 1215, y: 45 },
      { id: GRAVITY_UP_PORTAL, x: 30, y: 150 },
    ]);
    orb.objects[orb.objects.length - 2].groups = [7];
    const sim = simOn(orb, { y: 150 });
    sim.step(press ? HOLD : NO_INPUT);
    assert.deepEqual(
      eventsAt(sim, 1).filter((e) => e !== "flip"),
      press ? [`orb#${orb.objects.length - 3}`] : [`portal#${orb.objects.length - 1}`],
      `the orb, press ${press}: what the pass touched`,
    );
    assert.equal(sim.state.flipped, flipped, `the orb, press ${press}: flipped`);
  }
});

test("a slope's lift is seen by the objects after it in its own section", () => {
  // The slope, too, has the box read again, landed on or not. The cube runs up
  // the slope; the gravity portal after it, 82.5 up, is reached on the pass
  // whose slope snap lifts the cube's top past 82.5, not the pass after.
  // [collisionCheckObjects :463730-463732 → :463754-463760]
  const level = emptyLevel([
    { id: SLOPE_45, x: 165, y: 45 },
    { id: GRAVITY_UP_PORTAL, x: 185, y: 120 },
  ]);
  const portalBottom = 82.5;
  const sim = simOn(level, { x: 60 });
  let reached = -1;
  for (let t = 0; t < 120 && reached < 0; t++) {
    const before = sim.state.y + 15;
    sim.step(NO_INPUT);
    if (sim.state.y + 15 >= portalBottom) {
      reached = sim.tick;
      assert.ok(before < portalBottom, "reached from below in one pass");
      assert.ok(p1(sim).onSlope || p1(sim).wasOnSlope, "on the slope");
    }
  }
  assert.ok(reached > 0, "never reached");
  const flips = sim.events.filter((e) => e.type === "portal").map((e) => e.tick);
  assert.deepEqual(flips, [reached], "flipped on the pass that lifted it");
});

// --- the section window ------------------------------------------------------

test("a teleport out of the pass's sections meets what waits there a pass later", () => {
  // checkCollisions fixes the sections it collects from before the walk: the
  // player's column and the one either side. Solids and hazards are collected
  // nowhere else, and the teleport runs inside the walk, so the spike at the
  // exit (column 12) is not met on the pass that began in column 0.
  // [checkCollisions :464882-464966; collisionCheckObjects :463394-463430,
  // teleportPlayer :463753]
  const level = emptyLevel([
    { id: TELEPORT_ENTRY, x: 108, y: 45, props: { 51: "7" } },
    { id: TELEPORT_EXIT, x: 1215, y: 45 },
    { id: SPIKE, x: 1215, y: 45 },
  ]);
  level.objects[level.objects.length - 2].groups = [7];
  const spike = level.objects.length - 1;
  const sim = simOn(level);
  for (let t = 0; t < 200 && !sim.state.dead; t++) sim.step(NO_INPUT);
  const teleports = sim.events.filter((e) => e.detail === "teleport").map((e) => e.tick);
  assert.deepEqual(teleports, [60], "one teleport");
  assert.equal(sim.state.killedBy, spike);
  assert.equal(sim.tick, 61, "dead a pass after the teleport, not on it");
});

test("with rows, the window is three rows tall as well", () => {
  // A platformer or kA37 files objects in rows too, and the window takes the
  // player's row and the one either side. The linked portal lifts the cube 600
  // units, from row 1 into spikes in row 7: without rows the column holds them
  // and the teleport pass kills; with rows the next pass does.
  // [checkCollisions :464882-464910; LevelSettingsObject::shouldUseYSection
  // :195727-195733]
  const spikes: Placed[] = [];
  for (let x = 90; x <= 180; x += 30) spikes.push({ id: SPIKE, x, y: 645 });
  for (const [kA37, deathTick] of [
    [false, 14],
    [true, 15],
  ] as const) {
    // The portal at 93 puts its box, 12 to its right, at 105.
    const level = emptyLevel([{ id: LINKED_TELEPORT, x: 93, y: 45, props: { 54: "600" } }, ...spikes], makeHeader({ ySections: kA37 }));
    const sim = simOn(level, { x: 60 });
    for (let t = 0; t < 120 && !sim.state.dead; t++) sim.step(NO_INPUT);
    const teleports = sim.events.filter((e) => e.detail === "teleport").map((e) => e.tick);
    assert.deepEqual(teleports, [14], `kA37 ${kA37}: one teleport`);
    assert.equal(sim.state.killedBy, level.objects.length - spikes.length, `kA37 ${kA37}: killed by the first spike`);
    assert.equal(sim.tick, deathTick, `kA37 ${kA37}: the tick it dies`);
  }
});

test("a big block filed outside the window is met once the window reaches it, unless its collision is extended", () => {
  // A 300-unit block filed in column 3 reaches back to x 165, into column 1.
  // The cube running into it collects from its own column and the ones either
  // side, so it meets the block only from column 2 on, well inside it.
  // Extended collision (key 511) keeps the block out of the sections and has
  // every pass test it, so the cube dies on first contact.
  // [checkCollisions :464882-464970; addToSection :444818-444833]
  for (const [label, props, deathTick] of [
    ["filed in its section", {}, 143],
    ["extended", { 511: "1" }, 113],
  ] as const) {
    const level = emptyLevel([{ id: 1, x: 315, y: 165, scaleX: 10, scaleY: 10, props }]);
    const block = level.objects.length - 1;
    const sim = simOn(level);
    for (let t = 0; t < 200 && !sim.state.dead; t++) sim.step(NO_INPUT);
    assert.equal(sim.state.killedBy, block, `${label}: killed by the block`);
    assert.equal(sim.tick, deathTick, `${label}: the tick it dies`);
  }
  // Filed in its section, the pass that kills is the first one in column 2.
  const late = simOn(emptyLevel([{ id: 1, x: 315, y: 165, scaleX: 10, scaleY: 10 }]));
  for (let t = 0; t < 142; t++) late.step(NO_INPUT);
  assert.ok(late.state.x < 200 && !late.state.dead, `still in column 1 and alive at x ${late.state.x}`);
});
