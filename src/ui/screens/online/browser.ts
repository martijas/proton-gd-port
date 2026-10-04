// A page of online levels: search results, Featured, a map pack, a gauntlet,
// or the saved levels. One screen for all of them, as the game's
// LevelBrowserLayer is one layer for every list it shows.

import type { Game } from "../../../game/game";
import { OnlineError, searchLevels, type LevelQuery, type OnlineLevel } from "../../../online/api";
import { gradient, NO_ART, type ArtLookup } from "../../chrome";
import { UI_COLOURS } from "../../render";
import type { Screen } from "../../screen";
import type { UiViewport } from "../../viewport";
import type { Widget } from "../../widgets";
import { countText, levelRow, listFrame, listRect, pagedChrome, ROW_HEIGHT, scrolled, songLine } from "./common";
import { OnlineLevelScreen } from "./info";

interface Page {
  levels: OnlineLevel[];
  total: number;
  perPage: number;
}

/** Where a browser's levels come from. */
export type LevelSource =
  | { kind: "query"; query: LevelQuery; /** For a list of ids, the order to show them in. */ order?: readonly number[] }
  | { kind: "saved" };

const SAVED_PER_PAGE = 10;

export class LevelBrowserScreen implements Screen {
  readonly name = "levelBrowser";
  readonly opaque = true;
  private page = 0;
  private result: Page | null = null;
  private error: string | null = null;
  private loading = false;
  private scroll = 0;
  /** Bumped on every load, so a slow reply for a page already left is dropped. */
  private ticket = 0;

  constructor(
    private readonly game: Game,
    private readonly title: string,
    private readonly source: LevelSource,
  ) {}

  enter(): void {
    this.load();
  }

  private get art(): ArtLookup {
    return this.game.ui?.art ?? NO_ART;
  }

  private load(): void {
    this.scroll = 0;
    this.error = null;
    if (this.source.kind === "saved") return;
    const source = this.source;
    const ticket = ++this.ticket;
    this.loading = true;
    this.result = null;
    searchLevels(source.query, this.page).then(
      (page) => {
        if (ticket !== this.ticket) return;
        this.loading = false;
        const order = source.order;
        const levels = order ? [...page.levels].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : page.levels;
        this.result = { levels, total: page.total, perPage: page.perPage };
      },
      (e: unknown) => {
        if (ticket !== this.ticket) return;
        this.loading = false;
        this.error = e instanceof OnlineError ? e.message : "Something went wrong. Try again.";
      },
    );
  }

  /** The saved list is read fresh every frame, so a level taken off it in its page is gone on the way back. */
  private current(): Page | null {
    if (this.source.kind !== "saved") return this.result;
    const all = this.game.save.get().savedLevels;
    const pages = Math.max(1, Math.ceil(all.length / SAVED_PER_PAGE));
    if (this.page >= pages) this.page = pages - 1;
    return { levels: all.slice(this.page * SAVED_PER_PAGE, (this.page + 1) * SAVED_PER_PAGE), total: all.length, perPage: SAVED_PER_PAGE };
  }

  build(view: UiViewport): Widget[] {
    const art = this.art;
    const page = this.current();
    const levels = page?.levels ?? [];
    const out: Widget[] = [gradient(view, UI_COLOURS.menuBlue)];
    const box = listRect(view);

    let message: string | null = null;
    if (this.loading) message = "Loading...";
    else if (this.error) message = this.error;
    else if (levels.length === 0) message = this.source.kind === "saved" ? "Levels you play show up here." : "No levels found.";
    out.push(...listFrame(art, box, message, this.error !== null));

    if (levels.length > 0 && !this.loading) {
      const rows = levels.map((level, i) =>
        levelRow(art, level, box.w, i, this.game.save.onlineLevel(level.id), songLine(level, (n) => this.game.strings.song(n)?.title)),
      );
      out.push({ kind: "list", id: "rows", rect: box, rowSize: ROW_HEIGHT, rows, scroll: this.scroll });
    }

    const perPage = page?.perPage ?? 10;
    const total = page?.total ?? 0;
    out.push(
      ...pagedChrome(art, view, {
        title: this.title,
        count: countText(this.page, perPage, levels.length, total),
        canPrev: this.page > 0 && !this.loading,
        canNext: !this.loading && (this.page + 1) * perPage < total && levels.length >= perPage,
      }),
    );
    return out;
  }

  private turn(delta: number): void {
    const page = this.current();
    if (this.loading || !page) return;
    const next = this.page + delta;
    if (next < 0 || next * page.perPage >= page.total) return;
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
    if (id.startsWith("view:")) {
      const level = this.current()?.levels.find((l) => l.id === Number(id.slice(5)));
      if (level) {
        this.game.audio.ui("play");
        this.game.stack.push(new OnlineLevelScreen(this.game, { level }));
      }
      return true;
    }
    return false;
  }

  onDrag(id: string, _dx: number, dy: number): boolean {
    if (id !== "rows") return false;
    const rows = this.current()?.levels.length ?? 0;
    this.scroll = scrolled(this.scroll, dy, rows, ROW_HEIGHT, listRect(this.game.view).h);
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
