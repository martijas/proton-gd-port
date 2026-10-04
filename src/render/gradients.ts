// The Gradient trigger's layers: a quad whose colour runs from one channel to
// another, drawn into one of the scene's draw layers.
//
// The game makes each one a CCLayerGradient and places it every frame. Its
// four sides come from the main objects of up to four groups (key 203 the
// top's y, 204 the bottom's, 205 the left's x, 206 the right's), any side
// without one being the view's own edge 20 units out; with key 207 the four
// objects are the corners instead. The colour runs along the trigger's own
// turn, from the start channel (key 21) to the end channel (key 22), each at
// its channel's opacity and the trigger's group opacity, and the layer sits
// over everything else in its draw layer.
//
// A quad with a colour at each corner is not something the sprite batch can
// draw, so the quad is cut into strips across the way the colour runs, each
// a flat colour, fine enough that nothing bands. CCLayerGradient's colour is
// a straight-line function of the position across the quad (its "compressed
// interpolation"), so the strips are exact apart from the steps between them.
//
// [gdp GJBaseGameLayer::updateGradientLayers :423485-424305;
//  triggerGradientCommand :436326-436500; CCLayerGradient::initWithColor
//  :820556-820580 (compressed interpolation on); updateColor :820617-820690]

import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS } from "../engine/gl/spriteBatch";
import type { Level } from "../level/types";
import type { GradientState, TriggerRuntime } from "../triggers/runtime";
import { applyHsv, type ColorSource, type Rgb } from "./colors";
import type { EffectQuad } from "./effects";

/** How far past the view a side with no group stands. [:423558-423565] */
const VIEW_MARGIN = 20;
/** Strips along each way the colour changes. */
const STRIPS = 48;
const SQRT2 = Math.fround(1.4142);

/**
 * Where a gradient's layer draws: after which of the scene's parts. The
 * world's draw layers (3 to 12) go over their batch layer's sprites and
 * particles, the player's (8) over the particles above the player; the
 * background, middleground and ground take theirs over their own art, and
 * the interface's and the top layer over the whole scene.
 * [gdp triggerGradientCommand :436380-436460 (the parent by layer, the z at
 *  that layer's highest, maxZOrderForShaderZ)]
 */
export const GRADIENT_SLOT = {
  BACKGROUND: 0,
  MIDDLEGROUND: 1,
  /** B5 … B1 are 2 … 6. */
  BEHIND: 2,
  PLAYER: 7,
  /** T1 … T4 are 8 … 11. */
  FRONT: 8,
  GROUND: 12,
} as const;
export const GRADIENT_SLOTS = 13;

/** The slot a gradient's key-202 layer draws in. */
export function gradientSlot(layer: number): number {
  if (layer <= 1) return GRADIENT_SLOT.BACKGROUND;
  if (layer === 2) return GRADIENT_SLOT.MIDDLEGROUND;
  if (layer <= 7) return GRADIENT_SLOT.BEHIND + (layer - 3);
  if (layer === 8) return GRADIENT_SLOT.PLAYER;
  if (layer <= 12) return GRADIENT_SLOT.FRONT + (layer - 9);
  return GRADIENT_SLOT.GROUND;
}

/** One gradient's place and colours this frame, in the level's units, or null when nothing of it shows. */
export interface GradientQuad {
  /** Bottom left, bottom right, top left, top right. */
  corners: [number, number, number, number, number, number, number, number];
  /** The start and end colours, 0-255, and their opacities, 0-1. */
  start: Rgb;
  startAlpha: number;
  end: Rgb;
  endAlpha: number;
  /** How far towards the start each corner is, 0 to 1: CCLayerGradient's weights, in corner order. */
  weights: [number, number, number, number];
  additive: boolean;
}

/** What placing a gradient reads from the live level. */
export interface GradientWorld {
  level: Level;
  triggers: TriggerRuntime;
  colors: ColorSource;
  /** The view in the level's units, unturned. */
  view: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * One gradient as the game places and colours it this frame. Null when it
 * shows nothing: both ends clear, an additive one that is black at both
 * ends, one wholly off the view, and the two blend modes the sprite batch
 * cannot do (2 and 3, which multiply by and invert what is under them).
 * [gdp updateGradientLayers :423640-423700 (the colours and when it hides),
 *  :423700-423760 (the sides), :423800-423830 (the corners)]
 */
export function placeGradient(g: GradientState, world: GradientWorld): GradientQuad | null {
  if (g.blend === 2 || g.blend === 3) return null;
  const { level, triggers, colors, view } = world;
  const trigger = level.objects[g.object];
  if (!trigger) return null;
  let groupAlpha = 1;
  for (const group of trigger.groups) groupAlpha *= triggers.groupAlphaOf(group);
  const startChannel = colors.get(g.start);
  const endChannel = colors.get(g.end);
  const start = applyHsv(startChannel, trigger.baseHsv);
  const end = applyHsv(endChannel, trigger.detailHsv);
  const startAlpha = Math.trunc(startChannel.a * 255 * groupAlpha) / 255;
  const endAlpha = Math.trunc(endChannel.a * 255 * groupAlpha) / 255;
  const additive = g.blend === 1;
  if (startAlpha === 0 && endAlpha === 0) return null;
  const black = (c: Rgb): boolean => c.r === 0 && c.g === 0 && c.b === 0;
  if (additive && black(start) && black(end)) return null;

  const at = (group: number): [number, number] | null => {
    const i = triggers.mainObjectOf(group);
    return i >= 0 ? triggers.objectPosition(i) : null;
  };
  const [up, down, left, right] = g.groups.map((group) => (group > 0 ? at(group) : null));
  const x0 = view.x0 - VIEW_MARGIN;
  const y0 = view.y0 - VIEW_MARGIN;
  const x1 = view.x1 + VIEW_MARGIN;
  const y1 = view.y1 + VIEW_MARGIN;
  let corners: GradientQuad["corners"];
  if (!g.vertexMode) {
    const bottom = down ? down[1] : y0;
    const leftX = left ? left[0] : x0;
    const top = up ? up[1] : y1;
    const rightX = right ? right[0] : x1;
    if (leftX > x1 || bottom > y1 || rightX < x0 || top < y0) return null;
    corners = [leftX, bottom, rightX, bottom, leftX, top, rightX, top];
  } else {
    const bl = up ?? [x0, y0];
    const br = down ?? [x1, y0];
    const tl = left ?? [x0, y1];
    const tr = right ?? [x1, y1];
    const xs = [bl[0], br[0], tl[0], tr[0]];
    const ys = [bl[1], br[1], tl[1], tr[1]];
    if (Math.min(...xs) > x1 || Math.min(...ys) > y1 || Math.max(...xs) < x0 || Math.max(...ys) < y0) return null;
    corners = [bl[0], bl[1], br[0], br[1], tl[0], tl[1], tr[0], tr[1]];
  }

  // The way the colour runs: the trigger's turn, clockwise, as a vector
  // (cos −r, sin −r), stretched so its larger part reaches the corners.
  // [:423700-423704 (+468); CCLayerGradient::updateColor, compressed]
  const m = triggerTurnScratch;
  triggers.objectTransform(g.object, m);
  const turn = -((trigger.rotation + m[6]) * Math.PI) / 180;
  let ux = Math.cos(turn);
  let uy = Math.sin(turn);
  const k = SQRT2 / (Math.abs(ux) + Math.abs(uy));
  ux *= k;
  uy *= k;
  const w = (sx: number, sy: number): number => (SQRT2 + sx * ux + sy * uy) / (2 * SQRT2);
  return {
    corners,
    start,
    startAlpha,
    end,
    endAlpha,
    weights: [w(1, 1), w(-1, 1), w(1, -1), w(-1, -1)],
    additive,
  };
}

const triggerTurnScratch = new Float64Array(9);

/**
 * Every gradient of the frame, cut into strips and written as sprite
 * instances, in runs by the slot they draw after (layerStart/layerCount).
 */
export class GradientPainter {
  private data = new Float32Array(256 * INSTANCE_FLOATS);
  private bytes = new Uint8Array(this.data.buffer);
  readonly layerStart = new Int32Array(GRADIENT_SLOTS);
  readonly layerCount = new Int32Array(GRADIENT_SLOTS);

  get buffer(): Float32Array {
    return this.data;
  }

  /**
   * The frame's gradients, drawn with `white`, a flat white quad. Each slot's
   * gradients go in the order their layers were made.
   */
  update(states: readonly GradientState[], world: GradientWorld, white: EffectQuad): void {
    this.layerStart.fill(0);
    this.layerCount.fill(0);
    if (states.length === 0) return;
    let at = 0;
    for (let slot = 0; slot < GRADIENT_SLOTS; slot++) {
      const from = at;
      for (const g of states) {
        if (gradientSlot(g.layer) !== slot) continue;
        const quad = placeGradient(g, world);
        if (quad) at = this.write(at, quad, white);
      }
      this.layerStart[slot] = from;
      this.layerCount[slot] = at - from;
    }
  }

  private ensure(n: number): void {
    if (n * INSTANCE_FLOATS <= this.data.length) return;
    const next = new Float32Array(Math.max(n, this.data.length / INSTANCE_FLOATS * 2) * INSTANCE_FLOATS);
    next.set(this.data);
    this.data = next;
    this.bytes = new Uint8Array(next.buffer);
  }

  /** One gradient as strips: the colour at each strip's middle, the corners mapped across. */
  private write(at: number, q: GradientQuad, white: EffectQuad): number {
    const [wbl, wbr, wtl] = q.weights;
    const ns = Math.abs(wbr - wbl) > 1e-4 ? STRIPS : 1;
    const nt = Math.abs(wtl - wbl) > 1e-4 ? STRIPS : 1;
    this.ensure(at + ns * nt);
    const c = q.corners;
    const point = (s: number, t: number): [number, number] => [
      c[0] * (1 - s) * (1 - t) + c[2] * s * (1 - t) + c[4] * (1 - s) * t + c[6] * s * t,
      c[1] * (1 - s) * (1 - t) + c[3] * s * (1 - t) + c[5] * (1 - s) * t + c[7] * s * t,
    ];
    // The white square's middle, clear of its edges.
    const u0 = white.u0 + white.du * 0.25;
    const v0 = white.v0 + white.dv * 0.25;
    const du = white.du * 0.5;
    const dv = white.dv * 0.5;
    for (let j = 0; j < nt; j++) {
      for (let i = 0; i < ns; i++) {
        const s0 = i / ns;
        const s1 = (i + 1) / ns;
        const t0 = j / nt;
        const t1 = (j + 1) / nt;
        const sc = (s0 + s1) / 2;
        const tc = (t0 + t1) / 2;
        const mid = point(sc, tc);
        const a = point(s1, tc);
        const b = point(s0, tc);
        const up = point(sc, t1);
        const down = point(sc, t0);
        const wgt = wbl + (wbr - wbl) * sc + (wtl - wbl) * tc;
        const f = at * INSTANCE_FLOATS;
        const d = this.data;
        d[f] = (a[0] - b[0]) / 2;
        d[f + 1] = (a[1] - b[1]) / 2;
        d[f + 2] = (up[0] - down[0]) / 2;
        d[f + 3] = (up[1] - down[1]) / 2;
        d[f + 4] = mid[0];
        d[f + 5] = mid[1];
        d[f + 6] = u0;
        d[f + 7] = v0;
        d[f + 8] = du;
        d[f + 9] = dv;
        const o = at * INSTANCE_BYTES;
        const mix = (e: number, s: number): number => e + (s - e) * wgt;
        const bytes = this.bytes;
        bytes[o + 40] = Math.round(mix(q.end.r, q.start.r));
        bytes[o + 41] = Math.round(mix(q.end.g, q.start.g));
        bytes[o + 42] = Math.round(mix(q.end.b, q.start.b));
        bytes[o + 43] = Math.round(Math.min(1, Math.max(0, mix(q.endAlpha, q.startAlpha))) * 255);
        bytes[o + 44] = white.unit;
        bytes[o + 45] = 0;
        bytes[o + 46] = q.additive ? BLEND.ADD : BLEND.NORMAL;
        bytes[o + 47] = 0;
        at++;
      }
    }
    return at;
  }
}
