// The wave's trail: the solid band it leaves behind it.
//
// The game draws this with HardStreak, a CCDrawNode of its own, and not with
// the CCMotionStreak the other modes use. It keeps a list of points — one
// wherever the wave changed direction — and the player's position as the
// head, and every frame it redraws the band as one flat four-cornered polygon
// per pair of points. Nothing fades with age: the band stays as long as the
// wave does, and a point leaves only once the next one has gone off the left
// of the screen. It fades out, over a fifth of a second, when the player
// stops being the wave or dies.
//
// Additive, it draws every segment twice: the band in the player's colour,
// then a white core a third as wide at 0.65 of its opacity. Made normal, it
// is the band alone.
//
// The points come from the simulation tick rather than the frame, so the band
// is the same shape however fast the machine is drawing, and a pause holds it
// still.
// [gdp HardStreak::updateStroke :389335-389627, quadCornerOffset
//  :389294-389319, clearBehindXPos :389187-389208, clearAboveXPos
//  :389225-389246; PlayerObject::placeStreakPoint :148159-148189,
//  setPosition :144280-144286 (the head), update :161151-161171 (the pulse
//  and the clearing), deactivateStreak :147767-147785 and fadeOutStreak2
//  :147733-147751 (the fade), toggleDartMode :153052-153059 (a new band on
//  entering), createFadeOutDartStreak :143417-143444]

import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS } from "../engine/gl/spriteBatch";
import type { Rgb } from "./colors";
import type { EffectQuad } from "./effects";

/**
 * The band's width, and the core's, before the player's scale and the music
 * pulse: 6 and 2. [updateStroke :389471-389477 (+356 × 6, or × 2 for the
 *  second pass, × +360)]
 */
export const BAND_WIDTH = 6;
export const CORE_WIDTH = 2;
/** The core's share of the band's opacity. [updateStroke :389586-389590] */
export const CORE_OPACITY = 0.65;
/** How long the band takes to fade away when it stops. [deactivateStreak :147767-147785 (0.2 in play); playerDestroyed :149944] */
const FADE_OUT = 0.2;
/** How long the copy left behind by a turn-around takes to fade. [createFadeOutDartStreak :143439 (CCFadeTo 0.5)] */
const COPY_FADE_OUT = 0.5;
/**
 * A move bigger than this in one tick is a teleport, not travel: the game
 * starts the band afresh there. 30 units is a block; the fastest mini wave
 * covers about 5 a tick. [GJBaseGameLayer::teleportPlayer :462428-462430
 *  (resetStreak, then placeStreakPoint)]
 */
const TELEPORT = 30;
/**
 * How far the direction has to turn, as the sine of the angle, before it is a
 * new point. The wave travels in straight lines, so the only turns are real
 * ones — a click, a release, a landing, a portal — and this only has to be
 * clear of rounding.
 */
const TURN = 1e-3;

/**
 * The band's width multiplier from the music pulse (audio/pulse.ts), which
 * the game hands the player each frame: (pulse − 0.1) × 2.1 + 0.4.
 * [PlayerObject::update :161151-161153; PlayLayer::updateVisibility
 *  :95893-95894 (+2156)]
 */
export function bandPulse(meter: number): number {
  return Math.fround(Math.fround(Math.fround(meter - 0.1) * 2.1) + 0.4);
}

interface Point {
  x: number;
  y: number;
}

/**
 * Whether the bands draw additive, with their white core, or normal. They
 * start additive unless the player's colour 1 is black, and from then on
 * follow the level's streak blend flag only when it changes: the game sets
 * the blend when it builds the player and touches it again only through
 * togglePlayerStreakBlend, which does nothing unless the flag changes — and
 * the flag starts additive, so a reset that leaves it there does not make a
 * black player's band additive, while a reset after an Options trigger made
 * it normal does. Both players share it: the test is colour 1's either way.
 * [gdp PlayerObject::setupStreak :160812-160818 (index 15, the table's only
 *  black, unless 0096); GJGameState ctor :97219 (+388 = 1);
 *  GJBaseGameLayer::togglePlayerStreakBlend :429735-429746, from
 *  resetLevelVariables :463029, loadFromCheckpoint :105588 and the Options
 *  trigger :429820-429822; updateStreakBlend :141933-141951]
 */
export class StreakBlend {
  private flag = true;
  additive: boolean;

  constructor(colour1Black: boolean) {
    this.additive = !colour1Black;
  }

  /** Takes the level's flag for this tick and returns the blend. */
  follow(flag: boolean): boolean {
    if (flag !== this.flag) {
      this.flag = flag;
      this.additive = flag;
    }
    return this.additive;
  }
}

/** One band: the live one, or a copy fading out. */
interface Band {
  points: Point[];
  head: Point;
  /** +365: the player is turned around, and the band is laid right to left. */
  reversed: boolean;
  /** When it began to fade, or -1 while it is not fading. */
  fadeFrom: number;
  fadeTime: number;
  /** A copy keeps the width, blend and colour it was made with. */
  scale: number;
  additive: boolean;
  colour: Rgb;
}

/** What one tick tells the band about its player. */
export interface StreakPlayer {
  x: number;
  y: number;
  /** The wave, alive and shown: the band is laid. */
  laying: boolean;
  reversed: boolean;
}

/** The four corners updateStroke hands drawPolygon, in its order: v65, v66, v67, v68. */
export type StrokeCorners = [Point, Point, Point, Point];

/**
 * One segment's polygon, exactly as updateStroke builds it, for the band
 * (`core` false) or its core.
 *
 * Each end has one corner on the perpendicular through its point and one
 * moved along x and y. For the band, the moved one is the corner on the
 * outside of a zigzag's bend, pushed out to meet the next segment's, so a
 * bend has no notch on its outside, and the two segments overlap on its
 * inside. The core moves its points in by the same
 * amounts first, which puts both its ends on the vertical through the point:
 * its segments meet edge to edge. The last segment of the band ends square
 * at the head, a little short of it once it is over ten long.
 * [updateStroke :389454-389593; quadCornerOffset :389294-389319]
 */
export function strokeCorners(from: Point, to: Point, width: number, core: boolean, last: boolean, reversed: boolean): StrokeCorners {
  const c = new Float64Array(8);
  strokeInto(c, from, to, width, core, last, reversed);
  return [
    { x: c[0], y: c[1] },
    { x: c[2], y: c[3] },
    { x: c[4], y: c[5] },
    { x: c[6], y: c[7] },
  ];
}

/** strokeCorners into `out` as x, y pairs, for the frame's build, which makes hundreds. */
function strokeInto(out: Float64Array, from: Point, to: Point, width: number, core: boolean, last: boolean, reversed: boolean): void {
  // Turned around, the band is laid from the head back. [:389461-389466]
  let ax = reversed ? to.x : from.x;
  let ay = reversed ? to.y : from.y;
  let bx = reversed ? from.x : to.x;
  let by = reversed ? from.y : to.y;
  const half = width * 0.5;
  // Half the width across the segment, turned a quarter from it; nothing
  // under a width of 1.
  let ox = 0;
  let oy = 0;
  if (width >= 1) {
    const turn = Math.atan2(by - ay, bx - ax) + Math.PI / 2;
    ox = Math.cos(turn) * half;
    oy = Math.sin(turn) * half;
  }
  const dx = Math.abs(ox);
  const t = dx > 0 ? Math.tanh(Math.asinh(dx / half)) : 0;
  const dy = Math.abs(t * dx);
  // The last band segment, not turned around: its head is drawn square and,
  // past ten units, pulled back four along x. [:389486-389524]
  const head = last && !core && !reversed;
  if (head && Math.hypot(bx - ax, by - ay) > 10) {
    const pull = Math.abs(t * 4);
    by = ay < by ? by - pull : by + pull;
    bx -= 4;
  }
  // The ends pushed out along x, and along y away from each other.
  const pax = ax - dx;
  const pbx = bx + dx;
  if (core) {
    ax += dx;
    bx -= dx;
  }
  const up = ay < by;
  let pay = ay;
  let pby = by;
  if (up) {
    pay -= dy;
    pby += dy;
    if (core) {
      ay += dy;
      by -= dy;
    }
  } else {
    pay += dy;
    pby -= dy;
    if (core) {
      ay -= dy;
      by += dy;
    }
  }
  // v65 low at the start, v66 high at the start, v67 high at the end, v68
  // low at the end; the pushed point or the plain one as updateStroke picks.
  out[0] = (up ? pax : ax) - ox;
  out[1] = (up ? pay : ay) - oy;
  out[2] = (up ? ax : pax) + ox;
  out[3] = (up ? ay : pay) + oy;
  out[4] = (!up || head ? bx : pbx) + ox;
  out[5] = (!up || head ? by : pby) + oy;
  out[6] = (up || head ? bx : pbx) - ox;
  out[7] = (up || head ? by : pby) - oy;
}

/**
 * The wave's band for one player: where it has been laid and how it draws.
 * `track` once a tick, `build` once a frame.
 */
export class HardStreak {
  private live: Band | null = null;
  private readonly copies: Band[] = [];
  /** The last tick's position, and the way it was going. */
  private lastX = 0;
  private lastY = 0;
  private dirX = 0;
  private dirY = 0;
  private hasDir = false;
  private wasLaying = false;
  data = new Float32Array(64 * INSTANCE_FLOATS);
  private bytes = new Uint8Array(this.data.buffer);
  private count = 0;
  /** One polygon's corners, reused for every segment. */
  private readonly corners = new Float64Array(8);

  /** Drops the band and its copies, so a restart does not draw the last run's. */
  reset(): void {
    this.live = null;
    this.copies.length = 0;
    this.hasDir = false;
    this.wasLaying = false;
  }

  /** Whether there is anything to draw. */
  get empty(): boolean {
    return this.live === null && this.copies.length === 0;
  }

  /**
   * One tick. `view` is the world's left and right edge on the screen, which
   * the points behind the player are cleared against; `scale` the player's
   * size (0.6 mini); `additive` and `colour` how the band draws now, which a
   * copy keeps.
   */
  track(p: StreakPlayer, seconds: number, view: { x0: number; x1: number }, scale: number, additive: boolean, colour: Rgb): void {
    this.dropFaded(seconds);
    const live = this.live;
    if (!p.laying) {
      // Stopped: the band stays where it is and fades, then goes.
      // [deactivateStreak → fadeOutStreak2 → stopStroke]
      if (live && live.fadeFrom < 0) {
        live.fadeFrom = seconds;
        live.fadeTime = FADE_OUT;
      }
      this.wasLaying = false;
      this.hasDir = false;
      return;
    }
    if (!this.wasLaying || !live || live.fadeFrom >= 0) {
      // Becoming the wave, or shown again: a new band from here.
      // [toggleDartMode :153052-153059; toggleVisibility :148205-148259]
      this.start(p, scale, additive, colour);
      return;
    }
    const mx = p.x - this.lastX;
    const my = p.y - this.lastY;
    if (Math.abs(mx) > TELEPORT || Math.abs(my) > TELEPORT) {
      this.start(p, scale, additive, colour);
      return;
    }
    if (p.reversed !== live.reversed) {
      // Turning round leaves the band behind, fading, and starts another.
      // [doReversePlayer :148330-148340]
      live.head = { x: p.x, y: p.y };
      live.fadeFrom = seconds;
      live.fadeTime = COPY_FADE_OUT;
      this.copies.push(live);
      this.start(p, scale, additive, colour);
      return;
    }
    const length = Math.hypot(mx, my);
    if (length > 0) {
      const ux = mx / length;
      const uy = my / length;
      // A turn puts a point where it happened: the last tick's position.
      if (this.hasDir && (Math.abs(this.dirX * uy - this.dirY * ux) > TURN || this.dirX * ux + this.dirY * uy < 0)) {
        live.points.push({ x: this.lastX, y: this.lastY });
      }
      this.dirX = ux;
      this.dirY = uy;
      this.hasDir = true;
    }
    this.lastX = p.x;
    this.lastY = p.y;
    live.head = { x: p.x, y: p.y };
    live.scale = scale;
    live.additive = additive;
    live.colour = colour;
    // Only the point just off the screen behind is kept. [:161156-161171]
    const points = live.points;
    if (live.reversed) {
      while (points.length > 1 && points[1].x > view.x1) points.shift();
    } else {
      while (points.length > 1 && points[1].x < view.x0) points.shift();
    }
  }

  private start(p: StreakPlayer, scale: number, additive: boolean, colour: Rgb): void {
    this.live = {
      points: [{ x: p.x, y: p.y }],
      head: { x: p.x, y: p.y },
      reversed: p.reversed,
      fadeFrom: -1,
      fadeTime: 0,
      scale,
      additive,
      colour,
    };
    this.lastX = p.x;
    this.lastY = p.y;
    this.hasDir = false;
    this.wasLaying = true;
  }

  private dropFaded(seconds: number): void {
    for (let i = this.copies.length - 1; i >= 0; i--) {
      const c = this.copies[i];
      if (seconds - c.fadeFrom >= c.fadeTime) this.copies.splice(i, 1);
    }
    const live = this.live;
    if (live && live.fadeFrom >= 0 && seconds - live.fadeFrom >= live.fadeTime) this.live = null;
  }

  /**
   * Builds the band, the copies after it. `head` is where the player is drawn
   * this frame, which the live band runs to. Returns how many instances to
   * draw.
   */
  build(quad: EffectQuad, seconds: number, pulse: number, head?: Point): number {
    this.count = 0;
    const live = this.live;
    const k = bandPulse(pulse);
    if (live) this.buildBand(quad, live, seconds, k, head && live.fadeFrom < 0 ? head : live.head);
    for (const copy of this.copies) this.buildBand(quad, copy, seconds, k, copy.head);
    return this.count;
  }

  /**
   * One band: every segment as the band, then, additive, every segment again
   * as the core. [updateStroke :389447-389599 (the passes round the
   * segments)]
   */
  private buildBand(quad: EffectQuad, band: Band, seconds: number, pulse: number, head: Point): void {
    const fade = band.fadeFrom < 0 ? 1 : Math.max(0, 1 - (seconds - band.fadeFrom) / band.fadeTime);
    // The opacity goes to GL as a byte. [CCFadeOut on the node, read back
    // through getOpacity :389583-389590]
    const opacity = Math.trunc(255 * fade) / 255;
    if (opacity <= 0) return;
    const points = band.points;
    const segments = points.length;
    const passes = band.additive ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      const core = pass === 1;
      const width = (core ? CORE_WIDTH : BAND_WIDTH) * band.scale * pulse;
      const colour = core ? WHITE : band.colour;
      const alpha = core ? opacity * CORE_OPACITY : opacity;
      const blend = band.additive ? BLEND.ADD : BLEND.NORMAL;
      for (let i = 0; i < segments; i++) {
        const a = points[i];
        const last = i === segments - 1;
        const b = last ? head : points[i + 1];
        if (a.x === b.x && a.y === b.y) continue;
        strokeInto(this.corners, a, b, width, core, last, band.reversed);
        this.polygon(quad, this.corners, colour, alpha, blend);
      }
    }
  }

  /**
   * One polygon as an instance. Every segment but the band's last is a
   * parallelogram, which an instance draws exactly; the last is drawn as the
   * parallelogram on its start edge whose far edge is centred where its own
   * is — the difference is a sliver at the head, under the player.
   */
  private polygon(quad: EffectQuad, c: Float64Array, colour: Rgb, alpha: number, blend: number): void {
    const at = this.count;
    if ((at + 1) * INSTANCE_FLOATS > this.data.length) this.grow();
    const sx = (c[0] + c[2]) / 2;
    const sy = (c[1] + c[3]) / 2;
    const ex = (c[4] + c[6]) / 2;
    const ey = (c[5] + c[7]) / 2;
    const f = at * INSTANCE_FLOATS;
    const d = this.data;
    // Column one runs from the start edge to the end edge, column two along
    // the start edge.
    d[f] = (ex - sx) / 2;
    d[f + 1] = (ey - sy) / 2;
    d[f + 2] = (c[2] - c[0]) / 2;
    d[f + 3] = (c[3] - c[1]) / 2;
    d[f + 4] = (sx + ex) / 2;
    d[f + 5] = (sy + ey) / 2;
    d[f + 6] = quad.u0;
    d[f + 7] = quad.v0;
    d[f + 8] = quad.du;
    d[f + 9] = quad.dv;
    const o = at * INSTANCE_BYTES;
    const bytes = this.bytes;
    bytes[o + 40] = colour.r;
    bytes[o + 41] = colour.g;
    bytes[o + 42] = colour.b;
    bytes[o + 43] = Math.round(alpha * 255);
    bytes[o + 44] = quad.unit;
    bytes[o + 45] = 0;
    bytes[o + 46] = blend;
    bytes[o + 47] = 0;
    this.count = at + 1;
  }

  private grow(): void {
    const next = new Float32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
    this.bytes = new Uint8Array(next.buffer);
  }

  /** How many instances the last build wrote. */
  get instances(): number {
    return this.count;
  }
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
