// Pointer and key routing between the interface and the game.
//
// The rule, in order:
//   1. If the press landed on a widget of the top screen, the interface has it.
//   2. Otherwise it falls through to gameplay — which is what makes tapping
//      anywhere on the play screen a jump, while tapping the pause button is
//      not.
//
// A button fires on *release inside its own rectangle*, the way the game does,
// so a press that slides off is cancelled rather than committed.

import type { InputState } from "../engine/loop";
import type { ScreenStack } from "./screen";
import { pointerToUi, type UiViewport } from "./viewport";
import { hitTest, listAt, sliderValueAt, type Widget } from "./widgets";

/**
 * How far a pointer has to move before a press on a row becomes a scroll of the
 * list it sits in. Small enough that a deliberate drag is caught at once, large
 * enough that a tap with a shaky hand still counts as a tap. [meas]
 */
const DRAG_SLOP = 4;

/** Design units scrolled per unit of wheel delta. [meas] */
const WHEEL_SCALE = 0.5;

/** Keys the interface always takes, whatever is on screen. */
const UI_KEYS = new Set(["Escape", "KeyP"]);

export class UiInput {
  private held: { id: string; widget: Widget; x: number; y: number; startX: number; startY: number; dragging: boolean } | null = null;
  private detach: (() => void) | null = null;
  private view: UiViewport | null = null;

  constructor(
    private readonly stack: ScreenStack,
    private readonly game: InputState,
  ) {}

  /** The button the pointer is holding down right now, for its face to swell. */
  get heldId(): string | null {
    const h = this.held;
    if (!h || h.dragging) return null;
    return h.widget.kind === "button" ? h.id : null;
  }

  /** Called each frame so a pointer can be converted with the current size. */
  setViewport(view: UiViewport): void {
    this.view = view;
  }

  attach(target: HTMLElement): void {
    this.detach?.();
    const down = (e: PointerEvent): void => {
      if (!this.view) return;
      const p = pointerToUi(target, this.view, e.clientX, e.clientY);
      const hit = hitTest(this.stack.interactive(this.view), p.x, p.y);
      if (!hit) {
        if (this.stack.touch(p.x, p.y)) {
          e.stopPropagation();
          e.preventDefault();
        }
        return;
      }
      this.held = { id: hit.id, widget: hit, x: p.x, y: p.y, startX: p.x, startY: p.y, dragging: false };
      // A slider jumps to where it was grabbed, which is what the game does.
      if (hit.kind === "slider") this.stack.drag(hit.id, 0, 0, p.x, p.y);
      // The gameplay input must not also see this press.
      e.stopPropagation();
      e.preventDefault();
    };

    const move = (e: PointerEvent): void => {
      const holding = this.held;
      if (!holding || !this.view) return;
      const p = pointerToUi(target, this.view, e.clientX, e.clientY);
      const dx = p.x - holding.x;
      const dy = p.y - holding.y;
      holding.x = p.x;
      holding.y = p.y;

      // A press that has travelled far enough stops being a tap. If it began on
      // something inside a list — a level row, say — the list takes the drag
      // from here, which is the only way a row is both pressable and scrollable.
      if (!holding.dragging) {
        const travelled = Math.hypot(p.x - holding.startX, p.y - holding.startY);
        if (travelled < DRAG_SLOP) return;
        holding.dragging = true;
        if (holding.widget.kind !== "list" && holding.widget.kind !== "slider") {
          const list = listAt(this.stack.interactive(this.view), holding.startX, holding.startY);
          if (list) {
            holding.id = list.id;
            holding.widget = list;
          }
        }
      }
      this.stack.drag(holding.id, dx, dy, p.x, p.y);
    };

    const up = (e: PointerEvent): void => {
      const holding = this.held;
      this.held = null;
      if (!holding || !this.view) return;
      this.stack.release(holding.id);
      const p = pointerToUi(target, this.view, e.clientX, e.clientY);
      // Only a release still on the widget counts as a press, and only when the
      // pointer never travelled far enough to become a scroll.
      if (holding.dragging) return;
      const stillOn = hitTest(this.stack.interactive(this.view), p.x, p.y);
      if (stillOn?.id === holding.id && holding.widget.kind !== "slider" && holding.widget.kind !== "list") {
        this.stack.press(holding.id, p.x, p.y);
      }
    };

    const cancel = (): void => {
      if (this.held) this.stack.release(this.held.id);
      this.held = null;
    };

    // A wheel over a list scrolls it. On a desktop this is the gesture people
    // reach for first, and without it the list looks stuck even though dragging
    // works.
    const wheel = (e: WheelEvent): void => {
      if (!this.view) return;
      const p = pointerToUi(target, this.view, e.clientX, e.clientY);
      const list = listAt(this.stack.interactive(this.view), p.x, p.y);
      if (!list) return;
      e.preventDefault();
      this.stack.drag(list.id, 0, e.deltaY * WHEEL_SCALE, p.x, p.y);
    };

    // Capture, so a press the interface wants never reaches the gameplay
    // listener bound to the same element.
    target.addEventListener("wheel", wheel as EventListener, { passive: false });
    target.addEventListener("pointerdown", down as EventListener, { capture: true });
    window.addEventListener("pointermove", move as EventListener);
    window.addEventListener("pointerup", up as EventListener);
    window.addEventListener("pointercancel", cancel);
    this.detach = () => {
      target.removeEventListener("wheel", wheel as EventListener);
      target.removeEventListener("pointerdown", down as EventListener, { capture: true });
      window.removeEventListener("pointermove", move as EventListener);
      window.removeEventListener("pointerup", up as EventListener);
      window.removeEventListener("pointercancel", cancel);
    };
  }

  /**
   * Offers a key to the interface. Returns true when it took it, so the caller
   * can stop the game seeing it.
   */
  key(code: string, down: boolean): boolean {
    if (this.stack.key(code, down)) return true;
    if (!UI_KEYS.has(code)) return false;
    // Escape and P belong to the interface even when no screen claimed them,
    // so a level can always be paused.
    if (down) this.game.clear();
    return true;
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
  }
}

/** The value a slider should take from a drag at `x`. */
export function sliderAt(widget: Widget, x: number): number | null {
  return widget.kind === "slider" ? sliderValueAt(widget, x) : null;
}
