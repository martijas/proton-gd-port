// The camera as updateCamera composes it: the gameplay offset, the dead zone,
// the edges, the floor and the level's left stop, the static camera's
// approach and hand-back, what teleports ask of it, the rotated axes, and the
// turned view's cover. The follow runs headless, on stand-in players or on a
// real sim the way the scene drives it each tick.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Level } from "../src/level/types";
import type { Player } from "../src/physics/player";
import { Camera, type CameraTriggerState, LEVEL_START_LEFT, turnPoint } from "../src/render/camera";
import { backgroundRepeats } from "../src/render/scenery";
import { NO_INPUT, type PlayerState, type Sim, type SimOptions } from "../src/physics/types";
import { makeSim } from "./helpers";
import { buildLevel, emptyLevel, HOLD, makeHeader, simOn } from "./levelKit";

const near = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

/** A stand-in player: a cube going forwards, upright, unless told otherwise. */
function player(p: Partial<PlayerState>): PlayerState {
  return { x: 0, y: 15, mode: "cube", flipped: false, reversed: false, rotated: false, ...p } as PlayerState;
}

/** What a fresh runtime asks of the camera, with `over` on top. */
function triggerState(camera: Camera, over: Partial<CameraTriggerState> = {}): CameraTriggerState {
  return {
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
    staticX: { ...camera.staticX },
    staticY: { ...camera.staticY },
    limitLeft: null,
    limitRight: null,
    limitTop: null,
    limitBottom: null,
    levelTop: 2700,
    levelEnd: null,
    leadSnap: 0,
    followDivisor: 10,
    padding: 0.5,
    minLeft: LEVEL_START_LEFT,
    platformer: false,
    snapSeq: 0,
    slowYSeq: 0,
    teleportCheckSeq: 0,
    teleportCheckY: 0,
    teleportCheckMargin: 0,
    ...over,
  };
}

/** One tick the way the scene does it: the sim steps, then the camera takes the triggers and follows. */
function tick(sim: Sim, camera: Camera): void {
  sim.step(NO_INPUT);
  camera.applyTriggers(sim.triggers.camera);
  camera.follow(sim.state);
}

test("the player keeps its place across the screen at any zoom", () => {
  // 75 design units, so 75 / zoom world units. [gdp updateCamera
  //  :449668-449689]
  const camera = new Camera();
  camera.setAspect(16, 9);
  for (const [zoom, ahead] of [
    [1, 75],
    [0.6, 125],
    [1.25, 60],
  ] as const) {
    camera.zoom = zoom;
    camera.reset(player({ x: 1000 }));
    near(camera.centre().x - 1000, ahead, 1e-9, `ahead at zoom ${zoom}`);
    const b = camera.bounds(0);
    near((1000 - b.x0) / (b.x1 - b.x0), 0.3681640625, 1e-12, `fraction at zoom ${zoom}`);
  }
});

test("a zoom change carries the gameplay offset with it at once, and reversing slides it", () => {
  // Settled, the offset snaps to 75 / zoom while the zoom moves; turned
  // round, it slides across at the player's own speed.
  // [gdp updateCamera :450045-450140]
  const camera = new Camera();
  camera.reset(player({ x: 1000 }));
  camera.zoom = 0.8;
  camera.follow(player({ x: 1001 }));
  near(camera.centre().x, 1001 + 93.75, 1e-9, "75 / 0.8");
  camera.zoom = 1;
  camera.reset(player({ x: 1000 }));
  camera.follow(player({ x: 999, reversed: true }));
  near(camera.centre().x, 999 + 74, 1e-9, "one unit across");
  for (let x = 998; x > 800; x--) camera.follow(player({ x, reversed: true }));
  near(camera.centre().x, 801 - 75, 1e-9, "75 ahead once it has crossed");
});

test("the view's bottom stays at the game's y 0, and its top under the level's top", () => {
  // A cube on the floor stands a third of the way up, with 90 units of
  // ground under it. With no top edge the view stays 150 under the level's
  // top, 2790 in the game's units. [gdp updateCamera :449586-449601;
  //  limitCamera :430885-430904; updateMaxGameplayY :430648-430650]
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.reset(player({ y: 15 }));
  assert.equal(camera.centre().y, 70, "160 over the game's 0, which is 90 under the floor");
  const b = camera.bounds(0);
  near((15 - b.y0) / (b.y1 - b.y0), 105 / 320, 1e-12, "the player a third of the way up");
  camera.reset(player({ y: 5000, mode: "ball" }));
  assert.equal(camera.bounds(0).y1, 2790 - 90 - 150, "the top 150 under the level's");
});

test("a Camera Edge stops the view, easing into it over the last 60 units", () => {
  // The divisor rises from 1 towards 24 as the target closes on the edge.
  // [gdp updateCamera :450440-450545]
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.reset(player({ x: 1500 }));
  assert.equal(camera.centre().x, 1575);
  camera.limitRight = 2000;
  camera.follow(player({ x: 1600 }));
  const half = 160 * (16 / 9);
  const edge = 2000 - half;
  const divisor = 1 + (1 - (edge - 1675) / 60) * 23;
  near(camera.centre().x, 1575 + 100 / (divisor / 0.25), 1e-9, "eased, not snapped");
  let last = camera.centre().x;
  for (let x = 1601; x < 2100; x++) {
    camera.follow(player({ x }));
    const c = camera.centre().x;
    assert.ok(c >= last && c <= edge + 1e-9, `never past the edge: ${c}`);
    last = c;
  }
  near(last, edge, 1, "and closes on it, ever more slowly");
});

test("the travel axis swaps when gameplay is rotated", () => {
  // y snaps with the gameplay offset and x gets the dead zone.
  // [gdp updateCamera :449622-449626, :449727-449733, :450018-450032]
  const camera = new Camera();
  camera.setAspect(16, 9);
  // The dead zone is measured from where the view was, here x 0.
  camera.x = 0;
  camera.reset(player({ x: 500, y: 600, rotated: true }));
  assert.deepEqual(camera.centre(), { x: 430, y: 675 });
  camera.follow(player({ x: 600, y: 700, rotated: true }));
  assert.equal(camera.centre().y, 775, "y follows exactly");
  near(camera.centre().x, 430 + 100 * 0.025, 1e-9, "x eases toward the dead zone");
});

test("Rotate Gameplay's key 368 snaps the gameplay offset instead of letting it slide", () => {
  // Turned to travel up, the y axis' offset starts where it was (0) and
  // slides to 75 at the player's own speed; key 368 snaps it.
  // [gdp rotateGameplay :442856-442860; updateCamera :450045-450056]
  const run = (snap: boolean) => {
    const camera = new Camera();
    camera.setAspect(16, 9);
    camera.reset(player({ x: 500, y: 600 }));
    if (snap) camera.leadSnap++;
    camera.follow(player({ x: 500, y: 601, rotated: true }));
    return camera.y - 601;
  };
  assert.equal(run(false), 1, "one unit of the slide");
  assert.equal(run(true), 75, "all of it");
});

test("a turn of gameplay hands the view back over a second rather than jumping", () => {
  // [gdp updateCamera :449643-449661]
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.reset(player({ x: 500, y: 600 }));
  const before = camera.centre();
  camera.follow(player({ x: 501, y: 600, rotated: true }));
  const after = camera.centre();
  near(after.x, before.x, 1e-9, "no jump across");
  near(after.y, before.y, 1e-9, "no jump up");
  for (let i = 0; i < 240; i++) camera.follow(player({ x: 501, y: 600 + i, rotated: true }));
  assert.ok(Math.abs(camera.centre().y - (600 + 239 + 75)) < 1e-6, "a second later it is on the player");
});

test("a static camera sets out from the view, and its exit hands the view back", () => {
  // The approach eases from where the view was drawn to the group; letting
  // go snaps the follow and adds the jump back, eased away over the exit's
  // move time. [gdp updateStaticCameraPos :450947-450976; exitStaticCamera
  //  :451385-451465; updateCamera :450609-450640, :450779-450786]
  const level = emptyLevel([
    { id: 1, x: 600, y: 300 },
    { id: 1914, x: 60, y: 600, props: { 71: "4", 101: "1", 10: "0.5" } },
    { id: 1914, x: 450, y: 600, props: { 110: "1", 101: "1", 10: "0.5" } },
  ]);
  level.objects[level.objects.length - 3].groups = [4];
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: 45 } });
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.reset(sim.state, sim.triggers.camera);
  const st = sim.triggers.camera.staticX;
  let prev = camera.centre().x;
  while (!st.on) {
    near(camera.centre().x, sim.state.x + 75, 1e-9, "following");
    prev = camera.centre().x;
    tick(sim, camera);
  }
  near(camera.centre().x, prev + (600 - prev) / 120, 1e-6, "one step of the approach from where it was");
  // A hair over 120 steps: the move time is counted in floats, as the game
  // counts it.
  for (let i = 0; i < 120; i++) tick(sim, camera);
  near(camera.centre().x, 600, 1e-6, "there after the move time");
  while (st.on) {
    prev = camera.centre().x;
    tick(sim, camera);
  }
  near(prev, 600, 1e-6, "held");
  near(camera.centre().x, 600, 1e-6, "the exit's own step does not jump");
  const jump = 600 - (sim.state.x + 75);
  tick(sim, camera);
  near(camera.centre().x, sim.state.x + 75 + jump * (1 - 1 / 120), 1e-4, "the jump eases away");
  for (let i = 0; i < 120; i++) tick(sim, camera);
  near(camera.centre().x, sim.state.x + 75, 1e-6, "and the view is the follow's again");
});

test("a turned view covers its corners and turns clockwise", () => {
  // [gdp GJBaseGameLayer::visit :434055-434071 (setRotation, clockwise);
  //  preUpdateVisibility :452608-452650]
  near(turnPoint(100, 0, 90)[0], 0, 1e-9, "right of centre");
  near(turnPoint(100, 0, 90)[1], -100, 1e-9, "goes below it at 90");
  near(turnPoint(100, 0, -4)[1], 6.975647374, 1e-9, "and rises at -4, as in Dash");
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.reset(player({ x: 0, y: 200 }));
  camera.rotation = 4;
  let b = camera.coverBounds(0);
  near(b.x1 - b.x0, 589.825176, 1e-5, "width at 4");
  near(b.y1 - b.y0, 358.904179, 1e-5, "height at 4");
  camera.rotation = 90;
  b = camera.coverBounds(0);
  near(b.x1 - b.x0, 320, 1e-9, "width at 90");
  near(b.y1 - b.y0, 568.888889, 1e-5, "height at 90");
  camera.rotation = 0;
  assert.deepEqual(camera.coverBounds(30), camera.bounds(30), "unturned, the same as bounds");
});

test("a turn is drawn part-way between ticks, the long way when asked", () => {
  // 180 to 360 passes through 270.
  const camera = new Camera();
  camera.reset(player({}));
  camera.applyTriggers(triggerState(camera, { rotation: 180 }));
  camera.applyTriggers(triggerState(camera, { rotation: 360 }));
  assert.equal(camera.rotationAt(0.5), 270);
  assert.equal(camera.rotationAt(1), 360);
});

test("a background's rows past the placed one repeat mirrored, except the seamless ones", () => {
  // [gdp GJBaseGameLayer::createBackground :418087-418113]
  for (const id of [16, 35, 37, 40, 51, 53, 59, 60]) assert.ok(backgroundRepeats(id), `${id} repeats`);
  for (const id of [1, 15, 36, 39, 52]) assert.ok(!backgroundRepeats(id), `${id} mirrors`);
});

test("a classic level's end stops the view, easing into it over the last 60 units", () => {
  // The end portal stands 340 past the furthest object, and the view's right
  // edge stops on it as on a Camera Edge, less the camera offset; the player
  // runs on across the screen into the portal. A short level's portal is
  // still at least 300 past a screen's width. [gdp updateCamera
  //  :449604-449612; PlayLayer::createObjectsFromSetupFinished
  //  :102160-102177]
  const camera = new Camera();
  camera.setAspect(16, 9);
  const half = 160 * (16 / 9);
  const stop = 3000 - half;
  camera.reset(player({ x: stop - 195 }));
  camera.levelEnd = 3000;
  near(camera.centre().x, stop - 120, 1e-9, "following");
  camera.follow(player({ x: stop - 95 }));
  const divisor = 1 + (1 - 20 / 60) * 23;
  near(camera.centre().x, stop - 120 + 100 / (divisor / 0.25), 1e-9, "eased, not snapped");
  let last = camera.centre().x;
  for (let x = stop - 94; x < 3600; x++) {
    camera.follow(player({ x }));
    const c = camera.centre().x;
    assert.ok(c >= last && c <= stop + 1e-9, `never past the end: ${c}`);
    last = c;
  }
  near(camera.bounds(0).x1, 3000, 1, "the right edge comes to rest on the portal");
  camera.offsetX = 40;
  for (let i = 0; i < 2000; i++) camera.follow(player({ x: 3600 }));
  near(camera.bounds(0).x1, 3000 - 40, 1, "less the offset");
  camera.reset(player({ x: 200 }));
  camera.levelEnd = 400;
  for (let x = 200; x < 2000; x++) camera.follow(player({ x }));
  near(camera.bounds(0).x1, 2 * half + 300, 1, "a short level's portal is a screen and 300 in");
});

test("a sim's level ends 340 past its furthest object, and a platformer's has no end", () => {
  // [gdp PlayLayer::addObject :89885-89888; createObjectsFromSetupFinished
  //  :102160-102177, only without byte 10734]
  const classic = makeSim(emptyLevel([{ id: 1, x: 4005, y: 15 }]), undefined, { visuals: true });
  assert.equal(classic.triggers.camera.levelEnd, 4005 + 340);
  const platformer = makeSim(emptyLevel([], makeHeader({ platformer: true })), undefined, { visuals: true });
  assert.equal(platformer.triggers.camera.levelEnd, null);
});

test("a zoom in on a player that last stood on the floor keeps the view's bottom on the floor", () => {
  // The y re-centre is skipped and the follow aims the bottom at the game's
  // y 0, so the floor stays where it was on screen rather than the zoom
  // closing in about the centre. Only for a player whose last landing was on
  // the floor itself, low enough to keep it in view. [gdp updateCamera
  //  :449733-449753, :450040-450048]
  const run = (lastGroundY: number) => {
    const camera = new Camera();
    camera.setAspect(16, 9);
    camera.reset(player({ x: 1000, lastGroundY }));
    assert.equal(camera.bounds(0).y0, -90);
    let lowest = 0;
    for (let i = 1; i <= 720; i++) {
      camera.zoom = 1 + 0.25 * Math.min(1, i / 48);
      camera.follow(player({ x: 1000 + i, lastGroundY }));
      lowest = Math.min(lowest, camera.bounds(0).y0);
    }
    return { bottom: camera.bounds(0).y0, lowest };
  };
  const held = run(15);
  near(held.bottom, -90, 1e-9, "on the floor at 1.25");
  near(held.lowest, -90, 1e-9, "all the way in");
  // Last grounded anywhere else, the view zooms about its centre (70) and the
  // dead zone settles it 40 over the player.
  near(run(Number.NaN).bottom, 15 + 40 - 128, 1e-3, "about the centre");
  near(run(45).bottom, 15 + 40 - 128, 1e-3, "a block's top is not the floor");
});

test("a static camera that fires while an exit is still handing the view back drops the hand-back", () => {
  // updateStaticCameraPos zeroes the hand-back and stops its tween, so the
  // new approach sets out from where the view was drawn and takes one step.
  // [gdp updateStaticCameraPos :450947-450958; updateStaticCameraPosToGroup
  //  :451505-451530]
  const level = emptyLevel([
    { id: 1, x: 900, y: 300 },
    { id: 1, x: 1200, y: 300 },
    { id: 1914, x: 60, y: 600, props: { 71: "4", 101: "1", 10: "0.5" } },
    { id: 1914, x: 450, y: 600, props: { 110: "1", 101: "1", 10: "1" } },
    { id: 1914, x: 530, y: 600, props: { 71: "6", 101: "1", 10: "0.5" } },
  ]);
  const at = level.objects.length - 5;
  level.objects[at].groups = [4];
  level.objects[at + 1].groups = [6];
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 15, y: 45 } });
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.reset(sim.state, sim.triggers.camera);
  const st = sim.triggers.camera.staticX;
  while (st.exitSeq === 0) tick(sim, camera);
  for (let i = 0; i < 4; i++) tick(sim, camera);
  assert.ok(Math.abs(camera.centre().x - (sim.state.x + 75)) > 100, "still handing back");
  let prev = camera.centre().x;
  while (st.seq < 2) {
    prev = camera.centre().x;
    tick(sim, camera);
  }
  near(camera.centre().x, prev + (1200 - prev) / 120, 1e-3, "one step of the approach, and nothing of the hand-back");
});

test("a frame between two ticks takes the zoom between them", () => {
  // The zoom steps once a tick, so the size is interpolated as the centre and
  // the turn are.
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.reset(player({}));
  camera.applyTriggers(triggerState(camera));
  camera.applyTriggers(triggerState(camera, { zoom: 1.5 }));
  assert.equal(camera.zoomAt(0.5), 1.25);
  assert.equal(camera.unitsHighAt(0.5), 256);
  const b = camera.bounds(0, 0.5);
  near(b.y1 - b.y0, 256, 1e-9, "the half-way height");
  assert.equal(camera.unitsHigh, 320 / 1.5, "and the tick's own");
});

test("a run from the level's start holds the view's left edge on x 15 until the player catches up", () => {
  // The player starts at x 0, off the left of the view, which holds still
  // until the player is 75 behind its centre, about 0.7 s at 1x. A start
  // position, or a debug jump standing in for one, has no stop unless kA23
  // asks for it, and kA24 takes it away. [gdp updateCamera :449613-449619;
  //  limitCamera :430885-430904; PlayLayer::addObject :90313-90314]
  const half = 160 * (16 / 9);
  const begin = (level: Level, start?: SimOptions["start"]) => {
    const sim = makeSim(level, undefined, { visuals: true, start });
    const camera = new Camera();
    camera.setAspect(16, 9);
    camera.reset(sim.state, sim.triggers.camera);
    return { sim, camera };
  };
  // On the ground itself, where the game's player starts.
  const { sim, camera } = begin(buildLevel([]));
  assert.equal(sim.state.x, 0);
  assert.equal(sim.triggers.camera.minLeft, 15);
  near(camera.bounds(0).x0, 15, 1e-9, "the left edge on x 15");
  let ticks = 0;
  while (sim.state.x + 75 <= 15 + half && ticks < 480) {
    near(camera.centre().x, 15 + half, 1e-9, `held at tick ${ticks}`);
    tick(sim, camera);
    ticks++;
  }
  assert.equal(sim.state.dead, false);
  near(camera.centre().x, sim.state.x + 75, 1e-9, "then it follows");
  assert.ok(ticks > 0.65 * 240 && ticks < 0.75 * 240, `about 0.7 s: ${ticks} ticks`);
  const startPos = { id: 31, x: 30, y: 15, settings: {} };
  near(begin(buildLevel([startPos])).camera.centre().x, 105, 1e-9, "a start position has no stop");
  near(begin(buildLevel([startPos], makeHeader({ leftStopAlways: true }))).camera.centre().x, 15 + half, 1e-9, "unless kA23 asks for it");
  near(begin(buildLevel([], makeHeader({ noLeftStop: true }))).camera.centre().x, 75, 1e-9, "kA24 takes it away");
  near(begin(buildLevel([]), { x: 15 }).camera.centre().x, 90, 1e-9, "a debug jump stands in for a start position");
});

test("a teleport's key 55 slows the y follow for half a second, and key 464 snaps the view", () => {
  // Key 55 sets the y divisor to 30, whatever it was, for a half second the
  // game counts down in floats, which runs out a step late: 121 steps. A y
  // snap ends it, and so does key 464, which snaps both axes.
  // [gdp teleportPlayer :462456-462479; updateCamera :449628-449668,
  //  :450552-450566]
  const camera = new Camera();
  camera.setAspect(16, 9);
  camera.reset(player({ x: 1000, y: 15 }));
  assert.equal(camera.centre().y, 70);
  camera.slowYSeq++;
  let y = camera.centre().y;
  for (let i = 0; i < 121; i++) {
    camera.follow(player({ x: 1001 + i, y: 600 }));
    near(camera.centre().y, y + (530 - y) / 120, 1e-9, `slowed at step ${i}`);
    y = camera.centre().y;
  }
  camera.follow(player({ x: 1200, y: 600 }));
  near(camera.centre().y, y + (530 - y) / 40, 1e-9, "the follow's own 10 after");
  camera.slowYSeq++;
  camera.snapSeq++;
  camera.follow(player({ x: 1201, y: 1000 }));
  assert.equal(camera.centre().y, 930, "snapped");
  assert.equal(camera.centre().x, 1276, "on both axes");
  camera.follow(player({ x: 1202, y: 1100 }));
  near(camera.centre().y, 930 + (1030 - 930) / 40, 1e-9, "and not slowed");
});

test("a teleport or a spider's jump that lands the player well outside the view snaps it", () => {
  // More than the margin (60, or 180 under key 55) over the view's top or
  // under its bottom, the view as it was last drawn. The top is the bottom
  // plus the window's height whatever the zoom, so a zoomed-in view lets the
  // player go further over it. [gdp checkCameraLimitAfterTeleport
  //  :450837-450857]
  const run = (from: number, y: number, margin: number, zoom = 1) => {
    const camera = new Camera();
    camera.setAspect(16, 9);
    camera.zoom = zoom;
    camera.reset(player({ x: 1000, y: from }));
    const before = camera.centre().y;
    camera.teleportCheckSeq++;
    camera.teleportCheckY = y;
    camera.teleportCheckMargin = margin;
    camera.follow(player({ x: 1001, y }));
    return { before, after: camera.centre().y };
  };
  // A view from y -90 to 230.
  assert.equal(run(15, 291, 60).after, 291 - 70, "61 over the top snaps");
  near(run(15, 290, 60).after, 70 + (290 - 70 - 70) / 40, 1e-9, "60 over follows");
  near(run(15, 291, 180).after, 70 + (291 - 70 - 70) / 40, 1e-9, "with key 55's 180 it follows");
  assert.equal(run(15, 411, 180).after, 411 - 70, "181 over snaps");
  // A view from 770 to 1090.
  assert.equal(run(1000, 709, 60).after, 709 + 40, "61 under the bottom snaps");
  near(run(1000, 710, 60).after, 930 + (710 + 40 - 930) / 40, 1e-9, "60 under follows");
  // Zoomed to 2, a view from 850 to 1010 that the check takes as 850 to 1170.
  const zoomed = run(1000, 1200, 60, 2);
  near(zoomed.after, zoomed.before + (1200 - 70 - zoomed.before) / 40, 1e-9, "190 over the top at zoom 2 follows");
});

test("a platformer eases into every limit, the floor included", () => {
  // Elsewhere only a Camera Edge or a classic level's end eases the view in.
  // [gdp updateCamera :450439, :450498-450500 (+10734)]
  const run = (platformer: boolean) => {
    const camera = new Camera();
    camera.setAspect(16, 9);
    camera.reset(player({ x: 1000, y: 15 }));
    camera.platformer = platformer;
    camera.y = 120;
    camera.follow(player({ x: 1001, y: 0 }));
    return camera.centre().y;
  };
  near(run(false), 120 - 50 / 40, 1e-9, "the follow's 10");
  near(run(true), 120 - 50 / 96, 1e-9, "24 on the floor itself");
});

test("teleports and the spider's jump tell the camera what they did", () => {
  // A teleport to a target always checks where the player landed; keys 55
  // and 464 ask for the slow follow and the snap, and key 510 makes the
  // landing the player's last. A spider's jump checks only when it looked
  // past a band. [gdp teleportPlayer :462456-462489;
  //  spiderTestJumpInternal :154751-154755, :155225-155230]
  const through = (props: Record<number, string>) => {
    const sim = simOn(emptyLevel([{ id: 747, x: 120, y: 45, props: { 54: "300", ...props } }]));
    for (let i = 0; i < 120; i++) {
      const n = sim.events.length;
      sim.step(NO_INPUT);
      if (sim.events.slice(n).some((e) => e.detail === "teleport")) break;
    }
    return { cam: sim.triggers.camera, ground: sim.state.lastGroundY };
  };
  const plain = through({});
  assert.deepEqual(
    [plain.cam.teleportCheckSeq, plain.cam.teleportCheckY, plain.cam.teleportCheckMargin, plain.cam.slowYSeq, plain.cam.snapSeq],
    [1, 345, 60, 0, 0],
  );
  assert.ok(Number.isNaN(plain.ground), "a teleport forgets the last landing");
  const slow = through({ 55: "1" });
  assert.deepEqual([slow.cam.slowYSeq, slow.cam.teleportCheckMargin], [1, 180]);
  assert.equal(through({ 464: "1" }).cam.snapSeq, 1);
  assert.equal(through({ 510: "1" }).ground, 345, "key 510 lands it");

  // A cube on a spider pad looks 3,000 units off; a spider in its band does not.
  let landed = Number.NaN;
  const pad: Sim = makeSim(buildLevel([{ id: 1, x: 2985, y: 15 }, { id: 3005, x: 450, y: 3 }]), undefined, {
    start: { x: 15, y: 15 },
    onEvent: (e) => {
      if (e.type === "jump" && e.detail === "spider") landed = pad.state.y;
    },
  });
  for (let i = 0; i < 400 && Number.isNaN(landed); i++) pad.step(NO_INPUT);
  assert.ok(!Number.isNaN(landed), "never reached the pad");
  const cam = pad.triggers.camera;
  assert.deepEqual([cam.teleportCheckSeq, cam.teleportCheckY, cam.teleportCheckMargin], [1, landed, 60]);
  const spider = makeSim(emptyLevel(), undefined, { start: { x: 95, y: 43.5, mode: "spider" } });
  const p = spider.state as Player;
  p.onGround = true;
  p.onGround2 = true;
  spider.step(HOLD);
  assert.ok(spider.state.y > 200, "the spider jumped");
  assert.equal(spider.triggers.camera.teleportCheckSeq, 0, "inside its band");
});
