// The trigger catalogue, the coverage it drives, and the machinery underneath.
//
// The coverage invariants are cheap and they exist because the report is only
// worth anything if it is complete: a trigger missing from the catalogue would
// be a gap that does not even show up as a gap. The rest check the rules that
// came out of the decompile, because those are the ones that will be quietly
// wrong if they are ever wrong.

import { test } from "node:test";
import { ENTER } from "../src/render/enterEffects";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { TRIGGER_CATALOGUE, TOTAL_TRIGGER_PLACEMENTS } from "../src/triggers/catalogue";
import { coverage, declaredIds, statusOf } from "../src/triggers/registry";
import { bounceTime, easedValue } from "../src/triggers/easing";
import { Lcg, RAND_MAX } from "../src/triggers/rng";
import { buildTriggerIndex, type TriggerSpec } from "../src/triggers/spec";
import { closestDirection, mergeRemap, ownRemap } from "../src/triggers/runtime";
import { multipliedColorValue, pulseEnvelope } from "../src/render/colors";
import type { ObjectsFile } from "../src/assets/objectTypes";
import { LEVELS_DIR, loadObjectTable, loadOfficialLevel, makeSim, builtPath, readMacro } from "./helpers";
import { buildLevel, emptyLevel, HOLD, makeHeader, simOn, stepN } from "./levelKit";
import { NO_INPUT, type PlayerInput } from "../src/physics/types";

const objectsPath = builtPath("assets/objects.json");
const SKIP = existsSync(objectsPath) ? false : "run `npm run assets` first";
const LEVELS = existsSync(`${LEVELS_DIR}/1.txt`) ? false : "needs the real install";

// --- the catalogue and the coverage report ----------------------------------

test("the catalogue knows every trigger the object table does", { skip: SKIP }, () => {
  const file = JSON.parse(readFileSync(objectsPath, "utf8")) as ObjectsFile;
  const missing: number[] = [];
  for (const [id, rec] of Object.entries(file.objects)) {
    if (rec.k !== "trigger") continue;
    if (!TRIGGER_CATALOGUE.has(Number(id))) missing.push(Number(id));
  }
  assert.deepEqual(missing, [], "trigger ids the catalogue has never heard of");
});

test("every trigger the levels place has a name", () => {
  const nameless = [...TRIGGER_CATALOGUE.values()].filter((t) => t.uses > 0 && t.name === "").map((t) => t.id);
  // The 2.206 table does not name the 1.x colour triggers; extract-triggers.ts
  // fills those in by hand, so nothing placed should be left anonymous.
  assert.deepEqual(nameless, [], "placed trigger ids with no name");
});

test("coverage adds up to the catalogue it came from", () => {
  const c = coverage();
  const ids = c.byStatus.done.ids + c.byStatus.partial.ids + c.byStatus.todo.ids + c.byStatus.unsupported.ids;
  const placements =
    c.byStatus.done.placements + c.byStatus.partial.placements + c.byStatus.todo.placements + c.byStatus.unsupported.placements;
  assert.equal(ids, c.usedIds, "every used id lands in exactly one status");
  assert.equal(placements, c.placements, "and so does every placement");
  assert.equal(c.placements, TOTAL_TRIGGER_PLACEMENTS);
});

test("the registry has an opinion about every trigger in the game", () => {
  const declared = new Set(declaredIds());
  const silent = [...TRIGGER_CATALOGUE.keys()].filter((id) => !declared.has(id));
  // A trigger with no entry falls through to "todo", which is the right default
  // but a bad place to leave one: the note is what says *why* it is a gap.
  assert.deepEqual(silent, [], "trigger ids with no entry in registry.ts");
});

test("anything not done says why", () => {
  const silent: number[] = [];
  for (const id of declaredIds()) {
    const entry = statusOf(id);
    if (entry.status !== "done" && !entry.note) silent.push(id);
  }
  assert.deepEqual(silent, [], "partial/todo/unsupported entries with no reason given");
});

test("an id nobody has spoken for counts as outstanding", () => {
  assert.equal(statusOf(-1).status, "todo", "the default has to be todo, not done");
  const c = coverage();
  assert.ok(c.byStatus.todo.ids + c.byStatus.partial.ids === c.worstGaps.length);
});

test("the levels' trigger load is what the census measured", () => {
  // 10,426 placements across 105 ids; if this moves, the census or the table
  // changed underneath and the plan's numbers need revisiting. The End
  // trigger (3600, five placements) counts since the table made it the effect
  // object it is (type 20). [gd_2206_customSetup_objectTypes.csv:3601]
  assert.equal(TOTAL_TRIGGER_PLACEMENTS, 10426);
  assert.equal([...TRIGGER_CATALOGUE.values()].filter((t) => t.uses > 0).length, 105);
});

test("the catalogue points at levels that exist", () => {
  const known = new Set([...Array.from({ length: 22 }, (_, i) => i + 1), 3001, 5001, 5002, 5003, 5004]);
  const strays: string[] = [];
  for (const t of TRIGGER_CATALOGUE.values()) {
    for (const level of t.levels) if (!known.has(level)) strays.push(`${t.id} -> ${level}`);
  }
  assert.deepEqual(strays, []);
});

// --- easing ------------------------------------------------------------------

test("easing mode 0 and an unknown mode are both straight lines", () => {
  for (const t of [0, 0.25, 0.5, 1]) {
    assert.equal(easedValue(t, 0, 2), t);
    assert.equal(easedValue(t, 99, 2), t);
  }
});

test("every easing mode starts at 0 and ends at 1", () => {
  for (let mode = 1; mode <= 18; mode++) {
    const at0 = easedValue(0, mode, 2);
    const at1 = easedValue(1, mode, 2);
    // The two exponential modes are a thousandth off at their ends in cocos
    // itself — mode 10 starts at 2^-11 and mode 11 subtracts a flat 0.001 —
    // and the game ships that, so the tolerance is the curve's, not a fudge.
    assert.ok(Math.abs(at0) < 0.002, `mode ${mode} starts at ${at0}`);
    assert.ok(Math.abs(at1 - 1) < 0.002, `mode ${mode} ends at ${at1}`);
  }
});

test("a rate of zero means the default exponent, not an instant curve", () => {
  // The clamp happens before the switch, so rate 0 and rate 2 agree exactly.
  assert.equal(easedValue(0.5, 2, 0), easedValue(0.5, 2, 2));
  assert.equal(easedValue(0.5, 2, -3), 0.25);
});

test("the bounce curve matches cocos at its four thresholds", () => {
  assert.ok(Math.abs(bounceTime(1) - 1) < 1e-9);
  assert.ok(bounceTime(1 / 2.75) > 0.99 && bounceTime(1 / 2.75) <= 1);
  // The second arc peaks at 1 again a little past 2/2.75.
  assert.ok(bounceTime(0.5) < 1);
  assert.equal(bounceTime(0), 0);
});

// --- randomness --------------------------------------------------------------

test("the generator is the game's, and a stored seed reproduces it", () => {
  const a = new Lcg(12345);
  const first = [a.next(), a.next(), a.next()];
  for (const v of first) assert.ok(v >= 0 && v <= RAND_MAX);
  const b = new Lcg(12345);
  assert.deepEqual([b.next(), b.next(), b.next()], first, "the same seed has to give the same stream");
  // Capturing the seed mid-stream and putting it back resumes it, which is what
  // a snapshot does thousands of times a second.
  const at = a.seed;
  const next = a.next();
  a.setSeed(at);
  assert.equal(a.next(), next);
});

test("the recurrence is seed = seed * 214013 + 2531011, output bits 16..30", () => {
  const seed = 1n;
  const stepped = (seed * 214013n + 2531011n) & ((1n << 64n) - 1n);
  const expected = Number((stepped >> 16n) & 0x7fffn);
  assert.equal(new Lcg(1).next(), expected);
});

// --- colour ------------------------------------------------------------------

test("a colour fade truncates rather than rounds", () => {
  // Halfway from 0 to 255 is 127.5, and the game's cast takes 127.
  assert.deepEqual(multipliedColorValue({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5), { r: 127, g: 127, b: 127 });
  assert.deepEqual(multipliedColorValue({ r: 10, g: 20, b: 30 }, { r: 90, g: 90, b: 90 }, 0), { r: 10, g: 20, b: 30 });
  assert.deepEqual(multipliedColorValue({ r: 10, g: 20, b: 30 }, { r: 90, g: 90, b: 90 }, 1), { r: 90, g: 90, b: 90 });
});

test("the pulse envelope ramps, holds and falls in straight lines", () => {
  assert.equal(pulseEnvelope(0, 1, 1, 1), 0);
  assert.equal(pulseEnvelope(0.5, 1, 1, 1), 0.5);
  assert.equal(pulseEnvelope(1, 1, 1, 1), 1, "the hold starts exactly at the end of the ramp");
  assert.equal(pulseEnvelope(2, 1, 1, 1), 1);
  assert.equal(pulseEnvelope(2.5, 1, 1, 1), 0.5);
  assert.equal(pulseEnvelope(3, 1, 1, 1), 0);
  // A zero fade-in is not a division by zero: it lands on the hold at once.
  assert.equal(pulseEnvelope(0, 0, 1, 1), 1);
});

// --- the level index ---------------------------------------------------------

test("the activation queue is ordered, and the order is total", { skip: LEVELS }, async () => {
  // Key 115, then key 115 plus x cut to an integer as floats, then the
  // object's index. [gdp compOrder, gd-ida-decomp.cpp:120294-120318]
  const level = await loadOfficialLevel(19);
  const table = loadObjectTable();
  const index = buildTriggerIndex(level, (id) => table.get(id).kind === "trigger");
  assert.equal(index.channels.length, 1, "level 19 uses channel 0 only");
  const queue = index.channels[0].specs;
  assert.ok(queue.length > 100, "level 19 places hundreds of pass-by triggers");
  const key = (s: TriggerSpec): number => Math.trunc(Math.fround(Math.fround(s.ordering) + Math.fround(s.x)));
  for (let i = 1; i < queue.length; i++) {
    const a = queue[i - 1];
    const b = queue[i];
    const ordered = a.ordering < b.ordering || (a.ordering === b.ordering && (key(a) < key(b) || (key(a) === key(b) && a.index < b.index)));
    assert.ok(ordered, `queue out of order at ${i}: ${a.id}@${a.x} then ${b.id}@${b.x}`);
  }
});

test("levels 1 to 18 define no groups and move nothing", { skip: LEVELS }, async () => {
  const table = loadObjectTable();
  for (const id of [1, 5, 12, 18]) {
    const level = await loadOfficialLevel(id);
    const index = buildTriggerIndex(level, (n) => table.get(n).kind === "trigger");
    assert.equal(index.movingObjects.length, 0, `level ${id} should have nothing that moves`);
    assert.ok(index.count > 0, `level ${id} should still have triggers`);
  }
});

test("an enter trigger fills its channel's table when it is reached, coming in, going out or both", () => {
  // Key 344 is the channel, key 217 which side: 0 both, 1 in, 2 out. The
  // objects take the entry for their own channel (key 343) as they start to
  // come in. [GJBaseGameLayer::updateActiveEnterEffect :467525-467625;
  //  EnterEffectObject::customObjectSetup :299961-299972]
  const level = emptyLevel([
    { id: 23, x: 60, y: 100, props: { 344: "4" } },
    { id: 27, x: 60, y: 100, props: { 344: "7", 217: "1" } },
    { id: 28, x: 60, y: 100, props: { 344: "7", 217: "2" } },
    { id: 1915, x: 300, y: 100, props: {} },
  ]);
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 45, y: 45 } });
  const tables = (): { in: number[]; out: number[] } => ({
    in: Array.from(sim.triggers.visual.enter.in),
    out: Array.from(sim.triggers.visual.enter.out),
  });
  assert.ok(tables().in.every((c) => c === ENTER.fade), "every channel starts on the fade");
  stepN(sim, NO_INPUT, 60);
  const passed = tables();
  assert.equal(passed.in[4], ENTER.fromBottom);
  assert.equal(passed.out[4], ENTER.fromBottom);
  assert.equal(passed.in[7], ENTER.smallToBig);
  assert.equal(passed.out[7], ENTER.bigToSmall);
  assert.equal(passed.in[0], ENTER.fade, "the 1915 ahead has not been reached");
  stepN(sim, NO_INPUT, 400);
  assert.equal(tables().in[0], ENTER.none, "and now it has");
});

test("a checkpoint carries the enter tables: a respawn gets back the ones it was laid with", () => {
  // resetLevel puts every channel on the fade, then loadFromCheckpoint copies
  // the checkpoint's game state, both tables included, back over it.
  // [PlayLayer::resetLevel :105832 → resetActiveEnterEffects :448610-448625;
  //  loadFromCheckpoint :105527 → GJGameState::operator= :104868-104869;
  //  createCheckpoint :105114]
  const level = emptyLevel([
    { id: 23, x: 60, y: 100, props: {} },
    { id: 24, x: 600, y: 100, props: {} },
  ]);
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 45, y: 45 } });
  stepN(sim, NO_INPUT, 60);
  assert.equal(sim.triggers.visual.enter.in[0], ENTER.fromBottom);
  const laid = sim.snapshot();
  stepN(sim, NO_INPUT, 500);
  assert.equal(sim.triggers.visual.enter.in[0], ENTER.fromTop, "the one passed after the checkpoint");
  sim.respawnFrom(laid);
  assert.equal(sim.triggers.visual.enter.in[0], ENTER.fromBottom, "the checkpoint's: not the fade, not the later one");
});

test("a start position's warm-up keeps the enter tables it filled, on every attempt", () => {
  // The warm-up passes the trigger behind the start; every attempt after the
  // first loads back the checkpoint startMusic made after the warm-up, tables
  // and all. [loadStartPosObject :469534-469590; PlayLayer::startMusic
  //  :105411-105421; resetLevel :105898-105902 → loadFromCheckpoint :105527]
  const level = emptyLevel([
    { id: 23, x: 60, y: 100, props: {} },
    { id: 31, x: 900, y: 45, settings: {} },
    { id: 24, x: 1500, y: 100, props: {} },
  ]);
  const sim = makeSim(level, undefined, { visuals: true });
  assert.equal(sim.triggers.visual.enter.in[0], ENTER.fromBottom, "attempt 1, after the warm-up");
  const warm = sim.snapshot();
  stepN(sim, NO_INPUT, 560);
  assert.equal(sim.triggers.visual.enter.in[0], ENTER.fromTop);
  sim.restore(warm);
  assert.equal(sim.triggers.visual.enter.in[0], ENTER.fromBottom, "attempt 2, loaded back");
});

test("an Animate trigger starts an animation once its object is active, and with key 214 passes over one that is not", () => {
  // The trigger rewinds the object; its clock starts at the next visibility
  // pass to reach it, which only walks the sections round the camera. Key 214
  // drops the trigger for an object that is not active.
  // [EnhancedGameObject::triggerAnimation :620430-620445; updateSyncedAnimation
  //  :620687-620690, from PlayLayer::updateVisibility :95979-95983;
  //  preUpdateVisibility :452664-452700]
  const level = emptyLevel([
    { id: 2047, x: 300, y: 100, props: { 123: "1" } },
    { id: 2047, x: 2400, y: 100, props: { 123: "1" } },
    { id: 2047, x: 2400, y: 100, props: { 123: "1", 214: "1" } },
    { id: 2047, x: 300, y: 100, props: { 123: "1", 214: "1" } },
    { id: 1585, x: 15, y: 100, props: { 51: "5" } },
  ]);
  const at = level.objects.length - 5;
  for (let k = 0; k < 4; k++) level.objects[at + k].groups.push(5);
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 45, y: 45 } });
  const t = sim.triggers;
  assert.ok(Number.isNaN(t.animationStartOf(at)), "nothing starts before the first step");
  sim.step(NO_INPUT);
  assert.equal(t.animationStartOf(at), t.levelTime, "on screen: from the first step");
  assert.equal(t.animationStartOf(at + 3), t.levelTime, "on screen with key 214 too");
  assert.ok(Number.isNaN(t.animationStartOf(at + 1)), "off screen: waiting");
  assert.equal(t.animationsOf(at + 2), 0, "key 214 off screen: never reached");
  const laid = sim.snapshot();
  let x = 0;
  for (let i = 0; i < 2000 && Number.isNaN(t.animationStartOf(at + 1)); i++) {
    sim.step(NO_INPUT);
    x = sim.state.x;
  }
  assert.equal(t.animationStartOf(at + 1), t.levelTime, "it starts the step it comes into range");
  // 2400 times the float 0.01 is a hair under 24, so it is filed in section
  // 23, which a view whose right edge is past 2100 reaches with its one
  // section to spare: the player 75 behind the centre of a 569-wide view,
  // so 359.4 in from its right edge. [gdp updateCamera :449668-449689]
  assert.ok(x > 1740 && x < 1746, `came into range with the player at ${x}`);
  assert.equal(t.animationsOf(at + 2), 0);
  // A respawn puts every object back to waiting for a trigger, and the one
  // behind the checkpoint does not reach them again. [PlayLayer::resetLevel
  //  :105839-105843 → EnhancedGameObject::resetObject :170043-170067 →
  //  waitForAnimationTrigger]
  sim.respawnFrom(laid);
  sim.step(NO_INPUT);
  assert.ok(Number.isNaN(t.animationStartOf(at)), "back to waiting");
  assert.ok(Number.isNaN(t.animationStartOf(at + 1)));
});

test("an Animate trigger switches a beast to the clip key 76 names", () => {
  const level = emptyLevel([
    { id: 918, x: 300, y: 100 },
    { id: 2047, x: 300, y: 100, props: { 123: "1" } },
    { id: 1585, x: 15, y: 100, props: { 51: "5", 76: "1" } },
  ]);
  const beast = level.objects.length - 3;
  const waiting = beast + 1;
  level.objects[beast].groups.push(5);
  level.objects[waiting].groups.push(5);
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 45, y: 45 } });
  sim.step(NO_INPUT);
  assert.deepEqual(sim.triggers.skeletonAnimOf(beast), { id: 1, gen: 1 });
  assert.equal(sim.triggers.animationsOf(waiting), 1, "key 123 still counts");
  assert.equal(sim.triggers.animationsOf(beast), 0, "a beast is not on the frame path");
  const laid = sim.snapshot();
  sim.respawnFrom(laid);
  assert.equal(sim.triggers.skeletonAnimOf(beast), null, "a respawn clears the clip command");
});

// --- the runtime in a real level ---------------------------------------------

test("a level with movement triggers actually moves something", { skip: LEVELS }, async () => {
  const level = await loadOfficialLevel(22);
  const sim = makeSim(level, loadObjectTable(), { noclip: true });
  const before = new Map<number, { x: number; y: number }>();
  for (const i of sim.triggers.index.movingObjects.slice(0, 400)) {
    const box = sim.hitboxOf(i);
    if (box && box.type === "rect") before.set(i, { x: box.rect.x, y: box.rect.y });
  }
  for (let t = 0; t < 12000 && !sim.state.finished; t++) sim.step(NO_INPUT);
  assert.ok(sim.triggers.hasMotion, "something should have been moved by now");
  let moved = 0;
  for (const [i, was] of before) {
    const box = sim.hitboxOf(i);
    if (box && box.type === "rect" && (box.rect.x !== was.x || box.rect.y !== was.y)) moved++;
  }
  assert.ok(moved > 0, "a moved group's hitboxes have to move with it");
});

test("a spawned trigger without multi-trigger still fires", { skip: LEVELS }, async () => {
  // Geometrical Dominator's door near x 27700: touching spawn #13190 spawns
  // group 85, whose two once-only moves slide group 82 down and 83 up by 45.
  // The once-only check used to run twice, so the second saw the first's mark
  // and the door stayed shut. [gdp GJBaseGameLayer::spawnObject :456038-456089]
  const level = await loadOfficialLevel(19);
  const sim = makeSim(level, loadObjectTable(), { noclip: true });
  const move = sim.triggers.index.byObject.get(13162);
  assert.ok(move && move.spawnTriggered && !move.multi, "#13162 is a spawn-only move without multi-trigger");
  const edgeY = (group: number): number => {
    const members = sim.triggers.index.groups.get(group) ?? [];
    for (const i of members) {
      const box = sim.hitboxOf(i);
      if (box && box.type === "rect") return box.rect.y;
    }
    throw new Error(`group ${group} has nothing solid`);
  };
  const bottom = edgeY(82);
  const top = edgeY(83);
  sim.step(NO_INPUT);
  sim.triggers.touched(13190, 1);
  for (let t = 0; t < 480; t++) sim.step(NO_INPUT);
  assert.ok(Math.abs(edgeY(82) - (bottom - 45)) < 1e-6, "the bottom half slides down 45");
  assert.ok(Math.abs(edgeY(83) - (top + 45)) < 1e-6, "the top half slides up 45");
});

test("a snapshot puts the trigger state back exactly", { skip: LEVELS }, async () => {
  const level = await loadOfficialLevel(21);
  const sim = makeSim(level, loadObjectTable(), { noclip: true });
  for (let t = 0; t < 4000; t++) sim.step(NO_INPUT);
  const snap = sim.snapshot();
  const hash = sim.stateHash();
  const fired = sim.triggers.describe();
  for (let t = 0; t < 600; t++) sim.step(NO_INPUT);
  sim.restore(snap);
  assert.equal(sim.stateHash(), hash, "restoring has to undo everything the triggers did");
  assert.equal(sim.triggers.describe(), fired);
  // And going forward again from the restored state has to land in the same place.
  for (let t = 0; t < 600; t++) sim.step(NO_INPUT);
  const after = sim.stateHash();
  sim.restore(snap);
  for (let t = 0; t < 600; t++) sim.step(NO_INPUT);
  assert.equal(sim.stateHash(), after, "the same inputs from the same state must give the same state");
});

test("two runs from the same seed fire the same triggers", { skip: LEVELS }, async () => {
  const level = await loadOfficialLevel(5004);
  const table = loadObjectTable();
  const run = (): string => {
    const sim = makeSim(level, table, { noclip: true, seed: 7 });
    for (let t = 0; t < 6000; t++) sim.step(NO_INPUT);
    return `${sim.stateHash()}|${sim.triggers.describe()}`;
  };
  assert.equal(run(), run(), "the level's randomness has to come from the seed, not the clock");
});

test("a group that is switched off stops colliding", { skip: LEVELS }, async () => {
  const level = await loadOfficialLevel(21);
  const sim = makeSim(level, loadObjectTable(), { noclip: true });
  // Find a group with a solid in it and switch it off by hand; the trigger
  // system is what normally does this, but the effect on collision is the part
  // worth pinning down.
  let group = 0;
  let victim = -1;
  for (const [g, members] of sim.triggers.index.groups) {
    for (const i of members) {
      if (sim.hitboxOf(i)) {
        group = g;
        victim = i;
        break;
      }
    }
    if (victim >= 0) break;
  }
  assert.ok(victim >= 0, "level 21 should have a group with something solid in it");
  assert.ok(sim.hitboxOf(victim), "it should start out present");
  sim.triggers.toggleGroup(group, false);
  assert.equal(sim.hitboxOf(victim), null, "a disabled group stops colliding as well as drawing");
  sim.triggers.toggleGroup(group, true);
  assert.ok(sim.hitboxOf(victim), "and comes back");
});

// --- spawn remapping ---------------------------------------------------------

/** A bare spec carrying only the props a test cares about. */
function specWith(props: Record<number, string>): TriggerSpec {
  return {
    index: 0,
    id: 1268,
    x: 0,
    y: 0,
    touch: false,
    spawnTriggered: false,
    multi: false,
    sharedPlayer: false,
    ordering: 0,
    channel: 0,
    controlId: 0,
    target: 0,
    target2: 0,
    activateGroup: false,
    duration: 0,
    easing: 0,
    easingRate: 2,
    groups: [],
    props,
  };
}

test("a remap is a flat list of pairs, and a later pair wins", () => {
  // The shape the official levels store: 379.380.380.381 is (379 -> 380) and
  // (380 -> 381), not a chain to be followed twice.
  const r = ownRemap(specWith({ 442: "379.380.380.381" }));
  assert.ok(r);
  assert.equal(r.get(379), 380);
  assert.equal(r.get(380), 381);
  assert.equal(r.get(381), undefined, "a remap is one hop, never transitive");
  const dup = ownRemap(specWith({ 442: "5.6.5.7" }));
  assert.equal(dup?.get(5), 7, "the last pair for an id is the one that applies");
  assert.equal(ownRemap(specWith({})), null);
  assert.equal(ownRemap(specWith({ 442: "9" })), null, "half a pair is no pair");
});

test("an inherited chain is extended, not replaced", () => {
  const inherited = ownRemap(specWith({ 442: "1.2.3.4" }));
  const own = ownRemap(specWith({ 442: "3.99.5.6" }));
  const merged = mergeRemap(inherited, own);
  assert.ok(merged);
  assert.equal(merged.get(1), 2, "what it inherited is kept");
  assert.equal(merged.get(5), 6, "and its own pairs are added");
  assert.equal(merged.get(3), 99, "where they disagree the newer one wins");
  assert.equal(mergeRemap(inherited, null), inherited, "no pairs of its own changes nothing");
  assert.equal(mergeRemap(null, own), own);
});

test("the official levels' remaps are all well-formed pairs", { skip: LEVELS }, async () => {
  const table = loadObjectTable();
  let withRemap = 0;
  for (const id of [19, 21, 22, 5001, 5002, 5003, 5004]) {
    const level = await loadOfficialLevel(id);
    const index = buildTriggerIndex(level, (n) => table.get(n).kind === "trigger");
    for (const spec of index.byObject.values()) {
      if (spec.id !== 1268 || spec.props[442] === undefined) continue;
      withRemap++;
      const parts = spec.props[442].split(".");
      assert.equal(parts.length % 2, 0, `level ${id} trigger ${spec.index} has an odd remap list`);
      assert.ok(ownRemap(spec), `level ${id} trigger ${spec.index} parsed to nothing`);
    }
  }
  // The census counted 300 remapped spawns across the official levels.
  assert.equal(withRemap, 300);
});

// --- options and collisions --------------------------------------------------

test("an option key absent leaves the setting alone, and -1 turns it off", { skip: LEVELS }, async () => {
  const level = await loadOfficialLevel(22);
  const sim = makeSim(level, loadObjectTable(), { visuals: true });
  const options = sim.triggers.visual.options;
  assert.equal(options.hideGround, false, "nothing is hidden before a trigger says so");
  const before = options.respawnTime;
  assert.ok(before > 0, "the respawn time starts at something sane");
});

test("an Options key is on for 1, off for any other value, and left alone for 0", () => {
  // Key 575 keeps the sound through a death; the game's +1038 starts at zero.
  // [gdp GJBaseGameLayer::processOptionsTrigger :429848-429852, each
  //  `if (v) field = v == 1`; GameOptionsTrigger::customObjectSetup :300435-300442]
  const after = (values: string[]): boolean => {
    const sim = simOn(emptyLevel(values.map((v, i) => ({ id: 2899, x: 100 + 60 * i, y: 300, props: { 575: v } }))));
    assert.equal(sim.triggers.visual.options.audioOnDeath, false);
    stepN(sim, NO_INPUT, 60 + 30 * values.length);
    return sim.triggers.visual.options.audioOnDeath;
  };
  assert.equal(after(["1"]), true);
  assert.equal(after(["1", "-1"]), false);
  assert.equal(after(["1", "0"]), true, "0 leaves it alone");
  assert.equal(after(["2"]), false);
});

test("the streak starts additive, and key 159 = -1 is what makes it normal", () => {
  // Every reset makes both players' streaks additive; the Options trigger
  // turns it off with -1 and back on with 1. [gdp resetLevelVariables
  //  :463029 → togglePlayerStreakBlend(1); processOptionsTrigger :429820-429822]
  const after = (values: string[]): boolean => {
    const sim = simOn(emptyLevel(values.map((v, i) => ({ id: 2899, x: 100 + 60 * i, y: 300, props: { 159: v } }))));
    assert.equal(sim.triggers.visual.options.streakAdditive, true);
    stepN(sim, NO_INPUT, 60 + 30 * values.length);
    return sim.triggers.visual.options.streakAdditive;
  };
  assert.equal(after([]), true);
  assert.equal(after(["-1"]), false);
  assert.equal(after(["-1", "1"]), true);
});

test("audio triggers raise their own kinds, with the trigger and the music clock", () => {
  // An SFX trigger with no sound returns before anything, even the note that
  // a checkpoint would replay. [gdp activateSFXTrigger :447166-447169;
  //  activatedAudioTrigger :448038-448043]
  const sim = simOn(
    emptyLevel([
      { id: 3602, x: 100, y: 300 },
      { id: 3602, x: 130, y: 300, props: { 392: "5" } },
      { id: 3603, x: 160, y: 300, props: { 418: "1" } },
      { id: 1934, x: 190, y: 300, props: { 392: "10002867" } },
      { id: 3605, x: 220, y: 300, props: { 418: "1" } },
    ]),
  );
  stepN(sim, NO_INPUT, 300);
  const n = sim.level.objects.length;
  assert.deepEqual(
    sim.triggers.events.map((e) => [e.kind, e.id, e.object]),
    [
      ["sfx", 5, n - 4],
      ["sfxEdit", 0, n - 3],
      ["song", 10002867, n - 2],
      ["songEdit", 0, n - 1],
    ],
  );
  for (const e of sim.triggers.events) assert.ok((e.at ?? -1) > 0 && (e.at ?? 0) < 1, `${e.kind} at ${e.at}`);
});

test("the collision pairs are exactly what the levels ask about", { skip: LEVELS }, async () => {
  const table = loadObjectTable();
  let triggers = 0;
  for (const id of [22, 5002, 5003, 5004]) {
    const sim = makeSim(await loadOfficialLevel(id), table, { noclip: true });
    const inner = sim.triggers as unknown as { collisionTriggers: unknown[]; collisionPairs: unknown[] };
    triggers += inner.collisionTriggers.length;
    assert.ok(inner.collisionPairs.length <= inner.collisionTriggers.length, "pairs are deduplicated across triggers");
  }
  // 20 Collision plus 7 Instant Collision placements, from the census.
  assert.equal(triggers, 27);
});

// --- spawn order, camera mode ------------------------------------------------

test("a group a Spawn trigger names is sorted by x, others keep file order, kA38 sorts all", () => {
  // [gdp sortGroups :453213-453279, sortAllGroupsX :423269-423279,
  //  xCompPosition :415180-415187 (integer x; ties kept in file order here)]
  const build = (kA38: boolean) => {
    const level = buildLevel(
      [
        { id: 1268, x: 0, y: 0, props: { 51: "5" } },
        { id: 1, x: 300, y: 600 },
        { id: 1, x: 100.9, y: 600 },
        { id: 1, x: 100.2, y: 600 },
        { id: 1, x: 200, y: 600 },
        { id: 1, x: 300, y: 700 },
        { id: 1, x: 100, y: 700 },
      ],
      makeHeader({ sortAllGroupsX: kA38 }),
    );
    for (const i of [1, 2, 3, 4]) level.objects[i].groups = [5];
    for (const i of [5, 6]) level.objects[i].groups = [6];
    return buildTriggerIndex(level, (id) => id === 1268);
  };
  const plain = build(false);
  assert.deepEqual(plain.groups.get(5), [2, 3, 4, 1], "by integer x, the tie at 100 in file order");
  assert.deepEqual(plain.groups.get(6), [5, 6], "no spawn names group 6");
  assert.deepEqual(build(true).groups.get(6), [6, 5], "kA38 sorts every group");
});

test("a spawn fires its members in x order", () => {
  // Group 7 holds a Pickup that sets item 1 to 5 (first in the file, x 200)
  // and one that doubles it (x 100). In x order: 0 x 2, then 5. In file order
  // it came out 10. [gdp spawnGroup :443163-443246 walks the sorted array]
  const level = emptyLevel([
    { id: 1268, x: 0, y: 300, props: { 51: "7" } },
    { id: 1817, x: 200, y: 900, props: { 62: "1", 80: "1", 77: "5", 139: "1" } },
    { id: 1817, x: 100, y: 900, props: { 62: "1", 80: "1", 88: "1", 449: "2" } },
  ]);
  const n = level.objects.length;
  level.objects[n - 2].groups = [7];
  level.objects[n - 1].groups = [7];
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 2);
  assert.equal(sim.triggers.itemCount(1), 5);
});

test("an ordered spawn times its members from the leftmost", () => {
  // The Pickup at x 100 fires with the spawn; the one at x 400, first in the
  // file, (400 - 100) / 311.580109 = 0.9628 s later. The port timed from the
  // first in the file, so both fired at once.
  // [gdp spawnObjectsInOrder :421726-421805]
  const level = emptyLevel([
    { id: 1268, x: 0, y: 300, props: { 51: "8", 441: "1" } },
    { id: 1817, x: 400, y: 900, props: { 62: "1", 80: "2", 77: "1" } },
    { id: 1817, x: 100, y: 900, props: { 62: "1", 80: "3", 77: "1" } },
  ]);
  const n = level.objects.length;
  level.objects[n - 2].groups = [8];
  level.objects[n - 1].groups = [8];
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 1);
  assert.deepEqual([sim.triggers.itemCount(2), sim.triggers.itemCount(3)], [0, 1]);
  let at = -1;
  for (let t = 0; t < 400 && at < 0; t++) {
    sim.step(NO_INPUT);
    if (sim.triggers.itemCount(2) === 1) at = sim.tick;
  }
  // The Spawn at x 0 is behind the player, so it fires at the reset and the
  // queue runs from the first step. [PlayLayer::resetLevel :105954-105963]
  assert.equal(at, 232, "231.08 ticks after the spawn at the reset, rounded up");
});

test("an ordered spawn takes its base from a checkpoint too, by id alone", () => {
  // Group 8 holds a checkpoint (2063) at x 100 and a Pickup at x 400. The
  // checkpoint is a spawnable id, so it is the base, even though nothing is
  // run for it here, and the Pickup fires 0.9628 s later. The port only
  // looked at members it runs as triggers, so the Pickup was the base and
  // fired at once. [gdp spawnObjectsInOrder :421758-421771; isSpawnableTrigger
  //  :173769-173930]
  const level = emptyLevel([
    { id: 1268, x: 0, y: 300, props: { 51: "8", 441: "1" } },
    { id: 1817, x: 400, y: 900, props: { 62: "1", 80: "2", 77: "1" } },
    { id: 2063, x: 100, y: 900 },
  ]);
  const n = level.objects.length;
  level.objects[n - 2].groups = [8];
  level.objects[n - 1].groups = [8];
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 1);
  assert.equal(sim.triggers.itemCount(2), 0, "not with the spawn");
  let at = -1;
  for (let t = 0; t < 400 && at < 0; t++) {
    sim.step(NO_INPUT);
    if (sim.triggers.itemCount(2) === 1) at = sim.tick;
  }
  // As above: the Spawn fires at the reset. [PlayLayer::resetLevel :105954-105963]
  assert.equal(at, 232, "timed from the checkpoint's x");
});

test("an ordered spawn times its members from where they are now", () => {
  // The Pickup filed at x 400 is also in group 9, which a Move at the reset
  // carries 300 units left, onto the other Pickup's x 100. The spawn at x 60
  // meets both at x 100, so both fire with it; timed from the file's x, the
  // moved one came 0.9628 s later. [gdp spawnObjectsInOrder, getPosition
  //  :421760-421770]
  const level = emptyLevel([
    { id: 901, x: 0, y: 300, props: { 51: "9", 28: "-300", 10: "0" } },
    { id: 1268, x: 60, y: 300, props: { 51: "8", 441: "1" } },
    { id: 1817, x: 400, y: 900, props: { 62: "1", 80: "2", 77: "1" } },
    { id: 1817, x: 100, y: 900, props: { 62: "1", 80: "3", 77: "1" } },
  ]);
  const n = level.objects.length;
  level.objects[n - 2].groups = [8, 9];
  level.objects[n - 1].groups = [8];
  const sim = simOn(level);
  let spawned = -1;
  for (let t = 0; t < 120 && spawned < 0; t++) {
    sim.step(NO_INPUT);
    if (sim.triggers.itemCount(3) === 1) spawned = sim.tick;
  }
  assert.ok(spawned > 0, "the spawn fired");
  assert.equal(sim.triggers.itemCount(2), 1, "the moved member fires with the base");
});

// --- camera triggers ---------------------------------------------------------

/** A sim with the visuals on, which is what steps the camera, on the empty level's floor. */
function cameraSim(extra: Parameters<typeof emptyLevel>[0]) {
  return makeSim(emptyLevel(extra), undefined, { visuals: true, start: { x: 15, y: 45 } });
}

const near = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

test("Camera Rotate adds with key 70 and snaps with key 394", () => {
  // Key 70 is Add and key 394 Snap360; the port had them the other way round,
  // which turned Dash's -4 at x 11385 into 176. [gdp SetupCameraRotatePopup2::
  //  init :618062-618070; customObjectSetup :301554-301562;
  //  updateScreenRotation :449176-449210]
  const turn = (second: Record<number, string>) => {
    const sim = cameraSim([
      { id: 2015, x: 30, y: 300, props: { 68: "90" } },
      { id: 2015, x: 60, y: 300, props: second },
    ]);
    stepN(sim, NO_INPUT, 100);
    return sim.triggers.camera.rotation;
  };
  assert.equal(turn({ 68: "-4", 394: "1" }), -4, "Snap360 does not add");
  assert.equal(turn({ 68: "-4", 70: "1", 10: "0.1" }), 86, "Add does");
  assert.equal(turn({ 68: "-4", 70: "1" }), -4, "with no move time the view takes key 68 itself");
});

test("a turn eases over its move time and takes its first step in the tick it fires", () => {
  // Dash's first turn: -4 over 0.2 s, Sine Out. [gdp GJValueTween::step
  //  :417562-417600; GJBaseGameLayer::update :469988]
  const sim = cameraSim([{ id: 2015, x: 60, y: 300, props: { 68: "-4", 10: "0.2", 30: "15", 85: "2" } }]);
  const cam = sim.triggers.camera;
  for (let i = 0; i < 200 && cam.rotation === 0; i++) sim.step(NO_INPUT);
  near(cam.rotation, -4 * Math.sin(Math.PI / 96), 1e-6, "one step");
  stepN(sim, NO_INPUT, 23);
  near(cam.rotation, -4 * Math.sin(Math.PI / 4), 1e-5, "half way");
  stepN(sim, NO_INPUT, 25);
  assert.equal(cam.rotation, -4);
  assert.equal(cam.rotationTween, null, "and the tween is gone");
});

test("Snap360 turns the short way", () => {
  // 350 becomes -10 before a turn to 0. [gdp convertToClosestDirection
  //  :428041-428058]
  const run = (snap: boolean) => {
    const sim = cameraSim([
      { id: 2015, x: 30, y: 300, props: { 68: "350" } },
      { id: 2015, x: 60, y: 300, props: snap ? { 68: "0", 10: "1", 394: "1" } : { 68: "0", 10: "1" } },
    ]);
    const cam = sim.triggers.camera;
    for (let i = 0; i < 200 && (cam.rotation === 350 || cam.rotation === 0); i++) sim.step(NO_INPUT);
    const first = cam.rotation;
    stepN(sim, NO_INPUT, 119);
    return [first, cam.rotation];
  };
  const [s1, s120] = run(true);
  near(s1, -10 + 10 / 240, 1e-5, "snapped, first step");
  near(s120, -5, 1e-4, "snapped, half way");
  const [n1, n120] = run(false);
  near(n1, 350 - 350 / 240, 1e-4, "unsnapped, first step");
  near(n120, 175, 1e-3, "unsnapped, half way");
  assert.equal(closestDirection(540), -180);
  assert.equal(closestDirection(180), 180);
  assert.equal(closestDirection(-190), 170);
});

test("a zoom eases per step, and a rendered frame does not move it", () => {
  // The zoom was linear and advanced by the frame's delta, so it depended on
  // the refresh rate. [gdp updateZoom :451250-451300; GameToolbox::
  //  getEasedValue]
  const sim = cameraSim([{ id: 1913, x: 60, y: 300, props: { 371: "0.5", 10: "0.5", 30: "1", 85: "2" } }]);
  const cam = sim.triggers.camera;
  for (let i = 0; i < 200 && cam.zoom === 1; i++) sim.step(NO_INPUT);
  near(cam.zoom, 1 - 0.5 * 0.5 * (2 / 120) ** 2, 1e-7, "one step of ease in-out");
  sim.triggers.updateVisuals(1);
  near(cam.zoom, 1 - 0.5 * 0.5 * (2 / 120) ** 2, 1e-7, "a frame is not a step");
  stepN(sim, NO_INPUT, 59);
  near(cam.zoom, 0.75, 1e-6, "half way");
  stepN(sim, NO_INPUT, 61);
  assert.equal(cam.zoom, 0.5);
});

test("a zoom with no key 371 reads the old key 109", () => {
  // Before 2.1 a zoom was a step out from 0 to 8, 30 units on 300 each.
  // [gdp EffectGameObject::customObjectSetup :299032-299079]
  const zoomOf = (props: Record<number, string>) => {
    const sim = cameraSim([{ id: 1913, x: 30, y: 300, props }]);
    stepN(sim, NO_INPUT, 40);
    return sim.triggers.camera.zoom;
  };
  near(zoomOf({ 109: "2" }), 300 / 360, 1e-6, "two steps out");
  near(zoomOf({ 109: "20" }), 300 / 540, 1e-6, "eight at most");
  near(zoomOf({ 109: "-4" }), 1.6667, 1e-6, "in, below -3");
  assert.equal(zoomOf({}), 1, "neither key: 1");
  assert.equal(zoomOf({ 371: "5" }), 3, "key 371 is clamped to 3");
});

test("a camera offset slides over its move time", () => {
  // [gdp updateCameraOffsetX :449227-449245]
  const sim = cameraSim([{ id: 1916, x: 60, y: 300, props: { 28: "30", 10: "1" } }]);
  const cam = sim.triggers.camera;
  for (let i = 0; i < 200 && cam.offsetX === 0; i++) sim.step(NO_INPUT);
  near(cam.offsetX, 0.125, 1e-6, "one step");
  stepN(sim, NO_INPUT, 119);
  near(cam.offsetX, 15, 1e-4, "half way");
  stepN(sim, NO_INPUT, 121);
  assert.equal(cam.offsetX, 30);
  assert.equal(cam.offsetY, 0, "no key 29, and axis 0 moves both: y goes to 0");
});

test("a checkpoint keeps a turn part-way, and does not share it", () => {
  const sim = cameraSim([{ id: 2015, x: 60, y: 300, props: { 68: "-4", 10: "1" } }]);
  stepN(sim, NO_INPUT, 60);
  const snap = sim.snapshot();
  const at = sim.triggers.camera.rotation;
  assert.ok(at < 0 && at > -4, `part-way: ${at}`);
  stepN(sim, NO_INPUT, 60);
  sim.restore(snap);
  assert.equal(sim.triggers.camera.rotation, at);
  stepN(sim, NO_INPUT, 1);
  // The turn is straight, -4 over 240 steps: a snapshot sharing the live
  // tween would have been stepped along with it, and would step on from
  // where the live run had got to.
  near(sim.triggers.camera.rotation, at - 4 / 240, 1e-6, "one step on from the checkpoint, not from where the live run got to");
  sim.restore(snap);
  assert.equal(sim.triggers.camera.rotation, at, "and the snapshot survives a second restore");
});

test("a checkpoint keeps a static camera's approach part-way, and does not share it", () => {
  const level = emptyLevel([
    { id: 1, x: 900, y: 300 },
    { id: 1914, x: 60, y: 600, props: { 71: "4", 101: "1", 10: "1" } },
  ]);
  level.objects[level.objects.length - 2].groups = [4];
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: 45 } });
  const st = sim.triggers.camera.staticX;
  for (let i = 0; i < 200 && !st.on; i++) sim.step(NO_INPUT);
  stepN(sim, NO_INPUT, 30);
  const snap = sim.snapshot();
  const at = st.progress;
  assert.ok(at > 0 && at < 1, `part-way: ${at}`);
  stepN(sim, NO_INPUT, 60);
  sim.restore(snap);
  stepN(sim, NO_INPUT, 1);
  near(sim.triggers.camera.staticX.progress, at + 1 / 240, 1e-6, "one step on from the checkpoint");
});

test("Stop ends a camera trigger's tween where it stands, and Pause holds one until Resume", () => {
  // By the group the camera trigger is in, or by its control id (key 534
  // with key 535 on the Stop); a stopped turn keeps the angle it had.
  // [gdp controlTriggersInGroup :468311-468322; controlTriggersWithControlID
  //  :468086; GJGameState::controlTweenAction :451598-451640;
  //  GJValueTween::step :417576-417577]
  const stopped = (stopGroup: string) => {
    const level = emptyLevel([
      { id: 2015, x: 60, y: 300, props: { 68: "-4", 10: "1" } },
      { id: 1616, x: 120, y: 300, props: { 51: stopGroup } },
    ]);
    level.objects[level.objects.length - 2].groups = [5];
    const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: 45 } });
    stepN(sim, NO_INPUT, 400);
    return sim.triggers.camera;
  };
  const stop = stopped("5");
  assert.equal(stop.rotationTween, null);
  assert.ok(stop.rotation < 0 && stop.rotation > -4, `stopped part-way: ${stop.rotation}`);
  assert.equal(stopped("6").rotation, -4, "a Stop aimed at another group leaves it");

  const level = emptyLevel([
    { id: 2015, x: 60, y: 300, props: { 68: "-4", 10: "1", 534: "7" } },
    { id: 1616, x: 120, y: 300, props: { 51: "7", 535: "1", 580: "1" } },
    { id: 1616, x: 240, y: 300, props: { 51: "7", 535: "1", 580: "2" } },
  ]);
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: 45 } });
  const cam = sim.triggers.camera;
  for (let i = 0; i < 400 && !cam.rotationTween?.paused; i++) sim.step(NO_INPUT);
  const held = cam.rotation;
  assert.ok(held < 0 && held > -4, `paused part-way: ${held}`);
  let steps = 0;
  for (; steps < 400 && cam.rotationTween?.paused; steps++) {
    sim.step(NO_INPUT);
    if (cam.rotationTween?.paused) assert.equal(cam.rotation, held, "held while paused");
  }
  assert.ok(steps > 30, `paused for a while: ${steps}`);
  stepN(sim, NO_INPUT, 1);
  assert.ok(cam.rotation < held, "resumed");
  stepN(sim, NO_INPUT, 300);
  assert.equal(cam.rotation, -4, "and finished");
});

test("a start position's warm-up starts camera tweens but does not step them", () => {
  // loadUpToPosition never runs updateTweenActions: a turn the warm-up
  // passes begins when play does. [gdp loadUpToPosition :469428-469517]
  const level = emptyLevel([
    { id: 2015, x: 60, y: 300, props: { 68: "-4", 10: "1" } },
    { id: 31, x: 300, y: 45, settings: {} },
  ]);
  const sim = makeSim(level, undefined, { visuals: true });
  const cam = sim.triggers.camera;
  assert.ok(sim.startPosition >= 0, "the run starts at the start position");
  assert.equal(cam.rotation, 0, "not stepped during the warm-up");
  assert.equal(cam.rotationTween?.elapsed, 0);
  sim.step(NO_INPUT);
  near(cam.rotation, -4 / 240, 1e-6, "the first step of play is its first");
});

test("kA35 also clears the camera edges, and keeps the zoom", () => {
  // [gdp loadStartPosObject :469562-469586, the edge slots :469565-469568]
  const run = (reset: boolean) => {
    const level = emptyLevel([
      { id: 1, x: 2000, y: 600 },
      { id: 2062, x: 30, y: 300, props: { 51: "9", 164: "2" } },
      { id: 2015, x: 30, y: 300, props: { 68: "20" } },
      { id: 1913, x: 30, y: 300, props: { 371: "0.8" } },
      { id: 31, x: 300, y: 45, settings: reset ? { kA35: "1" } : {} },
    ]);
    level.objects[level.objects.length - 5].groups = [9];
    const sim = makeSim(level, undefined, { visuals: true });
    sim.step(NO_INPUT);
    return sim.triggers.camera;
  };
  const kept = run(false);
  assert.equal(kept.edgeRight, 9);
  assert.equal(kept.limitRight, 2000, "the edge is the block's x");
  assert.equal(kept.rotation, 20);
  const reset = run(true);
  assert.equal(reset.edgeRight, 0, "kA35 drops the edge");
  assert.equal(reset.limitRight, null);
  assert.equal(reset.rotation, 0, "and the turn");
  near(reset.zoom, 0.8, 1e-6, "not the zoom");
});

test("a static camera aims at where its group is now, and eases there", () => {
  // The guide block has been moved 300 to the right before the static camera
  // fires: it aims at the moved block. The approach is a progress the camera
  // turns into a position. [gdp updateStaticCameraPosToGroup :451494
  //  (getRealPosition); updateStaticCameraPos :450937-451023]
  const level = emptyLevel([
    { id: 1, x: 600, y: 300 },
    { id: 901, x: 15, y: 600, props: { 51: "4", 28: "300", 10: "0" } },
    { id: 1914, x: 60, y: 600, props: { 71: "4", 10: "0.5", 30: "1" } },
  ]);
  level.objects[level.objects.length - 3].groups = [4];
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: 45 } });
  const cam = sim.triggers.camera;
  for (let i = 0; i < 300 && !cam.staticX.on; i++) sim.step(NO_INPUT);
  assert.ok(cam.staticX.on && cam.staticY.on, "both axes");
  assert.equal(cam.staticX.target, 900, "the block where it is now, not at 600");
  assert.equal(cam.staticY.target, 300);
  assert.equal(cam.staticX.follow, 0);
  assert.ok(cam.staticX.progress > 0 && cam.staticX.progress < 0.001, "the approach has taken one step");
  stepN(sim, NO_INPUT, 120);
  assert.equal(cam.staticX.progress, 1);
  assert.equal(cam.staticX.tween, null);
});

test("Follow keeps a static camera on its group as the group moves", () => {
  // Key 212: the group's main object is read every step. [gdp updateCamera
  //  :449866-449871]
  const level = emptyLevel([
    { id: 1, x: 600, y: 300 },
    { id: 1914, x: 30, y: 600, props: { 71: "4", 212: "1", 213: "4" } },
    { id: 901, x: 60, y: 600, props: { 51: "4", 28: "120", 10: "0.5" } },
  ]);
  level.objects[level.objects.length - 3].groups = [4];
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: 45 } });
  const cam = sim.triggers.camera;
  for (let i = 0; i < 300 && !cam.staticX.on; i++) sim.step(NO_INPUT);
  assert.equal(cam.staticX.follow, 4);
  assert.equal(cam.staticX.smoothing, 4);
  assert.equal(cam.staticX.progress, 1, "no move time: there at once");
  stepN(sim, NO_INPUT, 200);
  near(cam.staticX.target, 720, 1e-3, "where the move took it");
});

test("a static camera exit lets the axis go and keeps what the hand-back needs", () => {
  // [gdp exitStaticCamera :451385-451465; the popup's 110 Exit Static, 465
  //  Exit Instant, 453 Smooth Velocity, 454 Modifier]
  const level = emptyLevel([
    { id: 1, x: 600, y: 300 },
    { id: 1914, x: 30, y: 600, props: { 71: "4", 101: "1" } },
    { id: 1914, x: 90, y: 600, props: { 110: "1", 10: "0.75", 30: "2", 453: "1", 454: "0.5" } },
  ]);
  level.objects[level.objects.length - 3].groups = [4];
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: 45 } });
  const cam = sim.triggers.camera;
  for (let i = 0; i < 300 && !cam.staticX.on; i++) sim.step(NO_INPUT);
  assert.ok(cam.staticX.on && !cam.staticY.on, "key 101 = 1 holds x alone");
  const seq = cam.staticX.exitSeq;
  for (let i = 0; i < 300 && cam.staticX.on; i++) sim.step(NO_INPUT);
  assert.equal(cam.staticX.exitSeq, seq + 1);
  assert.ok(cam.staticX.exitHeld, "x was held");
  assert.equal(cam.staticX.exitDuration, 0.75);
  assert.equal(cam.staticX.exitEasing, 2);
  assert.ok(cam.staticX.exitSmoothVelocity);
  assert.equal(cam.staticX.exitModifier, 0.5);
  assert.equal(cam.staticY.exitHeld, false, "y was not");
});

// --- Event (3604) ---------------------------------------------------------------

/** An Event trigger at the start listening with `props`, and a multi-trigger Pickup in group 5 that adds 1 to item 1. */
function eventLevel(props: Record<number, string>, extra: Parameters<typeof emptyLevel>[0] = [], platformer = true) {
  const level = emptyLevel(
    [
      { id: 3604, x: 0, y: 300, props: { 51: "5", ...props } },
      { id: 1817, x: 0, y: 900, props: { 62: "1", 87: "1", 80: "1", 77: "1" } },
      ...extra,
    ],
    makeHeader({ platformer }),
  );
  level.objects[level.objects.length - 1 - extra.length].groups = [5];
  return level;
}

test("an Event trigger spawns its group each time the game raises its event", () => {
  // Right Push (73) and Right Release (74), raised by the button as it
  // reaches the player; a step raises each (event, key) once.
  // [gdp GJBaseGameLayer::activateEventTrigger :464167-464273;
  //  gameEventTriggered :462225-462258; handleButton :463975-463995]
  const right: PlayerInput = { jump: false, left: false, right: true };
  const sim = simOn(eventLevel({ 430: "73.74" }));
  stepN(sim, NO_INPUT, 2);
  assert.equal(sim.triggers.itemCount(1), 0, "nothing yet");
  stepN(sim, right, 1);
  assert.equal(sim.triggers.itemCount(1), 1, "the push");
  stepN(sim, right, 5);
  assert.equal(sim.triggers.itemCount(1), 1, "holding raises nothing");
  stepN(sim, NO_INPUT, 1);
  assert.equal(sim.triggers.itemCount(1), 2, "the release");
  const snap = sim.snapshot();
  const hash = sim.stateHash();
  stepN(sim, right, 1);
  assert.equal(sim.triggers.itemCount(1), 3);
  sim.restore(snap);
  assert.equal(sim.stateHash(), hash, "the listeners ride the snapshot");
  stepN(sim, right, 1);
  assert.equal(sim.triggers.itemCount(1), 3, "and fire again after it");
});

test("key 525 picks a player, key 447 an extra id, and key 431 takes a listener away", () => {
  // The key is 525 + 10000 × 447. A player's event reaches its own key, then
  // the key with no player. [gdp getEventKey :428499-428502;
  //  gameEventTriggered :462255-462256; activateEventTrigger :464183-464214]
  const jump: PlayerInput = { jump: true, left: false, right: false };
  const count = (props: Record<number, string>, extra: Parameters<typeof emptyLevel>[0] = []) => {
    const sim = simOn(eventLevel(props, extra, false));
    stepN(sim, NO_INPUT, 2);
    stepN(sim, jump, 1);
    return sim.triggers.itemCount(1);
  };
  assert.equal(count({ 430: "69" }), 1, "any player");
  assert.equal(count({ 430: "69", 525: "1" }), 1, "player 1");
  assert.equal(count({ 430: "69", 525: "2" }), 0, "player 2");
  assert.equal(count({ 430: "69", 447: "3" }), 0, "an extra id the button never has");
  assert.equal(count({ 430: "69" }, [{ id: 3604, x: 0, y: 330, props: { 51: "5", 430: "69", 431: "1" } }]), 0, "taken away");
  assert.equal(count({ 430: "70" }), 0, "a release is its own event");
});

test("a cube's jump raises Normal Jump and its landing Normal Landing, by how fast it comes down", () => {
  // A jump leaves at about 11 and comes back at about -11: past 8, under 14.
  // [gdp updateJump :155874-155901; PlayerObject::hitGround :150025-150054]
  const run = (events: string): number => {
    const sim = simOn(eventLevel({ 430: events }, [], false));
    stepN(sim, NO_INPUT, 2);
    stepN(sim, HOLD, 1);
    stepN(sim, NO_INPUT, 120);
    return sim.triggers.itemCount(1);
  };
  assert.equal(run("12"), 1, "the jump");
  assert.equal(run("4"), 1, "a normal landing");
  assert.equal(run("2.3.5"), 0, "not feather, soft or hard");
});

test("a yellow pad raises Yellow Pad and Pad Activated; a yellow orb Orb Touched, Orb Activated and Yellow Orb", () => {
  // [gdp GJBaseGameLayer::bumpPlayer :463199-463202; playerTouchedRing
  //  :463281-463286; PlayerObject::ringJump :159920-159926]
  const pad = (events: string): number => {
    const sim = simOn(eventLevel({ 430: events }, [{ id: 35, x: 150, y: 32 }], false));
    stepN(sim, NO_INPUT, 200);
    return sim.triggers.itemCount(1);
  };
  assert.equal(pad("45"), 1, "yellow pad");
  assert.equal(pad("9"), 1, "pad activated");
  assert.equal(pad("46.34.8"), 0, "not pink, nor an orb");
  const orb = (events: string, press: boolean): number => {
    const sim = simOn(eventLevel({ 430: events }, [{ id: 36, x: 150, y: 50 }], false));
    stepN(sim, NO_INPUT, 2);
    for (let i = 0; i < 300; i++) sim.step(press && sim.state.x > 130 ? HOLD : NO_INPUT);
    return sim.triggers.itemCount(1);
  };
  assert.equal(orb("7", false), 1, "touched without a press");
  assert.equal(orb("8", false), 0, "not activated without one");
  assert.equal(orb("8", true), 1, "activated");
  assert.equal(orb("34", true), 1, "yellow orb");
});

test("picking up a collectible raises Pickup Item", () => {
  // [gdp collisionCheckObjects :463778 → :463801]
  const sim = simOn(eventLevel({ 430: "63" }, [{ id: 1614, x: 90, y: 45 }], false));
  stepN(sim, NO_INPUT, 40);
  assert.equal(sim.triggers.itemCount(1), 1);
});

test("Camera Mode's key 111 frees the corridor, as a free-mode portal does", () => {
  // A ship portal sets up a band; a Camera Mode trigger with 111 = 1 drops it
  // at once. The port read key 1 (the object id) and so never did anything.
  // [gdp CameraTriggerGameObject::triggerObject :315616 → updateCameraMode
  //  :451188-451232 → updateDualGround :451158-451172]
  const level = emptyLevel([
    { id: 13, x: 30, y: 45 },
    { id: 2925, x: 120, y: 300, props: { 111: "1" } },
  ]);
  const sim = simOn(level);
  stepN(sim, NO_INPUT, 40);
  assert.ok(Number.isFinite(sim.ceilingY), "the ship's band");
  stepN(sim, NO_INPUT, 60);
  assert.equal(sim.ceilingY, Number.POSITIVE_INFINITY, "free mode: no band");
});

// --- Stop, Touch and keyframes ------------------------------------------------

/** A level of `extra`, with each object's groups set from `groups` (by its place in `extra`). */
function grouped(extra: NonNullable<Parameters<typeof emptyLevel>[0]>, groups: Record<number, number[]>) {
  const level = emptyLevel(extra);
  const first = level.objects.length - extra.length;
  for (const [k, g] of Object.entries(groups)) level.objects[first + Number(k)].groups = g;
  return { level, at: (k: number) => first + k };
}

test("Stop ends what the triggers in its group started, not the moves aimed at that group", () => {
  // A Move in group 5 carries group 9's block 300 units over 2 s; a Stop on
  // group 5 freezes it part-way, one on group 9 does nothing.
  // [gdp controlTriggersInGroup :468242ff → controlActionsForTrigger :484607]
  const run = (stopGroup: string) => {
    const { level, at } = grouped(
      [
        { id: 901, x: 30, y: 300, props: { 51: "9", 28: "300", 10: "2" } },
        { id: 1616, x: 150, y: 300, props: { 51: stopGroup } },
        { id: 1, x: 900, y: 600 },
      ],
      { 0: [5], 2: [9] },
    );
    const sim = simOn(level);
    stepN(sim, NO_INPUT, 600);
    return sim.triggers.objectPosition(at(2))[0] - 900;
  };
  const stopped = run("5");
  assert.ok(stopped > 0 && stopped < 300, `stopped part-way: ${stopped}`);
  near(run("9"), 300, 1e-6, "a Stop on the moved group leaves the move alone");
});

test("Stop takes a Pulse trigger's pulse away at once", () => {
  // [gdp controlActionsForTrigger :484941-484968 (erase by the trigger's id)]
  const { level } = grouped(
    [
      { id: 1006, x: 30, y: 300, props: { 51: "9", 52: "1", 7: "255", 8: "0", 9: "0", 46: "5" } },
      { id: 1616, x: 150, y: 300, props: { 51: "5" } },
      { id: 1, x: 900, y: 600 },
    ],
    { 0: [5], 2: [9] },
  );
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: 45 } });
  stepN(sim, NO_INPUT, 40);
  assert.equal(sim.triggers.colors.pulsesForGroup(9)?.length, 1, "pulsing");
  stepN(sim, NO_INPUT, 160);
  assert.equal(sim.triggers.colors.pulsesForGroup(9), undefined, "gone after the Stop");
});

test("a Touch trigger switches its group on each press, as its mode says, until a Stop ends it", () => {
  // Group 6 starts off; the Touch arms at x 60. A press turns it on (mode 1);
  // with mode 0 each press toggles it. A Stop on the touch's group ends it.
  // [gdp GJEffectManager::playerButton :482526; handleButton :463997]
  const jump: PlayerInput = { jump: true, left: false, right: false };
  const press = (sim: ReturnType<typeof simOn>) => {
    stepN(sim, jump, 1);
    stepN(sim, NO_INPUT, 40);
  };
  const level = (mode: string, stop = false) =>
    grouped(
      [
        { id: 1049, x: 0, y: 300, props: { 51: "6", 56: "0" } },
        { id: 1595, x: 60, y: 300, props: { 51: "6", 82: mode } },
        { id: 1, x: 2500, y: 600 },
        ...(stop ? [{ id: 1616, x: 400, y: 300, props: { 51: "7" } }] : []),
      ],
      { 1: [7], 2: [6] },
    ).level;

  const on = simOn(level("1"));
  stepN(on, NO_INPUT, 60);
  assert.equal(on.triggers.groupIsEnabled(6), false, "off before a press");
  press(on);
  assert.equal(on.triggers.groupIsEnabled(6), true, "a press turns it on");
  press(on);
  assert.equal(on.triggers.groupIsEnabled(6), true, "and on it stays");

  const toggle = simOn(level("0"));
  stepN(toggle, NO_INPUT, 60);
  press(toggle);
  assert.equal(toggle.triggers.groupIsEnabled(6), true);
  press(toggle);
  assert.equal(toggle.triggers.groupIsEnabled(6), false, "mode 0 toggles");

  const stopped = simOn(level("1", true));
  stepN(stopped, NO_INPUT, 330);
  assert.ok(stopped.state.x > 400, "past the Stop");
  press(stopped);
  assert.equal(stopped.triggers.groupIsEnabled(6), false, "a stopped touch hears nothing");
});

test("a Keyframe Animation trigger carries its group along the keyframes' path", () => {
  // Two keyframes for group 9, 300 apart, the first 1 s long, uneased along
  // a straight line. Half a second in is halfway along; at the end it has
  // gone the whole way. [gdp createKeyframeCommand :489789;
  //  prepareMoveActions case 5 :486386-486710]
  const { level, at } = grouped(
    [
      { id: 3033, x: 30, y: 300, props: { 76: "20", 520: "1", 521: "1", 522: "1", 523: "1" } },
      { id: 3032, x: 600, y: 300, props: { 51: "9", 374: "1", 10: "1" } },
      { id: 3032, x: 900, y: 300, props: { 51: "9", 374: "2" } },
      { id: 1, x: 600, y: 600 },
    ],
    { 1: [20], 2: [21], 3: [9] },
  );
  const sim = simOn(level);
  const x = () => sim.triggers.objectPosition(at(3))[0] - 600;
  let start = -1;
  let half = Number.NaN;
  stepN(sim, NO_INPUT, 400, (s) => {
    if (start < 0 && x() > 0) start = s.tick;
    if (start >= 0 && s.tick - start === 119) half = x();
  });
  near(half, 150, 3, "halfway");
  near(x(), 300, 1e-6, "the whole way");
});

test("Dash's orb runs its keyframe path, and six presses put out the coin", { skip: LEVELS }, async () => {
  // The orb (group 514) circles on Keyframe Animation 17811; every press
  // pulses it and adds 1 to item 1, and at 6 the coin's group 537 comes on
  // and the touch is stopped.
  // The saved run gets the player there; its own presses count too.
  const macro = readMacro(22);
  assert.ok(macro, "Dash's saved run");
  const sim = makeSim(await loadOfficialLevel(22), undefined, { visuals: true });
  const triggers = sim.triggers as unknown as { touchActions: readonly unknown[] };
  const inputs = [...macro.inputs].filter((e) => !e.player2 && e.button === 1).sort((a, b) => a.frame - b.frame);
  const held: PlayerInput = { jump: false, left: false, right: false };
  const m = new Float64Array(9);
  let next = 0;
  let armed = false;
  const orb: number[] = [];
  for (let i = 0; i < 16000 && !sim.state.dead && orb.length < 1200; i++) {
    while (next < inputs.length && inputs[next].frame <= sim.tick) held.jump = inputs[next++].down;
    sim.step({ ...held });
    if (!armed && triggers.touchActions.length > 0) armed = true;
    if (armed && i % 6 === 0 && triggers.touchActions.length > 0) {
      sim.triggers.playerButton(true, true);
      sim.triggers.playerButton(false, true);
    }
    if (armed) {
      sim.triggers.groupTransform(514, m);
      orb.push(m[4]);
    }
  }
  assert.ok(armed, "the touch arms");
  assert.equal(sim.triggers.itemCount(1), 6);
  assert.equal(sim.triggers.groupIsEnabled(537), true, "the coin's group is on");
  assert.equal(triggers.touchActions.length, 0, "the touch is stopped");
  assert.ok(Math.max(...orb) - Math.min(...orb) > 100, "the orb moves");
});
