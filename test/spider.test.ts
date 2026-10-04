// The spider's jump, pinned to spiderTestJumpInternal in the 2.206 decompile:
// where it looks, what it takes, what a hazard in the way does, and what it
// leaves the player with. Dash's box ceiling (block 1198, x 2100-2130) and The
// Challenge's jump at tick 3721 are the two cases this was fixed for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Player } from "../src/physics/player";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { makeSim } from "./helpers";
import { buildLevel, emptyLevel, floor, HOLD, settle, simOn, type Placed } from "./levelKit";

const EPS = 1e-9;
const SPIKE = 8;
const FLOOR_SPIKES = 919;
const DUAL_PORTAL = 286;
const SPIDER_PAD = 3005;

function near(actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

function p1(sim: Sim): Player {
  return sim.state as Player;
}

interface Jump {
  y: number;
  object: number | undefined;
  onGround: boolean;
  onGround2: boolean;
  yVel: number;
  holding: boolean;
}

/**
 * A spider standing on the floor at x 95 (it gets there by settling from
 * x 15 − 17.5), a press, and where the jump put it, read at the jump itself.
 */
function jumpFrom(extra: Placed[], start: { x?: number; y?: number; flipped?: boolean; reversed?: boolean } = {}, ground = true): { sim: Sim; jump: Jump | null } {
  let jump: Jump | null = null;
  const level = ground ? emptyLevel(extra) : buildLevel([...extra, { id: 1, x: 2985, y: 15 }]);
  const sim = makeSim(level, undefined, {
    start: { x: start.x ?? 95, y: start.y ?? 43.5, mode: "spider", flipped: start.flipped ?? false, reversed: start.reversed ?? false },
    onEvent: (e) => {
      if (e.type !== "jump" || jump) return;
      const p = p1(sim);
      jump = { y: p.y, object: e.object, onGround: p.onGround, onGround2: p.onGround2, yVel: p.yVel, holding: p.holding };
    },
  });
  const p = p1(sim);
  p.onGround = true;
  p.onGround2 = true;
  sim.step(HOLD);
  return { sim, jump };
}

test("the spider finds a ceiling that starts ahead of its centre, up to a unit past its box", () => {
  // The strip runs from the centre to the leading edge + 1: 95 .. 109.5. Dash's
  // box ceiling starts 4.62 ahead of the centre there. [spiderTestJumpInternal
  // :154868-154903; the object-ahead test :155110-155125]
  for (const [left, found] of [
    [99.62, true],
    [109, true],
    [110, false],
  ] as const) {
    const { jump } = jumpFrom([{ id: 1, x: left + 15, y: 165 }]);
    assert.ok(jump);
    near(jump.y, found ? 136.5 : 256.5, `block from x ${left}`);
  }
});

test("a reversed spider looks behind its box, not behind its centre", () => {
  // Reversed, the strip is measured back from the box's left edge: 95 − 28 ..
  // 95 − 13.5. A block wholly behind the box is found; one right over the
  // centre is not. [:154881-154890]
  const behind = jumpFrom([{ id: 1, x: 70, y: 165 }], { reversed: true });
  near(behind.jump!.y, 136.5, "block over x 55..85");
  const over = jumpFrom([{ id: 1, x: 105, y: 165 }], { reversed: true });
  near(over.jump!.y, 256.5, "block over x 90..120");
});

test("with nothing in reach the spider goes to the band's far edge", () => {
  // v8 − h/2 in a band; 3,000 units off in free mode. [:154776-154778, 155150-155160]
  near(jumpFrom([]).jump!.y, 256.5, "band ceiling 270");
});

test("a passable block is a surface for the spider", () => {
  // staticObjectsInRect never reads key 134. [:419454-419604]
  const { jump } = jumpFrom([{ id: 1, x: 110, y: 165, props: { 134: "1" } }]);
  near(jump!.y, 136.5, "under the passable block");
});

test("the jump leaves the spider in the air, one unit a tick toward its new floor", () => {
  // flipGravity drops the latch and keeps +2044; setYVelocity(−flipMod); the
  // button is let go. The same step's pass lands it. [:155210-155215]
  const { sim, jump } = jumpFrom([{ id: 1, x: 110, y: 165 }]);
  assert.deepEqual(jump, { y: 136.5, object: sim.level.objects.length - 1, onGround: false, onGround2: true, yVel: 1, holding: false });
  assert.equal(sim.state.onGround, true, "landed by the end of the step");
  near(sim.state.y, 136.5, "on the ceiling");
});

test("a hazard in the way: the spider lands on it and the same step's pass kills it", () => {
  // A spike hanging 16.5 below the landing, in the 8-unit hazard strip: the
  // search goes round again with the wider box, still meets it first, and
  // puts the spider on the spike's own position. [:155171-155200]
  const { sim, jump } = jumpFrom([{ id: 1, x: 110, y: 195 }, { id: SPIKE, x: 95, y: 150, rotation: 180 }]);
  const spike = sim.level.objects.length - 1;
  assert.equal(jump!.y, 150);
  assert.equal(jump!.object, spike);
  assert.equal(sim.state.dead, true);
  assert.equal(sim.state.killedBy, spike);
  assert.equal(sim.tick, 1);
});

test("hazards but no surface in the strip: the search widens and finds the block behind (The Challenge, tick 3721)", () => {
  // A spider on a ceiling at x 133.61 jumps down. The floor block ends 3.61
  // behind its centre, outside the strip 133.61 .. 148.11; a row of floor
  // spikes sits in the hazard strip below the block's top. The wider box,
  // 120.11 .. 151.11, finds the block. [:154929-154934]
  const { sim, jump } = jumpFrom(
    [
      { id: 1, x: 115, y: 15 },
      { id: 1, x: 115, y: 45 },
      { id: FLOOR_SPIKES, x: 145, y: 35 },
      ...floor(90, 180, 195),
    ],
    { x: 133.61, y: 166.5, flipped: true },
    false,
  );
  near(jump!.y, 73.5, "on the block, 13.5 over its top");
  assert.equal(jump!.object, 1);
  assert.equal(sim.state.dead, false);
});

test("a cube or robot on a spider pad reaches 3,000 units, even inside a dual's band", () => {
  // isInBasicMode picks the free reach for cubes and robots, band or not; the
  // next pass's band snap puts them on its ceiling. A ball keeps the band.
  // [spiderTestJumpInternal :154751-154778; isInBasicMode :145589-145598]
  for (const [mode, jumpY] of [
    ["cube", 3000],
    ["robot", 3000],
    ["ball", 255],
  ] as const) {
    const level = buildLevel([{ id: 1, x: 2985, y: 15 }, { id: DUAL_PORTAL, x: 150, y: 45 }, { id: SPIDER_PAD, x: 450, y: 3 }]);
    let at: number | null = null;
    const sim = makeSim(level, undefined, {
      start: { x: 15, y: 15, mode },
      onEvent: (e) => {
        if (e.type === "jump" && e.detail === "spider" && e.player === 1 && at === null) at = p1(sim).y;
      },
    });
    for (let i = 0; i < 400 && at === null; i++) sim.step(NO_INPUT);
    assert.ok(sim.state2, `${mode}: not in the dual`);
    assert.equal(at, jumpY, `${mode}: the jump`);
    sim.step(NO_INPUT);
    assert.equal(sim.state.y, 255, `${mode}: on the band's ceiling a pass later`);
    assert.equal(sim.state.dead, false, `${mode}: alive`);
  }
});

test("the spider jump runs in rotated gameplay's own frame", () => {
  // Rotated, the search runs along x from the player's own frame; nothing in
  // reach sends it 3,000 units off. [:154759-154766]
  const level = emptyLevel([{ id: 2900, x: 60, y: 45, props: { 166: "3", 167: "4" } }]);
  const sim = simOn(level, { y: 43.5 }, "spider");
  for (let i = 0; i < 200 && !p1(sim).rotated; i++) sim.step(NO_INPUT);
  assert.equal(p1(sim).rotated, true, "the trigger never fired");
  settle(sim);
  const x0 = sim.state.x;
  sim.step(HOLD);
  assert.ok(Math.abs(sim.state.x - x0) > 1000, `the jump went along x (from ${x0} to ${sim.state.x})`);
});
