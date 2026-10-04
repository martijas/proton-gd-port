// Pure-physics expectations on hand-built levels: a flat floor of id 1 blocks
// and nothing else, so every number here follows from the constants alone.
// Reference values come from the wiki jump heights reproduced by the 240 Hz
// integration of the decompiled rules (research_physics-web.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Speed } from "../src/level/types";
import type { PlayerInput, Sim } from "../src/physics/types";
import { NO_INPUT } from "../src/physics/types";
import type { Player } from "../src/physics/player";
import { FRAME_DT, xSpeedFor } from "../src/physics/constants";
import { makeSim } from "./helpers";
import { BLOCK, HOLD, buildLevel, emptyLevel, floor, makeHeader, settle, simOn, STANDING_Y, stepN } from "./levelKit";

/** Holds for `holdTicks`, then coasts until the player is back on the ground. */
function jumpArc(sim: Sim, holdTicks: number): { apexBlocks: number; airTicks: number } {
  const y0 = settle(sim);
  let maxY = y0;
  let airTicks = 0;
  let left = false;
  const track = (s: Sim) => {
    airTicks++;
    if (s.state.y > maxY) maxY = s.state.y;
    if (!s.state.onGround) left = true;
  };
  stepN(sim, HOLD, holdTicks, track);
  for (let guard = 0; guard < 2000 && !(left && sim.state.onGround); guard++) stepN(sim, NO_INPUT, 1, track);
  assert.ok(sim.state.onGround, "player never landed");
  return { apexBlocks: (maxY - y0) / BLOCK, airTicks };
}

test("cube tap jump: apex ≈ 2.13 blocks, airtime ≈ 103 ticks", () => {
  const sim = simOn(emptyLevel());
  const { apexBlocks, airTicks } = jumpArc(sim, 1);
  assert.ok(Math.abs(apexBlocks - 2.13) <= 0.05, `apex ${apexBlocks.toFixed(3)} blocks`);
  assert.ok(Math.abs(airTicks - 103) <= 3, `airtime ${airTicks} ticks`);
});

test("mini cube tap jump: apex ≈ 1.36 blocks", () => {
  const sim = simOn(emptyLevel(), { mini: true });
  const { apexBlocks } = jumpArc(sim, 1);
  assert.ok(Math.abs(apexBlocks - 1.36) <= 0.05, `apex ${apexBlocks.toFixed(3)} blocks`);
});

test("cube x advance per tick is 1.29825 at 1x", () => {
  // The step is a float, added to the float x. [PlayerObject::update :161084-161100]
  const sim = simOn(emptyLevel());
  settle(sim);
  const x0 = sim.state.x;
  sim.step(NO_INPUT);
  const dx = sim.state.x - x0;
  assert.ok(Math.abs(dx - 1.29825) < 1e-5, `dx ${dx}`);
  assert.equal(sim.state.x, Math.fround(x0 + Math.fround(xSpeedFor(1) * FRAME_DT)), "matches constants.ts");
});

// Speed portal ids: 200 = 0.5x, 201 = 1x, 202 = 2x, 203 = 3x, 1334 = 4x.
const SPEED_PORTALS: Array<{ id: number; speed: Speed; perTick: number }> = [
  { id: 200, speed: 0, perTick: 1.0465 },
  { id: 202, speed: 2, perTick: 1.61425 },
  { id: 203, speed: 3, perTick: 1.95 },
  { id: 1334, speed: 4, perTick: 2.4 },
];

for (const { id, speed, perTick } of SPEED_PORTALS) {
  test(`speed portal ${id}: x advance per tick is ${perTick}`, () => {
    const sim = simOn(emptyLevel([{ id, x: 400, y: STANDING_Y }]));
    settle(sim);
    for (let guard = 0; guard < 600 && sim.state.x < 470; guard++) stepN(sim, NO_INPUT, 1);
    assert.equal(sim.state.speed, speed, "portal changed the speed index");
    const x0 = sim.state.x;
    sim.step(NO_INPUT);
    const dx = sim.state.x - x0;
    assert.ok(Math.abs(dx - perTick) < 1e-4, `dx ${dx}`);
    assert.equal(sim.state.x, Math.fround(x0 + Math.fround(xSpeedFor(speed) * FRAME_DT)), "matches constants.ts");
  });
}

test("ship: holding caps yVel at 8, releasing at -6.4", () => {
  const sim = simOn(emptyLevel(), {}, "ship");
  settle(sim);
  let maxVel = -Infinity;
  stepN(sim, HOLD, 300, (s) => {
    maxVel = Math.max(maxVel, s.state.yVel);
    assert.ok(s.state.yVel <= 8 + 1e-6, `yVel ${s.state.yVel} while holding at tick ${s.tick}`);
  });
  assert.ok(maxVel > 7, `holding never got near the cap (max ${maxVel.toFixed(2)})`);
  let minVel = Infinity;
  stepN(sim, NO_INPUT, 300, (s) => {
    minVel = Math.min(minVel, s.state.yVel);
    assert.ok(s.state.yVel >= -6.4 - 1e-6, `yVel ${s.state.yVel} while released at tick ${s.tick}`);
  });
  assert.ok(minVel < -6, `releasing never got near the cap (min ${minVel.toFixed(2)})`);
});

for (const mini of [false, true]) {
  test(`wave${mini ? " (mini)" : ""}: dy/dx is exactly ${mini ? 2 : 1}`, () => {
    const sim = simOn(emptyLevel(), { y: 150, mini }, "wave");
    const slope = mini ? 2 : 1;
    // The steps are exact; the positions they are added to are floats, which
    // round x and y (+90) each at its own size. [PlayerObject::update :161052-161100]
    const step = Math.fround(xSpeedFor(1) * FRAME_DT);
    const p = sim.state as Player;
    stepN(sim, HOLD, 8);
    let { x, y } = sim.state;
    sim.step(HOLD);
    assert.equal(p.stepY, slope * step, "up");
    assert.equal(sim.state.x, Math.fround(x + step), "up: x");
    assert.equal(sim.state.y, Math.fround(y + 90 + slope * step) - 90, "up: y");
    stepN(sim, NO_INPUT, 8);
    ({ x, y } = sim.state);
    sim.step(NO_INPUT);
    assert.equal(p.stepY, -slope * step, "down");
    assert.equal(sim.state.y, Math.fround(y + 90 - slope * step) - 90, "down: y");
  });
}

test("swing: a click flips gravity and scales yVel by 0.8", () => {
  const sim = simOn(emptyLevel(), { y: 200 }, "swing");
  stepN(sim, NO_INPUT, 40);
  assert.ok(sim.state.yVel < -1, "swing should be falling before the click");
  assert.equal(sim.state.flipped, false);
  let before = sim.state.yVel;
  let flippedAt: { before: number; after: number } | null = null;
  for (let i = 0; i < 6 && !flippedAt; i++) {
    sim.step(HOLD);
    if (sim.state.flipped) flippedAt = { before, after: sim.state.yVel };
    before = sim.state.yVel;
  }
  assert.ok(flippedAt, "the click never flipped gravity");
  // One tick of (now upward) swing gravity may already be folded into `after`.
  assert.ok(
    Math.abs(flippedAt.after - flippedAt.before * 0.8) < 0.25,
    `yVel ${flippedAt.before.toFixed(3)} → ${flippedAt.after.toFixed(3)} across the flip`,
  );
});

test("robot: holding jumps higher than tapping, never above ~3.4 blocks", () => {
  const tap = jumpArc(simOn(emptyLevel(), {}, "robot"), 1).apexBlocks;
  const hold = jumpArc(simOn(emptyLevel(), {}, "robot"), 200).apexBlocks;
  assert.ok(hold > tap + 0.3, `hold ${hold.toFixed(3)} vs tap ${tap.toFixed(3)}`);
  assert.ok(hold >= 3.0 && hold <= 3.6, `held apex ${hold.toFixed(3)} blocks`);
});

test("cube walking off a ledge dies to the spike two blocks down; a jump clears it", () => {
  // Upper ledge x 0..600 (tops at 90), lower floor from 600 (tops at 30), spike on it at x 675.
  const spikeX = 675;
  const level = buildLevel([...floor(0, 600, 75), ...floor(600, 3000, 15), { id: 8, x: spikeX, y: 45 }]);
  const spikeIndex = level.objects.findIndex((o) => o.id === 8);

  const walker = makeSim(level, undefined, { start: { x: 15, y: 105 } });
  for (let guard = 0; guard < 2000 && !walker.state.dead && walker.state.x < 900; guard++) walker.step(NO_INPUT);
  assert.ok(walker.state.dead, `walker survived to x=${walker.state.x.toFixed(1)}`);
  assert.equal(walker.state.killedBy, spikeIndex, "the spike should be the killer");

  const jumper = makeSim(level, undefined, { start: { x: 15, y: 105 } });
  for (let guard = 0; guard < 2000 && jumper.state.x < 560; guard++) jumper.step(NO_INPUT);
  assert.ok(jumper.state.onGround, "should still be on the ledge at the jump point");
  jumper.step(HOLD);
  for (let guard = 0; guard < 2000 && !jumper.state.dead && jumper.state.x < 900; guard++) jumper.step(NO_INPUT);
  assert.ok(!jumper.state.dead, `jumper died at x=${jumper.state.x.toFixed(1)} (killedBy ${jumper.state.killedBy})`);
});

test("gravity portal halves the vertical velocity (flipGravity mult)", () => {
  // Yellow gravity portal (11) hanging in the air (y 92.5..167.5, out of a walking cube's
  // reach); the cube jumps from x≈355 and enters it about 40 ticks in, still rising.
  const level = emptyLevel([{ id: 11, x: 420, y: 130 }]);
  const sim = simOn(level, { x: 355 });
  settle(sim);
  let before = 0;
  let after = 0;
  let flippedAt = -1;
  sim.step(HOLD);
  for (let guard = 0; guard < 400 && flippedAt < 0; guard++) {
    before = sim.state.yVel;
    sim.step(NO_INPUT);
    if (sim.state.flipped) {
      flippedAt = sim.tick;
      after = sim.state.yVel;
    }
  }
  assert.ok(flippedAt > 0, "the cube never reached the portal");
  assert.ok(before > 1, `expected to enter the portal while rising, yVel ${before.toFixed(2)}`);
  // The same tick also applies gravity once, so allow that much slack.
  assert.ok(Math.abs(after - before * 0.5) < 0.3, `yVel ${before.toFixed(3)} → ${after.toFixed(3)} through the portal`);
});

test("a cube passing high above a slope is not pulled down onto it", () => {
  // 45° slope (289) on the floor; the cube starts 3 blocks above the floor and free-falls past it.
  const level = emptyLevel([{ id: 289, x: 405, y: 45 }]);
  const sim = makeSim(level, undefined, { start: { x: 380, y: 150 } });
  let minYWhileOverSlope = Infinity;
  for (let guard = 0; guard < 60 && sim.state.x < 440; guard++) {
    sim.step(NO_INPUT);
    if (sim.state.x > 390 && sim.state.x < 430) minYWhileOverSlope = Math.min(minYWhileOverSlope, sim.state.y);
  }
  // Free fall from 150 over the ~38 ticks it takes to cross the slope drops ~35 units (y ≈ 115);
  // the old bug snapped the cube onto the slope surface (y ≈ 75) instead.
  assert.ok(minYWhileOverSlope > 100, `cube was snapped down to y=${minYWhileOverSlope.toFixed(1)} over the slope`);
});

test("an orb ignores a held button and answers a fresh click", () => {
  // Yellow orb (36) one jump-height above the floor, reached with the button down.
  const level = emptyLevel([{ id: 36, x: 500, y: 105 }]);

  const fired = (press: (sim: Sim) => PlayerInput): number => {
    let orbs = 0;
    const sim = makeSim(level, undefined, {
      start: { x: 380, y: STANDING_Y },
      onEvent: (e) => {
        if (e.type === "orb") orbs++;
      },
    });
    settle(sim);
    for (let i = 0; i < 300 && !sim.state.dead && sim.state.x < 560; i++) sim.step(press(sim));
    return orbs;
  };

  // Held from the floor: the jump spends the click, so the orb does nothing.
  assert.equal(fired(() => HOLD), 0, "a held button should not fire the orb");
  // Same jump, released in the air, clicked again on the orb.
  assert.equal(
    fired((sim) => (sim.state.x < 420 || (sim.state.x > 488 && sim.state.x < 515) ? HOLD : NO_INPUT)),
    1,
    "clicking on the orb should fire it",
  );
});

test("a second orb needs its own click", () => {
  // Two yellow orbs in a row; the click that fires the first must not fire the second.
  const level = emptyLevel([
    { id: 36, x: 500, y: 105 },
    { id: 36, x: 620, y: 195 },
  ]);
  let orbs = 0;
  const sim = makeSim(level, undefined, {
    start: { x: 380, y: STANDING_Y },
    onEvent: (e) => {
      if (e.type === "orb") orbs++;
    },
  });
  settle(sim);
  for (let i = 0; i < 400 && !sim.state.dead && sim.state.x < 700; i++) {
    sim.step(sim.state.x < 420 || sim.state.x > 488 ? HOLD : NO_INPUT);
  }
  assert.equal(orbs, 1, "holding through the second orb should do nothing");
});

test("running off a slope launches the cube", () => {
  // 45° slope (289) sitting on the floor, with the block under it filled in.
  const level = buildLevel([...floor(0, 3000), { id: 289, x: 405, y: 45 }]);
  const sim = simOn(level, { x: 330 });
  settle(sim);
  let leftSlopeVel = 0;
  let wasOnSlope = false;
  let peak = sim.state.y;
  for (let i = 0; i < 200 && sim.state.x < 520; i++) {
    sim.step(NO_INPUT);
    if (sim.state.onSlope) wasOnSlope = true;
    else if (wasOnSlope && leftSlopeVel === 0) leftSlopeVel = sim.state.yVel;
    peak = Math.max(peak, sim.state.y);
  }
  assert.ok(wasOnSlope, "the cube never rode the slope");
  assert.ok(leftSlopeVel > 4, `slope hand-off velocity ${leftSlopeVel.toFixed(2)} (expected a launch)`);
  assert.ok(peak > 90, `peak height ${peak.toFixed(1)} above the slope top`);
});

// --- the robot's held jump ----------------------------------------------------
// It belongs to a jump off the ground and to nothing else: letting go ends it, a
// pad ends it only with kA34 or in platformer, and only the next ground jump
// hands it back. An orb taken in the air is a plain velocity set, so holding the
// button through one buys no height. Getting this wrong sends the robot several
// blocks too high off every orb.
// [gdp updateJump 155920-155928, releaseButton 159517, ringJump 159830-160400,
//  bumpPlayer 157053-157054]

/** A short robot hop off the floor, released in the air: the ordinary way to reach an orb. */
const HOP_TICKS = 8;
const ARC_TICKS = 45;

/** Where that hop puts the robot ARC_TICKS after letting go. */
function hopPoint(): { x: number; y: number } {
  const sim = simOn(emptyLevel(), {}, "robot");
  settle(sim);
  stepN(sim, HOLD, HOP_TICKS);
  stepN(sim, NO_INPUT, ARC_TICKS);
  return { x: sim.state.x, y: sim.state.y };
}

/**
 * Hops a robot onto `id` placed in its path, then holds or releases. The hop is
 * what makes this worth testing: it leaves the accumulator empty, so the only
 * thing standing between the orb and 60 ticks of free float is the flag the
 * release set. Orbs need a click, so one is sent on the contact tick either
 * way; what differs is what happens next.
 */
function midAirBoost(id: number, holdAfter: boolean): { apexBlocks: number; fired: boolean } {
  const at = hopPoint();
  let fired = false;
  const level = emptyLevel([{ id, x: at.x, y: at.y }]);
  const sim = makeSim(level, undefined, {
    start: { x: 15, y: STANDING_Y, mode: "robot" },
    onEvent: (e) => {
      if (e.type === "orb" || e.type === "pad") fired = true;
    },
  });
  settle(sim);
  stepN(sim, HOLD, HOP_TICKS);
  stepN(sim, NO_INPUT, ARC_TICKS);
  const y0 = sim.state.y;
  let apex = y0;
  sim.step(HOLD);
  for (let i = 0; i < 200 && !sim.state.dead && !sim.state.onGround; i++) {
    sim.step(holdAfter ? HOLD : NO_INPUT);
    apex = Math.max(apex, sim.state.y);
  }
  return { apexBlocks: (apex - y0) / BLOCK, fired };
}

const UPWARD_ORBS: Array<[string, number]> = [
  ["yellow", 36],
  ["pink", 141],
  ["red", 1333],
];

for (const [name, id] of UPWARD_ORBS) {
  test(`robot: a ${name} orb goes the same height held or let go`, () => {
    const held = midAirBoost(id, true);
    const released = midAirBoost(id, false);
    assert.ok(held.fired && released.fired, "the orb never fired");
    assert.ok(
      Math.abs(held.apexBlocks - released.apexBlocks) < 0.01,
      `held ${held.apexBlocks.toFixed(3)} blocks vs let go ${released.apexBlocks.toFixed(3)}`,
    );
  });
}

test("robot: with kA34 a pad ends the held jump even with the button still down", () => {
  // A held robot jump with a pad in its path, never letting go. Before the pad
  // the hold cancels gravity outright; with kA34 the pad has to end that, or
  // the robot sails on at the pad's speed for another quarter of a second.
  // Without kA34 it does sail on — padsorbs.test.ts covers that.
  // [gdp PlayerObject::bumpPlayer, gd-ida-decomp.cpp:157053; +2408 = !kA34 at :430562-430563]
  const probe = simOn(emptyLevel(), {}, "robot");
  settle(probe);
  stepN(probe, HOLD, 42);
  const level = emptyLevel([{ id: 35, x: probe.state.x, y: probe.state.y }], makeHeader({ fixRobotJump: true }));

  let padTick = -1;
  const sim = makeSim(level, undefined, {
    start: { x: 15, y: STANDING_Y, mode: "robot" },
    onEvent: (e) => {
      if (e.type === "pad" && padTick < 0) padTick = e.tick;
    },
  });
  settle(sim);
  // Holding cancels gravity exactly, which is what the pad has to take away.
  stepN(sim, HOLD, 20);
  const before = sim.state.yVel;
  sim.step(HOLD);
  assert.ok(Math.abs(sim.state.yVel - before) < 1e-9, `the hold should cancel gravity, yVel moved ${sim.state.yVel - before}`);

  for (let guard = 0; guard < 40 && padTick < 0; guard++) stepN(sim, HOLD, 1);
  assert.ok(padTick >= 0, "the robot never reached the pad");
  let last = sim.state.yVel;
  for (let i = 0; i < 40; i++) {
    stepN(sim, HOLD, 1);
    assert.ok(sim.state.yVel < last, `yVel held at ${sim.state.yVel.toFixed(4)} ${i} ticks after the pad`);
    last = sim.state.yVel;
  }
});

test("robot: the held jump comes back after landing, and only then", () => {
  const sim = simOn(emptyLevel(), {}, "robot");
  const first = jumpArc(sim, 200).apexBlocks;
  // Same sim, so the second jump starts from a released button and a landing.
  const second = jumpArc(sim, 200).apexBlocks;
  assert.ok(Math.abs(first - second) < 0.01, `first ${first.toFixed(3)} blocks, second ${second.toFixed(3)}`);
  assert.ok(second > 3, `a held robot jump should clear 3 blocks, got ${second.toFixed(3)}`);
});

test("a robot arriving through a portal still gets a full held jump off the ground", () => {
  // Entering robot mode starts the accumulator spent. The jump off the ground
  // is what refills it, so a robot that has just come through a portal must
  // jump exactly as high as one that started the level in robot mode.
  const level = emptyLevel([{ id: 745, x: 480, y: STANDING_Y }]);
  const sim = makeSim(level, undefined, { start: { x: 380, y: STANDING_Y, mode: "cube" } });
  settle(sim);
  for (let guard = 0; guard < 300 && sim.state.mode !== "robot"; guard++) stepN(sim, NO_INPUT, 1);
  assert.equal(sim.state.mode, "robot", "the cube never reached the robot portal");
  const throughPortal = jumpArc(sim, 200).apexBlocks;
  const fromTheStart = jumpArc(simOn(emptyLevel(), {}, "robot"), 200).apexBlocks;
  assert.ok(throughPortal > 3, `a held robot jump should clear 3 blocks, got ${throughPortal.toFixed(3)}`);
  assert.ok(
    Math.abs(throughPortal - fromTheStart) < 0.01,
    `through a portal ${throughPortal.toFixed(3)} blocks vs from the start ${fromTheStart.toFixed(3)}`,
  );
});

test("a pad launches a mini player at four fifths the speed", () => {
  // propellPlayer's factor starts at 0.8 and is only raised to 1 when the
  // player's scale is exactly 1, so a mini player leaves every pad slower —
  // the same fraction a mini jump is weaker by. It was missing here, so a mini
  // cube left a pad a quarter too fast and sailed over whatever it was meant
  // to land on. Clutterfunk's mini section overshot its orb and the autoplayer
  // could not finish the level.
  // [gdp PlayerObject::propellPlayer, gd-ida-decomp.cpp:147679-147690]
  const speeds: Record<string, number> = {};
  for (const mini of [false, true]) {
    // A yellow pad (id 35) directly under the player's standing position.
    const level = emptyLevel([{ id: 35, x: 15, y: 30 }]);
    const sim = makeSim(level, undefined, { start: { x: 15, y: STANDING_Y, mode: "cube", mini } });
    let launched = 0;
    for (let i = 0; i < 240 && launched === 0; i++) {
      sim.step(NO_INPUT);
      if (sim.state.yVel > 1) launched = sim.state.yVel;
    }
    assert.ok(launched > 0, `the ${mini ? "mini" : "full-size"} player should have been launched`);
    speeds[mini ? "mini" : "full"] = launched;
  }
  const ratio = speeds.mini / speeds.full;
  assert.ok(
    Math.abs(ratio - 0.8) < 1e-6,
    `a mini pad launch should be 0.8 of a full-size one, got ${ratio.toFixed(4)} (${speeds.mini} vs ${speeds.full})`,
  );
});
