// Playing: the heads-up display, the pause menu, the end of a run and the
// screen a death shows when the level does not restart by itself.
//
// The play screen is the only one that lets a press through to the game — a tap
// anywhere that is not a button is a jump — which is what `hitTest` returning
// nothing already does.
//
// Every position is the game's own:
//   - the HUD from `UILayer::init` and `PlayLayer::init`: the faint pause
//     button 15 in from the top-right corner, the bar centred 8 under the top
//     with its fill 2 in and 4 up, the percentage 110 right of the centre
//     beside it or centred without it, neither in a platformer;
//   - the pause menu from `PauseLayer::customSetup`: the name 30 under the
//     top, the two bars 80 and 30 above the centre, the buttons 30 below it
//     15 apart, the sliders 105 below it and 100 to either side;
//   - the end screen from `EndLevelLayer::customSetup`: the banner 75 above
//     the centre, the stats from 35 above it in steps of 24, the phrase 65
//     below it, the two buttons 125 below it and 100 to either side;
//   - the death screen from `RetryLevelLayer::setupLastProgress`.

import type { Game } from "../../game/game";
import { FRAMES } from "../art";
import { clock, label, NO_ART, spriteButton, TRANSPARENT, type ArtLookup } from "../chrome";
import { NewBestPopup, OrbReward } from "../newBest";
import { UI_COLOURS } from "../render";
import type { Screen } from "../screen";
import { rect, type UiViewport } from "../viewport";
import { sliderValueAt, type Widget } from "../widgets";

/** How long the death overlay waits before retrying by itself. [meas] */
const AUTO_RETRY_SECONDS = 1;
/** A death that shows the new-best pop-up waits at least this long. [gdp PlayLayer::destroyPlayer :93351-93352] */
const NEW_BEST_RETRY_SECONDS = 1.4;

/** The pause button is drawn faint. [gdp UILayer::init :86322, opacity 75 of 255] */
const PAUSE_ALPHA = 75 / 255;

/** The attempt label in a run from a start position. [gdp PlayLayer::setupHasCompleted :106462-106463, opacity 50 of 255] */
const TEST_LABEL_ALPHA = 50 / 255;

/**
 * The whole percentage the game reads off player 1's progress, in its float
 * arithmetic: `(float)(x / length) * 100`, rounded down.
 * [gdp PlayLayer::getCurrentPercent :91461-91487; getCurrentPercentInt
 *  :91686-91692]
 */
export function wholePercent(progress: number): number {
  return Math.floor(Math.fround(Math.fround(progress) * 100));
}

/**
 * What the end screen says, picked at random the way the game picks it.
 * [gdp EndLevelLayer::getEndText, gd-ida-decomp.cpp:368846-369230]
 */
export const END_TEXTS: readonly string[] = [
  "Amazing!",
  "Awesome!",
  "Brilliant!",
  "Good Job!",
  "Impressive!",
  "Incredible!",
  "Not bad!",
  "Reflex Master!",
  "Challenge Breaker!",
  "How is this possible!?",
  "I am speechless...",
  "Never before have I seen such skill",
  "LET'S ROCK IT!",
  "Pump. It. Up.",
  "Big brain moment",
  "Did we win?",
  "Are ya winning son?",
  "I like ya cut G",
  "NOICE",
  "Nice song",
  "Cool, now beat it with your eyes closed",
  "Does anyone read this?",
  "BEHOLD, an endscreen comment!",
  "Have you just... DASHED it???",
  "Not 1 attempt but ok",
  "Robala Topala approves",
  "I am not not impressed",
  "Fluked",
  "HOW!?",
  "I can't believe you've done this",
  "OMG Poggers",
  "Don't forget to thank the bus driver",
  "Dr. Click",
  "I have the highground",
  "DROP THE BEAT",
];

export class PlayScreen implements Screen {
  readonly name = "play";
  /**
   * Opaque, even though the level shows through it. The level is drawn by the
   * renderer rather than by a screen, so "opaque" here only stops the *menus*
   * underneath from drawing — without it the level select keeps showing over
   * the level it just started.
   */
  readonly opaque = true;
  private deadFor = 0;
  private finished = false;
  private retryShown = false;
  private retryDelay = AUTO_RETRY_SECONDS;
  /** The death is waiting for its orbs to land before it starts over. */
  private orbsPending = false;
  private popup: NewBestPopup | null = null;
  private reward: OrbReward | null = null;
  /** Where the attempt label falls in the frame, refilled each build. */
  private readonly labelAt: [number, number] = [0, 0];

  constructor(private readonly game: Game) {}

  exit(): void {
    this.game.endLevel();
  }

  /**
   * Steps the pop-up and the orb counter. They are the level's own layers, so
   * they carry on through the death screen and into the next attempt, and
   * stand still while the level is paused.
   */
  private tickOverlays(dt: number): void {
    if (this.game.stack.freezesLevel) return;
    if (this.popup) {
      this.popup.update(dt);
      if (this.popup.done) this.popup = null;
    }
    if (this.reward) {
      this.reward.update(dt);
      if (this.reward.done) this.reward = null;
    }
  }

  /**
   * A death that beat the best, or paid orbs: the pop-up, and the orbs flying
   * from it to the counter. When the level starts over by itself and orbs
   * were paid, it starts over as the last one lands rather than on a timer.
   * [gdp PlayLayer::showNewBest :88991-89618; currencyWillExit :107335]
   */
  private showNewBest(newBest: boolean, percent: number, orbs: number, waitForOrbs: boolean): void {
    const view = this.game.view;
    const popup = new NewBestPopup({ newBest, percent, orbs });
    this.popup = popup;
    this.orbsPending = waitForOrbs && orbs > 0;
    if (orbs <= 0) return;
    this.game.audio.ui("orbs");
    const art: ArtLookup = this.game.ui?.art ?? NO_ART;
    const total = this.game.orbTotal();
    this.reward = new OrbReward(total - orbs, orbs, popup.centre(view.width, view.height), view.width, view.height, art, () => {
      if (!this.orbsPending) return;
      this.orbsPending = false;
      if (this.game.sim?.state.dead && this.game.stack.top === this) this.retry();
    });
  }

  update(dt: number): void {
    this.tickOverlays(dt);
    const sim = this.game.sim;
    const run = this.game.run;
    if (!sim || !run) return;

    // A run from a start position counts as an attempt and keeps nothing
    // else: no best, no completion, no coins. Its jumps count all the same.
    // [gdp PlayLayer::destroyPlayer :93168, :93199-93203; levelComplete
    //  :92666-92696, :92772-92858]
    const kept = sim.startPosition < 0;
    // An attempt a cheat or safe mode was on in keeps nothing at all, not
    // even the attempt itself (mods/state.ts).
    const saves = this.game.runSaves();
    // A replay from the end screen is a fresh attempt on the same screen.
    if (!sim.state.finished) this.finished = false;
    if (sim.state.finished && !this.finished) {
      this.finished = true;
      this.game.commitJumps();
      const before = this.game.runProgress(run).best;
      const improved = saves && this.game.recordRun(run, kept ? 100 : 0, kept ? sim.coinsTaken() : []);
      if (kept && saves) this.game.awardOrbs(run, before, 100);
      this.game.audio.finishLevel(sim, this.game.practiceMusic());
      this.game.stack.push(new CompleteScreen(this.game, improved, saves));
      return;
    }
    if (!sim.state.dead) {
      this.deadFor = 0;
      this.retryShown = false;
      return;
    }
    if (this.deadFor === 0) {
      this.game.commitJumps();
      // The game keeps the percentage the attempt died at, whole and short of
      // 100 — not the furthest it got — and a platformer's deaths keep none.
      // [gdp PlayLayer::destroyPlayer :93198-93216, :93277-93281;
      //  getCurrentPercentInt :91686-91692]
      const percent = wholePercent(sim.progress());
      if (!run.practice) run.lastPercent = percent;
      const keeps = kept && saves && !run.level.header.platformer;
      const kept99 = keeps ? Math.min(99, percent) : 0;
      // A new best beats the normal-mode best as it stood; the orbs are paid
      // for the stretch past it. [gdp PlayLayer::destroyPlayer :93199-93268]
      const before = this.game.runProgress(run).best;
      const newBest = keeps && !run.practice && kept99 > before;
      if (saves) this.game.recordRun(run, kept99);
      const orbs = keeps ? this.game.awardOrbs(run, before, kept99) : 0;
      this.game.audio.playerDied(sim, this.game.practiceMusic());
      // Starting over by itself, the level shows the pop-up for a new best or
      // for orbs; with the death screen, only for orbs.
      // [gdp PlayLayer::destroyPlayer :93302-93352]
      const auto = this.game.save.get().settings.autoRetry;
      const mods = this.game.mods;
      this.retryDelay = mods.on("respawnTime") ? mods.value("respawnTime") : AUTO_RETRY_SECONDS;
      this.orbsPending = false;
      if (orbs > 0 || (auto && newBest)) {
        this.showNewBest(newBest, kept99, orbs, auto);
        if (auto) this.retryDelay = Math.max(this.retryDelay, NEW_BEST_RETRY_SECONDS);
      }
    }
    this.deadFor += dt;
    if (this.game.save.get().settings.autoRetry) {
      if (!this.orbsPending && this.deadFor >= this.retryDelay) {
        this.deadFor = 0;
        this.retry();
      }
    } else if (!this.retryShown && this.deadFor >= AUTO_RETRY_SECONDS) {
      this.retryShown = true;
      this.game.stack.push(new RetryScreen(this.game));
    }
  }

  /**
   * Practice comes back to its last checkpoint, and so does a normal run of a
   * platformer that has passed a checkpoint object; anything else starts over.
   * [gdp PlayLayer::resetLevel :105893, loadLastCheckpoint :105665-105677]
   */
  retry(): void {
    this.deadFor = 0;
    this.retryShown = false;
    this.orbsPending = false;
    if (this.game.run?.practice || this.game.checkpoints.length > 0) this.game.respawn();
    else this.game.restart();
  }

  build(view: UiViewport): Widget[] {
    const sim = this.game.sim;
    const run = this.game.run;
    if (!sim || !run) return [];
    const art: ArtLookup = this.game.ui?.art ?? NO_ART;
    const settings = this.game.save.get().settings;
    const progress = sim.progress();
    const w = view.width;
    const h = view.height;
    const out: Widget[] = [];

    // The attempt count stands in the level and scrolls away with it; a run
    // from a start position draws it faint. It is a child of the object
    // layer, so it grows and shrinks with the zoom and moves with the view's
    // turn and shake (the text itself stays upright here): it is placed
    // through the frame the level was just drawn in. [gdp PlayLayer::
    // updateAttempts :92457-92471; setupHasCompleted :106298-106300,
    // :106462-106463]
    const scene = this.game.scene;
    const mods = this.game.mods;
    const hud = !mods.on("hideHud");
    const at = this.labelAt;
    scene.viewPoint(run.attemptLabel.x, run.attemptLabel.y, at);
    const sx = at[0] * w;
    const sy = at[1] * h;
    if (sx > -200 && sx < w + 200 && !mods.on("hideAttempts")) {
      const scale = scene.camera.zoomAt(scene.drawnAlpha);
      out.push(label(art, `Attempt ${run.attempt}`, sx, sy, { scale, alpha: sim.startPosition >= 0 ? TEST_LABEL_ALPHA : undefined }));
    }

    // A platformer shows no progress: the bar never, and the label only as
    // the time, which is not here. Elsewhere the percentage sits 110 right of
    // the centre beside the bar, or centred without it.
    // [gdp PlayLayer::toggleProgressbar :91596-91670; updateProgressbar
    //  :91522 (not in a platformer), :91569-91572]
    const platformer = run.level.header.platformer;
    const bar = settings.showProgressBar && !platformer && hud;
    if (bar) {
      out.push({
        kind: "progress",
        x: w / 2,
        y: h - 8,
        frame: FRAMES.hudGroove,
        fillFrame: FRAMES.hudFill,
        fillInset: { x: 2, y: 4 },
        value: progress,
        fill: UI_COLOURS.barNormal,
      });
    }
    if (settings.showPercentage && !platformer && hud) {
      const text = mods.on("accuratePercent")
        ? `${Math.min(100, progress * 100).toFixed(mods.value("accuratePercent"))}%`
        : `${Math.min(100, wholePercent(progress))}%`;
      out.push(label(art, text, bar ? w / 2 + 110 : w / 2, h - 8, { scale: 0.5, anchorX: bar ? 0 : 0.5 }));
    }

    if (hud && !mods.on("hidePause")) out.push(...spriteButton(art, "pause", w - 15, h - 15, FRAMES.pause, { alpha: PAUSE_ALPHA, sizeMult: 1.6 }));

    if (run.practice && hud) {
      // The game's two practice buttons, bottom right: lay a checkpoint, take
      // the last one back. [meas]
      const n = this.game.checkpoints.length;
      out.push(...spriteButton(art, "checkpoint", w - 120, 30, FRAMES.checkpoint, { scale: 0.8, sizeMult: 1.2 }));
      out.push(...spriteButton(art, "uncheckpoint", w - 45, 30, FRAMES.removeCheckpoint, { scale: 0.8, sizeMult: 1.2, alpha: n > 0 ? 1 : 0.5 }));
    }
    return out.concat(this.overlayWidgets(view));
  }

  /** The pop-up, then the orb counter over it. */
  overlayWidgets(view: UiViewport): Widget[] {
    const art: ArtLookup = this.game.ui?.art ?? NO_ART;
    const out: Widget[] = [];
    if (this.popup) out.push(...this.popup.widgets(art, view.width, view.height));
    if (this.reward) out.push(...this.reward.widgets(art));
    return out;
  }

  onPress(id: string): boolean {
    if (id === "pause") {
      this.game.stack.push(new PauseScreen(this.game));
      return true;
    }
    if (id === "checkpoint") {
      this.game.placeCheckpoint();
      return true;
    }
    if (id === "uncheckpoint") {
      this.game.removeCheckpoint();
      return true;
    }
    return false;
  }

  onKey(code: string, down: boolean): boolean {
    if (!down) return false;
    if (code === "Escape" && this.game.mods.on("ignoreEscape")) return true;
    if (code === "Escape" || code === "KeyP") {
      this.game.stack.push(new PauseScreen(this.game));
      return true;
    }
    if (code === "KeyR") {
      restartAttempt(this.game);
      return true;
    }
    // The game's own practice keys.
    if (code === "KeyZ" && this.game.run?.practice) {
      this.game.placeCheckpoint();
      return true;
    }
    if (code === "KeyX" && this.game.run?.practice) {
      this.game.removeCheckpoint();
      return true;
    }
    return false;
  }
}

/**
 * The pause menu's restart, and R: back to the last checkpoint when there is
 * one, as a death does — practice's own, or the last checkpoint object a
 * platformer passed — and from the start when there is none. A platformer's
 * pause menu has a second restart that always starts over.
 * [gdp PauseLayer::onRestart :235367-235375 → resumeAndRestart(…, 0)
 *  :107581-107624 → PlayLayer::resetLevel, which loads the last checkpoint
 *  whatever the mode :105893, loadLastCheckpoint :105665-105677; R
 *  :85188-85192; onRestartFull :235392-235400 → resetLevelFromStart
 *  :107412-107435, its button added for a platformer only :236152-236158
 *  (+281, kA22 :202523-202529)]
 */
function restartAttempt(game: Game): void {
  if (game.checkpoints.length > 0) game.respawn();
  else game.restart();
}

/** The pause menu's dark sheet, inset 10 from every edge. [gdp PauseLayer::customSetup :236100-236115] */
const PAUSE_INSET = 10;
const PAUSE_SHEET = { r: 0, g: 0, b: 0 };
const PAUSE_SHEET_ALPHA = 0.7;

export class PauseScreen implements Screen {
  readonly name = "pause";
  /** The level freezes underneath, which is the whole point of the flag. */
  readonly ticksBelow = false;
  /** And so does everything that moves in it on its own: colours, effects, particles. */
  readonly freezesLevel = true;

  constructor(private readonly game: Game) {}

  enter(): void {
    // A jump held when the menu opened must not survive into it and fire again.
    this.game.input.clear();
    // The level's sound stops where it is and carries on from there, so the
    // music does not run ahead of a level that is standing still.
    this.game.audio.pauseLevel();
  }

  exit(): void {
    this.game.audio.resumeLevel();
  }

  build(view: UiViewport): Widget[] {
    const art: ArtLookup = this.game.ui?.art ?? NO_ART;
    const run = this.game.run;
    const w = view.width;
    const h = view.height;
    const cx = w / 2;
    const cy = h / 2;
    const progress = run ? this.game.runProgress(run) : null;
    const settings = this.game.save.get().settings;
    const out: Widget[] = [];

    out.push({ kind: "panel", rect: rect(PAUSE_INSET, PAUSE_INSET, w - PAUSE_INSET * 2, h - PAUSE_INSET * 2), frame: FRAMES.squareWhite, tint: PAUSE_SHEET, alpha: PAUSE_SHEET_ALPHA });
    // The name hangs 30 under the top: half the inset sheet's height above the
    // centre, less 20. [gdp PauseLayer::customSetup :236126]
    const name = run?.name ?? "Paused";
    out.push(label(art, name, cx, h - 30, { scale: art.fit?.("bigFont", name, w - 120, 1) ?? 0.8 }));

    // The two bars. [gdp PauseLayer::setupProgressBars]
    const bars = [
      { y: cy + 80, title: "Normal Mode", value: progress?.best ?? 0, fill: UI_COLOURS.barNormal },
      { y: cy + 30, title: "Practice Mode", value: progress?.practiceBest ?? 0, fill: UI_COLOURS.barPractice },
    ];
    for (const bar of bars) {
      out.push({ kind: "progress", x: cx, y: bar.y, frame: FRAMES.progressBar, value: bar.value / 100, fill: bar.fill });
      out.push(label(art, bar.title, cx, bar.y + 20, { scale: 0.5 }));
      out.push(label(art, `${Math.floor(bar.value)}%`, cx, bar.y, { scale: 0.5 }));
    }

    // The row of buttons: menu, practice or normal, the big resume, restart.
    // A platformer adds the restart from the start, just ahead of practice or
    // normal as the game adds it. [gdp PauseLayer::customSetup :236152-236158]
    const row: Array<{ id: string; frame: string }> = [
      { id: "quit", frame: FRAMES.menu },
      ...(run?.level.header.platformer ? [{ id: "retryFull", frame: FRAMES.replayFull }] : []),
      { id: "mode", frame: run?.practice ? FRAMES.normal : FRAMES.practice },
      { id: "resume", frame: FRAMES.resume },
      { id: "retry", frame: FRAMES.replay },
    ];
    const widths = row.map((b) => art.quad(b.frame)?.w ?? 60);
    const total = widths.reduce((a, b) => a + b, 0) + 15 * (row.length - 1);
    let x = cx - total / 2;
    row.forEach((b, i) => {
      out.push(...spriteButton(art, b.id, x + widths[i] / 2, cy - 30, b.frame));
      x += widths[i] + 15;
    });
    // The game never shows it for a platformer. [:236202-236213]
    if (run?.practice && !run.level.header.platformer) out.push({ kind: "sprite", x: cx - 190, y: cy - 12, frame: FRAMES.practiceText });

    out.push(...spriteButton(art, "settings", w - 36, h - 36, FRAMES.options, { scale: 0.75 }));
    // The mod menu, for a screen with no Tab key. Not the game's.
    out.push({ kind: "button", id: "mods", rect: rect(PAUSE_INSET + 12, h - PAUSE_INSET - 42, 70, 30), frame: FRAMES.button, label: { text: "Mods", scale: 0.5 } });

    // The two sliders along the bottom, each under its name.
    const sliders: Array<{ id: string; text: string; x: number; value: number }> = [
      { id: "music", text: "Music", x: cx - 100, value: settings.musicVolume },
      { id: "sfx", text: "SFX", x: cx + 100, value: settings.sfxVolume },
    ];
    for (const s of sliders) {
      out.push(label(art, s.text, s.x, cy - 85, { scale: 0.5 }));
      out.push({ kind: "slider", id: s.id, rect: rect(s.x - 84, cy - 110, 168, 10), value: s.value, scale: 0.45 });
    }
    return out;
  }

  private setVolume(id: string, value: number): void {
    this.game.save.set((s) => {
      if (id === "music") s.settings.musicVolume = value;
      else s.settings.sfxVolume = value;
    });
    const settings = this.game.save.get().settings;
    this.game.audio.setVolumes({ music: settings.musicVolume, sfx: settings.sfxVolume });
  }

  onPress(id: string): boolean {
    if (id === "resume") {
      this.game.stack.pop();
      return true;
    }
    if (id === "retry") {
      this.game.stack.pop();
      restartAttempt(this.game);
      return true;
    }
    if (id === "retryFull") {
      this.game.stack.pop();
      this.game.restart();
      return true;
    }
    if (id === "mode") {
      // As the game does it: practice goes on from where the level is, and
      // leaving practice starts the level over.
      // [gdp PlayLayer::togglePracticeMode :107466-107485]
      const run = this.game.run;
      this.game.stack.pop();
      if (run?.practice) {
        run.practice = false;
        this.game.restart();
      } else {
        this.game.enterPractice();
      }
      return true;
    }
    if (id === "mods") {
      this.game.mods.toggleMenu();
      return true;
    }
    if (id === "settings") {
      // The level's own options, not the main Options pages. [gdp PauseLayer::onSettings :235188]
      void import("./settings").then(({ GameOptionsScreen }) => this.game.stack.push(new GameOptionsScreen(this.game)));
      return true;
    }
    if (id === "quit") {
      this.game.audio.ui("back");
      this.game.save.flush();
      quitToMenu(this.game);
      return true;
    }
    return false;
  }

  onDrag(id: string, _dx: number, _dy: number, x: number): boolean {
    if (id !== "music" && id !== "sfx") return false;
    const widget = this.build(this.game.view).find((w) => w.kind === "slider" && w.id === id);
    if (widget && widget.kind === "slider") this.setVolume(id, sliderValueAt(widget, x));
    return true;
  }

  onRelease(id: string): void {
    if (id === "music" || id === "sfx") this.game.save.flush();
  }

  onKey(code: string, down: boolean): boolean {
    if (down && (code === "Escape" || code === "KeyP")) {
      this.game.stack.pop();
      return true;
    }
    return false;
  }
}

/**
 * What a run's stats say, for the end and death screens: this visit's
 * attempts and jumps. [gdp EndLevelLayer::customSetup :369518-369529;
 *  RetryLevelLayer::setupLastProgress :383933-383935, customSetup
 *  :384043-384045]
 */
function attemptStats(game: Game): { attempts: number; jumps: number; seconds: number } {
  const run = game.run;
  return {
    attempts: run?.attempt ?? 0,
    jumps: run?.jumps ?? 0,
    seconds: run ? (performance.now() - run.attemptStartedAt) / 1000 : 0,
  };
}

export class CompleteScreen implements Screen {
  readonly name = "complete";
  readonly ticksBelow = false;
  private readonly phrase = END_TEXTS[Math.floor(Math.random() * END_TEXTS.length)] ?? "Awesome!";
  private readonly stats: { attempts: number; jumps: number; seconds: number };

  constructor(
    private readonly game: Game,
    private readonly newBest: boolean,
    /** False when a cheat or safe mode kept the run from saving. */
    private readonly saved = true,
  ) {
    this.stats = attemptStats(game);
  }

  enter(): void {
    this.game.input.clear();
    // Finishing already sounds, from the level's own finish event; this is only
    // the extra flourish for beating your own record.
    if (this.newBest) this.game.audio.ui("newBest");
  }

  build(view: UiViewport): Widget[] {
    const art: ArtLookup = this.game.ui?.art ?? NO_ART;
    const run = this.game.run;
    const w = view.width;
    const cx = w / 2;
    const cy = view.height / 2;
    const stars = run ? this.game.runStars(run) : 0;
    const out: Widget[] = [];
    out.push({ kind: "fill", rect: rect(0, 0, w, view.height), tint: UI_COLOURS.shade, alpha: 0.5 });
    out.push({ kind: "panel", rect: rect(cx - 210, cy - 145, 420, 290), frame: FRAMES.panel });

    const banner = run?.practice ? FRAMES.practiceComplete : FRAMES.levelComplete;
    const bannerW = art.quad(banner)?.w ?? 375;
    out.push({ kind: "sprite", x: cx, y: cy + 75, frame: banner, scale: Math.min(1, (w - 40) / bannerW) });

    const lines = [`Attempts: ${this.stats.attempts}`, `Jumps: ${this.stats.jumps}`, `Time: ${clock(this.stats.seconds)}`];
    lines.forEach((line, i) => out.push(label(art, line, cx, cy + 35 - i * 24, { font: "goldFont", scale: 0.8, maxWidth: 150 })));

    if (stars > 0 && !run?.practice && this.saved) {
      out.push({ kind: "sprite", x: cx + 120, y: cy + 34, frame: FRAMES.star, scale: 0.9 });
      out.push(label(art, String(stars), cx + 120 - 16, cy + 34, { scale: 0.6, anchorX: 1 }));
    }
    if (this.newBest) out.push({ kind: "sprite", x: cx, y: cy - 42, frame: FRAMES.newBest, scale: 0.55 });
    if (!this.saved) out.push(label(art, "Not saved: mods were on", cx, cy - 42, { font: "goldFont", scale: 0.6, maxWidth: 380 }));

    const phrase = run?.practice ? "Well done... Now try to complete it without any checkpoints!" : this.phrase;
    out.push(label(art, phrase, cx, cy - 68, { scale: art.fit?.("bigFont", phrase, 260, 0.9) ?? 0.6, maxWidth: 380 }));

    out.push(...spriteButton(art, "again", cx - 100, cy - 125, FRAMES.replay));
    out.push(...spriteButton(art, "menu", cx + 100, cy - 125, FRAMES.menu));
    return out;
  }

  onPress(id: string): boolean {
    if (id === "again") {
      // The replay starts the visit over. [gdp EndLevelLayer::onReplay
      //  :367255-367287 → PlayLayer::fullReset]
      this.game.stack.pop();
      this.game.fullReset();
      return true;
    }
    if (id === "menu") {
      quitToMenu(this.game);
      return true;
    }
    return false;
  }

  onKey(code: string, down: boolean): boolean {
    if (down && code === "Escape") {
      quitToMenu(this.game);
      return true;
    }
    return false;
  }
}

/**
 * What a death shows when the level does not start over by itself: the
 * attempt, how far it got, and the way back.
 * [gdp RetryLevelLayer::setupLastProgress and its customSetup]
 */
export class RetryScreen implements Screen {
  readonly name = "retry";
  readonly ticksBelow = false;
  private readonly stats: { attempts: number; jumps: number; seconds: number };

  constructor(private readonly game: Game) {
    this.stats = attemptStats(game);
  }

  enter(): void {
    this.game.input.clear();
  }

  build(view: UiViewport): Widget[] {
    const art: ArtLookup = this.game.ui?.art ?? NO_ART;
    const run = this.game.run;
    const w = view.width;
    const cx = w / 2;
    const cy = view.height / 2;
    const last = run?.lastPercent ?? 0;
    const out: Widget[] = [];
    out.push({ kind: "fill", rect: rect(0, 0, w, view.height), tint: UI_COLOURS.shade, alpha: 0.5 });
    out.push({ kind: "panel", rect: rect(cx - 210, cy - 145, 420, 290), frame: FRAMES.panel });

    const name = run?.name ?? "";
    out.push(label(art, name, cx, cy + 65, { scale: art.fit?.("bigFont", name, 320, 1) ?? 0.8 }));
    out.push({ kind: "progress", x: cx, y: cy + 10, frame: FRAMES.progressBar, value: last / 100, fill: UI_COLOURS.barNormal });
    out.push(label(art, `${last}%`, cx, cy + 10, { scale: 0.5 }));
    out.push(label(art, `Attempt ${this.stats.attempts}`, cx, cy + 33, { scale: 0.5 }));
    out.push(label(art, `Jumps: ${this.stats.jumps}`, cx, cy - 25, { font: "goldFont", scale: 0.8 }));
    out.push(label(art, `Time: ${clock(this.stats.seconds)}`, cx, cy - 49, { font: "goldFont", scale: 0.8 }));

    // The sheet itself takes a tap, the way a tap anywhere restarts in the game.
    out.push({ kind: "button", id: "tap", rect: rect(0, 0, w, view.height), label: { text: "", scale: 0 }, tint: TRANSPARENT });
    // Buttons after the sheet so they win the hit test.
    out.push(...spriteButton(art, "again", cx - 100, cy - 125, FRAMES.replay));
    out.push(...spriteButton(art, "menu", cx + 100, cy - 125, FRAMES.menu));
    return out;
  }

  private again(): void {
    this.game.stack.pop();
    const play = this.game.stack.top;
    if (play instanceof PlayScreen) play.retry();
    else this.game.restart();
  }

  onPress(id: string): boolean {
    if (id === "again" || id === "tap") {
      this.again();
      return true;
    }
    if (id === "menu") {
      quitToMenu(this.game);
      return true;
    }
    return false;
  }

  onKey(code: string, down: boolean): boolean {
    if (!down) return false;
    if (code === "Escape") {
      quitToMenu(this.game);
      return true;
    }
    if (code === "Space" || code === "Enter" || code === "KeyR") {
      this.again();
      return true;
    }
    return false;
  }
}

/** Unwinds back to whatever was under the play screen, and ends the run. */
function quitToMenu(game: Game): void {
  while (game.stack.depth > 0 && game.stack.top?.name !== "play") game.stack.pop();
  if (game.stack.top?.name === "play") game.stack.pop();
  void game.audio.playMenuMusic("menu");
}
