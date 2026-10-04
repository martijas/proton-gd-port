import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadLevel } from "../src/level/decode";
import { createSim } from "../src/physics/index";
import { NO_INPUT, type PlayerInput, type Sim } from "../src/physics/types";
import { buildStubObjectTable } from "./stubObjects";
import { LEVELS_DIR as LEVELS } from "../tools/paths";
const HOLD: PlayerInput = { jump: true, left: false, right: false };

async function stereoMadness(): Promise<Sim> {
  const level = await loadLevel(readFileSync(`${LEVELS}/1.txt`, "latin1"));
  return createSim(level, buildStubObjectTable());
}

test("holding nothing walks the cube into the first spike", async () => {
  const sim = await stereoMadness();
  let ticks = 0;
  while (!sim.state.dead && ticks < 5000) {
    sim.step(NO_INPUT);
    ticks++;
  }
  assert.ok(sim.state.dead, "the cube should die");
  const killer = sim.level.objects[sim.state.killedBy ?? -1];
  assert.ok(killer, "killedBy names an object");
  assert.equal(killer.id, 8, `killed by a spike, got id ${killer.id}`);
  // Spike at x = 525 with a 6-wide hitbox: the 30-wide cube touches it at x ≈ 507.
  assert.ok(sim.state.x > 500 && sim.state.x < 512, `died at x = ${sim.state.x.toFixed(2)} (tick ${sim.tick})`);
  assert.equal(sim.state.y, 15, "on the ground when it died");
  console.log(`  first spike: died at x=${sim.state.x.toFixed(2)} tick=${sim.tick} object #${killer.index} id ${killer.id} (${killer.x},${killer.y})`);
});

test("a jump at the right tick clears the first spike", async () => {
  const sim = await stereoMadness();
  // Press when the cube's front edge is ~30 units from the spike.
  const pressAtX = 480;
  let pressed = false;
  let pressTick = -1;
  while (!sim.state.dead && sim.state.x < 900) {
    const hold = !pressed && sim.state.x >= pressAtX && sim.state.onGround;
    if (hold) {
      pressed = true;
      pressTick = sim.tick + 1;
    }
    sim.step(hold ? HOLD : NO_INPUT);
  }
  assert.ok(!sim.state.dead, `died at x = ${sim.state.x.toFixed(2)} after pressing at tick ${pressTick}`);
  assert.ok(sim.state.x >= 900);
  const jumps = sim.events.filter((e) => e.type === "jump");
  assert.equal(jumps.length, 1, "exactly one jump event");
  const lands = sim.events.filter((e) => e.type === "land");
  assert.ok(lands.length >= 2, "landed at the start and after the jump");
  console.log(`  jump at tick ${pressTick}, x=${sim.state.x.toFixed(1)}, landed at tick ${lands[lands.length - 1].tick}`);
  // Keep walking: the half spike at x = 975 must kill.
  while (!sim.state.dead && sim.state.x < 1100) sim.step(NO_INPUT);
  assert.ok(sim.state.dead, "the next spike kills");
  assert.ok(sim.state.x < 1010, `died at ${sim.state.x.toFixed(1)}`);
});

test("cube jump height and airtime match the wiki within tolerance", async () => {
  const sim = await stereoMadness();
  while (!sim.state.onGround) sim.step(NO_INPUT);
  const groundY = sim.state.y;
  sim.step(HOLD);
  const t0 = sim.tick;
  let apex = groundY;
  while (!sim.state.onGround && sim.tick - t0 < 400) {
    sim.step(NO_INPUT);
    if (sim.state.y > apex) apex = sim.state.y;
  }
  const height = (apex - groundY) / 30;
  const airtime = (sim.tick - t0) / 240;
  console.log(`  jump apex ${height.toFixed(3)} blocks, airtime ${airtime.toFixed(3)} s`);
  // Wiki: 2.1333 blocks tap / 2.233 held; decompiled rule without first-tick gravity gives ~2.22.
  assert.ok(height > 2.05 && height < 2.3, `apex ${height}`);
  assert.ok(airtime > 0.38 && airtime < 0.48, `airtime ${airtime}`);
});

test("snapshot / restore reproduces the same trajectory", async () => {
  const sim = await stereoMadness();
  for (let i = 0; i < 300; i++) sim.step(NO_INPUT);
  const snap = sim.snapshot();
  const xs: number[] = [];
  for (let i = 0; i < 200; i++) {
    sim.step(i % 50 === 0 ? HOLD : NO_INPUT);
    xs.push(sim.state.x * 1e6 + sim.state.y);
  }
  sim.restore(snap);
  assert.equal(sim.tick, snap.tick);
  for (let i = 0; i < 200; i++) {
    sim.step(i % 50 === 0 ? HOLD : NO_INPUT);
    assert.equal(sim.state.x * 1e6 + sim.state.y, xs[i], `tick ${i} diverged after restore`);
  }
});

test("10,000 ticks run in well under a second", async () => {
  const sim = await stereoMadness();
  const start = performance.now();
  let n = 0;
  const snap = sim.snapshot();
  while (n < 10000) {
    sim.step(n % 97 < 3 ? HOLD : NO_INPUT);
    n++;
    if (sim.state.dead) sim.restore(snap);
  }
  const ms = performance.now() - start;
  console.log(`  10,000 ticks in ${ms.toFixed(1)} ms`);
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test("throughput: ticks per second over a longer run", async () => {
  const sim = await stereoMadness();
  const snap = sim.snapshot();
  const total = 1_000_000;
  const start = performance.now();
  let n = 0;
  while (n < total) {
    sim.step(n % 89 < 2 ? HOLD : NO_INPUT);
    n++;
    if (sim.state.dead || sim.state.finished) sim.restore(snap);
  }
  const s = (performance.now() - start) / 1000;
  console.log(`  ${(total / s / 1e6).toFixed(2)} M ticks/s`);
  assert.ok(total / s > 200_000, `only ${(total / s).toFixed(0)} ticks/s`);
});
