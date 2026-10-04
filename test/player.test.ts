// The player's own sprites.
//
// The renderer is pure in the sense that matters here: given an icon file and a
// player state it produces instance bytes, with no GL involved, so a test can
// check that every mode actually draws something and that the layers land where
// the icon says. Which is the thing that goes wrong silently — a missing frame
// or an unbound page shows up as an invisible player rather than as an error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { IconSet } from "../src/assets/icons";
import type { IconFile } from "../src/assets/iconTypes";
import { PlayerRenderer } from "../src/render/player";
import { strongColor } from "../src/render/colors";
import { INSTANCE_FLOATS } from "../src/engine/gl/spriteBatch";
import type { GameMode } from "../src/level/types";
import type { PlayerState } from "../src/physics/types";
import { builtPath } from "./helpers";

const iconsPath = builtPath("assets/icons/icons.json");
const SKIP = existsSync(iconsPath) ? false : "run `npm run assets` first";

function loadIcons(): IconSet {
  const file = JSON.parse(readFileSync(iconsPath, "utf8")) as IconFile;
  // The constructor is private to TypeScript only; the alternative is a fetch.
  return new (IconSet as unknown as new (f: IconFile) => IconSet)(file);
}

function playerAt(mode: GameMode, extra: Partial<PlayerState> = {}): PlayerState {
  return {
    x: 300,
    y: 105,
    yVel: 0,
    xSpeed: 5.193,
    xVel: 0,
    mode,
    speed: 1,
    mini: false,
    flipped: false,
    mirrored: false,
    reversed: false,
    rotated: false,
    onGround: true,
    onSlope: false,
    lastGroundY: Number.NaN,
    rotation: 0,
    holding: false,
    holdTicks: -1,
    dashing: false,
    dashAngle: 0,
    dead: false,
    finished: false,
    killedBy: null,
    lastFlipTick: -1,
    orbReady: true,
    ...extra,
  };
}

/** Builds a renderer with the icon set attached but no animation data. */
function renderer(icons: IconSet): PlayerRenderer {
  const p = new PlayerRenderer();
  (p as unknown as { icons: IconSet }).icons = icons;
  return p;
}

function withPages(p: PlayerRenderer, mode: GameMode): number[] {
  const pages = p.pagesFor(mode);
  p.setUnits(new Map(pages.map((page, i) => [page, 11 + i])));
  return pages;
}

const MODES: GameMode[] = ["cube", "ship", "ball", "ufo", "wave", "robot", "spider", "swing"];

test("every mode draws something", { skip: SKIP }, () => {
  const p = renderer(loadIcons());
  for (const mode of MODES) {
    withPages(p, mode);
    const n = p.build(playerAt(mode), { r: 0, g: 255, b: 119 }, { r: 0, g: 187, b: 255 }, 0);
    assert.ok(n > 0, `${mode} drew nothing`);
  }
});

test("no mode needs more than the two icon pages there are units for", { skip: SKIP }, () => {
  const p = renderer(loadIcons());
  for (const mode of MODES) {
    const pages = p.pagesFor(mode);
    assert.ok(pages.length <= 2, `${mode} wants ${pages.length} pages`);
    assert.ok(pages.length > 0, `${mode} wants no pages at all`);
  }
});

test("a mode with no bound page draws nothing rather than sampling the wrong sheet", { skip: SKIP }, () => {
  const p = renderer(loadIcons());
  p.setUnits(new Map());
  assert.equal(p.build(playerAt("cube"), { r: 0, g: 255, b: 119 }, { r: 0, g: 187, b: 255 }, 0), 0);
});

test("a dead player is not drawn", { skip: SKIP }, () => {
  const p = renderer(loadIcons());
  withPages(p, "cube");
  assert.equal(p.build(playerAt("cube", { dead: true }), { r: 0, g: 255, b: 119 }, { r: 0, g: 187, b: 255 }, 0), 0);
});

test("the cube is a block wide and follows the two player colours", { skip: SKIP }, () => {
  const icons = loadIcons();
  const p = renderer(icons);
  withPages(p, "cube");
  const p1 = { r: 0, g: 255, b: 119 };
  const p2 = { r: 0, g: 187, b: 255 };
  const n = p.build(playerAt("cube"), p1, p2, 0);
  assert.ok(n >= 2, "the cube has a shape and a second colour");
  const bytes = new Uint8Array(p.data.buffer);
  // The first layer drawn is the shape, which carries colour 1 and is one
  // block across; the icon art is 121 px at 4 px per unit, a hair over 30.
  const hw = Math.abs(p.data[0]) + Math.abs(p.data[2]);
  assert.ok(Math.abs(hw - 15.125) < 0.01, `half width ${hw}`);
  assert.deepEqual([bytes[40], bytes[41], bytes[42]], [p1.r, p1.g, p1.b]);
  // And the second layer is the smaller inner square on colour 2.
  const second = INSTANCE_FLOATS * 4;
  assert.deepEqual([bytes[second + 40], bytes[second + 41], bytes[second + 42]], [p2.r, p2.g, p2.b]);
});

test("the outline wears the strengthened colour 2, and player 2's its own", { skip: SKIP }, () => {
  // [PlayerObject::updateGlowColor :146119-146173, the glow sprite
  //  :146248-146259]
  const p = renderer(loadIcons());
  withPages(p, "cube");
  p.glow = true;
  const first = { r: 0, g: 200, b: 100 };
  const second = { r: 100, g: 50, b: 0 };
  const bytes = new Uint8Array(p.data.buffer);
  const tints = (n: number) => Array.from({ length: n }, (_, i) => [40, 41, 42].map((k) => bytes[i * INSTANCE_FLOATS * 4 + k]));
  const strong2 = strongColor(second);
  const strong1 = strongColor(first);
  assert.deepEqual(tints(p.build(playerAt("cube"), first, second, 0)), [
    [strong2.r, strong2.g, strong2.b],
    [first.r, first.g, first.b],
    [second.r, second.g, second.b],
  ], "outline, shape, second layer");
  assert.deepEqual(tints(p.build(playerAt("cube"), second, first, 0))[0], [strong1.r, strong1.g, strong1.b], "player 2");
});

test("mini halves the player and gravity flips it", { skip: SKIP }, () => {
  const p = renderer(loadIcons());
  withPages(p, "cube");
  const colour = { r: 255, g: 255, b: 255 };
  p.build(playerAt("cube"), colour, colour, 0);
  const full = Math.abs(p.data[0]) + Math.abs(p.data[2]);
  p.build(playerAt("cube", { mini: true }), colour, colour, 0);
  const mini = Math.abs(p.data[0]) + Math.abs(p.data[2]);
  assert.ok(Math.abs(mini / full - 0.6) < 1e-6, `mini is ${mini / full} of full size`);
  // Flipped gravity mirrors the sprite vertically, which shows as a negative d.
  p.build(playerAt("cube", { flipped: true }), colour, colour, 0);
  assert.ok(p.data[3] < 0, "an upside-down player draws upside down");
});

test("a ship carries a cube, and it sits above the hull", { skip: SKIP }, () => {
  const p = renderer(loadIcons());
  withPages(p, "ship");
  const colour = { r: 255, g: 255, b: 255 };
  const n = p.build(playerAt("ship"), colour, colour, 0);
  assert.ok(n >= 3, "the hull's layers plus the rider");
  // The hull drops 5 units and the rider sits 5 up, both from toggleFlyMode.
  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = p.data[i * INSTANCE_FLOATS + 5];
    if (y < lowest) lowest = y;
    if (y > highest) highest = y;
  }
  assert.ok(highest - lowest > 5, `the rider should sit clear of the hull, got ${highest - lowest}`);
});
