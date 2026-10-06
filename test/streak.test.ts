// When the player's streak lays: the sim's side of activateStreak and
// deactivateStreak, which the ribbon (render/trail.ts) follows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLevel, HOLD, simOn, stepN } from "./levelKit";
import { NO_INPUT, STREAK_OFF, STREAK_ON, STREAK_SOFT_OFF, type Sim } from "../src/physics/types";
import type { Player } from "../src/physics/player";

/** Steps until `done`, at most `max` ticks; returns whether it got there. */
function until(sim: Sim, done: () => boolean, max = 400): boolean {
  for (let i = 0; i < max; i++) {
    if (done()) return true;
    sim.step(NO_INPUT);
  }
  return done();
}

test("a cube starts with the streak soft-stopped, and a jump alone does not start it", () => {
  // [gdp resetObject :153629, :153668-153673; updateJump :155852 arms, never starts]
  const sim = simOn(emptyLevel([]));
  assert.equal(sim.state.streak, STREAK_SOFT_OFF);
  stepN(sim, NO_INPUT, 2);
  stepN(sim, HOLD, 1);
  stepN(sim, NO_INPUT, 20);
  assert.equal(sim.state.streak, STREAK_SOFT_OFF);
});

test("a pad starts the streak, and the landing after it stops it softly", () => {
  // [gdp propellPlayer :147686, :147714; hitGround :150191-150197]
  const sim = simOn(emptyLevel([{ id: 35, x: 150, y: 32 }]));
  stepN(sim, NO_INPUT, 2);
  assert.ok(until(sim, () => !sim.state.onGround), "the pad launched it");
  assert.equal(sim.state.streak, STREAK_ON);
  assert.ok(until(sim, () => sim.state.onGround), "it came down");
  assert.equal(sim.state.streak, STREAK_SOFT_OFF);
});

test("an orb starts the streak", () => {
  // [gdp ringJump :160271]
  const sim = simOn(emptyLevel([{ id: 36, x: 150, y: 50 }]));
  let launched = false;
  for (let i = 0; i < 300 && !launched; i++) {
    sim.step(sim.state.x > 130 ? HOLD : NO_INPUT);
    launched = sim.state.streak === STREAK_ON;
  }
  assert.ok(launched);
});

test("a flying start has the streak on; a soft stop does not undo a hard one", () => {
  // [gdp toggleFlyMode :152875; deactivateStreak :147767-147784]
  const ship = simOn(emptyLevel([]), {}, "ship");
  assert.equal(ship.state.streak, STREAK_ON);
  const p = ship.state as unknown as Player;
  p.deactivateStreak(false);
  assert.equal(p.streak, STREAK_SOFT_OFF);
  p.activateStreak();
  p.deactivateStreak(true);
  p.deactivateStreak(false);
  assert.equal(p.streak, STREAK_OFF);
});

test("landing in a flying mode keeps the streak", () => {
  // [gdp hitGround :150191 (isFlying)]
  const ship = simOn(emptyLevel([]), {}, "ship");
  stepN(ship, NO_INPUT, 120);
  assert.ok(ship.state.onGround);
  assert.equal(ship.state.streak, STREAK_ON);
});
