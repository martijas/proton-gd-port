// The whole game as one object: what every screen talks to.
//
// It owns the context, the batch, the level renderer, the simulation, the
// sound, the save and the screen stack, and it is the only place that knows how
// they fit together. A screen asks it to start a level or go back to the menu;
// it never reaches past this into GL or into the simulation.

import { AtlasSet } from "../assets/atlas";
import { IconSet } from "../assets/icons";
import { fetchLevel, OFFICIAL_LEVELS } from "../assets/levels";
import { loadObjects, type ObjectData } from "../assets/objectTable";
import { Scenery } from "../assets/scenery";
import { Strings } from "../assets/strings";
import { GameAudio, type LevelTrack } from "../audio/gameAudio";
import { awardedOrbs, baseOrbs, orbsFor } from "./orbs";
import { GlContext } from "../engine/gl/context";
import { SpriteBatch } from "../engine/gl/spriteBatch";
import { uploadTexture } from "../engine/gl/texture";
import { GameLoop, InputState } from "../engine/loop";
import type { Level } from "../level/types";
import type { OnlineLevel } from "../online/api";
import { loadHostConfig } from "../online/hostConfig";
import { createSim } from "../physics/index";
import { modesOf } from "../physics/levelModes";
import { Mods } from "../mods/index";
import { START_POS_ID } from "../physics/objectData";
import { countsAsJump, NO_INPUT, TICK_RATE, type Sim, type SimSnapshot } from "../physics/types";
import { Scene } from "../render/scene";
import { attachHostBridge } from "../save/host";
import { demoLevel, loadDemoLevel } from "./demoLevel";
import { TEXTURE_RES, type LevelProgress } from "../save/schema";
import { SaveStore } from "../save/store";
import { achieved, describeAchievement, progressOf } from "../save/unlocks";
import { FRAMES, UiArt } from "../ui/art";
import { UI_COLOURS } from "../ui/render";
import { rewardLabel } from "../ui/screens/stats";
import { drawIcon, type IconArt } from "../ui/icons";
import { UiInput } from "../ui/input";
import { UiRenderer } from "../ui/render";
import { ScreenStack } from "../ui/screen";
import { PlayScreen } from "../ui/screens/play";
import { rect, viewportFor, type UiViewport } from "../ui/viewport";
import type { Widget } from "../ui/widgets";

export interface LevelRun {
  id: number;
  name: string;
  level: Level;
  /** Set for a level from the online servers; `id` is then its server id. */
  online?: OnlineLevel;
  /** An online demo level (demoLevel.ts): bundled, its progress kept with the online levels'. */
  demo?: boolean;
  practice: boolean;
  /**
   * The whole percentage the last normal-mode death came at, for the death
   * screen. [gdp PlayLayer::destroyPlayer :93277-93281 (+11932);
   *  RetryLevelLayer::setupLastProgress :383912-383924]
   */
  lastPercent: number;
  attemptStartedAt: number;
  /**
   * This visit's jumps, restarts and practice included, for the end and
   * death screens. [gdp PlayLayer::incrementJumps :92531 (+11916), zeroed by
   *  PlayLayer::init :106960 and fullReset :107524;
   *  EndLevelLayer::customSetup :369525-369529]
   */
  jumps: number;
  /**
   * Where the level's "Attempt N" label stands, in world units. The game puts
   * it well above the camera's centre at the start of the attempt — a little
   * right of it after the first — and lets it scroll away with the level.
   * [gdp PlayLayer::updateAttempts, gd-ida-decomp.cpp:92478-92486;
   *  setupHasCompleted :106455-106461; fullReset :107531-107537]
   */
  attemptLabel: { x: number; y: number };
  /**
   * This visit's attempt number, 1 for the first: every restart and every
   * practice respawn counts, as the game's +10708 does, and the end screen's
   * replay starts it over. An Item Compare can read it.
   * [gdp PlayLayer::updateAttempts :92437-92457, from resetLevel :105983;
   *  fullReset :107523]
   */
  attempt: number;
  /**
   * From a start position: the sim the visit's first attempt warmed up and
   * where the warm-up left it. Every later attempt loads this back instead of
   * warming up again, as the game loads the checkpoint its first startMusic
   * made, so a Random trigger on the way is decided once a visit. Unset
   * without a start position.
   * [gdp PlayLayer::startMusic :105416-105421 (+11776); resetLevel
   *  :105898-105905 (loadFromCheckpoint), :105942-105944 (the warm-up only
   *  without one); released only with the layer :101875]
   */
  startState?: { sim: Sim; snapshot: SimSnapshot } | null;
  /**
   * A cheat or safe mode was on at some point in this attempt, so it saves
   * nothing. A fresh attempt clears it; a practice respawn does not.
   */
  cheated: boolean;
}

/** A place a practice run, or a platformer's checkpoint object, can come back to. */
export interface Checkpoint {
  snapshot: SimSnapshot;
  tick: number;
  x: number;
  y: number;
}

/**
 * How often practice lays a checkpoint down by itself, in seconds of play
 * with the player on the ground. The game places one whenever its own
 * checkpoint object queues one and never on a timer, so this is the port's
 * own rule; the manual button is the sourced one. [guess]
 */
const AUTO_CHECKPOINT_SECONDS = 2;

/** How long a notice stays up. [meas] */
const NOTICE_SECONDS = 2.5;

/** How long an achievement's bar stays up, and how long it takes to slide in and out. [guess] */
const ACHIEVEMENT_SECONDS = 3;
const ACHIEVEMENT_SLIDE = 0.3;

/**
 * A platformer's restart holds the level still this long before it runs and
 * its music starts: 0.2 s, in ticks. [gdp PlayLayer::resetLevel
 *  :106036-106050 (CCDelayTime 0x3E4CCCCD → startGameDelayed :105470-105474)]
 */
const PLATFORMER_START_HOLD = Math.round(0.2 * TICK_RATE);

export class Game {
  readonly gl: GlContext;
  readonly batch: SpriteBatch;
  readonly scene: Scene;
  readonly stack = new ScreenStack();
  readonly save: SaveStore;
  readonly mods: Mods;
  readonly input = new InputState();
  readonly loop: GameLoop;

  /**
   * These arrive during `boot`, and the loop is deliberately running before it
   * finishes so the loading screen can animate. So `render` has to cope with a
   * half-built game, and everything it might reach for while booting is either
   * built in the constructor or guarded.
   */
  ui: UiRenderer | null = null;
  audio!: GameAudio;
  strings!: Strings;
  icons!: IconSet;
  private atlas!: AtlasSet;
  private objects!: ObjectData;
  private readonly uiInput: UiInput;

  view: UiViewport;
  sim: Sim | null = null;
  run: LevelRun | null = null;
  /** Practice mode's checkpoints and the ones a platformer's checkpoint objects laid, oldest first. */
  readonly checkpoints: Checkpoint[] = [];
  private groundedSince = 0;
  /** How many of the simulation's events this has already counted. */
  private eventCursor = 0;
  /**
   * Jumps not yet in the save's total: the game adds them at a death or a
   * finish, so a run quit halfway keeps none, and a restart from the pause
   * menu carries them to the next. [gdp PlayLayer::incrementJumps :92529
   *  (+11924); commitJumps :92555-92562, from destroyPlayer :93168 and
   *  levelComplete :92858]
   */
  private jumpsPending = 0;
  /** Set while the level is being swapped, so a frame does not draw half of one. */
  loading = false;
  /**
   * Ticks a platformer's restart still holds before its first step; see
   * PLATFORMER_START_HOLD. Nothing steps and the buttons are not read.
   */
  private startHold = 0;
  /** Set by fullReset for the restart it makes, as delayedFullReset sets +11736. */
  private replayPending = false;
  /** The start position the StartPos Switcher picked, by object index, -1 for none; unset is the level's own. */
  private startPosChoice: number | undefined;
  private startPosList: { level: Level; indices: number[] } | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = new GlContext(canvas);
    this.batch = new SpriteBatch(this.gl.gl);
    this.scene = new Scene(this.gl);
    const store = storage();
    this.save = new SaveStore(store);
    this.mods = new Mods(store);
    this.uiInput = new UiInput(this.stack, this.input);
    this.view = viewportFor(canvas.clientWidth || 960, canvas.clientHeight || 540);
    this.loop = new GameLoop(
      () => this.tick(),
      (alpha, dt) => this.render(alpha, dt),
    );
  }

  /** Loads everything the menus need. The level art is already part of it. */
  async boot(onProgress?: (what: string) => void): Promise<void> {
    // The interface comes first, and deliberately: the loading screen is drawn
    // by the same renderer as everything else, and until this is up the screen
    // is blank. Its own page and the fonts are all it needs — the panels and
    // the text on the loading screen touch no gameplay sheet — so this is a
    // couple of megabytes ahead of the forty the sheets cost.
    onProgress?.("Loading the interface");
    const host = loadHostConfig();
    this.atlas = await AtlasSet.load(TEXTURE_RES[this.save.get().settings.textureQuality]);
    const art = await UiArt.load(this.atlas);
    this.ui = new UiRenderer(this.gl, art);
    await this.ui.load(["bigFont", "goldFont", "chatFont"]);
    // The level's own text objects draw in the same face the menus do, off the
    // same upload and the same unit.
    this.scene.setFont(this.ui.levelFont("bigFont"));
    // The trail and the ground's loose art ride on the interface's packed page.
    this.scene.setEffects(this.ui.levelArt());
    this.uiInput.attach(this.canvas);

    onProgress?.("Loading art");
    await this.scene.loadSheets(this.atlas);
    this.scene.useScenery(await Scenery.load());
    await this.scene.loadPlayer();

    onProgress?.("Loading objects");
    this.objects = await loadObjects();
    this.strings = await Strings.load();
    this.icons = await IconSet.load();
    await host;

    onProgress?.("Loading sound");
    this.audio = new GameAudio(this.strings, {
      music: this.save.get().settings.musicVolume,
      sfx: this.save.get().settings.sfxVolume,
    });
    this.audio.setMenuMusic(this.save.get().settings.menuMusic);
    // Not awaited: a browser that is blocking autoplay may never answer, and
    // the game has to reach its menu either way. The gesture listener resumes
    // it the moment the player touches anything.
    void this.audio.engine.ensureRunning();
    this.audio.engine.unlockOnGesture(this.canvas);
    await this.audio.loadUi();

    this.scene.particlesEnabled = this.save.get().settings.particles;
    this.scene.effectsEnabled = this.save.get().settings.shaders;

    this.input.attach(this.canvas);
    this.mods.attach(this);
    attachHostBridge(this.save, { onReset: () => this.onSaveReset?.() });
    this.audio.engine.attachLifecycle({
      // A hidden pane still gets the occasional frame, and one frame is a
      // quarter second of simulation, so the loop stops rather than lurching.
      onHidden: () => {
        this.loop.stop();
        this.save.flush();
      },
      onVisible: () => this.loop.start(),
      onLeave: () => this.save.flush(),
    });
    window.addEventListener("keydown", (e) => this.key(e, true));
    window.addEventListener("keyup", (e) => this.key(e, false));
  }

  /** Set by the boot code so a host reset can drop back to the menu. */
  onSaveReset: (() => void) | null = null;

  levelName(id: number): string {
    return OFFICIAL_LEVELS.find((l) => l.id === id)?.name ?? `Level ${id}`;
  }

  /** Loads a level and starts an attempt. */
  async startLevel(id: number, practice = false): Promise<void> {
    this.loading = true;
    try {
      const level = await fetchLevel(id);
      await this.begin({ id, name: this.levelName(id), level, practice }, undefined);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Starts an online level already downloaded, and puts it at the top of the
   * saved list as the game does with every level it downloads. Its music is
   * the official track or custom song its own description names.
   */
  async startOnlineLevel(info: OnlineLevel, level: Level, practice = false): Promise<void> {
    this.loading = true;
    try {
      this.save.saveOnlineLevel(info);
      const track = info.song.kind === "custom" ? { songId: info.song.id } : this.officialTrack(info.song.index);
      await this.begin({ id: info.id, name: info.name, level, online: info, practice }, track);
    } finally {
      this.loading = false;
    }
  }

  /** An online demo level, from the bundle. */
  async startDemoLevel(id: number, practice = false): Promise<void> {
    const demo = demoLevel(id);
    if (!demo) return;
    this.loading = true;
    try {
      const level = await loadDemoLevel(id);
      await this.begin({ id, name: demo.name, level, demo: true, practice }, { songId: demo.songId });
    } finally {
      this.loading = false;
    }
  }

  /** An online level's official track by its index; out of range is the game's first. */
  private officialTrack(index: number): { file: string; index: number } | null {
    const own = this.strings.song(index);
    const song = own ?? this.strings.song(0);
    return song ? { file: song.file, index: own ? index : 0 } : null;
  }

  private async begin(start: Pick<LevelRun, "id" | "name" | "level" | "online" | "demo" | "practice">, track: LevelTrack | undefined): Promise<void> {
    const { level } = start;
    this.run = { ...start, lastPercent: 0, attemptStartedAt: performance.now(), jumps: 0, attemptLabel: { x: 0, y: 0 }, attempt: 0, cheated: false };
    this.jumpsPending = 0;
    this.startPosChoice = undefined;
    this.mods.levelEntered();
    await this.scene.setLevel(level, this.objects.render, this.atlas, null);
    // Every icon the level can turn the player into, loaded now rather than
    // on the first portal, so entering a mode never blinks the player out
    // while its image arrives.
    await this.scene.preloadPlayerPages(modesOf(level, this.objects.table));
    // The sound is decoded before the first attempt starts, so the first
    // death or trigger is not a frame late. An online level's id is no
    // official level's, so it passes none.
    await this.audio.loadLevel(level, start.online || start.demo ? 0 : start.id, track);
    this.restart();
    if (!this.stack.has("play")) this.stack.push(new PlayScreen(this));
  }

  /** The progress kept for the level being played, official or online. */
  runProgress(run: LevelRun): LevelProgress {
    return run.online || run.demo ? this.save.onlineLevel(run.id) : this.save.level(run.id);
  }

  /** SaveStore.recordAttempt, against the right table for the run. */
  recordRun(run: LevelRun, percent: number, coins: readonly number[] = []): boolean {
    return this.save.recordAttempt(run.id, percent, run.practice, coins, run.online !== undefined || run.demo === true);
  }

  /** The stars a run's level awards: the game's table for an official level, the rating for an online one. */
  runStars(run: LevelRun): number {
    if (run.demo) return demoLevel(run.id)?.stars ?? 0;
    return run.online ? run.online.stars : (this.strings.facts(run.id)?.stars ?? 0);
  }

  /** The orbs a run's level gives for its whole run, before a completion's quarter more. */
  runOrbBase(run: LevelRun): number {
    return baseOrbs(run.id, this.runStars(run), !run.online && !run.demo);
  }

  /**
   * Pays the orbs a normal-mode run has earned by reaching `percent` when its
   * best was `before`, adds them to the total, and returns them.
   * [gdp PlayLayer::destroyPlayer :93263-93268; levelComplete :92829;
   *  GameStatsManager::awardCurrencyForLevel :356267-356340]
   */
  awardOrbs(run: LevelRun, before: number, percent: number): number {
    if (run.practice) return 0;
    const orbs = orbsFor(this.runOrbBase(run), this.runStars(run), before, percent);
    if (orbs > 0) {
      const total = this.orbTotal();
      this.save.set((save) => {
        save.totals.orbs = total + orbs;
      });
    }
    return orbs;
  }

  /**
   * The orbs earned in all. A save from before the total was kept counts it
   * up once from the bests: the official levels', and the saved online ones'.
   */
  orbTotal(): number {
    const save = this.save.get();
    if (save.totals.orbs >= 0) return save.totals.orbs;
    let total = 0;
    for (const [id, progress] of Object.entries(save.levels)) {
      const stars = this.strings.facts(Number(id))?.stars ?? 0;
      if (stars > 0) total += awardedOrbs(baseOrbs(Number(id), stars, true), progress.best);
    }
    for (const level of save.savedLevels) {
      const progress = save.online[String(level.id)];
      if (progress && level.stars > 0) total += awardedOrbs(baseOrbs(level.id, level.stars, false), progress.best);
    }
    this.save.set((s) => {
      s.totals.orbs = total;
    });
    return total;
  }

  /** A fresh attempt at the level already loaded. */
  restart(): void {
    const run = this.run;
    if (!run) return;
    const look = this.save.get().player;
    this.scene.player.choice = { ...look.icons };
    this.scene.player.glow = look.glow;
    this.scene.refreshPlayerPages();
    // Whether the game had started, which the replay counts as.
    const started = run.attempt > 0 || this.replayPending;
    this.replayPending = false;
    run.attempt++;
    run.cheated = false;
    const seed = this.mods.seed() ?? (Math.random() * 0x7fffffff) | 0;
    let sim: Sim;
    const warm = run.startState;
    if (warm) {
      // The attempt's own seed, drawn before the load, which does not carry
      // one. [gdp PlayLayer::resetLevel :105790-105797, then :105898-105905]
      sim = warm.sim;
      sim.restore(warm.snapshot);
      sim.triggers.reseed(seed);
      sim.triggers.attempt = run.attempt;
      sim.setPractice(run.practice);
    } else {
      // The screen effects this visit's last attempt left, which the game
      // resets rather than rebuilds, so some of them carry over.
      // [gdp resetLevelVariables :462991-462996]
      const previous = this.sim?.level === run.level ? this.sim.triggers.visual.shader : undefined;
      sim = createSim(run.level, this.objects.table, {
        visuals: true,
        attempt: run.attempt,
        seed,
        player1: this.strings.playerColour(look.colour1),
        player2: this.strings.playerColour(look.colour2),
        practice: run.practice,
        shader: previous,
        startPosition: this.mods.on("startposSwitcher") ? this.startPosChoice : undefined,
      });
      if (sim.startPosition >= 0) run.startState = { sim, snapshot: sim.snapshot() };
    }
    this.sim = sim;
    this.eventCursor = 0;
    this.checkpoints.length = 0;
    this.groundedSince = 0;
    run.attemptStartedAt = performance.now();
    this.scene.useSim(sim);
    this.scene.resetInterpolation();
    this.scene.camera.reset(sim.state, sim.triggers.camera);
    // Every reset but the level's first puts the player back with its rings.
    // [gdp PlayLayer::resetLevel :105947-105951]
    if (run.attempt > 1 && !this.mods.on("noRespawnFlash")) this.scene.playSpawnEffect();
    run.attemptLabel = this.attemptLabelAt(run.attempt === 1 && !run.level.header.platformer);
    this.mods.attemptStarted(sim, seed);
    // A platformer that had started holds still for a moment, then starts
    // its music; any other attempt starts at once. A start position has
    // warmed the level up; the music starts where it got to.
    // [gdp PlayLayer::resetLevel :105994-106050; startGameDelayed :105470-105474]
    this.startHold = run.level.header.platformer && started ? PLATFORMER_START_HOLD : 0;
    if (this.startHold === 0) this.audio.startAttempt(sim, this.practiceMusic());
  }

  /** Whether the music is practice's: in practice, unless the Practice Music Hack plays the level's song. */
  practiceMusic(): boolean {
    return (this.run?.practice ?? false) && !this.mods.on("practiceMusic");
  }

  /**
   * Practice from the pause menu: the run goes on where it is, to the practice
   * track. Leaving practice starts the level over, which `restart` does.
   * [gdp PlayLayer::togglePracticeMode :107451-107490]
   */
  enterPractice(): void {
    const run = this.run;
    if (!run || run.practice) return;
    run.practice = true;
    this.groundedSince = 0;
    this.sim?.setPractice(true);
    if (this.practiceMusic()) this.audio.enterPractice();
  }

  /** Whether the run in progress may save: no cheat or safe mode in this attempt, nor on now. */
  runSaves(): boolean {
    return !(this.run?.cheated ?? false) && !this.mods.blocksSaving();
  }

  /** The mod menu's Instant Complete: the level ends now, and saves nothing. */
  instantComplete(): void {
    const sim = this.sim;
    const run = this.run;
    if (!sim || !run || !this.canStep) return;
    run.cheated = true;
    sim.finishNow();
  }

  /** The level's start positions by object index, left to right. */
  startPositions(): number[] {
    const level = this.run?.level;
    if (!level) return [];
    if (this.startPosList?.level !== level) {
      const found = level.objects.filter((o) => o.id === START_POS_ID).sort((a, b) => a.x - b.x || a.index - b.index);
      this.startPosList = { level, indices: found.map((o) => o.index) };
    }
    return this.startPosList.indices;
  }

  /**
   * The StartPos Switcher: the next start position along, or back to the
   * level's start past either end, and a fresh attempt from it. False when
   * the level has none.
   */
  switchStartPos(step: 1 | -1): boolean {
    const run = this.run;
    const all = this.startPositions();
    if (!run || all.length === 0) return false;
    const choices = [-1, ...all];
    const current = choices.indexOf(this.sim?.startPosition ?? -1);
    this.startPosChoice = choices[(current + step + choices.length) % choices.length];
    run.startState = null;
    this.restart();
    return true;
  }

  /**
   * The end screen's replay: the visit's attempts and jumps start over, and
   * practice ends, before a fresh attempt from the start whose label stands
   * above the camera's centre.
   * [gdp EndLevelLayer::onReplay :367255-367287 → delayedFullReset →
   *  PlayLayer::fullReset :107506-107537]
   */
  fullReset(): void {
    const run = this.run;
    if (!run) return;
    run.attempt = 0;
    run.jumps = 0;
    run.practice = false;
    this.replayPending = true;
    this.restart();
    run.attemptLabel = this.attemptLabelAt(true);
  }

  /**
   * Where the attempt label goes for the camera as it stands now: above its
   * centre for a level's first attempt, and 50 to the right of that for every
   * later one and for any attempt of a platformer.
   * [gdp PlayLayer::setupHasCompleted :106455-106461; updateAttempts
   *  :92478-92486]
   */
  private attemptLabelAt(first: boolean): { x: number; y: number } {
    const camera = this.scene.camera;
    const b = camera.bounds(0);
    return { x: b.x0 + camera.unitsWide / 2 + (first ? 0 : 50), y: b.y0 + camera.unitsHigh / 2 + 85 };
  }

  /**
   * Lays a checkpoint where the player is. Refused while dead, finished, or
   * outside practice — the same refusal the game's own button gets.
   * [gdp PlayLayer::markCheckpoint, gd-ida-decomp.cpp:105241-105250]
   */
  placeCheckpoint(): boolean {
    const sim = this.sim;
    const run = this.run;
    if (!sim || !run || !run.practice || sim.state.dead || sim.state.finished) return false;
    this.checkpoints.push({ snapshot: sim.snapshot(), tick: sim.tick, x: sim.state.x, y: sim.state.y });
    this.groundedSince = 0;
    return true;
  }

  /** Takes the last checkpoint away, so a bad one can be undone. */
  removeCheckpoint(): boolean {
    return this.checkpoints.pop() !== undefined;
  }

  /**
   * Back to the last checkpoint, or to the start when there is none. The
   * simulation, the camera, the trails and the sound all rewind together —
   * the music to the checkpoint's music clock; the jumps already counted
   * stay counted, because they happened.
   */
  respawn(): void {
    const sim = this.sim;
    const run = this.run;
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (!sim || !run || !last) {
      this.restart();
      return;
    }
    const kept = sim.respawnFrom(last.snapshot);
    // A checkpoint starts the game at once. [gdp PlayLayer::resetLevel :106040-106042]
    this.startHold = 0;
    run.attempt++;
    sim.triggers.attempt = run.attempt;
    this.eventCursor = Math.min(this.eventCursor, sim.events.length);
    this.groundedSince = 0;
    this.scene.resetInterpolation();
    this.scene.camera.reset(sim.state, sim.triggers.camera);
    if (!this.mods.on("noRespawnFlash")) this.scene.playSpawnEffect();
    run.attemptLabel = this.attemptLabelAt(false);
    this.mods.respawned(sim);
    this.audio.respawn(sim, this.practiceMusic(), kept);
  }

  /**
   * A line at the bottom of the screen for a moment, for a button whose
   * feature is not in this version. The game has no such thing — its buttons
   * all do something — so this is the port's, and it is kept small.
   */
  say(text: string): void {
    this.notice = { text, until: performance.now() + NOTICE_SECONDS * 1000 };
  }

  private notice: { text: string; until: number } | null = null;

  /** The object table, for a screen that runs a player of its own. */
  get objectTable(): ObjectData["table"] {
    return this.objects.table;
  }

  /** The achievements this port can see the player has earned. */
  earnedAchievements(): Set<string> {
    const p = progressOf(
      this.save.get(),
      (id) => this.strings.facts(id)?.stars ?? 0,
      (id) => this.strings.facts(id)?.demon ?? false,
    );
    const out = new Set<string>();
    for (const a of this.strings.achievements()) if (achieved(a.id, a, p) === true) out.add(a.id);
    return out;
  }

  /**
   * Shows the bar for every achievement earned since `before`, one after
   * another, with the game's chime. [gdp AchievementNotifier, AchievementBar]
   */
  announceAchievements(before: ReadonlySet<string>): void {
    for (const id of this.earnedAchievements()) {
      if (!before.has(id) && !this.achievementQueue.includes(id)) this.achievementQueue.push(id);
    }
  }

  private achievementQueue: string[] = [];
  private achievementShownAt = 0;

  private achievementWidgets(): Widget[] {
    const id = this.achievementQueue[0];
    if (id === undefined) return [];
    const now = performance.now();
    if (this.achievementShownAt === 0) {
      this.achievementShownAt = now;
      this.audio.ui("achievement");
    }
    const t = (now - this.achievementShownAt) / 1000;
    if (t >= ACHIEVEMENT_SECONDS) {
      this.achievementQueue.shift();
      this.achievementShownAt = 0;
      return [];
    }
    const facts = this.strings.achievements().find((a) => a.id === id);
    if (!facts) return [];
    const slide = Math.min(1, t / ACHIEVEMENT_SLIDE, (ACHIEVEMENT_SECONDS - t) / ACHIEVEMENT_SLIDE);
    const view = this.view;
    const w = Math.min(300, view.width - 40);
    const h = 48;
    const y = view.height - slide * (h + 8);
    const text = describeAchievement(id, facts, (n) => this.levelName(n));
    const reward = rewardLabel(facts.reward);
    const out: Widget[] = [
      { kind: "panel", rect: rect(view.width / 2 - w / 2, y, w, h), frame: FRAMES.panelDark, alpha: 0.95 },
      { kind: "text", x: view.width / 2, y: y + h - 16, text: "Achievement earned", font: "goldFont", scale: 0.5, align: "center" },
      { kind: "text", x: view.width / 2, y: y + (reward ? 20 : 14), text, scale: 0.3, align: "center", maxWidth: w - 20 },
    ];
    if (reward) out.push({ kind: "text", x: view.width / 2, y: y + 8, text: reward, font: "goldFont", scale: 0.35, align: "center", tint: UI_COLOURS.dim });
    return out;
  }

  /** The notice as a widget, or nothing once it has gone. */
  private noticeWidgets(): Widget[] {
    const n = this.notice;
    if (!n) return [];
    const left = (n.until - performance.now()) / 1000;
    if (left <= 0) {
      this.notice = null;
      return [];
    }
    const alpha = Math.min(1, left / 0.4);
    const view = this.view;
    const width = Math.min(view.width - 40, 60 + n.text.length * 7);
    return [
      { kind: "panel", rect: rect(view.width / 2 - width / 2, 8, width, 26), frame: FRAMES.panelDark, alpha: alpha * 0.9 },
      { kind: "text", x: view.width / 2, y: 15, text: n.text, scale: 0.3, align: "center", maxWidth: width - 16, alpha },
    ];
  }

  /** Ends the run and goes back to wherever the player came from. */
  endLevel(): void {
    this.audio.stopLevel();
    this.audio.setMusicSpeed(1);
    this.loop.timeScale = 1;
    this.mods.levelEnded();
    this.sim = null;
    this.run = null;
    this.startHold = 0;
    // Leaving drops the jumps no death or finish has added yet.
    this.jumpsPending = 0;
    this.scene.useSim(null);
    this.save.flush();
  }

  /**
   * Whether the simulation is advancing right now.
   *
   * Both the tick and the frame need this and they must agree. When it is false
   * the frame has to stop interpolating: the camera's previous and current
   * positions stay frozen one tick apart while the loop keeps sweeping `alpha`
   * from 0 to 1 every frame, so the view oscillates between the two — a violent
   * shake on death, and a permanent one with the pause menu open, because that
   * state never ends.
   */
  private get stepping(): boolean {
    return this.canStep && !this.mods.frozen;
  }

  /** Whether the simulation may advance, the frame stepper aside: a level running, nothing in the way. */
  private get canStep(): boolean {
    const sim = this.sim;
    if (!sim || this.loading || !this.stack.ticks || this.startHold > 0) return false;
    return !sim.state.dead && !sim.state.finished;
  }

  private tick(): void {
    const sim = this.sim;
    if (sim && this.startHold > 0 && !this.loading && this.stack.ticks) {
      // The game's delay is an action on the layer, so a pause holds it too.
      if (--this.startHold === 0) this.audio.startAttempt(sim, this.practiceMusic());
      return;
    }
    if (!sim || !this.canStep || !this.mods.takeStep()) return;
    if (this.run && this.mods.blocksSaving()) this.run.cheated = true;
    this.mods.prepare(sim);
    const [p1, p2] = this.mods.inputs(sim, this.input.input(1), this.input.input(2));
    sim.step(p1, sim.state2 ? p2 : NO_INPUT);
    this.mods.stepped(sim);
    // A platformer's checkpoint object lays one down in practice and in a
    // normal run alike; a death goes back to it.
    const laid = sim.takePlatformerCheckpoint();
    if (laid) this.checkpoints.push({ snapshot: laid, tick: sim.tick, x: sim.state.x, y: sim.state.y });
    this.scene.tick(sim);
    this.countJumps(sim);
    if (this.run?.practice) this.autoCheckpoint(sim);
  }

  /** The jumps the game counts, into this visit's count and the pending total. */
  private countJumps(sim: Sim): void {
    const events = sim.events;
    if (this.eventCursor > events.length) this.eventCursor = events.length;
    let jumps = 0;
    for (let i = this.eventCursor; i < events.length; i++) if (countsAsJump(events[i])) jumps++;
    this.eventCursor = events.length;
    this.jumpsPending += jumps;
    if (this.run) this.run.jumps += jumps;
  }

  /** A death or a finish: the pending jumps go into the save's total. */
  commitJumps(): void {
    const n = this.jumpsPending;
    this.jumpsPending = 0;
    if (n > 0 && this.runSaves()) this.save.set((save) => void (save.totals.jumps += n));
  }

  /** Practice lays a checkpoint by itself after a stretch on the ground. */
  private autoCheckpoint(sim: Sim): void {
    if (sim.state.dead || sim.state.finished) return;
    if (!sim.state.onGround) {
      this.groundedSince = 0;
      return;
    }
    this.groundedSince += 1 / TICK_RATE;
    if (this.groundedSince >= AUTO_CHECKPOINT_SECONDS) this.placeCheckpoint();
  }

  private render(frameAlpha: number, dt: number): void {
    // Pinned to the latest tick whenever the simulation is not advancing, so a
    // frozen frame is drawn where the player actually is rather than sliding
    // back and forth between the last two ticks.
    const alpha = this.stepping ? frameAlpha : 1;
    this.gl.resize();
    this.view = viewportFor(this.gl.gl.drawingBufferWidth, this.gl.gl.drawingBufferHeight);
    this.uiInput.setViewport(this.view);
    this.scene.camera.setAspect(this.view.width, this.view.height);
    this.applyMods();
    this.stack.update(dt);

    if (this.sim) {
      const c = this.scene.camera.centre();
      this.audio?.update(this.sim, [c.x, c.y]);
      // Practice's pulse is flat, which is what No Pulse wants too.
      if (this.audio && !this.loading) this.scene.pulse = this.audio.pulse(this.stack.freezesLevel ? 0 : dt, this.practiceMusic() || this.mods.on("noPulse"));
    }
    // Under the pause menu the level's own clock stops too, not only the
    // run: the colours, pulses, screen effects and particles hold still.
    this.scene.update(this.stack.freezesLevel ? 0 : dt);
    if (this.sim && !this.loading) {
      // Scene.draw clears to the level's own background colour itself.
      this.scene.draw(alpha);
    } else {
      const bg = this.scene.backgroundColor;
      this.gl.clear(bg.r, bg.g, bg.b);
    }
    // After the level and its screen effects, so a shader trigger never warps
    // the pause menu. Absent until the interface has loaded, which is the first
    // thing boot does but still a few frames in.
    const widgets = this.stack.build(this.view);
    widgets.push(...this.noticeWidgets(), ...this.achievementWidgets());
    this.ui?.draw(this.batch, this.view, widgets, (w, out) => drawIcon(w, out, this.iconArt), this.uiInput.heldId);
    this.mods.frame();
  }

  /** The mod menu's switches that the loop, the sound and the renderer read, set once a frame. */
  private applyMods(): void {
    const mods = this.mods;
    const inLevel = this.sim !== null;
    const speed = inLevel ? mods.speed : 1;
    // A time warp above 1 runs more steps to the real second, each a whole
    // 240th; below 1 the steps keep coming and the sim shrinks them.
    // [gdp GJBaseGameLayer::getModifiedDelta :430237-430243]
    const warp = this.sim?.triggers.timeWarp ?? 1;
    this.loop.timeScale = speed * Math.max(1, warp);
    this.audio?.setMusicSpeed(mods.on("speedhackMusic") ? speed : 1);
    const settings = this.save.get().settings;
    this.scene.particlesEnabled = settings.particles && !mods.on("noParticles");
    this.scene.effectsEnabled = settings.shaders && !mods.on("noShaders");
    const look = this.scene.mods;
    look.hidePlayer = mods.on("hidePlayer");
    look.noShake = mods.on("noShake");
    look.noWaveTrail = mods.on("noWaveTrail");
    look.noTrail = mods.on("noTrail");
    look.alwaysTrail = mods.on("alwaysTrail");
    look.noDeathEffect = mods.on("noDeathEffect");
    look.sameDualColour = mods.on("sameDualColour");
    look.rainbow = mods.on("rainbowIcon") ? mods.value("rainbowIcon") : 0;
  }

  /** What a menu needs to draw an icon: the pages, the units, the colours, the poses. */
  private get iconArt(): IconArt {
    return {
      icons: this.icons,
      unitOf: (page) => this.scene.iconUnits.get(page),
      colour: (index) => this.strings.playerColour(index),
      entity: (kind) => (kind === "robot" || kind === "spider" ? this.scene.player.entityFor(kind) : undefined),
    };
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (e.repeat) return;
    // Typing in the search box belongs to the box, P and Escape included.
    if (e.target instanceof HTMLInputElement) return;
    if (this.uiInput.key(e.code, down)) e.preventDefault();
  }

  start(): void {
    this.loop.start();
  }
}

/** localStorage, or a memory stand-in when the browser refuses it. */
function storage(): Storage {
  try {
    const probe = "__gd_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    } as Storage;
  }
}

/** Re-exported so a screen does not have to reach for the loader itself. */
export { uploadTexture };
