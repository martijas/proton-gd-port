// What a portal does to the player's velocity and angle.
//
// These numbers are not measurements of this port: they are the rule read out
// of the 2.206 decompile, and the port is asserted against them. The derivation
// and the line numbers are in data/ref/gd-portal-modes.md and
// data/ref/gd-portal-others.md; each case below cites the part it pins.
//
// The rule in one sentence: four of the seven mode toggles — fly (ship), bird
// (UFO), dart (wave) and swing — halve the y velocity and zero the angle, and
// they do it inside a "the flag actually changed" guard, so they fire when the
// mode is turned off as well as when it is turned on. A portal runs two toggles
// (the old mode's off, the new mode's on), which is why wave to ship quarters.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameMode, Level } from "../src/level/types";
import { Player, type PlayerWorld } from "../src/physics/player";
import { maxGameplayYFor } from "../src/physics/constants";
import { NO_INPUT, type Sim } from "../src/physics/types";
import { groundLayers } from "../src/render/camera";
import { loadOfficialLevel, makeSim } from "./helpers";
import { buildLevel, emptyLevel, makeHeader, type Placed } from "./levelKit";

/** Object id of the ship portal. */
const SHIP_PORTAL = 13;
/** Object id of the portal that turns dual mode on. */
const DUAL_PORTAL = 286;

const WORLD: PlayerWorld = {
  emit: () => {},
  spiderJump: () => {},
  platformer: false,
  dual: false,
  fixGravityBug: false,
  boostSlide: true,
};

function player(mode: GameMode, yVel: number, rotation = 0, flipped = false): Player {
  const p = new Player(WORLD, 1);
  p.setMode(mode);
  p.yVel = yVel;
  p.rotation = rotation;
  p.flipped = flipped;
  return p;
}

/** Every mode-to-mode pair, as a factor on the y velocity. */
const FLYING: GameMode[] = ["ship", "ufo", "wave", "swing"];
const GROUNDED: GameMode[] = ["cube", "ball", "robot", "spider"];
const ALL: GameMode[] = [...GROUNDED, ...FLYING];

test("a mode portal halves the y velocity once per flying toggle it fires", () => {
  for (const from of ALL) {
    for (const to of ALL) {
      if (from === to) continue;
      const halvings = (FLYING.includes(from) ? 1 : 0) + (FLYING.includes(to) ? 1 : 0);
      const p = player(from, 8);
      p.setMode(to);
      const expected = 8 * 0.5 ** halvings;
      assert.equal(p.yVel, expected, `${from} -> ${to} should be x${0.5 ** halvings}, got x${p.yVel / 8}`);
    }
  }
});

test("wave into a ship portal leaves at a quarter speed, not at full speed", () => {
  // The case that prompted this: toggleDartMode(0) halves and toggleFlyMode(1)
  // halves again. [gd-ida-decomp.cpp:153032 and :152819]
  const p = player("wave", 5.193, -44.9);
  p.setMode("ship");
  assert.ok(Math.abs(p.yVel - 5.193 * 0.25) < 1e-12, `expected a quarter, got ${p.yVel}`);
  assert.equal(p.rotation, 0, "and pointing straight ahead, not at the wave's angle");
});

test("ball and robot portals leave the y velocity alone", () => {
  // toggleRollMode, toggleRobotMode and toggleSpiderMode contain no write to
  // the y velocity at all. [gd-portal-modes.md, the per-toggle table]
  for (const [from, to] of [
    ["ball", "robot"],
    ["robot", "spider"],
    ["spider", "cube"],
    ["cube", "ball"],
  ] as [GameMode, GameMode][]) {
    const p = player(from, 11.5);
    p.setMode(to);
    assert.equal(p.yVel, 11.5, `${from} -> ${to} should not touch the velocity`);
  }
});

test("the angle is zeroed entering any flying mode, robot or spider", () => {
  for (const to of [...FLYING, "robot", "spider"] as GameMode[]) {
    const p = player("cube", 0, 137);
    p.setMode(to);
    assert.equal(p.rotation, 0, `entering ${to} should zero the angle`);
  }
});

test("leaving the ball or the swing stands the player upright for its gravity", () => {
  // toggleRollMode's and toggleSwingMode's off branches end in
  // setRotation(upsideDown ? 180 : 0). [gd-ida-decomp.cpp:153168 and :152633]
  for (const from of ["ball", "swing"] as GameMode[]) {
    for (const flipped of [false, true]) {
      const p = player(from, 0, 137, flipped);
      p.setMode("cube");
      assert.equal(p.rotation, flipped ? 180 : 0, `${from} -> cube while ${flipped ? "flipped" : "upright"}`);
    }
  }
});

test("entering the cube from robot or spider leaves the angle where it was", () => {
  // Neither toggle writes the angle on the way out, and cube has no on toggle.
  for (const from of ["robot", "spider"] as GameMode[]) {
    const p = player(from, 0, 137);
    p.setMode("cube");
    assert.equal(p.rotation, 137, `${from} -> cube should not touch the angle`);
  }
});

test("a gravity flip halves the y velocity, in both directions", () => {
  // flipGravity is the sole owner of this, and it runs the same code entering
  // flipped gravity and leaving it. [gd-ida-decomp.cpp:151156-151158]
  const down = player("cube", 9);
  down.flipGravity(true);
  assert.equal(down.yVel, 4.5);
  down.flipGravity(false);
  assert.equal(down.yVel, 2.25);
});

test("a gravity flip to the gravity already in force does nothing", () => {
  // The whole body sits inside `if (this[1967] != a2)`.
  const p = player("cube", 9);
  p.flipGravity(false);
  assert.equal(p.yVel, 9);
});

test("a mode change to the mode already in force does nothing", () => {
  const p = player("ship", 9, 40);
  p.setMode("ship");
  assert.equal(p.yVel, 9);
  assert.equal(p.rotation, 40);
});

test("a portal that both changes mode and flips gravity composes the two halvings", () => {
  // A portal pair in one frame is the case gd-portal-modes.md calls out: the
  // halvings multiply rather than one winning.
  const p = player("cube", 16);
  p.setMode("ship");
  p.flipGravity(true);
  assert.equal(p.yVel, 4);
});

// --- the flying corridor ------------------------------------------------------

/**
 * The corridor the player is left in after crossing `portal`, entering it at
 * `entryY`. Started on the portal rather than in front of it: a cube dropped
 * ahead of a portal placed high simply falls past it before arriving.
 */
async function corridorAfterCrossing(levelId: number, portal: { x: number; y: number }, entryY: number): Promise<string | null> {
  const level = await loadOfficialLevel(levelId);
  const sim = makeSim(level, undefined, { noclip: true, start: { x: portal.x, y: entryY, mode: "cube" } });
  for (let i = 0; i < 40 && sim.state.mode !== "ship"; i++) {
    sim.step({ jump: false, left: false, right: false });
  }
  return sim.state.mode === "ship" ? `${sim.floorY}..${sim.ceilingY}` : null;
}

// These two were `todo` for the whole of goal 5: the band followed the player,
// so both of them failed. The anchor is now the object the game hangs it from,
// so they are ordinary tests. See `animateInGround` in src/physics/sim.ts.
test("the flying corridor does not depend on how the player entered the portal", async () => {
  // The corridor used to be anchored to the player's y at the moment it crossed,
  // so arriving at Stereo Madness's ship portal a couple of blocks higher lifted
  // both the floor and the ceiling and the section played differently. The game
  // anchors it to the portal — `getMinPortalY` / `getMaxPortalY` — which does
  // not move.
  const level = await loadOfficialLevel(1);
  const portal = level.objects.filter((o) => o.id === SHIP_PORTAL).sort((a, b) => a.x - b.x)[0];
  assert.ok(portal, "Stereo Madness should have a ship portal");

  const bands = new Set<string>();
  // Inside the portal's 86-unit box, which is the range an approach can vary by.
  for (const offset of [-30, -15, 0, 15, 30]) {
    const band = await corridorAfterCrossing(1, portal, portal.y + offset);
    if (band) bands.add(band);
  }
  assert.ok(bands.size > 0, "at least one entry height should have crossed the portal");
  assert.equal(bands.size, 1, `every entry height should give one corridor, got ${[...bands].join(", ")}`);
});

test("a low portal puts the corridor on the ground and a high one lifts it", async () => {
  // Both halves matter. Pinning the band to the ground would put the sections
  // built high out of reach — 19 of the 89 flying portals in the official levels
  // sit above y = 300, and Theory of Everything has one at 1005.
  const level = await loadOfficialLevel(1);
  const portals = level.objects.filter((o) => o.id === SHIP_PORTAL).sort((a, b) => a.y - b.y);
  const lowest = portals[0];
  const highest = portals[portals.length - 1];
  assert.ok(highest.y > lowest.y + 100, "the level should have both a low and a high ship portal");

  const low = await corridorAfterCrossing(1, lowest, lowest.y);
  const high = await corridorAfterCrossing(1, highest, highest.y);
  assert.ok(low && high, "both portals should have been crossed");
  const [lowFloor, lowCeiling] = low.split("..").map(Number);
  const [highFloor, highCeiling] = high.split("..").map(Number);
  assert.equal(lowFloor, 0, `a portal at y ${lowest.y} should sit on the ground, got ${lowFloor}`);
  assert.ok(highFloor > 0, `a portal at y ${highest.y} should lift the corridor, got ${highFloor}`);
  assert.equal(highCeiling - highFloor, lowCeiling - lowFloor, "and the corridor keeps its height");
});

test("a dual keeps its own portal as the corridor's anchor, whatever is crossed inside it", async () => {
  // Hexagon Force is the case that settles this. Its dual begins at y 419 and
  // runs to x 15103; the two stacked ship portals at x 12825 sit inside it. The
  // game anchors to the dual portal, so the band there is 240..540 — and the
  // section's blocks run up to y 533, which is why anchoring to the ship portal
  // instead (180..480) made the level unfinishable for the autoplayer.
  // [gdp GJBaseGameLayer::getTargetFlyCameraY, gd-ida-decomp.cpp:420357-420368]
  const level = await loadOfficialLevel(16);
  const dual = level.objects.filter((o) => o.id === DUAL_PORTAL).sort((a, b) => a.x - b.x)[0];
  assert.ok(dual, "Hexagon Force should have a dual portal");

  const sim = makeSim(level, undefined, { noclip: true, start: { x: dual.x - 60, y: dual.y, mode: "cube" } });
  let inDual: string | null = null;
  let inShip: string | null = null;
  for (let i = 0; i < 60000 && inShip === null; i++) {
    sim.step({ jump: false, left: false, right: false });
    if (sim.state2 !== null && inDual === null) inDual = `${sim.floorY}..${sim.ceilingY}`;
    if (sim.state.mode === "ship") inShip = `${sim.floorY}..${sim.ceilingY}`;
  }

  // Entering the dual gives even a cube a band, which it never has on its own.
  assert.equal(inDual, "270..540", "the dual itself puts a 270 band under the cube");
  // And the ship portal widens it to 300 without moving the anchor off the dual
  // portal: 419 − 150 snapped down to the block grid is 240.
  assert.equal(inShip, "240..540", "the ship portals inside the dual keep the dual portal's anchor");
});

// --- the level's own bounds ---------------------------------------------------

test("a level has a ceiling, and it is the one the level asks for", async () => {
  // There was none at all, so a player whose gravity flipped in a mode without
  // a corridor rose for ever. Nothing stopped it and progress is measured along
  // x, so the autoplayer "finished" eight levels from thousands of units up in
  // empty sky. The flat default is 2790 in the game's units, the value the
  // camera's top reads too. [gdp GJBaseGameLayer::updateMaxGameplayY
  //  :430608-430651, 1160667136 = 2790.0 at :430650]
  const stereo = await loadOfficialLevel(1);
  assert.equal(maxGameplayYFor(stereo), 2700, "a classic level takes the flat default");

  // Dash and the four tower floors are the only official levels that ask for
  // the taller ceiling, and the only ones whose art needs it.
  const dash = await loadOfficialLevel(22);
  const highest = dash.objects.reduce((m, o) => Math.max(m, o.y), -Infinity);
  assert.ok(highest > 2700, `Dash's art should reach above the default, got ${highest}`);
  assert.equal(maxGameplayYFor(dash), highest + 390, "Dash measures its own contents");
  assert.ok(maxGameplayYFor(dash) > highest, "and leaves room above the highest object");

  // The test is usesYSections, a platformer or kA37; Dash and the tower
  // floors carry kA27 too, but kA27 alone asks for nothing.
  // [shouldUseYSection :195727-195733; +361 = kA37 at :196285-196287]
  const tall = [{ id: 1, x: 15, y: 3000 }];
  assert.equal(maxGameplayYFor(buildLevel(tall, makeHeader({ allowMultiRotation: true }))), 2700, "kA27 alone: the flat default");
  assert.equal(maxGameplayYFor(buildLevel(tall, makeHeader({ ySections: true }))), 3390, "kA37: measured");
  assert.equal(maxGameplayYFor(buildLevel(tall, makeHeader({ platformer: true }))), 3390, "a platformer: measured");
});

test("a flipped cube in a mode with no corridor dies instead of rising for ever", async () => {
  const level = await loadOfficialLevel(1);
  // Straight up from the start under flipped gravity, with nothing in the way.
  const sim = makeSim(level, undefined, { start: { x: 0, y: 15, mode: "cube", flipped: true } });
  let top = -Infinity;
  for (let i = 0; i < 240 * 60 && !sim.state.dead; i++) {
    sim.step({ jump: false, left: false, right: false });
    top = Math.max(top, sim.state.y);
  }
  assert.ok(sim.state.dead, `the player should have died, got as high as ${top.toFixed(0)}`);
  assert.ok(top < 2700 + 60, `and it should die at the ceiling, not above it, got ${top.toFixed(0)}`);
});

// --- the corridor on the screen -------------------------------------------------

/** A cube that runs into a ship portal at (300, `portalY`), with `extra` placed first. */
function shipRun(portalY: number, extra: Placed[] = []): { sim: Sim; level: Level } {
  const level = emptyLevel([...extra, { id: SHIP_PORTAL, x: 300, y: portalY }]);
  const sim = makeSim(level, undefined, { noclip: true, start: { x: 270, y: portalY, mode: "cube" } });
  for (let i = 0; i < 60 && sim.state.mode !== "ship"; i++) sim.step(NO_INPUT);
  assert.equal(sim.state.mode, "ship", "the cube should have reached the portal");
  return { sim, level };
}

test("a corridor takes the camera's y: its middle becomes the static y, eased in over half a second", () => {
  // [gdp animateInDualGroundNew :451129-451137 → updateStaticCameraPos
  //  (y only, 0.5 s, easing 1 at rate 2) and +576]
  const { sim } = shipRun(315);
  const st = sim.triggers.camera.staticY;
  assert.equal(st.on, true);
  assert.equal(st.target, (sim.floorY + sim.ceilingY) / 2, "aimed at the band's middle");
  assert.equal(st.tween?.duration, 0.5);
  assert.deepEqual([sim.floorY, sim.ceilingY], [150, 450], "315 − 150 snapped down to 150, 300 tall");
});

test("a zoom stretches the corridor about its middle: the band is its height over the zoom", () => {
  // The layers are 300 apart on the screen, so at a zoom of 0.5 they hold 600
  // of the level. [gdp getMinPortalY :420455-420461, getMaxPortalY
  //  :420498-420501]
  const { sim } = shipRun(615, [{ id: 1913, x: 30, y: 600, props: { 371: "0.5", 10: "0" } }]);
  assert.equal(sim.triggers.camera.zoom, 0.5);
  assert.deepEqual([sim.floorY, sim.ceilingY], [300, 900], "615 − 150 snapped down to 450, so a middle of 600, and 300 each way");
});

test("under a Static Camera's y the corridor is measured about the camera, and its layers slide in", () => {
  // Dash's spider section: the camera holds y on its own guide, so the
  // corridor does not take it, and the band is read off the ground layers
  // on the screen. Before they have slid in they are at the view's bottom
  // and top edges, a unit out; once in, the band is 300 about the view's
  // middle, wherever the portal stood.
  // [gdp getMinPortalY :420462-420480, getMaxPortalY :420503-420507;
  //  updateCameraBGArt :431194-431213]
  const guide: Placed = { id: 1, x: 120, y: 405 };
  const level = emptyLevel([guide, { id: 1914, x: 60, y: 600, props: { 71: "4", 101: "2", 10: "0" } }, { id: SHIP_PORTAL, x: 300, y: 165 }]);
  level.objects[level.objects.length - 3].groups = [4];
  const sim = makeSim(level, undefined, { noclip: true, start: { x: 270, y: 165, mode: "cube" } });
  for (let i = 0; i < 60 && sim.state.mode !== "ship"; i++) sim.step(NO_INPUT);
  const st = sim.triggers.camera.staticY;
  assert.equal(sim.state.mode, "ship");
  assert.ok(st.on && st.target === 405, "the trigger holds y on its guide");
  // Fresh in, one step's slide from the view's edges: 405 − 160 − 1 and 405 + 160 + 1.
  assert.ok(Math.abs(sim.floorY - 244) < 0.1 && Math.abs(sim.ceilingY - 566) < 0.1, `the band starts at the view's edges, got ${sim.floorY}..${sim.ceilingY}`);
  for (let i = 0; i < 240; i++) sim.step(NO_INPUT);
  assert.ok(Math.abs(sim.floorY - 255) < 1e-3 && Math.abs(sim.ceilingY - 555) < 1e-3, `the band about the view's 405, got ${sim.floorY}..${sim.ceilingY}`);
});

test("the ground layers stand at the screen's edges when out and the corridor's height apart when in", () => {
  // [gdp updateCameraBGArt :431194-431213]
  assert.deepEqual(groundLayers(300, 0, 0, 569, 320), { floor: 0, ceiling: 320 });
  assert.deepEqual(groundLayers(300, 1, 0, 569, 320), { floor: 11, ceiling: 309 });
  const turned = groundLayers(300, 0, 4, 569, 320);
  assert.ok(turned.floor < 0 && turned.ceiling > 320, "a turned view starts them further out");
});
