// The renderer's pure parts: where a frame lands, and what colour it ends up.
// Both run without a browser, which is the point of keeping them pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Atlas, AtlasFrame } from "../src/assets/atlasTypes";
import { frameQuad, quadUv } from "../src/render/frameQuad";
import { ColorTable, applyHsv, hsvToRgb, lightBackgroundColor, rgbToHsv } from "../src/render/colors";
import { BACKGROUND_SPEED, BackdropDrift, SceneryRenderer, backdropPlacement, backgroundScale, middlegroundBaseY, middlegroundFoot, middlegroundScale } from "../src/render/scenery";
import { Camera } from "../src/render/camera";
import { BLEND, blendAdds } from "../src/engine/gl/spriteBatch";
import type { ColorChannel, HsvShift, LevelHeader, LevelObject } from "../src/level/types";
import { affine, apply, compose, lerpAngle, wrapDegrees } from "../src/engine/math";
import { existsSync, readFileSync } from "node:fs";
import type { ObjectRecord } from "../src/assets/objectTypes";
import {
  animMemo,
  animTimingFor,
  hash01,
  nextSkeletonClip,
  objectAnimationFor,
  randomFrameFor,
  skeletonFor,
  skeletonFrame,
  startSkeleton,
  syncedFrame,
  type AnimTiming,
} from "../src/render/anim";
import type { AnimEntity } from "../src/assets/anims";
import { GAME_ANIMATIONS } from "../src/assets/gameAnimations";
import { TrailRenderer } from "../src/render/trail";
import { HardStreak, StreakBlend, bandPulse, strokeCorners } from "../src/render/hardStreak";
import { GhostTrail, type GhostPlayer } from "../src/render/ghostTrail";
import type { PlayerRenderer } from "../src/render/player";
import type { EffectQuad } from "../src/render/effects";
import { PlayerParticles, defFromPlist, facingOf } from "../src/render/playerParticles";
import { ENTER, enterAngle, enterCode, enterFades, enterPose, enterProgress } from "../src/render/enterEffects";
import type { ParticleFile } from "../src/assets/miscTypes";
import type { PlayerState } from "../src/physics/types";
import { builtPath } from "./helpers";

const sheet: Atlas = { name: "test", image: "test.png", w: 1000, h: 500, frames: [] };

/** Texture coordinates are divisions, so they land a float tick off exactly. */
function sameUv(got: { u: number; v: number }, u: number, v: number, what = ""): void {
  assert.ok(Math.abs(got.u - u) < 1e-9 && Math.abs(got.v - v) < 1e-9, `${what} got ${got.u},${got.v} want ${u},${v}`);
}

test("an upright frame lands where the 2D view puts it", () => {
  // A plain 30-unit block at uhd: 120 px square, untrimmed.
  const frame: AtlasFrame = { n: "square.png", x: 40, y: 80, w: 120, h: 120 };
  const q = frameQuad(sheet, frame, 4);
  assert.deepEqual({ cx: q.cx + 0, cy: q.cy + 0, hw: q.hw, hh: q.hh }, { cx: 0, cy: 0, hw: 15, hh: 15 });
  sameUv(quadUv(q, 0, 0), 0.04, 0.16, "top left");
  sameUv(quadUv(q, 1, 1), 0.16, 0.4, "bottom right");
});

test("a trimmed frame keeps its place inside the untrimmed box", () => {
  // 40 px of the sprite's top was cut away, so the region sits low in its box.
  const frame: AtlasFrame = { n: "trim.png", x: 0, y: 0, w: 80, h: 40, tx: 20, ty: 40, sw: 120, sh: 120 };
  const q = frameQuad(sheet, frame, 4);
  // x: 20 + 40 - 60 = 0 px from centre; y: -(40 + 20 - 60) = 0 px. Dead centre
  // horizontally, and the vertical trim is symmetric here by construction.
  // Node's strict equality separates -0 from 0, which is noise here.
  assert.equal(q.cx + 0, 0);
  assert.equal(q.cy + 0, 0);
  assert.equal(q.hw, 10);
  assert.equal(q.hh, 5);
});

test("a rotated frame occupies the same quad and only reads the sheet differently", () => {
  const upright: AtlasFrame = { n: "a.png", x: 100, y: 200, w: 60, h: 180 };
  const turned: AtlasFrame = { ...upright, r: 1 };
  const a = frameQuad(sheet, upright, 4);
  const b = frameQuad(sheet, turned, 4);
  assert.deepEqual([a.cx, a.cy, a.hw, a.hh], [b.cx, b.cy, b.hw, b.hh], "the destination must not move");
  assert.equal(b.rotated, true);
  // The region runs h across and w down, so the corners swap axes: the top left
  // of the sprite is the top right of the stored region.
  sameUv(quadUv(b, 0, 0), (100 + 180) / 1000, 200 / 500, "top left");
  sameUv(quadUv(b, 1, 0), (100 + 180) / 1000, (200 + 60) / 500, "top right");
  sameUv(quadUv(b, 0, 1), 100 / 1000, 200 / 500, "bottom left");
});

test("a turn is clockwise, the way the game stores rotation", () => {
  // 90 degrees clockwise takes +x to -y in a y-up space.
  const m = affine(0, 0, 90, 1, 1);
  const p = apply(m, 1, 0);
  assert.ok(Math.abs(p.x) < 1e-9 && Math.abs(p.y + 1) < 1e-9, `got ${p.x},${p.y}`);
});

test("a child transform composes inside its parent", () => {
  const parent = affine(100, 50, 0, 2, 2);
  const child = affine(5, 0, 0, 1, 1);
  const p = apply(compose(parent, child), 0, 0);
  assert.deepEqual({ x: p.x, y: p.y }, { x: 110, y: 50 }, "the parent's scale applies to the child's offset");
});

test("angles interpolate the short way round", () => {
  assert.equal(wrapDegrees(370), 10);
  assert.equal(lerpAngle(350, 10, 0.5), 360);
  assert.equal(lerpAngle(10, 350, 0.5), 0);
});

test("hue, saturation and value survive a round trip", () => {
  for (const c of [
    { r: 40, g: 62, b: 255 },
    { r: 255, g: 255, b: 255 },
    { r: 0, g: 0, b: 0 },
    { r: 17, g: 200, b: 99 },
  ]) {
    const { h, s, v } = rgbToHsv(c.r, c.g, c.b);
    assert.deepEqual(hsvToRgb(h, s, v), c);
  }
});

test("an unchecked shift multiplies rather than adds", () => {
  const red = { r: 255, g: 0, b: 0 };
  const unchanged: HsvShift = { h: 0, s: 1, v: 1, sChecked: false, vChecked: false };
  assert.deepEqual(applyHsv(red, unchanged), red, "s = 1, v = 1 has to mean 'leave it alone'");
  const darker: HsvShift = { h: 0, s: 1, v: 0.5, sChecked: false, vChecked: false };
  // 127, not 128: the game converts back with a C cast, which truncates.
  assert.deepEqual(applyHsv(red, darker), { r: 127, g: 0, b: 0 });
  const hue: HsvShift = { h: 120, s: 1, v: 1, sChecked: false, vChecked: false };
  assert.deepEqual(applyHsv(red, hue), { r: 0, g: 255, b: 0 });
});

// --- the channel table -------------------------------------------------------

function header(channels: Partial<ColorChannel>[]): LevelHeader {
  const colors = new Map<number, ColorChannel>();
  for (const c of channels) {
    const full: ColorChannel = {
      id: 0,
      r: 0,
      g: 0,
      b: 0,
      opacity: 1,
      blending: false,
      copyId: 0,
      copyHsv: null,
      copyOpacity: false,
      playerColor: 0,
      ...c,
    };
    colors.set(full.id, full);
  }
  return {
    startMode: "cube",
    startSpeed: 1,
    startMini: false,
    startDual: false,
    startFlipped: false,
    startReversed: false,
    startRotated: false,
    spawnGroup: 0,
    twoPlayer: false,
    platformer: false,
    playerSqueeze: false,
    fixGravityBug: false,
    fixRobotJump: false,
    enable22Changes: false,
    sortAllGroupsX: false,
    ySections: false,
    fixRadiusCollision: false,
    allowMultiRotation: true,
    allowStaticRotate: true,
    reverseSync: false,
    fixNegativeScale: true,
    lengthSteps: 0,
    decreaseBoostSlide: false,
    leftStopAlways: false,
    noLeftStop: false,
    songOffset: 0,
    fadeIn: false,
    fadeOut: false,
    background: 1,
    ground: 1,
    groundLine: 0,
    font: 0,
    guidelines: [],
    colors,
    raw: {},
  };
}

test("a channel that copies another follows it through the chain", () => {
  const table = ColorTable.resolve(
    header([
      { id: 1, r: 255, g: 0, b: 0 },
      { id: 2, copyId: 1 },
      { id: 3, copyId: 2, copyHsv: { h: 180, s: 1, v: 1, sChecked: false, vChecked: false } },
    ]),
  );
  assert.deepEqual(pick(table.get(1)), { r: 255, g: 0, b: 0 });
  assert.deepEqual(pick(table.get(2)), { r: 255, g: 0, b: 0 });
  assert.deepEqual(pick(table.get(3)), { r: 0, g: 255, b: 255 }, "half a turn of hue from red is cyan");
  assert.deepEqual(table.cycles, []);
});

test("a ring of copies is broken and reported rather than hanging", () => {
  const table = ColorTable.resolve(header([{ id: 5, r: 10, g: 20, b: 30, copyId: 6 }, { id: 6, copyId: 5 }]));
  assert.ok(table.cycles.length > 0, "the loop should be named");
  // The game refuses to link a channel whose copy would close a ring, so the
  // channel is left holding its own authored colour rather than a placeholder.
  assert.deepEqual(pick(table.get(5)), { r: 10, g: 20, b: 30 });
});

test("the black channel is black before anyone says otherwise", () => {
  const table = ColorTable.resolve(header([]));
  assert.deepEqual(pick(table.get(1010)), { r: 0, g: 0, b: 0 });
  assert.deepEqual(pick(table.get(1004)), { r: 255, g: 255, b: 255 });
});

test("opacity and the additive flag come through", () => {
  const table = ColorTable.resolve(header([{ id: 7, r: 10, g: 20, b: 30, opacity: 0.5, blending: true }]));
  const c = table.get(7);
  assert.equal(c.a, 0.5);
  assert.equal(c.blending, true);
});

function pick(c: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  return { r: c.r, g: c.g, b: c.b };
}

// --- the backdrop ------------------------------------------------------------

test("the background starts at the screen's foot and moves a tenth of the camera's step the other way", () => {
  // Each step the camera's move times the speed and the zoom, wrapped across
  // by a tile. [gdp updateCameraBGArt :431053-431113; resetLevelVariables
  //  :462922 (0.1, 0.1)]
  const drift = new BackdropDrift();
  assert.deepEqual([drift.x, drift.y], [0, 0]);
  drift.step(50, 100, 1, BACKGROUND_SPEED.x, BACKGROUND_SPEED.y, 600);
  assert.deepEqual([drift.x, drift.y], [-5, -10]);
  drift.step(0, 100, 0.5, BACKGROUND_SPEED.x, BACKGROUND_SPEED.y, 600);
  assert.equal(drift.y, -15, "the zoom scales the move");
  drift.step(6000, 0, 1, BACKGROUND_SPEED.x, BACKGROUND_SPEED.y, 600);
  assert.ok(drift.x <= 0 && drift.x > -600, "across it wraps by a tile");
});

test("the background is scaled to the window by the larger of its design factors", () => {
  // [AppDelegate::bgScale → getScreenScaleFactorMax, updateScreenScale
  //  :801160-801170]
  assert.ok(Math.abs(backgroundScale(569, 320) - 569 / 480) < 1e-12, "1.185 at 16:9");
  assert.equal(backgroundScale(480, 360), 360 / 320, "a 4:3 window keeps the width and grows taller");
});

test("the background's tile is placed from the screen through the zoom", () => {
  const b = backdropPlacement(512, 512, 100, -90, 0.5, 1.2, { x: -30, y: -10 });
  assert.deepEqual(b, { width: 1228.8, height: 1228.8, x: 40, y: -110 });
});

test("the middleground stands on its own base, climbs half as fast as the camera and is 1.2 times its art", () => {
  // The base was the floor line, 90, where the game's table says 25 or 30:
  // the middleground stood 60 too high in the 4 % screenshot.
  // [gdp updateCameraBGArt :431122-431149; GJMGLayer::defaultYOffsetForBG2
  //  :382677-382686]
  assert.deepEqual([0, 1, 2, 3, 4].map(middlegroundBaseY), [0, 25, 30, 30, 0]);
  assert.equal(middlegroundFoot(30, 0, 1, 0), 30, "the base, with the view's foot on the game's 0");
  assert.equal(middlegroundFoot(30, 0, 1, 100), -20, "100 up, half of it comes off");
  assert.equal(middlegroundFoot(30, 24, 1, 0), 54, "the MG trigger lifts it");
  assert.equal(middlegroundScale(1), 1.2);
  assert.ok(Math.abs(middlegroundScale(0.5) - 1.2 * 0.85) < 1e-12);
});

test("a level cannot recolour the reserved black and white channels", () => {
  // Fingerdash, Dash and the Towers all write rgb(255,255,255) into 1010, the
  // default main colour of the objects that are black by default (the beasts,
  // the sludge, the newer blades); the game ignores the write and so must this.
  const table = ColorTable.resolve(
    header([
      { id: 1010, r: 255, g: 255, b: 255 },
      { id: 1011, r: 12, g: 34, b: 56 },
    ]),
  );
  assert.deepEqual(pick(table.get(1010)), { r: 0, g: 0, b: 0 }, "the black channel stays black");
  assert.deepEqual(pick(table.get(1011)), { r: 255, g: 255, b: 255 }, "and the white one stays white");
});

test("a reserved channel can still be faded or made additive", () => {
  const table = ColorTable.resolve(header([{ id: 1010, r: 255, g: 255, b: 255, opacity: 0.25, blending: true }]));
  const c = table.get(1010);
  assert.deepEqual(pick(c), { r: 0, g: 0, b: 0 });
  assert.equal(c.a, 0.25);
  assert.equal(c.blending, true);
});

test("the light background channel is derived from the background, not authored", () => {
  const p1 = { r: 0, g: 255, b: 119 };
  // A mid-tone background: desaturated a fifth, brightened a fifth, no player mix.
  const mid = lightBackgroundColor({ r: 100, g: 100, b: 200 }, p1);
  assert.ok(mid.r > 100 && mid.g > 100, `expected a lift, got ${JSON.stringify(mid)}`);
  // Pure black sits at the far end of the dark clause: exactly the player colour.
  assert.deepEqual(lightBackgroundColor({ r: 0, g: 0, b: 0 }, p1), p1);
  // The dark clause is a threshold, not a feeling: Fingerdash's background is
  // (93, 0, 78), which sums to 171 and so sits just ABOVE it — it gets the plain
  // lift and no player mix at all.
  const fingerdash = lightBackgroundColor({ r: 93, g: 0, b: 78 }, p1);
  assert.deepEqual(fingerdash, { r: 144, g: 28, b: 125 });
  // One that really is under the line pulls most of the way to the player.
  const veryDark = lightBackgroundColor({ r: 10, g: 0, b: 10 }, p1);
  assert.ok(veryDark.g > 200, `expected the player's green to dominate, got ${JSON.stringify(veryDark)}`);
});

test("a level cannot author the light background channel", () => {
  const table = ColorTable.resolve(
    header([
      { id: 1000, r: 0, g: 0, b: 0 },
      { id: 1007, r: 255, g: 255, b: 255 },
    ]),
  );
  assert.notDeepEqual(pick(table.get(1007)), { r: 255, g: 255, b: 255 }, "the header's value must be ignored");
});

// --- frame animations --------------------------------------------------------
// The game's own table says how many frames an animated object has, how long
// each lasts and which frame families its sprites play; updateSyncedAnimation
// says which frame shows when. Both are pinned here: the table against the
// decompile, the clock against the frames the game's arithmetic lands on.

const OBJECTS = builtPath("assets/objects.json");
const ATLAS = builtPath("assets/atlas/uhd.json");
const ASSETS = existsSync(OBJECTS) && existsSync(ATLAS) ? false : "run `npm run assets` first";

function objectTable(): Record<string, ObjectRecord> {
  return (JSON.parse(readFileSync(OBJECTS, "utf8")) as { objects: Record<string, ObjectRecord> }).objects;
}

function atlasNames(): Set<string> {
  const file = JSON.parse(readFileSync(ATLAS, "utf8")) as { frames: Record<string, unknown> };
  return new Set(Object.keys(file.frames));
}

/** An object as the level string gives it, for the timing tests. */
function animated(id: number, props: Record<number, string> = {}, index = 7): LevelObject {
  return {
    index,
    id,
    x: 0,
    y: 0,
    rotation: 0,
    flipX: false,
    flipY: false,
    scaleX: 1,
    scaleY: 1,
    groups: [],
    zLayer: null,
    zOrder: null,
    baseColor: null,
    detailColor: null,
    legacyColor: null,
    baseHsv: null,
    detailHsv: null,
    editorLayer: null,
    props: { 1: String(id), ...props },
    settings: null,
  };
}

const everyFrame = (): boolean => true;

function timingOf(id: number, props: Record<number, string> = {}): AnimTiming {
  const animation = objectAnimationFor(id, everyFrame);
  assert.ok(animation, `${id} should animate`);
  return animTimingFor(animated(id, props), animation);
}

test("the animation table is the game's: frame counts, times and families", () => {
  // [GameManager::setupGameAnimations :622973-624650]
  assert.deepEqual(GAME_ANIMATIONS.get(1936), { frames: 13, time: 0.07, name: "fire_b_01", color: "fire_b_01_2" });
  assert.deepEqual(GAME_ANIMATIONS.get(2041), { frames: 12, time: 0.05, name: "gj22_anim_22", color: null });
  assert.equal(GAME_ANIMATIONS.get(2047)?.time, 0.04);
  assert.equal(GAME_ANIMATIONS.get(-142)?.name, "secretCoin_b_01", "the collected coin's look");
  assert.equal(GAME_ANIMATIONS.size, 135);
  // 1583 plays 1, 2, 3, 2: the custom frame goes in at 4 and the cycle is four long.
  const fireball = objectAnimationFor(1583, everyFrame);
  assert.deepEqual(
    fireball?.framesFor("fireball_02_001.png", false)?.map((a) => a.f),
    ["fireball_02_001.png", "fireball_02_002.png", "fireball_02_003.png", "fireball_02_002.png"],
  );
  assert.deepEqual(
    fireball?.framesFor("fireball_02_color_001.png", true)?.map((a) => a.f).slice(3),
    ["fireball_02_color_002.png"],
  );
});

test("a sprite plays the family its resting frame belongs to", () => {
  const anim = objectAnimationFor(2047, everyFrame);
  assert.equal(anim?.framesFor("gj22_anim_28_011.png", false)?.length, 11, "the main sprite, resting on frame 11");
  assert.equal(anim?.framesFor("gj22_anim_28_color_001.png", false)?.[4].f, "gj22_anim_28_color_005.png");
  assert.equal(anim?.framesFor("something_else_001.png", false), null);
  // 1592: the two families are one, and the colour plays back and forth. [:621319-621339]
  const square = objectAnimationFor(1592, everyFrame);
  const numbers = (detail: boolean): string[] | undefined => square?.framesFor("d_animSquare_01_001.png", detail)?.map((a) => a.f.slice(-7, -4));
  assert.deepEqual(numbers(false), ["001", "002", "003", "004", "005", "006", "007", "008"]);
  assert.deepEqual(numbers(true), ["001", "008", "007", "006", "005", "004", "003", "002"]);
  // The wave strips show half their frames mirrored. [:621213-621287]
  const wave = objectAnimationFor(1050, everyFrame)?.framesFor("d_animWave_01_001.png", true);
  assert.deepEqual(wave?.[3], { f: "d_animWave_01_003.png", flip: true });
  assert.deepEqual(wave?.[5], { f: "d_animWave_01_006.png", flip: false });
  // A family with a frame missing is not played at all.
  assert.equal(objectAnimationFor(2041, (n) => !n.endsWith("_012.png"))?.framesFor("gj22_anim_22_001.png", false) ?? null, null);
  // The special animations that are not transcribed hold still.
  assert.equal(objectAnimationFor(1839, everyFrame), null);
});

test("a plain cycle: the level time in frame times, round and round", () => {
  // 2041: 12 frames at 0.05 s. [updateSyncedAnimation :620727-620745]
  const s = { ...timingOf(2041), interval: Math.fround(0.05) };
  assert.equal(syncedFrame(s, 0.12), 2, "frame 3");
  assert.equal(syncedFrame(s, 0.57), 11, "frame 12");
  assert.equal(syncedFrame(s, 0.61), 0, "frame 1 again");
});

test("keys 122 and 107 set the speed, and a negative one plays backwards", () => {
  const s = timingOf(2041, { 122: "1", 107: "-2" });
  assert.equal(s.reverse, true);
  assert.ok(Math.abs(s.interval - 0.025) < 1e-7);
  assert.equal(syncedFrame(s, 0.06), 9, "frame 10: twelve less two");
  // Key 107 without key 122 does nothing.
  assert.equal(timingOf(2041, { 107: "-2" }).reverse, false);
  // The fire and 2.2 sets roll a speed of their own, 0.8-1.2; the wave strips do not.
  const fire = timingOf(1936);
  assert.ok(fire.interval >= 0.07 / 1.2 - 1e-6 && fire.interval <= 0.07 / 0.8 + 1e-6, `fire runs at 0.8-1.2: ${fire.interval}`);
  assert.equal(timingOf(1050).interval, Math.fround(0.05));
});

test("key 462 pins a frame, and with key 592 shifts the cycle by it", () => {
  const pinned = { ...timingOf(2041, { 462: "3" }), interval: Math.fround(0.05) };
  for (const t of [0, 0.13, 7.77]) assert.equal(syncedFrame(pinned, t), 2);
  const shifted = { ...timingOf(2041, { 462: "3", 592: "1" }), interval: Math.fround(0.05) };
  assert.equal(syncedFrame(shifted, 0.12), 5, "frame 6");
});

test("in play every copy runs in step, key 106 or not; only the editor keeps the offsets it loads with", () => {
  // The reset before the first frame, and every restart and respawn, clears
  // the start offset customSetup and saveActiveColors roll at load.
  // [PlayLayer::setupHasCompleted :106465 → resetLevel :105839-105843 →
  //  EnhancedGameObject::resetObject :170043-170067; saveActiveColors
  //  :173339-173351]
  assert.equal(timingOf(2041).startOffset, 0);
  const wave = objectAnimationFor(1050, everyFrame);
  const fire = objectAnimationFor(1936, everyFrame);
  assert.ok(wave && fire);
  const inPlay = [1, 2, 3, 4, 5, 6].map((i) => animTimingFor(animated(1050, { 106: "1" }, i), wave).startOffset);
  assert.deepEqual(inPlay, [0, 0, 0, 0, 0, 0]);
  assert.equal(animTimingFor(animated(1936, { 106: "1" }), fire).startOffset, 0);
  const editor = [1, 2, 3, 4, 5, 6].map((i) => animTimingFor(animated(1050, { 106: "1" }, i), wave, true).startOffset);
  assert.ok(editor.every((o) => o >= 0 && o < 1));
  assert.ok(new Set(editor).size > 3, "in the editor different objects start at different points");
});

test("an object on an Animate trigger is hidden until one, plays once and hides again", () => {
  // 2047 with keys 123, 122 and 107 0.6, as Dash places it.
  const s = timingOf(2047, { 123: "1", 122: "1", 107: "0.6" });
  assert.equal(s.onTrigger, true);
  assert.equal(s.freeze, true);
  for (const t of [0, 1, 4.99]) assert.equal(syncedFrame(s, t), -1, "no trigger yet");
  assert.equal(syncedFrame(s, 4, 5), -1, "a trigger that has not happened yet");
  assert.equal(syncedFrame(s, 5.0, 5), 0);
  assert.equal(syncedFrame(s, 5.1, 5), 1);
  assert.equal(syncedFrame(s, 5.7, 5), 10, "the last of its 11 frames");
  assert.equal(syncedFrame(s, 5.74, 5), -1, "the blank slot after it");
  assert.equal(syncedFrame(s, 9, 5), -1, "and it waits for the next trigger");
  assert.equal(syncedFrame(s, 9.05, 9), 0, "which starts it over");
});

test("a freeze loop hides in the slot after its last frame for a random 0.2-0.7 s", () => {
  // 2047 without key 123: 11 frames at 0.04 s and one blank slot.
  const s = { ...timingOf(2047), interval: Math.fround(0.04) };
  assert.equal(s.freeze, true);
  assert.equal(syncedFrame(s, 0.01), 0);
  assert.equal(syncedFrame(s, 0.43), 10);
  assert.equal(syncedFrame(s, 0.45), -1, "the blank slot");
  const pause = 0.2 + 0.5 * hash01(s.seed, 1);
  assert.ok(pause >= 0.2 && pause < 0.7);
  assert.equal(syncedFrame(s, 0.47 + pause), -1, "the pause, then the rest of the blank slot");
  assert.equal(syncedFrame(s, 0.49 + pause), 0, "frame 1 of the next loop");
  // Asking again and again (with a memo) gives what asking once does.
  const memo = animMemo();
  for (let t = 0; t < 30; t += 1 / 60) {
    assert.equal(syncedFrame(s, t, Number.NaN, memo), syncedFrame(s, t), `t ${t}`);
  }
  // Key 126 turns the pause off: a plain cycle of 11.
  const plain = { ...timingOf(2047, { 126: "1" }), interval: Math.fround(0.04) };
  assert.equal(plain.freeze, false);
  assert.equal(syncedFrame(plain, 0.45), 0);
});

test("lava plays its surface, and 1591 rolls a bubble now and then", () => {
  const surface = objectAnimationFor(1593, everyFrame);
  assert.ok(surface?.lava);
  assert.equal(surface.framesFor("lava_top_001.png", false)?.[0].f, "lava_top_001.png");
  assert.equal(surface.framesFor("lava_top_color_001.png", true)?.[8].f, "lava_top_bubble_color_001.png");
  const loops = animTimingFor(animated(1593), surface);
  for (let t = 0; t < 20; t += 0.37) assert.ok(syncedFrame(loops, t) < 8, "1593 never leaves the surface");
  const bubbling = objectAnimationFor(1591, everyFrame);
  assert.ok(bubbling);
  const rolls = animTimingFor(animated(1591), bubbling);
  // In play the reset clears the surface customSetup presets, so the first
  // play is rolled like the rest; the editor's is the surface.
  // [customSetup :182709-182710; resetObject :170043-170067 (+1240);
  //  updateSyncedAnimation :621440-621455]
  const firsts = Array.from({ length: 40 }, (_, i) => syncedFrame(animTimingFor(animated(1591, {}, i), bubbling), 0.01));
  assert.ok(firsts.some((k) => k === 0) && firsts.some((k) => k >= 8), `first plays: ${firsts.join(" ")}`);
  for (let i = 0; i < 40; i++) {
    assert.equal(syncedFrame(animTimingFor(animated(1591, {}, i), bubbling, true), 0.01), 0, "the editor's first play is the surface");
  }
  const seen = new Set<number>();
  const memo = animMemo();
  for (let t = 0; t < 60; t += 0.05) {
    const k = syncedFrame(rolls, t, Number.NaN, memo);
    seen.add(k < 8 ? 0 : k < 16 ? 1 : 2);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2], "all three plays turn up in a minute");
});

test("every animated id the levels place resolves to frames that exist", { skip: ASSETS }, () => {
  const objects = objectTable();
  const names = atlasNames();
  const has = (n: string): boolean => names.has(n);
  const unplaced: number[] = [];
  let resolved = 0;
  for (const [id, entry] of GAME_ANIMATIONS) {
    const record = objects[String(id)];
    if (!record || entry.frames <= 1) continue;
    const anim = objectAnimationFor(id, has);
    if (!anim) continue;
    const resting: { f: string; detail: boolean }[] = [];
    if (record.f) resting.push({ f: record.f, detail: record.ct === "D" });
    const walk = (children: ObjectRecord["ch"]): void => {
      for (const c of children ?? []) {
        resting.push({ f: c.f, detail: c.ct === "D" });
        walk(c.ch);
      }
    };
    walk(record.ch);
    const played = resting.map((r) => anim.framesFor(r.f, r.detail)).filter((l) => l !== null);
    if (played.length === 0) unplaced.push(id);
    else resolved++;
    for (const list of played) for (const a of list ?? []) assert.ok(names.has(a.f), `${id}: ${a.f} is not in the atlas`);
  }
  assert.deepEqual(unplaced, [], "animations that reach none of the object's sprites");
  assert.ok(resolved > 100, `only ${resolved} animations resolved`);
});

test("a random frame is stable for an object and varies between neighbours", () => {
  const choices = ["a.png", "b.png", "c.png"];
  assert.equal(randomFrameFor(choices, 7), randomFrameFor(choices, 7), "the same object picks the same frame twice");
  const run = Array.from({ length: 24 }, (_, i) => randomFrameFor(choices, i));
  assert.equal(new Set(run).size, 3, "a row of objects should use every variant");
  let repeats = 0;
  for (let i = 1; i < run.length; i++) if (run[i] === run[i - 1]) repeats++;
  assert.ok(repeats < run.length / 2, `neighbours repeat ${repeats} times out of ${run.length - 1}`);
});

// --- the player's streak -----------------------------------------------------
// A ribbon of quads, one per segment, each turned to face along itself. The
// arithmetic is what decides whether a streak follows the player or smears
// across the screen, and none of it needs a browser.

const STREAK: EffectQuad = { u0: 0.1, v0: 0.2, du: 0.01, dv: 0.02, unit: 13, w: 32, h: 32 };
const BLUE = { r: 0, g: 187, b: 255 };

function trailOf(points: Array<[number, number, number]>, on = true): TrailRenderer {
  const trail = new TrailRenderer();
  for (const [x, y, t] of points) trail.track(x, y, t, on);
  return trail;
}

test("a straight run lays one quad per segment, along the segment", () => {
  const trail = trailOf([
    [0, 100, 0],
    [20, 100, 0.05],
    [40, 100, 0.1],
  ]);
  const n = trail.build(STREAK, BLUE, 0.1, false);
  assert.equal(n, 2, "two gaps between three points");
  // First quad: centred between the first pair, pointing along +x.
  const d = trail.data;
  assert.ok(Math.abs(d[4] - 10) < 1e-6, `centre x ${d[4]}`);
  assert.ok(Math.abs(d[5] - 100) < 1e-6, `centre y ${d[5]}`);
  assert.ok(Math.abs(d[0] - 10) < 1e-6, "half-length should be half the gap");
  assert.ok(Math.abs(d[1]) < 1e-6, "a horizontal segment has no vertical component");
  assert.ok(Math.abs(d[2]) < 1e-6, "the across vector is perpendicular");
  assert.ok(d[3] > 0, "the across vector has width");
});

test("a diagonal segment turns the quad to match", () => {
  const trail = trailOf([
    [0, 0, 0],
    [30, 30, 0.05],
  ]);
  trail.build(STREAK, BLUE, 0.05, false);
  const d = trail.data;
  // Along and across must be perpendicular and the along vector must point up-right.
  const dot = d[0] * d[2] + d[1] * d[3];
  assert.ok(Math.abs(dot) < 1e-6, `along and across are not perpendicular (dot ${dot})`);
  assert.ok(d[0] > 0 && d[1] > 0, "the segment runs up and to the right");
});

test("the tail fades and the head does not", () => {
  const trail = trailOf([
    [0, 0, 0],
    [20, 0, 0.1],
    [40, 0, 0.2],
    [60, 0, 0.3],
  ]);
  const n = trail.build(STREAK, BLUE, 0.3, false);
  assert.ok(n >= 2, `expected several segments, got ${n}`);
  const bytes = new Uint8Array(trail.data.buffer);
  const oldest = bytes[43];
  const newest = bytes[(n - 1) * 48 + 43];
  assert.ok(newest > oldest, `the head (${newest}) should be brighter than the tail (${oldest})`);
});

test("the streak adds as the game's CCMotionStreak does, or covers by the same weights", () => {
  // Its colour goes to GL as it is with the fade as alpha, on premultiplied
  // art, under GL_SRC_ALPHA with GL_ONE or GL_ONE_MINUS_SRC_ALPHA.
  // [PlayerObject::setupStreak :160763-160818; updateStreakBlend
  //  :141933-141951]
  const trail = trailOf([
    [0, 0, 0],
    [20, 0, 0.1],
    [40, 0, 0.2],
  ]);
  const blends = (additive: boolean): number[] => {
    const n = trail.build(STREAK, BLUE, 0.2, additive);
    const bytes = new Uint8Array(trail.data.buffer);
    return Array.from({ length: n }, (_, i) => bytes[i * 48 + 46]);
  };
  assert.deepEqual(blends(true), [BLEND.ADD_PARTICLE, BLEND.ADD_PARTICLE]);
  assert.deepEqual(blends(false), [BLEND.COVER_STRAIGHT, BLEND.COVER_STRAIGHT]);
  assert.equal(blendAdds(BLEND.COVER_STRAIGHT), false, "it covers");
});

// --- the wave's band ----------------------------------------------------------
// HardStreak: a point wherever the wave turns, the player as the head, and one
// four-cornered polygon per pair, built the way updateStroke builds it.

const FLAT: EffectQuad = { u0: 0.5, v0: 0.5, du: 0.01, dv: 0.01, unit: 13, w: 4, h: 4 };
const GREEN = { r: 0, g: 255, b: 119 };
const WIDE_VIEW = { x0: -1e6, x1: 1e6 };

/** The pulse with nothing to follow, as in practice. */
const PULSE = 0.5;

/** A wave run through `path`, one point a tick. */
function bandOf(path: Array<[number, number]>, opts: { additive?: boolean; scale?: number; view?: { x0: number; x1: number } } = {}): HardStreak {
  const band = new HardStreak();
  path.forEach(([x, y], i) => band.track({ x, y, laying: true, reversed: false }, i / 240, opts.view ?? WIDE_VIEW, opts.scale ?? 1, opts.additive ?? true, GREEN));
  return band;
}

/** `n` ticks of travel from `x`,`y` by `dx`,`dy` each, after the start point. */
function leg(x: number, y: number, dx: number, dy: number, n: number): Array<[number, number]> {
  return Array.from({ length: n }, (_, i): [number, number] => [x + dx * (i + 1), y + dy * (i + 1)]);
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

test("the wave's band has a point only where the wave turns", () => {
  // Up for ten ticks, then down for ten: one turn, so two segments, each a
  // band and a core. [PlayerObject::placeStreakPoint :148159-148189]
  const path: Array<[number, number]> = [[0, 0], ...leg(0, 0, 2.5, 2.5, 10), ...leg(25, 25, 2.5, -2.5, 10)];
  const band = bandOf(path);
  assert.equal(band.build(FLAT, 20 / 240, PULSE), 4, "two bands, then two cores");
  const straight = bandOf([[0, 0], ...leg(0, 0, 2.5, 2.5, 20)]);
  assert.equal(straight.build(FLAT, 20 / 240, PULSE), 2, "a straight run is one segment however long");
});

test("a bend in the band closes on its outside and overlaps on its inside", () => {
  // The band's corner on the outside of the bend is pushed out to meet the
  // next segment's; the inside ones cross. [updateStroke :389454-389593]
  const up = strokeCorners({ x: -10, y: -10 }, { x: 0, y: 0 }, 6, false, false, false);
  const down = strokeCorners({ x: 0, y: 0 }, { x: 10, y: -10 }, 6, false, true, false);
  assert.ok(near(up[2], down[1]), `the outer corners meet: ${JSON.stringify(up[2])} and ${JSON.stringify(down[1])}`);
  assert.ok(up[2].y > 3, "and stand above the perpendicular corner");
  assert.ok(up[3].x > down[0].x, "the inner corners cross");
});

test("the core's segments meet edge to edge, on the vertical through the point", () => {
  const up = strokeCorners({ x: -10, y: -10 }, { x: 0, y: 0 }, 2, true, false, false);
  const down = strokeCorners({ x: 0, y: 0 }, { x: 10, y: -10 }, 2, true, false, false);
  assert.ok(near(up[2], down[1]) && near(up[3], down[0]), "the two segments share their end edge");
  assert.ok(Math.abs(up[2].x) < 1e-9 && Math.abs(up[3].x) < 1e-9, "which is vertical, through the point");
});

test("the band is 6 wide times the player's scale and the pulse, the core 2", () => {
  // [updateStroke :389471-389477; PlayerObject::update :161151-161153;
  //  togglePlayerScale :150458-150459]
  assert.ok(Math.abs(bandPulse(PULSE) - 1.24) < 1e-6, `pulse ${bandPulse(PULSE)}`);
  const across = (band: HardStreak, i: number): number => 2 * Math.hypot(band.data[i * 12 + 2], band.data[i * 12 + 3]);
  const flat: Array<[number, number]> = [[0, 0], ...leg(0, 0, 2.5, 0, 20)];
  const normal = bandOf(flat);
  assert.equal(normal.build(FLAT, 20 / 240, PULSE), 2);
  assert.ok(Math.abs(across(normal, 0) - 6 * bandPulse(PULSE)) < 1e-6, `band ${across(normal, 0)}`);
  assert.ok(Math.abs(across(normal, 1) - 2 * bandPulse(PULSE)) < 1e-6, `core ${across(normal, 1)}`);
  const mini = bandOf(flat, { scale: 0.6 });
  mini.build(FLAT, 20 / 240, PULSE);
  assert.ok(Math.abs(across(mini, 0) - 6 * 0.6 * bandPulse(PULSE)) < 1e-6, `mini band ${across(mini, 0)}`);
});

test("the band adds its colour with a white core over it, or covers alone", () => {
  // [updateStroke :389414-389418 (two passes unless +364), :389586-389590
  //  (the second white, at 0.65); updateStreakBlend :141933-141951]
  const path: Array<[number, number]> = [[0, 0], ...leg(0, 0, 2.5, 2.5, 10), ...leg(25, 25, 2.5, -2.5, 10)];
  const band = bandOf(path);
  assert.equal(band.build(FLAT, 20 / 240, PULSE), 4);
  const bytes = new Uint8Array(band.data.buffer);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual([...bytes.slice(i * 48 + 40, i * 48 + 44)], [0, 255, 119, 255], `band ${i}`);
    assert.equal(bytes[i * 48 + 46], BLEND.ADD);
    const core = (i + 2) * 48;
    assert.deepEqual([...bytes.slice(core + 40, core + 44)], [255, 255, 255, Math.round(0.65 * 255)], `core ${i}`);
    assert.equal(bytes[core + 46], BLEND.ADD);
  }
  const plain = bandOf(path, { additive: false });
  assert.equal(plain.build(FLAT, 20 / 240, PULSE), 2, "made normal, the band alone");
  assert.equal(new Uint8Array(plain.data.buffer)[46], BLEND.NORMAL);
});

test("the band stays whole while the wave lasts and fades for 0.2 s after", () => {
  // No fade with age; a fifth of a second once it stops.
  // [deactivateStreak :147767-147785; fadeOutStreak2 :147733-147751]
  const path: Array<[number, number]> = [[0, 0], ...leg(0, 0, 2.5, 2.5, 240), ...leg(600, 600, 2.5, -2.5, 240)];
  const band = bandOf(path, { additive: false });
  const end = (path.length - 1) / 240;
  assert.equal(band.build(FLAT, end, PULSE), 2, "two seconds back, still both segments");
  assert.equal(new Uint8Array(band.data.buffer)[43], 255, "at full opacity");
  const stop = end + 1 / 240;
  band.track({ x: 1200, y: 0, laying: false, reversed: false }, stop, WIDE_VIEW, 1, false, GREEN);
  band.build(FLAT, stop + 0.1, PULSE);
  const half = new Uint8Array(band.data.buffer)[43];
  assert.ok(Math.abs(half - 127) <= 1, `half way through the fade: ${half}`);
  band.track({ x: 1200, y: 0, laying: false, reversed: false }, stop + 0.2, WIDE_VIEW, 1, false, GREEN);
  assert.equal(band.build(FLAT, stop + 0.2, PULSE), 0, "and then gone");
});

test("only the point just behind the screen's left edge is kept", () => {
  // Turns at x = 25, 50, 75, 100 and 125; with the edge at 60 the points at
  // 0 and 25 go, as the point after each is behind the edge too.
  // [clearBehindXPos :389187-389208]
  const path: Array<[number, number]> = [[0, 0]];
  for (let k = 0; k < 6; k++) path.push(...leg(25 * k, k % 2 === 0 ? 0 : 25, 2.5, k % 2 === 0 ? 2.5 : -2.5, 10));
  const band = bandOf(path, { additive: false, view: { x0: 60, x1: 1e6 } });
  assert.equal(band.build(FLAT, path.length / 240, PULSE), 4, "from the turn at 50 on: 50, 75, 100, 125 and the head");
});

test("a teleport starts the band again rather than drawing across", () => {
  const path: Array<[number, number]> = [[0, 0], ...leg(0, 0, 2.5, 2.5, 10), ...leg(500, 0, 2.5, 2.5, 10)];
  const band = bandOf(path, { additive: false });
  assert.equal(band.build(FLAT, path.length / 240, PULSE), 1, "only the run after the jump");
  assert.ok(band.data[4] > 400, "laid where the player went");
});

test("the band's blend starts from colour 1 and follows the level's only when it changes", () => {
  // [setupStreak :160812-160818; togglePlayerStreakBlend :429735-429746]
  const black = new StreakBlend(true);
  assert.equal(black.follow(true), false, "a black colour 1 starts normal, and a reset does not change it");
  assert.equal(black.follow(false), false);
  assert.equal(black.follow(true), true, "the flag coming back makes it additive");
  const green = new StreakBlend(false);
  assert.equal(green.follow(true), true);
  assert.equal(green.follow(false), false, "key 159 = -1 makes it normal");
  assert.equal(green.follow(true), true);
});

// --- the Ghost Trail -----------------------------------------------------------
// Triggers 32 and 33 start and stop copies of the icon, not a streak.

interface Written {
  frame: string;
  scale: number;
  x: number;
  rgb: number[];
  alpha: number;
  blend: number;
}

/** A player renderer that records what the Ghost Trail asks it to write. */
function fakeArt(): { art: PlayerRenderer; written: Written[] } {
  const written: Written[] = [];
  const art = {
    iconSprite: (mode: string) => ({ frame: `${mode}.png`, scale: mode === "ship" ? 0.55 : 1 }),
    writeFrame: (_d: Float32Array, _b: Uint8Array, at: number, frame: string, m: { a: number; b: number; tx: number }, tint: { r: number; g: number; b: number }, alpha: number, blend: number) => {
      written[at] = { frame, scale: Math.hypot(m.a, m.b), x: m.tx, rgb: [tint.r, tint.g, tint.b], alpha: Math.round(alpha * 255), blend };
      return true;
    },
  } as unknown as PlayerRenderer;
  return { art, written };
}

const GHOST_PLAYER: GhostPlayer = { x: 0, y: 0, rotation: 0, mode: "cube", scale: 1, dead: false, icon: { r: 0, g: 200, b: 100 }, strong: { r: 0, g: 255, b: 127 } };

function ghostRun(ticks: number, player: GhostPlayer = GHOST_PLAYER, on = (_t: number): boolean => true): GhostTrail {
  const { art } = fakeArt();
  const ghosts = new GhostTrail();
  for (let t = 0; t < ticks; t++) ghosts.step(0, on(t), { ...player, x: t }, 1 / 240, t / 240, art);
  return ghosts;
}

test("the Ghost Trail takes a copy of the icon every 0.05 s", () => {
  // The first tick starts the scheduler's count; then one copy every twelve.
  // [toggleGhostEffect :147168-147176; runWithTarget :59433-59466]
  const { art, written } = fakeArt();
  const ghosts = ghostRun(25);
  assert.equal(ghosts.build(24 / 240, art), 2);
  assert.deepEqual(written.map((w) => w.x), [12, 24], "taken where the player was");
  assert.equal(written[0].frame, "cube.png", "of the icon sprite's frame");
});

test("a copy fades from 200 to nothing over 0.4 s and shrinks to 0.6", () => {
  // [toggleGhostEffect :147162 (200); trailSnapshot :59317-59337]
  const { art, written } = fakeArt();
  const ghosts = ghostRun(13);
  const born = 12 / 240;
  ghosts.build(born, art);
  assert.equal(written[0].alpha, 200);
  assert.ok(Math.abs(written[0].scale - 1) < 1e-9);
  ghosts.build(born + 0.2, art);
  assert.equal(written[0].alpha, 100);
  assert.ok(Math.abs(written[0].scale - 0.8) < 1e-9, `half way it is ${written[0].scale}`);
  assert.equal(ghosts.build(born + 0.4, art), 0, "and then it is gone");
});

test("a mini player's copies start at its size and shrink by it again", () => {
  // [trailSnapshot :59269-59275 (× +280), :59326-59337 (× +272 × +280)]
  const { art, written } = fakeArt();
  const ghosts = ghostRun(13, { ...GHOST_PLAYER, scale: 0.6, mode: "ship" });
  ghosts.build(12 / 240, art);
  assert.ok(Math.abs(written[0].scale - 0.55 * 0.6) < 1e-9, "the ship's cube at 0.55, then the player's 0.6");
  // Three quarters of the way from 0.33 to 0.33 × 0.6 × 0.6.
  ghosts.build(12 / 240 + 0.3, art);
  const from = 0.55 * 0.6;
  assert.ok(Math.abs(written[0].scale - (from + (from * 0.36 - from) * 0.75)) < 1e-6, `three quarters through it is ${written[0].scale}`);
});

test("copies are added in the strengthened colour 1, or laid over in black", () => {
  // [toggleGhostEffect :147152-147196; doBlendAdditive :59482-59487]
  const { art, written } = fakeArt();
  ghostRun(13).build(12 / 240, art);
  assert.deepEqual(written[0].rgb, [0, 255, 127]);
  assert.equal(written[0].blend, BLEND.ADD_SPRITE);
  ghostRun(13, { ...GHOST_PLAYER, icon: { r: 0, g: 0, b: 0 } }).build(12 / 240, art);
  assert.deepEqual(written[0].rgb, [0, 0, 0]);
  assert.equal(written[0].blend, BLEND.NORMAL);
});

test("turning the Ghost Trail off stops new copies and lets the old ones fade", () => {
  const { art } = fakeArt();
  const ghosts = ghostRun(40, GHOST_PLAYER, (t) => t < 30);
  assert.equal(ghosts.build(39 / 240, art), 2, "the copies at 12 and 24, and none at 36");
  assert.equal(ghostRun(40, { ...GHOST_PLAYER, dead: true }).build(39 / 240, art), 0, "a dead player leaves none");
});

test("turning the trail off clears it rather than freezing it", () => {
  const trail = trailOf([
    [0, 0, 0],
    [20, 0, 0.05],
    [40, 0, 0.1],
  ]);
  trail.track(60, 0, 0.15, false);
  assert.equal(trail.build(STREAK, BLUE, 0.15, false), 0, "a trail that was switched off should draw nothing");
});

test("points closer together than a segment's worth do not each get a quad", () => {
  // A player at 1x covers about 1.3 units a tick; a quad each would be 240 a
  // second for a ribbon nobody can see the joints of.
  const points: Array<[number, number, number]> = [];
  for (let i = 0; i < 40; i++) points.push([i * 0.4, 0, i / 240]);
  const trail = trailOf(points);
  const n = trail.build(STREAK, BLUE, 40 / 240, false);
  assert.ok(n > 0, "a slow drift should still draw");
  assert.ok(n < 20, `40 points 0.4 units apart should not make ${n} quads`);
});

test("the streak's texture is stretched along the ribbon, not repeated per segment", () => {
  // Giving every quad the whole texture is what makes a streak come out as a
  // row of stripes: the art's soft ends land at both ends of every segment.
  const trail = trailOf([
    [0, 0, 0],
    [20, 0, 0.05],
    [40, 0, 0.1],
    [60, 0, 0.15],
  ]);
  const n = trail.build(STREAK, BLUE, 0.15, false);
  assert.ok(n >= 3, `expected three segments, got ${n}`);
  let expected = STREAK.u0;
  for (let i = 0; i < n; i++) {
    const u0 = trail.data[i * 12 + 6];
    const du = trail.data[i * 12 + 8];
    assert.ok(Math.abs(u0 - expected) < 1e-5, `segment ${i} starts at ${u0}, expected ${expected}`);
    assert.ok(du < STREAK.du, `segment ${i} takes the whole texture rather than a slice`);
    expected = u0 + du;
  }
  assert.ok(Math.abs(expected - (STREAK.u0 + STREAK.du)) < 1e-5, "the slices should cover the texture exactly once");
});

// --- what the player actually leaves behind ----------------------------------
// A cube has no ribbon. What follows it is dragEffect, one of four cocos
// particle plists out of the install that the asset build has been shipping
// with nothing reading them.

const PARTICLES = builtPath("assets/particles.json");
const NO_PARTICLES = existsSync(PARTICLES) ? false : "run `npm run assets` first";
const SQUARE: EffectQuad = { u0: 0, v0: 0, du: 0.01, dv: 0.01, unit: 13, w: 32, h: 32 };

function particleFile(): ParticleFile {
  return JSON.parse(readFileSync(PARTICLES, "utf8")) as ParticleFile;
}

function playerAt(over: Partial<PlayerState>): PlayerState {
  return { x: 100, y: 15, mode: "cube", onGround: true, dashing: false, flipped: false, ...over } as PlayerState;
}

function stepped(over: Partial<PlayerState>, ticks = 20): PlayerParticles {
  const p = new PlayerParticles();
  p.load(particleFile(), SQUARE);
  const state = playerAt(over);
  for (let i = 0; i < ticks; i++) p.update(state, 1 / 60, state.flipped);
  return p;
}

test("the four player effects convert from their plists", { skip: NO_PARTICLES }, () => {
  const file = particleFile();
  for (const name of ["dragEffect", "landEffect", "shipDragEffect", "dashEffect"]) {
    const effect = file.effects[name];
    assert.ok(effect, `${name} is not in the built effects`);
    const def = defFromPlist(effect as Record<string, number | string | boolean>);
    assert.ok(def.maxParticles > 0, `${name} emits nothing`);
    // cocos has no rate of its own: it emits maxParticles over one lifetime.
    assert.ok(def.emissionRate > 0, `${name} has no emission rate`);
    assert.equal(def.additive, true, `${name} blends 770 to 1, which is additive`);
  }
});

test("a cube running on the ground kicks up dust and lays no ribbon", { skip: NO_PARTICLES }, () => {
  const p = stepped({ onGround: true });
  assert.ok(p.instances > 0, "the drag effect should be emitting");
});

test("a cube in the air stops emitting, and what is already out finishes", { skip: NO_PARTICLES }, () => {
  const p = new PlayerParticles();
  p.load(particleFile(), SQUARE);
  const ground = playerAt({ onGround: true });
  for (let i = 0; i < 20; i++) p.update(ground, 1 / 60, false);
  const running = p.instances;
  assert.ok(running > 0, "nothing was emitting to begin with");
  const air = playerAt({ onGround: false, y: 80 });
  const justAfter = p.update(air, 1 / 60, false);
  assert.ok(justAfter > 0, "particles already in the air should finish their lives");
  for (let i = 0; i < 90; i++) p.update(air, 1 / 60, false);
  assert.equal(p.instances, 0, "once they have all expired nothing should be left");
});

test("a ship trails exhaust instead of dust", { skip: NO_PARTICLES }, () => {
  const ship = stepped({ mode: "ship", onGround: false, y: 150 });
  assert.ok(ship.instances > 0, "the ship should be trailing something");
  const cube = stepped({ mode: "cube", onGround: false, y: 150 });
  assert.equal(cube.instances, 0, "a cube in the air leaves nothing behind");
});

test("a dash sprays, and the dust stops while it does", { skip: NO_PARTICLES }, () => {
  const dashing = stepped({ dashing: true, onGround: true });
  const plain = stepped({ dashing: false, onGround: true });
  assert.ok(dashing.instances > 0, "a dash should be spraying");
  assert.notEqual(dashing.instances, plain.instances, "a dash does not look like a run");
});

test("the dust and the puff start in colour 1, the dash spray runs from colour 2 to half of it", { skip: NO_PARTICLES }, () => {
  // [PlayerObject::updateGlowColor :146162-146212]
  const p = new PlayerParticles();
  p.load(particleFile(), SQUARE);
  p.tint({ r: 255, g: 0, b: 51 }, { r: 0, g: 102, b: 255 });
  const defs = (p as unknown as { slots: Array<{ emitter: { def: { startColor: number[]; endColor: number[] } } }> }).slots.map((s) => s.emitter.def);
  const [drag, land, , dash] = defs;
  assert.deepEqual(drag.startColor, [1, 0, 0.2, 1]);
  assert.deepEqual(land.startColor, [1, 0, 0.2, 1]);
  assert.deepEqual(dash.startColor, [0, 0.4, 1, 1]);
  assert.deepEqual(dash.endColor, [0, 0.4, 1, 0.5]);
});

test("in rotated gameplay the dust comes off the wall the player runs on and falls back to it", { skip: NO_PARTICLES }, () => {
  // [PlayerObject::updatePlayerArt :145447-145491]
  const p = new PlayerParticles();
  p.load(particleFile(), SQUARE);
  const running = playerAt({ onGround: true, rotated: true, x: 300, y: 300 });
  for (let i = 0; i < 30; i++) p.update(running, 1 / 60, false);
  const drag = (p as unknown as { slots: Array<{ emitter: { def: { gravityX: number; gravityY: number; angle: number }; x: number; y: number } }> }).slots[0];
  assert.ok(drag.emitter.def.gravityX < 0 && drag.emitter.def.gravityY === 0, `gravity ${drag.emitter.def.gravityX}, ${drag.emitter.def.gravityY}`);
  assert.ok(drag.emitter.x < 300, "the floor is the wall on the left");
  assert.ok(drag.emitter.y < 300, "and behind is below");
  p.update(playerAt({ onGround: true }), 1 / 60, false);
  assert.ok(drag.emitter.def.gravityX === 0 && drag.emitter.def.gravityY < 0, "turned back, it falls down again");
});

test("landing lets off a puff", { skip: NO_PARTICLES }, () => {
  const p = new PlayerParticles();
  p.load(particleFile(), SQUARE);
  const air = playerAt({ onGround: false, y: 80 });
  for (let i = 0; i < 30; i++) p.update(air, 1 / 60, false);
  const before = p.instances;
  // The tick the player touches down.
  const landed = playerAt({ onGround: true });
  const after = p.update(landed, 1 / 60, false);
  assert.ok(after > before, `landing should add particles (${before} then ${after})`);
});

test("the dust and dash spray go under the player, the landing puff and exhaust over it", { skip: NO_PARTICLES }, () => {
  // z 39 and z 61 either side of the player's 59.
  // [PlayerObject::addAllParticles :141835-141880]
  // Two seconds in, the puff of the first touch-down is long gone.
  const running = stepped({ onGround: true }, 120);
  assert.ok(running.instances > 0);
  assert.equal(running.underCount, running.instances, "all dust");
  const ship = stepped({ mode: "ship", onGround: false, y: 150 });
  assert.ok(ship.instances > 0);
  assert.equal(ship.underCount, 0, "all exhaust");
  const p = new PlayerParticles();
  p.load(particleFile(), SQUARE);
  for (let i = 0; i < 30; i++) p.update(playerAt({ onGround: false, y: 80 }), 1 / 60, false);
  for (let i = 0; i < 3; i++) p.update(playerAt({ onGround: true }), 1 / 60, false);
  assert.ok(p.underCount > 0 && p.underCount < p.instances, `dust under and a puff over (${p.underCount} of ${p.instances})`);
});

test("the dust comes off the player's feet, not its waist", { skip: NO_PARTICLES }, () => {
  // Both ends of this were wrong on the way here: the emitter on the bottom
  // edge sprayed through the floor, and on the centre it came off the cube's
  // middle. It belongs just above the feet.
  const p = new PlayerParticles();
  p.load(particleFile(), SQUARE);
  const state = playerAt({ onGround: true, y: 15 });
  // One tick, so the particles are still where they were born rather than
  // wherever their own velocity has taken them.
  p.update(state, 1 / 240, false);
  const n = p.instances;
  assert.ok(n > 0, "nothing was emitting");
  let sum = 0;
  for (let i = 0; i < n; i++) sum += p.data[i * 12 + 5];
  const mean = sum / n;
  assert.ok(mean < state.y - 5, `the dust starts at y ${mean.toFixed(1)}, which is the cube's middle, not its feet`);
  assert.ok(mean > state.y - 20, `the dust starts at y ${mean.toFixed(1)}, which is below the cube altogether`);
});

test("a mini cube's dust comes off its own, smaller feet", { skip: NO_PARTICLES }, () => {
  const spawn = (mini: boolean): number => {
    const p = new PlayerParticles();
    p.load(particleFile(), SQUARE);
    const state = playerAt({ onGround: true, y: 100, mini });
    p.update(state, 1 / 240, false);
    let sum = 0;
    for (let i = 0; i < p.instances; i++) sum += p.data[i * 12 + 5];
    return sum / Math.max(1, p.instances);
  };
  assert.ok(spawn(true) > spawn(false), "a mini cube is shorter, so its feet are higher");
});

test("a flipped player's dust comes off the other side", { skip: NO_PARTICLES }, () => {
  const upright = new PlayerParticles();
  upright.load(particleFile(), SQUARE);
  const flipped = new PlayerParticles();
  flipped.load(particleFile(), SQUARE);
  const a = playerAt({ onGround: true, y: 100 });
  const b = playerAt({ onGround: true, y: 100, flipped: true });
  for (let i = 0; i < 4; i++) {
    upright.update(a, 1 / 240, false);
    flipped.update(b, 1 / 240, true);
  }
  const mean = (p: PlayerParticles): number => {
    let sum = 0;
    for (let i = 0; i < p.instances; i++) sum += p.data[i * 12 + 5];
    return sum / Math.max(1, p.instances);
  };
  assert.ok(upright.instances > 0 && flipped.instances > 0, "both should be emitting");
  // Upright, the feet are below the centre; upside down they are above it.
  assert.ok(mean(upright) < mean(flipped), "the offset should turn over with the player");
  assert.ok(mean(upright) < 100 && mean(flipped) > 100, "each should be on its own side of the player");
});

test("the dust comes off the trailing edge, whichever way the level runs", { skip: NO_PARTICLES }, () => {
  const spawnX = (over: Partial<PlayerState>): number => {
    const p = new PlayerParticles();
    p.load(particleFile(), SQUARE);
    const state = playerAt({ onGround: true, y: 15, ...over });
    // Past the landing burst, so it is the drag effect being measured.
    for (let i = 0; i < 40; i++) p.update(state, 1 / 240, false);
    let sum = 0;
    for (let i = 0; i < p.instances; i++) sum += p.data[i * 12 + 4];
    return sum / Math.max(1, p.instances) - state.x;
  };
  assert.ok(spawnX({}) < -5, "running forward, the dust should be behind on the left");
  // A reverse portal turns the level around; the dust has to follow.
  assert.ok(spawnX({ reversed: true }) > 5, "running backward, the dust should be behind on the right");
  assert.ok(spawnX({ xVel: -50 }) > 5, "a platformer player walking left trails to its right");
  assert.ok(spawnX({ xVel: 50 }) < -5, "and to its left walking right");
});

test("facing follows the reverse flag, and the mirror does not touch it", { skip: NO_PARTICLES }, () => {
  // A mirror portal turns the view over and leaves the player going the same
  // way through the world the particles live in.
  assert.equal(facingOf(playerAt({})), 1);
  assert.equal(facingOf(playerAt({ reversed: true })), -1);
  assert.equal(facingOf(playerAt({ mirrored: true })), 1);
  assert.equal(facingOf(playerAt({ reversed: true, mirrored: true })), -1);
  assert.equal(facingOf(playerAt({ xVel: -2, reversed: false })), -1, "the platformer steers for itself");
});

test("upside down, the dust is thrown the other way and falls back the other way", { skip: NO_PARTICLES }, () => {
  // Measured rather than read off the definition: what matters is which way
  // the particles actually go.
  const drift = (flipped: boolean): number => {
    const p = new PlayerParticles();
    p.load(particleFile(), SQUARE);
    const state = playerAt({ onGround: true, y: 500, flipped });
    for (let i = 0; i < 40; i++) p.update(state, 1 / 240, flipped);
    let sum = 0;
    for (let i = 0; i < p.instances; i++) sum += p.data[i * 12 + 5] - state.y;
    return sum / Math.max(1, p.instances);
  };
  assert.ok(drift(false) < 0, "upright, the dust sits below the player");
  assert.ok(drift(true) > 0, "flipped, it sits above it");
});

// --- the enter effects -------------------------------------------------------
// Read out of PlayLayer::applyEnterEffect rather than guessed: the band is 70
// units, a slide is 100, big-to-small starts at 1.75, and everything fades but
// "none". These pin the arithmetic; the draw list only adds the offsets.

test("every trigger id maps to the code the game gives it, and the rest are the fade", () => {
  assert.equal(enterCode(23), ENTER.fromBottom);
  assert.equal(enterCode(24), ENTER.fromTop);
  assert.equal(enterCode(25), ENTER.fromLeft);
  assert.equal(enterCode(26), ENTER.fromRight);
  assert.equal(enterCode(27), ENTER.smallToBig);
  assert.equal(enterCode(28), ENTER.bigToSmall);
  assert.equal(enterCode(55), ENTER.random);
  assert.equal(enterCode(56), ENTER.angledFar);
  assert.equal(enterCode(57), ENTER.angledNear);
  assert.equal(enterCode(58), ENTER.verticalNear);
  assert.equal(enterCode(59), ENTER.verticalFar);
  assert.equal(enterCode(1915), ENTER.none);
  assert.equal(enterCode(3019), ENTER.custom);
  // 22 is not "off"; it is the default, which fades.
  assert.equal(enterCode(22), ENTER.fade);
  assert.equal(enterCode(901), ENTER.fade, "a move trigger is not an enter effect");
});

test("only none and the custom effects skip the fade", () => {
  for (const code of Object.values(ENTER)) {
    const fades = enterFades(code);
    assert.equal(fades, code !== ENTER.none && code !== ENTER.custom, `code ${code}`);
  }
});

test("progress is the distance inside the edge over 70 units, clamped", () => {
  assert.equal(enterProgress(-10), 0);
  assert.equal(enterProgress(0), 0);
  assert.ok(Math.abs(enterProgress(35) - 0.5) < 1e-9);
  assert.equal(enterProgress(70), 1);
  assert.equal(enterProgress(700), 1);
});

test("the slides start 100 units out and arrive at rest", () => {
  assert.deepEqual(enterPose(ENTER.fromBottom, 0, false, 0), { dx: 0, dy: -100, scale: 1 });
  assert.deepEqual(enterPose(ENTER.fromTop, 0, false, 0), { dx: 0, dy: 100, scale: 1 });
  assert.deepEqual(enterPose(ENTER.fromLeft, 0, false, 0), { dx: -100, dy: 0, scale: 1 });
  assert.deepEqual(enterPose(ENTER.fromRight, 0, false, 0), { dx: 100, dy: 0, scale: 1 });
  const half = enterPose(ENTER.fromBottom, 0.5, false, 0);
  assert.ok(Math.abs(half.dy + 50) < 1e-9, "half way in is half the slide");
  assert.deepEqual(enterPose(ENTER.fromBottom, 1, false, 0), { dx: 0, dy: 0, scale: 1 });
});

test("small to big grows from nothing; big to small shrinks from 1.75", () => {
  assert.equal(enterPose(ENTER.smallToBig, 0, false, 0).scale, 0);
  assert.equal(enterPose(ENTER.smallToBig, 0.25, false, 0).scale, 0.25);
  assert.ok(Math.abs(enterPose(ENTER.bigToSmall, 0, false, 0).scale - 1.75) < 1e-9);
  assert.ok(Math.abs(enterPose(ENTER.bigToSmall, 0.5, false, 0).scale - 1.375) < 1e-9);
  assert.equal(enterPose(ENTER.bigToSmall, 1, false, 0).scale, 1);
});

test("the vertical pair comes in from the nearer edge and the further one", () => {
  // Below the middle of the screen, "near" is the bottom: the object starts
  // 100 below and slides up. Above it, the top.
  const nearBelow = enterPose(ENTER.verticalNear, 0, false, 0);
  const nearAbove = enterPose(ENTER.verticalNear, 0, true, 0);
  assert.ok(nearBelow.dy < -99 && Math.abs(nearBelow.dx) < 1e-6, `below: ${JSON.stringify(nearBelow)}`);
  assert.ok(nearAbove.dy > 99 && Math.abs(nearAbove.dx) < 1e-6, `above: ${JSON.stringify(nearAbove)}`);
  const farBelow = enterPose(ENTER.verticalFar, 0, false, 0);
  assert.ok(farBelow.dy > 99, "far from below the middle is the top");
});

test("the angled pair leans toward the right on 57 and the left on 56", () => {
  const near = enterPose(ENTER.angledNear, 0, false, 0);
  const far = enterPose(ENTER.angledFar, 0, false, 0);
  assert.ok(near.dx > 0 && near.dy < 0, `57 below the middle should start down-right, got ${JSON.stringify(near)}`);
  assert.ok(far.dx < 0 && far.dy < 0, `56 below the middle should start down-left, got ${JSON.stringify(far)}`);
  assert.ok(Math.abs(Math.hypot(near.dx, near.dy) - 100) < 1e-6, "the diagonal is still a 100-unit slide");
});

test("the random effect is different between objects and the same for one object", () => {
  const a = enterAngle(ENTER.random, false, 3);
  const b = enterAngle(ENTER.random, false, 4);
  assert.equal(a, enterAngle(ENTER.random, false, 3));
  assert.notEqual(a, b);
  assert.ok(a >= -180 && a < 180);
});

// --- how the scenery meets what is under it ---------------------------------------

test("the line and the middleground add as the game's additive sprites while their channels blend; the ground always covers", () => {
  // The line's art is premultiplied and cocos multiplies its colour by its
  // opacity, then SRC_ALPHA / ONE weighs it by its alpha again: its soft ends
  // add a good deal less than colour times alpha. The ground has no blend
  // switch at all. [GJGroundLayer::createLine :382015-382055, updateLineBlend
  //  :382377-382392; GJMGLayer::updateMG01Blend :383263-383280;
  //  GJBaseGameLayer::updateLevelColors :418679-418783]
  const scenery = new SceneryRenderer({} as WebGL2RenderingContext);
  scenery.setLine({ u0: 0, v0: 0, du: 1, dv: 1, unit: 3, height: 2, rotated: false, scaleY: 1 });
  const stub = scenery as unknown as {
    ground: { texture: null; unit: number; width: number; height: number };
    middleground: { base: null; detail: null; unit: number; width: number; height: number; detailHeight: number };
  };
  stub.ground = { texture: null, unit: 9, width: 120, height: 120 };
  stub.middleground = { base: null, detail: null, unit: 15, width: 512, height: 100, detailHeight: 100 };
  const camera = new Camera();
  camera.setAspect(16, 9);
  const blends = (count: number): number[] => {
    const bytes = new Uint8Array(scenery.data.buffer);
    return Array.from({ length: count }, (_, i) => bytes[i * 48 + 46]);
  };
  const blending = ColorTable.resolve(header([1001, 1002, 1013].map((id) => ({ id, r: 255, g: 255, b: 255, blending: true }))));
  const ground = blends(scenery.buildGround(camera, blending));
  assert.ok(ground.length > 2, `tiles and a line: ${ground.length}`);
  assert.deepEqual(ground.slice(0, -1).filter((b) => b !== BLEND.NORMAL), [], "the ground covers though its channel blends");
  assert.equal(ground[ground.length - 1], BLEND.ADD_SPRITE, "the line adds as a sprite in an additive batch");
  const mg = blends(scenery.buildMiddleground(camera, blending, false, new BackdropDrift(), 0));
  assert.ok(mg.length > 0 && mg.every((b) => b === BLEND.ADD_SPRITE), `the middleground too: ${mg}`);
  const plain = ColorTable.resolve(header([1001, 1002, 1013].map((id) => ({ id, r: 255, g: 255, b: 255, blending: id === 1001 }))));
  const line = blends(scenery.buildGround(camera, plain));
  assert.equal(line[line.length - 1], BLEND.NORMAL);
  const still = blends(scenery.buildMiddleground(camera, plain, false, new BackdropDrift(), 0));
  assert.ok(still.every((b) => b === BLEND.NORMAL));
});

// --- the beasts' clips --------------------------------------------------------

const animPath = (name: string): string => builtPath(`assets/anims/${name}.json`);
const readEntity = (name: string): AnimEntity => JSON.parse(readFileSync(animPath(name), "utf8")) as AnimEntity;

test("a beast starts on its definition's clip: the bat bites, its jaws opening wide", { skip: existsSync(animPath("GJBeast01")) ? false : "run `npm run build` first" }, () => {
  // [gdp CCAnimatedSprite::loadType :30404-30407 (defaultAnimation);
  //  AnimatedGameObject::animationFinished :302102-302121 (918 ? bite)]
  const plan = skeletonFor(readEntity("GJBeast01"), 918);
  assert.ok(plan);
  assert.equal(plan.clips[0].name, "bite");
  assert.equal(plan.clips[0].looped, true);
  const jaw = plan.slots.find((s) => s.tag === 1);
  assert.ok(jaw);
  const turns = jaw.frames.slice(0, plan.clips[0].frames).map((f) => f?.rot ?? 0);
  assert.ok(Math.max(...turns) - Math.min(...turns) > 30, `the jaw swings wide: ${Math.min(...turns)}..${Math.max(...turns)}`);
});

test("a beast's idle that ends picks the next by a roll, and idle02 always goes back to idle01", () => {
  // [gdp AnimatedGameObject::animationFinished :302122-302151, :302193-302197, :302244-302258]
  assert.equal(nextSkeletonClip(1327, "idle01", 0.5), "idle01");
  assert.equal(nextSkeletonClip(1327, "idle01", 0.8), "idle02");
  assert.equal(nextSkeletonClip(1328, "idle01", 0.8), "idle01");
  assert.equal(nextSkeletonClip(1328, "idle01", 0.95), "idle02");
  assert.equal(nextSkeletonClip(1327, "idle02", 0.99), "idle01");
  assert.equal(nextSkeletonClip(1584, "sleep", 0), "sleep_loop");
  assert.equal(nextSkeletonClip(2012, "toAttack03", 0), "attack03");
  assert.equal(nextSkeletonClip(918, "idle01", 0), "bite");
  assert.equal(nextSkeletonClip(1, "idle01", 0), null);
});

test("a beast's clock walks its clips one after another, from a random point in the first", { skip: existsSync(animPath("GJBeast02")) ? false : "run `npm run build` first" }, () => {
  const plan = skeletonFor(readEntity("GJBeast02"), 1327);
  assert.ok(plan);
  assert.deepEqual(plan.clips.map((c) => c.name), ["idle01", "idle02"]);
  const clock = { clip: 0, began: 0, rolls: 0 };
  startSkeleton(plan, clock, 10, 7);
  const length = plan.clips[0].frames * plan.clips[0].interval;
  assert.ok(clock.began <= 10 && clock.began > 10 - length, "part-way into idle01");
  const played = new Set<string>();
  for (let t = 10; t < 60; t += 1 / 60) {
    const k = skeletonFrame(plan, clock, t, 7);
    const clip = plan.clips[clock.clip];
    assert.ok(k >= clip.start && k < clip.start + clip.frames, "the frame is in the clip it is playing");
    played.add(clip.name);
  }
  assert.deepEqual([...played].sort(), ["idle01", "idle02"], "both idles play");
});
