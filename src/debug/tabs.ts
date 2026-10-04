// What the asset viewer's tabs have in common: they share one canvas, one
// viewport and one heads-up display, and each owns a strip of controls in the
// top bar.

import type { Viewport } from "./viewport";

export interface TabView {
  /** Matches the id suffix of #tab-<id> and #ctl-<id> in the page. */
  readonly id: string;
  /** Loads whatever the tab needs and frames the view. Called on first show. */
  activate(): Promise<void> | void;
  draw(ctx: CanvasRenderingContext2D, viewport: Viewport): void;
  /** Text for the overlay, already newline separated. */
  hud(): string;
  /** A click in the canvas, in world coordinates. */
  click?(world: { x: number; y: number }): void;
}
