// Rebuilds everything the port ships from the real Geometry Dash install.
//
//   npm run assets -- [flags]
//
// Source:  $GD_RESOURCES   (read-only; never written to),
//          and GeometryDash.exe beside it for the screen-effect shader
// Output:  prebuilt/assets/   (committed; the page build copies it into GD_OUT)
// Reports: data/{asset-build,objects-report,assets-report}.json
//
// Conventions the whole pipeline follows, so they only have to be learned once:
//   * Positions and sizes in the shipped JSON are GD units unless a field says
//     px. One block is 30 units. Object-space y points up; texture-space y
//     points down.
//   * uhd art is 4 px per unit, hd 2, sd 1. Every record that describes pixels
//     carries the pxPerUnit it was measured at, because the trail and ship-fire
//     art only exists at sd and would be four times too big otherwise.
//   * A rotated atlas frame is stored turned 90° clockwise: its region covers
//     h px across and w px down from (x, y).
//
// Deliberately not shipped, so nobody "fixes" it later: LevelStats.dat, the
// menu/shop/tower/editor sheets (--meta-sheets), GJ_GameSheetTemp-hd.png (it
// has no plist), GJ_GameSheetIcons (sd/hd only and superseded by the repacked
// icon pages), dialog portraits, menu chrome, gjFont01..59 (--fonts=all) and
// the sd/hd duplicates of everything except the gameplay sheets.

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_ROOT, DEFAULT_OPTIONS, OUT_ROOT, SRC_ROOT, type BuildOptions, type Res } from "./assets/config";
import { createLogger, formatBytes, formatCount, formatMs } from "./assets/log";
import { ensureDir, hashFiles, hashValue, removePath, walkFiles } from "./assets/fsx";
import { isStale, loadManifest, pruneAgainst, recordStep, saveManifest, stampInputs } from "./assets/manifest";
import { animsStep } from "./assets/anims";
import { audioStep } from "./assets/audio";
import { stringsStep } from "./assets/strings";
import { uiStep } from "./assets/ui";
import { fontsStep } from "./assets/fonts";
import { iconsStep } from "./assets/icons";
import { levelsStep } from "./assets/levels";
import { looseStep } from "./assets/loose";
import { particlesStep } from "./assets/particles";
import { reportStep } from "./assets/report";
import { sceneryStep } from "./assets/scenery";
import { shadersStep } from "./assets/shaders";
import { objectsStep } from "./assets/objects";
import { sheetsStep } from "./assets/sheets";
import type { StepContext, StepModule } from "./assets/step";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIRNAME = "assets";
/** Files whose contents invalidate every step when they change. */
const SHARED_SOURCES = ["assets/config.ts", "assets/fsx.ts", "assets/plist.ts", "assets/step.ts"].map((p) => join(HERE, p));

// ---------------------------------------------------------------------------
// steps

/** Run order. Categories land one at a time; each is a module under assets/. */
const STEPS: StepModule[] = [
  sheetsStep,
  objectsStep,
  iconsStep,
  particlesStep,
  animsStep,
  fontsStep,
  sceneryStep,
  looseStep,
  uiStep,
  levelsStep,
  stringsStep,
  shadersStep,
  audioStep,
  reportStep,
];

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv: string[]): BuildOptions {
  const o: BuildOptions = { ...DEFAULT_OPTIONS, res: [...DEFAULT_OPTIONS.res], skip: [] };
  for (const arg of argv) {
    const [rawKey, rawValue] = arg.startsWith("--") ? splitFlag(arg.slice(2)) : ["", ""];
    switch (rawKey) {
      case "only":
        o.only = list(rawValue);
        break;
      case "skip":
        o.skip = list(rawValue);
        break;
      case "res":
        o.res = list(rawValue).map(asRes);
        break;
      case "icon-res":
        o.iconRes = asRes(rawValue);
        break;
      case "fonts":
        if (rawValue !== "core" && rawValue !== "levels" && rawValue !== "all") {
          throw new Error("--fonts takes core, levels or all");
        }
        o.fonts = rawValue;
        break;
      case "explosions":
        o.explosions = rawValue === "none" ? "none" : asRes(rawValue);
        break;
      case "meta-sheets":
        o.metaSheets = true;
        break;
      case "audio":
        o.audio = true;
        break;
      case "no-audio":
        o.audio = false;
        break;
      case "transcode":
        o.transcode = true;
        break;
      case "dry-run":
        o.dryRun = true;
        break;
      case "verify":
        o.verify = true;
        break;
      case "force":
        o.force = true;
        break;
      case "clean":
        o.clean = true;
        break;
      case "out":
        o.out = resolve(rawValue);
        break;
      case "json":
        o.json = true;
        break;
      case "quiet":
        o.quiet = true;
        break;
      case "verbose":
      case "v":
        o.verbose = true;
        break;
      case "help":
      case "h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option ${arg}`);
    }
  }
  if (o.res.length === 0) throw new Error("--res needs at least one of uhd, hd, sd");
  return o;
}

function splitFlag(s: string): [string, string] {
  const eq = s.indexOf("=");
  return eq < 0 ? [s, ""] : [s.slice(0, eq), s.slice(eq + 1)];
}

function list(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function asRes(v: string): Res {
  if (v === "uhd" || v === "hd" || v === "sd") return v;
  throw new Error(`Expected uhd, hd or sd, got "${v}"`);
}

function printHelp(): void {
  console.log(`Rebuilds assets/ from the real Geometry Dash install.

  --only=a,b        run only these steps (their prerequisites come along)
  --skip=a,b        run everything except these
  --res=uhd,hd,sd   sprite-sheet resolutions to ship        (default uhd,hd,sd)
  --icon-res=uhd    icon page resolution                    (default uhd)
  --fonts=core|levels|all
                    core is the interface fonts; levels adds the ones the
                    official levels name; all adds gjFont01..59  (default levels)
  --explosions=hd   death explosion sheets, or none         (default hd)
  --meta-sheets     also ship the menu, shop and editor sheets
  --no-audio        leave out the music and sound effects (they ship by default)
  --transcode       write m4a beside each ogg (needs ffmpeg)
  --dry-run         print the plan, write nothing
  --verify          re-check what is already built, write nothing
  --force           rebuild even when nothing changed
  --clean           delete assets/ first
  --out=<dir>       write somewhere else than the catalog folder
  --json            machine-readable summary
  --quiet  --verbose  --help`);
}

// ---------------------------------------------------------------------------
// run

function selectedSteps(opts: BuildOptions): StepModule[] {
  const byName = new Map(STEPS.map((s) => [s.name, s]));
  let wanted: Set<string>;
  if (opts.only) {
    wanted = new Set<string>();
    const add = (name: string): void => {
      const step = byName.get(name);
      if (!step) throw new Error(`Unknown step "${name}". Known: ${STEPS.map((s) => s.name).join(", ")}`);
      if (wanted.has(name)) return;
      wanted.add(name);
      for (const need of step.needs ?? []) add(need);
    };
    for (const name of opts.only) add(name);
  } else {
    wanted = new Set(STEPS.map((s) => s.name));
  }
  for (const name of opts.skip) wanted.delete(name);
  return STEPS.filter((s) => wanted.has(s.name));
}

function sourceStats(paths: string[]): { files: number; bytes: number } {
  let bytes = 0;
  let files = 0;
  for (const p of paths) {
    try {
      bytes += statSync(p).size;
      files++;
    } catch {
      /* a missing input is reported by the step itself */
    }
  }
  return { files, bytes };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const log = createLogger(opts);

  if (!existsSync(SRC_ROOT)) {
    console.error(`The Geometry Dash install is not where the build expects it: ${SRC_ROOT}`);
    console.error("Point GD_RESOURCES (environment or .env) at the install's Resources folder.");
    return 2;
  }

  const assetsRoot = join(opts.out, ASSETS_DIRNAME);
  const manifestPath = join(DATA_ROOT, "asset-build.json");
  const previous = loadManifest(manifestPath);
  const manifest = opts.force || opts.clean ? { version: 1 as const, steps: {} } : structuredClone(previous);

  if (opts.clean && !opts.dryRun && !opts.verify) {
    removePath(assetsRoot);
    log.note(`cleaned ${assetsRoot}`);
  }
  if (!opts.dryRun && !opts.verify) ensureDir(assetsRoot);

  const ctx: StepContext = {
    src: SRC_ROOT,
    out: assetsRoot,
    data: DATA_ROOT,
    opts,
    manifest,
    log,
    frames: null,
    shared: new Map(),
  };

  const steps = selectedSteps(opts);
  log.blank();
  log.note(`source ${SRC_ROOT}`);
  log.note(`output ${assetsRoot}${opts.dryRun ? "  (dry run)" : opts.verify ? "  (verify)" : ""}`);
  log.blank();

  const started = Date.now();
  const rows: [string, string][] = [];
  let totalFiles = 0;
  let totalBytes = 0;

  if (steps.length === 0) {
    log.note("No steps are implemented yet. Categories land one at a time; see the plan.");
  }

  for (const step of steps) {
    const inputs = step.inputs(ctx);
    const stats = sourceStats(inputs);
    if (opts.dryRun) {
      rows.push([step.name, `${formatCount(stats.files)} source files  ${formatBytes(stats.bytes)}`]);
      continue;
    }
    const toolHash = hashFiles([
      join(HERE, "assets", `${step.name}.ts`),
      ...SHARED_SOURCES,
      ...(step.sources ?? []).map((p) => join(HERE, "..", p)),
    ]);
    const optsHash = hashValue(Object.fromEntries((step.optionKeys ?? []).map((k) => [k, opts[k]])));
    const stamped = stampInputs(inputs);
    const stale =
      opts.force || opts.verify || step.always
        ? { stale: true, reason: step.always ? "always runs" : "forced" }
        : isStale(previous, step.name, toolHash, optsHash, stamped, assetsRoot);
    if (!stale.stale) {
      const prev = previous.steps[step.name];
      await step.prepare?.(ctx);
      recordStep(manifest, step.name, { toolHash, optsHash, inputs: stamped, outputs: prev.outputs });
      const bytes = sourceStats(prev.outputs.map((rel) => join(assetsRoot, rel))).bytes;
      totalBytes += bytes;
      const done = log.step(step.name);
      done(`up to date  ${formatCount(prev.outputs.length)} files  ${formatBytes(bytes)}`);
      rows.push([step.name, `${formatCount(prev.outputs.length)} files  ${formatBytes(bytes)}  (unchanged)`]);
      continue;
    }
    const done = log.step(step.name);
    const result = await step.run(ctx);
    done(result.summary);
    if (!opts.verify) recordStep(manifest, step.name, { toolHash, optsHash, inputs: stamped, outputs: result.outputs });
    totalFiles += result.files;
    totalBytes += result.bytes;
    rows.push([step.name, `${formatCount(result.outputs.length)} files  ${formatBytes(result.bytes)}`]);
  }

  if (opts.dryRun) {
    log.blank();
    log.table(rows);
    const all = steps.flatMap((s) => s.inputs(ctx));
    const stats = sourceStats(all);
    log.blank();
    log.note(`would read ${formatCount(stats.files)} source files (${formatBytes(stats.bytes)})`);
    return 0;
  }

  if (!opts.verify) {
    const removed = pruneAgainst(assetsRoot, previous, manifest);
    if (removed.length > 0) log.note(`pruned ${removed.length} file(s) no longer produced`);
    saveManifest(manifestPath, manifest);
  }

  log.blank();
  log.table(rows);
  log.blank();
  const onDisk = existsSync(assetsRoot) ? sourceStats(walkFiles(assetsRoot).map((r) => join(assetsRoot, r))) : { files: 0, bytes: 0 };
  log.table([
    ["assets/", `${formatCount(onDisk.files)} files  ${formatBytes(onDisk.bytes)}`],
    ["written this run", `${formatCount(totalFiles)} files`],
    ["elapsed", formatMs(Date.now() - started)],
  ]);

  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: log.errors.length === 0,
        files: onDisk.files,
        bytes: onDisk.bytes,
        steps: Object.fromEntries(rows),
        warnings: log.warnings,
        errors: log.errors,
      }),
    );
  }
  if (log.errors.length > 0) {
    console.error(`\n${log.errors.length} error(s); assets are not complete.`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  },
);
