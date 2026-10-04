// Checks the built assets/ folder against the sources it came from.
//
// These skip cleanly when the build has not been run, so a fresh checkout is
// still green; run `npm run assets` to make them meaningful.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AtlasFile, AtlasFrame } from "../src/assets/atlasTypes";
import { framePackedRect, frameSourceRect } from "../src/assets/atlasTypes";
import { isZLayer } from "../src/assets/objectTypes";
import type { IconFile } from "../src/assets/iconTypes";
import type { ObjectsFile } from "../src/assets/objectTypes";
import { buildObjectTable, objectTableFromRecords } from "../src/physics/objects";
import type { ObjectDef } from "../src/physics/types";
import { GAME_ANIMATIONS } from "../src/assets/gameAnimations";
import { loadObjectTable, projectPath, outPath } from "./helpers";

const ASSETS = outPath("assets");
const objectsPath = join(ASSETS, "objects.json");
const atlasPath = join(ASSETS, "atlas/uhd.json");
const iconsPath = join(ASSETS, "icons/icons.json");
const built = existsSync(objectsPath) && existsSync(atlasPath);
const SKIP = built ? false : "run `npm run assets` first";
const SKIP_ICONS = existsSync(iconsPath) ? false : "run `npm run assets` first";

function readObjects(): ObjectsFile {
  return JSON.parse(readFileSync(objectsPath, "utf8")) as ObjectsFile;
}

function readAtlas(): AtlasFile {
  return JSON.parse(readFileSync(atlasPath, "utf8")) as AtlasFile;
}

/** Every field of a definition the simulation actually reads. */
function physics(def: ObjectDef): Record<string, unknown> {
  return {
    id: def.id,
    kind: def.kind,
    hitbox: def.hitbox,
    passable: def.passable ?? false,
    breakable: def.breakable ?? false,
    special: def.special ?? null,
    orb: def.orb ?? null,
    pad: def.pad ?? null,
    portal: def.portal ?? null,
    collectible: def.collectible ?? null,
    forceShape: def.forceShape ?? null,
    animated: def.animated ?? false,
    gridW: def.gridW ?? null,
    gridH: def.gridH ?? null,
    source: def.source,
  };
}

test("the shipped object table matches the one the simulation derives", { skip: SKIP }, () => {
  const file = readObjects();
  const shipped = objectTableFromRecords(file.objects);
  const derived = loadObjectTable();
  assert.deepEqual(shipped.ids(), derived.ids(), "the two tables know different ids");
  for (const id of derived.ids()) {
    assert.deepEqual(physics(shipped.get(id)), physics(derived.get(id)), `object ${id} differs`);
  }
});

test("every object the official levels use has art", { skip: SKIP }, () => {
  const file = readObjects();
  const atlas = readAtlas();
  const missing: number[] = [];
  for (const id of file.census) {
    const rec = file.objects[String(id)];
    if (!rec) {
      missing.push(id);
      continue;
    }
    // Three kinds of object legitimately have no sprite frame: a trigger is
    // invisible in play and its only art is the editor icon this build leaves
    // out, a text object draws a string instead, and a beast draws a skeleton.
    if (rec.k === "trigger" || rec.txt || rec.ent) continue;
    if (!rec.f) missing.push(id);
  }
  assert.deepEqual(missing, [], "object ids used by the levels with no frame");
  assert.equal(atlas.res, file.validatedAgainst);
});

test("every object the levels draw knows which layer it belongs to", { skip: SKIP }, () => {
  const file = readObjects();
  const nameless: number[] = [];
  const offEnum: string[] = [];
  for (const id of file.census) {
    const rec = file.objects[String(id)];
    if (!rec) continue;
    if (rec.zl !== undefined && !isZLayer(rec.zl)) offEnum.push(`${id}: ${rec.zl}`);
    // A trigger is never drawn, so it needs no layer.
    if (rec.k === "trigger") continue;
    if (rec.zl === undefined || rec.p.z === "none") nameless.push(id);
  }
  assert.deepEqual(offEnum, [], "z layers the game does not have");
  assert.deepEqual(nameless, [], "drawable census ids with no z layer from any source");
});

test("the additive blend flag survives the merge", { skip: SKIP }, () => {
  // It was silently zero for a while: the fan table spells the flag
  // "additive" and the generator compared it against true.
  const file = readObjects();
  const additive = Object.values(file.objects).filter((r) => r.bl === 1);
  assert.ok(additive.length > 0, "no object is additive, which was the old bug");
});

test("every frame name in the object table resolves in the atlas", { skip: SKIP }, () => {
  const file = readObjects();
  const atlas = readAtlas();
  const unknown: string[] = [];
  const check = (name: string | undefined): void => {
    if (name && !(name in atlas.frames)) unknown.push(name);
  };
  const walk = (children: ObjectsFile["objects"][string]["ch"]): void => {
    for (const c of children ?? []) {
      check(c.f);
      check(c.g);
      walk(c.ch);
    }
  };
  for (const rec of Object.values(file.objects)) {
    check(rec.f);
    check(rec.g);
    walk(rec.ch);
    for (const f of rec.rnd ?? []) check(f);
  }
  assert.deepEqual([...new Set(unknown)], [], "frames the atlas does not contain");
});

test("every animated object draws each family the game's table names, the colour one on the detail slot", { skip: SKIP }, () => {
  // The main frames play on the object, the colour frames on its colour
  // sprite, which takes the secondary colour. A family whose first frame the
  // build has no art for is not asked for. [EnhancedGameObject::
  //  updateSyncedAnimation LABEL_303 :621663-621675, LABEL_294
  //  :621187-621208, 1614 :621568-621640]
  const objects = readObjects().objects;
  const frames = readAtlas().frames;
  const family = (f: string): string => f.replace(/_\d{3}\.png$/, "");
  const problems: string[] = [];
  let checked = 0;
  for (const [id, entry] of GAME_ANIMATIONS) {
    const record = objects[String(id)];
    if (id <= 0 || entry.frames <= 1 || !record || record.ent || record.txt) continue;
    // The colour slot a sprite follows once the record's swap flag is applied.
    const slot = (ct: string | undefined): string => {
      const s = ct ?? "B";
      return s === "K" || !record.sw ? s : s === "B" ? "D" : "B";
    };
    // What is drawn: a don't-draw sprite only carries its children.
    const sprites: { f: string; slot: string }[] = [];
    if (record.f && !record.dd) sprites.push({ f: record.f, slot: slot(record.ct) });
    const walk = (children: ObjectsFile["objects"][string]["ch"]): void => {
      for (const c of children ?? []) {
        if (!c.dd) sprites.push({ f: c.f, slot: slot(c.ct) });
        walk(c.ch);
      }
    };
    walk(record.ch);
    checked++;
    if (`${entry.name}_001.png` in frames && !sprites.some((s) => family(s.f) === entry.name)) {
      problems.push(`${id}: nothing plays ${entry.name}`);
    }
    if (!entry.color || !(`${entry.color}_001.png` in frames)) continue;
    const colour = sprites.filter((s) => family(s.f) === entry.color);
    if (!colour.some((s) => s.slot === "D")) problems.push(`${id}: ${entry.color} is on no detail sprite`);
    if (entry.color !== entry.name && colour.some((s) => s.slot !== "D")) problems.push(`${id}: ${entry.color} on a ${colour.map((s) => s.slot)} sprite`);
    if (entry.color !== entry.name && sprites.some((s) => family(s.f) === entry.name && s.slot === "D")) {
      problems.push(`${id}: the detail slot plays the main family`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked > 120, `only ${checked} animated records checked`);
  // Dash's 2047s: the colour sprite follows key 22, not key 21.
  const fire = objects["2047"];
  assert.deepEqual(fire.ch?.map((c) => [c.f, c.ct]), [["gj22_anim_28_color_001.png", "D"]]);
});

test("a set whose colour plays on a doubled child draws it at about the main frames' size", { skip: SKIP }, () => {
  // Their colour sprite is never drawn; its one child, where updateSyncedAnimation
  // plays the colour frames, is at twice its size, and the colour frames are
  // drawn at half the main frames' size for it. The sets that play the
  // colour on the colour sprite itself (2046, 2051-2054) are drawn as they
  // are. The bound is on the longer side, and loose: the colour art's canvas
  // is not exactly half the main art's (2032 is 1.24 of it, 2872 0.83).
  // [setupCustomSprites :612779-612787, :609850-609898, LABEL_1825
  //  :610199-610215; updateSyncedAnimation LABEL_294 :621187-621208,
  //  LABEL_303 :621663-621675]
  const objects = readObjects().objects;
  const atlas = readAtlas();
  const size = new Map<string, number>();
  for (const sheet of atlas.atlases) {
    for (const frame of sheet.frames) {
      const r = frameSourceRect(frame);
      size.set(frame.n, Math.max(r.w, r.h));
    }
  }
  const family = (f: string): string => f.replace(/_\d{3}\.png$/, "");
  const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, k) => a + k);
  const doubled = [920, 921, 923, 924, ...range(1936, 1939), ...range(2020, 2040), ...range(2043, 2045), ...range(2047, 2050)];
  doubled.push(2055, 2864, 2865, 2867, 2869, ...range(2871, 2894));
  const problems: string[] = [];
  let checked = 0;
  for (const id of [...doubled, 2046, 2051, 2052, 2053, 2054]) {
    const record = objects[String(id)];
    const entry = GAME_ANIMATIONS.get(id);
    if (!record?.f || !entry?.color || !size.has(`${entry.color}_001.png`)) continue;
    const drawn: { f: string; scale: number }[] = [];
    const walk = (children: ObjectsFile["objects"][string]["ch"], scale: number): void => {
      for (const c of children ?? []) {
        const k = scale * Math.abs(c.sx ?? 1);
        if (!c.dd && family(c.f) === entry.color) drawn.push({ f: c.f, scale: k });
        walk(c.ch, k);
      }
    };
    walk(record.ch, 1);
    checked++;
    if (drawn.length !== 1) {
      problems.push(`${id}: ${drawn.length} colour sprites drawn`);
      continue;
    }
    const ratio = ((size.get(drawn[0].f) ?? 0) * drawn[0].scale) / (size.get(record.f) ?? 1);
    if (ratio < 0.75 || ratio > 1.33) problems.push(`${id}: colour at ${ratio.toFixed(2)} of the main frame`);
  }
  assert.deepEqual(problems, []);
  assert.ok(checked >= 65, `only ${checked} sets checked`);
});

test("every atlas frame sits inside its sheet", { skip: SKIP }, () => {
  const atlas = readAtlas();
  const bad: string[] = [];
  for (const sheet of atlas.atlases) {
    for (const frame of sheet.frames) {
      const r = framePackedRect(frame);
      if (r.x < 0 || r.y < 0 || r.x + r.w > sheet.w || r.y + r.h > sheet.h) bad.push(`${sheet.name}/${frame.n}`);
    }
  }
  assert.deepEqual(bad, [], "frames outside their sheet (the rotation convention is wrong)");
});

test("a source box is turned with the region it belongs to", () => {
  // Upright: the box is the region grown by whatever was trimmed off it.
  assert.deepEqual(frameSourceRect({ n: "a", x: 10, y: 20, w: 30, h: 40 }), { x: 10, y: 20, w: 30, h: 40 });
  assert.deepEqual(frameSourceRect({ n: "a", x: 10, y: 20, w: 30, h: 40, tx: 3, ty: 4, sw: 40, sh: 50 }), { x: 7, y: 16, w: 40, h: 50 });
  // Rotated with nothing trimmed: the box is exactly the packed region.
  const rotated: AtlasFrame = { n: "a", x: 10, y: 20, w: 30, h: 40, r: 1 };
  assert.deepEqual(frameSourceRect(rotated), framePackedRect(rotated));
  // Rotated and trimmed, as GJ_GameSheet stores block003_color_04_001: the
  // 28 px cut off the top of the sprite end up to the right of the region,
  // because the whole box turned with it.
  assert.deepEqual(frameSourceRect({ n: "a", x: 3693, y: 3439, w: 60, h: 92, r: 1, ty: 28, sh: 120 }), { x: 3693, y: 3439, w: 120, h: 60 });
});

test("every source box contains its own region", { skip: SKIP }, () => {
  const atlas = readAtlas();
  const bad: string[] = [];
  for (const sheet of atlas.atlases) {
    for (const frame of sheet.frames) {
      // GD ships two 3×3 placeholders that claim a source box smaller than
      // themselves. Nothing draws either one.
      if (frame.n === "emptyFrame.png" || frame.n === "emptyGlow.png") continue;
      const r = framePackedRect(frame);
      const s = frameSourceRect(frame);
      if (r.x < s.x || r.y < s.y || r.x + r.w > s.x + s.w || r.y + r.h > s.y + s.h) bad.push(`${sheet.name}/${frame.n}`);
    }
  }
  assert.deepEqual(bad, [], "source boxes that do not enclose the region they were trimmed from");
});

test("frame names are unique across every sheet", { skip: SKIP }, () => {
  const atlas = readAtlas();
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const sheet of atlas.atlases) {
    for (const frame of sheet.frames) {
      const first = seen.get(frame.n);
      if (first) clashes.push(`${frame.n}: ${first} and ${sheet.name}`);
      else seen.set(frame.n, sheet.name);
    }
  }
  assert.deepEqual(clashes, []);
  assert.equal(Object.keys(atlas.frames).length, seen.size, "the name index and the sheets disagree");
});

test("every icon layer is drawn where icons.json says it is", { skip: SKIP_ICONS }, async (t) => {
  let canvasLib: typeof import("canvas");
  try {
    canvasLib = await import("canvas");
  } catch {
    t.skip("node-canvas is not installed, so the pages cannot be read");
    return;
  }
  const file = JSON.parse(readFileSync(iconsPath, "utf8")) as IconFile;
  const spills: string[] = [];
  for (const page of file.pages) {
    const image = await canvasLib.loadImage(join(ASSETS, page.image));
    const surface = canvasLib.createCanvas(page.w, page.h);
    const ctx = surface.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const px = ctx.getImageData(0, 0, page.w, page.h).data;
    const opaque = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < page.w && y < page.h && px[(y * page.w + x) * 4 + 3] > 8;
    for (const f of page.frames) {
      // The packer leaves a transparent gutter around every slot, so a layer
      // copied even one pixel out of place shows up in the ring around its
      // rectangle. This is what catches a rotated layer being turned about the
      // wrong corner, which is invisible in the JSON.
      let out = 0;
      for (let x = f.x - 1; x <= f.x + f.w; x++) if (opaque(x, f.y - 1) || opaque(x, f.y + f.h)) out++;
      for (let y = f.y - 1; y <= f.y + f.h; y++) if (opaque(f.x - 1, y) || opaque(f.x + f.w, y)) out++;
      if (out > 0) spills.push(`${f.n} (${out} px outside its slot)`);
    }
  }
  assert.deepEqual(spills.slice(0, 10), [], `${spills.length} icon layer(s) are not inside the rectangle they were given`);
});

test("the bootstrap table still builds", () => {
  // Independent of the build: this is the table the tests and the bot use.
  const table = buildObjectTable(
    JSON.parse(readFileSync(projectPath("data/objects-bootstrap.json"), "utf8")) as Parameters<typeof buildObjectTable>[0],
  );
  assert.ok(table.ids().length > 4000);
});

test("an object the game draws through a copy of its own frame draws it once, in the main sprite's colour", { skip: SKIP }, () => {
  // setupCustomSprites hides the sprite (+471) and hangs a copy on it, which
  // takes the object's own colour; 1752's ring spiral was drawn twice, the
  // copy in the light background's channel. [LABEL_1808 :614435-614462]
  const objects = readObjects().objects;
  const spiral = objects["1752"];
  assert.equal(spiral.dd, 1, "the sprite itself is not drawn");
  const copy = (spiral.ch ?? []).find((c) => c.f === spiral.f);
  assert.ok(copy, "the copy stays");
  assert.equal(copy.ct, spiral.ct, "and takes the main sprite's colour");
});

test("black art is the art the game makes black for good, and nothing else", { skip: SKIP }, () => {
  // Every object whose own sprite setupCustomSprites or customSetup sets to
  // ccBLACK and keeps out of setObjectColor (+541), and no other: the
  // beasts, the sludge and the fake spikes are black only by their main
  // colour's default (1010), and the slope outline 309, the cogwheels
  // 675-677 and the block edge 1363 follow their main colour.
  // [setupCustomSprites :606565-606820, :609096-609097, :612340-612690,
  //  :614036-614052, :614660-614800; customSetup :178915-178916,
  //  :180361-180362]
  const blackArt = new Set<number>([
    9, 61, 62, 63, 64, 65, 66, 68, 88, 89, 94, 98, 135, 191, 198, 199, 243, 244, 296, 297, 363, 364, 365, 366, 367, 368,
    393, 397, 398, 399, 421, 422, 446, 447, 667, 668, 669, 670, 671, 672, 687, 688, 720, 738, 768, 989, 991, 1078, 1079,
    1080, 1081, 1747, 1748,
  ]);
  for (let id = 807; id <= 833; id++) blackArt.add(id);
  const objects = readObjects().objects;
  const shipped = Object.entries(objects)
    .filter(([, r]) => r.ct === "K")
    .map(([id]) => Number(id))
    .sort((a, b) => a - b);
  assert.deepEqual(shipped, [...blackArt].sort((a, b) => a - b));
  // Black by default, not black art: the main colour, 1010 unless key 21 says otherwise.
  for (const id of [918, 919, 1327, 1328, 1584, 1889, 2012]) assert.equal(objects[String(id)].bc, 1010, `${id}'s main colour`);
});

test("the pulsing balls are their own sprite alone", { skip: SKIP }, () => {
  // setupCustomSprites hangs nothing on them and addColorSprite makes them
  // no colour sprite; the fan table's child was drawn behind each one as a
  // colour sprite. [setupCustomSprites :614711-614715; addColorSprite
  //  :171326-172378]
  const objects = readObjects().objects;
  for (const id of [50, 51, 52, 53, 54, 60, 148, 149, 405]) {
    assert.equal((objects[String(id)].ch ?? []).length, 0, `${id} has no child sprites`);
  }
});

test("the pixel-art edge strips sit over the tiles they edge", { skip: SKIP }, () => {
  // Dash's ceiling blocks: the strip is drawn over the tile even where the
  // level lists it first. [meas: a 2.2074 screenshot of Dash at 4 %]
  const objects = readObjects().objects;
  for (const [strip, tile] of [
    [2541, 2540],
    [2543, 2542],
    [2547, 2546],
  ]) {
    assert.equal(objects[String(strip)].zl, objects[String(tile)].zl);
    assert.ok((objects[String(strip)].zo ?? 0) > (objects[String(tile)].zo ?? 0), `${strip} over ${tile}`);
  }
});

test("the portals and orbs carry the particle systems customSetup hangs on them", { skip: SKIP }, () => {
  // Each at the z createAndAddParticle gives it: 4 for portals and rings, 0
  // (left out) for pads, -2 for the fireballs.
  // [customSetup :177390-177409 (1331); :182290-182300 (1022); :177420 (35);
  //  :177544 (1583); traced into data/ref/customSetup_particles_2206.json]
  const objects = readObjects().objects;
  assert.deepEqual(objects["1331"].pt, { e: "portalEffect02", pos: 2, z: 4, s: [0.784314, 0, 1, 1], en: [0.784314, 0, 1, 1], o: [-5, 0] });
  assert.equal(objects["12"].pt?.e, "portalEffect03");
  assert.equal(objects["12"].pt?.z, 4);
  assert.equal(objects["1022"].pt?.e, "ringEffect");
  assert.equal(objects["1022"].pt?.z, 4);
  assert.equal(objects["35"].pt?.e, "bumpEffect");
  assert.equal(objects["35"].pt?.z, undefined);
  assert.equal(objects["1583"].pt?.z, -2);
});
