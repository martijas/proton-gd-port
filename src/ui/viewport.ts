// How big the screen is, in the units everything else is measured in.
//
// The design view is 480x320 and the window decides which of the two the game
// keeps: anything at least 3:2 wide keeps the 320 of height and gets wider, and
// anything narrower — a phone held upright — keeps the 480 of width and gets
// taller instead. Getting it the wrong way round makes a portrait window four
// times too close.
//
// This lives here rather than in the camera because the interface has to agree
// with the level about where the edge of the screen is, and two copies of a
// rule like that drift. `render/camera.ts` reads `designSize` too.
// [gdp AppDelegate::setupGLView and CCDirector::updateScreenScale,
//  gd-ida-decomp.cpp:77019-77041 and :801122-801146]

export const VIEW_UNITS_HIGH = 320;
export const VIEW_UNITS_WIDE = 480;

/** The aspect at which the policy switches from keeping height to keeping width. */
export const PIVOT_ASPECT = VIEW_UNITS_WIDE / VIEW_UNITS_HIGH;

export interface DesignSize {
  width: number;
  height: number;
}

export function designSize(aspect: number): DesignSize {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const height = safe >= PIVOT_ASPECT ? VIEW_UNITS_HIGH : VIEW_UNITS_WIDE / safe;
  return { width: height * safe, height };
}

/**
 * The interface's own view: the design box, plus where its edges are. The
 * origin is the bottom-left corner with y up, the same handedness as the world,
 * so one vertex shader draws both.
 */
export interface UiViewport extends DesignSize {
  aspect: number;
  /** Device pixels across the whole canvas, for a pointer to be converted. */
  pixelWidth: number;
  pixelHeight: number;
}

export function viewportFor(pixelWidth: number, pixelHeight: number): UiViewport {
  const aspect = pixelHeight > 0 ? pixelWidth / pixelHeight : 16 / 9;
  const { width, height } = designSize(aspect);
  return { width, height, aspect, pixelWidth, pixelHeight };
}

/** A rectangle in design units, from its bottom-left corner. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** A rectangle of `w` x `h` centred on a point. */
export function centred(cx: number, cy: number, w: number, h: number): Rect {
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Where a pointer event landed, in design units.
 *
 * `clientX`/`clientY` are CSS pixels relative to the viewport, so the canvas's
 * own box is what turns them into a fraction; the device pixel ratio never
 * enters into it.
 */
export function pointerToUi(canvas: HTMLElement, view: UiViewport, clientX: number, clientY: number): { x: number; y: number } {
  const box = canvas.getBoundingClientRect();
  const fx = box.width > 0 ? (clientX - box.left) / box.width : 0;
  // Screen y runs down and the design box runs up.
  const fy = box.height > 0 ? 1 - (clientY - box.top) / box.height : 0;
  return { x: fx * view.width, y: fy * view.height };
}

/**
 * The nine places a thing can sit in a box. Written as fractions so a caller
 * can interpolate between them; `anchor("center")` is `{x: 0.5, y: 0.5}`.
 */
export type Anchor =
  | "bottomLeft" | "bottom" | "bottomRight"
  | "left" | "center" | "right"
  | "topLeft" | "top" | "topRight";

const ANCHORS: Record<Anchor, { x: number; y: number }> = {
  bottomLeft: { x: 0, y: 0 },
  bottom: { x: 0.5, y: 0 },
  bottomRight: { x: 1, y: 0 },
  left: { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  right: { x: 1, y: 0.5 },
  topLeft: { x: 0, y: 1 },
  top: { x: 0.5, y: 1 },
  topRight: { x: 1, y: 1 },
};

export function anchor(which: Anchor): { x: number; y: number } {
  return ANCHORS[which];
}

/** A point on the screen's edge, inset by `pad`. */
export function at(view: UiViewport, which: Anchor, pad = 0): { x: number; y: number } {
  const a = ANCHORS[which];
  return {
    x: pad + a.x * (view.width - pad * 2),
    y: pad + a.y * (view.height - pad * 2),
  };
}
