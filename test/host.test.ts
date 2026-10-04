// What the host config shows a player: the label under Play, the Server page
// in Settings, and the port's credit on the Support page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOST_CONFIG, parseHostConfig, setHostConfig } from "../src/online/hostConfig";
import { MainMenuScreen } from "../src/ui/screens/menu";
import { HostInfoScreen, SettingsScreen, SupportScreen } from "../src/ui/screens/settings";
import { defaultSave, type SaveV1 } from "../src/save/schema";
import { viewportFor } from "../src/ui/viewport";
import type { Widget } from "../src/ui/widgets";
import type { Game } from "../src/game/game";
import type { Screen } from "../src/ui/screen";

function texts(widgets: Widget[]): string[] {
  return widgets.flatMap((w) => {
    if (w.kind === "text") return [w.text];
    if (w.kind === "button" && w.label?.text) return [w.label.text];
    return [];
  });
}

function fakeGame(): { game: Game; pushed: Screen[] } {
  const save: SaveV1 = defaultSave();
  const pushed: Screen[] = [];
  const game = {
    save: { get: () => save, set: (fn: (s: SaveV1) => void) => fn(save), flush: () => undefined },
    input: { clear: () => undefined },
    stack: { pop: () => undefined, push: (s: Screen) => void pushed.push(s) },
    say: () => undefined,
    audio: { ui: () => undefined },
    scene: {},
    view: viewportFor(752, 418),
  } as unknown as Game;
  return { game, pushed };
}

const VIEW = viewportFor(752, 418);

test("the home screen names the host under Play only when one is set", () => {
  const { game } = fakeGame();
  const menu = new MainMenuScreen(game);
  setHostConfig(DEFAULT_HOST_CONFIG);
  assert.ok(!texts(menu.build(VIEW)).some((t) => t.startsWith("Hosted by")));
  setHostConfig(parseHostConfig({ hostedBy: "Proton" }));
  assert.ok(texts(menu.build(VIEW)).includes("Hosted by Proton"));
  setHostConfig(DEFAULT_HOST_CONFIG);
});

test("Settings opens a read-only Server page that shows the host's setup", () => {
  const { game, pushed } = fakeGame();
  const settings = new SettingsScreen(game);
  assert.ok(texts(settings.build(VIEW)).includes("Server"));
  settings.onPress("server");
  assert.ok(pushed[0] instanceof HostInfoScreen);

  const page = () => texts(new HostInfoScreen(game).build(VIEW));
  setHostConfig(parseHostConfig({ server: { mode: "autodetect" }, hostedBy: "Proton" }));
  assert.ok(page().includes("Through this site"));
  assert.ok(page().includes("Proton"));
  setHostConfig(parseHostConfig({ server: { mode: "direct" } }));
  assert.ok(page().includes("Straight to RobTop's servers"));
  assert.ok(page().includes("Not set"));
  setHostConfig(parseHostConfig({ server: { mode: "hostApi", hostApi: "https://relay.example/api/robtop-server" } }));
  assert.ok(page().includes("Through relay.example"));

  // Nothing on it changes the setup: OK is its only button.
  const buttons = new HostInfoScreen(game).build(VIEW).filter((w) => w.kind === "button");
  assert.deepEqual(
    buttons.map((b) => (b.kind === "button" ? b.id : "")),
    ["ok"],
  );
  setHostConfig(DEFAULT_HOST_CONFIG);
});

test("the Support page credits the port right under RobTop", () => {
  const { game } = fakeGame();
  const widgets = new SupportScreen(game).build(VIEW);
  const ported = widgets.find((w) => w.kind === "text" && w.text === "Ported By:");
  const proton = widgets.find((w) => w.kind === "text" && w.text === "Proton");
  const developed = widgets.find((w) => w.kind === "sprite" && w.frame === "developedBy_001.png");
  const powered = widgets.find((w) => w.kind === "sprite" && w.frame === "poweredBy_001.png");
  assert.ok(ported && proton && developed && powered);
  const y = (w: Widget) => ("y" in w ? (w.y as number) : 0);
  assert.ok(y(ported) < y(developed) && y(ported) > y(powered), "between Developed by and Powered by");
});
