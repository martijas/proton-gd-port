// Moving blocks: what a block a trigger moves hands the player standing on it.
// [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:151538-151627;
//  PlayerObject::postCollision :159069-159116, 159188-159192]

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyLevel, simOn, stepN } from "./levelKit";
import { NO_INPUT } from "../src/physics/types";

/** The floor in group 5, raised fast by one Move and then slowly by another. */
function elevator(noBoostY = false) {
  const level = emptyLevel([
    // 150 up in 0.25 s: 2.5 a step, a platform speed of 10.
    { id: 901, x: 30, y: 600, props: { 51: "5", 29: "150", 10: "0.25" } },
    // Then 30 up in 0.5 s: 0.25 a step, a speed of 1.
    { id: 901, x: 150, y: 600, props: { 51: "5", 29: "30", 10: "0.5" } },
  ]);
  for (const o of level.objects) {
    if (o.id !== 1) continue;
    o.groups = [5];
    if (noBoostY) o.props[496] = "1";
  }
  return simOn(level);
}

test("a block rising under the player carries it, and launches it when it stops", () => {
  const sim = elevator();
  let carriedAt = -1;
  stepN(sim, NO_INPUT, 60, (s) => {
    if (carriedAt < 0 && s.state.y > 60 && s.state.onGround) carriedAt = s.tick;
  });
  assert.ok(carriedAt > 0, "the rise carries the player up, standing on the floor");
  let launched = 0;
  for (let t = 0; t < 60 && !sim.state.dead; t++) {
    sim.step(NO_INPUT);
    if (sim.state.yVel > launched) launched = sim.state.yVel;
  }
  assert.ok(launched >= 9, `launched at the fast rise's speed, got ${launched}`);
});

test("the fast rise's speed is not kept once the floor slows", () => {
  const sim = elevator();
  stepN(sim, NO_INPUT, 160);
  assert.ok(!sim.state.dead && sim.state.onGround, "back on the slow floor once the launch has played out");
  let fastest = 0;
  for (let t = 0; t < 20; t++) {
    sim.step(NO_INPUT);
    fastest = Math.max(fastest, sim.state.yVel);
  }
  assert.ok(fastest < 2, `no carry from a floor moving at a speed of 1, got ${fastest}`);
});

test("a \"don't boost Y\" block carries the player without launching it", () => {
  const sim = elevator(true);
  stepN(sim, NO_INPUT, 100);
  let fastest = 0;
  for (let t = 0; t < 60 && !sim.state.dead; t++) {
    sim.step(NO_INPUT);
    if (sim.state.yVel > fastest) fastest = sim.state.yVel;
  }
  assert.ok(fastest < 5, `no launch, got ${fastest}`);
});
