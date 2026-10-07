// Mod menu extras: No Solids, Hitbox Multiplier, and Show Trajectory's
// snapshot/restore prediction.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Player } from "../src/physics/player";
import type { Sim } from "../src/physics/types";
import { NO_INPUT } from "../src/physics/types";
import { emptyLevel, HOLD, settle, simOn, stepN } from "./levelKit";

function p1(sim: Sim): Player {
  return sim.state as Player;
}

test("hitbox multiplier scales the player's outer and inner boxes", () => {
  const sim = simOn(emptyLevel());
  settle(sim);
  const base = sim.playerRect(1).w;
  const baseInner = sim.playerInnerRect(1).w;
  sim.cheats.hitboxScale = 2;
  assert.equal(sim.playerRect(1).w, base * 2);
  assert.equal(sim.playerInnerRect(1).w, baseInner * 2);
  sim.cheats.hitboxScale = 0.5;
  assert.equal(sim.playerRect(1).w, base * 0.5);
});

test("no solids lets the player walk through a block; hazards still kill", () => {
  // A block sitting on the floor in the path. Ground plane still holds; the
  // solid itself is ignored.
  const solid = simOn(emptyLevel([{ id: 1, x: 200, y: 45 }]));
  settle(solid);
  solid.cheats.noSolids = true;
  stepN(solid, NO_INPUT, 200);
  assert.ok(solid.state.x > 200, `expected to pass through block, x=${solid.state.x}`);
  assert.equal(solid.state.dead, false);

  const hazard = simOn(emptyLevel([{ id: 8, x: 200, y: 23 }]));
  settle(hazard);
  hazard.cheats.noSolids = true;
  for (let i = 0; i < 250 && !hazard.state.dead; i++) hazard.step(NO_INPUT);
  assert.equal(hazard.state.dead, true);
});

test("trajectory prediction restores the sim exactly", () => {
  const sim = simOn(emptyLevel());
  settle(sim);
  const beforeTick = sim.tick;
  const startX = sim.state.x;
  const startY = sim.state.y;
  const hash = sim.stateHash();

  const snap = sim.snapshot();
  for (let i = 0; i < 40 && !sim.state.dead; i++) sim.step(HOLD);
  assert.ok(sim.state.y !== startY || sim.state.x !== startX, "hold path should move the player");
  sim.restore(snap);
  for (let i = 0; i < 40 && !sim.state.dead; i++) sim.step(NO_INPUT);
  sim.restore(snap);

  assert.equal(sim.tick, beforeTick);
  assert.equal(p1(sim).x, startX);
  assert.equal(p1(sim).y, startY);
  assert.equal(sim.stateHash(), hash);
});
