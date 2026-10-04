// The creator page: the game's grid of fifteen tiles behind the hammer.
//
// The online levels are behind Saved, Daily, Weekly, Event, Gauntlets,
// Featured, Map Packs and Search. The rest — the editor, the leaderboards,
// the quests, the lists, the paths, the map — lead somewhere this port does
// not go yet, and tapping one says so in one line instead of pretending. The
// two the game itself greys out (Versus and The Map) are greyed here too.
//
// [gdp CreatorLayer::init, gd-ida-decomp.cpp:239289-239720: five columns 90
//  apart at eight tenths, three rows 90 apart about the centre, the vault
//  lock top right, the secret door bottom right, the pink arrow back]

import type { Game } from "../../game/game";
import { LIST_TYPE } from "../../online/api";
import { FRAMES } from "../art";
import { backArrow, corners, gradient, label, NO_ART, spriteButton, type ArtLookup } from "../chrome";
import { UI_COLOURS } from "../render";
import type { Screen } from "../screen";
import type { UiViewport } from "../viewport";
import type { Widget } from "../widgets";
import { LevelBrowserScreen } from "./online/browser";
import { CollectionScreen } from "./online/collections";
import { OnlineLevelScreen } from "./online/info";
import { SearchScreen } from "./online/search";

/** The tiles in the game's own order, left to right and top to bottom. */
const TILES: ReadonlyArray<{ id: string; frame: string; off?: boolean }> = [
  { id: "create", frame: FRAMES.tileCreate },
  { id: "saved", frame: FRAMES.tileSaved },
  { id: "scores", frame: FRAMES.tileScores },
  { id: "quests", frame: FRAMES.tileQuests },
  { id: "versus", frame: FRAMES.tileVersus, off: true },
  { id: "map", frame: FRAMES.tileMap, off: true },
  { id: "daily", frame: FRAMES.tileDaily },
  { id: "weekly", frame: FRAMES.tileWeekly },
  { id: "event", frame: FRAMES.tileEvent },
  { id: "gauntlets", frame: FRAMES.tileGauntlets },
  { id: "featured", frame: FRAMES.tileFeatured },
  { id: "lists", frame: FRAMES.tileLists },
  { id: "paths", frame: FRAMES.tilePaths },
  { id: "mapPacks", frame: FRAMES.tileMapPacks },
  { id: "search", frame: FRAMES.tileSearch },
];

/** The grid: 90 apart at full size, the tiles at eight tenths. */
const TILE_PITCH = 90;
const TILE_SCALE = 0.8;

/** How the game greys a tile out: a CCSpriteGrayscale at even luminance, tinted 175. [:239497-239503] */
const GREYED = { r: 175, g: 175, b: 175, grey: true };

/** Diamonds the vault asks for. [:239630-239633] */
const VAULT_DIAMONDS = 50;

export class CreatorScreen implements Screen {
  readonly name = "creator";
  readonly opaque = true;

  constructor(private readonly game: Game) {}

  build(view: UiViewport): Widget[] {
    const art: ArtLookup = this.game.ui?.art ?? NO_ART;
    const w = view.width;
    const h = view.height;
    const out: Widget[] = [];
    out.push(gradient(view, UI_COLOURS.menuBlue));
    // The right-hand pair is made but never added. [:239574-239629]
    out.push(...corners(view, ["bottomLeft", "topLeft"]));

    // The tiles fit narrower windows by shrinking together, never past a tenth.
    // [:239442-239450]
    const searchW = art.quad(FRAMES.tileSearch)?.w ?? 100;
    const fit = Math.max(0.9, Math.min(1, (w - 100) / (searchW * 0.8 + 360)));
    TILES.forEach((tile, i) => {
      const col = i % 5;
      const row = Math.floor(i / 5);
      const x = w / 2 + (col - 2) * TILE_PITCH * fit;
      const y = h / 2 - (row - 1) * TILE_PITCH * fit;
      out.push(...spriteButton(art, tile.id, x, y, tile.frame, { scale: TILE_SCALE * fit, tint: tile.off ? GREYED : undefined }));
    });

    // Still locked, so the price sits under it. [:239630-239671]
    out.push(...spriteButton(art, "vault", w - 22, h - 18, FRAMES.lockGrey, { sizeMult: 2 }));
    out.push(label(art, String(VAULT_DIAMONDS), w - 22 - 8.5, h - 18 - 22, { scale: 0.4 }));
    out.push({ kind: "sprite", x: w - 22 + 9, y: h - 18 - 23, frame: FRAMES.diamond, scale: 0.7 });
    out.push(...spriteButton(art, "treasure", w - 22, 24, FRAMES.secretDoor, { sizeMult: 1.2 }));
    out.push(...backArrow(art, view, "pink"));
    return out;
  }

  onPress(id: string): boolean {
    if (id === "back") {
      this.game.audio.ui("back");
      this.game.stack.pop();
      return true;
    }
    if (id === "create") {
      this.game.say("The level editor isn't in this version yet.");
      return true;
    }
    if (id === "vault" || id === "treasure") {
      this.game.say("The vaults aren't in this version yet.");
      return true;
    }
    const next = this.screenFor(id);
    if (next) {
      this.game.audio.ui("play");
      this.game.stack.push(next);
      return true;
    }
    if (TILES.some((t) => t.id === id)) {
      this.game.say(id === "versus" || id === "map" ? "This isn't in the game yet." : "This isn't in this version yet.");
      return true;
    }
    return false;
  }

  private screenFor(id: string): Screen | null {
    const game = this.game;
    switch (id) {
      case "saved":
        return new LevelBrowserScreen(game, "Saved Levels", { kind: "saved" });
      case "featured":
        return new LevelBrowserScreen(game, "Featured", { kind: "query", query: { type: LIST_TYPE.featured } });
      case "search":
        return new SearchScreen(game);
      case "mapPacks":
        return new CollectionScreen(game, "mapPacks");
      case "gauntlets":
        return new CollectionScreen(game, "gauntlets");
      case "daily":
        return new OnlineLevelScreen(game, { special: -1, heading: "Daily Level" });
      case "weekly":
        return new OnlineLevelScreen(game, { special: -2, heading: "Weekly Demon" });
      case "event":
        return new OnlineLevelScreen(game, { special: -3, heading: "Event Level" });
      default:
        return null;
    }
  }

  onKey(code: string, down: boolean): boolean {
    if (down && code === "Escape") {
      this.game.stack.pop();
      return true;
    }
    return false;
  }
}
