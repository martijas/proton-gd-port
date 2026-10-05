// The options pages and the graphics popup, laid out as the game lays them
// out. Positions come from the decompile; the labels are the game's own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GameOptionsScreen, OptionsScreen, VideoOptionsScreen } from "../src/ui/screens/settings";
import { defaultSave, type SaveV1 } from "../src/save/schema";
import { viewportFor } from "../src/ui/viewport";
import type { Widget } from "../src/ui/widgets";
import type { Game } from "../src/game/game";

function texts(widgets: Widget[]): string[] {
  return widgets.flatMap((w) => {
    if (w.kind === "text") return [w.text];
    if (w.kind === "button" && w.label?.text) return [w.label.text];
    return [];
  });
}

function fakeGame(): { game: Game; said: string[]; save: SaveV1 } {
  const save = defaultSave();
  const said: string[] = [];
  const game = {
    save: {
      get: () => save,
      set: (fn: (s: SaveV1) => void) => fn(save),
      flush: () => undefined,
    },
    input: { clear: () => undefined },
    stack: { pop: () => undefined, push: () => undefined },
    say: (m: string) => void said.push(m),
    audio: { setVolumes: () => undefined, setMenuMusic: () => undefined, ui: () => undefined },
    scene: {},
  } as unknown as Game;
  return { game, said, save };
}

test("options pages run in the game's order, and only a live box changes anything", () => {
  const { game, said, save } = fakeGame();
  const screen = new OptionsScreen(game);
  const view = viewportFor(752, 418);
  const page = () => texts(screen.build(view));

  assert.ok(page().includes("Gameplay"));
  assert.ok(page().includes("Auto-Retry"));
  assert.ok(page().includes("Enable Faster Reset"));
  screen.onPress("toggle:0026");
  assert.equal(save.settings.autoRetry, false, "auto-retry is the one box this version uses");
  assert.deepEqual(said, []);

  screen.onPress("toggle:0052");
  assert.deepEqual(said, ["That isn't in this version yet."]);

  const titles = ["Gameplay", "Visual", "Visual", "Practice", "Performance", "Audio", "Other"];
  for (const title of titles) {
    assert.ok(page().includes(title), title);
    screen.onPress("next");
  }
  assert.ok(page().includes("Gameplay"), "the last page wraps back");
  assert.ok(page().includes("Music Offset (MS)") === false);

  // Audio is five steps back from Gameplay, so two more nexts from the wrap land on it.
  screen.onPress("next");
  screen.onPress("next");
  screen.onPress("next");
  screen.onPress("next");
  screen.onPress("next");
  assert.ok(page().includes("Audio"));
  assert.ok(page().includes("Music Offset (MS)"));
  assert.ok(page().includes("Debug"));
});

test("graphics shows the window size and the quality, and says what it cannot change", () => {
  const { game, said } = fakeGame();
  const screen = new VideoOptionsScreen(game);
  const page = texts(screen.build(viewportFor(752, 418)));
  assert.ok(page.includes("Video Options"));
  assert.ok(page.includes("Windowed Resolution"));
  assert.ok(page.includes("Texture Quality"));
  assert.ok(page.includes("High"));
  assert.ok(page.includes("Borderless"));
  assert.ok(page.includes("Fix"));
  assert.ok(page.includes("Advanced"));
  assert.ok(page.some((t) => /^\d+x\d+$/.test(t)), "a window size is shown");

  screen.onPress("advanced");
  assert.deepEqual(said, ["Advanced graphics aren't in this version yet."]);
  screen.onPress("qualityUp");
  const after = texts(screen.build(viewportFor(752, 418)));
  assert.ok(after.includes("Auto"), "the arrows step Auto, Low, Medium, High");
});

test("the pause menu's options: the level's own boxes, with the bar and the percentage live", () => {
  // [gdp PauseLayer::onSettings :235188; GameOptionsLayer::setupOptions :499637-499903]
  const { game, said, save } = fakeGame();
  const screen = new GameOptionsScreen(game);
  const view = viewportFor(752, 418);
  const shown = texts(screen.build(view));
  for (const text of ["Auto-Retry", "Auto-Checkpoints", "Show Progress Bar", "Show Percentage", "Show Time", "Audio Visualizer", "Show Info Label", "Disable Checkpoints", "Show Hitboxes", "Practice Music Sync", "Platformer UI", "Practice UI"]) {
    assert.ok(shown.includes(text), text);
  }
  assert.ok(!shown.includes("Enable Faster Reset"), "not the main Options pages");

  assert.equal(save.settings.showProgressBar, false);
  screen.onPress("toggle:bar");
  assert.equal(save.settings.showProgressBar, true);
  screen.onPress("toggle:0040");
  assert.equal(save.settings.showPercentage, true);
  screen.onPress("toggle:bar");
  assert.equal(save.settings.showProgressBar, false);
  assert.deepEqual(said, []);

  screen.onPress("toggle:0145");
  assert.deepEqual(said, ["That isn't in this version yet."]);

  // Two columns 40 apart from 90 above the centre: Show Progress Bar is slot 2.
  const box = screen.build(view).find((w) => w.kind === "button" && w.id === "toggle:bar");
  assert.ok(box && box.kind === "button");
  assert.equal(box.rect.x + box.rect.w / 2, view.width / 2 - 160);
  assert.equal(box.rect.y + box.rect.h / 2, view.height / 2 + 50);
});
