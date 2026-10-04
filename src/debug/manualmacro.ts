/// <reference types="vite/client" />
// Play a level by hand and keep the run as its macro.
//
// Every input is recorded against the tick it lands on, so the run can be
// replayed exactly by the tests. A run can start partway in, from a saved run
// or furthest attempt, which plays itself up to the chosen tick; practice
// checkpoints rewind the simulation and the recording together. A run that
// finishes goes to the dev server, which replays it the way the tests do and
// saves it as test/macros/<id>.json (test/record-manual.ts).

import { fetchLevel, OFFICIAL_LEVELS } from "../assets/levels";
import { Strings } from "../assets/strings";
import { GameAudio } from "../audio/gameAudio";
import { AtlasSet } from "../assets/atlas";
import { Scenery } from "../assets/scenery";
import { loadObjects, type ObjectData } from "../assets/objectTable";
import { GlContext } from "../engine/gl/context";
import { demoLevel, loadDemoLevel } from "../game/demoLevel";
import { SHEET_FONT, SHEET_UI } from "../engine/gl/spriteBatch";
import { GameLoop, InputState } from "../engine/loop";
import { loadLevel } from "../level/decode";
import type { Level } from "../level/types";
import { createSim } from "../physics/index";
import { modesOf } from "../physics/levelModes";
import { TICK_RATE, type PlayerInput, type Sim, type SimSnapshot } from "../physics/types";
import { loadEffectArt } from "../render/effects";
import { Scene } from "../render/scene";
import { loadLevelFont } from "../render/text";
import { MacroPlayer, parseMacro, type Macro, type MacroInput } from "./macro";
import { PLAYER_SCREEN_FRACTION, Renderer2D } from "./render2d";
import { bindSpeedSlider } from "./speed";

/** The seed a level is played with when its saved run names none. */
const DEFAULT_SEED = 1;
/** How long a death stays on screen before the retry. */
const RESPAWN_MS = 600;

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing #${id} in manualmacro.html`);
  return e as T;
}

const glCanvas = el<HTMLCanvasElement>("gl");
const overlayCanvas = el<HTMLCanvasElement>("c");
const hud = el<HTMLDivElement>("hud");
const levelBox = el<HTMLInputElement>("level");
const sourceBox = el<HTMLSelectElement>("source");
const fromBox = el<HTMLInputElement>("from");
const loadBtn = el<HTMLButtonElement>("load");
const pauseBtn = el<HTMLButtonElement>("pause");
const hitboxBox = el<HTMLInputElement>("hitboxes");
const soundBox = el<HTMLInputElement>("sound");
const msg = el<HTMLSpanElement>("msg");

let scene: Scene | null = null;
try {
  scene = new Scene(new GlContext(glCanvas));
} catch (e) {
  console.warn(e);
  glCanvas.hidden = true;
  hitboxBox.checked = true;
}
const renderer = new Renderer2D(overlayCanvas);
renderer.overlay = scene !== null;
const input = new InputState();
input.attach(glCanvas);

let objectData: ObjectData | null = null;
let atlas: AtlasSet | null = null;
let audio: GameAudio | null = null;

let levelId = 0;
let levelName = "";
let level: Level | null = null;
let seed = DEFAULT_SEED;
let sim: Sim | null = null;
let paused = false;
let attempt = 1;
let bestPercent = 0;
/** When the player died, for the respawn; null while alive. */
let diedAt: number | null = null;
let finished = false;
let loadToken = 0;

/** What the recording has each button at, which is what a replay will have. */
interface Held {
  jump: boolean;
  left: boolean;
  right: boolean;
}
/** The run so far: the inputs that got the player to `sim.tick`. */
let recording: MacroInput[] = [];
let held: Held = { jump: false, left: false, right: false };

/** A place to retry from: the simulation there and the recording up to it. */
interface Checkpoint {
  snap: SimSnapshot;
  inputs: number;
  held: Held;
  percent: number;
}
let checkpoints: Checkpoint[] = [];

function setMsg(text: string, tone: "" | "good" | "bad" = ""): void {
  msg.textContent = text;
  msg.className = tone;
}

// --- loading -----------------------------------------------------------------

async function fetchText(url: string): Promise<string | null> {
  const res = await fetch(url, { cache: "no-store" });
  return res.ok ? res.text() : null;
}

async function levelFor(id: number): Promise<{ level: Level; name: string }> {
  const demo = demoLevel(id);
  if (demo) return { level: await loadDemoLevel(id), name: demo.name };
  const official = OFFICIAL_LEVELS.find((l) => l.id === id);
  if (official) return { level: await fetchLevel(id), name: official.name };
  const [data, info] = await Promise.all([fetch(`/test/levels/${id}.txt`), fetch(`/test/levels/${id}.json`)]);
  if (!data.ok || !info.ok) throw new Error(`Level ${id} isn't saved yet.`);
  const raw = new TextDecoder("latin1").decode(new Uint8Array(await data.arrayBuffer()));
  const meta = (await info.json()) as { capacity: string; name?: string };
  return { level: { ...(await loadLevel(raw)), capacity: meta.capacity }, name: meta.name ?? `Level ${id}` };
}

/** The level's saved runs that a start can be played from: key, file suffix, label. */
const SOURCES: [key: string, suffix: string, label: string][] = [
  ["best", ".best", "furthest attempt"],
  ["run", "", "saved run"],
];
const sourceRuns = new Map<string, Macro>();

async function loadSources(id: number): Promise<void> {
  sourceRuns.clear();
  const texts = await Promise.all(SOURCES.map(([, suffix]) => fetchText(`/test/macros/${id}${suffix}.json`)));
  sourceBox.replaceChildren(new Option("the beginning", "start"));
  SOURCES.forEach(([key, , label], i) => {
    const text = texts[i];
    if (!text) return;
    try {
      const macro = parseMacro(text);
      sourceRuns.set(key, macro);
      const end = macro.inputs.reduce((m, e) => Math.max(m, e.frame), 0);
      sourceBox.append(new Option(`${label} (inputs to tick ${end})`, key));
    } catch (e) {
      console.warn(e);
    }
  });
  fromBox.disabled = true;
}

async function loadLevelById(id: number): Promise<void> {
  const token = ++loadToken;
  sim = null;
  setMsg(`Loading level ${id}…`);
  audio?.stopLevel();
  try {
    const got = await levelFor(id);
    await loadSources(id);
    if (token !== loadToken) return;
    levelId = id;
    level = got.level;
    levelName = got.name;
    if (scene && atlas && objectData) {
      await scene.setLevel(got.level, objectData.render, atlas, null);
    }
    if (audio) {
      const demo = demoLevel(id);
      try {
        await audio.loadLevel(got.level, demo ? 0 : id, demo ? { songId: demo.songId } : undefined);
      } catch (e) {
        console.warn(e);
      }
    }
    if (token !== loadToken) return;
    const url = new URL(location.href);
    url.searchParams.set("level", String(id));
    history.replaceState(null, "", url);
    await start();
  } catch (e) {
    if (token !== loadToken) return;
    setMsg(e instanceof Error ? e.message : `Level ${id} couldn't be loaded.`, "bad");
  }
}

/** A fresh run: from the beginning, or played by a saved run up to the chosen tick. */
async function start(): Promise<void> {
  if (!level || !objectData) return;
  const source = sourceRuns.get(sourceBox.value) ?? null;
  seed = source?.seed ?? sourceRuns.get("run")?.seed ?? sourceRuns.get("best")?.seed ?? DEFAULT_SEED;
  const from = source ? Math.max(0, Math.floor(Number(fromBox.value) || 0)) : 0;
  const next = createSim(level, objectData.table, { seed });
  recording = [];
  held = { jump: false, left: false, right: false };
  if (source && from > 0) {
    setMsg(`Playing the ${sourceBox.selectedOptions[0]?.text.split(" (")[0]} to tick ${from}…`);
    await new Promise((r) => setTimeout(r, 0));
    const player = new MacroPlayer(source);
    while (next.tick < from && !next.state.dead && !next.state.finished) {
      const m = player.at(next.tick);
      next.step(m.p1, m.p1);
    }
    if (next.state.dead || next.state.finished) {
      setMsg(`That run ${next.state.dead ? "dies" : "finishes"} before tick ${from}. Pick an earlier tick.`, "bad");
      return;
    }
    recording = source.inputs.filter((e) => e.frame < from).map((e) => ({ ...e }));
    for (const e of [...recording].sort((a, b) => a.frame - b.frame)) {
      if (e.player2) continue;
      if (e.button === 1) held.jump = e.down;
      else if (e.button === 2) held.left = e.down;
      else held.right = e.down;
    }
  }
  sim = next;
  attempt = 1;
  bestPercent = sim.progress() * 100;
  checkpoints = [{ snap: sim.snapshot(), inputs: recording.length, held: { ...held }, percent: bestPercent }];
  if (scene && objectData) {
    scene.useSim(sim);
    await scene.preloadPlayerPages(modesOf(level, objectData.table));
  }
  respawnView();
  setMsg(from > 0 ? `Starting at tick ${from}. Good luck.` : "");
}

/** Back to the last checkpoint, the recording with it. */
function retry(): void {
  const cp = checkpoints[checkpoints.length - 1];
  if (!sim || !cp) return;
  sim.restore(cp.snap);
  recording.length = cp.inputs;
  held = { ...cp.held };
  attempt++;
  respawnView();
}

function respawnView(): void {
  if (!sim) return;
  diedAt = null;
  finished = false;
  input.clear();
  renderer.reset();
  renderer.recordPosition(sim.state);
  if (scene) {
    scene.resetInterpolation();
    scene.camera.reset(sim.state, sim.triggers.camera);
  }
  if (!paused) audio?.startAttempt(sim, false);
}

function addCheckpoint(): void {
  if (!sim || diedAt !== null || finished) return;
  checkpoints.push({ snap: sim.snapshot(), inputs: recording.length, held: { ...held }, percent: sim.progress() * 100 });
  setMsg(`Checkpoint at ${(sim.progress() * 100).toFixed(1)}%.`);
}

function removeCheckpoint(): void {
  if (checkpoints.length <= 1) return;
  checkpoints.pop();
  setMsg(`Back to ${checkpoints.length - 1 ? `the checkpoint at ${checkpoints[checkpoints.length - 1].percent.toFixed(1)}%` : "the start"}.`);
}

async function save(): Promise<void> {
  if (!sim) return;
  setMsg("Checking the run…");
  try {
    const res = await fetch(`/__manual-macro/save?level=${levelId}&seed=${seed}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: recording }),
    });
    const out = (await res.json()) as { ok: boolean; message: string };
    setMsg(out.message, out.ok ? "good" : "bad");
  } catch (e) {
    console.warn(e);
    setMsg("The run couldn't be saved here. Downloading it instead.", "bad");
    const blob = new Blob([JSON.stringify({ levelId, seed, inputs: recording })], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${levelId}.manual.json`;
    a.click();
  }
}

// --- the loop ----------------------------------------------------------------

/** Writes this step's buttons into the recording wherever they differ from what it has. */
function record(frame: number, p: PlayerInput): void {
  if (p.tap) {
    recording.push({ frame, button: 1, player2: false, down: !held.jump });
    recording.push({ frame, button: 1, player2: false, down: held.jump });
    if (p.jump !== held.jump) recording.push({ frame, button: 1, player2: false, down: p.jump });
  } else if (p.jump !== held.jump) {
    recording.push({ frame, button: 1, player2: false, down: p.jump });
  }
  if (p.left !== held.left) recording.push({ frame, button: 2, player2: false, down: p.left });
  if (p.right !== held.right) recording.push({ frame, button: 3, player2: false, down: p.right });
  held = { jump: p.jump, left: p.left, right: p.right };
}

function tick(): void {
  if (!sim || paused || diedAt !== null || finished) return;
  const p = input.input(1);
  input.input(2);
  record(sim.tick, p);
  sim.step(p, p);
  scene?.tick(sim);
  renderer.recordPosition(sim.state);
  const s = sim.state;
  if (s.finished) {
    finished = true;
    audio?.finishLevel(sim, false);
    void save();
  } else if (s.dead) {
    diedAt = performance.now();
    bestPercent = Math.max(bestPercent, sim.progress() * 100);
    audio?.playerDied(sim, false);
  }
}

function render(alpha: number, dt: number): void {
  if (diedAt !== null && !paused && performance.now() - diedAt >= RESPAWN_MS) retry();
  const s = sim;
  if (!s) {
    renderer.clear();
    return;
  }
  audio?.update(s);
  const frameAlpha = paused || diedAt !== null || finished ? 1 : alpha;
  if (scene) {
    scene.gl.resize();
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
}

function drawHud(s: Sim): void {
  const p = s.state;
  const title = document.createElement("b");
  title.textContent = `${levelId} — ${levelName}`;
  const state = paused ? "paused" : finished ? "finished" : p.dead ? "died" : "";
  const seconds = s.tick / TICK_RATE;
  const lines = [
    `${(s.progress() * 100).toFixed(1)}%  ·  best ${Math.max(bestPercent, s.progress() * 100).toFixed(1)}%${state ? `  ·  ${state}` : ""}`,
    `attempt ${attempt}  ·  checkpoints ${checkpoints.length - 1}  ·  tick ${s.tick}  ·  ${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`,
    `${p.mode}${p.mini ? " mini" : ""}${p.flipped ? " flipped" : ""}  ·  x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}`,
  ];
  hud.replaceChildren(title, document.createTextNode(`\n${lines.join("\n")}`));
}

const loop = new GameLoop(tick, render);
bindSpeedSlider(el<HTMLInputElement>("speed"), el<HTMLSpanElement>("speedval"), loop);

// --- controls ----------------------------------------------------------------

function togglePause(): void {
  paused = !paused;
  pauseBtn.textContent = paused ? "Play" : "Pause";
  input.clear();
  if (paused) audio?.pauseLevel();
  else audio?.resumeLevel();
}

soundBox.addEventListener("change", () => audio?.setVolumes(soundBox.checked ? { music: 1, sfx: 1 } : { music: 0, sfx: 0 }));
pauseBtn.addEventListener("click", togglePause);
loadBtn.addEventListener("click", () => {
  const id = Math.floor(Number(levelBox.value));
  if (id > 0 && id !== levelId) void loadLevelById(id);
  else void start();
  loadBtn.blur();
});
sourceBox.addEventListener("change", () => {
  fromBox.disabled = sourceBox.value === "start";
});
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === "Escape" || e.code === "KeyP") togglePause();
  else if (e.code === "KeyR") retry();
  else if (e.code === "KeyC") addCheckpoint();
  else if (e.code === "KeyX") removeCheckpoint();
  else if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
});
// Buttons keep focus after a click, and Space would press them again.
for (const b of document.querySelectorAll("button")) b.addEventListener("keydown", (e) => e.code === "Space" && e.preventDefault());

/** The browser holds sound back until the first click or key. */
function unlockSound(): void {
  const tryUnlock = (): void => {
    if (!audio) return;
    void audio.engine.ensureRunning().then((ok) => {
      if (!ok) return;
      window.removeEventListener("pointerdown", tryUnlock);
      window.removeEventListener("keydown", tryUnlock);
      if (sim && diedAt === null && !finished) audio?.startAttempt(sim, false);
    });
  };
  window.addEventListener("pointerdown", tryUnlock);
  window.addEventListener("keydown", tryUnlock);
}

// --- boot --------------------------------------------------------------------

(async () => {
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
    setMsg(e instanceof Error ? e.message : "The game's files couldn't be loaded.", "bad");
    return;
  }
  try {
    audio = new GameAudio(await Strings.load());
    await audio.loadUi();
    audio.engine.attachLifecycle();
    unlockSound();
  } catch (e) {
    console.warn(e);
    audio = null;
  }
  loop.start();
  const params = new URLSearchParams(location.search);
  const wanted = Math.floor(Number(params.get("level"))) || 22;
  levelBox.value = String(wanted);
  await loadLevelById(wanted);
  const from = Number(params.get("from"));
  if (from > 0 && sourceRuns.size > 0) {
    sourceBox.selectedIndex = 1;
    fromBox.disabled = false;
    fromBox.value = String(from);
    await start();
  }
})();
