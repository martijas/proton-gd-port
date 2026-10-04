// Follow (1347), Follow Player Y (1814), and the main object both of them and
// the rotate and scale centres resolve. The moved objects are plain blocks well
// above the player, read back through their hitboxes.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Level } from "../src/level/types";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { buildTriggerIndex } from "../src/triggers/spec";
import { emptyLevel, type Placed, simOn, stepN } from "./levelKit";

function withGroups(extra: Placed[], groups: Record<number, number[]>): { level: Level; at: (i: number) => number } {
  const level = emptyLevel(extra);
  const first = level.objects.length - extra.length;
  for (const [i, g] of Object.entries(groups)) level.objects[first + Number(i)].groups = g;
  return { level, at: (i) => first + i };
}

/** A block's centre, as the collision geometry has it. */
function centre(sim: Sim, index: number): [number, number] {
  const box = sim.hitboxOf(index);
  assert.ok(box && box.type === "rect");
  return [box.rect.x + box.rect.w / 2, box.rect.y + box.rect.h / 2];
}

function near(a: number, b: number, what: string, eps = 1e-6): void {
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
}

test("a Follow copies a rotation's motion", () => {
  // Group 2's block orbits group 3's block, 100 below it, a quarter turn
  // clockwise in 1 s: from (300, 600) to (400, 500). Group 4 follows group 2
  // and moves by the same (+100, -100). The port copied only Move triggers.
  // [gdp processFollowActions :428340-428420]
  const { level, at } = withGroups(
    [
      { id: 1346, x: 0, y: 300, props: { 51: "2", 71: "3", 68: "90", 10: "1" } },
      { id: 1347, x: 1, y: 300, props: { 51: "4", 71: "2", 72: "1", 73: "1", 10: "5" } },
      { id: 1, x: 300, y: 600 },
      { id: 1, x: 300, y: 500 },
      { id: 1, x: 600, y: 600 },
    ],
    { 2: [2], 3: [3], 4: [4] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 300);
  const [ox, oy] = centre(sim, at(2));
  near(ox, 400, "orbit x");
  near(oy, 500, "orbit y");
  const [fx, fy] = centre(sim, at(4));
  near(fx, 700, "follower x");
  near(fy, 500, "follower y");
});

test("a Follow made before its Move still copies all of it", () => {
  // Follows run after every other command, so creation order does not matter.
  // The port stepped commands in creation order and cleared what a Move had
  // done at the end of the step, so this Follow copied nothing.
  // [gdp processMoveActionsStep :469395-469401]
  const { level, at } = withGroups(
    [
      { id: 1347, x: 0, y: 300, props: { 51: "4", 71: "2", 72: "1", 73: "1", 10: "5" } },
      { id: 901, x: 1, y: 300, props: { 51: "2", 28: "30", 29: "90", 10: "0.5" } },
      { id: 1, x: 300, y: 600 },
      { id: 1, x: 600, y: 600 },
    ],
    { 2: [2], 3: [4] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 200);
  const [fx, fy] = centre(sim, at(3));
  near(fx, 630, "follower x");
  near(fy, 690, "follower y");
});

test("a Follow's mods default to 0", () => {
  // Only key 72 given: the x motion is copied and the y is not. The port
  // defaulted both to 1. [gdp EffectGameObject::customObjectSetup :298776-298826]
  const { level, at } = withGroups(
    [
      { id: 1347, x: 0, y: 300, props: { 51: "4", 71: "2", 72: "1", 10: "5" } },
      { id: 901, x: 1, y: 300, props: { 51: "2", 28: "30", 29: "90", 10: "0.5" } },
      { id: 1, x: 300, y: 600 },
      { id: 1, x: 600, y: 600 },
    ],
    { 2: [2], 3: [4] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 200);
  const [fx, fy] = centre(sim, at(3));
  near(fx, 630, "x copied");
  near(fy, 600, "y not");
});

test("a Follow's clock adds the float step, so half a second is 120 steps", () => {
  // The leader moves 1 a step for 4 s; a 0.5 s Follow copies 120 of them and a
  // 1 s one 240. The game adds fround(1/240) to the clock, which reaches 0.5
  // on step 120; the port added the double 1/240, which needs 121, and so
  // copied one step too many. [gdp GroupCommandObject2::step :716512-716537,
  // the float step from GJBaseGameLayer::update :469891]
  const run = (duration: string): number => {
    const { level, at } = withGroups(
      [
        { id: 1347, x: 0, y: 300, props: { 51: "4", 71: "2", 72: "1", 10: duration } },
        { id: 901, x: 1, y: 300, props: { 51: "2", 28: "960", 10: "4" } },
        { id: 1, x: 300, y: 600 },
        { id: 1, x: 600, y: 600 },
      ],
      { 2: [2], 3: [4] },
    );
    const sim = simOn(level);
    stepN(sim, NO_INPUT, 1000);
    return centre(sim, at(3))[0] - 600;
  };
  near(run("0.5"), 120, "half a second", 1e-9);
  near(run("1"), 240, "a second", 1e-9);
});

test("a Follow follows its group's parent, and nothing in a group of several without one", () => {
  // Group 2 holds blocks B (first in the file) and A; only A moves (group 5).
  // With A naming group 2 in key 274 the follower copies A; without it group 2
  // has no main object and the follower stays put. The port followed the
  // first member, B, in both. [gdp tryGetMainObject :423396-423405]
  const run = (parent: boolean): number => {
    const { level, at } = withGroups(
      [
        { id: 1347, x: 0, y: 300, props: { 51: "4", 71: "2", 72: "1", 73: "1", 10: "5" } },
        { id: 901, x: 1, y: 300, props: { 51: "5", 29: "60", 10: "0.5" } },
        { id: 1, x: 300, y: 600 },
        { id: 1, x: 360, y: 600, props: parent ? { 274: "2" } : {} },
        { id: 1, x: 600, y: 600 },
      ],
      { 2: [2], 3: [2, 5], 4: [4] },
    );
    const sim = simOn(level);
    stepN(sim, NO_INPUT, 200);
    return centre(sim, at(4))[1] - 600;
  };
  near(run(true), 60, "with a parent");
  near(run(false), 0, "without one");
});

test("a rotate turns about where its centre is now", () => {
  // Block C (group 3) moves up 150; then group 2, a block 30 to C's right,
  // turns half a turn about C: it ends 30 to C's left and 150 above C. The
  // port turned about C's place in the file, 150 below, which left the block
  // where it started, turned. [gdp processRotationActions :439939 →
  // getUnmodifiedPosition :167217-167226: the position now, less any area
  // trigger's offset]
  const { level, at } = withGroups(
    [
      { id: 901, x: 0, y: 300, props: { 51: "3", 29: "150", 10: "0.1" } },
      { id: 1268, x: 1, y: 300, props: { 51: "9", 63: "0.5" } },
      { id: 1346, x: 900, y: 900, props: { 62: "1", 51: "2", 71: "3", 68: "180", 10: "0.2" } },
      { id: 1, x: 300, y: 600 },
      { id: 1, x: 330, y: 600 },
    ],
    { 2: [9], 3: [3], 4: [2] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 240);
  const [cx, cy] = centre(sim, at(3));
  near(cx, 300, "centre x");
  near(cy, 750, "centre y");
  const [nx, ny] = centre(sim, at(4));
  near(nx, 270, "turned block x");
  near(ny, 900, "turned block y");
});

test("a rotate turns about its centre before this step's moves, whichever was made first", () => {
  // A Move sends centre C (group 3) up 150 and a Rotate, made after it, turns
  // group 2, a block 30 to C's right, half a turn about C; both land on the
  // same step. The rotations run before the moves, so the block turns about
  // C's old place and ends 30 to its left, at y 600. The port stepped them in
  // the order they were made and turned the block about C's new place, 150
  // up, which left it at y 900. [gdp processMoveActionsStep :469396-469398;
  // processRotationActions reads the pivot at :439939 before
  // processMoveActions :427806-427835 moves anything]
  const { level, at } = withGroups(
    [
      { id: 901, x: 0, y: 300, props: { 51: "3", 29: "150", 10: "0" } },
      { id: 1346, x: 1, y: 300, props: { 51: "2", 71: "3", 68: "180", 10: "0" } },
      { id: 1, x: 300, y: 600 },
      { id: 1, x: 330, y: 600 },
    ],
    { 2: [3], 3: [2] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 10);
  const [cx, cy] = centre(sim, at(2));
  near(cx, 300, "centre x");
  near(cy, 750, "centre y");
  const [nx, ny] = centre(sim, at(3));
  near(nx, 270, "turned block x");
  near(ny, 600, "turned block y");
});

// --- Move target mode --------------------------------------------------------

test("a target-mode Move measures from where both ends are now", () => {
  // Block T (group 3) moves up 150; half a second later a target-mode Move
  // sends block M (group 2) to T, which it now finds at (600, 750). The port
  // measured from the two blocks' places in the file and stopped at y 600.
  // [gdp getMoveTargetDelta :425096-425145, both positions live at
  //  :425139-425141]
  const { level, at } = withGroups(
    [
      { id: 901, x: 0, y: 300, props: { 51: "3", 29: "150", 10: "0.1" } },
      { id: 1268, x: 1, y: 300, props: { 51: "9", 63: "0.5" } },
      { id: 901, x: 900, y: 900, props: { 62: "1", 51: "2", 71: "3", 100: "1", 10: "0.2" } },
      { id: 1, x: 300, y: 600 },
      { id: 1, x: 600, y: 600 },
    ],
    { 2: [9], 3: [2], 4: [3] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 240);
  const [x, y] = centre(sim, at(3));
  near(x, 600, "x");
  near(y, 750, "y");
});

test("a dynamic Move aims at any member, with or without the 2.2 changes, from key 395", () => {
  // Groups 2 (blocks M and F) and 3 (two targets) have no parent, in a level
  // without kA40. A dynamic Move still finds a member of each, where a static
  // one would find nothing: the game picks one at random, the first member
  // stands in here. So M lands on the first target. With key 395 naming F's
  // own group 5 it is F that lands there instead. The port found no target,
  // so nothing moved, and it ignored 395.
  // [gdp activateMoveTrigger :443564-443569 → triggerDynamicMoveCommand
  //  :443366-443376 (tryGetObject, +1340 before +1276)]
  const run = (props: Record<number, string>): { m: [number, number]; f: [number, number] } => {
    const { level, at } = withGroups(
      [
        { id: 901, x: 0, y: 300, props: { 51: "2", 71: "3", 100: "1", 397: "1", 10: "0.5", ...props } },
        { id: 1, x: 300, y: 600 },
        { id: 1, x: 330, y: 630 },
        { id: 1, x: 600, y: 750 },
        { id: 1, x: 660, y: 750 },
      ],
      { 1: [2], 2: [2, 5], 3: [3], 4: [3] },
    );
    const sim = simOn(level);
    stepN(sim, NO_INPUT, 240);
    return { m: centre(sim, at(1)), f: centre(sim, at(2)) };
  };
  const plain = run({});
  near(plain.m[0], 600, "M onto the first target, x");
  near(plain.m[1], 750, "M onto the first target, y");
  const centred = run({ 395: "5" });
  near(centred.f[0], 600, "F onto the first target, x");
  near(centred.f[1], 750, "F onto the first target, y");
  near(centred.m[0], 570, "M keeps its place beside F, x");
  near(centred.m[1], 720, "M keeps its place beside F, y");
});

test("a dynamic Move covers its share of what is left, times the gap as it is now", () => {
  // Measured from block F, which it does not move, the gap never closes: each
  // of the 60 steps of a quarter second (linear) moves M by 1/60, 1/59, ...
  // 1/1 of it, so M ends up H(60) = 4.68 gaps along. The port rewrote the
  // move's total every step instead, which ran away when nothing closed it.
  // [gdp processDynamicObjectActions :445512-445526]
  const { level, at } = withGroups(
    [
      { id: 901, x: 0, y: 300, props: { 51: "2", 71: "3", 395: "5", 100: "1", 397: "1", 10: "0.25" } },
      { id: 1, x: 300, y: 600 },
      { id: 1, x: 330, y: 630 },
      { id: 1, x: 360, y: 640 },
    ],
    { 1: [2], 2: [5], 3: [3] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 240);
  let h = 0;
  for (let k = 1; k <= 60; k++) h += 1 / k;
  const [x, y] = centre(sim, at(1));
  near(x, 300 + 30 * h, "x", 1e-6);
  near(y, 600 + 10 * h, "y", 1e-6);
});

test("a dynamic Move measures its gap before this step's moves, whichever was made first", () => {
  // A Move, made first, carries target T (group 3) up 1 a step for a second;
  // a quarter-second dynamic Move sends M (group 2) to T. Dynamic moves run
  // before plain ones, so each step sees T where the last step left it, and
  // the last step lands M on T one step behind: y 659, not 660. The port
  // stepped them in the order they were made and caught T exactly.
  // [gdp processMoveActionsStep :469397-469398; the gap at :445524-445526,
  // before processMoveActions :427806-427835]
  const { level, at } = withGroups(
    [
      { id: 901, x: 0, y: 300, props: { 51: "3", 29: "240", 10: "1" } },
      { id: 901, x: 1, y: 300, props: { 51: "2", 71: "3", 100: "1", 397: "1", 10: "0.25" } },
      { id: 1, x: 300, y: 600 },
      { id: 1, x: 600, y: 600 },
    ],
    { 2: [2], 3: [3] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 120);
  const [x, y] = centre(sim, at(2));
  near(x, 600, "x", 1e-6);
  near(y, 659, "y", 1e-6);
});

// --- Follow Player Y ---------------------------------------------------------

test("Follow Player Y closes speed x the step in 60ths of the gap each step", () => {
  // Speed 1 at 240 Hz closes a quarter of the gap a step: the block at y 300
  // heads for the standing player's y, 45, 63.75 on the first step. With max
  // speed 2 it moves 0.5 a step. The port copied the player's y change times
  // key 105. The trigger at x 0 fires at the reset, so its first step is the
  // level's. [gdp processPlayerFollowActions :427914-428015; PlayLayer::
  //  resetLevel :105954-105963]
  const run = (props: Record<number, string>): [number, number] => {
    const { level, at } = withGroups(
      [
        { id: 1814, x: 0, y: 300, props: { 51: "6", 90: "1", 10: "-1", ...props } },
        { id: 1, x: 300, y: 300 },
      ],
      { 1: [6] },
    );
    const sim = simOn(level);
    stepN(sim, NO_INPUT, 1);
    const first = centre(sim, at(1))[1];
    stepN(sim, NO_INPUT, 59);
    return [first, centre(sim, at(1))[1]];
  };
  const [first, later] = run({});
  near(first, 300 - 63.75, "the first step");
  near(later, 45, "sixty steps on", 0.01);
  const [capped] = run({ 105: "2" });
  near(capped, 299.5, "max speed 2");
});

test("Follow Player Y moves each member by its own gap", () => {
  // Two blocks of group 6 at y 300 and 600 both head for the standing
  // player's 45: the first step takes a quarter of each one's own gap, and
  // sixty steps on both are there. The port moved the whole group by the
  // first member's step, so the upper block stayed 300 above the lower.
  // [gdp processPlayerFollowActions :427914-428015, per member :427983-428012]
  const { level, at } = withGroups(
    [
      { id: 1814, x: 0, y: 300, props: { 51: "6", 90: "1", 10: "-1" } },
      { id: 1, x: 300, y: 300 },
      { id: 1, x: 330, y: 600 },
    ],
    { 1: [6], 2: [6] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 1);
  near(centre(sim, at(1))[1], 300 - 63.75, "the lower block's first step");
  near(centre(sim, at(2))[1], 600 - 138.75, "the upper block's own");
  const hash = sim.stateHash();
  const snap = sim.snapshot();
  stepN(sim, NO_INPUT, 59);
  near(centre(sim, at(1))[1], 45, "lower, sixty steps on", 0.01);
  near(centre(sim, at(2))[1], 45, "upper, sixty steps on", 0.01);
  assert.notEqual(sim.stateHash(), hash, "the lifts are in the hash");
  const later = centre(sim, at(2))[1];
  sim.restore(snap);
  assert.equal(sim.stateHash(), hash, "and in the snapshot");
  near(centre(sim, at(2))[1], 600 - 138.75, "put back");
  stepN(sim, NO_INPUT, 59);
  assert.equal(centre(sim, at(2))[1], later, "the same path again");
});

test("the y history is only kept for a Follow Player Y with a delay", () => {
  // Without one the game reads the player's y as it is now, so a level whose
  // 1814s have none keeps no history, and its state hash carries none.
  // [gdp PlayerObject::getOldPosition :142151-142156]
  const kept = (props: Record<number, string>): boolean =>
    buildTriggerIndex(emptyLevel([{ id: 1814, x: 0, y: 300, props: { 51: "6", 90: "1", ...props } }]), (id) => id === 1814)
      .hasPlayerFollow;
  assert.equal(kept({}), false, "no delay");
  assert.equal(kept({ 91: "0" }), false, "a delay of 0");
  assert.equal(kept({ 91: "0.5" }), true, "half a second");
});

test("Follow Player Y with a delay waits for the history to fill", () => {
  // The player's y is kept a slot a hundredth of a second; the slots start at
  // game y 0, which means "nothing yet", so with a 0.5 s delay the block holds
  // still until half a second of history exists.
  // [gdp PlayerObject::getOldPosition :142151-142165, updateSpecial :142088-142110]
  const { level, at } = withGroups(
    [
      { id: 1814, x: 0, y: 300, props: { 51: "6", 90: "1", 91: "0.5", 10: "-1" } },
      { id: 1, x: 300, y: 300 },
    ],
    { 1: [6] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 100);
  near(centre(sim, at(1))[1], 300, "still waiting");
  stepN(sim, NO_INPUT, 100);
  assert.ok(centre(sim, at(1))[1] < 100, "on its way once the history is there");
});

test("Follow Player Y's history rides a snapshot, and a practice respawn keeps it", () => {
  // A restore puts the history back exactly, so the block retraces its path. A
  // respawn at a checkpoint does too: the player's reset empties the history,
  // but the checkpoint then hands back the history, the slot counter and the
  // clock. The port emptied it, so a delayed follower waited all over again.
  // [gdp PlayerObject::resetObject :153622-153627; saveToCheckpoint
  //  :161569-161571, loadFromCheckpoint :161651-161653]
  const { level, at } = withGroups(
    [
      { id: 1814, x: 0, y: 300, props: { 51: "6", 90: "1", 91: "0.5", 10: "-1" } },
      { id: 1, x: 900, y: 300 },
    ],
    { 1: [6] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 150);
  const snap = sim.snapshot();
  const hash = sim.stateHash();
  const held = centre(sim, at(1))[1];
  assert.ok(held < 300, "already on its way");
  stepN(sim, NO_INPUT, 100);
  const later = centre(sim, at(1))[1];
  sim.restore(snap);
  assert.equal(sim.stateHash(), hash, "the same state, the same hash");
  stepN(sim, NO_INPUT, 100);
  assert.equal(centre(sim, at(1))[1], later, "the same path again");
  sim.respawnFrom(snap);
  stepN(sim, NO_INPUT, 100);
  assert.equal(centre(sim, at(1))[1], later, "the same path after a respawn");
});
