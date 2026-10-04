// The order the draw list hands sprites over in: the game's batch nodes, one
// per z layer, sheet and blend mode, each at a fixed z in the object layer.
// The draw list is built with a two-frame atlas of its own, so only the
// shipped-table checks need the asset build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { AtlasSet } from "../src/assets/atlas";
import type { AtlasFile } from "../src/assets/atlasTypes";
import type { ChildRecord, ObjectRecord, ObjectsFile } from "../src/assets/objectTypes";
import type { ColorChannel, Level, LevelObject } from "../src/level/types";
import { ColorTable, channelOpacityMod } from "../src/render/colors";
import { enterProgress } from "../src/render/enterEffects";
import { ParticleField, mainOpacityMod } from "../src/render/particles";
import { defFromPlist } from "../src/render/playerParticles";
import { DrawList, HIDDEN_IN_PLAY_IDS, blendVariableChannels, type LiveScene } from "../src/render/drawList";
import {
  NO_NODE,
  PARENT_MODE,
  batchZ,
  colourSpriteInFront,
  colourSpriteStays,
  containerZ,
  drawLayerRuns,
  drawParticleRuns,
  legacyLayers,
  parentMode,
  slotOfZ,
  type ZRuns,
} from "../src/render/batchNodes";
import { OFFICIAL_LEVELS } from "../src/assets/levels";
import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS } from "../src/engine/gl/spriteBatch";
import type { TriggerRuntime } from "../src/triggers/runtime";
import { LAYER_Z, OBJECT_Z } from "../src/triggers/shaderState";
import { makeHeader } from "./levelKit";
import { outPath } from "./helpers";

const ASSETS = outPath("assets");
const ASSETS_SKIP = existsSync(`${ASSETS}/objects.json`) && existsSync(`${ASSETS}/atlas/hd.json`) ? false : "run `npm run assets` first";

// --- the nodes ------------------------------------------------------------------

test("each layer's batches sit at the z setupLayers gives them, glow lowest and GJ_GameSheet highest", () => {
  // B4, bottom to top. [GJBaseGameLayer::setupLayers :434825-435747; the
  //  container at -960, the 2.2074 exe's setupLayers]
  const b4 = -3;
  assert.equal(batchZ(b4, true, PARENT_MODE.GLOW), -1180);
  assert.equal(batchZ(b4, true, PARENT_MODE.PARTICLE), -1132);
  assert.equal(batchZ(b4, false, PARENT_MODE.PARTICLE), -1130);
  assert.equal(batchZ(b4, true, PARENT_MODE.PIXEL), -1120);
  assert.equal(batchZ(b4, false, PARENT_MODE.PIXEL), -1100);
  assert.equal(batchZ(b4, true, PARENT_MODE.GAME_02), -1080);
  assert.equal(batchZ(b4, false, PARENT_MODE.GAME_02), -1060);
  assert.equal(batchZ(b4, true, PARENT_MODE.FIRE), -1040);
  assert.equal(batchZ(b4, false, PARENT_MODE.FIRE), -1020);
  assert.equal(containerZ(b4), -960);
  assert.equal(batchZ(b4, true, PARENT_MODE.GAME), -940);
  assert.equal(batchZ(b4, false, PARENT_MODE.GAME), -920);
  // The text font's additive batch is over its plain one, not under.
  // [createTextLayers :419300-419400]
  assert.equal(batchZ(3, false, PARENT_MODE.TEXT), -100);
  assert.equal(batchZ(3, true, PARENT_MODE.TEXT), -80);
  // A mode the game does not know is GJ_GameSheet, as its switch's default.
  assert.equal(batchZ(3, false, 7), batchZ(3, false, PARENT_MODE.GAME));
});

test("layer 4 is B1's top for what blends, T1 for what does not, and the portals' back halves' own", () => {
  // [parentForZLayer :435785-436250, the a2 == 4 branches]
  assert.equal(batchZ(4, true, PARENT_MODE.GAME), -10, "over B1's GJ_GameSheet");
  assert.equal(batchZ(4, false, PARENT_MODE.GAME), 360, "T1's");
  assert.equal(batchZ(4, false, PARENT_MODE.GAME_02), -5, "the back halves' batch, top of B1");
  assert.equal(batchZ(4, true, PARENT_MODE.GAME_02), -150);
  assert.equal(batchZ(4, true, PARENT_MODE.GLOW), -280, "B1's glow");
  assert.equal(batchZ(4, true, PARENT_MODE.PARTICLE), NO_NODE, "setupLayers never makes it");
  // Twelve and up has additive batches over T4's.
  assert.equal(batchZ(12, true, PARENT_MODE.GAME), 1360);
  assert.equal(batchZ(12, false, PARENT_MODE.GAME), 1340);
  // The even layers go in with the layer above them.
  assert.equal(batchZ(-6, false, PARENT_MODE.GAME), -1220, "B5");
  assert.equal(batchZ(-4, false, PARENT_MODE.GAME), -920, "B4");
  assert.equal(batchZ(-2, false, PARENT_MODE.GAME), -620, "B3");
  assert.equal(batchZ(0, false, PARENT_MODE.GAME), -320, "B2");
  assert.equal(batchZ(2, false, PARENT_MODE.GAME), -20, "B1");
  assert.equal(batchZ(6, false, PARENT_MODE.GAME), 660, "T2");
  assert.equal(batchZ(10, false, PARENT_MODE.GAME), 1340, "T4");
});

test("every batch falls in the draw layer its key-24 layer names", () => {
  // B5 … B1, T1 … T4, and the odd layers with the one above them.
  // [parentForZLayer :435785-436250]
  const slotOf: Record<number, number> = { [-6]: 0, [-5]: 0, [-4]: 1, [-3]: 1, [-2]: 2, [-1]: 2, 0: 3, 1: 3, 2: 4, 3: 4, 5: 5, 6: 6, 7: 6, 8: 7, 9: 7, 10: 8, 11: 8, 12: 8 };
  for (const [layer, slot] of Object.entries(slotOf)) {
    for (const mode of Object.values(PARENT_MODE)) {
      for (const blend of [false, true]) {
        const z = batchZ(Number(layer), blend, mode);
        assert.equal(slotOfZ(z), slot, `layer ${layer} mode ${mode} ${blend ? "additive" : "plain"} at ${z}`);
      }
    }
  }
  // Layer 4: what blends is B1's top, but for the text font and the
  // containers, which have no node of their own there, and the particle
  // sheet, which has none at all; what does not is T1's, but for the
  // portals' back halves' batch and the glow.
  for (const mode of Object.values(PARENT_MODE)) {
    const additive = batchZ(4, true, mode);
    const wantAdditive = mode === PARENT_MODE.TEXT || mode === PARENT_MODE.CONTAINER ? 5 : 4;
    if (mode === PARENT_MODE.PARTICLE) assert.equal(additive, NO_NODE);
    else assert.equal(slotOfZ(additive), wantAdditive, `layer 4 mode ${mode} additive at ${additive}`);
    const plain = batchZ(4, false, mode);
    const wantPlain = mode === PARENT_MODE.GAME_02 || mode === PARENT_MODE.GLOW ? 4 : 5;
    assert.equal(slotOfZ(plain), wantPlain, `layer 4 mode ${mode} plain at ${plain}`);
  }
  assert.equal(LAYER_Z.length, 9);
});

test("a level made before 2.0's layers draws its text and fire in B1, whatever their layer", () => {
  // updateLayerCapacity sets +2628 for a capacity string of 16 to 54 numbers
  // joined by "_"; parentForZLayer then sends modes 2 and 3 to B1's nodes.
  // [GJBaseGameLayer::updateLayerCapacity :438751, :438815; parentForZLayer
  //  :435877, :435929, :436084, :436136]
  const sixteen = Array(16).fill("29").join("_");
  assert.equal(legacyLayers(sixteen), true);
  assert.equal(legacyLayers(`${sixteen}_`), true, "a trailing _ adds no number");
  assert.equal(legacyLayers(Array(15).fill("29").join("_")), false, "15 is the old capacity form, not a legacy level");
  assert.equal(legacyLayers(Array(54).fill("0").join("_")), true);
  assert.equal(legacyLayers(Array(55).fill("0").join("_")), false, "55 is 2.1's form");
  assert.equal(legacyLayers("24,340,52,244"), false, "2.2's pairs");
  assert.equal(legacyLayers(undefined), false);
  assert.equal(legacyLayers(""), false);
  // The official levels: up to Deadlocked and The Challenge; not Fingerdash,
  // Dash or the Tower. [LevelTools::getLevel :120696-121075]
  const legacy = OFFICIAL_LEVELS.filter((l) => legacyLayers(l.capacity)).map((l) => l.id);
  assert.deepEqual(legacy, [...Array.from({ length: 20 }, (_, i) => i + 1), 3001]);
  // T2's fire and text, plain and additive, go to B1's; nothing else moves.
  assert.equal(batchZ(7, false, PARENT_MODE.FIRE, true), -120);
  assert.equal(batchZ(7, true, PARENT_MODE.FIRE, true), -140);
  assert.equal(batchZ(-5, false, PARENT_MODE.TEXT, true), -100);
  assert.equal(batchZ(4, true, PARENT_MODE.TEXT, true), -80);
  assert.equal(batchZ(7, false, PARENT_MODE.GAME, true), batchZ(7, false, PARENT_MODE.GAME));
  assert.equal(batchZ(7, false, PARENT_MODE.PIXEL, true), batchZ(7, false, PARENT_MODE.PIXEL));
  // In a draw list: a fire sprite in T2 draws behind the player in a legacy level.
  const table = ColorTable.resolve(makeHeader());
  const records = { 1844: record({ zl: 7 }) };
  const modern = build([object(1844, 0)], records, table);
  const old = build([object(1844, 0)], records, table, makeHeader(), sixteen);
  modern.visible(VIEW, null, 0);
  old.visible(VIEW, null, 0);
  assert.deepEqual([modern.runZ[0], modern.layerRuns[6]], [560, 1], "T2's fire batch");
  assert.deepEqual([old.runZ[0], old.layerRuns[4]], [-120, 1], "B1's");
});

test("getParentMode: the flags first, then the id table", () => {
  // [GameObject::getParentMode :168337-168540; +656 and +908 from customSetup]
  assert.equal(parentMode(1), PARENT_MODE.GAME);
  assert.equal(parentMode(1583), PARENT_MODE.GAME, "the moving fireball");
  assert.equal(parentMode(2593), PARENT_MODE.PIXEL, "pixel art");
  assert.equal(parentMode(12), PARENT_MODE.GAME_02, "a portal, by +908");
  assert.equal(parentMode(1844), PARENT_MODE.FIRE);
  assert.equal(parentMode(3801), PARENT_MODE.PARTICLE);
  assert.equal(parentMode(914), PARENT_MODE.TEXT);
  assert.equal(parentMode(1816), PARENT_MODE.CONTAINER, "+656 before the table's 3");
  assert.equal(parentMode(3800), PARENT_MODE.GAME, "just below the particle range");
  assert.ok(colourSpriteStays(1614) && colourSpriteStays(918) && !colourSpriteStays(1583));
  // +909 from customSetup, not from where the table happens to hang the
  // colour sprite: 939's is in front, 3001's and the beasts' behind.
  assert.ok(colourSpriteInFront(939) && colourSpriteInFront(1614) && colourSpriteInFront(4401));
  assert.ok(!colourSpriteInFront(3001) && !colourSpriteInFront(918) && !colourSpriteInFront(1));
});

test("the shipped table draws every object from the sheet its batch holds", { skip: ASSETS_SKIP }, () => {
  // A batch draws everything in it from its one texture, so the game's mode
  // and the sheet the frames are on have to agree; the order trusts the mode.
  const file = JSON.parse(readFileSync(`${ASSETS}/objects.json`, "utf8")) as ObjectsFile;
  const atlas = JSON.parse(readFileSync(`${ASSETS}/atlas/hd.json`, "utf8")) as AtlasFile;
  const sheetOf = (frame: string): string => atlas.atlases[atlas.frames[frame]?.[0] ?? -1]?.name ?? "?";
  const SHEET: Record<number, string> = {
    [PARENT_MODE.GAME]: "GJ_GameSheet",
    [PARENT_MODE.GAME_02]: "GJ_GameSheet02",
    [PARENT_MODE.FIRE]: "FireSheet_01",
    [PARENT_MODE.PIXEL]: "PixelSheet_01",
    [PARENT_MODE.PARTICLE]: "GJ_ParticleSheet",
  };
  const wrong: string[] = [];
  let checked = 0;
  for (const id of file.census) {
    const r = file.objects[String(id)];
    if (!r || r.k === "trigger" || r.txt || r.ent) continue;
    const want = SHEET[parentMode(id)];
    if (!want) continue;
    const frames: string[] = [];
    if (r.f && !r.dd) frames.push(r.f);
    const walk = (children: ChildRecord[] | undefined): void => {
      for (const c of children ?? []) {
        if (!c.dd) frames.push(c.f);
        walk(c.ch);
      }
    };
    walk(r.ch);
    for (const f of frames) if (sheetOf(f) !== want) wrong.push(`${id} ${f} on ${sheetOf(f)}, not ${want}`);
    checked++;
  }
  assert.ok(checked > 1000, `checked ${checked}`);
  assert.deepEqual(wrong, []);
});

// --- the draw list's order -----------------------------------------------------------

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

function entry(id: number, over: Partial<ColorChannel> = {}): ColorChannel {
  return { id, r: 255, g: 255, b: 255, opacity: 1, blending: false, copyId: 0, copyHsv: null, copyOpacity: false, playerColor: 0, ...over };
}

function object(id: number, x: number, props: Record<number, string> = {}, over: Partial<LevelObject> = {}): LevelObject {
  return {
    index: 0,
    id,
    x,
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
    props: { 1: String(id), 2: String(x), ...props },
    settings: null,
    ...over,
  };
}

function record(over: Partial<ObjectRecord> = {}): ObjectRecord {
  return { k: "decoration", hb: null, src: "table", p: { hb: "none", art: "manual", z: "none" }, f: "a.png", bc: 1004, zl: 3, zo: 2, ...over };
}

const VIEW = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };

function build(objects: LevelObject[], records: Record<number, ObjectRecord>, table: ColorTable, header = makeHeader(), capacity?: string): DrawList {
  const level: Level = { header, objects: objects.map((o, index) => ({ ...o, index })), lengthUnits: 1000, capacity };
  return DrawList.build(level, (id) => records[id], atlas(), table);
}

function live(table: ColorTable): LiveScene {
  return { colors: table, triggers: { hasMotion: false, groupAlphaOf: () => 1 } as unknown as TriggerRuntime };
}

/** What each drawn sprite is: its x, which frame (a or b), and whether it adds. */
function drawn(list: DrawList, scene: LiveScene | null = null): string[] {
  const data = list.visible(VIEW, scene, 0);
  const bytes = new Uint8Array(data.buffer);
  const out: string[] = [];
  for (let i = 0; i < list.visibleCount; i++) {
    const x = Math.round(data[i * INSTANCE_FLOATS + 4]);
    const frame = data[i * INSTANCE_FLOATS + 6] < 0.4 ? "a" : "b";
    out.push(`${x}${frame}${bytes[i * INSTANCE_BYTES + 46] === BLEND.ADD_SPRITE ? "+" : ""}`);
  }
  return out;
}

test("a sheet's batch decides the order inside a layer, not the z order: GJ_GameSheet over pixel art", () => {
  // Dash's Moving Fireball (1583, GJ_GameSheet, z order 9) over the pixel art
  // (2593, PixelSheet_01, z order 10) in B4: the pixel batch is at -1100,
  // GJ_GameSheet's at -920. [setupLayers :434825-435747]
  const table = ColorTable.resolve(makeHeader());
  const records = { 1583: record({ zl: -3, zo: 9 }), 2593: record({ zl: -3, zo: 10 }) };
  const list = build([object(1583, 0), object(2593, 10)], records, table);
  assert.deepEqual(drawn(list), ["10a", "0a"], "the pixel art first, the fireball over it");
  assert.equal(list.runs, 2);
  assert.deepEqual([...list.runZ.slice(0, 2)], [-1100, -920]);
  assert.equal(list.layerRunFirst[1], 0);
  assert.equal(list.layerRuns[1], 2);
  // Key 25 still orders sprites inside one batch.
  const same = build([object(2593, 0, {}, { zOrder: 12 }), object(2593, 10)], records, table);
  assert.deepEqual(drawn(same), ["10a", "0a"]);
});

test("an object that blends goes in its sheet's additive batch, under the plain one whatever its z order", () => {
  // [parentForZLayer: the additive batch sits below the plain one of its
  //  sheet; GameObject::addMainSpriteToParent :169272-169338]
  const header = makeHeader();
  header.colors.set(5, entry(5, { blending: true }));
  const table = ColorTable.resolve(header);
  const list = build([object(1, 0, {}, { baseColor: 5, zOrder: 50 }), object(1, 10, {}, { baseColor: 6 })], { 1: record() }, table, header);
  assert.deepEqual(drawn(list), ["0a+", "10a"]);
});

test("every glow goes in its layer's glow batch, under all of the layer's sprites", () => {
  // activateObject adds the glow to parentForZLayer(layer, true, 5) at z
  // order -1000. [:169462-169471]
  const table = ColorTable.resolve(makeHeader());
  const glowing = record({ g: "b.png", zo: 5 });
  const list = build([object(1, 0), object(2, 10)], { 1: glowing, 2: record({ zo: 1 }) }, table);
  assert.deepEqual(drawn(list), ["0b+", "10a", "0a"], "the glow, then the plain batch by z order");
  // A glow is drawn in its own object's layer: one in T1 comes after B1's sprites.
  const up = build([object(1, 0), object(2, 10)], { 1: { ...glowing, zl: 5 }, 2: record({ zo: 1 }) }, table);
  assert.deepEqual(drawn(up), ["10a", "0b+", "0a"]);
});

test("an object's sprites keep cocos's tree order: negative z before their parent, the rest after", () => {
  // [cocos2d CCSpriteBatchNode::updateAtlasIndex]
  const table = ColorTable.resolve(makeHeader());
  const tree = record({
    ch: [
      { f: "b.png", dx: 1, dy: 0, z: 2 },
      { f: "b.png", dx: 2, dy: 0, z: -1, ch: [{ f: "b.png", dx: 1, dy: 0, z: 1 }] },
      { f: "b.png", dx: 4, dy: 0, z: -2 },
      { f: "b.png", dx: 5, dy: 0, z: 2 },
    ],
  });
  const list = build([object(1, 100)], { 1: tree }, table);
  assert.deepEqual(drawn(list), ["104b", "102b", "103b", "100a", "101b", "105b"]);
});

test("a colour trigger that turns a channel's blending on moves its objects to the additive batch as it happens", () => {
  // updateVisibility re-parents an object whose channel's blending changed.
  // [PlayLayer::updateVisibility :95946-95958]
  const header = makeHeader();
  const table = ColorTable.resolve(header);
  const trigger = object(899, 500, { 23: "5", 17: "1" });
  const records = { 1: record() };
  const list = build([object(1, 0, {}, { baseColor: 5, zOrder: 50 }), object(1, 10, {}, { baseColor: 6 }), trigger], records, table, header);
  assert.deepEqual([...blendVariableChannels({ header, objects: [trigger], lengthUnits: 0 })], [5]);
  assert.equal(list.stats.slots, 3, "the blending object has a slot in each batch");
  const scene = live(table);
  assert.deepEqual(drawn(list, scene), ["10a", "0a"], "plain: by z order");
  table.startFade({ channel: 5, r: 255, g: 255, b: 255, duration: 0, opacity: 1, blending: true, copyId: 0, copyHsv: null, copyOpacity: false });
  table.process();
  assert.deepEqual(drawn(list, scene), ["0a+", "10a"], "additive: under the plain batch");
});

test("which channels a level's colour triggers can change the blending of", () => {
  const header = makeHeader();
  header.colors.set(7, entry(7, { blending: true }));
  const of = (objects: LevelObject[]): number[] => [...blendVariableChannels({ header, objects, lengthUnits: 0 })].sort((a, b) => a - b);
  assert.deepEqual(of([object(899, 0, { 23: "6" })]), [], "leaves 6 as it starts");
  assert.deepEqual(of([object(899, 0, { 23: "7" })]), [7], "turns 7's off");
  assert.deepEqual(of([object(899, 0, { 17: "1" })]), [1], "no key 23 is channel 1");
  assert.deepEqual(of([object(104, 0)]), [1002], "the 1.x line trigger always blends");
  assert.deepEqual(of([object(29, 0, { 17: "1" })]), [], "the 1.x background trigger never does");
});

test("a main half that blends over a colour sprite that does not goes up a layer", () => {
  // addMainSpriteToParent: +744, a colour sprite, not +745, not +909 → layer
  // + 1. From B1 that is layer 4, whose additive GJ_GameSheet batch (-10) is
  // over B1's plain one (-20). The colour sprite keeps B1's plain batch.
  // [GameObject::addMainSpriteToParent :169283-169290; addColorSpriteToParent
  //  :169352-169390]
  const header = makeHeader();
  header.colors.set(5, entry(5, { blending: true }));
  const table = ColorTable.resolve(header);
  const behind = record({ dc: 6, ch: [{ f: "b.png", dx: 0, dy: 0, z: -100, ct: "D" }] });
  const objects = [object(1, 0, {}, { baseColor: 5, detailColor: 6 }), object(2, 10, {}, { zOrder: 50 })];
  const list = build(objects, { 1: behind, 2: record() }, table, header);
  assert.deepEqual(drawn(list), ["0b", "10a", "0a+"], "the colour sprite, the other block, then the main half over both");
  // A colour sprite in front (+909, 939's) keeps the main half where it is,
  // wherever the table hangs it; one with no +909 does not, though the table
  // has it at 100. [customSetup, traced]
  const front = record({ dc: 6, ch: [{ f: "b.png", dx: 0, dy: 0, z: -100, ct: "D" }] });
  const flower = [object(939, 0, {}, { baseColor: 5, detailColor: 6 }), object(2, 10, {}, { zOrder: 50 })];
  const stays = build(flower, { 939: front, 2: record() }, table, header);
  assert.deepEqual(drawn(stays), ["0a+", "0b", "10a"]);
  const notFront = record({ dc: 6, ch: [{ f: "b.png", dx: 0, dy: 0, z: 100, ct: "D" }] });
  assert.deepEqual(drawn(build(objects, { 1: notFront, 2: record() }, table, header)), ["0b", "10a", "0a+"]);
  // Halves that blend alike stay together, the colour sprite hung on the
  // object: at -100, or at 100 with +909, whatever the table says.
  // [addColorSpriteToSelf :168655-168660]
  header.colors.set(6, entry(6, { blending: true }));
  const together = build(objects, { 1: behind, 2: record() }, ColorTable.resolve(header), header);
  assert.deepEqual(drawn(together), ["0b+", "0a+", "10a"]);
  const togetherNotFront = build(objects, { 1: notFront, 2: record() }, ColorTable.resolve(header), header);
  assert.deepEqual(drawn(togetherNotFront), ["0b+", "0a+", "10a"]);
  const togetherFront = build(flower, { 939: front, 2: record() }, ColorTable.resolve(header), header);
  assert.deepEqual(drawn(togetherFront), ["0a+", "0b+", "10a"]);
});

test("a colour sprite that holds the colour frames is the colour sprite, whatever its own slot", () => {
  // The perspective blocks make an empty frame their colour sprite and hang
  // the *_color frames on it, so the frames go where the colour sprite goes
  // and blend as it does. [setupCustomSprites :611785-611795 →
  //  addInternalCustomColorChild :166960-166985]
  const header = makeHeader();
  header.colors.set(6, entry(6, { blending: true }));
  const table = ColorTable.resolve(header);
  const perspective = record({
    dc: 6,
    dd: 1,
    ch: [
      { f: "a.png", dx: 0, dy: 0, z: -100, ct: "B", ch: [{ f: "b.png", dx: 2, dy: 0, z: -1, ct: "D" }] },
      { f: "a.png", dx: 4, dy: 0, z: -1, ct: "B" },
    ],
  });
  const list = build([object(980, 0, {}, { baseColor: 5, detailColor: 6 })], { 980: perspective }, table, header);
  // The holder and its frame in the additive batch (-40), the art in the plain one (-20).
  assert.deepEqual(drawn(list), ["2b+", "0a+", "4a"]);
  assert.deepEqual([...list.runZ.slice(0, list.runs)], [-40, -20]);
});

test("a colour sprite the object keeps goes with the main half's batch, and blends as it does", () => {
  // +552: addColorSpriteToParent leaves it on the main sprite, in its batch,
  // which draws all it holds with one blend. [addColorSpriteToParent :169343]
  const header = makeHeader();
  header.colors.set(6, entry(6, { blending: true }));
  const table = ColorTable.resolve(header);
  const coin = record({ dc: 6, ch: [{ f: "b.png", dx: 0, dy: 0, z: 1, ct: "D" }] });
  const list = build([object(1614, 0, {}, { baseColor: 5, detailColor: 6 })], { 1614: coin }, table, header);
  assert.deepEqual(drawn(list), ["0a", "0b"], "both plain, the colour sprite where the table hangs it");
  assert.deepEqual([...list.runZ.slice(0, list.runs)], [-120], "FireSheet's plain B1 batch");
  // Only the main half's blending moves it.
  header.colors.set(5, entry(5, { blending: true }));
  header.colors.set(6, entry(6, { blending: false }));
  const both = build([object(1614, 0, {}, { baseColor: 5, detailColor: 6 })], { 1614: coin }, ColorTable.resolve(header), header);
  assert.deepEqual(drawn(both), ["0a+", "0b+"]);
  assert.deepEqual([...both.runZ.slice(0, both.runs)], [-140]);
});

test("a black child goes with its object's batch, so it adds when the object does", () => {
  // A batch draws everything in it with one blend; the black art is hung on
  // the object's own sprite. [GameObject::addCustomBlackChild;
  //  CCSpriteBatchNode's blend function]
  const header = makeHeader();
  header.colors.set(5, entry(5, { blending: true }));
  const table = ColorTable.resolve(header);
  const outlined = record({ ch: [{ f: "b.png", dx: 1, dy: 0, z: 1, ct: "K" }] });
  const list = build([object(1, 0, {}, { baseColor: 5 })], { 1: outlined }, table, header);
  assert.deepEqual(drawn(list), ["0a+", "1b+"]);
});

// --- the particle systems between the batches ---------------------------------------------

test("a particle system draws between its layer's batches, at its own z", () => {
  // A Custom Particles object's system in its layer's container; an object's
  // own one at its tag, over all of B1 and the streak. [ParticleGameObject::
  //  addMainSpriteToParent :301723-301759; GJBaseGameLayer::claimParticle
  //  :431656-431700]
  assert.equal(containerZ(3), -60, "B1's container, between the fire sheet and GJ_GameSheet");
  for (const z of [-2, 0, 4]) {
    assert.equal(slotOfZ(z), 4, `an object's own system at ${z} is drawn with B1`);
    assert.ok(z > OBJECT_Z.STREAK && z < OBJECT_Z.PARTICLES_UNDER && z > batchZ(4, false, PARENT_MODE.GAME_02), `${z} is over B1's batches and the streak`);
  }

  // B1 drawn from three batches; systems at -60 and at -5 (a tie goes to the batch).
  const runs = (z: number[], count: number[], slot: number): ZRuns => {
    const start: number[] = [];
    let at = 0;
    for (const n of count) {
      start.push(at);
      at += n;
    }
    const first = new Int32Array(9);
    const many = new Int32Array(9);
    many[slot] = z.length;
    return { runZ: Int16Array.from(z), runStart: Int32Array.from(start), runCount: Int32Array.from(count), layerRunFirst: first, layerRuns: many };
  };
  const sprites = runs([-200, -120, -20, -5], [2, 3, 4, 1], 4);
  const particles = runs([-60, -5], [7, 8], 4);
  const calls: string[] = [];
  drawLayerRuns(sprites, particles, 4, (buffer, count, start) => calls.push(`${buffer ? "particles" : "sprites"} ${start}+${count}`));
  assert.deepEqual(calls, ["sprites 0+5", "particles 0+7", "sprites 5+5", "particles 7+8"]);
  const alone: string[] = [];
  drawLayerRuns(sprites, null, 4, (buffer, count, start) => alone.push(`${buffer} ${start}+${count}`));
  assert.deepEqual(alone, ["0 0+10"], "with no system in between, one draw");

  // Systems at several zs with no batch between them are one draw, and the
  // ones from the streak up are left for after it.
  const more = runs([-150, -60, -40, 4], [7, 8, 2, 3], 4);
  const split: string[] = [];
  const collect = (buffer: 0 | 1 | 2, count: number, start: number): void => {
    split.push(`${buffer ? "particles" : "sprites"} ${start}+${count}`);
  };
  drawLayerRuns(sprites, more, 4, collect, OBJECT_Z.STREAK);
  assert.deepEqual(split, ["sprites 0+2", "particles 0+7", "sprites 2+3", "particles 7+10", "sprites 5+5"]);
  split.length = 0;
  drawParticleRuns(more, 4, OBJECT_Z.STREAK, collect);
  assert.deepEqual(split, ["particles 17+3"]);
  split.length = 0;
  drawLayerRuns(sprites, more, 4, collect);
  assert.deepEqual(split.slice(-1), ["particles 17+3"], "with nothing held back, they come last");
});

// --- what an object is shown at -----------------------------------------------------

test("an object's sprites wear their channel's opacity once, rounded as the game rounds it, as its particle system does", () => {
  // 0.825 is the byte 210, worn at 0.84; the sprite and the system both take
  // that. A channel the header starts part opaque is not counted again on
  // top of itself, so raising it to 1 shows the sprite whole.
  // [GameObject::opacityModForMode :172788-172808; updateVisibility
  //  :95919-95925; GameObject::setOpacity :167631-167636]
  assert.equal(channelOpacityMod(0.825), 210 * 0.004);
  assert.equal(channelOpacityMod(0.98), 249 * 0.004);
  assert.equal(channelOpacityMod(0.99), 1);
  assert.equal(channelOpacityMod(1), 1);
  const header = makeHeader();
  header.colors.set(5, entry(5, { opacity: 0.825 }));
  const table = ColorTable.resolve(header);
  const placed = object(1, 0, {}, { baseColor: 5 });
  const list = build([placed], { 1: record() }, table, header);
  const alphaOf = (scene: LiveScene | null): number => {
    const data = list.visible(VIEW, scene, 0);
    assert.equal(list.visibleCount, 1);
    return new Uint8Array(data.buffer)[43];
  };
  const scene = live(table);
  const worn = Math.round(210 * 0.004 * 255);
  assert.equal(alphaOf(scene), worn);
  assert.equal(alphaOf(null), worn, "with nothing live, as the build found it");
  assert.equal(Math.round(mainOpacityMod({ ...placed, index: 0 }, 5, { colors: table }) * 255), worn, "the system's the same");
  table.startFade({ channel: 5, r: 255, g: 255, b: 255, duration: 0, opacity: 1, blending: false, copyId: 0, copyHsv: null, copyOpacity: false });
  table.process();
  assert.equal(alphaOf(scene), 255, "raised to 1, the sprite is whole");
});

/** A live scene whose toggles switch off the objects `off` names. */
function toggled(table: ColorTable, off: (o: number) => boolean): LiveScene {
  return {
    colors: table,
    triggers: { hasMotion: false, hasToggles: true, objectDisabled: off, groupAlphaOf: () => 1 } as unknown as TriggerRuntime,
  };
}

test("objectFade is what this gather showed an object at: whole in view, its fade at the edge, 0 when it is not shown", () => {
  // What a built-in system's object hands updateParticleOpacity comes from
  // here, so every portal, orb, pad and fireball system depends on it.
  // [PlayLayer::updateVisibility :96001-96076; GameObject::setOpacity
  //  :167614-167645 → updateParticleOpacity :165124-165150]
  const table = ColorTable.resolve(makeHeader());
  // A 30-unit block has no half-width beyond a block (+704), so its fade is
  // measured from its own x: 35 units inside the right edge is halfway in.
  const list = build([object(1, 0), object(1, 965), object(1, 5000), object(1, 100)], { 1: record() }, table);
  const off = new Set<number>([3]);
  const scene = toggled(table, (o) => off.has(o));
  list.visible(VIEW, scene, 0);
  assert.equal(list.objectFade(0), 1, "in the middle of the view");
  assert.equal(list.objectFade(1), enterProgress(35));
  assert.equal(list.objectFade(1), 0.5);
  assert.equal(list.objectFade(2), 0, "out of view");
  assert.equal(list.objectFade(3), 0, "switched off by a toggle");
  assert.equal(list.objectFade(-1), 0);
  assert.equal(list.objectFade(99), 0);
  // The last gather is the only one that counts: one that left the object
  // out of view takes back what an earlier one showed.
  list.visible({ x0: 2000, y0: -1000, x1: 3000, y1: 1000 }, scene, 0);
  for (const o of [0, 1, 2, 3]) assert.equal(list.objectFade(o), 0, `object ${o}, gathered before but not now`);
  off.clear();
  list.visible(VIEW, scene, 0);
  assert.equal(list.objectFade(3), 1, "switched on again");
});

test("an object's own particle system runs while the draw list shows its object, and stops when it does not", () => {
  // The scene's wiring: the gather first, then the systems, each asking the
  // draw list what its object was shown at. [Scene.draw; DrawList.objectFade]
  const table = ColorTable.resolve(makeHeader());
  const portal = record({ k: "portal", pt: { e: "swirl", pos: 2, z: 4 } } as Partial<ObjectRecord>);
  const objects = [object(12, 0)];
  const list = build(objects, { 12: portal }, table);
  const level: Level = { header: makeHeader(), objects: objects.map((o, index) => ({ ...o, index })), lengthUnits: 1000 };
  const field = new ParticleField(level, atlas());
  const def = defFromPlist({
    maxParticles: 30,
    duration: -1,
    particleLifespan: 0.6,
    emitterType: 1,
    maxRadius: 40,
    startParticleSize: 6,
    finishParticleSize: 1,
    startColorRed: 1,
    startColorGreen: 1,
    startColorBlue: 1,
    startColorAlpha: 1,
    finishColorRed: 1,
    finishColorGreen: 1,
    finishColorBlue: 1,
    finishColorAlpha: 1,
    blendFuncDestination: 1,
  });
  const quad = { u0: 0, v0: 0, du: 1, dv: 1, sheet: 0, rotated: 0 };
  field.addBuiltIn(level, (id) => (id === 12 ? portal : undefined), () => ({ def, texture: "a.png" }), () => quad);
  const scene = live(table);
  const frame = (view: typeof VIEW): number => {
    list.visible(view, scene, 0);
    return field.update(1 / 30, VIEW, { levelTime: 0, colors: table, animationsOf: () => 0, objectFade: (o) => list.objectFade(o) }).count;
  };
  frame(VIEW);
  assert.ok(frame(VIEW) > 0, "shown, it runs");
  for (let i = 0; i < 40; i++) frame({ x0: 2000, y0: -1000, x1: 3000, y1: 1000 });
  assert.equal(frame({ x0: 2000, y0: -1000, x1: 3000, y1: 1000 }), 0, "not gathered, it stops and what was out finishes");
});

test("the shipped table gathers every object that carries a system of its own, so the system can run", { skip: ASSETS_SKIP }, () => {
  // An object type with a built-in system and no slot in the draw list would
  // never be stamped, objectFade would give it 0, and its system would never
  // start.
  const file = JSON.parse(readFileSync(`${ASSETS}/objects.json`, "utf8")) as ObjectsFile;
  const atlasFile = JSON.parse(readFileSync(`${ASSETS}/atlas/hd.json`, "utf8")) as AtlasFile;
  const shipped = new (AtlasSet as unknown as new (f: AtlasFile) => AtlasSet)(atlasFile);
  const ids = Object.keys(file.objects)
    .map(Number)
    .filter((id) => file.objects[String(id)].pt && !HIDDEN_IN_PLAY_IDS.has(id));
  assert.ok(ids.length > 100, `${ids.length} types carry a system`);
  const header = makeHeader();
  const table = ColorTable.resolve(header);
  const level: Level = { header, objects: ids.map((id, index) => ({ ...object(id, 0), index })), lengthUnits: 1000 };
  const list = DrawList.build(level, (id) => file.objects[String(id)], shipped, table);
  list.visible({ x0: -500, y0: -300, x1: 500, y1: 300 }, live(table), 0);
  const dark = ids.filter((_, o) => !(list.objectFade(o) > 0));
  assert.deepEqual(dark, [], "types whose system would never start");
});
