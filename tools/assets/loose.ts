// The sprites that never made it into a sheet: player trails, ship fire, the
// gravity line and the few primitives the particle effects draw with.
//
// Every one of these exists only at sd in the install, so one pixel is one GD
// unit here where a sheet frame is four. The file records that, because
// drawing a trail at the sheet scale would make it four times too wide.

import { join } from "node:path";
import type { LooseFile, SceneryImage } from "../../src/assets/miscTypes";
import { copyIfChanged, fileSize, listFiles, pngSize, writeJson } from "./fsx";
import type { StepContext, StepModule, StepResult } from "./step";

/**
 * Numbered runs: prefix, how many there are, and the suffix each one carries.
 * The trails are numbered in the middle (streak_04_001.png) and the ship fire
 * at the end (shipfire05_016.png), which is why the two shapes are separate.
 */
const SEQUENCES: { prefix: string; count: number; suffix: string }[] = [
  { prefix: "streak_", count: 7, suffix: "_001" },
  { prefix: "shipfire02_", count: 9, suffix: "" },
  { prefix: "shipfire03_", count: 10, suffix: "" },
  { prefix: "shipfire04_", count: 6, suffix: "" },
  { prefix: "shipfire05_", count: 16, suffix: "" },
  { prefix: "shipfire06_", count: 5, suffix: "" },
];

const SINGLES = ["streakb_01_001.png", "streakDWhite.png", "gravityLine_001.png", "square.png", "circle.png", "sun.png", "pixel.png"];

function wanted(): string[] {
  const out = [...SINGLES];
  for (const seq of SEQUENCES) {
    const width = seq.suffix === "" ? 3 : 2;
    for (let i = 1; i <= seq.count; i++) out.push(`${seq.prefix}${String(i).padStart(width, "0")}${seq.suffix}.png`);
  }
  return out.sort();
}

export const looseStep: StepModule = {
  name: "loose",

  inputs(ctx: StepContext): string[] {
    const present = new Set(listFiles(ctx.src, (n) => n.endsWith(".png")));
    return wanted()
      .filter((n) => present.has(n))
      .map((n) => join(ctx.src, n));
  },

  run(ctx: StepContext): StepResult {
    const present = new Set(listFiles(ctx.src, (n) => n.endsWith(".png")));
    const images: Record<string, SceneryImage> = {};
    const outputs: string[] = [];
    const absent: string[] = [];
    let bytes = 0;
    let written = 0;

    for (const name of wanted()) {
      if (!present.has(name)) {
        absent.push(name);
        continue;
      }
      const src = join(ctx.src, name);
      const rel = `loose/${name}`;
      const size = pngSize(src);
      if (!ctx.opts.verify) {
        const c = copyIfChanged(src, join(ctx.out, rel));
        bytes += c.bytes;
        if (c.copied) written++;
      } else {
        bytes += fileSize(join(ctx.out, rel));
      }
      outputs.push(rel);
      images[name.replace(/\.png$/, "")] = { image: rel, w: size.w, h: size.h };
    }

    // These are sd-only art; one pixel is one unit.
    const file: LooseFile = { version: 1, pxPerUnit: 1, images };
    if (ctx.opts.verify) {
      bytes += fileSize(join(ctx.out, "loose.json"));
    } else {
      const w = writeJson(join(ctx.out, "loose.json"), file, true);
      bytes += w.bytes;
      if (w.written) written++;
    }
    outputs.push("loose.json");
    if (absent.length > 0) ctx.log.note(`${absent.length} loose sprite(s) are not in this install: ${absent.slice(0, 4).join(", ")}`);

    return {
      files: written,
      bytes,
      skipped: outputs.length - written,
      summary: `${Object.keys(images).length} loose sprites`,
      outputs,
    };
  },
};
