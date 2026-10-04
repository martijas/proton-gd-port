// Headless autoplayer: layered beam search over the deterministic Sim, with
// snapshot-backed backtracking (see research_bot-design.md). Its job is to be a
// test oracle: either it completes a level, or it reports exactly which object
// killed its best attempt and where, so hitbox/physics bugs are visible.
//
// Also home to the pcgd-macro JSON format (a GDR superset) and its replay,
// which the regression suite uses to detect physics drift without searching.

import type { GameMode, LevelObject } from "../src/level/types";
import type {
  ObjectKind,
  PlayerInput,
  PlayerState,
  Rect,
  Sim,
  SimSnapshot,
  WorldShape,
} from "../src/physics/types";
import { NO_INPUT } from "../src/physics/types";
import * as PHYSICS from "../src/physics/constants";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BotConfig {
  /** Beam width; doubled on every dead end up to `maxW`. */
  W: number;
  /** Decision window in ticks; halved on every dead end down to 1. */
  D: number;
  /** Coasting lookahead length in ticks, only run for nodes in danger. */
  N: number;
  maxTicks: number;
  maxWallMs: number;
  maxW: number;
  /** Backoff ladder stops once the next step would exceed this many ticks. */
  maxBackoff: number;
  checkpointEvery: number;
  ringSize: number;
  /** Max nodes kept per 5-unit y bucket so the beam does not collapse onto one trajectory. */
  diversityCap: number;
  /** Clearance below which the coasting lookahead is worth its cost. */
  dangerClearance: number;
  /** Clearance above which more clearance no longer improves a node. Keeps the search out of open sky. */
  safeClearance: number;
  /** How far above the level a node may float before it starts paying for it (units). */
  aboveLevelSlack: number;
  /** How far ahead (units) the static clearance scan looks. */
  lookaheadUnits: number;
  /**
   * At a dead end with a new furthest death, the search first reopens from
   * that death's own line at least this many ticks back, alone, before the
   * widening ladder. A narrow passage can need one exact line that a full
   * beam keeps pruning. 0 turns it off.
   */
  focusBack: number;
  /**
   * Past this x, a node that is still mini is dropped. For a level whose end
   * can only be finished at full size, where the search would otherwise skip
   * the size portal and walk into a dead end it cannot back out of.
   */
  normalSizeAfter?: number;
  log?: (message: string) => void;
  /** Called at each dead end with the inputs of the furthest death so far. */
  onDeadEnd?: (inputs: MacroInput[]) => void;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  W: 256,
  D: 4,
  N: 24,
  maxTicks: 40e6,
  maxWallMs: 90_000,
  maxW: 4096,
  maxBackoff: 1920,
  checkpointEvery: 60,
  ringSize: 16,
  diversityCap: 4,
  dangerClearance: 6,
  safeClearance: 6,
  aboveLevelSlack: 300,
  lookaheadUnits: 90,
  focusBack: 120,
};

/** GDR input event: `frame` is the tick the input first applies to. */
export interface MacroInput {
  frame: number;
  /** 1 = jump, 2 = left, 3 = right (GDR button ids). */
  button: 1 | 2 | 3;
  player2: boolean;
  down: boolean;
}

export interface TracePoint {
  tick: number;
  x: number;
  y: number;
  yVel: number;
  held: boolean;
  onGround: boolean;
  mode: GameMode;
}

export interface Killer {
  index: number;
  id: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  kind: ObjectKind;
  shape: WorldShape | null;
}

export interface NearMiss {
  index: number;
  id: number;
  kind: ObjectKind;
  /** Closest approach (units) over the traced ticks; 0 = touching. */
  distance: number;
  shape: WorldShape | null;
}

export interface Furthest {
  tick: number;
  x: number;
  y: number;
  mode: GameMode;
  held: boolean;
}

export interface DeathReport {
  furthest: Furthest;
  bestX: number;
  bestPercent: number;
  killer: Killer | null;
  playerRect: Rect | null;
  trace: TracePoint[];
  nearMisses: NearMiss[];
}

export interface SolveResult extends DeathReport {
  completed: boolean;
  /** Tick of the finish, or of the furthest death. */
  ticks: number;
  inputs: MacroInput[];
  simTicksUsed: number;
  wallMs: number;
  stopReason: "completed" | "dead end" | "tick budget" | "wall clock";
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const RELEASE: PlayerInput = NO_INPUT;
const HOLD: PlayerInput = Object.freeze({ jump: true, left: false, right: false });
export const CLASSIC_BRANCHES: readonly PlayerInput[] = [RELEASE, HOLD];
export const PLATFORMER_BRANCHES: readonly PlayerInput[] = [
  RELEASE,
  HOLD,
  Object.freeze({ jump: false, left: true, right: false }),
  Object.freeze({ jump: true, left: true, right: false }),
  Object.freeze({ jump: false, left: false, right: true }),
  Object.freeze({ jump: true, left: false, right: true }),
];

const BUTTONS: ReadonlyArray<{ key: "jump" | "left" | "right"; button: 1 | 2 | 3 }> = [
  { key: "jump", button: 1 },
  { key: "left", button: 2 },
  { key: "right", button: 3 },
];

export function inputEvents(prev: PlayerInput, next: PlayerInput, frame: number): MacroInput[] | null {
  let out: MacroInput[] | null = null;
  for (const { key, button } of BUTTONS) {
    if (prev[key] === next[key]) continue;
    (out ??= []).push({ frame, button, player2: false, down: next[key] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry helpers (AABB approximations are fine: this only ranks nodes)
// ---------------------------------------------------------------------------

interface Shape {
  hazard: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  circle: { cx: number; cy: number; r: number } | null;
}

function toShape(w: WorldShape, hazard: boolean): Shape {
  if (w.type === "circle") {
    return {
      hazard,
      x0: w.cx - w.r,
      y0: w.cy - w.r,
      x1: w.cx + w.r,
      y1: w.cy + w.r,
      circle: { cx: w.cx, cy: w.cy, r: w.r },
    };
  }
  if (w.type === "triangle") {
    return {
      hazard,
      x0: Math.min(w.ax, w.bx, w.cx),
      y0: Math.min(w.ay, w.by, w.cy),
      x1: Math.max(w.ax, w.bx, w.cx),
      y1: Math.max(w.ay, w.by, w.cy),
      circle: null,
    };
  }
  const { rect, rotation } = w;
  if (rotation % 180 === 0) {
    return { hazard, x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h, circle: null };
  }
  // Extents of a rotated box: |hw cos| + |hh sin| works for either rotation sign.
  const rad = (rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  const cx = rect.x + hw;
  const cy = rect.y + hh;
  const ex = hw * c + hh * s;
  const ey = hw * s + hh * c;
  return { hazard, x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey, circle: null };
}

function rectToAabbDistance(r: Rect, s: Shape): number {
  const dx = Math.max(s.x0 - (r.x + r.w), r.x - s.x1, 0);
  const dy = Math.max(s.y0 - (r.y + r.h), r.y - s.y1, 0);
  return Math.hypot(dx, dy);
}

function rectToShapeDistance(r: Rect, s: Shape): number {
  if (!s.circle) return rectToAabbDistance(r, s);
  const px = Math.min(Math.max(s.circle.cx, r.x), r.x + r.w);
  const py = Math.min(Math.max(s.circle.cy, r.y), r.y + r.h);
  return Math.max(0, Math.hypot(px - s.circle.cx, py - s.circle.cy) - s.circle.r);
}

function isHazardKind(kind: ObjectKind): boolean {
  return kind === "hazard";
}

/** The End trigger, which the platformer guide aims at. */
const END_TRIGGER_ID = 3600;

function isSolidKind(kind: ObjectKind): boolean {
  return kind === "solid" || kind === "slope";
}

/**
 * Static clearance: nearest hazard (2D) or side-on solid (horizontal, ahead)
 * within the next `lookahead` units, precomputed per 30-unit column the first
 * time a column is looked at. Solids whose top is within the snap threshold of
 * the player's feet are steps, not walls, so the player rect is shrunk on the
 * gravity side before the solid test — otherwise standing on the ground would
 * read as clearance 0 and every node would pay for a lookahead.
 */
export class ClearanceIndex {
  private readonly columns = new Map<number, Shape[]>();

  constructor(
    private readonly sim: Sim,
    private readonly lookahead: number,
  ) {}

  private column(c: number): Shape[] {
    const cached = this.columns.get(c);
    if (cached) return cached;
    const list: Shape[] = [];
    for (const o of this.sim.query(c * 30, -1e6, c * 30 + 30, 1e6)) {
      const kind = this.sim.objects.get(o.id).kind;
      const hazard = isHazardKind(kind);
      if (!hazard && !isSolidKind(kind)) continue;
      const shape = this.sim.hitboxOf(o.index);
      if (!shape) continue;
      list.push(toShape(shape, hazard));
    }
    this.columns.set(c, list);
    return list;
  }

  /**
   * The top of the level near `x`: the highest solid or hazard in the columns
   * around it, or null where the level has nothing at all.
   *
   * The search needs this because climbing is free. Every node advances in x at
   * the same rate whatever its height, and a node in empty sky meets no hazard,
   * so sky nodes out-survive every node actually playing the level and the beam
   * fills with them. That is how eight levels came to be "solved" from
   * thousands of units above their own geometry.
   */
  topNear(x: number): number {
    const c0 = Math.floor((x - 60) / 30);
    const c1 = Math.floor((x + 60) / 30);
    let top = -Infinity;
    for (let c = c0; c <= c1; c++) for (const s of this.column(c)) if (s.y1 > top) top = s.y1;
    // Over a gap there is nothing nearby to measure against, so fall back to
    // the level's own highest point. Without the fallback a node floating over
    // a gap paid nothing, which is exactly where the search used to escape.
    return top === -Infinity ? this.levelTop() : top;
  }

  private levelTopCache: number | null = null;

  /** The highest solid or hazard anywhere in the level. */
  private levelTop(): number {
    if (this.levelTopCache !== null) return this.levelTopCache;
    let top = 0;
    for (const o of this.sim.level.objects) if (o.y > top) top = o.y;
    this.levelTopCache = top;
    return top;
  }

  clearance(rect: Rect, st: PlayerState): number {
    const forward = st.reversed ? -1 : 1;
    const x0 = rect.x;
    const x1 = rect.x + rect.w;
    const scanX0 = forward > 0 ? x0 : x0 - this.lookahead;
    const scanX1 = forward > 0 ? x1 + this.lookahead : x1;
    let sy0 = rect.y;
    let sy1 = rect.y + rect.h;
    if (st.flipped) sy1 -= PHYSICS.SNAP_THRESHOLD;
    else sy0 += PHYSICS.SNAP_THRESHOLD;
    let best = this.lookahead;
    const from = Math.floor(scanX0 / 30);
    const to = Math.floor(scanX1 / 30);
    for (let c = from; c <= to; c++) {
      for (const s of this.column(c)) {
        let d: number;
        if (s.hazard) {
          d = rectToShapeDistance(rect, s);
        } else {
          if (s.y1 <= sy0 || s.y0 >= sy1) continue;
          d = forward > 0 ? s.x0 - x1 : x0 - s.x1;
          if (d < 0) {
            if (s.x1 <= x0 || s.x0 >= x1) continue; // fully behind
            d = 0;
          }
        }
        if (d < best) best = d;
      }
    }
    return best;
  }
}

/**
 * Platformer levels have no x-is-a-clock property, so progress is the BFS
 * distance to whatever ends the level, over a 30-unit grid of open cells.
 *
 * The goal is the thing the player has to reach, not the End trigger itself:
 * an End is usually spawned by a touch trigger somewhere else, so the chain
 * of spawns is walked back to the touch triggers (or orbs) that start it. A
 * teleport is a one-way edge from whatever fires it to where it lands. The
 * grid covers the level's solids and hazards only — triggers parked far below
 * the floor must not open a corridor under the level — and blocks that are
 * one-way, or in a group a toggle switches off or a trigger moves, count as
 * open. Rising is only allowed within a jump (or a pad's throw) of something
 * to stand on, so the guide does not lead up an empty shaft.
 */
export class PlatformerGuide {
  private readonly cell = 30;
  private readonly minCx: number;
  private readonly minCy: number;
  private readonly w: number;
  private readonly h: number;
  /** Steps to the goal rising only within a jump of a floor; -1 where that cannot reach. */
  private readonly dist: Int32Array;
  private readonly maxDist: number;
  /**
   * Steps to the goal rising anywhere, for the cells `dist` cannot reach: a
   * lift, a key or a switch it does not know of may be the way on.
   */
  private readonly looseDist: Int32Array;
  private readonly looseMax: number;
  /** How many cells the goals and teleport edges were placed on, for the log. */
  readonly goalCount: number;
  readonly teleportCount: number;

  constructor(sim: Sim) {
    const objs = sim.level.objects;
    const trig = sim.triggers;
    const index = trig.index;
    // A group a toggle switches off is a door: open. A group a trigger moves,
    // spins or carries is a lift, a wheel or a sliding door: never a wall,
    // but a floor wherever its Move triggers can take it, since the route may
    // ride it — a lift's whole shaft is a ladder.
    const switched = new Set<number>();
    const moved = index.movingGroups;
    const remapsTo = new Map<number, number[]>();
    for (const spec of index.byObject.values()) {
      if (spec.target > 0 && spec.id === 1049 && !spec.activateGroup) switched.add(spec.target);
      const list = objs[spec.index].props[442];
      if (!list) continue;
      const parts = list.split(".").map((v) => Math.trunc(Number(v)));
      for (let k = 0; k + 1 < parts.length; k += 2) {
        const to = remapsTo.get(parts[k]);
        if (to) to.push(parts[k + 1]);
        else remapsTo.set(parts[k], [parts[k + 1]]);
      }
    }
    // Per group, how far its Move triggers can carry it each way: [-x, +x, -y, +y].
    const reach = new Map<number, [number, number, number, number]>();
    for (const spec of index.byObject.values()) {
      if (spec.id !== 901 || spec.target <= 0) continue;
      const props = objs[spec.index].props;
      if (props[100] === "1") continue;
      const dx = Number(props[28] ?? 0) || 0;
      const dy = Number(props[29] ?? 0) || 0;
      for (const g of [spec.target, ...(remapsTo.get(spec.target) ?? [])]) {
        const r = reach.get(g) ?? [0, 0, 0, 0];
        if (dx < 0) r[0] += dx;
        else r[1] += dx;
        if (dy < 0) r[2] += dy;
        else r[3] += dy;
        reach.set(g, r);
      }
    }
    const MAX_SWEEP = 3000;
    const swept = (s: Shape, groups: readonly number[]): Shape => {
      let [x0, x1, y0, y1] = [s.x0, s.x1, s.y0, s.y1];
      for (const g of groups) {
        const r = reach.get(g);
        if (!r) continue;
        x0 += Math.max(r[0], -MAX_SWEEP);
        x1 += Math.min(r[1], MAX_SWEEP);
        y0 += Math.max(r[2], -MAX_SWEEP);
        y1 += Math.min(r[3], MAX_SWEEP);
      }
      return { ...s, x0, x1, y0, y1 };
    };
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const walls: Shape[] = [];
    const floors: Shape[] = [];
    const boosts: { x: number; y: number; pad: boolean }[] = [];
    for (const o of objs) {
      const def = sim.objects.get(o.id);
      if (def.kind === "pad" || def.kind === "orb") {
        boosts.push({ x: o.x, y: o.y, pad: def.kind === "pad" });
        continue;
      }
      const shape = sim.hitboxOf(o.index);
      if (!shape || !(isSolidKind(def.kind) || isHazardKind(def.kind))) continue;
      const s = toShape(shape, false);
      if (s.x0 < minX) minX = s.x0;
      if (s.x1 > maxX) maxX = s.x1;
      if (s.y0 < minY) minY = s.y0;
      if (s.y1 > maxY) maxY = s.y1;
      if (o.groups.some((g) => switched.has(g))) continue;
      // A one-way block can be stood on but not run into.
      if (o.groups.some((g) => moved.has(g))) {
        if (isSolidKind(def.kind)) floors.push(swept(s, o.groups));
        continue;
      }
      if (def.passable || o.props[134] === "1") {
        if (isSolidKind(def.kind)) floors.push(s);
        continue;
      }
      walls.push(s);
      if (isSolidKind(def.kind)) floors.push(s);
    }
    if (minX === Infinity) {
      minX = 0;
      maxX = sim.level.lengthUnits;
      minY = 0;
      maxY = 300;
    }
    this.minCx = Math.floor(minX / this.cell);
    this.minCy = Math.floor(minY / this.cell);
    this.w = Math.floor(maxX / this.cell) + 1 - this.minCx;
    // Room above the highest block to jump into.
    this.h = Math.floor(maxY / this.cell) + 4 - this.minCy;
    const n = this.w * this.h;
    this.dist = new Int32Array(n).fill(-1);
    this.looseDist = this.dist;
    this.goalCount = 0;
    this.teleportCount = 0;
    if (n > 4e6) {
      this.maxDist = 0;
      this.looseMax = 0;
      return;
    }
    const blocked = new Uint8Array(n);
    const floor = new Uint8Array(n);
    const fill = (shapes: Shape[], into: Uint8Array) => {
      for (const s of shapes) {
        const cx0 = Math.floor((s.x0 + 1) / this.cell);
        const cx1 = Math.floor((s.x1 - 1) / this.cell);
        const cy0 = Math.floor((s.y0 + 1) / this.cell);
        const cy1 = Math.floor((s.y1 - 1) / this.cell);
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const idx = this.cellIndex(cx, cy);
            if (idx >= 0) into[idx] = 1;
          }
        }
      }
    };
    fill(walls, blocked);
    fill(floors, floor);
    const boost = new Uint8Array(n);
    for (const b of boosts) {
      const idx = this.indexOf(b.x, b.y);
      if (idx >= 0) boost[idx] = b.pad ? 2 : 1;
    }

    // Who fires each group: spawn-style triggers by their target, and any
    // non-trigger object (an orb, a pad) that names a group in key 51.
    const firedBy = new Map<number, number[]>();
    const addFire = (g: number, i: number) => {
      if (g <= 0) return;
      const list = firedBy.get(g);
      if (list) list.push(i);
      else firedBy.set(g, [i]);
    };
    const firesOf = (i: number): number[] => {
      const spec = index.byObject.get(i);
      if (spec) {
        if (spec.id === 1268 || spec.id === 3607 || (spec.id === 1049 && spec.activateGroup)) return [spec.target];
        if (spec.id === 1912) return [spec.target, spec.target2];
        return [];
      }
      const g = Number(objs[i].props[51] ?? 0);
      return g > 0 ? [g] : [];
    };
    for (let i = 0; i < objs.length; i++) for (const g of firesOf(i)) addFire(g, i);
    /** What the player touches or passes to set object `i` off, walking spawns back. */
    const startersOf = (i: number, out: Set<number>, depth: number): void => {
      const spec = index.byObject.get(i);
      if (!spec || !spec.spawnTriggered || depth > 8) {
        out.add(i);
        return;
      }
      for (const g of objs[i].groups) for (const j of firedBy.get(g) ?? []) if (j !== i) startersOf(j, out, depth + 1);
    };

    const goals: number[] = [];
    const starters = new Set<number>();
    for (const o of objs) if (o.id === END_TRIGGER_ID) startersOf(o.index, starters, 0);
    for (const i of starters) {
      const idx = this.indexOf(objs[i].x, objs[i].y);
      if (idx >= 0) goals.push(idx);
    }

    // Teleports: from each starter cell to the landing cell, walked forward.
    const landsFrom = new Map<number, number[]>();
    let teleports = 0;
    for (const spec of index.byObject.values()) {
      if (spec.id !== 3022) continue;
      const from = new Set<number>();
      startersOf(spec.index, from, 0);
      const t = trig.portalTarget(spec.target);
      if (t < 0) continue;
      const to = this.indexOf(objs[t].x, objs[t].y);
      if (to < 0) continue;
      for (const f of from) {
        const src = this.indexOf(objs[f].x, objs[f].y);
        if (src < 0) continue;
        const list = landsFrom.get(to);
        if (list) list.push(src);
        else landsFrom.set(to, [src]);
        teleports++;
      }
    }
    this.goalCount = goals.length;
    this.teleportCount = teleports;

    if (goals.length === 0) {
      // No end trigger: the far right edge is the goal, like classic levels.
      for (let cy = 0; cy < this.h; cy++) goals.push(cy * this.w + (this.w - 1));
    }
    const climbable = this.climbable(blocked, floor, boost);
    this.maxDist = this.search(this.dist, goals, blocked, climbable, landsFrom);
    this.looseDist = new Int32Array(n).fill(-1);
    this.looseMax = this.search(this.looseDist, goals, blocked, null, landsFrom);
  }

  /**
   * Fills `dist` back from the goals: the cells that move into each one are
   * those beside it, the one above it (falling), the one below it when it may
   * be risen into — within a jump of something to stand on, or anywhere when
   * `climbable` is null — and the teleports landing in it. Returns the largest.
   */
  private search(dist: Int32Array, goals: number[], blocked: Uint8Array, climbable: Uint8Array | null, landsFrom: Map<number, number[]>): number {
    const queue: number[] = [];
    for (const g of goals) {
      if (dist[g] !== -1) continue;
      dist[g] = 0;
      queue.push(g);
    }
    let head = 0;
    let maxDist = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const d = dist[idx] + 1;
      const cx = idx % this.w;
      const cy = (idx - cx) / this.w;
      const neighbours = [
        cx > 0 ? idx - 1 : -1,
        cx < this.w - 1 ? idx + 1 : -1,
        cy > 0 && (!climbable || climbable[idx]) ? idx - this.w : -1,
        cy < this.h - 1 ? idx + this.w : -1,
        ...(landsFrom.get(idx) ?? []),
      ];
      for (const nb of neighbours) {
        if (nb < 0 || blocked[nb] || dist[nb] !== -1) continue;
        dist[nb] = d;
        if (d > maxDist) maxDist = d;
        queue.push(nb);
      }
    }
    return maxDist;
  }

  private cellIndex(cx: number, cy: number): number {
    const ix = cx - this.minCx;
    const iy = cy - this.minCy;
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return -1;
    return iy * this.w + ix;
  }

  private indexOf(x: number, y: number): number {
    return this.cellIndex(Math.floor(x / this.cell), Math.floor(y / this.cell));
  }

  /** Cells a jump from the ground rises; a cube's is 64 units. */
  private static readonly RISE = 3;
  /** Cells a pad throws the player. */
  private static readonly PAD_RISE = 6;
  /**
   * Which cells a player can rise into: those with something to stand on, or
   * an orb, within a jump below — in its own column or the next one over,
   * with nothing solid in between — and those within a pad's throw of a pad.
   */
  private climbable(blocked: Uint8Array, floor: Uint8Array, boost: Uint8Array): Uint8Array {
    const w = this.w;
    const n = w * this.h;
    // The ground's top is level y 0; the row just above it stands on it.
    const groundRow = -this.minCy;
    const support = new Uint8Array(n);
    for (let c = 0; c < n; c++) {
      if (blocked[c]) continue;
      const row = (c / w) | 0;
      if (boost[c] === 2) support[c] = PlatformerGuide.PAD_RISE;
      else if ((row > 0 && floor[c - w]) || row === groundRow || boost[c] === 1) support[c] = PlatformerGuide.RISE;
    }
    const out = new Uint8Array(n);
    for (let c = 0; c < n; c++) {
      if (blocked[c]) continue;
      const cx = c % w;
      found: for (let dx = -1; dx <= 1; dx++) {
        if (cx + dx < 0 || cx + dx >= w) continue;
        for (let k = 1; k <= PlatformerGuide.PAD_RISE; k++) {
          const p = c + dx - k * w;
          if (p < 0 || blocked[p]) break;
          if (support[p] >= k) {
            out[c] = 1;
            break found;
          }
        }
      }
    }
    return out;
  }

  /** Larger is closer to the goal; one cell of progress outweighs any clearance score. */
  progressScore(st: PlayerState): number {
    const idx = this.indexOf(st.x, st.y);
    if (idx < 0) return 0;
    // Any cell the strict search reaches outranks every one only the loose one does.
    if (this.dist[idx] >= 0) return (this.looseMax + 2 + this.maxDist - this.dist[idx]) * 2000;
    if (this.looseDist[idx] >= 0) return (this.looseMax + 1 - this.looseDist[idx]) * 2000;
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Death / finish reporting
// ---------------------------------------------------------------------------

function describeKiller(sim: Sim, index: number | null): Killer | null {
  if (index === null || index < 0 || index >= sim.level.objects.length) return null;
  const o: LevelObject = sim.level.objects[index];
  return {
    index,
    id: o.id,
    x: o.x,
    y: o.y,
    rotation: o.rotation,
    scaleX: o.scaleX,
    scaleY: o.scaleY,
    kind: sim.objects.get(o.id).kind,
    shape: sim.hitboxOf(index),
  };
}

export interface PlanStep {
  input: PlayerInput;
  ticks: number;
}

export interface TraceCapture {
  trace: TracePoint[];
  nearMisses: NearMiss[];
}

const TRACE_TICKS = 16;
const NEAR_MISS_DISTANCE = 2;

/**
 * Restores `snap`, re-steps `plan` and records the player for the last
 * `keep` ticks, plus every hazard/solid whose hitbox came within 2 units of
 * the player rect during those ticks (the killer excluded by the caller).
 */
export function captureTrace(sim: Sim, snap: SimSnapshot, plan: PlanStep[], keep = TRACE_TICKS): TraceCapture {
  sim.restore(snap);
  let total = 0;
  for (const p of plan) total += p.ticks;
  const trace: TracePoint[] = [];
  const near = new Map<number, NearMiss>();
  let done = 0;
  outer: for (const p of plan) {
    for (let k = 0; k < p.ticks; k++) {
      sim.step(p.input, p.input);
      done++;
      const st = sim.state;
      if (total - done < keep) {
        trace.push({
          tick: sim.tick,
          x: st.x,
          y: st.y,
          yVel: st.yVel,
          held: p.input.jump,
          onGround: st.onGround,
          mode: st.mode,
        });
        const r = sim.playerRect();
        const m = NEAR_MISS_DISTANCE;
        for (const o of sim.query(r.x - m, r.y - m, r.x + r.w + m, r.y + r.h + m)) {
          const kind = sim.objects.get(o.id).kind;
          if (!isHazardKind(kind) && !isSolidKind(kind)) continue;
          const shape = sim.hitboxOf(o.index);
          if (!shape) continue;
          const d = rectToShapeDistance(r, toShape(shape, isHazardKind(kind)));
          if (d > m) continue;
          const prev = near.get(o.index);
          if (!prev || d < prev.distance) near.set(o.index, { index: o.index, id: o.id, kind, distance: d, shape });
        }
      }
      if (st.dead || st.finished) break outer;
    }
  }
  return { trace, nearMisses: [...near.values()].sort((a, b) => a.distance - b.distance) };
}

export function reportFromState(sim: Sim, held: boolean, capture: TraceCapture): DeathReport {
  const st = sim.state;
  const killer = describeKiller(sim, st.killedBy);
  return {
    furthest: { tick: sim.tick, x: st.x, y: st.y, mode: st.mode, held },
    bestX: st.x,
    bestPercent: sim.progress() * 100,
    killer,
    playerRect: sim.playerRect(),
    trace: capture.trace,
    nearMisses: killer ? capture.nearMisses.filter((n) => n.index !== killer.index) : capture.nearMisses,
  };
}

function shapeText(s: WorldShape | null): string {
  if (!s) return "no hitbox";
  if (s.type === "circle") return `circle r${fmt(s.r)} @ (${fmt(s.cx)},${fmt(s.cy)})`;
  if (s.type === "triangle")
    return `tri (${fmt(s.ax)},${fmt(s.ay)}) (${fmt(s.bx)},${fmt(s.by)}) (${fmt(s.cx)},${fmt(s.cy)})`;
  const r = s.rect;
  return `rect [${fmt(r.x)},${fmt(r.y)} ${fmt(r.w)}×${fmt(r.h)}]${s.rotation ? ` rot ${fmt(s.rotation)}` : ""}`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** One-line summary, plus the trace and near misses when `verbose`. */
export function formatReport(name: string, r: SolveResult, verbose = false): string {
  const lines: string[] = [];
  const cost = `${(r.simTicksUsed / 1e6).toFixed(1)}M sim ticks, ${(r.wallMs / 1000).toFixed(1)}s`;
  if (r.completed) {
    lines.push(`${name} 100% — completed at tick ${r.ticks} (${r.inputs.length} inputs, ${cost})`);
  } else {
    const f = r.furthest;
    const who = r.killer
      ? `killed at tick ${f.tick} by ${r.killer.kind} #${r.killer.index} (obj ${r.killer.id}) at (${fmt(r.killer.x)},${fmt(r.killer.y)})` +
        (r.killer.rotation ? ` rot ${fmt(r.killer.rotation)}` : "") +
        (r.killer.scaleX !== 1 || r.killer.scaleY !== 1 ? ` scale ${fmt(r.killer.scaleX)}×${fmt(r.killer.scaleY)}` : "") +
        ` hitbox ${shapeText(r.killer.shape)}`
      : `stopped at tick ${f.tick} (${r.stopReason})`;
    const pr = r.playerRect ? `rect [${fmt(r.playerRect.x)},${fmt(r.playerRect.y)} ${fmt(r.playerRect.w)}×${fmt(r.playerRect.h)}]` : "";
    // A replay has no search cost to report (wallMs 0).
    const tail = r.wallMs > 0 ? `; ${r.stopReason}, ${cost}` : "";
    lines.push(
      `${name} ${r.bestPercent.toFixed(1)}% — ${who}; player ${f.mode}${f.held ? " holding" : ""} at (${fmt(f.x)},${fmt(f.y)}) ${pr}${tail}`,
    );
  }
  if (verbose) {
    for (const t of r.trace) {
      lines.push(
        `  t${t.tick} x${fmt(t.x)} y${fmt(t.y)} yVel${fmt(t.yVel)} ${t.mode}${t.held ? " hold" : ""}${t.onGround ? " ground" : ""}`,
      );
    }
    for (const n of r.nearMisses) {
      lines.push(`  near miss: ${n.kind} #${n.index} (obj ${n.id}) within ${fmt(n.distance)} — ${shapeText(n.shape)}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Decision history: small, shared between siblings, never holds a snapshot. */
export interface Lineage {
  parent: Lineage | null;
  /** Sim tick after this window was stepped. */
  tick: number;
  input: PlayerInput;
  /** Ticks actually stepped in this window (< D only when the player died/finished). */
  ticks: number;
  events: MacroInput[] | null;
  /** Furthest x reached by any descendant; guides which checkpoint node to reopen first. */
  subtreeMaxX: number;
}

export interface Node {
  snap: SimSnapshot;
  input: PlayerInput;
  lineage: Lineage;
  score: number;
  y: number;
  /** Mode, size and gravity, packed; diversity buckets are per form. */
  form: number;
}

export function formOf(s: { mode: string; mini: boolean; flipped: boolean }): number {
  return (s.mode.charCodeAt(0) * 31 + s.mode.charCodeAt(1)) * 4 + (s.mini ? 2 : 0) + (s.flipped ? 1 : 0);
}

export interface Checkpoint {
  tick: number;
  beam: Node[];
  byLineage: Map<Lineage, Node> | null;
}

export function bubbleMaxX(l: Lineage, x: number): void {
  for (let cur: Lineage | null = l; cur && cur.subtreeMaxX < x; cur = cur.parent) cur.subtreeMaxX = x;
}

export function materializeInputs(l: Lineage): MacroInput[] {
  const chunks: MacroInput[][] = [];
  for (let cur: Lineage | null = l; cur; cur = cur.parent) if (cur.events) chunks.push(cur.events);
  chunks.reverse();
  return chunks.flat();
}

/**
 * yVel buckets per mode. A UFO, ship or swing carries its velocity for a long
 * arc, so two that differ by 0.3 can peak 7 units apart (Society's mini-UFO
 * zigzag at x 9100 needs the lower one); the other modes reset it on landing.
 */
const YVEL_BUCKET: Partial<Record<string, number>> = { ufo: 0.5, ship: 0.5, swing: 0.5 };

export function bucketKey(sim: Sim, input: PlayerInput, platformer: boolean): string {
  const s = sim.state;
  const yb = YVEL_BUCKET[s.mode] ?? 8;
  let key =
    `${s.mode}|${s.flipped ? 1 : 0}${s.mini ? 1 : 0}${s.speed}${input.jump ? 1 : 0}${s.onGround ? 1 : 0}${s.dashing ? 1 : 0}${s.orbReady ? 1 : 0}|` +
    `${Math.round(s.x * 2)}|${Math.round(s.y * 2)}|${Math.round(s.yVel / yb)}|${s.holdTicks >> 2}|${sim.stateHash()}`;
  if (platformer) key += `|${input.left ? 1 : 0}${input.right ? 1 : 0}|${Math.round(s.xVel / 8)}`;
  const s2 = sim.state2;
  if (s2) key += `|${s2.flipped ? 1 : 0}|${Math.round(s2.y * 2)}|${Math.round(s2.yVel / 8)}`;
  return key;
}

/**
 * Best-first with at most `cap` nodes per 5-unit y bucket and form; the rest
 * fill any remaining slots in score order. Bucketing per form keeps a line
 * that took (or skipped) a size or gravity portal alive while its score
 * trails: Society's x 10013 is passable only by a big UFO that went through
 * the small size portal at x 9549, which the mini lines outscored.
 */
export function selectDiverse(sorted: Node[], W: number, cap: number): Node[] {
  const out: Node[] = [];
  const skipped: Node[] = [];
  const counts = new Map<number, number>();
  for (const n of sorted) {
    if (out.length >= W) break;
    const b = Math.floor(n.y / 5) * 65536 + n.form;
    const c = counts.get(b) ?? 0;
    if (c >= cap) {
      skipped.push(n);
      continue;
    }
    counts.set(b, c + 1);
    out.push(n);
  }
  for (const n of skipped) {
    if (out.length >= W) break;
    out.push(n);
  }
  return out;
}

/** The lineage chain from the checkpoint node (exclusive) down to `to` (inclusive), as a step plan. */
export function planFromCheckpoint(cp: Checkpoint, to: Lineage): { node: Node; plan: PlanStep[] } | null {
  const chain: Lineage[] = [];
  let cur: Lineage | null = to;
  while (cur && cur.tick > cp.tick) {
    chain.push(cur);
    cur = cur.parent;
  }
  if (!cur) return null;
  cp.byLineage ??= new Map(cp.beam.map((n) => [n.lineage, n]));
  const node = cp.byLineage.get(cur);
  if (!node) return null;
  chain.reverse();
  return { node, plan: chain.map((l) => ({ input: l.input, ticks: l.ticks })) };
}

/**
 * Scores the node the sim is at, reached by holding `input`. Returns the
 * snapshot it took for the coasting lookahead, if it ran one, and the sim
 * ticks that cost. Leaves the sim where it found it.
 */
export function makeRanker(
  sim: Sim,
  cfg: BotConfig,
  clearanceIndex: ClearanceIndex,
  guide: PlatformerGuide | null,
): (input: PlayerInput) => { score: number; snap: SimSnapshot | null; used: number } {
  /**
   * What a node pays for floating above the level instead of playing it.
   *
   * Nothing at all while the player is within `cfg.aboveLevelSlack` of the
   * highest thing near it, which covers every honest jump, ship climb and
   * flying corridor; beyond that it grows until no amount of clearance can
   * make the sky attractive. Without it the search climbs, because height is
   * free — x advances at the same rate whatever the altitude — and empty air
   * never kills anything.
   */
  const aboveLevelPenalty = (st: PlayerState): number => {
    const top = clearanceIndex.topNear(st.x);
    const over = st.y - (top + cfg.aboveLevelSlack);
    return over <= 0 ? 0 : Math.min(2000, over);
  };

  return (input) => {
    const st = sim.state;
    let clr = clearanceIndex.clearance(sim.playerRect(), st);
    const st2 = sim.state2;
    if (st2) clr = Math.min(clr, clearanceIndex.clearance(sim.playerRect(2), st2));
    let score: number;
    let snap: SimSnapshot | null = null;
    let used = 0;
    if (clr >= cfg.dangerClearance) {
      // Clearance stops paying once the player is clearly out of danger.
      //
      // It used to pay all the way to the 90-unit lookahead, so a node in empty
      // space scored 1090 where a node on a real path through the level scored
      // about 1010. Eighty points a step, compounded over a whole level, is an
      // instruction to go wherever the level is not — and before the play area
      // had a ceiling, that meant flying into the sky and riding it to the end.
      // Eight of the saved macros were "solved" that way.
      score = 1000 + Math.min(clr, cfg.safeClearance);
      score -= aboveLevelPenalty(st);
    } else {
      snap = sim.snapshot();
      let alive = 0;
      for (; alive < cfg.N; alive++) {
        sim.step(input, input);
        used++;
        if (sim.state.dead) break;
        if (sim.state.finished) {
          alive = cfg.N;
          break;
        }
      }
      sim.restore(snap);
      score = alive * 10 + clr;
    }
    if (guide) score += guide.progressScore(st);
    return { score, snap, used };
  };
}

/**
 * Searches for inputs that complete the level the sim was built for. Leaves
 * the sim restored to the state it had on entry, so the caller can replay the
 * returned inputs (recordMacro) straight away.
 */
export function solve(sim: Sim, overrides: Partial<BotConfig> = {}): SolveResult {
  const cfg: BotConfig = { ...DEFAULT_BOT_CONFIG, ...overrides };
  const t0 = performance.now();
  const platformer = sim.level.header.platformer;
  const branches = platformer ? PLATFORMER_BRANCHES : CLASSIC_BRANCHES;
  const clearanceIndex = new ClearanceIndex(sim, cfg.lookaheadUnits);
  const guide = platformer ? new PlatformerGuide(sim) : null;

  const startSnap = sim.snapshot();
  const startTick = sim.tick;
  const root: Lineage = {
    parent: null,
    tick: startTick,
    input: RELEASE,
    ticks: 0,
    events: null,
    subtreeMaxX: sim.state.x,
  };
  let beam: Node[] = [{ snap: startSnap, input: RELEASE, lineage: root, score: 0, y: sim.state.y, form: formOf(sim.state) }];
  let tick = startTick;
  let used = 0;
  let W = cfg.W;
  let D = cfg.D;
  let backoff = cfg.checkpointEvery;
  let furthestTick = startTick;
  /** Furthest tick reached before the last dead end; the ladder restarts once the beam is well past it. */
  let deadEndFrontier = Number.NEGATIVE_INFINITY;
  let lastCheckpointTick = startTick - cfg.checkpointEvery;
  const ring: Checkpoint[] = [];
  let best: { report: DeathReport; lineage: Lineage } | null = null;
  let stopReason: SolveResult["stopReason"] = "dead end";
  /** The furthest death last focused on, so each one is focused on once. */
  let focusedOn: Lineage | null = null;

  /** The latest checkpoint at least focusBack ticks before `death` whose beam holds its ancestor. */
  const focusNode = (death: Lineage): { ringIdx: number; node: Node } | null => {
    for (let i = ring.length - 1; i >= 0; i--) {
      const cp = ring[i];
      if (cp.tick > death.tick - cfg.focusBack) continue;
      let cur: Lineage | null = death;
      while (cur && cur.tick > cp.tick) cur = cur.parent;
      if (!cur) return null;
      cp.byLineage ??= new Map(cp.beam.map((n) => [n.lineage, n]));
      const node = cp.byLineage.get(cur);
      return node ? { ringIdx: i, node } : null;
    }
    return null;
  };

  const ranker = makeRanker(sim, cfg, clearanceIndex, guide);
  const rank = (input: PlayerInput): { score: number; snap: SimSnapshot | null } => {
    const r = ranker(input);
    used += r.used;
    return r;
  };

  const latestCheckpoint = (): Checkpoint | null => {
    for (let i = ring.length - 1; i >= 0; i--) if (ring[i].tick <= tick) return ring[i];
    return null;
  };

  const traceFor = (parent: Node, lineage: Lineage): TraceCapture => {
    const cp = latestCheckpoint();
    const viaCp = cp ? planFromCheckpoint(cp, lineage) : null;
    if (viaCp) return captureTrace(sim, viaCp.node.snap, viaCp.plan);
    return captureTrace(sim, parent.snap, [{ input: lineage.input, ticks: lineage.ticks }]);
  };

  const finish = (completed: boolean, lineage: Lineage | null, report: DeathReport | null): SolveResult => {
    sim.restore(startSnap);
    const wallMs = performance.now() - t0;
    const empty: DeathReport = {
      furthest: { tick, x: 0, y: 0, mode: sim.state.mode, held: false },
      bestX: 0,
      bestPercent: 0,
      killer: null,
      playerRect: null,
      trace: [],
      nearMisses: [],
    };
    const rep = report ?? empty;
    return {
      ...rep,
      completed,
      ticks: rep.furthest.tick,
      inputs: lineage ? materializeInputs(lineage) : [],
      simTicksUsed: used,
      wallMs,
      stopReason: completed ? "completed" : stopReason,
    };
  };

  for (;;) {
    if (used >= cfg.maxTicks) {
      stopReason = "tick budget";
      break;
    }
    if (performance.now() - t0 > cfg.maxWallMs) {
      stopReason = "wall clock";
      break;
    }
    if (tick - lastCheckpointTick >= cfg.checkpointEvery) {
      ring.push({ tick, beam, byLineage: null });
      if (ring.length > cfg.ringSize) ring.shift();
      lastCheckpointTick = tick;
    }
    if (tick > furthestTick) furthestTick = tick;
    if (tick > deadEndFrontier + cfg.checkpointEvery) {
      // Clearly past the spot that killed the beam: the ladder starts over (W stays widened).
      backoff = cfg.checkpointEvery;
      deadEndFrontier = Number.NEGATIVE_INFINITY;
    }

    const next: Node[] = [];
    const seen = new Map<string, number>();
    for (const node of beam) {
      for (const input of branches) {
        sim.restore(node.snap);
        let stepped = 0;
        while (stepped < D) {
          sim.step(input, input);
          used++;
          stepped++;
          if (sim.state.dead || sim.state.finished) break;
        }
        const st = sim.state;
        const lineage: Lineage = {
          parent: node.lineage,
          tick: tick + stepped,
          input,
          ticks: stepped,
          events: inputEvents(node.input, input, tick),
          subtreeMaxX: st.x,
        };
        if (st.finished) {
          bubbleMaxX(node.lineage, st.x);
          const capture = traceFor(node, lineage);
          const report = reportFromState(sim, input.jump, capture);
          return finish(true, lineage, report);
        }
        if (st.dead) {
          bubbleMaxX(node.lineage, st.x);
          if (!best || st.x > best.report.bestX) {
            const capture = traceFor(node, lineage);
            const report = reportFromState(sim, input.jump, capture);
            best = { report, lineage };
          }
          continue;
        }
        if (cfg.normalSizeAfter !== undefined && st.mini && st.x > cfg.normalSizeAfter) continue;
        const key = bucketKey(sim, input, platformer);
        const prevIdx = seen.get(key);
        const { score, snap } = rank(input);
        if (prevIdx !== undefined && next[prevIdx].score >= score) continue;
        const child: Node = { snap: snap ?? sim.snapshot(), input, lineage, score, y: st.y, form: formOf(st) };
        if (prevIdx !== undefined) next[prevIdx] = child;
        else {
          seen.set(key, next.length);
          next.push(child);
        }
      }
    }

    if (next.length === 0) {
      const focus = best && cfg.focusBack > 0 && best.lineage !== focusedOn ? focusNode(best.lineage) : null;
      if (focus) {
        focusedOn = best!.lineage;
        const deadTick = tick;
        ring.length = focus.ringIdx + 1;
        beam = [focus.node];
        tick = ring[focus.ringIdx].tick;
        lastCheckpointTick = tick;
        cfg.log?.(`dead end at tick ${deadTick} → focusing on the furthest death's line from tick ${tick}`);
        continue;
      }
      let cpIdx = -1;
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].tick <= tick - backoff) {
          cpIdx = i;
          break;
        }
      }
      if (cpIdx < 0 && ring.length > 0) cpIdx = 0;
      if (cpIdx < 0 || backoff > cfg.maxBackoff) {
        stopReason = "dead end";
        break;
      }
      const cp = ring[cpIdx];
      const deadTick = tick;
      deadEndFrontier = Math.max(deadEndFrontier, furthestTick);
      ring.length = cpIdx + 1;
      beam = [...cp.beam].sort((a, b) => b.lineage.subtreeMaxX - a.lineage.subtreeMaxX);
      tick = cp.tick;
      lastCheckpointTick = cp.tick;
      backoff *= 2;
      W = Math.min(W * 2, cfg.maxW);
      D = Math.max(1, D >> 1);
      const fd = best?.report;
      const fdText = fd
        ? `; furthest death at tick ${fd.furthest.tick} (${fmt(fd.furthest.x)},${fmt(fd.furthest.y)}) ${fd.furthest.mode}` +
          (fd.killer ? ` by #${fd.killer.index} (obj ${fd.killer.id}) ${shapeText(fd.killer.shape)}` : "")
        : "";
      cfg.log?.(
        `dead end at tick ${deadTick} → reopening ${beam.length} nodes at tick ${cp.tick} (W=${W}, D=${D}, next backoff ${backoff})${fdText}`,
      );
      if (best && cfg.onDeadEnd) cfg.onDeadEnd(materializeInputs(best.lineage));
      continue;
    }

    next.sort((a, b) => b.score - a.score);
    beam = selectDiverse(next, W, cfg.diversityCap);
    tick += D;
  }

  if (best) return finish(false, best.lineage, best.report);
  // Budget ran out with the beam still alive: report the leading node instead of a death.
  const lead = beam.reduce((a, b) => (b.lineage.subtreeMaxX > a.lineage.subtreeMaxX ? b : a), beam[0]);
  sim.restore(lead.snap);
  const report = reportFromState(sim, lead.input.jump, { trace: [], nearMisses: [] });
  return finish(false, lead.lineage, report);
}

// ---------------------------------------------------------------------------
// Macros: pcgd-macro v1, a GDR superset
// ---------------------------------------------------------------------------

export interface MacroCheckpoint {
  frame: number;
  x: number;
  y: number;
  yVel: number;
  mode: GameMode;
}

export interface Macro {
  format: "pcgd-macro";
  version: 1;
  levelId: number;
  levelName: string;
  framerate: 240;
  /** Hash of the physics constants + hitbox table the macro was solved against. */
  simHash: string;
  botInfo: { name: string; version: string };
  inputs: MacroInput[];
  completedFrame: number | null;
  checkpoints: MacroCheckpoint[];
  /**
   * The random seed the run was solved with, when it is not MACRO_SEED. A
   * level whose random triggers have a rare branch the default seed lands on
   * is solved with another.
   */
  seed?: number;
}

/** The GDR-only view of a macro (what xdBot/zBot accept). */
export interface GdrMacro {
  framerate: 240;
  inputs: MacroInput[];
  botInfo: { name: string; version: string };
  levelInfo: { id: number; name: string };
}

export const BOT_INFO = { name: "pcgd-autoplayer", version: "1" } as const;
export const MACRO_CHECKPOINT_EVERY = 60;
/** Divergence tolerance for checkpoint (x, y) comparison. */
export const MACRO_DIVERGENCE_TOLERANCE = 0.01;

function fnv1a(seed: number, text: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Changes whenever a physics constant or a table hitbox changes, so stale macros say so. */
export function simHash(sim: Sim): string {
  let h = fnv1a(0x811c9dc5, JSON.stringify(PHYSICS, (_k, v: unknown) => (typeof v === "function" ? String(v) : v)));
  const ids = [...sim.objects.ids()].sort((a, b) => a - b);
  for (const id of ids) {
    const d = sim.objects.get(id);
    h = fnv1a(h, `${id}:${d.kind}:${JSON.stringify(d.hitbox)}:${d.special ?? ""}:${d.orb ?? ""}:${d.pad ?? ""}`);
  }
  return h.toString(16).padStart(8, "0");
}

export function toGdr(m: Macro): GdrMacro {
  return {
    framerate: 240,
    inputs: m.inputs.map((i) => ({ ...i })),
    botInfo: { ...m.botInfo },
    levelInfo: { id: m.levelId, name: m.levelName },
  };
}

/** Applies a GDR event to a mutable input. */
function applyEvent(input: PlayerInput, e: MacroInput): void {
  if (e.button === 1) input.jump = e.down;
  else if (e.button === 2) input.left = e.down;
  else if (e.button === 3) input.right = e.down;
}

interface RunOptions {
  /** Stop after this tick even if still alive. */
  maxTick: number;
  /** Leave the sim where the inputs took it instead of restoring it. */
  keepState?: boolean;
  onCheckpointTick?: (tick: number, st: PlayerState) => void;
}

interface RunOutcome {
  finished: boolean;
  dead: boolean;
  ticks: number;
  report: DeathReport | null;
}

/** Steps the sim through a fixed input list from its current state. Restores the sim afterwards. */
export function runInputs(sim: Sim, inputs: MacroInput[], opts: RunOptions): RunOutcome {
  const startSnap = sim.snapshot();
  const events = [...inputs].sort((a, b) => a.frame - b.frame);
  const p1: PlayerInput = { jump: false, left: false, right: false };
  const p2: PlayerInput = { jump: false, left: false, right: false };
  // Single-player dual: both players get player 1's input, like the game.
  const hasP2Events = inputs.some((i) => i.player2);
  let ei = 0;
  // Ring of recent snapshots + inputs so a death can be re-stepped for its trace.
  const ringSize = TRACE_TICKS + 1;
  const snaps: SimSnapshot[] = [];
  const stepInputs: PlayerInput[] = [];
  let finished = false;
  let dead = false;
  while (sim.tick <= opts.maxTick) {
    const t = sim.tick;
    if (opts.onCheckpointTick && t % MACRO_CHECKPOINT_EVERY === 0) opts.onCheckpointTick(t, sim.state);
    // A jump that goes down and up on one frame is a tap: the sim runs both
    // commands in that step, as the game does.
    const was1 = p1.jump;
    const was2 = p2.jump;
    let edges1 = 0;
    let edges2 = 0;
    while (ei < events.length && events[ei].frame <= t) {
      const e = events[ei];
      const into = e.player2 ? p2 : p1;
      if (e.button === 1 && into.jump !== e.down) {
        if (e.player2) edges2++;
        else edges1++;
      }
      applyEvent(into, e);
      ei++;
    }
    const inp1: PlayerInput = edges1 - (p1.jump !== was1 ? 1 : 0) >= 2 ? { ...p1, tap: true } : { ...p1 };
    const tap2 = edges2 - (p2.jump !== was2 ? 1 : 0) >= 2;
    const inp2: PlayerInput = sim.state2 && hasP2Events ? (tap2 ? { ...p2, tap: true } : { ...p2 }) : inp1;
    snaps.push(sim.snapshot());
    stepInputs.push(inp1);
    if (snaps.length > ringSize) {
      snaps.shift();
      stepInputs.shift();
    }
    sim.step(inp1, inp2);
    if (sim.state.finished) {
      finished = true;
      break;
    }
    if (sim.state.dead) {
      dead = true;
      break;
    }
  }
  const ticks = sim.tick;
  let report: DeathReport | null = null;
  if (dead || finished) {
    const plan = stepInputs.map((input) => ({ input, ticks: 1 }));
    const capture = captureTrace(sim, snaps[0], plan);
    report = reportFromState(sim, stepInputs[stepInputs.length - 1]?.jump ?? false, capture);
  }
  if (!opts.keepState) sim.restore(startSnap);
  return { finished, dead, ticks, report };
}

/**
 * Plays `inputs` from the start until the sim reaches tick `until` and leaves
 * it there, for a solve that picks up from part way along an earlier attempt.
 * Returns the inputs that solve's result must follow: those before `until`,
 * then a release of every button still held, since a solve starts with all of
 * them up. Null when the attempt dies or finishes before `until`.
 */
export function playPrefix(sim: Sim, inputs: MacroInput[], until: number): MacroInput[] | null {
  const prefix = inputs.filter((i) => i.frame < until).sort((a, b) => a.frame - b.frame);
  const out = runInputs(sim, prefix, { maxTick: until - 1, keepState: true });
  if (out.dead || out.finished) return null;
  const held = new Map<string, MacroInput>();
  for (const e of prefix) {
    const key = `${e.player2 ? 2 : 1}:${e.button}`;
    if (e.down) held.set(key, e);
    else held.delete(key);
  }
  for (const e of held.values()) prefix.push({ frame: until, button: e.button, player2: e.player2, down: false });
  return prefix;
}

/**
 * Replays a solved input list from the sim's current state and writes the
 * macro with its per-60-tick checkpoints. `completedFrame` is null when the
 * inputs no longer finish the level (a solve/replay mismatch is itself a bug).
 */
export function recordMacro(sim: Sim, inputs: MacroInput[], levelId: number, levelName: string, seed?: number): Macro {
  const checkpoints: MacroCheckpoint[] = [];
  const lastFrame = inputs.reduce((m, i) => Math.max(m, i.frame), 0);
  // A hold-heavy solve can place its last input minutes before the end wall, so
  // the replay budget is generous; runInputs stops at the finish or a death anyway.
  const out = runInputs(sim, inputs, {
    maxTick: lastFrame + PHYSICS.TICKS_PER_SECOND * 600,
    onCheckpointTick: (frame, st) => checkpoints.push({ frame, x: st.x, y: st.y, yVel: st.yVel, mode: st.mode }),
  });
  return {
    format: "pcgd-macro",
    version: 1,
    levelId,
    levelName,
    framerate: 240,
    simHash: simHash(sim),
    botInfo: { ...BOT_INFO },
    inputs: inputs.map((i) => ({ ...i })),
    completedFrame: out.finished ? out.ticks : null,
    checkpoints,
    ...(seed !== undefined ? { seed } : {}),
  };
}

export interface Divergence {
  frame: number;
  expected: { x: number; y: number };
  actual: { x: number; y: number };
}

export interface ReplayResult {
  finished: boolean;
  ticks: number;
  /** First checkpoint whose (x, y) is off by more than the tolerance, or null. */
  firstDivergence: Divergence | null;
  /** False when the physics constants or hitbox table changed since the macro was solved. */
  simHashMatches: boolean;
  /** Death report when the replay died (null on success). */
  death: DeathReport | null;
}

/** Plain replay, no search: the regression check for saved macros. Restores the sim afterwards. */
export function replay(sim: Sim, macro: Macro): ReplayResult {
  const cps = [...macro.checkpoints].sort((a, b) => a.frame - b.frame);
  let ci = 0;
  let firstDivergence: Divergence | null = null;
  const lastFrame = macro.inputs.reduce((m, i) => Math.max(m, i.frame), 0);
  const maxTick = Math.max(macro.completedFrame ?? 0, lastFrame) + PHYSICS.TICKS_PER_SECOND * (macro.completedFrame ? 60 : 600);
  const out = runInputs(sim, macro.inputs, {
    maxTick,
    onCheckpointTick: (tick, st) => {
      while (ci < cps.length && cps[ci].frame < tick) ci++;
      if (ci >= cps.length || cps[ci].frame !== tick) return;
      const cp = cps[ci++];
      if (firstDivergence) return;
      if (Math.abs(cp.x - st.x) > MACRO_DIVERGENCE_TOLERANCE || Math.abs(cp.y - st.y) > MACRO_DIVERGENCE_TOLERANCE) {
        firstDivergence = { frame: tick, expected: { x: cp.x, y: cp.y }, actual: { x: st.x, y: st.y } };
      }
    },
  });
  return {
    finished: out.finished,
    ticks: out.ticks,
    firstDivergence,
    simHashMatches: macro.simHash === simHash(sim),
    death: out.finished ? null : out.report,
  };
}

/** Turns a replay failure into the same one-line report the solver prints. */
export function formatReplay(name: string, r: ReplayResult): string {
  const parts: string[] = [];
  if (!r.simHashMatches) parts.push(`${name}: physics changed since this macro was solved; re-solve with \`npm run bot -- <levelId> --save\``);
  if (r.firstDivergence) {
    const d = r.firstDivergence;
    parts.push(
      `${name}: first divergence at frame ${d.frame}: expected (${fmt(d.expected.x)},${fmt(d.expected.y)}) got (${fmt(d.actual.x)},${fmt(d.actual.y)})`,
    );
  }
  if (r.finished) parts.push(`${name} 100% — replay finished at tick ${r.ticks}`);
  else if (r.death) {
    const asSolve: SolveResult = {
      ...r.death,
      completed: false,
      ticks: r.death.furthest.tick,
      inputs: [],
      simTicksUsed: r.ticks,
      wallMs: 0,
      stopReason: "dead end",
    };
    parts.push(formatReport(name, asSolve, true));
  } else parts.push(`${name}: replay ran out of inputs at tick ${r.ticks} without finishing`);
  return parts.join("\n");
}
