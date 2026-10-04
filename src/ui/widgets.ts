// What a screen says is on it.
//
// A screen returns a flat list of these every frame and keeps its own state in
// its own fields; nothing here is retained between frames. That is what makes
// hit-testing a pure function of the list and a point, testable without a
// browser, and it keeps the interface out of the garbage collector's way during
// gameplay.

import type { IconKind } from "../assets/iconTypes";
import type { Tint } from "./draw";
import type { TextAlign } from "./text";
import { contains, type Rect } from "./viewport";

export interface TextSpec {
  text: string;
  font?: "bigFont" | "goldFont" | "chatFont";
  scale?: number;
  align?: TextAlign;
  maxWidth?: number;
  tint?: Tint;
  alpha?: number;
}

export type Widget =
  /** A nine-slice window frame. */
  | { kind: "panel"; rect: Rect; frame?: string; tint?: Tint; alpha?: number }
  /** A frame stretched over a rectangle: the gradient wash, a flat fill, a divider. */
  | { kind: "fill"; rect: Rect; frame?: string; tint?: Tint; alpha?: number }
  /**
   * A sheet or interface frame, drawn at its own size times `scale`.
   * `pressedBy` names the button it is the face of, so it swells while that
   * button is held the way the game's do.
   */
  | {
      kind: "sprite";
      x: number;
      y: number;
      frame: string;
      scale?: number;
      /** Multiplies `scale` vertically only, for a piece stretched to a height. */
      scaleY?: number;
      rotation?: number;
      tint?: Tint;
      alpha?: number;
      flipX?: boolean;
      flipY?: boolean;
      originX?: number;
      originY?: number;
      pressedBy?: string;
    }
  | ({ kind: "text"; x: number; y: number } & TextSpec)
  /** Anything that can be pressed. `id` is what `onPress` receives. */
  | {
      kind: "button";
      id: string;
      rect: Rect;
      frame?: string;
      label?: TextSpec;
      /** Moves the label off the frame's centre, in units. */
      labelOffset?: { x: number; y: number };
      enabled?: boolean;
      scale?: number;
      tint?: Tint;
    }
  | { kind: "toggle"; id: string; rect: Rect; on: boolean; label?: TextSpec; enabled?: boolean }
  | { kind: "slider"; id: string; rect: Rect; value: number; enabled?: boolean; scale?: number }
  /**
   * A bar with a fill: the level page's and pause menu's bars are a bar frame
   * with a copy of itself cropped to `value` and tinted; the level's own bar is
   * a groove with a separate fill stretched inside it. `x`/`y` are the centre.
   */
  | {
      kind: "progress";
      x: number;
      y: number;
      frame: string;
      value: number;
      fill: Tint;
      scale?: number;
      /** A second frame stretched inside the bar, instead of cropping the bar itself. */
      fillFrame?: string;
      /** How far in the fill starts, in units of the unscaled frame. */
      fillInset?: { x: number; y: number };
      alpha?: number;
    }
  /**
   * The main menu's scrolling sky and ground. `offset` is how far the ground
   * has travelled; the sky follows at a tenth of it. `groundTop` is the line
   * the ground hangs from.
   */
  | { kind: "backdrop"; tint: Tint; groundTint: Tint; offset: number; groundTop: number; noSky?: boolean }
  /** A player icon, drawn from the icon pages with the player's colours. */
  | {
      kind: "icon";
      x: number;
      y: number;
      iconKind: IconKind;
      iconId: number;
      scale?: number;
      colour1: number;
      colour2: number;
      glow?: boolean;
      alpha?: number;
      /** Degrees, clockwise. */
      rotation?: number;
      /** Upside down, as a player under flipped gravity is drawn. */
      flipY?: boolean;
      /** The cube a ship or UFO carries, by its icon number. */
      rider?: number;
      /** Draws every layer in this one colour and leaves out the second colour, as a locked icon is shown. */
      darken?: Tint;
      /** A robot's or spider's clip and how far into it, instead of the resting pose. */
      clip?: string;
      clipSeconds?: number;
    }
  /** A scrolling strip of rows. Children are placed relative to the list. */
  | { kind: "list"; id: string; rect: Rect; rowSize: number; rows: Widget[][]; scroll: number; horizontal?: boolean };

/** Widgets a pointer can land on. */
function pressable(w: Widget): w is Extract<Widget, { id: string }> {
  return w.kind === "button" || w.kind === "toggle" || w.kind === "slider" || w.kind === "list";
}

function isEnabled(w: Widget): boolean {
  if (w.kind === "button" || w.kind === "toggle" || w.kind === "slider") return w.enabled !== false;
  return true;
}

export interface ListMetrics {
  /** Total length of every row along the scroll axis. */
  contentLength: number;
  /** The furthest the list may be scrolled; 0 when everything fits. */
  maxScroll: number;
  firstVisible: number;
  lastVisible: number;
}

/**
 * How far a list is actually scrolled, which is not always what it was asked
 * for. Clamping here rather than only where a drag is handled means the rows a
 * list shows and the places it puts them can never disagree — set `scroll` past
 * the end and the list used to pick rows by the clamped value and position them
 * by the raw one, which drew nothing at all.
 */
export function listScroll(list: Extract<Widget, { kind: "list" }>): number {
  const along = list.horizontal ? list.rect.w : list.rect.h;
  const maxScroll = Math.max(0, list.rows.length * list.rowSize - along);
  return Math.max(0, Math.min(maxScroll, list.scroll));
}

export function listMetrics(list: Extract<Widget, { kind: "list" }>): ListMetrics {
  const along = list.horizontal ? list.rect.w : list.rect.h;
  const contentLength = list.rows.length * list.rowSize;
  const maxScroll = Math.max(0, contentLength - along);
  const scroll = listScroll(list);
  const first = Math.max(0, Math.floor(scroll / list.rowSize));
  const last = Math.min(list.rows.length - 1, Math.ceil((scroll + along) / list.rowSize));
  return { contentLength, maxScroll, firstVisible: first, lastVisible: last };
}

/**
 * Where a row's own box sits, in screen units. Rows run left to right on a
 * horizontal list and top to bottom on a vertical one, which is the direction
 * the game's level pages and settings lists respectively go.
 */
export function rowRect(list: Extract<Widget, { kind: "list" }>, index: number): Rect {
  const offset = index * list.rowSize - listScroll(list);
  if (list.horizontal) {
    return { x: list.rect.x + offset, y: list.rect.y, w: list.rowSize, h: list.rect.h };
  }
  return { x: list.rect.x, y: list.rect.y + list.rect.h - offset - list.rowSize, w: list.rect.w, h: list.rowSize };
}

/** A widget moved by a row's offset, so a screen can describe a row at the origin. */
export function shifted(w: Widget, dx: number, dy: number): Widget {
  const move = (r: Rect): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
  switch (w.kind) {
    case "panel":
    case "fill":
      return { ...w, rect: move(w.rect) };
    case "button":
    case "toggle":
    case "slider":
      return { ...w, rect: move(w.rect) };
    case "list":
      return { ...w, rect: move(w.rect) };
    case "backdrop":
      return w;
    default:
      return { ...w, x: w.x + dx, y: w.y + dy };
  }
}

/**
 * Every widget, with list rows flattened into place and the off-screen ones
 * dropped. What a renderer walks, and what `hitTest` searches.
 */
export function flatten(widgets: readonly Widget[]): Widget[] {
  const out: Widget[] = [];
  for (const w of widgets) {
    out.push(w);
    if (w.kind !== "list") continue;
    const m = listMetrics(w);
    for (let i = m.firstVisible; i <= m.lastVisible; i++) {
      const box = rowRect(w, i);
      for (const child of w.rows[i] ?? []) out.push(shifted(child, box.x, box.y));
    }
  }
  return out;
}

/**
 * Which widget a point is on, or null. Walks back to front, because that is the
 * order they were drawn in and the top one should win — a button on a panel is
 * listed after the panel, so it is found first here.
 */
export function hitTest(widgets: readonly Widget[], x: number, y: number): Extract<Widget, { id: string }> | null {
  const flat = flatten(widgets);
  for (let i = flat.length - 1; i >= 0; i--) {
    const w = flat[i];
    if (!pressable(w) || !isEnabled(w)) continue;
    if (!contains(w.rect, x, y)) continue;
    // A list is only hit where none of its own rows were, so a row's button
    // wins over dragging the list. The rows come after it in `flat`, so they
    // have already been tried.
    return w;
  }
  return null;
}

/**
 * The list a point is inside, if any.
 *
 * Needed because `hitTest` deliberately returns a row's own button rather than
 * the list holding it — a tap on a row should press the row. But a *drag* that
 * starts on a row should scroll the list, and without this it went to the button
 * instead and nothing moved at all.
 */
export function listAt(widgets: readonly Widget[], x: number, y: number): Extract<Widget, { kind: "list" }> | null {
  for (let i = widgets.length - 1; i >= 0; i--) {
    const w = widgets[i];
    if (w.kind === "list" && contains(w.rect, x, y)) return w;
  }
  return null;
}

/** Where along a slider a point falls, 0 at its left edge and 1 at its right. */
export function sliderValueAt(slider: Extract<Widget, { kind: "slider" }>, x: number): number {
  const w = slider.rect.w;
  if (w <= 0) return 0;
  return Math.max(0, Math.min(1, (x - slider.rect.x) / w));
}

/**
 * The game's own progress-bar arithmetic: the fill is the bar's own picture
 * cropped to the fraction, starting a hair in from the left edge so the bar's
 * border stays visible round it.
 * [gdp LevelPage::init, gd-ida-decomp.cpp:338838-338850: the copy is placed at
 *  (w - w * 0.992) / 2 and cropped to w * percent / 100]
 */
export const BAR_FILL_INSET = (1 - 0.992) / 2;

/**
 * The fraction of a bar its fill covers, and where it starts, both as
 * fractions of the bar's own width.
 */
export function barFill(value: number): { from: number; to: number } {
  const v = Math.max(0, Math.min(1, value));
  return { from: BAR_FILL_INSET, to: BAR_FILL_INSET + (1 - BAR_FILL_INSET * 2) * v };
}

/**
 * Where a set of pages settles after a drag: the nearest page, in the
 * direction of travel when the drag went further than a quarter of a page.
 */
export function snapPage(offset: number, pageWidth: number, pages: number, velocity = 0): number {
  if (pageWidth <= 0 || pages <= 0) return 0;
  let page = Math.round(offset / pageWidth);
  const partial = offset / pageWidth - Math.floor(offset / pageWidth);
  if (velocity > 0 && partial > 0.25 && partial < 0.5) page = Math.floor(offset / pageWidth) + 1;
  if (velocity < 0 && partial < 0.75 && partial > 0.5) page = Math.floor(offset / pageWidth);
  return Math.max(0, Math.min(pages - 1, page));
}
