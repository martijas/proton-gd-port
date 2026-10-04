// Items, counters and the triggers that read them: Pickup (1817), Count (1611),
// Instant Count (1811), Item Edit (3619), Item Compare (3620), and the
// collectibles (object type 30) that feed them. Every level here is a flat
// floor with the triggers at the far left, so they fire on the first step in
// x order, and the groups they spawn hold Pickup triggers whose items say
// which way a test went.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Level } from "../src/level/types";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { buildLevel, emptyLevel, floor, HOLD, type Placed, settle, simOn, stepN } from "./levelKit";
import { makeSim } from "./helpers";

/** A spawn-only Pickup that adds one to `item`: what a spawned group holds to say it fired. */
function marker(item: number, x = 900): Placed {
  return { id: 1817, x, y: 900, props: { 62: "1", 87: "1", 80: String(item), 77: "1" } };
}

/** The level, with `groups[i]` given to the object at `extra` index i (floor objects come first). */
function withGroups(extra: Placed[], groups: Record<number, number[]>): Level {
  const level = emptyLevel(extra);
  const first = level.objects.length - extra.length;
  for (const [i, g] of Object.entries(groups)) level.objects[first + Number(i)].groups = g;
  return level;
}

function count(sim: Sim, item: number): number {
  return sim.triggers.itemCount(item);
}

// --- Item Compare -------------------------------------------------------------

test("Item Compare tests item 80 times 479 against 483 by the test in 482", () => {
  // Item 1 is 3. 3 x 1 >= 3 spawns group 10; the same with "less than" spawns
  // group 13, its false group. The port read keys 476/477 as the two item ids
  // and 88 as the test, so it compared item 1 with item 0 for equality and
  // took the false branch of both. [gdp activateItemCompareTrigger :429330-429472]
  const compare = (test482: string, x: number, yes: number, no: number): Placed => ({
    id: 3620,
    x,
    y: 300,
    props: { 80: "1", 476: "1", 479: "1", 480: "3", 481: "3", 482: test482, 483: "3", 51: String(yes), 71: String(no) },
  });
  const level = withGroups(
    [{ id: 1817, x: 0, y: 300, props: { 80: "1", 77: "3" } }, compare("2", 1, 10, 11), compare("3", 2, 12, 13), marker(2), marker(3), marker(4), marker(5)],
    { 3: [10], 4: [11], 5: [12], 6: [13] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  assert.deepEqual([count(sim, 2), count(sim, 3)], [1, 0], ">= : true");
  assert.deepEqual([count(sim, 4), count(sim, 5)], [0, 1], "< : false");
});

test("Item Compare's tolerance, rounding and sign", () => {
  // Item 1 is -7. Left side -7 / 2 = -3.5: rounded (485 = 1) away from zero
  // to -4, made positive (578 = 1): 4, equal to 4. Floor (2) gives -4 and 4
  // too; ceiling (3) gives -3, so 3, and 3 != 4 within 0.5 tolerance fails
  // the equality and passes "not equal" (482 = 5) only beyond it.
  // [gdp performMathRounding :429269-429284, performMathSign :429300-429314]
  const side = (round: string, test482: string, tol: string, g: number, x: number): Placed => ({
    id: 3620,
    x,
    y: 300,
    props: { 80: "1", 476: "1", 479: "2", 480: "4", 485: round, 578: "1", 483: "4", 482: test482, 484: tol, 51: String(g) },
  });
  const level = withGroups(
    [
      { id: 1817, x: 0, y: 300, props: { 80: "1", 77: "-7", 139: "1" } },
      side("1", "0", "0", 10, 1),
      side("2", "0", "0", 11, 2),
      side("3", "0", "0", 12, 3),
      side("3", "0", "1", 13, 4),
      side("3", "5", "1", 14, 5),
      side("3", "5", "0.5", 15, 6),
      marker(1 + 10),
      marker(1 + 11),
      marker(1 + 12),
      marker(1 + 13),
      marker(1 + 14),
      marker(1 + 15),
    ],
    { 7: [10], 8: [11], 9: [12], 10: [13], 11: [14], 12: [15] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  assert.deepEqual(
    [11, 12, 13, 14, 15, 16].map((i) => count(sim, i)),
    [1, 1, 0, 1, 0, 1],
    "round, floor, ceiling; tolerance 1 lets 3 equal 4; not-equal needs more than the tolerance",
  );
});

test("Item Compare reads the attempt number and the level time", () => {
  // Type 5 is the attempt: "attempt <= 1" holds on the first attempt only.
  // Type 4 is the level time: a compare spawned half a second in sees at least
  // 0.5. [gdp getItemValue :429183-429210; the level time :469830-469831]
  const firstOnly: Placed = { id: 3620, x: 0, y: 300, props: { 476: "5", 479: "1", 480: "3", 482: "4", 483: "1", 51: "10", 71: "11" } };
  const build = () =>
    withGroups(
      [
        firstOnly,
        marker(2),
        marker(3),
        { id: 1268, x: 1, y: 300, props: { 51: "20", 63: "0.5" } },
        { id: 3620, x: 900, y: 600, props: { 62: "1", 476: "4", 479: "1", 480: "3", 482: "2", 483: "0.5", 51: "21", 71: "22" } },
        marker(4),
        marker(5),
      ],
      { 1: [10], 2: [11], 4: [20], 5: [21], 6: [22] },
    );
  const first = simOn(build());
  stepN(first, NO_INPUT, 130);
  assert.deepEqual([count(first, 2), count(first, 3)], [1, 0], "attempt 1");
  assert.deepEqual([count(first, 4), count(first, 5)], [1, 0], "0.5 s in");
  const second = makeSim(build(), undefined, { start: { x: 15, y: 45 }, attempt: 2 });
  stepN(second, NO_INPUT, 2);
  assert.deepEqual([count(second, 2), count(second, 3)], [0, 1], "attempt 2");
});

// --- Item Edit ------------------------------------------------------------------

test("Item Edit writes key 51 of type 478 from A op B op the modifier", () => {
  // Items 1 = 6 and 2 = 4. (6 - 4) x 2.5 = 5 into item 3; then item 3 x= 6/4
  // gives 7.5, cast to 7. Points (478 = 3) take 6 x 10 = 60, which a compare
  // on type 3 then sees. The port wrote key 80 and read 480 as the operator.
  // [gdp activateItemEditTrigger :459103-459228]
  const level = withGroups(
    [
      { id: 1817, x: 0, y: 300, props: { 80: "1", 77: "6" } },
      { id: 1817, x: 1, y: 300, props: { 80: "2", 77: "4" } },
      { id: 3619, x: 2, y: 300, props: { 80: "1", 476: "1", 95: "2", 477: "1", 481: "2", 482: "3", 479: "2.5", 478: "1", 51: "3" } },
      { id: 3619, x: 3, y: 300, props: { 80: "1", 476: "1", 482: "4", 479: "4", 480: "3", 478: "1", 51: "3" } },
      { id: 3619, x: 4, y: 300, props: { 80: "1", 476: "1", 479: "10", 478: "3" } },
      { id: 3620, x: 5, y: 300, props: { 476: "3", 479: "1", 480: "3", 482: "0", 483: "60", 51: "10" } },
      marker(4),
    ],
    { 6: [10] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  assert.equal(count(sim, 3), 7);
  assert.equal(count(sim, 4), 1, "the points reached 60");
});

// --- Pickup ---------------------------------------------------------------------

test("Pickup: 88 = 1 multiplies, 2 divides, 139 sets; 77 defaults to 0 and item 0 is an item", () => {
  // 7 x 1.5 = 10.5 rounds to 11; 11 / 4 = 2.75 rounds to 3; dividing by 0 is
  // skipped; adding with no key 77 adds nothing. Item 2 is set to 5, then set
  // with no key 77, which is 0. [gdp addPickupTrigger :459042-459086;
  //  CountTriggerGameObject::customObjectSetup :300830-300854]
  const level = emptyLevel([
    { id: 1817, x: 0, y: 300, props: { 80: "1", 77: "7", 139: "1" } },
    { id: 1817, x: 1, y: 300, props: { 80: "1", 88: "1", 449: "1.5" } },
    { id: 1817, x: 2, y: 300, props: { 80: "1", 88: "2", 449: "4" } },
    { id: 1817, x: 3, y: 300, props: { 80: "1", 88: "2" } },
    { id: 1817, x: 4, y: 300, props: { 80: "1" } },
    { id: 1817, x: 5, y: 300, props: { 80: "2", 77: "5" } },
    { id: 1817, x: 6, y: 300, props: { 80: "2", 139: "1" } },
    { id: 1817, x: 7, y: 300, props: { 80: "0", 77: "2" } },
  ]);
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  assert.equal(count(sim, 1), 3);
  assert.equal(count(sim, 2), 0);
  assert.equal(count(sim, 0), 2);
});

// --- Count ----------------------------------------------------------------------

test("a Count fires when a later change reaches its number, not when it is passed", () => {
  // Item 1 is 2 when both Counts are passed. Count A (2) does not fire then;
  // Count B (3) fires when a spawned Pickup makes it 3; A fires when a second
  // takes it from 3 down to 1, crossing 2. The port tested once, on the pass.
  // [gdp runCountTrigger :487736-487880, updateCountForItem :487384-487525]
  const level = withGroups(
    [
      { id: 1817, x: 0, y: 300, props: { 80: "1", 77: "2" } },
      { id: 1611, x: 1, y: 300, props: { 80: "1", 77: "2", 51: "10", 56: "1" } },
      { id: 1611, x: 2, y: 300, props: { 80: "1", 77: "3", 51: "11", 56: "1" } },
      { id: 1268, x: 3, y: 300, props: { 51: "5", 63: "0.1" } },
      { id: 1268, x: 4, y: 300, props: { 51: "6", 63: "0.2" } },
      { id: 1817, x: 900, y: 600, props: { 62: "1", 80: "1", 77: "1" } },
      { id: 1817, x: 900, y: 600, props: { 62: "1", 80: "1", 77: "-2" } },
      marker(2),
      marker(3),
    ],
    { 5: [5], 6: [6], 7: [10], 8: [11] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  assert.deepEqual([count(sim, 2), count(sim, 3)], [0, 0], "nothing on the pass");
  stepN(sim, NO_INPUT, 30);
  assert.equal(count(sim, 1), 3);
  assert.deepEqual([count(sim, 2), count(sim, 3)], [0, 1], "B at 3");
  stepN(sim, NO_INPUT, 30);
  assert.equal(count(sim, 1), 1);
  assert.deepEqual([count(sim, 2), count(sim, 3)], [1, 1], "A on the way down through 2");
});

test("a Count survives a snapshot and restore", () => {
  const level = withGroups(
    [
      { id: 1611, x: 0, y: 300, props: { 80: "1", 77: "1", 51: "10", 56: "1" } },
      { id: 1268, x: 1, y: 300, props: { 51: "5", 63: "0.1" } },
      { id: 1817, x: 900, y: 600, props: { 62: "1", 80: "1", 77: "1" } },
      marker(2),
    ],
    { 2: [5], 3: [10] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  const snap = sim.snapshot();
  stepN(sim, NO_INPUT, 30);
  assert.equal(count(sim, 2), 1);
  sim.restore(snap);
  assert.equal(count(sim, 2), 0, "the restore took the spawn back");
  stepN(sim, NO_INPUT, 30);
  assert.equal(count(sim, 2), 1, "and the listener was still armed");
});

// --- Activate Group -------------------------------------------------------------

test("Activate Group on an Instant Count switches a switched-off group on, then spawns it", () => {
  // Toggle 1049 turns group 10 off; Instant Count (item 1 == 0) with key 56
  // turns it back on and spawns it. The port only spawned, and a spawn of a
  // switched-off group does nothing. [gdp toggleGroupTriggered :423103-423110]
  const level = withGroups(
    [
      { id: 1049, x: 0, y: 300, props: { 51: "10" } },
      { id: 1811, x: 1, y: 300, props: { 80: "1", 77: "0", 51: "10", 56: "1" } },
      marker(2),
    ],
    { 2: [10] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  assert.equal(sim.triggers.groupIsEnabled(10), true);
  assert.equal(count(sim, 2), 1);
});

// --- collectibles ---------------------------------------------------------------

test("a collectible counts (381), subtracts (78), toggles (382, 79) and scores (383)", () => {
  // Small coins (1614) in the player's path. Three add one to item 1 and one
  // takes one away: 2. One switches group 10 on and spawns it (item 2 = 1);
  // one with key 79 = 2 and no 56 switches group 11 off. One scores 5 points.
  // [gdp EffectGameObject::customObjectSetup :298721-298772; triggerObject
  //  :314855-314880 → collectedObject :459006-459021]
  const coin = (x: number, props: Record<number, string>): Placed => ({ id: 1614, x, y: 45, props });
  const level = withGroups(
    [
      coin(60, { 381: "1", 80: "1" }),
      coin(90, { 381: "1", 80: "1" }),
      coin(120, { 79: "1", 80: "1" }),
      coin(150, { 381: "1", 78: "1", 80: "1" }),
      coin(180, { 382: "1", 51: "10", 56: "1" }),
      coin(210, { 79: "2", 51: "11" }),
      coin(240, { 383: "5" }),
      marker(2),
      { id: 1, x: 900, y: 900 },
    ],
    { 7: [10], 8: [11] },
  );
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 220);
  assert.equal(count(sim, 1), 2);
  assert.equal(count(sim, 2), 1);
  assert.equal(sim.triggers.groupIsEnabled(11), false);
  assert.equal((sim.triggers as unknown as { points: number }).points, 5);
});

// --- the custom rings -----------------------------------------------------------

test("a trigger orb switches group 51 on (and spawns it) or off by key 56, and with key 504 only spawns it", () => {
  // Taken with a press, the orb hands its group to activateCustomRing: key 504
  // spawns it; otherwise toggleGroupTriggered switches it on and spawns it
  // with key 56, or off without. The port fired the orb and left the group
  // alone, which kept The Sewers' route shut at its trigger orb. The toggle
  // block (3643) is the same custom ring, 30 × 30.
  // [gdp RingObject::customObjectSetup :302960-302990; PlayerObject::ringJump
  //  :159943-159945 → GJBaseGameLayer::activateCustomRing :439065-439098;
  //  GameObject::customSetup :178493-178499]
  const take = (orb: Record<number, string>, startOff: boolean, press: boolean, id = 1594): Sim => {
    const extra: Placed[] = [{ id, x: 20, y: 30, props: { 51: "10", ...orb } }, marker(2)];
    if (startOff) extra.push({ id: 1049, x: 0, y: 300, props: { 51: "10" } });
    const sim = simOn(withGroups(extra, { 1: [10] }));
    settle(sim);
    if (press) sim.step(HOLD);
    stepN(sim, NO_INPUT, 3);
    return sim;
  };
  const on = take({ 56: "1" }, true, true);
  assert.equal(on.triggers.groupIsEnabled(10), true, "56: switched on");
  assert.equal(count(on, 2), 1, "56: and spawned");
  const off = take({}, false, true);
  assert.equal(off.triggers.groupIsEnabled(10), false, "no 56: switched off");
  assert.equal(count(off, 2), 0, "no 56: not spawned");
  const spawn = take({ 504: "1" }, false, true);
  assert.equal(spawn.triggers.groupIsEnabled(10), true, "504: left on");
  assert.equal(count(spawn, 2), 1, "504: spawned");
  const untaken = take({ 56: "1" }, true, false);
  assert.equal(untaken.triggers.groupIsEnabled(10), false, "no press: nothing");
  const block = take({ 56: "1" }, true, true, 3643);
  assert.equal(block.triggers.groupIsEnabled(10), true, "toggle block: switched on");
  assert.equal(count(block, 2), 1, "toggle block: and spawned");
});

test("a practice respawn puts back the checkpoint's points and keeps the level time running", () => {
  // resetLevel zeroes the points (resetLevelVariables), then the checkpoint's
  // game state, which holds them, is copied back; the level time is only
  // zeroed when there is no checkpoint. The port zeroed the points outright.
  // [gdp PlayLayer::resetLevel :105781, :105893-105896; loadFromCheckpoint
  //  :105527 → GJGameState::operator= :105019 (+1516, the points)]
  const level = emptyLevel([{ id: 1614, x: 60, y: 45, props: { 383: "5" } }]);
  const sim = simOn(level);
  const before = sim.snapshot();
  stepN(sim, NO_INPUT, 100);
  const points = sim.triggers as unknown as { points: number };
  assert.equal(points.points, 5);
  const after = sim.snapshot();
  stepN(sim, NO_INPUT, 20);
  const t = sim.triggers.levelTime;
  sim.respawnFrom(before);
  assert.equal(points.points, 0, "a checkpoint placed before the pickup has none");
  assert.equal(sim.triggers.levelTime, t);
  stepN(sim, NO_INPUT, 20);
  const t2 = sim.triggers.levelTime;
  sim.respawnFrom(after);
  assert.equal(points.points, 5, "a checkpoint placed after it keeps them");
  assert.equal(sim.triggers.levelTime, t2);
  sim.restore(before);
  assert.equal(sim.triggers.levelTime, 0, "a plain restore puts the clock back");
});

test("the level time stops at the finish, and a respawn starts it again", () => {
  // The game only adds to the level time while +11304 is clear. The end sets
  // it; any reset, a practice respawn included, clears it. The port's clock
  // never stopped.
  // [gdp GJBaseGameLayer::update :469828-469831; EndPortalObject::triggerObject
  //  :326158, PlayLayer::levelComplete :92676; resetLevelVariables :462932]
  const sim = simOn(buildLevel(floor(0, 600)));
  for (let i = 0; i < 5000 && !sim.state.finished; i++) sim.step(NO_INPUT);
  assert.ok(sim.state.finished, "reached the end");
  const done = sim.snapshot();
  const t = sim.triggers.levelTime;
  assert.ok(t > 0);
  sim.triggers.beginStep(1 / 240);
  assert.equal(sim.triggers.levelTime, t, "stopped at the finish");
  sim.restore(done);
  sim.triggers.beginStep(1 / 240);
  assert.equal(sim.triggers.levelTime, t, "a snapshot keeps it stopped");
  sim.respawnFrom(done);
  sim.triggers.beginStep(1 / 240);
  assert.equal(sim.triggers.levelTime, t + 1 / 240, "running again after a respawn");
});
