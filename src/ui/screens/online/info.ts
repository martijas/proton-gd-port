// One online level, before playing it: who made it, how hard it is, what it
// plays to, how far you have got, and the button that starts it. The level is
// downloaded as soon as the page opens, as the game's LevelInfoLayer does, so
// the play button is ready by the time it is reached for.
//
// Also the daily, weekly and event levels, which open by their special ids
// and learn what they are from the download.
//
// [gdp LevelInfoLayer::init: the name across the top with the author under
//  it, the face to the left with its stars and coins, the big play button in
//  the middle, the stats down the right, the song under the button]

import type { Game } from "../../../game/game";
import { downloadLevel, lengthName, OnlineError, shortCount, type Downloaded, type OnlineLevel } from "../../../online/api";
import { FRAMES } from "../../art";
import { gradient, label, NO_ART, popup, shade, spriteButton, type ArtLookup } from "../../chrome";
import { UI_COLOURS } from "../../render";
import type { Screen } from "../../screen";
import { rect, type UiViewport } from "../../viewport";
import type { Widget } from "../../widgets";
import { faceWidgets, MUTED, SONG_BLUE, stat } from "./common";

export type LevelTarget =
  /** A level already described by a list. */
  | { level: OnlineLevel }
  /** -1, -2 or -3, today's daily, weekly or event level, under a heading. */
  | { special: number; heading: string };

export class OnlineLevelScreen implements Screen {
  readonly name = "onlineLevel";
  readonly opaque = true;
  private info: OnlineLevel | null;
  private download: Downloaded | null = null;
  private error: string | null = null;
  private starting = false;
  private details = false;

  constructor(
    private readonly game: Game,
    private readonly target: LevelTarget,
  ) {
    this.info = "level" in target ? target.level : null;
  }

  enter(): void {
    this.fetch();
  }

  private get art(): ArtLookup {
    return this.game.ui?.art ?? NO_ART;
  }

  private fetch(): void {
    this.error = null;
    const id = "level" in this.target ? this.target.level.id : this.target.special;
    downloadLevel(id).then(
      (got) => {
        this.download = got;
        // A list knows the author's name; a download by id sometimes does not.
        this.info = { ...got.info, author: got.info.author || this.info?.author || "" };
      },
      (e: unknown) => {
        this.error = e instanceof OnlineError ? e.message : "This level couldn't be downloaded. Try again.";
      },
    );
  }

  build(view: UiViewport): Widget[] {
    const art = this.art;
    const w = view.width;
    const h = view.height;
    const cx = w / 2;
    const cy = h / 2;
    const out: Widget[] = [gradient(view, UI_COLOURS.menuBlue)];
    out.push(...spriteButton(art, "back", 24, h - 23, FRAMES.arrowGreen, { sizeMult: 1.6 }));
    const heading = "heading" in this.target ? this.target.heading : null;
    if (heading) out.push(label(art, heading, cx, h - 12, { font: "goldFont", scale: 0.45 }));

    const level = this.info;
    if (!level) {
      out.push(label(art, this.error ?? "Loading...", cx, cy + (this.error ? 16 : 0), { font: "goldFont", scale: 0.6, maxWidth: w - 80 }));
      if (this.error) out.push(retryButton(cx, cy - 20));
      return out;
    }

    const nameY = heading ? h - 36 : h - 30;
    out.push(label(art, level.name, cx, nameY, { scale: art.fit?.("bigFont", level.name, w - 140, 0.9) ?? 0.7 }));
    if (level.author) out.push(label(art, `By ${level.author}`, cx, nameY - 26, { font: "goldFont", scale: 0.6 }));

    // The face (its art carries its name), its stars and its coins, left of the button.
    const faceX = cx - 125;
    out.push(...faceWidgets(level, faceX, cy + 34, 1.1));
    const progress = this.game.save.onlineLevel(level.id);
    if (level.stars > 0) {
      out.push(label(art, String(level.stars), faceX - 2, cy - 4, { scale: 0.45, anchorX: 1 }));
      out.push({ kind: "sprite", x: faceX + 10, y: cy - 4, frame: progress.completions > 0 ? FRAMES.star : FRAMES.starGrey, scale: 0.5 });
    }
    for (let i = 0; i < level.coins; i++) {
      out.push({
        kind: "sprite",
        x: faceX + (i - (level.coins - 1) / 2) * 20,
        y: cy - 26,
        frame: progress.coins[i] ? FRAMES.userCoin : FRAMES.coinGrey,
        scale: 0.6,
        alpha: level.verifiedCoins ? 1 : 0.5,
      });
    }

    // The play button, faint until the level is here.
    const ready = this.download !== null && !this.starting;
    out.push(...spriteButton(art, "play", cx, cy + 30, FRAMES.resume, { enabled: ready, alpha: ready ? 1 : 0.4 }));
    if (this.error) {
      out.push(label(art, this.error, cx, cy - 18, { font: "goldFont", scale: 0.45, maxWidth: 200 }));
      out.push(retryButton(cx, cy - 48));
    } else if (!ready) {
      out.push(label(art, this.starting ? "Starting..." : "Downloading...", cx, cy - 18, { font: "goldFont", scale: 0.45 }));
    }

    // The stats, down the right.
    const statX = cx + 105;
    out.push(...stat(art, FRAMES.downloads, shortCount(level.downloads), statX, cy + 52, 0.6));
    out.push(...stat(art, level.likes < 0 ? FRAMES.dislikes : FRAMES.likes, shortCount(Math.abs(level.likes)), statX, cy + 26, 0.6));
    out.push(...stat(art, FRAMES.length, lengthName(level.length), statX, cy, 0.6));

    // The song, under it all.
    const songY = cy - 72;
    const song = level.song;
    if (song.kind === "official") {
      const track = this.game.strings.song(song.index) ?? this.game.strings.song(0);
      out.push(label(art, track?.title ?? "Stereo Madness", cx, songY, { font: "chatFont", scale: 0.6, tint: SONG_BLUE }));
    } else {
      out.push(label(art, song.name, cx, songY, { font: "chatFont", scale: art.fit?.("chatFont", song.name, w - 120, 0.6) ?? 0.55, tint: SONG_BLUE }));
      const by = song.available ? (song.artist ? `by ${song.artist}` : "") : "This song can't be played here, so the level will be silent.";
      if (by) out.push(label(art, by, cx, songY - 15, { font: "chatFont", scale: 0.45, tint: song.available ? MUTED : UI_COLOURS.gold, maxWidth: w - 80 }));
    }

    // Your best, along the bottom.
    const bars = [
      { x: cx - 105, title: "Normal", value: progress.best, fill: UI_COLOURS.barNormal },
      { x: cx + 105, title: "Practice", value: progress.practiceBest, fill: UI_COLOURS.barPractice },
    ];
    for (const bar of bars) {
      out.push({ kind: "progress", x: bar.x, y: 24, frame: FRAMES.progressBar, value: bar.value / 100, fill: bar.fill, scale: 0.5 });
      out.push(label(art, `${bar.title} ${Math.floor(bar.value)}%`, bar.x, 40, { scale: 0.35 }));
    }

    out.push(...spriteButton(art, "details", w - 20, h - 20, FRAMES.infoIcon, { sizeMult: 2 }));
    if (this.game.save.isSaved(level.id)) out.push(...spriteButton(art, "forget", w - 26, 70, FRAMES.trash, { scale: 0.7, sizeMult: 1.3 }));

    if (this.details) out.push(...this.detailsPopup(view, level));
    return out;
  }

  /** The description and the numbers that do not fit on the page. */
  private detailsPopup(view: UiViewport, level: OnlineLevel): Widget[] {
    const art = this.art;
    const cx = view.width / 2;
    const cy = view.height / 2;
    const box = rect(cx - 180, cy - 100, 360, 200);
    const out: Widget[] = [shade(view, 0.5), ...popup(art, box)];
    out.push(label(art, level.name, cx, box.y + box.h - 26, { scale: art.fit?.("bigFont", level.name, 300, 0.65) ?? 0.55 }));
    const description = level.description || "No description.";
    out.push(label(art, description, cx, box.y + box.h - 82, { font: "chatFont", scale: 0.55, maxWidth: box.w - 40 }));
    const facts = [
      `Level ID: ${level.id}`,
      `Version: ${level.version}`,
      `Objects: ${level.objects > 0 ? level.objects.toLocaleString("en-US") : "Unknown"}`,
      level.twoPlayer ? "Two player" : "",
    ].filter(Boolean);
    facts.forEach((line, i) => out.push(label(art, line, cx, box.y + 62 - i * 16, { font: "goldFont", scale: 0.42 })));
    return out;
  }

  private play(): void {
    const got = this.download;
    if (!got || this.starting || !this.info) return;
    this.starting = true;
    this.game.audio.ui("play");
    this.game.startOnlineLevel(this.info, got.level).then(
      () => {
        this.starting = false;
      },
      (e: unknown) => {
        console.error(e);
        this.starting = false;
        this.game.say("This level couldn't be started.");
      },
    );
  }

  onPress(id: string): boolean {
    if (this.details) {
      if (id === "close") this.details = false;
      return true;
    }
    if (id === "back") {
      this.game.audio.ui("back");
      this.game.stack.pop();
      return true;
    }
    if (id === "play") {
      this.play();
      return true;
    }
    if (id === "retry") {
      this.fetch();
      return true;
    }
    if (id === "details") {
      this.details = true;
      return true;
    }
    if (id === "forget" && this.info) {
      this.game.save.forgetOnlineLevel(this.info.id);
      this.game.say("Removed from your saved levels.");
      return true;
    }
    return false;
  }

  onKey(code: string, down: boolean): boolean {
    if (!down) return false;
    if (code === "Escape") {
      if (this.details) this.details = false;
      else this.game.stack.pop();
      return true;
    }
    if ((code === "Enter" || code === "Space") && !this.details) {
      this.play();
      return true;
    }
    return false;
  }
}

function retryButton(x: number, y: number): Widget {
  return { kind: "button", id: "retry", rect: rect(x - 55, y - 15, 110, 30), frame: FRAMES.button, label: { text: "Try again", scale: 0.45 } };
}
