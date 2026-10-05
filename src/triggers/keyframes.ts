// Keyframe animations: the path a Keyframe Animation trigger (3033) carries a
// group along, through the Keyframe objects (3032) of one animation.
//
// Each keyframe object is a pose: where it stands, how it is scaled and
// turned, and how long the way on to the next one takes. The trigger turns
// that chain into a list of nodes, each holding the change from the pose
// before it, and every step works out how far along the chain the clock is,
// eases it, and hands the group the difference from the last step. A run of
// keyframes marked as a curve is followed along a natural cubic spline
// through their points, timed by their durations, rather than straight from
// one to the next. A keyframe can also chain onto the one before, so a whole
// stretch shares its first keyframe's time (evenly, or by distance) and its
// easing.
// [gdp GJBaseGameLayer::playKeyframeAnimation :451933-451995 →
//  GJEffectManager::createKeyframeCommand :489789-490244; stepped by
//  GJEffectManager::prepareMoveActions case 5 :486386-486710;
//  KeyframeObject::setupSpline :712205-712286 (tk::spline, natural cubic);
//  KeyframeGameObject::customObjectSetup :300635-300765;
//  KeyframeAnimTriggerObject::customObjectSetup :300464-300556]

import type { LevelObject } from "../level/types";
import { easedValue } from "./easing";

export const KEYFRAME_OBJECT_ID = 3032;
export const KEYFRAME_TRIGGER_ID = 3033;

/** What a Keyframe object (3032) carries. */
export interface KeyframePoint {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotationX: number;
  rotationY: number;
  /** Key 10: seconds on to the next keyframe. */
  duration: number;
  /** Keys 30 and 85 (a rate of 0 or less is 2). */
  easing: number;
  easingRate: number;
  /** Key 375: shares the time and easing of the keyframe before. */
  chain: boolean;
  /** Key 376: the last keyframe leads back to the first. */
  closeLoop: boolean;
  /** Key 378: part of a curve. */
  curve: boolean;
  /** Key 379: how a chained stretch shares its time: 0 by each one's own, 1 evenly, 2 by distance. */
  timeMode: number;
  /** Key 71: the group spawned on arriving here, after key 557 (or 63) seconds. */
  spawnGroup: number;
  spawnDelay: number;
  /** Key 377: spawn at 95% of the way rather than on arrival. */
  spawnEarly: boolean;
  /** Key 536: which way a turn goes the long way round, 1 or 2; 0 the short way. */
  spinDirection: number;
  /** Key 537: whole turns added. */
  spins: number;
}

function num(o: LevelObject, key: number, fallback = 0): number {
  const raw = o.props[key];
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function int(o: LevelObject, key: number): number {
  return Math.trunc(num(o, key));
}

/** The animation a keyframe belongs to (key 373). */
export function keyframeAnimId(o: LevelObject): number {
  return int(o, 373);
}

/** A keyframe's place in its animation (key 374). */
export function keyframeOrder(o: LevelObject): number {
  return int(o, 374);
}

/** [gdp KeyframeGameObject::customObjectSetup :300664-300765] */
export function readKeyframe(o: LevelObject): KeyframePoint {
  const rate = num(o, 85, 2);
  const delay = num(o, 63) !== 0 ? num(o, 63) : num(o, 557);
  return {
    x: o.x,
    y: o.y,
    scaleX: o.scaleX,
    scaleY: o.scaleY,
    rotationX: o.props[131] !== undefined ? num(o, 131) : o.rotation,
    rotationY: o.props[132] !== undefined ? num(o, 132) : o.rotation,
    duration: num(o, 10),
    easing: int(o, 30),
    easingRate: rate > 0 ? rate : 2,
    chain: int(o, 375) !== 0,
    closeLoop: int(o, 376) !== 0,
    curve: int(o, 378) !== 0,
    timeMode: int(o, 379),
    spawnGroup: int(o, 71),
    spawnDelay: delay,
    spawnEarly: int(o, 377) !== 0,
    spinDirection: int(o, 536),
    spins: int(o, 537),
  };
}

/** The trigger's multipliers on the path: time, x, y, turn, scale x, scale y. */
export interface KeyframeMods {
  time: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/**
 * A Keyframe Animation trigger's multipliers (keys 520, 521, 545, 522, 523,
 * 546). An absent key reads 0, except that y and scale y take x's and scale
 * x's when theirs is 0. [gdp KeyframeAnimTriggerObject::customObjectSetup
 * :300482-300555]
 */
export function keyframeMods(props: Record<number, string>): KeyframeMods {
  const f = (key: number): number => {
    const v = Number(props[key] ?? 0);
    return Number.isFinite(v) ? v : 0;
  };
  const x = f(521);
  const scaleX = f(523);
  return {
    time: f(520),
    x,
    y: f(545) !== 0 ? f(545) : x,
    rotation: f(522),
    scaleX,
    scaleY: f(546) !== 0 ? f(546) : scaleX,
  };
}

/** A natural cubic spline through (t, v), straight on past either end, as tk::spline makes one. */
export interface Spline {
  t: Float64Array;
  v: Float64Array;
  b: Float64Array;
  c: Float64Array;
  d: Float64Array;
}

/**
 * tk::spline(t, v, cspline, not monotonic, second derivative 0 at both ends).
 * [gdp KeyframeObject::setupSpline :712275 → tk::spline::spline]
 */
export function naturalSpline(t: readonly number[], v: readonly number[]): Spline {
  const n = t.length;
  const c = new Float64Array(n);
  // The tridiagonal system for c (half the second derivative), with c = 0 at
  // both ends, by the Thomas algorithm.
  if (n > 2) {
    const sub = new Float64Array(n);
    const diag = new Float64Array(n);
    const sup = new Float64Array(n);
    const rhs = new Float64Array(n);
    diag[0] = 2;
    diag[n - 1] = 2;
    for (let i = 1; i < n - 1; i++) {
      sub[i] = (t[i] - t[i - 1]) / 3;
      diag[i] = ((t[i + 1] - t[i - 1]) * 2) / 3;
      sup[i] = (t[i + 1] - t[i]) / 3;
      rhs[i] = (v[i + 1] - v[i]) / (t[i + 1] - t[i]) - (v[i] - v[i - 1]) / (t[i] - t[i - 1]);
    }
    for (let i = 1; i < n; i++) {
      const m = sub[i] / diag[i - 1];
      diag[i] -= m * sup[i - 1];
      rhs[i] -= m * rhs[i - 1];
    }
    c[n - 1] = rhs[n - 1] / diag[n - 1];
    for (let i = n - 2; i >= 0; i--) c[i] = (rhs[i] - sup[i] * c[i + 1]) / diag[i];
  }
  const b = new Float64Array(n);
  const d = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) {
    const h = t[i + 1] - t[i];
    d[i] = (c[i + 1] - c[i]) / (3 * h);
    b[i] = (v[i + 1] - v[i]) / h - ((2 * c[i] + c[i + 1]) * h) / 3;
  }
  if (n > 1) {
    const h = t[n - 1] - t[n - 2];
    b[n - 1] = 3 * d[n - 2] * h * h + 2 * c[n - 2] * h + b[n - 2];
  }
  return { t: Float64Array.from(t), v: Float64Array.from(v), b, c, d };
}

export function evalSpline(s: Spline, x: number): number {
  const n = s.t.length;
  if (x < s.t[0]) {
    const h = x - s.t[0];
    return (s.c[0] * h + s.b[0]) * h + s.v[0];
  }
  if (x > s.t[n - 1]) {
    const h = x - s.t[n - 1];
    return (s.c[n - 1] * h + s.b[n - 1]) * h + s.v[n - 1];
  }
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.t[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  const h = x - s.t[lo];
  return ((s.d[lo] * h + s.c[lo]) * h + s.b[lo]) * h + s.v[lo];
}

/** One keyframe as the command holds it (the game's 336-byte KeyframeObject). */
export interface KeyframeNode {
  /** Seconds on to the next node, after the trigger's time and any chained share (+0). */
  duration: number;
  easing: number;
  easingRate: number;
  /** Shares the time of the node before (+16). */
  chained: boolean;
  /** Spawned on arriving at the next node (+20, +24, +28). */
  spawnGroup: number;
  spawnDelay: number;
  spawnEarly: boolean;
  curve: boolean;
  /** The change from the node before: position (+280), scale (+296, +304) and turn (+312). */
  dx: number;
  dy: number;
  dScaleX: number;
  dScaleY: number;
  dRotation: number;
  /** Where it stands (+288). */
  x: number;
  y: number;
  /** Key 379 (+272). */
  timeMode: number;
  /** A chained stretch's whole time, eased as one, on its first node (+264); 0 elsewhere. */
  groupTime: number;
  /** The curve starting here and how long it lasts (+32, +144, +256). */
  splineX: Spline | null;
  splineY: Spline | null;
  splineTime: number;
}

export interface KeyframePath {
  readonly nodes: readonly KeyframeNode[];
  /** Every node's time but the last one's (+24). */
  readonly duration: number;
}

/**
 * Turns flipped scales into a half turn, so a pose reads as a turn and two
 * positive scales where it can. [gdp normalizeKeyframeValues :474067-474118]
 */
function normalize(v: [number, number, number, number]): void {
  const [, , rx, ry] = v;
  const gap = Math.abs(rx - ry);
  if (gap <= 179.999 || gap >= 180.001) {
    if (v[0] < 0 && v[1] < 0) {
      if (rx <= 0) {
        v[2] = rx + 180;
        v[3] = ry + 180;
      } else {
        v[2] = rx - 180;
        v[3] = ry - 180;
      }
      v[0] = -v[0];
      v[1] = -v[1];
    }
    return;
  }
  if (Math.abs(rx) > Math.abs(ry)) {
    v[2] = rx <= 0 ? rx + 180 : rx - 180;
    v[1] = -v[1];
    return;
  }
  v[3] = ry <= 0 ? ry + 180 : ry - 180;
  v[0] = -v[0];
}

/**
 * The nodes a trigger with these multipliers makes of an animation's
 * keyframes, in order. Null for none.
 * [gdp GJEffectManager::createKeyframeCommand :489905-490244]
 */
export function buildKeyframePath(points: readonly KeyframePoint[], mods: KeyframeMods): KeyframePath | null {
  const n = points.length;
  if (n === 0) return null;
  const timeMod = Math.max(mods.time, 0.0001);
  const nodes: KeyframeNode[] = [];
  let refX = 0;
  let refY = 0;
  let refScaleX = 1;
  let refScaleY = 1;
  let refRotation = 0;
  let prev: KeyframePoint | null = null;
  let prevNode: KeyframeNode | null = null;
  let prevX = 0;
  let prevY = 0;
  let prevScaleX = 1;
  let prevScaleY = 1;
  let prevRotation = 0;
  let closing = false;
  const v: [number, number, number, number] = [1, 1, 0, 0];
  for (let i = 0; i < n; ) {
    const pt = points[i];
    v[0] = pt.scaleX;
    v[1] = pt.scaleY;
    v[2] = pt.rotationX;
    v[3] = pt.rotationY;
    normalize(v);
    let x = pt.x;
    let y = pt.y;
    let sx = v[0];
    let sy = v[1];
    let rotation = v[2];
    if (i !== 0) {
      if (mods.x !== 1) x = Math.fround(refX + Math.fround((x - refX) * mods.x));
      if (mods.y !== 1) y = Math.fround(refY + Math.fround((y - refY) * mods.y));
      if (mods.scaleX !== 1) sx = refScaleX + (sx - refScaleX) * mods.scaleX;
      if (mods.scaleY !== 1) sy = refScaleY + (sy - refScaleY) * mods.scaleY;
      if (mods.rotation !== 1) rotation = refRotation + (rotation - refRotation) * mods.rotation;
      sx /= refScaleX;
      sy /= refScaleY;
    } else {
      refX = x;
      refY = y;
      refRotation = rotation;
      refScaleX = sx;
      refScaleY = sy;
      sx = 1;
      sy = 1;
    }
    const spins = 360 * pt.spins;
    const node: KeyframeNode = {
      duration: timeMod * pt.duration,
      easing: pt.easing,
      easingRate: pt.easingRate,
      chained: false,
      spawnGroup: 0,
      spawnDelay: 0,
      spawnEarly: false,
      curve: pt.curve,
      dx: x,
      dy: y,
      dScaleX: sx,
      dScaleY: sy,
      dRotation: rotation + spins,
      x,
      y,
      timeMode: pt.timeMode,
      groupTime: 0,
      splineX: null,
      splineY: null,
      splineTime: 0,
    };
    if (prev && prevNode && prev.x === pt.x && prev.y === pt.y) prevNode.curve = false;
    const chainable = i !== 0 && (pt.closeLoop || i < n - 1);
    node.chained = pt.chain && chainable;
    if (prev && prevNode) {
      node.dx = Math.fround(x - prevX);
      node.dy = Math.fround(y - prevY);
      node.dScaleX = sx - prevScaleX;
      node.dScaleY = sy - prevScaleY;
      const turn = rotation + spins - prevRotation;
      const short = turn - spins;
      node.dRotation = turn;
      if (short > 180 || (short > 0 && pt.spinDirection === 2)) node.dRotation = turn - 360;
      else if (short < -180 || (short < 0 && pt.spinDirection === 1)) node.dRotation = turn + 360;
      prevNode.spawnGroup = pt.spawnGroup;
      prevNode.spawnEarly = pt.spawnEarly;
      prevNode.spawnDelay = pt.spawnDelay;
    }
    nodes.push(node);
    prevX = x;
    prevY = y;
    prevScaleX = sx;
    prevScaleY = sy;
    prevRotation = rotation;
    prev = pt;
    prevNode = node;
    if (closing) break;
    if (i === n - 1 && pt.closeLoop) {
      closing = true;
      i = 0;
    } else {
      i++;
    }
  }
  shareChainedTime(nodes);
  let duration = 0;
  for (let k = 0; k < nodes.length - 1; k++) duration += nodes[k].duration;
  setupSplines(nodes);
  return { nodes, duration };
}

/**
 * A chained stretch shares its first node's time: each node keeps its own
 * (mode 0), or gets an even share (1) or a share by the distance it covers
 * (2). With easing, the first node eases the whole stretch as one.
 * [gdp createKeyframeCommand :490120-490191]
 */
function shareChainedTime(nodes: KeyframeNode[]): void {
  let anchor: KeyframeNode | null = null;
  let list: KeyframeNode[] = [];
  let extra = 0;
  for (const node of nodes) {
    if (node.chained) {
      if (list.length === 0 && anchor) list.push(anchor);
      list.push(node);
      extra += node.duration;
      continue;
    }
    if (list.length > 0 && anchor) {
      list.push(node);
      const total = anchor.duration;
      const shares = list.length - 1;
      if (anchor.timeMode === 1) {
        for (let k = 0; k < shares; k++) list[k].duration = total / shares;
        extra = 0;
      } else if (anchor.timeMode === 2) {
        let sum = 0;
        const dist: number[] = [];
        for (let k = 0; k < shares; k++) {
          const d = Math.fround(Math.hypot(list[k + 1].x - list[k].x, list[k + 1].y - list[k].y));
          dist.push(d);
          sum += d;
        }
        for (let k = 0; k < shares; k++) list[k].duration = sum === 0 ? total / shares : (dist[k] / sum) * total;
        extra = 0;
      }
      if (anchor.easing > 0) anchor.groupTime = total + extra;
    }
    extra = 0;
    anchor = node;
    list = [];
  }
}

/**
 * Each run of curve nodes, with the node that ends it, becomes one spline
 * through their points, timed by their durations; a run of one is no curve.
 * [gdp createKeyframeCommand :490203-490240; KeyframeObject::setupSpline
 * :712232-712283]
 */
function setupSplines(nodes: KeyframeNode[]): void {
  const last = nodes.length - 1;
  let run: number[] = [];
  for (let k = 0; k <= last; k++) {
    if (nodes[k].curve && k < last) {
      run.push(k);
      continue;
    }
    if (run.length === 0) continue;
    if (run.length <= 1) {
      for (const r of run) nodes[r].curve = false;
    } else {
      run.push(k);
      const t = [0];
      const xs = [0];
      const ys = [0];
      for (let j = 1; j < run.length; j++) {
        const node = nodes[run[j]];
        xs.push(xs[j - 1] + node.dx);
        ys.push(ys[j - 1] + node.dy);
        const d = nodes[run[j - 1]].duration;
        t.push(t[j - 1] + (d <= 0.00001 ? 0.00001 : d));
      }
      const first = nodes[run[0]];
      first.splineX = naturalSpline(t, xs);
      first.splineY = naturalSpline(t, ys);
      first.splineTime = t[t.length - 1];
    }
    run = [];
  }
}

/** Where a path has carried its group by some time, from where it began. */
export interface KeyframePose {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

/**
 * The pose `elapsed` seconds in, and the nodes whose spawn is due (`arrived`
 * gets each node index once, and is told which ones have already gone).
 * [gdp GJEffectManager::prepareMoveActions :486386-486586]
 */
export function keyframePose(
  path: KeyframePath,
  elapsed: number,
  out: KeyframePose,
  spawned: (node: number) => boolean,
  arrived: (node: number) => void,
): KeyframePose {
  const nodes = path.nodes;
  const segments = nodes.length - 1;
  // Which node the eased clock is in, how far into it, and the eased clock.
  let local = elapsed;
  let clock = 0;
  let current: KeyframeNode | null = null;
  for (let k = 0; k < segments; k++) {
    const node = nodes[k];
    current = node;
    if (node.groupTime > 0 && local < node.groupTime) {
      local = easedValue(local / node.groupTime, node.easing, node.easingRate) * node.groupTime;
    }
    if (local < node.duration || k === segments - 1) {
      clock += local;
      break;
    }
    local -= node.duration;
    clock += node.duration;
  }
  let x = 0;
  let y = 0;
  let scaleX = 1;
  let scaleY = 1;
  let rotation = 0;
  let onSpline = false;
  for (let k = 0; k < segments; k++) {
    const node = nodes[k];
    const next = nodes[k + 1];
    let early = false;
    if (node.splineX && node.splineY && node.splineTime > 0 && clock < node.splineTime) {
      let at = clock;
      if (current && !(local >= current.duration || current.easing <= 0 || current.chained) && current.groupTime <= 0) {
        const eased = easedValue(local / current.duration, current.easing, current.easingRate);
        at = clock - local + eased * current.duration;
        early = current.spawnEarly && eased > 0.95;
      }
      x += evalSpline(node.splineX, at);
      y += evalSpline(node.splineY, at);
      onSpline = true;
    }
    const lastOpen = k === segments - 1 && elapsed < path.duration;
    let f: number;
    if (clock >= node.duration && !lastOpen) {
      f = 1;
      if (node.spawnGroup > 0 && !spawned(k)) arrived(k);
    } else {
      f = clock / node.duration;
      if (node.easing > 0 && !node.chained && node.groupTime <= 0) f = easedValue(f, node.easing, node.easingRate);
      if (((node.spawnEarly && f > 0.95) || early) && node.spawnGroup > 0 && !spawned(k)) arrived(k);
    }
    if (!onSpline) {
      x += f * next.dx;
      y += f * next.dy;
    }
    scaleX += f * next.dScaleX;
    scaleY += f * next.dScaleY;
    rotation += f * next.dRotation;
    if (clock < node.duration) break;
    clock -= node.duration;
  }
  out.x = x;
  out.y = y;
  out.scaleX = scaleX;
  out.scaleY = scaleY;
  out.rotation = rotation;
  return out;
}
