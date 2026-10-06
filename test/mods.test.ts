// The mod menu: what counts as a cheat, how its switches are kept, and what
// noclip, the jump hack, the start position switcher, Instant Complete and
// the macro recorder do to a run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MacroDeck } from "../src/mods/macro";
import { MODS, MODS_KEY, ModStore, clampValue, mergeModState } from "../src/mods/state";
import { NO_INPUT, type PlayerInput } from "../src/physics/types";
import { makeSim } from "./helpers";
import { HOLD, STANDING_Y, emptyLevel, settle, simOn } from "./levelKit";

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test("every mod has a unique id, and only switches and buttons are cheats", () => {
  const ids = new Set<string>();
  for (const m of MODS) {
    assert.ok(!ids.has(m.id), `${m.id} is listed once`);
    ids.add(m.id);
    if (m.cheat) assert.ok(m.kind === "toggle" || m.kind === "action", `${m.id} can be a cheat`);
    if (m.value) assert.equal(clampValue(m.value, m.value.initial), m.value.initial, `${m.id} starts inside its own range`);
  }
});

test("the cheats on are the game-changing switches, and the speedhack only away from 1x", () => {
  const store = new ModStore(memory());
  assert.deepEqual(store.activeCheats(), [], "a fresh menu has none");
  store.setOn("showHitboxes", true);
  store.setOn("hidePlayer", true);
  store.setOn("safeMode", true);
  assert.deepEqual(store.activeCheats(), [], "looks and safe mode are not cheats");
  store.setOn("speedhack", true);
  assert.deepEqual(store.activeCheats(), [], "the speedhack at 1x changes nothing");
  store.setValue("speedhack", 0.5);
  store.setOn("noclip", true);
  assert.deepEqual(store.activeCheats(), ["Noclip", "Speedhack"]);
});

test("the menu's switches survive a reload, and junk does not", () => {
  const storage = memory();
  const store = new ModStore(storage);
  store.setOn("noclip", true);
  store.setValue("autoClicker", 99);
  store.setText("message", "hello");
  store.bind("noclip", "KeyN");
  store.place("player", { x: 10.4, y: 20.6 });
  store.flush();
  const back = new ModStore(storage);
  assert.equal(back.on("noclip"), true);
  assert.equal(back.value("autoClicker"), 30, "held to its range");
  assert.equal(back.text("message"), "hello");
  assert.equal(back.boundTo("KeyN"), "noclip");
  assert.deepEqual(back.raw.windows.player, { x: 10, y: 21 });

  const junk = mergeModState({ on: { noclip: "yes", nope: true }, values: { speedhack: "fast" }, keys: { KeyX: "nope", "Key X": "noclip" }, windows: { nope: { x: 1, y: 1 } } });
  assert.equal(junk.on.noclip, false);
  assert.equal("nope" in junk.on, false);
  assert.equal(junk.values.speedhack, 1);
  assert.deepEqual(junk.keys, {});
  assert.deepEqual(junk.windows, {});
  assert.equal(new ModStore(memory({ [MODS_KEY]: "{not json" })).on("noclip"), false, "an unreadable store starts fresh");
});

test("a key binds to one mod, and a mod to one key", () => {
  const store = new ModStore(memory());
  store.bind("noclip", "KeyN");
  store.bind("noclip", "KeyM");
  assert.equal(store.boundTo("KeyN"), undefined, "the mod's old key is let go");
  store.bind("jumpHack", "KeyM");
  assert.equal(store.boundTo("KeyM"), "jumpHack", "the key's old mod is let go");
  assert.equal(store.keyOf("noclip"), undefined);
  store.bind("jumpHack", null);
  assert.equal(store.keyOf("jumpHack"), undefined);
});

test("noclip keeps the player alive through a spike, counting each step it saved it, and can be turned off mid-run", () => {
  const level = emptyLevel([{ id: 8, x: 200, y: STANDING_Y }, { id: 8, x: 500, y: STANDING_Y }]);
  const sim = simOn(level);
  sim.cheats.noclip = true;
  for (let i = 0; i < 200; i++) sim.step(NO_INPUT);
  assert.equal(sim.state.dead, false, "through the first spike");
  assert.ok(sim.noclipHits > 0, "and counted");
  const hits = sim.noclipHits;
  assert.ok(hits < 60, `a step counts once however much it touches (${hits})`);
  sim.cheats.noclip = false;
  for (let i = 0; i < 400 && !sim.state.dead; i++) sim.step(NO_INPUT);
  assert.equal(sim.state.dead, true, "the second spike kills");
  assert.equal(sim.noclipHits, hits, "and is not counted");
});

test("the jump hack lets a fresh press jump again in mid-air, once a press", () => {
  const sim = simOn(emptyLevel());
  settle(sim);
  sim.step(HOLD);
  for (let i = 0; i < 20; i++) sim.step(NO_INPUT);
  assert.equal(sim.state.onGround, false, "in the air");
  const falling = sim.state.yVel;
  sim.step(HOLD);
  assert.ok(sim.state.yVel <= falling, "no jump without the hack");
  sim.step(NO_INPUT);
  sim.cheats.jumpHack = true;
  sim.step(HOLD);
  assert.ok(sim.state.yVel > 10, `a second jump (${sim.state.yVel})`);
  const after = sim.state.yVel;
  sim.step(HOLD);
  assert.ok(sim.state.yVel < after, "holding does not jump again");
});

test("the start position switcher's choice: the level's start, or a start position by its index", () => {
  const level = emptyLevel([
    { id: 31, x: 900, y: 45, settings: {} },
    { id: 31, x: 1500, y: 45, settings: {} },
  ]);
  const first = level.objects.length - 2;
  assert.equal(makeSim(level).startPosition, first + 1, "the game picks the furthest");
  assert.equal(makeSim(level, undefined, { startPosition: -1 }).startPosition, -1, "the level's own start");
  assert.equal(makeSim(level, undefined, { startPosition: -1 }).state.x < 100, true);
  const chosen = makeSim(level, undefined, { startPosition: first });
  assert.equal(chosen.startPosition, first);
  assert.equal(chosen.state.x, 900);
  assert.equal(makeSim(level, undefined, { startPosition: 0 }).startPosition, -1, "a block is no start position");
});

test("Instant Complete finishes the level, and does nothing once it is over", () => {
  const sim = simOn(emptyLevel());
  sim.step(NO_INPUT);
  sim.finishNow();
  assert.equal(sim.state.finished, true);
  assert.equal(sim.events.filter((e) => e.type === "finish").length, 1);
  sim.finishNow();
  assert.equal(sim.events.filter((e) => e.type === "finish").length, 1, "once");
});

test("a recorded run plays back the same, taps and all", () => {
  const level = emptyLevel();
  const deck = new MacroDeck();
  deck.record();
  const seed = 1234;
  const live = makeSim(level, undefined, { seed, start: { x: 15, y: STANDING_Y } });
  deck.attemptStarted(seed);
  const pattern = (t: number): PlayerInput =>
    t % 97 === 3 ? { jump: false, tap: true, left: false, right: false } : { jump: t % 61 < 20, left: false, right: false };
  for (let t = 0; t < 600 && !live.state.dead; t++) {
    const p1 = pattern(live.tick);
    deck.note(live.tick, p1, NO_INPUT);
    live.step(p1);
  }
  deck.stop();
  assert.ok(deck.macro && deck.macro.inputs.length > 10, `something was recorded (${deck.macro?.inputs.length} by tick ${live.tick})`);
  assert.equal(deck.macro?.seed, seed);

  assert.equal(deck.play(), true);
  assert.equal(deck.seed(), seed, "playback asks for the recording's seed");
  const replay = makeSim(level, undefined, { seed: deck.seed(), start: { x: 15, y: STANDING_Y } });
  deck.attemptStarted(seed);
  for (let t = 0; t < live.tick; t++) {
    const inputs = deck.inputsAt(replay.tick);
    assert.ok(inputs);
    replay.step(inputs.p1, inputs.p2);
  }
  assert.equal(replay.tick, live.tick);
  assert.equal(replay.state.x, live.state.x);
  assert.equal(replay.state.y, live.state.y);
  assert.equal(replay.state.dead, live.state.dead);
  assert.deepEqual(
    replay.events.map((e) => `${e.tick}:${e.type}`),
    live.events.map((e) => `${e.tick}:${e.type}`),
  );

  const round = new MacroDeck();
  round.load(deck.toJson());
  assert.deepEqual(round.macro, deck.macro, "a saved recording loads back");
});

test("a recording forgets what came after the checkpoint a practice run respawns at", () => {
  const deck = new MacroDeck();
  deck.record();
  deck.attemptStarted(1);
  deck.note(10, HOLD, NO_INPUT);
  deck.note(20, NO_INPUT, NO_INPUT);
  deck.note(30, HOLD, NO_INPUT);
  deck.respawned(25);
  assert.deepEqual(deck.macro?.inputs.map((i) => [i.frame, i.down]), [[10, true], [20, false]]);
  deck.note(26, NO_INPUT, NO_INPUT);
  assert.equal(deck.macro?.inputs.length, 2, "the button is where the recording left it");
});

test("a recording that finished the level is kept rather than recorded over", () => {
  const deck = new MacroDeck();
  deck.record();
  deck.attemptStarted(1);
  deck.note(5, HOLD, NO_INPUT);
  deck.levelFinished();
  deck.attemptStarted(2);
  assert.equal(deck.mode, "idle");
  assert.equal(deck.macro?.inputs.length, 1);
  assert.equal(deck.macro?.seed, 1);
});
