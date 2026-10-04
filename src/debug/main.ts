/// <reference types="vite/client" />
import { fetchLevel, OFFICIAL_LEVELS } from "../assets/levels";
import { AtlasSet } from "../assets/atlas";
import { Scenery } from "../assets/scenery";
import { loadObjects, type ObjectData } from "../assets/objectTable";
import { GlContext } from "../engine/gl/context";
import { Scene } from "../render/scene";
import { loadLevelFont } from "../render/text";
import { SHEET_FONT, SHEET_UI } from "../engine/gl/spriteBatch";
import { loadEffectArt } from "../render/effects";
import { GameLoop, InputState } from "../engine/loop";
import type { Level } from "../level/types";
import { loadLevel } from "../level/decode";
import { createSim } from "../physics/index";
import { NO_INPUT, SUBSTEPS_PER_FRAME, TICK_RATE, type ObjectTable, type PlayerInput, type Sim } from "../physics/types";
import { PLAYER_SCREEN_FRACTION, Renderer2D } from "./render2d";
import { GameAudio } from "../audio/gameAudio";
import { Strings } from "../assets/strings";
import { SPAWN_SPEED } from "../triggers/runtime";
import { MacroPlayer, parseMacro } from "./macro";
import { bindSpeedSlider } from "./speed";

/** Delay before an automatic restart after death. */
const RESTART_AFTER_DEATH_MS = 1000;
/** rAF silence after which the interval driver takes over (the Browser pane starves hidden tabs). */
const RAF_WATCHDOG_MS = 500;
const FALLBACK_INTERVAL_MS = 16;

// --- page --------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing #${id} in debug.html`);
  return e as T;
}

const canvas = el<HTMLCanvasElement>("c");
const hud = el<HTMLDivElement>("hud");
const bar = el<HTMLDivElement>("bar");
const levelSelect = el<HTMLSelectElement>("level");
const restartBtn = el<HTMLButtonElement>("restart");
const pauseBtn = el<HTMLButtonElement>("pause");
const stepBtn = el<HTMLButtonElement>("step");
const step4Btn = el<HTMLButtonElement>("step4");
const noclipBox = el<HTMLInputElement>("noclip");
const startPct = el<HTMLInputElement>("startpct");
const msg = el<HTMLSpanElement>("msg");

const macroLabel = document.createElement("label");
macroLabel.textContent = "Load macro ";
const macroInput = document.createElement("input");
macroInput.type = "file";
macroInput.accept = ".json,application/json";
macroLabel.appendChild(macroInput);
const macroClear = document.createElement("button");
macroClear.textContent = "Clear macro";
macroClear.hidden = true;
bar.insertBefore(macroLabel, msg);
bar.insertBefore(macroClear, msg);

for (const lv of OFFICIAL_LEVELS) {
  const opt = document.createElement("option");
  opt.value = String(lv.id);
  opt.textContent = `${lv.id} — ${lv.name}`;
  levelSelect.appendChild(opt);
}

const glCanvas = el<HTMLCanvasElement>("gl");
const hitboxBox = el<HTMLInputElement>("hitboxes");
let scene: Scene | null = null;
/** Sound is off unless ?audio=1, so the physics harness stays silent by default. */
const wantAudio = new URLSearchParams(location.search).get("audio") === "1";
let audio: GameAudio | null = null;
try {
  scene = new Scene(new GlContext(glCanvas));
} catch (e) {
  // No WebGL2: the page still works as the hitbox view it has always been.
  console.warn(e);
  glCanvas.hidden = true;
}
const renderer = new Renderer2D(canvas);
renderer.overlay = scene !== null;
const input = new InputState();
input.attach(canvas);

let objects: ObjectTable | null = null;
let objectData: ObjectData | null = null;
let atlas: AtlasSet | null = null;
let level: Level | null = null;
let levelId = OFFICIAL_LEVELS[0].id;
let sim: Sim | null = null;
let paused = false;
let macro: MacroPlayer | null = null;
/** The seed the loaded macro was solved with; random triggers drift under any other. */
let macroSeed: number | undefined;
/** Ticks before the macro's last input to start each replay at, silently stepping up to there. 0 plays it all. */
let tailTicks = 0;
let diedAt: number | null = null;
let loadToken = 0;

// fps / ticks-per-second counters
let frameCount = 0;
let tickCount = 0;
let fps = 0;
let tps = 0;
let statsAt = performance.now();
let lastFrameAt = performance.now();
/** The run's tick the level's own clock was last advanced to, for a step taken while paused. */
let shownTick = 0;

function setMsg(text: string): void {
  msg.textContent = text;
}

function buildSim(): void {
  if (!level || !objects) return;
  const pct = Math.min(100, Math.max(0, Number(startPct.value) || 0));
  const next: Sim = createSim(level, objects, {
    start: pct > 0 ? { x: (pct / 100) * level.lengthUnits } : undefined,
    noclip: noclipBox.checked,
    ...(macro && macroSeed !== undefined ? { seed: macroSeed } : {}),
  });
  sim = next;
  diedAt = null;
  macro?.reset();
  if (macro && tailTicks > 0 && pct === 0) {
    const until = macro.length - tailTicks;
    while (next.tick < until && !next.state.dead && !next.state.finished) {
      const m = macro.at(next.tick);
      next.step(m.p1, m.p2);
    }
  }
  if (audio && level) {
    // Starting part-way in means the track has to start part-way in too. This
    // reads the distance at the 1x scroll rate, so a level with speed portals
    // before the start point will be out by however much they changed it —
    // good enough for a debug jump, not good enough for practice mode.
    // Without a start point the run's own music clock is used, which is also
    // where a macro skipped ahead has got to.
    const from = pct > 0 ? ((pct / 100) * level.lengthUnits) / SPAWN_SPEED : undefined;
    audio.startAttempt(next, false, from);
  }
  renderer.reset();
  renderer.recordPosition(next.state);
  scene?.useSim(next);
  scene?.resetInterpolation();
  scene?.camera.reset(next.state, next.triggers.camera);
  setMsg(macro ? `Macro loaded (${macro.length} ticks).` : "");
}

/** An online level saved by test/fetch-online-level.ts (dev server only). */
async function fetchSavedOnlineLevel(id: number): Promise<Level> {
  const [data, info] = await Promise.all([fetch(`/test/levels/${id}.txt`), fetch(`/test/levels/${id}.json`)]);
  if (!data.ok || !info.ok) throw new Error(`Level ${id} isn't saved in test/levels.`);
  const raw = new TextDecoder("latin1").decode(new Uint8Array(await data.arrayBuffer()));
  const { capacity } = (await info.json()) as { capacity: string };
  return { ...(await loadLevel(raw)), capacity };
}

const WATCH_EVERY_MS = 5000;
let watchedMacroUrl: string | null = null;

/** Re-reads a macro file a solve keeps rewriting, and replays it again whenever it changes. */
function watchMacro(url: string, current: string): void {
  watchedMacroUrl = url;
  let last = current;
  const poll = async (): Promise<void> => {
    if (watchedMacroUrl !== url) return;
    try {
      const res = await fetch(url, { cache: "no-store" });
      const text = res.ok ? await res.text() : last;
      if (text !== last && watchedMacroUrl === url) {
        useMacro(text);
        last = text;
        buildSim();
        setMsg(`New attempt loaded (${macro?.length ?? 0} ticks).`);
      }
    } catch {
      // the solve is rewriting the file; try again next time
    }
    setTimeout(() => void poll(), WATCH_EVERY_MS);
  };
  setTimeout(() => void poll(), WATCH_EVERY_MS);
}

function useMacro(text: string): void {
  const parsed = parseMacro(text);
  macro = new MacroPlayer(parsed);
  macroSeed = parsed.seed;
  macroClear.hidden = false;
}

async function loadLevelById(id: number): Promise<void> {
  const token = ++loadToken;
  levelId = id;
  setMsg(`Loading level ${id}…`);
  try {
    const lv = OFFICIAL_LEVELS.some((l) => l.id === id) ? await fetchLevel(id) : await fetchSavedOnlineLevel(id);
    if (token !== loadToken) return;
    level = lv;
    buildSim();
    if (scene && atlas && objectData) {
      const built = await scene.setLevel(lv, objectData.render, atlas, sim);
      if (token !== loadToken) return;
      if (built.missingFrames > 0) console.warn(`${built.missingFrames} sprite(s) had no frame`);
    }
    if (audio && sim) {
      await audio.loadLevel(lv, id);
      if (token !== loadToken) return;
      audio.startAttempt(sim, false);
    }
  } catch (e) {
    if (token !== loadToken) return;
    setMsg(e instanceof Error ? e.message : "Level could not be loaded.");
  }
}

/** ?pauseAt=<tick> freezes the run there so a spot deep in a macro can be inspected. */
const pauseAtTick = Number(new URLSearchParams(location.search).get("pauseAt")) || 0;

function tick(): void {
  if (!sim || paused || sim.state.dead || sim.state.finished) return;
  if (pauseAtTick > 0 && sim.tick >= pauseAtTick) {
    paused = true;
    pauseBtn.textContent = "Resume";
    return;
  }
  let p1: PlayerInput;
  let p2: PlayerInput | undefined;
  if (macro) {
    const m = macro.at(sim.tick);
    p1 = m.p1;
    p2 = m.p2;
    input.consume(); // keep the button's edges from piling up while the macro drives
  } else {
    p1 = input.input(1);
    const second = input.input(2);
    p2 = sim.state2 ? second : undefined;
  }
  sim.step(p1, p2 ?? NO_INPUT);
  tickCount++;
  renderer.recordPosition(sim.state);
  scene?.tick(sim);
  if (sim.state.dead && diedAt === null) {
    diedAt = performance.now();
    audio?.playerDied(sim, false);
    const k = sim.state.killedBy;
    if (k === null) setMsg("Died (floor/ceiling).");
    else {
      const o = sim.level.objects[k];
      setMsg(o ? `Died: object #${k} id ${o.id} at ${o.x},${o.y}` : `Died: object #${k}`);
    }
  }
  if (sim.state.finished) {
    setMsg("Level complete.");
    audio?.finishLevel(sim, false);
  }
}

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}

function hudText(s: Sim): string {
  const p = s.state;
  const lines = [
    `level ${levelId}  tick ${s.tick}  ${paused ? "PAUSED" : ""}${macro ? " MACRO" : ""}`,
    `x ${fmt(p.x)}  y ${fmt(p.y)}  ${fmt(s.progress() * 100, 1)}%`,
    `yVel ${fmt(p.yVel, 3)}  xSpeed ${fmt(p.xSpeed, 3)}  xVel ${fmt(p.xVel, 3)}  rot ${fmt(p.rotation, 1)}`,
    `mode ${p.mode}  speed ${p.speed}  mini ${p.mini}  flipped ${p.flipped}  mirrored ${p.mirrored}`,
    `onGround ${p.onGround}  onSlope ${p.onSlope}  holding ${p.holding} (${p.holdTicks})  orb ${p.orbReady ? "ready" : "spent"}  dashing ${p.dashing}`,
    `dead ${p.dead}${p.killedBy !== null ? `  killedBy #${p.killedBy} id ${s.level.objects[p.killedBy]?.id ?? "?"}` : ""}  finished ${p.finished}`,
    `floor ${fmt(s.floorY, 1)}  ceiling ${Number.isFinite(s.ceilingY) ? fmt(s.ceilingY, 1) : "open"}  zoom ${fmt(renderer.camera.zoom)}`,
    `fps ${fps}  ticks/s ${tps}  driver ${driver}`,
  ];
  if (s.state2) {
    const q = s.state2;
    lines.push(`P2 x ${fmt(q.x)} y ${fmt(q.y)} yVel ${fmt(q.yVel, 3)} mode ${q.mode} dead ${q.dead}`);
  }
  if (scene) lines.push("", scene.describe());
  if (renderer.hovered.length) {
    lines.push(`hover: ${renderer.hovered.map((h) => `#${h.index}(id ${h.id})`).join(" ")}`);
  }
  return lines.join("\n");
}

function render(alpha: number): void {
  frameCount++;
  if (audio && sim) audio.update(sim);
  const now = performance.now();
  if (now - statsAt >= 1000) {
    fps = Math.round((frameCount * 1000) / (now - statsAt));
    tps = Math.round((tickCount * 1000) / (now - statsAt));
    frameCount = 0;
    tickCount = 0;
    statsAt = now;
  }
  if (!sim) return;
  if (diedAt !== null && !paused && now - diedAt >= RESTART_AFTER_DEATH_MS) buildSim();
  if (!sim) return;
  if (scene) {
    scene.gl.resize();
    // Paused, the level's own clock stops with the run, as it does under the
    // game's pause menu: the colours, the pulses, the screen effects and the
    // particles hold still. A step taken while paused moves them on by the
    // ticks it ran.
    const wall = Math.min(0.1, (now - lastFrameAt) / 1000);
    scene.update(paused ? Math.max(0, sim.tick - shownTick) / TICK_RATE : wall);
    shownTick = sim.tick;
    lastFrameAt = now;
    scene.draw(alpha);
    // The overlay shares the rendered camera, so the two pictures agree by
    // construction rather than by both happening to follow the same rule. The
    // two place the player at different fractions of the width, so the overlay
    // camera is shifted to land on the same pixels.
    const wide = scene.camera.unitsWideAt(alpha);
    const centre = scene.camera.centre(alpha);
    renderer.camera.x = centre.x + wide * (PLAYER_SCREEN_FRACTION - 0.5);
    renderer.camera.y = centre.y;
    renderer.camera.zoom = (glCanvas.clientWidth || 1) / wide;
    renderer.camera.turn = scene.camera.rotationAt(alpha);
  }
  // The overlay canvas stays on screen even when it draws nothing: it is what
  // the pointer listens on, so hiding it would stop taps reaching the game.
  if (hitboxBox.checked) renderer.draw(sim);
  else renderer.clear();
  hud.textContent = hudText(sim);
}

// Reachable from the console while developing: __gd.scene, __gd.sim.
if (import.meta.env.DEV) {
  Object.defineProperty(window, "__gd", {
    value: {
      get scene() {
        return scene;
      },
      get sim() {
        return sim;
      },
    },
  });
}

const loop = new GameLoop(tick, render);
// ?speed=<n> runs the sim n× real time (handy for reaching a pauseAt tick quickly).
loop.timeScale = Math.min(32, Math.max(0.1, Number(new URLSearchParams(location.search).get("speed")) || 1));
bindSpeedSlider(el<HTMLInputElement>("speed"), el<HTMLSpanElement>("speedval"), loop);

// --- controls ----------------------------------------------------------------

levelSelect.addEventListener("change", () => {
  void loadLevelById(Number(levelSelect.value));
});
restartBtn.addEventListener("click", () => buildSim());
pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "Resume" : "Pause";
});
function stepWhilePaused(n: number): void {
  if (!sim) return;
  const was = paused;
  paused = false;
  loop.stepTicks(n);
  paused = true;
  if (!was) pauseBtn.textContent = "Resume";
}
stepBtn.addEventListener("click", () => stepWhilePaused(1));
step4Btn.addEventListener("click", () => stepWhilePaused(SUBSTEPS_PER_FRAME));
noclipBox.addEventListener("change", () => buildSim());
startPct.addEventListener("change", () => buildSim());
macroInput.addEventListener("change", async () => {
  const file = macroInput.files?.[0];
  if (!file) return;
  try {
    useMacro(await file.text());
    buildSim();
  } catch (e) {
    macro = null;
    setMsg(`Macro could not be read${e instanceof Error ? `: ${e.message}` : "."}`);
  }
});
macroClear.addEventListener("click", () => {
  macro = null;
  macroSeed = undefined;
  watchedMacroUrl = null;
  macroInput.value = "";
  macroClear.hidden = true;
  buildSim();
});
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === "KeyR") buildSim();
  else if (e.code === "KeyP") pauseBtn.click();
  else if (e.code === "Period") stepWhilePaused(1);
  else if (e.code === "Slash") stepWhilePaused(SUBSTEPS_PER_FRAME);
});

// --- loop driver with rAF watchdog -------------------------------------------

let driver: "raf" | "interval" = "raf";
let fallback: ReturnType<typeof setInterval> | null = null;
let lastRafFrames = 0;
let lastRafChangeAt = performance.now();

loop.start();
setInterval(() => {
  const now = performance.now();
  if (loop.rafFrames !== lastRafFrames) {
    lastRafFrames = loop.rafFrames;
    lastRafChangeAt = now;
    if (fallback !== null) {
      clearInterval(fallback);
      fallback = null;
      driver = "raf";
    }
  } else if (fallback === null && now - lastRafChangeAt > RAF_WATCHDOG_MS) {
    driver = "interval";
    fallback = setInterval(() => loop.advance(performance.now()), FALLBACK_INTERVAL_MS);
  }
}, RAF_WATCHDOG_MS / 2);

// --- boot --------------------------------------------------------------------

(async () => {
  setMsg("Loading object table…");
  try {
    objectData = await loadObjects();
    objects = objectData.table;
  } catch (e) {
    setMsg(e instanceof Error ? e.message : "Object table could not be loaded.");
    return;
  }
  if (scene) {
    setMsg("Loading sheets…");
    try {
      atlas = await AtlasSet.load("uhd");
      await scene.loadSheets(atlas);
      scene.useScenery(await Scenery.load());
      await scene.loadPlayer();
      // The harness has no menus to borrow the face from, so it loads its own.
      scene.setFont(await loadLevelFont(scene.gl.gl, "bigFont", SHEET_FONT));
      scene.setEffects(await loadEffectArt(scene.gl.gl, SHEET_UI));
    } catch (e) {
      // Without the art the page falls back to hitboxes, which is still useful.
      console.warn(e);
      setMsg(e instanceof Error ? e.message : "Sprite sheets could not be loaded.");
      scene = null;
      renderer.overlay = false;
      glCanvas.hidden = true;
    }
  }
  if (wantAudio) {
    setMsg("Loading sound…");
    try {
      const strings = await Strings.load();
      audio = new GameAudio(strings);
      await audio.engine.ensureRunning();
      await audio.loadUi();
      // The debug page's whole job is being pokeable from the console.
      (window as unknown as { gdAudio: GameAudio }).gdAudio = audio;
      // Sound stops when the pane is hidden; the simulation deliberately does
      // not. This page is a harness whose whole point is running unattended —
      // the rAF watchdog below exists precisely to keep a macro replaying when
      // the pane stops handing out frames, and stopping the loop here would
      // fight it. The shipped game wants the opposite and stops both; that
      // policy belongs in src/main.ts, not in the harness.
      audio.engine.attachLifecycle();
    } catch (e) {
      console.warn(e);
      audio = null;
      setMsg("Sound could not be started; the level still plays.");
    }
  }

  // The scene and the simulation, for poking at from the console.
  (window as unknown as { gdScene: unknown }).gdScene = { get scene() { return scene; }, get sim() { return sim; } };

  // ?level=<id>&macro=1 opens a level with its saved autoplayer macro (test/macros/<id>.json;
  // macro=best replays the furthest failed attempt from --save-best, and
  // macro=deadend the furthest death a running solve has reached so far,
  // test/deadends/<id>.json) so a run can be watched without picking a file
  // by hand. best and deadend are re-read every few seconds and replayed
  // again when they change; deadend starts each replay 5 s before its end,
  // and ?tail=<seconds> sets that for any macro (0 plays it all). In the dev
  // server, ?level also takes an online level saved in test/levels.
  const params = new URLSearchParams(location.search);
  const wanted = Number(params.get("level"));
  if (OFFICIAL_LEVELS.some((l) => l.id === wanted)) levelId = wanted;
  else if (wanted > 0 && import.meta.env.DEV) {
    levelId = wanted;
    const opt = document.createElement("option");
    opt.value = String(wanted);
    opt.textContent = `${wanted} — online`;
    levelSelect.appendChild(opt);
  }
  const which = params.get("macro");
  if (which && import.meta.env.DEV) {
    const url =
      which === "deadend" ? `/test/deadends/${levelId}.json` : `/test/macros/${levelId}${which === "best" ? ".best" : ""}.json`;
    tailTicks = Math.max(0, Number(params.get("tail") ?? (which === "deadend" ? 5 : 0)) || 0) * TICK_RATE;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const text = await res.text();
        useMacro(text);
        if (which === "best" || which === "deadend") watchMacro(url, text);
      }
    } catch {
      // no saved macro for this level; play by hand
    }
  }
  levelSelect.value = String(levelId);
  await loadLevelById(levelId);
})();
