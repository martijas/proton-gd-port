// The mod menu as the game sees it: what the switches do to a run.
//
// The game calls in at a handful of moments — an attempt starting, each step,
// each frame, the level ending — and reads a few answers back: the inputs to
// step with, how fast to run, whether the run may save.

import type { Game } from "../game/game";
import { NO_INPUT, TICK_RATE, type PlayerInput, type Sim } from "../physics/types";
import type { Speed } from "../level/types";
import type { KeyValueStore } from "../save/store";
import { clock } from "../ui/chrome";
import { PauseScreen } from "../ui/screens/play";
import { MacroDeck } from "./macro";
import { ModMenu } from "./menu";
import { Flash, HitboxLayer, StatusPanel } from "./overlay";
import { Session } from "./session";
import { modDef, ModStore } from "./state";

const SPEED_NAMES: Record<Speed, string> = { 0: "0.5x", 1: "1x", 2: "2x", 3: "3x", 4: "4x" };
const STATUS_INTERVAL_MS = 100;
const TRAJECTORY_INTERVAL_MS = 50;
/** How far ahead Show Trajectory looks, in ticks (~0.75 s). */
const TRAJECTORY_TICKS = 180;
const HOLD_INPUT: PlayerInput = Object.freeze({ jump: true, left: false, right: false });
const DOT_SAVES = "#4dff6a";
const DOT_CHEATING = "#ff4040";
const DOT_NOT_SAVING = "#ffb040";

/** Walk the sim ahead under one input, then put it back. Centres of the player box. */
function predictPath(sim: Sim, input: PlayerInput, ticks: number): Array<readonly [number, number]> {
  const snap = sim.snapshot();
  const pts: Array<readonly [number, number]> = [];
  const start = sim.playerRect(1);
  pts.push([start.x + start.w / 2, start.y + start.h / 2]);
  for (let i = 0; i < ticks; i++) {
    if (sim.state.dead || sim.state.finished) break;
    sim.step(input, sim.state2 ? input : undefined);
    const r = sim.playerRect(1);
    pts.push([r.x + r.w / 2, r.y + r.h / 2]);
  }
  sim.restore(snap);
  return pts;
}

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

export class Mods {
  readonly store: ModStore;
  readonly session = new Session();
  readonly macro = new MacroDeck();
  private game: Game | null = null;
  private menu: ModMenu | null = null;
  private hitboxes: HitboxLayer | null = null;
  private status: StatusPanel | null = null;
  private flash: Flash | null = null;
  /** Steps the frame stepper has been asked for and not yet run. */
  private steps = 0;
  private statusAt = 0;
  private trajAt = 0;
  private holdPath: ReadonlyArray<readonly [number, number]> = [];
  private releasePath: ReadonlyArray<readonly [number, number]> = [];
  private autoClickTicks = 0;

  constructor(storage: KeyValueStore) {
    this.store = new ModStore(storage);
  }

  on(id: string): boolean {
    return this.store.on(id);
  }

  value(id: string): number {
    return this.store.value(id);
  }

  /** The cheats on right now, by name, macro playback among them. */
  cheats(): string[] {
    const out = this.store.activeCheats();
    if (this.macro.mode === "play") out.push("Macro playback");
    return out;
  }

  /** Whether a run would save nothing right now: a cheat is on, or safe mode. */
  blocksSaving(): boolean {
    return this.on("safeMode") || this.cheats().length > 0;
  }

  /** How fast the level runs: the speedhack's speed, or 1. */
  get speed(): number {
    return this.on("speedhack") ? this.value("speedhack") : 1;
  }

  get frozen(): boolean {
    return this.on("frameStepper");
  }

  /** Builds the menu and the overlays, and starts listening for keys. */
  attach(game: Game): void {
    this.game = game;
    const parent = document.body;
    this.hitboxes = new HitboxLayer(parent);
    this.flash = new Flash(parent);
    this.status = new StatusPanel(parent);
    this.menu = new ModMenu({
      store: this.store,
      macro: this.macro,
      action: (id) => this.action(id),
      saving: () => this.savingNote(),
      startPosLabel: () => this.startPosLabel(),
      levelName: () => game.run?.name ?? null,
    });
    game.input.onPress = () => this.session.click();
    window.addEventListener("keydown", (e) => this.key(e), true);
    window.addEventListener("blur", () => this.focus(false));
    window.addEventListener("focus", () => this.focus(true));
  }

  /** Opens or closes the menu, for the pause menu's button. */
  toggleMenu(): void {
    this.menu?.toggle();
  }

  private key(e: KeyboardEvent): void {
    const menu = this.menu;
    if (!menu) return;
    if (menu.isBinding) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) menu.takeBindingKey(e.code);
      return;
    }
    if (e.code === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) menu.toggle();
      return;
    }
    if (e.repeat || typing(e.target)) return;
    const bound = this.store.boundTo(e.code);
    if (bound) {
      e.preventDefault();
      e.stopPropagation();
      this.press(bound);
      return;
    }
    const game = this.game;
    if (!game || game.stack.top?.name !== "play") return;
    if (e.code === "KeyC" && this.frozen) {
      e.preventDefault();
      e.stopPropagation();
      this.steps++;
      return;
    }
    if ((e.code === "KeyQ" || e.code === "KeyE") && this.on("startposSwitcher") && game.switchStartPos(e.code === "KeyQ" ? -1 : 1)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** A bound key: flips its switch, or presses its button, and says so. */
  private press(id: string): void {
    const def = modDef(id);
    if (!def) return;
    if (def.kind === "action") {
      this.action(id);
      return;
    }
    const on = !this.on(id);
    this.store.setOn(id, on);
    this.game?.say(`${def.label}: ${on ? "on" : "off"}`);
  }

  private action(id: string): void {
    if (id === "instantComplete") this.game?.instantComplete();
    if (id === "startposSpoofer") this.spoofStart();
  }

  private spoofStart(): void {
    const game = this.game;
    if (!game) return;
    const at = game.addSpoofedStart();
    if (at === 0) {
      game.say("You can only add a start position while playing.");
      return;
    }
    const total = game.startPositions().length;
    game.say(this.on("startposSwitcher") ? `Start position ${at} of ${total} added` : `Start position added. Turn on StartPos Switcher to use it.`);
  }

  private focus(focused: boolean): void {
    const game = this.game;
    if (!game?.audio) return;
    if (this.on("muteOnUnfocus")) {
      const s = game.save.get().settings;
      game.audio.setVolumes(focused ? { music: s.musicVolume, sfx: s.sfxVolume } : { music: 0, sfx: 0 });
    }
    if (!focused && this.on("pauseOnUnfocus") && game.stack.top?.name === "play" && game.sim && !game.sim.state.dead) {
      game.stack.push(new PauseScreen(game));
    }
  }

  private savingNote(): { saves: boolean; why: string } {
    const cheats = this.cheats();
    if (cheats.length > 0) return { saves: false, why: `Your progress won't save: ${cheats.join(", ")}.` };
    if (this.on("safeMode")) return { saves: false, why: "Safe mode is on: your progress won't save." };
    if (this.game?.run?.cheated) return { saves: false, why: "This attempt won't save. Your next one will." };
    return { saves: true, why: "" };
  }

  private startPosLabel(): string | null {
    const game = this.game;
    if (!game?.run || !this.on("startposSwitcher")) return null;
    const all = game.startPositions();
    if (all.length === 0) return "This level has no start positions.";
    // The switcher at the foot of the screen says it already, unless the HUD is hidden.
    if (!this.on("hideHud")) return null;
    const at = all.indexOf(game.currentStart);
    return at < 0 ? `Starting from the start (${all.length} start positions)` : `Start position ${at + 1} of ${all.length}`;
  }

  // --- the game's moments ---------------------------------------------------

  levelEntered(): void {
    this.session.levelEntered();
  }

  attemptStarted(sim: Sim, seed: number): void {
    this.session.attemptStarted(sim);
    this.macro.attemptStarted(seed);
    this.hitboxes?.forgetTrail();
    this.autoClickTicks = 0;
    this.steps = 0;
  }

  respawned(sim: Sim): void {
    this.session.respawned(sim);
    this.macro.respawned(sim.tick);
    this.hitboxes?.forgetTrail();
  }

  /** The seed a fresh attempt should use, when a playback needs its own. */
  seed(): number | undefined {
    return this.macro.seed();
  }

  /** Whether the frame stepper lets this step run. */
  takeStep(): boolean {
    if (!this.frozen) return true;
    if (this.steps <= 0) return false;
    this.steps--;
    return true;
  }

  /** The switches the simulation reads, set before each step. */
  prepare(sim: Sim): void {
    sim.cheats.noclip = this.on("noclip");
    sim.cheats.jumpHack = this.on("jumpHack");
    sim.cheats.noSolids = this.on("noSolids");
    sim.cheats.hitboxScale = this.on("hitboxMult") ? this.value("hitboxMult") : 1;
  }

  /** The buttons to step with: a playback's, the auto clicker's, or the player's own, noted by a recording. */
  inputs(sim: Sim, p1: PlayerInput, p2: PlayerInput): [PlayerInput, PlayerInput] {
    const played = this.macro.inputsAt(sim.tick);
    if (played) {
      p1 = played.p1;
      p2 = played.p2;
    } else if (this.on("autoClicker")) {
      // Down for the first half of each click, up for the second.
      const jump = Math.floor((this.autoClickTicks * this.value("autoClicker") * 2) / TICK_RATE) % 2 === 0;
      this.autoClickTicks++;
      p1 = { jump, left: p1.left, right: p1.right };
    }
    this.macro.note(sim.tick, p1, p2);
    return [p1, p2];
  }

  stepped(sim: Sim): void {
    this.session.stepped(sim);
    if (this.on("hitboxTrail")) this.hitboxes?.record(sim);
    if (sim.state.finished) this.macro.levelFinished();
  }

  levelEnded(): void {
    this.hitboxes?.clear();
    this.status?.show([], 1, 1);
    this.steps = 0;
  }

  /** After the frame is drawn: the hitboxes, the status lines and the flash. */
  frame(): void {
    const game = this.game;
    if (!game) return;
    this.session.frame();
    const sim = game.sim;
    const inLevel = sim !== null && game.run !== null && !game.loading;
    if (!inLevel || !sim) {
      this.hitboxes?.clear();
      this.status?.show([], 1, 1);
      return;
    }
    const objects = this.on("showHitboxes") || (this.on("hitboxesOnDeath") && sim.state.dead);
    const trail = this.on("hitboxTrail");
    const trajectory = this.on("showTrajectory") && !sim.state.dead;
    if (trajectory) {
      const now = performance.now();
      if (now - this.trajAt >= TRAJECTORY_INTERVAL_MS) {
        this.trajAt = now;
        this.holdPath = predictPath(sim, HOLD_INPUT, TRAJECTORY_TICKS);
        this.releasePath = predictPath(sim, NO_INPUT, TRAJECTORY_TICKS);
      }
    } else {
      this.holdPath = [];
      this.releasePath = [];
    }
    if (objects || trail || trajectory) {
      this.hitboxes?.draw(sim, game.scene, objects, trail, trajectory ? this.holdPath : null, trajectory ? this.releasePath : null);
    } else this.hitboxes?.clear();
    if (this.session.noclipHitNow) {
      this.session.noclipHitNow = false;
      if (this.on("noclipFlash") && this.on("noclip")) this.flash?.flash();
    }
    const now = performance.now();
    if (now - this.statusAt >= STATUS_INTERVAL_MS) {
      this.statusAt = now;
      this.status?.show(this.statusLines(sim), this.value("statusSize"), this.value("statusOpacity"));
    }
  }

  private statusLines(sim: Sim): Array<readonly [string, string?]> {
    const game = this.game;
    const run = game?.run;
    if (!game || !run) return [];
    const lines: Array<readonly [string, string?]> = [];
    if (this.on("cheatIndicator")) {
      const colour = this.cheats().length > 0 ? DOT_CHEATING : this.on("safeMode") || run.cheated ? DOT_NOT_SAVING : DOT_SAVES;
      lines.push(["●", colour]);
    }
    const message = this.store.text("message");
    if (message) lines.push([message]);
    if (this.on("fps")) lines.push([`${this.session.fps} FPS`]);
    if (this.on("cps")) lines.push([`${this.session.cps()} CPS (${this.session.attemptClicks})`]);
    if (this.on("noclipAccuracy")) lines.push([`Accuracy: ${this.session.noclipAccuracy(sim).toFixed(2)}%`]);
    if (this.on("noclipDeaths")) lines.push([`Deaths: ${this.session.noclipDeaths}`]);
    if (this.on("attempts")) lines.push([`Attempt ${run.attempt}`]);
    if (this.on("jumps")) lines.push([`Jumps: ${run.jumps}`]);
    if (this.on("bestRun")) {
      const best = this.session.bestRun;
      lines.push([best ? `Best Run: ${best.from}-${best.to}%` : "Best Run: none yet"]);
    }
    if (this.on("runInfo")) {
      const p = sim.state;
      lines.push([`X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)}`]);
      lines.push([`${p.mode[0].toUpperCase()}${p.mode.slice(1)}, ${SPEED_NAMES[p.speed]}${p.flipped ? ", upside down" : ""}${p.mini ? ", mini" : ""}`]);
    }
    if (this.on("levelId")) lines.push([run.online || run.demo ? `ID ${run.id}` : `Level ${run.id}`]);
    if (this.on("startposSwitcher")) {
      const label = this.startPosLabel();
      if (label) lines.push([label]);
    }
    if (this.frozen) lines.push(["Frozen: C steps", DOT_NOT_SAVING]);
    if (this.macro.mode === "record") lines.push(["Recording", DOT_CHEATING]);
    if (this.macro.mode === "play") lines.push(["Playing back", DOT_NOT_SAVING]);
    if (this.on("sessionTime")) lines.push([clock((performance.now() - this.session.startedAt) / 1000)]);
    if (this.on("clock")) lines.push([new Date().toLocaleTimeString()]);
    return lines;
  }
}
