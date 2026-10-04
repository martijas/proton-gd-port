// Shared plumbing for the node test suites and the bot CLI: official level
// loading, the object table from the bootstrap JSON, and the one place that
// knows how to construct a Sim.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { officialCapacity } from "../src/assets/levels";
import { loadLevel } from "../src/level/decode";
import type { Level } from "../src/level/types";
import type { ObjectDef, ObjectTable, Sim, SimOptions } from "../src/physics/types";
import { createSim } from "../src/physics/index";
import { buildObjectTable } from "../src/physics/objects";
import { LEVELS_DIR, outPath } from "../tools/paths";
import type { Macro } from "./bot";

/** The real install is the reference; levels are read straight out of it. */
export { LEVELS_DIR, outPath };

/** 1–22 main levels, 3001 The Challenge, 5001–5004 The Tower (platformer). */
export const OFFICIAL_LEVEL_IDS: readonly number[] = [
  ...Array.from({ length: 22 }, (_, i) => i + 1),
  3001,
  5001,
  5002,
  5003,
  5004,
];

/** Names as the game's exe spells them (achievement strings for the Tower floors). */
const LEVEL_NAMES: Record<number, string> = {
  1: "Stereo Madness",
  2: "Back On Track",
  3: "Polargeist",
  4: "Dry Out",
  5: "Base After Base",
  6: "Cant Let Go",
  7: "Jumper",
  8: "Time Machine",
  9: "Cycles",
  10: "xStep",
  11: "Clutterfunk",
  12: "Theory of Everything",
  13: "Electroman Adventures",
  14: "Clubstep",
  15: "Electrodynamix",
  16: "Hexagon Force",
  17: "Blast Processing",
  18: "Theory of Everything 2",
  19: "Geometrical Dominator",
  20: "Deadlocked",
  21: "Fingerdash",
  22: "Dash",
  3001: "The Challenge",
  5001: "The Tower",
  5002: "The Sewers",
  5003: "The Cellar",
  5004: "The Secret Hollow",
};

export function levelName(id: number): string {
  if (LEVEL_NAMES[id]) return LEVEL_NAMES[id];
  const info = onlineInfo(id);
  return info?.name ?? `Level ${id}`;
}

/** An online level saved by `test/fetch-online-level.ts`. */
function onlineInfo(id: number): { name: string; capacity: string } | null {
  const path = projectPath(`test/levels/${id}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { name: string; capacity: string }) : null;
}

/** An official level from the install, or an online one saved under test/levels. */
export async function loadBotLevel(id: number): Promise<Level> {
  if (OFFICIAL_LEVEL_IDS.includes(id)) return loadOfficialLevel(id);
  const info = onlineInfo(id);
  if (!info) throw new Error(`No level ${id}: fetch it with test/fetch-online-level.ts first`);
  const raw = readFileSync(projectPath(`test/levels/${id}.txt`), "latin1");
  return { ...(await loadLevel(raw)), capacity: info.capacity };
}

export function projectPath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

/** Level files are the raw url-safe-base64 string; latin1 keeps the stray trailing NUL bytes harmless. */
export async function loadOfficialLevel(id: number): Promise<Level> {
  const raw = readFileSync(`${LEVELS_DIR}/${id}.txt`, "latin1");
  return { ...(await loadLevel(raw)), officialId: id, capacity: officialCapacity(id) };
}

type BootstrapArg = Parameters<typeof buildObjectTable>[0];

let cachedTable: ObjectTable | null = null;

/** The 4082-entry bootstrap table from the old port, turned into the physics ObjectTable. Cached per process. */
export function loadObjectTable(): ObjectTable {
  if (cachedTable) return cachedTable;
  const raw = JSON.parse(readFileSync(projectPath("data/objects-bootstrap.json"), "utf8")) as BootstrapArg;
  cachedTable = applyKindOverrides(buildObjectTable(raw));
  return cachedTable;
}

/**
 * A/B seam for classifying objects with the official levels as the oracle:
 * GD_DECO_IDS=5,73 strips the hitbox from those ids, GD_SOLID_IDS=647 forces a
 * 30×30 (grid-sized) solid. Test-only; the shipped table ignores the env.
 */
function applyKindOverrides(table: ObjectTable): ObjectTable {
  const parse = (v: string | undefined) => (v ? v.split(",").map(Number).filter((n) => Number.isFinite(n)) : []);
  const deco = new Set(parse(process.env.GD_DECO_IDS));
  const solid = new Set(parse(process.env.GD_SOLID_IDS));
  if (deco.size === 0 && solid.size === 0) return table;
  const cache = new Map<number, ObjectDef>();
  const get = (id: number): ObjectDef => {
    const hit = cache.get(id);
    if (hit) return hit;
    const d = table.get(id);
    let out = d;
    if (deco.has(id)) out = { ...d, kind: "decoration", hitbox: null, source: "manual" };
    else if (solid.has(id)) {
      const w = (d.gridW && d.gridW > 0 ? d.gridW : 1) * 30;
      const h = (d.gridH && d.gridH > 0 ? d.gridH : 1) * 30;
      out = { ...d, kind: "solid", hitbox: { type: "box", w, h, ox: 0, oy: 0 }, source: "manual" };
    }
    cache.set(id, out);
    return out;
  };
  return { get, has: (id) => table.has(id), ids: () => table.ids() };
}

/**
 * Single seam between the tests/bot and the sim constructor.
 *
 * Visuals are off here on purpose: colours, pulses and the camera cannot change
 * what the player collides with, and the autoplayer takes thousands of
 * snapshots a second, so paying for a colour table it never looks at would slow
 * the search down for nothing. The seed is fixed so a macro replays the same
 * way every time — the game stores its own seed in a replay string for exactly
 * this reason.
 */
export const MACRO_SEED = 1;

export function makeSim(level: Level, table: ObjectTable = loadObjectTable(), opts?: SimOptions): Sim {
  return createSim(level, table, { visuals: false, seed: MACRO_SEED, ...opts });
}

/** Where `run-bot.ts --save` writes a level's macro and the regression suite reads it back. */
export function macroPath(levelId: number): string {
  return projectPath(`test/macros/${levelId}.json`);
}

export function readMacro(levelId: number): Macro | null {
  const path = macroPath(levelId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Macro;
}
