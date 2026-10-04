// The player's streak: the textured ribbon that follows it through the air.
//
// The game draws this with cocos's CCMotionStreak — a ribbon whose points are
// the positions the player has been in, with the texture stretched along it and
// each point fading as it ages. This is the same idea written against the one
// instance format everything else here uses: a ribbon is a run of quads, one
// between each pair of points, each turned to face along its own segment.
//
// It is not the wave's solid band, which is a HardStreak (hardStreak.ts), and
// not the Ghost Trail, which is copies of the icon (ghostTrail.ts). The game
// lays it from PlayerObject::activateStreak — the flying modes, the pads and
// the orbs — which the port does not model yet, so nothing in the scene lays
// it today. [gdp PlayerObject::activateStreak :147620-147650]
//
// The points come from the simulation tick rather than the frame, so the ribbon
// is the same shape however fast the machine is drawing, and a pause holds it
// still instead of collapsing it.

import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS } from "../engine/gl/spriteBatch";
import type { Rgb } from "./colors";
import type { EffectQuad } from "./effects";

/** How many positions the ribbon remembers. At 240 Hz this is about a second. */
const MAX_POINTS = 96;
/**
 * How long a point stays on the ribbon, in seconds, and how wide the ribbon is
 * in units.
 *
 * The decompile hands CCMotionStreak its fade, minimum segment and stroke as
 * three floats in one call and the extract does not make clear which is which,
 * so these are set to match the game's own picture rather than read off it:
 * a streak about a third of a block wide that is gone within half a second.
 * [guess]
 */
const LIFETIME = 0.45;
const STROKE = 9;
/** A point closer than this to the last one is not worth its own segment. */
const MIN_SEGMENT = 1.5;

interface Point {
  x: number;
  y: number;
  /** The clock when it was added. */
  at: number;
}

export class TrailRenderer {
  private readonly points: Point[] = [];
  readonly data = new Float32Array(MAX_POINTS * INSTANCE_FLOATS);
  private readonly bytes = new Uint8Array(this.data.buffer);
  private count = 0;

  /** Drops the ribbon, so a restart does not draw a streak from the last run. */
  reset(): void {
    this.points.length = 0;
    this.count = 0;
  }

  /**
   * Records where the player is. `on` is the streak's own switch, and a gap
   * in the ribbon is a real gap, so turning it off clears the points rather
   * than freezing them.
   */
  track(x: number, y: number, seconds: number, on: boolean): void {
    if (!on) {
      if (this.points.length > 0) this.points.length = 0;
      return;
    }
    const last = this.points[this.points.length - 1];
    if (last) {
      const dx = x - last.x;
      const dy = y - last.y;
      if (dx * dx + dy * dy < MIN_SEGMENT * MIN_SEGMENT) return;
    }
    this.points.push({ x, y, at: seconds });
    // Both ends are bounded: the oldest point leaves when it has faded out, and
    // the buffer never grows past what one second of travel needs.
    while (this.points.length > MAX_POINTS) this.points.shift();
    while (this.points.length > 1 && seconds - this.points[0].at > LIFETIME) this.points.shift();
  }

  /**
   * Builds the ribbon. Returns how many instances to draw.
   *
   * Every segment is a quad as long as the gap it spans and as wide as the
   * stroke, turned to face along itself. Consecutive quads overlap at their
   * corners on a bend, which is what a motion streak does too — the alternative
   * is mitred joints, and at this width nobody can tell.
   *
   * The texture is stretched *once* along the whole ribbon rather than repeated
   * per segment: each quad takes the slice of it that its own share of the
   * length covers. Giving every quad the whole texture is what a first pass
   * does, and it comes out as a row of stripes, because the art's soft ends
   * then land at both ends of every segment instead of at the two ends of the
   * streak.
   *
   * `additive` is the level's streak blend, GL_SRC_ALPHA with GL_ONE or with
   * GL_ONE_MINUS_SRC_ALPHA. The streak is a CCMotionStreak, whose texture is
   * premultiplied and whose vertex colour is its colour with the fade as
   * alpha, so the art's alpha weighs it twice and the fade once, adding
   * (ADD_PARTICLE) or covering (COVER_STRAIGHT).
   * [gdp PlayerObject::setupStreak :160803-160808 (770 / 1 at the start),
   *  updateStreakBlend :141933-141951; cocos2d CCMotionStreak::update]
   */
  build(quad: EffectQuad, colour: Rgb, seconds: number, additive: boolean): number {
    this.count = 0;
    if (this.points.length < 2) return 0;
    // The ribbon's whole length, so each segment knows which part of the
    // texture is its own.
    let total = 0;
    for (let i = 1; i < this.points.length; i++) {
      total += Math.hypot(this.points[i].x - this.points[i - 1].x, this.points[i].y - this.points[i - 1].y);
    }
    if (total <= 0) return 0;
    let travelled = 0;
    let at = 0;
    for (let i = 1; i < this.points.length && at < MAX_POINTS; i++) {
      const a = this.points[i - 1];
      const b = this.points[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length <= 0) continue;
      // Where this segment starts along the ribbon. Advanced for every
      // segment, including the faded ones that are not drawn, or the slices
      // would slide along the texture as the tail disappears.
      const from = travelled / total;
      const to = (travelled + length) / total;
      travelled += length;
      const age = seconds - a.at;
      // The head of the ribbon is full width and the tail tapers away, which is
      // what stops a streak ending in a blunt rectangle.
      const faded = 1 - Math.min(1, Math.max(0, age / LIFETIME));
      if (faded <= 0) continue;
      const blend = additive ? BLEND.ADD_PARTICLE : BLEND.COVER_STRAIGHT;
      this.segment(at++, quad, a, b, from, to, STROKE * faded, colour, faded, blend);
    }
    this.count = at;
    return at;
  }

  /** One quad from `a` to `b`, `width` across, carrying the texture from `from` to `to` along it. */
  private segment(at: number, quad: EffectQuad, a: Point, b: Point, from: number, to: number, width: number, colour: Rgb, alpha: number, blend: number): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const ux = dx / length;
    const uy = dy / length;
    const half = width / 2;
    const f = at * INSTANCE_FLOATS;
    const d = this.data;
    // Column one runs along the segment, column two across it.
    d[f] = ux * (length / 2);
    d[f + 1] = uy * (length / 2);
    d[f + 2] = -uy * half;
    d[f + 3] = ux * half;
    d[f + 4] = (a.x + b.x) / 2;
    d[f + 5] = (a.y + b.y) / 2;
    // The slice of the texture this segment carries, tail at u0.
    d[f + 6] = quad.u0 + from * quad.du;
    d[f + 7] = quad.v0;
    d[f + 8] = (to - from) * quad.du;
    d[f + 9] = quad.dv;
    const o = at * INSTANCE_BYTES;
    this.bytes[o + 40] = colour.r;
    this.bytes[o + 41] = colour.g;
    this.bytes[o + 42] = colour.b;
    this.bytes[o + 43] = Math.round(alpha * 255);
    this.bytes[o + 44] = quad.unit;
    this.bytes[o + 45] = 0;
    this.bytes[o + 46] = blend;
    this.bytes[o + 47] = 0;
  }

  /** How many instances the last build wrote. */
  get instances(): number {
    return this.count;
  }
}
