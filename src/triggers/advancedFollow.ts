// Advanced Follow (3016) and its Edit / Re-Target triggers: per-object velocity
// steering at 240 Hz. See data/ref/gd-advanced-follow.md.

import type { AreaRandom } from "./area";
import type { Lcg } from "./rng";
import { flag, int, num, type TriggerSpec } from "./spec";

/** Random-bank slot offsets for Advanced Follow mod keys. */
export const ADV_FOLLOW_SLOT = {
  delay: 0,
  maxSpeed: 1,
  accel: 2,
  maxRange: 3,
  smooth: 6,
  nearDist: 6,
  drag: 7,
  nearAccel: 8,
  turnRate: 9,
  nearDrag: 9,
  slowTurn: 10,
  fastTurn: 11,
  slowThr: 12,
  fastThr: 13,
  brake: 14,
  brakeAng: 15,
  brakeTurn: 16,
  brakeThr: 16,
} as const;

const PI = 3.1416;
const DEG = 0.017453;

export interface GameObjectPhysics {
  owner: number;
  velX: number;
  velY: number;
  dirX: number;
  dirY: number;
  aimAngle: number;
  turnRate: number;
  stamp: number;
  lastMoveFrame: number;
  lastStepFrame: number;
}

export interface AdvFollowInstance {
  triggerIndex: number;
  followerGroup: number;
  followedTarget: number;
  controlId: number;
  rangeRefObject: number;
  actionOrdinal: number;
  paused: boolean;
  runOneSettlePass: boolean;
  removeMe: boolean;
  hasStarted: boolean;
}

export interface AdvFollowSnapshot {
  instances: AdvFollowInstance[];
  physics: Map<number, GameObjectPhysics>;
  dirtySort: boolean;
  nextOrdinal: number;
  history: PositionHistorySnapshot;
}

export interface AdvFollowHost {
  grp(id: number): number;
  groupMembers(group: number): readonly number[];
  mainObject(group: number): number;
  targetObject(group: number): number;
  objectPosition(index: number): [number, number];
  objectRotation(index: number): number;
  objectId(index: number): number;
  objectGroups(index: number): readonly number[];
  specOf(index: number): TriggerSpec | undefined;
  player1(): [number, number];
  player2(): [number, number] | null;
  /** Point for followed target -3 (layer+852); absent → (0,0). */
  followPoint?(): [number, number];
  /**
   * Enter-effect group-copy slot for `getSpecialKey(group, key280, key281)`,
   * or 0 when the map has no entry (one plain-group pass).
   * [gdp processAdvancedFollowAction :453786-453818]
   */
  enterCopySlot?(specialKey: number): number;
  /**
   * Members of enter-effect copy `slot` for pass `pass` (0 or 1). Absent or
   * empty falls back to the plain follower group on pass 0.
   */
  copyGroupMembers?(slot: number, pass: number): readonly number[];
  noteMoved(group: number): void;
  markDirty(group: number): void;
  setMotion(index: number, dx: number, dy: number, drot: number): void;
}

/** Physics ticks per second for the position-history ring. */
const HISTORY_HZ = 240;
/** Default ring length: two seconds of 240 Hz samples. */
const DEFAULT_HISTORY_LEN = HISTORY_HZ * 2;

/**
 * `getSpecialKey(group, b1, b2)` for enter-effect / AdvFollow copy lookup.
 * [gdp GJBaseGameLayer::getSpecialKey :425770-425774]
 */
export function getSpecialKey(group: number, b1: boolean, b2: boolean): number {
  return 100000000 + (b1 ? 10000000 : 0) + (b2 ? 1000000 : 0) + group;
}

export interface PositionHistorySnapshot {
  samples: number;
  rings: Map<number, { len: number; base: number; xy: Float32Array }>;
  ring: Float32Array;
  nextBase: number;
}

/** Per-target delayed positions for AdvFollow key 292. [gdp getSavedPosition :453471-453611] */
export class PositionHistory {
  private samples = 0;
  private readonly rings = new Map<number, { len: number; base: number; xy: Float32Array }>();
  private ring = new Float32Array(0);
  private nextBase = 0;

  capture(): PositionHistorySnapshot {
    return {
      samples: this.samples,
      rings: new Map([...this.rings.entries()].map(([k, v]) => [k, { len: v.len, base: v.base, xy: v.xy }])),
      ring: this.ring.slice(),
      nextBase: this.nextBase,
    };
  }

  restore(s: PositionHistorySnapshot): void {
    this.samples = s.samples;
    this.rings.clear();
    for (const [k, v] of s.rings) this.rings.set(k, { len: v.len, base: v.base, xy: v.xy });
    this.ring = s.ring.slice();
    this.nextBase = s.nextBase;
  }

  /** Ensures target `id` (-1/-2/-3 or group) has a ring of at least `len` samples. */
  ensure(id: number, len: number): void {
    const need = Math.max(2, Math.ceil(len));
    let r = this.rings.get(id);
    if (r && r.len >= need) return;
    const base = this.nextBase;
    this.nextBase += need;
    if (this.ring.length < this.nextBase * 2) {
      const grown = new Float32Array(Math.max(this.nextBase * 2, this.ring.length * 2 || 64));
      grown.set(this.ring);
      this.ring = grown;
    }
    if (r) {
      // Keep existing samples in the new longer slot.
      for (let i = 0; i < r.len; i++) {
        this.ring[(base + i) * 2] = this.ring[(r.base + i) * 2];
        this.ring[(base + i) * 2 + 1] = this.ring[(r.base + i) * 2 + 1];
      }
    }
    this.rings.set(id, { len: need, base, xy: this.ring });
  }

  /** One physics tick: write live positions for every registered target. */
  record(host: AdvFollowHost): void {
    if (this.rings.size === 0) return;
    this.samples++;
    for (const [id, r] of this.rings) {
      const [x, y] = this.live(host, id);
      const slot = r.base + (this.samples % r.len);
      this.ring[slot * 2] = x;
      this.ring[slot * 2 + 1] = y;
    }
  }

  private live(host: AdvFollowHost, id: number): [number, number] {
    if (id === -1) return host.player1();
    if (id === -2) return host.player2() ?? [0, 0];
    if (id === -3) return host.followPoint?.() ?? [0, 0];
    const main = host.mainObject(id);
    if (main < 0) return [0, 0];
    return host.objectPosition(main);
  }

  /**
   * Position of `id` `delay` seconds ago. Live when delay ≤ 0; (0,0) when the
   * sample is older than the recorded history.
   */
  get(host: AdvFollowHost, id: number, delay: number): [number, number] {
    if (!(delay > 0)) return this.live(host, id);
    const frames = Math.max(0, delay * HISTORY_HZ);
    const n = Math.ceil(frames);
    if (n >= this.samples) return [0, 0];
    const r = this.rings.get(id);
    if (!r) return [0, 0];
    let j = (this.samples % r.len) - n;
    if (j < 0) j += r.len;
    let k = j + 1;
    if (k >= r.len) k = 0;
    const t = n - frames;
    const i0 = (r.base + j) * 2;
    const i1 = (r.base + k) * 2;
    const x0 = this.ring[i0];
    const y0 = this.ring[i0 + 1];
    const x1 = this.ring[i1];
    const y1 = this.ring[i1 + 1];
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  }
}

export function closestDirectionMod(x: number, m: number): number {
  if (x < -m) {
    const n = Math.ceil(Math.floor(Math.abs(x) / m) * 0.5);
    return x + n * (m + m);
  }
  if (x > m) {
    const n = Math.ceil(Math.floor(Math.abs(x) / m) * 0.5);
    return x - n * (m + m);
  }
  return x;
}

export function advVariance(rand: AreaRandom, object: number, slot: number): number {
  return rand.table[rand.index[object] + slot];
}

export function advModded(base: number, mod: number, object: number, slot: number, rand: AreaRandom): number {
  if (mod === 0) return base;
  return Math.fround(base + mod * advVariance(rand, object, slot));
}

export function pointAngle(p: [number, number]): number {
  return Math.atan2(p[1], p[0]);
}

export function ccpForAngle(a: number): [number, number] {
  return [Math.cos(a), Math.sin(a)];
}

export function normalize(p: [number, number]): [number, number] {
  const len = Math.hypot(p[0], p[1]);
  if (len <= 0) return [0, 0];
  return [p[0] / len, p[1] / len];
}

export function followSpeedVal(
  host: AdvFollowHost,
  objectIndex: number,
  refA: number,
  refB: number,
  angleDeg: number,
  magnitude: number,
): [number, number] {
  let a = Math.fround((90 - angleDeg) * DEG);
  let dx = 0;
  let dy = 0;
  if (refA > 0) {
    const o = host.targetObject(refA);
    if (o >= 0) {
      const pos = host.objectPosition(o);
      dx = pos[0] - pos[0];
      dy = pos[1] - pos[1];
    }
  }
  if (dx === 0 && dy === 0 && refB > 0) {
    const o = host.targetObject(refB);
    if (o >= 0) {
      const pos = host.objectPosition(o);
      const here = host.objectPosition(objectIndex);
      dx = here[0] - pos[0];
      dy = here[1] - pos[1];
    }
  }
  if (dx !== 0 || dy !== 0) a = Math.fround(a + Math.atan2(dy, dx) + 1.57079633);
  const [cx, cy] = ccpForAngle(a);
  let vx = Math.fround(cx * magnitude);
  let vy = Math.fround(cy * magnitude);
  if (Math.abs(vx) < 2e-4) vx = 0;
  if (Math.abs(vy) < 2e-4) vy = 0;
  return [vx, vy];
}

export function newPhysics(owner: number): GameObjectPhysics {
  return {
    owner,
    velX: 0,
    velY: 0,
    dirX: 0,
    dirY: 0,
    aimAngle: 0,
    turnRate: 0,
    stamp: 0,
    lastMoveFrame: 0,
    lastStepFrame: 0,
  };
}

export function clonePhysics(p: GameObjectPhysics): GameObjectPhysics {
  return { ...p };
}

export function cloneAdvFollow(s: AdvFollowSnapshot): AdvFollowSnapshot {
  return {
    instances: s.instances.map((i) => ({ ...i })),
    physics: new Map([...s.physics.entries()].map(([k, v]) => [k, clonePhysics(v)])),
    dirtySort: s.dirtySort,
    nextOrdinal: s.nextOrdinal,
    history: {
      samples: s.history.samples,
      rings: new Map([...s.history.rings.entries()].map(([k, v]) => [k, { len: v.len, base: v.base, xy: v.xy }])),
      ring: s.history.ring.slice(),
      nextBase: s.history.nextBase,
    },
  };
}

function emptyHistory(): PositionHistorySnapshot {
  return { samples: 0, rings: new Map(), ring: new Float32Array(0), nextBase: 0 };
}

function followedTargetOf(spec: TriggerSpec): number {
  if (flag(spec, 138)) return -1;
  if (flag(spec, 200)) return -2;
  if (flag(spec, 201)) return -3;
  return int(spec, 71);
}

function sortPriority(spec: TriggerSpec): number {
  return int(spec, 365);
}

function instanceKey(inst: AdvFollowInstance): string {
  return `${inst.triggerIndex}:${inst.followerGroup}:${inst.followedTarget}:${inst.controlId}`;
}

function mag(x: number, y: number): number {
  return Math.hypot(x, y);
}

function clampTurn(w: number, err: number): number {
  if (err === 0) return 0;
  return Math.sign(err) * Math.min(Math.abs(w), Math.abs(err));
}

export class AdvancedFollowSystem {
  private instances: AdvFollowInstance[] = [];
  private readonly physics = new Map<number, GameObjectPhysics>();
  private readonly velMul = new Map<number, { sx: number; sy: number }>();
  /** Per-object step multiplier from Edit (3660), applied each tick. */
  private readonly stepMul = new Map<number, { sx: number; sy: number }>();
  private dirtySort = false;
  private nextOrdinal = 0;
  readonly history = new PositionHistory();

  get active(): boolean {
    return this.instances.length > 0;
  }

  capture(): AdvFollowSnapshot {
    return cloneAdvFollow({
      instances: this.instances,
      physics: this.physics,
      dirtySort: this.dirtySort,
      nextOrdinal: this.nextOrdinal,
      history: this.history.capture(),
    });
  }

  restore(s: AdvFollowSnapshot): void {
    this.instances = s.instances.map((i) => ({ ...i }));
    this.physics.clear();
    for (const [k, v] of s.physics) this.physics.set(k, clonePhysics(v));
    this.dirtySort = s.dirtySort;
    this.nextOrdinal = s.nextOrdinal;
    this.history.restore(s.history ?? emptyHistory());
  }

  hash(): number {
    let h = 0x9e3779b9;
    h = Math.imul(h ^ this.instances.length, 0x01000193);
    for (const inst of this.instances) {
      h = Math.imul(h ^ inst.triggerIndex, 0x01000193);
      h = Math.imul(h ^ inst.followerGroup, 0x01000193);
      h = Math.imul(h ^ inst.followedTarget, 0x01000193);
      h = Math.imul(h ^ (inst.paused ? 1 : 0) ^ (inst.removeMe ? 2 : 0), 0x01000193);
    }
    for (const [id, ph] of this.physics) {
      h = Math.imul(h ^ id, 0x01000193);
      h = Math.imul(h ^ (ph.velX * 1000), 0x01000193);
      h = Math.imul(h ^ (ph.velY * 1000), 0x01000193);
    }
    return h >>> 0;
  }

  trigger(spec: TriggerSpec, host: AdvFollowHost): void {
    const followerGroup = host.grp(int(spec, 51));
    const followedTarget = followedTargetOf(spec);
    const controlId = int(spec, 534);
    const key = `${spec.index}:${followerGroup}:${followedTarget}:${controlId}`;
    this.ensureHistory(spec, followedTarget);
    for (const inst of this.instances) {
      if (instanceKey(inst) !== key) continue;
      inst.paused = false;
      inst.runOneSettlePass = false;
      inst.actionOrdinal = ++this.nextOrdinal;
      this.dirtySort = true;
      return;
    }
    this.instances.push({
      triggerIndex: spec.index,
      followerGroup,
      followedTarget,
      controlId,
      rangeRefObject: 0,
      actionOrdinal: ++this.nextOrdinal,
      paused: false,
      runOneSettlePass: false,
      removeMe: false,
      hasStarted: false,
    });
    this.dirtySort = true;
  }

  private ensureHistory(spec: TriggerSpec, followedTarget: number): void {
    const delay = num(spec, 292) + Math.abs(num(spec, 293));
    const len = delay > 0 ? Math.ceil(delay * HISTORY_HZ) + 2 : DEFAULT_HISTORY_LEN;
    this.history.ensure(followedTarget, len);
  }

  control(triggerIndex: number, controlId: number, mode: number): void {
    for (const inst of this.instances) {
      const hit = triggerIndex >= 0 ? inst.triggerIndex === triggerIndex : inst.controlId === controlId;
      if (!hit) continue;
      if (mode === 1) {
        inst.paused = true;
        inst.runOneSettlePass = true;
      } else if (mode === 2) {
        inst.paused = false;
        inst.runOneSettlePass = false;
      } else {
        inst.paused = false;
        inst.runOneSettlePass = false;
        inst.removeMe = true;
      }
    }
  }

  edit(spec: TriggerSpec, host: AdvFollowHost, rng: Lcg): void {
    const byControl = flag(spec, 535);
    const group = host.grp(int(spec, 51));
    if (byControl) {
      for (const inst of this.instances) {
        if (inst.controlId !== int(spec, 51)) continue;
        this.editFollowerGroup(inst, spec, host, rng);
      }
      return;
    }
    for (const idx of host.groupMembers(group)) this.modifyObjectPhysics(idx, spec, host, rng);
  }

  retarget(spec: TriggerSpec, host: AdvFollowHost): void {
    const newTarget = followedTargetOf(spec);
    if (newTarget === 0 && !flag(spec, 138) && !flag(spec, 200) && !flag(spec, 201)) return;
    this.ensureHistory(spec, newTarget);
    const sel = host.grp(int(spec, 51));
    if (flag(spec, 535)) {
      for (const inst of this.instances) if (inst.controlId === sel) inst.followedTarget = newTarget;
      return;
    }
    for (const inst of this.instances) {
      if (inst.followerGroup === sel) inst.followedTarget = newTarget;
    }
    for (const idx of host.groupMembers(sel)) {
      if (host.objectId(idx) !== 3016) continue;
      for (const inst of this.instances) if (inst.triggerIndex === idx) inst.followedTarget = newTarget;
    }
  }

  step(dt240: number, frame: number, host: AdvFollowHost, rand: AreaRandom, rng: Lcg): void {
    if (this.instances.length === 0) return;
    this.history.record(host);
    if (this.dirtySort) {
      this.instances.sort((a, b) => {
        const sa = host.specOf(a.triggerIndex);
        const sb = host.specOf(b.triggerIndex);
        const pa = sa ? sortPriority(sa) : 0;
        const pb = sb ? sortPriority(sb) : 0;
        if (pa === pb) return a.actionOrdinal - b.actionOrdinal;
        return pb - pa;
      });
      this.dirtySort = false;
    }
    for (const inst of this.instances) {
      if (inst.paused) {
        if (!inst.runOneSettlePass) continue;
        inst.runOneSettlePass = false;
        this.processInstance(inst, true, dt240, frame, host, rand, rng);
      } else {
        this.processInstance(inst, inst.removeMe, dt240, frame, host, rand, rng);
      }
    }
    this.instances = this.instances.filter((i) => !i.removeMe);
    for (const [id, ph] of [...this.physics.entries()]) {
      if (ph.lastMoveFrame < frame) this.physics.delete(id);
    }
  }

  private editFollowerGroup(inst: AdvFollowInstance, spec: TriggerSpec, host: AdvFollowHost, rng: Lcg): void {
    for (const idx of host.groupMembers(inst.followerGroup)) this.modifyObjectPhysics(idx, spec, host, rng);
  }

  private modifyObjectPhysics(objectIndex: number, spec: TriggerSpec, host: AdvFollowHost, rng: Lcg): void {
    const modX = num(spec, 567);
    const modY = num(spec, 569);
    const sx = Math.fround(num(spec, 566) + (modX !== 0 ? modX * rng.next01() : 0));
    const sy = Math.fround(num(spec, 568) + (modY !== 0 ? modY * rng.next01() : 0));
    const ph = this.physics.get(objectIndex);
    if (!ph) {
      this.velMul.set(objectIndex, { sx, sy });
      this.stepMul.set(objectIndex, { sx, sy });
      return;
    }
    ph.velX = Math.fround(ph.velX * sx);
    ph.velY = Math.fround(ph.velY * sy);
    this.stepMul.set(objectIndex, { sx, sy });
    const speed = Math.fround(num(spec, 300) + num(spec, 301) * rng.next01());
    if (speed !== 0) {
      const angle = Math.fround(num(spec, 563) + num(spec, 564) * rng.next01());
      const [kx, ky] = followSpeedVal(host, objectIndex, int(spec, 560), int(spec, 565), angle, speed);
      if (!flag(spec, 306)) ph.velY = Math.fround(ph.velY + ky);
      if (!flag(spec, 307)) ph.velX = Math.fround(ph.velX + kx);
    }
  }

  private getPhysics(objectIndex: number, frame: number): GameObjectPhysics {
    let ph = this.physics.get(objectIndex);
    if (!ph) {
      ph = newPhysics(objectIndex);
      this.physics.set(objectIndex, ph);
    }
    ph.stamp = frame;
    return ph;
  }

  private savedPosition(host: AdvFollowHost, followedTarget: number, delay: number): [number, number] {
    return this.history.get(host, followedTarget, delay);
  }

  private skipTarget(followedTarget: number, delay: number, target: [number, number]): boolean {
    if (target[0] !== 0 || target[1] !== 0) return false;
    if (followedTarget < 0) return false;
    if (delay > 0) return true;
    if (followedTarget > 0) return true;
    return false;
  }

  private processInstance(
    inst: AdvFollowInstance,
    settlePass: boolean,
    dt240: number,
    frame: number,
    host: AdvFollowHost,
    rand: AreaRandom,
    rng: Lcg,
  ): void {
    const spec = host.specOf(inst.triggerIndex);
    if (!spec) return;
    // Enter-effect group copies: when the special-key map has an entry, walk
    // the copy array over one or two passes instead of the plain group.
    // [gdp processAdvancedFollowAction :453786-453818]
    const special = getSpecialKey(inst.followerGroup, flag(spec, 280), flag(spec, 281));
    const copySlot = host.enterCopySlot?.(special) ?? 0;
    const passes = copySlot <= 0 ? 1 : 2;
    for (let pass = 0; pass < passes; pass++) {
      const members =
        copySlot > 0 ? (host.copyGroupMembers?.(copySlot, pass) ?? []) : host.groupMembers(inst.followerGroup);
      if (members.length === 0 && copySlot <= 0) continue;
      for (const obj of members) {
        const ph = this.getPhysics(obj, frame);
        if (ph.lastStepFrame >= frame) continue;
        if (settlePass) {
          if (ph.lastMoveFrame < frame) {
            ph.lastMoveFrame = frame;
            host.setMotion(obj, 0, 0, 0);
          }
          continue;
        }
        this.processObject(inst, spec, obj, ph, dt240, frame, host, rand, rng);
      }
    }
  }

  private processObject(
    inst: AdvFollowInstance,
    spec: TriggerSpec,
    obj: number,
    ph: GameObjectPhysics,
    dt: number,
    frame: number,
    host: AdvFollowHost,
    rand: AreaRandom,
    rng: Lcg,
  ): void {
    const delay = advModded(num(spec, 292), num(spec, 293), obj, ADV_FOLLOW_SLOT.delay, rand);
    const pos = host.objectPosition(obj);
    let target = this.savedPosition(host, inst.followedTarget, delay);
    if (inst.followedTarget < 0) target = [target[0], pos[1]];
    if (this.skipTarget(inst.followedTarget, delay, target)) return;
    let dx = target[0] - pos[0];
    let dy = target[1] - pos[1];
    const dist = mag(dx, dy);
    const xOnly = flag(spec, 306);
    const yOnly = flag(spec, 307);
    const maxSpeed = advModded(num(spec, 298), num(spec, 299), obj, ADV_FOLLOW_SLOT.maxSpeed, rand);
    let accel = advModded(num(spec, 334), num(spec, 335), obj, ADV_FOLLOW_SLOT.accel, rand) * 0.01;
    const maxRange = advModded(num(spec, 308), num(spec, 309), obj, ADV_FOLLOW_SLOT.maxRange, rand);
    if (xOnly) dy = 0;
    else if (yOnly) dx = 0;
    const rangeDist = dist;
    if (maxRange !== 0 && rangeDist > maxRange) return;

    if (!inst.hasStarted) {
      const speed = Math.fround(num(spec, 300) + num(spec, 301) * rng.next01());
      if (speed !== 0) {
        const angle = Math.fround(num(spec, 563) + num(spec, 564) * rng.next01());
        const [kx, ky] = followSpeedVal(host, obj, int(spec, 560), int(spec, 565), angle, speed);
        const mode572 = int(spec, 572);
        if (ph.lastMoveFrame !== 0 && mode572 === 1) {
          // leave velocity
        } else if (ph.lastMoveFrame !== 0 && mode572 === 2) {
          if (!xOnly) ph.velY = Math.fround(ph.velY + ky);
          if (!yOnly) ph.velX = Math.fround(ph.velX + kx);
        } else {
          if (!xOnly) ph.velY = ky;
          if (!yOnly) ph.velX = kx;
        }
      }
    }
    inst.hasStarted = true;
    ph.lastMoveFrame = frame;
    if (flag(spec, 571)) ph.lastStepFrame = frame;

    const mul = this.velMul.get(obj);
    if (mul) {
      ph.velX = Math.fround(ph.velX * mul.sx);
      ph.velY = Math.fround(ph.velY * mul.sy);
      this.velMul.delete(obj);
    }

    const mode = int(spec, 367);
    if (mode === 2) this.integrateMode2(spec, obj, ph, dx, dy, dist, dt, rand, xOnly, yOnly, accel);
    else if (mode === 1) this.integrateMode1(spec, obj, ph, dx, dy, dist, dt, rand, xOnly, yOnly, accel);
    else this.integrateMode0(spec, obj, ph, dx, dy, dt, rand, xOnly, yOnly);

    if (mode !== 2) {
      if (dist >= num(spec, 364)) ph.aimAngle = pointAngle([ph.velX, ph.velY]);
      const turnDiv = Math.max(1, num(spec, 363));
      const step = closestDirectionMod(ph.aimAngle - pointAngle([ph.dirX, ph.dirY]), PI) / turnDiv;
      const [nx, ny] = ccpForAngle(pointAngle([ph.dirX, ph.dirY]) + step);
      ph.dirX = nx;
      ph.dirY = ny;
    }

    let rot = 0;
    if (flag(spec, 339)) {
      const want = Math.fround(90 - pointAngle([ph.dirX, ph.dirY]) * 57.296 + num(spec, 340));
      rot = closestDirectionMod(want - host.objectRotation(obj), 180) * 0.25;
    }

    const vmag = xOnly ? Math.abs(ph.velX) : yOnly ? Math.abs(ph.velY) : mag(ph.velX, ph.velY);
    if (vmag > maxSpeed && maxSpeed > 0) {
      const s = maxSpeed / vmag;
      if (xOnly) ph.velX *= s;
      else if (yOnly) ph.velY *= s;
      else {
        ph.velX *= s;
        ph.velY *= s;
      }
    }

    let stepX = ph.velX * dt;
    let stepY = ph.velY * dt;
    if (xOnly) stepY = 0;
    else if (yOnly) stepX = 0;
    const sm = this.stepMul.get(obj);
    if (sm) {
      stepX = Math.fround(stepX * sm.sx);
      stepY = Math.fround(stepY * sm.sy);
    }
    if (stepX !== 0 || stepY !== 0 || rot !== 0) host.setMotion(obj, stepX, stepY, rot);
  }

  private integrateMode0(
    spec: TriggerSpec,
    obj: number,
    ph: GameObjectPhysics,
    dx: number,
    dy: number,
    dt: number,
    rand: AreaRandom,
    xOnly: boolean,
    yOnly: boolean,
  ): void {
    let smooth = advModded(num(spec, 361), num(spec, 362), obj, ADV_FOLLOW_SLOT.smooth, rand);
    if (smooth <= 1) smooth = 1;
    const vx = dx / smooth;
    const vy = dy / smooth;
    if (!xOnly) ph.velY = vy;
    if (!yOnly) ph.velX = vx;
  }

  private integrateMode1(
    spec: TriggerSpec,
    obj: number,
    ph: GameObjectPhysics,
    dx: number,
    dy: number,
    dist: number,
    dt: number,
    rand: AreaRandom,
    xOnly: boolean,
    yOnly: boolean,
    accel: number,
  ): void {
    const nearDist = advModded(num(spec, 359), num(spec, 360), obj, ADV_FOLLOW_SLOT.nearDist, rand);
    let drag = advModded(num(spec, 558), num(spec, 559), obj, ADV_FOLLOW_SLOT.drag, rand) * 0.01;
    const [dirX, dirY] = normalize([dx, dy]);
    if (nearDist > 0 && dist < nearDist) {
      const t = 1 - dist / nearDist;
      const nearAcc = advModded(num(spec, 357), num(spec, 358), obj, ADV_FOLLOW_SLOT.nearAccel, rand) * 0.01;
      const nearDrag = advModded(num(spec, 561), num(spec, 562), obj, ADV_FOLLOW_SLOT.nearDrag, rand) * 0.01;
      accel = Math.fround(accel + t * (nearAcc - accel));
      drag = Math.fround(drag + t * (nearDrag - drag));
    }
    if (drag !== 0) {
      const fx = ph.velX - ph.velX * (drag * dt);
      const fy = ph.velY - ph.velY * (drag * dt);
      if (!xOnly) ph.velY = fy;
      if (!yOnly) ph.velX = fx;
    }
    const ax = dirX * (accel * dt);
    const ay = dirY * (accel * dt);
    if (!xOnly) ph.velY = Math.fround(ph.velY + ay);
    if (!yOnly) ph.velX = Math.fround(ph.velX + ax);
  }

  private integrateMode2(
    spec: TriggerSpec,
    obj: number,
    ph: GameObjectPhysics,
    dx: number,
    dy: number,
    dist: number,
    dt: number,
    rand: AreaRandom,
    xOnly: boolean,
    yOnly: boolean,
    accel: number,
  ): void {
    const [dirX, dirY] = normalize([dx, dy]);
    if (ph.dirX === 0 && ph.dirY === 0) {
      ph.dirX = dirX;
      ph.dirY = dirY;
    }
    let turn = advModded(num(spec, 316), num(spec, 317), obj, ADV_FOLLOW_SLOT.turnRate, rand) * 0.01;
    const slowTurn = advModded(num(spec, 318), num(spec, 319), obj, ADV_FOLLOW_SLOT.slowTurn, rand) * 0.01;
    const fastTurn = advModded(num(spec, 320), num(spec, 321), obj, ADV_FOLLOW_SLOT.fastTurn, rand) * 0.01;
    const slowThr = advModded(num(spec, 322), num(spec, 323), obj, ADV_FOLLOW_SLOT.slowThr, rand);
    const fastThr = advModded(num(spec, 324), num(spec, 325), obj, ADV_FOLLOW_SLOT.fastThr, rand);
    let brake = advModded(num(spec, 326), num(spec, 327), obj, ADV_FOLLOW_SLOT.brake, rand) * 0.01;
    const brakeAng = advModded(num(spec, 328), num(spec, 329), obj, ADV_FOLLOW_SLOT.brakeAng, rand) * DEG;
    const brakeTurn = advModded(num(spec, 330), num(spec, 331), obj, ADV_FOLLOW_SLOT.brakeTurn, rand) * 0.01;
    const brakeThr = advModded(num(spec, 332), num(spec, 333), obj, ADV_FOLLOW_SLOT.brakeThr, rand);
    const speed = mag(ph.velX, ph.velY);
    if (flag(spec, 337) && speed <= slowThr) turn = slowTurn;
    else if (flag(spec, 338) && speed >= fastThr && fastThr > 0) turn = fastTurn;
    const err = closestDirectionMod(pointAngle([dirX, dirY]) - pointAngle([ph.dirX, ph.dirY]), PI);
    if (brake > 0 && Math.abs(err) > brakeAng && speed > brakeThr) turn = brakeTurn;
    ph.turnRate = Math.fround(ph.turnRate + (turn - ph.turnRate) / 10);
    let w = clampTurn(ph.turnRate, err);
    if (w !== 0) {
      const c = Math.cos(w * dt);
      const s = Math.sin(w * dt);
      const vx0 = ph.velX;
      const vy0 = ph.velY;
      if (!xOnly) ph.velY = Math.fround(vx0 * s + vy0 * c);
      if (!yOnly) ph.velX = Math.fround(vx0 * c - vy0 * s);
      const [nx, ny] = ccpForAngle(pointAngle([ph.dirX, ph.dirY]) + w * dt);
      ph.dirX = nx;
      ph.dirY = ny;
    }
    if (brake > 0 && Math.abs(err - w) - brakeAng > 0) {
      const bx = Math.min(Math.abs(brake * ph.dirX * dt), Math.abs(ph.velX)) * Math.sign(ph.velX || 1);
      const by = Math.min(Math.abs(brake * ph.dirY * dt), Math.abs(ph.velY)) * Math.sign(ph.velY || 1);
      if (!xOnly) ph.velY = Math.fround(ph.velY - by);
      if (!yOnly) ph.velX = Math.fround(ph.velX - bx);
      accel = 0;
    }
    const pushAlong = flag(spec, 305);
    const pushX = pushAlong ? dirX : ph.dirX;
    const pushY = pushAlong ? dirY : ph.dirY;
    if (!xOnly) ph.velY = Math.fround(ph.velY + accel * pushY * dt);
    if (!yOnly) ph.velX = Math.fround(ph.velX + accel * pushX * dt);
  }
}
