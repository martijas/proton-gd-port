// The object table: assets/objects.json, one record per id with the physics
// half and the art half together.
//
// The physics half is not re-derived here. buildObjectTable() in
// src/physics/objects.ts stays the single source of truth for hitboxes and
// kinds, and this step serialises whatever it produces, so the shipped table
// cannot drift away from the simulation the tests run against.
//
// The art half merges two machine sources. For ids up to 1911 the game's own
// table (data/ref/gdclone-object.json, extracted by opstic/gdclone) wins: it
// has the real texture, z layer and order, colour channels and child sprites.
// Above that the old fan port's table is all there is. Fields the first source
// does not carry — glow frames, text objects, portal particles — are layered
// on from the second either way. Frame animations are not: the renderer reads
// the game's own table (src/assets/gameAnimations.ts).
//
// Which sprites an animated object has is the one thing the game's animation
// table also settles: the main frames go on the object and the colour frames
// on its colour sprite, so a fan-table record's sprites are rebuilt from it
// (animatedArt).
//
// Then every frame name is checked against the atlas index. The fan port
// invented a glow frame for almost every object (3789 of 4082) where the game
// has 224 in total, so a name that no sheet contains is dropped and counted
// rather than shipped: without that pass "zero missing frames" would be a
// meaningless number and the renderer's glow pass would draw nothing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuiltInParticle, ChildRecord, ColorType, ObjectRecord, ObjectsFile, Provenance } from "../../src/assets/objectTypes";
import { isZLayer } from "../../src/assets/objectTypes";
import type { BootstrapEntry, BootstrapJson } from "../../src/physics/objects";
import { buildObjectTable } from "../../src/physics/objects";
import { GDCLONE_HITBOXES } from "../../src/physics/gdcloneHitboxes";
import { GAME_OBJECT_TYPES } from "../../src/physics/gameObjectTypes";
import { ANIM_ENTITY_IDS, RENDER_OVERRIDES } from "../../src/physics/objectRenderOverrides";
import { GAME_ANIMATIONS } from "../../src/assets/gameAnimations";
import type { ObjectDef } from "../../src/physics/types";
import { fileSize, writeJson } from "./fsx";
import type { StepContext, StepModule, StepResult } from "./step";

// --- the two reference tables ------------------------------------------------

interface GdcloneChild {
  texture?: string;
  x?: number;
  y?: number;
  z?: number;
  rot?: number;
  scale_x?: number;
  scale_y?: number;
  flip_x?: boolean;
  flip_y?: boolean;
  anchor_x?: number;
  anchor_y?: number;
  color_type?: string;
  opacity?: number;
  children?: GdcloneChild[];
}

interface GdcloneEntry extends GdcloneChild {
  default_z_layer?: number;
  default_z_order?: number;
  default_base_color_channel?: number;
  default_detail_color_channel?: number;
  swap_base_detail?: boolean;
}

interface BootstrapChild {
  frame?: string | null;
  dx?: number;
  dy?: number;
  z?: number;
  rot?: number;
  /** The fan table's packed-RGB colour marker. Ambiguous — see childColorType. */
  tint?: number;
  /** The string "additive", never a boolean. */
  blend?: string;
  glowFrame?: string | null;
  /** The string "black", never a number. */
  colorChannel?: string;
}

interface Census {
  counts: Record<string, number>;
  perLevel: Record<string, number[]>;
}

interface ZPair {
  zl: number;
  zo: number;
}

/** What tools/ref-run_customsetup2.py starts every object at, before customSetup runs. */
const CUSTOM_SETUP_SEED: ZPair = { zl: 5, zo: 0 };

/** The 2.206 customSetup extraction: id → its default z pair. */
function readCustomSetup(file: string): Map<number, ZPair> {
  const out = new Map<number, ZPair>();
  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const head = (lines[0] ?? "").split(",");
  const idCol = head.indexOf("id");
  const zlCol = head.indexOf("defaultZLayer");
  const zoCol = head.indexOf("defaultZOrder");
  if (idCol < 0 || zlCol < 0 || zoCol < 0) throw new Error(`${file}: expected id, defaultZLayer and defaultZOrder columns`);
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const id = Number(cells[idCol]);
    const zl = Number(cells[zlCol]);
    const zo = Number(cells[zoCol]);
    if (Number.isInteger(id) && Number.isFinite(zl) && Number.isFinite(zo)) out.set(id, { zl, zo });
  }
  return out;
}

// --- helpers -----------------------------------------------------------------

/** The old table writes several kinds of "no frame"; none of them are file names. */
function cleanFrameName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name === "" || !name.toLowerCase().endsWith(".png")) return null;
  return name;
}

function colorType(value: unknown): ColorType | undefined {
  if (value === "Base") return "B";
  if (value === "Detail") return "D";
  if (value === "Black") return "K";
  return undefined;
}

function raw(e: BootstrapEntry | undefined): Record<string, unknown> {
  return (e?.raw ?? {}) as Record<string, unknown>;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Rounds away float noise the reference tables carry (y: -0.2200002670288086). */
function tidy(n: number): number {
  return Math.abs(n) < 1e-6 ? 0 : Math.round(n * 1e4) / 1e4;
}

/**
 * Editor-only art. Triggers and other invisible objects carry the icon the
 * editor draws for them, which lives on GJ_GameSheetEditor — a sheet the game
 * build deliberately leaves out. A name like this is an exclusion, not a gap.
 */
function isEditorFrame(name: string): boolean {
  return name.startsWith("edit_");
}

class FrameChecker {
  readonly droppedGlow: string[] = [];
  readonly droppedChild: string[] = [];
  readonly droppedAnim: string[] = [];
  readonly editorOnly: string[] = [];
  readonly notGlow: string[] = [];
  readonly missing: { id: number; frame: string }[] = [];

  constructor(
    private readonly has: (name: string) => boolean,
    private readonly sheetOf: (name: string) => string | undefined,
  ) {}

  /** Keeps a frame name only when a sheet really contains it. */
  keep(name: string | null, drop: string[] | null): string | undefined {
    if (name === null) return undefined;
    if (this.has(name)) return name;
    drop?.push(name);
    return undefined;
  }

  /**
   * Keeps a glow frame only when it really is one.
   *
   * The fan table's `glow_frame` is not just over-generous, it is wrong: 97 of
   * the 354 names it supplies are simply a different frame of the same sprite —
   * id 1591 is lava with its glow set to `lava_top_bubble_008.png`, id 1519 is
   * `starAnim_004` pointing at `starAnim_002`, and several point at
   * `emptyFrame.png`. 36 of those are ids the official levels place, so drawing
   * them additively would ghost the wrong art over lava, stars and smoke.
   *
   * A real glow frame either says so in its name or lives on the glow sheet —
   * the sheet holds 209 frames of which 24, the `playerDash2_*` set, are not
   * named for it. The two tests together keep exactly the 257 genuine names.
   * [meas: assets/atlas/uhd.json against the shipped table]
   */
  glow(name: string | null): string | undefined {
    const frame = this.keep(name, this.droppedGlow);
    if (frame === undefined) return undefined;
    if (/glow/i.test(frame) || this.sheetOf(frame) === "GJ_GameSheetGlow") return frame;
    this.notGlow.push(frame);
    return undefined;
  }
}

// --- the art half ------------------------------------------------------------

function gdcloneChild(c: GdcloneChild, check: FrameChecker): ChildRecord | null {
  const frame = check.keep(cleanFrameName(c.texture), check.droppedChild);
  if (!frame) return null;
  const out: ChildRecord = { f: frame, dx: tidy(numberOr(c.x, 0)), dy: tidy(numberOr(c.y, 0)), z: numberOr(c.z, 0) };
  // gdclone turns counter-clockwise; the game's setRotation, and ChildRecord,
  // turn clockwise. The slope pieces show it: 1744's outline is -26.5 in the
  // game and 26.5 in gdclone, 294's triangle and 371's plank -45 against 45,
  // 646's block edge 90 against -90.
  // [setupCustomSprites :174362-174366, :610066-610070, :609921-609925, :612065-612069]
  const rot = tidy(-numberOr(c.rot, 0));
  if (rot !== 0) out.rot = rot;
  // gdclone writes the anchor as anchorPoint − 0.5, a share of the frame.
  const ax = tidy(numberOr(c.anchor_x, 0));
  const ay = tidy(numberOr(c.anchor_y, 0));
  const anchored = ax !== 0 || ay !== 0;
  // A texture flip is a negative scale about the centre, so a centred child
  // folds it in and the renderer has one concept instead of two. About any
  // other anchor it is not — a flip mirrors the sprite in place, a negative
  // scale onto the far side of the anchor — so an anchored child keeps it.
  // [CCSprite::setFlipX; setupCustomSprites :609992-610030]
  const sx = tidy(numberOr(c.scale_x, 1) * (c.flip_x && !anchored ? -1 : 1));
  const sy = tidy(numberOr(c.scale_y, 1) * (c.flip_y && !anchored ? -1 : 1));
  if (sx !== 1) out.sx = sx;
  if (sy !== 1) out.sy = sy;
  if (ax !== 0) out.ax = ax;
  if (ay !== 0) out.ay = ay;
  if (anchored && c.flip_x) out.fx = 1;
  if (anchored && c.flip_y) out.fy = 1;
  const ct = colorType(c.color_type);
  if (ct) out.ct = ct;
  const a = numberOr(c.opacity, 1);
  if (a !== 1) out.a = tidy(a);
  const nested = (c.children ?? []).map((n) => gdcloneChild(n, check)).filter((n): n is ChildRecord => n !== null);
  if (nested.length > 0) out.ch = nested;
  return out;
}

/**
 * Which colour channel a child sprite follows, for the ids the game's own table
 * does not reach (everything above 1911, which is 497 of the census).
 *
 * The signal is the fan table's packed-RGB `tint`, but only two of its values
 * mean anything. Checked against gdclone's `color_type` over the 1,384 children
 * both sources describe: 0x00CC00 is detail 464 times out of 464, and 0 is the
 * black channel. 0x00FF00 decides nothing — it is base 558 times and detail 265
 * times — so it is left absent, which the renderer reads as base.
 *
 * That last value is the residual: about a fifth of these children should follow
 * the detail channel and will follow the base one instead. Nothing in either
 * table separates them — the frame name does not either, since none of the 265
 * carry the `_color_` marker that the detail sprites below id 1911 use. It shows
 * only where a level gives base and detail different colours, so the report
 * counts it and the provenance stays "bootstrap".
 * [meas: data/ref/gdclone-object.json against data/objects-bootstrap.json]
 */
const TINT_DETAIL = 0x00cc00;

function childColorType(c: BootstrapChild): ColorType | undefined {
  if (c.tint === TINT_DETAIL) return "D";
  if (c.tint === 0 || c.colorChannel === "black") return "K";
  return undefined;
}

function bootstrapChild(c: BootstrapChild, check: FrameChecker): ChildRecord | null {
  const frame = check.keep(cleanFrameName(c.frame), check.droppedChild);
  if (!frame) return null;
  const out: ChildRecord = { f: frame, dx: tidy(numberOr(c.dx, 0)), dy: tidy(numberOr(c.dy, 0)), z: numberOr(c.z, 0) };
  const rot = tidy(numberOr(c.rot, 0));
  if (rot !== 0) out.rot = rot;
  if (c.blend === "additive") out.bl = 1;
  const ct = childColorType(c);
  if (ct) out.ct = ct;
  const glow = check.glow(cleanFrameName(c.glowFrame));
  if (glow) out.g = glow;
  return out;
}

/**
 * The z layer and order an object defaults to, merged from the three reference
 * tables.
 *
 * gdclone wins where it reaches (ids up to 1911). Above that the 2.206
 * `customSetup` extraction is next, but only when it is not simply reporting
 * the value the extractor seeded before the function ran — and it is exactly
 * that in every disagreement: of the two tables' 589 differing z orders all 589
 * are gdclone against the seed 0, and of 268 differing layers 263 are gdclone
 * against the seed 5. So the two sources never really contradict each other;
 * one of them just has not been told. The five that do differ otherwise are the
 * speed portals, where the extraction says layer 4 — not a layer the game has —
 * so any value outside the enum falls through to the next source.
 *
 * The fan table is last and still earns its place: it carries a real value for
 * 106 census ids where the extraction only has the seed.
 * [meas: data/ref/gdclone-object.json against data/ref/gd_2206_customSetup_objectTypes.csv]
 */
function mergeZ(rec: ObjectRecord, id: number, e: BootstrapEntry | undefined, g: GdcloneEntry | undefined, csv: Map<number, ZPair>): Provenance["z"] {
  const take = (zl: unknown, zo: unknown, from: Provenance["z"]): Provenance["z"] | null => {
    if (typeof zl !== "number" || !isZLayer(zl)) return null;
    rec.zl = zl;
    if (typeof zo === "number") rec.zo = zo;
    return from;
  };
  const c = csv.get(id);
  // The pixel art the 2.206 customSetup puts at one blanket order (B1, 9)
  // and the fan table gives an order of its own: the edge strips over the
  // tiles they edge (10), a few fills under them (8). The game this port is
  // checked against draws Dash's ceiling blocks that way — the yellow strip
  // along each block's foot is over the tile even where the level lists it
  // first, which two pieces at the same order cannot do — so the table's
  // order is the newer game's and stands. [meas: a 2.2074 screenshot of Dash
  // at 4 %, ceiling blocks at x 1185 and 1365 (2543 before 2542 in the level);
  // GameObject::customSetup LABEL_787 :178511-178519 for the blanket 9]
  if (c && c.zl === 3 && c.zo === 9 && e?.zLayer === 3 && typeof e.zOrder === "number" && e.zOrder !== 9 && /^pixelart_/.test(e.frame ?? "")) {
    return take(e.zLayer, e.zOrder, "bootstrap") ?? "none";
  }
  return (
    take(g?.default_z_layer, g?.default_z_order, "gdclone") ??
    // (5, 0) is the pair the extractor starts from, so it means "never set".
    (c && !(c.zl === CUSTOM_SETUP_SEED.zl && c.zo === CUSTOM_SETUP_SEED.zo) ? take(c.zl, c.zo, "customSetup") : null) ??
    take(e?.zLayer, e?.zOrder, "bootstrap") ??
    "none"
  );
}

/**
 * Objects the fan table hangs a sprite on that the game never makes: the
 * pulsing balls are their main sprite alone. setupCustomSprites adds nothing
 * to them (41-61 fall through to its end, :614711-614715, and so do 148, 149
 * and 405), addColorSprite makes them no colour sprite, and the extra ball
 * PlayLayer::addObject makes is the rods' (15-17), not theirs. The fan
 * table's child — the rod's ball, or the ball's own frame again — was drawn
 * as the colour sprite behind each of them in white, or in key 22's colour.
 * [setupCustomSprites :605579-614812 and addColorSprite :171326-172378,
 *  traced for every id; PlayLayer::addObject :90320-90350]
 */
const NO_CHILD_SPRITE_IDS: ReadonlySet<number> = new Set([50, 51, 52, 53, 54, 60, 148, 149, 405]);

/** The three radial glows, whose quadrants are added together. */
const RADIAL_GLOW_IDS: ReadonlySet<number> = new Set([1886, 1887, 1888]);

function applyArt(rec: ObjectRecord, id: number, e: BootstrapEntry | undefined, g: GdcloneEntry | undefined, check: FrameChecker): Provenance["art"] {
  let source: Provenance["art"] = "none";

  if (g) {
    const name = cleanFrameName(g.texture);
    const frame = check.keep(name, null);
    if (frame) {
      rec.f = frame;
      source = "gdclone";
    } else if (name && isEditorFrame(name)) {
      check.editorOnly.push(name);
    } else if (g.texture) {
      check.missing.push({ id, frame: String(g.texture) });
    }
    if (typeof g.default_base_color_channel === "number" && g.default_base_color_channel !== 0) rec.bc = g.default_base_color_channel;
    if (typeof g.default_detail_color_channel === "number" && g.default_detail_color_channel !== 0) rec.dc = g.default_detail_color_channel;
    const ct = colorType(g.color_type);
    if (ct) rec.ct = ct;
    if (g.swap_base_detail === true) rec.sw = 1;
    const a = numberOr(g.opacity, 1);
    if (a !== 1) rec.a = tidy(a);
    const children = (g.children ?? []).map((c) => gdcloneChild(c, check)).filter((c): c is ChildRecord => c !== null);
    // The radial glows' four quadrants all sit on the object's centre: one
    // loop adds them at (0, 0) for 1886-1888 alike, and only the anchor and
    // the mirroring scales place them. gdclone gives 1888's ±0.25 offsets,
    // which open a dark cross through the middle of the glow.
    // [setupCustomSprites :610143-610190; unk_A9D4C8 is (0, 0) :13979]
    if (RADIAL_GLOW_IDS.has(id)) {
      for (const c of children) {
        c.dx = 0;
        c.dy = 0;
      }
    }
    if (children.length > 0) rec.ch = children;
  }

  if (e) {
    // The old table fills in whatever the game's own table is silent about.
    // That includes children: it knows the portal arrows and the orb rings,
    // which the first source leaves to game code.
    if (!rec.f) {
      const name = cleanFrameName(e.frame);
      const frame = check.keep(name, null);
      if (frame) {
        rec.f = frame;
        source = source === "none" ? "bootstrap" : source;
      } else if (name && isEditorFrame(name)) {
        check.editorOnly.push(name);
      } else if (e.frame) {
        check.missing.push({ id, frame: String(e.frame) });
      }
    }
    if (rec.bc === undefined && typeof e.baseChannel === "number" && e.baseChannel > 0) rec.bc = e.baseChannel;
    if (rec.dc === undefined && typeof e.detailChannel === "number" && e.detailChannel > 0) rec.dc = e.detailChannel;
    if (!rec.ch && !NO_CHILD_SPRITE_IDS.has(id)) {
      const children = ((e.children ?? []) as BootstrapChild[])
        .map((c) => bootstrapChild(c, check))
        .filter((c): c is ChildRecord => c !== null);
      if (children.length > 0) rec.ch = children;
    }
  }

  // Fields only the old table carries, whichever source supplied the frame.
  const r = raw(e);
  const glow = check.glow(cleanFrameName(r.glow_frame));
  if (glow) rec.g = glow;
  // The fan table spells this as a string, not a flag.
  if (r.blend === "additive") rec.bl = 1;
  // The fan table's `black` flag is not taken. Up to 1911 the game's own
  // table's "Black" is exactly the art the game makes black for good
  // (setObjectColor(ccBLACK) and +541), and past 1911 the game makes none.
  // The fan flag is set on objects that are merely black by default — the
  // beasts, the sludge and the fake spikes, whose main colour defaults to
  // 1010 and which key 21 recolours — and on some that are not black at
  // all: the slope outline 309, the cogwheels 675-677 and the block edge
  // 1363, which follow their main colour like any other object.
  // [setupCustomSprites :614660-614800, :606565-606820, :609096-609097 and
  //  customSetup :178915-178916, :180361-180362, traced for every id, against
  //  data/ref/gdclone-object.json's "Black"; setDefaultMainColorMode(1010)
  //  :177567, :179229, :180858]

  // The old table's animFrames and animInterval are not carried: 41 of its 42
  // intervals are not the game's, and it has no list at all for 87 of the
  // game's animated ids. The renderer reads the game's own table instead
  // (src/assets/gameAnimations.ts). [meas: against GameManager::
  //  setupGameAnimations, gd-ida-decomp.cpp:622973-624650]

  const randomFrames = Array.isArray(r.randomFrames) ? (r.randomFrames as unknown[]) : null;
  if (randomFrames && randomFrames.length > 0) {
    const frames = randomFrames.map((f) => check.keep(cleanFrameName(f), check.droppedAnim)).filter((f): f is string => f !== undefined);
    if (frames.length > 0) rec.rnd = frames;
  }

  if (r.textObject === true) {
    rec.txt = {
      font: typeof r.font === "string" ? r.font : "Pusab",
      size: numberOr(r.textSize, 30),
      def: typeof r.defaultText === "string" ? r.defaultText : "",
    };
  }
  if (r.teleportEntry === true) rec.tp = "entry";
  else if (r.teleportExit === true) rec.tp = "exit";

  const entity = ANIM_ENTITY_IDS.get(id);
  if (entity) rec.ent = entity;

  return source;
}

/** A frame's family: its name without the `_NNN.png`. */
function familyOf(frame: string): string {
  return frame.replace(/_\d{3}\.png$/, "");
}

/** The fire_b and 2.2 sets, whose colour the game puts on the colour sprite's child. [updateSyncedAnimation LABEL_294 :621187-621208] */
function coloursBehind(id: number): boolean {
  return (id >= 1936 && id <= 1939) || (id >= 2020 && id <= 2055) || id === 2864 || id === 2865 || (id >= 2867 && id <= 2894);
}

/**
 * The sets whose colour sprite is never drawn and carries one child at twice
 * its size, where the colour frames play: the looped fires, fire_b, and the
 * 2.2 sets but 2041, 2042, 2046, 2051-2054, 2866, 2868 and 2870 (which put
 * the colour on the colour sprite itself, or have none). Their colour frames
 * are drawn at half the main frames' size for it.
 * [setupCustomSprites :612779-612787, :612824-612832, :612907-612927 (920,
 *  921, 923, 924), :609850-609898 (1936-1939), LABEL_1825 :610199-610215
 *  (2020-2040 falling into it, 2043-2045, 2047-2050, 2055, 2864, 2865, 2867,
 *  2869, 2871-2891, 2894; :610334-610353, :610835-610946),
 *  :610841-610858 (2892, 2893); updateSyncedAnimation LABEL_294
 *  :621187-621208 sets the colour frame on +748's first child, dispatched
 *  :621037-621045, :621110-621133]
 */
function colourOnDoubledChild(id: number): boolean {
  return (
    id === 920 || id === 921 || id === 923 || id === 924 ||
    (id >= 1936 && id <= 1939) ||
    (id >= 2020 && id <= 2040) ||
    (id >= 2043 && id <= 2045) ||
    (id >= 2047 && id <= 2050) ||
    id === 2055 || id === 2864 || id === 2865 || id === 2867 || id === 2869 ||
    (id >= 2871 && id <= 2894)
  );
}

/**
 * The objects whose colour sprite the game never draws (+471 on what
 * addCustomColorChild returns), only the children hung on it: the sets
 * above, and the block, slope and square pieces whose colour art is a child
 * of a placeholder. gdclone describes that sprite as an ordinary detail child
 * with children of its own, so the build marks it. [setupCustomSprites
 *  :607868-607875 (1281), :608041-608047 (1290), :608890-608896 (1592),
 *  :609190-609194, :609526-609530 (1789-1792), :609268-609327 (1773-1775),
 *  :609690-609697 (LABEL_1141, 1794-1810), :609935-609941, :613303-613309
 *  (1906, 1907); traced by tools/ref-trace-ida-customsetup.py
 *  (dontDraw:GameObject::addCustomColorChild)]
 */
const COLOUR_SPRITE_HIDDEN_IDS: ReadonlySet<number> = new Set([
  1281, 1290, 1592, 1773, 1774, 1775, 1789, 1790, 1791, 1792, 1794, 1796, 1800, 1802, 1804, 1806, 1808, 1810, 1906, 1907,
]);

/**
 * The block pieces and slopes whose own sprite, a one- or two-block outline,
 * the game never draws (+471): the art is all children. Not every object on
 * an outline frame: most of those draw it. [setupCustomSprites
 *  :609160-609163, :609495-609499 (1789-1792), :609235-609241 (1775,
 *  1776), :609281-609284 (1773, 1774), :609358-609418 (1785-1788),
 *  LABEL_1141 :609625-609626 (1794-1810), LABEL_1103 :609918-609919 (371
 *  by :613318, 1906), LABEL_1107 :613286-613287 (372, 1907), :610063-610065
 *  (1899), :609835-609837 (1900); traced by tools/ref-trace-ida-customsetup.py
 *  (471)]
 */
const MAIN_SPRITE_HIDDEN_IDS: ReadonlySet<number> = new Set([
  371, 372, 1773, 1774, 1775, 1776, 1785, 1786, 1787, 1788, 1789, 1790, 1791, 1792, 1794, 1796, 1800, 1802, 1804, 1806,
  1808, 1810, 1899, 1900, 1906, 1907,
]);

/**
 * Marks the sprites the game makes and never draws (ChildRecord.dd,
 * ObjectRecord.dd). The colour sprite is the record's one detail child that
 * carries children; a record without exactly one is left as it is and
 * counted, so a change in the source shows in the report.
 */
function hiddenSprites(rec: ObjectRecord, id: number, unmatched: number[]): void {
  if (MAIN_SPRITE_HIDDEN_IDS.has(id) && rec.f && (rec.ch ?? []).length > 0) rec.dd = 1;
  if (!COLOUR_SPRITE_HIDDEN_IDS.has(id) && !colourOnDoubledChild(id)) return;
  const parents = (rec.ch ?? []).filter((c) => c.ct === "D" && (c.ch ?? []).length > 0);
  if (parents.length === 1) parents[0].dd = 1;
  else if (COLOUR_SPRITE_HIDDEN_IDS.has(id) || rec.p.art === "gdclone") unmatched.push(id);
}

/**
 * An animated object's sprites from the game's animation table, for the ids
 * the fan table describes: the main frames play on the object and the colour
 * frames on its colour sprite, which takes the secondary (detail) colour. So
 * the object rests on `${name}_001.png`, and with a colour family it has one
 * detail child on `${color}_001.png`; a child resting on the colour family,
 * or on the main family in the detail slot, is the fan table's guess at that
 * sprite and goes. Any other child stays. The new child keeps the z of the
 * one it replaces, else the z the set's other records give it: behind for
 * the fire_b and 2.2 sets, in front for the pixel art. The small coin (1614)
 * is the game's own record, which leaves its sprites to game code: its frame
 * goes on a child, with the colour sprite under that child and a highlight
 * child above both, and the animation walks all three through four sheets.
 * Returns whether anything changed.
 * [EnhancedGameObject::updateSyncedAnimation LABEL_303 :621663-621675,
 *  LABEL_294 :621187-621208, 1614 :621568-621640; setupCustomSprites
 *  :608779-608801 (1614); GameObject::updateSecondaryColor / colorForMode
 *  (+560, 0); meas: the z of the colour children in data/objects-bootstrap.json]
 */
function animatedArt(rec: ObjectRecord, id: number, source: Provenance["art"], check: FrameChecker): boolean {
  const entry = GAME_ANIMATIONS.get(id);
  if (!entry || entry.frames <= 1) return false;
  if (id === SMALL_COIN) {
    if (!rec.f || (rec.ch ?? []).length > 0) return false;
    const colour = check.keep("smallCoin_01_color_001.png", check.droppedChild);
    const highlight = check.keep("smallCoin_01_highlight_001.png", check.droppedChild);
    const children: ChildRecord[] = [];
    if (colour) children.push({ f: colour, dx: 0, dy: 0, z: 1, ct: "D" });
    if (highlight) children.push({ f: highlight, dx: 0, dy: 0, z: 10 });
    if (children.length > 0) rec.ch = children;
    return children.length > 0;
  }
  if (source !== "bootstrap" && source !== "none") return false;
  const main = check.keep(`${entry.name}_001.png`, null);
  if (!main) return false;
  rec.f = main;
  const colourFamily = entry.color;
  let z: number | undefined;
  const kept = (rec.ch ?? []).filter((c) => {
    const family = familyOf(c.f);
    const wrong = family === colourFamily || (family === entry.name && c.ct === "D");
    if (wrong && z === undefined) z = c.z;
    return !wrong;
  });
  const colour = colourFamily ? check.keep(`${colourFamily}_001.png`, null) : undefined;
  if (colour) {
    // The never-drawn colour sprite and its doubled child, as one sprite.
    const doubled = colourOnDoubledChild(id) ? { sx: 2, sy: 2 } : {};
    kept.unshift({ f: colour, dx: 0, dy: 0, z: z ?? (coloursBehind(id) ? -100 : 100), ...doubled, ct: "D" });
  }
  if (kept.length > 0) rec.ch = kept;
  else delete rec.ch;
  return true;
}

/** The small coin, whose sprites the game builds in code. */
const SMALL_COIN = 1614;

// --- the physics half --------------------------------------------------------

function hitboxProvenance(def: ObjectDef, id: number, e: BootstrapEntry | undefined): Provenance["hb"] {
  if (GDCLONE_HITBOXES.has(id)) return "gdclone";
  if (def.source === "manual") return "manual";
  const g = GAME_OBJECT_TYPES.get(id);
  if (g && g.e === 1) return "gameTypes";
  if (e?.hitbox) return "bootstrap";
  return "none";
}

function physicsHalf(def: ObjectDef): ObjectRecord {
  const rec: ObjectRecord = { k: def.kind, hb: def.hitbox, src: def.source, p: { hb: "none", art: "none", z: "none" } };
  if (def.passable) rec.passable = 1;
  if (def.breakable) rec.breakable = 1;
  if (def.special) rec.special = def.special;
  if (def.orb) rec.orb = def.orb;
  if (def.pad) rec.pad = def.pad;
  if (def.portal) rec.portal = def.portal;
  if (def.collectible) rec.collectible = def.collectible;
  if (def.forceShape) rec.forceShape = def.forceShape;
  if (def.animated) rec.anim = 1;
  if (typeof def.gridW === "number") rec.gw = def.gridW;
  if (typeof def.gridH === "number") rec.gh = def.gridH;
  return rec;
}

// --- the step ----------------------------------------------------------------

export interface ObjectsReport {
  generated: string;
  validatedAgainst: string;
  totals: { ids: number; census: number; withFrame: number; withGlow: number; withChildren: number; children: number; withAnim: number };
  provenance: { hitbox: Record<string, number>; art: Record<string, number> };
  dropped: {
    glow: number;
    child: number;
    anim: number;
    editorOnly: number;
    /** Names the old table called a glow frame that are an ordinary frame of the same sprite. */
    notGlow: number;
    glowNames: string[];
    notGlowNames: string[];
    childNames: string[];
    animNames: string[];
  };
  missing: { census: { id: number; frame: string; uses: number }[]; other: { id: number; frame: string }[] };
  perLevel: Record<string, { ids: number; resolved: number; missing: number[] }>;
}

function inputPaths(ctx: StepContext): string[] {
  return [
    join(ctx.data, "objects-bootstrap.json"),
    join(ctx.data, "ref", "gdclone-object.json"),
    join(ctx.data, "ref", "gd_2206_customSetup_objectTypes.csv"),
    join(ctx.data, "census.json"),
    join(ctx.data, "ref", "customSetup_render_flags_2206.json"),
    join(ctx.data, "ref", "customSetup_particles_2206.json"),
  ];
}

interface TracedParticle {
  plist: string;
  z: number | string;
  position: number;
  start?: (number | null)[];
  end?: (number | null)[];
  offset?: number[];
  "669"?: number;
  "670"?: number;
  "680"?: number;
  "920"?: number;
}

/** The traced particle systems (tools/ref-trace-ida-particles.py), by id, as records carry them. */
function readParticles(file: string): Map<number, BuiltInParticle> {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, TracedParticle>;
  const out = new Map<number, BuiltInParticle>();
  const rgba = (c: (number | null)[] | undefined): [number, number, number, number | null] | undefined =>
    c && c.length === 4 ? [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3]] : undefined;
  for (const [id, t] of Object.entries(raw)) {
    const p: BuiltInParticle = { e: t.plist.replace(/\.plist$/, ""), pos: t.position === 1 ? 1 : 2 };
    // The trace leaves a z it could not work out as the expression; none does.
    if (typeof t.z !== "number") throw new Error(`object ${id}: the trace has no z for ${t.plist} (${t.z})`);
    if (t.z !== 0) p.z = t.z;
    const s = rgba(t.start);
    const en = rgba(t.end);
    if (s) p.s = s;
    if (en) p.en = en;
    if (t.offset && (t.offset[0] !== 0 || t.offset[1] !== 0)) p.o = [t.offset[0], t.offset[1]];
    if (t["669"]) p.c = 1;
    if (t["670"]) p.cs = 1;
    if (t["680"]) p.s1 = 1;
    if (t["920"]) p.r0 = 1;
    out.set(Number(id), p);
  }
  return out;
}

/** The ids the trace says hide their own sprite (+471), from tools/ref-trace-ida-customsetup.py's output. */
function readHiddenMain(file: string): Set<number> {
  const flags = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
  const out = new Set<number>();
  for (const [id, f] of Object.entries(flags)) if (f["471"] === 1) out.add(Number(id));
  return out;
}

/**
 * The objects drawn through a copy of their own frame: setupCustomSprites
 * hides the object's sprite (+471) and hangs a copy of the same frame on it
 * with addCustomChild, which takes the object's own colour, so the frame is
 * drawn once. The tables carry both the sprite and the copy, so it drew
 * twice: an additive one twice as bright, or the copy in the other channel —
 * 1752's ring spiral in its main colour over a light-background twin. Marked
 * here when the trace has +471 on the object's sprite and a child is that
 * frame exactly: same place, no turn, size, flip or anchor of its own. The
 * copy takes the main sprite's colour type, so it lands in the same channel.
 * [setupCustomSprites LABEL_1808 :614435-614462 (and the ids that reach it,
 *  e.g. 1752 :609068-609105); addCustomChild :166842-166856; traced by
 *  tools/ref-trace-ida-customsetup.py (471)]
 */
function drawnThroughCopy(rec: ObjectRecord, hidesMain: boolean): boolean {
  if (!hidesMain || !rec.f || rec.dd) return false;
  const copy = (rec.ch ?? []).find(
    (c) =>
      c.f === rec.f &&
      c.dx === 0 &&
      c.dy === 0 &&
      !c.rot &&
      (c.sx ?? 1) === 1 &&
      (c.sy ?? 1) === 1 &&
      !c.ax &&
      !c.ay &&
      !c.fx &&
      !c.fy &&
      !c.dd,
  );
  if (!copy) return false;
  rec.dd = 1;
  if (rec.ct) copy.ct = rec.ct;
  else delete copy.ct;
  return true;
}

export const objectsStep: StepModule = {
  name: "objects",
  needs: ["sheets"],
  optionKeys: ["res"],

  // Hand-written tables and the physics table this step serialises. Without
  // these a correction in src/ would not invalidate the step.
  sources: [
    "src/assets/objectTypes.ts",
    "src/physics/objectRenderOverrides.ts",
    "src/physics/objectData.ts",
    "src/physics/objects.ts",
    "src/physics/gdcloneHitboxes.ts",
    "src/physics/gameObjectTypes.ts",
    "src/assets/gameAnimations.ts",
  ],

  inputs: inputPaths,

  run(ctx: StepContext): StepResult {
    const [bootstrapPath, gdclonePath, customSetupPath, censusPath, flagsPath, particlesPath] = inputPaths(ctx);
    const hidesMain = readHiddenMain(flagsPath);
    const particles = readParticles(particlesPath);
    const bootstrap = JSON.parse(readFileSync(bootstrapPath, "utf8")) as BootstrapJson;
    const gdclone = JSON.parse(readFileSync(gdclonePath, "utf8")) as Record<string, GdcloneEntry>;
    const customSetup = readCustomSetup(customSetupPath);
    const census = JSON.parse(readFileSync(censusPath, "utf8")) as Census;
    const frames = ctx.frames;
    if (!frames) throw new Error("the sheets step must run first: there is no frame index to validate against");

    const check = new FrameChecker(
      (n) => frames.has(n),
      (n) => frames.sheetOf.get(n),
    );
    const table = buildObjectTable(bootstrap);
    const censusIds = Object.keys(census.counts).map(Number).filter(Number.isInteger);
    const censusSet = new Set(censusIds);

    const objects: Record<string, ObjectRecord> = {};
    const hitboxProv: Record<string, number> = {};
    const artProv: Record<string, number> = {};
    let withFrame = 0;
    let withGlow = 0;
    let withChildren = 0;
    let childCount = 0;
    let withAnim = 0;
    const hiddenUnmatched: number[] = [];
    let throughCopy = 0;

    for (const id of table.ids()) {
      const def = table.get(id);
      const e = bootstrap[String(id)];
      const rec = physicsHalf(def);
      const before = check.missing.length;
      let art = applyArt(rec, id, e, gdclone[String(id)], check);
      if (animatedArt(rec, id, art, check)) art = "gameAnimations";
      const zFrom = mergeZ(rec, id, e, gdclone[String(id)], customSetup);
      const override = RENDER_OVERRIDES.get(id);
      if (override) Object.assign(rec, override);
      rec.p = {
        hb: hitboxProvenance(def, id, e),
        art: override ? "manual" : art,
        z: override && (override.zl !== undefined || override.zo !== undefined) ? "manual" : zFrom,
      };
      hiddenSprites(rec, id, hiddenUnmatched);
      if (drawnThroughCopy(rec, hidesMain.has(id))) throughCopy++;
      const particle = particles.get(id);
      if (particle) rec.pt = particle;
      // A missing frame only matters when the object is one the levels use.
      if (check.missing.length > before && !censusSet.has(id)) {
        // keep it in the report, but it is a warning rather than an error
      }
      hitboxProv[rec.p.hb] = (hitboxProv[rec.p.hb] ?? 0) + 1;
      artProv[rec.p.art] = (artProv[rec.p.art] ?? 0) + 1;
      if (rec.f) withFrame++;
      if (rec.g) withGlow++;
      if (rec.ch) {
        withChildren++;
        childCount += rec.ch.length;
      }
      // Animated by the game's own table, which the renderer reads directly.
      if ((GAME_ANIMATIONS.get(id)?.frames ?? 0) > 1) withAnim++;
      objects[String(id)] = rec;
    }

    const file: ObjectsFile = {
      version: 1,
      validatedAgainst: frames.res,
      objects,
      census: censusIds,
    };

    const missingCensus = check.missing
      .filter((m) => censusSet.has(m.id))
      .map((m) => ({ ...m, uses: census.counts[String(m.id)] ?? 0 }))
      .sort((a, b) => b.uses - a.uses);
    const missingOther = check.missing.filter((m) => !censusSet.has(m.id));

    const missingIds = new Set(check.missing.map((m) => m.id));
    const perLevel: ObjectsReport["perLevel"] = {};
    for (const [level, ids] of Object.entries(census.perLevel)) {
      const missing = ids.filter((id) => !objects[String(id)]?.f && missingIds.has(id));
      perLevel[level] = { ids: ids.length, resolved: ids.length - missing.length, missing };
    }

    const report: ObjectsReport = {
      generated: new Date().toISOString(),
      validatedAgainst: frames.res,
      totals: { ids: table.ids().length, census: censusIds.length, withFrame, withGlow, withChildren, children: childCount, withAnim },
      provenance: { hitbox: hitboxProv, art: artProv },
      dropped: {
        glow: check.droppedGlow.length,
        child: check.droppedChild.length,
        anim: check.droppedAnim.length,
        editorOnly: check.editorOnly.length,
        notGlow: check.notGlow.length,
        glowNames: [...new Set(check.droppedGlow)].sort().slice(0, 200),
        notGlowNames: [...new Set(check.notGlow)].sort(),
        childNames: [...new Set(check.droppedChild)].sort().slice(0, 200),
        animNames: [...new Set(check.droppedAnim)].sort().slice(0, 200),
      },
      missing: { census: missingCensus, other: missingOther },
      perLevel,
    };

    let bytes = 0;
    const outputs: string[] = [];
    if (ctx.opts.verify) {
      bytes += fileSize(join(ctx.out, "objects.json"));
    } else {
      bytes += writeJson(join(ctx.out, "objects.json"), file).bytes;
      writeJson(join(ctx.data, "objects-report.json"), report, true);
    }
    outputs.push("objects.json");

    for (const m of missingCensus) {
      ctx.log.error(`object ${m.id} (used ${m.uses}×) has no frame: ${m.frame}`);
    }
    ctx.log.note(`${throughCopy} objects draw their frame once, through a copy (drawnThroughCopy)`);
    if (hiddenUnmatched.length > 0) {
      ctx.log.warn(`no single colour sprite to mark don't-draw on ${hiddenUnmatched.join(", ")}`);
    }
    if (missingOther.length > 0) {
      ctx.log.warn(`${missingOther.length} object(s) outside the official levels have no frame (see data/objects-report.json)`);
    }
    ctx.shared.set("objects", { file, report });

    return {
      files: ctx.opts.verify ? 0 : 1,
      bytes,
      skipped: 0,
      summary:
        `${table.ids().length} ids  ${withFrame} with art  ${childCount} children  ` +
        `census ${censusIds.length}/${censusIds.length - missingCensus.length} resolved  ${check.droppedGlow.length} glow dropped`,
      outputs,
    };
  },
};
