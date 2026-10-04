// Bitmap fonts: the AngelCode .fnt files are parsed here rather than shipped,
// so the page does not need a second parser at runtime.
//
// The three the interface is built from, plus whichever gjFont families the
// official levels actually name. bigFont is the face called "Pusab", which is
// what a text object asks for unless the level says otherwise; goldFont and
// chatFont cover the rest of the interface. All 59 gjFonts come in at hd behind
// --fonts=all, for custom levels; at uhd they are 20 MiB of art nothing reads.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Font, FontChar, FontFile } from "../../src/assets/miscTypes";
import { CORE_FONTS, LEVEL_FONTS, PX_PER_UNIT, type Res } from "./config";
import { copyIfChanged, fileSize, writeJson } from "./fsx";
import type { StepContext, StepModule, StepResult } from "./step";

function fontList(ctx: StepContext): { name: string; res: Res }[] {
  const out: { name: string; res: Res }[] = CORE_FONTS.map((name) => ({ name, res: ctx.opts.res[0] }));
  const gj = (i: number): void => {
    out.push({ name: `gjFont${String(i).padStart(2, "0")}`, res: "hd" });
  };
  if (ctx.opts.fonts === "all") for (let i = 1; i <= 59; i++) gj(i);
  else if (ctx.opts.fonts === "levels") for (const i of LEVEL_FONTS) gj(i);
  return out;
}

function fntPath(src: string, name: string, res: Res): string {
  return join(src, `${name}${res === "sd" ? "" : `-${res}`}.fnt`);
}

/** Reads one "key=value" pair per token, tolerating quoted values with spaces. */
function tokens(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=("[^"]*"|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

function parseFnt(text: string, image: string): Font {
  const font: Font = { face: "", size: 0, lineHeight: 0, base: 0, scaleW: 0, scaleH: 0, image, chars: {} };
  const kernings: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const kind = line.slice(0, line.indexOf(" ") < 0 ? line.length : line.indexOf(" "));
    const t = tokens(line);
    if (kind === "info") {
      font.face = t.face ?? "";
      font.size = Math.abs(Number(t.size ?? 0));
    } else if (kind === "common") {
      font.lineHeight = Number(t.lineHeight ?? 0);
      font.base = Number(t.base ?? 0);
      font.scaleW = Number(t.scaleW ?? 0);
      font.scaleH = Number(t.scaleH ?? 0);
    } else if (kind === "char") {
      const char: FontChar = {
        x: Number(t.x ?? 0),
        y: Number(t.y ?? 0),
        w: Number(t.width ?? 0),
        h: Number(t.height ?? 0),
        xo: Number(t.xoffset ?? 0),
        yo: Number(t.yoffset ?? 0),
        xa: Number(t.xadvance ?? 0),
      };
      font.chars[Number(t.id ?? 0)] = char;
    } else if (kind === "kerning") {
      kernings[`${Number(t.first ?? 0)},${Number(t.second ?? 0)}`] = Number(t.amount ?? 0);
    }
  }
  if (Object.keys(kernings).length > 0) font.kernings = kernings;
  return font;
}

export const fontsStep: StepModule = {
  name: "fonts",
  optionKeys: ["fonts", "res"],

  inputs(ctx: StepContext): string[] {
    const out: string[] = [];
    for (const f of fontList(ctx)) {
      out.push(fntPath(ctx.src, f.name, f.res));
      out.push(join(ctx.src, `${f.name}${f.res === "sd" ? "" : `-${f.res}`}.png`));
    }
    return out;
  },

  run(ctx: StepContext): StepResult {
    const fonts: Record<string, Font> = {};
    const outputs: string[] = [];
    let bytes = 0;
    let written = 0;

    for (const entry of fontList(ctx)) {
      const suffix = entry.res === "sd" ? "" : `-${entry.res}`;
      const fnt = fntPath(ctx.src, entry.name, entry.res);
      const png = join(ctx.src, `${entry.name}${suffix}.png`);
      const rel = `fonts/${entry.name}.png`;
      let text: string;
      try {
        text = readFileSync(fnt, "utf8");
      } catch {
        ctx.log.warn(`font ${entry.name} is not in the install at ${entry.res}`);
        continue;
      }
      fonts[entry.name] = parseFnt(text, rel);
      if (!ctx.opts.verify) {
        const c = copyIfChanged(png, join(ctx.out, rel));
        bytes += c.bytes;
        if (c.copied) written++;
      } else {
        bytes += fileSize(join(ctx.out, rel));
      }
      outputs.push(rel);
    }

    const file: FontFile = { version: 1, pxPerUnit: PX_PER_UNIT[ctx.opts.res[0]], fonts };
    if (ctx.opts.verify) {
      bytes += fileSize(join(ctx.out, "fonts/fonts.json"));
    } else {
      const w = writeJson(join(ctx.out, "fonts/fonts.json"), file);
      bytes += w.bytes;
      if (w.written) written++;
    }
    outputs.push("fonts/fonts.json");

    const glyphs = Object.values(fonts).reduce((n, f) => n + Object.keys(f.chars).length, 0);
    return {
      files: written,
      bytes,
      skipped: outputs.length - written,
      summary: `${Object.keys(fonts).length} fonts  ${glyphs} glyphs`,
      outputs,
    };
  },
};
