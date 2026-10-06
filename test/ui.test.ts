// The interface's pure parts: where a glyph goes, where a line breaks, and
// which widget a click landed on. All of it is decidable without a browser,
// which is the point — the drawing is easy to eyeball and the arithmetic is not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ScreenStack, type Screen } from "../src/ui/screen";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FontFile } from "../src/assets/miscTypes";
import { layout, measure, scaleToFit } from "../src/ui/text";
import { assignFontUnits } from "../src/ui/art";
import {
  MAX_SHEETS,
  SHEET_BACKGROUND,
  SHEET_FONT,
  SHEET_FONT_2,
  SHEET_GROUND,
  SHEET_GROUND_DETAIL,
  SHEET_PLAYER,
  SHEET_PLAYER_2,
  SHEET_UI,
  UPLOAD_UNIT,
} from "../src/engine/gl/spriteBatch";
import { CompleteScreen, PauseScreen, PlayScreen } from "../src/ui/screens/play";
import { designSize, pointerToUi, viewportFor, VIEW_UNITS_HIGH, VIEW_UNITS_WIDE } from "../src/ui/viewport";
import { Game } from "../src/game/game";
import { Mods } from "../src/mods/index";
import { Camera } from "../src/render/camera";
import { defaultSave } from "../src/save/schema";
import { loadObjectTable, builtPath } from "./helpers";
import { emptyLevel, makeHeader, stepN } from "./levelKit";
import { createSim } from "../src/physics/index";
import { NO_INPUT, type Sim } from "../src/physics/types";

const FONTS = builtPath("assets/fonts/fonts.json");
const SKIP = existsSync(FONTS) ? false : "run `npm run assets` first";

function fonts(): FontFile {
  return JSON.parse(readFileSync(FONTS, "utf8")) as FontFile;
}

// --- the design box ---------------------------------------------------------

test("a wide window keeps 320 units of height and gets wider", () => {
  const wide = designSize(16 / 9);
  assert.equal(wide.height, VIEW_UNITS_HIGH);
  assert.ok(Math.abs(wide.width - 568.9) < 0.1, `16:9 should show ~569 units across, got ${wide.width}`);
});

test("a window narrower than 3:2 keeps 480 units of width and gets taller", () => {
  // A phone held upright. Reading the policy the other way round makes this
  // four times too close, which is the bug it exists to prevent.
  const tall = designSize(9 / 16);
  assert.equal(tall.width, VIEW_UNITS_WIDE);
  assert.ok(Math.abs(tall.height - 853.3) < 0.1, `9:16 should show ~853 units tall, got ${tall.height}`);
});

test("3:2 exactly is the pivot and keeps both", () => {
  const pivot = designSize(1.5);
  assert.equal(pivot.height, VIEW_UNITS_HIGH);
  assert.ok(Math.abs(pivot.width - VIEW_UNITS_WIDE) < 1e-9);
});

test("a nonsense aspect falls back rather than dividing by zero", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const size = designSize(bad);
    assert.ok(Number.isFinite(size.width) && size.width > 0, `${bad} gave ${size.width}`);
    assert.ok(Number.isFinite(size.height) && size.height > 0);
  }
});

test("a pointer in the top-left corner is at the top-left of the design box", () => {
  const view = viewportFor(1920, 1080);
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }) } as HTMLElement;
  const topLeft = pointerToUi(canvas, view, 0, 0);
  assert.ok(Math.abs(topLeft.x) < 1e-9);
  // Screen y runs down, design y runs up.
  assert.ok(Math.abs(topLeft.y - view.height) < 1e-9);
  const middle = pointerToUi(canvas, view, 960, 540);
  assert.ok(Math.abs(middle.x - view.width / 2) < 1e-9);
  assert.ok(Math.abs(middle.y - view.height / 2) < 1e-9);
});

test("a pointer is measured against the canvas's own box, not the window", () => {
  const view = viewportFor(800, 600);
  const canvas = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }) } as HTMLElement;
  const p = pointerToUi(canvas, view, 100, 50);
  assert.ok(Math.abs(p.x) < 1e-9, `x should be 0 at the canvas's own left edge, got ${p.x}`);
  assert.ok(Math.abs(p.y - view.height) < 1e-9);
});

// --- text -------------------------------------------------------------------

test("bigFont at scale 1 is the height the game draws a heading at", { skip: SKIP }, () => {
  const file = fonts();
  const big = file.fonts.bigFont;
  // 128 px glyphs at 4 px per unit is 32 units: a tenth of the 320-unit screen.
  assert.equal(big.size / file.pxPerUnit, 32);
});

test("a glyph's advance and kerning come from the font, not from its box", { skip: SKIP }, () => {
  const file = fonts();
  const big = file.fonts.bigFont;
  const px = file.pxPerUnit;
  const A = big.chars[65];
  const V = big.chars[86];
  assert.ok(A && V, "bigFont should have A and V");

  const two = measure(big, px, "AV", { scale: 1 });
  const kern = big.kernings?.["65,86"] ?? 0;
  const expected = (A.xa + V.xa + kern) / px;
  assert.ok(Math.abs(two.width - expected) < 1e-9, `expected ${expected}, got ${two.width}`);
});

test("scale divides the size without changing the shape", { skip: SKIP }, () => {
  const file = fonts();
  const big = file.fonts.bigFont;
  const full = measure(big, file.pxPerUnit, "Stereo Madness", { scale: 1 });
  const half = measure(big, file.pxPerUnit, "Stereo Madness", { scale: 0.5 });
  assert.ok(Math.abs(full.width / 2 - half.width) < 1e-9);
  assert.ok(Math.abs(full.height / 2 - half.height) < 1e-9);
});

test("measure and layout agree about the box", { skip: SKIP }, () => {
  const file = fonts();
  const big = file.fonts.bigFont;
  const text = "Back On Track";
  const m = measure(big, file.pxPerUnit, text, { scale: 0.6 });
  const l = layout(big, file.pxPerUnit, text, { scale: 0.6 });
  assert.ok(Math.abs(m.width - l.width) < 1e-9);
  assert.ok(Math.abs(m.height - l.height) < 1e-9);
  assert.equal(m.lines, l.lines);
});

test("every glyph sits inside the box its layout reports", { skip: SKIP }, () => {
  const file = fonts();
  const big = file.fonts.bigFont;
  const l = layout(big, file.pxPerUnit, "Hexagon Force", { scale: 0.5 });
  for (const g of l.glyphs) {
    assert.ok(g.x >= -1e-6, `glyph ${g.code} starts left of the box at ${g.x}`);
    assert.ok(g.y >= -l.height, `glyph ${g.code} sits below the box`);
    assert.ok(g.y + g.h <= l.height + 1e-6, `glyph ${g.code} pokes out of the top`);
  }
});

test("an explicit newline makes a second line", { skip: SKIP }, () => {
  const file = fonts();
  const l = layout(file.fonts.bigFont, file.pxPerUnit, "one\ntwo", {});
  assert.equal(l.lines, 2);
  assert.deepEqual([...new Set(l.glyphs.map((g) => g.line))], [0, 1]);
  const topOf = (line: number): number => Math.max(...l.glyphs.filter((g) => g.line === line).map((g) => g.y + g.h));
  assert.ok(topOf(0) > topOf(1), "the second line should sit below the first");
});

test("wrapping breaks at spaces and keeps every line inside the width", { skip: SKIP }, () => {
  const file = fonts();
  const chat = file.fonts.chatFont;
  const text = "Use practice mode to learn the layout of a level";
  const maxWidth = 200;
  const m = measure(chat, file.pxPerUnit, text, { scale: 1, maxWidth });
  assert.ok(m.lines > 1, "it should have wrapped");
  assert.ok(m.width <= maxWidth + 1e-6, `the box is ${m.width}, wider than ${maxWidth}`);
});

test("a single word too long for the line is broken rather than allowed to run off", { skip: SKIP }, () => {
  const file = fonts();
  const chat = file.fonts.chatFont;
  const m = measure(chat, file.pxPerUnit, "Supercalifragilisticexpialidocious", { scale: 1, maxWidth: 60 });
  assert.ok(m.lines > 1, "it should have been broken");
  assert.ok(m.width <= 60 + 1e-6, `the box is ${m.width}, wider than 60`);
});

test("centring and right-aligning move the short line, not the long one", { skip: SKIP }, () => {
  const file = fonts();
  const big = file.fonts.bigFont;
  const text = "wide line here\nshort";
  const left = layout(big, file.pxPerUnit, text, { align: "left" });
  const centre = layout(big, file.pxPerUnit, text, { align: "center" });
  const right = layout(big, file.pxPerUnit, text, { align: "right" });
  assert.ok(Math.abs(left.width - centre.width) < 1e-9, "alignment must not change the box");
  const firstOf = (l: typeof left, line: number): number => l.glyphs.find((g) => g.line === line)?.x ?? 0;
  assert.ok(firstOf(centre, 1) > firstOf(left, 1), "centring should indent the short line");
  assert.ok(firstOf(right, 1) > firstOf(centre, 1), "right alignment should indent it further");
});

test("scaleToFit shrinks a long name and leaves a short one alone", { skip: SKIP }, () => {
  const file = fonts();
  const big = file.fonts.bigFont;
  const px = file.pxPerUnit;
  const long = scaleToFit(big, px, "The Secret Hollow", 120);
  assert.ok(long < 1, "a long name at 120 units should shrink");
  assert.ok(measure(big, px, "The Secret Hollow", { scale: long }).width <= 120 + 1e-6);
  assert.equal(scaleToFit(big, px, "Dash", 4000), 1, "it should never grow past the cap");
});

test("a character the font does not have is skipped, not drawn as a hole", { skip: SKIP }, () => {
  const file = fonts();
  const big = file.fonts.bigFont;
  const plain = measure(big, file.pxPerUnit, "AB", {});
  const withMissing = measure(big, file.pxPerUnit, "A\u{1F600}B", {});
  assert.ok(Math.abs(plain.width - withMissing.width) < 1e-9);
});

test("laying out nothing is a zero box rather than a crash", { skip: SKIP }, () => {
  const file = fonts();
  const l = layout(file.fonts.bigFont, file.pxPerUnit, "", {});
  assert.equal(l.glyphs.length, 0);
  assert.equal(l.width, 0);
});

// --- the texture unit budget ------------------------------------------------
// Sixteen units is the WebGL2 minimum and this port uses all sixteen, so the
// only safe sharing is a unit whose users all rebind it before they sample it.
// One unit is set aside for that; everything else has to stay clear of it.
// Getting this wrong does not throw — it draws a background image's pixels as
// letters, or an empty unit's opaque black, and only sometimes.

test("the scratch unit is the last one, and nothing stable shares it", () => {
  assert.equal(UPLOAD_UNIT, MAX_SHEETS - 1);
  for (const [name, unit] of Object.entries({ SHEET_BACKGROUND, SHEET_GROUND, SHEET_GROUND_DETAIL, SHEET_PLAYER, SHEET_PLAYER_2, SHEET_UI, SHEET_FONT })) {
    assert.notEqual(unit, UPLOAD_UNIT, `${name} shares the scratch unit, which is emptied by every upload`);
    assert.ok(unit >= 0 && unit < MAX_SHEETS, `${name} is outside the unit budget`);
  }
});

test("two fonts get the two font units, in the order they were asked for", () => {
  const units = assignFontUnits(["bigFont", "chatFont"]);
  assert.deepEqual([...units], [["bigFont", SHEET_FONT], ["chatFont", SHEET_FONT_2]]);
});

test("a font asked for twice does not take two units", () => {
  const units = assignFontUnits(["bigFont", "bigFont", "chatFont"]);
  assert.equal(units.size, 2);
  assert.equal(units.get("chatFont"), SHEET_FONT_2);
});

test("a third font gets no unit rather than taking one from another font", () => {
  // Evicting would swap a page out from under glyphs already queued for this
  // frame, which draws one font's letters out of the other's image.
  const units = assignFontUnits(["bigFont", "chatFont", "goldFont"]);
  assert.equal(units.size, 2);
  assert.equal(units.get("goldFont"), undefined);
  assert.equal(new Set(units.values()).size, 2, "the two fonts must be on different units");
});

// --- the screen stack ---------------------------------------------------------

/** A screen that counts its own updates, for telling which ones ran. */
function counting(name: string, opaque: boolean): Screen & { updates: number } {
  return {
    name,
    opaque,
    updates: 0,
    update() {
      this.updates++;
    },
    build: () => [],
  };
}

test("a screen covered by an opaque one does not update", () => {
  // The main menu stays on the stack under a level. It used to go on running
  // underneath, and its cube respawned with a random icon and bound that icon's
  // page into the units the player draws from — so the player vanished for
  // seconds at a time, in any level, whenever the menu's cube came round.
  const stack = new ScreenStack();
  const menu = counting("menu", true);
  const level = counting("play", true);
  stack.push(menu);
  stack.push(level);
  stack.update(1 / 60);
  assert.equal(menu.updates, 0, "the menu under the level should be frozen");
  assert.equal(level.updates, 1, "the level on top should run");
});

test("an overlay does not freeze the level under it", () => {
  // The pause menu, the end screen and the death screen are not opaque, so the
  // level under them keeps running — the stack's own ticks rule is what pauses
  // the simulation, not this.
  const stack = new ScreenStack();
  const level = counting("play", true);
  const pause = counting("pause", false);
  stack.push(level);
  stack.push(pause);
  stack.update(1 / 60);
  assert.equal(level.updates, 1);
  assert.equal(pause.updates, 1);
});

test("the pause menu stops the level's own clock; the end screen stops only the run", () => {
  // The game pauses the level layer itself, so its colours, effects and
  // particles stand still under the pause menu; the end and death screens
  // leave it running. [PlayLayer::pauseGame :93439-93477; showEndLayer
  //  :87287ff, showRetryLayer :87316ff]
  const game = {} as unknown as ConstructorParameters<typeof PauseScreen>[0];
  const pause = new PauseScreen(game);
  const complete: Screen = new CompleteScreen(game, false);
  assert.deepEqual([pause.ticksBelow, pause.freezesLevel], [false, true]);
  assert.deepEqual([complete.ticksBelow, complete.freezesLevel ?? false], [false, false]);
  // Pushed as plain screens with the same flags: entering the real ones
  // needs a whole game.
  const stack = new ScreenStack();
  stack.push(counting("play", true));
  assert.equal(stack.freezesLevel, false);
  stack.push({ name: "pause", ticksBelow: false, freezesLevel: true, build: () => [] });
  assert.deepEqual([stack.ticks, stack.freezesLevel], [false, true]);
  stack.push({ name: "settings", ticksBelow: false, build: () => [] });
  assert.equal(stack.freezesLevel, true, "a panel opened from the pause menu keeps it frozen");
  stack.pop();
  stack.pop();
  assert.equal(stack.freezesLevel, false, "and resuming lets it run");
  stack.push({ name: "complete", ticksBelow: false, build: () => [] });
  assert.deepEqual([stack.ticks, stack.freezesLevel], [false, false]);
});

test("a key stops at the topmost opaque screen, so Space in a level never reaches the level select", () => {
  // The level select plays its level on Space and stays on the stack under
  // the level; Space falling through to it restarted the level mid-jump.
  const stack = new ScreenStack();
  const pressed: string[] = [];
  stack.push({ name: "levelSelect", opaque: true, build: () => [], onKey: (code) => (pressed.push(`select:${code}`), true) });
  stack.push({ name: "play", opaque: true, build: () => [], onKey: () => false });
  assert.equal(stack.key("Space", true), false);
  assert.equal(pressed.length, 0);
  // An overlay above the level still sees keys, and the level under it too.
  stack.push({ name: "pause", build: () => [], onKey: (code) => (pressed.push(`pause:${code}`), code === "Escape") });
  stack.key("Escape", true);
  assert.deepEqual(pressed, ["pause:Escape"]);
});

test("uncovering a screen lets it run again", () => {
  const stack = new ScreenStack();
  const menu = counting("menu", true);
  stack.push(menu);
  stack.push(counting("play", true));
  stack.update(1 / 60);
  stack.pop();
  stack.update(1 / 60);
  assert.equal(menu.updates, 1, "back on top, the menu moves again");
});

test("the pause restart goes back to the last checkpoint; a platformer's full restart starts over", () => {
  // [gdp PauseLayer::onRestart :235367-235375 → resetLevel, which loads the
  //  last checkpoint in any mode :105893; onRestartFull :235392-235400, added
  //  for a platformer only :236152-236158]
  const run = (platformer: boolean, checkpoints: number, practice = false) => {
    const calls: string[] = [];
    const game = {
      run: { id: 1, name: "Level", practice, level: { header: { platformer } } },
      checkpoints: Array.from({ length: checkpoints }, () => ({})),
      stack: { pop: () => calls.push("pop"), push: () => calls.push("push") },
      save: { get: () => ({ settings: { musicVolume: 1, sfxVolume: 1 } }) },
      runProgress: () => ({ best: 0, practiceBest: 0 }),
      respawn: () => calls.push("respawn"),
      restart: () => calls.push("restart"),
    } as unknown as ConstructorParameters<typeof PauseScreen>[0];
    return { game, calls };
  };
  const ids = (game: ConstructorParameters<typeof PauseScreen>[0]) =>
    new PauseScreen(game).build(viewportFor(1920, 1080)).flatMap((w) => (w.kind === "button" ? [w.id] : []));

  const passed = run(true, 1);
  new PauseScreen(passed.game).onPress("retry");
  new PlayScreen(passed.game).onKey("KeyR", true);
  new PauseScreen(passed.game).onPress("retryFull");
  assert.deepEqual(passed.calls, ["pop", "respawn", "respawn", "pop", "restart"]);
  assert.ok(ids(passed.game).includes("retryFull"));

  const fresh = run(true, 0);
  new PauseScreen(fresh.game).onPress("retry");
  assert.deepEqual(fresh.calls, ["pop", "restart"], "nothing passed yet: from the start");

  const classic = run(false, 0);
  new PauseScreen(classic.game).onPress("retry");
  assert.deepEqual(classic.calls, ["pop", "restart"]);
  assert.ok(!ids(classic.game).includes("retryFull"), "a classic level has one restart");

  const practice = run(false, 1, true);
  new PauseScreen(practice.game).onPress("retry");
  new PlayScreen(practice.game).onKey("KeyR", true);
  assert.deepEqual(practice.calls, ["pop", "respawn", "respawn"], "practice restarts from its last checkpoint");
  assert.ok(!ids(practice.game).includes("retryFull"));
});

test("what a death and a finish record", () => {
  // A death keeps the whole percentage it came at, short of 100; a finish
  // keeps 100 and the coins; a run from a start position keeps neither, and
  // a platformer's deaths keep nothing. Both commit the jumps.
  // [gdp PlayLayer::destroyPlayer :93168, :93198-93216, :93277-93281;
  //  levelComplete :92666-92696, :92772-92858]
  const recorded = (startPosition: number, state: { dead: boolean; finished: boolean }, p: number, platformer = false, practice = false, saves = true) => {
    const calls: Array<[number, number, boolean, number[]]> = [];
    let commits = 0;
    const run = { id: 3, name: "Level", practice, attempt: 1, jumps: 0, lastPercent: 0, attemptStartedAt: 0, level: { header: { platformer } } };
    const game = {
      sim: { startPosition, state, progress: () => p, coinsTaken: () => [2] },
      run,
      stack: { push: () => undefined, pop: () => undefined },
      audio: { finishLevel: () => undefined, playerDied: () => undefined },
      mods: noMods(),
      runSaves: () => saves,
      practiceMusic: () => practice,
      commitJumps: () => void commits++,
      recordRun: (r: typeof run, percent: number, coins: readonly number[] = []) => (calls.push([r.id, percent, r.practice, [...coins]]), false),
      runProgress: () => ({ best: 100 }),
      awardOrbs: () => 0,
      save: {
        get: () => ({ settings: { autoRetry: false } }),
      },
    } as unknown as ConstructorParameters<typeof PlayScreen>[0];
    new PlayScreen(game).update(1 / 60);
    return { calls, commits, lastPercent: run.lastPercent };
  };
  const finished = { dead: false, finished: true };
  const dead = { dead: true, finished: false };
  const p = 0.4275;
  assert.deepEqual(recorded(-1, finished, p), { calls: [[3, 100, false, [2]]], commits: 1, lastPercent: 0 });
  assert.deepEqual(recorded(-1, dead, p), { calls: [[3, 42, false, []]], commits: 1, lastPercent: 42 });
  assert.deepEqual(recorded(100, finished, p).calls, [[3, 0, false, []]], "finished, but no completion");
  assert.deepEqual(recorded(100, dead, p).calls, [[3, 0, false, []]], "died, and no best");
  assert.deepEqual(recorded(-1, dead, p, true).calls, [[3, 0, false, []]], "a platformer's death keeps nothing");
  assert.deepEqual(recorded(-1, finished, p, true).calls, [[3, 100, false, [2]]]);
  assert.deepEqual(recorded(-1, dead, p, false, true), { calls: [[3, 42, true, []]], commits: 1, lastPercent: 0 }, "practice leaves the death screen's number alone");
  assert.deepEqual(recorded(-1, dead, 0.99995), { calls: [[3, 99, false, []]], commits: 1, lastPercent: 99 });
  assert.deepEqual(recorded(-1, dead, 1), { calls: [[3, 99, false, []]], commits: 1, lastPercent: 100 }, "kept short of 100");
  // An attempt a cheat or safe mode was on in records nothing at all.
  assert.deepEqual(recorded(-1, finished, p, false, false, false).calls, [], "a cheated finish is not kept");
  assert.deepEqual(recorded(-1, dead, p, false, false, false).calls, [], "nor a cheated death");
});

test("a replay from the end screen records its own finish", () => {
  // The replay is a fresh attempt on the same play screen, so its finish is a
  // completion like the first. [gdp EndLevelLayer::onReplay :367255-367287 →
  //  PlayLayer::fullReset :107506-107537; levelComplete :92772-92848]
  const recorded: number[] = [];
  const pushed: Screen[] = [];
  const unfinished = () => ({ startPosition: -1, state: { dead: false, finished: false }, progress: () => 1, coinsTaken: () => [] });
  let sim = unfinished();
  const game = {
    get sim() {
      return sim;
    },
    run: { id: 3, name: "Level", practice: false, attempt: 1, jumps: 0, lastPercent: 0, attemptStartedAt: 0, level: { header: { platformer: false } } },
    stack: { push: (s: Screen) => void pushed.push(s), pop: () => pushed.pop() },
    audio: { finishLevel: () => undefined },
    mods: noMods(),
    runSaves: () => true,
    practiceMusic: () => false,
    commitJumps: () => undefined,
    fullReset: () => void (sim = unfinished()),
    recordRun: (_run: unknown, percent: number) => (recorded.push(percent), false),
    runProgress: () => ({ best: 100 }),
    awardOrbs: () => 0,
  } as unknown as ConstructorParameters<typeof PlayScreen>[0];
  const play = new PlayScreen(game);
  play.update(1 / 60);
  sim.state.finished = true;
  play.update(1 / 60);
  play.update(1 / 60);
  assert.deepEqual(recorded, [100], "a finish is recorded once");

  const end = pushed.at(-1);
  assert.ok(end instanceof CompleteScreen);
  end.onPress("again");
  play.update(1 / 60);
  sim.state.finished = true;
  play.update(1 / 60);
  assert.deepEqual(recorded, [100, 100], "and the replay's finish too");
});

test("the HUD: the bar and the percentage, and none of it in a platformer", () => {
  // [gdp PlayLayer::toggleProgressbar :91596-91670; setupHasCompleted
  //  :106462-106463]
  const view = viewportFor(1920, 1080);
  const hud = (settings: { showPercentage: boolean; showProgressBar: boolean }, platformer = false, startPosition = -1) => {
    const game = {
      sim: { progress: () => 0.5, startPosition },
      run: { attempt: 3, attemptLabel: { x: 0, y: 0 }, practice: false, level: { header: { platformer } } },
      save: { get: () => ({ settings }) },
      scene: {
        camera: new Camera(),
        drawnAlpha: 1,
        viewPoint: (_x: number, _y: number, out: [number, number]) => out.fill(0.5),
      },
      ui: { art: { quad: () => null, measure: () => ({ width: 40, height: 16 }) } },
      mods: noMods(),
      checkpoints: [],
    } as unknown as ConstructorParameters<typeof PlayScreen>[0];
    const widgets = new PlayScreen(game).build(view);
    const text = (t: string) => widgets.find((w) => w.kind === "text" && w.text === t);
    return { bars: widgets.filter((w) => w.kind === "progress"), pct: text("50%"), attempt: text("Attempt 3") };
  };
  const off = hud({ showPercentage: false, showProgressBar: false });
  assert.equal(off.bars.length, 0, "a fresh save shows no bar");
  assert.equal(off.pct, undefined, "and no percentage");

  const both = hud({ showPercentage: true, showProgressBar: true });
  assert.equal(both.bars.length, 1);
  assert.equal(both.bars[0].kind === "progress" && both.bars[0].x, view.width / 2);
  assert.equal(both.pct?.kind === "text" && both.pct.x, view.width / 2 + 110, "beside the bar");

  const alone = hud({ showPercentage: true, showProgressBar: false });
  assert.equal(alone.bars.length, 0);
  assert.equal(alone.pct?.kind === "text" && alone.pct.x, view.width / 2 - 20, "centred without it");

  const platformer = hud({ showPercentage: true, showProgressBar: true }, true);
  assert.equal(platformer.bars.length, 0);
  assert.equal(platformer.pct, undefined);

  assert.equal(both.attempt?.kind === "text" && both.attempt.alpha, undefined, "this visit's attempt");
  const fromStart = hud({ showPercentage: false, showProgressBar: false }, false, 5);
  assert.equal(fromStart.attempt?.kind === "text" && fromStart.attempt.alpha, 50 / 255, "faint from a start position");
});

test("the attempt label, and the end screen's replay starting the visit over", () => {
  // A classic level's first attempt stands it 85 above the camera's centre;
  // every later attempt, and any attempt of a platformer, 50 to the right of
  // that. The replay zeroes the visit's attempts and jumps, ends practice,
  // and puts the label back over the centre, a platformer's too.
  // [gdp PlayLayer::setupHasCompleted :106455-106461; updateAttempts
  //  :92478-92486; EndLevelLayer::onReplay :367255-367287 → fullReset
  //  :107506-107537]
  const visit = (platformer: boolean) => {
    const camera = new Camera();
    const run = {
      id: 1,
      name: "Level",
      level: emptyLevel([], makeHeader({ platformer })),
      practice: false,
      lastPercent: 0,
      attemptStartedAt: 0,
      jumps: 0,
      attemptLabel: { x: 0, y: 0 },
      attempt: 0,
    };
    const restarts: Array<{ attempt: number; jumps: number; practice: boolean }> = [];
    // The class needs a canvas, so this is its prototype with only what
    // restart and fullReset touch; restart itself is the real one, watched.
    const game = Object.assign(Object.create(Game.prototype) as object, {
      run,
      save: { get: () => defaultSave() },
      objects: { table: loadObjectTable() },
      strings: { playerColour: () => ({ r: 255, g: 255, b: 255 }) },
      scene: { player: {}, camera, refreshPlayerPages: () => undefined, useSim: () => undefined, resetInterpolation: () => undefined, playSpawnEffect: () => undefined },
      audio: { startAttempt: () => undefined },
      mods: noMods(),
      checkpoints: [],
      restart(this: Game) {
        restarts.push({ attempt: run.attempt, jumps: run.jumps, practice: run.practice });
        Game.prototype.restart.call(this);
      },
    }) as unknown as Game;
    const offset = () => {
      const c = camera.centre();
      return { x: Math.round(run.attemptLabel.x - c.x), y: Math.round(run.attemptLabel.y - c.y) };
    };
    return { game, run, restarts, offset };
  };

  const classic = visit(false);
  classic.game.restart();
  assert.equal(classic.run.attempt, 1);
  assert.deepEqual(classic.offset(), { x: 0, y: 85 }, "the first attempt's is over the centre");
  classic.game.restart();
  assert.equal(classic.run.attempt, 2);
  assert.deepEqual(classic.offset(), { x: 50, y: 85 }, "every later one's 50 to the right");

  classic.run.attempt = 3;
  classic.run.jumps = 5;
  classic.run.practice = true;
  classic.game.fullReset();
  assert.deepEqual(classic.restarts.at(-1), { attempt: 0, jumps: 0, practice: false }, "the replay starts the visit over");
  assert.equal(classic.run.attempt, 1);
  assert.deepEqual(classic.offset(), { x: 0, y: 85 });

  const tower = visit(true);
  tower.game.restart();
  assert.equal(tower.run.attempt, 1);
  assert.deepEqual(tower.offset(), { x: 50, y: 85 }, "a platformer's first attempt is to the right too");
  tower.game.fullReset();
  assert.equal(tower.run.attempt, 1);
  assert.deepEqual(tower.offset(), { x: 0, y: 85 }, "but its replay's is over the centre");
});

test("Camera Mode's easing and padding shape the free follow of a ball, not a cube's", () => {
  // No corridor (free mode). A ball 200 above the view's centre: the padding
  // 0.5 lets it stray 160 − (0.5 × 128 + 30) = 66 units, and the easing 10
  // closes 0.25/10 of the gap a tick. The cube keeps its 70-unit dead zone.
  // An easing of 1 snaps. [gdp GJBaseGameLayer::updateCamera :449705-449710,
  //  :450219-450236, :450572-450590; resetCamera :451335-451336]
  const at = (mode: "ball" | "cube", divisor: number, padding: number) => {
    const camera = new Camera();
    const player = { x: 0, y: 100, mode, flipped: false } as unknown as Parameters<Camera["follow"]>[0];
    camera.reset(player);
    camera.y = 100;
    camera.followDivisor = divisor;
    camera.padding = padding;
    camera.follow({ ...player, y: 300 });
    return camera.y;
  };
  assert.ok(Math.abs(at("ball", 10, 0.5) - (100 + (234 - 100) * 0.025)) < 1e-9, "eased toward 300 − 66");
  assert.equal(at("ball", 1, 0.5), 234, "an easing of 1 snaps");
  assert.equal(at("ball", 1, 1), 298, "full padding leaves 2 units");
  assert.equal(at("ball", 1, 0), 170, "none leaves 130");
  assert.ok(Math.abs(at("cube", 1, 1) - (100 + (230 - 100) * 0.025)) < 1e-9, "the cube ignores both");
});

/** The mod menu with nothing switched on and nowhere to keep it. */
function noMods(): Mods {
  return new Mods({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
}

/** A Game with only what restart, respawn and tick touch, around a real restart. */
function stubGame(level: ReturnType<typeof emptyLevel>) {
  const camera = new Camera();
  const run = {
    id: 1,
    name: "Level",
    level,
    practice: false,
    lastPercent: 0,
    attemptStartedAt: 0,
    jumps: 0,
    attemptLabel: { x: 0, y: 0 },
    attempt: 0,
  };
  const audio = { starts: 0, startAttempt: () => void audio.starts++ };
  const game = Object.assign(Object.create(Game.prototype) as object, {
    run,
    save: { get: () => defaultSave() },
    objects: { table: loadObjectTable() },
    strings: { playerColour: () => ({ r: 255, g: 255, b: 255 }) },
    scene: {
      player: {},
      camera,
      refreshPlayerPages: () => undefined,
      useSim: () => undefined,
      resetInterpolation: () => undefined,
      playSpawnEffect: () => undefined,
      tick: () => undefined,
    },
    audio,
    mods: noMods(),
    checkpoints: [],
    stack: { ticks: true },
    input: { input: () => NO_INPUT },
    loading: false,
  }) as unknown as Game;
  const tick = () => (game as unknown as { tick(): void }).tick();
  return { game, run, audio, tick };
}

test("a start position's warm-up is decided once a visit, and later attempts load it back", () => {
  // A Random trigger before the start position picks item 1 or item 2. The
  // first attempt warms up with its seed; the next loads what that left,
  // whatever its own seed would have drawn, and runs on with its own.
  // [gdp PlayLayer::startMusic :105416-105421; resetLevel :105790-105797,
  //  :105898-105905, :105942-105944]
  const level = emptyLevel([
    { id: 1912, x: 300, y: 300, props: { 51: "5", 71: "6", 10: "50" } },
    { id: 1817, x: 330, y: 600, props: { 62: "1", 80: "1", 77: "1" } },
    { id: 1817, x: 360, y: 600, props: { 62: "1", 80: "2", 77: "1" } },
    { id: 31, x: 900, y: 45, settings: {} },
  ]);
  const n = level.objects.length;
  level.objects[n - 3].groups = [5];
  level.objects[n - 2].groups = [6];
  const picked = (sim: Sim) => (sim.triggers.itemCount(1) === 1 ? 1 : 2);
  // A seed for each outcome, found by warming up afresh.
  const bySeed = new Map<number, number>();
  for (let k = 1; bySeed.size < 2 && k < 200; k++) {
    const seed = (k * 0x0badf00d) & 0x7fffffff;
    const outcome = picked(createSim(level, loadObjectTable(), { seed }));
    if (!bySeed.has(outcome)) bySeed.set(outcome, seed);
  }
  assert.equal(bySeed.size, 2, "both outcomes are reachable");
  const { game, run } = stubGame(level);
  const random = Math.random;
  try {
    const first = bySeed.get(1) as number;
    const other = bySeed.get(2) as number;
    Math.random = () => (first + 0.5) / 0x7fffffff;
    game.restart();
    const sim = game.sim as Sim;
    assert.equal(picked(sim), 1);
    stepN(sim, NO_INPUT, 50);
    Math.random = () => (other + 0.5) / 0x7fffffff;
    game.restart();
    assert.equal(game.sim, sim, "the same sim, loaded back");
    assert.equal(run.attempt, 2);
    assert.equal(sim.triggers.attempt, 2);
    assert.equal(picked(sim), 1, "the first warm-up's pick, not the new seed's");
    assert.equal(sim.state.x, 900, "at the start position");
    const fresh = createSim(level, loadObjectTable(), { seed: other });
    assert.equal(picked(fresh), 2, "a fresh warm-up with that seed picks the other");
  } finally {
    Math.random = random;
  }
});

test("a platformer's restart holds still 0.2 s before it runs and its music starts", () => {
  // The first attempt of a visit and a classic level's restarts start at
  // once; a platformer's restart, and its replay, wait 48 ticks. A
  // checkpoint starts at once. [gdp PlayLayer::resetLevel :105994-105996,
  //  :106036-106050 (CCDelayTime 0.2 → startGameDelayed :105470-105474)]
  const platformer = stubGame(emptyLevel([], makeHeader({ platformer: true })));
  platformer.game.restart();
  assert.equal(platformer.audio.starts, 1, "the first attempt starts at once");
  const sim = platformer.game.sim as Sim;
  platformer.tick();
  assert.equal(sim.tick, 1, "and steps");
  platformer.game.restart();
  const held = platformer.game.sim as Sim;
  assert.equal(platformer.audio.starts, 1, "the restart's music waits");
  for (let i = 0; i < 47; i++) platformer.tick();
  assert.equal(held.tick, 0, "nothing steps while it holds");
  assert.equal(platformer.audio.starts, 1);
  platformer.tick();
  assert.equal(platformer.audio.starts, 2, "the music starts on the 48th tick");
  assert.equal(held.tick, 0);
  platformer.tick();
  assert.equal(held.tick, 1, "and the level runs from the next");
  platformer.game.fullReset();
  assert.equal(platformer.audio.starts, 2, "the replay waits too");

  const classic = stubGame(emptyLevel([]));
  classic.game.restart();
  classic.game.restart();
  assert.equal(classic.audio.starts, 2, "a classic restart starts at once");
  classic.tick();
  assert.equal((classic.game.sim as Sim).tick, 1);
});
