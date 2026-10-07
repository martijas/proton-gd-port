import { test } from "node:test";
import assert from "node:assert/strict";
import { Camera } from "../src/render/camera";
import { NO_INPUT, type PlayerInput } from "../src/physics/types";
import { emptyLevel, makeHeader, simOn, stepN } from "./levelKit";

const near = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

/** A pass-by trigger ahead of the start, so the reset does not fire it. */
const ahead = (id: number, props: Record<number, string> = {}) => ({ id, x: 200, y: 300, props });

test("a Gravity trigger sets the player's gravity multiplier", () => {
  // [gdp triggerGravityChange :422792-422818]
  const sim = simOn(emptyLevel([ahead(2066, { 148: "0.5" })]));
  stepN(sim, NO_INPUT, 200);
  near((sim.state as unknown as { gravityMod: number }).gravityMod, 0.5);
});

test("a Gravity trigger below 0.1 is held to 0.1, and above 2 to 2", () => {
  const low = simOn(emptyLevel([ahead(2066, { 148: "0.05" })]));
  stepN(low, NO_INPUT, 200);
  near((low.state as unknown as { gravityMod: number }).gravityMod, 0.1);
  const high = simOn(emptyLevel([ahead(2066, { 148: "9" })]));
  stepN(high, NO_INPUT, 200);
  near((high.state as unknown as { gravityMod: number }).gravityMod, 2);
});

test("a Reverse trigger turns the player around", () => {
  // [gdp reverseDirection :416188-416196 → reversePlayer :148361-148392]
  const sim = simOn(emptyLevel([ahead(1917)]));
  assert.equal(sim.state.reversed, false);
  stepN(sim, NO_INPUT, 200);
  assert.equal(sim.state.reversed, true);
  const x = sim.state.x;
  stepN(sim, NO_INPUT, 10);
  assert.ok(sim.state.x < x, `should travel left, x ${sim.state.x} after ${x}`);
});

test("a Reverse trigger does nothing in a platformer", () => {
  const sim = simOn(emptyLevel([ahead(1917)], makeHeader({ platformer: true })));
  stepN(sim, NO_INPUT, 200);
  assert.equal(sim.state.reversed, false);
});

test("a Player Control Stop Jump clears a held jump until the next press", () => {
  // [gdp activatePlayerControlTrigger :421196-421248]
  const sim = simOn(emptyLevel([ahead(1932, { 540: "1" })]));
  const hold: PlayerInput = { jump: true, left: false, right: false };
  // Reach the trigger while holding, then stay held: the stop must stick.
  stepN(sim, hold, 200);
  assert.equal(sim.state.holding, false, "Stop Jump should have released the hold");
  stepN(sim, hold, 2);
  assert.equal(sim.state.holding, false, "a still-held key must not re-engage");
});

test("a Gameplay Offset trigger moves the lead distance", () => {
  // [gdp updateGameplayOffsetX :430003-430007; updateCamera :449670-449689]
  const sim = simOn(emptyLevel([ahead(2901, { 28: "150", 29: "150" })]));
  stepN(sim, NO_INPUT, 200);
  assert.equal(sim.triggers.camera.gameplayOffsetX, 150);
  assert.equal(sim.triggers.camera.gameplayOffsetY, 150);
  const camera = new Camera();
  camera.setAspect(16, 9);
  // Far enough that the level's left stop does not pin the view.
  camera.reset({ ...sim.state, x: 1000 }, sim.triggers.camera);
  near(camera.centre().x - 1000, 150);
});

test("a Gameplay Offset with key 58 keeps the value in world units across zoom", () => {
  const sim = simOn(emptyLevel([ahead(2901, { 28: "100", 58: "1", 101: "1" })]));
  stepN(sim, NO_INPUT, 200);
  assert.equal(sim.triggers.camera.gameplayOffsetX, 100);
  assert.equal(sim.triggers.camera.gameplayOffsetXRaw, true);
  assert.equal(sim.triggers.camera.gameplayOffsetY, 75, "axis 1 leaves Y alone");
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.reset({ ...sim.state, x: 1000 }, { ...sim.triggers.camera, zoom: 2 });
  near(camera.centre().x - 1000, 100);
});
