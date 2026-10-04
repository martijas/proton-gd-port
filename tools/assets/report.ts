// The last step: writes assets/manifest.json, prints the validation block and
// the byte table, and fails the build when something does not add up.
//
// It reads the built folder rather than trusting what the earlier steps said
// they wrote, so the numbers describe what is actually on disk.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IconFile, IconKind } from "../../src/assets/iconTypes";
import type { Manifest } from "../../src/assets/manifestTypes";
import type { AnimIndex, FontFile, ParticleFile, SceneryFile } from "../../src/assets/miscTypes";
import type { ObjectsFile } from "../../src/assets/objectTypes";
import { BUDGET, SRC_ROOT } from "./config";
import { fileSize, walkFiles, writeJson } from "./fsx";
import { formatBytes, formatCount } from "./log";
import type { ObjectsReport } from "./objects";
import type { StepContext, StepModule, StepResult } from "./step";

/** Which top-level folder a shipped path belongs to, for the byte table. */
function categoryOf(path: string): string {
  const slash = path.indexOf("/");
  if (slash < 0) return path.endsWith(".json") ? "data" : "other";
  const head = path.slice(0, slash);
  return head === "atlas" || head === "icons" ? head : head;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function sortedNumbers(keys: Iterable<string>): number[] {
  return [...keys].map(Number).filter(Number.isInteger).sort((a, b) => a - b);
}

/**
 * Everything about a manifest except when it was made, as a string that does
 * not depend on key order. `manifest.json` lists its own size, which is only
 * known after it has been written, so that entry sits outside the comparison.
 */
function withoutTimestamp(m: Manifest): string {
  const { generated: _when, ...rest } = m;
  const files = { ...rest.files };
  delete files["manifest.json"];
  return JSON.stringify({ ...rest, files }, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
}

export const reportStep: StepModule = {
  name: "report",
  needs: ["sheets"],

  // Reads the built folder, not the install, so it has no source inputs — and
  // no stamp of the install can tell it that another step has just rewritten a
  // file it measures, which is why it never skips.
  always: true,

  inputs(): string[] {
    return [];
  },

  run(ctx: StepContext): StepResult {
    const files: Record<string, number> = {};
    const categories: Record<string, { files: number; bytes: number }> = {};
    let total = 0;
    for (const rel of walkFiles(ctx.out)) {
      if (rel === "manifest.json") continue;
      const bytes = fileSize(join(ctx.out, rel));
      files[rel] = bytes;
      total += bytes;
      const cat = (categories[categoryOf(rel)] ??= { files: 0, bytes: 0 });
      cat.files++;
      cat.bytes += bytes;
    }

    const objects = readJson<ObjectsFile>(join(ctx.out, "objects.json"));
    const objectsReport = readJson<ObjectsReport>(join(ctx.data, "objects-report.json"));
    const icons = readJson<IconFile>(join(ctx.out, "icons/icons.json"));
    const particles = readJson<ParticleFile>(join(ctx.out, "particles.json"));
    const anims = readJson<AnimIndex>(join(ctx.out, "anims/index.json"));
    const fonts = readJson<FontFile>(join(ctx.out, "fonts/fonts.json"));
    const scenery = readJson<SceneryFile>(join(ctx.out, "scenery.json"));

    const iconIds = {} as Record<IconKind, number[]>;
    for (const [kind, group] of Object.entries(icons?.kinds ?? {})) {
      iconIds[kind as IconKind] = group.icons.map((i) => i.id).sort((a, b) => a - b);
    }

    const audioNames = (folder: string): string[] =>
      Object.keys(files)
        .filter((f) => f.startsWith(`audio/${folder}/`))
        .map((f) => f.slice(`audio/${folder}/`.length))
        .sort();

    const manifest: Manifest = {
      version: 1,
      generated: new Date().toISOString(),
      generator: {
        tool: "tools/build-assets.ts",
        options: {
          res: ctx.opts.res,
          iconRes: ctx.opts.iconRes,
          fonts: ctx.opts.fonts,
          explosions: ctx.opts.explosions,
          metaSheets: ctx.opts.metaSheets,
          audio: ctx.opts.audio,
          transcode: ctx.opts.transcode,
        },
      },
      source: { root: SRC_ROOT, files: 0, bytes: 0 },
      res: { atlas: ctx.opts.res.slice(), icons: ctx.opts.iconRes, preferred: ctx.opts.res[0] },
      files,
      categories,
      totals: {
        files: Object.keys(files).length,
        bytes: total,
        warnBytes: BUDGET.warnBytes,
        failBytes: BUDGET.failBytes,
        headroomBytes: BUDGET.catalogPromptBytes - total,
      },
      have: {
        levels: Object.keys(files)
          .filter((f) => f.startsWith("levels/"))
          .map((f) => Number(f.slice("levels/".length).replace(/\.txt$/, "")))
          .filter(Number.isInteger)
          .sort((a, b) => a - b),
        backgrounds: sortedNumbers(Object.keys(scenery?.backgrounds ?? {})),
        grounds: sortedNumbers(Object.keys(scenery?.grounds ?? {})),
        foregrounds: sortedNumbers(Object.keys(scenery?.foregrounds ?? {})),
        fonts: Object.keys(fonts?.fonts ?? {}).sort(),
        icons: iconIds,
        particles: Object.keys(particles?.effects ?? {}).sort(),
        animEntities: Object.keys(anims?.entities ?? {}).sort(),
        audio: { music: audioNames("music"), sfx: audioNames("sfx"), songs: audioNames("songs") },
      },
      checks: {
        framesIndexed: ctx.frames?.size ?? 0,
        objects: Object.keys(objects?.objects ?? {}).length,
        censusIds: objects?.census.length ?? 0,
        missingFrames: objectsReport?.missing.census.length ?? 0,
        droppedGlow: objectsReport?.dropped.glow ?? 0,
      },
    };

    const manifestPath = join(ctx.out, "manifest.json");
    const onDisk = readJson<Manifest>(manifestPath);
    const matches = onDisk !== null && withoutTimestamp(onDisk) === withoutTimestamp(manifest);
    // Nothing moved, so keep the old date: a build with no work to do should
    // still write nothing at all.
    if (matches && onDisk) manifest.generated = onDisk.generated;
    let bytes = fileSize(manifestPath);
    let written = 0;
    if (!ctx.opts.verify) {
      const w = writeJson(manifestPath, manifest, true);
      bytes = w.bytes;
      written = w.written ? 1 : 0;
      manifest.files["manifest.json"] = w.bytes;
    }

    // --- the block a person reads ------------------------------------------
    ctx.log.blank();
    const censusResolved = (objects?.census.length ?? 0) - (objectsReport?.missing.census.length ?? 0);
    ctx.log.table([
      ["frames indexed", `${formatCount(manifest.checks.framesIndexed)}  (${ctx.frames?.res ?? "?"})`],
      ["objects merged", formatCount(manifest.checks.objects)],
      ["census ids", `${formatCount(manifest.checks.censusIds)}  main frame resolved ${formatCount(censusResolved)}`],
      ["glow frames dropped", `${formatCount(manifest.checks.droppedGlow)}  (names the old table invented)`],
      ["MISSING FRAMES", manifest.checks.missingFrames === 0 ? "0  ✓" : `${manifest.checks.missingFrames}  ✗`],
      ["icons", `${formatCount(Object.values(iconIds).reduce((n, l) => n + l.length, 0))} in ${icons?.pages.length ?? 0} pages`],
      ["levels / backgrounds / grounds", `${manifest.have.levels.length} / ${manifest.have.backgrounds.length} / ${manifest.have.grounds.length}`],
      ["particles / entities / fonts", `${manifest.have.particles.length} / ${manifest.have.animEntities.length} / ${manifest.have.fonts.length}`],
    ]);
    ctx.log.blank();
    const budget = total >= BUDGET.failBytes ? "over the ceiling ✗" : total >= BUDGET.warnBytes ? "over the warning line" : "✓";
    ctx.log.table([
      ["total", `${formatCount(manifest.totals.files)} files  ${formatBytes(total)}`],
      ["headroom", `${formatBytes(manifest.totals.headroomBytes)} before the catalog warns  ${budget}`],
    ]);

    if (ctx.opts.verify && !matches) {
      ctx.log.error("manifest.json does not describe what is in assets/ any more; run the build without --verify");
    }
    if (manifest.checks.missingFrames > 0) ctx.log.error(`${manifest.checks.missingFrames} object(s) the levels use have no art`);
    if (total >= BUDGET.failBytes) ctx.log.error(`assets/ is ${formatBytes(total)}, over the ${formatBytes(BUDGET.failBytes)} ceiling`);
    else if (total >= BUDGET.warnBytes) ctx.log.warn(`assets/ is ${formatBytes(total)}, past the ${formatBytes(BUDGET.warnBytes)} warning line`);

    if (!ctx.opts.verify) writeJson(join(ctx.data, "assets-report.json"), manifest, true);

    return { files: written, bytes, skipped: 0, summary: `${formatCount(manifest.totals.files)} files  ${formatBytes(total)}`, outputs: ["manifest.json"] };
  },
};
