// Picking a level: one page per level, swiped or paged through, the way the
// game's level select goes.
//
// Every position is `LevelSelectLayer::init` and `LevelPage::init`: the block
// strip hanging from the top, the stair-step corners, the big white arrows 25
// in from each edge, the level's panel 340 by 95 standing 60 above the centre,
// the two bars 30 and 80 below it, the stars top right of the panel and the
// coins bottom right. The sky behind is the game's own colour for the page,
// blended into the next one's as the pages slide.

import { OFFICIAL_LEVELS } from "../../assets/levels";
import { DEMO_LEVELS, demoLevel } from "../../game/demoLevel";
import type { Game } from "../../game/game";
import { FRAMES, levelPageFace } from "../art";
import { backArrow, corners, gradient, label, NO_ART, popup, scrollDots, shade, spriteButton, TRANSPARENT, type ArtLookup } from "../chrome";
import { SongsScreen } from "./settings";
import type { Tint } from "../draw";
import { UI_COLOURS } from "../render";
import type { Screen } from "../screen";
import { rect, type Rect, type UiViewport } from "../viewport";
import { snapPage, type Widget } from "../widgets";

/** The level panel. [gdp LevelPage::init :338762-338780] */
const PANEL_W = 340;
const PANEL_H = 95;
const PANEL_ABOVE_CENTRE = 60;
/** The panel is the game's black square at a little over half strength. [meas] */
const PANEL_ALPHA = 0.55;
/** The two bars. [:338818, :338850] */
const NORMAL_BAR_BELOW_CENTRE = 30;
const PRACTICE_BAR_BELOW_CENTRE = 80;
/** The stars sit in the panel's top-right corner, the coins in its bottom-right. [:338940, :338964] */
const STAR_INSET = { x: 15, y: 13 };
const COIN_INSET = { x: 16, y: 16 };
const COIN_PITCH = 26;
/** The title fits this width at most, beside its face. [meas] */
const TITLE_MAX_WIDTH = 250;
/** How fast a page settles after a swipe. [meas] */
const SETTLE_RATE = 12;

/**
 * The sky colour behind each page: the game's colour table by page number,
 * with the Tower's own dark slate every 22nd page.
 * [gdp LevelSelectLayer::colorForPage, gd-ida-decomp.cpp:338333-338410]
 */
export function pageColourIndex(page: number): number | "tower" {
  if (page === 0) return 5;
  if (page % 22 === 0) return "tower";
  switch (page) {
    case 1:
      return 7;
    case 2:
      return 8;
    case 3:
      return 9;
    case 4:
      return 10;
    case 5:
      return 11;
    case 6:
      return 1;
    case 7:
      return 3;
    case 8:
      return 4;
    default:
      return pageColourIndex(page % 9);
  }
}

const TOWER_SKY: Tint = { r: 37, g: 44, b: 52 };

/** The Tower's four floors, which its page opens rather than each having a page. */
const TOWER_FLOORS = OFFICIAL_LEVELS.filter((l) => l.id > 5000);

/**
 * One page: a level, the Tower, or the closing Coming Soon. `colour` is the
 * page number the game would give its sky.
 */
type Page = { kind: "level"; id: number; name: string; colour: number } | { kind: "tower"; colour: number } | { kind: "soon"; colour: number };

/**
 * The game's order: the 22 main levels, the Tower, then Coming Soon last.
 * The Challenge and the online demo levels (demoLevel.ts) sit after the
 * Tower, where they don't move any of the game's pages.
 * [gdp LevelSelectLayer::init :339312-339344]
 */
const PAGES: readonly Page[] = (() => {
  const main = OFFICIAL_LEVELS.filter((l) => l.id <= 22);
  const extras = [...OFFICIAL_LEVELS.filter((l) => l.id > 22 && l.id < 5000), ...DEMO_LEVELS];
  return [
    ...main.map((l, i): Page => ({ kind: "level", id: l.id, name: l.name, colour: i })),
    { kind: "tower", colour: 22 },
    ...extras.map((l, i): Page => ({ kind: "level", id: l.id, name: l.name, colour: 24 + i })),
    { kind: "soon", colour: 23 },
  ];
})();

/** Where the ground's line is. [gdp LevelSelectLayer::init :339264-339267, min(h / 2 - 110, 128)] */
function groundTop(view: UiViewport): number {
  return Math.min(view.height / 2 - 110, 128);
}

/** The ground is the sky at four fifths. [gdp LevelSelectLayer::updateColors :338500] */
const GROUND_SHADE = 0.8;

/** The Tower's door bobs 5 up and back over 2.5 s each way. [gdp LevelPage::updateDynamicPage :340228-340245] */
const DOOR_BOB = { distance: 5, seconds: 2.5 };

/** The completed star count's colour. [:340450-340460] */
const STARS_DONE: Tint = { r: 255, g: 255, b: 50 };

/**
 * The orbs a level gives for its whole run, and a quarter more again once it
 * is finished: twenty a star and twenty more, or 400 for the three levels the
 * game singles out. [gdp GameStatsManager::getBaseCurrency :342949-342970,
 *  getAwardedCurrencyForLevel :343034-343075]
 */
function baseOrbs(id: number, stars: number): number {
  return id === 14 || id === 18 || id === 20 ? 400 : 20 * stars + 20;
}

function awardedOrbs(base: number, best: number): number {
  return best > 99 ? Math.trunc(base * 0.25) + base : Math.floor(base * (best / 100));
}

function lerp(a: Tint, b: Tint, t: number): Tint {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

export class LevelSelectScreen implements Screen {
  readonly name = "levels";
  readonly opaque = true;
  /** How far the pages have slid, in units; page n sits at n times the width. */
  private offset = 0;
  private page = 0;
  private dragging = false;
  private lastDx = 0;
  private info = false;
  private tower = false;
  private wheelCooldown = 0;
  private clock = 0;

  constructor(private readonly game: Game) {
    // Open on the level played last, the way the game remembers its page.
    let best = -1;
    let recent = "";
    PAGES.forEach((page, i) => {
      if (page.kind !== "level") return;
      const progress = this.game.save.get().levels[page.id];
      const at = progress?.firstCompletedAt ?? (progress && progress.attempts > 0 ? "0" : "");
      if (at && at >= recent) {
        recent = at;
        best = i;
      }
    });
    if (best >= 0) this.page = best;
  }

  private get popupOpen(): boolean {
    return this.info || this.tower;
  }

  enter(): void {
    this.offset = this.page * this.game.view.width;
  }

  update(dt: number): void {
    this.clock += dt;
    this.wheelCooldown = Math.max(0, this.wheelCooldown - dt);
    if (this.dragging) return;
    const target = this.page * this.game.view.width;
    const gap = target - this.offset;
    if (Math.abs(gap) < 0.5) {
      this.offset = target;
      return;
    }
    this.offset += gap * Math.min(1, dt * SETTLE_RATE);
  }

  private get art(): ArtLookup {
    return this.game.ui?.art ?? NO_ART;
  }

  private skyTint(): Tint {
    const width = this.game.view.width;
    const at = Math.max(0, this.offset / width);
    const from = Math.floor(at);
    const t = at - from;
    const colour = (page: number): Tint => {
      const index = pageColourIndex(PAGES[page]?.colour ?? page);
      if (index === "tower" || !this.game.strings) return TOWER_SKY;
      return this.game.strings.playerColour(index);
    };
    return lerp(colour(from), colour(Math.min(PAGES.length - 1, from + 1)), t);
  }

  build(view: UiViewport): Widget[] {
    const art = this.art;
    const w = view.width;
    const h = view.height;
    const out: Widget[] = [];
    const sky = this.skyTint();
    out.push(gradient(view, sky));
    const ground = groundTop(view);
    out.push({ kind: "backdrop", tint: sky, groundTint: { r: sky.r * GROUND_SHADE, g: sky.g * GROUND_SHADE, b: sky.b * GROUND_SHADE }, offset: 0, groundTop: ground, noSky: true });
    out.push({ kind: "fill", rect: { x: 0, y: ground - 0.75, w, h: 1.5 }, frame: FRAMES.floorLine, tint: { r: 255, g: 255, b: 255, additive: true } });

    // The pages, side by side.
    const rows = PAGES.map((page) => this.pageWidgets(page, view));
    out.push({ kind: "list", id: "pages", rect: rect(0, 0, w, h), rowSize: w, rows, scroll: this.offset, horizontal: true });

    // The chrome over them. The arrow art points right. [gdp LevelSelectLayer::init :339374-339463]
    out.push({ kind: "sprite", x: w / 2, y: h + 1, frame: FRAMES.topBar, originY: 1 });
    out.push(...corners(view, ["bottomLeft", "bottomRight"]));
    out.push(...spriteButton(art, "prev", 25, h / 2, FRAMES.navArrow, { sizeMult: 2, flipX: true }));
    out.push(...spriteButton(art, "next", w - 25, h / 2, FRAMES.navArrow, { sizeMult: 2 }));
    out.push(...backArrow(art, view, "green"));
    out.push(...spriteButton(art, "info", w - 20, h - 20, FRAMES.infoIcon, { sizeMult: 2 }));
    out.push(...scrollDots(art, w / 2, 15, PAGES.length, this.page));
    // Opens the soundtrack list over this screen. [gdp LevelSelectLayer::onDownload :337454]
    const download = "Download the soundtrack";
    const downloadW = (art.measure?.("bigFont", download, { scale: 0.5 }).width ?? 200) * 1.1;
    out.push(label(art, download, w / 2, 35, { scale: 0.5 }));
    out.push({ kind: "button", id: "soundtrack", rect: rect(w / 2 - downloadW / 2, 25, downloadW, 20), label: { text: "", scale: 0 }, tint: TRANSPARENT });

    const page = PAGES[this.page];
    if (this.info && page?.kind === "level") out.push(...this.infoPopup(view, page.id));
    if (this.tower) out.push(...this.towerPopup(view));
    return out;
  }

  /** The Tower's floors, one button each. */
  private towerPopup(view: UiViewport): Widget[] {
    const art = this.art;
    const cx = view.width / 2;
    const cy = view.height / 2;
    const box = rect(cx - 150, cy - 105, 300, 210);
    const out: Widget[] = [shade(view, 0.5), ...popup(art, box)];
    out.push(label(art, "The Tower", cx, box.y + box.h - 28, { scale: 0.8 }));
    TOWER_FLOORS.forEach((floor, i) => {
      const y = box.y + box.h - 68 - i * 36;
      out.push({ kind: "button", id: `level:${floor.id}`, rect: rect(cx - 100, y - 15, 200, 30), frame: FRAMES.button, label: { text: floor.name, font: "goldFont", scale: 0.7 } });
    });
    return out;
  }

  /** One page, laid out relative to its own box. [gdp LevelPage::init, LevelPage::updateDynamicPage] */
  private pageWidgets(page: Page, view: UiViewport): Widget[] {
    const art = this.art;
    const cx = view.width / 2;
    const cy = view.height / 2;
    if (page.kind === "soon") return [label(art, "Coming Soon!", cx, cy + 50)];
    if (page.kind === "tower") {
      // The door, the label 23 above its top, the whole thing bobbing. [:340210-340245]
      const door = art.quad(FRAMES.towerDoor);
      const doorH = door?.h ?? 100;
      const phase = (this.clock % (DOOR_BOB.seconds * 2)) / DOOR_BOB.seconds;
      const eased = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));
      const bob = DOOR_BOB.distance * (phase < 1 ? eased(phase) : 1 - eased(phase - 1));
      const y = cy - 5 + bob;
      return [
        ...spriteButton(art, "tower", cx, y, FRAMES.towerDoor),
        { kind: "sprite", x: cx, y: y + doorH / 2 + 23, frame: FRAMES.towerLabel },
      ];
    }
    const { id, name } = page;
    const demo = demoLevel(id);
    const progress = demo ? this.game.save.onlineLevel(id) : this.game.save.level(id);
    const facts = this.game.strings.facts(id);
    const stars = demo ? demo.stars : (facts?.stars ?? 0);
    const out: Widget[] = [];

    const panel: Rect = rect(cx - PANEL_W / 2, cy + PANEL_ABOVE_CENTRE - PANEL_H / 2, PANEL_W, PANEL_H);
    out.push({ kind: "panel", rect: panel, frame: FRAMES.squareBlack, alpha: PANEL_ALPHA });
    out.push({ kind: "button", id: `level:${id}`, rect: panel, label: { text: "", scale: 0 }, tint: { r: 255, g: 255, b: 255, a: 0 } });

    // The face and the name, centred together: the face's half, the name at
    // its fitted scale, and the 35 between and around them. [:340430-340445]
    const face = facts ? levelPageFace(facts) : levelPageFace({ difficulty: 0, demon: demo !== undefined });
    const faceW = art.quad(face)?.w ?? 30;
    const scale = art.fit?.("bigFont", name, TITLE_MAX_WIDTH, 1) ?? 0.8;
    const titleW = art.measure?.("bigFont", name, { scale }).width ?? 0;
    const group = faceW / 2 + titleW + 5 + 30;
    const faceX = panel.x + PANEL_W / 2 - group / 2 + faceW / 2;
    const midY = panel.y + PANEL_H / 2 + 3;
    out.push({ kind: "sprite", x: faceX, y: midY, frame: face });
    out.push(label(art, name, faceX + 30, midY, { scale, anchorX: 0 }));

    // Stars top right, when the level awards any.
    const done = progress.completions > 0;
    if (stars > 0) {
      const starX = panel.x + PANEL_W - STAR_INSET.x;
      const starY = panel.y + PANEL_H - STAR_INSET.y;
      out.push({ kind: "sprite", x: starX, y: starY, frame: done ? FRAMES.star : FRAMES.starGrey, scale: 0.55 });
      out.push(label(art, String(stars), starX - 12, starY + 0.5, { scale: 0.5, anchorX: 1, tint: done ? STARS_DONE : undefined }));
    }

    if (demo) {
      // Where an official level's coins and orbs go, what this one is and who made it.
      out.push(label(art, "ONLINE DEMO LEVEL", panel.x + 8, panel.y + 12, { scale: 0.4, anchorX: 0, tint: STARS_DONE }));
      out.push(label(art, `by ${demo.author}`, panel.x + PANEL_W - 10, panel.y + 12, { font: "goldFont", scale: 0.5, anchorX: 1 }));
    } else {
      // The orbs, bottom left: what this level has given of what it can.
      // [LevelPage::updateDynamicPage :340497-340530: bigFont 0.4 at (8, 12), the orb at 0.7 after it]
      const base = baseOrbs(id, stars);
      if (base > 0) {
        const text = `${awardedOrbs(base, progress.best)}/${base + Math.trunc(base * 0.25)}`;
        const textW = art.measure?.("bigFont", text, { scale: 0.4 }).width ?? 30;
        out.push(label(art, text, panel.x + 8, panel.y + 12, { scale: 0.4, anchorX: 0 }));
        out.push({ kind: "sprite", x: panel.x + 8 + textW + 9, y: panel.y + 11.5, frame: "currencyOrbIcon_001.png", scale: 0.7 });
      }
    }

    // The three coins, bottom right, right to left. [:340500-340530]
    for (let i = 0; i < 3 && !demo; i++) {
      out.push({
        kind: "sprite",
        x: panel.x + PANEL_W - COIN_INSET.x - i * COIN_PITCH,
        y: panel.y + COIN_INSET.y,
        frame: progress.coins[2 - i] ? FRAMES.coin : FRAMES.coinGrey,
      });
    }

    // The two bars and their names. [:338818-338900]
    const bars: Array<{ y: number; title: string; value: number; fill: Tint }> = [
      { y: cy - NORMAL_BAR_BELOW_CENTRE, title: "Normal Mode", value: progress.best, fill: UI_COLOURS.barNormal },
      { y: cy - PRACTICE_BAR_BELOW_CENTRE, title: "Practice Mode", value: progress.practiceBest, fill: UI_COLOURS.barPractice },
    ];
    for (const bar of bars) {
      out.push({ kind: "progress", x: cx, y: bar.y, frame: FRAMES.progressBar, value: bar.value / 100, fill: bar.fill });
      out.push(label(art, bar.title, cx, bar.y + 20, { scale: 0.5 }));
      out.push(label(art, `${Math.floor(bar.value)}%`, cx, bar.y, { scale: 0.5 }));
    }
    return out;
  }

  /** What the info button shows: the song and the numbers behind the bars. */
  private infoPopup(view: UiViewport, id: number): Widget[] {
    const art = this.art;
    const cx = view.width / 2;
    const cy = view.height / 2;
    const box = rect(cx - 170, cy - 90, 340, 180);
    const demo = demoLevel(id);
    const song = demo ? { title: demo.song, artist: demo.artist } : this.game.strings.songForLevel(id);
    const progress = demo ? this.game.save.onlineLevel(id) : this.game.save.level(id);
    const name = demo ? demo.name : this.game.levelName(id);
    const out: Widget[] = [shade(view, 0.5), ...popup(art, box)];
    out.push(label(art, name, cx, box.y + box.h - 30, { scale: art.fit?.("bigFont", name, 300, 0.7) ?? 0.6 }));
    if (song) {
      out.push(label(art, song.title, cx, box.y + box.h - 62, { font: "goldFont", scale: 0.55, maxWidth: 300 }));
      if (song.artist) out.push(label(art, `by ${song.artist}`, cx, box.y + box.h - 82, { font: "goldFont", scale: 0.45 }));
    }
    const lines = [`Attempts: ${progress.attempts}`, `Completions: ${progress.completions}`];
    if (!demo) lines.push(`Coins: ${progress.coins.filter(Boolean).length} of 3`);
    lines.forEach((line, i) => out.push(label(art, line, cx, box.y + 62 - i * 20, { font: "goldFont", scale: 0.5 })));
    return out;
  }

  private go(delta: number): void {
    const n = PAGES.length;
    this.page = Math.max(0, Math.min(n - 1, this.page + delta));
  }

  onPress(id: string): boolean {
    if (this.tower && id.startsWith("level:")) {
      this.tower = false;
    } else if (this.popupOpen) {
      if (id === "close") {
        this.info = false;
        this.tower = false;
      }
      return true;
    }
    if (id === "tower") {
      this.tower = true;
      return true;
    }
    if (id === "soundtrack") {
      this.game.stack.push(new SongsScreen(this.game, false));
      return true;
    }
    if (id === "back") {
      this.game.audio.ui("back");
      this.game.stack.pop();
      return true;
    }
    if (id === "prev") {
      this.go(-1);
      return true;
    }
    if (id === "next") {
      this.go(1);
      return true;
    }
    if (id === "info") {
      this.info = true;
      return true;
    }
    if (id.startsWith("level:")) {
      this.game.audio.ui("play");
      this.start(Number(id.slice(6)));
      return true;
    }
    return false;
  }

  onDrag(id: string, dx: number, dy: number): boolean {
    if (id !== "pages" || this.popupOpen) return false;
    // A wheel arrives as a vertical delta with no horizontal one: a page a notch.
    if (dx === 0 && dy !== 0) {
      if (this.wheelCooldown <= 0) {
        this.go(dy > 0 ? 1 : -1);
        this.wheelCooldown = 0.3;
      }
      return true;
    }
    this.dragging = true;
    this.lastDx = dx;
    const width = this.game.view.width;
    const max = (PAGES.length - 1) * width;
    this.offset = Math.max(-width * 0.25, Math.min(max + width * 0.25, this.offset - dx));
    return true;
  }

  onRelease(id: string): void {
    if (id !== "pages" || !this.dragging) return;
    this.dragging = false;
    this.page = snapPage(this.offset, this.game.view.width, PAGES.length, -this.lastDx);
  }

  onKey(code: string, down: boolean): boolean {
    if (!down) return false;
    if (code === "Escape") {
      if (this.popupOpen) {
        this.info = false;
        this.tower = false;
      } else this.game.stack.pop();
      return true;
    }
    if (code === "ArrowLeft") {
      this.go(-1);
      return true;
    }
    if (code === "ArrowRight") {
      this.go(1);
      return true;
    }
    if (code === "Enter" || code === "Space") {
      const page = PAGES[this.page];
      if (page?.kind === "level") {
        this.game.audio.ui("play");
        this.start(page.id);
      } else if (page?.kind === "tower") this.tower = true;
      return true;
    }
    return false;
  }

  private start(id: number): void {
    if (demoLevel(id)) void this.game.startDemoLevel(id);
    else void this.game.startLevel(id, false);
  }
}
