// Sprite sheets: the cocos plists become assets/atlas/<res>.json and the pngs
// are copied through untouched.
//
// The pngs are not repacked or re-encoded. Copying keeps them byte-identical to
// the game's own art, keeps the build to a few hundred milliseconds, and keeps
// the packer's rotated frames rotated, which costs the runtime one branch and
// saves a re-encode of 70 MiB.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Atlas, AtlasFile, AtlasFrame } from "../../src/assets/atlasTypes";
import { PX_PER_UNIT, sheetPlan, type Res } from "./config";
import { copyIfChanged, fileSize, pngSize, writeJson } from "./fsx";
import { dict, point, readPlist, rect, size, str } from "./plist";
import type { FrameIndex, StepContext, StepModule, StepResult } from "./step";

function sheetFiles(src: string, name: string, res: Res): { plist: string; png: string } {
  const suffix = res === "sd" ? "" : `-${res}`;
  return { plist: join(src, `${name}${suffix}.plist`), png: join(src, `${name}${suffix}.png`) };
}

/**
 * cocos writes a frame's position as an offset of the trimmed region's centre
 * from the untrimmed centre, y up. The runtime wants the region's top-left
 * corner inside the untrimmed box, y down, which is what every sprite batcher
 * and every packer format uses.
 */
function trimOffset(sw: number, sh: number, w: number, h: number, offX: number, offY: number): { tx: number; ty: number } {
  return { tx: (sw - w) / 2 + offX, ty: (sh - h) / 2 - offY };
}

function readSheet(plistFile: string, pngFile: string, name: string, imagePath: string): Atlas {
  const root = dict(readPlist(plistFile), name);
  const framesDict = dict(root.frames, `${name}.frames`);
  const png = pngSize(pngFile);
  const frames: AtlasFrame[] = [];
  for (const key of Object.keys(framesDict)) {
    const where = `${name}.${key}`;
    const f = dict(framesDict[key], where);
    const r = rect(str(f.textureRect, `${where}.textureRect`), where);
    const src = size(str(f.spriteSourceSize, `${where}.spriteSourceSize`), where);
    const off = point(str(f.spriteOffset, `${where}.spriteOffset`), where);
    const rotated = f.textureRotated === true;
    // The rect's w/h are the upright size; a rotated region is stored h across
    // by w down. Reading it the other way puts 16 GJ_GameSheet frames outside
    // the png, so this assertion is the one that proves the convention.
    const packedW = rotated ? r.h : r.w;
    const packedH = rotated ? r.w : r.h;
    if (r.x < 0 || r.y < 0 || r.x + packedW > png.w || r.y + packedH > png.h) {
      throw new Error(`${where}: frame ${r.x},${r.y} ${packedW}×${packedH} falls outside ${png.w}×${png.h}`);
    }
    const { tx, ty } = trimOffset(src.w, src.h, r.w, r.h, off.x, off.y);
    // Round-trip back to the cocos form; a sign slip here would be invisible
    // until the renderer drew everything half a sprite out of place.
    const backX = tx - (src.w - r.w) / 2;
    const backY = (src.h - r.h) / 2 - ty;
    if (Math.abs(backX - off.x) > 1e-6 || Math.abs(backY - off.y) > 1e-6) {
      throw new Error(`${where}: trim offset does not round-trip (${backX},${backY} vs ${off.x},${off.y})`);
    }
    const frame: AtlasFrame = { n: key, x: r.x, y: r.y, w: r.w, h: r.h };
    if (rotated) frame.r = 1;
    if (tx !== 0) frame.tx = tx;
    if (ty !== 0) frame.ty = ty;
    if (src.w !== r.w) frame.sw = src.w;
    if (src.h !== r.h) frame.sh = src.h;
    frames.push(frame);
  }
  frames.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  return { name, image: imagePath, w: png.w, h: png.h, frames };
}

/** Frame index straight from a built atlas file, for runs that skip the step. */
function indexFromBuilt(ctx: StepContext): FrameIndex | null {
  const res = ctx.opts.res[0];
  const path = join(ctx.out, `atlas/${res}.json`);
  if (fileSize(path) === 0) return null;
  const file = JSON.parse(readFileSync(path, "utf8")) as AtlasFile;
  const sheetOf = new Map<string, string>();
  for (const [name, at] of Object.entries(file.frames)) {
    const atlas = file.atlases[at[0]];
    if (atlas) sheetOf.set(name, atlas.name);
  }
  return { res, sheetOf, has: (n) => sheetOf.has(n), size: sheetOf.size };
}

export const sheetsStep: StepModule = {
  name: "sheets",
  optionKeys: ["res", "explosions", "metaSheets"],

  prepare(ctx: StepContext): void {
    ctx.frames = indexFromBuilt(ctx);
    if (!ctx.frames) ctx.log.warn("no built atlas to read frame names from; run with --force");
  },

  inputs(ctx: StepContext): string[] {
    const out: string[] = [];
    for (const s of sheetPlan(ctx.opts)) {
      for (const res of s.res) {
        const f = sheetFiles(ctx.src, s.name, res);
        out.push(f.plist, f.png);
      }
    }
    return out;
  },

  run(ctx: StepContext): StepResult {
    const plan = sheetPlan(ctx.opts);
    const byRes = new Map<Res, Atlas[]>();
    const outputs: string[] = [];
    let copied = 0;
    let bytes = 0;
    let frameCount = 0;
    let rotatedCount = 0;

    for (const s of plan) {
      for (const res of s.res) {
        const file = sheetFiles(ctx.src, s.name, res);
        const imageRel = `atlas/${res}/${s.name}.png`;
        const atlas = readSheet(file.plist, file.png, s.name, imageRel);
        const list = byRes.get(res) ?? [];
        list.push(atlas);
        byRes.set(res, list);
        frameCount += atlas.frames.length;
        rotatedCount += atlas.frames.filter((f) => f.r === 1).length;
        if (!ctx.opts.verify) {
          const c = copyIfChanged(file.png, join(ctx.out, imageRel));
          if (c.copied) copied++;
          bytes += c.bytes;
        } else {
          bytes += fileSize(join(ctx.out, imageRel));
        }
        outputs.push(imageRel);
      }
    }

    let primary: FrameIndex | null = null;
    for (const [res, atlases] of byRes) {
      atlases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const index: Record<string, [number, number]> = {};
      const sheetOf = new Map<string, string>();
      atlases.forEach((atlas, ai) => {
        atlas.frames.forEach((frame, fi) => {
          const seen = sheetOf.get(frame.n);
          if (seen) throw new Error(`frame "${frame.n}" appears in both ${seen} and ${atlas.name} at ${res}`);
          sheetOf.set(frame.n, atlas.name);
          index[frame.n] = [ai, fi];
        });
      });
      const file: AtlasFile = { version: 1, res, pxPerUnit: PX_PER_UNIT[res], atlases, frames: index };
      const rel = `atlas/${res}.json`;
      if (ctx.opts.verify) {
        bytes += fileSize(join(ctx.out, rel));
      } else {
        const w = writeJson(join(ctx.out, rel), file);
        bytes += w.bytes;
        if (w.written) copied++;
      }
      outputs.push(rel);
      if (res === ctx.opts.res[0]) {
        primary = { res, sheetOf, has: (n) => sheetOf.has(n), size: sheetOf.size };
      }
    }
    ctx.frames = primary;
    if (!primary) ctx.log.warn(`no atlas was built at ${ctx.opts.res[0]}; later steps cannot validate frame names`);

    const resList = [...byRes.keys()].join("+");
    return {
      files: copied,
      bytes,
      skipped: outputs.length - copied,
      summary: `${plan.length} sheets  ${frameCount} frames (${rotatedCount} rotated)  ${resList}`,
      outputs,
    };
  },
};
