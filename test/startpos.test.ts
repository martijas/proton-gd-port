// Where a run starts and in what state: start positions (object 31) and the
// warm-up to one, the header's start keys, and the reset's own pass-by check.
// [PlayLayer::addObject, gd-ida-decomp.cpp:90278-90315 (which start position);
//  GJBaseGameLayer::resetPlayer :425029-425078; setupLevelStart
//  :462728-462821; loadStartPosObject :469534-469590 → loadUpToPosition
//  :469428-469517; PlayLayer::resetLevel :105893-105963]

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickStartPosition } from "../src/level/decode";
import { modesOf, startModeOf } from "../src/physics/levelModes";
import { NO_INPUT } from "../src/physics/types";
import { loadObjectTable, makeSim } from "./helpers";
import { emptyLevel, makeHeader, simOn, stepN, type Placed } from "./levelKit";

/** A start position standing on the floor at x. */
function start(x: number, settings: Record<string, string> = {}, y = 45): Placed {
  return { id: 31, x, y, settings };
}

// --- which start position ---------------------------------------------------------

test("the start position with the highest target order wins, then the one furthest along", () => {
  // Further along is further right, or further left for a reversed one; a
  // tie in x keeps the first, and a disabled one never counts.
  const picked = (list: Placed[]) => pickStartPosition(emptyLevel(list))?.x ?? null;
  assert.equal(picked([start(900, { kA19: "0" }), start(300, { kA19: "2" }), start(600, { kA19: "1" })]), 300);
  assert.equal(picked([start(300), start(900), start(600)]), 900);
  assert.equal(picked([start(300), start(900, { kA21: "1" })]), 300);
  assert.equal(picked([start(600, { kA20: "1" }), start(300, { kA20: "1" }), start(900, { kA20: "1" })]), 300);
  assert.equal(picked([start(600, { kA21: "1" })]), null);
  assert.equal(pickStartPosition(emptyLevel([start(600, { kA2: "1" }), start(600, { kA2: "2" })]))?.mode, "ship");
});

// --- the start state ----------------------------------------------------------------

test("a run starts at the start position, in its state, and is a test", () => {
  const sim = makeSim(emptyLevel([start(900, { kA2: "1", kA4: "2", kA3: "1", kA11: "1" }, 105)]));
  const s = sim.state;
  assert.deepEqual([s.x, s.y, s.mode, s.speed, s.mini, s.flipped, s.reversed, s.rotated], [900, 105, "ship", 2, true, true, false, false]);
  assert.equal(sim.startPosition, 100, "the object's index");
  assert.equal(makeSim(emptyLevel([start(900, { kA21: "1" })])).startPosition, -1, "a disabled one is no start");
});

test("the band hangs from the start position until a portal takes over", () => {
  // A ship at y 405: 405 - 150 = 255, snapped down to 240.
  // [GJBaseGameLayer::getTargetFlyCameraY :420349-420385]
  const sim = makeSim(emptyLevel([start(900, { kA2: "1" }, 405)]));
  assert.deepEqual([sim.floorY, sim.ceilingY], [240, 540]);
  const none = makeSim(emptyLevel([], makeHeader({ startMode: "ship" })));
  assert.deepEqual([none.floorY, none.ceilingY], [0, 300]);
});

test("the spawn group sets a classic level's y and a platformer's x and y, from its main object", () => {
  const spawnAt = (platformer: boolean, members: Placed[], parent = -1) => {
    const level = emptyLevel(members, makeHeader({ spawnGroup: 4, platformer }));
    const first = level.objects.length - members.length;
    members.forEach((_, i) => (level.objects[first + i].groups = [4]));
    if (parent >= 0) level.objects[first + parent].props[274] = "4";
    const s = makeSim(level).state;
    return [s.x, s.y];
  };
  const one = [{ id: 1, x: 450, y: 165 }];
  assert.deepEqual(spawnAt(false, one), [0, 165]);
  assert.deepEqual(spawnAt(true, one), [450, 165]);
  const three = [
    { id: 1, x: 450, y: 165 },
    { id: 1, x: 750, y: 225 },
    { id: 1, x: 150, y: 285 },
  ];
  assert.deepEqual(spawnAt(true, three, 2), [150, 285], "the parent");
  assert.deepEqual(spawnAt(true, three.slice(0, 2)), [450, 165], "the first member stands in for the game's random one");
});

test("kA29 turns player 1 at the start, and a platformer starts a wave or swing as a cube", () => {
  assert.equal(makeSim(emptyLevel([], makeHeader({ startRotated: true }))).state.rotated, true);
  assert.equal(makeSim(emptyLevel([], makeHeader({ startMode: "wave", platformer: true }))).state.mode, "cube");
  assert.equal(makeSim(emptyLevel([], makeHeader({ startMode: "wave" }))).state.mode, "wave");
  assert.equal(makeSim(emptyLevel([start(600, { kA2: "7", kA22: "1" })])).state.mode, "cube", "the start position's own kA22 counts");
});

test("the icons loaded before the first attempt are for the mode the run starts in", () => {
  const table = loadObjectTable();
  const modes = (level: Parameters<typeof modesOf>[0]) => [...modesOf(level, table)];
  assert.deepEqual(modes(emptyLevel([start(600, { kA2: "1" })])), ["ship"]);
  assert.deepEqual(modes(emptyLevel([], makeHeader({ startMode: "swing", platformer: true }))), ["cube"]);
  assert.deepEqual(modes(emptyLevel([start(600, { kA2: "4", kA22: "1" })])), ["cube"]);
  // The sim and the icons read the one rule; a run started elsewhere passes no start position.
  const level = emptyLevel([start(600, { kA2: "1" })], makeHeader({ startMode: "ball" }));
  assert.deepEqual([startModeOf(level), startModeOf(level, null)], ["ship", "ball"]);
});

// --- the warm-up ------------------------------------------------------------------

test("the warm-up runs the level up to the start position", () => {
  // A Move at x 300 lifts group 2 by 60 over 0.5 s; the run reaches x 900
  // 2.8885 s in, so the move is long done when the player starts.
  const level = emptyLevel([
    { id: 901, x: 300, y: 300, props: { 51: "2", 28: "0", 29: "60", 10: "0.5" } },
    { id: 1, x: 1200, y: 300 },
    start(900),
  ]);
  const block = level.objects.length - 2;
  level.objects[block].groups = [2];
  const sim = makeSim(level);
  const box = sim.hitboxOf(block);
  assert.ok(box && box.type === "rect");
  assert.equal(box.rect.y + box.rect.h / 2, 360);
  assert.equal(sim.tick, 0, "no step has been taken");
  assert.equal(sim.startTime, 2.888505021110177, "sixtieths of a second up to 900 / 311.58, summed as the game sums them");
  // The walk runs the music clock alone; the level time the reset zeroed
  // starts with the run. [loadUpToPosition :469472-469474; resetLevel :105896]
  assert.equal(sim.triggers.musicTime, sim.startTime);
  assert.equal(sim.triggers.levelTime, 0);
});

test("a spawn delay running at the start runs on from where the warm-up left it", () => {
  // The Spawn at x 300 fires in the warm-up's 58th sixtieth; its 3 s end
  // 1.0782 s into the run.
  const level = emptyLevel([
    { id: 1268, x: 300, y: 300, props: { 51: "7", 63: "3" } },
    { id: 1817, x: 0, y: 900, props: { 62: "1", 80: "1", 77: "1" } },
    start(900),
  ]);
  level.objects[level.objects.length - 2].groups = [7];
  const sim = makeSim(level);
  let at = -1;
  for (let t = 0; t < 400 && at < 0; t++) {
    sim.step(NO_INPUT);
    if (sim.triggers.itemCount(1) === 1) at = sim.tick;
  }
  assert.equal(at, 259);
});

test("the warm-up ends on the channel its walk is on, and keeps its audio triggers with their times", () => {
  // A channel-only turn at x 300 with key 13 moves the walk to channel 1: the
  // Pickup on channel 1 fires once the player passes it, the one on channel 0
  // does not, and neither does the SFX trigger at x 400, which is on channel
  // 0. Both Song triggers are noted with the music time they fired at, the one
  // at x 200 0.65 s in (the walk's 39th sixtieth); the music's start plays
  // what they left running.
  // [activatedAudioTrigger :447750-447840; PlayLayer::startMusic
  //  :105410-105415 → processActivatedAudioTriggers :454746-454962]
  const level = emptyLevel([
    { id: 1934, x: 100, y: 300, props: { 392: "6" } },
    { id: 1934, x: 200, y: 300, props: { 392: "7" } },
    { id: 2900, x: 300, y: 300, props: { 13: "1", 166: "2", 167: "4", 171: "1", 172: "1", 173: "1" } },
    { id: 3602, x: 400, y: 300, props: { 392: "5" } },
    { id: 1817, x: 1000, y: 300, props: { 80: "1", 77: "1", 170: "1" } },
    { id: 1817, x: 1000, y: 300, props: { 80: "2", 77: "1" } },
    start(900),
  ]);
  const sim = makeSim(level);
  assert.deepEqual(
    sim.triggers.events.map((e) => [e.kind, e.id]),
    [["song", 6], ["song", 7]],
  );
  assert.deepEqual(
    sim.triggers.events.map((e) => e.at),
    [0.3333333507180214, 0.6500000339001417],
  );
  const at = sim.triggers.events[1].at ?? -1;
  assert.ok(Math.abs(at - 39 / 60) < 1e-4, `the song fired at ${at}`);
  stepN(sim, NO_INPUT, 120);
  assert.deepEqual([sim.triggers.itemCount(1), sim.triggers.itemCount(2)], [1, 0]);
});

test("after the warm-up the pass-by check runs once more from the start position itself", () => {
  // The walk's last point can stop a float short of the start position, as
  // it does at these three, so a trigger at the start position's own x fires
  // in the check PlayLayer::init makes once the reset is done.
  // [PlayLayer::init :106486, after resetLevel :106465]
  for (const x of [255, 495, 990]) {
    const sim = makeSim(emptyLevel([{ id: 1817, x, y: 300, props: { 80: "1", 77: "1" } }, start(x)]));
    assert.equal(sim.triggers.itemCount(1), 1, `x ${x}`);
  }
});

test("a Teleport trigger on the way moves player 1, and the next step's move is measured from there", () => {
  // Group 3's block follows player 1's x (key 58) for the whole walk. The
  // Teleport at x 300 sends player 1 back to group 7's block at x 0, so the
  // next step carries the block the whole way back up, and it ends up that
  // much further on. Player 1 still starts on the start position.
  // [loadUpToPosition :469476-469480; teleportPlayer :462274-462314]
  const run = (teleport: boolean) => {
    const placed: Placed[] = [
      { id: 901, x: 30, y: 300, props: { 51: "3", 58: "1", 10: "20" } },
      { id: 1, x: 1200, y: 300 },
      { id: 3022, x: 300, y: 300, props: { 51: teleport ? "7" : "8" } },
      { id: 1, x: 0, y: 45 },
      start(900),
    ];
    const level = emptyLevel(placed);
    const first = level.objects.length - placed.length;
    level.objects[first + 1].groups = [3];
    level.objects[first + 3].groups = [7];
    const sim = makeSim(level);
    return { block: sim.triggers.objectPosition(first + 1)[0], player: sim.state.x };
  };
  const plain = run(false);
  const moved = run(true);
  assert.deepEqual([plain.player, moved.player], [900, 900]);
  const extra = moved.block - plain.block;
  assert.ok(extra >= 300 && extra < 306, `the walk point the teleport left from, got ${extra}`);
});

test("an End trigger on the way ends the run before its first step", () => {
  // The End trigger at x 300 fires in the walk, which nothing in the game
  // checks for loading: it locks the players and stops the level time, so
  // the run from x 900 is over at once and the End trigger at x 1500 never
  // acts. [PlayLayer::activatePlatformerEndTrigger :93034-93065 →
  //  playPlatformerEndAnimationToPos :92922-93030]
  const sim = makeSim(emptyLevel([{ id: 3600, x: 300, y: 200 }, start(900), { id: 3600, x: 1500, y: 100 }]));
  assert.equal(sim.state.finished, true);
  assert.deepEqual([sim.tick, sim.state.x], [0, 900]);
  assert.deepEqual(sim.end, { x: 300, y: 200, instant: false, effects: true, sound: true });
  assert.ok(sim.events.some((e) => e.type === "finish"));
  sim.step(NO_INPUT);
  assert.deepEqual([sim.tick, sim.triggers.levelTime], [0, 0]);
});

// --- the reset's pass-by check -------------------------------------------------------

test("what sits at or behind the player's start fires at the reset, before the first step", () => {
  // [PlayLayer::resetLevel :105954-105963]
  const sim = makeSim(
    emptyLevel([
      { id: 1817, x: 0, y: 300, props: { 80: "1", 77: "1" } },
      { id: 1817, x: 30, y: 300, props: { 80: "2", 77: "1" } },
    ]),
  );
  assert.deepEqual([sim.triggers.itemCount(1), sim.triggers.itemCount(2)], [1, 0]);
  const debug = simOn(emptyLevel([{ id: 1817, x: 15, y: 300, props: { 80: "1", 77: "1" } }]));
  assert.equal(debug.triggers.itemCount(1), 1, "a debug start checks from where it puts the player");
});

test("the warm-up is the same every time, and a snapshot after it rewinds as any other", () => {
  const level = emptyLevel([
    { id: 1268, x: 300, y: 300, props: { 51: "7", 63: "3" } },
    { id: 1817, x: 0, y: 900, props: { 62: "1", 80: "1", 77: "1" } },
    start(900),
  ]);
  level.objects[level.objects.length - 2].groups = [7];
  const a = makeSim(level);
  const b = makeSim(level);
  assert.equal(a.stateHash(), b.stateHash());
  const snap = a.snapshot();
  stepN(a, NO_INPUT, 300);
  const [x, item] = [a.state.x, a.triggers.itemCount(1)];
  a.restore(snap);
  stepN(a, NO_INPUT, 300);
  assert.deepEqual([a.state.x, a.triggers.itemCount(1)], [x, item]);
  assert.equal(item, 1);
});
