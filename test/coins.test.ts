// Secret coins (142): picked up once, by their own number (key 12), not at
// all in practice, spawning their group (key 51) as they go, and given back
// by every reset. What a completion keeps of them is the save's; see
// save.test.ts. The level is a flat floor: a cube running with no input
// takes the first coin at tick 193 and the second at tick 239, and the third
// sits out of its reach.
// [gdp collisionCheckObjects case 0x16 :463675-463688; triggerObject
//  :315158-315160 → LABEL_125 :315442-315457; customObjectSetup LABEL_126
//  :299550-299560; resetLevel :105781, :105839-105843; loadFromCheckpoint
//  :105589-105610]

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Level } from "../src/level/types";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { emptyLevel, type Placed, simOn, stepN, STANDING_Y } from "./levelKit";
import { makeSim } from "./helpers";

/** A spawn-only Pickup that adds one to `item`: what a spawned group holds to say it fired. */
function marker(item: number, x = 900): Placed {
  return { id: 1817, x, y: 900, props: { 62: "1", 87: "1", 80: String(item), 77: "1" } };
}

/** Coin 2 (spawning group 10), coin 3, and coin 1 out of reach; group 10 adds one to item 5. */
function coinLevel(): Level {
  const extra: Placed[] = [
    { id: 142, x: 300, y: 45, props: { 12: "2", 51: "10" } },
    { id: 142, x: 360, y: 45, props: { 12: "3" } },
    { id: 142, x: 420, y: 200, props: { 12: "1" } },
    marker(5),
  ];
  const level = emptyLevel(extra);
  const first = level.objects.length - extra.length;
  level.objects[first + 3].groups = [10];
  return level;
}

/** The first coin's object index: the floor's hundred blocks come first. */
const FIRST_COIN = 100;

function collects(sim: Sim): Array<[number, number | undefined]> {
  return sim.events.filter((e) => e.type === "collect").map((e) => [e.tick, e.object]);
}

test("a coin is picked up outside practice: its number, and its group", () => {
  const sim = simOn(coinLevel());
  stepN(sim, NO_INPUT, 300);
  assert.deepEqual(sim.coinsTaken(), [2, 3]);
  assert.deepEqual(collects(sim), [
    [193, FIRST_COIN],
    [239, FIRST_COIN + 1],
  ]);
  assert.equal(sim.triggers.itemCount(5), 1, "coin 2's key 51 spawned group 10");
});

test("practice leaves the coins where they are, and fires nothing", () => {
  const sim = makeSim(coinLevel(), undefined, { start: { x: 15, y: STANDING_Y, mode: "cube" }, practice: true });
  stepN(sim, NO_INPUT, 300);
  assert.deepEqual(sim.coinsTaken(), []);
  assert.deepEqual(collects(sim), []);
  assert.equal(sim.triggers.itemCount(5), 0);
});

test("entering practice mid-run stops the pickups from there", () => {
  const sim = simOn(coinLevel());
  stepN(sim, NO_INPUT, 200);
  sim.setPractice(true);
  stepN(sim, NO_INPUT, 100);
  assert.deepEqual(sim.coinsTaken(), [2], "the one taken before the switch stays taken");
  assert.deepEqual(collects(sim), [[193, FIRST_COIN]]);
});

test("a respawn gives the coins back; a rewind does not", () => {
  const sim = simOn(coinLevel());
  stepN(sim, NO_INPUT, 100);
  const a = sim.snapshot();
  stepN(sim, NO_INPUT, 200);
  const b = sim.snapshot();

  sim.restore(b);
  assert.deepEqual(sim.coinsTaken(), [2, 3], "the autoplayer's rewind keeps them");

  sim.respawnFrom(b);
  assert.deepEqual(sim.coinsTaken(), [], "a checkpoint does not keep a secret coin");
  stepN(sim, NO_INPUT, 60);
  assert.deepEqual(sim.coinsTaken(), [], "both are behind the player now");

  sim.respawnFrom(a);
  stepN(sim, NO_INPUT, 200);
  assert.deepEqual(sim.coinsTaken(), [2, 3]);
  assert.deepEqual(collects(sim), [
    [193, FIRST_COIN],
    [239, FIRST_COIN + 1],
  ]);
  assert.equal(sim.triggers.itemCount(5), 1, "the item came back with the checkpoint and the coin fired again");
});

test("reading the coins changes nothing", () => {
  const sim = simOn(coinLevel());
  stepN(sim, NO_INPUT, 300);
  const hash = sim.stateHash();
  assert.deepEqual(sim.coinsTaken(), [2, 3]);
  assert.deepEqual(sim.coinsTaken(), [2, 3]);
  assert.equal(sim.stateHash(), hash);
});
