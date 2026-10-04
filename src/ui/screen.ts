// A stack of screens, and what one is.
//
// A screen describes itself as a flat widget list every frame and keeps its own
// state in its own fields, so nothing here is retained and the interface never
// has to be told something changed.
//
// `ticksBelow` is the whole pause mechanism. The game loop asks the stack
// whether the simulation should run; a pause menu says no, and the loop never
// has to learn what a menu is.

import type { Widget } from "./widgets";
import type { UiViewport } from "./viewport";

export interface Screen {
  readonly name: string;
  /** Nothing below this is drawn. A menu is opaque; a pause overlay is not. */
  readonly opaque?: boolean;
  /** The screen right below this one is not drawn while it is up, as the game hides the layer that opened a drop-down. */
  readonly hidesOpener?: boolean;
  /** Whether the simulation keeps running under this screen. Default true. */
  readonly ticksBelow?: boolean;
  /**
   * Whether the level's own clock stops under this screen as well — its
   * colours, pulses, screen effects and particles — as it does under the
   * game's pause menu. A screen that only stops the simulation (the end and
   * retry screens, over a run that is already over) leaves it running, as
   * the game leaves its level running behind them. Default false.
   * [PlayLayer::pauseGame :93439-93477, which ends in the layer's onExit;
   *  showEndLayer :87287ff and showRetryLayer :87316ff do not]
   */
  readonly freezesLevel?: boolean;
  enter?(): void | Promise<void>;
  exit?(): void;
  /** Wall-clock seconds, never the simulation's — a menu animates while paused. */
  update?(dt: number): void;
  build(view: UiViewport): Widget[];
  /** True if the press was dealt with and should not fall through. */
  onPress?(id: string, x: number, y: number): boolean;
  onDrag?(id: string, dx: number, dy: number, x: number, y: number): boolean;
  onRelease?(id: string): void;
  /**
   * A press that landed on none of the screen's widgets, as it goes down.
   * True if the screen took it, so gameplay does not also see it.
   */
  onTouch?(x: number, y: number): boolean;
  /** True if the key was dealt with. */
  onKey?(code: string, down: boolean): boolean;
}

export class ScreenStack {
  private readonly screens: Screen[] = [];

  get top(): Screen | null {
    return this.screens[this.screens.length - 1] ?? null;
  }

  get depth(): number {
    return this.screens.length;
  }

  has(name: string): boolean {
    return this.screens.some((s) => s.name === name);
  }

  push(screen: Screen): void {
    this.screens.push(screen);
    void screen.enter?.();
  }

  pop(): Screen | null {
    const gone = this.screens.pop() ?? null;
    gone?.exit?.();
    return gone;
  }

  /** Replaces the top screen, which is what a menu transition is. */
  replace(screen: Screen): void {
    this.pop();
    this.push(screen);
  }

  /** Empties the stack down to one screen, for "back to the main menu". */
  clearTo(screen: Screen): void {
    while (this.screens.length > 0) this.pop();
    this.push(screen);
  }

  /**
   * Whether the simulation should advance. False as soon as any screen on the
   * stack says so, not only the top one, so a settings panel opened from a
   * pause menu keeps the level frozen.
   */
  get ticks(): boolean {
    return this.screens.every((s) => s.ticksBelow !== false);
  }

  /**
   * Whether the level's own clock should stand still: any screen on the stack
   * can say so, so a settings panel opened from the pause menu keeps it
   * frozen too.
   */
  get freezesLevel(): boolean {
    return this.screens.some((s) => s.freezesLevel === true);
  }

  /**
   * Advances the screens that can be seen: the topmost opaque one and
   * everything above it. A screen underneath is not drawn, so it has no
   * business moving either — and letting it run on was a real bug. The main
   * menu stays on the stack under a level, and its running cube kept
   * respawning with a random icon and binding that icon's page into the slots
   * the player is drawn from, so the player vanished for seconds at a time.
   * An overlay such as the pause menu is not opaque, so the level under it
   * still runs.
   */
  update(dt: number): void {
    // A screen may push or pop while updating, so walk a copy.
    const from = this.visibleFrom();
    for (const [i, screen] of this.screens.slice(from).entries()) {
      if (!this.hidden(from + i)) screen.update?.(dt);
    }
  }

  private hidden(index: number): boolean {
    return this.screens[index + 1]?.hidesOpener === true;
  }

  /** Index of the topmost opaque screen: nothing below it is seen. */
  private visibleFrom(): number {
    for (let i = this.screens.length - 1; i >= 0; i--) {
      if (this.screens[i].opaque) return i;
    }
    return 0;
  }

  /**
   * Everything to draw, bottom-up, stopping at the topmost opaque screen so a
   * menu does not pay for the screens it is covering.
   */
  build(view: UiViewport): Widget[] {
    const from = this.visibleFrom();
    const out: Widget[] = [];
    for (let i = from; i < this.screens.length; i++) {
      if (!this.hidden(i)) out.push(...this.screens[i].build(view));
    }
    return out;
  }

  /** The widgets that can be pressed: only the top screen's. */
  interactive(view: UiViewport): Widget[] {
    return this.top?.build(view) ?? [];
  }

  press(id: string, x: number, y: number): boolean {
    for (let i = this.screens.length - 1; i >= 0; i--) {
      if (this.screens[i].onPress?.(id, x, y)) return true;
    }
    return false;
  }

  drag(id: string, dx: number, dy: number, x: number, y: number): boolean {
    for (let i = this.screens.length - 1; i >= 0; i--) {
      if (this.screens[i].onDrag?.(id, dx, dy, x, y)) return true;
    }
    return false;
  }

  release(id: string): void {
    this.top?.onRelease?.(id);
  }

  /** A press on nothing, offered to the top screen alone. */
  touch(x: number, y: number): boolean {
    return this.top?.onTouch?.(x, y) ?? false;
  }

  key(code: string, down: boolean): boolean {
    for (let i = this.screens.length - 1; i >= 0; i--) {
      if (this.screens[i].onKey?.(code, down)) return true;
    }
    return false;
  }
}
