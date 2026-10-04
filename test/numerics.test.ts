// The numbers the game keeps: the y velocity to three decimals on every
// setYVelocity, and the player's position as a float in the game's own space,
// where y is this port's + 90 — pinned to the 2.206 decompile. The derivation
// is in data/ref/gd-discrepancies.md §5 and §17.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_DT, JUMP_DT, xSpeedFor } from "../src/physics/constants";
import { Player, quantizeYVelocity, type PlayerWorld } from "../src/physics/player";
import { NO_INPUT, type Sim } from "../src/physics/types";
import type { GameplayRotation } from "../src/triggers/runtime";
import { buildLevel, emptyLevel, floor, HOLD, makeHeader, settle, simOn, type Placed } from "./levelKit";

const EPS = 1e-9;
const LINKED_TELEPORT = 747;
const F_BLOCK = 2866;
/** A 2:1 slope, 60 wide and 30 high. */
const SLOPE_2_1 = 291;
/** A 45° slope, one block. */
const SLOPE_45 = 289;

function near(actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

function world(over: Partial<PlayerWorld> = {}): PlayerWorld {
  return { emit: () => {}, spiderJump: () => {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true, ...over };
}

function p1(sim: Sim): Player {
  return sim.state as Player;
}

// --- §17: setYVelocity ------------------------------------------------------------

test("setYVelocity keeps three decimals, rounding a half away from zero", () => {
  // v = (int)v + round((v − (int)v) × 1000) / 1000 unless v is whole. [141992-142007]
  const cases: Array<[number, number]> = [
    [11.180031776428223, 11.18],
    [10.96440523147583, 10.964],
    [-0.2155947685241699, -0.216],
    [0.0625, 0.063],
    // Math.round would give −0.062.
    [-0.0625, -0.063],
    [-1.0625, -1.063],
    [7.9996, 8],
    [-0.9996, -1],
    [15, 15],
    [-15, -15],
  ];
  for (const [v, want] of cases) near(quantizeYVelocity(v), want, `${v}`);
  assert.ok(Object.is(quantizeYVelocity(-0), -0), "a whole −0 is kept as it is");
  assert.ok(Object.is(quantizeYVelocity(-0.0004), 0), "(int)−0.0004 is 0, and so is the result");
  for (let k = -3000; k <= 3000; k += 7) {
    const v = k / 997;
    assert.equal(quantizeYVelocity(quantizeYVelocity(v)), quantizeYVelocity(v), `idempotent at ${v}`);
  }
});

test("a cube jump at 1x is 11.18, then 0.216 a tick through setYVelocity, and peaks 63.85 up", () => {
  // The jump's float through setYVelocity [155785-155814], then gravity
  // through addToYVelocity every tick [155990], so 0.2155948 comes out as
  // 0.216 from a velocity on thousandths.
  const sim = simOn(emptyLevel());
  const y0 = settle(sim);
  sim.step(HOLD);
  near(sim.state.yVel, 10.964, "the press step");
  const seq: number[] = [];
  let apex = y0;
  for (let i = 0; i < 60; i++) {
    sim.step(HOLD);
    seq.push(sim.state.yVel);
    if (sim.state.y > apex) apex = sim.state.y;
  }
  near(seq[0], 10.748, "the next");
  near(seq[48], 0.38, "49 ticks on");
  near(seq[50], -0.052, "past the top");
  near(seq[51], -0.268, "and down at 0.216 a tick");
  near(apex - y0, 63.846893310546875, "the apex, 2.128 blocks");
});

test("update holds the y velocity to ±1000 on the double before anything reads it", () => {
  // A raw write, then updateJump's gravity through addToYVelocity. [160995-161003]
  const up = new Player(world(), 1);
  up.yVel = 2000.0005;
  up.update(FRAME_DT);
  near(up.yVel, 999.784, "1000, then a rounded tick of gravity");
  // Boosted, so no ±15 clamp follows the gravity. [155914-155936]
  const down = new Player(world(), 1);
  down.maybeIsBoosted = true;
  down.yVel = -2000;
  down.update(FRAME_DT);
  near(down.yVel, -1000.216, "−1000, then a rounded tick of gravity");
});

test("the halvings and the slow modes' share write the double directly", () => {
  // flipGravity [151156-151158] and the ball's × 0.6 [155859] are raw; the
  // next addToYVelocity rounds. [142043-142047]
  const flip = new Player(world(), 1);
  flip.yVel = 11.181;
  flip.flipGravity(true);
  assert.equal(flip.yVel, 5.5905, "halved, not rounded");
  flip.updateJump(JUMP_DT);
  near(flip.yVel, 5.806, "then a rounded tick of gravity the new way");

  const ball = new Player(world(), 1);
  ball.setMode("ball");
  ball.onGround = true;
  ball.holding = true;
  ball.stateRingJump = true;
  ball.updateJump(0);
  assert.equal(ball.yVel, 11.18 * 0.5 * Math.fround(0.6), "11.18, halved by the flip, × the float 0.6");
  ball.updateJump(JUMP_DT);
  near(ball.yVel, 3.483, "then rounded");
});

test("the flying caps are floats over the size factor, written every tick", () => {
  // (float)(8.0 / v20) and (float)((float)(v91 × −8.0) / v20), through
  // setYVelocity. [155560-155593]
  for (const [mini, flipped, up, down] of [
    [false, false, 8, -6.4],
    [true, false, 9.412, -7.529],
    [false, true, -8, 6.4],
    [true, true, -9.412, 7.529],
  ] as const) {
    const tag = `${mini ? "mini " : ""}${flipped ? "flipped " : ""}ship`;
    const a = new Player(world(), 1);
    a.setMode("ship");
    a.mini = mini;
    a.flipped = flipped;
    a.yVel = flipped ? -20 : 20;
    a.updateJump(JUMP_DT);
    near(a.yVel, up, `${tag}: against gravity`);
    const b = new Player(world(), 1);
    b.setMode("ship");
    b.mini = mini;
    b.flipped = flipped;
    b.yVel = flipped ? 20 : -20;
    b.updateJump(JUMP_DT);
    near(b.yVel, down, `${tag}: with gravity`);
  }
});

test("the accelerating flag's band ends at the float −6.4000001, so −6.4 is inside it", () => {
  // (float)(−6.4 / v20) compared with the double velocity. [155485-155554]
  const p = new Player(world(), 1);
  p.setMode("ship");
  p.isAccelerating = true;
  p.yVel = -6.4;
  p.updateJump(JUMP_DT);
  assert.equal(p.isAccelerating, false);
});

test("a mini UFO's hop is the float 6.8000002, which beats a velocity of 6.8", () => {
  // (float)((float)(8 × flipMod) × 0.85) against the double. [155692-155706]
  let hops = 0;
  const p = new Player(world({ emit: (type) => void (type === "jump" && hops++) }), 1);
  p.setMode("ufo");
  p.mini = true;
  p.yVel = 6.8;
  p.holding = true;
  p.stateRingJump = true;
  p.updateJump(JUMP_DT);
  assert.equal(hops, 1, "it hops");
  near(p.yVel, 6.648, "6.8, then a tick of mini UFO gravity");
});

test("copyAttributes rounds the velocity it copies; a checkpoint hands it back as a float", () => {
  // copyAttributes → setYVelocity [153327-153328]; saveToCheckpoint keeps a
  // float [161545-161551], loadFromCheckpoint → setYVelocity [161732].
  const a = new Player(world(), 1);
  a.yVel = 1.0005000001;
  const b = new Player(world(), 2);
  b.copyAttributes(a);
  near(b.yVel, 1.001, "copied");

  const sim = simOn(emptyLevel(), { y: 150 });
  sim.step(NO_INPUT);
  p1(sim).yVel = 1.0005000001;
  const snap = sim.snapshot();
  sim.restore(snap);
  assert.equal(p1(sim).yVel, 1.0005000001, "a restore is exact");
  sim.respawnFrom(snap);
  near(p1(sim).yVel, 1, "a respawn: (float)1.0005000001 is 1.00049996");
});

test("an F block met head first turns the cube over toward the block, which it then stands on", () => {
  // hardFlipGravity: flipGravity, then setYVelocity(−2 × the new flipMod).
  // [151223-151232, didHitHead :151248-151265]
  const level = emptyLevel([...floor(0, 3000, 105), { id: F_BLOCK, x: 45, y: 75 }, { id: F_BLOCK, x: 75, y: 75 }]);
  const sim = simOn(level);
  settle(sim);
  sim.step(HOLD);
  while (!sim.state.flipped && sim.tick < 60) sim.step(NO_INPUT);
  assert.equal(sim.tick, 26);
  assert.deepEqual(
    [sim.state.y, sim.state.yVel, sim.state.onGround],
    [75, 0, true],
    "pushed up into the ceiling, it lands on it in the same pass",
  );
});

test("a slope's y speed is the game's float quotients, width over x speed first", () => {
  // v21 = (float)(width / x speed), v22 = (float)(height / v21), kept in
  // +1832; at 2x that is a float above the one-step quotient, and leaving the
  // slope rounds it through setYVelocity. [157308-157309, 157905; 158501]
  const placed: Placed[] = [...floor(0, 3000)];
  const slopes: number[] = [];
  for (let k = 0; k < 4; k++) {
    slopes.push(placed.length);
    placed.push({ id: SLOPE_2_1, x: 330 + 60 * k, y: 195 - 30 * k });
  }
  const level = buildLevel(placed);
  for (const i of slopes) level.objects[i].flipX = true;
  const sim = simOn(level, { x: 305, y: 240, speed: 2 });
  const p = p1(sim);
  while (!p.onSlope && sim.tick < 200) sim.step(NO_INPUT);
  assert.equal(p.onSlope, true, "on the slope");
  const game = Math.fround(30 / Math.fround(60 / xSpeedFor(2)));
  assert.equal(p.currentSlopeYVel, game);
  assert.notEqual(game, Math.fround((30 * xSpeedFor(2)) / 60), "not the one-step quotient");
  // +1956: f(f(v22 × 1.4) × v100), v100 = f(0.8 / angle) capped at 1.1,
  // which a 2:1 slope's 1.7254 is. [157905-157913]
  assert.equal(Math.abs(p.slopeVelocity), Math.fround(Math.fround(game * 1.4) * Math.fround(1.1)), "+1956, capped");
  while (p.onSlope && sim.tick < 400) sim.step(NO_INPUT);
  near(p.yVel, -3.229, "left at the slope's y speed, to thousandths");
});

test("a slope's snap is float sums a step at a time, so on a 45° slope it rounds a tie down", () => {
  // v44 = f(f(30 / cosf(angle)) × 0.5) is half a step of the position's grid
  // from game y 128 to 256, and v50 = f(f(slopeYPos) + v44) − v46 ties there;
  // rounding once from the double radius went a step up. +1956 is
  // f(f(v22 × 1.4) × f(0.8 / angle)), the product rounded where the game
  // rounds it. [157398-157458, 157905-157913]
  const f = Math.fround;
  const placed: Placed[] = [...floor(0, 3000)];
  for (let k = 0; k < 4; k++) placed.push({ id: SLOPE_45, x: 105 + 30 * k, y: 45 + 30 * k });
  const sim = simOn(buildLevel(placed));
  const p = p1(sim);
  const angle = f(Math.PI / 4);
  const v44 = f(f(30 / f(Math.cos(angle))) * 0.5);
  assert.equal(v44 * 2 ** 16, 1390228.5, "a half step of the grid from 128 to 256");
  let ridden = 0;
  let ties = 0;
  let sv = 0;
  while (sim.tick < 200) {
    sim.step(NO_INPUT);
    if (!p.onSlope || p.slopeAtLow || p.slopeAtHigh) continue;
    ridden++;
    // Under these slopes the surface is at port y x − 60, game y x + 30.
    const game = f(f(p.x + 30) + v44) - 90;
    assert.equal(p.y, game, `tick ${sim.tick}, x ${p.x}`);
    if (game !== f(p.x + 30 + 15 / Math.cos(Math.PI / 4)) - 90) ties++;
    assert.equal(p.slopeVelocity, f(f(p.currentSlopeYVel * 1.4) * f(0.8 / angle)));
    sv = p.slopeVelocity;
  }
  assert.ok(ridden > 80, `rode ${ridden} ticks`);
  assert.ok(ties > 50, `${ties} ticks would round the other way at once`);
  assert.equal(sv, 7.405367851257324, "not the merged 1.12 / angle's 7.405367374420166");
});

test("a cube in a ceiling slope is put back and sent off at 2 only just after a flip or a mode change", () => {
  // isSafeMode(0.1) || isSafeFlip(0.1): setPosition(x, v50) and
  // setYVelocity(flipped ? max(yVel, 2) : min(yVel, −2), 18). Otherwise more
  // than 2 in is death, and nearer than that nothing is written but the
  // ground flags. [157646-157697, 157990-157992]
  function hit(o: { y: number; yVel: number; flipped?: boolean; safe?: "mode" | "flip" }): Player {
    const flipped = o.flipped ?? false;
    // Upside down, a floor slope met from above is the ceiling.
    const sim = simOn(buildLevel([{ id: SLOPE_45, x: 300, y: 200, flipY: !flipped }]), { x: 296, y: o.y, flipped });
    const p = p1(sim);
    p.onGround = true;
    p.onGround2 = true;
    p.yVel = o.yVel;
    if (o.safe === "mode") p.lastModeChangeTick = sim.tick + 1;
    if (o.safe === "flip") p.lastFlipTick = sim.tick + 1;
    sim.step(NO_INPUT);
    return p;
  }
  // v50 at x 296, below the slope and, upside down, its mirror above.
  const V50 = 181.48855590820312;
  const V50_FLIPPED = 218.51144409179688;

  for (const safe of ["mode", "flip"] as const) {
    const p = hit({ y: 185, yVel: 3, safe });
    assert.deepEqual([p.dead, p.y, p.yVel], [false, V50, -2], `${safe}: back on the surface, sent down at 2`);
    assert.deepEqual([p.onGround, p.onGround2], [false, false], `${safe}: off the ground`);
  }
  const up = hit({ y: 215, yVel: -3, flipped: true, safe: "mode" });
  assert.deepEqual([up.dead, up.y, up.yVel], [false, V50_FLIPPED, 2], "upside down: sent up at 2");
  near(hit({ y: 215, yVel: 3, flipped: true, safe: "mode" }).yVel, 3.216, "already leaving faster than 2: kept");
  near(hit({ y: 187, yVel: -5, safe: "mode" }).yVel, -5.216, "the same the right way up");

  // Not safe: 1.94 in, it is left where gravity put it, still rising.
  const near1 = hit({ y: 182.8, yVel: 3 });
  assert.deepEqual([near1.dead, near1.y, near1.yVel], [false, 183.4263916015625, 2.784], "left alone");
  assert.equal(near1.y - V50, 1.937835693359375);
  assert.deepEqual([near1.onGround, near1.onGround2], [false, false], "only off the ground");
  const near2 = hit({ y: 217.2, yVel: -3, flipped: true });
  assert.deepEqual([near2.dead, near2.y, near2.yVel], [false, 216.5736083984375, -2.784], "upside down, left alone");
  assert.equal(V50_FLIPPED - near2.y, 1.937835693359375);
  // 2.04 in dies, either way up.
  assert.equal(hit({ y: 182.9, yVel: 3 }).dead, true, "more than 2 in");
  assert.equal(hit({ y: 217.1, yVel: -3, flipped: true }).dead, true, "upside down, more than 2 in");
});

// --- §5: the float position ------------------------------------------------------

test("the start is a float in the game's space", () => {
  // setPosition takes a float point, and the game's y is ours + 90. [143981, 164602-164615]
  const sim = simOn(emptyLevel(), { x: 0.1, y: 20.1 });
  assert.equal(sim.state.x, Math.fround(0.1));
  assert.equal(sim.state.y, Math.fround(110.1) - 90, "20.099998, not the float 20.100000");
  assert.notEqual(sim.state.y, Math.fround(20.1));
});

test("each step is a float added to the float position, so far out it moves in 1/512ths", () => {
  // CCPoint(float dx, float dy) + getPosition(). [161084-161100]
  const sim = simOn(buildLevel(floor(29850, 30300)), { x: 30000 });
  settle(sim);
  const x0 = sim.state.x;
  sim.step(NO_INPUT);
  const step = Math.fround(xSpeedFor(1) * FRAME_DT);
  assert.equal(step, 1.298250436782837);
  assert.equal(sim.state.x, Math.fround(x0 + step));
  assert.equal(sim.state.x - x0, 1.298828125);
});

test("rotated gameplay: the gravity step lands on x and the forward step on y, each a float on its own axis", () => {
  // The swap comes before the float point is built. [161086-161098]
  const sim = simOn(buildLevel([]), { x: 300, y: 100 });
  p1(sim).rotated = true;
  const { x, y } = sim.state;
  sim.step(NO_INPUT);
  const p = p1(sim);
  assert.equal(p.stepY, Math.fround(-0.216 * JUMP_DT));
  assert.equal(p.x, Math.fround(x + p.stepY));
  assert.equal(p.y, Math.fround(y + 90 + Math.fround(xSpeedFor(1) * FRAME_DT)) - 90);
});

test("a gameplay turn swaps the velocity point: a platformer's own x velocity goes to y, its y velocity to x", () => {
  // getCurrentXVelocity is the signed +2216 in a platformer [142060-142072].
  // Both halves are read before the flip halves y, swapped, edited by keys
  // 582 (x) and 583 (y), and written raw by updatePlayerForce, the x half
  // only in a platformer. [152474-152531, 147375-147395]
  const f = Math.fround;
  const turn = (platformer: boolean, edit: Partial<GameplayRotation> = {}): Player => {
    const sim = simOn(buildLevel([], makeHeader({ platformer })), { x: 300, y: 100 });
    const p = p1(sim);
    p.xVel = platformer ? -4.2 : 0;
    p.yVel = 3.3;
    const r: GameplayRotation = {
      orientation: 4,
      direction: 4,
      editVelocity: false,
      velocityX: 0,
      velocityY: 0,
      overrideVelocity: false,
      channelOnly: false,
      dontSlide: false,
      ...edit,
    };
    (sim as unknown as { rotatePlayer(p: Player, r: GameplayRotation): void }).rotatePlayer(p, r);
    assert.equal(p.rotated && p.flipped, true, "turned and flipped");
    return p;
  };
  const plat = turn(true);
  assert.deepEqual([plat.yVel, plat.xVel], [f(-4.2), f(3.3)], "the signed x velocity, and y before the flip halved it");
  const classic = turn(false);
  assert.deepEqual([classic.yVel, classic.xVel], [f(xSpeedFor(1)), 0], "the unsigned speed; no x velocity to write");
  const scaled = turn(true, { editVelocity: true, velocityX: 0.5, velocityY: 2 });
  assert.deepEqual([scaled.yVel, scaled.xVel], [f(f(-4.2) * 2), f(f(3.3) * 0.5)]);
  const set = turn(true, { editVelocity: true, overrideVelocity: true, velocityX: -3.3, velocityY: 7.1 });
  assert.deepEqual([set.yVel, set.xVel], [f(7.1), f(-3.3)]);
});

test("a teleport moves the player to its partner's y in the world, rotated or not", () => {
  // teleportPlayer sets a world position [462318-462336]: for the linked
  // portal, the player's x and the partner's y, which is key 54 above the
  // portal (getPortalTargetPos :419427-419431, the partner :89924-89934).
  // The rotated pass has the player in its own frame, with x and y swapped.
  // The portal's box is 25 wide with its centre 12 right of the portal's
  // (GameObject::customSetup :179044-179052), so a cube meets it at x 44.86,
  // tick 23; a centred box met it at 33.18 on tick 14.
  const flat = simOn(buildLevel([...floor(0, 600), { id: LINKED_TELEPORT, x: 60, y: 45, props: { 54: "60" } }]));
  while (!flat.events.some((e) => e.detail === "teleport") && flat.tick < 60) flat.step(NO_INPUT);
  assert.equal(flat.tick, 23);
  assert.deepEqual([flat.state.x, flat.state.y], [44.859771728515625, 105], "45 + 60, not the player's 44.95 + 60");

  const turned = simOn(buildLevel([{ id: LINKED_TELEPORT, x: 300, y: 130, props: { 54: "60" } }]), { x: 300, y: 100 });
  p1(turned).rotated = true;
  turned.step(NO_INPUT);
  assert.ok(turned.events.some((e) => e.detail === "teleport"), "the portal is met on the first step");
  assert.deepEqual([turned.state.x, turned.state.y], [299.9513854980469, 190], "130 + 60 along y, x keeps its gravity step");
  assert.equal(p1(turned).axesSwapped, false, "back in the world's frame");

  // Key 351 keeps the player's offset from the portal: the target less
  // (portal − player), and the target's x is the player's own. The portal is
  // its own position, 60, not its box's centre. [:462337-462344]
  const kept = simOn(buildLevel([...floor(0, 600), { id: LINKED_TELEPORT, x: 60, y: 45, props: { 54: "60", 351: "1" } }]));
  while (!kept.events.some((e) => e.detail === "teleport") && kept.tick < 60) kept.step(NO_INPUT);
  const x = 44.859771728515625;
  assert.deepEqual([kept.state.x, kept.state.y], [Math.fround(x - Math.fround(60 - x)), 104.95140075683594]);
});

test("setWorldPosition writes the world's point into whichever frame the player is in", () => {
  const p = new Player(world(), 1);
  p.setWorldPosition(100.1, 20.1);
  assert.deepEqual([p.x, p.y], [Math.fround(100.1), Math.fround(110.1) - 90]);
  p.axesSwapped = true;
  p.setWorldPosition(100.1, 20.1);
  assert.deepEqual([p.x, p.y], [Math.fround(110.1) - 90, Math.fround(100.1)]);
  assert.deepEqual([p.worldX, p.worldY], [Math.fround(100.1), Math.fround(110.1) - 90]);
  p.setY(7.3);
  assert.equal(p.y, Math.fround(7.3), "own y in the swapped frame is the world's x");
});
