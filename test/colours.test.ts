// What colour and blend a sprite ends up with, and the angles an object is
// drawn at. The draw list is built here with a two-frame atlas of
// its own, so none of this needs the asset build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AtlasSet } from "../src/assets/atlas";
import type { AtlasFile } from "../src/assets/atlasTypes";
import type { ChildRecord, ObjectRecord } from "../src/assets/objectTypes";
import { affine, affineXY } from "../src/engine/math";
import type { ColorChannel, HsvShift, Level, LevelObject } from "../src/level/types";
import {
  CHANNEL,
  ColorTable,
  applyHsv,
  channelOpacityMod,
  lighterColor,
  playerChannelColours,
  strongColor,
  type ColorSource,
  type PulseAction,
} from "../src/render/colors";
import {
  BLEND_ALWAYS,
  BLEND_NEVER,
  DrawList,
  blendChannelOf,
  objectChannels,
  rodBallFrame,
  rotationBase,
  rotationSpeed,
  type LiveScene,
} from "../src/render/drawList";
import { ENTER } from "../src/render/enterEffects";
import type { AnimEntity, AnimPart } from "../src/assets/anims";
import { existsSync, readFileSync } from "node:fs";
import { BLEND, INSTANCE_BYTES } from "../src/engine/gl/spriteBatch";
import { NO_INPUT } from "../src/physics/types";
import type { TriggerRuntime } from "../src/triggers/runtime";
import { STANDING_Y, emptyLevel, makeHeader, type Placed } from "./levelKit";
import { makeSim, builtPath } from "./helpers";

const OBJECTS_PATH = builtPath("assets/objects.json");
const OBJECTS_SKIP = existsSync(OBJECTS_PATH) ? false : "run `npm run assets` first";

function entry(id: number, over: Partial<ColorChannel> = {}): ColorChannel {
  return { id, r: 0, g: 0, b: 0, opacity: 1, blending: false, copyId: 0, copyHsv: null, copyOpacity: false, playerColor: 0, ...over };
}

// --- the player's colours -----------------------------------------------------

test("an icon colour is strengthened unless a part of it is already full", () => {
  // [GameToolbox::strongColor, gd-ida-decomp.cpp:43436-43470]
  assert.deepEqual(strongColor({ r: 0, g: 255, b: 119 }), { r: 0, g: 255, b: 119 }, "has a 255");
  assert.deepEqual(strongColor({ r: 150, g: 50, b: 0 }), { r: 225, g: 75, b: 0 }, "capped at half again");
  assert.deepEqual(strongColor({ r: 90, g: 90, b: 90 }), { r: 135, g: 135, b: 135 });
  assert.deepEqual(strongColor({ r: 175, g: 175, b: 175 }), { r: 255, g: 255, b: 255 });
  // Float maths, truncated: 224 × float(255/224) lands a hair under 255.
  assert.deepEqual(strongColor({ r: 224, g: 224, b: 224 }), { r: 254, g: 254, b: 254 });
});

test("a black first colour hands over to the second, and two black ones make white", () => {
  // [PlayerObject::updateGlowColor :146119-146173]
  assert.deepEqual(playerChannelColours({ r: 0, g: 0, b: 0 }, { r: 150, g: 50, b: 0 }), {
    p1: { r: 225, g: 75, b: 0 },
    p2: { r: 225, g: 75, b: 0 },
  });
  assert.deepEqual(playerChannelColours({ r: 150, g: 50, b: 0 }, { r: 0, g: 0, b: 0 }).p2, { r: 225, g: 75, b: 0 });
  assert.deepEqual(playerChannelColours({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }).p1, { r: 255, g: 255, b: 255 });
});

test("P1 and P2 are the player's colours and additive, whatever the header stored", () => {
  // Geometrical Dominator stores 1005 as (0,175,75) and Deadlocked as
  // (0,0,255); the game writes the icon colours over both.
  // [PlayLayer::setupHasCompleted :106214-106234 → loadDefaultColors]
  const header = makeHeader();
  header.colors.set(1005, entry(1005, { g: 175, b: 75 }));
  header.colors.set(7, entry(7, { r: 1, g: 2, b: 3, playerColor: 2 }));
  const table = ColorTable.resolve(header, { player1: { r: 150, g: 50, b: 0 }, player2: { r: 90, g: 90, b: 90 } });
  const p1 = table.get(CHANNEL.P1);
  assert.deepEqual([p1.r, p1.g, p1.b, p1.blending], [225, 75, 0, true]);
  const p2 = table.get(CHANNEL.P2);
  assert.deepEqual([p2.r, p2.g, p2.b, p2.blending], [135, 135, 135, true]);
  const seven = table.get(7);
  assert.deepEqual([seven.r, seven.g, seven.b], [135, 135, 135], "a player-colour channel takes the strong colour too");
  assert.deepEqual(table.playerColour(1), { r: 225, g: 75, b: 0 });
  // The player's own icon keeps the colours as chosen. [createPlayer :417905-417930]
  assert.deepEqual(table.iconColour(1), { r: 150, g: 50, b: 0 });
  assert.deepEqual(table.iconColour(2), { r: 90, g: 90, b: 90 });
});

test("G2 is its own channel, not a copy of G1", () => {
  const header = makeHeader();
  header.colors.set(1001, entry(1001, { r: 9, g: 9, b: 9 }));
  const g2 = ColorTable.resolve(header).get(CHANNEL.GROUND_2);
  assert.deepEqual([g2.r, g2.g, g2.b], [255, 255, 255], "what the header gives it, which here is nothing");
});

// --- which channel, and whether it adds -------------------------------------------

function object(id: number, props: Record<number, string> = {}, over: Partial<LevelObject> = {}): LevelObject {
  return {
    index: 0,
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
    ...over,
  };
}

const withDetail: ObjectRecord = {
  k: "decoration",
  hb: null,
  src: "table",
  p: { hb: "none", art: "manual", z: "none" },
  f: "a.png",
  bc: 1004,
  dc: 1,
  ct: "B",
  ch: [{ f: "b.png", dx: 0, dy: 0, z: 1, ct: "D" }],
};
const baseOnly: ObjectRecord = { ...withDetail, ch: [] };

test("key 19 lands on the detail colour when the object has detail art, else on the base", () => {
  // A default detail channel with no art on it does not count (spikes 18 and
  // 19), and nor does detail art with no default.
  // [objectFromVector :184346-184349; createSpriteColor :166652-166680]
  assert.deepEqual(objectChannels(object(1, {}, { legacyColor: 1005 }), withDetail), { base: 1004, detail: 1005 });
  assert.deepEqual(objectChannels(object(1, {}, { legacyColor: 1005 }), baseOnly), { base: 1005, detail: 1 });
  const noDefault: ObjectRecord = { ...withDetail, dc: undefined };
  assert.deepEqual(objectChannels(object(1, {}, { legacyColor: 1005 }), noDefault), { base: 1005, detail: 0 });
  assert.deepEqual(objectChannels(object(1, {}, { baseColor: 7, detailColor: 8 }), withDetail), { base: 7, detail: 8 });
});

test("P1, P2 and the light background always add; lighter follows the base; the rods never do", () => {
  // [GameObject::shouldBlendColor :166462-166495]
  assert.equal(blendChannelOf(1005, 1004, 1), BLEND_ALWAYS);
  assert.equal(blendChannelOf(1007, 1004, 1), BLEND_ALWAYS);
  assert.equal(blendChannelOf(1012, 1006, 1), BLEND_ALWAYS, "a lighter sprite on a P2 object");
  assert.equal(blendChannelOf(1012, 5, 1), 5, "a lighter sprite follows its base's flag");
  assert.equal(blendChannelOf(5, 1004, 1), 5);
  assert.equal(blendChannelOf(0, 1004, 1), BLEND_NEVER);
  assert.equal(blendChannelOf(1005, 1004, 15), BLEND_NEVER, "a rod never blends by colour");
});

/** A two-frame atlas, 30 units square each at 4 px a unit. */
function atlas(): AtlasSet {
  const file: AtlasFile = {
    version: 1,
    res: "uhd",
    pxPerUnit: 4,
    atlases: [
      {
        name: "t",
        image: "t.png",
        w: 256,
        h: 128,
        frames: [
          { n: "a.png", x: 0, y: 0, w: 120, h: 120 },
          { n: "b.png", x: 128, y: 0, w: 120, h: 120 },
        ],
      },
    ],
    frames: { "a.png": [0, 0], "b.png": [0, 1] },
  };
  return new (AtlasSet as unknown as new (f: AtlasFile) => AtlasSet)(file);
}

const VIEW = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };

function build(objects: LevelObject[], records: Record<number, ObjectRecord>, table: ColorTable): DrawList {
  const level: Level = { header: makeHeader(), objects: objects.map((o, index) => ({ ...o, index })), lengthUnits: 1000 };
  return DrawList.build(level, (id) => records[id], atlas(), table);
}

test("the draw list adds a P2 base and its lighter detail, and not a rod on P1", () => {
  const table = ColorTable.resolve(makeHeader());
  const lighter: ObjectRecord = { ...withDetail, bc: 1006, dc: 1012 };
  const rod: ObjectRecord = { ...baseOnly, bc: 1005 };
  const list = build([object(2), object(15)], { 2: lighter, 15: rod }, table);
  const data = list.visible(VIEW, null, 0);
  const bytes = new Uint8Array(data.buffer);
  assert.equal(list.visibleCount, 3);
  const additive = [0, 1, 2].map((i) => bytes[i * INSTANCE_BYTES + 46]);
  assert.deepEqual(additive, [BLEND.ADD_SPRITE, BLEND.ADD_SPRITE, BLEND.NORMAL], "P2 base, its lighter detail, the rod");
});

test("a colour trigger that turns a channel's blending off stops its sprites adding", () => {
  // Only the art's own flag is kept from the build; the channel's is read
  // live, so it can go either way. [GameObject::shouldBlendColor :166462-166495]
  const header = makeHeader();
  header.colors.set(5, entry(5, { r: 255, g: 255, b: 255, blending: true }));
  const table = ColorTable.resolve(header);
  const list = build([object(3)], { 3: { ...baseOnly, bc: 5 } }, table);
  const live = { colors: table, triggers: { hasMotion: false, groupAlphaOf: () => 1 } as unknown as TriggerRuntime };
  const additive = (): number => new Uint8Array(list.visible(VIEW, live, 0).buffer)[46];
  assert.equal(additive(), BLEND.ADD_SPRITE);
  table.startFade({ channel: 5, r: 255, g: 255, b: 255, duration: 0, opacity: 1, blending: false, copyId: 0, copyHsv: null, copyOpacity: false });
  table.process();
  assert.equal(additive(), 0);
});

test("a warp draws the two axes turned apart; a solid keeps neither, and loses 45°", () => {
  // 131 = 30, 132 = -60 on a decoration: the y axis turns 30°, the x axis -60°.
  // A solid (id 1) without key 121 ignores both, and its 45° is cut to 0.
  // [objectFromVector :184214-184237]
  const table = ColorTable.resolve(makeHeader());
  const list = build(
    [object(5, { 131: "30", 132: "-60" }), object(1, { 131: "30", 132: "-60", 6: "45" }, { rotation: 45 })],
    { 5: baseOnly, 1: baseOnly },
    table,
  );
  const data = list.visible(VIEW, null, 0);
  // Half a block across: a = cos 60° × 15, b = sin 60° × 15 from rotation Y,
  // c = sin 30° × 15, d = cos 30° × 15 from rotation X.
  // [CCNode::nodeToParentTransform :788592-788613]
  const want = [7.5, 12.990381, 7.5, 12.990381];
  Array.from(data.slice(0, 4)).forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-5, `warp ${i}: ${v} vs ${want[i]}`));
  const flat = affine(0, 0, 0, 1, 1);
  assert.deepEqual(Array.from(data.slice(12, 16)), [flat.a * 15, flat.b * 15, flat.c * 15, flat.d * 15]);
});

test("equal warp angles are an ordinary turn", () => {
  const a = affineXY(3, 4, 30, 30, 2, 0.5);
  const b = affine(3, 4, 30, 2, 0.5);
  for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) assert.ok(Math.abs(a[k] - b[k]) < 1e-12, k);
});

test("rotation Y turns the x axis and rotation X the y axis", () => {
  // a = cos(-rotY)·sx, b = sin(-rotY)·sx, c = -sin(-rotX)·sy, d = cos(-rotX)·sy.
  // [CCNode::nodeToParentTransform :788592-788613]
  const m = affineXY(3, 4, 30, 90, 2, 0.5);
  const want = { a: 0, b: -2, c: 0.25, d: 0.4330127, tx: 3, ty: 4 };
  for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) assert.ok(Math.abs(m[k] - want[k]) < 1e-6, `${k}: ${m[k]}`);
});

// --- colour triggers ----------------------------------------------------------

/** A level whose colour triggers all sit behind the start, stepped once with the visuals on. */
function fired(triggers: Placed[], player1?: { r: number; g: number; b: number }, player2?: { r: number; g: number; b: number }): ColorTable {
  const sim = makeSim(emptyLevel(triggers), undefined, { visuals: true, player1, player2, start: { x: 45, y: STANDING_Y } });
  sim.step(NO_INPUT);
  sim.triggers.updateVisuals(0);
  return sim.triggers.colors;
}

const rgbOf = (t: ColorTable, id: number) => [t.get(id).r, t.get(id).g, t.get(id).b];
const trigger = (id: number, x: number, props: Record<number, string>): Placed => ({ id, x, y: 100, props: { 7: "10", 8: "20", 9: "30", 10: "0", ...props } });

test("a Color Trigger without key 23 recolours channel 1", () => {
  // Every object starts aimed at channel 1; key 23 moves it only above 1.
  // [GameObject::GameObject :165584; customObjectSetup :299793-299800]
  assert.deepEqual(rgbOf(fired([trigger(899, 15, {})]), 1), [10, 20, 30]);
  assert.deepEqual(rgbOf(fired([trigger(899, 15, { 23: "1" })]), 1), [10, 20, 30]);
  assert.deepEqual(rgbOf(fired([trigger(899, 15, { 23: "6" })]), 6), [10, 20, 30]);
});

test("900 recolours the second ground, and the 1.x channel triggers ignore key 23", () => {
  // [EffectGameObject::customSetup :302332-302337; objectFromVector
  //  :184244-184275 (221 → 1, sets after key 23)]
  const t = fired([trigger(900, 15, {}), trigger(221, 15, { 23: "9", 7: "40" })]);
  assert.deepEqual(rgbOf(t, CHANNEL.GROUND_2), [10, 20, 30]);
  assert.deepEqual(rgbOf(t, 4), [255, 255, 255], "not channel 4");
  assert.deepEqual(rgbOf(t, 1), [40, 20, 30]);
  assert.deepEqual(rgbOf(t, 9), [255, 255, 255]);
  // The 1.x Col 4 trigger is the one that recolours channel 4.
  // [objectFromVector :183934-183945 (made as 899), :184259-184264 (+880 = 4)]
  const col4 = fired([trigger(743, 15, { 23: "9" })]);
  assert.deepEqual(rgbOf(col4, 4), [10, 20, 30]);
  assert.deepEqual(rgbOf(col4, 9), [255, 255, 255]);
});

test("a 1.x Line trigger is additive whatever key 17 says; 915 follows key 17", () => {
  // [objectFromVector :184267-184270]
  assert.equal(fired([trigger(104, 15, { 17: "0" })]).get(CHANNEL.LINE).blending, true);
  assert.equal(fired([trigger(915, 15, { 17: "0" })]).get(CHANNEL.LINE).blending, false);
  assert.equal(fired([trigger(915, 15, { 17: "1" })]).get(CHANNEL.LINE).blending, true);
});

test("a colour trigger's opacity counts only with key 36, and is 0 when key 35 is missing then", () => {
  // [customObjectSetup :299801-299812]
  assert.equal(fired([trigger(899, 15, { 23: "3", 36: "1" })]).get(3).a, 0);
  assert.equal(fired([trigger(899, 15, { 23: "3", 36: "1", 35: "0.5" })]).get(3).a, 0.5);
  assert.equal(fired([trigger(899, 15, { 23: "3", 35: "0.5" })]).get(3).a, 1, "no 36: opaque");
});

test("Player Color 1 or 2 takes the player's strengthened colour, key 15 first", () => {
  // [PlayLayer::addObject :90024-90045]
  const p1 = { r: 150, g: 50, b: 0 };
  const p2 = { r: 90, g: 90, b: 90 };
  assert.deepEqual(rgbOf(fired([trigger(899, 15, { 23: "3", 15: "1", 16: "1" })], p1, p2), 3), [225, 75, 0]);
  assert.deepEqual(rgbOf(fired([trigger(29, 15, { 16: "1" })], p1, p2), CHANNEL.BG), [135, 135, 135]);
});

test("an Animate trigger counts on the objects that wait for one, and only those", () => {
  // [EffectGameObject::triggerObject :315512-315513 → playAnimationCommand
  //  :422977-423004 → animationTriggered :164755-164759 (key 123)]
  const emitter: Placed = { id: 2065, x: 300, y: 100, props: { 57: "5", 123: "1" } };
  const other: Placed = { id: 2065, x: 330, y: 100, props: { 57: "5" } };
  const animate: Placed = { id: 1585, x: 15, y: 100, props: { 51: "5" } };
  const level = emptyLevel([emitter, other, animate]);
  const at = level.objects.length - 3;
  level.objects[at].groups.push(5);
  level.objects[at + 1].groups.push(5);
  const sim = makeSim(level, undefined, { visuals: true, start: { x: 45, y: STANDING_Y } });
  sim.step(NO_INPUT);
  assert.equal(sim.triggers.animationsOf(at), 1);
  assert.equal(sim.triggers.animationsOf(at + 1), 0, "no key 123");
});

// --- what each object decides about its own drawing ------------------------------

/** An atlas with any frames asked for, each `size` px square at 4 px a unit, side by side. */
function atlasOf(frames: Array<[name: string, size: number]>): AtlasSet {
  let x = 0;
  const list = frames.map(([n, size]) => {
    const f = { n, x, y: 0, w: size, h: size };
    x += size + 8;
    return f;
  });
  const file: AtlasFile = {
    version: 1,
    res: "uhd",
    pxPerUnit: 4,
    atlases: [{ name: "t", image: "t.png", w: Math.max(256, x), h: 256, frames: list }],
    frames: Object.fromEntries(list.map((f, i) => [f.n, [0, i]])),
  };
  return new (AtlasSet as unknown as new (f: AtlasFile) => AtlasSet)(file);
}

function buildWith(objects: LevelObject[], records: Record<number, ObjectRecord>, table: ColorTable, set: AtlasSet): DrawList {
  const level: Level = { header: makeHeader(), objects: objects.map((o, index) => ({ ...o, index })), lengthUnits: 1000 };
  return DrawList.build(level, (id) => records[id], set, table);
}

/** A live scene with nothing moving, every group at full alpha, and the enter tables given. */
function liveWith(table: ColorTable, extra: Record<string, unknown> = {}, enterIn: number = ENTER.fade, enterOut: number = ENTER.fade): LiveScene {
  const enter = { in: new Uint8Array(101).fill(enterIn), out: new Uint8Array(101).fill(enterOut) };
  return {
    colors: table,
    triggers: { hasMotion: false, groupAlphaOf: () => 1, visual: { enter }, ...extra } as unknown as TriggerRuntime,
  };
}

const floatsOf = (data: Float32Array, i: number): number[] => Array.from(data.slice(i * 12, i * 12 + 6));
const near = (got: number[], want: number[], what: string, eps = 1e-4): void =>
  got.forEach((v, k) => assert.ok(Math.abs(v - want[k]) < eps, `${what} [${k}]: ${v} vs ${want[k]}`));

test("a hidden object (key 135) draws nothing at all in play, glow and children included", () => {
  // atoi, so "2" hides too. [objectFromVector :184143-184146; saveActiveColors
  //  :173315-173322; activateObject :169451-169475; addGlow :165833]
  const table = ColorTable.resolve(makeHeader());
  const shown = build([object(1, { 135: "1" }), object(1, {}, { index: 1 })], { 1: baseOnly }, table);
  shown.visible(VIEW, null, 0);
  assert.equal(shown.visibleCount, 1);
  assert.equal(shown.stats.hidden, 1);
  const zero = build([object(1, { 135: "0" }), object(1, { 135: "2" })], { 1: baseOnly }, table);
  zero.visible(VIEW, null, 0);
  assert.equal(zero.visibleCount, 1, "135 = 0 shows, 135 = 2 hides");
  const full = build([object(1, { 135: "1" })], { 1: { ...withDetail, g: "b.png" } }, table);
  full.visible(VIEW, null, 0);
  assert.equal(full.visibleCount, 0);
});

test("key 96 drops the object's glow and keeps the rest", () => {
  // [objectFromVector :184210-184213 (+876); GameObject::setVisible :164695-164705]
  const table = ColorTable.resolve(makeHeader());
  const glowing: ObjectRecord = { ...baseOnly, g: "b.png" };
  const list = build([object(3), object(3, { 96: "1" })], { 3: glowing }, table);
  const data = list.visible(VIEW, null, 0);
  assert.equal(list.visibleCount, 3);
  assert.equal(new Uint8Array(data.buffer)[46], BLEND.ADD_SPRITE, "the first object's glow, drawn first and additive");
});

test("keys 64 and 67 exempt an object from the enter fade and the enter motion", () => {
  // From the bottom, the object's centre 35 inside the right edge: halfway in.
  // A 30-unit block's fade is measured from its centre (+704 is 0 up to a
  // block wide), so it is half faded too. [saveActiveColors :173306-173309;
  //  updateVisibility :96038-96066; applyEnterEffect :91103-91108]
  const table = ColorTable.resolve(makeHeader());
  const screen = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  const cases: Array<[Record<number, string>, number, number]> = [
    [{}, 128, -50],
    [{ 64: "1" }, 255, -50],
    [{ 67: "1" }, 128, 0],
    [{ 64: "1", 67: "1" }, 255, 0],
  ];
  for (const [props, alpha, py] of cases) {
    const list = build([object(1, props, { x: 965 })], { 1: baseOnly }, table);
    const data = list.visible(VIEW, liveWith(table, {}, ENTER.fromBottom), 0, screen);
    assert.equal(new Uint8Array(data.buffer)[43], alpha, `alpha with ${JSON.stringify(props)}`);
    assert.ok(Math.abs(data[5] - py) < 1e-4, `y with ${JSON.stringify(props)}: ${data[5]}`);
  }
});

test("an object keeps the enter effect it started coming in with, and takes a new one the next time", () => {
  // The latch (+864) holds while the object is on its way in, and lapses
  // once it has been out of view. [applyEnterEffect :91103-91140, :91290-91297]
  const table = ColorTable.resolve(makeHeader());
  const screen = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  const list = build([object(1, {}, { x: 965 })], { 1: baseOnly }, table);
  const y = (live: LiveScene, view = VIEW): number => {
    const data = list.visible(view, live, 0, screen);
    return list.visibleCount > 0 ? data[5] : Number.NaN;
  };
  assert.ok(Math.abs(y(liveWith(table, {}, ENTER.fromBottom)) + 50) < 1e-4);
  assert.ok(Math.abs(y(liveWith(table, {}, ENTER.fromTop)) + 50) < 1e-4, "still the one it latched");
  assert.ok(Number.isNaN(y(liveWith(table, {}, ENTER.fromTop), { x0: 2000, y0: -1000, x1: 3000, y1: 1000 })), "out of view");
  assert.ok(Math.abs(y(liveWith(table, {}, ENTER.fromTop)) - 50) < 1e-4, "back in view: the new one");
});

test("an enter effect is the object's, not each sprite's: a child moves and scales with it", () => {
  // applyEnterEffect moves and scales the object, and its children follow.
  // [applyEnterEffect :91232-91290 (setPosition, setRScaleX/Y)]
  const table = ColorTable.resolve(makeHeader());
  const screen = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  const twoParts: ObjectRecord = { ...baseOnly, ch: [{ f: "b.png", dx: 40, dy: 0, z: 1 }] };
  const list = build([object(1, {}, { x: 965 })], { 1: twoParts }, table);
  const data = list.visible(VIEW, liveWith(table, {}, ENTER.smallToBig), 0, screen);
  assert.equal(list.visibleCount, 2);
  // Halfway in: half size, the child half as far from the object as it rests.
  near(floatsOf(data, 0), [7.5, 0, 0, 7.5, 965, 0], "the main sprite");
  near(floatsOf(data, 1), [7.5, 0, 0, 7.5, 985, 0], "the child");
  const bytes = new Uint8Array(data.buffer);
  assert.equal(bytes[43], bytes[INSTANCE_BYTES + 43], "both fade as one");
});

test("an object that pulses to the music is not scaled by an enter effect, unless key 372 stops the pulse", () => {
  // [applyEnterEffect :91256-91278 (+824 and not +825)]
  const table = ColorTable.resolve(makeHeader());
  const screen = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  const half = (id: number, props: Record<number, string> = {}): number => {
    const list = build([object(id, props, { x: 965 })], { [id]: baseOnly }, table);
    return list.visible(VIEW, liveWith(table, {}, ENTER.smallToBig), 0, screen)[0];
  };
  assert.ok(Math.abs(half(1) - 7.5) < 1e-6, "a block grows in");
  assert.ok(Math.abs(half(36) - 15) < 1e-6, "a yellow orb does not");
  assert.ok(Math.abs(half(36, { 372: "1" }) - 7.5) < 1e-6, "unless its pulse is off");
});

test("the solid colour blocks skip the default fade, unless they blend", () => {
  // [customSetup +889/+892; updateVisibility :96043-96050]
  const header = makeHeader();
  header.colors.set(5, entry(5, { r: 255, g: 255, b: 255, blending: true }));
  const table = ColorTable.resolve(header);
  const screen = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  const alphaOf = (id: number, record: ObjectRecord): number => {
    const list = build([object(id, {}, { x: 990 })], { [id]: record }, table);
    return new Uint8Array(list.visible(VIEW, liveWith(table), 0, screen).buffer)[43];
  };
  assert.equal(alphaOf(1, baseOnly), Math.round((10 / 70) * 255), "an ordinary block fades");
  assert.equal(alphaOf(207, baseOnly), 255, "a colour block does not");
  assert.equal(alphaOf(207, { ...baseOnly, bc: 5 }), Math.round((10 / 70) * 255), "unless its colour blends");
  assert.equal(alphaOf(90, { ...baseOnly, bc: 5 }), 255, "90 is exempt even blending");
});

test("an invisible block fades with its distance from the middle of the screen, and its glow takes the background", () => {
  // The tint is setGlowColor's (vfunc 744): the block itself keeps its
  // channel's colour. [PlayLayer::updateInvisibleBlock :91356-91444; the
  //  bands updateVisibility hands it :95854-95856, the dead branch
  //  :96020-96025; GameObject::setGlowColor :164902-164915]
  const header = makeHeader();
  header.colors.set(1004, entry(1004, { r: 200, g: 30, b: 60 }));
  const table = ColorTable.resolve(header);
  const screen = { x0: -284.5, y0: -200, x1: 284.5, y1: 200 };
  const view = { x0: -400, y0: -400, x1: 400, y1: 400 };
  const glowing: ObjectRecord = { ...baseOnly, g: "b.png" };
  const at = (x: number, dead = false): { alpha: number; glow: number; glowRgb: number[]; blockRgb: number[] } => {
    const list = build([object(144, {}, { x })], { 144: glowing }, table);
    const live = { ...liveWith(table), playerDead: () => dead };
    const bytes = new Uint8Array(list.visible(view, live, 0, screen).buffer);
    // The glow sits just behind the block, so it is drawn first.
    const s = INSTANCE_BYTES;
    return {
      glow: bytes[43],
      alpha: bytes[s + 43],
      glowRgb: [bytes[40], bytes[41], bytes[42]],
      blockRgb: [bytes[s + 40], bytes[s + 41], bytes[s + 42]],
    };
  };
  // Near the middle: 5 % (12 of 255), its glow 15 %.
  assert.deepEqual([at(0).alpha, at(0).glow], [12, 38]);
  // 65 into the right-hand band of 159.5: (0.05 + 0.95 × 0.4075) × 255.
  assert.equal(at(100).alpha, 111);
  assert.equal(at(200).alpha, 255);
  // Inside the edge fade at the right: (284.5 − 270) / 50.
  assert.equal(at(270).alpha, Math.trunc((14.5 / 50) * 255));
  const tint = applyHsv(table.get(CHANNEL.BG), { h: 0, s: -0.2, v: 0.2, sChecked: true, vChecked: true });
  assert.deepEqual(at(0).glowRgb, [tint.r, tint.g, tint.b], "faint, the glow is the background's tint");
  assert.deepEqual(at(0).blockRgb, [200, 30, 60], "and the block keeps 1004's colour");
  // Dead, it shows in full; the glow is the background's washed-out colour.
  const shown = at(0, true);
  assert.equal(shown.alpha, 255);
  assert.deepEqual(shown.glowRgb, [tint.r, tint.g, tint.b]);
  assert.deepEqual(shown.blockRgb, [200, 30, 60]);
});

test("a +929 object's glow takes the background, a +930 one the light background, and a locked glow keeps its own", () => {
  // [setObjectColor :165358-165364 (no glow colour with +929);
  //  updateVisibility :95996-95997 (143), :96010-96018; setupCustomSprites
  //  :613125-613129 (1022), :611349-611356 (3004); setGlowColor :164902-164915]
  const header = makeHeader();
  header.colors.set(1000, entry(1000, { r: 40, g: 80, b: 160 }));
  header.colors.set(1004, entry(1004, { r: 200, g: 30, b: 60 }));
  const table = ColorTable.resolve(header);
  const glowing: ObjectRecord = { ...baseOnly, g: "b.png" };
  const rgbOf = (id: number): { glow: number[]; main: number[] } => {
    const list = build([object(id)], { [id]: glowing }, table);
    const bytes = new Uint8Array(list.visible(VIEW, liveWith(table), 0).buffer);
    const s = INSTANCE_BYTES;
    return { glow: [bytes[40], bytes[41], bytes[42]], main: [bytes[s + 40], bytes[s + 41], bytes[s + 42]] };
  };
  const bg = applyHsv(table.get(CHANNEL.BG), { h: 0, s: -0.2, v: 0.2, sChecked: true, vChecked: true });
  const light = table.get(CHANNEL.LIGHT_BG);
  assert.deepEqual(rgbOf(1).glow, [200, 30, 60], "a block's glow is its own colour");
  assert.deepEqual(rgbOf(177).glow, [bg.r, bg.g, bg.b], "an ice spike's is the background's tint");
  assert.deepEqual(rgbOf(177).main, [200, 30, 60], "while the spike keeps its own");
  assert.deepEqual(rgbOf(143).glow, [bg.r, bg.g, bg.b], "the brick's too, by its id");
  assert.deepEqual(rgbOf(397).glow, [light.r, light.g, light.b], "a dark blade's is the light background");
  assert.deepEqual(rgbOf(3004).glow, [100, 0, 255], "the spider orb's is locked");
  assert.deepEqual(rgbOf(1022).glow, [25, 255, 25], "and the green orb's");
});

test("a sprite the game never draws still carries its children", () => {
  // CCSprite's don't-draw flag (+471): the colour sprite of the looped fires
  // hangs the visible colour on a child at twice its size, and the block
  // pieces' own sprite is a placeholder for theirs. [setupCustomSprites
  //  :612779-612787, :609625-609626]
  const table = ColorTable.resolve(makeHeader());
  const parent: ChildRecord = { f: "b.png", dx: 0, dy: 0, z: -100, ct: "D", dd: 1, ch: [{ f: "b.png", dx: 0, dy: 0, z: -1, sx: 2, sy: 2, ct: "D" }] };
  const fire: ObjectRecord = { ...withDetail, ch: [parent] };
  const list = build([object(920)], { 920: fire }, table);
  const data = list.visible(VIEW, null, 0);
  assert.equal(list.visibleCount, 2, "the object and the doubled child, not the colour sprite");
  near(floatsOf(data, 0), [30, 0, 0, 30, 0, 0], "the doubled child");
  const pieces: ObjectRecord = { ...baseOnly, dd: 1, ch: [{ f: "b.png", dx: 15, dy: 0, z: 0 }] };
  const block = build([object(1773)], { 1773: pieces }, table);
  const drawn = block.visible(VIEW, null, 0);
  assert.equal(block.visibleCount, 1, "only the piece");
  near(floatsOf(drawn, 0), [15, 0, 0, 15, 15, 0], "the piece");
});

test("a group toggled off is not drawn", () => {
  // [GJBaseGameLayer::preUpdateVisibility :452902]
  const table = ColorTable.resolve(makeHeader());
  const list = build([object(1, {}, { groups: [4] }), object(1, {}, { groups: [4] })], { 1: baseOnly }, table);
  list.visible(VIEW, liveWith(table, { hasToggles: true, objectDisabled: (i: number) => i === 0 }), 0);
  assert.equal(list.visibleCount, 1);
});

test("a group pulse colours the object before its hue shift, and a lighter detail follows the worn main", () => {
  // [GameObject::colorForMode :173028-173089; getActiveColorForMode, 1012 branch]
  const header = makeHeader();
  header.colors.set(5, entry(5, { r: 255, g: 255, b: 255 }));
  const table = ColorTable.resolve(header);
  const half: HsvShift = { h: 0, s: 1, v: 0.5, sChecked: false, vChecked: false };
  const red = { r: 255, g: 0, b: 0 };
  const pulse = (detailOnly: boolean, colour = red) => ({
    target: 7,
    fadeIn: 0,
    hold: 10,
    fadeOut: 0,
    elapsed: 0,
    value: 1,
    mode: 2 as const,
    colour,
    hsv: { h: 0, s: 1, v: 1, sChecked: false, vChecked: false },
    copyChannel: 0,
    mainOnly: false,
    detailOnly,
    animateHsv: false,
  });
  table.addPulse(pulse(false), true, false);
  const list = build([object(3, {}, { groups: [7], baseHsv: half })], { 3: { ...baseOnly, bc: 5 } }, table);
  const bytes = new Uint8Array(list.visible(VIEW, liveWith(table), 0).buffer);
  const want = applyHsv(red, half);
  assert.deepEqual([bytes[40], bytes[41], bytes[42]], [want.r, want.g, want.b], "red, then halved");

  const header2 = makeHeader();
  header2.colors.set(5, entry(5, { r: 200, g: 0, b: 0 }));
  const table2 = ColorTable.resolve(header2);
  table2.addPulse(pulse(true, { r: 0, g: 0, b: 255 }), true, false);
  const turn: HsvShift = { h: 120, s: 1, v: 1, sChecked: false, vChecked: false };
  const lighter = build([object(4, {}, { groups: [7], baseHsv: turn })], { 4: { ...withDetail, bc: 5, dc: 1012 } }, table2);
  const lb = new Uint8Array(lighter.visible(VIEW, liveWith(table2), 0).buffer);
  const detail = lighterColor(applyHsv({ r: 200, g: 0, b: 0 }, turn));
  // Id 4 has no +909, so addColorSpriteToSelf hangs its colour sprite behind
  // it: the detail is drawn first. [addColorSpriteToSelf :168655-168660]
  const s = 0;
  assert.deepEqual([lb[s + 40], lb[s + 41], lb[s + 42]], [detail.r, detail.g, detail.b], "lighter of the turned main, no pulse of its own");
  const raw = lighterColor({ r: 200, g: 0, b: 0 });
  assert.notDeepEqual([detail.r, detail.g, detail.b], [raw.r, raw.g, raw.b], "not the lighter of the raw channel");
});

test("four anchored quarters meet at the object's centre (1886, the radial glow)", () => {
  // Each quadrant's bottom-right corner sits on the centre, mirrored by its
  // scale. [setupCustomSprites :610143-610190]
  const table = ColorTable.resolve(makeHeader());
  const set = atlasOf([["g.png", 80]]);
  const quarter = (over: Partial<ChildRecord>): ChildRecord => ({ f: "g.png", dx: 0, dy: 0, z: -1, ax: 0.5, ay: -0.5, ...over });
  const glow: ObjectRecord = {
    k: "decoration",
    hb: null,
    src: "table",
    p: { hb: "none", art: "manual", z: "none" },
    ch: [quarter({}), quarter({ sx: -1 }), quarter({ sx: -1, sy: -1 }), quarter({ sy: -1 })],
  };
  const list = buildWith([object(1886)], { 1886: glow }, table, set);
  const data = list.visible(VIEW, null, 0);
  assert.equal(list.visibleCount, 4);
  near(floatsOf(data, 0), [10, 0, 0, 10, -10, 10], "top left");
  near(floatsOf(data, 1), [-10, 0, 0, 10, 10, 10], "top right");
  near(floatsOf(data, 2), [-10, 0, 0, -10, 10, -10], "bottom right");
  near(floatsOf(data, 3), [10, 0, 0, -10, -10, -10], "bottom left");
  // Dash #698: scaled 1.379 by 1.574 at (1227, 21), a 55 × 63 glow.
  const dash = buildWith([object(1886, {}, { x: 1227, y: 21, scaleX: 1.379, scaleY: 1.574 })], { 1886: glow }, table, set);
  const d = dash.visible({ x0: 0, y0: -1000, x1: 3000, y1: 1000 }, null, 0);
  near(floatsOf(d, 0), [13.79, 0, 0, 15.74, 1213.21, 36.74], "Dash #698's first quarter");
});

test("an anchored child's flip mirrors it in place (1839-1842, the rings)", () => {
  // A texture flip leaves the anchor where it is. [setupCustomSprites
  //  :609992-610030; CCSprite::setFlipX]
  const table = ColorTable.resolve(makeHeader());
  const set = atlasOf([["h.png", 120]]);
  const ring: ObjectRecord = {
    k: "decoration",
    hb: null,
    src: "table",
    p: { hb: "none", art: "manual", z: "none" },
    ch: [
      { f: "h.png", dx: 0, dy: 0, z: -1, ax: 0.5, ay: -0.5 },
      { f: "h.png", dx: 0, dy: 0, z: -1, ax: -0.5, ay: -0.5, fx: 1 },
      { f: "h.png", dx: 0, dy: 0, z: -1, ax: -0.5, ay: 0.5, fx: 1, fy: 1 },
      { f: "h.png", dx: 0, dy: 0, z: -1, ax: 0.5, ay: 0.5, fy: 1 },
    ],
  };
  const data = buildWith([object(1839)], { 1839: ring }, table, set).visible(VIEW, null, 0);
  near(floatsOf(data, 0), [15, 0, 0, 15, -15, 15], "first");
  near(floatsOf(data, 1), [-15, 0, 0, 15, 15, 15], "second");
  near(floatsOf(data, 2), [-15, 0, 0, -15, 15, -15], "third");
  near(floatsOf(data, 3), [15, 0, 0, -15, -15, -15], "fourth");
});

test("an animated object plays the game's frames, and one on a trigger waits for it", () => {
  // 2041 is twelve frames at 0.05 s. [setupGameAnimations; updateSyncedAnimation]
  const table = ColorTable.resolve(makeHeader());
  const names = Array.from({ length: 12 }, (_, i): [string, number] => [`gj22_anim_22_${String(i + 1).padStart(3, "0")}.png`, 40 + i * 4]);
  const set = atlasOf(names);
  const record: ObjectRecord = { ...baseOnly, f: "gj22_anim_22_006.png", bc: 1 };
  const plain = buildWith([object(2041, { 122: "1", 107: "1" })], { 2041: record }, table, set);
  const width = (data: Float32Array): number => data[0];
  assert.equal(plain.stats.animated, 1);
  // Frame 3 is 48 px, a half-width of 6 units.
  assert.ok(Math.abs(width(plain.visible(VIEW, null, 0.12)) - 6) < 1e-6);
  assert.ok(Math.abs(width(plain.visible(VIEW, null, 0.61)) - 5) < 1e-6, "frame 1 again");
  const waiting = buildWith([object(2041, { 123: "1", 122: "1", 107: "1" })], { 2041: record }, table, set);
  waiting.visible(VIEW, liveWith(table, { levelTime: 3 }), 3);
  assert.equal(waiting.visibleCount, 0, "hidden until an Animate trigger");
  const after = waiting.visible(VIEW, liveWith(table, { levelTime: 3.12, animationStartOf: () => 3 }), 3.12);
  assert.equal(waiting.visibleCount, 1);
  assert.ok(Math.abs(width(after) - 6) < 1e-6, "frame 3, counted from the trigger");
  waiting.visible(VIEW, liveWith(table, { levelTime: 3.7, animationStartOf: () => 3 }), 3.7);
  assert.equal(waiting.visibleCount, 0, "one play, then hidden again");
});

test("a rotating object turns its sprites about its own centre while it is on screen", () => {
  // [EnhancedGameObject::updateRotateAction :182804-182870, called from
  //  updateVisibility :95987-95988; key 97 :181779-181798]
  const table = ColorTable.resolve(makeHeader());
  const wheel: ObjectRecord = { ...baseOnly, ch: [{ f: "b.png", dx: 10, dy: 0, z: 1 }] };
  const list = build([object(1752, { 97: "90" })], { 1752: wheel }, table);
  assert.equal(list.stats.spinning, 1);
  list.visible(VIEW, null, 0);
  const data = list.visible(VIEW, null, 1);
  // A quarter turn clockwise: the child at (10, 0) goes to (0, −10).
  near(floatsOf(data, 1), [0, -15, 15, 0, 0, -10], "the child");
  near(floatsOf(data, 0), [0, -15, 15, 0, 0, 0], "the main sprite");
  // Key 98 stops it; an id that does not turn never does.
  assert.equal(build([object(1752, { 98: "1" })], { 1752: wheel }, table).stats.spinning, 0);
  assert.equal(build([object(1, { 97: "90" })], { 1: wheel }, table).stats.spinning, 0);
  // Without key 97 the speed is the id's own with a random sign.
  const speeds = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => rotationSpeed({ ...object(1752), index: i }));
  assert.ok(speeds.every((s) => Math.abs(s) >= 270 && Math.abs(s) <= 360));
  assert.ok(speeds.some((s) => s < 0) && speeds.some((s) => s > 0));
  assert.equal(rotationBase(1619, 0.5), 720);
});

test("the shipped table keeps an anchored child's flip apart from its scale", { skip: OBJECTS_SKIP }, () => {
  const file = JSON.parse(readFileSync(OBJECTS_PATH, "utf8")) as { objects: Record<string, ObjectRecord> };
  const glow = file.objects["1886"].ch?.[1];
  assert.deepEqual([glow?.ax, glow?.ay, glow?.sx, glow?.fx], [0.5, -0.5, -1, undefined]);
  const ring = file.objects["1839"].ch?.[1];
  assert.deepEqual([ring?.ax, ring?.ay, ring?.sx, ring?.fx], [-0.5, -0.5, undefined, 1]);
  // All three radial glows add their quadrants at the centre; gdclone's ±0.25
  // on 1888 would open a cross through it. [setupCustomSprites :610143-610190]
  for (const id of ["1886", "1887", "1888"]) {
    const quarters = file.objects[id].ch ?? [];
    assert.equal(quarters.length, 4, id);
    assert.deepEqual(quarters.map((c) => [c.dx, c.dy]), [[0, 0], [0, 0], [0, 0], [0, 0]], id);
  }
});

test("the editor-only objects draw nothing in play: start positions, the letter blocks, collision blocks, keyframes", () => {
  // customSetup makes them invisible outside the editor, as key 135 does.
  // [GameObject::customSetup :177924…:178496 (+855 = !+549); activateObject
  //  :169451-169475]
  const table = ColorTable.resolve(makeHeader());
  const shown = build([31, 1755, 1816, 3032, 1].map((id, index) => object(id, {}, { index })), { 31: baseOnly, 1755: withDetail, 1816: baseOnly, 3032: baseOnly, 1: baseOnly }, table);
  shown.visible(VIEW, null, 0);
  assert.equal(shown.visibleCount, 1, "only the block");
  assert.equal(shown.stats.hidden, 4);
});

test("a glow fades in and out with its object; only an invisible block sets its own", () => {
  // setOpacity hands setGlowOpacity the same faded value. [GameObject::
  //  setOpacity :167614-167660; updateInvisibleBlock :91418-91426]
  const table = ColorTable.resolve(makeHeader());
  const screen = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  const glowing: ObjectRecord = { ...baseOnly, g: "b.png" };
  const list = build([object(3, {}, { x: 990 })], { 3: glowing }, table);
  const bytes = new Uint8Array(list.visible(VIEW, liveWith(table), 0, screen).buffer);
  assert.equal(list.visibleCount, 2);
  const want = Math.round((10 / 70) * 255);
  assert.deepEqual([bytes[43], bytes[INSTANCE_BYTES + 43]], [want, want], "the glow, then the sprite");
  // Going out at the left as well.
  const out = build([object(3, {}, { x: -990 })], { 3: glowing }, table);
  const ob = new Uint8Array(out.visible(VIEW, liveWith(table), 0, screen).buffer);
  assert.deepEqual([ob[43], ob[INSTANCE_BYTES + 43]], [want, want]);
});

test("a light square fades when either half blends, its detail as well as its base", () => {
  // +960 is the main half's blending, else the detail half's.
  // [addMainSpriteToParent :169316-169320; updateVisibility :96043-96050]
  const header = makeHeader();
  header.colors.set(5, entry(5, { r: 255, g: 255, b: 255, blending: true }));
  header.colors.set(6, entry(6, { r: 255, g: 255, b: 255 }));
  const table = ColorTable.resolve(header);
  const screen = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  const alphaOf = (record: ObjectRecord): number => {
    const list = build([object(207, {}, { x: 990 })], { 207: record }, table);
    return new Uint8Array(list.visible(VIEW, liveWith(table), 0, screen).buffer)[43];
  };
  assert.equal(alphaOf({ ...withDetail, bc: 6, dc: 6 }), 255, "neither half blends: no fade");
  assert.equal(alphaOf({ ...withDetail, bc: 6, dc: 5 }), Math.round((10 / 70) * 255), "only the detail blends: it fades");
});

test("the fade's lead: a quarter turn swaps the sides, other turns take the diagonal, a custom rect has none", () => {
  // [GameObject::getObjectTextureRect :165040-165097; setRotation +760 :164488]
  const table = ColorTable.resolve(makeHeader());
  const screen = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  const set = atlasOf([["w.png", 240]]);
  const wide: ObjectRecord = { ...baseOnly, f: "w.png" };
  // A 60-unit frame scaled 2 across: 120 wide, 60 tall, so +704 is 45 upright.
  const alphaAt = (id: number, rotation: number): number => {
    const list = buildWith([object(id, {}, { x: 990, rotation, scaleX: 2 })], { [id]: wide }, table, set);
    return new Uint8Array(list.visible(VIEW, liveWith(table), 0, screen).buffer)[43];
  };
  const fadeFor = (lead: number): number => Math.round(Math.min(1, (10 + lead) / 70) * 255);
  assert.equal(alphaAt(1, 0), fadeFor(45));
  assert.equal(alphaAt(1, 90), fadeFor(15), "a quarter turn: 60 wide");
  assert.equal(alphaAt(1, -270), fadeFor(15));
  const diagonal = Math.hypot(120, 60) / 2 - 15;
  assert.equal(alphaAt(1, 450), fadeFor(diagonal), "450 is no quarter turn to the game");
  assert.equal(alphaAt(1, 360), fadeFor(diagonal), "nor is a whole turn upright");
  assert.equal(alphaAt(1, 180), fadeFor(45));
  assert.equal(alphaAt(1020, 0), fadeFor(0), "1020 keeps its own rect, and no lead");
});

test("a turn follows the sim's clock, not how often the frame is drawn", () => {
  // The same moment of a macro draws a saw at the same angle at any display
  // rate or playback speed. [updateRotateAction :182804-182870]
  const table = ColorTable.resolve(makeHeader());
  const wheel: ObjectRecord = { ...baseOnly, ch: [{ f: "b.png", dx: 10, dy: 0, z: 1 }] };
  const childAt = (rate: number): number[] => {
    const list = build([object(1705, { 97: "300" })], { 1705: wheel }, table);
    let data = list.visible(VIEW, null, 0);
    for (let k = 1; k <= 3 * rate; k++) data = list.visible(VIEW, null, k / rate);
    return floatsOf(data, 1);
  };
  near(childAt(60), childAt(15), "60 Hz against 15 Hz");
  near(childAt(75), childAt(4), "75 Hz against 4 Hz");
});

test("a restart forgets the enter effect an object latched", () => {
  // resetLevel starts every object afresh. [PlayLayer::resetLevel :105839-105843]
  const table = ColorTable.resolve(makeHeader());
  const screen = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  const list = build([object(1, {}, { x: 965 })], { 1: baseOnly }, table);
  const y = (live: LiveScene): number => list.visible(VIEW, live, 0, screen)[5];
  assert.ok(Math.abs(y(liveWith(table, {}, ENTER.fromBottom)) + 50) < 1e-4);
  assert.ok(Math.abs(y(liveWith(table, {}, ENTER.fromTop)) + 50) < 1e-4, "latched");
  list.reset();
  assert.ok(Math.abs(y(liveWith(table, {}, ENTER.fromTop)) - 50) < 1e-4, "after a restart it takes the one in force");
});

test("an object far off screen is not settled: a moving one costs nothing until it nears the view", () => {
  // Only what can reach the view is worked out; its latch lapses meanwhile.
  const table = ColorTable.resolve(makeHeader());
  const screen = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
  const list = build([object(1, {}, { x: 965, groups: [3] })], { 1: baseOnly }, table);
  let asked = 0;
  const moved = (dx: number): LiveScene =>
    liveWith(
      table,
      {
        hasMotion: true,
        objectTransform: (_o: number, m: Float64Array): boolean => {
          asked++;
          m.set([1, 0, 0, 1, dx, 0, 0, 1, 1]);
          return true;
        },
      },
      ENTER.fromBottom,
    );
  list.visible(VIEW, moved(0), 0, screen);
  assert.equal(list.visibleCount, 1);
  asked = 0;
  list.visible(VIEW, moved(5000), 0, screen);
  assert.equal(list.visibleCount, 0);
  assert.equal(asked, 1, "one look at where it is, and nothing more");
});

// --- beasts ---------------------------------------------------------------------

/** A two-limb beast: limb 0 (tag 0) draws b.png over limb 1 (tag 1), a.png. */
function beastEntity(name: string): AnimEntity {
  const part = (tex: string, tag: number, z: number): AnimPart => ({ tex, tag, x: 0, y: 0, sx: 1, sy: 1, rot: 0, z });
  return {
    name,
    textures: [part("0", 0, 0), part("a.png", 1, 0)],
    frames: { [`${name}_idle_001.png`]: [part("a.png", 1, 0), part("b.png", 0, 1)] },
    animations: { idle: { delay: 0.05, frames: 1, looped: 1, prio: 0, usesParts: 1 } },
  };
}

test("a beast's body takes its main colour and the limb the game makes its colour sprite the detail colour", () => {
  // The whole animated sprite is set to the main colour; limb 0 of GJBeast02
  // is the object's colour sprite, which takes the detail colour. Key 21
  // overrides the black default like any object's.
  // [AnimatedGameObject::setupChildSprites :306803-307100; setObjectColor
  //  :297856-297860; setChildColor :297934-297947]
  const header = makeHeader();
  header.colors.set(5, entry(5, { r: 200, g: 0, b: 0 }));
  header.colors.set(6, entry(6, { r: 0, g: 200, b: 0 }));
  const table = ColorTable.resolve(header);
  const beast: ObjectRecord = { ...baseOnly, bc: 1010, dc: 1011, ct: "K", ent: "GJBeast02" };
  const entities = new Map([["GJBeast02", beastEntity("GJBeast02")]]);
  const rgbs = (o: LevelObject): number[][] => {
    const level: Level = { header: makeHeader(), objects: [{ ...o, index: 0 }], lengthUnits: 1000 };
    const list = DrawList.build(level, () => beast, atlas(), table, undefined, entities);
    const bytes = new Uint8Array(list.visible(VIEW, liveWith(table), 0).buffer);
    return [0, 1].map((i) => [bytes[i * INSTANCE_BYTES + 40], bytes[i * INSTANCE_BYTES + 41], bytes[i * INSTANCE_BYTES + 42]]);
  };
  assert.deepEqual(rgbs(object(1327, {}, { detailColor: 6 })), [
    [0, 0, 0],
    [0, 200, 0],
  ], "black body (1010 by default), detail-coloured eyes");
  assert.deepEqual(rgbs(object(1327, {}, { baseColor: 5, detailColor: 6 })), [
    [200, 0, 0],
    [0, 200, 0],
  ], "key 21 recolours the body");
  // The Black Sludge has no colour sprite: every limb is main.
  assert.deepEqual(rgbs(object(919, {}, { baseColor: 5, detailColor: 6 })), [
    [200, 0, 0],
    [200, 0, 0],
  ]);
});

test("GJBeast01's colour sprite is an extra sprite on limb 1, just above it", () => {
  // [AnimatedGameObject::setupChildSprites :307071-307086: addCustomColorChild
  //  "GJBeast01_03_001.png" on limb 1 at z 1, at its centre]
  const header = makeHeader();
  header.colors.set(5, entry(5, { r: 200, g: 0, b: 0 }));
  header.colors.set(6, entry(6, { r: 0, g: 200, b: 0 }));
  const table = ColorTable.resolve(header);
  const file: AtlasFile = {
    version: 1,
    res: "uhd",
    pxPerUnit: 4,
    atlases: [
      {
        name: "t",
        image: "t.png",
        w: 512,
        h: 128,
        frames: [
          { n: "a.png", x: 0, y: 0, w: 120, h: 120 },
          { n: "b.png", x: 128, y: 0, w: 120, h: 120 },
          { n: "GJBeast01_03_001.png", x: 256, y: 0, w: 40, h: 40 },
        ],
      },
    ],
    frames: { "a.png": [0, 0], "b.png": [0, 1], "GJBeast01_03_001.png": [0, 2] },
  };
  const set = new (AtlasSet as unknown as new (f: AtlasFile) => AtlasSet)(file);
  const beast: ObjectRecord = { ...baseOnly, bc: 1010, dc: 1011, ct: "K", ent: "GJBeast01" };
  const placed = { ...object(918, {}, { baseColor: 5, detailColor: 6 }), index: 0 };
  const level: Level = { header: makeHeader(), objects: [placed], lengthUnits: 1000 };
  const list = DrawList.build(level, () => beast, set, table, undefined, new Map([["GJBeast01", beastEntity("GJBeast01")]]));
  const data = list.visible(VIEW, liveWith(table), 0);
  const bytes = new Uint8Array(data.buffer);
  const rgb = (i: number): number[] => [bytes[i * INSTANCE_BYTES + 40], bytes[i * INSTANCE_BYTES + 41], bytes[i * INSTANCE_BYTES + 42]];
  // Limb 1 (a.png), the extra sprite centred on it, then limb 0 (b.png) on top.
  assert.equal(list.visibleCount, 3);
  assert.deepEqual([rgb(0), rgb(1), rgb(2)], [
    [200, 0, 0],
    [0, 200, 0],
    [200, 0, 0],
  ]);
  near(floatsOf(data, 1), [5, 0, 0, 5, 0, 0], "a 10-unit sprite at limb 1's centre");
});

// --- black art ----------------------------------------------------------------------

/** A black square with an outline that follows the main colour, as 62-68 are. */
const outlined: ObjectRecord = { ...baseOnly, ct: "K", ch: [{ f: "b.png", dx: 0, dy: 0, z: 1, ct: "B" }] };

interface Drawn {
  rgb: number[];
  a: number;
  blend: number;
}

function drawnSprites(list: DrawList, live: LiveScene | null): Drawn[] {
  const bytes = new Uint8Array(list.visible(VIEW, live, 0).buffer);
  const out: Drawn[] = [];
  for (let i = 0; i < list.visibleCount; i++) {
    const o = i * INSTANCE_BYTES;
    out.push({ rgb: [bytes[o + 40], bytes[o + 41], bytes[o + 42]], a: bytes[o + 43], blend: bytes[o + 46] });
  }
  return out;
}

test("black art stays black, and takes its opacity and its blend from the object's main colour", () => {
  // The game sets the object's own sprite black once and keeps it out of
  // setObjectColor (+541). The main colour, key 21's or the default 1004,
  // still decides how opaque the object is and whether its batch adds, and
  // it colours the outline hung on it; 1010's own opacity has no say.
  // [setupCustomSprites :614660-614800; setObjectColor :165359-165362;
  //  updateMainOpacity :172824-172832 → opacityModForMode; updateBlendMode
  //  :168557-168582 → shouldBlendColor; setOpacity :167631-167700]
  const header = makeHeader();
  header.colors.set(5, entry(5, { r: 200, g: 0, b: 0, opacity: 0.5, blending: true }));
  header.colors.set(1010, entry(1010, { opacity: 0.2 }));
  const table = ColorTable.resolve(header);
  const half = Math.round(channelOpacityMod(0.5) * 255);
  for (const live of [null, liveWith(table)]) {
    const what = live ? "live" : "as baked";
    const plain = drawnSprites(build([object(62)], { 62: outlined }, table), live);
    assert.deepEqual(plain, [
      { rgb: [0, 0, 0], a: 255, blend: BLEND.NORMAL },
      { rgb: [255, 255, 255], a: 255, blend: BLEND.NORMAL },
    ], `${what}: black on the default 1004, the outline in 1004`);
    const keyed = drawnSprites(build([object(62, {}, { baseColor: 5 })], { 62: outlined }, table), live);
    assert.deepEqual(keyed, [
      { rgb: [0, 0, 0], a: half, blend: BLEND.ADD_SPRITE },
      { rgb: [200, 0, 0], a: half, blend: BLEND.ADD_SPRITE },
    ], `${what}: key 21's channel makes it half opaque and additive, and colours only the outline`);
  }
});

test("a pulse reaches what is hung on black art, never the black art itself", () => {
  // A group pulse goes through colorForMode into setObjectColor, which
  // leaves a +541 sprite alone. [colorForMode :173063 (groupColor);
  //  setObjectColor :165359-165362]
  const table = ColorTable.resolve(makeHeader());
  const yellow = { r: 255, g: 255, b: 0 };
  const pulse: PulseAction = {
    target: 3, fadeIn: 0, hold: 1, fadeOut: 0, elapsed: 0, value: 1, mode: 2, colour: yellow,
    hsv: { h: 0, s: 1, v: 1, sChecked: false, vChecked: false }, copyChannel: 0, mainOnly: false, detailOnly: false,
    animateHsv: false,
  };
  const colours: ColorSource = { get: (id) => table.get(id), pulsesForGroup: (g) => (g === 3 ? [pulse] : undefined) };
  const live: LiveScene = { ...liveWith(table), colors: colours as ColorTable };
  const list = build([object(62, {}, { groups: [3] })], { 62: outlined }, table);
  assert.deepEqual(drawnSprites(list, live).map((s) => s.rgb), [[0, 0, 0], [255, 255, 0]]);
});

test("the glow of black art takes the main colour", () => {
  // setObjectColor hands the glow the main colour even where it leaves the
  // object's own sprite black. [setObjectColor :165358-165364 → setGlowColor]
  const header = makeHeader();
  header.colors.set(6, entry(6, { r: 0, g: 200, b: 0 }));
  const table = ColorTable.resolve(header);
  const glowing: ObjectRecord = { ...baseOnly, ct: "K", g: "b.png" };
  const sprites = drawnSprites(build([object(296, {}, { baseColor: 6 })], { 296: glowing }, table), liveWith(table));
  assert.deepEqual(sprites.map((s) => s.rgb), [[0, 200, 0], [0, 0, 0]], "the glow's batch is under the object's");
});

// --- portals ----------------------------------------------------------------------

function portalAtlas(): AtlasSet {
  const frames = ["portal_03_front_001.png", "portal_03_back_001.png", "portal_15_front_001.png", "portal_15_back_001.png", "portal_16_front_001.png", "portal_16_back_001.png"];
  const file: AtlasFile = {
    version: 1,
    res: "uhd",
    pxPerUnit: 4,
    atlases: [{ name: "t", image: "t.png", w: 1024, h: 512, frames: frames.map((n, k) => ({ n, x: k * 130, y: 0, w: 120, h: 360 })) }],
    frames: Object.fromEntries(frames.map((n, k) => [n, [0, k]])),
  };
  return new (AtlasSet as unknown as new (f: AtlasFile) => AtlasSet)(file);
}

const portalRecord = (f: string): ObjectRecord => ({ ...baseOnly, f, zl: 5, zo: 10, bc: undefined, dc: undefined, ct: undefined });

test("every portal draws its back half under the player, at its order less 100, in no colour", () => {
  // [PlayLayer::addObject :90062-90250: the back is an object of its own on
  //  layer 4 at the portal's order − 100; the portal's own order becomes 12]
  const header = makeHeader();
  header.colors.set(5, entry(5, { r: 200, g: 0, b: 0 }));
  const table = ColorTable.resolve(header);
  const level: Level = { header, objects: [{ ...object(12, {}, { x: 50, y: 60, baseColor: 5 }), index: 0 }], lengthUnits: 1000 };
  const list = DrawList.build(level, () => portalRecord("portal_03_front_001.png"), portalAtlas(), table);
  const data = list.visible(VIEW, liveWith(table), 0);
  const bytes = new Uint8Array(data.buffer);
  assert.equal(list.visibleCount, 2);
  // The back first: layer 4 sorts under the portal's T1.
  near(floatsOf(data, 0).slice(4), [50, 60], "the back half sits on the portal");
  assert.deepEqual([bytes[40], bytes[41], bytes[42]], [255, 255, 255], "the back takes no colour of the portal's");
  assert.deepEqual([bytes[INSTANCE_BYTES + 40], bytes[INSTANCE_BYTES + 41], bytes[INSTANCE_BYTES + 42]], [200, 0, 0], "the front keeps key 21");
});

test("a hidden portal has no back half", () => {
  const table = ColorTable.resolve(makeHeader());
  const level: Level = { header: makeHeader(), objects: [{ ...object(12, { 135: "1" }), index: 0 }], lengthUnits: 1000 };
  const list = DrawList.build(level, () => portalRecord("portal_03_front_001.png"), portalAtlas(), table);
  list.visible(VIEW, liveWith(table), 0);
  assert.equal(list.visibleCount, 0);
});

test("a linked teleport draws its exit 10 to the left and key 54 up, flipped the other way, with both back halves", () => {
  // [PlayLayer::addObject :89924-89965 (the 749 at x + getTeleportXOff and
  //  y + key 54, the flip inverted), then the back halves :90062-90250]
  const table = ColorTable.resolve(makeHeader());
  const placed = { ...object(747, { 54: "120" }, { x: 300, y: 90 }), index: 0 };
  const level: Level = { header: makeHeader(), objects: [placed], lengthUnits: 1000 };
  const list = DrawList.build(level, () => portalRecord("portal_15_front_001.png"), portalAtlas(), table);
  const data = list.visible(VIEW, liveWith(table), 0);
  assert.equal(list.visibleCount, 4, "two backs, two fronts");
  // Backs first (layer 4): the exit's, then the portal's; then the fronts.
  near(floatsOf(data, 0).slice(4), [290, 210], "the exit's back");
  near(floatsOf(data, 1).slice(4), [300, 90], "the portal's back");
  near(floatsOf(data, 2).slice(4), [300, 90], "the portal");
  near(floatsOf(data, 3).slice(4), [290, 210], "the exit");
  assert.ok(floatsOf(data, 3)[0] < 0 && floatsOf(data, 2)[0] > 0, "the exit is flipped the other way");
});

// --- rods ---------------------------------------------------------------------------

/** A rod 10 by 42 units, and the three balls, 20 units across, at 4 px a unit. */
function rodAtlas(): AtlasSet {
  const frames = [
    { n: "rod_01_001.png", x: 0, y: 0, w: 40, h: 168 },
    ...[1, 2, 3].map((k) => ({ n: `rod_ball_0${k}_001.png`, x: 40 + k * 90, y: 0, w: 80, h: 80 })),
  ];
  const file: AtlasFile = {
    version: 1,
    res: "uhd",
    pxPerUnit: 4,
    atlases: [{ name: "t", image: "t.png", w: 512, h: 256, frames }],
    frames: Object.fromEntries(frames.map((f, k) => [f.n, [0, k]])),
  };
  return new (AtlasSet as unknown as new (f: AtlasFile) => AtlasSet)(file);
}

const rodRecord: ObjectRecord = {
  ...baseOnly,
  f: "rod_01_001.png",
  bc: 1004,
  dc: undefined,
  zl: 1,
  zo: -6,
  ch: [{ f: "rod_ball_01_001.png", dx: 0, dy: 31, z: 1, bl: 1 }],
};

test("a rod's ball is an object of its own: P1, over the rod's top, pulsing about its centre", () => {
  // [PlayLayer::addObject :90318-90345: the ball (37) takes P1 unless the
  //  rod's colour is not 1004, the rod is left white; customSetup 37
  //  :180263-180270 (layer 3, order 10, the music's scale)]
  const header = makeHeader();
  header.colors.set(5, entry(5, { r: 0, g: 0, b: 200 }));
  const table = ColorTable.resolve(header, { player1: { r: 255, g: 100, b: 0 }, player2: { r: 0, g: 255, b: 255 } });
  const p1 = table.get(CHANNEL.P1);
  const drawnAt = (over: Partial<LevelObject>, pulse: number) => {
    const level: Level = { header, objects: [{ ...object(15, {}, { x: 100, y: 50, ...over }), index: 0 }], lengthUnits: 1000 };
    const list = DrawList.build(level, () => rodRecord, rodAtlas(), table);
    const data = list.visible(VIEW, { ...liveWith(table), pulse: () => pulse }, 0);
    const bytes = new Uint8Array(data.buffer);
    assert.equal(list.visibleCount, 2, "the rod and its ball");
    const sprite = (i: number) => ({ at: floatsOf(data, i), rgb: [bytes[i * INSTANCE_BYTES + 40], bytes[i * INSTANCE_BYTES + 41], bytes[i * INSTANCE_BYTES + 42]], blend: bytes[i * INSTANCE_BYTES + 46] });
    return { rod: sprite(0), ball: sprite(1) };
  };
  const plain = drawnAt({}, 0.5);
  assert.deepEqual(plain.rod.rgb, [255, 255, 255], "the rod is white");
  assert.deepEqual(plain.ball.rgb, [p1.r, p1.g, p1.b], "the ball is in P1");
  assert.equal(plain.ball.blend, BLEND.ADD_SPRITE, "and adds, as P1 does");
  near(plain.ball.at.slice(4), [100, 50 + 21 + 10], "10 over the rod's top");
  near([plain.ball.at[0]], [10 * 0.5], "half its size at a pulse of 0.5");
  near([drawnAt({}, 0.1).ball.at[0]], [10 * 0.1], "a tenth of it at rest");
  const keyed = drawnAt({ baseColor: 5 }, 0.5);
  assert.deepEqual(keyed.ball.rgb, [0, 0, 200], "key 21 goes to the ball");
  assert.deepEqual(keyed.rod.rgb, [255, 255, 255], "and the rod stays white");
  assert.equal(keyed.ball.blend, BLEND.NORMAL);
  const turned = drawnAt({ rotation: 90 }, 1);
  near(turned.ball.at.slice(4), [100 + 31, 50], "a turned rod carries its ball round");
  near(turned.ball.at.slice(0, 2), [10, 0], "but the ball itself is not turned");
});

test("an orb scales with the music about its own position, unless key 372 stops it", () => {
  // [updateVisibility :96000-96009; RingObject::setRScale :298067-298077]
  const table = ColorTable.resolve(makeHeader());
  const width = (props: Record<number, string>, pulse: number | null): number => {
    const list = build([object(36, props, { x: 40, y: 20 })], { 36: baseOnly }, table);
    const live = pulse === null ? liveWith(table) : { ...liveWith(table), pulse: () => pulse };
    const data = list.visible(VIEW, live, 0);
    near(floatsOf(data, 0).slice(4), [40, 20], "it stays where it is");
    return floatsOf(data, 0)[0];
  };
  near([width({}, 0.5)], [15 * 0.8], "0.3 over a pulse of 0.5");
  near([width({}, 1.1)], [15 * 1.2], "no more than 1.2");
  near([width({}, null)], [15], "still without music");
  near([width({ 372: "1" }, 0.5)], [15], "key 372");
});

test("the level's rods all carry the same ball, a ring half the time", () => {
  // [PlayLayer::init :107006-107008; GameObject::getBallFrame]
  assert.equal(rodBallFrame(0), "rod_ball_01_001.png");
  assert.equal(rodBallFrame(0.5), "rod_ball_02_001.png");
  assert.equal(rodBallFrame(0.74), "rod_ball_02_001.png");
  assert.equal(rodBallFrame(1), "rod_ball_03_001.png");
});
