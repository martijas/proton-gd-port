// The game's entry point.
//
// Builds the one Game, shows the loading screen while it decodes its art, and
// hands over to the menu. Everything after that is the screen stack's.

import { Game } from "./game/game";
import { LoadingScreen, MainMenuScreen } from "./ui/screens/menu";

const canvas = document.getElementById("gl") as HTMLCanvasElement | null;
const fallback = document.getElementById("fallback") as HTMLElement | null;

function fail(message: string): void {
  if (fallback) {
    fallback.hidden = false;
    const line = fallback.querySelector("[data-role=why]");
    if (line) line.textContent = message;
  }
  if (canvas) canvas.hidden = true;
}

async function main(): Promise<void> {
  if (!canvas) throw new Error("The game could not start.");
  const game = new Game(canvas);
  // Handed over before boot, not after: the loop starts first so the loading
  // screen can animate, and the interesting failures are the ones that happen
  // during boot rather than after it.
  if (import.meta.env.DEV) (window as unknown as { gd: Game }).gd = game;

  const loading = new LoadingScreen(game);
  game.stack.push(loading);
  game.start();

  // Four steps, so the bar means something rather than sitting at nothing and
  // then jumping to full.
  const STEPS = 4;
  let done = 0;
  await game.boot((what) => {
    loading.step(what, done / STEPS);
    done++;
  });
  loading.step("Ready", 1);

  const menu = new MainMenuScreen(game);
  game.onSaveReset = () => game.stack.clearTo(new MainMenuScreen(game));
  game.stack.replace(menu);
}

void main().catch((e: unknown) => {
  console.error(e);
  fail(
    e instanceof Error && e.message.includes("could not be loaded")
      ? "Some of the game's files are missing. Try reloading."
      : "The game could not start. Try reloading.",
  );
});
