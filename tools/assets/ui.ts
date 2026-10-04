// The interface's own art: window frames, buttons, sliders, the progress bar,
// the logo, the menu backdrop and one font.
//
// Most of these are loose PNGs in the install rather than sheet frames, and
// there are a few dozen of them. Copied one by one they would want a texture
// unit each, and WebGL2 only guarantees sixteen — so they are packed onto one
// page with the same packer the icon pages use, and the interface costs one
// unit.
//
// Three other things ride on the page because a unit is the scarce thing:
//   - `GJ_logo_001`, which lives in GJ_LaunchSheet — a menu sheet the port does
//     not ship. It is cut out of that sheet here rather than shipping 4 MiB of
//     launch art for one picture.
//   - chatFont's glyph page. Three faces are on screen at once (bigFont for
//     headings, goldFont for stats and tips, chatFont for hints) and there are
//     two font units; the smallest face gives its unit up and is read off this
//     page instead.
//   - the menu backdrop is *not* packed: `game_bg_01_001` repeats across the
//     screen and a repeated tile needs a texture of its own. It is copied at hd
//     beside the page, with the ground tile it hangs from.
//
// Everything else a menu draws is already in the gameplay sheets: the 152
// `GJ_*Btn` frames, the difficulty faces, the coins, the locks and the stars
// are all on GJ_GameSheet03 and 04. That is why this is a short list and not
// `--meta-sheets`, which is the shop, tower and editor art and is still not
// shipped.

import { createCanvas, loadImage, type CanvasRenderingContext2D, type Image } from "canvas";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SceneryImage, UiArtFile } from "../../src/assets/miscTypes";
import { PX_PER_UNIT } from "./config";
import { ensureDir, fileSize, listFiles, pngSize, copyIfChanged, writeJson } from "./fsx";
import { packGroups, type PackPlacement } from "./pack";
import { dict, readPlist, rect, str } from "./plist";
import type { StepContext, StepModule, StepResult } from "./step";

/** Nine-slice window frames, the buttons, the sliders and the progress bar. */
const WANTED: readonly string[] = [
  "GJ_square01", "GJ_square02", "GJ_square03", "GJ_square04",
  "GJ_square05", "GJ_square06", "GJ_square07", "GJ_squareB_01",
  // The two plain rounded squares the level page and the pause menu tint:
  // one black, one white.
  "square02_001", "square04_001",
  // The tighter white squares the search page's panels are cut from.
  "square02b_001", "square02b_small",
  // The dark field the music-offset box on the Audio options page is.
  "square02_small",
  "GJ_button_01", "GJ_button_02", "GJ_button_03",
  "GJ_button_04", "GJ_button_05", "GJ_button_06",
  "sliderBar", "sliderBar2", "slidergroove", "slidergroove2", "slidergroove_02",
  "sliderthumb", "sliderthumbsel",
  "GJ_progressBar_001",
  // The vertical wash every menu but the main one sits on, tinted per screen.
  "GJ_gradientBG",
  // The primitives a flat fill and a divider are drawn with. They are also
  // copied loose for the particle system, which addresses them by name; here
  // they cost nothing and save the interface a whole texture unit for a white
  // pixel.
  "square", "pixel",
  // The soft dot the bubbles' built-in particle system is drawn with
  // (bubbleEffect.plist), beside the square the rest use.
  "circle",
  // The level's own loose art rides along: the player's trail and the ground
  // line are single PNGs in the install, and on this page they cost the
  // renderer nothing instead of a texture unit each out of a budget of
  // sixteen that is already full. The page is bound for the level as well as
  // for the menus, so one upload serves both.
  "streak_01_001", "streak_02_001", "streak_03_001", "streak_04_001",
  "streak_05_001", "streak_06_001", "streak_07_001",
  "streakb_01_001", "streakDWhite",
  "gravityLine_001",
];

/** Frames cut out of sheets the port does not ship, keyed by their frame name. */
const CUT: readonly { sheet: string; frame: string }[] = [
  { sheet: "GJ_LaunchSheet", frame: "GJ_logo_001.png" },
  // The Support page's "Powered by" mark.
  { sheet: "GJ_LaunchSheet", frame: "cocos2DxLogo.png" },
  // The Rewards page's two chests, ready to open.
  { sheet: "GJ_ShopSheet", frame: "chest_01_02_001.png" },
  { sheet: "GJ_ShopSheet", frame: "chest_02_02_001.png" },
];

/**
 * Font pages packed here rather than given a unit. The runtime reads the
 * face's `.fnt` metrics as usual and offsets each glyph by where the page
 * landed; the entry is keyed by the face name.
 */
export const PACKED_FONTS: readonly string[] = ["chatFont"];

/** The menu backdrop: a tile that repeats, so it keeps a texture of its own. */
const MENU = {
  background: { name: "game_bg_01_001", out: "ui/menu-bg.png" },
  ground: { name: "groundSquare_01_001", out: "ui/menu-ground.png" },
} as const;

/**
 * 2048 square: `GJ_progressBar_001-uhd` is 1360 px across on its own, the
 * eight window frames are 320 each, the logo is 1702 across and chatFont's
 * page is 512 square. About two million pixels, so one page this size holds
 * it with room to spare.
 */
const PAGE = 2048;
const PADDING = 2;

function fileFor(name: string, present: Set<string>): string | null {
  // uhd for everything that has it, so the interface matches the sheets'
  // 4 px per unit; a couple only exist at hd or sd.
  for (const suffix of ["-uhd.png", "-hd.png", ".png"]) {
    if (present.has(name + suffix)) return name + suffix;
  }
  return null;
}

/** How many texture pixels one unit is, for the resolution a file came at. */
function pxPerUnitOf(fileName: string): number {
  if (fileName.endsWith("-uhd.png")) return PX_PER_UNIT.uhd;
  if (fileName.endsWith("-hd.png")) return PX_PER_UNIT.hd;
  return PX_PER_UNIT.sd;
}

interface Piece {
  name: string;
  /** Where it came from, for the input list. */
  file: string;
  pxPerUnit: number;
  image: Image;
  /** For a frame cut from a sheet: the region to copy, and whether it is stored turned. */
  region?: { x: number; y: number; w: number; h: number; rotated: boolean };
}

/** The sheet a cut frame is read from, at the best resolution present. */
function sheetFor(src: string, sheet: string, present: Set<string>): { plist: string; png: string; pxPerUnit: number } | null {
  for (const suffix of ["-uhd", "-hd", ""]) {
    if (present.has(`${sheet}${suffix}.png`) && present.has(`${sheet}${suffix}.plist`)) {
      return { plist: join(src, `${sheet}${suffix}.plist`), png: join(src, `${sheet}${suffix}.png`), pxPerUnit: pxPerUnitOf(`${sheet}${suffix}.png`) };
    }
  }
  return null;
}

/** Copies one region of a sheet onto the page, turning a rotated frame upright. */
function drawRegion(g: CanvasRenderingContext2D, piece: Piece, x: number, y: number): void {
  const r = piece.region;
  if (!r) {
    g.drawImage(piece.image, x, y);
    return;
  }
  if (!r.rotated) {
    g.drawImage(piece.image, r.x, r.y, r.w, r.h, x, y, r.w, r.h);
    return;
  }
  // cocos stores a rotated frame turned 90° clockwise: h across by w down.
  // Turning it back anticlockwise about the destination's top-left corner
  // puts it upright at (x, y) with its own w across.
  g.save();
  g.translate(x, y + r.h);
  g.rotate(-Math.PI / 2);
  g.drawImage(piece.image, r.x, r.y, r.h, r.w, 0, 0, r.h, r.w);
  g.restore();
}

function uprightSize(piece: Piece): { w: number; h: number } {
  const r = piece.region;
  if (!r) return { w: piece.image.width, h: piece.image.height };
  return { w: r.w, h: r.h };
}

export const uiStep: StepModule = {
  name: "ui",

  inputs(ctx: StepContext): string[] {
    const present = new Set(listFiles(ctx.src, (n) => n.endsWith(".png") || n.endsWith(".plist")));
    const out = WANTED.map((n) => fileFor(n, present))
      .filter((n): n is string => n !== null)
      .map((n) => join(ctx.src, n));
    for (const cut of CUT) {
      const sheet = sheetFor(ctx.src, cut.sheet, present);
      if (sheet) out.push(sheet.plist, sheet.png);
    }
    for (const font of PACKED_FONTS) {
      const file = fileFor(font, present);
      if (file) out.push(join(ctx.src, file));
    }
    for (const image of Object.values(MENU)) {
      if (present.has(`${image.name}-hd.png`)) out.push(join(ctx.src, `${image.name}-hd.png`));
    }
    return out;
  },

  async run(ctx: StepContext): Promise<StepResult> {
    const present = new Set(listFiles(ctx.src, (n) => n.endsWith(".png") || n.endsWith(".plist")));
    const found: { name: string; file: string }[] = [];
    const absent: string[] = [];
    for (const name of [...WANTED, ...PACKED_FONTS]) {
      const file = fileFor(name, present);
      if (file) found.push({ name, file });
      else absent.push(name);
    }

    const outputs = ["ui/ui-0.png", "ui.json", MENU.background.out, MENU.ground.out];
    if (ctx.opts.verify) {
      const bytes = outputs.reduce((sum, rel) => sum + fileSize(join(ctx.out, rel)), 0);
      return { files: 0, bytes, skipped: outputs.length, summary: `${found.length + CUT.length} pieces`, outputs };
    }

    const pieces: Piece[] = await Promise.all(
      found.map(async (f) => ({ ...f, pxPerUnit: pxPerUnitOf(f.file), image: await loadImage(join(ctx.src, f.file)) })),
    );
    for (const cut of CUT) {
      const sheet = sheetFor(ctx.src, cut.sheet, present);
      if (!sheet) {
        absent.push(cut.frame);
        continue;
      }
      const frames = dict(dict(readPlist(sheet.plist), cut.sheet).frames, `${cut.sheet}.frames`);
      const frame = frames[cut.frame];
      if (!frame) {
        absent.push(cut.frame);
        continue;
      }
      const f = dict(frame, cut.frame);
      const r = rect(str(f.textureRect, `${cut.frame}.textureRect`), cut.frame);
      pieces.push({
        name: cut.frame,
        file: sheet.png,
        pxPerUnit: sheet.pxPerUnit,
        image: await loadImage(sheet.png),
        region: { x: r.x, y: r.y, w: r.w, h: r.h, rotated: f.textureRotated === true },
      });
    }

    const result = packGroups(
      pieces.map((p) => {
        const size = uprightSize(p);
        return { id: p.name, items: [{ key: p.name, w: size.w, h: size.h }] };
      }),
      { width: PAGE, maxHeight: PAGE, padding: PADDING, powerOfTwoHeight: true },
    );
    const placements: PackPlacement[] = result.placements;
    // One page is the whole point of packing these; more than one and the
    // interface is back to wanting a texture unit per sprite.
    if (result.pages.length > 1) throw new Error(`the interface art no longer fits on one ${PAGE}x${PAGE} page`);
    if (result.oversized.length > 0) throw new Error(`too big to pack: ${result.oversized.join(", ")}`);

    const pageHeight = result.pages[0]?.h ?? PAGE;
    const canvas = createCanvas(PAGE, pageHeight);
    const g = canvas.getContext("2d");
    const images: Record<string, SceneryImage & { x: number; y: number; pxPerUnit: number }> = {};
    for (const placement of placements) {
      const piece = pieces.find((p) => p.name === placement.key);
      if (!piece) continue;
      drawRegion(g, piece, placement.x, placement.y);
      const size = uprightSize(piece);
      images[placement.key] = {
        image: "ui/ui-0.png",
        x: placement.x,
        y: placement.y,
        w: size.w,
        h: size.h,
        pxPerUnit: piece.pxPerUnit,
      };
    }

    ensureDir(join(ctx.out, "ui"));
    const png = canvas.toBuffer("image/png");
    writeFileSync(join(ctx.out, "ui/ui-0.png"), png);

    // The backdrop, beside the page. hd rather than uhd: the menu tints it flat
    // and scrolls it slowly, and 4 MiB of texture is plenty for that.
    let menu: UiArtFile["menu"];
    let menuBytes = 0;
    let menuFiles = 0;
    const bg = `${MENU.background.name}-hd.png`;
    const ground = `${MENU.ground.name}-hd.png`;
    if (present.has(bg) && present.has(ground)) {
      const copy = (from: string, to: string): SceneryImage & { pxPerUnit: number } => {
        const done = copyIfChanged(join(ctx.src, from), join(ctx.out, to));
        menuBytes += done.bytes;
        if (done.copied) menuFiles++;
        const size = pngSize(join(ctx.out, to));
        return { image: to, w: size.w, h: size.h, pxPerUnit: PX_PER_UNIT.hd };
      };
      menu = { background: copy(bg, MENU.background.out), ground: copy(ground, MENU.ground.out) };
    } else {
      absent.push(MENU.background.name, MENU.ground.name);
    }

    const file: UiArtFile = { version: 1, page: "ui/ui-0.png", pageWidth: PAGE, pageHeight, images, packedFonts: PACKED_FONTS.filter((f) => f in images) };
    if (menu) file.menu = menu;
    const json = writeJson(join(ctx.out, "ui.json"), file, true);
    if (absent.length > 0) ctx.log.note(`${absent.length} interface piece(s) are not in this install: ${absent.join(", ")}`);

    return {
      files: 2 + menuFiles,
      bytes: png.length + json.bytes + menuBytes,
      skipped: 0,
      summary: `${pieces.length} pieces on one ${PAGE}x${pageHeight} page`,
      outputs,
    };
  },
};
