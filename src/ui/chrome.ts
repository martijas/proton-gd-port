// The pieces every one of the game's menus is built from.
//
// A sprite that is a button, the corner art, the gradient wash, the back
// arrow, the page dots: each is a few widgets in a fixed arrangement, and
// spelling them out in every screen is how two screens end up with two
// different back buttons. The positions are the game's own where it has one,
// and say so.

import type { Tint, UiQuad } from "./draw";
import { FRAMES, type FontName } from "./art";
import type { TextAlign, TextOptions } from "./text";
import { rect, type Rect, type UiViewport } from "./viewport";
import type { Widget } from "./widgets";

/** What a screen needs from the art: a sprite's size, and a text's. */
export interface ArtLookup {
  quad(name: string): UiQuad | null;
  measure?(name: FontName, text: string, opts?: TextOptions): { width: number; height: number };
  fit?(name: FontName, text: string, maxWidth: number, max?: number): number;
}

/** An art lookup that knows nothing, for a frame before the art has loaded. */
export const NO_ART: ArtLookup = { quad: () => null };

export interface LabelOptions {
  font?: FontName;
  scale?: number;
  maxWidth?: number;
  tint?: Tint;
  alpha?: number;
  /** Where on the text `x` is: 0 its left edge, 0.5 its middle, 1 its right. */
  anchorX?: number;
  /** Where on the text `y` is: 0 its bottom, 0.5 its middle, 1 its top. */
  anchorY?: number;
  /** How the lines of a multi-line text line up with each other. */
  align?: TextAlign;
}

/**
 * Text placed by an anchor the way the game places a label, rather than by
 * its bottom-left corner. The game's labels are centred on their point unless
 * told otherwise, and every position in the decompile is that point.
 */
export function label(art: ArtLookup, text: string, x: number, y: number, opts: LabelOptions = {}): Widget {
  const font = opts.font ?? "bigFont";
  const scale = opts.scale ?? 1;
  const size = art.measure?.(font, text, { scale, maxWidth: opts.maxWidth }) ?? { width: 0, height: 32 * scale };
  const ax = opts.anchorX ?? 0.5;
  const ay = opts.anchorY ?? 0.5;
  // The renderer anchors an aligned block itself: `x` is its middle when
  // centred and its right edge when right-aligned.
  const shift = opts.align === "center" ? 0.5 : opts.align === "right" ? 1 : 0;
  return {
    kind: "text",
    x: x - size.width * ax + size.width * shift,
    y: y - size.height * ay,
    text,
    font,
    scale,
    maxWidth: opts.maxWidth,
    align: opts.align,
    tint: opts.tint,
    alpha: opts.alpha,
  };
}

/** Draws nothing; the sprite beside it is the button. */
export const TRANSPARENT: Tint = { r: 255, g: 255, b: 255, a: 0 };

export interface SpriteButtonOptions {
  scale?: number;
  /** How much bigger than the art the press area is. The game's default is 1. */
  sizeMult?: number;
  flipX?: boolean;
  alpha?: number;
  tint?: Tint;
  enabled?: boolean;
  originX?: number;
  originY?: number;
}

/**
 * A sprite with an invisible press rectangle over it, sized from the art.
 * The sprite names the button so it swells while the button is held.
 */
export function spriteButton(art: ArtLookup, id: string, x: number, y: number, frame: string, opts: SpriteButtonOptions = {}): Widget[] {
  const q = art.quad(frame);
  const scale = opts.scale ?? 1;
  const w = (q?.w ?? 30) * scale * (opts.sizeMult ?? 1);
  const h = (q?.h ?? 30) * scale * (opts.sizeMult ?? 1);
  const ox = opts.originX ?? 0.5;
  const oy = opts.originY ?? 0.5;
  const hit: Rect = rect(x - w * ox, y - h * oy, w, h);
  return [
    { kind: "sprite", x, y, frame, scale, flipX: opts.flipX, alpha: opts.alpha, tint: opts.tint, originX: opts.originX, originY: opts.originY, pressedBy: id },
    { kind: "button", id, rect: hit, label: { text: "", scale: 0 }, tint: TRANSPARENT, enabled: opts.enabled },
  ];
}

/** The natural size of a frame in units, for laying things out beside it. */
export function sizeOf(art: ArtLookup, frame: string, scale = 1): { w: number; h: number } {
  const q = art.quad(frame);
  return { w: (q?.w ?? 0) * scale, h: (q?.h ?? 0) * scale };
}

/**
 * The gradient wash behind a menu, tinted. The game draws it a little larger
 * than the screen so no edge ever shows.
 * [gdp CreatorLayer::init, gd-ida-decomp.cpp:239425-239433: scaled to the
 *  window plus 10 and placed at (-5, -5)]
 */
export function gradient(view: UiViewport, tint: Tint): Widget {
  return { kind: "fill", rect: rect(-5, -5, view.width + 10, view.height + 10), frame: FRAMES.gradient, tint };
}

export type Corner = "bottomLeft" | "bottomRight" | "topLeft" | "topRight";

/**
 * The stair-step blocks in the corners, one unit past each edge so their own
 * edge never shows. The art is drawn for the bottom-left and flipped for the
 * others.
 * [gdp LevelSelectLayer::init :339280-339305, GJGarageLayer::init :336166-336204]
 */
export function corners(view: UiViewport, which: readonly Corner[]): Widget[] {
  const out: Widget[] = [];
  for (const c of which) {
    const right = c === "bottomRight" || c === "topRight";
    const top = c === "topLeft" || c === "topRight";
    out.push({
      kind: "sprite",
      x: right ? view.width + 1 : -1,
      y: top ? view.height + 1 : -1,
      frame: FRAMES.sideArt,
      originX: right ? 1 : 0,
      originY: top ? 1 : 0,
      flipX: right,
      flipY: top,
    });
  }
  return out;
}

/**
 * The arrow in the top-left corner that goes back. Green on the level
 * select, pink everywhere else, and a hair apart in position because the game
 * places them separately.
 * [gdp LevelSelectLayer::init :339431 (left + 25, top - 22);
 *  GJGarageLayer::init :336423 and CreatorLayer::init (left + 24, top - 23)]
 */
export function backArrow(art: ArtLookup, view: UiViewport, colour: "green" | "pink" = "pink"): Widget[] {
  const green = colour === "green";
  return spriteButton(art, "back", green ? 25 : 24, view.height - (green ? 22 : 23), green ? FRAMES.arrowGreen : FRAMES.arrowPink, { sizeMult: 1.6 });
}

/** The row of dots under a set of pages, the current one lit. */
export function pageDots(x: number, y: number, count: number, current: number, pitch = 12, scale = 0.6): Widget[] {
  const out: Widget[] = [];
  const left = x - ((count - 1) * pitch) / 2;
  for (let i = 0; i < count; i++) {
    out.push({ kind: "sprite", x: left + i * pitch, y, frame: i === current ? FRAMES.dotOn : FRAMES.dotOff, scale });
  }
  return out;
}

/**
 * The level select's page dots: one plain dot tinted white for the page
 * showing and grey for the rest, 16 apart. The game's dot is built into the
 * app, so the round particle stands in for it.
 * [gdp BoomScrollLayer::updateDots :27858-27911]
 */
export function scrollDots(art: ArtLookup, x: number, y: number, count: number, current: number): Widget[] {
  const size = art.quad(FRAMES.circle)?.w ?? 8;
  const scale = SCROLL_DOT.size / size;
  const left = x - ((count - 1) * SCROLL_DOT.pitch) / 2;
  const out: Widget[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ kind: "sprite", x: left + i * SCROLL_DOT.pitch, y, frame: FRAMES.circle, scale, tint: i === current ? { r: 255, g: 255, b: 255 } : SCROLL_DOT.off });
  }
  return out;
}

const SCROLL_DOT = { pitch: 16, size: 9, off: { r: 125, g: 125, b: 125 } };

/** A darkening over whatever is underneath, for a popup. */
export function shade(view: UiViewport, alpha: number): Widget {
  return { kind: "fill", rect: rect(0, 0, view.width, view.height), tint: { r: 0, g: 0, b: 0 }, alpha };
}

/**
 * The game's popup: a window frame with its close button hanging off the
 * top-left corner.
 */
export function popup(art: ArtLookup, box: Rect, frame: string = FRAMES.panel): Widget[] {
  return [
    { kind: "panel", rect: box, frame },
    ...spriteButton(art, "close", box.x + 2, box.y + box.h - 2, FRAMES.close, { scale: 0.8, sizeMult: 1.4 }),
  ];
}

/** The inside of the green table a drop-down list hangs in. [gdp GJDropDownLayer::init: GJListLayer 356 x 220] */
export const TABLE = { w: 356, h: 220 };

/** Where the table's inside sits on a screen of this size. */
export function tableRect(view: UiViewport): Rect {
  return rect(view.width / 2 - TABLE.w / 2, view.height / 2 - TABLE.h / 2 - 5, TABLE.w, TABLE.h);
}

/**
 * The game's drop-down list: a shade over the menu, the green table hung from
 * two chains with its title on the top bar, and the pink back arrow.
 * [gdp GJDropDownLayer::init :359849, GJListLayer::init :340867]
 */
export function dropDown(art: ArtLookup, view: UiViewport, title: string): Widget[] {
  const list = tableRect(view);
  const cx = list.x + list.w / 2;
  const top = list.y + list.h;
  const sideH = sizeOf(art, FRAMES.tableSide).h || 64;
  const barY = top - 5 + 20;
  const out: Widget[] = [shade(view, 125 / 255)];
  for (const side of [-1, 1]) {
    out.push({ kind: "sprite", x: cx + side * 156, y: top + 12, frame: FRAMES.chain, originX: 0.5, originY: 0, flipX: side > 0 });
  }
  out.push(
    { kind: "fill", rect: list, tint: { r: 0, g: 0, b: 0 }, alpha: 180 / 255 },
    { kind: "sprite", x: list.x - 20, y: list.y, frame: FRAMES.tableSide, originX: 0, originY: 0, scaleY: list.h / sideH },
    { kind: "sprite", x: list.x + list.w + 20, y: list.y, frame: FRAMES.tableSide, originX: 1, originY: 0, flipX: true, scaleY: list.h / sideH },
    { kind: "sprite", x: cx, y: list.y - 10, frame: FRAMES.tableBottom },
    { kind: "sprite", x: cx, y: barY, frame: FRAMES.tableTop },
    label(art, title, cx, barY + 3, { scale: art.fit?.("bigFont", title, 280, 0.8) ?? 0.8 }),
  );
  // Further into the corner than the other menus' back arrows. [meas off the reference]
  out.push(...spriteButton(art, "back", 16, view.height - 20.5, FRAMES.arrowPink, { sizeMult: 1.6 }));
  return out;
}

/** A drop-down list's brown rows, darker and lighter by turns. [meas off the reference] */
export function listRowTint(index: number): Tint {
  return index % 2 === 0 ? { r: 161, g: 88, b: 44 } : { r: 194, g: 114, b: 62 };
}

/**
 * Draws the table's top and bottom bars again, for a list whose rows run
 * under them as the game's do.
 */
export function tableBars(art: ArtLookup, view: UiViewport, title: string): Widget[] {
  const list = tableRect(view);
  const cx = list.x + list.w / 2;
  const barY = list.y + list.h - 5 + 20;
  return [
    { kind: "sprite", x: cx, y: list.y - 10, frame: FRAMES.tableBottom },
    { kind: "sprite", x: cx, y: barY, frame: FRAMES.tableTop },
    label(art, title, cx, barY + 3, { scale: art.fit?.("bigFont", title, 280, 0.8) ?? 0.8 }),
  ];
}

/** Opens one of the game's own links the way the game does: in the browser. */
export function openLink(url: string): void {
  try {
    window.open(url, "_blank", "noopener");
  } catch {
    // A host that forbids it forbids it; nothing to do.
  }
}

/** Formats seconds the way the end screen does: mm:ss, or h:mm:ss past an hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${two(h)}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}
