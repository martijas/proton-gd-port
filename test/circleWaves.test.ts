// The circle waves: when the simulation says the game makes one, what each
// looks like, how it moves, and how it is drawn among the object layer's
// children. Every number is the game's (render/circleWaves.ts cites them).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMode } from "../src/level/types";
import { NO_INPUT, type PlayerInput, type Sim, type SimWave } from "../src/physics/types";
import {
  circleSegments,
  CircleWaves,
  PORTAL_WAVES,
  shownOpacity,
  completeEffectWaves,
  spawnEffectWaves,
  waveAlpha,
  wavesFor,
  waveState,
  type WaveContext,
  type WaveScene,
  type WaveSpec,
} from "../src/render/circleWaves";
import { drawLayerRuns, drawParticleRuns, type CountedRuns } from "../src/render/batchNodes";
import { CHANNEL, type Rgb } from "../src/render/colors";
import { INSTANCE_BYTES, INSTANCE_FLOATS, SHAPE, SHAPE_BYTE } from "../src/engine/gl/spriteBatch";
import { makeSim } from "./helpers";
import { buildLevel, emptyLevel, HOLD, makeHeader, simOn, type Placed } from "./levelKit";

const EPS = 1e-9;
/** For what has been through the float32 instance buffer. */
const F32 = 1e-4;

function near(actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);
}

// --- what the simulation reports ---------------------------------------------------

/** Every wave the steps report, in order, as "cause:variant". */
function run(sim: Sim, steps: number, input: PlayerInput | ((tick: number) => PlayerInput) = NO_INPUT): SimWave[] {
  const out: SimWave[] = [];
  for (let i = 0; i < steps && !sim.state.dead; i++) {
    sim.step(typeof input === "function" ? input(sim.tick) : input);
    out.push(...sim.waves);
  }
  return out;
}

const names = (ws: SimWave[]): string[] => ws.map((w) => (w.variant ? `${w.cause}:${w.variant}` : w.cause));

function on(placed: Placed[], mode: GameMode = "cube", start = {}): Sim {
  return simOn(emptyLevel(placed), start, mode);
}

const SHIP_PORTAL = 13;
const CUBE_PORTAL = 12;
const WAVE_PORTAL = 660;
const GRAVITY_UP = 11;
const MINI_PORTAL = 101;
const FAST_PORTAL = 202;
const YELLOW_PAD = 35;
const SPIDER_PAD = 3005;
const YELLOW_ORB = 36;
const SECRET_COIN = 142;
const SPIKE = 8;
const KEY = 1275;
const SMALL_COIN = 1614;
const ALPHA_TRIGGER = 1007;
const LINKED_TELEPORT = 747;
const MIRROR_ON = 45;
const DUAL_PORTAL = 286;
const SOLO_PORTAL = 287;

const RIGHT: PlayerInput = { jump: false, left: false, right: true };
const LEFT: PlayerInput = { jump: false, left: true, right: false };

/**
 * The plain ground, a dual portal at (150, 45) and whatever else: the dual
 * starts on tick 77 with player 1 on the ground at y 15 and player 2 on the
 * band's ceiling at y 255 (dual.test.ts).
 */
function dualSim(extra: Placed[]): Sim {
  const level = buildLevel([{ id: 1, x: 2985, y: 15 }, { id: DUAL_PORTAL, x: 150, y: 45 }, ...extra], makeHeader());
  return makeSim(level, undefined, { start: { x: 15, y: 15, mode: "cube" } });
}

/** The dual portal's index in a dualSim level. */
const DUAL_INDEX = 1;

test("a mode portal makes its circle only when the mode changes, never for the cube, and not with no effects", () => {
  // [toggleFlyMode :152870-152874 inside the changed-flag guard; the cube
  //  portal has no toggle; key 116 → +900 → the toggle's a3]
  const level = emptyLevel([{ id: SHIP_PORTAL, x: 60, y: 45 }]);
  const ship = run(simOn(level), 40);
  assert.deepEqual(names(ship), ["portal:ship"]);
  assert.equal(ship[0].object, level.objects.length - 1, "on the portal");
  assert.deepEqual([ship[0].x, ship[0].y], [60, 45]);
  assert.deepEqual(names(run(on([{ id: SHIP_PORTAL, x: 60, y: 45 }], "ship"), 40)), [], "already a ship");
  assert.deepEqual(names(run(on([{ id: CUBE_PORTAL, x: 60, y: 45 }], "ship"), 40)), [], "the cube makes none");
  assert.deepEqual(names(run(on([{ id: SHIP_PORTAL, x: 60, y: 45, props: { 116: "1" } }]), 40)), [], "no effects");
  // The wave adds its ring. [toggleDartMode :153049-153078]
  assert.deepEqual(names(run(on([{ id: WAVE_PORTAL, x: 60, y: 45 }]), 40)).slice(0, 2), ["portal:wave", "dart"]);
});

test("a gravity portal's circle needs the gravity to turn, and neither no effects nor hidden", () => {
  // [collisionCheckObjects case 4 :463518-463541 (+900, else +1106);
  //  PlayerObject::flipGravity :151131 (the changed check), :151158-151170]
  assert.deepEqual(names(run(on([{ id: GRAVITY_UP, x: 30, y: 45 }]), 5)), ["portal:gravityUp"]);
  assert.deepEqual(names(run(on([{ id: GRAVITY_UP, x: 30, y: 150 }], "cube", { flipped: true, y: 150 }), 5)), [], "already up");
  assert.deepEqual(names(run(on([{ id: GRAVITY_UP, x: 30, y: 45, props: { 135: "1" } }]), 5)), [], "hidden");
  assert.deepEqual(names(run(on([{ id: GRAVITY_UP, x: 30, y: 45, props: { 116: "1" } }]), 5)), [], "no effects");
});

test("a size portal makes the portal circle and the scale circle", () => {
  // [togglePlayerScale :150487-150499]
  const ws = run(on([{ id: MINI_PORTAL, x: 60, y: 45 }]), 40);
  assert.deepEqual(names(ws), ["portal:mini", "scale:mini"]);
  near(ws[1].size, 0.6, "made at the new size", 1e-6);
});

test("a speed portal rings the first time it fires, by either player", () => {
  // [EffectGameObject::triggerObject :315460-315482 → playShineEffect
  //  :167956-167966 (768, hasBeenActivated)]
  assert.deepEqual(names(run(on([{ id: FAST_PORTAL, x: 60, y: 45 }]), 40)), ["speed:2"]);
  assert.deepEqual(names(run(on([{ id: FAST_PORTAL, x: 60, y: 45, props: { 116: "1" } }]), 40)), [], "no effects");
  assert.deepEqual(names(run(on([{ id: FAST_PORTAL, x: 60, y: 45, props: { 135: "1" } }]), 40)), [], "hidden");
  // Key 99 lets each player fire it: player 2 fires it after player 1, and
  // by then it has been activated.
  const sim = dualSim([{ id: FAST_PORTAL, x: 400, y: 135, scaleY: 6, props: { 99: "1" } }]);
  assert.deepEqual(names(run(sim, 400)), ["dual", "dual", "speed:2"]);
  assert.deepEqual(
    sim.events.filter((e) => e.type === "portal" && e.detail === "speed2").map((e) => e.player),
    [1, 2],
    "both players fired it",
  );
});

test("a pad bounces with its circle; a spider pad's plays whatever its switches, after the dash", () => {
  // [propellPlayer :147695-147696; bumpPlayer :157055-157064]
  assert.deepEqual(names(run(on([{ id: YELLOW_PAD, x: 45, y: 32 }]), 20)), ["bump:yellow"]);
  assert.deepEqual(names(run(on([{ id: YELLOW_PAD, x: 45, y: 32, props: { 116: "1" } }]), 20)), [], "no effects");
  const spider = run(on([{ id: SPIDER_PAD, x: 45, y: 32, props: { 116: "1" } }]), 20);
  assert.deepEqual(names(spider).slice(0, 2), ["spiderDash", "bump:spider"]);
  const dash = spider[0];
  assert.ok(dash.y2 > dash.y + 100, "the dash runs from the floor to the top of the level");
});

test("an orb powers on once as it is touched and makes its circle as it is taken", () => {
  // The first pass touches it (a white ring); the press takes it, and it is
  // not powered on again while the press holds it. [RingObject::powerOnObject
  //  :306767-306787; ringJump :160134-160159]
  const sim = simOn(emptyLevel([{ id: YELLOW_ORB, x: 20, y: 150 }]), { y: 150 });
  assert.deepEqual(names(run(sim, 1)), ["ringPower"]);
  assert.deepEqual(names(run(sim, 1, HOLD)), ["ring:yellow"]);
  assert.deepEqual(names(run(sim, 3, HOLD)), [], "taken: the pass looks at it no more");
  const quiet = simOn(emptyLevel([{ id: YELLOW_ORB, x: 20, y: 150, props: { 116: "1" } }]), { y: 150 });
  assert.deepEqual(names(run(quiet, 2, (t) => (t >= 1 ? HOLD : NO_INPUT))), [], "no effects");
});

test("an orb both players of a dual take makes its circle for the first only", () => {
  // The second finds it activated. [PlayerObject::ringJump :159948-159955
  //  (768, hasBeenActivated, by either player)]
  const sim = dualSim([{ id: YELLOW_ORB, x: 400, y: 135, scaleY: 8 }]);
  const seen: SimWave[] = [];
  for (let i = 0; i < 400 && !seen.some((w) => w.cause === "ringPower"); i++) {
    sim.step(NO_INPUT);
    seen.push(...sim.waves);
  }
  seen.push(...run(sim, 2), ...run(sim, 3, HOLD));
  assert.deepEqual(names(seen), ["dual", "dual", "ringPower", "ring:yellow"]);
  assert.deepEqual(
    sim.events.filter((e) => e.type === "orb").map((e) => e.player),
    [1, 2],
    "both players took it",
  );
});

test("an orb the player stays in powers on once; leaving and coming back powers it again", () => {
  // processStateObjects powers off a ring no pass touched in the step.
  // [GJBaseGameLayer::processStateObjects :421383-421410]
  const sim = simOn(emptyLevel([{ id: YELLOW_ORB, x: 20, y: 150 }]), { y: 150 });
  assert.deepEqual(names(run(sim, 4)), ["ringPower"]);
  // A platformer walks into one, back out of it and in again.
  const walk = simOn(emptyLevel([{ id: YELLOW_ORB, x: 90, y: 45 }], makeHeader({ platformer: true })));
  const steps: number[] = [];
  for (let t = 0; t < 200; t++) {
    walk.step(t < 40 ? RIGHT : t < 100 ? LEFT : RIGHT);
    if (walk.waves.some((w) => w.cause === "ringPower")) steps.push(walk.tick);
  }
  assert.equal(steps.length, 2, `powered on at ${steps.join(", ")}`);
  assert.ok(steps[0] < 100 && steps[1] > 100, "once on the way in, once on the way back");
});

test("a restore powers every ring off, as the game's reset does", () => {
  // [RingObject::resetObject :297985-297988]
  const sim = simOn(emptyLevel([{ id: YELLOW_ORB, x: 20, y: 150 }]), { y: 150 });
  assert.deepEqual(names(run(sim, 1)), ["ringPower"]);
  const inside = sim.snapshot();
  assert.deepEqual(names(run(sim, 1)), [], "still powered on");
  sim.restore(inside);
  assert.deepEqual(names(run(sim, 1)), ["ringPower"], "powered on afresh");
});

test("a coin's circles and the player's death are reported where they happen", () => {
  // [playDestroyObjectAnim :622603-622660; playerDestroyed → playDeathEffect]
  const coin = run(on([{ id: SECRET_COIN, x: 60, y: 45 }]), 40);
  assert.deepEqual(names(coin), ["coin:secret"]);
  near(coin[0].x, 60, "at the coin");
  const dead = on([{ id: SPIKE, x: 60, y: 45 }]);
  const death = run(dead, 60);
  assert.deepEqual(names(death), ["death"]);
  near(death[0].x, dead.state.x, "where the player died");
});

test("the list is emptied by each step and by a restore", () => {
  const sim = on([{ id: SHIP_PORTAL, x: 60, y: 45 }]);
  const before = sim.snapshot();
  const toWave = (): void => {
    for (let i = 0; i < 40 && sim.waves.length === 0; i++) sim.step(NO_INPUT);
    assert.equal(sim.waves.length, 1, "made");
  };
  toWave();
  sim.step(NO_INPUT);
  assert.equal(sim.waves.length, 0, "the next step");
  sim.restore(before);
  toWave();
  sim.restore(before);
  assert.equal(sim.waves.length, 0, "a restore");
});

test("a pickup's circle: none with no effects, hidden, a particle of its own, or for the small coin", () => {
  // [GJBaseGameLayer::destroyObject :463125-463146 (440, +1504);
  //  shouldShowPickupEffects :622099-622100 (+900, +855);
  //  spawnDefaultPickupParticle (not 1614)]
  assert.deepEqual(names(run(on([{ id: KEY, x: 60, y: 45 }]), 40)), ["pickup"]);
  for (const props of [{ 116: "1" }, { 135: "1" }, { 440: "1" }] as Record<number, string>[]) {
    const sim = on([{ id: KEY, x: 60, y: 45, props }]);
    assert.deepEqual(names(run(sim, 40)), [], JSON.stringify(props));
    assert.equal(sim.events.filter((e) => e.type === "collect").length, 1, "still picked up");
  }
  assert.deepEqual(names(run(on([{ id: SMALL_COIN, x: 60, y: 45 }]), 40)), [], "the small coin");
});

test("a pickup or speed portal nobody can see makes no circle: its opacity, from its channel and groups, is 0", () => {
  // An Alpha trigger takes the key's group to 0 before it is picked up. The
  // simulation still reports the pickup; its opacity is the renderer's.
  // [shouldShowPickupEffects :622101-622108; playShineEffect :167956-167966;
  //  GameObject::setOpacity :167614-167646; groupOpacityMod :170161-170181]
  const level = emptyLevel([
    { id: ALPHA_TRIGGER, x: 20, y: 600, props: { 51: "5", 35: "0", 10: "0" } },
    { id: KEY, x: 90, y: 45 },
  ]);
  const key = level.objects.length - 1;
  level.objects[key].groups = [5];
  const sim = simOn(level);
  const ws = run(sim, 60);
  assert.deepEqual(names(ws), ["pickup"]);
  const opacity = shownOpacity(1, level.objects[key].groups, (g) => sim.triggers.groupAlphaOf(g));
  assert.equal(opacity, 0, "its group at 0");
  assert.deepEqual(wavesFor(ws[0], context({ spriteOpacity: (_, detail) => (detail ? -1 : opacity) })), [], "none drawn");
  assert.equal(wavesFor(ws[0], context({ spriteOpacity: (_, detail) => (detail ? 40 : 0) })).length, 1, "its colour sprite still shows");
  assert.deepEqual(wavesFor(wave("speed", "1"), context({ spriteOpacity: () => 0 })), [], "a speed portal at 0");
  // The channel's opacity as a byte (over 249 whole, else times 0.004), the
  // groups' product, truncated; the product gives up at 0.
  assert.equal(shownOpacity(1, [], () => 0), 255, "no groups");
  assert.equal(shownOpacity(0.5, [], () => 1), 129);
  assert.equal(shownOpacity(1, [1], () => 0.1), 25);
  assert.equal(shownOpacity(1, [1, 2], () => 0.05), 0, "0.0025 of 255 truncates to 0");
});

test("a teleport's two circles need effects; a linked one's second is on its exit", () => {
  // [GJBaseGameLayer::teleportPlayer :462376-462426 (+900)]
  const ws = run(on([{ id: LINKED_TELEPORT, x: 120, y: 75, props: { 54: "150" } }]), 150);
  assert.deepEqual(names(ws), ["portal:teleportIn", "portal:teleportOut"]);
  assert.deepEqual([ws[0].exit, ws[1].exit], [false, true]);
  assert.deepEqual(names(run(on([{ id: LINKED_TELEPORT, x: 120, y: 75, props: { 54: "150", 116: "1" } }]), 150)), [], "no effects");
});

test("a mirror portal makes its circle only when the view turns", () => {
  // [GJBaseGameLayer::toggleFlipped :449100-449101 (the changed check)]
  assert.deepEqual(names(run(on([{ id: MIRROR_ON, x: 60, y: 45 }, { id: MIRROR_ON, x: 200, y: 45 }]), 200)), ["portal:mirrorOn"]);
});

test("inside a dual a mode portal's circles follow the dual portal's switch", () => {
  // [processCameraObject :420092-420100 (+848, the dual portal) → the
  //  toggles' a3]
  const ship = { id: SHIP_PORTAL, x: 400, y: 135, scaleY: 3 };
  assert.deepEqual(names(run(dualSim([ship]), 400)), ["dual", "dual", "portal:ship", "portal:ship"]);
  const quiet = buildLevel([{ id: 1, x: 2985, y: 15 }, { id: DUAL_PORTAL, x: 150, y: 45, props: { 116: "1" } }, ship], makeHeader());
  assert.deepEqual(names(run(makeSim(quiet, undefined, { start: { x: 15, y: 15, mode: "cube" } }), 400)), ["dual", "dual"]);
});

test("a dual's leaving player rings as the other dies", () => {
  // [PlayLayer::destroyPlayer :93191-93197 → playExitDualEffect]
  const sim = dualSim([{ id: SPIKE, x: 400, y: 15 }]);
  const ws = run(sim, 400);
  assert.deepEqual(names(ws), ["dual", "dual", "death", "exitDual"]);
  const [death, exit] = ws.slice(2);
  assert.deepEqual([death.player, exit.player], [1, 2]);
  near(exit.y, 255, "where player 2 was");
});

test("at a solo portal the player that did not take it rings, then player 1's circle is on what it last met", () => {
  // [GJBaseGameLayer::toggleDualMode :462671-462690; spawnPortalCircle on
  //  player 1's +2116]
  const low = dualSim([{ id: SOLO_PORTAL, x: 400, y: 15 }]);
  const ws = run(low, 400);
  assert.deepEqual(names(ws), ["dual", "dual", "exitDual", "portal:solo"]);
  assert.deepEqual([ws[2].player, ws[3].object], [2, 2], "player 2 leaves; the circle is on the portal player 1 took");
  near(ws[2].y, 255, "where player 2 was");
  // Player 2 takes it: player 1 leaves from where it was, and its circle is
  // on the dual portal, the last thing player 1 met.
  const high = dualSim([{ id: SOLO_PORTAL, x: 400, y: 255 }]);
  const hs = run(high, 400);
  assert.deepEqual(names(hs), ["dual", "dual", "exitDual", "portal:solo"]);
  assert.equal(hs[2].player, 1);
  near(hs[2].y, 15, "player 1 on the ground, before it takes player 2's place");
  assert.equal(hs[3].object, DUAL_INDEX);
  assert.ok(high.state.y > 200, "player 1 then took player 2's place");
});

test("a mirror portal player 2 takes turns both players, its circle on what player 1 last met", () => {
  // [GJBaseGameLayer::toggleFlipped :449100-449126 (+860, the layer's;
  //  the circle on +549)]
  const sim = dualSim([{ id: MIRROR_ON, x: 400, y: 255 }]);
  const ws = run(sim, 300);
  assert.deepEqual(names(ws), ["dual", "dual", "portal:mirrorOn"]);
  assert.deepEqual([ws[2].player, ws[2].object], [1, DUAL_INDEX]);
  assert.ok(sim.state.mirrored && sim.state2?.mirrored, "both mirrored");
});

test("a gravity portal in a linked dual turns both, each circle on what that player last met", () => {
  // Player 2 met the dual portal as it spawned inside it. [GJBaseGameLayer::
  //  flipGravity :420149-420176; PlayerObject::flipGravity :151159-151175]
  const sim = dualSim([{ id: GRAVITY_UP, x: 400, y: 15 }]);
  const ws = run(sim, 300);
  assert.deepEqual(names(ws), ["dual", "dual", "portal:gravityUp", "portal:gravityDown"]);
  assert.deepEqual(ws.slice(2).map((w) => [w.player, w.object]), [
    [1, 2],
    [2, DUAL_INDEX],
  ]);
  const hidden = dualSim([{ id: GRAVITY_UP, x: 400, y: 15, props: { 135: "1" } }]);
  assert.deepEqual(names(run(hidden, 300)), ["dual", "dual"], "the portal's switch is both players'");
});

test("a reset forgets what the players met; a checkpoint's dual has player 1 back on its portal", () => {
  // [PlayerObject::resetObject :153636-153637; PlayLayer::loadFromCheckpoint
  //  :105568-105573 → enterDualMode :420939-420958]
  const sim = dualSim([{ id: SOLO_PORTAL, x: 400, y: 255 }]);
  for (let i = 0; i < 150; i++) sim.step(NO_INPUT);
  assert.ok(sim.state2, "in the dual, past its portal");
  const mid = sim.snapshot();
  sim.restore(mid);
  assert.deepEqual(names(run(sim, 300)), ["exitDual"], "player 1 has met nothing: no solo circle");
  sim.respawnFrom(mid);
  const ws = run(sim, 300);
  assert.deepEqual(names(ws), ["exitDual", "portal:solo"]);
  assert.equal(ws[1].object, DUAL_INDEX);
});

// --- what each one looks like -------------------------------------------------------

const RED: Rgb = { r: 255, g: 0, b: 0 };
const GREEN: Rgb = { r: 0, g: 255, b: 0 };

function context(over: Partial<WaveContext> = {}): WaveContext {
  return {
    performanceMode: false,
    playerColour: (which, slot) => (which === slot ? RED : GREEN),
    channelColour: (id) => (id === CHANNEL.LIGHT_BG ? { r: 1, g: 2, b: 3 } : RED),
    objectColour: () => ({ r: 9, g: 8, b: 7 }),
    objectPosition: () => [100, 50],
    objectBatchZ: () => -460,
    linkedExitOffset: () => [-10, 40],
    playerShown: () => true,
    spriteOpacity: () => 255,
    toScreen: (x, y) => [x * 2, y * 2],
    ...over,
  };
}

function wave(cause: SimWave["cause"], variant = "", over: Partial<SimWave> = {}): SimWave {
  return { cause, player: 1, object: 3, exit: false, variant, x: 100, y: 50, x2: 100, y2: 50, size: 1, ...over };
}

test("an orb's circle shrinks into it in its type's colour, the black orb's in the light background's", () => {
  const [yellow] = wavesFor(wave("ring", "yellow"), context());
  assert.deepEqual([yellow.spec.from, yellow.spec.to, yellow.spec.duration, yellow.spec.fadeIn], [35, 5, 0.35, true]);
  assert.deepEqual(yellow.spec.colour, { r: 255, g: 200, b: 0 });
  assert.deepEqual(yellow.follow, { kind: "object", index: 3, dx: 0, dy: 0 });
  assert.equal(wavesFor(wave("ring", "red"), context())[0].spec.from, 42);
  assert.deepEqual(wavesFor(wave("ring", "black"), context())[0].spec.colour, { r: 1, g: 2, b: 3 });
  assert.deepEqual(wavesFor(wave("ring", "toggle"), context())[0].spec.colour, { r: 9, g: 8, b: 7 }, "the orb's own colour");
  const [touch] = wavesFor(wave("ringPower"), context());
  assert.deepEqual([touch.spec.from, touch.spec.to, touch.spec.outline, touch.spec.easeOut], [5, 55, true, true]);
});

test("a pad's circle starts at 10, or 12 for a full-size player on a red pad", () => {
  assert.equal(wavesFor(wave("bump", "red"), context())[0].spec.from, 12);
  assert.equal(wavesFor(wave("bump", "red", { size: 0.6 }), context())[0].spec.from, 10);
  assert.deepEqual(wavesFor(wave("bump", "red"), context())[0].spec.colour, { r: 255, g: 200, b: 0 }, "the yellow pad's colour");
  assert.deepEqual(wavesFor(wave("bump", "blue"), context())[0].spec.colour, { r: 0, g: 255, b: 255 });
});

test("portal circles: 50 for a mode, 45 for gravity and size; a linked exit stands beside its portal", () => {
  assert.equal(PORTAL_WAVES.ship.radius, 50);
  assert.equal(PORTAL_WAVES.gravityUp.radius, 45);
  assert.equal(PORTAL_WAVES.mini.radius, 45);
  const [out] = wavesFor(wave("portal", "teleportOut", { exit: true }), context());
  assert.deepEqual([out.x, out.y], [90, 90]);
  assert.deepEqual(out.follow, { kind: "object", index: 3, dx: -10, dy: 40 });
  assert.deepEqual(wavesFor(wave("portal", "nothing"), context()), []);
});

test("the speed portal's ring sits just under its batch, 6 pixels wide", () => {
  const [ring] = wavesFor(wave("speed", "4"), context());
  assert.deepEqual([ring.spec.to, ring.spec.lineWidth, ring.spec.z, ring.spec.outline], [90, 6, -461, true]);
  assert.deepEqual(ring.spec.colour, { r: 255, g: 50, b: 50 });
});

test("a spider's dash: three circles in colour 2, moved the way it travels", () => {
  const ws = wavesFor(wave("spiderDash", "", { x: 0, y: 0, x2: 0, y2: 200, size: 1 }), context());
  assert.deepEqual(
    ws.map((w) => [w.x, w.y, w.spec.from, w.spec.to, w.spec.opacityMod, w.spec.outline]),
    [
      [7.5, 0, 13, 1, 0.42, false],
      [13.5, 200, 26, 2, 0.84, false],
      [13.5, 200, 10, 45, 1, true],
    ],
  );
  assert.deepEqual(ws[0].spec.colour, GREEN, "colour 2");
  const back = wavesFor(wave("spiderDash", "reversed", { x: 0, y: 0, x2: 0, y2: 200 }), context());
  assert.deepEqual([back[0].x, back[1].x], [-7.5, -1.5]);
  assert.deepEqual(wavesFor(wave("spiderDash"), context({ playerShown: () => false })), [], "hidden player");
});

test("player 2's circles wear its own colour 1", () => {
  const ctx = context();
  assert.deepEqual(wavesFor(wave("dual", "", { player: 2 }), ctx)[0].spec.colour, ctx.playerColour(2, 1));
  assert.deepEqual(wavesFor(wave("dual", "", { player: 2 }), ctx)[0].follow, { kind: "player", which: 2 });
});

test("the exit dual's ring is the game layer's, on the screen, following the ghost as it slides away", () => {
  const [r] = wavesFor(wave("exitDual", "", { player: 2 }), context());
  assert.deepEqual([r.spec.from, r.spec.to, r.spec.duration, r.spec.fadeIn, r.spec.easeOut, r.spec.outline, r.spec.lineWidth], [10, 30, 0.4, false, true, true, 2]);
  assert.deepEqual([r.spec.layer, r.spec.z], ["game", 0]);
  assert.deepEqual(r.spec.colour, context().playerColour(2, 1));
  assert.deepEqual([r.x, r.y], [200, 100], "on the screen");
  assert.equal(r.follow.kind, "ghost");
  if (r.follow.kind === "ghost") {
    near(r.follow.dx, -124.63203430175781, "slides left");
    assert.deepEqual([r.follow.dy, r.follow.duration], [0, 0.4]);
  }
  const [m] = wavesFor(wave("exitDual", "mirrored"), context());
  assert.deepEqual([m.x, m.y], [500, 100], "150 to the right in a mirrored view");
  if (m.follow.kind === "ghost") near(m.follow.dx, 124.63203430175781, "slides right");
});

test("the death circle grows from the player at z 99, a full-size player counting as 0.9", () => {
  const [d] = wavesFor(wave("death"), context());
  near(d.spec.from, 9, "from", 1e-12);
  near(d.spec.to, 81, "to", 1e-12);
  assert.deepEqual([d.spec.duration, d.spec.easeOut, d.spec.z], [0.5, true, 99]);
  assert.deepEqual(wavesFor(wave("death"), context({ playerShown: () => false })), []);
});

test("Low Detail Mode leaves out the circles the game gates on it, and only those", () => {
  const low = context({ performanceMode: true });
  for (const [cause, variant] of [["ring", "yellow"], ["ringPower", ""], ["bump", "yellow"], ["portal", "ship"], ["scale", "mini"], ["dual", ""], ["spiderDash", ""]] as const) {
    assert.deepEqual(wavesFor(wave(cause, variant), low), [], cause);
  }
  for (const [cause, variant] of [["dart", ""], ["speed", "1"], ["pickup", ""], ["coin", "user"], ["death", ""], ["exitDual", ""]] as const) {
    assert.ok(wavesFor(wave(cause, variant), low).length > 0, cause);
  }
  assert.deepEqual(spawnEffectWaves(1, 0, 0, low), []);
});

test("the spawn effect is four rings a tenth of a second apart, on the player", () => {
  const ws = spawnEffectWaves(2, 5, 6, context());
  assert.deepEqual(ws.map((w) => w.spec.delay), [0, 0.1, 0.2, 0.30000000000000004]);
  assert.ok(ws.every((w) => w.spec.scheduled && w.spec.outline && w.spec.from === 70 && w.spec.to === 2));
  assert.deepEqual(ws[0].follow, { kind: "player", which: 2 });
});

test("level-complete circles: three rings at the end and three discs per player", () => {
  const ws = completeEffectWaves(400, 100, [{ which: 1, x: 390, y: 95 }], context());
  assert.equal(ws.length, 6);
  assert.deepEqual(
    ws.slice(0, 3).map((w) => [w.spec.from, w.spec.to, w.spec.duration, w.spec.outline, w.spec.lineWidth, w.x, w.y]),
    [
      [10, 250, 0.5, true, 4, 400, 100],
      [10, 250, 0.8, true, 4, 400, 100],
      [10, 250, 0.8, true, 4, 400, 100],
    ],
  );
  assert.equal(ws[0].spec.fadeIn, true);
  assert.deepEqual(
    ws.slice(3).map((w) => [w.spec.from, w.spec.to, w.spec.duration, w.spec.opacityMod, w.follow]),
    [
      [20, 80, 0.72, 1, { kind: "player", which: 1 }],
      [30, 50, 0.84, 0.7, { kind: "player", which: 1 }],
      [30, 20, 0.96, 0.7, { kind: "player", which: 1 }],
    ],
  );
  assert.equal(completeEffectWaves(0, 0, [{ which: 1, x: 0, y: 0 }, { which: 2, x: 1, y: 1 }], context()).length, 9);
});

// --- how one moves -----------------------------------------------------------------

function specOf(over: Partial<WaveSpec>): WaveSpec {
  return { from: 10, to: 50, duration: 0.4, fadeIn: false, easeOut: false, colour: RED, outline: false, lineWidth: 2, opacityMod: 1, z: 0, layer: "object", scheduled: false, delay: 0, ...over };
}

test("tweens: straight, eased out on the square root of the time, or fading in and out", () => {
  // [CCCircleWave::init :59966-60030; CCEaseOut rate 2]
  const plain = specOf({});
  assert.deepEqual(waveState(plain, 0), { radius: 10, opacity: 255 });
  assert.deepEqual(waveState(plain, 0.1), { radius: 20, opacity: 191.25 });
  assert.deepEqual(waveState(plain, 0.4), { radius: 50, opacity: 0 });
  const eased = specOf({ easeOut: true });
  near(waveState(eased, 0.1).radius, 10 + 40 * 0.5, "eased radius at a quarter");
  near(waveState(eased, 0.1).opacity, 127.5, "eased opacity at a quarter");
  const fade = specOf({ fadeIn: true, easeOut: true });
  assert.deepEqual(waveState(fade, 0), { radius: 10, opacity: 0 });
  assert.deepEqual(waveState(fade, 0.1), { radius: 20, opacity: 127.5 });
  assert.deepEqual(waveState(fade, 0.2), { radius: 30, opacity: 255 });
  near(waveState(fade, 0.3).radius, 40, "radius at three quarters");
  near(waveState(fade, 0.3).opacity, 127.5, "opacity at three quarters", 1e-9);
});

test("sides by radius, and the alpha byte held and truncated", () => {
  // [CCCircleWave::draw :59700-59738]
  assert.deepEqual([9.9, 10, 19.9, 20, 39.9, 40, 199, 200].map(circleSegments), [10, 15, 15, 20, 20, 30, 30, 50]);
  assert.equal(waveAlpha(254.9, 1), 254);
  assert.equal(waveAlpha(300, 1), 255);
  assert.equal(waveAlpha(-1, 1), 0);
  assert.equal(waveAlpha(255, 0.42), 107);
});

const QUAD = { u0: 0.5, v0: 0.25, du: 0.1, dv: 0.2, unit: 13, w: 1, h: 1 };

function scene(over: Partial<WaveScene> = {}): WaveScene {
  return {
    objectPosition: () => [0, 0],
    playerPosition: () => ({ x: 0, y: 0 }),
    screenToLevel: (sx, sy, out) => {
      out[0] = sx;
      out[1] = sy;
    },
    zoom: 1,
    unitsPerPixel: 0.5,
    view: { x0: -1000, y0: -1000, x1: 1000, y1: 1000 },
    ...over,
  };
}

test("a circle made in a tick holds still for two frames, then moves, and is gone when done", () => {
  const waves = new CircleWaves();
  waves.add({ spec: specOf({ duration: 0.045 }), x: 0, y: 0, follow: { kind: "none" } });
  const radiusNow = (): number => {
    waves.build(QUAD, scene());
    const d = waves.buffer;
    // The first triangle's first corner is the circle's first point, (r, 0).
    return d[4] - d[0] + d[2];
  };
  near(radiusNow(), 10, "as made", F32);
  waves.update(0.01);
  near(radiusNow(), 10, "the frame it was made in", F32);
  waves.update(0.01);
  near(radiusNow(), 10, "the first step moves nothing", F32);
  waves.update(0.01);
  near(radiusNow(), 10 + (40 * 0.01) / 0.045, "then it moves", F32);
  waves.update(0);
  near(radiusNow(), 10 + (40 * 0.01) / 0.045, "a frozen frame moves nothing", F32);
  for (let i = 0; i < 3; i++) waves.update(0.01);
  assert.equal(waves.size, 1);
  waves.update(0.01);
  assert.equal(waves.size, 0, "done after its duration");
});

test("a scheduled circle waits its delay before it is made", () => {
  const waves = new CircleWaves();
  waves.add({ spec: specOf({ scheduled: true, delay: 0.1 }), x: 0, y: 0, follow: { kind: "none" } });
  assert.equal(waves.build(QUAD, scene()), 0, "not made yet");
  for (let i = 0; i < 4; i++) waves.update(0.03);
  assert.equal(waves.build(QUAD, scene()), 0, "the delay's first step moves nothing");
  waves.update(0.03);
  assert.ok(waves.build(QUAD, scene()) > 0, "made");
});

/** The corners an instance makes, as the sprite shader puts them. */
function corners(d: Float32Array, b: Uint8Array, i: number): [number, number][] {
  const f = i * INSTANCE_FLOATS;
  const tri = b[i * INSTANCE_BYTES + SHAPE_BYTE] === SHAPE.TRIANGLE;
  const out: [number, number][] = [];
  for (let id = 0; id < 4; id++) {
    const k = tri && id === 3 ? 2 : id;
    const ux = (k & 1) * 2 - 1;
    const uy = 1 - (k >> 1) * 2;
    out.push([d[f] * ux + d[f + 2] * uy + d[f + 4], d[f + 1] * ux + d[f + 3] * uy + d[f + 5]]);
  }
  return out;
}

test("a disc is the polygon's fan of triangles; a ring is a band per side, its line in pixels", () => {
  const waves = new CircleWaves();
  waves.add({ spec: specOf({ from: 30, to: 30 }), x: 100, y: 0, follow: { kind: "none" } });
  const n = waves.build(QUAD, scene());
  assert.equal(n, circleSegments(30) - 2);
  const d = waves.buffer;
  const b = new Uint8Array(d.buffer);
  const first = corners(d, b, 0);
  near(first[0][0], 130, "the fan's pivot is the first point", F32);
  near(first[0][1], 0, "the fan's pivot is the first point", F32);
  near(first[3][0], first[2][0], "the fourth corner folds onto the third", F32);
  assert.equal(b[46], 1, "ADD");
  near(d[6], 0.55, "the square's middle", 1e-6);
  assert.equal(d[8], 0);
  // Every triangle's corners are on the circle.
  for (let i = 0; i < n; i++) for (const [x, y] of corners(d, b, i).slice(0, 3)) near(Math.hypot(x - 100, y), 30, `triangle ${i}`, 1e-4);

  const ring = new CircleWaves();
  ring.add({ spec: specOf({ from: 30, to: 30, outline: true, lineWidth: 4 }), x: 0, y: 0, follow: { kind: "none" } });
  const m = ring.build(QUAD, scene({ unitsPerPixel: 0.5 }));
  assert.equal(m, circleSegments(30));
  const rd = ring.buffer;
  const rb = new Uint8Array(rd.buffer);
  const c = corners(rd, rb, 0);
  near(Math.hypot(c[0][0] - c[2][0], c[0][1] - c[2][1]), 2, "4 pixels at half a unit each", 1e-5);
  assert.equal(rb[SHAPE_BYTE], SHAPE.QUAD);
});

test("a game-layer circle comes after the object layer's runs, in screen units, on its ghost's slide", () => {
  const waves = new CircleWaves();
  // The game layer's first: still drawn after the object layer's.
  waves.add({ spec: specOf({ from: 30, to: 30, layer: "game" }), x: 10, y: 20, follow: { kind: "ghost", dx: -100, dy: 0, duration: 0.4 } });
  waves.add({ spec: specOf({ from: 30, to: 30 }), x: 0, y: 0, follow: { kind: "none" } });
  // Screen (sx, sy) is level (sx + 1000, sy) at a zoom of 2.
  const at = scene({
    zoom: 2,
    screenToLevel: (sx, sy, out) => {
      out[0] = sx + 1000;
      out[1] = sy;
    },
    view: { x0: -2000, y0: -2000, x1: 2000, y1: 2000 },
  });
  const disc = circleSegments(30) - 2;
  assert.equal(waves.build(QUAD, at), 2 * disc);
  assert.deepEqual([waves.runs, waves.runCount[0], waves.gameStart, waves.gameCount], [1, disc, disc, disc]);
  const d = waves.buffer;
  const b = new Uint8Array(d.buffer);
  const first = (): [number, number] => corners(d, b, waves.gameStart)[0];
  near(first()[0], 1010 + 15, "on the screen, its radius halved by the zoom", F32);
  near(first()[1], 20, "on the screen", F32);
  for (let i = 0; i < 2; i++) waves.update(0.1);
  waves.build(QUAD, at);
  near(first()[0], 1010 + 15, "the ghost waits as the circle does", F32);
  waves.update(0.1);
  waves.build(QUAD, at);
  near(first()[0], 1010 - 25 + 15, "a quarter of the way", F32);
  waves.clearBuild();
  assert.deepEqual([waves.instances, waves.gameCount, waves.runs], [0, 0, 0], "a frame that draws none");
});

test("circles follow what they were made on, and are ordered by z then by arrival", () => {
  const waves = new CircleWaves();
  waves.add({ spec: specOf({ z: 99 }), x: 0, y: 0, follow: { kind: "player", which: 1 } });
  waves.add({ spec: specOf({}), x: 5, y: 5, follow: { kind: "object", index: 7, dx: 1, dy: 2 } });
  waves.build(QUAD, scene({ objectPosition: () => [40, 50], playerPosition: () => ({ x: -300, y: 0 }) }));
  assert.deepEqual(Array.from(waves.runZ.slice(0, waves.runs)), [0, 99]);
  const d = waves.buffer;
  const b = new Uint8Array(d.buffer);
  near(corners(d, b, 0)[0][0], 41 + 10, "on the object, at its offset, radius 10", F32);
  const last = waves.instances - 1;
  near(corners(d, b, last)[0][0], -300 + 10, "on the player", F32);
});

// --- among the particle systems ------------------------------------------------------

function runsOf(z: number[], counts: number[]): CountedRuns & { data: Float32Array } {
  let total = 0;
  const runStart = new Int32Array(z.length);
  counts.forEach((c, i) => {
    runStart[i] = total;
    total += c;
  });
  const data = new Float32Array(total * INSTANCE_FLOATS);
  // Each instance's first float names it: run index × 100 + its place.
  let at = 0;
  counts.forEach((c, i) => {
    for (let k = 0; k < c; k++) data[(at + k) * INSTANCE_FLOATS] = i * 100 + k;
    at += c;
  });
  return { runZ: Int16Array.from(z), runStart, runCount: Int32Array.from(counts), layerRunFirst: new Int32Array(9), layerRuns: new Int32Array(9), runs: z.length, data };
}

test("the circles' runs go among the batches and the particle systems' by z, a tie going to the system", () => {
  const particles = runsOf([-2, 0, 4], [1, 2, 1]);
  const circles = runsOf([0, 99], [3, 1]);
  // B1 (slot 4) holds the first three particle runs and the first circle
  // run; T1 (slot 5) the last circle run.
  particles.layerRuns[4] = 3;
  circles.layerRuns[4] = 1;
  circles.layerRunFirst[5] = 1;
  circles.layerRuns[5] = 1;
  const sprites = runsOf([-20, 2], [2, 2]);
  sprites.layerRuns[4] = 2;
  const calls: string[] = [];
  const collect = (buffer: 0 | 1 | 2, count: number, start: number): void => {
    calls.push(`${buffer} ${start}+${count}`);
  };
  drawLayerRuns(sprites, particles, 4, collect, undefined, circles);
  assert.deepEqual(calls, ["0 0+2", "1 0+3", "2 0+3", "0 2+2", "1 3+1"]);
  calls.length = 0;
  drawLayerRuns(sprites, null, 4, collect, undefined, circles);
  assert.deepEqual(calls, ["0 0+2", "2 0+3", "0 2+2"], "circles alone");
  calls.length = 0;
  // From the streak (-3) up they wait for drawParticleRuns, still by z.
  drawLayerRuns(sprites, particles, 4, collect, -3, circles);
  assert.deepEqual(calls, ["0 0+4"]);
  calls.length = 0;
  drawParticleRuns(particles, 4, -3, collect, circles);
  assert.deepEqual(calls, ["1 0+3", "2 0+3", "1 3+1"]);
  calls.length = 0;
  drawParticleRuns(null, 5, -3, collect, circles);
  assert.deepEqual(calls, ["2 3+1"], "T1's");
  calls.length = 0;
  // Both start at the same z: the system still goes first.
  const level = runsOf([0, 4], [1, 1]);
  level.layerRuns[4] = 2;
  drawParticleRuns(level, 4, -3, collect, circles);
  assert.deepEqual(calls, ["1 0+1", "2 0+3", "1 1+1"]);
});
