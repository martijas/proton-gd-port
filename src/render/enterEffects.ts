// The enter effects: what an object does as it comes on screen, and again as
// it goes off.
//
// Read out of PlayLayer::applyEnterEffect and the visibility pass that calls
// it, which settle everything this port had been guessing at:
//
//   - Progress is a *distance*, not a timer: how far the object's position is
//     inside the screen edge, over a band of 70 units, clamped to 0..1. That is
//     `getRelativeModNew(pos, 70, 0)`. Coming in it is measured from the right
//     edge; going out, from the left — the same effect plays in reverse on the
//     way off, out of a second table the trigger fills at the same time.
//   - Every effect fades. The opacity is the same 70-unit progress, measured
//     from the object's position less +704 — half its width beyond one block
//     (getObjectTextureRect) — which is its centre up to a block wide and
//     leads a wider object's centre by the rest. The only codes that do not
//     fade are "none" (1915) and the custom effects (3017-3021).
//   - The slides travel 100 units, not 60, and the "big to small" scale starts
//     at 1.75, not 2.
//   - With no trigger in force at all, the default is code -2: the fade and
//     nothing else. Which is why every classic level's blocks fade in at the
//     right edge, and why this port's used to pop.
//   - An enter trigger does not set the effect of the objects after it: it
//     sets its channel's entry in a table, when it is reached like any other
//     trigger, and an object takes the entry for its own channel (key 343)
//     as it starts to come in — so the objects already on their way in when
//     the player crosses it keep the old one. The draw list keeps that latch
//     per object; the runtime keeps the tables (VisualState.enter).
//
// The game keeps the codes as small negatives; they are stored here as their
// magnitudes, a byte each in the runtime's per-channel tables and in the draw
// list's per-object latches.
// [gdp PlayLayer::applyEnterEffect, gd-ida-decomp.cpp:91072-91300;
//  getRelativeModNew :91043-91055; the fade in PlayLayer::updateVisibility
//  :96040-96066; the id table and the per-channel tables in
//  GJBaseGameLayer::updateActiveEnterEffect :467525-467625]

/** How far inside the edge an object is fully in, in units. */
export const ENTER_BAND = 70;
/** How far a sliding effect starts from its resting place, in units. */
export const ENTER_SLIDE = 100;
/** Where "big to small" starts. */
export const ENTER_GROW_FROM = 1.75;

/** The game's own codes, as magnitudes. */
export const ENTER = {
  /** Fade only. The default, and what id 22 asks for. */
  fade: 2,
  smallToBig: 3,
  bigToSmall: 4,
  fromTop: 5,
  fromBottom: 6,
  fromLeft: 7,
  fromRight: 8,
  /** From the right, angled toward the nearer of the top and bottom. */
  angledNear: 9,
  /** From the left, likewise. */
  angledFar: 10,
  random: 11,
  /** Straight in from the nearer of the top and bottom. */
  verticalNear: 12,
  /** Straight in from the further one. */
  verticalFar: 13,
  /** Nothing at all, not even the fade: id 1915. */
  none: 14,
  /** The 2.2 custom enter triggers (3017-3021), whose effects this port does not draw yet. */
  custom: 15,
} as const;

/** The enter-effect trigger ids, which the runtime fills its enter tables from. */
export const ENTER_TRIGGER_IDS: ReadonlySet<number> = new Set([22, 23, 24, 25, 26, 27, 28, 55, 56, 57, 58, 59, 1915, 3017, 3018, 3019, 3020, 3021]);

/** Which code a trigger id sets. Anything else is the default. */
export function enterCode(triggerId: number): number {
  switch (triggerId) {
    case 23:
      return ENTER.fromBottom;
    case 24:
      return ENTER.fromTop;
    case 25:
      return ENTER.fromLeft;
    case 26:
      return ENTER.fromRight;
    case 27:
      return ENTER.smallToBig;
    case 28:
      return ENTER.bigToSmall;
    case 55:
      return ENTER.random;
    case 56:
      return ENTER.angledFar;
    case 57:
      return ENTER.angledNear;
    case 58:
      return ENTER.verticalNear;
    case 59:
      return ENTER.verticalFar;
    case 1915:
      return ENTER.none;
    case 3017:
    case 3018:
    case 3019:
    case 3020:
    case 3021:
      return ENTER.custom;
    default:
      return ENTER.fade;
  }
}

/** Whether a code dims the object as it enters. */
export function enterFades(code: number): boolean {
  return code !== ENTER.none && code !== ENTER.custom;
}

/** Where an object is drawn relative to its resting place, and how big. */
export interface EnterPose {
  dx: number;
  dy: number;
  scale: number;
}

const REST: EnterPose = { dx: 0, dy: 0, scale: 1 };

/**
 * The pose for `code` at progress `t` (0 at the edge, 1 fully in).
 *
 * `above` is whether the object sat above the middle of the screen when the
 * effect latched, which the angled and vertical effects use to pick the
 * nearer edge; the draw list keeps it with the latch. `seed` is what the
 * random effect rolls its angle from — the game uses rand(), which no replay
 * could reproduce.
 */
export function enterPose(code: number, t: number, above: boolean, seed: number): EnterPose {
  if (t >= 1) return REST;
  const left = 1 - t;
  switch (code) {
    case ENTER.smallToBig:
      return { dx: 0, dy: 0, scale: t };
    case ENTER.bigToSmall:
      return { dx: 0, dy: 0, scale: 1 + (ENTER_GROW_FROM - 1) * left };
    case ENTER.fromTop:
      return { dx: 0, dy: ENTER_SLIDE * left, scale: 1 };
    case ENTER.fromBottom:
      return { dx: 0, dy: -ENTER_SLIDE * left, scale: 1 };
    case ENTER.fromLeft:
      return { dx: -ENTER_SLIDE * left, dy: 0, scale: 1 };
    case ENTER.fromRight:
      return { dx: ENTER_SLIDE * left, dy: 0, scale: 1 };
    case ENTER.angledNear:
    case ENTER.angledFar:
    case ENTER.random:
    case ENTER.verticalNear:
    case ENTER.verticalFar:
      return alongAngle(enterAngle(code, above, seed), left);
    default:
      return REST;
  }
}

/**
 * The angle the game stores for the directional effects, in its own degrees.
 * [gdp applyEnterEffect :91145-91180: 45/135 and -45/-135 by which half of the
 *  screen the object is in, 0/180 for the vertical pair, and a roll of
 *  rand() for the random one]
 */
export function enterAngle(code: number, above: boolean, seed: number): number {
  switch (code) {
    case ENTER.angledNear:
      return above ? 135 : 45;
    case ENTER.angledFar:
      return above ? -135 : -45;
    case ENTER.verticalNear:
      return above ? 180 : 0;
    case ENTER.verticalFar:
      return above ? 360 : 180;
    case ENTER.random:
      return roll(seed) * 360 - 180;
    default:
      return 0;
  }
}

/** ccpForAngle(angle - 90°) scaled by the slide left to travel. */
function alongAngle(angle: number, left: number): EnterPose {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { dx: Math.cos(rad) * ENTER_SLIDE * left, dy: Math.sin(rad) * ENTER_SLIDE * left, scale: 1 };
}

/** A stable 0..1 for an object, so the random effect looks the same every attempt. */
function roll(seed: number): number {
  let h = (seed + 1) * 2654435761;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Progress across the band, from a distance inside the edge. */
export function enterProgress(distanceInside: number): number {
  return Math.min(1, Math.max(0, distanceInside / ENTER_BAND));
}
