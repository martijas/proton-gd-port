// The area triggers' arithmetic: the falloff, the eased lookup and the
// per-object variance table. The runtime owns the instances and moves things;
// everything here is a pure function of its arguments.
//
// See data/ref/gd-areas.md for the whole system as the decompile has it.

import { easedValue } from "./easing";

/** Every level key an area instance copies from its trigger, as its fields. */
export const AREA_FIELDS = [
  218, 219, 220, 221, 222, 223, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 252, 253, 263, 264,
  265, 270, 271, 275, 282, 285, 286, 288,
] as const;

/**
 * The keys an Edit Area trigger may tween, in its slot order.
 * [gdp EnterEffectInstance::loadTransitions :717433-717761]
 */
export const AREA_EDITABLE = [
  222, 223, 220, 221, 263, 264, 282, 218, 219, 231, 232, 237, 238, 239, 240, 233, 234, 235, 236, 270, 271,
  265, 285, 275, 286, 252, 253, 288,
] as const;

/** An Edit Area trigger's "leave this field alone". [gdp resetEnterAnimValues :305463-305498] */
export const AREA_UNSET = -99;

/** The float table's size, and how far into it an object's own index may start. */
const RAND_TABLE = 2000;
const RAND_INDEX_SPAN = 1900;

/** Where each variance reads, past the object's own index. [gd-areas.md, "slot offsets"] */
export const VARIANCE_SLOT: Readonly<Record<number, number>> = {
  223: 0,
  221: 1,
  253: 2,
  238: 8,
  240: 9,
  219: 10,
  232: 11,
  234: 12,
  236: 13,
  271: 18,
};

/**
 * The table every ± half of an area field is scaled by: 2000 floats in
 * [-1, 1], and each object's own start index in [0, 1900). The game draws
 * both from MSVC's rand() recurrence, seeded by a process-wide value nobody
 * has pinned down; this seeds it with rand()'s own default of 1, so the
 * variance is the game's shape and fixed per level, but not the game's draw.
 * [gdp GJBaseGameLayer::init :462058-462068; GameObject::commonSetup :166724]
 */
export interface AreaRandom {
  table: Float32Array;
  index: Uint16Array;
}

export function areaRandom(objectCount: number): AreaRandom {
  let state = 1;
  const next = (): number => {
    state = (Math.imul(state, 214013) + 2531011) >>> 0;
    return (state >>> 16) & 0x7fff;
  };
  const table = new Float32Array(RAND_TABLE);
  for (let i = 0; i < RAND_TABLE; i++) {
    const r = next() / 32767;
    table[i] = r + r - 1;
  }
  const index = new Uint16Array(objectCount);
  for (let i = 0; i < objectCount; i++) index[i] = Math.trunc((next() / 32767) * RAND_INDEX_SPAN);
  return { table, index };
}

/** One object's draw for one field: its slot of the table, in [-1, 1]. */
export function variance(rand: AreaRandom, object: number, key: number): number {
  const slot = VARIANCE_SLOT[key];
  if (slot === undefined) return 0;
  return rand.table[rand.index[object] + slot];
}

const easingBuffers = new Map<number, Float32Array>();

/**
 * The game's eased value for an area falloff. Linear for type 0; types 3, 7,
 * 8 and 9 are worked out each time; every other curve is sampled into 101
 * points once and read back by straight-line interpolation, which is not
 * quite the curve itself.
 * [gdp getEnterEasingKey :419136-419157; generateEnterEasingBuffer
 *  :466412-466493; getEnterEasingValue :419172-419195]
 */
export function areaEase(t: number, type: number, rate: number): number {
  if (type === 0) return t;
  if (type === 3 || type === 7 || type === 8 || type === 9) return easedValue(t, type, rate);
  const key = Math.trunc(10000 * type + rate * 100);
  let buf = easingBuffers.get(key);
  if (!buf) {
    buf = new Float32Array(102);
    for (let i = 0; i <= 100; i++) buf[i] = easedValue(i / 100, type, rate);
    buf[101] = buf[100];
    easingBuffers.set(key, buf);
  }
  const k = Math.max(0, Math.min(100, Math.trunc(t * 100)));
  const lo = buf[k];
  const hi = buf[k + 1];
  return Math.fround(lo + (hi - lo) * (t - k * 0.01) * 100);
}

/** An easing rate as the area triggers read it: cut to hundredths. [gdp customObjectSetup :299879-300262] */
export function areaRate(v: number): number {
  return Math.trunc(v * 100) / 100;
}

/**
 * How far out one object sits, 0 at the centre to 1 at the edge, with the
 * side of the centre it is on. Axis 1 and 2 measure along x or y alone and
 * weigh the two sides by `front` and `back`; axis 0 is the straight-line
 * distance. The dead zone stretches what is left of the range, and invert
 * turns the whole thing over.
 * [gdp GJBaseGameLayer::getAreaObjectValue :426694-426866]
 */
export function areaValue(
  axis: number,
  ox: number,
  oy: number,
  cx: number,
  cy: number,
  offsetDraw: number,
  offsetYDraw: number,
  length: number,
  front: number,
  back: number,
  deadzone: number,
  invert: boolean,
): { v: number; side: boolean } {
  let d: number;
  let side: boolean;
  if (axis === 1) {
    d = ox - cx + offsetDraw;
    side = cx <= ox;
    d *= d >= 0 ? back : front;
  } else if (axis === 2) {
    d = oy - cy + offsetDraw;
    side = cy <= oy;
    d *= d >= 0 ? back : front;
  } else {
    const px = cx + offsetDraw;
    const py = cy + offsetYDraw;
    d = Math.hypot(ox - px, oy - py);
    // The decompile reads centre x against object y here; see gd-areas.md.
    side = cx <= oy;
  }
  const len = Math.trunc(length);
  const ratio = d / len;
  let v: number;
  if (deadzone === 0) v = ratio > 0 ? ratio : 0;
  else {
    v = (ratio - deadzone) / (1 - deadzone);
    if (v < 0) v = 0;
  }
  if (v >= 1 || Number.isNaN(v)) v = 1;
  if (invert) v = 1 - v;
  return { v: Math.fround(v), side };
}
