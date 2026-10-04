/// <reference types="vite/client" />
// Plays every saved autoplayer run back to back, so anything a run does that it
// should not — floating off above the level, slipping through a block — can be
// seen rather than inferred from a test result.
//
// Stereo Madness through Dash and then The Challenge, each with its own run
// from test/macros, moving on by itself when a run ends. A level whose run no
// longer finishes is played from its furthest attempt; a level with no run at
// all is skipped.

import { fetchLevel, OFFICIAL_LEVELS } from "../assets/levels";
import { Strings } from "../assets/strings";
import { GameAudio } from "../audio/gameAudio";
import { AtlasSet } from "../assets/atlas";
import { Scenery } from "../assets/scenery";
import { loadObjects, type ObjectData } from "../assets/objectTable";
import { GlContext } from "../engine/gl/context";
import { DEMO_LEVELS, demoLevel, loadDemoLevel } from "../game/demoLevel";
import { SHEET_FONT, SHEET_UI } from "../engine/gl/spriteBatch";
import { GameLoop } from "../engine/loop";
import type { Level } from "../level/types";
import { createSim } from "../physics/index";
import { modesOf } from "../physics/levelModes";
import { TICK_RATE, type Sim } from "../physics/types";
import { loadEffectArt } from "../render/effects";
import { Scene } from "../render/scene";
import { loadLevelFont } from "../render/text";
import { MacroPlayer, parseMacro, type Macro } from "./macro";
import { PLAYER_SCREEN_FRACTION, Renderer2D } from "./render2d";
import { bindSpeedSlider } from "./speed";

/** Stereo Madness to Dash, then The Challenge, then the online demo levels. */
const LEVEL_IDS = [...Array.from({ length: 22 }, (_, i) => i + 1), 3001, ...DEMO_LEVELS.map((l) => l.id)];

function levelFor(id: number): Promise<Level> {
  return demoLevel(id) ? loadDemoLevel(id) : fetchLevel(id);
}

/** How long a run that has ended stays on screen before the next level. */
const PAUSE_AFTER_RUN_MS = 1500;
/**
 * A run is called stopped when the player has not moved for this long. Not a
 * fixed time after its last input: a run that coasts to the end without
 * pressing anything is still finishing, and Theory of Everything's saved run
 * spends its last ten seconds doing exactly that. Distance rather than x, so
 * a player travelling up or down a turned section is not mistaken for stuck.
 */
const STILL_TICKS = 3 * TICK_RATE;
/** And whatever happens, this long after the last input the run is over. */
const HARD_LIMIT_AFTER_LAST_INPUT_TICKS = 60 * TICK_RATE;
/** The seed every saved run was solved with; any other and random triggers drift. */
const RUN_SEED = 1;
/** rAF silence after which a timer takes over, because a hidden pane stops handing out frames. */
const RAF_WATCHDOG_MS = 500;
const FALLBACK_INTERVAL_MS = 16;

// Every saved run, fetched only when its level comes up. Bundled rather than
// read from test/ at run time, so the page works from the built game as well
// as from the dev server.
const RUNS = import.meta.glob("../../test/macros/*.json", { query: "?raw", import: "default" }) as Partial<
  Record<string, () => Promise<string>>
>;

type RunKind = "solved" | "best" | "unsolved";

/** In the level list: nothing for a run that finishes, a word for one that does not. */
const KIND_TAG: Record<RunKind, string> = { solved: "", best: "best try", unsolved: "retired" };
/** In the readout. */
const KIND_TEXT: Record<RunKind, string> = {
  solved: "saved run",
  best: "furthest attempt — no saved run finishes this level",
  unsolved: "retired run — it no longer finishes",
};

/** A finished run first, then the furthest attempt, then a retired run. */
function runFor(id: number): { kind: RunKind; load: () => Promise<string> } | null {
  const order: [RunKind, string][] = [
    ["solved", ""],
    ["best", ".best"],
    ["unsolved", ".unsolved"],
  ];
  for (const [kind, suffix] of order) {
    const load = RUNS[`../../test/macros/${id}${suffix}.json`];
    if (load) return { kind, load };
  }
  return null;
}

type Status = "waiting" | "playing" | "finished" | "died" | "stopped" | "none";

interface Entry {
  id: number;
  name: string;
  run: { kind: RunKind; load: () => Promise<string> } | null;
  status: Status;
  percent: number;
  row: HTMLLIElement;
  statusCell: HTMLSpanElement;
}

// --- page --------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing #${id} in macroverify.html`);
  return e as T;
}

const glCanvas = el<HTMLCanvasElement>("gl");
const overlayCanvas = el<HTMLCanvasElement>("c");
const hud = el<HTMLDivElement>("hud");
const list = el<HTMLOListElement>("levels");
const pauseBtn = el<HTMLButtonElement>("pause");
const autoBox = el<HTMLInputElement>("auto");
const hitboxBox = el<HTMLInputElement>("hitboxes");
const soundBox = el<HTMLInputElement>("sound");
const msg = el<HTMLSpanElement>("msg");
/** The level's music and sounds, played along with each run; null if sound could not start. */
let audio: GameAudio | null = null;

let scene: Scene | null = null;
try {
  scene = new Scene(new GlContext(glCanvas));
} catch (e) {
  // No WebGL2: the hitbox view still shows every run.
  console.warn(e);
  glCanvas.hidden = true;
  hitboxBox.checked = true;
}
const renderer = new Renderer2D(overlayCanvas);
renderer.overlay = scene !== null;

let objectData: ObjectData | null = null;
let atlas: AtlasSet | null = null;
let level: Level | null = null;
let macro: Macro | null = null;
let sim: Sim | null = null;
let player: MacroPlayer | null = null;
let hasPlayer2Inputs = false;
let lastInputTick = 0;
/** Where the player last was when it moved, and when. */
let stillX = 0;
let stillY = 0;
let stillSince = 0;
let paused = false;
/** When the current run finished, died or stopped; null while it is playing. */
let endedAt: number | null = null;
let current = -1;
let loadToken = 0;

const entries: Entry[] = LEVEL_IDS.map((id) => {
  const name = demoLevel(id)?.name ?? OFFICIAL_LEVELS.find((l) => l.id === id)?.name ?? `Level ${id}`;
  const run = runFor(id);
  const row = document.createElement("li");
  const button = document.createElement("button");
  const idCell = document.createElement("span");
  idCell.className = "id";
  idCell.textContent = String(id);
  const nameCell = document.createElement("span");
  nameCell.className = "name";
  nameCell.textContent = name;
  const kindCell = document.createElement("span");
  kindCell.className = "kind";
  kindCell.textContent = run ? KIND_TAG[run.kind] : "";
  const statusCell = document.createElement("span");
  statusCell.className = "status";
  button.append(idCell, nameCell, kindCell, statusCell);
  row.append(button);
  list.append(row);
  const entry: Entry = { id, name, run, status: run ? "waiting" : "none", percent: 0, row, statusCell };
  button.addEventListener("click", () => {
    if (paused) audio?.resumeLevel();
    paused = false;
    pauseBtn.textContent = "Pause";
    void load(entries.indexOf(entry));
  });
  return entry;
});

function statusText(e: Entry): string {
  switch (e.status) {
    case "none":
      return "no run";
    case "waiting":
      return "";
    case "playing":
      return `${Math.floor(e.percent)}%`;
    case "finished":
      return "✓ 100%";
    case "died":
      return `✗ ${Math.floor(e.percent)}%`;
    case "stopped":
      return `■ ${Math.floor(e.percent)}%`;
  }
}

function refreshList(): void {
  entries.forEach((e, i) => {
    e.row.className = `${e.status}${i === current ? " current" : ""}`;
    e.statusCell.textContent = statusText(e);
  });
}

function setMsg(text: string): void {
  msg.textContent = text;
}

// --- a run -------------------------------------------------------------------

/** A fresh simulation of the current level, at the start of its run. */
function freshRun(): Sim | null {
  if (!level || !objectData || !macro) return null;
  const next = createSim(level, objectData.table, { seed: macro.seed ?? RUN_SEED });
  player = new MacroPlayer(macro);
  hasPlayer2Inputs = macro.inputs.some((i) => i.player2);
  lastInputTick = player.length;
  stillX = next.state.x;
  stillY = next.state.y;
  stillSince = 0;
  endedAt = null;
  renderer.reset();
  renderer.recordPosition(next.state);
  return next;
}

async function load(index: number): Promise<void> {
  const entry = entries[index];
  if (!entry) return;
  const token = ++loadToken;
  current = index;
  sim = null;
  player = null;
  endedAt = null;
  audio?.stopLevel();
  entry.row.scrollIntoView({ block: "nearest" });
  if (!entry.run) {
    refreshList();
    setMsg(`${entry.name} has no saved run.`);
    // Nothing to watch here; move on if the page is running through them.
    if (autoBox.checked) endedAt = performance.now() - PAUSE_AFTER_RUN_MS;
    return;
  }
  entry.status = "playing";
  entry.percent = 0;
  refreshList();
  setMsg(`Loading ${entry.name}…`);
  try {
    const [lv, text] = await Promise.all([levelFor(entry.id), entry.run.load()]);
    if (token !== loadToken) return;
    level = lv;
    macro = parseMacro(text);
    const next = freshRun();
    if (!next) return;
    if (scene && atlas && objectData) {
      await scene.setLevel(lv, objectData.render, atlas, next);
      // The player's icons for every mode in the level, now, so the first
      // portal of each kind does not blink the player out while one loads.
      await scene.preloadPlayerPages(modesOf(lv, objectData.table));
      if (token !== loadToken) return;
      scene.resetInterpolation();
      scene.camera.reset(next.state, next.triggers.camera);
    }
    if (audio) {
      const demo = demoLevel(entry.id);
      try {
        await audio.loadLevel(lv, demo ? 0 : entry.id, demo ? { songId: demo.songId } : undefined);
      } catch (e) {
        console.warn(e);
      }
      if (token !== loadToken) return;
      audio.startAttempt(next, false);
    }
    sim = next;
    setMsg("");
  } catch (e) {
    if (token !== loadToken) return;
    entry.status = "stopped";
    refreshList();
    setMsg(`${entry.name} could not be loaded${e instanceof Error ? `: ${e.message}` : "."}`);
  }
}

function restart(): void {
  const entry = entries[current];
  if (!entry?.run || !level) return;
  const next = freshRun();
  if (!next) return;
  scene?.useSim(next);
  scene?.resetInterpolation();
  scene?.camera.reset(next.state, next.triggers.camera);
  audio?.startAttempt(next, false);
  sim = next;
  entry.status = "playing";
  entry.percent = 0;
  refreshList();
  setMsg("");
}

/** The next level in the list, or the previous with -1. Stops at either end. */
function step(direction: 1 | -1): void {
  const target = current + direction;
  if (target < 0 || target >= entries.length) {
    if (direction > 0) setMsg("That was the last level.");
    return;
  }
  void load(target);
}

function end(status: "finished" | "died" | "stopped"): void {
  const entry = entries[current];
  if (entry && sim) {
    entry.status = status;
    entry.percent = status === "finished" ? 100 : sim.progress() * 100;
    if (status === "finished") audio?.finishLevel(sim, false);
    else if (status === "died") audio?.playerDied(sim, false);
    else audio?.stopLevel();
  }
  endedAt = performance.now();
  refreshList();
}

// --- the loop ----------------------------------------------------------------

function tick(): void {
  if (!sim || !player || paused || endedAt !== null) return;
  const inputs = player.at(sim.tick);
  // Without inputs of its own, player 2 in a dual copies player 1, as it does
  // in the game and in the replay the tests run.
  sim.step(inputs.p1, hasPlayer2Inputs ? inputs.p2 : inputs.p1);
  scene?.tick(sim);
  renderer.recordPosition(sim.state);
  const p = sim.state;
  if (Math.abs(p.x - stillX) + Math.abs(p.y - stillY) > 1) {
    stillX = p.x;
    stillY = p.y;
    stillSince = sim.tick;
  }
  if (p.finished) end("finished");
  else if (p.dead) end("died");
  else if (sim.tick - stillSince > STILL_TICKS) end("stopped");
  else if (sim.tick > lastInputTick + HARD_LIMIT_AFTER_LAST_INPUT_TICKS) end("stopped");
}

let lastListUpdate = 0;

function render(alpha: number, dt: number): void {
  const now = performance.now();
  if (endedAt !== null && !paused && autoBox.checked && now - endedAt >= PAUSE_AFTER_RUN_MS) {
    endedAt = null;
    step(1);
  }
  const s = sim;
  if (!s) {
    renderer.clear();
    return;
  }
  audio?.update(s);
  // Pinned to the last tick whenever nothing is advancing, so a paused or
  // ended run holds still instead of sliding between its last two ticks.
  const frameAlpha = paused || endedAt !== null ? 1 : alpha;
  if (scene) {
    scene.gl.resize();
    // Paused, the level's own clock stops with the run, as it does under the
    // game's pause menu; a run that has ended goes on moving, as the game's
    // level does behind its death and end screens, which do not pause it.
    // [PlayLayer::pauseGame :93439-93477; showEndLayer :87287ff and
    //  showRetryLayer :87316ff leave the layer running]
    scene.update(paused ? 0 : Math.min(0.1, dt));
    scene.draw(frameAlpha);
    const wide = scene.camera.unitsWideAt(frameAlpha);
    const centre = scene.camera.centre(frameAlpha);
    renderer.camera.x = centre.x + wide * (PLAYER_SCREEN_FRACTION - 0.5);
    renderer.camera.y = centre.y;
    renderer.camera.zoom = (glCanvas.clientWidth || 1) / wide;
    renderer.camera.turn = scene.camera.rotationAt(frameAlpha);
  }
  if (hitboxBox.checked) renderer.draw(s);
  else renderer.clear();
  drawHud(s);
  const entry = entries[current];
  if (entry && entry.status === "playing" && now - lastListUpdate > 200) {
    entry.percent = s.progress() * 100;
    entry.statusCell.textContent = statusText(entry);
    lastListUpdate = now;
  }
}

function drawHud(s: Sim): void {
  const entry = entries[current];
  if (!entry) return;
  const p = s.state;
  const title = document.createElement("b");
  title.textContent = `${entry.id} — ${entry.name}`;
  const kind = entry.run ? KIND_TEXT[entry.run.kind] : "";
  const state = paused ? "paused" : p.finished ? "finished" : p.dead ? "died" : "";
  const lines = [
    `${kind}${state ? `  ·  ${state}` : ""}`,
    `${(s.progress() * 100).toFixed(1)}%  ·  tick ${s.tick}  ·  ${formatClock(s.tick)}`,
    `${p.mode}${p.mini ? " mini" : ""}${p.flipped ? " flipped" : ""}  ·  x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}`,
  ];
  if (p.dead && p.killedBy !== null) {
    lines.push(`hit object #${p.killedBy} (id ${s.level.objects[p.killedBy]?.id ?? "?"})`);
  }
  hud.replaceChildren(title, document.createTextNode(`\n${lines.join("\n")}`));
}

function formatClock(tick: number): string {
  const seconds = tick / TICK_RATE;
  const m = Math.floor(seconds / 60);
  const rest = (seconds - m * 60).toFixed(1).padStart(4, "0");
  return `${m}:${rest}`;
}

const loop = new GameLoop(tick, render);
bindSpeedSlider(el<HTMLInputElement>("speed"), el<HTMLSpanElement>("speedval"), loop);

// --- controls ----------------------------------------------------------------

function togglePause(): void {
  paused = !paused;
  pauseBtn.textContent = paused ? "Play" : "Pause";
  if (paused) audio?.pauseLevel();
  else audio?.resumeLevel();
}

function soundVolumes(): { music: number; sfx: number } {
  return soundBox.checked ? { music: 1, sfx: 1 } : { music: 0, sfx: 0 };
}

soundBox.addEventListener("change", () => audio?.setVolumes(soundVolumes()));

/**
 * The browser holds sound back until the first click or key. Once it lets go,
 * the music joins the run where its own clock has got to.
 */
function unlockSound(): void {
  const tryUnlock = (): void => {
    if (!audio) return;
    void audio.engine.ensureRunning().then((ok) => {
      if (!ok) return;
      window.removeEventListener("pointerdown", tryUnlock);
      window.removeEventListener("keydown", tryUnlock);
      if (sim && endedAt === null) audio?.startAttempt(sim, false);
    });
  };
  window.addEventListener("pointerdown", tryUnlock);
  window.addEventListener("keydown", tryUnlock);
}

pauseBtn.addEventListener("click", togglePause);
el<HTMLButtonElement>("prev").addEventListener("click", () => step(-1));
el<HTMLButtonElement>("next").addEventListener("click", () => step(1));
el<HTMLButtonElement>("restart").addEventListener("click", restart);
el<HTMLButtonElement>("togglelist").addEventListener("click", () => document.body.classList.toggle("list-toggled"));
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "Space") {
    e.preventDefault();
    togglePause();
  } else if (e.code === "ArrowRight") step(1);
  else if (e.code === "ArrowLeft") step(-1);
  else if (e.code === "KeyR") restart();
});

// A hidden pane stops handing out animation frames, and a run left there would
// simply stop; a timer keeps it going until the frames come back.
let fallback: ReturnType<typeof setInterval> | null = null;
let lastRafFrames = 0;
let lastRafChangeAt = performance.now();
setInterval(() => {
  const now = performance.now();
  if (loop.rafFrames !== lastRafFrames) {
    lastRafFrames = loop.rafFrames;
    lastRafChangeAt = now;
    if (fallback !== null) {
      clearInterval(fallback);
      fallback = null;
    }
  } else if (fallback === null && now - lastRafChangeAt > RAF_WATCHDOG_MS) {
    fallback = setInterval(() => loop.advance(performance.now()), FALLBACK_INTERVAL_MS);
  }
}, RAF_WATCHDOG_MS / 2);

// --- boot --------------------------------------------------------------------

(async () => {
  refreshList();
  setMsg("Loading…");
  try {
    objectData = await loadObjects();
    if (scene) {
      atlas = await AtlasSet.load("uhd");
      await scene.loadSheets(atlas);
      scene.useScenery(await Scenery.load());
      await scene.loadPlayer();
      scene.setFont(await loadLevelFont(scene.gl.gl, "bigFont", SHEET_FONT));
      scene.setEffects(await loadEffectArt(scene.gl.gl, SHEET_UI));
    }
  } catch (e) {
    console.warn(e);
    setMsg(e instanceof Error ? e.message : "The game's files could not be loaded.");
    return;
  }
  try {
    audio = new GameAudio(await Strings.load());
    audio.setVolumes(soundVolumes());
    await audio.loadUi();
    // Like the debug page: sound stops while the pane is hidden, the runs do not.
    audio.engine.attachLifecycle();
    unlockSound();
  } catch (e) {
    console.warn(e);
    audio = null;
  }
  loop.start();
  // ?level=<id> starts there instead of at Stereo Madness.
  const wanted = Number(new URLSearchParams(location.search).get("level"));
  const start = entries.findIndex((e) => e.id === wanted);
  await load(start >= 0 ? start : 0);
})();
