// Settings, as the game lays them out: a green table that drops down over the
// main menu with seven buttons and the two volume sliders, the Options pages
// of check boxes, and the Video Options popup.
//
// Every change writes through to the save at once rather than on the way out —
// closing a pane is not an event the game gets. Only Video Options waits for
// Apply, as the game's does.
//
// [gdp GJDropDownLayer::init :359849, GJListLayer::init :340867,
//  OptionsLayer::customSetup :360395, MoreOptionsLayer::init :363268 and
//  addToggle :362945, nextPosition :362704, VideoOptionsLayer::init :364485]

import type { Game } from "../../game/game";
import { hostConfig, type HostConfig } from "../../online/hostConfig";
import { FRAMES, type FontName } from "../art";
import { dropDown, label, listRowTint, NO_ART, openLink, shade, sizeOf, spriteButton, tableBars, tableRect, TRANSPARENT, type ArtLookup } from "../chrome";
import type { Screen } from "../screen";
import { TEXTURE_QUALITIES, TEXTURE_RES, type Settings, type TextureQuality } from "../../save/schema";
import { rect, type UiViewport } from "../viewport";
import { listMetrics, sliderValueAt, type Widget } from "../widgets";

type SaveData = ReturnType<Game["save"]["get"]>;

function artOf(game: Game): ArtLookup {
  return game.ui?.art ?? NO_ART;
}

/** Writes a settings change through and applies it to what is running. */
function changeSettings(game: Game, mutate: (s: Settings) => void): void {
  game.save.set((s: SaveData) => mutate(s.settings));
  const settings = game.save.get().settings;
  game.audio.setVolumes({ music: settings.musicVolume, sfx: settings.sfxVolume });
  game.audio.setMenuMusic(settings.menuMusic);
  game.scene.particlesEnabled = settings.particles;
  game.scene.effectsEnabled = settings.shaders;
  game.save.flush();
}

/**
 * The game's text button: the label in gold on a green frame that is never
 * narrower than `width`, the label shrunk to fit inside it.
 * [gdp ButtonSprite::create(caption, width, 0, "goldFont.fnt", "GJ_button_01.png", 0, 1)]
 */
function textButton(
  art: ArtLookup,
  id: string,
  x: number,
  y: number,
  text: string,
  width: number,
  opts: { frame?: string; font?: FontName; height?: number; maxScale?: number } = {},
): Widget {
  const font = opts.font ?? "goldFont";
  const scale = art.fit?.(font, text, width, opts.maxScale ?? 1) ?? opts.maxScale ?? 1;
  const w = width + BUTTON_PAD;
  const h = opts.height ?? BUTTON_H;
  return {
    kind: "button",
    id,
    rect: rect(x - w / 2, y - h / 2, w, h),
    frame: opts.frame ?? FRAMES.button,
    label: { text, font, scale },
    labelOffset: BUTTON_LABEL_OFFSET,
  };
}

/** How much wider the frame is than its caption's room, how tall it is, and where the caption sits. [meas off the reference] */
const BUTTON_PAD = 15;
const BUTTON_H = 29;
const BUTTON_LABEL_OFFSET = { x: -3, y: 1.5 };

/**
 * A check box: the box, its press area, and the label beside it shrunk to fit.
 * [gdp GameToolbox::createToggleButton: label 8 past the box's edge]
 */
function checkbox(
  art: ArtLookup,
  id: string,
  x: number,
  y: number,
  on: boolean,
  opts: { scale: number; text?: string; textScale?: number; textWidth?: number; tint?: { r: number; g: number; b: number }; enabled?: boolean },
): Widget[] {
  const frame = on ? FRAMES.checkOn : FRAMES.checkOff;
  const out = spriteButton(art, id, x, y, frame, { scale: opts.scale, tint: opts.tint, enabled: opts.enabled });
  if (opts.text) {
    const box = sizeOf(art, FRAMES.checkOff, opts.scale);
    const lines = opts.text.split("\n");
    const widest = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
    const scale = Math.min(opts.textScale ?? 0.4, art.fit?.("bigFont", widest, opts.textWidth ?? 130, opts.textScale ?? 0.4) ?? 1);
    out.push(label(art, opts.text, x + box.w / 2 + 8, y, { scale, anchorX: 0, align: "left", tint: opts.tint }));
  }
  return out;
}

/** A slider with the blue fill the game draws up to the thumb. */
function slider(id: string, cx: number, y: number, value: number): Widget[] {
  const v = Math.max(0, Math.min(1, value));
  const groove = rect(cx - SLIDER.w / 2, y - SLIDER.h / 2, SLIDER.w, SLIDER.h);
  const inner = SLIDER.w - SLIDER.inset * 2;
  return [
    { kind: "fill", rect: rect(groove.x + SLIDER.inset, y - SLIDER.bar / 2, inner * v, SLIDER.bar), frame: FRAMES.sliderBar },
    { kind: "slider", id, rect: groove, value: v, scale: SLIDER.thumb },
  ];
}

/** The groove is the art's own size; the thumb and bar are sized to the reference. [meas] */
const SLIDER = { w: 210, h: 16, inset: 4, bar: 8, thumb: 1 };

// ---------------------------------------------------------------------------
// The hub

export class SettingsScreen implements Screen {
  readonly name = "settings";
  readonly opaque = false;
  readonly ticksBelow = false;

  constructor(private readonly game: Game) {}

  enter(): void {
    this.game.input.clear();
  }

  private get settings(): Settings {
    return this.game.save.get().settings;
  }

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const w = view.width;
    const h = view.height;
    const cx = w / 2;
    const out: Widget[] = dropDown(art, view, "Settings");

    // Seven buttons round the menu's centre. The PC layout puts Options and
    // Graphics on the second row. [OptionsLayer::customSetup :360395]
    const my = h / 2 + 80;
    out.push(textButton(art, "account", cx - 79, my, "Account", 130));
    out.push(textButton(art, "howToPlay", cx + 79, my, "How To Play", 130));
    out.push(textButton(art, "options", cx - 79, my - 40, "Options", 130));
    out.push(textButton(art, "graphics", cx + 79, my - 40, "Graphics", 130));
    out.push(textButton(art, "rate", cx - 105, my - 80, "Rate", 78));
    out.push(textButton(art, "songs", cx, my - 80, "Songs", 78));
    out.push(textButton(art, "help", cx + 105, my - 80, "Help", 78));

    // The sliders, each 20 under its name, and Menu Music beside them.
    const musicY = h / 2 - 34;
    const sfxY = musicY - 40;
    out.push(label(art, "Music", cx, musicY, { scale: 0.6 }));
    out.push(...slider("music", cx, musicY - 20, this.settings.musicVolume));
    out.push(label(art, "SFX", cx, sfxY, { scale: 0.6 }));
    out.push(...slider("sfx", cx, sfxY - 20, this.settings.sfxVolume));
    out.push(...checkbox(art, "menuMusic", cx + 145, musicY - 35, this.settings.menuMusic, { scale: 0.6 }));
    out.push(label(art, "Menu\nMusic", cx + 145, musicY - 13, { scale: 0.35, align: "center" }));

    // The vault, top right, locked behind ten user coins.
    out.push(...spriteButton(art, "vault", w - 20, h - 18, FRAMES.lockGrey));
    out.push(label(art, "10", w - 31, h - 41, { scale: 0.4 }));
    out.push({ kind: "sprite", x: w - 16, y: h - 41, frame: FRAMES.userCoin, scale: 0.5 });

    // How whoever hosts this copy set it up. Not one of the game's own buttons.
    out.push(textButton(art, "server", w - 45, 25, "Server", 60, { frame: FRAMES.buttonRed, font: "goldFont", height: 25, maxScale: 0.55 }));
    return out;
  }

  onPress(id: string): boolean {
    switch (id) {
      case "back":
        this.game.audio.ui("back");
        this.game.stack.pop();
        return true;
      case "options":
        this.game.stack.push(new OptionsScreen(this.game));
        return true;
      case "graphics":
        this.game.stack.push(new VideoOptionsScreen(this.game));
        return true;
      case "account":
        this.game.stack.push(new AccountScreen(this.game));
        return true;
      case "howToPlay":
        this.game.say("Tap, click or press Space to jump. Hold to keep jumping.");
        return true;
      case "songs":
        this.game.stack.push(new SongsScreen(this.game));
        return true;
      case "help":
        this.game.stack.push(new SupportScreen(this.game));
        return true;
      case "rate":
        this.game.say("That isn't in this version yet.");
        return true;
      case "server":
        this.game.stack.push(new HostInfoScreen(this.game));
        return true;
      case "vault":
        this.game.say("Collect 10 user coins to open the vault.");
        return true;
      case "menuMusic":
        changeSettings(this.game, (s) => void (s.menuMusic = !s.menuMusic));
        if (this.settings.menuMusic) void this.game.audio.playMenuMusic("menu");
        return true;
    }
    return false;
  }

  onDrag(id: string, _dx: number, _dy: number, x: number): boolean {
    if (id !== "music" && id !== "sfx") return false;
    const widget = this.build(this.game.view).find((w) => w.kind === "slider" && w.id === id);
    if (!widget || widget.kind !== "slider") return true;
    const value = sliderValueAt(widget, x);
    changeSettings(this.game, (s) => {
      if (id === "music") s.musicVolume = value;
      else s.sfxVolume = value;
    });
    return true;
  }

  onKey(code: string, down: boolean): boolean {
    if (down && code === "Escape") {
      this.game.stack.pop();
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// The Options pages

interface Toggle {
  id: string;
  text: string;
  info: string;
  /** Set when this version actually does what the box says. The rest keep the game's label and say so when tapped. */
  get?: (s: Settings) => boolean;
  set?: (s: Settings, on: boolean) => void;
}

interface Page {
  title: string;
  toggles: Toggle[];
  /** The folder on Audio, the face on Other. [objectsForPage of pages 5 and 6] */
  corner?: "songs" | "profile";
}

/**
 * One row of the game's own list, then a page break where it calls
 * offsetToNextPage. Ten toggles fill a page on their own.
 * [gdp MoreOptionsLayer::addToggle :362987, offsetToNextPage :362621]
 */
const NOT_YET = "That isn't in this version yet.";

const PAGES: readonly Page[] = [
  {
    title: "Gameplay",
    toggles: [
      { id: "0026", text: "Auto-Retry", info: "Restarts level upon death automatically.", get: (s) => s.autoRetry, set: (s, on) => void (s.autoRetry = on) },
      { id: "0052", text: "Enable Faster Reset", info: "Restarts in 0.5 s instead of 1.0 s upon death." },
      { id: "clickBetween", text: "Click Between Steps", info: NOT_YET },
      { id: "clickOn", text: "Click On Steps", info: NOT_YET },
      { id: "lockCursor", text: "Lock Cursor In-Game", info: NOT_YET },
      { id: "0010", text: "Flip 2-Player\nControls", info: "Flips which side controls which player during 2-player mode." },
      { id: "0011", text: "Always Limit\nControls", info: "Limits player 1 controls to one side even when dual mode is inactive." },
      { id: "thumbstick", text: "Disable Thumbstick", info: NOT_YET },
      { id: "quickKeys", text: "Enable Quick Keys", info: NOT_YET },
    ],
  },
  {
    title: "Visual",
    toggles: [
      { id: "showCursor", text: "Show Cursor In-Game", info: NOT_YET },
      { id: "0135", text: "Hide Attempts", info: "Hides the attempt counter when playing levels." },
      { id: "0015", text: "Flip Pause Button", info: "Flips the location of the pause button." },
      {
        id: "0129",
        text: "Disable Portal Guide",
        info: "Disables extra indicators on portals.",
        get: (s) => s.disablePortalGuide,
        set: (s, on) => void (s.disablePortalGuide = on),
      },
      {
        id: "0130",
        text: "Enable Orb Guide",
        info: "Enables extra indicators on orbs.",
        get: (s) => s.orbGuide,
        set: (s, on) => void (s.orbGuide = on),
      },
      { id: "0140", text: "Disable Orb Scale", info: "Disables the scaling effect on all orbs." },
      { id: "0141", text: "Disable Trigger\nOrb Scale", info: "Disables the scaling effect on only trigger orbs." },
      { id: "0172", text: "Disable Shake", info: "Disables shake effects." },
      { id: "0014", text: "Disable Explosion\nShake", info: "Disables the shake effect that happens upon death." },
      { id: "0072", text: "Disable Gravity\nEffect", info: "Disables the effect that happens upon changing gravity." },
    ],
  },
  {
    title: "Visual",
    toggles: [
      { id: "0060", text: "Default Mini Icon", info: "Sets player icon in mini mode to default." },
      { id: "0061", text: "Switch Spider\nTeleport Color", info: "Toggles between main and secondary color for the teleport effect in spider mode." },
      { id: "0062", text: "Switch Dash\nFire Color", info: "Toggles between main and secondary color for the fire effect from dash orbs." },
      { id: "0096", text: "Switch Wave\nTrail Color", info: "Toggles between main and secondary color for the trail in wave mode." },
      { id: "0174", text: "Hide Playtest Text", info: "Hides text in the top left when using start positions or ignore damage." },
      { id: "hitboxDeath", text: "Hitbox On Death", info: NOT_YET },
    ],
  },
  {
    title: "Practice",
    toggles: [
      { id: "hidePractice", text: "Hide Practice Buttons", info: NOT_YET },
      { id: "0134", text: "Hide Attempts", info: "Hides the attempt counter when playing levels in practice mode." },
      { id: "0027", text: "Enable Auto-Checkpoints", info: "Places checkpoints automatically in practice mode." },
      { id: "0068", text: "Enable Quick\nCheckpoints", info: "Tries to place checkpoints more often in practice mode." },
      { id: "0100", text: "Enable Death Effect", info: "Shows death effects in practice mode." },
      { id: "0125", text: "Enable Normal Music\nIn Editor", info: "Plays normal music in sync to editor levels in practice mode." },
      { id: "0166", text: "Show Hitboxes", info: "Shows hitboxes while in practice mode." },
      { id: "0171", text: "Disable Player Hitbox", info: "Disables the player's hitbox in practice mode\n(if hitboxes are shown)." },
    ],
  },
  {
    title: "Performance",
    toggles: [
      { id: "0023", text: "Enable Smooth Fix", info: "Makes some optimizations that can reduce lag. Disable if game speed becomes inconsistent." },
      { id: "0066", text: "Increase Draw Capacity", info: "Increases draw capacity for batch nodes at level start. Can improve performance on some levels, but may cause issues on low-end devices." },
      { id: "0108", text: "Enable Low Detail", info: "Enables low detail mode on levels that support it automatically." },
      { id: "0082", text: "Disable High Object\nAlert", info: "Removes the alert shown when starting levels with a high object count." },
      { id: "0136", text: "Enable Extra LDM", info: "Removes glow and enter effects while in low detail mode. Levels without LDM show LDM Lite." },
      { id: "0042", text: "Increase Maximum\nLevels", info: "Increases maximum locally saved levels from 10 to 100. This refers to level data, not statistics. Enabling this can make your save file considerably larger, so keeping the option off is recommended for quicker saving." },
      { id: "0119", text: "Disable Level Saving", info: "Saves level statistics as usual, but levels need to be redownloaded every time you restart the game. Makes saving and loading faster." },
      { id: "0127", text: "Save Gauntlets", info: "Saves gauntlet levels locally so they do not have to be redownloaded. Increases save time but helpful if you have poor connection." },
      { id: "0155", text: "Disable Shader\nAnti-Aliasing", info: "Disables anti-aliasing on shader effects." },
    ],
  },
  {
    title: "Audio",
    corner: "songs",
    toggles: [
      { id: "songFolder", text: "Change Custom Songs\nLocation", info: NOT_YET },
      { id: "0083", text: "Disable Song Alert", info: "Removes the alert shown when starting levels without the song downloaded." },
      { id: "0018", text: "No Song Limit", info: "Stops automatic deletion of custom songs. This is done by default to save space." },
      { id: "0142", text: "Reduce Quality\n(Read Info)", info: "Lowers audio sampling rate from 44100 Hz to 24000 Hz. Requires restarting to take effect." },
      { id: "0159", text: "Audio Fix 01", info: "Increases the audio buffer size, which may fix certain issues. Do not enable if audio is working fine. Causes a slight more audio delay. Requires restarting to take effect." },
    ],
  },
  {
    title: "Other",
    corner: "profile",
    toggles: [
      { id: "0094", text: "More Comments", info: "Shows more comments per page. Why not?" },
      { id: "0090", text: "Load Comments", info: "Loads comments automatically." },
      { id: "0073", text: "New Completed Filter", info: "Makes completed levels filter based only on percentage from update 2.1. Useful to rebeat levels for Mana Orbs." },
      { id: "0093", text: "Increase Local Levels\nPer Page", info: "Increases created and saved levels per page from 10 to 20." },
      { id: "0084", text: "Manual Level Order", info: "Places new levels last in the saved levels list. Useful if you want to manually move levels to the top." },
      { id: "0126", text: "Percentage Decimals", info: "Shows decimals in level progress." },
      { id: "0099", text: "Show Leaderboard\nPercentage", info: "Toggles viewing the leaderboard percentage you have on levels. To upload your level progress to the level leaderboard, you need to replay levels completed before 2.11." },
      { id: "0095", text: "Do Not...", info: "Does not do anything... Well, nothing useful." },
      { id: "0167", text: "Confirm Exit", info: "Adds an extra confirmation window when exiting levels." },
      { id: "0168", text: "Fast Menu", info: "Makes transitions between menu pages faster." },
    ],
  },
];

/** [gdp MoreOptionsLayer::init: GJ_square01 400 x 280] */
const OPTIONS_BOX = { w: 400, h: 280 };

export class OptionsScreen implements Screen {
  readonly name = "options";
  readonly opaque = false;
  readonly ticksBelow = false;
  private page = 0;

  constructor(private readonly game: Game) {}

  enter(): void {
    this.game.input.clear();
  }

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const cx = view.width / 2;
    const cy = view.height / 2;
    const settings = this.game.save.get().settings;
    const page = PAGES[this.page];
    const out: Widget[] = [
      shade(view, 75 / 255),
      { kind: "panel", rect: rect(cx - OPTIONS_BOX.w / 2, cy - OPTIONS_BOX.h / 2, OPTIONS_BOX.w, OPTIONS_BOX.h), frame: FRAMES.panel },
      label(art, page.title, cx, cy + OPTIONS_BOX.h / 2 - 16, { scale: 0.7 }),
    ];

    // Two columns, 48 between rows. [MoreOptionsLayer::nextPosition :362722]
    page.toggles.forEach((t, i) => {
      const x = i % 2 === 0 ? cx - 160 : cx + 32;
      const y = cy + 80 - 48 * Math.floor(i / 2);
      out.push(...checkbox(art, `toggle:${t.id}`, x, y, t.get?.(settings) ?? false, { scale: 0.8, text: t.text, textScale: 0.4, textWidth: 130 }));
      out.push(...spriteButton(art, `info:${t.id}`, x - 18, y + 16, FRAMES.infoIcon, { scale: 0.5, sizeMult: 2 }));
    });

    // [MoreOptionsLayer::init :363753 close, :363780 arrows, and the Keys
    //  button the 2.2 page adds at the title row]
    out.push(...spriteButton(art, "close", cx - 195, cy + 135, FRAMES.close, { sizeMult: 1.5 }));
    out.push(textButton(art, "keys", cx + 152, cy + 120, "Keys", 48, { frame: FRAMES.buttonRed, font: "goldFont", height: 25, maxScale: 0.55 }));
    out.push(...spriteButton(art, "prev", 20, cy, FRAMES.arrowGreen, { sizeMult: 1.5 }));
    out.push(...spriteButton(art, "next", view.width - 20, cy, FRAMES.arrowGreen, { flipX: true, sizeMult: 1.5 }));

    if (page.corner === "songs") {
      // [MoreOptionsLayer::init :363678-363731 the offset, :363627 debug, :363609 the folder]
      const field = { x: cx - 125, y: cy - 105 };
      out.push(label(art, "Music Offset (MS)", field.x, field.y + 25, { scale: 0.4 }));
      out.push({ kind: "panel", rect: rect(field.x - 50, field.y - 15, 100, 30), frame: FRAMES.offsetField, alpha: 100 / 255 });
      out.push({ kind: "button", id: "offset", rect: rect(field.x - 50, field.y - 15, 100, 30), label: { text: "", scale: 0 }, tint: TRANSPARENT });
      out.push(label(art, "Offset", field.x, field.y, { scale: 0.5, tint: { r: 120, g: 170, b: 240 } }));
      out.push(textButton(art, "debug", cx + 40, cy - 110, "Debug", 70, { frame: FRAMES.buttonRed, font: "goldFont", height: 25, maxScale: 0.6 }));
      out.push(...spriteButton(art, "songs", cx + 164, cy - 102, FRAMES.savedSongs, { sizeMult: 1.2 }));
    }
    if (page.corner === "profile") {
      // [MoreOptionsLayer::init :363658-363674, scale 0.8]
      out.push(...spriteButton(art, "parental", cx + 164, cy - 102, FRAMES.profileButton, { scale: 0.8, sizeMult: 1.2 }));
    }
    return out;
  }

  onPress(id: string): boolean {
    if (id === "close") {
      this.game.stack.pop();
      return true;
    }
    if (id === "prev" || id === "next") {
      this.page = (this.page + (id === "next" ? 1 : -1) + PAGES.length) % PAGES.length;
      return true;
    }
    if (id === "keys") {
      this.game.say("Key bindings aren't in this version yet.");
      return true;
    }
    if (id === "debug") {
      this.game.say("Audio debug isn't in this version yet.");
      return true;
    }
    if (id === "songs") {
      this.game.say("Saved songs aren't in this version yet.");
      return true;
    }
    if (id === "offset") {
      this.game.say("Music offset isn't in this version yet.");
      return true;
    }
    if (id === "parental") {
      this.game.say("Parent controls aren't in this version yet.");
      return true;
    }
    const [kind, key] = id.split(":");
    const toggle = PAGES[this.page].toggles.find((t) => t.id === key);
    if (!toggle) return false;
    if (kind === "info") {
      this.game.stack.push(new InfoScreen(this.game, "Info", toggle.info));
      return true;
    }
    if (kind === "toggle") {
      if (toggle.get && toggle.set) changeSettings(this.game, (s) => toggle.set?.(s, !toggle.get?.(s)));
      else this.game.say(NOT_YET);
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
    if (code === "ArrowLeft" || code === "ArrowRight") return this.onPress(code === "ArrowRight" ? "next" : "prev");
    return false;
  }
}

// ---------------------------------------------------------------------------
// The pause menu's options

/**
 * What the pause menu's gear opens: the level's own options, not the main
 * Options pages. One page of the same two columns, 40 apart from 90 above the
 * centre; slot 8 is held for Practice Music Sync.
 * [gdp PauseLayer::onSettings :235188; GameOptionsLayer::init :506483 (row
 *  40, text 0.4), setupOptions :499637-499903; GJOptionsLayer::nextPosition
 *  :498864, addToggleInternal :499105]
 */
const GAME_TOGGLES: readonly (Toggle & { slot: number })[] = [
  { slot: 0, id: "0026", text: "Auto-Retry", info: "", get: (s) => s.autoRetry, set: (s, on) => void (s.autoRetry = on) },
  { slot: 1, id: "0027", text: "Auto-Checkpoints", info: "" },
  { slot: 2, id: "bar", text: "Show Progress Bar", info: "", get: (s) => s.showProgressBar, set: (s, on) => void (s.showProgressBar = on) },
  { slot: 3, id: "0040", text: "Show Percentage", info: "", get: (s) => s.showPercentage, set: (s, on) => void (s.showPercentage = on) },
  { slot: 4, id: "0145", text: "Show Time", info: "" },
  { slot: 5, id: "0144", text: "Audio Visualizer", info: "" },
  { slot: 6, id: "0109", text: "Show Info Label", info: "" },
  { slot: 7, id: "0146", text: "Disable Checkpoints", info: "" },
  { slot: 9, id: "0166", text: "Show Hitboxes", info: "Shows hitboxes while in practice mode." },
];

/** The locked Practice Music Sync box's grey. [setupOptions :499893-499901] */
const LOCKED_TINT = { r: 150, g: 150, b: 150 };

export class GameOptionsScreen implements Screen {
  readonly name = "gameOptions";
  readonly opaque = false;
  readonly ticksBelow = false;
  readonly freezesLevel = true;

  constructor(private readonly game: Game) {}

  enter(): void {
    this.game.input.clear();
  }

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const cx = view.width / 2;
    const cy = view.height / 2;
    const settings = this.game.save.get().settings;
    const out: Widget[] = [
      shade(view, 75 / 255),
      { kind: "panel", rect: rect(cx - OPTIONS_BOX.w / 2, cy - OPTIONS_BOX.h / 2, OPTIONS_BOX.w, OPTIONS_BOX.h), frame: FRAMES.panel },
    ];
    const at = (slot: number) => ({ x: slot % 2 === 0 ? cx - 160 : cx + 32, y: cy + 90 - 40 * Math.floor(slot / 2) });
    for (const t of GAME_TOGGLES) {
      const { x, y } = at(t.slot);
      out.push(...checkbox(art, `toggle:${t.id}`, x, y, t.get?.(settings) ?? false, { scale: 0.8, text: t.text, textScale: 0.4, textWidth: 130 }));
      if (t.info) out.push(...spriteButton(art, `info:${t.id}`, x - 18, y + 16, FRAMES.infoIcon, { scale: 0.5, sizeMult: 2 }));
    }
    const sync = at(8);
    out.push(...checkbox(art, "toggle:sync", sync.x, sync.y, false, { scale: 0.8, text: "Practice Music Sync", textScale: 0.4, textWidth: 130, tint: LOCKED_TINT }));

    // The two UI buttons, 26 above the bottom edge, 80 either side.
    // [setupOptions :499830-499853, ButtonSprite at 0.65]
    const buttonY = cy - OPTIONS_BOX.h / 2 + 26;
    for (const [id, text, x] of [["platformerUi", "Platformer UI", cx - 80], ["practiceUi", "Practice UI", cx + 80]] as const) {
      const width = (art.measure?.("goldFont", text).width ?? 120) * 0.65;
      out.push(textButton(art, id, x, buttonY, text, width, { height: BUTTON_H * 0.65, maxScale: 0.65 }));
    }
    // [GJOptionsLayer::init :500128-500142: 0.8, 3 in from the corner]
    out.push(...spriteButton(art, "close", cx - OPTIONS_BOX.w / 2 + 3, cy + OPTIONS_BOX.h / 2 - 3, FRAMES.close, { scale: 0.8, sizeMult: 1.5 }));
    return out;
  }

  onPress(id: string): boolean {
    if (id === "close") {
      this.game.stack.pop();
      return true;
    }
    if (id === "platformerUi" || id === "practiceUi" || id === "toggle:sync") {
      this.game.say(NOT_YET);
      return true;
    }
    const [kind, key] = id.split(":");
    const toggle = GAME_TOGGLES.find((t) => t.id === key);
    if (!toggle) return false;
    if (kind === "info") {
      this.game.stack.push(new InfoScreen(this.game, "Info", toggle.info));
      return true;
    }
    if (kind === "toggle") {
      if (toggle.get && toggle.set) changeSettings(this.game, (s) => toggle.set?.(s, !toggle.get?.(s)));
      else this.game.say(NOT_YET);
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

// ---------------------------------------------------------------------------
// Video Options

const QUALITY_LABELS: Record<TextureQuality, string> = { auto: "Auto", low: "Low", medium: "Medium", high: "High" };

/**
 * Window sizes the graphics page steps through, smallest first. Only the
 * ones that fit the screen are offered, and the largest of those starts
 * selected. [gdp GameManager::resolutionForKey :113224, VideoOptionsLayer::init
 * :364671]
 */
const RESOLUTIONS: readonly { w: number; h: number }[] = [
  { w: 640, h: 480 }, { w: 720, h: 480 }, { w: 720, h: 576 }, { w: 800, h: 600 },
  { w: 1024, h: 768 }, { w: 1152, h: 864 }, { w: 1176, h: 664 }, { w: 1280, h: 720 },
  { w: 1280, h: 768 }, { w: 1280, h: 800 }, { w: 1280, h: 960 }, { w: 1280, h: 1024 },
  { w: 1360, h: 768 }, { w: 1366, h: 768 }, { w: 1440, h: 900 }, { w: 1600, h: 900 },
  { w: 1600, h: 1024 }, { w: 1600, h: 1200 }, { w: 1680, h: 1050 }, { w: 1768, h: 992 },
  { w: 1920, h: 1080 }, { w: 1920, h: 1200 }, { w: 1920, h: 1440 }, { w: 2048, h: 1536 },
  { w: 2560, h: 1440 }, { w: 2560, h: 1600 }, { w: 3840, h: 2160 },
];

/** Grey, for a control the current fullscreen choice has switched off. */
const DIMMED = { r: 120, g: 120, b: 130 };

function resolutionsThatFit(): { w: number; h: number }[] {
  const w = typeof screen !== "undefined" && screen.width > 0 ? screen.width : 1920;
  const h = typeof screen !== "undefined" && screen.height > 0 ? screen.height : 1080;
  const fit = RESOLUTIONS.filter((r) => r.w <= w && r.h <= h);
  return fit.length > 0 ? fit : [{ w, h }];
}

/** [gdp VideoOptionsLayer::init: GJ_square01 360 x 260] */
const VIDEO_BOX = { w: 360, h: 260 };

function isFullscreen(): boolean {
  return typeof document !== "undefined" && document.fullscreenElement != null;
}

export class VideoOptionsScreen implements Screen {
  readonly name = "videoOptions";
  readonly opaque = false;
  readonly ticksBelow = false;
  private quality: TextureQuality;
  private fullscreen = isFullscreen();
  private readonly resolutions = resolutionsThatFit();
  private resolution: number;
  private readonly resolutionStart: number;

  constructor(private readonly game: Game) {
    this.quality = game.save.get().settings.textureQuality;
    this.resolution = this.resolutions.length - 1;
    this.resolutionStart = this.resolution;
  }

  enter(): void {
    this.game.input.clear();
  }

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const cx = view.width / 2;
    const cy = view.height / 2;
    const out: Widget[] = [
      shade(view, 75 / 255),
      { kind: "panel", rect: rect(cx - VIDEO_BOX.w / 2, cy - VIDEO_BOX.h / 2, VIDEO_BOX.w, VIDEO_BOX.h), frame: FRAMES.panel },
      label(art, "Video Options", cx, cy + VIDEO_BOX.h / 2 - 14, { font: "goldFont", scale: 0.7 }),
    ];

    // Fullscreen turns the window-size row off and the borderless box on.
    // [gdp VideoOptionsLayer::toggleResolution :364155, createToggleButton :364707]
    const windowed = !this.fullscreen;
    const dim = windowed ? undefined : DIMMED;
    out.push(...checkbox(art, "fullscreen", cx - 65, cy + 85, this.fullscreen, { scale: 0.7, text: "Fullscreen", textScale: 0.5, textWidth: 100 }));
    out.push(...checkbox(art, "borderless", cx - 65, cy + 48, false, { scale: 0.7, text: "Borderless", textScale: 0.5, textWidth: 90, tint: windowed ? DIMMED : undefined, enabled: this.fullscreen }));
    out.push(...checkbox(art, "fix", cx + 78, cy + 48, false, { scale: 0.7, text: "Fix", textScale: 0.5, textWidth: 40, tint: DIMMED, enabled: false }));

    const size = this.resolutions[this.resolution] ?? this.resolutions[0];
    const sizeText = size ? `${size.w}x${size.h}` : "";
    const ry = cy - 8;
    out.push(label(art, "Windowed Resolution", cx, ry + 25, { font: "goldFont", scale: 0.8, tint: dim }));
    out.push(label(art, sizeText, cx, ry, { scale: art.fit?.("bigFont", sizeText, 100, 0.75) ?? 0.75, tint: dim }));
    out.push(...spriteButton(art, "resDown", cx - 70, ry, FRAMES.stepLeft, { sizeMult: 2, tint: dim, enabled: windowed }));
    out.push(...spriteButton(art, "resUp", cx + 70, ry, FRAMES.stepRight, { sizeMult: 2, tint: dim, enabled: windowed }));

    // [gdp VideoOptionsLayer::init :364748 quality at cy-66, heading 25 above, arrows 70 out, sizeMult 2]
    const qy = cy - 66;
    const qualityText = QUALITY_LABELS[this.quality];
    out.push(label(art, "Texture Quality", cx, qy + 25, { font: "goldFont", scale: 0.8 }));
    out.push(label(art, qualityText, cx, qy, { scale: art.fit?.("bigFont", qualityText, 100, 0.75) ?? 0.75 }));
    out.push(...spriteButton(art, "qualityDown", cx - 70, qy, FRAMES.stepLeft, { sizeMult: 2 }));
    out.push(...spriteButton(art, "qualityUp", cx + 70, qy, FRAMES.stepRight, { sizeMult: 2 }));

    const by = cy - VIDEO_BOX.h / 2 + 23;
    out.push(textButton(art, "cancel", cx - 55, by, "Back", 80));
    out.push(textButton(art, "apply", cx + 55, by, "Apply", 80));
    out.push(...spriteButton(art, "close", cx - VIDEO_BOX.w / 2 + 5, cy + VIDEO_BOX.h / 2 - 5, FRAMES.close, { sizeMult: 1.5 }));
    out.push(textButton(art, "advanced", cx + 132, cy + 110, "Advanced", 60, { frame: FRAMES.buttonRed, font: "goldFont", height: 25, maxScale: 0.6 }));
    return out;
  }

  onPress(id: string): boolean {
    switch (id) {
      case "close":
      case "cancel":
        this.game.stack.pop();
        return true;
      case "fullscreen":
        this.fullscreen = !this.fullscreen;
        return true;
      case "borderless":
        if (!this.fullscreen) return true;
        this.game.say("Borderless isn't in this version yet.");
        return true;
      case "fix":
        this.game.say("That isn't in this version yet.");
        return true;
      case "advanced":
        this.game.say("Advanced graphics aren't in this version yet.");
        return true;
      case "resDown":
      case "resUp": {
        if (this.fullscreen) return true;
        const n = this.resolutions.length;
        this.resolution = (this.resolution + (id === "resUp" ? 1 : -1) + n) % n;
        return true;
      }
      case "qualityDown":
      case "qualityUp": {
        const n = TEXTURE_QUALITIES.length;
        const i = Math.max(0, TEXTURE_QUALITIES.indexOf(this.quality));
        this.quality = TEXTURE_QUALITIES[(i + (id === "qualityUp" ? 1 : -1) + n) % n] ?? this.quality;
        return true;
      }
      case "apply":
        this.apply();
        return true;
    }
    return false;
  }

  private apply(): void {
    if (this.fullscreen !== isFullscreen()) {
      const done = this.fullscreen ? document.documentElement.requestFullscreen?.() : document.exitFullscreen?.();
      void done?.catch(() => this.game.say("Fullscreen isn't available here."));
    }
    const saved = this.game.save.get().settings.textureQuality;
    if (this.quality !== saved) {
      changeSettings(this.game, (s) => void (s.textureQuality = this.quality));
      // The sheets only change when the chosen quality wants different ones.
      if (TEXTURE_RES[this.quality] !== TEXTURE_RES[saved]) {
        window.location.reload();
        return;
      }
    }
    if (this.resolution !== this.resolutionStart) this.game.say("Window size isn't in this version yet.");
    this.game.stack.pop();
  }

  onKey(code: string, down: boolean): boolean {
    if (down && code === "Escape") {
      this.game.stack.pop();
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// The info popup

/** [gdp FLAlertLayer::create(…, "OK", …, 380)] */
const INFO_W = 380;

export class InfoScreen implements Screen {
  readonly name = "info";
  readonly opaque = false;
  readonly ticksBelow = false;

  constructor(
    private readonly game: Game,
    private readonly title: string,
    private readonly text: string,
  ) {}

  enter(): void {
    this.game.input.clear();
  }

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const cx = view.width / 2;
    const cy = view.height / 2;
    const body = art.measure?.("chatFont", this.text, { maxWidth: INFO_W - 60 }) ?? { width: 0, height: 20 };
    const h = Math.max(140, body.height + 100);
    const top = cy + h / 2;
    return [
      shade(view, 100 / 255),
      { kind: "panel", rect: rect(cx - INFO_W / 2, cy - h / 2, INFO_W, h), frame: FRAMES.panel },
      label(art, this.title, cx, top - 25, { font: "goldFont", scale: 0.9 }),
      label(art, this.text, cx, (top - 45 + cy - h / 2 + 50) / 2, { font: "chatFont", maxWidth: INFO_W - 60, align: "center" }),
      textButton(art, "ok", cx, cy - h / 2 + 28, "OK", 40),
    ];
  }

  onPress(id: string): boolean {
    if (id !== "ok") return false;
    this.game.stack.pop();
    return true;
  }

  onKey(code: string, down: boolean): boolean {
    if (down && (code === "Escape" || code === "Enter" || code === "Space")) {
      this.game.stack.pop();
      return true;
    }
    return false;
  }
}

/** What the Server page says about how online levels are reached. */
export function connectionText(config: HostConfig): string {
  switch (config.server.mode) {
    case "direct":
      return "Straight to RobTop's servers";
    case "hostApi": {
      let host = config.server.hostApi;
      try {
        host = new URL(host).host;
      } catch {
        /* shown as written */
      }
      return `Through ${host}`;
    }
    default:
      return "Through this site";
  }
}

/** The host's setup, read-only: where online levels come from and who hosts this copy. */
export class HostInfoScreen implements Screen {
  readonly name = "hostInfo";
  readonly opaque = false;
  readonly ticksBelow = false;

  constructor(private readonly game: Game) {}

  enter(): void {
    this.game.input.clear();
  }

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const cx = view.width / 2;
    const cy = view.height / 2;
    const config = hostConfig();
    const h = 200;
    const top = cy + h / 2;
    const row = (name: string, value: string, y: number): Widget[] => [
      label(art, name, cx, y, { font: "goldFont", scale: 0.6 }),
      label(art, value, cx, y - 20, { font: "chatFont", maxWidth: INFO_W - 60 }),
    ];
    return [
      shade(view, 100 / 255),
      { kind: "panel", rect: rect(cx - INFO_W / 2, cy - h / 2, INFO_W, h), frame: FRAMES.panel },
      label(art, "Server", cx, top - 25, { font: "goldFont", scale: 0.9 }),
      ...row("Online levels", connectionText(config), top - 58),
      ...row("Hosted by", config.hostedBy || "Not set", top - 104),
      label(art, "Set by whoever hosts this copy of the game.", cx, top - 146, { font: "chatFont", scale: 0.7, alpha: 0.7 }),
      textButton(art, "ok", cx, cy - h / 2 + 24, "OK", 40),
    ];
  }

  onPress(id: string): boolean {
    if (id !== "ok") return false;
    this.game.stack.pop();
    return true;
  }

  onKey(code: string, down: boolean): boolean {
    if (down && (code === "Escape" || code === "Enter" || code === "Space")) {
      this.game.stack.pop();
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// The drop-downs Settings opens: Account, Soundtrack and Support

/** What every drop-down opened from Settings shares: Settings hides, Escape and back close it. */
abstract class SettingsDropDown implements Screen {
  abstract readonly name: string;
  readonly opaque = false;
  readonly ticksBelow = false;

  constructor(
    protected readonly game: Game,
    readonly hidesOpener = true,
  ) {}

  enter(): void {
    this.game.input.clear();
  }

  abstract build(view: UiViewport): Widget[];

  protected close(): void {
    this.game.audio.ui("back");
    this.game.stack.pop();
  }

  onPress(id: string): boolean {
    if (id !== "back") return false;
    this.close();
    return true;
  }

  onKey(code: string, down: boolean): boolean {
    if (down && code === "Escape") {
      this.close();
      return true;
    }
    return false;
  }
}

/**
 * The account page. Progress here is kept with the player's sign-in, so it
 * shows the game's signed-in page with Save in place of the cloud buttons.
 * [gdp AccountLayer::customSetup :409330, updatePage :409200]
 */
export class AccountScreen extends SettingsDropDown {
  readonly name = "account";

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const cx = view.width / 2;
    const cy = view.height / 2;
    const out = dropDown(art, view, "Account");
    out.push(label(art, "Signed in", cx, cy + 87, { font: "goldFont", scale: 0.8 }));
    out.push(label(art, "Your progress saves automatically.", cx, cy + 75, { scale: 0.4, anchorY: 1, align: "center" }));
    out.push(textButton(art, "save", cx, cy + 30, "Save", 160));
    out.push(textButton(art, "accountHelp", cx, cy - 15, "Help", 160));
    return out;
  }

  onPress(id: string): boolean {
    if (id === "save") {
      this.game.save.flush();
      this.game.say("Saved.");
      return true;
    }
    if (id === "accountHelp") {
      this.game.stack.push(new InfoScreen(this.game, "Account", "Your stars, coins, icons and settings are saved as you play, and come back whenever you sign in."));
      return true;
    }
    return super.onPress(id);
  }
}

/** One soundtrack row's height. [meas off the reference] */
const SONG_ROW = 60;
/** The practice track the game lists last. [gdp SongsLayer::customSetup :374763, SongObject -1] */
const PRACTICE_SONG = { title: "Practice: Stay Inside Me", artist: "OcularNebula", file: "StayInsideMe.mp3" };

/**
 * The official soundtrack, one row a song with View to listen.
 * [gdp SongsLayer::customSetup :374667, SongCell::loadFromObject :133259]
 */
export class SongsScreen extends SettingsDropDown {
  readonly name = "songs";
  private scroll = 0;

  private songs(): Array<{ title: string; artist: string; file: string }> {
    const out: Array<{ title: string; artist: string; file: string }> = [];
    for (let i = 0; i <= 21; i++) {
      const s = this.game.strings.song(i);
      if (s) out.push({ title: s.title, artist: s.artist ?? "", file: s.file });
    }
    out.push(PRACTICE_SONG);
    return out;
  }

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const list = tableRect(view);
    const out = dropDown(art, view, "Soundtrack");
    const rows = this.songs().map((song, i): Widget[] => {
      const row: Widget[] = [{ kind: "fill", rect: rect(0, 0, list.w, SONG_ROW), tint: listRowTint(i) }];
      const titleScale = Math.min(0.7, art.fit?.("bigFont", song.title, 240, 0.7) ?? 0.7);
      row.push(label(art, song.title, 10, SONG_ROW / 2 + 10, { scale: titleScale, anchorX: 0 }));
      if (song.artist) {
        const by = `By ${song.artist}`;
        row.push(label(art, by, 12, SONG_ROW / 2 - 11, { font: "goldFont", scale: Math.min(0.7, art.fit?.("goldFont", by, 140, 0.7) ?? 0.7), anchorX: 0 }));
      }
      row.push(textButton(art, `song:${i}`, list.w - 9 - (45 + BUTTON_PAD) / 2, SONG_ROW / 2, "View", 45, { font: "bigFont", maxScale: 0.6, height: 30 }));
      return row;
    });
    out.push({ kind: "list", id: "songs", rect: list, rowSize: SONG_ROW, rows, scroll: this.scroll });
    out.push(...tableBars(art, view, "Soundtrack"));
    return out;
  }

  onPress(id: string): boolean {
    if (id.startsWith("song:")) {
      const song = this.songs()[Number(id.slice(5))];
      if (song) this.game.stack.push(new SongInfoScreen(this.game, song));
      return true;
    }
    return super.onPress(id);
  }

  onDrag(id: string, _dx: number, dy: number): boolean {
    if (id !== "songs") return false;
    const rows = this.songs().map(() => []);
    const metrics = listMetrics({ kind: "list", id, rect: tableRect(this.game.view), rowSize: SONG_ROW, rows, scroll: this.scroll });
    this.scroll = Math.max(0, Math.min(metrics.maxScroll, this.scroll + dy));
    return true;
  }

  exit(): void {
    this.game.audio.stopSong();
  }
}

/** A song's card: its name and artist, and a button to listen. */
class SongInfoScreen implements Screen {
  readonly name = "songInfo";
  readonly opaque = false;
  readonly ticksBelow = false;

  constructor(
    private readonly game: Game,
    private readonly song: { title: string; artist: string; file: string },
  ) {}

  enter(): void {
    this.game.input.clear();
  }

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const cx = view.width / 2;
    const cy = view.height / 2;
    const playing = this.game.audio.isPlayingSong(this.song.file);
    const out: Widget[] = [
      shade(view, 100 / 255),
      { kind: "panel", rect: rect(cx - 170, cy - 75, 340, 150), frame: FRAMES.panel },
      label(art, this.song.title, cx, cy + 45, { scale: Math.min(0.7, art.fit?.("bigFont", this.song.title, 300, 0.7) ?? 0.7) }),
    ];
    if (this.song.artist) out.push(label(art, `By ${this.song.artist}`, cx, cy + 18, { font: "goldFont", scale: 0.7 }));
    out.push(textButton(art, "listen", cx - 55, cy - 40, playing ? "Stop" : "Play", 80));
    out.push(textButton(art, "ok", cx + 55, cy - 40, "OK", 80));
    return out;
  }

  onPress(id: string): boolean {
    if (id === "listen") {
      if (this.game.audio.isPlayingSong(this.song.file)) this.game.audio.stopSong();
      else this.game.audio.playSong(this.song.file);
      return true;
    }
    if (id !== "ok") return false;
    this.game.stack.pop();
    return true;
  }

  onKey(code: string, down: boolean): boolean {
    if (down && (code === "Escape" || code === "Enter")) {
      this.game.stack.pop();
      return true;
    }
    return false;
  }
}

const SUPPORT_LINKS = [
  { name: "FAQ", url: "https://www.boomlings.com/FAQ" },
  { name: "Editor Guide", url: "https://www.boomlings.com/GDEditor" },
  { name: "Rating System", url: "https://www.boomlings.com/GDRating" },
  { name: "Leaderboards", url: "https://www.boomlings.com/GDLeaderboards" },
];

const SFX_CREDITS = [
  { name: "Epic Stock Media", url: "https://epicstockmedia.com" },
  { name: "Cyberwave Orchestra", url: "https://cyberwaveorchestra.com" },
  { name: "Fusehive", url: "http://fusehive.com" },
  { name: "SoundMorph", url: "https://www.soundmorph.com" },
  { name: "Stormwave Audio", url: "https://stormwave-audio.com" },
  { name: "David Dumais", url: "https://www.daviddumaisaudio.com" },
];

/**
 * Support: the game's links, who made it, and Low Detail Mode, which here
 * turns off particles and shader effects together.
 * [gdp SupportLayer::customSetup :372958, createToggleButton :372872]
 */
export class SupportScreen extends SettingsDropDown {
  readonly name = "support";

  private get lowDetail(): boolean {
    const s = this.game.save.get().settings;
    return !s.particles && !s.shaders;
  }

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const cx = view.width / 2;
    const cy = view.height / 2;
    const out = dropDown(art, view, "Support");
    const small = { font: "bigFont" as const, maxScale: 0.5, height: 30 };
    out.push(textButton(art, "links", cx - 100, cy + 80, "Links", 70, small));
    out.push(textButton(art, "contact", cx, cy + 80, "Contact", 70, small));
    out.push(textButton(art, "sfx", cx + 100, cy + 80, "SFX", 70, small));
    out.push(textButton(art, "privacy", cx - 50, cy + 40, "Privacy", 70, small));
    out.push(textButton(art, "tos", cx + 50, cy + 40, "ToS", 70, small));

    out.push({ kind: "sprite", x: cx - 55, y: cy + 2, frame: FRAMES.developedBy });
    out.push(...spriteButton(art, "robtopSite", cx + 45, cy + 2, FRAMES.robtop));
    // The port's own credit, under RobTop's.
    out.push(label(art, "Ported By:", cx - 55, cy - 24, { font: "chatFont", scale: 0.75 }));
    out.push(label(art, "Proton", cx + 45, cy - 24, { font: "bigFont", scale: 0.6 }));
    out.push({ kind: "sprite", x: cx - 55, y: cy - 50, frame: FRAMES.poweredBy });
    out.push(...spriteButton(art, "cocos", cx + 45, cy - 50, FRAMES.cocosLogo));
    out.push(label(art, "FMOD Studio by Firelight Technologies Pty Ltd.", cx, cy - 73, { font: "goldFont", scale: 0.35 }));

    const boxX = cx - 160;
    const boxY = cy - 90;
    out.push(...spriteButton(art, "lowDetail", boxX, boxY, this.lowDetail ? FRAMES.checkOn : FRAMES.checkOff, { scale: 0.8, sizeMult: 1.5 }));
    const boxW = sizeOf(art, FRAMES.checkOff, 0.8).w;
    const text = "Low Detail Mode";
    out.push(label(art, text, boxX + boxW / 2 + 8, boxY, { scale: Math.min(0.35, art.fit?.("bigFont", text, 120, 0.35) ?? 0.35), anchorX: 0 }));
    return out;
  }

  onPress(id: string): boolean {
    switch (id) {
      case "links":
        this.game.stack.push(new LinkListScreen(this.game, "Support Links", SUPPORT_LINKS));
        return true;
      case "sfx":
        this.game.stack.push(new LinkListScreen(this.game, "SFX Library Credits", SFX_CREDITS));
        return true;
      case "contact":
        this.game.stack.push(new InfoScreen(this.game, "Contact", "This version of the game runs here rather than in RobTop's app, so RobTop's support can't help with it."));
        return true;
      case "privacy":
        openLink("https://www.robtopgames.com/privacy");
        return true;
      case "tos":
        openLink("https://www.robtopgames.com/tos");
        return true;
      case "robtopSite":
        openLink("https://www.robtopgames.com");
        return true;
      case "cocos":
        openLink("https://www.cocos2d-x.org");
        return true;
      case "lowDetail": {
        const on = !this.lowDetail;
        changeSettings(this.game, (s) => {
          s.particles = !on;
          s.shaders = !on;
        });
        if (on) this.game.stack.push(new InfoScreen(this.game, "Low Detail Mode", "Low detail mode disables a lot of visual effects to increase performance."));
        return true;
      }
    }
    return super.onPress(id);
  }
}

/** A titled list of links, one button each. [gdp URLViewLayer] */
class LinkListScreen implements Screen {
  readonly name = "links";
  readonly opaque = false;
  readonly ticksBelow = false;

  constructor(
    private readonly game: Game,
    private readonly title: string,
    private readonly links: ReadonlyArray<{ name: string; url: string }>,
  ) {}

  enter(): void {
    this.game.input.clear();
  }

  build(view: UiViewport): Widget[] {
    const art = artOf(this.game);
    const cx = view.width / 2;
    const cy = view.height / 2;
    const pitch = 34;
    const h = this.links.length * pitch + 110;
    const top = cy + h / 2;
    const out: Widget[] = [
      shade(view, 100 / 255),
      { kind: "panel", rect: rect(cx - 160, cy - h / 2, 320, h), frame: FRAMES.panel },
      label(art, this.title, cx, top - 25, { font: "goldFont", scale: 0.8 }),
    ];
    this.links.forEach((link, i) => {
      out.push(textButton(art, `link:${i}`, cx, top - 62 - i * pitch, link.name, 200, { font: "bigFont", maxScale: 0.5, height: 28 }));
    });
    out.push(textButton(art, "ok", cx, cy - h / 2 + 28, "OK", 40));
    return out;
  }

  onPress(id: string): boolean {
    if (id.startsWith("link:")) {
      const link = this.links[Number(id.slice(5))];
      if (link) openLink(link.url);
      return true;
    }
    if (id !== "ok") return false;
    this.game.stack.pop();
    return true;
  }

  onKey(code: string, down: boolean): boolean {
    if (down && (code === "Escape" || code === "Enter")) {
      this.game.stack.pop();
      return true;
    }
    return false;
  }
}
