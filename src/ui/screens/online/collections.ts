// Map packs and gauntlets: named sets of online levels, each opening as a
// level list of its own.
//
// [gdp LevelBrowserLayer in its map pack mode (MapPackCell: the face, the
//  name in the pack's colour, the stars and coins it awards); GauntletSelectLayer,
//  whose islands are reduced here to a list of the same rows]

import type { Game } from "../../../game/game";
import { faceFrame, gauntlets, LIST_TYPE, mapPacks, OnlineError } from "../../../online/api";
import { FRAMES } from "../../art";
import { gradient, label, NO_ART, TRANSPARENT, type ArtLookup } from "../../chrome";
import type { Tint } from "../../draw";
import { UI_COLOURS } from "../../render";
import type { Screen } from "../../screen";
import { rect, type UiViewport } from "../../viewport";
import type { Widget } from "../../widgets";
import { LevelBrowserScreen } from "./browser";
import { countText, LIST_DARK, LIST_EDGE, LIST_LIGHT, listFrame, listRect, pagedChrome, ROW_HEIGHT, scrolled } from "./common";

interface Entry {
  key: string;
  title: string;
  subtitle: string;
  face?: number;
  colour?: Tint;
  levels: number[];
}

interface Page {
  entries: Entry[];
  total: number;
  perPage: number;
}

export type CollectionKind = "mapPacks" | "gauntlets";

/**
 * The gauntlets' names by id, as the game's GauntletNode prints them. Ids
 * past the end are shown by number.
 */
const GAUNTLET_NAMES = [
  "", "Fire", "Ice", "Poison", "Shadow", "Lava", "Bonus", "Chaos", "Demon", "Time", "Crystal",
  "Magic", "Spike", "Monster", "Doom", "Death", "Forest", "Rune", "Force", "Spooky", "Dragon",
  "Water", "Haunted", "Acid", "Witch", "Power", "Potion", "Snake", "Toxic", "Halloween", "Treasure",
  "Ghost", "Spider", "Gem", "Inferno", "Portal", "Strange", "Fantasy", "Christmas", "Surprise", "Mystery",
  "Cursed", "Cyborg", "Castle", "Grave", "Temple", "World", "Galaxy", "Universe", "Discord", "Split",
  "NCS I", "NCS II",
];

function gauntletName(id: number): string {
  const name = GAUNTLET_NAMES[id];
  return name ? `${name} Gauntlet` : `Gauntlet ${id}`;
}

async function loadPage(kind: CollectionKind, page: number): Promise<Page> {
  if (kind === "mapPacks") {
    const got = await mapPacks(page);
    return {
      total: got.total,
      perPage: got.perPage,
      entries: got.packs.map((p) => ({
        key: `pack:${p.id}`,
        title: p.name,
        subtitle: `${p.stars} stars, ${p.coins} coins, ${p.levels.length} levels`,
        face: p.face,
        colour: { r: p.colour[0], g: p.colour[1], b: p.colour[2] },
        levels: p.levels,
      })),
    };
  }
  const all = await gauntlets();
  return {
    total: all.length,
    perPage: all.length,
    entries: all.map((g) => ({ key: `gauntlet:${g.id}`, title: gauntletName(g.id), subtitle: `${g.levels.length} levels`, levels: g.levels })),
  };
}

export class CollectionScreen implements Screen {
  readonly name = "collection";
  readonly opaque = true;
  private page = 0;
  private result: Page | null = null;
  private error: string | null = null;
  private loading = false;
  private scroll = 0;
  private ticket = 0;

  constructor(
    private readonly game: Game,
    private readonly kind: CollectionKind,
  ) {}

  enter(): void {
    this.load();
  }

  private get art(): ArtLookup {
    return this.game.ui?.art ?? NO_ART;
  }

  private get title(): string {
    return this.kind === "mapPacks" ? "Map Packs" : "Gauntlets";
  }

  private load(): void {
    const ticket = ++this.ticket;
    this.loading = true;
    this.error = null;
    this.result = null;
    this.scroll = 0;
    loadPage(this.kind, this.page).then(
      (page) => {
        if (ticket !== this.ticket) return;
        this.loading = false;
        this.result = page;
      },
      (e: unknown) => {
        if (ticket !== this.ticket) return;
        this.loading = false;
        this.error = e instanceof OnlineError ? e.message : "Something went wrong. Try again.";
      },
    );
  }

  private row(entry: Entry, width: number, index: number): Widget[] {
    const art = this.art;
    const h = ROW_HEIGHT;
    const id = `open:${entry.key}`;
    const out: Widget[] = [
      { kind: "fill", rect: rect(0, 0, width, h), frame: FRAMES.white, tint: index % 2 ? LIST_LIGHT : LIST_DARK },
      { kind: "fill", rect: rect(0, 0, width, 1), frame: FRAMES.white, tint: LIST_EDGE },
      { kind: "button", id, rect: rect(0, 0, width, h), label: { text: "", scale: 0 }, tint: TRANSPARENT },
    ];
    const textX = entry.face === undefined ? 16 : 58;
    if (entry.face !== undefined) out.push({ kind: "sprite", x: 28, y: h / 2, frame: faceFrame(entry.face), scale: 0.75 });
    const textW = width - textX - 80;
    out.push(label(art, entry.title, textX, 40, { scale: art.fit?.("bigFont", entry.title, textW, 0.6) ?? 0.5, anchorX: 0, tint: entry.colour }));
    out.push(label(art, entry.subtitle, textX, 18, { font: "goldFont", scale: 0.42, anchorX: 0 }));
    out.push({ kind: "button", id, rect: rect(width - 70, h / 2 - 15, 60, 30), frame: FRAMES.button, label: { text: "View", scale: 0.45 } });
    return out;
  }

  build(view: UiViewport): Widget[] {
    const art = this.art;
    const out: Widget[] = [gradient(view, UI_COLOURS.menuBlue)];
    const box = listRect(view);
    const entries = this.result?.entries ?? [];
    let message: string | null = null;
    if (this.loading) message = "Loading...";
    else if (this.error) message = this.error;
    else if (entries.length === 0) message = "Nothing here yet.";
    out.push(...listFrame(art, box, message, this.error !== null));
    if (entries.length > 0) {
      const rows = entries.map((e, i) => this.row(e, box.w, i));
      out.push({ kind: "list", id: "rows", rect: box, rowSize: ROW_HEIGHT, rows, scroll: this.scroll });
    }
    const perPage = this.result?.perPage ?? 10;
    const total = this.result?.total ?? 0;
    out.push(
      ...pagedChrome(art, view, {
        title: this.title,
        count: this.kind === "mapPacks" ? countText(this.page, perPage, entries.length, total) : "",
        canPrev: this.page > 0 && !this.loading,
        canNext: !this.loading && (this.page + 1) * perPage < total,
      }),
    );
    return out;
  }

  private turn(delta: number): void {
    const result = this.result;
    if (this.loading || !result) return;
    const next = this.page + delta;
    if (next < 0 || next * result.perPage >= result.total) return;
    this.page = next;
    this.load();
  }

  onPress(id: string): boolean {
    if (id === "back") {
      this.game.audio.ui("back");
      this.game.stack.pop();
      return true;
    }
    if (id === "prev" || id === "next") {
      this.turn(id === "prev" ? -1 : 1);
      return true;
    }
    if (id === "retry") {
      this.load();
      return true;
    }
    if (id.startsWith("open:")) {
      const entry = this.result?.entries.find((e) => `open:${e.key}` === id);
      if (entry && entry.levels.length > 0) {
        this.game.audio.ui("play");
        this.game.stack.push(
          new LevelBrowserScreen(this.game, entry.title, { kind: "query", query: { type: LIST_TYPE.ids, str: entry.levels.join(",") }, order: entry.levels }),
        );
      }
      return true;
    }
    return false;
  }

  onDrag(id: string, _dx: number, dy: number): boolean {
    if (id !== "rows") return false;
    this.scroll = scrolled(this.scroll, dy, this.result?.entries.length ?? 0, ROW_HEIGHT, listRect(this.game.view).h);
    return true;
  }

  onKey(code: string, down: boolean): boolean {
    if (!down) return false;
    if (code === "Escape") {
      this.game.stack.pop();
      return true;
    }
    if (code === "ArrowLeft" || code === "ArrowRight") {
      this.turn(code === "ArrowLeft" ? -1 : 1);
      return true;
    }
    return false;
  }
}
