// The icon kit: choosing what the player looks like, laid out as the game's
// garage is.
//
// The name across the top, the chosen icon standing on its line, a row of
// round tabs for the kinds, and a grid of twelve by three under a hint,
// paged with green arrows and dots. The paint pot at the left swaps the grid
// for the colours. What has not been earned sits dim behind a lock, and
// tapping it says what earns it — or that it is earned in a part of the game
// this port does not have, which is most of the later ones.
//
// The icon pages are bound to two texture units, like the level does for the
// player, so the grid asks for the pages its visible cells sit on and the
// preview takes whichever of those it can. A page swap is a frame late, which
// at this size is invisible.
//
// [gdp GJGarageLayer::init, gd-ida-decomp.cpp:335859-336660: the name 34
//  under the top, the line 50 above the centre, the icon 23.5 above the line
//  at one and a half, the stars 18 in from the right and 12 under the top with
//  15 between rows, the paint pot at (30, top - 120), the pink arrow back]

import type { IconKind } from "../../assets/iconTypes";
import type { Game } from "../../game/game";
import { availability, describeAchievement, progressOf, type Availability, type Progress, type RewardKind } from "../../save/unlocks";
import { FRAMES } from "../art";
import { backArrow, corners, gradient, label, NO_ART, pageDots, spriteButton, TRANSPARENT, type ArtLookup } from "../chrome";
import type { Screen } from "../screen";
import { rect, type Rect, type UiViewport } from "../viewport";
import type { Widget } from "../widgets";
import { countCoins, countStars, countUserCoins } from "./menu";

interface Tab {
  kind: IconKind;
  on: string;
  off: string;
}

/** The kinds in the game's tab order. Jetpack shows only when the art has it. */
const TABS: readonly Tab[] = [
  { kind: "cube", on: FRAMES.tabCubeOn, off: FRAMES.tabCubeOff },
  { kind: "ship", on: FRAMES.tabShipOn, off: FRAMES.tabShipOff },
  { kind: "ball", on: FRAMES.tabBallOn, off: FRAMES.tabBallOff },
  { kind: "ufo", on: FRAMES.tabUfoOn, off: FRAMES.tabUfoOff },
  { kind: "wave", on: FRAMES.tabWaveOn, off: FRAMES.tabWaveOff },
  { kind: "robot", on: FRAMES.tabRobotOn, off: FRAMES.tabRobotOff },
  { kind: "spider", on: FRAMES.tabSpiderOn, off: FRAMES.tabSpiderOff },
  { kind: "swing", on: FRAMES.tabSwingOn, off: FRAMES.tabSwingOff },
  { kind: "jetpack", on: FRAMES.tabJetpackOn, off: FRAMES.tabJetpackOff },
];

/** The line the icon stands on, and where the name and the tabs sit. [gdp] */
const LINE_ABOVE_CENTRE = 50;
/** Half the icon's 30 at its scale, plus one. [gdp :336320-336330] */
const PREVIEW_SCALE = 1.6;
const PREVIEW_ABOVE_LINE = (30 * PREVIEW_SCALE) / 2 + 1;
const NAME_UNDER_TOP = 34;
/** The name's box, which the name is shrunk to fit. [gdp CCTextInputNode::create(180, 50, …)] */
const NAME_WIDTH = 180;
/**
 * The tab row, two apart. The decompile scales each tab to 0.9; the PC build
 * draws them at full size. [gdp setupIconSelect :335745-335758; meas]
 */
const TABS_ABOVE_CENTRE = 30;
const TAB_SCALE = 1;
const TAB_GAP = 2;
/** The grid's backing, 75 of 255 opaque, and the hint 12 above it. [gdp :335620-335638] */
const GRID_PANEL: { w: number; h: number } = { w: 385, h: 100 };
const GRID_CENTRE_Y = 95;
const GRID_ALPHA = 75 / 255;
const HINT_Y = GRID_CENTRE_Y + GRID_PANEL.h / 2 + 12;
const GRID_COLUMNS = 12;
const GRID_ROWS = 3;
const CELL_PITCH = 30;
const ICON_SCALE = 0.7;
/** The arrows 220 either side of the grid at 0.8. [gdp :335770-335806] */
const ARROW_OFFSET = 220;
const ARROW_SCALE = 0.8;
/** The dots at 0.9, laid out by their unscaled size plus a gap. [gdp setupPage :335290-335318; meas] */
const DOTS_Y = 25;
const DOT_SCALE = 0.9;
const DOT_PITCH = 25;
/** How a locked icon is shown: black at 120 of 255, under a grey lock. [gdp GJItemIcon::changeToLockedState :333000] */
const LOCKED_TINT = { r: 0, g: 0, b: 0 };
const LOCKED_ALPHA = 120 / 255;
const LOCK_TINT = { r: 175, g: 175, b: 175 };
const LOCK_ALPHA = 200 / 255;
/** The wash behind the kit. [gdp GJGarageLayer::init :336162-336165] */
const BACKGROUND = { r: 150, g: 150, b: 150 };
/** The stat rows top right. [gdp :336468-336612] */
const STATS_INSET = { x: 18, y: 12 };
const STATS_PITCH = 15;
const STATS_TEXT_SCALE = 0.34;
/** The frame round the chosen icon. [gdp :335760-335768] */
const SELECT_SCALE = 0.85;

const PER_PAGE = GRID_COLUMNS * GRID_ROWS;

export class IconKitScreen implements Screen {
  readonly name = "icons";
  readonly opaque = true;
  private kind: IconKind = "cube";
  private mode: "icons" | "colours" = "icons";
  /** Which colour the swatches set, while in colour mode. */
  private slot: 1 | 2 = 1;
  private page = 0;
  private hint = "";

  constructor(private readonly game: Game) {}

  enter(): void {
    // The grid's first cells, and the chosen icon, before the first frame.
    this.bindPages();
  }

  exit(): void {
    this.game.save.flush();
  }

  update(): void {
    this.bindPages();
  }

  private get art(): ArtLookup {
    return this.game.ui?.art ?? NO_ART;
  }

  private progress(): Progress {
    const save = this.game.save.get();
    return progressOf(save, (id) => this.game.strings.facts(id)?.stars ?? 0, (id) => this.game.strings.facts(id)?.demon ?? false);
  }

  /** Asks the scene for the pages the visible part of the grid is on. */
  private bindPages(): void {
    const ids = this.ids();
    const first = ids[this.page * PER_PAGE];
    const last = ids[Math.min(ids.length - 1, (this.page + 1) * PER_PAGE - 1)];
    const pages: number[] = [];
    const add = (kind: IconKind, id: number | undefined): void => {
      if (id === undefined) return;
      const icon = this.game.icons.icon(kind, id);
      if (icon && !pages.includes(icon.page)) pages.push(icon.page);
    };
    if (this.mode === "icons") {
      add(this.kind, first);
      add(this.kind, last);
    }
    add(this.kind, this.game.save.get().player.icons[this.kind]);
    void this.game.scene.bindPages(pages);
  }

  /** Every icon of the current kind the kit offers. Cube and ball skip their 0. */
  private ids(): number[] {
    const set = this.game.icons.file.kinds[this.kind];
    if (!set) return [];
    return set.icons.map((i) => i.id).filter((id) => id >= 1);
  }

  private tabs(): readonly Tab[] {
    return TABS.filter((t) => (this.game.icons.file.kinds[t.kind]?.count ?? 0) > 0);
  }

  private pageCount(): number {
    const n = this.mode === "icons" ? this.ids().length : this.game.strings.playerColourCount;
    return Math.max(1, Math.ceil(n / PER_PAGE));
  }

  build(view: UiViewport): Widget[] {
    const art = this.art;
    const w = view.width;
    const h = view.height;
    const cx = w / 2;
    const look = this.game.save.get().player;
    const out: Widget[] = [];

    out.push(gradient(view, BACKGROUND));
    out.push(...corners(view, ["topLeft", "bottomLeft", "bottomRight"]));
    out.push(...backArrow(art, view, "pink"));

    out.push(label(art, "Player", cx, h - NAME_UNDER_TOP, { scale: art.fit?.("bigFont", "Player", NAME_WIDTH, 1) ?? 1 }));

    // The line and the icon standing on it.
    const lineY = h / 2 + LINE_ABOVE_CENTRE;
    out.push({ kind: "sprite", x: cx, y: lineY, frame: FRAMES.floorLine });
    out.push({
      kind: "icon",
      x: cx,
      y: lineY + PREVIEW_ABOVE_LINE,
      iconKind: this.kind,
      iconId: look.icons[this.kind],
      scale: PREVIEW_SCALE,
      colour1: look.colour1,
      colour2: look.colour2,
      glow: look.glow,
    });

    // The paint pot, and the stats top right.
    out.push(...spriteButton(art, "paint", 30, h - 120, FRAMES.paint, { tint: this.mode === "colours" ? { r: 255, g: 255, b: 160 } : undefined }));
    // The game's column, keeping the counts this version keeps.
    const stats: Array<{ frame: string; scale: number; value: number }> = [
      { frame: FRAMES.star, scale: 0.55, value: countStars(this.game) },
      { frame: FRAMES.coin, scale: 0.5, value: countCoins(this.game) },
      { frame: FRAMES.userCoin, scale: 0.5, value: countUserCoins(this.game) },
    ];
    stats.forEach((row, i) => {
      const y = h - STATS_INSET.y - i * STATS_PITCH;
      out.push({ kind: "sprite", x: w - STATS_INSET.x, y, frame: row.frame, scale: row.scale });
      out.push(label(art, String(row.value), w - STATS_INSET.x - 12, y + 0.5, { scale: STATS_TEXT_SCALE, anchorX: 1 }));
    });

    if (this.mode === "icons") out.push(...this.tabRow(view));
    else out.push(...this.colourRow(view));

    // The hint, or what a locked cell has to say.
    if (this.hint) {
      out.push(label(art, this.hint, cx, HINT_Y, { font: "chatFont", scale: 0.55, maxWidth: w - 120 }));
    } else {
      out.push({ kind: "sprite", x: cx, y: HINT_Y, frame: FRAMES.unlockText });
    }

    // The grid and its paging. The arrows and dots only show past one page.
    out.push({ kind: "panel", rect: this.gridRect(view), frame: FRAMES.squareBlack, alpha: GRID_ALPHA });
    out.push(...(this.mode === "icons" ? this.iconCells(view) : this.colourCells(view)));
    const pages = this.pageCount();
    if (pages > 1) {
      out.push(...spriteButton(art, "prev", cx - ARROW_OFFSET, GRID_CENTRE_Y, FRAMES.arrowGreen, { scale: ARROW_SCALE, sizeMult: 2.2 }));
      out.push(...spriteButton(art, "next", cx + ARROW_OFFSET, GRID_CENTRE_Y, FRAMES.arrowGreen, { scale: ARROW_SCALE, sizeMult: 2.2, flipX: true }));
      out.push(...pageDots(cx, DOTS_Y, pages, this.page, DOT_PITCH, DOT_SCALE));
    }
    return out;
  }

  private gridRect(view: UiViewport): Rect {
    return rect(view.width / 2 - GRID_PANEL.w / 2, GRID_CENTRE_Y - GRID_PANEL.h / 2, GRID_PANEL.w, GRID_PANEL.h);
  }

  /** Where cell `i` of the page is. */
  private cellAt(view: UiViewport, i: number): { x: number; y: number } {
    const col = i % GRID_COLUMNS;
    const row = Math.floor(i / GRID_COLUMNS);
    return { x: view.width / 2 + (col - (GRID_COLUMNS - 1) / 2) * CELL_PITCH, y: GRID_CENTRE_Y + (1 - row) * CELL_PITCH };
  }

  private tabRow(view: UiViewport): Widget[] {
    const art = this.art;
    const tabs = this.tabs();
    const y = view.height / 2 + TABS_ABOVE_CENTRE;
    const pitch = (art.quad(FRAMES.tabCubeOff)?.w ?? 36) * TAB_SCALE + TAB_GAP;
    const left = view.width / 2 - ((tabs.length - 1) * pitch) / 2;
    const out: Widget[] = [];
    tabs.forEach((tab, i) => {
      out.push(...spriteButton(art, `kind:${tab.kind}`, left + i * pitch, y, tab.kind === this.kind ? tab.on : tab.off, { scale: TAB_SCALE, sizeMult: 1.2 }));
    });
    return out;
  }

  /** In colour mode the tab row is the two colour slots and the glow switch. */
  private colourRow(view: UiViewport): Widget[] {
    const y = view.height / 2 + TABS_ABOVE_CENTRE;
    const cx = view.width / 2;
    const look = this.game.save.get().player;
    const out: Widget[] = [];
    const slots: Array<{ slot: 1 | 2; text: string; x: number }> = [
      { slot: 1, text: "Col 1", x: cx - 90 },
      { slot: 2, text: "Col 2", x: cx },
    ];
    for (const s of slots) {
      out.push({
        kind: "button",
        id: `slot:${s.slot}`,
        rect: rect(s.x - 34, y - 12, 68, 24),
        frame: this.slot === s.slot ? FRAMES.buttonGreen : FRAMES.button,
        label: { text: s.text, scale: 0.3 },
      });
    }
    out.push({ kind: "toggle", id: "glow", rect: rect(cx + 60, y - 11, 22, 22), on: look.glow, label: { text: "Glow", scale: 0.3 } });
    return out;
  }

  private iconCells(view: UiViewport): Widget[] {
    const ids = this.ids();
    const look = this.game.save.get().player;
    const progress = this.progress();
    const achievements = this.game.strings.achievements();
    const chosen = look.icons[this.kind];
    const out: Widget[] = [];
    for (let i = 0; i < PER_PAGE; i++) {
      const id = ids[this.page * PER_PAGE + i];
      if (id === undefined) break;
      const { x, y } = this.cellAt(view, i);
      const state = availability(this.kind, id, achievements, progress);
      const locked = state.state !== "unlocked";
      out.push({
        kind: "icon",
        x,
        y,
        iconKind: this.kind,
        iconId: id,
        scale: ICON_SCALE,
        colour1: look.colour1,
        colour2: look.colour2,
        glow: false,
        darken: locked ? LOCKED_TINT : undefined,
        alpha: locked ? LOCKED_ALPHA : 1,
      });
      if (locked) out.push({ kind: "sprite", x, y, frame: FRAMES.lockGrey, scale: 0.8, tint: LOCK_TINT, alpha: LOCK_ALPHA });
      if (id === chosen) out.push({ kind: "sprite", x, y, frame: FRAMES.select, scale: SELECT_SCALE });
      out.push({ kind: "button", id: `icon:${id}`, rect: rect(x - CELL_PITCH / 2, y - CELL_PITCH / 2, CELL_PITCH, CELL_PITCH), label: { text: "", scale: 0 }, tint: TRANSPARENT });
    }
    return out;
  }

  private colourCells(view: UiViewport): Widget[] {
    const count = this.game.strings.playerColourCount;
    const look = this.game.save.get().player;
    const progress = this.progress();
    const achievements = this.game.strings.achievements();
    const kind: RewardKind = this.slot === 1 ? "colour1" : "colour2";
    const chosen = this.slot === 1 ? look.colour1 : look.colour2;
    const out: Widget[] = [];
    for (let i = 0; i < PER_PAGE; i++) {
      const index = this.page * PER_PAGE + i;
      if (index >= count) break;
      const { x, y } = this.cellAt(view, i);
      const colour = this.game.strings.playerColour(index);
      const state = availability(kind, index, achievements, progress);
      const locked = state.state !== "unlocked";
      out.push({ kind: "fill", rect: rect(x - 9, y - 9, 18, 18), tint: colour, alpha: locked ? 0.3 : 1 });
      if (locked) out.push({ kind: "sprite", x, y, frame: FRAMES.lockGrey, scale: 0.8, tint: LOCK_TINT, alpha: LOCK_ALPHA });
      if (index === chosen) out.push({ kind: "sprite", x, y, frame: FRAMES.select, scale: SELECT_SCALE });
      out.push({ kind: "button", id: `colour:${index}`, rect: rect(x - CELL_PITCH / 2, y - CELL_PITCH / 2, CELL_PITCH, CELL_PITCH), label: { text: "", scale: 0 }, tint: TRANSPARENT });
    }
    return out;
  }

  /** What to tell the player about something they cannot wear yet. */
  private explain(state: Availability): string {
    if (state.state === "unlocked") return "";
    if (state.state === "elsewhere") return "Earned in a part of the game that isn't here yet.";
    const facts = this.game.strings.achievement(state.achievement);
    if (!facts) return "Locked.";
    return `Locked: ${describeAchievement(state.achievement, facts, (id) => this.game.levelName(id)).toLowerCase()}.`;
  }

  onPress(id: string): boolean {
    const progress = this.progress();
    const achievements = this.game.strings.achievements();
    if (id === "back") {
      this.game.audio.ui("back");
      this.game.stack.pop();
      return true;
    }
    if (id === "prev" || id === "next") {
      // The ends wrap round. [gdp GJGarageLayer::onArrow :335372]
      const pages = this.pageCount();
      this.page = (this.page + (id === "next" ? 1 : -1) + pages) % pages;
      this.hint = "";
      return true;
    }
    if (id === "paint") {
      this.mode = this.mode === "icons" ? "colours" : "icons";
      this.page = 0;
      this.hint = "";
      return true;
    }
    if (id.startsWith("kind:")) {
      this.kind = id.slice(5) as IconKind;
      this.page = 0;
      this.hint = "";
      return true;
    }
    if (id.startsWith("slot:")) {
      this.slot = id.endsWith("2") ? 2 : 1;
      this.hint = "";
      return true;
    }
    if (id === "glow") {
      this.game.save.set((s) => void (s.player.glow = !s.player.glow));
      return true;
    }
    if (id.startsWith("icon:")) {
      const icon = Number(id.slice(5));
      const state = availability(this.kind, icon, achievements, progress);
      if (state.state !== "unlocked") {
        this.hint = this.explain(state);
        return true;
      }
      this.hint = "";
      this.game.save.set((s) => void (s.player.icons[this.kind] = icon));
      this.game.scene.refreshPlayerPages();
      return true;
    }
    if (id.startsWith("colour:")) {
      const index = Number(id.slice(7));
      const kind: RewardKind = this.slot === 1 ? "colour1" : "colour2";
      const state = availability(kind, index, achievements, progress);
      if (state.state !== "unlocked") {
        this.hint = this.explain(state);
        return true;
      }
      this.hint = "";
      this.game.save.set((s) => {
        if (this.slot === 1) s.player.colour1 = index;
        else s.player.colour2 = index;
      });
      return true;
    }
    return false;
  }

  onKey(code: string, down: boolean): boolean {
    if (!down) return false;
    if (code === "Escape") {
      this.game.stack.pop();
      return true;
    }
    if (code === "ArrowLeft") return this.onPress("prev");
    if (code === "ArrowRight") return this.onPress("next");
    return false;
  }
}
