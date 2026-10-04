// A platformer's checkpoint object (2063) lays down a checkpoint at the end
// of the step it is touched in, in a normal run as in practice, with player
// 1 put at the respawn point; its key 51 spawns after, and key 448 on every
// respawn from it. A classic level's only flashes. Only one with key 11 is
// touched at all; the editor sets it on every checkpoint it places.
// [gdp PlayLayer::checkpointActivated :86960-86965, PlayLayer::postUpdate
//  :105309-105362, resetLevel :105893-105973]

import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { buildLevel, floor, makeHeader, simOn, type Placed } from "./levelKit";
import { makeSim } from "./helpers";

const RIGHT = { jump: false, left: false, right: true };

function platformer(extra: Placed[]): Sim {
  const level = buildLevel([...floor(0, 3000), ...extra], makeHeader({ platformer: true }));
  const n = level.objects.length;
  for (const [i, o] of level.objects.entries()) if (i >= n - extra.length && o.props[57]) o.groups = o.props[57].split(".").map(Number);
  return makeSim(level, undefined, { start: { x: 15, y: 45 } });
}

function walkToCheckpoint(sim: Sim, max = 240): SimSnapshotLike | null {
  for (let i = 0; i < max; i++) {
    sim.step(RIGHT);
    const laid = sim.takePlatformerCheckpoint();
    if (laid) return laid;
  }
  return null;
}
type SimSnapshotLike = ReturnType<Sim["snapshot"]>;

test("touching a platformer's checkpoint lays one down at the object, and a respawn goes there", () => {
  const sim = platformer([{ id: 2063, x: 120, y: 60, props: { 11: "1" } }]);
  const laid = walkToCheckpoint(sim);
  assert.ok(laid, "laid down");
  assert.equal(sim.takePlatformerCheckpoint(), null, "taken once");
  for (let i = 0; i < 30; i++) sim.step(RIGHT);
  sim.respawnFrom(laid!);
  assert.deepEqual([sim.state.x, sim.state.y], [120, 60], "at the object, not where the player touched it");
});

test("key 138 keeps the player where it stood; key 71 sends it to that group's main object", () => {
  const kept = platformer([{ id: 2063, x: 120, y: 60, props: { 11: "1", 138: "1" } }]);
  const laid = walkToCheckpoint(kept)!;
  const at = [kept.state.x, kept.state.y];
  for (let i = 0; i < 30; i++) kept.step(RIGHT);
  kept.respawnFrom(laid);
  assert.deepEqual([kept.state.x, kept.state.y], at);
  const moved = platformer([
    { id: 2063, x: 120, y: 60, props: { 11: "1", 71: "9" } },
    { id: 1, x: 600, y: 300, props: { 57: "9" } },
  ]);
  const there = walkToCheckpoint(moved)!;
  moved.respawnFrom(there);
  assert.deepEqual([moved.state.x, moved.state.y], [600, 300]);
});

test("key 51 spawns after the checkpoint is laid down, and key 448 on each respawn", () => {
  // Group 5's Pickup adds to item 1, group 6's to item 2.
  const sim = platformer([
    { id: 2063, x: 120, y: 60, props: { 11: "1", 51: "5", 448: "6" } },
    { id: 1817, x: 0, y: 900, props: { 57: "5", 62: "1", 87: "1", 80: "1", 77: "1" } },
    { id: 1817, x: 0, y: 900, props: { 57: "6", 62: "1", 87: "1", 80: "2", 77: "1" } },
  ]);
  const laid = walkToCheckpoint(sim)!;
  assert.deepEqual([sim.triggers.itemCount(1), sim.triggers.itemCount(2)], [1, 0], "key 51, after the snapshot");
  sim.respawnFrom(laid);
  assert.deepEqual([sim.triggers.itemCount(1), sim.triggers.itemCount(2)], [0, 1], "the snapshot has no key-51 spawn; key 448 spawned");
  sim.respawnFrom(laid);
  assert.equal(sim.triggers.itemCount(2), 1, "each respawn starts from the snapshot again");
});

test("a respawn from it lets go of the button, stops the fall and takes the player off the ground", () => {
  // Jumped through with the button held: the saved state is rising and
  // holding, and neither comes back; touched standing: the saved state is on
  // the ground, and the respawn is not. [PlayerObject::loadFromCheckpoint
  //  :161737-161743, for the flag PlayLayer::postUpdate sets :105345]
  type Held = { holding: boolean; yVel: number; onGround: boolean };
  const player = (s: Sim): Held => (s as unknown as { p1: Held }).p1;
  const saved = (snap: SimSnapshotLike): Held => (snap.opaque as { p1: Held }).p1;
  const jumping = platformer([{ id: 2063, x: 120, y: 90, props: { 11: "1" } }]);
  let laid: SimSnapshotLike | null = null;
  for (let i = 0; i < 240 && !laid; i++) {
    jumping.step({ jump: true, left: false, right: true });
    laid = jumping.takePlatformerCheckpoint();
  }
  assert.ok(laid);
  assert.equal(saved(laid).holding, true);
  assert.notEqual(saved(laid).yVel, 0);
  jumping.respawnFrom(laid);
  assert.deepEqual([player(jumping).holding, player(jumping).yVel, player(jumping).onGround], [false, 0, false]);
  const standing = platformer([{ id: 2063, x: 120, y: 45, props: { 11: "1", 138: "1" } }]);
  const there = walkToCheckpoint(standing)!;
  assert.equal(saved(there).onGround, true);
  standing.respawnFrom(there);
  assert.equal(player(standing).onGround, false);
});

test("a classic level's checkpoint object lays nothing down", () => {
  const sim = simOn(buildLevel([...floor(0, 3000), { id: 2063, x: 120, y: 45, props: { 11: "1" } }]));
  for (let i = 0; i < 120; i++) {
    sim.step(NO_INPUT);
    assert.equal(sim.takePlatformerCheckpoint(), null);
  }
  assert.ok(sim.events.some((e) => e.type === "checkpoint"), "it was touched");
});

test("a spawned checkpoint object lays one down too", () => {
  // The tower's #14427 (5004) is spawn-only with key 138.
  const sim = platformer([
    { id: 1268, x: 60, y: 45, props: { 11: "1", 51: "4" } },
    { id: 2063, x: 900, y: 600, props: { 57: "4", 62: "1" } },
  ]);
  const laid = walkToCheckpoint(sim);
  assert.ok(laid);
  sim.respawnFrom(laid!);
  assert.deepEqual([sim.state.x, sim.state.y], [900, 600]);
});

test("a checkpoint object without key 11 is walked through: The Secret Hollow's #14427 lays nothing", () => {
  // #14427 (5004) is spawn-only with key 138 and has no key 11; here it sits
  // in the player's path and nothing spawns it. The collision pass fires a
  // checkpoint object only with key 11, in either kind of level.
  // [collisionCheckObjects case 0x14 :463671-463673 → playerTouchedTrigger,
  //  gated on +1284 :456793; +1284 from key 11 :298669-298675]
  const sim = platformer([{ id: 2063, x: 120, y: 45, props: { 62: "1", 107: "1", 116: "1", 138: "1" } }]);
  assert.equal(walkToCheckpoint(sim), null);
  assert.ok(sim.state.x > 150, "walked through it");
  assert.ok(!sim.events.some((e) => e.type === "checkpoint"));
  const plain = platformer([{ id: 2063, x: 120, y: 45 }]);
  assert.equal(walkToCheckpoint(plain), null);
  const classic = simOn(buildLevel([...floor(0, 3000), { id: 2063, x: 120, y: 45 }]));
  for (let i = 0; i < 120; i++) classic.step(NO_INPUT);
  assert.ok(!classic.events.some((e) => e.type === "checkpoint"), "not even the flash");
});

test("what key 51 fires acts in the step that lays the checkpoint, so a snapshot there keeps it", () => {
  // Group 5 holds a spawn-only Rotate Gameplay, which the game runs inside
  // postUpdate's spawn. [gdp PlayLayer::postUpdate :105352-105359]
  const make = () =>
    platformer([
      { id: 2063, x: 120, y: 60, props: { 11: "1", 51: "5" } },
      { id: 2900, x: 0, y: 900, props: { 57: "5", 62: "1", 166: "3" } },
    ]);
  const rotated = (s: Sim): boolean => (s as unknown as { p1: { rotated: boolean } }).p1.rotated;
  const straight = make();
  assert.ok(walkToCheckpoint(straight));
  assert.equal(rotated(straight), true, "turned in the laying step");
  assert.equal(straight.triggers.pendingRotations.length, 0);
  const resumed = make();
  assert.ok(walkToCheckpoint(resumed));
  resumed.restore(resumed.snapshot());
  for (let i = 0; i < 30; i++) {
    straight.step(RIGHT);
    resumed.step(RIGHT);
  }
  assert.deepEqual([resumed.state.x, resumed.state.y, rotated(resumed)], [straight.state.x, straight.state.y, true]);
  assert.equal(resumed.stateHash(), straight.stateHash());
});

test("a checkpoint object that key 51 fires lays nothing: the game forgets it once the spawn is over", () => {
  // [gdp PlayLayer::postUpdate clears +12104 after the spawn, :105361]
  const sim = platformer([
    { id: 2063, x: 120, y: 60, props: { 11: "1", 51: "5" } },
    { id: 2063, x: 900, y: 600, props: { 57: "5", 62: "1" } },
  ]);
  assert.ok(walkToCheckpoint(sim));
  assert.equal(sim.triggers.pendingCheckpoint, -1);
  for (let i = 0; i < 30; i++) {
    sim.step(RIGHT);
    assert.equal(sim.takePlatformerCheckpoint(), null);
  }
});

test("what key 448 fires acts in the respawn itself, once the player is back", () => {
  // Group 6 holds a spawn-only Teleport trigger to group 7's block.
  // [gdp PlayLayer::resetLevel :105965-105973, after loadLastCheckpoint :105893]
  const sim = platformer([
    { id: 2063, x: 120, y: 60, props: { 11: "1", 448: "6" } },
    { id: 3022, x: 0, y: 900, props: { 57: "6", 62: "1", 51: "7" } },
    { id: 1, x: 600, y: 300, props: { 57: "7" } },
  ]);
  const laid = walkToCheckpoint(sim)!;
  sim.respawnFrom(laid);
  assert.deepEqual([sim.state.x, sim.state.y], [600, 300]);
  assert.equal(sim.triggers.pendingTeleports.length, 0);
});
