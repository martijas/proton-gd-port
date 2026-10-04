// Where the game's files are read from and where the build goes.
//
//   prebuilt/assets/  the game's art, sound and levels, built from the install
//                     and committed, so the repo is enough to build and host it
//   GD_RESOURCES      the Geometry Dash install's Resources folder (read-only);
//                     only `npm run assets` reads it, to remake prebuilt/
//   GD_OUT            the folder that gets served: the page, its scripts, and a
//                     copy of prebuilt/assets
//
// GD_RESOURCES and GD_OUT come from the environment first, then from a `.env`
// file in the project root, then from the default here. Relative paths are
// taken from the project root. Every path is returned with forward slashes.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This project's own folder. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");

function readDotEnv(): Record<string, string> {
  const file = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

const fileEnv = readDotEnv();

function setting(name: string, fallback: string): string {
  const value = process.env[name] || fileEnv[name] || fallback;
  return (isAbsolute(value) ? value : resolve(PROJECT_ROOT, value)).replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The real install's Resources folder. Nothing is ever written here. */
export const GD_RESOURCES = setting("GD_RESOURCES", "resources");
/** The committed build of the game's files; `assets/` under it. */
export const PREBUILT = `${PROJECT_ROOT}/prebuilt`;
/** The official level files, as shipped. Byte-for-byte the install's. */
export const LEVELS_DIR = `${PREBUILT}/assets/levels`;
/** What gets served. */
export const GD_OUT = setting("GD_OUT", "dist");

/** A path inside prebuilt/, e.g. `assets/objects.json`. */
export function builtPath(relative: string): string {
  return `${PREBUILT}/${relative}`;
}
