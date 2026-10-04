// Builds the physics ObjectTable from the fan-port bootstrap JSON
// (data/objects-bootstrap.json) plus the manual knowledge in objectData.ts.
// Pure: the caller loads the JSON (readFileSync in node tests, fetch in the
// browser). Resolution order per id: the game's own hitbox assignment (gdclone
// table, ids ≤ 1911) → manual entry → bootstrap type mapping → 'unknown'.
// `get` never throws.

import type { LevelObject } from "../level/types";
import type { Hitbox, ObjectDef, ObjectKind, ObjectTable } from "./types";
import { GDCLONE_HITBOXES, GDCLONE_NO_HITBOX } from "./gdcloneHitboxes";
import { GAME_OBJECT_TYPES, GOT } from "./gameObjectTypes";
import {
  ANIMATED_HAZARDS,
  BREAKABLE_ID,
  CHECKPOINT_ID,
  COLLECTIBLES,
  COLLISION_IDS,
  CUSTOM_SPRITES_OBJECT_TYPES,
  ENHANCED_OBJECT_TYPES,
  FAKE_SPIKE_IDS,
  FORCE_BLOCK_IDS,
  FORCE_CIRCLE_ID,
  FORCE_CIRCLE_RADIUS,
  HAZARD_CIRCLES,
  HAZARD_RECTS,
  LEGACY_TRIGGER_IDS,
  ORBS,
  ORB_SIZE,
  PADS,
  PORTALS,
  SLOPE_22_IDS,
  SLOPE_45_IDS,
  SOLID_DECO_IDS,
  SOLID_IDS,
  SOLID_SIZES,
  SPECIAL_BLOCKS,
  START_POS_ID,
  SUBCLASS_OBJECT_TYPES,
  TOGGLE_BLOCK_ID,
} from "./objectData";

// ---------------------------------------------------------------------------
// Bootstrap JSON shape (tools/bootstrap-objects.mjs output)
// ---------------------------------------------------------------------------

export type BootstrapType =
  | "solid"
  | "soliddeco"
  | "hazard"
  | "portal"
  | "speed"
  | "ring"
  | "pad"
  | "coin"
  | "trigger"
  | "deco"
  | "pixel"
  | "particle";

export type BootstrapHitbox =
  | { shape: "rect"; w: number; h: number; ox: number; oy: number; source: string; estimated?: boolean }
  | { shape: "circle"; r: number; ox: number; oy: number; source: string; estimated?: boolean }
  | null;

export interface BootstrapEntry {
  type: BootstrapType | string;
  frame: string | null;
  glowFrame: string | null;
  gridW: number;
  gridH: number;
  hitbox: BootstrapHitbox;
  zLayer?: number | null;
  zOrder?: number | null;
  baseChannel?: number | null;
  detailChannel?: number | null;
  children?: unknown[];
  raw?: Record<string, unknown>;
}

export type BootstrapJson = Record<string, BootstrapEntry>;

// ---------------------------------------------------------------------------

const BLOCK = 30;

const box = (w: number, h: number, ox = 0, oy = 0): Hitbox => ({ type: "box", w, h, ox, oy });
const circle = (r: number, ox = 0, oy = 0): Hitbox => ({ type: "circle", r, ox, oy });

/** Fan-port sprite footprint in units; null when the table has no usable grid. */
function gridBox(e: BootstrapEntry | undefined): Hitbox {
  if (!e || !(e.gridW > 0) || !(e.gridH > 0)) return null;
  return box(e.gridW * BLOCK, e.gridH * BLOCK);
}

function bootstrapHitbox(e: BootstrapEntry): Hitbox {
  const h = e.hitbox;
  if (!h) return null;
  if (h.shape === "circle") return circle(h.r, h.ox, h.oy);
  return box(h.w, h.h, h.ox, h.oy);
}

/** Manual classification. Returns null when objectData has nothing to say about the id. */
function manualDef(id: number, e: BootstrapEntry | undefined): Omit<ObjectDef, "gridW" | "gridH"> | null {
  const base = { id, source: "manual" as const };

  const portal = PORTALS.get(id);
  if (portal) return { ...base, kind: "portal", hitbox: box(portal.w, portal.h, portal.ox ?? 0), portal: portal.effect };

  const orb = ORBS.get(id);
  if (orb) return { ...base, kind: "orb", hitbox: box(ORB_SIZE, ORB_SIZE), orb };

  const pad = PADS.get(id);
  if (pad) return { ...base, kind: "pad", hitbox: box(pad.w, pad.h), pad: pad.pad };

  const col = COLLECTIBLES.get(id);
  if (col) return { ...base, kind: "collectible", hitbox: box(col.w, col.h), collectible: col.collectible };

  if (id === CHECKPOINT_ID) return { ...base, kind: "checkpoint", hitbox: box(BLOCK, BLOCK) };
  if (id === START_POS_ID) return { ...base, kind: "startPos", hitbox: null };
  if (COLLISION_IDS.includes(id)) return { ...base, kind: "collision", hitbox: box(BLOCK, BLOCK) };
  // The toggle block is a custom ring (type 36), as the trigger orb is, 30 × 30
  // and hidden in play. [gdp GameObject::customSetup, gd-ida-decomp.cpp:178493-178499]
  if (id === TOGGLE_BLOCK_ID) return { ...base, kind: "orb", hitbox: box(BLOCK, BLOCK), orb: "toggle" };
  if (FORCE_BLOCK_IDS.includes(id)) {
    return id === FORCE_CIRCLE_ID
      ? { ...base, kind: "forceBlock", hitbox: circle(FORCE_CIRCLE_RADIUS), forceShape: "circle" }
      : { ...base, kind: "forceBlock", hitbox: box(BLOCK, BLOCK), forceShape: "box" };
  }
  if (LEGACY_TRIGGER_IDS.includes(id)) return { ...base, kind: "trigger", hitbox: box(BLOCK, BLOCK) };

  const special = SPECIAL_BLOCKS.get(id);
  if (special) return { ...base, kind: "solid", hitbox: box(BLOCK, BLOCK), special };
  if (id === BREAKABLE_ID) return { ...base, kind: "solid", hitbox: box(BLOCK, BLOCK), breakable: true };

  if (SLOPE_45_IDS.includes(id)) return { ...base, kind: "slope", hitbox: { type: "slope", w: BLOCK, h: BLOCK } };
  if (SLOPE_22_IDS.includes(id)) return { ...base, kind: "slope", hitbox: { type: "slope", w: 2 * BLOCK, h: BLOCK } };

  const rect = HAZARD_RECTS.get(id);
  if (rect) return { ...base, kind: "hazard", hitbox: box(rect.w, rect.h, rect.ox, rect.oy) };
  const r = HAZARD_CIRCLES.get(id);
  if (r !== undefined) return { ...base, kind: "hazard", hitbox: circle(r) };
  const ar = ANIMATED_HAZARDS.get(id);
  if (ar !== undefined) return { ...base, kind: "hazard", hitbox: circle(ar), animated: true };
  if (FAKE_SPIKE_IDS.includes(id)) return { ...base, kind: "decoration", hitbox: null };
  if (SOLID_DECO_IDS.includes(id)) return { ...base, kind: "decoration", hitbox: null };

  if (SOLID_IDS.includes(id)) {
    const size = SOLID_SIZES.get(id);
    if (size) return { ...base, kind: "solid", hitbox: box(size.w, size.h) };
    // Plain grid footprint from the bootstrap; the size itself is table data.
    const gb = gridBox(e);
    return { id, kind: "solid", hitbox: gb ?? box(BLOCK, BLOCK), source: gb ? "table" : "manual" };
  }
  return null;
}

/** Bootstrap `type` → engine kind, for ids objectData does not cover. */
function bootstrapDef(id: number, e: BootstrapEntry): Omit<ObjectDef, "frame" | "gridW" | "gridH"> {
  const estimated = e.hitbox?.source === "hazard-default" || e.hitbox?.estimated === true;
  const source = estimated ? "derived" : "table";
  const kindOf = (): ObjectKind => {
    switch (e.type) {
      case "solid":
        return "solid";
      case "hazard":
        return "hazard";
      case "ring":
        return "orb";
      case "pad":
        return "pad";
      case "portal":
      case "speed":
        return "portal";
      case "coin":
        return "collectible";
      case "trigger":
        return "trigger";
      case "deco":
      case "pixel":
      case "particle":
      case "soliddeco":
        return "decoration";
      default:
        return "unknown";
    }
  };
  const kind = kindOf();
  switch (kind) {
    case "solid":
      return { id, kind, hitbox: gridBox(e) ?? box(BLOCK, BLOCK), source: "table" };
    case "hazard":
      return { id, kind, hitbox: bootstrapHitbox(e) ?? gridBox(e), source };
    case "orb":
    case "pad":
    case "portal":
    case "collectible":
    case "trigger":
      return { id, kind, hitbox: bootstrapHitbox(e) ?? gridBox(e), source: "table" };
    case "decoration":
      // Block-looking deco (block001_*, block003_*, square_05 fillers …) really has
      // no hitbox: forcing it solid walled the player in five official levels.
      return { id, kind, hitbox: null, source: "table" };
    default:
      return { id, kind: "unknown", hitbox: null, source: "derived" };
  }
}

function unknownDef(id: number): ObjectDef {
  return { id, kind: "unknown", hitbox: null, source: "derived" };
}

type CoreDef = Omit<ObjectDef, "frame" | "gridW" | "gridH">;

/** Kinds whose identity comes from the manual tables; the game tables only refine their hitbox size. */
const MANUAL_KINDS: ReadonlySet<ObjectKind> = new Set([
  "portal", "orb", "pad", "collectible", "checkpoint", "startPos", "collision", "forceBlock", "trigger",
]);

const PAD_TYPES = new Set([GOT.YellowJumpPad, GOT.PinkJumpPad, GOT.GravityPad, GOT.RedJumpPad, GOT.SpiderPad]);
const RING_TYPES = new Set([GOT.YellowJumpRing, GOT.PinkJumpRing, GOT.GravityRing, GOT.GreenRing, GOT.DropRing,
  GOT.RedJumpRing, GOT.CustomRing, GOT.DashRing, GOT.GravityDashRing, GOT.SpiderOrb, GOT.TeleportOrb]);
const PORTAL_TYPES = new Set([GOT.InverseGravityPortal, GOT.NormalGravityPortal, GOT.ShipPortal, GOT.CubePortal,
  GOT.InverseMirrorPortal, GOT.NormalMirrorPortal, GOT.BallPortal, GOT.RegularSizePortal, GOT.MiniSizePortal,
  GOT.UfoPortal, GOT.DualPortal, GOT.SoloPortal, GOT.WavePortal, GOT.RobotPortal, GOT.TeleportPortal,
  GOT.SpiderPortal, GOT.SwingPortal, GOT.GravityTogglePortal]);

/**
 * What the game itself makes of the object. Two game-derived tables:
 * GAME_OBJECT_TYPES (m_objectType from GameObject::customSetup, every id) and
 * GDCLONE_HITBOXES (the resulting hitbox shapes, ids ≤ 1911). Together they
 * settle what the fan port and OpenGD disagreed on: fill blocks (square_05,
 * block001_* …) are Decoration with no hitbox, the black outline pieces
 * 467–475 are the solid skeleton of 1.9 structures (468 is a 30×1.5 edge),
 * pits and saws keep small centred boxes/circles. Types the game assigns
 * outside customSetup show up as the default Solid with `e` unset; for those
 * the hitbox table (or, past 1911, the bootstrap) decides. setupCustomSprites
 * runs after every customSetup and makes the 3DL pieces and perspective blocks
 * Decoration, so that wins over all of it: the perspective slopes 522 and 523,
 * Slope to customSetup, do not collide. [GameObject::setupCustomSprites
 * LABEL_1827, gd-ida-decomp.cpp:613575-613582; objectFromVector :184192-184201]
 */
function gameDef(id: number, e: BootstrapEntry | undefined, manual: CoreDef | null): CoreDef | null {
  if (CUSTOM_SPRITES_OBJECT_TYPES.get(id) === GOT.Decoration) return { id, kind: "decoration", hitbox: null, source: "table" };
  const g = GAME_OBJECT_TYPES.get(id);
  const gh = GDCLONE_HITBOXES.get(id);
  const known = gh !== undefined || GDCLONE_NO_HITBOX.has(id);
  if (!g && !known) return null;
  if (manual && MANUAL_KINDS.has(manual.kind)) return gh ? { ...manual, hitbox: gh } : manual;
  if (manual && manual.kind === "solid" && (manual.special || manual.breakable)) return manual;

  const src = { source: "table" as const };
  if (g && g.e) {
    switch (g.t) {
      case GOT.Decoration:
      case GOT.EnterEffectObject:
        return { id, kind: "decoration", hitbox: null, ...src };
      case GOT.Slope:
        return { id, kind: "slope", hitbox: gh ?? { type: "slope", w: (e && e.gridW > 1.5 ? 2 : 1) * BLOCK, h: BLOCK }, ...src };
      case GOT.Hazard:
      case GOT.AnimatedHazard: {
        const hb = gh ?? (manual && manual.kind === "hazard" ? manual.hitbox : null) ?? (g.r ? circle(g.r) : g.w && g.h ? box(g.w, g.h) : null)
          ?? (e ? bootstrapHitbox(e) ?? gridBox(e) : null);
        return { id, kind: "hazard", hitbox: hb, animated: g.t === GOT.AnimatedHazard || undefined, source: gh ? "table" : "derived" };
      }
      case GOT.Solid:
      case GOT.Breakable: {
        const hb = gh ?? (g.w && g.h ? box(g.w, g.h) : gridBox(e)) ?? box(BLOCK, BLOCK);
        const def: CoreDef = { id, kind: "solid", hitbox: hb, ...src };
        if (g.t === GOT.Breakable) def.breakable = true;
        if (g.p) def.passable = true;
        return def;
      }
      case GOT.Modifier:
        return { id, kind: "trigger", hitbox: gh ?? box(BLOCK, BLOCK), ...src };
      case GOT.Special:
        return { id, kind: "decoration", hitbox: null, ...src };
      case GOT.SecretCoin:
      case GOT.UserCoin:
      case GOT.Collectible:
        return { id, kind: "collectible", hitbox: gh ?? box(g.w || BLOCK, g.h || BLOCK), collectible: g.t === GOT.UserCoin ? "userCoin" : g.t === GOT.SecretCoin ? "secretCoin" : "item", source: "derived" };
      case GOT.CollisionObject:
        return { id, kind: "collision", hitbox: gh ?? box(BLOCK, BLOCK), ...src };
      default:
        if (PAD_TYPES.has(g.t)) return { id, kind: "pad", hitbox: gh ?? box(25, 4), pad: "yellow", source: "derived" };
        if (RING_TYPES.has(g.t)) return { id, kind: "orb", hitbox: gh ?? box(ORB_SIZE, ORB_SIZE), orb: "yellow", source: "derived" };
        if (PORTAL_TYPES.has(g.t)) return null; // unknown portal id: let the manual/bootstrap path handle it
        return null;
    }
  }
  // Default Solid: the game set the type elsewhere. The hitbox table knows the outcome for ids ≤ 1911.
  if (gh) {
    if (gh.type === "slope") return { id, kind: "slope", hitbox: gh, ...src };
    if (gh.type === "circle") return { id, kind: "hazard", hitbox: gh, ...src };
    const hazard = manual?.kind === "hazard" || e?.type === "hazard";
    return { id, kind: hazard ? "hazard" : "solid", hitbox: gh, ...src };
  }
  if (known) {
    if (manual && manual.kind === "hazard") return manual;
    return { id, kind: "decoration", hitbox: null, ...src };
  }
  return null;
}

export function buildObjectTable(bootstrap: BootstrapJson): ObjectTable {
  const defs = new Map<number, ObjectDef>();
  const idSet = new Set<number>();
  for (const key of Object.keys(bootstrap)) {
    const id = Number(key);
    if (Number.isInteger(id)) idSet.add(id);
  }
  // Manual ids the bootstrap lacks (717, 718, 743 …) still need an entry.
  const manualOnly = [...PORTALS.keys(), ...ORBS.keys(), ...PADS.keys(), ...COLLECTIBLES.keys(), ...HAZARD_RECTS.keys(),
    ...HAZARD_CIRCLES.keys(), ...ANIMATED_HAZARDS.keys(), ...SPECIAL_BLOCKS.keys(), ...SOLID_IDS, ...SLOPE_45_IDS,
    ...SLOPE_22_IDS, ...FAKE_SPIKE_IDS, ...SOLID_DECO_IDS, ...COLLISION_IDS, ...FORCE_BLOCK_IDS,
    ...LEGACY_TRIGGER_IDS, CHECKPOINT_ID, START_POS_ID, TOGGLE_BLOCK_ID, BREAKABLE_ID];
  for (const id of manualOnly) idSet.add(id);

  for (const id of idSet) {
    const e = bootstrap[String(id)];
    const manual = manualDef(id, e);
    const core = gameDef(id, e, manual) ?? manual ?? (e ? bootstrapDef(id, e) : unknownDef(id));
    const def: ObjectDef = { ...core };
    if (e) {
      def.gridW = e.gridW;
      def.gridH = e.gridH;
    }
    defs.set(id, def);
  }

  const ids = [...defs.keys()].sort((a, b) => a - b);
  return {
    get: (id) => defs.get(id) ?? unknownDef(id),
    has: (id) => defs.has(id),
    ids: () => ids.slice(),
  };
}

/**
 * The same table, read straight from the shipped assets/objects.json instead of
 * derived. The browser uses this: the generator already ran every rule in this
 * file, so the page does not have to carry the hitbox and object-type tables to
 * repeat the work. Keep it in step with buildObjectTable — test/assets.test.ts
 * compares the two id by id.
 */
export function objectTableFromRecords(records: Record<string, ObjectRecordLike>): ObjectTable {
  const defs = new Map<number, ObjectDef>();
  for (const [key, rec] of Object.entries(records)) {
    const id = Number(key);
    if (!Number.isInteger(id)) continue;
    const def: ObjectDef = { id, kind: rec.k, hitbox: rec.hb, source: rec.src };
    if (rec.passable) def.passable = true;
    if (rec.breakable) def.breakable = true;
    if (rec.special) def.special = rec.special;
    if (rec.orb) def.orb = rec.orb;
    if (rec.pad) def.pad = rec.pad;
    if (rec.portal) def.portal = rec.portal;
    if (rec.collectible) def.collectible = rec.collectible;
    if (rec.forceShape) def.forceShape = rec.forceShape;
    if (rec.anim) def.animated = true;
    if (typeof rec.gw === "number") def.gridW = rec.gw;
    if (typeof rec.gh === "number") def.gridH = rec.gh;
    defs.set(id, def);
  }
  const ids = [...defs.keys()].sort((a, b) => a - b);
  return {
    get: (id) => defs.get(id) ?? unknownDef(id),
    has: (id) => defs.has(id),
    ids: () => ids.slice(),
  };
}

/** The physics half of an assets/objects.json record; see src/assets/objectTypes.ts. */
export interface ObjectRecordLike {
  k: ObjectKind;
  hb: Hitbox;
  passable?: 1;
  breakable?: 1;
  special?: ObjectDef["special"];
  orb?: ObjectDef["orb"];
  pad?: ObjectDef["pad"];
  portal?: ObjectDef["portal"];
  collectible?: ObjectDef["collectible"];
  forceShape?: ObjectDef["forceShape"];
  anim?: 1;
  gw?: number;
  gh?: number;
  src: ObjectDef["source"];
}

// ---------------------------------------------------------------------------
// The object's type and the angles it is loaded with
// ---------------------------------------------------------------------------

/**
 * m_objectType once the object is set up: GameObject::setupCustomSprites's
 * where it sets one (CUSTOM_SPRITES_OBJECT_TYPES, the last to run), else a
 * subclass's own (SUBCLASS_OBJECT_TYPES), else GameObject::customSetup's, else
 * EnhancedGameObject::customSetup's, else Solid (0), the constructor's default.
 * [GameObject::GameObject :165575 (+776 = 0); objectFromVector :184192-184201]
 */
export function gameObjectType(id: number): number {
  const c = CUSTOM_SPRITES_OBJECT_TYPES.get(id);
  if (c !== undefined) return c;
  const s = SUBCLASS_OBJECT_TYPES.get(id);
  if (s !== undefined) return s;
  const g = GAME_OBJECT_TYPES.get(id);
  if (g?.e) return g.t;
  return ENHANCED_OBJECT_TYPES.get(id) ?? GOT.Solid;
}

/**
 * Whether an object may stand at any angle: everything but a solid,
 * breakable or slope, which may only with key 121.
 * [GameObject::canRotateFree, gd-ida-decomp.cpp:168950-168959; key 121 is
 *  +1042, objectFromVector :184024-184027]
 */
export function canRotateFree(id: number, props: Record<number, string>): boolean {
  const t = gameObjectType(id);
  if (t === GOT.Solid || t === GOT.Breakable || t === GOT.Slope) return (parseInt(props[121] ?? "0", 10) || 0) !== 0;
  return true;
}

/** Key 6 as loaded: an object that may not rotate freely loses an angle off the quarter turns. */
function keptRotation(rotation: number, free: boolean): number {
  return !free && Math.trunc(rotation) % 90 !== 0 ? 0 : rotation;
}

/**
 * The key-6 rotation an object is loaded with: an object that may not rotate
 * freely loses an angle that is not a whole quarter turn (cut to an integer
 * first, so 90.5 stays). It is the object's own rotation, which its hitbox
 * turns by as well as its art. [GameObject::objectFromVector,
 * gd-ida-decomp.cpp:184221-184225, read by getObjectRect]
 */
export function loadRotation(o: LevelObject): number {
  return keptRotation(o.rotation, canRotateFree(o.id, o.props));
}

/**
 * The rotation X and Y an object is loaded with. Key 6 first, as loadRotation
 * has it. Then keys 131 and 132 replace both, if they differ and the object
 * may rotate freely: a warp, which skews the art unless the two are a whole
 * turn apart.
 * [GameObject::objectFromVector, gd-ida-decomp.cpp:184214-184237]
 */
export function loadAngles(o: LevelObject): { x: number; y: number } {
  const free = canRotateFree(o.id, o.props);
  const r = keptRotation(o.rotation, free);
  const wx = parseFloat(o.props[131] ?? "0") || 0;
  const wy = parseFloat(o.props[132] ?? "0") || 0;
  if (wx !== wy && free) return { x: wx, y: wy };
  return { x: r, y: r };
}
