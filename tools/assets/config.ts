// Paths, options and budgets for the asset build. Everything is resolved from
// this file's own location, never from the working directory, because the build
// is run from npm scripts, from the project root and from the editor alike.

import { resolve } from "node:path";
import { GD_OUT, GD_RESOURCES, PROJECT_ROOT } from "../paths";

export { PROJECT_ROOT };
/** The real install. Read-only reference; nothing is ever written here. */
export const SRC_ROOT = GD_RESOURCES;
/** What gets served. `assets/` under it is this tool's output. */
export const OUT_ROOT = GD_OUT;
/** Generated data and reports that stay in the source tree. */
export const DATA_ROOT = resolve(PROJECT_ROOT, "data");

/** Sprite resolution suffixes and how many pixels one GD unit is at each. */
export const PX_PER_UNIT = { sd: 1, hd: 2, uhd: 4 } as const;
export type Res = keyof typeof PX_PER_UNIT;

/**
 * The eight sheets a level needs on screen. Everything else (shop, tower,
 * gauntlet, world, dungeon, treasure room, secret, launch, path, colour picker,
 * editor) belongs to menus and the editor, which do not exist yet.
 */
export const GAMEPLAY_SHEETS = [
  "GJ_GameSheet",
  "GJ_GameSheet02",
  "GJ_GameSheet03",
  "GJ_GameSheet04",
  "GJ_GameSheetGlow",
  "GJ_ParticleSheet",
  "FireSheet_01",
  "PixelSheet_01",
] as const;

/** Menu and editor sheets, shipped only with --meta-sheets. */
export const META_SHEETS = [
  "GJ_ShopSheet",
  "GJ_ShopSheet01",
  "GJ_ShopSheet02",
  "GJ_ShopSheet03",
  "SecretSheet",
  "TowerSheet",
  "GauntletSheet",
  "WorldSheet",
  "DungeonSheet",
  "TreasureRoomSheet",
  "GJ_LaunchSheet",
  "GJ_PathSheet",
  "CCControlColourPickerSpriteSheet",
  "GJ_GameSheetEditor",
] as const;

/** The 19 death-explosion sheets. */
export const EXPLOSION_SHEETS = Array.from({ length: 19 }, (_, i) => `PlayerExplosion_${String(i + 1).padStart(2, "0")}`);

/** Icon kinds, longest prefix first so player_ball_ never loses to player_. */
export const ICON_KINDS = [
  { kind: "ball", prefix: "player_ball_" },
  { kind: "cube", prefix: "player_" },
  { kind: "ship", prefix: "ship_" },
  { kind: "ufo", prefix: "bird_" },
  { kind: "wave", prefix: "dart_" },
  { kind: "robot", prefix: "robot_" },
  { kind: "spider", prefix: "spider_" },
  { kind: "swing", prefix: "swing_" },
  { kind: "jetpack", prefix: "jetpack_" },
] as const;
export type IconKind = (typeof ICON_KINDS)[number]["kind"];

/** Fonts the interface itself is built from. */
export const CORE_FONTS = ["bigFont", "goldFont", "chatFont"] as const;

/**
 * The gjFont families the official levels actually ask for, on top of the core
 * three. Measured across all 27: 23 levels set header font 0 (bigFont) and the
 * four Tower floors set 19, which is also where 104 of the 140 text objects
 * live. Shipping all 59 instead would be 20 MiB of art nothing reads, so the
 * default is this list and --fonts=all stays for custom levels.
 */
export const LEVEL_FONTS = [19] as const;

/** Size gates, measured against the catalog's 250 MB "this is a big one" prompt. */
export const BUDGET = {
  warnBytes: 200 * 1024 * 1024,
  failBytes: 220 * 1024 * 1024,
  catalogPromptBytes: 250 * 1024 * 1024,
};

/** Icon atlas pages. */
export const ICON_PAGE = { width: 2048, maxHeight: 2048, padding: 2 };

export interface BuildOptions {
  only: string[] | null;
  skip: string[];
  /** Atlas resolutions to emit, in preference order. */
  res: Res[];
  iconRes: Res;
  fonts: "core" | "levels" | "all";
  explosions: Res | "none";
  metaSheets: boolean;
  audio: boolean;
  transcode: boolean;
  dryRun: boolean;
  verify: boolean;
  force: boolean;
  clean: boolean;
  out: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

export const DEFAULT_OPTIONS: BuildOptions = {
  only: null,
  skip: [],
  res: ["uhd", "hd", "sd"],
  iconRes: "uhd",
  fonts: "levels",
  explosions: "hd",
  metaSheets: false,
  audio: true,
  transcode: false,
  dryRun: false,
  verify: false,
  force: false,
  clean: false,
  out: OUT_ROOT,
  json: false,
  quiet: false,
  verbose: false,
};

/** Which sheets a given option set ships, at which resolutions. */
export function sheetPlan(opts: BuildOptions): { name: string; res: Res[] }[] {
  const out: { name: string; res: Res[] }[] = [];
  for (const name of GAMEPLAY_SHEETS) out.push({ name, res: [...opts.res] });
  if (opts.explosions !== "none") for (const name of EXPLOSION_SHEETS) out.push({ name, res: [opts.explosions] });
  if (opts.metaSheets) for (const name of META_SHEETS) out.push({ name, res: [opts.res[0]] });
  return out;
}
