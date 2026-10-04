// The player's own oriented box, pinned to the 2.206 decompile: an object
// turned off the right angles is met by the player's box turned the way the
// player is drawn, not by its upright rect. The derivation is in
// data/ref/gd-discrepancies.md §11.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGroupTransform, ObjectSet, reflectObject, S_AABB, S_CIRCLE, S_OBB } from "../src/physics/collision";
import { Player } from "../src/physics/player";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { loadObjectTable, makeSim } from "./helpers";
import { buildLevel, emptyLevel, floor, makeHeader, simOn, STANDING_Y, type Placed } from "./levelKit";

const SPIKE = 8;
const YELLOW_GRAVITY_PORTAL = 11;
const SMALL_SAW = 98;
const ROTATE_GAMEPLAY = 2900;

function p1(sim: Sim): Player {
  return sim.state as Player;
}

function near(actual: number, expected: number, what: string, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

/** Where a cube standing at x 15 is after one step: the floor holds y, x moves one step. */
function oneStepX(): number {
  const sim = simOn(emptyLevel());
  sim.step(NO_INPUT);
  return sim.state.x;
}

/** A cube standing at x 15 with `extra` in the level, drawn at `rotation` for the next pass, one step on. */
function standAndStep(extra: Placed[], rotation: number): Sim {
  const sim = simOn(emptyLevel(extra));
  p1(sim).rotation = rotation;
  sim.step(NO_INPUT);
  return sim;
}

test("a spinning cube's corner no longer reaches what its upright corner did", () => {
  // A spike turned 45° sits on the diagonal off the box's top right corner, 24
  // units from the centre: the upright corner is 21.2 out along that line and
  // the spike starts at 18, but a box turned 45° has a face there, at 15.
  // [hazards :465009-465052; the player's box, updateOrientedBox
  //  :170865-170900 with getObjectRotation :140253]
  const x = oneStepX();
  const d = 24 * Math.SQRT1_2;
  const spike: Placed = { id: SPIKE, x: x + d, y: STANDING_Y + d, rotation: 45 };
  const upright = standAndStep([spike], 0);
  assert.equal(upright.state.dead, true, "upright, the corner touches it");
  const turned = standAndStep([spike], 45);
  assert.equal(turned.state.dead, false, "turned 45°, it does not");
});

test("a turned cube's corner reaches what its upright rect does not", () => {
  // A double-size spike turned 165°, 22 across and 17 up: its outer box meets
  // the player's rect, its own box does not, and the player's box turned 30°
  // does. Both steps are needed, the outer box first. [:465024-465052]
  const x = oneStepX();
  const spike: Placed = { id: SPIKE, x: x + 22, y: STANDING_Y + 17, rotation: 165, scaleX: 2, scaleY: 2 };
  const upright = standAndStep([spike], 0);
  assert.equal(upright.state.dead, false, "upright, it misses");
  const turned = standAndStep([spike], 30);
  assert.equal(turned.state.dead, true, "turned 30°, it touches");
  assert.equal(turned.state.killedBy, turned.level.objects.length - 1);
  // A right angle is upright as far as a square box goes.
  assert.equal(standAndStep([spike], 90).state.dead, false, "90°");
  assert.equal(standAndStep([spike], -270).state.dead, false, "−270°");
});

test("portals, pads and orbs meet the turned box too", () => {
  // A gravity portal turned 45°, 43 units straight up: the upright rect's top
  // edge reaches its tip, the box turned 45° does not. [collisionCheckObjects
  //  :463466-463478, updateOrientedBox on the player at :463470]
  const x = oneStepX();
  const portal: Placed = { id: YELLOW_GRAVITY_PORTAL, x, y: STANDING_Y + 43, rotation: 45 };
  assert.equal(p1(standAndStep([portal], 0)).flipped, true, "upright, the portal flips it");
  assert.equal(p1(standAndStep([portal], 45)).flipped, false, "turned 45°, it is never touched");
});

test("a round hazard ignores the player's angle", () => {
  // A circle's placed angle never orients it (updateIsOriented stops at a
  // radius, :170702-170722), so the corner test against the upright rect
  // stands; only a trigger's turn does (see below).
  // [playerCircleCollision :419752-419758]
  const x = oneStepX();
  const d = (15 * Math.SQRT2 + 11) * Math.SQRT1_2;
  const saw: Placed = { id: SMALL_SAW, x: x + d, y: STANDING_Y + d };
  for (const rotation of [0, 45]) assert.equal(standAndStep([saw], rotation).state.dead, true, `${rotation}°`);
});

test("a mini cube's box is its own size, turned", () => {
  // The box is +648 × +764: 30 × 0.6. The same spike 17 out on the diagonal
  // starts at 11, inside the upright corner (12.7) and clear of the turned
  // face (9). [updateOrientedBox :170891-170892, :170904-170905]
  const control = simOn(emptyLevel(), { mini: true });
  control.step(NO_INPUT);
  const { x, y } = control.state;
  const d = 17 * Math.SQRT1_2;
  const spike: Placed = { id: SPIKE, x: x + d, y: y + d, rotation: 45 };
  for (const [rotation, dead] of [
    [0, true],
    [45, false],
  ] as const) {
    const sim = simOn(emptyLevel([spike]), { mini: true });
    p1(sim).rotation = rotation;
    sim.step(NO_INPUT);
    assert.equal(sim.state.dead, dead, `${rotation}°`);
  }
});

test("each twin meets the level with its own box and angle", () => {
  // Player 2 starts where player 1 does and rises, turned over; drawn at 30°
  // it touches the spike from the second test, while player 1, upright a
  // hair lower, does not. [checkCollisions runs once per player, :469919,
  //  :469933; each reads its own getOrientedBox]
  const control = simOn(emptyLevel(), { dual: true });
  control.step(NO_INPUT);
  const twin = control.state2!;
  const spike: Placed = { id: SPIKE, x: twin.x + 22, y: twin.y + 17, rotation: 165, scaleX: 2, scaleY: 2 };
  for (const [rotation, dead] of [
    [0, false],
    [30, true],
  ] as const) {
    const sim = simOn(emptyLevel([spike]), { dual: true });
    (sim.state2 as Player).rotation = rotation;
    sim.step(NO_INPUT);
    assert.equal(sim.state.dead, dead, `player 2 at ${rotation}°`);
    if (dead) assert.equal(sim.events.find((e) => e.type === "die")?.player, 2);
  }
});

/**
 * Rotated gameplay from x 100 (keys 166 3, 167 4): the player runs up the y
 * axis and falls towards x 0, and collision runs in its mirrored frame.
 */
function rotated(extra: Placed[]): Sim {
  const level = buildLevel([...floor(0, 3000), { id: ROTATE_GAMEPLAY, x: 100, y: 45, props: { 166: "3", 167: "4" } }, ...extra], makeHeader());
  return makeSim(level, undefined, { start: { x: 15, y: 45, mode: "cube" } });
}

/** Steps until five ticks after the turn, draws the player at 30° and takes one more step. */
function turnedStep(sim: Sim): void {
  let turned = -1;
  for (let i = 0; i < 400 && (turned < 0 || sim.tick < turned + 5); i++) {
    sim.step(NO_INPUT);
    if (turned < 0 && p1(sim).rotated) turned = sim.tick;
    assert.equal(sim.state.dead, false, `died at tick ${sim.tick}`);
  }
  p1(sim).rotation = 30;
  sim.step(NO_INPUT);
}

test("in rotated gameplay the box turns in the world, where it is drawn", () => {
  // The pass runs in the mirror, where the player's angle becomes 90° less
  // its own, as every object's does; the same spike as above, placed in world
  // terms, touches the box drawn at 30°. Mirrored without that, the box
  // would be at 60° and miss. [the hazard test has no rotated-gameplay case:
  //  :465009-465052 are world rects and boxes]
  const control = rotated([]);
  turnedStep(control);
  const { x, y } = control.state;
  const sim = rotated([{ id: SPIKE, x: x + 22, y: y + 17, rotation: 165, scaleX: 2, scaleY: 2 }]);
  turnedStep(sim);
  assert.equal(p1(sim).rotated, true);
  assert.equal(sim.state.dead, true, "the spike touches the box drawn at 30°");
});

test("an object within a degree of a right angle is upright, and meets the player's rect", () => {
  // updateIsOriented tests the angle cut to whole degrees, so 0.99° is upright
  // and 1° is not; an upright object is met by the player's rect whatever the
  // player's angle. Only exactly ±90 and ±270 swap the rect, so 90.5° keeps
  // it unturned. A spike whose corner sits just inside the player's upright
  // corner, clear of its box turned 45°. [:170702-170722; the swap,
  // setRotation :164488-164489 and getObjectRect :170839-170844]
  const x = oneStepX();
  const spike = (rotation: number): Placed => ({ id: SPIKE, x: x + 17, y: STANDING_Y + 20, rotation });
  for (const [rotation, dead] of [
    [0.5, true],
    [-0.5, true],
    [0.99, true],
    [1, false],
  ] as const) {
    assert.equal(standAndStep([spike(rotation)], 45).state.dead, dead, `spike at ${rotation}°, player at 45°`);
  }
  const set = new ObjectSet(emptyLevel([spike(90.5), spike(90), spike(89.5)]), loadObjectTable());
  const at = (k: number) => [set.shape[k], set.hw[k], set.hh[k]];
  const n = set.n;
  assert.deepEqual(at(n - 3), [S_AABB, 3, 6], "90.5°: upright and unturned");
  assert.deepEqual(at(n - 2), [S_AABB, 6, 3], "90°: upright and swapped");
  assert.equal(set.shape[n - 1], S_OBB, "89.5°: oriented");
});

test("a solid or slope off the quarter turns lies flat, as it is drawn", () => {
  // Without key 121 a solid, breakable or slope loses a key-6 angle that is
  // not a whole quarter turn; the object's own rotation is what its rect
  // reads, so the hitbox lies flat with the art. [objectFromVector
  // :184221-184225]
  const SLAB = 40; // 30 × 14
  const SLOPE = 289;
  const set = new ObjectSet(
    emptyLevel([
      { id: SLAB, x: 300, y: 200, rotation: 45 },
      { id: SLAB, x: 300, y: 200, rotation: 90 },
      { id: SLOPE, x: 300, y: 200, rotation: 135 },
      { id: SLOPE, x: 300, y: 200 },
    ]),
    loadObjectTable(),
  );
  const n = set.n;
  const at = (k: number) => [set.shape[k], set.hw[k], set.hh[k], set.rawRot[k]];
  assert.deepEqual(at(n - 4), [S_AABB, 15, 7, 0], "45°: flat, not the nearest quarter turn");
  assert.deepEqual(at(n - 3), [S_AABB, 7, 15, 90], "90°: turned");
  assert.equal(set.flags[n - 2], set.flags[n - 1], "the slope at 135° is the slope at 0°");
  assert.equal(set.rawRot[n - 2], 0);
});

test("a trigger's turn orients a box at any angle; a move alone keeps its rect", () => {
  // A rotation action runs calculateOrientedBox, which sets +636 whatever the
  // angle, so the object meets the player's turned box from then on. A move
  // leaves an upright box upright, its right angle's swap and all. A solid
  // stays square to the axes here (not modelled). [fastRotateObject
  //  :170742-170750, calculateOrientedBox :170660-170664; processRotationActions
  //  :440005-440015]
  const level = buildLevel([
    { id: SPIKE, x: 100, y: 100, rotation: 90 },
    { id: 1, x: 200, y: 100 },
  ]);
  const base = new ObjectSet(level, loadObjectTable());
  const live = base.cloneForMotion();
  const move = Float64Array.of(1, 0, 0, 1, 5, 0);
  const box = (k: number) => [live.shape[k], live.x0[k], live.x1[k], live.y0[k], live.y1[k]];
  applyGroupTransform(base, live, 0, move, 0, 1, 1);
  assert.deepEqual(box(0), [S_AABB, base.x0[0] + 5, base.x1[0] + 5, base.y0[0], base.y1[0]], "moved");
  applyGroupTransform(base, live, 0, move, 90, 1, 1);
  assert.deepEqual([live.shape[0], live.hw[0], live.hh[0], live.cosR[0]], [S_OBB, 3, 6, -1], "turned to 180°: its own box, oriented");
  near(live.x1[0] - live.x0[0], 6, "6 across");
  near(live.y1[0] - live.y0[0], 12, "12 up");
  assert.equal(base.shape[0], S_AABB, "the shared set is not written");
  const mirror = base.cloneReflected();
  reflectObject(live, mirror, 0);
  assert.equal(mirror.shape[0], S_OBB, "the mirror follows");
  applyGroupTransform(base, live, 1, move, 90, 1, 1);
  assert.equal(live.shape[1], S_AABB, "a solid");
});

// --- round hazards a trigger turns -----------------------------------------------

const COGWHEEL = 1734;
const BEAST = 2012;
const ROTATE_TRIGGER = 1346;

test("a trigger's turn gives a round hazard its own box, which scales, turns and mirrors with it", () => {
  // fastRotateObject runs calculateOrientedBox for a circle as for anything
  // else, so +636 is set. The box is +648 × +652 at the object's scale: the
  // sprite's untrimmed size, 80 across for the cogwheel, not the circle.
  // [fastRotateObject :170742-170750; updateOrientedBox :170865-170900;
  //  GameObject::commonSetup :166725-166726]
  const level = buildLevel([{ id: COGWHEEL, x: 100, y: 100, scaleX: 0.5, scaleY: 0.5 }]);
  const base = new ObjectSet(level, loadObjectTable());
  assert.deepEqual([base.shape[0], base.turned[0], base.boxHw[0], base.boxHh[0]], [S_CIRCLE, 0, 20, 20], "placed");
  const live = base.cloneForMotion();
  const still = Float64Array.of(1, 0, 0, 1, 0, 0);
  applyGroupTransform(base, live, 0, still, 0, 2, 1);
  assert.deepEqual([live.shape[0], live.turned[0], live.boxHw[0], live.boxHh[0]], [S_CIRCLE, 0, 40, 20], "scaled, not turned");
  applyGroupTransform(base, live, 0, still, 30, 2, 1);
  assert.deepEqual([live.shape[0], live.turned[0], live.boxHw[0], live.boxHh[0]], [S_CIRCLE, 1, 40, 20], "turned: still a circle first");
  near(live.cosR[0], Math.cos(Math.PI / 6), "the box's angle, cos");
  near(live.sinR[0], Math.sin(Math.PI / 6), "the box's angle, sin");
  near(live.x1[0] - live.x0[0], 2 * live.hw[0], "the circle still bounds it");
  assert.equal(base.turned[0], 0, "the shared set is not written");
  const mirror = base.cloneReflected();
  reflectObject(live, mirror, 0);
  assert.deepEqual([mirror.turned[0], mirror.boxHw[0], mirror.boxHh[0]], [1, 40, 20], "the mirror keeps the box on its own axes");
  near(mirror.cosR[0], live.sinR[0], "at 90° less the world's angle");
});

/**
 * A beast 2012 — a circle of 15 about a box of 8 — 20 across and 20 up from
 * `at`, in group 5, which a rotate trigger at x 0 turns a quarter at the
 * start when `turn` is set.
 */
function beastLevel(at: { x: number; y: number }, turn: boolean, kA39: boolean, before: Placed[] = []): ReturnType<typeof buildLevel> {
  const beast: Placed = { id: BEAST, x: at.x + 20, y: at.y + 20 };
  const trigger: Placed[] = turn ? [{ id: ROTATE_TRIGGER, x: 0, y: 300, props: { 51: "5", 68: "90", 10: "0" } }] : [];
  const level = buildLevel([...floor(0, 3000), ...before, ...trigger, beast], makeHeader({ fixRadiusCollision: kA39 }));
  level.objects[level.objects.length - 1].groups = [5];
  return level;
}

test("a round hazard a trigger has turned kills only where its own box meets the player's too, unless kA39", () => {
  // Running under it, the leading corner enters the circle, but the box sits
  // a unit above the player's top the whole way, so the turned beast lets it
  // by. kA39 skips the box and keeps circle against circle, which the player
  // meets 28.3 apart against 30, turned or not. Placed off where the player
  // is twenty steps in, well after the trigger's turn.
  // [hazards :465038-465052, the kA39 skip :465042; setupAnimatedSize
  //  :307299-307303, 307311-307312, 307336-307337]
  const control = simOn(emptyLevel());
  for (let i = 0; i < 20; i++) control.step(NO_INPUT);
  const at = { x: control.state.x, y: control.state.y };
  for (const [turn, kA39, dead] of [
    [false, false, true],
    [true, false, false],
    [true, true, true],
    [false, true, true],
  ] as const) {
    const sim = makeSim(beastLevel(at, turn, kA39), undefined, { start: { x: 15, y: STANDING_Y, mode: "cube" } });
    for (let i = 0; i < 20 && !sim.state.dead; i++) sim.step(NO_INPUT);
    assert.equal(sim.state.dead, dead, `turned ${turn}, kA39 ${kA39}`);
  }
});

test("in rotated gameplay a turned round hazard is met by its own box in the mirror too", () => {
  // The same beast, placed off where the player is five steps after the
  // gameplay turn, with the pass running in the mirror: the corners reach its
  // circle on the way up, and only the turned one lets the player by.
  // [:465038-465052; reflectObject]
  const control = rotated([]);
  turnedStep(control);
  const at = { x: control.state.x, y: control.state.y };
  const gameplay: Placed = { id: ROTATE_GAMEPLAY, x: 100, y: 45, props: { 166: "3", 167: "4" } };
  for (const [turn, kA39, dead] of [
    [false, false, true],
    [true, false, false],
    [true, true, true],
  ] as const) {
    const sim = makeSim(beastLevel(at, turn, kA39, [gameplay]), undefined, { start: { x: 15, y: 45, mode: "cube" } });
    let turned = -1;
    for (let i = 0; i < 400 && (turned < 0 || sim.tick <= turned + 5) && !sim.state.dead; i++) {
      sim.step(NO_INPUT);
      if (turned < 0 && p1(sim).rotated) turned = sim.tick;
    }
    assert.equal(p1(sim).rotated, true, `turned ${turn}, kA39 ${kA39}: in rotated gameplay`);
    assert.equal(sim.state.dead, dead, `turned ${turn}, kA39 ${kA39}`);
  }
});
