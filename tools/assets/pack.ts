// A small rectangle packer for the icon pages. Pure: no file system, no
// canvas, so it can be unit-tested on its own.
//
// Skyline bottom-left with a transparent gutter. Items arrive in groups (one
// group is one icon's layers) and a group is never split across pages, so an
// icon and everything it draws with live on the same texture.

export interface PackItem {
  key: string;
  w: number;
  h: number;
}

export interface PackGroup {
  id: string;
  items: PackItem[];
}

export interface PackPlacement {
  key: string;
  group: string;
  page: number;
  x: number;
  y: number;
}

export interface PackOptions {
  width: number;
  maxHeight: number;
  /** Transparent margin around each item, in px. */
  padding: number;
  /** Round each page's height up to a power of two. */
  powerOfTwoHeight?: boolean;
}

interface Skyline {
  x: number;
  y: number;
  w: number;
}

class Page {
  readonly skyline: Skyline[];
  used = 0;

  constructor(readonly width: number) {
    this.skyline = [{ x: 0, y: 0, w: width }];
  }

  /** Lowest position the item fits at, or null when it does not fit at all. */
  find(w: number, h: number, maxHeight: number): { x: number; y: number; index: number } | null {
    let best: { x: number; y: number; index: number } | null = null;
    for (let i = 0; i < this.skyline.length; i++) {
      const y = this.fits(i, w);
      if (y === null || y + h > maxHeight) continue;
      const node = this.skyline[i];
      if (!best || y < best.y || (y === best.y && node.x < best.x)) best = { x: node.x, y, index: i };
    }
    return best;
  }

  /** The height an item of width w would sit at if placed at node i. */
  private fits(i: number, w: number): number | null {
    const start = this.skyline[i];
    if (start.x + w > this.width) return null;
    let left = w;
    let y = start.y;
    for (let j = i; j < this.skyline.length && left > 0; j++) {
      y = Math.max(y, this.skyline[j].y);
      left -= this.skyline[j].w;
    }
    return left > 0 ? null : y;
  }

  place(x: number, y: number, w: number, h: number): void {
    const top = y + h;
    const next: Skyline[] = [];
    for (const node of this.skyline) {
      const overlaps = node.x < x + w && x < node.x + node.w;
      if (!overlaps) {
        next.push(node);
        continue;
      }
      if (node.x < x) next.push({ x: node.x, y: node.y, w: x - node.x });
      const rightStart = x + w;
      const nodeEnd = node.x + node.w;
      if (nodeEnd > rightStart) next.push({ x: rightStart, y: node.y, w: nodeEnd - rightStart });
    }
    next.push({ x, y: top, w });
    next.sort((a, b) => a.x - b.x);
    // Merge neighbours at the same height so the skyline stays short.
    this.skyline.length = 0;
    for (const node of next) {
      const last = this.skyline[this.skyline.length - 1];
      if (last && last.y === node.y && last.x + last.w === node.x) last.w += node.w;
      else this.skyline.push({ ...node });
    }
    this.used = Math.max(this.used, top);
  }
}

export interface PackResult {
  pages: { w: number; h: number }[];
  placements: PackPlacement[];
  /** Groups that could not fit on an empty page at all. */
  oversized: string[];
}

export function packGroups(groups: PackGroup[], options: PackOptions): PackResult {
  const pad = options.padding;
  const sorted = [...groups].sort((a, b) => {
    const ah = Math.max(0, ...a.items.map((i) => i.h));
    const bh = Math.max(0, ...b.items.map((i) => i.h));
    if (ah !== bh) return bh - ah;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const pages: Page[] = [];
  const placements: PackPlacement[] = [];
  const oversized: string[] = [];

  const tryPlace = (page: Page, pageIndex: number, items: PackItem[], groupId: string): PackPlacement[] | null => {
    const snapshot = page.skyline.map((n) => ({ ...n }));
    const usedBefore = page.used;
    const local: PackPlacement[] = [];
    for (const item of items) {
      const spot = page.find(item.w + pad * 2, item.h + pad * 2, options.maxHeight);
      if (!spot) {
        // Undo the partial group: an icon never straddles two pages.
        page.skyline.length = 0;
        page.skyline.push(...snapshot);
        page.used = usedBefore;
        return null;
      }
      page.place(spot.x, spot.y, item.w + pad * 2, item.h + pad * 2);
      local.push({ key: item.key, group: groupId, page: pageIndex, x: spot.x + pad, y: spot.y + pad });
    }
    return local;
  };

  for (const group of sorted) {
    const items = [...group.items].sort((a, b) => b.h - a.h || b.w - a.w || (a.key < b.key ? -1 : 1));
    let done: PackPlacement[] | null = null;
    // Existing pages first, oldest to newest, then one fresh page.
    for (let i = 0; i < pages.length && !done; i++) done = tryPlace(pages[i], i, items, group.id);
    if (!done) {
      const page = new Page(options.width);
      done = tryPlace(page, pages.length, items, group.id);
      if (done) pages.push(page);
    }
    if (done) placements.push(...done);
    else oversized.push(group.id);
  }

  return {
    pages: pages.map((p) => ({ w: options.width, h: pageHeight(p.used, options) })),
    placements,
    oversized,
  };
}

function pageHeight(used: number, options: PackOptions): number {
  if (used <= 0) return 1;
  if (!options.powerOfTwoHeight) return Math.min(used, options.maxHeight);
  let h = 1;
  while (h < used) h *= 2;
  return Math.min(h, options.maxHeight);
}
