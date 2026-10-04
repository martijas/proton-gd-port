// The level-settings switches that keep old levels playing the old way:
// kA27 "Allow Multi-Rotation", kA41 "Allow Static-Rotate" and kA42 "Reverse
// Sync". New levels get all three; the official ones have none. Then two a
// level may set: kA44, a percentage by time, and kA45, less boost slide.
// [LevelSettingsObject::objectFromDict, gd-ida-decomp.cpp:196245-196259;
//  GJBaseGameLayer::resetLevelVariables :462936-462961]

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SimImpl } from "../src/physics/sim";
import { NO_INPUT } from "../src/physics/types";
import { emptyLevel, makeHeader, simOn, stepN, type Placed } from "./levelKit";

function withGroups(extra: Placed[], groups: Record<number, number>, header = makeHeader()) {
  const level = emptyLevel(extra, header);
  const first = level.objects.length - extra.length;
  for (const [i, g] of Object.entries(groups)) level.objects[first + Number(i)].groups = [g];
  return { level, at: (i: number) => first + i };
}

test("without kA27 only the newest rotate on a group turns it, and the older one loses its share meanwhile", () => {
  // A: 180° over 2 s from the reset, 0.375° a step. B: 90° over 0.5 s, spawned
  // 0.5 s in (step 121) and live to step 242. With kA27 both turn the group:
  // 270°. Without it A turns for steps 2-120 and 243-481 only: 358 × 0.375 +
  // 90 = 224.25°. [gdp GJEffectManager::prepareMoveActions :486170,
  //  :486272-486289; processRotationActions :439888-439901]
  const spinAt = (multi: boolean, ticks: number[]) => {
    const { level } = withGroups(
      [
        { id: 1346, x: 0, y: 300, props: { 51: "2", 68: "180", 10: "2" } },
        { id: 1268, x: 0, y: 300, props: { 51: "5", 63: "0.5" } },
        { id: 1346, x: 0, y: 300, props: { 51: "2", 68: "90", 10: "0.5", 62: "1" } },
        { id: 8, x: 300, y: 600 },
      ],
      { 2: 5, 3: 2 },
      makeHeader({ allowMultiRotation: multi }),
    );
    const sim = simOn(level);
    return ticks.map((k) => {
      stepN(sim, NO_INPUT, k - sim.tick);
      return Number(sim.triggers.groupSpinOf(2).toFixed(6));
    });
  };
  assert.deepEqual(spinAt(true, [120, 121, 600]), [44.625, 45, 270]);
  assert.deepEqual(spinAt(false, [120, 121, 241, 600]), [44.625, 44.625, 134.625, 224.25]);
});

test("without kA27 a 0° rotate holds an older rotate on its group back for one step", () => {
  // As above, with B a 0° rotate: the game still makes it a command, done at
  // once, so it is the newest on group 2 for step 121 alone and A loses that
  // step's 0.375°. With kA27 it does nothing. [gdp createRotateCommand
  //  :489608-489645; runRotateCommand :716195ff; prepareMoveActions
  //  :486272-486289, :486713-486718]
  const spinAt = (multi: boolean, ticks: number[]) => {
    const { level } = withGroups(
      [
        { id: 1346, x: 0, y: 300, props: { 51: "2", 68: "180", 10: "2" } },
        { id: 1268, x: 0, y: 300, props: { 51: "5", 63: "0.5" } },
        { id: 1346, x: 0, y: 300, props: { 51: "2", 68: "0", 10: "0.5", 62: "1" } },
        { id: 8, x: 300, y: 600 },
      ],
      { 2: 5, 3: 2 },
      makeHeader({ allowMultiRotation: multi }),
    );
    const sim = simOn(level);
    return ticks.map((k) => {
      stepN(sim, NO_INPUT, k - sim.tick);
      return Number(sim.triggers.groupSpinOf(2).toFixed(6));
    });
  };
  assert.deepEqual(spinAt(true, [120, 121, 122, 600]), [44.625, 45, 45.375, 180]);
  assert.deepEqual(spinAt(false, [120, 121, 122, 600]), [44.625, 44.625, 45, 179.625]);
});

test("without kA41 a solid carried round a centre keeps its angle; a hazard still turns", () => {
  // A quarter turn about the block at (600, 500), at once. The platform (1903,
  // 30 × 14) lands at (700, 500) either way; only kA41 turns its box on end,
  // and its art: the draw list carries a sprite through the same transform,
  // whose linear part has no turn in it without kA41. The spike beside it
  // turns in both. [GameObject::canRotateFree :168950-168958;
  //  applyLevelSettings :430498-430512; processRotationActions :440000-440016]
  const after = (staticRotate: boolean) => {
    const { level, at } = withGroups(
      [
        { id: 1346, x: 0, y: 300, props: { 51: "2", 71: "3", 68: "90", 10: "0" } },
        { id: 1903, x: 600, y: 600 },
        { id: 1, x: 600, y: 500 },
        { id: 8, x: 600, y: 700 },
      ],
      { 1: 2, 2: 3, 3: 2 },
      makeHeader({ allowStaticRotate: staticRotate }),
    );
    const sim = simOn(level) as SimImpl;
    stepN(sim, NO_INPUT, 3);
    const o = sim.objs;
    const i = at(1);
    const j = at(3);
    const m = new Float64Array(9);
    const linear = (k: number) => {
      sim.triggers.objectTransform(k, m);
      return [m[0], m[1], m[2], m[3]].map((v) => Math.round(v) + 0);
    };
    return {
      platform: [o.cx[i], o.cy[i], o.x1[i] - o.x0[i], o.y1[i] - o.y0[i], o.rawRot[i]],
      spike: [o.cx[j], o.cy[j], o.rotDeg[j]],
      art: [linear(i), linear(j)],
    };
  };
  const quarter = [0, -1, 1, 0];
  assert.deepEqual(after(true), { platform: [700, 500, 14, 30, 90], spike: [800, 500, 90], art: [quarter, quarter] });
  assert.deepEqual(after(false), { platform: [700, 500, 30, 14, 0], spike: [800, 500, 90], art: [[1, 0, 0, 1], quarter] });
});

test("with kA42 a pad that reverses the player owes it twice the way to the pad's centre, paid 2% of a step at a time", () => {
  // The pad at x 600 turns the player round at x 573.248: 53.5033 to make up,
  // 0.025965 a step at 1x. [gdp PlayerObject::reversePlayer :148376-148389;
  //  update :161082-161085, :161101-161113]
  const run = (sync: boolean) => {
    const sim = simOn(emptyLevel([{ id: 35, x: 600, y: 32, props: { 117: "1" } }], makeHeader({ reverseSync: sync }))) as SimImpl;
    stepN(sim, NO_INPUT, 430);
    const p = sim.state as unknown as { reverseOffset: number; reverseSlice: number };
    const turned = [sim.state.x, sim.state.reversed, p.reverseOffset, p.reverseSlice];
    stepN(sim, NO_INPUT, 270);
    return { turned, x: sim.state.x, owed: p.reverseOffset, share: p.reverseSlice };
  };
  const off = run(false);
  const on = run(true);
  assert.deepEqual(off.turned, [573.2483520507812, true, 0, 0]);
  assert.deepEqual(on.turned, [573.2483520507812, true, 53.5032958984375, 0], "the first share is set aside by the next update");
  assert.deepEqual([on.owed, on.share], [46.49274394659675, 0.025965007229037183]);
  assert.equal(on.x - off.x, 6.987457275390625, "the shares paid so far, bar the one still to come");
});

test("with kA42 the gap is to where the pad is now, after a group has moved it", () => {
  // A pad moved from x 600 to 630 by a Move trigger turns the player where
  // one placed at 630 does, and charges the same offset. [gdp
  //  PlayerObject::reversePlayer :148376-148389, the object's getRealPosition
  //  through vtable +672]
  const turn = (moved: boolean) => {
    const { level } = withGroups(
      [
        { id: 901, x: 0, y: 300, props: { 51: "4", 28: "30", 10: "0" } },
        { id: 35, x: moved ? 600 : 630, y: 32, props: { 117: "1" } },
      ],
      moved ? { 1: 4 } : {},
      makeHeader({ reverseSync: true }),
    );
    const sim = simOn(level);
    for (let t = 0; t < 600 && !sim.state.reversed; t++) sim.step(NO_INPUT);
    return [sim.state.x, (sim.state as unknown as { reverseOffset: number }).reverseOffset];
  };
  const placed = turn(false);
  assert.ok(placed[1] > 50, `a real offset, got ${placed[1]}`);
  assert.deepEqual(turn(true), placed);
});

test("a reverse-sync offset rides in snapshots, the state hash and a checkpoint", () => {
  // The checkpoint keeps the offset as a float and drops the share set aside.
  // [gdp PlayerObject::saveToCheckpoint :161564-161565, loadFromCheckpoint
  //  :161648; resetObject :153587]
  const make = (sync: boolean) => simOn(emptyLevel([{ id: 35, x: 600, y: 32, props: { 117: "1" } }], makeHeader({ reverseSync: sync })));
  const on = make(true);
  const off = make(false);
  stepN(on, NO_INPUT, 430);
  stepN(off, NO_INPUT, 430);
  assert.equal(on.state.x, off.state.x, "level so far");
  assert.notEqual(on.stateHash(), off.stateHash(), "but one owes the other");
  stepN(on, NO_INPUT, 20);
  const snap = on.snapshot();
  const owed = (snap.opaque as { p1: { reverseOffset: number } }).p1.reverseOffset;
  assert.notEqual(owed, 0, "the snapshot owes something");
  stepN(on, NO_INPUT, 100);
  const x = on.state.x;
  on.restore(snap);
  stepN(on, NO_INPUT, 100);
  assert.equal(on.state.x, x, "a rewind replays the same payments");
  on.respawnFrom(snap);
  const p = on.state as unknown as { reverseOffset: number; reverseSlice: number };
  assert.deepEqual([p.reverseOffset, p.reverseSlice], [Math.fround(owed), 0]);
});

test("with kA44 the percentage is the steps run out of the level's length in steps", () => {
  // Player 1's x does not come into it. [gdp PlayLayer::getCurrentPercent
  //  :91461-91487; processCommands :464115; loadLevelSettings :430566-430567]
  const timed = simOn(emptyLevel([], makeHeader({ lengthSteps: 480 })));
  const plain = simOn(emptyLevel([]));
  stepN(timed, NO_INPUT, 120);
  stepN(plain, NO_INPUT, 120);
  assert.equal(timed.progress(), 0.25);
  assert.notEqual(plain.progress(), 0.25);
  assert.equal(timed.state.x, plain.state.x, "the run itself is the same");
  const snap = timed.snapshot();
  stepN(timed, NO_INPUT, 120);
  assert.equal(timed.progress(), 0.5);
  timed.restore(snap);
  assert.equal(timed.progress(), 0.25, "a checkpoint keeps the count");
});

test("kA45 turns boost slide off for both players, and the Options trigger's key 593 sets it", () => {
  // +2072 = !kA45 at the start; key 593 of 1 sets it and any other non-zero
  // value clears it. [gdp loadLevelSettings :430564-430565; resetPlayer
  //  :425077-425078; processOptionsTrigger :429856-429861]
  const at = (header: ReturnType<typeof makeHeader>, placed: Placed[] = []) => {
    const sim = simOn(emptyLevel(placed, header)) as SimImpl;
    stepN(sim, NO_INPUT, 2);
    return sim.boostSlide;
  };
  assert.equal(at(makeHeader()), true, "on without kA45");
  assert.equal(at(makeHeader({ decreaseBoostSlide: true })), false, "off with it");
  assert.equal(at(makeHeader({ decreaseBoostSlide: true }), [{ id: 2899, x: 0, y: 300, props: { 593: "1" } }]), true, "key 593 = 1");
  assert.equal(at(makeHeader(), [{ id: 2899, x: 0, y: 300, props: { 593: "-1" } }]), false, "key 593 = -1");
  const off = simOn(emptyLevel([], makeHeader({ decreaseBoostSlide: true })));
  const on = simOn(emptyLevel([]));
  assert.notEqual(off.stateHash(), on.stateHash(), "in the state hash");
});

test("without kA33 a negative scale turns a block's rect inside out, and only a player spanning it lands", () => {
  // getObjectRect takes the scale's sign unless the object's +729 (kA33) is
  // set: a width of -15 puts the rect's min 7.5 right of the centre and its
  // max 7.5 left, and CCRect's test then only meets a rect covering both.
  // With kA33 the block is an ordinary 15-wide one. [GameObject::getObjectRect
  //  :170826-170830; resetLevelVariables :462944 → applyLevelSettings
  //  :430513-430516]
  const landedAt = (fix: boolean, x: number) => {
    const level = emptyLevel([{ id: 1, x: 300, y: 195, scaleX: -0.5 }], makeHeader({ platformer: true, fixNegativeScale: fix }));
    const sim = simOn(level, { x, y: 240 });
    stepN(sim, NO_INPUT, 200);
    return sim.state.y;
  };
  assert.equal(landedAt(true, 310), 225, "kA33: an ordinary block, 10 off its centre");
  assert.equal(landedAt(false, 310), 45, "without it the player does not span it and falls through");
  assert.equal(landedAt(false, 300), 225, "one that spans it lands");
});
