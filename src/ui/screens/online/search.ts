// Searching the online levels: the field across the top, the nine quick
// lists under it, and the difficulty and length filters that narrow all of
// them, with the demon filter behind the plus beside the faces.
//
// [gdp LevelSearchLayer::init, gd-ida-decomp.cpp:242837-243652: the field
//  bar 365×40 at cy+130 with the search, user and clear buttons on it; the
//  quick search panel 365×115 at cy+28, three by three, 119 and 36 apart;
//  the faces at 0.8 in a row 18 apart at cy-77; the length row at cy-128;
//  close, plus and lists down the right edge 50 apart.
//  LevelSearchLayer::toggleDifficulty: unrated, demon and auto each stand
//  alone; the five plain faces go together.
//  DemonFilterSelectLayer::init: a 380×180 popup, six faces at 1.1 18 apart.]

import type { Game } from "../../../game/game";
import { LIST_TYPE, type LevelQuery } from "../../../online/api";
import { FRAMES } from "../../art";
import { backArrow, corners, gradient, label, NO_ART, shade, spriteButton, TRANSPARENT, type ArtLookup } from "../../chrome";
import type { Tint } from "../../draw";
import type { Screen } from "../../screen";
import { TextField } from "../../textField";
import { rect, type UiViewport } from "../../viewport";
import type { Widget } from "../../widgets";
import { LevelBrowserScreen } from "./browser";

const BLUE: Tint = { r: 0, g: 102, b: 255 };
const OFF: Tint = { r: 125, g: 125, b: 125 };
const PLACEHOLDER: Tint = { r: 120, g: 170, b: 240 };

/** The quick lists in the game's order, left to right, top to bottom. */
const QUICK: ReadonlyArray<{ id: string; text: string; icon: string; scale: number; type?: number; soon?: string }> = [
  { id: "q:downloads", text: "Downloads", icon: "GJ_sDownloadIcon_001.png", scale: 0.43, type: LIST_TYPE.downloads },
  { id: "q:likes", text: "Likes", icon: "GJ_sLikeIcon_001.png", scale: 0.5, type: LIST_TYPE.likes },
  { id: "q:sent", text: "Sent", icon: "GJ_sModIcon_001.png", scale: 0.5, type: LIST_TYPE.sent },
  { id: "q:trending", text: "Trending", icon: "GJ_sTrendingIcon_001.png", scale: 0.5, type: LIST_TYPE.trending },
  { id: "q:recent", text: "Recent", icon: "GJ_sRecentIcon_001.png", scale: 0.5, type: LIST_TYPE.recent },
  { id: "q:magic", text: "Magic", icon: "GJ_sMagicIcon_001.png", scale: 0.5, type: LIST_TYPE.magic },
  { id: "q:awarded", text: "Awarded", icon: "GJ_sStarsIcon_001.png", scale: 0.5, type: LIST_TYPE.awarded },
  { id: "q:followed", text: "Followed", icon: "GJ_sFollowedIcon_001.png", scale: 0.5, soon: "Following creators isn't in this version yet." },
  { id: "q:friends", text: "Friends", icon: "GJ_sFriendsIcon_001.png", scale: 0.5, soon: "Friends aren't in this version yet." },
];

/** The faces in the game's order, and the value each sends. Index 6 is demon. */
const FACES: ReadonlyArray<{ frame: string; value: string }> = [
  { frame: "difficulty_00_btn_001.png", value: "-1" },
  { frame: "difficulty_01_btn_001.png", value: "1" },
  { frame: "difficulty_02_btn_001.png", value: "2" },
  { frame: "difficulty_03_btn_001.png", value: "3" },
  { frame: "difficulty_04_btn_001.png", value: "4" },
  { frame: "difficulty_05_btn_001.png", value: "5" },
  { frame: "difficulty_06_btn_001.png", value: "-2" },
  { frame: "difficulty_auto_btn_001.png", value: "-3" },
];
const DEMON = 6;

/** The demon filter's faces, 0 any demon and 1-5 easy to extreme. */
const DEMON_FACES = [
  "difficulty_06_btn_001.png",
  "difficulty_07_btn2_001.png",
  "difficulty_08_btn2_001.png",
  "difficulty_06_btn2_001.png",
  "difficulty_09_btn2_001.png",
  "difficulty_10_btn2_001.png",
];

const LENGTHS = ["Tiny", "Short", "Medium", "Long", "XL", "Plat."];

/** The filters, kept for the session as the game keeps them between visits. */
const filters = {
  faces: new Set<number>(),
  demon: 0,
  lengths: new Set<number>(),
  star: false,
};

/** Unrated, demon and auto each stand alone; the five plain faces go together. */
function toggleFace(i: number): void {
  if (filters.faces.has(i)) {
    filters.faces.delete(i);
    return;
  }
  filters.faces.add(i);
  for (const other of [...filters.faces]) {
    if (other === i) continue;
    const plain = (n: number): boolean => n >= 1 && n <= 5;
    if (!(plain(i) && plain(other))) filters.faces.delete(other);
  }
}

function query(): Pick<LevelQuery, "diff" | "demonFilter" | "len" | "star"> {
  const faces = [...filters.faces].sort((a, b) => a - b);
  return {
    diff: faces.map((i) => FACES[i].value).join(",") || undefined,
    demonFilter: filters.faces.has(DEMON) && filters.demon > 0 ? filters.demon : undefined,
    len: [...filters.lengths].sort().join(",") || undefined,
    star: filters.star || undefined,
  };
}

export class SearchScreen implements Screen {
  readonly name = "search";
  readonly opaque = true;
  private readonly field: TextField;

  constructor(private readonly game: Game) {
    this.field = new TextField({ maxLength: 20, onSubmit: () => this.search(), allowed: /[A-Za-z0-9 ]/ });
  }

  exit(): void {
    this.field.dispose();
  }

  private get art(): ArtLookup {
    return this.game.ui?.art ?? NO_ART;
  }

  private open(title: string, q: LevelQuery): void {
    this.field.blur();
    this.game.audio.ui("play");
    this.game.stack.push(new LevelBrowserScreen(this.game, title, { kind: "query", query: { ...q, ...query() } }));
  }

  private search(): void {
    const text = this.field.value.trim();
    if (!text) {
      this.field.focus();
      return;
    }
    this.open(/^\d+$/.test(text) ? `Level ${text}` : `"${text}"`, { type: LIST_TYPE.search, str: text });
  }

  private searchUser(): void {
    const text = this.field.value.trim();
    if (!text) {
      this.field.focus();
      return;
    }
    this.open(text, { type: LIST_TYPE.byUser, str: text });
  }

  build(view: UiViewport): Widget[] {
    const art = this.art;
    const w = view.width;
    const h = view.height;
    const cx = w / 2;
    const cy = h / 2;
    const out: Widget[] = [gradient(view, BLUE), ...corners(view, ["bottomLeft", "bottomRight"])];
    const box = (x: number, y: number, bw: number, bh: number, tint: Tint, frame: string = FRAMES.squareTight): Widget => ({
      kind: "panel",
      rect: rect(x - bw / 2, y - bh / 2, bw, bh),
      frame,
      tint,
    });

    // The field bar.
    const barY = cy + 130;
    out.push(box(cx, barY, 365, 40, { r: 0, g: 56, b: 141 }));
    out.push(box(cx - 73, barY, 210, 30, { r: 0, g: 39, b: 98 }, FRAMES.squareTightSmall));
    out.push({ kind: "button", id: "field", rect: rect(cx - 178, barY - 15, 210, 30), label: { text: "", scale: 0 }, tint: TRANSPARENT });
    const value = this.field.value;
    const focused = this.field.focused;
    const caret = focused && Math.floor(performance.now() / 500) % 2 === 0 ? "|" : "";
    const shown = value || focused ? value + caret : "Enter a level, user or id";
    out.push(
      label(art, shown, cx - 174, barY, {
        scale: art.fit?.("bigFont", shown, 194, 0.7) ?? 0.5,
        anchorX: 0,
        tint: value || focused ? undefined : PLACEHOLDER,
      }),
    );
    out.push(...spriteButton(art, "search", cx + 63, barY, "GJ_longBtn06_001.png"));
    out.push(...spriteButton(art, "user", cx + 110, barY, "GJ_longBtn05_001.png"));
    out.push(...spriteButton(art, "clearText", cx + 157, barY, "GJ_longBtn07_001.png"));

    // Quick search.
    const quickY = cy + 28;
    out.push(label(art, "Quick Search", cx, cy + 97.5, { scale: 0.5 }));
    out.push(box(cx, quickY, 365, 115, { r: 0, g: 46, b: 117 }));
    QUICK.forEach((q, i) => {
      const x = cx + ((i % 3) - 1) * 119;
      const y = quickY + 36 - Math.floor(i / 3) * 36;
      out.push(...this.quickButton(art, q, x, y));
    });

    // The difficulty faces, and the demon filter's plus once demon is on.
    const faceY = cy - 77;
    out.push(label(art, "Filters", cx, cy - 40, { scale: 0.5 }));
    out.push(box(cx, faceY, 365, 50, { r: 0, g: 36, b: 91 }));
    // The demon face shows the chosen demon whether or not it is on. [:243645-243648]
    const faces = FACES.map((f, i) => (i === DEMON ? DEMON_FACES[filters.demon] : f.frame));
    this.row(faces.map((frame) => ({ w: (art.quad(frame)?.w ?? 30) * 0.8 })), 18, cx).forEach((x, i) => {
      out.push(...spriteButton(art, `d:${i}`, x, faceY, faces[i], { scale: 0.8, sizeMult: 1.5, tint: filters.faces.has(i) ? undefined : OFF }));
    });
    if (filters.faces.has(DEMON)) out.push(...spriteButton(art, "demonFilter", cx + 202.5, faceY, "GJ_plus2Btn_001.png"));

    // The length row: the clock, the six lengths, and the star.
    const lenY = cy - 128;
    out.push(box(cx, lenY, 365, 35, { r: 0, g: 31, b: 79 }));
    const lenScale = 0.42;
    const items = [
      { w: art.quad(FRAMES.length)?.w ?? 20 },
      ...LENGTHS.map((t) => ({ w: art.measure?.("bigFont", t, { scale: lenScale }).width ?? 30 })),
      { w: art.quad(FRAMES.star)?.w ?? 20 },
    ];
    const xs = this.row(items, 12, cx);
    out.push({ kind: "sprite", x: xs[0], y: lenY, frame: FRAMES.length });
    LENGTHS.forEach((text, i) => {
      const x = xs[i + 1];
      const iw = items[i + 1].w * 1.3;
      out.push(label(art, text, x, lenY, { scale: lenScale, tint: filters.lengths.has(i) ? undefined : OFF }));
      out.push({ kind: "button", id: `l:${i}`, rect: rect(x - iw / 2, lenY - 14, iw, 28), label: { text: "", scale: 0 }, tint: TRANSPARENT });
    });
    out.push(...spriteButton(art, "star", xs[xs.length - 1], lenY, FRAMES.star, { sizeMult: 1.3, tint: filters.star ? undefined : OFF }));

    // Down the right edge.
    out.push(...spriteButton(art, "clearFilters", w - 25, h - 25, FRAMES.close, { scale: 0.8 }));
    out.push(...spriteButton(art, "more", w - 25, h - 75, "GJ_plusBtn_001.png", { scale: 0.8, sizeMult: 1.5 }));
    out.push(...spriteButton(art, "lists", w - 25, h - 125, "GJ_viewListsBtn_001.png", { scale: 0.8 }));
    out.push(...backArrow(art, view, "green"));
    return out;
  }

  /** Centres of items laid side by side with a gap between, centred on `cx`. */
  private row(items: ReadonlyArray<{ w: number }>, gap: number, cx: number): number[] {
    const total = items.reduce((s, it) => s + it.w, 0) + gap * (items.length - 1);
    let x = cx - total / 2;
    return items.map((it) => {
      const mid = x + it.w / 2;
      x += it.w + gap;
      return mid;
    });
  }

  /**
   * One quick search button: the long frame, its name, and the small icon
   * after it, the two centred together. [SearchButton::init]
   */
  private quickButton(art: ArtLookup, q: (typeof QUICK)[number], x: number, y: number): Widget[] {
    const iconW = (art.quad(q.icon)?.w ?? 12) * 1.1;
    const textW = (art.measure?.("bigFont", q.text, { scale: q.scale }).width ?? 50) + 5;
    const half = (iconW / 2 + textW + 10) / 2;
    return [
      ...spriteButton(art, q.id, x, y, "GJ_longBtn04_001.png"),
      label(art, q.text, x - half + textW / 2 - 1, y + 1, { scale: q.scale }),
      { kind: "sprite", x: x + half - iconW / 2, y, frame: q.icon, scale: 1.1, pressedBy: q.id },
    ];
  }

  onPress(id: string): boolean {
    if (id === "field") {
      this.field.focus();
      return true;
    }
    this.field.blur();
    const say = (text: string): true => {
      this.game.say(text);
      return true;
    };
    switch (id) {
      case "back":
        this.game.audio.ui("back");
        this.game.stack.pop();
        return true;
      case "search":
        this.search();
        return true;
      case "user":
        this.searchUser();
        return true;
      case "clearText":
        this.field.value = "";
        return true;
      case "clearFilters":
        filters.faces.clear();
        filters.demon = 0;
        filters.lengths.clear();
        filters.star = false;
        return true;
      case "more":
        return say("More search options aren't in this version yet.");
      case "lists":
        return say("Lists aren't in this version yet.");
      case "star":
        filters.star = !filters.star;
        return true;
      case "demonFilter":
        this.game.stack.push(new DemonFilterScreen(this.game));
        return true;
    }
    const quick = QUICK.find((q) => q.id === id);
    if (quick) {
      if (quick.type === undefined) return say(quick.soon ?? "This isn't in this version yet.");
      this.open(quick.text, { type: quick.type, str: "" });
      return true;
    }
    if (id.startsWith("d:")) {
      toggleFace(Number(id.slice(2)));
      return true;
    }
    if (id.startsWith("l:")) {
      const n = Number(id.slice(2));
      if (filters.lengths.has(n)) filters.lengths.delete(n);
      else filters.lengths.add(n);
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

/** The popup behind the plus: which demons the demon face finds. */
class DemonFilterScreen implements Screen {
  readonly name = "demonFilter";
  readonly opaque = false;
  readonly ticksBelow = false;
  private pick = filters.demon;

  constructor(private readonly game: Game) {}

  build(view: UiViewport): Widget[] {
    const art: ArtLookup = this.game.ui?.art ?? NO_ART;
    const cx = view.width / 2;
    const cy = view.height / 2;
    const out: Widget[] = [shade(view, 0.5), { kind: "panel", rect: rect(cx - 190, cy - 90, 380, 180), frame: FRAMES.panel }];
    out.push(label(art, "Demon Filter", cx, cy + 70, { scale: 0.8 }));
    const ws = DEMON_FACES.map((f) => (art.quad(f)?.w ?? 30) * 1.1);
    const total = ws.reduce((s, x) => s + x, 0) + 18 * (ws.length - 1);
    let x = cx - total / 2;
    DEMON_FACES.forEach((frame, i) => {
      out.push(...spriteButton(art, `f:${i}`, x + ws[i] / 2, cy + 3, frame, { scale: 1.1, tint: i === this.pick ? undefined : OFF }));
      x += ws[i] + 18;
    });
    out.push({ kind: "button", id: "ok", rect: rect(cx - 30, cy - 80, 60, 30), frame: FRAMES.button, label: { text: "OK", scale: 0.6 } });
    return out;
  }

  private close(): void {
    this.game.stack.pop();
  }

  onPress(id: string): boolean {
    if (id === "ok") {
      filters.demon = this.pick;
      this.close();
      return true;
    }
    if (id.startsWith("f:")) {
      this.pick = Number(id.slice(2));
      return true;
    }
    return true;
  }

  onKey(code: string, down: boolean): boolean {
    if (down && code === "Escape") this.close();
    return true;
  }
}
