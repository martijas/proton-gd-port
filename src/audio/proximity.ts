// Proximity volume: an audio trigger with key 51 turns a sound up or down by
// how far a listener is from a group, every frame.

import type { AudioTriggerParams } from "./triggerAudio";

const f = Math.fround;

/** What getMinDistance answers for no members or an unknown mode. */
const FAR_AWAY = f(2147500000);

/**
 * The listener's distance to the nearest member, by mode: 0 straight-line,
 * 1 |dx|, 2 member x − listener x, 3 listener x − member x, 4 |dy|,
 * 5 member y − listener y, 6 listener y − member y. It stops at the first
 * member within `near`, and skips members whose group is switched off.
 * [gdp GJBaseGameLayer::getMinDistance, gd-ida-decomp.cpp:431822-432062]
 */
export function minDistance(
  listener: readonly [number, number],
  members: Iterable<readonly [number, number]>,
  near: number,
  mode: number,
): number {
  let best = FAR_AWAY;
  if (mode < 0 || mode > 6) return best;
  for (const [x, y] of members) {
    let d: number;
    switch (mode) {
      case 0:
        d = f(Math.hypot(f(x - listener[0]), f(y - listener[1])));
        break;
      case 1:
        d = f(Math.abs(f(x - listener[0])));
        break;
      case 2:
        d = f(x - listener[0]);
        break;
      case 3:
        d = f(listener[0] - x);
        break;
      case 4:
        d = f(Math.abs(f(y - listener[1])));
        break;
      case 5:
        d = f(y - listener[1]);
        break;
      default:
        d = f(listener[1] - y);
        break;
    }
    if (best > d) best = d;
    if (best <= near) break;
  }
  return best;
}

/**
 * The volume at a distance: key 421 up to the near distance, 423 from the far
 * one, and straight lines through 422 in between, in the game's float steps.
 * [gdp GJBaseGameLayer::volumeForProximityEffect :432164-432230]
 */
export function proximityVolume(
  p: Pick<AudioTriggerParams, "near" | "mid" | "far" | "d1" | "d2" | "d3">,
  dist: number,
): number {
  let from = f(p.near);
  let to = f(p.far);
  let lo = f(3 * p.d1);
  const d = f(dist);
  if (d > lo) {
    const mid = f(f(3 * p.d2) + lo);
    let hi = f(f(3 * p.d3) + mid);
    if (d >= hi) return f(from + f(f(to - from) * 1));
    if (mid > 0) {
      if (d >= mid) {
        from = f(p.mid);
        to = f(p.far);
        lo = mid;
      } else {
        from = f(p.near);
        to = f(p.mid);
        hi = mid;
      }
    }
    if (lo !== hi) return f(from + f(f(to - from) * f(f(d - lo) / f(hi - lo))));
  }
  return f(from + f(f(to - from) * 0));
}

/** The level as proximity sees it, one frame at a time. */
export interface ProximityWorld {
  player1: readonly [number, number];
  /** Null unless the level is dual. */
  player2: readonly [number, number] | null;
  /** The centre of the view. */
  camera: readonly [number, number];
  members(group: number): readonly number[];
  position(index: number): readonly [number, number];
  disabled(index: number): boolean;
  /** tryGetMainObject: the group's parent or only member, else -1. */
  mainObject(group: number): number;
}

/**
 * The whole of volumeForProximityEffect: pick the listener, measure, ramp.
 * The camera with key 428; player 1 with 138 (and player 2 as well with 200
 * in a dual level, whichever is nearer once player 1 is past near); player 2
 * alone with 200, player 1 outside dual; otherwise the main object of key 71.
 * No listener, or an empty group, is full volume.
 * [gdp GJBaseGameLayer::volumeForProximityEffect :432079-432240]
 */
export function proximityFor(p: AudioTriggerParams, w: ProximityWorld): number {
  let listener: readonly [number, number] | null;
  let alsoPlayer2 = false;
  if (p.listenCamera) listener = w.camera;
  else if (p.listenP1) {
    listener = w.player1;
    alsoPlayer2 = p.listenP2 && w.player2 !== null;
  } else if (p.listenP2) listener = w.player2 ?? w.player1;
  else {
    const main = w.mainObject(p.target2);
    listener = main >= 0 ? w.position(main) : null;
  }
  const members = w.members(p.target);
  if (!listener || members.length === 0) return 1;
  const points = (): Iterable<readonly [number, number]> => {
    const out: Array<readonly [number, number]> = [];
    for (const m of members) if (!w.disabled(m)) out.push(w.position(m));
    return out;
  };
  const near = f(3 * p.d1);
  let d = minDistance(listener, points(), near, p.distMode);
  if (alsoPlayer2 && w.player2 && d > near) {
    const d2 = minDistance(w.player2, points(), near, p.distMode);
    if (d > d2) d = d2;
  }
  return proximityVolume(p, d);
}
