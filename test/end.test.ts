// The End trigger (3600): an effect object that ends the level, however it
// is fired, and the old End trigger (1931), which does nothing in play.
// [gdp EndTriggerGameObject::triggerObject :315851-315875 → vtable +628,
//  PlayLayer::activatePlatformerEndTrigger :93034-93065,
//  playPlatformerEndAnimationToPos :92922-93030; the keys,
//  EndTriggerGameObject::customObjectSetup :309857-309885]

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { EventDrain } from "../src/audio/events";
import { TICKS_PER_SECOND } from "../src/physics/constants";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { statusOf } from "../src/triggers/registry";
import { LEVELS_DIR, loadObjectTable, loadOfficialLevel } from "./helpers";
import { emptyLevel, simOn, stepN, type Placed } from "./levelKit";

const LEVELS = existsSync(`${LEVELS_DIR}/5001.txt`) ? false : "needs the real install";

function runToEnd(sim: Sim, max = 600): number {
  for (let i = 0; i < max && !sim.state.finished && !sim.state.dead; i++) sim.step(NO_INPUT);
  return sim.tick;
}

test("registry: End trigger is done", () => {
  assert.equal(statusOf(3600).status, "done");
});

test("a passed End trigger flies the player to the end point for one second, then finishes", () => {
  // x 300 is passed on tick 220 (x 300.6); without key 487 the player flies
  // for TICKS_PER_SECOND then levelComplete. [gdp playPlatformerEndAnimationToPos]
  const sim = simOn(emptyLevel([{ id: 3600, x: 300, y: 200 }]));
  assert.equal(runToEnd(sim, 220 + TICKS_PER_SECOND + 10), 220 + TICKS_PER_SECOND);
  assert.equal(sim.state.finished, true);
  assert.ok(Math.abs(sim.state.x - 300) < 0.01, String(sim.state.x));
  assert.ok(Math.abs(sim.state.y - 200) < 0.01, String(sim.state.y));
  assert.deepEqual(sim.end, { x: 300, y: 200, instant: false, effects: true, sound: true });
  assert.ok(sim.events.some((e) => e.type === "finish"));
  const time = sim.triggers.levelTime;
  sim.step(NO_INPUT);
  assert.equal(sim.triggers.levelTime, time, "the level time has stopped");
});

test("the End trigger is invisible to the collision pass: a player running through it does not end the level", () => {
  // A spawn-only End trigger in the player's path.
  const sim = simOn(emptyLevel([{ id: 3600, x: 60, y: 45, props: { 62: "1" } }]));
  stepN(sim, NO_INPUT, 120);
  assert.equal(sim.state.finished, false);
});

test("a spawned End trigger with keys 460, 461 and 487 ends at once and quietly, and spawns key 51 first", () => {
  // A touch-triggered Spawn fires group 5: the End trigger (spawn only) and
  // nothing else. The End trigger's own key 51 spawns group 6's Pickup.
  const placed: Placed[] = [
    { id: 1268, x: 90, y: 45, props: { 11: "1", 51: "5" } },
    { id: 3600, x: 1000, y: 700, props: { 62: "1", 460: "1", 461: "1", 487: "1", 51: "6" } },
    { id: 1817, x: 0, y: 900, props: { 62: "1", 80: "1", 77: "1" } },
  ];
  const level = emptyLevel(placed);
  const n = level.objects.length;
  level.objects[n - 2].groups = [5];
  level.objects[n - 1].groups = [6];
  const sim = simOn(level);
  runToEnd(sim);
  assert.equal(sim.state.finished, true);
  assert.ok(sim.state.x < 90, "ended where the touch was, far from the trigger");
  assert.deepEqual(sim.end, { x: 1000, y: 700, instant: true, effects: false, sound: false });
  assert.equal(sim.triggers.itemCount(1), 1, "key 51 spawned");
});

test("key 71 sends the player to that group's main object, and only the first End trigger counts", () => {
  const level = emptyLevel([
    { id: 3600, x: 200, y: 45, props: { 71: "9" } },
    { id: 3600, x: 201, y: 45, props: { 487: "1" } },
    { id: 1, x: 400, y: 600 },
  ]);
  level.objects[level.objects.length - 1].groups = [9];
  const sim = simOn(level);
  runToEnd(sim);
  assert.deepEqual(sim.end, { x: 400, y: 600, instant: false, effects: true, sound: true });
});

test("key 71 reads through a spawn's remap, as key 51 does", () => {
  // A touched Spawn trigger fires group 5 with 9 read as 10; group 5's End
  // trigger names group 9, so the player is flown to group 10's block.
  // [gdp spawnObject :456070-456084 → applyRemap :455343-455356 (+1280, key
  //  71), read inside the trigger :93049-93057]
  const placed: Placed[] = [
    { id: 1268, x: 90, y: 45, props: { 11: "1", 51: "5", 442: "9.10" } },
    { id: 3600, x: 1000, y: 700, props: { 62: "1", 71: "9" } },
    { id: 1, x: 400, y: 600 },
    { id: 1, x: 500, y: 500 },
  ];
  const level = emptyLevel(placed);
  const n = level.objects.length;
  level.objects[n - 3].groups = [5];
  level.objects[n - 2].groups = [9];
  level.objects[n - 1].groups = [10];
  const sim = simOn(level);
  runToEnd(sim);
  assert.deepEqual(sim.end, { x: 500, y: 500, instant: false, effects: true, sound: true });
});

test("the end sound plays for a level's end unless its End trigger has key 461", () => {
  // [gdp PlayLayer::showCompleteEffect :88846-88870: endStart_02 only while
  //  the End trigger's +1636, key 461, is clear]
  const heard = (sim: Sim): string[] => {
    const out: string[] = [];
    new EventDrain().drain(sim, { effect: (name) => out.push(name), trigger: () => {} }, false);
    return out;
  };
  const flight = 220 + TICKS_PER_SECOND + 10;
  for (const [extra, max, sound] of [
    [[], 4000, ["endStart_02"]],
    [[{ id: 3600, x: 300, y: 200 }], flight, ["endStart_02"]],
    [[{ id: 3600, x: 300, y: 200, props: { 461: "1" } }], flight, []],
  ] as const) {
    const sim = simOn(emptyLevel([...extra]));
    runToEnd(sim, max);
    assert.equal(sim.state.finished, true);
    assert.deepEqual(heard(sim), sound, JSON.stringify(extra));
  }
});

test("the old End trigger (1931) does nothing while a level plays", () => {
  const sim = simOn(emptyLevel([{ id: 1931, x: 200, y: 45 }]));
  stepN(sim, NO_INPUT, 300);
  assert.equal(sim.state.finished, false);
});

test("an On Death group cannot end the level: the player is already dead", () => {
  // An On Death trigger arms group 4, which holds a spawn-only End trigger; a
  // spike kills the player. [activatePlatformerEndTrigger :93041 (+1968)]
  const level = emptyLevel([
    { id: 1812, x: 30, y: 45, props: { 51: "4" } },
    { id: 3600, x: 500, y: 45, props: { 62: "1" } },
    { id: 8, x: 200, y: 45 },
  ]);
  level.objects[level.objects.length - 2].groups = [4];
  const sim = simOn(level);
  runToEnd(sim);
  assert.equal(sim.state.dead, true);
  assert.equal(sim.end, null);
  assert.equal(sim.triggers.pendingEnd, null);
});

test("an End trigger fired in the middle of the collision pass locks the player: a spike met in that pass does not kill", () => {
  // A key (1275) switches group 4 on and spawns it (keys 382, 51, 56) when it
  // is picked up; group 4 holds a spawn-only End trigger. The spike's box
  // starts where the key's does, so both are met in the same pass, and the
  // hazards are tested after the walk that picks the key up.
  // [collisionCheckObjects case 0x1E :463762-463779; the hazards,
  //  checkCollisions :465008-465057; PlayLayer::destroyPlayer :93151]
  const level = emptyLevel([
    { id: 1275, x: 150, y: 45, props: { 382: "1", 51: "4", 56: "1" } },
    { id: 8, x: 140.5, y: 45 },
    { id: 3600, x: 700, y: 300, props: { 62: "1", 487: "1" } },
  ]);
  level.objects[level.objects.length - 1].groups = [4];
  const sim = simOn(level);
  runToEnd(sim);
  assert.deepEqual([sim.state.finished, sim.state.dead], [true, false]);
  assert.ok(sim.state.x > 120 && sim.state.x < 130, String(sim.state.x));
  assert.deepEqual(sim.end, { x: 700, y: 300, instant: true, effects: true, sound: true });
});

test("a restore to before the end takes it back", () => {
  const sim = simOn(emptyLevel([{ id: 3600, x: 300, y: 200 }]));
  stepN(sim, NO_INPUT, 100);
  const snap = sim.snapshot();
  const h = sim.stateHash();
  runToEnd(sim, 220 + TICKS_PER_SECOND + 10);
  assert.equal(sim.state.finished, true);
  sim.restore(snap);
  assert.deepEqual([sim.state.finished, sim.end, sim.stateHash()], [false, null, h]);
  runToEnd(sim, 220 + TICKS_PER_SECOND + 10);
  assert.equal(sim.tick, 220 + TICKS_PER_SECOND, "and finishes again after the same flight");
});

test("the tower floors each end on a spawned End trigger that the table now treats as a trigger", { skip: LEVELS }, async () => {
  const table = loadObjectTable();
  assert.equal(table.get(3600).kind, "trigger");
  assert.equal(table.get(1931).kind, "trigger");
  for (const id of [5001, 5002, 5003, 5004]) {
    const level = await loadOfficialLevel(id);
    const ends = level.objects.filter((o) => o.id === 3600);
    assert.equal(ends.length, 1, `${id}: one End trigger`);
    const p = ends[0].props;
    assert.deepEqual([p[62], p[460], p[461], p[487], p[51] ?? null, p[71] ?? null], ["1", "1", "1", "1", null, null], `${id}`);
  }
});
