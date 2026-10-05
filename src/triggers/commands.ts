// Timed group actions: move, rotate, scale, follow, and the fades that behave
// like them.
//
// All of them are the same shape in the game — one 488-byte struct with a
// duration, an easing curve and a "slot" holding the total the action is worth.
// Each tick the eased *absolute* value is recomputed and only the difference
// from last tick is applied, which is what lets two moves on one group simply
// add up rather than fight. [gdp GroupCommandObject2::updateAction,
// gd-ida-decomp.cpp:716436-716555]

import { easedValue } from "./easing";
import type { KeyframePath } from "./keyframes";

export type CommandKind = "move" | "rotate" | "scale" | "follow" | "followPlayerY" | "alpha" | "aim" | "keyframe";

export interface Command {
  kind: CommandKind;
  /** The group whose objects this acts on. */
  group: number;
  /**
   * Rotate and scale pivot on this group's main object; 0 means "in place".
   * An aim and a dynamic move measure from it instead of their own group.
   */
  centre: number;
  duration: number;
  easing: number;
  easingRate: number;
  /** Seconds since the command started. */
  elapsed: number;
  /**
   * The game does not advance a command's easing clock on the tick it is
   * created, so nothing moves until the tick after the trigger fires and a
   * zero-duration move lands one tick late. [gdp GroupCommandObject2::reset :716879]
   */
  fresh: boolean;
  finished: boolean;
  paused: boolean;
  /** So a Stop trigger can name the triggers that started it rather than the group. */
  controlId: number;
  /** Totals this command is worth, and how much of each has been handed over. */
  dx: number;
  dy: number;
  appliedX: number;
  appliedY: number;
  /** Degrees for rotate, 0..1 progress for scale, alpha and a dynamic move. */
  angle: number;
  appliedAngle: number;
  /** Rotate: leave the objects' own rotation alone and only orbit them. */
  lockRotation: boolean;
  /** Scale targets, reached at progress 1. */
  scaleX: number;
  scaleY: number;
  appliedScaleX: number;
  appliedScaleY: number;
  /** Alpha: where the group's opacity started and where it is going. */
  fromAlpha: number;
  toAlpha: number;
  /** Move: follow the player or the camera on this axis instead of easing. */
  lockPlayerX: boolean;
  lockPlayerY: boolean;
  lockCameraX: boolean;
  lockCameraY: boolean;
  modX: number;
  modY: number;
  /** Follow: the group being followed, and how much of its motion to copy. */
  followGroup: number;
  followModX: number;
  followModY: number;
  /** Follow Player Y: keys 90 speed, 91 delay, 92 offset and 105 max speed. */
  followSpeed: number;
  followDelay: number;
  followOffset: number;
  followMaxSpeed: number;
  /**
   * A Follow or Follow Player Y whose time is up still runs one more step
   * before it goes, as the game's does. [gdp prepareMoveActions :486713-486718]
   */
  lingering: boolean;
  /**
   * Re-read the target every tick instead of working the offset out once. A
   * dynamic move steers toward something that is itself moving; a dynamic
   * rotate keeps pointing at it.
   * [Geode 2.2074 bindings: property 397 m_isDynamicMode, 401 m_rotationTargetID,
   *  402 m_rotationOffset, 403 m_dynamicModeEasing]
   */
  dynamic: boolean;
  /** Aim: degrees added to the angle from the pivot to the target. */
  angleOffset: number;
  /**
   * Keyframe: the path (never changed once made, so copies share it), the
   * pose last handed over, this step's turn and move waiting for their
   * passes, the nodes whose spawn has gone, and the chain it spawns with.
   */
  path: KeyframePath | null;
  poseX: number;
  poseY: number;
  poseRotation: number;
  poseScaleX: number;
  poseScaleY: number;
  dueRotation: number;
  dueX: number;
  dueY: number;
  spawned: readonly number[];
  remap: readonly number[];
  /** The trigger that made it, for the spawn guard. */
  trigger: number;
}

/** FLT_EPSILON, which is what the game divides by when a duration is zero. */
const MIN_DURATION = 1.1920929e-7;

export function newCommand(kind: CommandKind, group: number): Command {
  return {
    kind,
    group,
    centre: 0,
    duration: 0,
    easing: 0,
    easingRate: 2,
    elapsed: 0,
    fresh: true,
    finished: false,
    paused: false,
    controlId: 0,
    dx: 0,
    dy: 0,
    appliedX: 0,
    appliedY: 0,
    angle: 0,
    appliedAngle: 0,
    lockRotation: false,
    scaleX: 1,
    scaleY: 1,
    appliedScaleX: 0,
    appliedScaleY: 0,
    fromAlpha: 1,
    toAlpha: 1,
    lockPlayerX: false,
    lockPlayerY: false,
    lockCameraX: false,
    lockCameraY: false,
    modX: 1,
    modY: 1,
    followGroup: 0,
    followModX: 1,
    followModY: 1,
    followSpeed: 0,
    followDelay: 0,
    followOffset: 0,
    followMaxSpeed: 0,
    lingering: false,
    dynamic: false,
    angleOffset: 0,
    path: null,
    poseX: 0,
    poseY: 0,
    poseRotation: 0,
    poseScaleX: 1,
    poseScaleY: 1,
    dueRotation: 0,
    dueX: 0,
    dueY: 0,
    spawned: [],
    remap: [],
    trigger: -1,
  };
}

/** Progress through the command, eased. */
export function commandProgress(c: Command): number {
  const d = Math.max(c.duration, MIN_DURATION);
  const t = Math.min(1, Math.max(0, c.elapsed / d));
  return easedValue(t, c.easing, c.easingRate);
}

/**
 * Advances the clock and hands back what this tick is worth. The caller applies
 * it, because where it goes depends on the kind.
 */
export function stepCommand(c: Command, dt: number): void {
  if (c.finished || c.paused) return;
  if (c.fresh) c.fresh = false;
  else c.elapsed += dt;
  if (c.duration === -1) return; // a follow with no end
  if (c.elapsed > 0 && c.elapsed >= c.duration) c.finished = true;
}
