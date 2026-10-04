// What the online screens share: a level's face, a level's row in a list, and
// the frame round a paged list — title, page arrows, count, and the line that
// says it is loading or what went wrong.
//
// [gdp LevelBrowserLayer::init: the list 356 by 220 under a title, the page
//  arrows at the screen's sides, the count top right; LevelCell::loadFromLevel:
//  the face left with its stars under it, the name, "By" and the author, the
//  stats along the bottom, View on the right. Sizes here are fitted to this
//  port's design box rather than measured.]

import { faceFrame, lengthName, shortCount, type OnlineLevel } from "../../../online/api";
import type { LevelProgress } from "../../../save/schema";
import { FRAMES } from "../../art";
import { backArrow, label, spriteButton, TRANSPARENT, type ArtLookup } from "../../chrome";
import type { Tint } from "../../draw";
import { rect, type Rect, type UiViewport } from "../../viewport";
import type { Widget } from "../../widgets";

/** The game's brown list, its rows in two shades. [meas] */
export const LIST_DARK: Tint = { r: 161, g: 88, b: 44 };
export const LIST_LIGHT: Tint = { r: 194, g: 114, b: 62 };
export const LIST_EDGE: Tint = { r: 110, g: 56, b: 24 };
/** The blue the game prints a level's song in. [meas] */
export const SONG_BLUE: Tint = { r: 120, g: 200, b: 255 };
export const MUTED: Tint = { r: 200, g: 200, b: 200 };

export const ROW_HEIGHT = 62;

/** The coin behind a rated level's face, or none. */
export function rateCoin(level: Pick<OnlineLevel, "featured" | "epic">): string | null {
  if (level.epic === 3) return FRAMES.mythicCoin;
  if (level.epic === 2) return FRAMES.legendaryCoin;
  if (level.epic === 1) return FRAMES.epicCoin;
  return level.featured ? FRAMES.featuredCoin : null;
}

/** A level's difficulty face over its rating coin. */
export function faceWidgets(level: Pick<OnlineLevel, "face" | "featured" | "epic">, x: number, y: number, scale: number): Widget[] {
  const out: Widget[] = [];
  const coin = rateCoin(level);
  if (coin) out.push({ kind: "sprite", x, y, frame: coin, scale });
  out.push({ kind: "sprite", x, y, frame: faceFrame(level.face), scale });
  return out;
}

/** An icon with a number beside it, the way the rows and the info page print their stats. */
export function stat(art: ArtLookup, frame: string, text: string, x: number, y: number, scale: number): Widget[] {
  return [
    { kind: "sprite", x, y, frame, scale: scale * 1.1 },
    label(art, text, x + 10 * scale * 2, y, { scale: scale * 0.75, anchorX: 0 }),
  ];
}

/** The song line: an official track by title, a custom one by title and artist. */
export function songLine(level: OnlineLevel, officialTitle: (index: number) => string | undefined): string {
  const s = level.song;
  if (s.kind === "official") return officialTitle(s.index) ?? "Stereo Madness";
  return s.name;
}

/** One level in a list, laid out at the origin of a row `width` wide. */
export function levelRow(art: ArtLookup, level: OnlineLevel, width: number, index: number, progress: LevelProgress, song: string): Widget[] {
  const h = ROW_HEIGHT;
  const id = `view:${level.id}`;
  const out: Widget[] = [
    { kind: "fill", rect: rect(0, 0, width, h), frame: FRAMES.white, tint: index % 2 ? LIST_LIGHT : LIST_DARK },
    { kind: "fill", rect: rect(0, 0, width, 1), frame: FRAMES.white, tint: LIST_EDGE },
    // The whole row takes a tap; View is drawn over it.
    { kind: "button", id, rect: rect(0, 0, width, h), label: { text: "", scale: 0 }, tint: TRANSPARENT },
  ];

  out.push(...faceWidgets(level, 28, 38, 0.75));
  if (level.stars > 0) {
    out.push(label(art, String(level.stars), 26, 11, { scale: 0.34, anchorX: 1 }));
    out.push({ kind: "sprite", x: 33, y: 11, frame: FRAMES.smallStar, scale: 0.75 });
  }

  const textX = 58;
  const textW = width - textX - 78;
  out.push(label(art, level.name, textX, 47, { scale: art.fit?.("bigFont", level.name, textW, 0.55) ?? 0.5, anchorX: 0 }));
  const by = level.author ? `By ${level.author}` : "";
  if (by) out.push(label(art, by, textX, 31, { font: "goldFont", scale: art.fit?.("goldFont", by, textW * 0.55, 0.45) ?? 0.4, anchorX: 0 }));
  const songX = textX + (by ? Math.min(textW * 0.55, art.measure?.("goldFont", by, { scale: 0.45 }).width ?? 0) + 8 : 0);
  out.push(label(art, song, songX, 31, { font: "chatFont", scale: art.fit?.("chatFont", song, textX + textW - songX, 0.5) ?? 0.45, anchorX: 0, tint: SONG_BLUE }));

  out.push(...stat(art, FRAMES.downloads, shortCount(level.downloads), textX + 6, 13, 0.45));
  out.push(...stat(art, FRAMES.likes, shortCount(level.likes), textX + 76, 13, 0.45));
  out.push(...stat(art, FRAMES.length, lengthName(level.length), textX + 146, 13, 0.45));

  // User coins, after the stats: lit once taken, faint while unverified.
  for (let i = 0; i < level.coins; i++) {
    out.push({
      kind: "sprite",
      x: textX + 212 + i * 12,
      y: 13,
      frame: progress.coins[i] ? FRAMES.userCoin : FRAMES.coinGrey,
      scale: 0.45,
      alpha: level.verifiedCoins ? 1 : 0.5,
    });
  }

  if (progress.completions > 0) out.push({ kind: "sprite", x: width - 88, y: 44, frame: FRAMES.completed, scale: 0.6 });
  out.push({ kind: "button", id, rect: rect(width - 70, h / 2 - 15, 60, 30), frame: FRAMES.button, label: { text: "View", scale: 0.45 } });
  return out;
}

/** Where a paged list sits on the screen. */
export function listRect(view: UiViewport): Rect {
  const w = Math.min(view.width - 110, 430);
  const top = view.height - 52;
  const bottom = 26;
  return rect(view.width / 2 - w / 2, bottom, w, top - bottom);
}

export interface PagedChrome {
  title: string;
  /** "1 to 10 of 52", or nothing when there is nothing to count. */
  count: string;
  canPrev: boolean;
  canNext: boolean;
}

/** The title, the back arrow, the page arrows and the count. */
export function pagedChrome(art: ArtLookup, view: UiViewport, c: PagedChrome): Widget[] {
  const w = view.width;
  const h = view.height;
  const out: Widget[] = [];
  out.push(label(art, c.title, w / 2, h - 26, { scale: art.fit?.("bigFont", c.title, w - 200, 0.8) ?? 0.7 }));
  if (c.count) out.push(label(art, c.count, w - 10, h - 12, { font: "goldFont", scale: 0.42, anchorX: 1 }));
  out.push(...backArrow(art, view, "green"));
  if (c.canPrev) out.push(...spriteButton(art, "prev", 25, h / 2, FRAMES.navArrow, { sizeMult: 2, scale: 0.8 }));
  if (c.canNext) out.push(...spriteButton(art, "next", w - 25, h / 2, FRAMES.navArrow, { sizeMult: 2, scale: 0.8, flipX: true }));
  return out;
}

/** The list's frame, and a message in the middle of it when there are no rows to show. */
export function listFrame(art: ArtLookup, box: Rect, message: string | null, retry: boolean): Widget[] {
  const out: Widget[] = [
    { kind: "fill", rect: rect(box.x - 3, box.y - 3, box.w + 6, box.h + 6), frame: FRAMES.white, tint: LIST_EDGE },
    { kind: "fill", rect: box, frame: FRAMES.white, tint: LIST_DARK },
  ];
  if (message) {
    const cy = box.y + box.h / 2;
    out.push(label(art, message, box.x + box.w / 2, cy + (retry ? 16 : 0), { font: "goldFont", scale: 0.55, maxWidth: box.w - 40 }));
    if (retry) out.push({ kind: "button", id: "retry", rect: rect(box.x + box.w / 2 - 55, cy - 34, 110, 30), frame: FRAMES.button, label: { text: "Try again", scale: 0.45 } });
  }
  return out;
}

/** "1 to 10 of 52". */
export function countText(page: number, perPage: number, shown: number, total: number): string {
  if (shown === 0) return "";
  const first = page * perPage + 1;
  return `${first} to ${first + shown - 1} of ${Math.max(total, first + shown - 1)}`;
}

/** Scrolls a list by a drag, clamped to its rows. */
export function scrolled(current: number, dy: number, rows: number, rowSize: number, visible: number): number {
  return Math.max(0, Math.min(Math.max(0, rows * rowSize - visible), current + dy));
}
