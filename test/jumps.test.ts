// What the game counts as a jump: a cube, ball or robot leaving the ground,
// and every orb taken. A UFO flap, a swing click and a spider's jump are
// not. Each "jump" event says what jumped, and `countsAsJump` reads it; the
// save's total and the end screen count by it.
// [gdp PlayerObject::incrementJumps :142239-142251, from updateJump :155855
//  (the spider leaves before it, :155764-155767; the flying modes never
//  reach it) and ringJump :159956-159961]

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMode } from "../src/level/types";
import { countsAsJump, NO_INPUT, type Sim, type SimEvent } from "../src/physics/types";
import { Game } from "../src/game/game";
import { SaveStore } from "../src/save/store";
import { emptyLevel, HOLD, type Placed, settle, simOn, stepN } from "./levelKit";

/** The jumps and orbs after `from`, as "tick:type[:detail]". */
function seen(sim: Sim, from = 0): string[] {
  return sim.events
    .filter((e) => e.tick > from && (e.type === "jump" || e.type === "orb"))
    .map((e) => `${e.tick}:${e.type}${e.type === "jump" ? `:${e.detail}` : ""}`);
}

function counted(sim: Sim, from = 0): number {
  return sim.events.filter((e) => e.tick > from && countsAsJump(e)).length;
}

/** A player settled on the floor, pressing once. Ticks count from the settle. */
function pressOnGround(mode: GameMode, extra: Placed[] = []): { sim: Sim; from: number } {
  const sim = simOn(emptyLevel(extra), {}, mode);
  settle(sim);
  const from = sim.tick;
  sim.step(HOLD);
  return { sim, from };
}

test("countsAsJump is the ground and the orbs", () => {
  const e = (type: SimEvent["type"], detail?: string): SimEvent => ({ tick: 0, type, player: 1, detail });
  assert.equal(countsAsJump(e("jump", "ground")), true);
  assert.equal(countsAsJump(e("jump", "ufo")), false);
  assert.equal(countsAsJump(e("jump", "swing")), false);
  assert.equal(countsAsJump(e("jump", "spider")), false);
  assert.equal(countsAsJump(e("orb", "yellow")), true);
  assert.equal(countsAsJump(e("pad", "yellow")), false);
});

test("a cube, ball or robot leaving the ground is one jump", () => {
  for (const mode of ["cube", "ball", "robot"] as const) {
    const { sim, from } = pressOnGround(mode);
    assert.deepEqual(seen(sim, from), ["13:jump:ground"], mode);
    assert.equal(counted(sim, from), 1, mode);
  }
});

test("a held cube counts every landing's jump", () => {
  const sim = simOn(emptyLevel());
  settle(sim);
  const from = sim.tick;
  stepN(sim, HOLD, 240);
  assert.deepEqual(seen(sim, from), ["13:jump:ground", "116:jump:ground", "221:jump:ground"]);
  assert.equal(counted(sim, from), 3);
});

test("a UFO's flaps and a swing's click are not jumps", () => {
  const ufo = simOn(emptyLevel(), { y: 150 }, "ufo");
  stepN(ufo, NO_INPUT, 10);
  ufo.step(HOLD);
  ufo.step(NO_INPUT);
  ufo.step(HOLD);
  assert.deepEqual(seen(ufo), ["11:jump:ufo", "13:jump:ufo"]);
  assert.equal(counted(ufo), 0);

  const swing = simOn(emptyLevel(), { y: 200 }, "swing");
  stepN(swing, NO_INPUT, 40);
  swing.step(HOLD);
  assert.deepEqual(seen(swing), ["41:jump:swing"]);
  assert.equal(counted(swing), 0);
});

test("a spider's jump is not one", () => {
  const { sim, from } = pressOnGround("spider");
  assert.deepEqual(seen(sim, from), ["13:jump:spider"]);
  assert.equal(counted(sim, from), 0);
});

test("every orb taken is a jump, and a press inside a toggle orb on the ground is two", () => {
  // The toggle orb fires and the cube still jumps from the ground.
  const toggle = pressOnGround("cube", [{ id: 1594, x: 20, y: 60 }]);
  assert.deepEqual(seen(toggle.sim, toggle.from), ["13:orb", "13:jump:ground"]);
  assert.equal(counted(toggle.sim, toggle.from), 2);

  // The spider orb's teleport is not a jump; the orb is.
  const spider = simOn(emptyLevel([{ id: 3004, x: 20, y: 150, scaleX: 4, scaleY: 4 }, { id: 1, x: 15, y: 250, scaleX: 4 }]), { y: 150 }, "spider");
  stepN(spider, NO_INPUT, 3);
  spider.step(HOLD);
  assert.deepEqual(seen(spider), ["4:jump:spider", "4:orb"]);
  assert.equal(counted(spider), 1);

  const yellow = simOn(emptyLevel([{ id: 36, x: 20, y: 150 }]), { y: 150 });
  yellow.step(HOLD);
  assert.deepEqual(seen(yellow), ["1:orb"]);
  assert.equal(counted(yellow), 1);
});

test("the save gains the jumps at a death or a finish, and leaving drops the rest", () => {
  // The game adds its pending count at a death or a finish and nowhere else,
  // so a run quit halfway keeps none. The visit's count, for the end screen,
  // keeps them all. [gdp PlayLayer::incrementJumps :92529-92531; commitJumps
  //  :92555-92562, from destroyPlayer :93168 and levelComplete :92858]
  const stored = new Map<string, string>();
  const save = new SaveStore({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  const run = { jumps: 0 };
  // The class needs a canvas, so this is its prototype with only what these
  // three methods touch.
  const game = Object.assign(Object.create(Game.prototype) as object, {
    save,
    run,
    eventCursor: 0,
    jumpsPending: 0,
    audio: { stopLevel: () => undefined },
    scene: { useSim: () => undefined },
  }) as unknown as Game;
  const events: SimEvent[] = [];
  const count = (...more: SimEvent[]): void => {
    events.push(...more);
    (game as unknown as { countJumps(sim: { events: SimEvent[] }): void }).countJumps({ events });
  };
  const e = (type: SimEvent["type"], detail?: string): SimEvent => ({ tick: 0, type, player: 1, detail });

  count(e("jump", "ground"), e("jump", "ufo"), e("orb", "yellow"));
  assert.equal(save.get().totals.jumps, 0, "nothing until a death or a finish");
  assert.equal(run.jumps, 2);
  game.commitJumps();
  assert.equal(save.get().totals.jumps, 2);
  game.commitJumps();
  assert.equal(save.get().totals.jumps, 2, "committed once");

  count(e("jump", "ground"));
  game.endLevel();
  game.commitJumps();
  assert.equal(save.get().totals.jumps, 2, "a quit keeps none");
  assert.equal(run.jumps, 3, "the visit saw it all the same");
});
