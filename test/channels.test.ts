// Gameplay channels: pass-by triggers queue per channel (key 170) and only
// the active one fires; a Rotate Gameplay with key 171 makes key 173 the
// active channel, reversed when it sends the player left or down; each
// channel is sorted along its own way; and in a platformer the queue runs on
// the music clock, not the player.
// [gdp GJBaseGameLayer::checkSpawnObjects :454433-454549,
//  rotateGameplay :442819-442838, canTouchObject :421284-421300,
//  LevelTools::sortChannelOrderObjects :122777-122920]

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { buildTriggerIndex, gameplayDirection } from "../src/triggers/spec";
import { NO_INPUT } from "../src/physics/types";
import { LEVELS_DIR, loadObjectTable, loadOfficialLevel, makeSim } from "./helpers";
import { buildLevel, emptyLevel, makeHeader, simOn, stepN, type Placed } from "./levelKit";

const LEVELS = existsSync(`${LEVELS_DIR}/22.txt`) ? false : "needs the real install";

/** A Pickup that adds one to `item`: something to see a trigger fire by. */
function pickup(x: number, y: number, item: number, props: Record<number, string> = {}): Placed {
  return { id: 1817, x, y, props: { 80: String(item), 77: "1", ...props } };
}

test("only the active channel fires, and a turn that switches channel sets its way and its order", () => {
  // A turn at x 100 (a quarter turn clockwise: orientation 3, down) switches
  // to channel 1, which is sorted top down and pops against its way: a
  // trigger fires once player 1 is at or below it. Channel 0's Pickup at
  // x 150 never fires while channel 1 is active.
  const level = emptyLevel([
    { id: 2900, x: 100, y: 200, rotation: 90, props: { 166: "3", 167: "2", 171: "1", 173: "1" } },
    pickup(500, 50, 2, { 170: "1" }),
    pickup(500, 150, 1, { 170: "1" }),
    pickup(150, 0, 3),
  ]);
  const index = buildTriggerIndex(level, (id) => id === 2900 || id === 1817);
  const slot = index.channelSlot.get(1)!;
  assert.equal(index.channels[slot].direction, 2, "down: the turn's own way");
  assert.deepEqual(
    index.channels[slot].specs.map((s) => s.y),
    [150, 50],
    "top down",
  );
  const sim = simOn(level);
  const t = sim.triggers;
  const items = (): number[] => [t.itemCount(1), t.itemCount(2), t.itemCount(3)];
  t.checkPassed(90, 400, false);
  assert.deepEqual(items(), [0, 0, 0], "the turn is not reached");
  // The turn fires, and the same check goes on in channel 1 with the turn in
  // force: the Pickups there are at world y 240 and 140, player 1 at 490.
  t.checkPassed(100, 400, false);
  assert.deepEqual(items(), [0, 0, 0]);
  t.checkPassed(1000, 150, true);
  assert.deepEqual(items(), [1, 0, 0], "y 150 reached, x 1000 does not matter, channel 0 is not active");
  t.checkPassed(0, -40, true);
  assert.deepEqual(items(), [1, 1, 0]);
});

test("a turn's key 172 switches the channel without turning, and pops the new channel on at once", () => {
  // Key 171 with no key 173 goes back to channel 0; key 172 leaves the
  // players alone, so the next trigger is read along x again.
  const level = emptyLevel([
    { id: 2900, x: 100, y: 0, props: { 166: "2", 167: "4", 171: "1", 173: "1" } },
    { id: 2900, x: 50, y: 0, props: { 166: "2", 167: "4", 170: "1", 171: "1", 172: "1" } },
    pickup(120, 0, 1),
  ]);
  const sim = simOn(level);
  sim.triggers.checkPassed(130, 0, false);
  assert.equal(sim.triggers.itemCount(1), 1, "channel 1's switch fired at x 50 and channel 0 went on to x 120");
  assert.deepEqual(sim.triggers.pendingRotations.map((r) => r.channelOnly), [false, true]);
});

test("each channel sorts by its key 115, then its coordinate cut to an integer, then file order", () => {
  // 100.7 and 100.2 both cut to 100, so file order decides: the first in the
  // file is popped first and holds up the other until it is passed itself.
  // Key 115 = 1 puts the Pickup at x 50 behind both of them.
  const level = emptyLevel([pickup(100.7, 0, 1), pickup(100.2, 0, 2), pickup(50, 0, 3, { 115: "1" })]);
  const sim = simOn(level);
  const t = sim.triggers;
  const items = (): number[] => [t.itemCount(1), t.itemCount(2), t.itemCount(3)];
  t.checkPassed(60, 0, false);
  assert.deepEqual(items(), [0, 0, 0], "x 50 is passed, but it waits behind key 115 = 0");
  t.checkPassed(100.5, 0, false);
  assert.deepEqual(items(), [0, 0, 0], "100.7 blocks 100.2");
  t.checkPassed(100.7, 0, false);
  assert.deepEqual(items(), [1, 1, 1]);
});

test("while another channel is active, a touch trigger on a third one cannot be touched", () => {
  const level = emptyLevel([
    { id: 2900, x: 30, y: 0, props: { 166: "2", 167: "4", 171: "1", 172: "1", 173: "1" } },
    pickup(300, 45, 1, { 11: "1", 170: "2" }),
    pickup(300, 45, 2, { 11: "1", 170: "1" }),
    pickup(300, 45, 3, { 11: "1" }),
  ]);
  const sim = simOn(level);
  const t = sim.triggers;
  t.checkPassed(40, 45, false);
  t.checkTouch(300, 45, 15, 1);
  assert.deepEqual([t.itemCount(1), t.itemCount(2), t.itemCount(3)], [0, 1, 1]);
});

test("a pad on a channel other than the active one is not there", () => {
  // A channel-only turn at x 30 makes channel 1 active. A yellow pad on
  // channel 2 does not launch the cube; one on channel 1 or 0 does. Pads are
  // effect objects like orbs and portals. [canTouchObject :421284-421300;
  //  GameObject::createWithKey :183021-183022, 35 → EffectGameObject::create
  //  :183018]
  for (const [channel, launched] of [
    ["2", false],
    ["1", true],
    ["0", true],
  ] as const) {
    const level = emptyLevel([
      { id: 2900, x: 30, y: 0, props: { 166: "2", 167: "4", 171: "1", 172: "1", 173: "1" } },
      { id: 35, x: 150, y: 32, props: { 170: channel } },
    ]);
    const sim = simOn(level);
    let top = 0;
    for (let i = 0; i < 90; i++) {
      sim.step(NO_INPUT);
      top = Math.max(top, sim.state.y);
    }
    assert.equal(top > 60, launched, `channel ${channel}: highest y ${top}`);
  }
});

test("a force block or a letter block on a channel other than the active one is not there", () => {
  // As the pad above: a channel-only turn at x 30 makes channel 1 active. A
  // force block pushing up hard, or a J block (no jump buffer), on channel 2
  // does nothing; on channel 1 or 0 it acts. Both are effect objects, touched
  // in the same gated switch as the pads. [canTouchObject :421284-421300, the
  // gate :463487, type 40 → touchedObject :463812-463813;
  // ForceBlockGameObject::init :312930-312933; 1813 → EffectGameObject::create
  // :183314-183315]
  const state = (s: ReturnType<typeof simOn>) => (s as unknown as { p1: { stateNoAutoJump: number } }).p1;
  for (const [channel, acts] of [
    ["2", false],
    ["1", true],
    ["0", true],
  ] as const) {
    const turn: Placed = { id: 2900, x: 30, y: 0, props: { 166: "2", 167: "4", 171: "1", 172: "1", 173: "1" } };
    const pushed = simOn(emptyLevel([turn, { id: 2069, x: 150, y: 45, scaleX: 2, props: { 149: "20", 170: channel } }]));
    const letter = simOn(emptyLevel([turn, { id: 1813, x: 150, y: 45, props: { 170: channel } }]));
    let top = 0;
    let buffered = 0;
    for (let i = 0; i < 90; i++) {
      pushed.step(NO_INPUT);
      letter.step(NO_INPUT);
      top = Math.max(top, pushed.state.y);
      buffered = Math.max(buffered, state(letter).stateNoAutoJump);
    }
    assert.equal(top > 60, acts, `force block, channel ${channel}: highest y ${top}`);
    assert.equal(buffered > 0, acts, `J block, channel ${channel}`);
  }
});

test("in a platformer the pass-by queue runs on the music clock at 1x speed, whatever the player does", () => {
  // x 150 is 150 / 311.580109 = 0.4814 s in: tick 116 at 240 a second. The
  // player stands still at x 15 all the while.
  const level = buildLevel([{ id: 1, x: 15, y: 15 }, pickup(150, 600, 1)], makeHeader({ platformer: true }));
  const sim = makeSim(level, undefined, { start: { x: 15, y: 45 } });
  let at = -1;
  for (let i = 0; i < 200 && at < 0; i++) {
    sim.step(NO_INPUT);
    if (sim.triggers.itemCount(1) === 1) at = sim.tick;
  }
  assert.equal(at, 116);
  assert.ok(Math.abs(sim.state.x - 15) < 1, "the player did not move");
});

test("a channel's snapshot comes back: switch, reversal and how far each queue got", () => {
  const level = emptyLevel([
    { id: 2900, x: 100, y: 200, rotation: 90, props: { 166: "3", 167: "2", 171: "1", 173: "1" } },
    pickup(500, 150, 1, { 170: "1" }),
  ]);
  const sim = simOn(level);
  const before = sim.snapshot();
  const h0 = sim.stateHash();
  sim.triggers.checkPassed(100, 400, false);
  assert.notEqual(sim.stateHash(), h0, "the active channel is in the hash");
  const switched = sim.snapshot();
  sim.triggers.checkPassed(0, 100, true);
  assert.equal(sim.triggers.itemCount(1), 1);
  sim.restore(switched);
  assert.equal(sim.triggers.itemCount(1), 0);
  sim.triggers.checkPassed(0, 100, true);
  assert.equal(sim.triggers.itemCount(1), 1, "still on channel 1, still reversed");
  sim.restore(before);
  sim.triggers.checkPassed(0, 100, true);
  assert.equal(sim.triggers.itemCount(1), 0, "back on channel 0");
  assert.equal(sim.stateHash(), h0);
});

test("a Rotate Gameplay's way is its turn and flips, the same as the key 167 the editor stores", { skip: LEVELS }, async () => {
  // [gdp GameObject::getObjectDirection :168867-168889,
  //  RotateGameplayGameObject::updateGameplayRotation :313495-313546]
  const level = await loadOfficialLevel(22);
  const turns = level.objects.filter((o) => o.id === 2900);
  assert.equal(turns.length, 20);
  for (const o of turns) assert.equal(gameplayDirection(o.rotation, o.flipX, o.flipY), Number(o.props[167]), `#${o.index}`);
  assert.equal(gameplayDirection(45, false, false), 4, "no quarter turn: right");
});

test("Dash: the turn at x 2265 is undone at y 135 on its way down, not before it at x 2143.5", { skip: LEVELS }, async () => {
  // #1327 (channel 0) turns the player down and switches to channel 1;
  // #1199 on channel 1 turns it back when it has come down to y 135.
  const level = await loadOfficialLevel(22);
  const table = loadObjectTable();
  const index = buildTriggerIndex(level, (id) => table.get(id).kind === "trigger");
  assert.deepEqual(
    index.channels.map((c) => c.channel),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  );
  assert.deepEqual(index.channels.map((c) => c.direction), [4, 2, 1, 2, 1, 3, 2, 4, 1, 3, 4, 1, 3, 4, 3, 4]);
  const sim = makeSim(level, undefined, { noclip: true, start: { x: 2255, y: 226, mode: "ship", speed: 1 } });
  const turns: string[] = [];
  let rotated = false;
  for (let i = 0; i < 120; i++) {
    sim.step(NO_INPUT);
    const now = (sim as unknown as { p1: { rotated: boolean } }).p1.rotated;
    if (now !== rotated) turns.push(`${sim.tick}:${now}@${sim.state.x.toFixed(1)},${sim.state.y.toFixed(1)}`);
    rotated = now;
  }
  assert.deepEqual(turns, ["8:true@2265.4,225.4", "78:false@2265.0,134.6"]);
});

test("Dash's End trigger waits on channel 15", { skip: LEVELS }, async () => {
  const level = await loadOfficialLevel(22);
  const table = loadObjectTable();
  const index = buildTriggerIndex(level, (id) => table.get(id).kind === "trigger");
  const fifteen = index.channels[index.channelSlot.get(15)!];
  assert.ok(fifteen.specs.some((s) => s.id === 3600 && s.index === 16973));
  // On channel 0, nothing at x 21853 ends the level.
  const sim = simOn(level, { x: 21800, y: 2707, mode: "ship" });
  stepN(sim, NO_INPUT, 0);
  sim.triggers.checkPassed(21900, 2707, false);
  assert.equal(sim.triggers.pendingEnd, null);
});
