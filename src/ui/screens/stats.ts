// The player's numbers, and the achievements they add up to.
//
// Two screens that read the same progress. The stats are the counts the save
// keeps; the achievements are the game's own list, read out of the binary,
// shown only as far as this port can count them — the ones that need the
// shop, online levels or the vaults are summed up in one line rather than
// listed as things that will never happen here. Both sit in the game's popup
// frame over the blue wash the rest of the menus share.

import type { Game } from "../../game/game";
import { achieved, achievementProgress, describeAchievement, parseReward, progressOf, type Progress } from "../../save/unlocks";
import { FRAMES } from "../art";
import { backArrow, corners, dropDown, gradient, label, listRowTint, NO_ART, spriteButton, tableBars, tableRect, type ArtLookup } from "../chrome";
import type { IconKind } from "../../assets/iconTypes";
import { UI_COLOURS } from "../render";
import type { Screen } from "../screen";
import { rect, type Rect, type UiViewport } from "../viewport";
import { listMetrics, type Widget } from "../widgets";

function progressFor(game: Game): Progress {
  return progressOf(
    game.save.get(),
    (id) => game.strings.facts(id)?.stars ?? 0,
    (id) => game.strings.facts(id)?.demon ?? false,
  );
}

/** The popup that holds either list. */
function frame(view: UiViewport): Rect {
  const w = Math.min(400, view.width - 60);
  const h = Math.min(250, view.height - 60);
  return rect(view.width / 2 - w / 2, view.height / 2 - h / 2 - 6, w, h);
}

export class StatsScreen implements Screen {
  readonly name = "stats";
  readonly opaque = true;

  constructor(private readonly game: Game) {}

  build(view: UiViewport): Widget[] {
    const art: ArtLookup = this.game.ui?.art ?? NO_ART;
    const p = progressFor(this.game);
    const save = this.game.save.get();
    let completions = 0;
    for (const level of Object.values(save.levels)) completions += level.completions;
    const rows: Array<[string, string]> = [
      ["Stars", String(p.stars)],
      ["Secret coins", String(p.secretCoins)],
      ["Levels completed", String(p.completed.size)],
      ["Completions", String(completions)],
      ["Demons beaten", String(p.demons)],
      ["Practice completions", String(p.practised.size)],
      ["Attempts", p.attempts.toLocaleString()],
      ["Jumps", p.jumps.toLocaleString()],
    ];
    const box = frame(view);
    const out: Widget[] = [gradient(view, UI_COLOURS.menuBlue), ...corners(view, ["bottomLeft", "bottomRight"]), ...backArrow(art, view, "pink")];
    out.push({ kind: "panel", rect: box, frame: FRAMES.panel });
    out.push(label(art, "Stats", view.width / 2, box.y + box.h + 16, { scale: 0.7 }));
    const step = (box.h - 30) / rows.length;
    rows.forEach(([name, value], i) => {
      const y = box.y + box.h - 22 - i * step;
      out.push(label(art, name, box.x + 24, y, { font: "goldFont", scale: 0.5, anchorX: 0 }));
      out.push(label(art, value, box.x + box.w - 24, y, { scale: 0.45, anchorX: 1 }));
    });
    return out;
  }

  onPress(id: string): boolean {
    if (id === "back") {
      this.game.audio.ui("back");
      this.game.stack.pop();
      return true;
    }
    return false;
  }

  onKey(code: string, down: boolean): boolean {
    if (down && code === "Escape") {
      this.game.stack.pop();
      return true;
    }
    return false;
  }
}

/** A row's height, and how many rows a page holds. [gdp AchievementsLayer::loadPage :123788; meas] */
const ROW = 80;
const PER_PAGE = 10;
/** A reward icon is drawn grey, the way the list shows what an achievement gives. [gdp loadFromDict :130232-130238] */
const REWARD_GREY = { r: 175, g: 175, b: 175 };

interface AchievementRow {
  id: string;
  done: boolean;
  progress: number;
  text: string;
  reward: string | null;
}

export class AchievementsScreen implements Screen {
  readonly name = "achievements";
  readonly opaque = false;
  readonly ticksBelow = false;
  private page = 0;
  private scroll = 0;

  constructor(private readonly game: Game) {}

  enter(): void {
    this.bindPages();
  }

  update(): void {
    this.bindPages();
  }

  /** The scene holds two icon pages at once: the ones the rows in view are on. */
  private bindPages(): void {
    const items = this.countable();
    const firstRow = this.page * PER_PAGE + Math.floor(this.scroll / ROW);
    const pages: number[] = [];
    for (let i = firstRow; i < Math.min(firstRow + 3, (this.page + 1) * PER_PAGE, items.length); i++) {
      const kind = iconKindOf(items[i].reward);
      const icon = kind && this.game.icons.icon(kind.kind, kind.index);
      if (icon && !pages.includes(icon.page)) pages.push(icon.page);
    }
    void this.game.scene.bindPages(pages);
  }

  /** The achievements this port can count, in the game's order. */
  private countable(): AchievementRow[] {
    const p = progressFor(this.game);
    const out: AchievementRow[] = [];
    for (const a of this.game.strings.achievements()) {
      const done = achieved(a.id, a, p);
      if (done === null) continue;
      out.push({
        id: a.id,
        done,
        progress: achievementProgress(a.id, a, p) ?? 0,
        text: describeAchievement(a.id, a, (id) => this.game.levelName(id)),
        reward: a.reward,
      });
    }
    return out;
  }

  build(view: UiViewport): Widget[] {
    const art: ArtLookup = this.game.ui?.art ?? NO_ART;
    const items = this.countable();
    const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
    this.page = Math.min(this.page, pages - 1);
    const first = this.page * PER_PAGE;
    const shown = items.slice(first, first + PER_PAGE);
    const out: Widget[] = dropDown(art, view, "Achievements");

    const list = tableRect(view);
    const rows: Widget[][] = shown.map((item, i) => this.row(art, item, list.w, i));
    out.push({ kind: "list", id: "achievements", rect: list, rowSize: ROW, rows, scroll: this.scroll });
    out.push(...tableBars(art, view, "Achievements"));

    // "1 to 10 of N" in the corner, and the page arrows at the screen's edges. [customSetup :124024-124041]
    const last = Math.min(first + PER_PAGE, items.length);
    out.push(label(art, `${items.length ? first + 1 : 0} to ${last} of ${items.length}`, view.width - 7, view.height - 4, { font: "goldFont", scale: 0.6, anchorX: 1, anchorY: 1 }));
    if (this.page > 0) out.push(...spriteButton(art, "prev", 24, view.height / 2, FRAMES.arrowGreen));
    if (this.page < pages - 1) out.push(...spriteButton(art, "next", view.width - 24, view.height / 2, FRAMES.arrowGreen, { flipX: true }));
    return out;
  }

  /**
   * One row: the reward on the left, the gold line and the white line beside
   * it, and a tick on the right once it is earned.
   * [gdp AchievementCell::loadFromDict :129921-130362]
   */
  private row(art: ArtLookup, item: AchievementRow, width: number, index: number): Widget[] {
    const mid = ROW / 2;
    const out: Widget[] = [{ kind: "fill", rect: rect(0, 0, width, ROW), tint: listRowTint(index) }];
    out.push(...this.rewardIcon(art, item.reward, 35, mid));

    const textX = 67;
    const title = rewardTitle(item.reward);
    const titleScale = Math.min(0.7, art.fit?.("goldFont", title, 200, 0.7) ?? 0.7);
    const lines = Math.max(1, Math.round((art.measure?.("chatFont", item.text, { maxWidth: 260 })?.height ?? 16) / 16));
    const titleY = mid + 4 + 8 * lines;
    out.push(label(art, title, textX, titleY, { font: "goldFont", scale: titleScale, anchorX: 0 }));
    out.push(label(art, item.text, textX, titleY - 11, { font: "chatFont", maxWidth: 260, anchorX: 0, anchorY: 1 }));

    if (item.done) {
      out.push({ kind: "sprite", x: width - 40, y: mid, frame: FRAMES.completed, scale: 0.8, originX: 0 });
    } else if (item.progress > 0) {
      out.push(label(art, `${Math.floor(item.progress * 100)}%`, 35, mid - 25, { font: "goldFont", scale: 0.5 }));
    }
    return out;
  }

  /** The thing an achievement gives, drawn the way the kit draws it, or the plain trophy. */
  private rewardIcon(art: ArtLookup, reward: string | null, x: number, y: number): Widget[] {
    const r = parseReward(reward);
    const icon = iconKindOf(reward);
    if (icon) {
      return [{ kind: "icon", x, y, iconKind: icon.kind, iconId: icon.index, scale: 1, colour1: 0, colour2: 0, glow: false, darken: REWARD_GREY }];
    }
    if (r && (r.kind === "colour1" || r.kind === "colour2")) {
      const colour = this.game.strings.playerColour(r.index);
      const circle = Math.max(1, art.quad(FRAMES.circle)?.w ?? 30);
      return [
        { kind: "sprite", x, y, frame: FRAMES.circle, scale: 30 / circle, tint: { r: 0, g: 0, b: 0 } },
        { kind: "sprite", x, y, frame: FRAMES.circle, scale: 26 / circle, tint: colour },
        label(art, r.kind === "colour1" ? "1" : "2", x, y, { scale: 0.45 }),
      ];
    }
    return [{ kind: "sprite", x, y, frame: FRAMES.achievementImage }];
  }

  onPress(id: string): boolean {
    if (id === "back") {
      this.game.audio.ui("back");
      this.game.stack.pop();
      return true;
    }
    if (id === "prev" || id === "next") {
      this.page += id === "next" ? 1 : -1;
      this.scroll = 0;
      return true;
    }
    return false;
  }

  onDrag(id: string, _dx: number, dy: number): boolean {
    if (id !== "achievements") return false;
    const view = this.game.view;
    const count = Math.min(PER_PAGE, this.countable().length - this.page * PER_PAGE);
    const rows = Array.from({ length: Math.max(0, count) }, () => []);
    const metrics = listMetrics({ kind: "list", id, rect: tableRect(view), rowSize: ROW, rows, scroll: this.scroll });
    this.scroll = Math.max(0, Math.min(metrics.maxScroll, this.scroll + dy));
    return true;
  }

  onKey(code: string, down: boolean): boolean {
    if (!down) return false;
    if (code === "Escape") {
      this.game.stack.pop();
      return true;
    }
    if (code === "ArrowLeft" && this.page > 0) return this.onPress("prev");
    if (code === "ArrowRight" && (this.page + 1) * PER_PAGE < this.countable().length) return this.onPress("next");
    return false;
  }
}

const ICON_REWARDS: readonly IconKind[] = ["cube", "ship", "ball", "ufo", "wave", "robot", "spider", "swing", "jetpack"];

/** The icon an achievement unlocks, when it unlocks one. */
function iconKindOf(reward: string | null): { kind: IconKind; index: number } | null {
  const r = parseReward(reward);
  const kind = r && ICON_REWARDS.find((k) => k === r.kind);
  return r && kind ? { kind, index: r.index } : null;
}

/** An achievement's heading in the list: what it gives, in a word or two. */
function rewardTitle(reward: string | null): string {
  const r = parseReward(reward);
  if (!r) return "Achievement";
  switch (r.kind) {
    case "colour1":
      return `Colour ${r.index}`;
    case "colour2":
      return `Second Colour ${r.index}`;
    case "death":
      return "Death Effect";
    case "special":
      return "Trail";
    case "ufo":
      return `UFO ${r.index}`;
    default:
      return `${r.kind[0].toUpperCase()}${r.kind.slice(1)} ${r.index}`;
  }
}

/** What an achievement hands over, as a player would say it. */
export function rewardLabel(reward: string | null): string {
  const r = parseReward(reward);
  if (!r) return "";
  switch (r.kind) {
    case "cube":
      return `Unlocks cube ${r.index}`;
    case "ship":
      return `Unlocks ship ${r.index}`;
    case "ball":
      return `Unlocks ball ${r.index}`;
    case "ufo":
      return `Unlocks UFO ${r.index}`;
    case "wave":
      return `Unlocks wave ${r.index}`;
    case "robot":
      return `Unlocks robot ${r.index}`;
    case "spider":
      return `Unlocks spider ${r.index}`;
    case "swing":
      return `Unlocks swing ${r.index}`;
    case "jetpack":
      return `Unlocks jetpack ${r.index}`;
    case "colour1":
      return `Unlocks colour ${r.index}`;
    case "colour2":
      return `Unlocks second colour ${r.index}`;
    case "death":
      return "Unlocks a death effect";
    case "special":
      return "Unlocks a trail";
  }
}
