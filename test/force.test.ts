// Force blocks (2069) and force circles (3645): what a touch adds up, the push
// the next update gives each mode, and the object's own settings — pinned to
// the 2.206 decompile. touchedObject :159675-159698, calculateForceToTarget
// :312994-313089, the push in PlayerObject::update :161032, 161355-161424,
// the wear-off in updateStateVariables :153707-153715.
//
// One tick's y step for the push is JUMP_DT = the float 0.225, so a force of F
// pushes a cube fround(fround(0.225 × F)) a tick: 0.27000001072883606 for 1.2.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JUMP_DT } from "../src/physics/constants";
import { Player, quantizeYVelocity, type PlayerWorld } from "../src/physics/player";
import { NO_INPUT, type Sim } from "../src/physics/types";
import type { GameMode } from "../src/level/types";
import { buildLevel, makeHeader, type Placed, simOn } from "./levelKit";

const f = Math.fround;
const FORCE_BLOCK = 2069;
const FORCE_CIRCLE = 3645;
const BLOCK = 1;

function world(over: Partial<PlayerWorld> = {}): PlayerWorld {
  return { emit: () => {}, spiderJump: () => {}, platformer: false, dual: false, fixGravityBug: false, boostSlide: true, ...over };
}

function p1(sim: Sim): Player {
  return (sim as unknown as { p1: Player }).p1;
}

function touch(sim: Sim, p: Player, i: number): void {
  (sim as unknown as { touchForce(p: Player, i: number): void }).touchForce(p, i);
}

function applyForce(p: Player): void {
  (p as unknown as { applyForce(dt: number): void }).applyForce(JUMP_DT);
}

/** A player in the air in `mode`, with the given y velocity. */
function airborne(mode: GameMode, yVel: number, over: Partial<PlayerWorld> = {}): Player {
  const p = new Player(world(over), 1);
  p.setMode(mode);
  p.y = 300;
  p.yVel = yVel;
  return p;
}

test("a touch sets the counter and adds its push to the pass's vector, in floats", () => {
  const p = new Player(world(), 1);
  p.touchForce(f(1.5), f(2.5), 0);
  p.touchForce(f(1.5), f(2.5), 0);
  assert.equal(p.forcePasses, 2);
  assert.deepEqual([p.forceX, p.forceY], [3, 5]);
});

test("a force ID counts once a pass, but still sets the counter", () => {
  // The map at +2376 skips a second object with the same ID; the counter is
  // written before the check. [:159679-159687]
  const p = new Player(world(), 1);
  p.touchForce(0, f(4.2), 1);
  p.forcePasses = 0;
  p.touchForce(0, f(4.2), 1);
  assert.equal(p.forcePasses, 2);
  assert.equal(p.forceY, f(4.2));
  p.touchForce(0, f(4.2), 2);
  assert.equal(p.forceY, f(f(4.2) + f(4.2)));
});

test("the vector is held to 9999 long", () => {
  const p = new Player(world(), 1);
  p.touchForce(6000, 8000, 0);
  const k = f(9999 / 10000);
  assert.deepEqual([p.forceX, p.forceY], [f(6000 * k), f(8000 * k)]);
});

test("the push lands in the update after the touch, and the one after that pushes nothing", () => {
  const pushed = airborne("cube", 0);
  const twin = airborne("cube", 0);
  pushed.touchForce(0, f(1.2), 0);
  pushed.update(0.25);
  twin.update(0.25);
  assert.equal(pushed.yVel, quantizeYVelocity(twin.yVel + 0.27000001072883606));
  assert.equal(pushed.forcePasses, 1, "one update off");
  assert.deepEqual([pushed.forceX, pushed.forceY, pushed.forceIds.length], [0, 0, 0], "the vector starts again empty");
  const before = pushed.yVel;
  const twinBefore = twin.yVel;
  pushed.update(0.25);
  twin.update(0.25);
  assert.ok(Math.abs(pushed.yVel - before - (twin.yVel - twinBefore)) < 1e-9, "the second push is empty");
  assert.equal(pushed.forcePasses, 0);
});

test("each mode takes its own share of the push", () => {
  // [PlayerObject::update :161359-161396]
  const cases: [GameMode, boolean, number][] = [
    ["cube", false, 1],
    ["wave", false, 1],
    ["ship", false, f(0.47)],
    ["ufo", false, f(0.58)],
    ["swing", false, f(0.4)],
    ["ball", false, f(0.6)],
    ["spider", false, f(0.6)],
    ["robot", false, f(0.9)],
    ["ship", true, f(f(0.47) / f(0.8))],
    ["ufo", true, f(f(0.58) / f(0.8))],
    ["swing", true, f(f(0.4) / f(0.65))],
    ["robot", true, f(0.9)],
  ];
  for (const [mode, mini, k] of cases) {
    const p = airborne(mode, 0.5);
    p.setMini(mini);
    p.forceY = f(1.5);
    applyForce(p);
    assert.equal(p.yVel, quantizeYVelocity(0.5 + f(f(JUMP_DT * f(1.5)) * k)), `${mini ? "mini " : ""}${mode}`);
  }
});

test("a push lets a flying player past its caps, and one away from the floor feeds the robot's hold", () => {
  const ship = airborne("ship", 0);
  ship.forceY = f(1.5);
  applyForce(ship);
  assert.equal(ship.isAccelerating, true);
  const still = airborne("ship", 0);
  applyForce(still);
  assert.equal(still.isAccelerating, false, "the empty push leaves it alone");

  const v = f(f(JUMP_DT * f(1.4)) * f(0.9));
  const robot = airborne("robot", 0);
  robot.robotHold = 0;
  robot.forceY = f(1.4);
  applyForce(robot);
  assert.equal(robot.robotHold, (v / f(12.94)) * 1.5, "upright, an up push spends the hold");

  const flipped = airborne("robot", 0);
  flipped.flipped = true;
  flipped.robotHold = 1;
  flipped.forceY = f(-1.4);
  applyForce(flipped);
  assert.equal(flipped.robotHold, 1 + (-v / f(12.94)) * 1.5, "upside down, a down push gives it back");

  const down = airborne("robot", 0);
  down.robotHold = 1;
  down.forceY = f(-1.4);
  applyForce(down);
  assert.equal(down.robotHold, 1, "upright, a down push leaves it");
});

test("in a platformer the x part goes onto the x velocity, and a cube pushed sideways spins", () => {
  const p = airborne("cube", 0, { platformer: true });
  p.forceX = f(-1.98046);
  p.forceY = f(3.16965);
  applyForce(p);
  assert.equal(p.xVel, f(f(-1.98046) * JUMP_DT));
  assert.equal(p.spinning, true);
  // The float 0.1 is a little over the double it is compared with. [:161419]
  const gentle = airborne("cube", 0, { platformer: true });
  gentle.forceX = f(0.0999);
  applyForce(gentle);
  assert.equal(gentle.spinning, false, "not more than 0.1");
  const edge = airborne("cube", 0, { platformer: true });
  edge.forceX = f(0.1);
  applyForce(edge);
  assert.equal(edge.spinning, true, "the float 0.1 is");
  const classic = airborne("cube", 0);
  classic.forceX = 5;
  applyForce(classic);
  assert.deepEqual([classic.xVel, classic.spinning], [0, false], "a classic level has no x velocity to push");
});

test("a platformer push slides out at updateMove's own rate, not the ramp's", () => {
  // The push sets +2372. While it is set the x velocity loses 0.05 of itself
  // per 60th of update's 0.9 step with boost slide or a button held (0.2
  // with neither), the button held steers only below the top speed, and
  // under 0.5 the slide is over. The port clamped the push to the top speed
  // while steering and took it off at the ramp's rate otherwise.
  // [gdp PlayerObject::update :161417-161418; updateMove :149234-149236,
  //  :149258-149286, :149433-149455]
  const move = (p: Player) => (p as unknown as { updatePlatformerX(dt: number, dtMove: number): void }).updatePlatformerX(0.25, JUMP_DT);
  const pushed = (over: Partial<PlayerWorld> = {}) => {
    const p = airborne("cube", 0, { platformer: true, ...over });
    p.forceX = 40;
    applyForce(p);
    assert.equal(p.forceSlide, true);
    assert.equal(p.xVel, 9);
    return p;
  };
  const free = pushed();
  move(free);
  assert.equal(free.xVel, 9 + -(f(0.05) * 9) * JUMP_DT, "boost slide: 0.05");
  const decreased = pushed({ boostSlide: false });
  move(decreased);
  assert.equal(decreased.xVel, 9 + -(f(0.2) * 9) * JUMP_DT, "kA45: 0.2 with nothing held");
  const steering = pushed({ boostSlide: false });
  steering.rightHeld = true;
  move(steering);
  assert.equal(steering.xVel, 9 + -(f(0.05) * 9) * JUMP_DT, "0.05 while a button is held, and no clamp to the top speed");
  let steps = 1;
  let before = free.xVel;
  while (free.forceSlide && steps < 2000) {
    before = free.xVel;
    move(free);
    steps++;
  }
  assert.ok(before < 0.5 && before > 0.49, `the slide ends once it is under 0.5, at ${before}`);
  assert.equal(steps, Math.ceil(Math.log(0.5 / 9) / Math.log(1 - f(0.05) * JUMP_DT)) + 1, "the step after the last share over 0.5");
  assert.ok(free.xVel < before, "and the ramp takes over in that step");
  const classic = airborne("cube", 0);
  classic.forceX = 40;
  applyForce(classic);
  assert.equal(classic.forceSlide, false, "only a platformer slides");
});

test("the slide rides in snapshots and the state hash, and a respawn ends it", () => {
  // The checkpoint does not keep +2372, which resetObject clears.
  // [resetObject :153593; saveToCheckpoint :161518-161589]
  const level = buildLevel([{ id: FORCE_BLOCK, x: 300, y: 200, scaleX: 4, scaleY: 4, rotation: 90, props: { 149: "40" } }], makeHeader({ platformer: true }));
  const sim = simOn(level, { x: 300, y: 200, mode: "ship" });
  sim.step(NO_INPUT);
  sim.step(NO_INPUT);
  assert.equal(p1(sim).forceSlide, true, "pushed");
  const moved = sim.snapshot();
  const hash = sim.stateHash();
  p1(sim).forceSlide = false;
  assert.notEqual(sim.stateHash(), hash, "in the hash");
  sim.restore(moved);
  assert.equal(p1(sim).forceSlide, true, "in the snapshot");
  sim.respawnFrom(moved);
  assert.equal(p1(sim).forceSlide, false, "not in a checkpoint");
});

/** A level of nothing but `placed`, and player 1 at (300, 200), its update already run. */
function probe(placed: Placed[], header = makeHeader()): { sim: Sim; p: Player } {
  const sim = simOn(buildLevel(placed, header), { x: 300, y: 200, mode: "ship" });
  const p = p1(sim);
  p.setWorldPosition(300, 200);
  return { sim, p };
}

test("a block pushes along its angle: up at 0°, turned by its rotation, over when flipped", () => {
  // 90° less the rotation, +180° flipped, times π/180 as a float. [:313053-313058]
  const angle = (deg: number) => f(deg * f(Math.PI / 180));
  const cases: [string, Placed, number][] = [
    ["upright", { id: FORCE_BLOCK, x: 300, y: 200, props: { 149: "1.2" } }, angle(90)],
    ["turned 30°", { id: FORCE_BLOCK, x: 300, y: 200, rotation: 30, props: { 149: "1.2" } }, angle(60)],
    ["flipped", { id: FORCE_BLOCK, x: 300, y: 200, flipY: true, props: { 149: "1.2" } }, angle(270)],
  ];
  for (const [what, block, a] of cases) {
    const { sim, p } = probe([block]);
    touch(sim, p, 0);
    assert.deepEqual([p.forceX, p.forceY], [f(f(Math.cos(a)) * f(1.2)), f(f(Math.sin(a)) * f(1.2))], what);
  }
  const { sim, p } = probe([cases[0][1]]);
  touch(sim, p, 0);
  assert.equal(p.forceX, f(f(-4.371138828673793e-8) * f(1.2)), "the float 90° is a hair past π/2: a sliver sideways");
});

test("with key 528 a block pushes away from its centre, and flipped pulls towards it", () => {
  const away = probe([{ id: FORCE_BLOCK, x: 310, y: 200, props: { 149: "2", 528: "1" } }]);
  touch(away.sim, away.p, 0);
  assert.deepEqual([away.p.forceX, away.p.forceY], [f(f(Math.cos(f(Math.PI))) * 2), f(f(Math.sin(f(Math.PI))) * 2)]);
  assert.equal(away.p.forceX, -2);
  const pull = probe([{ id: FORCE_BLOCK, x: 310, y: 200, flipY: true, props: { 149: "2", 528: "1" } }]);
  touch(pull.sim, pull.p, 0);
  assert.deepEqual([pull.p.forceX, pull.p.forceY], [2, 0]);
});

test("with key 529 the strength runs from key 526 to key 527 across the object", () => {
  // Along the push: 526 at the side it points to, 527 at the side it comes
  // from. [:313070-313085]
  const along = (dy: number) => {
    const { sim, p } = probe([{ id: FORCE_BLOCK, x: 300, y: 200, props: { 149: "9", 526: "1", 527: "3", 529: "1" } }]);
    p.setWorldPosition(300, 200 + dy);
    touch(sim, p, 0);
    return p.forceY;
  };
  const s = f(Math.sin(f(90 * f(Math.PI / 180))));
  assert.equal(along(0), f(s * 2), "the centre: halfway");
  assert.equal(along(-7.5), f(s * 2.5), "below, where the push comes from: more");
  assert.equal(along(15), f(s * 1), "the top edge: key 526");
  assert.equal(along(30), f(s * 1), "past it: held at key 526");

  // With key 528 as well, from the rim (526) to the centre (527), over the
  // circle's radius: 15 × 2 here. [:313062-313069, getObjectRadius :174182-174196]
  const { sim, p } = probe([{ id: FORCE_CIRCLE, x: 312, y: 216, scaleX: 2, scaleY: 2, props: { 526: "1", 527: "4", 528: "1", 529: "1" } }]);
  touch(sim, p, 0);
  const t = f(1 - f(20 / 30));
  const strength = f(1 + f(3 * t));
  const a = f(Math.atan2(16, 12) + Math.PI);
  assert.deepEqual([p.forceX, p.forceY], [f(f(Math.cos(a)) * strength), f(f(Math.sin(a)) * strength)]);
});

test("a block turned off the right angles runs its range over half its outer box's side", () => {
  // v8 is half the longer side of getObjectRect, which for an oriented object
  // is the bounding rect of its turned box: 15√2 for a 30 block at 45°, not
  // 15. [:313025-313036; getObjectRect2 :170950-170967, getOuterObjectRect
  // :170928-170934]
  const block: Placed = { id: FORCE_BLOCK, x: 300, y: 200, rotation: 45, props: { 526: "0", 527: "10", 529: "1" } };
  const { sim, p } = probe([block]);
  const o = (sim as unknown as { objs: { cx: Float64Array; cy: Float64Array; x0: Float64Array; x1: Float64Array } }).objs;
  const r = f((o.x1[0] - o.x0[0]) * 0.5);
  assert.ok(Math.abs(r - 15 * Math.SQRT2) < 1e-4, "the outer box");
  // 10 units from the centre on the side the push points to, up and right.
  const a = f(f(90 - 45) * f(Math.PI / 180));
  const cos = f(Math.cos(a));
  const sin = f(Math.sin(a));
  p.setWorldPosition(o.cx[0] + 10 * Math.cos(a), o.cy[0] + 10 * Math.sin(a));
  touch(sim, p, 0);
  const dx = f(f(o.cx[0]) - p.worldX);
  const dy = f(f(o.cy[0] + 90) - (p.worldY + 90));
  const t = f(f(f(f(f(dy * sin) + f(dx * cos)) + r) / r) * 0.5);
  const strength = f(0 + f(10 * t));
  assert.ok(Math.abs(strength - 2.643) < 1e-3, "not the 1.667 half the block's own side gives");
  assert.deepEqual([p.forceX, p.forceY], [f(cos * strength), f(sin * strength)]);
});

test("the pass touches a force circle only where the game's circle test does", () => {
  // A box corner or the player's centre inside the circle, as for a round
  // hazard [playerCircleCollision → objectIntersectsCircle :419752-419758]:
  // the circle's bounding box meeting the player's box is not enough.
  const after = simOn(buildLevel([]), { x: 300, y: 200, mode: "ship" });
  after.step(NO_INPUT);
  const { x, y } = after.state;
  const at = (dx: number, dy: number) => {
    const sim = simOn(buildLevel([{ id: FORCE_CIRCLE, x: x + dx, y: y + dy, props: { 149: "1" } }]), { x: 300, y: 200, mode: "ship" });
    sim.step(NO_INPUT);
    return p1(sim).forcePasses;
  };
  assert.equal(at(28, 28), 0, "boxes overlap, corner 18.4 from the centre");
  assert.equal(at(25, 25), 2, "corner 14.1 from the centre");
});

test("two force blocks with the same force ID push once", () => {
  const blocks = (a: string, b: string) => {
    const sim = simOn(
      buildLevel([
        { id: FORCE_BLOCK, x: 300, y: 200, scaleX: 3, scaleY: 3, props: { 149: "4.2", 530: a } },
        { id: FORCE_BLOCK, x: 300, y: 200, scaleX: 3, scaleY: 3, props: { 149: "4.2", 530: b } },
      ]),
      { x: 300, y: 200, mode: "ship" },
    );
    sim.step(NO_INPUT);
    return p1(sim).forceY;
  };
  assert.equal(blocks("1", "1"), f(4.2));
  assert.equal(blocks("1", "2"), f(f(4.2) + f(4.2)));
  assert.equal(blocks("0", "0"), f(f(4.2) + f(4.2)), "0 is no ID");
});

test("a ship flying through a force block is pushed from its second step", () => {
  const field = () =>
    simOn(buildLevel([{ id: FORCE_BLOCK, x: 300, y: 200, scaleX: 4, scaleY: 4, props: { 149: "1.5" } }]), { x: 300, y: 200, mode: "ship" });
  const sim = field();
  const twin = simOn(buildLevel([]), { x: 300, y: 200, mode: "ship" });
  sim.step(NO_INPUT);
  twin.step(NO_INPUT);
  assert.equal(sim.state.yVel, twin.state.yVel, "the touching pass comes after the first update");
  sim.step(NO_INPUT);
  twin.step(NO_INPUT);
  const v = f(f(JUMP_DT * f(1.5)) * f(0.47));
  assert.equal(sim.state.yVel, quantizeYVelocity(twin.state.yVel + v));
});

test("in rotated gameplay the push is the world's, onto the y velocity, which moves the player along x", () => {
  // The vector is worked out from world positions and angles; the push lands
  // on +1936 whatever the rotation. [:313038-313058, 161076-161081]
  const upright = simOn(buildLevel([{ id: FORCE_BLOCK, x: 300, y: 200, scaleX: 4, scaleY: 4, props: { 149: "1.5" } }]), { x: 300, y: 200, mode: "ship" });
  const turned = simOn(buildLevel([{ id: FORCE_BLOCK, x: 300, y: 200, scaleX: 4, scaleY: 4, props: { 149: "1.5" } }]), { x: 300, y: 200, mode: "ship" });
  p1(turned).rotated = true;
  upright.step(NO_INPUT);
  turned.step(NO_INPUT);
  const a = p1(upright);
  const b = p1(turned);
  assert.equal(b.axesSwapped, false);
  assert.deepEqual([b.forcePasses, b.forceY], [2, f(1.5)], "met in the mirror");
  assert.deepEqual([b.forceX, b.forceY], [a.forceX, a.forceY]);
  // The next update adds the push to the y velocity, which the turned
  // player's step lays along x.
  const twin = simOn(buildLevel([]), { x: 300, y: 200, mode: "ship" });
  p1(twin).rotated = true;
  twin.step(NO_INPUT);
  turned.step(NO_INPUT);
  twin.step(NO_INPUT);
  assert.equal(b.yVel, quantizeYVelocity(p1(twin).yVel + f(f(JUMP_DT * f(1.5)) * f(0.47))));
  assert.ok(b.x > p1(twin).x, "pushed along x");
  assert.equal(b.y, p1(twin).y, "and not along y");
});

test("a pending push is carried by a snapshot and shows in the state hash; a practice respawn drops it", () => {
  const field = (force: string) =>
    simOn(buildLevel([{ id: FORCE_BLOCK, x: 300, y: 200, scaleX: 4, scaleY: 4, props: { 149: force } }]), { x: 300, y: 200, mode: "ship" });
  const sim = field("1.5");
  sim.step(NO_INPUT);
  const snap = sim.snapshot();
  sim.step(NO_INPUT);
  const after = sim.state.yVel;
  sim.restore(snap);
  assert.deepEqual([p1(sim).forcePasses, p1(sim).forceY], [2, f(1.5)]);
  sim.step(NO_INPUT);
  assert.equal(sim.state.yVel, after);

  const idle = simOn(buildLevel([]), { x: 300, y: 200, mode: "ship" });
  const empty = field("0");
  idle.step(NO_INPUT);
  empty.step(NO_INPUT);
  assert.deepEqual([empty.state.x, empty.state.y, empty.state.yVel], [idle.state.x, idle.state.y, idle.state.yVel]);
  assert.notEqual(empty.stateHash(), idle.stateHash(), "a push still to come");

  sim.restore(snap);
  sim.respawnFrom(snap);
  assert.deepEqual([p1(sim).forcePasses, p1(sim).forceX, p1(sim).forceY], [0, 0, 0]);
});

test("a force block is a volume: it never blocks or kills", () => {
  const sim = simOn(buildLevel([{ id: BLOCK, x: 15, y: 15 }, { id: FORCE_BLOCK, x: 60, y: 45, scaleX: 2, props: { 149: "0" } }]));
  for (let i = 0; i < 60; i++) sim.step(NO_INPUT);
  assert.equal(sim.state.dead, false);
  assert.ok(sim.state.x > 90, "straight through");
});
