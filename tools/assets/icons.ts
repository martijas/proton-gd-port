// Icons: 1207 single-icon atlases from the install become a handful of pages
// per game mode.
//
// This is the only step that decodes an image, so it is the only one that needs
// node-canvas. That dependency resolves from the repository's own
// node_modules and is imported dynamically: without it the step reports itself
// as skipped instead of failing the whole build.
//
// Rotated source frames are turned upright while blitting. It costs nothing
// here and means the runtime's icon path has no rotation case at all.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AtlasFrame } from "../../src/assets/atlasTypes";
import type { IconDef, IconFile, IconKind, IconLayer, IconLayerRole, IconPage } from "../../src/assets/iconTypes";
import { ICON_KINDS, ICON_PAGE, PX_PER_UNIT } from "./config";
import { ensureDir, fileSize, writeIfChanged, writeJson } from "./fsx";
import { packGroups, type PackGroup, type PackItem } from "./pack";
import { dict, point, readPlist, rect, size, str } from "./plist";
import type { StepContext, StepModule, StepResult } from "./step";

interface SourceFrame {
  name: string;
  /** Rect in the icon's own png. */
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
  /** Trim, converted to the same top-left convention the sheets use. */
  tx: number;
  ty: number;
  sw: number;
  sh: number;
}

interface SourceIcon {
  name: string;
  kind: IconKind;
  id: number;
  png: string;
  frames: SourceFrame[];
}

/** Longest prefix first, so player_ball_ never loses to player_. */
function classify(name: string): { kind: IconKind; id: number } | null {
  for (const entry of ICON_KINDS) {
    if (!name.startsWith(entry.prefix)) continue;
    const rest = name.slice(entry.prefix.length);
    if (!/^\d+$/.test(rest)) return null;
    return { kind: entry.kind, id: Number(rest) };
  }
  return null;
}

/**
 * Splits a frame name into its role. The suffixes are exhaustive: 001 is the
 * shape, 2_001 the second colour, 3_001 the UFO dome, extra_001 the
 * fixed-colour detail, glow_001 the outline, and the robot and spider repeat
 * all of those per limb as 0N_….
 */
function layerOf(iconName: string, frame: string): { role: IconLayerRole; part?: number } | null {
  if (!frame.startsWith(`${iconName}_`)) return null;
  const rest = frame.slice(iconName.length + 1).replace(/\.png$/, "");
  const simple: Record<string, IconLayerRole> = {
    "001": "base",
    "2_001": "secondary",
    "3_001": "dome",
    extra_001: "extra",
    glow_001: "glow",
  };
  const direct = simple[rest];
  if (direct) return { role: direct };
  const limb = /^0(\d)_(.*)$/.exec(rest);
  if (limb) {
    const role = simple[limb[2]];
    if (role) return { role, part: Number(limb[1]) };
  }
  return null;
}

function readIcon(dir: string, file: string, res: string): SourceIcon | null {
  const base = file.slice(0, file.length - `-${res}.plist`.length);
  const what = classify(base);
  if (!what) return null;
  const root = dict(readPlist(join(dir, file)), base);
  const framesDict = dict(root.frames, `${base}.frames`);
  const frames: SourceFrame[] = [];
  for (const key of Object.keys(framesDict)) {
    const where = `${base}.${key}`;
    const f = dict(framesDict[key], where);
    const r = rect(str(f.textureRect, where), where);
    const src = size(str(f.spriteSourceSize, where), where);
    const off = point(str(f.spriteOffset, where), where);
    frames.push({
      name: key,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      rotated: f.textureRotated === true,
      tx: (src.w - r.w) / 2 + off.x,
      ty: (src.h - r.h) / 2 - off.y,
      sw: src.w,
      sh: src.h,
    });
  }
  frames.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { name: base, kind: what.kind, id: what.id, png: join(dir, `${base}-${res}.png`), frames };
}

export const iconsStep: StepModule = {
  name: "icons",
  optionKeys: ["iconRes"],

  inputs(ctx: StepContext): string[] {
    const dir = join(ctx.src, "icons");
    const res = ctx.opts.iconRes;
    const out: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(`-${res}.plist`) && !file.endsWith(`-${res}.png`)) continue;
      out.push(join(dir, file));
    }
    out.sort();
    return out;
  },

  async run(ctx: StepContext): Promise<StepResult> {
    let canvasLib: typeof import("canvas") | null = null;
    try {
      canvasLib = await import("canvas");
    } catch {
      canvasLib = null;
    }
    if (!canvasLib) {
      ctx.log.warn("node-canvas is not installed, so the icon pages were not built (every other step is unaffected)");
      return { files: 0, bytes: 0, skipped: 1, summary: "skipped: node-canvas missing", outputs: [] };
    }

    const res = ctx.opts.iconRes;
    const dir = join(ctx.src, "icons");
    const icons: SourceIcon[] = [];
    const skipped: string[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(`-${res}.plist`)) continue;
      const icon = readIcon(dir, file, res);
      if (icon) icons.push(icon);
      else skipped.push(file);
    }
    if (skipped.length > 0) ctx.log.warn(`${skipped.length} icon file(s) did not match any game mode: ${skipped.slice(0, 5).join(", ")}`);

    // Two frames in spider_69 are packer duplicates of its 02 and 03 limbs;
    // nothing references them.
    const dropped: string[] = [];
    for (const icon of icons) {
      icon.frames = icon.frames.filter((f) => {
        if (layerOf(icon.name, f.name)) return true;
        dropped.push(f.name);
        return false;
      });
    }
    if (dropped.length > 0) ctx.log.note(`ignored ${dropped.length} unused icon frame(s): ${dropped.slice(0, 4).join(", ")}`);

    const pagesOut: IconPage[] = [];
    const kinds = {} as IconFile["kinds"];
    const index: Record<string, [number, number]> = {};
    const outputs: string[] = [];
    let bytes = 0;
    let written = 0;
    let pageBase = 0;

    for (const entry of ICON_KINDS) {
      const kindIcons = icons.filter((i) => i.kind === entry.kind).sort((a, b) => a.id - b.id);
      const groups: PackGroup[] = kindIcons.map((icon) => ({
        id: icon.name,
        items: icon.frames.map<PackItem>((f) => ({ key: `${icon.name}|${f.name}`, w: f.w, h: f.h })),
      }));
      const packed = packGroups(groups, {
        width: ICON_PAGE.width,
        maxHeight: ICON_PAGE.maxHeight,
        padding: ICON_PAGE.padding,
        powerOfTwoHeight: true,
      });
      if (packed.oversized.length > 0) ctx.log.error(`icons too large for a page: ${packed.oversized.join(", ")}`);

      const byKey = new Map(packed.placements.map((p) => [p.key, p]));
      const canvases = packed.pages.map((p) => canvasLib.createCanvas(p.w, p.h));

      const defs: IconDef[] = [];
      for (const icon of kindIcons) {
        const image = await canvasLib.loadImage(icon.png);
        let page = -1;
        const layers: IconLayer[] = [];
        for (const f of icon.frames) {
          const spot = byKey.get(`${icon.name}|${f.name}`);
          if (!spot) continue;
          page = spot.page;
          const target = canvases[spot.page].getContext("2d");
          if (f.rotated) {
            // Stored turned 90° clockwise; turn it back while copying. The
            // rotation sends a local (u, v) to (v, -u), so the copy grows
            // upwards from the origin and the origin has to be the BOTTOM left
            // of the slot. That is f.h, the upright height — using f.w put every
            // rotated layer (w - h) px out and spilled it into its neighbour.
            target.save();
            target.translate(spot.x, spot.y + f.h);
            target.rotate(-Math.PI / 2);
            target.drawImage(image, f.x, f.y, f.h, f.w, 0, 0, f.h, f.w);
            target.restore();
          } else {
            target.drawImage(image, f.x, f.y, f.w, f.h, spot.x, spot.y, f.w, f.h);
          }
          const frame: AtlasFrame = { n: f.name, x: spot.x, y: spot.y, w: f.w, h: f.h };
          if (f.tx !== 0) frame.tx = f.tx;
          if (f.ty !== 0) frame.ty = f.ty;
          if (f.sw !== f.w) frame.sw = f.sw;
          if (f.sh !== f.h) frame.sh = f.sh;
          const pageIndex = pageBase + spot.page;
          const list = (pagesOut[pageIndex] ??= { image: "", w: 0, h: 0, frames: [] }).frames;
          index[f.name] = [pageIndex, list.length];
          list.push(frame);
          const role = layerOf(icon.name, f.name);
          if (role) layers.push({ role: role.role, ...(role.part ? { part: role.part } : {}), n: f.name });
        }
        if (page >= 0) defs.push({ id: icon.id, name: icon.name, page: pageBase + page, layers });
      }

      packed.pages.forEach((p, i) => {
        const rel = `icons/pages/${entry.kind}-${i}.png`;
        const target = pagesOut[pageBase + i];
        target.image = rel;
        target.w = p.w;
        target.h = p.h;
        if (!ctx.opts.verify) {
          ensureDir(join(ctx.out, "icons/pages"));
          const w = writeIfChanged(join(ctx.out, rel), canvases[i].toBuffer("image/png"));
          bytes += w.bytes;
          if (w.written) written++;
        } else {
          bytes += fileSize(join(ctx.out, rel));
        }
        outputs.push(rel);
      });

      kinds[entry.kind] = { prefix: entry.prefix, count: defs.length, icons: defs };
      pageBase += packed.pages.length;
    }

    const file: IconFile = { version: 1, res, pxPerUnit: PX_PER_UNIT[res], pages: pagesOut, kinds, frames: index };
    if (ctx.opts.verify) {
      bytes += fileSize(join(ctx.out, "icons/icons.json"));
    } else {
      const w = writeJson(join(ctx.out, "icons/icons.json"), file);
      bytes += w.bytes;
      if (w.written) written++;
    }
    outputs.push("icons/icons.json");
    ctx.shared.set("icons", file);

    const total = Object.values(kinds).reduce((n, k) => n + k.count, 0);
    return {
      files: written,
      bytes,
      skipped: outputs.length - written,
      summary: `${total} icons  ${Object.keys(index).length} frames  ${pagesOut.length} pages (${res})`,
      outputs,
    };
  },
};
