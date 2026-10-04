// Minimal ObjectTable built straight from data/objects-bootstrap.json, for
// tests that must not depend on the full objects package. Mapping:
//   solid → solid, hazard → hazard, ring → orb, pad → pad, portal/speed →
//   portal, coin → collectible, with the json rect/circle as the hitbox and
//   gridW/gridH × 30 as the fallback; the 72 collidable slope ids
//   (research_level-format.md §5.1) → slope. Orb/pad/portal sub-types and
//   the letter blocks are the short id maps below.

import { readFileSync } from "node:fs";
import { PROJECT_ROOT } from "../tools/paths";
import type { GameMode, Speed } from "../src/level/types";
import type { Hitbox, ObjectDef, ObjectKind, ObjectTable, OrbType, PadType, PortalEffect } from "../src/physics/types";

interface BootstrapHitbox {
  shape: "rect" | "circle";
  w?: number;
  h?: number;
  r?: number;
  ox: number;
  oy: number;
}

interface BootstrapEntry {
  type: string;
  frame: string | null;
  gridW: number;
  gridH: number;
  hitbox: BootstrapHitbox | null;
}

export const BOOTSTRAP_PATH = `${PROJECT_ROOT}/data/objects-bootstrap.json`;

export const SLOPE_IDS_45 = [
  289, 294, 299, 305, 309, 315, 321, 326, 331, 337, 343, 349, 353, 363, 366, 371, 483, 492, 651, 665, 673, 709, 711, 726, 728, 886,
  1338, 1341, 1344, 1717, 1723, 1743, 1745, 1747, 1749, 1906,
];
export const SLOPE_IDS_22 = [
  291, 295, 301, 307, 311, 317, 323, 327, 333, 339, 345, 351, 355, 364, 367, 372, 484, 493, 652, 666, 674, 710, 712, 727, 729, 887,
  1339, 1342, 1345, 1718, 1724, 1744, 1746, 1748, 1750, 1907,
];

const MODE_PORTALS: Record<number, GameMode> = { 12: "cube", 13: "ship", 47: "ball", 111: "ufo", 660: "wave", 745: "robot", 1331: "spider", 1933: "swing" };
const SPEED_PORTALS: Record<number, Speed> = { 200: 0, 201: 1, 202: 2, 203: 3, 1334: 4 };
const ORBS: Record<number, OrbType> = {
  36: "yellow",
  141: "pink",
  1333: "red",
  84: "blue",
  1022: "green",
  1330: "black",
  3004: "spider",
  1704: "dash",
  1751: "dashGravity",
  1594: "toggle",
  3027: "teleport",
};
const PADS: Record<number, PadType> = { 35: "yellow", 140: "pink", 1332: "red", 67: "blue", 3005: "spider" };
const SPECIALS: Record<number, "D" | "J" | "S" | "H" | "F"> = { 1755: "D", 1813: "J", 1829: "S", 1859: "H", 2866: "F" };

function portalEffect(id: number): PortalEffect | null {
  const mode = MODE_PORTALS[id];
  if (mode) return { type: "mode", mode };
  const speed = SPEED_PORTALS[id];
  if (speed !== undefined) return { type: "speed", speed };
  switch (id) {
    case 10:
      return { type: "gravity", flipped: false };
    case 11:
      return { type: "gravity", flipped: true };
    case 2926:
      return { type: "gravityToggle" };
    case 45:
      return { type: "mirror", mirrored: true };
    case 46:
      return { type: "mirror", mirrored: false };
    case 101:
      return { type: "size", mini: true };
    case 99:
      return { type: "size", mini: false };
    case 286:
      return { type: "dual", dual: true };
    case 287:
      return { type: "dual", dual: false };
    case 747:
      return { type: "teleport", kind: "linkedEntry" };
    case 2902:
      return { type: "teleport", kind: "targetEntry" };
    case 2064:
      return { type: "teleport", kind: "targetExit" };
    default:
      return null;
  }
}

function hitboxOf(e: BootstrapEntry): Hitbox {
  const h = e.hitbox;
  if (h) {
    if (h.shape === "circle") return { type: "circle", r: h.r ?? 15, ox: h.ox, oy: h.oy };
    return { type: "box", w: h.w ?? 30, h: h.h ?? 30, ox: h.ox, oy: h.oy };
  }
  if (e.gridW > 0 && e.gridH > 0) return { type: "box", w: e.gridW * 30, h: e.gridH * 30, ox: 0, oy: 0 };
  return null;
}

export function buildStubObjectTable(path: string = BOOTSTRAP_PATH): ObjectTable {
  const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, BootstrapEntry>;
  const defs = new Map<number, ObjectDef>();
  const box30: Hitbox = { type: "box", w: 30, h: 30, ox: 0, oy: 0 };

  for (const key of Object.keys(json)) {
    const id = Number(key);
    const e = json[key];
    let kind: ObjectKind = "decoration";
    let hitbox: Hitbox = null;
    switch (e.type) {
      case "solid":
        kind = "solid";
        hitbox = hitboxOf(e) ?? box30;
        break;
      case "hazard":
        kind = "hazard";
        hitbox = hitboxOf(e);
        break;
      case "ring":
        kind = "orb";
        hitbox = hitboxOf(e);
        break;
      case "pad":
        kind = "pad";
        hitbox = hitboxOf(e);
        break;
      case "portal":
      case "speed":
        kind = "portal";
        hitbox = hitboxOf(e);
        break;
      case "coin":
        kind = "collectible";
        hitbox = hitboxOf(e);
        break;
      default:
        kind = "decoration";
    }
    const def: ObjectDef = { id, kind, hitbox, source: "table", gridW: e.gridW, gridH: e.gridH };
    if (kind === "orb") def.orb = ORBS[id] ?? "yellow";
    if (kind === "pad") def.pad = PADS[id] ?? "yellow";
    if (kind === "portal") {
      const eff = portalEffect(id);
      if (eff) def.portal = eff;
      else def.kind = "decoration";
    }
    if (kind === "collectible") def.collectible = id === 142 ? "secretCoin" : id === 1329 ? "userCoin" : "item";
    defs.set(id, def);
  }

  for (const id of SLOPE_IDS_45) defs.set(id, { id, kind: "slope", hitbox: { type: "slope", w: 30, h: 30 }, source: "manual" });
  for (const id of SLOPE_IDS_22) defs.set(id, { id, kind: "slope", hitbox: { type: "slope", w: 60, h: 30 }, source: "manual" });
  for (const [k, letter] of Object.entries(SPECIALS)) {
    defs.set(Number(k), { id: Number(k), kind: "solid", hitbox: box30, special: letter, source: "manual" });
  }
  defs.set(143, { id: 143, kind: "solid", hitbox: box30, breakable: true, source: "manual" });
  defs.set(2063, { id: 2063, kind: "checkpoint", hitbox: box30, source: "manual" });
  defs.set(3600, { id: 3600, kind: "trigger", hitbox: box30, source: "manual" });
  defs.set(1931, { id: 1931, kind: "trigger", hitbox: box30, source: "manual" });
  defs.set(31, { id: 31, kind: "startPos", hitbox: null, source: "manual" });
  // Its box's centre is 12 along its own x. [gdp GameObject::customSetup :179044-179052]
  defs.set(2902, { id: 2902, kind: "portal", hitbox: { type: "box", w: 25, h: 90, ox: 12, oy: 0 }, portal: { type: "teleport", kind: "targetEntry" }, source: "manual" });
  defs.set(2064, { id: 2064, kind: "portal", hitbox: { type: "box", w: 38.5, h: 90, ox: 0, oy: 0 }, portal: { type: "teleport", kind: "targetExit" }, source: "manual" });

  const ids = [...defs.keys()].sort((a, b) => a - b);
  const unknown = (id: number): ObjectDef => ({ id, kind: "unknown", hitbox: null, source: "derived" });
  return {
    get: (id) => defs.get(id) ?? unknown(id),
    has: (id) => defs.has(id),
    ids: () => ids.slice(),
  };
}
