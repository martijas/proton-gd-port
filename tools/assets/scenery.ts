// Backgrounds, grounds and foregrounds: copied at the sheet resolution and
// renamed, since "game_bg_07_001-uhd.png" is a mouthful for what is background
// number seven.
//
// Grounds 8 and up have a second layer that the game draws over the first; the
// three foregrounds all have one.

import { join } from "node:path";
import type { SceneryFile, SceneryImage } from "../../src/assets/miscTypes";
import { PX_PER_UNIT, type Res } from "./config";
import { copyIfChanged, fileSize, pngSize, writeJson } from "./fsx";
import type { StepContext, StepModule, StepResult } from "./step";

const BACKGROUNDS = 59;
const GROUNDS = 22;
/** Grounds from here up have a detail layer. */
const GROUND_DETAIL_FROM = 8;
const FOREGROUNDS = 3;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function sourceName(kind: "bg" | "ground" | "fg", id: number, detail: boolean, res: Res): string {
  const suffix = res === "sd" ? "" : `-${res}`;
  if (kind === "bg") return `game_bg_${pad(id)}_001${suffix}.png`;
  if (kind === "ground") return `groundSquare_${pad(id)}${detail ? "_2" : ""}_001${suffix}.png`;
  return `fg_${pad(id)}${detail ? "_2" : ""}_001${suffix}.png`;
}

function outName(kind: "bg" | "ground" | "fg", id: number, detail: boolean): string {
  const base = kind === "bg" ? "bg" : kind;
  return `scenery/${base}_${pad(id)}${detail ? "_2" : ""}.png`;
}

interface Planned {
  kind: "bg" | "ground" | "fg";
  id: number;
  detail: boolean;
}

function plan(): Planned[] {
  const out: Planned[] = [];
  for (let i = 1; i <= BACKGROUNDS; i++) out.push({ kind: "bg", id: i, detail: false });
  for (let i = 1; i <= GROUNDS; i++) {
    out.push({ kind: "ground", id: i, detail: false });
    if (i >= GROUND_DETAIL_FROM) out.push({ kind: "ground", id: i, detail: true });
  }
  for (let i = 1; i <= FOREGROUNDS; i++) {
    out.push({ kind: "fg", id: i, detail: false });
    out.push({ kind: "fg", id: i, detail: true });
  }
  return out;
}

export const sceneryStep: StepModule = {
  name: "scenery",
  optionKeys: ["res"],

  inputs(ctx: StepContext): string[] {
    const res = ctx.opts.res[0];
    return plan().map((p) => join(ctx.src, sourceName(p.kind, p.id, p.detail, res)));
  },

  run(ctx: StepContext): StepResult {
    const res = ctx.opts.res[0];
    const file: SceneryFile = { version: 1, pxPerUnit: PX_PER_UNIT[res], backgrounds: {}, grounds: {}, foregrounds: {} };
    const outputs: string[] = [];
    let bytes = 0;
    let written = 0;
    let missing = 0;

    for (const p of plan()) {
      const src = join(ctx.src, sourceName(p.kind, p.id, p.detail, res));
      const rel = outName(p.kind, p.id, p.detail);
      let image: SceneryImage;
      try {
        const size = pngSize(src);
        image = { image: rel, w: size.w, h: size.h };
      } catch {
        missing++;
        continue;
      }
      if (!ctx.opts.verify) {
        const c = copyIfChanged(src, join(ctx.out, rel));
        bytes += c.bytes;
        if (c.copied) written++;
      } else {
        bytes += fileSize(join(ctx.out, rel));
      }
      outputs.push(rel);
      if (p.kind === "bg") file.backgrounds[p.id] = image;
      else {
        const table = p.kind === "ground" ? file.grounds : file.foregrounds;
        const entry = table[p.id] ?? { base: image };
        if (p.detail) entry.detail = image;
        else entry.base = image;
        table[p.id] = entry;
      }
    }

    if (ctx.opts.verify) {
      bytes += fileSize(join(ctx.out, "scenery.json"));
    } else {
      const w = writeJson(join(ctx.out, "scenery.json"), file, true);
      bytes += w.bytes;
      if (w.written) written++;
    }
    outputs.push("scenery.json");
    if (missing > 0) ctx.log.warn(`${missing} scenery image(s) are not in the install at ${res}`);

    return {
      files: written,
      bytes,
      skipped: outputs.length - written,
      summary: `${Object.keys(file.backgrounds).length} backgrounds  ${Object.keys(file.grounds).length} grounds  ${Object.keys(file.foregrounds).length} foregrounds`,
      outputs,
    };
  },
};
