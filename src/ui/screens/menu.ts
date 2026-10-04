// The loading screen and the main menu, laid out where the game lays them.
//
// Every position here is the game's own, from `MenuLayer::init` and
// `LoadingLayer::init`, measured from the window's edges the way the game
// measures them: the logo hangs 50 under the top, the three big buttons sit
// 10 above the centre and 110 apart, the row of round buttons stands 45 off
// the bottom, the social icons 22 in from the left. The sky behind cycles
// through the game's own sequence of colours and an icon in a random mode runs
// along the ground — tap it and it explodes, because that is what the menu is.

import type { IconKind } from "../../assets/iconTypes";
import { OFFICIAL_LEVELS } from "../../assets/levels";
import type { Game } from "../../game/game";
import { parseLevel } from "../../level/decode";
import type { GameMode, Level, Speed } from "../../level/types";
import { xSpeedFor } from "../../physics/constants";
import { createSim } from "../../physics/index";
import { TICK_RATE, type Sim } from "../../physics/types";
import { clipFor } from "../../render/player";
import { MENU_CUBE_SECRETS } from "../../save/unlocks";
import { FRAMES } from "../art";
import { hostConfig } from "../../online/hostConfig";
import { backArrow, label, openLink, spriteButton, type ArtLookup } from "../chrome";
import type { Tint } from "../draw";
import { UI_COLOURS } from "../render";
import type { Screen } from "../screen";
import type { UiViewport } from "../viewport";
import type { Widget } from "../widgets";
import { CreatorScreen } from "./creator";
import { IconKitScreen } from "./iconKit";
import { LevelSelectScreen } from "./levelSelect";
import { RewardsScreen } from "./rewards";
import { SettingsScreen } from "./settings";
import { AchievementsScreen, StatsScreen } from "./stats";

/** Where the menu's ground line is. [gdp MenuGameLayer::init :237826, GJGroundLayer at y 90] */
export const MENU_GROUND_TOP = 90;

/**
 * The sky's colours, in the order the menu cycles them: the game's blue first,
 * then seven entries of the player colour table, round and round.
 * [gdp MenuGameLayer::getBGColor, gd-ida-decomp.cpp:237020-237070]
 */
export const MENU_SKY_SEQUENCE: ReadonlyArray<number | null> = [null, 7, 8, 9, 10, 11, 1, 3];

/** How long each tint takes, and how long it stays. [gdp MenuGameLayer::updateColor, CCTintTo over 4 s] */
const SKY_STEP_SECONDS = 4;

/** The ground is the sky's colour at four fifths. [gdp MenuGameLayer::updateColor :237106] */
const GROUND_SHADE = 0.8;

/** The game's links, which its buttons open in the browser. */
const LINKS = {
  robtop: "https://www.robtopgames.com/",
  facebook: "https://www.facebook.com/geometrydash",
  twitter: "https://twitter.com/RobTopGames",
  youtube: "https://www.youtube.com/user/RobTopGames",
  twitch: "https://www.twitch.tv/robtop",
  discord: "https://discord.gg/geometrydash",
  newgrounds: "https://www.newgrounds.com/audio",
  moreGames: "https://www.robtopgames.com/",
} as const;

function lerpTint(a: Tint, b: Tint, t: number): Tint {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

function shaded(c: Tint, by: number): Tint {
  return { r: c.r * by, g: c.g * by, b: c.b * by };
}

/**
 * What the game shows while it decodes 142 MiB of art: the logo over the
 * blue sky, a bar, and one of the game's own loading tips picked the way the
 * game picks them.
 * [gdp LoadingLayer::init, gd-ida-decomp.cpp:83330-83450]
 */
export class LoadingScreen implements Screen {
  readonly name = "loading";
  readonly opaque = true;
  private what = "Loading";
  private tip = "Loading resources";
  private progress = 0;

  constructor(private readonly game: Game) {}

  step(what: string, fraction: number): void {
    this.what = what;
    this.progress = fraction;
    // The tips only exist once the strings have loaded, which is most of the way
    // through; before that the game's own "Loading resources" is right anyway.
    this.tip = this.game.strings?.loadingTip(Math.floor(Math.random() * 100)) ?? this.tip;
  }

  build(view: UiViewport): Widget[] {
    const cx = view.width / 2;
    const cy = view.height / 2;
    const art = this.game.ui?.art;
    const logoWidth = art?.quad(FRAMES.logo)?.w ?? 425;
    const out: Widget[] = [];
    // The sky alone, in the game's blue; the loading screen has no ground.
    out.push({ kind: "backdrop", tint: UI_COLOURS.menuBlue, groundTint: UI_COLOURS.menuBlue, offset: 0, groundTop: -1000 });
    out.push({ kind: "sprite", x: cx, y: cy, frame: FRAMES.logo, scale: Math.min(1, (view.width - 40) / logoWidth) });
    out.push({
      kind: "progress",
      x: cx,
      y: cy - 40,
      frame: FRAMES.sliderGroove,
      fillFrame: FRAMES.sliderBar,
      fillInset: { x: 2, y: 4 },
      value: this.progress,
      fill: { r: 255, g: 255, b: 255 },
    });
    out.push({ kind: "text", x: cx, y: cy - 78, text: this.tip, font: "goldFont", scale: 0.7, align: "center", maxWidth: view.width - 60 });
    out.push({ kind: "text", x: cx, y: cy - 100, text: this.what, font: "goldFont", scale: 0.5, align: "center", tint: UI_COLOURS.dim });
    return out;
  }
}

/**
 * The icon that runs along the menu's ground: a player of the game's own, in
 * one of its eight modes, on a level with nothing in it.
 */
interface Runner {
  sim: Sim;
  /** Where the player's x of 0 is on the screen. */
  x0: number;
  mode: GameMode;
  /** The mode's own icon, and the cube a ship or UFO carries. */
  icon: number;
  cube: number;
  colour1: number;
  colour2: number;
  glow: boolean;
  /** Whether the button is down, as the last roll left it. */
  hold: boolean;
  /** Seconds alive, for the robot's and spider's animation. */
  clock: number;
}

/**
 * The modes a fresh runner can roll, in order, each with the roll it has to
 * come in under. One the runner already is is passed over for the next, and
 * past the last it is a cube. [gdp MenuGameLayer::resetPlayer :237246-237336]
 */
const MODE_ROLL: ReadonlyArray<readonly [number, GameMode]> = [
  [0.12, "ship"],
  [0.24, "ball"],
  [0.36, "ufo"],
  [0.48, "wave"],
  [0.6, "robot"],
  [0.7, "spider"],
  [0.8, "swing"],
];

/**
 * The speed a fresh runner rolls: 3x, 2x, half, 4x, else 1x.
 * [gdp MenuGameLayer::resetPlayer :237373-237403, the five speeds' time mods]
 */
function rollSpeed(): Speed {
  const r = Math.random();
  if (r < 0.2) return 3;
  if (r < 0.4) return 2;
  if (r < 0.6) return 0;
  if (r < 0.65) return 4;
  return 1;
}

/** How often the runner decides whether to hold the button. [gdp MenuGameLayer::init :237884, every 0.25 s] */
const JUMP_ROLL_SECONDS = 0.25;

/** How near a tap has to land to the runner to destroy it. [gdp MenuGameLayer::ccTouchBegan :237625-237628] */
const TAP_RADIUS = 30;
/** Taps this close to the left edge never count. */
const TAP_MIN_X = 50;

/** A square of the explosion. */
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  tint: Tint;
  alpha: number;
}

/** The disc that grows where the runner was destroyed. */
interface Burst {
  x: number;
  y: number;
  age: number;
  tint: Tint;
}

/**
 * The explosion: `explodeEffect.plist`, a hundred squares at once in the
 * runner's colour, and a disc from 10 to 90 over half a second.
 * [gdp MenuGameLayer::destroyPlayer :237559-237592; particles.json explodeEffect]
 */
const SPARKS = 100;
const SPARK_SPEED = 250;
const SPARK_SPEED_VARIANCE = 150;
const SPARK_LIFE_VARIANCE = 0.8;
const SPARK_SIZE = 10;
const SPARK_SIZE_VARIANCE = 5;
const SPARK_SPREAD = 10;
const BURST_FROM = 10;
const BURST_TO = 90;
const BURST_SECONDS = 0.5;

/** The icon kind that draws each mode. */
const MODE_ICON: Record<GameMode, IconKind> = {
  cube: "cube",
  ship: "ship",
  ball: "ball",
  ufo: "ufo",
  wave: "wave",
  robot: "robot",
  spider: "spider",
  swing: "swing",
};

/** A level with nothing in it, which the runner's player runs along. */
function emptyLevel(): Level {
  const level = parseLevel("kA13,0;");
  level.lengthUnits = 1e9;
  return level;
}

/** -1 to 1. */
function spread(): number {
  return Math.random() * 2 - 1;
}

export class MainMenuScreen implements Screen {
  readonly name = "menu";
  readonly opaque = true;
  /** How far the ground has scrolled, in units. */
  private travelled = 0;
  private skyIndex = Math.floor(Math.random() * MENU_SKY_SEQUENCE.length);
  private skyClock = 0;
  private runner: Runner | null = null;
  /** Steps of the runner's player owed to the clock, in 240ths of a second. */
  private runnerSteps = 0;
  private jumpClock = 0;
  /**
   * Set once a runner has been destroyed: a cube or robot jumps twice as
   * often from then on. [gdp MenuGameLayer::destroyPlayer :237552 (+324),
   *  read by tryJump :236822-236823]
   */
  private destroyedOne = false;
  private sparks: Spark[] = [];
  private bursts: Burst[] = [];

  constructor(private readonly game: Game) {}

  enter(): void {
    void this.game.audio.playMenuMusic("menu");
    this.runner = this.newRunner();
    this.bindRunnerPages();
  }

  /** The kinds a runner draws: its mode's own and, in a ship or UFO, the cube. */
  private runnerIcons(r: Runner): Array<{ kind: IconKind; id: number }> {
    const kind = MODE_ICON[r.mode];
    const out = [{ kind, id: r.icon }];
    if (r.mode === "ship" || r.mode === "ufo") out.push({ kind: "cube", id: r.cube });
    return out;
  }

  private runnerPages(r: Runner): number[] {
    const pages: number[] = [];
    for (const { kind, id } of this.runnerIcons(r)) {
      const icon = this.game.icons?.icon(kind, id);
      if (icon && !pages.includes(icon.page)) pages.push(icon.page);
    }
    return pages;
  }

  /** The runner's icon pages have to be on a unit before it can be drawn. */
  private bindRunnerPages(): void {
    const r = this.runner;
    if (r) void this.game.scene.bindPages(this.runnerPages(r));
  }

  /** A random icon of `kind`, as the game rolls one from the whole set. */
  private randomIcon(kind: IconKind): number {
    const ids = this.game.icons?.file.kinds[kind]?.icons.map((i) => i.id).filter((id) => id >= 1) ?? [1];
    return ids[Math.floor(Math.random() * ids.length)] ?? 1;
  }

  /**
   * A fresh runner off the left edge: a random mode, icon and pair of
   * colours, one in five with its glow, one in ten mini, at a random speed.
   * [gdp MenuGameLayer::resetPlayer, gd-ida-decomp.cpp:237215-237410]
   */
  private newRunner(): Runner {
    const colours = this.game.strings?.playerColourCount ?? 1;
    const glow = Math.random() > 0.8;
    const colour1 = Math.floor(Math.random() * colours);
    const colour2 = Math.floor(Math.random() * colours);
    const roll = Math.random();
    const previous = this.runner?.mode;
    let mode: GameMode = "cube";
    for (const [limit, candidate] of MODE_ROLL) {
      if (roll < limit && candidate !== previous) {
        mode = candidate;
        break;
      }
    }
    const mini = Math.random() <= 0.1;
    const sim = createSim(emptyLevel(), this.game.objectTable, {
      visuals: false,
      start: { x: 0, y: 15, mode, speed: rollSpeed(), mini },
    });
    this.runnerSteps = 0;
    return {
      sim,
      x0: -100 - Math.random() * 500,
      mode,
      icon: this.randomIcon(MODE_ICON[mode]),
      cube: this.randomIcon("cube"),
      colour1,
      colour2,
      glow,
      hold: false,
      clock: 0,
    };
  }

  /**
   * Whether the runner holds the button for the next quarter second: a chance
   * per mode, by how high it is. The ball and the spider never press; a ship
   * only low down, a wave always at the bottom and never at the top.
   * [gdp MenuGameLayer::tryJump :236798-236891]
   */
  private rollJump(r: Runner): void {
    const s = r.sim.state;
    const top = this.game.view.height - MENU_GROUND_TOP;
    let chance = this.destroyedOne ? 0.4 : 0.2;
    switch (s.mode) {
      case "ship":
        chance = s.y < 115 ? 0.3 : 0;
        break;
      case "ball":
      case "spider":
        chance = -1;
        break;
      case "ufo":
        chance = s.y < 215 ? 0.4 : 0;
        break;
      case "wave":
        chance = s.y < 75 ? 1 : s.y > top - 75 ? 0 : 0.5;
        break;
      case "swing":
        chance = (!s.flipped && s.y < 60) || (s.flipped && s.y > 120) ? 0.9 : 0;
        break;
    }
    const flying = s.mode === "ship" || s.mode === "ufo" || s.mode === "wave" || s.mode === "swing";
    r.hold = Math.random() <= chance && (s.onGround || flying);
  }

  update(dt: number): void {
    // The ground travels at the cube's own 1x speed, and the sky at a tenth of
    // it. [gdp MenuGameLayer::update :237490-237509]
    this.travelled += xSpeedFor(1) * 60 * dt;
    this.skyClock += dt;
    if (this.skyClock >= SKY_STEP_SECONDS) {
      this.skyClock -= SKY_STEP_SECONDS;
      this.skyIndex = (this.skyIndex + 1) % MENU_SKY_SEQUENCE.length;
    }
    this.stepRunner(dt);
    this.stepEffects(dt);
    // The level draws its player off the same units. Coming back from one
    // uncovers this screen without entering it again, so the runner's pages
    // have to be checked for rather than assumed.
    const r = this.runner;
    if (r && this.runnerPages(r).some((page) => !this.game.scene.iconUnits.has(page))) this.bindRunnerPages();
  }

  private stepRunner(dt: number): void {
    const r = this.runner;
    if (!r) return;
    // A long stall (a hidden tab) is not caught up step by step.
    const wall = Math.min(dt, 0.1);
    r.clock += wall;
    this.jumpClock += wall;
    if (this.jumpClock >= JUMP_ROLL_SECONDS) {
      this.jumpClock %= JUMP_ROLL_SECONDS;
      this.rollJump(r);
    }
    this.runnerSteps += wall * TICK_RATE;
    while (this.runnerSteps >= 1) {
      this.runnerSteps -= 1;
      r.sim.step({ jump: r.hold, left: false, right: false });
    }
    if (r.x0 + r.sim.state.x > this.game.view.width + 100) {
      this.runner = this.newRunner();
      this.bindRunnerPages();
    }
  }

  private stepEffects(dt: number): void {
    for (const s of this.sparks) {
      s.age += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    this.sparks = this.sparks.filter((s) => s.age < s.life);
    for (const b of this.bursts) b.age += dt;
    this.bursts = this.bursts.filter((b) => b.age < BURST_SECONDS);
  }

  /** Where the runner is on the screen. */
  private runnerAt(r: Runner): { x: number; y: number } {
    return { x: r.x0 + r.sim.state.x, y: MENU_GROUND_TOP + r.sim.state.y };
  }

  /**
   * A tap on the runner destroys it. Cube 55 and cube 50, full size, each
   * earn an achievement of their own as well.
   * [gdp MenuGameLayer::ccTouchBegan :237610-237659]
   */
  onTouch(x: number, y: number): boolean {
    const r = this.runner;
    if (!r || x <= TAP_MIN_X) return false;
    const at = this.runnerAt(r);
    if (Math.hypot(at.x - x, at.y - y) > TAP_RADIUS) return false;
    const s = r.sim.state;
    const secret = s.mode === "cube" && !s.mini ? (MENU_CUBE_SECRETS[r.cube] ?? null) : null;
    this.destroyRunner(r, at, secret);
    return true;
  }

  /** [gdp MenuGameLayer::destroyPlayer :237527-237594] */
  private destroyRunner(r: Runner, at: { x: number; y: number }, secret: string | null): void {
    const before = this.game.earnedAchievements();
    this.destroyedOne = true;
    this.game.save.recordMenuKill(secret);
    this.game.audio.ui("menuDeath", 0.5);
    const base = this.game.strings.playerColour(r.colour1);
    const channel = (v: number): number => Math.max(0, Math.min(255, v + spread() * 0.1 * 255));
    for (let i = 0; i < SPARKS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = SPARK_SPEED + spread() * SPARK_SPEED_VARIANCE;
      this.sparks.push({
        x: at.x + spread() * SPARK_SPREAD,
        y: at.y + spread() * SPARK_SPREAD,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        age: 0,
        life: Math.max(0, spread() * SPARK_LIFE_VARIANCE),
        size: Math.max(0, SPARK_SIZE + spread() * SPARK_SIZE_VARIANCE),
        tint: { r: channel(base.r), g: channel(base.g), b: channel(base.b), additive: true },
        alpha: Math.max(0, Math.min(1, 1 + spread() * 0.5)),
      });
    }
    this.bursts.push({ x: at.x, y: at.y, age: 0, tint: { r: base.r, g: base.g, b: base.b, additive: true } });
    this.runner = this.newRunner();
    this.bindRunnerPages();
    this.game.announceAchievements(before);
  }

  /** The sky right now: the colour it is leaving blended into the one it is reaching. */
  private skyTint(): Tint {
    const pick = (i: number): Tint => {
      const entry = MENU_SKY_SEQUENCE[i % MENU_SKY_SEQUENCE.length];
      if (entry === null || !this.game.strings) return UI_COLOURS.menuBlue;
      return this.game.strings.playerColour(entry);
    };
    const from = pick((this.skyIndex + MENU_SKY_SEQUENCE.length - 1) % MENU_SKY_SEQUENCE.length);
    const to = pick(this.skyIndex);
    return lerpTint(from, to, Math.min(1, this.skyClock / SKY_STEP_SECONDS));
  }

  build(view: UiViewport): Widget[] {
    const art: ArtLookup = this.game.ui?.art ?? { quad: () => null };
    const w = view.width;
    const h = view.height;
    const cx = w / 2;
    const cy = h / 2;
    const sky = this.skyTint();
    const out: Widget[] = [];

    out.push({ kind: "backdrop", tint: sky, groundTint: shaded(sky, GROUND_SHADE), offset: this.travelled, groundTop: MENU_GROUND_TOP });
    out.push({ kind: "fill", rect: { x: 0, y: MENU_GROUND_TOP - 0.75, w, h: 1.5 }, frame: FRAMES.floorLine, tint: { r: 255, g: 255, b: 255, additive: true } });

    const r = this.runner;
    if (r) {
      const s = r.sim.state;
      const at = this.runnerAt(r);
      const kind = MODE_ICON[r.mode];
      const entity = kind === "robot" || kind === "spider" ? this.game.scene.player.entityFor(kind) : undefined;
      out.push({
        kind: "icon",
        x: at.x,
        y: at.y,
        iconKind: kind,
        iconId: r.icon,
        scale: s.mini ? 0.6 : 1,
        rotation: s.rotation,
        flipY: s.flipped,
        rider: r.mode === "ship" || r.mode === "ufo" ? r.cube : undefined,
        clip: entity ? clipFor(s, entity) : undefined,
        clipSeconds: r.clock,
        colour1: r.colour1,
        colour2: r.colour2,
        glow: r.glow,
      });
    }

    // The disc fades as it grows; each square fades to nothing and shrinks
    // to nothing over its life, which is what the plist's black, size-0
    // finish does under additive blending.
    const circle = art.quad(FRAMES.circle)?.w ?? 1;
    for (const b of this.bursts) {
      const t = b.age / BURST_SECONDS;
      const radius = BURST_FROM + (BURST_TO - BURST_FROM) * t;
      out.push({ kind: "sprite", x: b.x, y: b.y, frame: FRAMES.circle, scale: (radius * 2) / circle, tint: b.tint, alpha: 1 - t });
    }
    const square = art.quad(FRAMES.white)?.w ?? 1;
    for (const p of this.sparks) {
      const left = 1 - p.age / p.life;
      const tint = { r: p.tint.r * left, g: p.tint.g * left, b: p.tint.b * left, additive: true };
      out.push({ kind: "sprite", x: p.x, y: p.y, frame: FRAMES.white, scale: (p.size * left) / square, tint, alpha: p.alpha });
    }

    const logoWidth = art.quad(FRAMES.logo)?.w ?? 425;
    out.push({ kind: "sprite", x: cx, y: h - 50, frame: FRAMES.logo, scale: Math.min(1, (w - 20) / logoWidth) });

    // The three big buttons. [gdp MenuLayer::init :81936-81975]
    out.push(...spriteButton(art, "play", cx, cy + 10, FRAMES.play));
    out.push(...spriteButton(art, "icons", cx - 110, cy + 10, FRAMES.garage));
    out.push(...spriteButton(art, "creator", cx + 110, cy + 10, FRAMES.creator));

    // Who hosts this copy, under the play button (host-config.json). Not the game's own.
    const { hostedBy } = hostConfig();
    if (hostedBy) {
      const playHalf = (art.quad(FRAMES.play)?.h ?? 110) / 2;
      out.push(label(art, `Hosted by ${hostedBy}`, cx, cy + 10 - playHalf - 12, { font: "goldFont", scale: 0.5, maxWidth: 200 }));
    }

    // The row along the bottom, 5 apart and centred. [:81996-82024]
    const row: Array<{ id: string; frame: string }> = [
      { id: "achievements", frame: FRAMES.achievements },
      { id: "settings", frame: FRAMES.options },
      { id: "stats", frame: FRAMES.stats },
      { id: "newgrounds", frame: FRAMES.newgrounds },
    ];
    const widths = row.map((b) => art.quad(b.frame)?.w ?? 50);
    const total = widths.reduce((a, b) => a + b, 0) + 5 * (row.length - 1);
    let x = cx - total / 2;
    row.forEach((b, i) => {
      out.push(...spriteButton(art, b.id, x + widths[i] / 2, 45, b.frame));
      x += widths[i] + 5;
    });

    // RobTop's mark and the five social buttons, bottom left. [:82026-82090]
    out.push(...spriteButton(art, "robtop", 50, 25, FRAMES.robtop, { scale: 0.8, sizeMult: 1.1 }));
    const social = { scale: 0.8, sizeMult: 1.5 };
    out.push(...spriteButton(art, "facebook", 22, 55, FRAMES.facebook, social));
    out.push(...spriteButton(art, "twitter", 51, 55, FRAMES.twitter, social));
    out.push(...spriteButton(art, "youtube", 80, 55, FRAMES.youtube, social));
    out.push(...spriteButton(art, "twitch", 109, 55, FRAMES.twitch, social));
    out.push(...spriteButton(art, "discord", 109, 26, FRAMES.discord, social));

    // More games bottom right, the daily chest at the right edge. [:82107-82118, :82257-82268]
    out.push(...spriteButton(art, "moreGames", w - 43, 45, FRAMES.moreGames, { scale: 0.9 }));
    out.push(...spriteButton(art, "daily", w - 40, cy + 20, FRAMES.daily, { sizeMult: 1.5 }));
    return out;
  }

  onPress(id: string): boolean {
    const forward = (screen: Screen): boolean => {
      this.game.audio.ui("play");
      this.game.stack.push(screen);
      return true;
    };
    switch (id) {
      case "play":
        return forward(new LevelSelectScreen(this.game));
      case "icons":
        return forward(new IconKitScreen(this.game));
      case "creator":
        return forward(new CreatorScreen(this.game));
      case "settings":
        return forward(new SettingsScreen(this.game));
      case "achievements":
        return forward(new AchievementsScreen(this.game));
      case "stats":
        return forward(new StatsScreen(this.game));
      case "daily":
        this.game.stack.push(new RewardsScreen(this.game));
        return true;
      case "robtop":
      case "facebook":
      case "twitter":
      case "youtube":
      case "twitch":
      case "discord":
      case "newgrounds":
      case "moreGames":
        openLink(LINKS[id]);
        return true;
    }
    return false;
  }
}

export function countStars(game: Game): number {
  let total = 0;
  for (const [id, progress] of Object.entries(game.save.get().levels)) {
    // A level whose star count is not in the binary contributes nothing rather
    // than a guess.
    if (progress.completions > 0) total += game.strings.facts(Number(id))?.stars ?? 0;
  }
  return total;
}

/** Coins collected in online levels, which the game counts apart from the official ones. */
export function countUserCoins(game: Game): number {
  let total = 0;
  for (const progress of Object.values(game.save.get().online)) {
    for (const got of progress.coins) if (got) total++;
  }
  return total;
}

export function countCoins(game: Game): number {
  let total = 0;
  for (const progress of Object.values(game.save.get().levels)) {
    for (const got of progress.coins) if (got) total++;
  }
  return total;
}

/** How many of the official levels are done, for the stats. */
export function countCompleted(game: Game): number {
  let total = 0;
  for (const level of OFFICIAL_LEVELS) if (game.save.level(level.id).completions > 0) total++;
  return total;
}

/** Re-exported for screens that use the same back arrow. */
export { backArrow };
