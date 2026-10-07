// The player's streak: the textured ribbon that follows it through the air.
//
// The game draws this with cocos's CCMotionStreak: a ribbon through the
// positions the player has been in, each point fading out over the streak's
// fade time, at one width the whole way, with the texture laid across the
// width and stretched once along the length. This is that, written against
// the one instance format everything else here uses: a run of quads, one
// between each pair of points, each turned to face along its own segment.
//
// It is not the wave's solid band, which is a HardStreak (hardStreak.ts), and
// not the Ghost Trail, which is copies of the icon (ghostTrail.ts). The
// simulation says when it lays (PlayerState.streak), as activateStreak and
// deactivateStreak do in the game.
//
// The points come from the simulation tick rather than the frame, so the ribbon
// is the same shape however fast the machine is drawing, and a pause holds it
// still instead of collapsing it.

import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS } from "../engine/gl/spriteBatch";
import type { Rgb } from "./colors";
import type { EffectQuad } from "./effects";

/** The most points kept; the minimum segment and the fade keep it far below this. */
const MAX_POINTS = 256;
/**
 * A head this far from the last point in one tick has been teleported, and
 * the ribbon starts again where it landed, as resetStreak does after a
 * teleport. The game sets the streak's longest segment to 50.
 * [gdp setupStreak :160770; GJBaseGameLayer::teleportPlayer :462428]
 */
const TELEPORT = 50;

/** One of the seven streaks the icon kit offers. */
export interface StreakStyle {
  /** The art, streak_NN_001. */
  frame: string;
  /** Seconds a point takes to fade out. */
  fade: number;
  /** A point closer than this to the last one is not laid. */
  minSeg: number;
  /** The width, in units, at full size. */
  stroke: number;
  /** Streaks 2 and 7 stay white; the rest take the player's colour 2. */
  white: boolean;
  /** Streaks 5 and 6 ignore a soft stop (+1817), so they lay all the time on the ground too. */
  ignoresSoftStop: boolean;
}

/**
 * The streak's settings by its number, CCMotionStreak::create(fade, minSeg,
 * stroke): 0.3 s, 5 and 10 unless the streak says otherwise. Streak 6 calls
 * enableRepeatMode(0.1) so the game tiles the art by distance along the
 * ribbon; build() still lays v as i/n over the whole ribbon (stretched).
 * [gdp PlayerObject::setupStreak :160708-160766]
 */
export function streakStyle(id: number): StreakStyle {
  const n = id >= 1 && id <= 7 ? Math.trunc(id) : 1;
  const style: StreakStyle = {
    frame: `streak_0${n}_001`,
    fade: 0.3,
    minSeg: 5,
    stroke: 10,
    white: false,
    ignoresSoftStop: false,
  };
  switch (n) {
    case 2:
    case 7:
      style.stroke = 14;
      style.white = true;
      break;
    case 3:
      style.stroke = 8.5;
      break;
    case 4:
      style.fade = 0.4;
      break;
    case 5:
      style.stroke = 5;
      style.fade = 0.6;
      style.ignoresSoftStop = true;
      break;
    case 6:
      style.stroke = 3;
      style.fade = 1;
      style.ignoresSoftStop = true;
      break;
  }
  return style;
}

/**
 * Where the streak is laid from: two units behind the player at full size,
 * four ahead of it in the ship, and on it in the UFO and the swing, along
 * the direction of travel (up the screen in rotated gameplay).
 * [gdp PlayerObject::setPosition :144187-144278]
 */
export function streakHead(
  p: { x: number; y: number; mode: string; reversed: boolean; rotated: boolean },
  scale: number,
): { x: number; y: number } {
  const along = p.mode === "ship" ? 4 : p.mode === "ufo" || p.mode === "swing" ? 0 : -2 * scale;
  const d = p.reversed ? -along : along;
  return p.rotated ? { x: p.x, y: p.y + d } : { x: p.x + d, y: p.y };
}

interface Point {
  x: number;
  y: number;
  /** The clock when it was laid. */
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

  get empty(): boolean {
    return this.points.length === 0;
  }

  /**
   * One tick of CCMotionStreak::update: the points that have faded out go,
   * and while the stroke is on, the head is laid as a new point unless it is
   * within the minimum segment of the last point, or within twice its square
   * of the one before. A stopped stroke lays nothing and lets the rest fade.
   */
  track(head: { x: number; y: number }, seconds: number, laying: boolean, style: StreakStyle): void {
    const pts = this.points;
    let gone = 0;
    while (gone < pts.length && seconds - pts[gone].at >= style.fade) gone++;
    if (gone > 0) pts.splice(0, gone);
    if (!laying) return;
    const last = pts[pts.length - 1];
    if (last) {
      const d2 = (head.x - last.x) ** 2 + (head.y - last.y) ** 2;
      if (d2 > TELEPORT * TELEPORT) {
        pts.length = 0;
      } else {
        const min2 = style.minSeg * style.minSeg;
        if (d2 < min2) return;
        const prev = pts[pts.length - 2];
        if (prev && (head.x - prev.x) ** 2 + (head.y - prev.y) ** 2 < min2 * 2) return;
      }
    }
    if (pts.length >= MAX_POINTS) pts.shift();
    pts.push({ x: head.x, y: head.y, at: seconds });
  }

  /**
   * Builds the ribbon. Returns how many instances to draw.
   *
   * Every segment is a quad as long as the gap it spans and `width` across,
   * turned to face along itself; consecutive quads overlap at their corners
   * on a bend, where the game mitres them. The texture runs across the width
   * and once along the whole ribbon, point i of n at i/n, as
   * CCMotionStreak's texture coordinates do. Each point's alpha is what is
   * left of its fade; a segment takes the mean of its two ends.
   *
   * `additive` is the level's streak blend, GL_SRC_ALPHA with GL_ONE or with
   * GL_ONE_MINUS_SRC_ALPHA. The texture is premultiplied and the vertex
   * colour is the streak's colour with the fade as alpha, so the art's alpha
   * weighs it twice and the fade once, adding (ADD_PARTICLE) or covering
   * (COVER_STRAIGHT).
   * [gdp PlayerObject::setupStreak :160803-160808 (770 / 1 at the start),
   *  updateStreakBlend :141933-141951; cocos2d CCMotionStreak::update]
   */
  build(quad: EffectQuad, colour: Rgb, seconds: number, additive: boolean, width: number, fade: number): number {
    this.count = 0;
    const pts = this.points;
    const n = pts.length;
    if (n < 2) return 0;
    const blend = additive ? BLEND.ADD_PARTICLE : BLEND.COVER_STRAIGHT;
    const alive = (p: Point): number => Math.max(0, 1 - (seconds - p.at) / fade);
    let at = 0;
    for (let i = 1; i < n && at < MAX_POINTS; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a.x === b.x && a.y === b.y) continue;
      const alpha = (alive(a) + alive(b)) / 2;
      if (alpha <= 0) continue;
      this.segment(at++, quad, a, b, (i - 1) / n, i / n, width, colour, alpha, blend);
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
    // Column one runs across the segment, which the texture's u follows;
    // column two runs along it, the v the ribbon's length is laid on.
    d[f] = -uy * half;
    d[f + 1] = ux * half;
    d[f + 2] = ux * (length / 2);
    d[f + 3] = uy * (length / 2);
    d[f + 4] = (a.x + b.x) / 2;
    d[f + 5] = (a.y + b.y) / 2;
    d[f + 6] = quad.u0;
    d[f + 7] = quad.v0 + from * quad.dv;
    d[f + 8] = quad.du;
    d[f + 9] = (to - from) * quad.dv;
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
