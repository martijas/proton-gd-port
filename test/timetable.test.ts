// The level's clock without a player: the list of speed portals, reverses,
// time warps, turns and teleports that carry key 13, and the two walks over
// it the warm-up to a start position makes. Times are in seconds, points in
// the game's space (y is the port's + 90).
// [LevelTools::sortSpeedObjects, gd-ida-decomp.cpp:122945-123144;
//  timeForPos :123161-123449; posForTimeInternal :122123-122345]

import { test } from "node:test";
import assert from "node:assert/strict";
import type { LevelHeader } from "../src/level/types";
import { ObjectSet } from "../src/physics/collision";
import { TimeTable } from "../src/physics/timeTable";
import { loadObjectTable } from "./helpers";
import { emptyLevel, makeHeader, type Placed } from "./levelKit";

function table(extra: Placed[], header: LevelHeader = makeHeader(), groups: Record<number, number> = {}): TimeTable {
  const level = emptyLevel(extra, header);
  const first = level.objects.length - extra.length;
  for (const [i, g] of Object.entries(groups)) level.objects[first + Number(i)].groups = [g];
  const member = (g: number) => level.objects.findIndex((o) => o.groups.includes(g));
  return new TimeTable(level, new ObjectSet(level, loadObjectTable()), header.platformer, member);
}

test("with nothing on the list the run goes at the level's start speed", () => {
  // 311.580109 units a second at 1x, 251.16008 at 0.5x: the game's own floats.
  // [LevelTools::valueForSpeedMod :122098-122107; GeometryDash.exe 0x2e7f9d-0x2e7fc5]
  const plain = table([]);
  assert.equal(plain.timeForPos(3115.80109, 0, 0, 0), 10);
  assert.deepEqual(plain.posForTime(10), { x: 3115.801025390625, y: 0, channel: 0 });
  assert.equal(plain.timeForPos(0, 0, 0, 0), 0, "nothing at or left of x 0 takes time");
  assert.equal(table([], makeHeader({ startSpeed: 0 })).timeForPos(2511.6008, 0, 0, 0), 10);
});

test("a speed portal changes the pace where the player's box first meets its box", () => {
  // A 2x portal (51 wide) at x 1000 acts at 1000 - 25.5 - 15 = 959.5. Without
  // key 13 it is not on the list at all; with key 369 it acts at its own x.
  // [sortSpeedObjects :123115-123135; PlayLayer::addObject :90352-90360]
  const portal = (props: Record<number, string>): Placed => ({ id: 202, x: 1000, y: 105, props });
  const t = table([portal({ 13: "1" })]);
  assert.equal(t.size, 1);
  assert.equal(t.timeForPos(2000, 0, 0, 0), 5.765179634094238, "959.5 / 311.58 + 1040.5 / 387.42");
  assert.deepEqual(t.posForTime(5.765179634094238), { x: 2000, y: 0, channel: 0 });
  assert.deepEqual(t.posForTime(1), { x: 311.5801086425781, y: 0, channel: 0 });
  assert.equal(table([portal({})]).size, 0);
  assert.equal(table([portal({})]).timeForPos(2000, 0, 0, 0), 6.4188947677612305);
  assert.equal(table([portal({ 13: "1", 369: "1" })]).timeForPos(2000, 0, 0, 0), 5.790624618530273);
});

test("the list is walked in x order, whatever the level's order", () => {
  // 0.5x at 2000 is listed first; the 2x at 1000 still acts first.
  // [sortChannelOrderObjects :122777-122920, compOrder :120294-120318]
  const t = table([
    { id: 200, x: 2000, y: 105, props: { 13: "1" } },
    { id: 202, x: 1000, y: 105, props: { 13: "1" } },
  ]);
  assert.equal(t.timeForPos(3000, 0, 0, 0), 9.792215347290039, "959.5 / 311.58 + 1008 / 387.42 + 1032.5 / 251.16");
  assert.deepEqual(t.posForTime(9.792215347290039), { x: 3000, y: 0, channel: 0 });
});

test("a reverse turns the walk round, a time warp slows it, and a touch trigger acts at its edge", () => {
  // The Reverse at 1000 is passed at its own x; a touch-activated one 30 units
  // across, 15 short of its box. Time Warp 0.5 halves the pace after it.
  const reverse = table([{ id: 1917, x: 1000, y: 105, props: { 13: "1" } }]);
  assert.deepEqual(reverse.posForTime(4), { x: 753.6795654296875, y: 0, channel: 0 });
  const touch = table([{ id: 1917, x: 1000, y: 105, props: { 13: "1", 11: "1" } }]);
  assert.deepEqual(touch.posForTime(4), { x: 693.6795654296875, y: 0, channel: 0 });
  const warp = table([{ id: 1935, x: 1000, y: 105, props: { 13: "1", 120: "0.5" } }]);
  assert.equal(warp.timeForPos(2000, 0, 0, 0), 9.628341674804688, "1000 / 311.58 + 1000 / 155.79");
  assert.deepEqual(warp.posForTime(5), { x: 1278.9503173828125, y: 0, channel: 0 });
});

test("a Time Warp without key 120 warps to 0, and the walk stops there", () => {
  // customObjectSetup reads a missing key 120 as 0.0 and the walk divides by
  // it unclamped, so the point beyond is never reached.
  // [EffectGameObject::customObjectSetup :298914-298924; timeForPos :123326,
  //  :123438]
  const stall = table([{ id: 1935, x: 1000, y: 105, props: { 13: "1" } }]);
  assert.equal(stall.timeForPos(2000, 0, 0, 0), Infinity);
  assert.deepEqual(stall.posForTime(5), { x: 1000, y: 0, channel: 0 });
});

test("a turn sends the walk down from the turn's own point, on the channel it switches to", () => {
  // Orientation 3, direction 2: rotated, going down. Key 171/173 switch to
  // channel 1, which is what the warm-up's pass-by check then reads.
  const turn = table([{ id: 2900, x: 600, y: 105, props: { 13: "1", 166: "3", 167: "2", 171: "1", 173: "1" } }]);
  assert.deepEqual(turn.posForTime(1), { x: 311.5801086425781, y: 0, channel: 0 });
  assert.deepEqual(turn.posForTime(3), { x: 600, y: -139.74032592773438, channel: 1 }, "195 - (3 - 1.9257) × 311.58");
  assert.equal(turn.timeForPos(900, 0, 0, 0), 2.551510810852051, "to the turn, then the 195 down to y 0");
});

test("a teleport jumps the walk to its target group's object", () => {
  // The Teleport trigger at 600 sends it to the block at (1500, 300): game
  // y 390, so 195 up from the trigger's own point.
  // [sortSpeedObjects :122972-122980; posForTimeInternal :122264-122273]
  const t = table(
    [
      { id: 3022, x: 600, y: 105, props: { 13: "1", 51: "9" } },
      { id: 1, x: 1500, y: 300 },
    ],
    makeHeader(),
    { 1: 9 },
  );
  assert.deepEqual(t.posForTime(3), { x: 1834.7403564453125, y: 195, channel: 0 });
  assert.equal(t.timeForPos(2000, 0, 0, 0), 3.5303921699523926, "600 / 311.58 + 500 / 311.58");
});

test("a platformer's walk is 1x along x, whatever the list holds", () => {
  const t = table([{ id: 202, x: 1000, y: 105, props: { 13: "1" } }], makeHeader({ platformer: true }));
  assert.equal(t.timeForPos(3115.80109, 0, 0, 0), 10);
  assert.deepEqual(t.posForTime(2), { x: 623.1602172851562, y: 0, channel: 0 });
});
