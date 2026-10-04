// Squeeze death (kA31, and every platformer): a player that meets a floor and
// a ceiling in one collision pass closer than 0.7 of its height (0.8 in a
// platformer) is destroyed where the pass left it, and so is a platformer
// player pushed off walls on both sides closer than its width less 5 × its
// scale. Pinned to the 2.206 decompile: resetLevelVariables :462941-462955,
// preCollision :154030-154033, updateCollideTop/Bottom :142767-142849,
// updateCollideLeft/Right :142864-142926, postCollision :158529-158830,
// staticObjectsInRect :419454-419604. The put-back to where the update began
// that postCollision has before each death runs only in the editor (+1604 is
// set outside it: PlayerObject::init :162197, createPlayer :417895-417900).
// After each test, in every level, the collision log: one object met as both
// a floor and a ceiling, or in a platformer as walls on both sides, puts the
// player back and destroys it (:158682-158715, 158831-158845).
//
// Contacts are stored as the game stores them, in its space: port y + 90.

import { test } from "node:test";
import assert from "node:assert/strict";
import { collideSolid, ObjectSet, R_CEIL, R_LAND } from "../src/physics/collision";
import { Player, type PlayerWorld } from "../src/physics/player";
import { NO_INPUT, type Sim } from "../src/physics/types";
import type { GameMode } from "../src/level/types";
import { buildLevel, makeHeader, type Placed, simOn } from "./levelKit";

const BLOCK = 1;
const SLOPE = 289;
const BIG_PORTAL = 99;

function p1(sim: Sim): Player {
  return (sim as unknown as { p1: Player }).p1;
}

function squeeze(sim: Sim, p: Player): void {
  (sim as unknown as { squeeze(p: Player): void }).squeeze(p);
}

/** A ceiling of blocks with their bottoms at y 20 over the plain ground, and a big portal at x 90. */
function lowCeiling(): Placed[] {
  const placed: Placed[] = [];
  for (let x = 15; x < 400; x += 30) placed.push({ id: BLOCK, x, y: 35 });
  placed.push({ id: BIG_PORTAL, x: 90, y: 15 });
  return placed;
}

function grow(mode: GameMode, kA31: boolean): Sim {
  const sim = simOn(buildLevel(lowCeiling(), makeHeader({ playerSqueeze: kA31 })), { x: 15, y: 9, mode, mini: true });
  for (let t = 0; t < 80 && !sim.state.dead; t++) sim.step(NO_INPUT);
  return sim;
}

test("a mini ship under a 20-unit ceiling dies in the pass that grows it, with kA31", () => {
  // The band's floor at 0 and the blocks' undersides at 20: 20 < 0.7 × 30.
  const sim = grow("ship", true);
  assert.equal(sim.state.dead, true);
  assert.equal(sim.tick, 39);
  assert.equal(p1(sim).killedBy, null, "no object is to blame");
  assert.deepEqual([p1(sim).collideBottom, p1(sim).collideTop], [90, 110], "the floor and ceiling, in the game's space");
  // The blocks pushed the grown ship down to 20 − 15; it dies there, not
  // back where its update began.
  assert.equal(sim.state.y, 5);
  assert.ok(sim.state.x > p1(sim).lastX, "not put back");
  const die = sim.events.find((e) => e.type === "die");
  assert.ok(die && die.object === undefined);
});

test("without kA31 a classic level never squeezes", () => {
  const sim = grow("ship", false);
  assert.equal(sim.state.dead, false);
  assert.equal((sim as unknown as { squeezes: boolean }).squeezes, false);
});

test("a cube meets no ceiling, so it is not squeezed", () => {
  // Only a flying player, a ball, an H or F block or a platformer takes a
  // ceiling contact. [collidedWithObjectInternal :151633-151638, v176]
  assert.equal(grow("cube", true).state.dead, false);
});

/** A kA31 sim and its player 1, with the contacts written by hand. */
function staged(top: number, bottom: number, over: Partial<Player> = {}, platformer = false, placed: Placed[] = []): { sim: Sim; p: Player } {
  const sim = simOn(buildLevel(placed, makeHeader({ playerSqueeze: !platformer, platformer })), { x: 300, y: 100 });
  const p = p1(sim);
  p.lastX = 298;
  p.lastY = 101;
  Object.assign(p, { collideTop: top, collideBottom: bottom, ...over });
  return { sim, p };
}

test("the gap must be under 0.7 of the player's height, and both contacts there", () => {
  // Player at y 100 (190 in the game's space), 30 tall: the line is 21.
  const cases: [string, number, number, boolean][] = [
    ["20 apart", 200, 180, true],
    ["21 apart", 201, 180, false],
    ["no floor", 200, 0, false],
    ["no ceiling", 0, 180, false],
    ["the same line", 190, 190, false],
  ];
  for (const [what, top, bottom, dies] of cases) {
    const { sim, p } = staged(top, bottom);
    squeeze(sim, p);
    assert.equal(p.dead, dies, what);
    if (dies) assert.deepEqual([p.x, p.y], [300, 100], `${what}: left where it is`);
  }
});

test("a ceiling on the floor's side of where the player is and where its update began does not count", () => {
  // v24: upright, top below y and below the saved y; upside down, above both. [:158541-158560]
  const cases: [string, number, Partial<Player>, boolean][] = [
    ["below now and before", 189, {}, false],
    ["below now, above before", 189.5, { lastY: 99 }, true],
    ["upside down, above now and before", 192, { flipped: true, lastY: 101 }, false],
    ["upside down, above now, below before", 191, { flipped: true, lastY: 101.5 }, true],
  ];
  for (const [what, top, over, dies] of cases) {
    const { sim, p } = staged(top, top - 10, over);
    squeeze(sim, p);
    assert.equal(p.dead, dies, what);
  }
});

test("a smaller player has a smaller line", () => {
  // Mini: 18 tall, so 12.6. [getObjectRect's height, v170]
  const tight = staged(203, 190, { mini: true });
  squeeze(tight.sim, tight.p);
  assert.equal(tight.p.dead, false, "13 apart");
  const tighter = staged(202.5, 190, { mini: true });
  squeeze(tighter.sim, tighter.p);
  assert.equal(tighter.p.dead, true, "12.5 apart");
});

test("a squeezed platformer player first tries 3, 6, 9 and 12 units either side, right first", () => {
  // 0.8 of 30 is 24. The first place whose box — a unit narrower each side, a
  // unit taller each end — has no solid both below and above its centre wins.
  // [:158593-158656]
  const open = staged(210, 190, {}, true);
  squeeze(open.sim, open.p);
  assert.deepEqual([open.p.dead, open.p.x], [false, 303], "nothing around: 3 right");

  // A block above and one below from x 312: the box reaches 317 at +3 and
  // stops at 311 at −3.
  const wall: Placed[] = [
    { id: BLOCK, x: 327, y: 130 },
    { id: BLOCK, x: 327, y: 70 },
  ];
  const right = staged(210, 190, {}, true, wall);
  squeeze(right.sim, right.p);
  assert.deepEqual([right.p.dead, right.p.x], [false, 297], "shut to the right: 3 left");

  const boxed: Placed[] = [];
  for (let x = 255; x < 360; x += 30) boxed.push({ id: BLOCK, x, y: 130 }, { id: BLOCK, x, y: 70 });
  const shut = staged(210, 190, {}, true, boxed);
  squeeze(shut.sim, shut.p);
  assert.deepEqual([shut.p.dead, shut.p.x, shut.p.y], [true, 300, 100], "shut both ways: destroyed where it is");

  const level: Placed[] = [{ id: BLOCK, x: 327, y: 100 }];
  const beside = staged(210, 190, {}, true, level);
  squeeze(beside.sim, beside.p);
  assert.deepEqual([beside.p.dead, beside.p.x], [false, 297], "a block level with the player shuts a side on its own");
});

test("a platformer player on a slope with most of its height to spare is eased down the slope", () => {
  // 24 ≤ gap ≤ 30 and the slope's rect meets the player's: x velocity 0, x
  // the saved x (298) a quarter unit down the slope, and no death whatever
  // the gap's side. Left on an uphill floor slope or a downhill ceiling one,
  // right on the other two. [:158565-158592]
  const cases: [string, Partial<Placed>, number][] = [
    ["uphill floor", {}, 297.75],
    ["downhill ceiling", { flipY: true }, 297.75],
    ["downhill floor", { flipX: true }, 298.25],
    ["uphill ceiling", { flipX: true, flipY: true }, 298.25],
  ];
  for (const [what, flip, x] of cases) {
    const slope: Placed[] = [{ id: SLOPE, x: 300, y: 100, ...flip }];
    const { sim, p } = staged(215, 190, { slopeIdx: 0, xVel: 3 }, true, slope);
    squeeze(sim, p);
    assert.deepEqual([p.dead, p.xVel, p.x], [false, 0, x], what);
  }
});

test("a platformer always squeezes, whatever kA31 says", () => {
  // +2492 = kA31 ? 0 : !platformer, and 0 turns the test on. [:462941-462955]
  const sim = simOn(buildLevel([], makeHeader({ platformer: true, playerSqueeze: false })), { x: 300, y: 100 });
  assert.equal((sim as unknown as { squeezes: boolean }).squeezes, true);
});

/** A level of one block, and its player 1 put where it is and was, with no contacts yet. */
function contact(block: Placed, mode: GameMode, mini: boolean, at: Partial<Player>): { o: ObjectSet; p: Player } {
  const sim = simOn(buildLevel([block], makeHeader({ playerSqueeze: true })), { x: block.x, y: 200, mode, mini });
  const p = p1(sim);
  Object.assign(p, { collideTop: 0, collideBottom: 0, ...at });
  return { o: (sim as unknown as { objs: ObjectSet }).objs, p };
}

test("canSnap, not the side the player is put on, picks the floor or the ceiling", () => {
  // With canSnap clear the block's top is a floor, with it set its bottom is a
  // ceiling. [collidedWithObjectInternal :151947-151980, 152155-152204; v61
  // :151786-151808]
  //
  // A mini ball (18 tall, threshold 10) rising into a block whose bottom is
  // 8.5 above its feet: past head − 10, so a head contact, but short of
  // feet + 10, so canSnap is clear. The block's top, 38.5, is the floor.
  const head = contact({ id: BLOCK, x: 300, y: 23.5 }, "ball", true, { x: 300, y: 9, lastY: 9, yVel: 1 });
  assert.equal(collideSolid(head.p, head.o, 0, false), R_CEIL);
  assert.deepEqual([head.p.collideBottom, head.p.collideTop], [38.5 + 90, 0], "mini ball, head first");

  // The same block well above a full-size ball: canSnap is set, and its
  // bottom, 8.5, is the ceiling.
  const tall = contact({ id: BLOCK, x: 300, y: 23.5 }, "ball", false, { x: 300, y: -5, lastY: -5, yVel: 1 });
  assert.equal(collideSolid(tall.p, tall.o, 0, false), R_CEIL);
  assert.deepEqual([tall.p.collideBottom, tall.p.collideTop], [0, 8.5 + 90], "ball, head first");

  // A cube that fell through a 3-unit slab in one step, its feet from 60 to
  // 35: landed on, but 35 + 10 is short of the slab's bottom, so canSnap is
  // set and the bottom, 50, is a ceiling.
  const slab: Placed = { id: BLOCK, x: 300, y: 51.5, scaleY: 0.1 };
  const fell = { x: 300, y: 50, lastY: 75, yVel: -1 };
  const thin = contact(slab, "cube", false, fell);
  assert.equal(collideSolid(thin.p, thin.o, 0, false), R_LAND);
  assert.deepEqual([thin.p.collideBottom, thin.p.collideTop], [0, 50 + 90], "cube, landed on");

  // Passable (key 134), the same slab records nothing.
  const passable = contact({ ...slab, props: { 134: "1" } }, "cube", false, fell);
  assert.equal(collideSolid(passable.p, passable.o, 0, false), R_LAND);
  assert.deepEqual([passable.p.collideBottom, passable.p.collideTop], [0, 0], "passable, landed on");
});

test("the contacts keep the nearest floor and ceiling, and a gravity flip forgets them", () => {
  const w: PlayerWorld = { emit: () => {}, spiderJump: () => {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true };
  const p = new Player(w, 1);
  p.updateCollideBottom(10);
  p.updateCollideBottom(30);
  p.updateCollideTop(60);
  p.updateCollideTop(50);
  assert.deepEqual([p.collideBottom, p.collideTop], [120, 140]);
  p.flipGravity(true);
  assert.deepEqual([p.collideBottom, p.collideTop], [0, 0]);
  p.updateCollideBottom(30);
  p.updateCollideBottom(10);
  p.updateCollideTop(50);
  p.updateCollideTop(60);
  assert.deepEqual([p.collideBottom, p.collideTop], [100, 150], "upside down, the lowest floor and the highest ceiling");
});

test("in rotated gameplay a contact is the player's world y plus the edge's distance from where it stood", () => {
  // The game turns the object a quarter about the player first. [:154412-154413]
  const w: PlayerWorld = { emit: () => {}, spiderJump: () => {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true };
  const p = new Player(w, 1);
  p.axesSwapped = true;
  p.x = 50;
  p.y = 400;
  p.updateCollideBottom(385, 50, 400);
  assert.equal(p.collideBottom, Math.fround(50 + 90 - 15));
});

test("the pass records the band's floor and the blocks over it", () => {
  // A ship on the band's floor at 0 under blocks from 40 up: the floor is its
  // own edge, the ceiling the blocks' undersides, in the game's space.
  const placed: Placed[] = [];
  for (let x = 15; x < 600; x += 30) placed.push({ id: BLOCK, x, y: 55 });
  const sim = simOn(buildLevel(placed, makeHeader({ playerSqueeze: true })), { x: 15, y: 15, mode: "ship" });
  sim.step(NO_INPUT);
  assert.deepEqual([p1(sim).collideBottom, p1(sim).collideTop], [90, 0]);
  const hold = { jump: true, left: false, right: false };
  for (let t = 0; t < 120 && p1(sim).collideTop === 0; t++) sim.step(hold);
  assert.deepEqual([p1(sim).collideBottom, p1(sim).collideTop], [0, 130]);
  assert.equal(sim.state.dead, false, "one at a time is no squeeze");
});

test("the walls keep the rightmost on the left and the leftmost on the right; a gravity flip leaves them, a pass empties them", () => {
  const w: PlayerWorld = { emit: () => {}, spiderJump: () => {}, platformer: true, dual: false, fixGravityBug: false, boostSlide: true };
  const p = new Player(w, 1);
  p.updateCollideLeft(280);
  p.updateCollideLeft(290);
  p.updateCollideLeft(285);
  p.updateCollideRight(320);
  p.updateCollideRight(310);
  p.updateCollideRight(315);
  assert.deepEqual([p.collideLeft, p.collideRight], [290, 310]);
  p.flipGravity(true);
  assert.deepEqual([p.collideLeft, p.collideRight], [290, 310], "only the floor and ceiling go [:151146-151147]");
  p.updateCollideLeft(295);
  assert.equal(p.collideLeft, 295, "the rightmost, upside down too");

  const sim = simOn(buildLevel([], makeHeader({ platformer: true })), { x: 300, y: 100 });
  Object.assign(p1(sim), { collideLeft: 290, collideRight: 310 });
  sim.step(NO_INPUT);
  assert.deepEqual([p1(sim).collideLeft, p1(sim).collideRight], [0, 0]);
});

/** A platformer level of one block, and its player 1 put where it is and was, with no walls yet. */
function wallContact(block: Placed, at: Partial<Player>): { o: ObjectSet; p: Player } {
  const sim = simOn(buildLevel([block], makeHeader({ platformer: true })), { x: block.x, y: 100 });
  const p = p1(sim);
  Object.assign(p, { collideLeft: 0, collideRight: 0, ...at });
  return { o: (sim as unknown as { objs: ObjectSet }).objs, p };
}

test("a platformer's side push records the block's face as a wall", () => {
  // Put left of a block, its minX is a wall on the right; put right of one,
  // its maxX is a wall on the left. [collidedWithObjectInternal :152313-152337]
  const at = { x: 300, y: 100, lastX: 300, lastY: 100 };
  const onLeft = wallContact({ id: BLOCK, x: 322, y: 100 }, at);
  collideSolid(onLeft.p, onLeft.o, 0, true);
  assert.deepEqual([onLeft.p.x, onLeft.p.collideLeft, onLeft.p.collideRight], [292, 0, 307]);
  const onRight = wallContact({ id: BLOCK, x: 278, y: 100 }, at);
  collideSolid(onRight.p, onRight.o, 0, true);
  assert.deepEqual([onRight.p.x, onRight.p.collideLeft, onRight.p.collideRight], [308, 293, 0]);
  const classic = wallContact({ id: BLOCK, x: 322, y: 100 }, at);
  collideSolid(classic.p, classic.o, 0, false);
  assert.deepEqual([classic.p.collideLeft, classic.p.collideRight], [0, 0], "a classic level has no side push");
});

test("a platformer player only touching a block's side cannot land on it", () => {
  // The block spans x 307..337 with its top at 115. The player's box, 2.5
  // narrower each side, must still touch it to meet the top; short of that
  // it goes to the side push, whose box is 2.5 shorter at each end and so
  // misses a block whose top is level with the feet. A stack of blocks is a
  // wall, not a ladder. [collidedWithObjectInternal :151741, :151767-151773, :152304-152307]
  const falling = (x: number) => ({ x, y: 130, lastX: x, lastY: 130.5, yVel: -1, onGround: false });
  const edge = wallContact({ id: BLOCK, x: 322, y: 100 }, falling(292));
  assert.equal(collideSolid(edge.p, edge.o, 0, true), 0);
  assert.deepEqual([edge.p.x, edge.p.y, edge.p.onGround], [292, 130, false], "a touch on the side is no floor");
  const over = wallContact({ id: BLOCK, x: 322, y: 100 }, falling(296));
  assert.equal(collideSolid(over.p, over.o, 0, true), R_LAND, "4 over the edge is more than the 2.5 taken off");
  const classic = wallContact({ id: BLOCK, x: 322, y: 100 }, falling(292));
  assert.equal(collideSolid(classic.p, classic.o, 0, false), R_LAND, "a classic level lands on a touch");
});

test("the block that last pushed a platformer player is kept until a step logs no wall on that side", () => {
  // updateCollideRight remembers it (+1308) and drops the other side's;
  // postCollision forgets it once a step's log has no right wall. [:142922-142923, :159172-159175]
  const { o, p } = wallContact({ id: BLOCK, x: 322, y: 100 }, { x: 300, y: 100, lastX: 300, lastY: 100 });
  p.wallLeftObj = 5;
  collideSolid(p, o, 0, true);
  assert.deepEqual([p.wallLeftObj, p.wallRightObj], [-1, 0]);
  p.forgetWalls();
  assert.equal(p.wallRightObj, 0, "a wall was logged this step");
  p.resetCollisionLog();
  p.forgetWalls();
  assert.equal(p.wallRightObj, -1);
});

test("in rotated gameplay a wall is the player's world x less the face's distance, and the sides trade", () => {
  // The quarter turn about the player takes a world y offset d to an x
  // offset of −d; the mirror keeps it +d. [rotateGameplayObject :154412-154413]
  const w: PlayerWorld = { emit: () => {}, spiderJump: () => {}, platformer: true, dual: false, fixGravityBug: false, boostSlide: true };
  const p = new Player(w, 1);
  p.axesSwapped = true;
  p.x = 100;
  p.y = 300;
  p.updateCollideLeft(107, 100, 300);
  assert.equal(p.collideLeft, 293);

  // Put on the mirror's left of a block, which is the game's right of it.
  const { o, p: q } = wallContact({ id: BLOCK, x: 322, y: 100 }, { x: 300, y: 100, lastX: 300, lastY: 100 });
  q.axesSwapped = true;
  collideSolid(q, o, 0, true);
  assert.deepEqual([q.collideLeft, q.collideRight], [100 - (307 - 300), 0]);
});

test("a platformer player between walls closer than its width less 5 × its scale is squeezed", () => {
  // 30 wide: under 25 apart; 18 wide when mini: under 15. [postCollision :158724-158743]
  const cases: [string, number, number, Partial<Player>, boolean][] = [
    ["24 apart", 290, 314, {}, true],
    ["25 apart", 290, 315, {}, false],
    ["no left wall", 0, 314, {}, false],
    ["no right wall", 290, 0, {}, false],
    ["mini, 14.5 apart", 290, 304.5, { mini: true }, true],
    ["mini, 15 apart", 290, 305, { mini: true }, false],
  ];
  for (const [what, left, right, over, squeezed] of cases) {
    const { sim, p } = staged(0, 0, { collideLeft: left, collideRight: right, ...over }, true);
    squeeze(sim, p);
    // Nothing around, so a squeezed player goes 3 up.
    assert.deepEqual([p.dead, p.x, p.y], [false, 300, squeezed ? 103 : 100], what);
  }
});

test("the wall on the side the player moves to, past it now and before, ends the wall test", () => {
  // xVel < 0: a left wall right of x and of the saved x; otherwise a right
  // wall left of both. Player at 300, saved at 298. [:158734-158742]
  const cases: [string, number, number, number, boolean][] = [
    ["still, right wall left of both", 280, 297, 0, false],
    ["still, right wall between them", 280, 299, 0, true],
    ["moving left, left wall right of both", 301, 310, -1, false],
    ["moving left, left wall between them", 299, 310, -1, true],
    ["moving right, left wall right of both", 301, 310, 1, true],
  ];
  for (const [what, left, right, xVel, squeezed] of cases) {
    const { sim, p } = staged(0, 0, { collideLeft: left, collideRight: right, xVel }, true);
    squeeze(sim, p);
    assert.equal(p.y, squeezed ? 103 : 100, what);
  }
});

test("a player squeezed between walls tries 3, 6, 9 and 12 units up and down, up first, or is destroyed", () => {
  // Each place's box is a unit wider each side and a unit shorter each end.
  // Something found left of the player's centre is a left side, anything
  // else a right side; both shut the place. [:158745-158826]
  const walls = { collideLeft: 290, collideRight: 310 };

  // A block right of the centre that only the +3 box (89 to 117) meets.
  const high: Placed[] = [{ id: BLOCK, x: 315, y: 128 }];
  const down = staged(0, 0, walls, true, high);
  squeeze(down.sim, down.p);
  assert.deepEqual([down.p.dead, down.p.y], [false, 97], "shut above: 3 down");

  // Blocks either side of the centre, from 55 to 145: every place meets both.
  const pinch: Placed[] = [];
  for (const y of [70, 100, 130]) pinch.push({ id: BLOCK, x: 285, y }, { id: BLOCK, x: 315, y });
  const shut = staged(0, 0, walls, true, pinch);
  squeeze(shut.sim, shut.p);
  assert.deepEqual([shut.p.dead, shut.p.x, shut.p.y], [true, 300, 100], "shut every way: destroyed where it is");
  assert.equal(shut.p.killedBy, null);

  const left: Placed[] = [{ id: BLOCK, x: 285, y: 100 }];
  const oneSide = staged(0, 0, walls, true, left);
  squeeze(oneSide.sim, oneSide.p);
  assert.deepEqual([oneSide.p.dead, oneSide.p.y], [false, 103], "one side only: open");
});

test("the game reads an object's y where the wall test means its x", () => {
  // Something not left of the centre shuts the place when its y, in the
  // game's space, is at or below the player's x. [:158799]
  const block: Placed[] = [{ id: BLOCK, x: 315, y: 100 }];
  const far = staged(0, 0, { collideLeft: 290, collideRight: 310 }, true, block);
  squeeze(far.sim, far.p);
  assert.deepEqual([far.p.dead, far.p.y], [true, 100], "x 300, the block's y 190: shut every way");

  const nearBlock: Placed[] = [{ id: BLOCK, x: 115, y: 100 }];
  const near = staged(0, 0, { x: 100, lastX: 98, collideLeft: 90, collideRight: 110 }, true, nearBlock);
  squeeze(near.sim, near.p);
  assert.deepEqual([near.p.dead, near.p.y], [false, 103], "x 100, under the block's y: a right side only, so open");
});

test("the wall test follows the floor-and-ceiling one, whatever it did, in a platformer only", () => {
  // The first test's nudge jumps past its death to the wall test. [:158605-158612, 158716]
  const both = staged(210, 190, { collideLeft: 290, collideRight: 314 }, true);
  squeeze(both.sim, both.p);
  assert.deepEqual([both.p.dead, both.p.x, both.p.y], [false, 303, 103], "3 right, then 3 up");

  const classic = staged(0, 0, { collideLeft: 290, collideRight: 300 });
  squeeze(classic.sim, classic.p);
  assert.deepEqual([classic.p.dead, classic.p.y], [false, 100], "kA31 alone tests no walls");
});

test("a platformer player caught between two walls 20 apart dies in the pass", () => {
  const placed: Placed[] = [];
  for (const y of [70, 100, 130]) placed.push({ id: BLOCK, x: 275, y }, { id: BLOCK, x: 325, y });
  const sim = simOn(buildLevel(placed, makeHeader({ platformer: true })), { x: 300, y: 100 });
  sim.step(NO_INPUT);
  assert.equal(sim.state.dead, true);
  assert.deepEqual([p1(sim).collideLeft, p1(sim).collideRight], [290, 310]);
  assert.equal(p1(sim).killedBy, null, "no object is to blame");
});

// --- the collision log -----------------------------------------------------------

test("a contact that names its object logs it, once, and a gravity flip empties the log", () => {
  // storeCollision keys each direction's set by the object; the ground names
  // none. [PlayerObject::storeCollision :142440-142490; updateCollideTop and
  //  the rest :142767-142926; flipGravity :151155]
  const w: PlayerWorld = { emit: () => {}, spiderJump: () => {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true };
  const p = new Player(w, 1);
  p.updateCollideBottom(10);
  p.updateCollideBottom(30, p.x, p.y, 4);
  p.updateCollideBottom(20, p.x, p.y, 4);
  p.updateCollideTop(60, p.x, p.y, 5);
  p.updateCollideLeft(0, p.x, p.y, 6);
  p.updateCollideRight(40, p.x, p.y, 7);
  assert.deepEqual([p.logBottom, p.logTop, p.logLeft, p.logRight], [[4], [5], [6], [7]]);
  p.flipGravity(true);
  assert.deepEqual([p.logBottom, p.logTop, p.logLeft, p.logRight], [[], [], [], []]);
});

test("one object logged as floor and ceiling in a step puts the player back and destroys it, in any level", () => {
  // The first log check runs after the first squeeze test whatever kA31 says,
  // and puts the player back where its update began before the death, in
  // play as well; the second, walls on both sides, only in a platformer.
  // [PlayerObject::postCollision :158682-158715 → LABEL_303 :158694-158711,
  //  :158831-158845; resetCollisionLog from GJBaseGameLayer::update
  //  :469854-469856]
  const classic = simOn(buildLevel([{ id: BLOCK, x: 600, y: 15 }]));
  classic.step(NO_INPUT);
  const p = p1(classic);
  assert.deepEqual([p.logTop, p.logBottom], [[], []], "the ground logs nothing");
  const back = [p.lastX, p.lastY];
  p.logTop.push(0);
  p.logBottom.push(1);
  squeeze(classic, p);
  assert.equal(p.dead, false, "two objects are no crush");
  p.logBottom.push(0);
  squeeze(classic, p);
  assert.equal(p.dead, true, "one object both ways is");
  assert.deepEqual([p.x, p.y], back, "put back where its update began");

  const walls = (platformer: boolean) => {
    const sim = simOn(buildLevel([{ id: BLOCK, x: 600, y: 15 }], makeHeader({ platformer })));
    sim.step(NO_INPUT);
    const q = p1(sim);
    q.logLeft.push(0);
    q.logRight.push(0);
    squeeze(sim, q);
    return q.dead;
  };
  assert.equal(walls(true), true, "walls on both sides, in a platformer");
  assert.equal(walls(false), false, "the wall log is only read in a platformer");
});

test("each step starts the collision log over", () => {
  const sim = simOn(buildLevel([{ id: BLOCK, x: 600, y: 15 }]));
  sim.step(NO_INPUT);
  p1(sim).logTop.push(0);
  sim.step(NO_INPUT);
  assert.deepEqual(p1(sim).logTop, []);
  assert.equal(sim.state.dead, false);
});
