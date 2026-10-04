// Static object shapes, the spatial hash over them, and the two decompiled
// resolvers the sim calls per overlapping object: collidedWithObjectInternal
// (solids) and collidedWithSlopeInternal (slopes). Shapes are precomputed once
// into typed arrays so the per-tick path touches no objects and allocates
// nothing.

import type { Level, LevelObject } from "../level/types";
import type { ObjectDef, ObjectTable, OrbType, PadType } from "./types";
import {
  HEAD_SNAP_PUSH_VELOCITY,
  PLATFORM_FAST_SPEED,
  PLATFORMER_CONTACT_INSET,
  POST_FLIP_SNAP_GRACE,
  SLOPE_ATTACH_TOLERANCE,
  SLOPE_ATTACH_TOLERANCE_ON_SLOPE,
  SLOPE_ENTRY_INSET,
  SLOPE_EXIT_A,
  SLOPE_EXIT_CAP,
  SLOPE_EXIT_YVEL_FACTOR,
  SLOPE_FLYING_BALL_FACTOR,
  SLOPE_FLY_HOLD_TOLERANCE,
  SLOPE_FLY_HOLD_TOLERANCE_ON_SLOPE,
  SLOPE_FLYING_CONTACT_CLAMP,
  SLOPE_HAZARD_SURFACE_OFFSET,
  SLOPE_KEEP_RISING_VELOCITY,
  SLOPE_NEW_SLOPE_OFFSET,
  SLOPE_PLATFORMER_ICE_ANGLE,
  SNAP_THRESHOLD,
  SNAP_THRESHOLD_FLYING,
  SNAP_THRESHOLD_PLATFORMER,
  SNAP_THRESHOLD_SCALED,
  SPATIAL_CELL,
  SPIDER_FLIP_GRACE,
  STAIR_SNAP,
  STAIR_SNAP_MINI_4X,
  TICKS_PER_SECOND,
  BALL_SLOPE_ROLL_CAP,
  BALL_SLOPE_ROLL_SOFT_A,
  BALL_SLOPE_ROLL_SOFT_B,
} from "./constants";
import { DEG, normDeg, rectsTouch, rotateCW, slopeOrientation, snap90 } from "./geometry";
import { ROUND_HAZARD_BOXES } from "./objectData";
import { loadRotation } from "./objects";
import type { Player } from "./player";

// ---------------------------------------------------------------------------
// codes
// ---------------------------------------------------------------------------

export const K_NONE = 0;
export const K_SOLID = 1;
export const K_HAZARD = 2;
export const K_SLOPE = 3;
export const K_ORB = 4;
export const K_PAD = 5;
export const K_PORTAL = 6;
export const K_COLLECTIBLE = 7;
export const K_CHECKPOINT = 8;
/** Letter modifier block (D/J/S/H/F): a pass-through volume. D, J, H and F change how solids behave for this pass and the next; S ends a dash. */
export const K_SPECIAL = 10;
/**
 * Force block (2069) or force circle (3645): a pass-through volume that
 * pushes the player in the update after each pass that touches it. Type 40
 * like the letter blocks; touchedObject tells them apart by id.
 * [gdp PlayerObject::touchedObject, gd-ida-decomp.cpp:159675-159697;
 *  collisionCheckObjects case 0x28 :463812-463813]
 */
export const K_FORCE = 11;

export const S_AABB = 0;
export const S_OBB = 1;
export const S_CIRCLE = 2;
export const S_TRI = 3;

export const F_PASSABLE = 1;
export const F_BREAKABLE = 2;
/**
 * The orb, pad or portal fires again on every fresh entry instead of once per
 * player: key 99 in a classic level, the absence of key 444 in a platformer.
 * A speed portal answers to key 87 alone.
 */
export const F_MULTI = 4;
/**
 * One player's touch spends the object for both, as triggerActivated marks it.
 * Only a speed portal sets this so far.
 */
export const F_SHARED = 8;
export const F_UPHILL = 16;
export const F_SOLID_ABOVE = 32;
/**
 * A portal's "checked" box, key 13. Still decoded, and still nothing reads it:
 * the flying corridor is anchored to the portal's own y either way, which is
 * what this flag used to be the only route to. Kept so the bit is accounted for
 * rather than quietly dropped from the table.
 */
export const F_CHECKED = 64;
export const F_FREE_MODE = 128;
export const F_REVERSE = 256;
/** The object is drawn upside down (key 5). Pads and orbs read it to know which way they face. */
export const F_FLIP_Y = 1024;
/**
 * The ring's Claim Touch (key 445): touching it never fires it, only a press
 * made inside it does, and that press does nothing else — no jump, no other
 * ring, and the button counts as let go. Only the custom rings (type 36: the
 * toggle orb and the toggle block) read the key; every other ring ignores it.
 * [gdp RingObject::customObjectSetup, gd-ida-decomp.cpp:302969-302983; read in
 *  playerTouchedRing :463290 and pushButton :160478-160482]
 */
export const F_CLAIM_TOUCH = 2048;
/**
 * Extended collision, key 511 (atoi != 0): the game files the object in none
 * of its sections and tests it on every collision pass, after the sections,
 * wherever the player is.
 * [gdp GameObject::objectFromVector :184187-184191 (+536); addToSection
 *  :444818-444833 (the list at +11352); checkCollisions :464968-464970]
 */
export const F_EXTENDED = 4096;
/**
 * A dash orb's "allow collide" (key 587, +1652): in a platformer, running
 * into a wall does not end the dash it starts.
 * [gdp DashRingObject::customObjectSetup, gd-ida-decomp.cpp:303028-303031;
 *  read by collidedWithObjectInternal :152327, :152349]
 */
export const F_DASH_ALLOW_COLLIDE = 8192;
/**
 * A dash orb's "stop slide" (key 589, +1653): the push a platformer dash
 * ends with does not let the player past the flying caps or slide on.
 * [gdp DashRingObject::customObjectSetup, gd-ida-decomp.cpp:303032-303036;
 *  read by stopDashing :149811-149812]
 */
export const F_DASH_STOP_SLIDE = 16384;
/**
 * A portal's "disable grid snap", key 370: the corridor it sets up skips the
 * 30-unit snap. [gdp EffectGameObject::customObjectSetup :299740-299743 →
 *  updateCameraMode :451200; read in animateInDualGroundNew :451068]
 */
export const F_NO_SNAP = 32768;
/**
 * "Don't boost Y", key 496 (+1113): landing on it holds off a moving
 * platform's launch for two updates.
 * [gdp updateLastGroundObject, gd-ida-decomp.cpp:142737-142751; the key,
 *  objectFromVector :184162]
 */
export const F_NO_BOOST_Y = 65536;

/**
 * A force object's two switches, in ObjectSet.forceMode: key 528, the push
 * points away from the object's centre instead of along its angle (towards
 * it when flipped upside down), and key 529, the strength runs from key 526
 * to key 527 across the object instead of being key 149.
 * [gdp ForceBlockGameObject::customObjectSetup, gd-ida-decomp.cpp:301283-301294]
 */
export const FORCE_RELATIVE = 1;
export const FORCE_RANGE = 2;

export const P_MODE_BASE = 0; // + mode index 0..7
export const P_GRAV_NORMAL = 10;
export const P_GRAV_FLIP = 11;
export const P_GRAV_TOGGLE = 12;
export const P_MIRROR_ON = 13;
export const P_MIRROR_OFF = 14;
export const P_SIZE_MINI = 15;
export const P_SIZE_NORMAL = 16;
export const P_SPEED_BASE = 20; // + speed 0..4
export const P_DUAL_ON = 30;
export const P_DUAL_OFF = 31;
export const P_TP_LINKED_ENTRY = 40;
export const P_TP_LINKED_EXIT = 41;
export const P_TP_TARGET_ENTRY = 42;
export const P_TP_TARGET_EXIT = 43;

export const ORB_CODE: Record<OrbType, number> = {
  yellow: 0,
  pink: 1,
  red: 2,
  blue: 3,
  green: 4,
  black: 5,
  spider: 6,
  dash: 7,
  dashGravity: 8,
  toggle: 9,
  teleport: 10,
};
export const ORB_TYPES: OrbType[] = ["yellow", "pink", "red", "blue", "green", "black", "spider", "dash", "dashGravity", "toggle", "teleport"];
export const PAD_CODE: Record<PadType, number> = { yellow: 0, pink: 1, red: 2, blue: 3, spider: 4 };
export const PAD_TYPES: PadType[] = ["yellow", "pink", "red", "blue", "spider"];
export const SPECIAL_CODE: Record<"D" | "J" | "S" | "H" | "F", number> = { D: 1, J: 2, S: 3, H: 4, F: 5 };

const MODE_INDEX: Record<string, number> = { cube: 0, ship: 1, ball: 2, ufo: 3, wave: 4, robot: 5, spider: 6, swing: 7 };

// ---------------------------------------------------------------------------
// Spatial hash
// ---------------------------------------------------------------------------

export class SpatialHash {
  constructor(
    readonly cell: number,
    readonly minX: number,
    readonly minY: number,
    readonly cols: number,
    readonly rows: number,
    readonly cellStart: Int32Array,
    readonly items: Int32Array,
  ) {}

  static build(n: number, x0: Float64Array, y0: Float64Array, x1: Float64Array, y1: Float64Array, active: Uint8Array, cell: number): SpatialHash {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    // A box turned inside out by a negative scale (kA33 off) keeps its ends
    // the other way round; the cells it covers are the same.
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const lo = Math.min(x0[i], x1[i]);
      const hi = Math.max(x0[i], x1[i]);
      if (lo < minX) minX = lo;
      if (Math.min(y0[i], y1[i]) < minY) minY = Math.min(y0[i], y1[i]);
      if (hi > maxX) maxX = hi;
      if (Math.max(y0[i], y1[i]) > maxY) maxY = Math.max(y0[i], y1[i]);
    }
    if (minX === Infinity) {
      minX = minY = 0;
      maxX = maxY = cell;
    }
    const cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1);
    const rows = Math.max(1, Math.floor((maxY - minY) / cell) + 1);
    const counts = new Int32Array(cols * rows + 1);
    const cellOf = (x: number, y: number): number => {
      let cx = Math.floor((x - minX) / cell);
      let cy = Math.floor((y - minY) / cell);
      if (cx < 0) cx = 0;
      if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0;
      if (cy >= rows) cy = rows - 1;
      return cy * cols + cx;
    };
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const a = cellOf(Math.min(x0[i], x1[i]), Math.min(y0[i], y1[i]));
      const b = cellOf(Math.max(x0[i], x1[i]), Math.max(y0[i], y1[i]));
      const ax = a % cols;
      const ay = (a - ax) / cols;
      const bx = b % cols;
      const by = (b - bx) / cols;
      for (let cy = ay; cy <= by; cy++) for (let cx = ax; cx <= bx; cx++) counts[cy * cols + cx + 1]++;
    }
    for (let c = 1; c <= cols * rows; c++) counts[c] += counts[c - 1];
    const cellStart = counts;
    const fill = new Int32Array(cols * rows);
    const items = new Int32Array(cellStart[cols * rows]);
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const a = cellOf(Math.min(x0[i], x1[i]), Math.min(y0[i], y1[i]));
      const b = cellOf(Math.max(x0[i], x1[i]), Math.max(y0[i], y1[i]));
      const ax = a % cols;
      const ay = (a - ax) / cols;
      const bx = b % cols;
      const by = (b - bx) / cols;
      for (let cy = ay; cy <= by; cy++) {
        for (let cx = ax; cx <= bx; cx++) {
          const c = cy * cols + cx;
          items[cellStart[c] + fill[c]++] = i;
        }
      }
    }
    return new SpatialHash(cell, minX, minY, cols, rows, cellStart, items);
  }

  /** Collects object indices whose cells overlap the rect (deduplicated with `stamp`), returns the count. */
  query(qx0: number, qy0: number, qx1: number, qy1: number, out: Int32Array, stamp: Int32Array, id: number): number {
    let cx0 = Math.floor((qx0 - this.minX) / this.cell);
    let cy0 = Math.floor((qy0 - this.minY) / this.cell);
    let cx1 = Math.floor((qx1 - this.minX) / this.cell);
    let cy1 = Math.floor((qy1 - this.minY) / this.cell);
    if (cx1 < 0 || cy1 < 0 || cx0 >= this.cols || cy0 >= this.rows) return 0;
    if (cx0 < 0) cx0 = 0;
    if (cy0 < 0) cy0 = 0;
    if (cx1 >= this.cols) cx1 = this.cols - 1;
    if (cy1 >= this.rows) cy1 = this.rows - 1;
    let n = 0;
    const cap = out.length;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.cols + cx;
        const end = this.cellStart[c + 1];
        for (let k = this.cellStart[c]; k < end; k++) {
          const i = this.items[k];
          if (stamp[i] === id) continue;
          stamp[i] = id;
          if (n < cap) out[n++] = i;
        }
      }
    }
    return n;
  }
}

// ---------------------------------------------------------------------------
// Object set
// ---------------------------------------------------------------------------

/** Mutable per-object state lives in a byte per slot: bit layout below. */
export const ST_ACT_P1 = 1;
export const ST_ACT_P2 = 2;
export const ST_TOUCH_P1 = 4;
export const ST_TOUCH_P2 = 8;
export const ST_DESTROYED = 16;

export class ObjectSet {
  readonly n: number;
  readonly kind: Uint8Array;
  readonly shape: Uint8Array;
  readonly cx: Float64Array;
  readonly cy: Float64Array;
  readonly hw: Float64Array;
  readonly hh: Float64Array;
  readonly cosR: Float64Array;
  readonly sinR: Float64Array;
  readonly rotDeg: Float64Array;
  /**
   * The rotation as the level and the rotate triggers leave it, never wrapped
   * or snapped: what a pad or orb reads to know which way it faces.
   * [gdp GameObject::getObjectRotation :163874-163876 — key 6 at +828
   *  (objectFromVector :184213-184218) plus the rotate triggers' turn at +576
   *  (fastRotateObject :170742-170746)]
   */
  readonly rawRot: Float64Array;
  readonly x0: Float64Array;
  readonly y0: Float64Array;
  readonly x1: Float64Array;
  readonly y1: Float64Array;
  readonly flags: Uint32Array;
  readonly param: Int32Array;
  readonly param2: Float64Array;
  /**
   * A round object's own box, half across and half up, at its scale: what a
   * trigger's turn makes it meet the player's box with (see `turned`). 0 for
   * anything not round. [gdp GameObject::updateOrientedBox,
   * gd-ida-decomp.cpp:170865-170900; its size, +648/+652, in roundBoxSize]
   */
  readonly boxHw: Float64Array;
  readonly boxHh: Float64Array;
  /**
   * 1 for a round object a trigger has turned. The turn gives it an oriented
   * box (+636), so it kills only where the player's own box also meets that
   * box — unless the level has kA39. A circle's placed angle never does:
   * updateIsOriented stops at a radius.
   * [gdp GameObject::fastRotateObject :170742-170750, updateIsOriented
   *  :170702-170722; the hazard test :465038-465052, collisionCheckObjects
   *  :463462-463478]
   */
  readonly turned: Uint8Array;
  /**
   * A dash orb's speed (key 586, +1640), end boost (key 588, +1644) and
   * longest dash in seconds (key 590, +1648): floats, 0 when the key is
   * absent. Only a platformer reads them.
   * [gdp DashRingObject::customObjectSetup, gd-ida-decomp.cpp:303016-303027,
   *  303037-303046]
   */
  readonly dashSpeed: Float32Array;
  readonly dashEndBoost: Float32Array;
  readonly dashMaxDuration: Float32Array;
  /**
   * A force object's strength (key 149, +1636) and the range mode's two ends
   * (keys 526 and 527, +1640 and +1644): floats, 0 when the key is absent.
   * Its force ID (key 530, +1652) is `param`, its two switches `forceMode`.
   * [gdp ForceBlockGameObject::customObjectSetup, gd-ida-decomp.cpp:301266-301306]
   */
  readonly forceStrength: Float32Array;
  readonly forceMin: Float32Array;
  readonly forceMax: Float32Array;
  readonly forceMode: Uint8Array;
  readonly slot: Int32Array;
  readonly slotCount: number;
  readonly hash: SpatialHash;
  /** Every object index sorted by x, for the debug query. */
  readonly byX: Int32Array;
  /** Objects carrying a group, for group-targeted teleports and platformer spawns. */
  readonly groups: Map<number, number[]>;
  /**
   * Key 170 of the orbs, pads, portals, collectibles, checkpoints, force
   * blocks and letter blocks that carry one: effect objects, which only the
   * active gameplay channel (or channel 0) lets the player touch. The secret
   * coin is the one exception, a plain object that never reads the key.
   * Empty in every official level but Dash (two speed portals and two
   * 2902s).
   * [gdp EffectGameObject::customObjectSetup reads 170 into +1584
   *  :298700-298704; canTouchObject :421284-421300 gates class 1 (+1076,
   *  EffectGameObject::init :307708). GameObject::createWithKey
   *  :182950-183752 builds the pads, the mode, gravity, mirror, size, speed
   *  and dual portals, the coins and items other than 142 and the letter
   *  blocks as EffectGameObjects (EffectGameObject::create :183018), the
   *  orbs as RingObjects (:308156-308160, DashRingObject::init
   *  :308184-308187), the teleports as TeleportPortalObjects
   *  (:310562-310566) and 2063 as a CheckpointGameObject (:308378-308383),
   *  all of class 1; 142 comes from GameObject::createWithFrame (:183133).
   *  The force blocks are EffectGameObjects too (ForceBlockGameObject::init
   *  :312930-312933), whose customObjectSetup reads 170 through
   *  EffectGameObject's (:301266-301276)]
   */
  readonly channelOf: Map<number, number>;

  constructor(
    readonly level: Level,
    readonly table: ObjectTable,
  ) {
    const objs = level.objects;
    const n = objs.length;
    this.n = n;
    this.kind = new Uint8Array(n);
    this.shape = new Uint8Array(n);
    this.cx = new Float64Array(n);
    this.cy = new Float64Array(n);
    this.hw = new Float64Array(n);
    this.hh = new Float64Array(n);
    this.cosR = new Float64Array(n);
    this.sinR = new Float64Array(n);
    this.rotDeg = new Float64Array(n);
    this.rawRot = new Float64Array(n);
    this.x0 = new Float64Array(n);
    this.y0 = new Float64Array(n);
    this.x1 = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.flags = new Uint32Array(n);
    this.param = new Int32Array(n);
    this.param2 = new Float64Array(n);
    this.boxHw = new Float64Array(n);
    this.boxHh = new Float64Array(n);
    this.turned = new Uint8Array(n);
    this.dashSpeed = new Float32Array(n);
    this.dashEndBoost = new Float32Array(n);
    this.dashMaxDuration = new Float32Array(n);
    this.forceStrength = new Float32Array(n);
    this.forceMin = new Float32Array(n);
    this.forceMax = new Float32Array(n);
    this.forceMode = new Uint8Array(n);
    this.slot = new Int32Array(n).fill(-1);
    this.groups = new Map();
    this.channelOf = new Map();
    const active = new Uint8Array(n);
    let slots = 0;
    const platformer = level.header.platformer;
    const signedScale = !level.header.fixNegativeScale;

    for (let i = 0; i < n; i++) {
      const o = objs[i];
      if (o.groups.length > 0) {
        for (const g of o.groups) {
          let list = this.groups.get(g);
          if (!list) this.groups.set(g, (list = []));
          list.push(i);
        }
      }
      const def = table.get(o.id);
      const hb = def.hitbox;
      if (!hb) continue;
      // 121 no_touch: pure decoration whatever the id says.
      if (o.props[121] === "1") continue;
      const kind = kindCode(def);
      if (kind === K_NONE) continue;
      // A checkpoint object is a trigger to the collision pass, which fires it
      // on touch only with key 11. The editor sets that on every one it places;
      // without it only a spawn can fire one, so the pass never looks at it.
      // [gdp collisionCheckObjects case 0x14 :463671-463673 →
      //  playerTouchedTrigger, gated on +1284 :456793; +1284 from key 11,
      //  EffectGameObject::customObjectSetup :298669-298675, which
      //  CheckpointGameObject::init :308378-308388 leaves clear. firstSetup,
      //  which sets it for a 2063 (:297434-297437), is the editor's placing
      //  (LevelEditorLayer::createObject :201794); objectFromVector, which
      //  loads a level, never calls it (:183768-184390)]
      if (kind === K_CHECKPOINT && (parseInt(o.props[11] ?? "0", 10) || 0) === 0) continue;
      this.kind[i] = kind;
      active[i] = 1;
      let flags = 0;
      if (o.props[134] === "1") flags |= F_PASSABLE;
      if (def.breakable) flags |= F_BREAKABLE;
      if (o.props[13] === "1") flags |= F_CHECKED;
      if (o.props[111] === "1") flags |= F_FREE_MODE;
      if (o.props[370] === "1") flags |= F_NO_SNAP;
      if ((parseInt(o.props[496] ?? "0", 10) || 0) !== 0) flags |= F_NO_BOOST_Y;
      if (o.props[117] === "1") flags |= F_REVERSE;
      if (o.flipY) flags |= F_FLIP_Y;
      if (def.portal?.type === "speed") {
        // A speed portal is a Modifier (type 20) and fires through the trigger
        // path. Whichever player touches it, the speed goes to both. Key 87,
        // the multi-trigger box, makes it fire again on each player's fresh
        // entry. Otherwise triggerActivated marks it used for both players, so
        // in a classic level one player spends it for both; where
        // canMultiActivate says yes (a platformer without key 444, a classic
        // level with key 99) the loop ignores those marks and the trigger's own
        // record, one per player unless key 284 shares it, decides instead.
        // [gdp collisionCheckObjects case 0x14 :463671-463674, loop skip :463439;
        //  playerTouchedTrigger :456781-456825; EffectGameObject::triggerActivated
        //  :298093-298099 → EnhancedGameObject::triggerActivated :164128-164132;
        //  hasBeenActivatedByPlayer :165257-165270; +1476 = key 87, +1548 = key
        //  284 at :298685-298692]
        const multiActivate = platformer ? o.props[444] !== "1" : o.props[99] === "1";
        if (o.props[87] === "1") flags |= F_MULTI;
        else if (!multiActivate || o.props[284] === "1") flags |= F_SHARED;
      } else if (kind === K_ORB || kind === K_PAD || kind === K_PORTAL) {
        // canMultiActivate: in a platformer every orb, pad and portal fires
        // again on each entry unless key 444 asks for once; elsewhere only key
        // 99 makes one fire again. [gdp EnhancedGameObject::canMultiActivate,
        // gd-ida-decomp.cpp:164106-164112; keys read at :181776-181785]
        if (platformer ? o.props[444] !== "1" : o.props[99] === "1") flags |= F_MULTI;
      }
      // atoi(value) != 0, as customObjectSetup reads it — and only for a custom
      // ring (type 36); on any other orb the key is never read. Type 36 also
      // covers the toggle block, which is not simulated as a ring here.
      // [gd-ida-decomp.cpp:302969-302983]
      if (kind === K_ORB && def.orb === "toggle" && (parseInt(o.props[445] ?? "0", 10) || 0) !== 0) flags |= F_CLAIM_TOUCH;
      if ((parseInt(o.props[511] ?? "0", 10) || 0) !== 0) flags |= F_EXTENDED;

      const sx = Math.abs(o.scaleX) || 1;
      const sy = Math.abs(o.scaleY) || 1;
      // The hitbox offset goes through the object's node, whose scale keeps
      // its sign whatever kA33 says. [GameObject::getBoxOffset :170768-170795]
      const osx = o.scaleX < 0 ? -sx : sx;
      const osy = o.scaleY < 0 ? -sy : sy;
      const rigid = kind === K_SOLID || kind === K_SLOPE || kind === K_SPECIAL;
      // A solid, breakable or slope that may not rotate freely is loaded at 0
      // when its angle is off the quarter turns, as it is drawn: the cut is to
      // the object's own rotation, which its rect reads. [gdp
      // GameObject::objectFromVector :184221-184225; see objects.ts loadRotation]
      const angle = rigid ? loadRotation(o) : o.rotation;
      const rot = rigid ? snap90(angle) : normDeg(angle);
      this.rotDeg[i] = rot;
      this.rawRot[i] = angle;

      if (hb.type === "slope") {
        const orient = slopeOrientation(o.flipX, o.flipY, angle);
        let w = hb.w * sx;
        let h = hb.h * sy;
        if (orient.swapped) {
          const t = w;
          w = h;
          h = t;
        }
        this.shape[i] = S_TRI;
        this.cx[i] = o.x;
        this.cy[i] = o.y;
        this.hw[i] = w / 2;
        this.hh[i] = h / 2;
        this.cosR[i] = 1;
        this.sinR[i] = 0;
        if (orient.uphill) flags |= F_UPHILL;
        if (orient.solidAbove) flags |= F_SOLID_ABOVE;
        // getSlopeAngle(): atan(height / width) of the object rect.
        this.param2[i] = Math.atan2(h, w);
      } else if (hb.type === "circle") {
        let ox = hb.ox;
        let oy = hb.oy;
        if (o.flipX) ox = -ox;
        if (o.flipY) oy = -oy;
        const [rx, ry] = rotateCW(ox * osx, oy * osy, rot);
        this.shape[i] = S_CIRCLE;
        this.cx[i] = o.x + rx;
        this.cy[i] = o.y + ry;
        this.hw[i] = hb.r * Math.max(sx, sy);
        this.hh[i] = this.hw[i];
        this.cosR[i] = 1;
        this.sinR[i] = 0;
        const [bw, bh] = roundBoxSize(o.id, def);
        this.boxHw[i] = (bw * sx) / 2;
        this.boxHh[i] = (bh * sy) / 2;
      } else {
        let ox = hb.ox;
        let oy = hb.oy;
        if (o.flipX) ox = -ox;
        if (o.flipY) oy = -oy;
        const [rx, ry] = rotateCW(ox * osx, oy * osy, rot);
        let w = hb.w * sx;
        let h = hb.h * sy;
        this.cx[i] = o.x + rx;
        this.cy[i] = o.y + ry;
        // Oriented is the game's test, on the angle cut to whole degrees: 0.5°
        // and 90.5° stay upright, and keep their rect unturned, which only an
        // angle of exactly 90 or 270 swaps. [gdp GameObject::updateIsOriented,
        // gd-ida-decomp.cpp:170702-170722; the swap, setRotation :164488-164489
        // and getObjectRect :170839-170844]
        if (rigid || Math.trunc(angle) % 90 === 0) {
          // Without kA33 a negative scale is a negative size: the rect's min
          // and max trade places, and rectsTouch, which is CCRect's test,
          // then only meets a player that spans it. The oriented box below
          // is the same whichever way round. [getObjectRect :170826-170830]
          if (signedScale) {
            w = hb.w * osx;
            h = hb.h * osy;
          }
          if (rot === 90 || rot === 270) {
            const t = w;
            w = h;
            h = t;
          }
          this.shape[i] = S_AABB;
          this.cosR[i] = 1;
          this.sinR[i] = 0;
        } else {
          this.shape[i] = S_OBB;
          this.cosR[i] = Math.cos(rot * DEG);
          this.sinR[i] = Math.sin(rot * DEG);
        }
        this.hw[i] = w / 2;
        this.hh[i] = h / 2;
      }

      // World AABB.
      if (this.shape[i] === S_OBB) {
        const ex = Math.abs(this.hw[i] * this.cosR[i]) + Math.abs(this.hh[i] * this.sinR[i]);
        const ey = Math.abs(this.hw[i] * this.sinR[i]) + Math.abs(this.hh[i] * this.cosR[i]);
        this.x0[i] = this.cx[i] - ex;
        this.x1[i] = this.cx[i] + ex;
        this.y0[i] = this.cy[i] - ey;
        this.y1[i] = this.cy[i] + ey;
      } else {
        this.x0[i] = this.cx[i] - this.hw[i];
        this.x1[i] = this.cx[i] + this.hw[i];
        this.y0[i] = this.cy[i] - this.hh[i];
        this.y1[i] = this.cy[i] + this.hh[i];
      }

      // Sub-type parameters.
      switch (kind) {
        case K_ORB:
          this.param[i] = ORB_CODE[def.orb ?? "yellow"];
          this.param2[i] = Number(o.props[51] ?? 0); // toggle / teleport target group
          if (def.orb === "dash" || def.orb === "dashGravity") {
            // atof and atoi, as customObjectSetup reads them. [:303016-303046]
            this.dashSpeed[i] = parseFloat(o.props[586] ?? "0") || 0;
            this.dashEndBoost[i] = parseFloat(o.props[588] ?? "0") || 0;
            this.dashMaxDuration[i] = parseFloat(o.props[590] ?? "0") || 0;
            if ((parseInt(o.props[587] ?? "0", 10) || 0) !== 0) flags |= F_DASH_ALLOW_COLLIDE;
            if ((parseInt(o.props[589] ?? "0", 10) || 0) !== 0) flags |= F_DASH_STOP_SLIDE;
          }
          break;
        case K_PAD:
          this.param[i] = PAD_CODE[def.pad ?? "yellow"];
          break;
        case K_PORTAL:
          this.param[i] = portalCode(def);
          if (this.param[i] === P_TP_LINKED_ENTRY) {
            // Key 54, the exit's height over the portal, is read with a 0.0
            // fallback and nothing else supplies one: a linked portal without
            // it exits level with itself. The editor places a new one 100 up,
            // and saves always write the key.
            // [gdp TeleportPortalObject::customObjectSetup :303108-303113;
            //  PlayLayer::addObject :89924-89937; EditorUI::addSpecial
            //  :201251-201258]
            const off = Number(o.props[54]);
            this.param2[i] = Number.isFinite(off) ? off : 0;
          } else if (this.param[i] === P_TP_TARGET_ENTRY) {
            this.param2[i] = Number(o.props[51] ?? 0);
          }
          break;
        case K_SPECIAL:
          this.param[i] = SPECIAL_CODE[def.special ?? "H"];
          break;
        case K_FORCE:
          // atof, atof, atof, atoi != 0 twice and atoi, as customObjectSetup
          // reads them. [:301277-301305]
          this.forceStrength[i] = parseFloat(o.props[149] ?? "0") || 0;
          this.forceMin[i] = parseFloat(o.props[526] ?? "0") || 0;
          this.forceMax[i] = parseFloat(o.props[527] ?? "0") || 0;
          if ((parseInt(o.props[528] ?? "0", 10) || 0) !== 0) this.forceMode[i] |= FORCE_RELATIVE;
          if ((parseInt(o.props[529] ?? "0", 10) || 0) !== 0) this.forceMode[i] |= FORCE_RANGE;
          this.param[i] = parseInt(o.props[530] ?? "0", 10) || 0;
          break;
        default:
          break;
      }
      this.flags[i] = flags;

      if (
        kind === K_ORB ||
        kind === K_PAD ||
        kind === K_PORTAL ||
        kind === K_COLLECTIBLE ||
        kind === K_CHECKPOINT ||
        (kind === K_SOLID && (flags & F_BREAKABLE) !== 0)
      ) {
        this.slot[i] = slots++;
      }
      if ((kind >= K_ORB && kind <= K_CHECKPOINT && def.collectible !== "secretCoin") || kind === K_SPECIAL || kind === K_FORCE) {
        const channel = parseInt(o.props[170] ?? "0", 10) || 0;
        if (channel !== 0) this.channelOf.set(i, channel);
      }
    }
    this.slotCount = slots;
    this.hash = SpatialHash.build(n, this.x0, this.y0, this.x1, this.y1, active, SPATIAL_CELL);
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => objs[a].x - objs[b].x);
    this.byX = order;
  }

  /**
   * A copy whose geometry a sim may move, sharing everything that cannot change.
   *
   * The base set is shared between every sim of a level and must stay that way,
   * but a trigger can move a group of objects, and collision has to see them
   * where they now are. So a sim that loads a level with a movement trigger
   * takes one of these and writes the twelve position-bearing arrays, the
   * shapes, which a turn can make oriented, and a round object's box and
   * turned mark; kinds, flags, slots, the group index, the x order and the
   * spatial hash are all still the originals.
   * Levels without a movement trigger — which is every one of the first
   * eighteen — never take the copy at all.
   */
  cloneForMotion(): ObjectSet {
    const out = Object.create(ObjectSet.prototype) as Record<string, unknown>;
    Object.assign(out, this);
    out.shape = this.shape.slice();
    out.cx = this.cx.slice();
    out.cy = this.cy.slice();
    out.hw = this.hw.slice();
    out.hh = this.hh.slice();
    out.cosR = this.cosR.slice();
    out.sinR = this.sinR.slice();
    out.rotDeg = this.rotDeg.slice();
    out.rawRot = this.rawRot.slice();
    out.x0 = this.x0.slice();
    out.y0 = this.y0.slice();
    out.x1 = this.x1.slice();
    out.y1 = this.y1.slice();
    out.boxHw = this.boxHw.slice();
    out.boxHh = this.boxHh.slice();
    out.turned = this.turned.slice();
    return out as unknown as ObjectSet;
  }

  /**
   * The level mirrored across the line y = x, for colliding a player whose
   * gameplay is rotated.
   *
   * Rotated gameplay sends the player along y and pulls it along x. Rather than
   * teach every resolver a second axis, the geometry is presented in the
   * player's own frame — gravity down, forward along +x — and the resolvers
   * run exactly as they do in ordinary play. The game does the same thing one
   * object at a time: it turns the colliding object into the player's frame,
   * runs the ordinary collision, and maps the result back.
   *
   * This mirrors where the game turns, and that is deliberate. The player's own
   * motion under rotation is a swap of the two axes, which is a mirror, so a
   * collision frame built by turning would put the direction of travel on the
   * wrong side for half the orientations. A mirror keeps forward on +x for a
   * player that is not reversed, which is what every resolver here assumes.
   *
   * The spatial hash is rebuilt from the mirrored bounds, so a query in the
   * player's frame finds the right neighbours. Objects a trigger moves are kept
   * current by `reflectObject`, the same way `cloneForMotion` is.
   * [gdp PlayerObject::update :161086-161098 (the swap);
   *  PlayerObject::handleRotatedCollisionInternal :158040-158078 (the approach)]
   */
  cloneReflected(): ObjectSet {
    const n = this.n;
    const out = Object.create(ObjectSet.prototype) as Record<string, unknown>;
    Object.assign(out, this);
    out.shape = new Uint8Array(n);
    out.cx = new Float64Array(n);
    out.cy = new Float64Array(n);
    out.hw = new Float64Array(n);
    out.hh = new Float64Array(n);
    out.cosR = new Float64Array(n);
    out.sinR = new Float64Array(n);
    out.rotDeg = new Float64Array(n);
    out.rawRot = new Float64Array(n);
    out.x0 = new Float64Array(n);
    out.y0 = new Float64Array(n);
    out.x1 = new Float64Array(n);
    out.y1 = new Float64Array(n);
    out.boxHw = new Float64Array(n);
    out.boxHh = new Float64Array(n);
    out.turned = new Uint8Array(n);
    // A mirror keeps a slope's diagonal running the same way but moves the
    // right angle across it — for an uphill slope only. See triangle() below:
    // the uphill apex sits off the diagonal on the side the flag names, and the
    // mirror carries that corner to the opposite side.
    const flags = this.flags.slice();
    for (let i = 0; i < n; i++) {
      if (this.shape[i] === S_TRI && (flags[i] & F_UPHILL) !== 0) flags[i] ^= F_SOLID_ABOVE;
    }
    out.flags = flags;
    const view = out as unknown as ObjectSet;
    const active = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      reflectObject(this, view, i);
      active[i] = this.kind[i] === K_NONE ? 0 : 1;
    }
    out.hash = SpatialHash.build(n, view.x0, view.y0, view.x1, view.y1, active, SPATIAL_CELL);
    return view;
  }

  /** Slope triangle corners: a, b = hypotenuse ends, c = right angle. */
  triangle(i: number, out: Float64Array): void {
    const x0 = this.x0[i];
    const x1 = this.x1[i];
    const y0 = this.y0[i];
    const y1 = this.y1[i];
    const uphill = (this.flags[i] & F_UPHILL) !== 0;
    const above = (this.flags[i] & F_SOLID_ABOVE) !== 0;
    if (uphill) {
      out[0] = x0;
      out[1] = y0;
      out[2] = x1;
      out[3] = y1;
    } else {
      out[0] = x0;
      out[1] = y1;
      out[2] = x1;
      out[3] = y0;
    }
    if (above) {
      out[4] = uphill ? x0 : x1;
      out[5] = y1;
    } else {
      out[4] = uphill ? x1 : x0;
      out[5] = y0;
    }
  }

  /** GameObject::slopeYPos(x): surface height under/over the player's x. */
  slopeYPos(i: number, x: number): number {
    const left = this.x0[i];
    const right = this.x1[i];
    const bottom = this.y0[i];
    const top = this.y1[i];
    const ratio = (top - bottom) / (right - left);
    const uphill = (this.flags[i] & F_UPHILL) !== 0;
    let r: number;
    if (left < x) {
      const d = x - right;
      r = uphill ? top + d * ratio : bottom - d * ratio;
    } else {
      const d = left - x;
      r = uphill ? bottom - d * ratio : top + d * ratio;
    }
    if (this.kind[i] === K_HAZARD) r += (this.flags[i] & F_SOLID_ABOVE) !== 0 ? -SLOPE_HAZARD_SURFACE_OFFSET : SLOPE_HAZARD_SURFACE_OFFSET;
    return r;
  }
}

function kindCode(def: ObjectDef): number {
  if (def.special) return K_SPECIAL;
  switch (def.kind) {
    case "solid":
      return K_SOLID;
    case "hazard":
      return K_HAZARD;
    case "slope":
      return K_SLOPE;
    case "orb":
      return K_ORB;
    case "pad":
      return K_PAD;
    case "portal":
      return K_PORTAL;
    case "collectible":
      return K_COLLECTIBLE;
    case "checkpoint":
      return K_CHECKPOINT;
    case "forceBlock":
      return K_FORCE;
    default:
      return K_NONE;
  }
}

/** A round object's own box, w and h before its scale: see ROUND_HAZARD_BOXES. */
function roundBoxSize(id: number, def: ObjectDef): [number, number] {
  const box = ROUND_HAZARD_BOXES.get(id);
  if (box) return [box.w, box.h];
  return [(def.gridW ?? 1) * 30, (def.gridH ?? 1) * 30];
}

function portalCode(def: ObjectDef): number {
  const p = def.portal;
  if (!p) return -1;
  switch (p.type) {
    case "mode":
      return P_MODE_BASE + (MODE_INDEX[p.mode] ?? 0);
    case "gravity":
      return p.flipped ? P_GRAV_FLIP : P_GRAV_NORMAL;
    case "gravityToggle":
      return P_GRAV_TOGGLE;
    case "mirror":
      return p.mirrored ? P_MIRROR_ON : P_MIRROR_OFF;
    case "size":
      return p.mini ? P_SIZE_MINI : P_SIZE_NORMAL;
    case "speed":
      return P_SPEED_BASE + p.speed;
    case "dual":
      return p.dual ? P_DUAL_ON : P_DUAL_OFF;
    case "teleport":
      switch (p.kind) {
        case "linkedEntry":
          return P_TP_LINKED_ENTRY;
        case "linkedExit":
          return P_TP_LINKED_EXIT;
        case "targetEntry":
          return P_TP_TARGET_ENTRY;
        default:
          return P_TP_TARGET_EXIT;
      }
    default:
      return -1;
  }
}

// ---------------------------------------------------------------------------
// Solid collision — PlayerObject::collidedWithObjectInternal, static objects,
// written gravity-relative: the game mirrors it for flipped play itself and
// never reads kA32 here (the gravity bug is Player.fallingBugged alone).
// rel(v) = flipMod * v; "feet" is the side gravity pulls toward, "head" the
// other one.
// ---------------------------------------------------------------------------

export const R_NONE = 0;
export const R_LAND = 1;
export const R_CEIL = 2;
export const R_DIE = 3;
export const R_BREAK = 4;

function setRelY(p: Player, yr: number): void {
  p.setY(p.flipped ? -yr : yr);
}

/**
 * A floor contact: the platform's speed (+1328, 0 for a block not coming
 * toward the feet) and updateLastGroundObject's "don't boost Y" hold.
 * [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:151970-151971;
 *  updateLastGroundObject :142737-142751]
 */
function landedOn(p: Player, o: ObjectSet, i: number, platformVel: number): void {
  p.platformYVel = platformVel;
  if (o.flags[i] & F_NO_BOOST_Y) p.noBoostYPasses = 2;
}

/**
 * The floor or ceiling a solid contact gives the squeeze test. canSnap picks
 * it, not the side the player was put on: with canSnap clear the block's top
 * is a floor, even when met head first; with it set the block's bottom is a
 * ceiling, even when landed on, unless the block is breakable (type 21) or
 * passable (key 134), when it records nothing. `floor` and `ceiling` are
 * those two edges in world y, so upside down the block's bottom and top.
 * [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:151947-151980 (put on
 *  top), 152155-152204 (put under); canSnap is v61, :151786-151808]
 */
function recordSqueezeContact(
  p: Player,
  canSnap: boolean,
  noCeiling: boolean,
  floor: number,
  ceiling: number,
  pivotX: number,
  pivotY: number,
  object: number,
): void {
  if (!canSnap) p.updateCollideBottom(floor, pivotX, pivotY, object);
  else if (!noCeiling) p.updateCollideTop(ceiling, pivotX, pivotY, object);
}

/**
 * The wall a platformer's side push gives the squeeze test: `face`, the
 * block's edge the player is put against, a wall on its left when it is put
 * to the block's right. In rotated gameplay the game's turn runs x the other
 * way from the mirror (Player.contactX), so the sides trade.
 * [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:152313-152315 (put right,
 *  updateCollideLeft with the block's maxX), 152335-152337 (put left,
 *  updateCollideRight with its minX)]
 */
function recordWallContact(p: Player, putRight: boolean, face: number, pivotX: number, pivotY: number, object: number): void {
  if (putRight !== p.axesSwapped) p.updateCollideLeft(face, pivotX, pivotY, object);
  else p.updateCollideRight(face, pivotX, pivotY, object);
}

/**
 * collidedWithObjectInternal against object `i`, over its own box or, from
 * preSlopeCollision, over one of a slope's edge strips (`x0`..`y1`).
 */
export function collideSolid(
  p: Player,
  o: ObjectSet,
  i: number,
  plat: boolean,
  x0 = o.x0[i],
  y0 = o.y0[i],
  x1 = o.x1[i],
  y1 = o.y1[i],
): number {
  const g = p.flipped ? -1 : 1;
  const half = p.hitboxSize() * 0.5;
  const flags = o.flags[i];
  const passable = (flags & F_PASSABLE) !== 0;
  const breakable = (flags & F_BREAKABLE) !== 0;
  const objTop = g > 0 ? y1 : -y0;
  const objBot = g > 0 ? y0 : -y1;
  const yr = g * p.y;
  const feet = yr - half;
  const head = yr + half;
  const prevFeet = g * p.lastY - half;
  const prevHead = g * p.lastY + half;
  // Where the player stood as this object's turn began: rotated gameplay
  // measures the floor and ceiling it meets from here (Player.contactY).
  const pivotX = p.x;
  const pivotY = p.y;

  // snapUpThreshold. A platformer player that has just grown back from mini
  // gets 15 for two passes; the flying 6 still wins outside a platformer.
  // [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:151513-151532]
  let thr: number;
  if (plat && !p.wasOnSlope && !p.onSlope) thr = SNAP_THRESHOLD_PLATFORMER;
  else thr = SNAP_THRESHOLD;
  if (p.scaleSnapPasses > 0) thr = SNAP_THRESHOLD_SCALED;
  if (p.isFlying && !plat) thr = SNAP_THRESHOLD_FLYING;
  if (p.wasOnSlope) thr += p.slopeExtra;

  // A moving object: its last move, toward the feet or away from them. One
  // coming toward the feet widens the threshold by its speed and is recorded
  // as the platform's speed (+1328), world-signed. Moving at more than 5, it
  // is met even by a player moving away from it. The scale trigger's share of
  // the move (getScalePosDelta) is not taken out.
  // [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:151538-151627]
  const move = p.world.objectRise?.(i, p.axesSwapped) ?? 0;
  let platformVel = 0;
  let toFeet = false;
  let awayFromFeet = false;
  let fastPlatform = false;
  if (g * move > 0) {
    platformVel = Math.fround(move / p.stepDt);
    const speed = Math.abs(platformVel);
    fastPlatform = speed > PLATFORM_FAST_SPEED;
    thr += speed;
    if (!plat) p.platformYVel = platformVel;
    toFeet = true;
  } else if (g * move < 0) awayFromFeet = true;

  const boolB = !passable && (p.stateHitHead > 0 || plat || p.stateFlipGravity > 0);
  // "canSnap" in the decomp: the object sits above the feet (now or a tick ago).
  const objAboveFeet = feet + thr <= objBot || prevFeet + thr <= objBot;
  const isCube = !p.isFlying && !p.isBall && !p.isRobot && !p.isSpider;
  // A platformer player meets a block's top or bottom only if its box, made
  // narrower by the inset, still touches the block; one only against its
  // side goes straight to the wall push, so a stack of blocks is a wall and
  // not a ladder. [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:151632-151634
  //  (inset), 151741 (narrow box), 151767-151773 (→ LABEL_210, the wall push)]
  const inset = PLATFORMER_CONTACT_INSET * 0.5;
  const facesMet = !plat || rectsTouch(p.x - half + inset, p.y - half, p.x + half - inset, p.y + half, x0, y0, x1, y1);

  if (!(p.isWave && p.stateDartSlide < 1) && facesMet) {
    // 1. Landing: the floor-side surface is within the snap threshold of the
    //    feet now or before the move.
    if (!(objTop > feet + thr && objTop > prevFeet + thr)) {
      // Rising away from the surface: a corner pass, no contact, unless a
      // block coming up under it carries it: then it lands and rises at least
      // as fast as the block. The world's bottom side (a flipped player's
      // floor) also lets a platformer meet it while +1336 is up.
      // [gdp line 174; gd-ida-decomp.cpp:151853, 151891-151912 (normal
      //  gravity), 152060-152086 (flipped)]
      if (g * p.yVel > 0 && !p.wasOnSlope && !fastPlatform && (!p.flipped || !plat || p.lastPlatformYVel <= 0)) {
        if (!objAboveFeet && toFeet) {
          const v = p.yVel;
          setRelY(p, objTop + half);
          p.hitGround(i, false);
          p.updateCollideBottom(g * objTop, pivotX, pivotY, i);
          landedOn(p, o, i, platformVel);
          p.setYVelocity(v);
          if (g * p.yVel < g * p.platformYVel) p.setYVelocity(p.platformYVel);
        }
        return R_NONE;
      }
      setRelY(p, objTop + half);
      if (isCube) checkSnapJumpToObject(p, o, i);
      // canSnap picks between the two for every object contact, landings
      // included. [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:151937-151940
      // (normal gravity), 152150-152153 (flipped)]
      if (objAboveFeet) p.hitGroundNoJump(i, false);
      else p.hitGround(i, false);
      // The squeeze contact: a floor, or a ceiling when canSnap is set because
      // the player crossed a thin block in one step.
      recordSqueezeContact(p, objAboveFeet, breakable || passable, g * objTop, g * objBot, pivotX, pivotY, i);
      // A floor contact names the ground object and its speed; a flying player
      // that crossed a block coming up takes the platform's speed.
      // [:151964-151971, 151987-151993, 152175-152180, 152201-152206]
      if (!objAboveFeet) landedOn(p, o, i, platformVel);
      else if (p.isFlying && toFeet) p.setYVelocity(p.platformYVel);
      if (isCube && p.stateNoAutoJump > 0 && p.padRingRelated) {
        // J block: a cube carried here by a blue pad or a ring lets go of the
        // button, so holding through the launch does not jump again. A hold
        // from the player's own press is left alone, and the fresh press is
        // kept. [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:151985-151986
        // (normal gravity), 152169-152170 (flipped)]
        p.holding = false;
      }
      return R_LAND;
    }

    // 2. The object extends above feet + threshold: ceiling or side contact.
    const ceilingCapable = ((p.isFlying || p.isBall) && !passable) || boolB;
    if (ceilingCapable && i !== p.lastFloorObj) {
      const deep = objBot < head - thr && objBot < prevHead - thr;
      // Moving away from the block, the head meets it only when it moves at
      // more than 5, or when it comes down on a head that crossed it: then
      // the player is put under it and falls at least 1 faster than the block.
      // [gd-ida-decomp.cpp:152060-152061 and 152089-152120 (normal gravity),
      //  151853-151889 (flipped)]
      const away = g * p.yVel < 0 && !p.wasOnSlope && !fastPlatform && (p.flipped || !plat || p.lastPlatformYVel <= 0);
      if (!deep && away && objAboveFeet && awayFromFeet) {
        const v = p.yVel;
        setRelY(p, objBot - half);
        p.hitGroundNoJump(i, true);
        recordSqueezeContact(p, true, breakable || passable, g * objTop, g * objBot, pivotX, pivotY, i);
        p.setYVelocity(v);
        const limit = p.platformYVel - g;
        if (g * p.yVel > g * limit) p.setYVelocity(limit);
        return plat && breakable ? R_BREAK : R_CEIL;
      }
      if (!deep && !away) {
        setRelY(p, objBot - half);
        if (isCube) checkSnapJumpToObject(p, o, i);
        // A head contact with canSnap set (always, for a full-size player that
        // is not this deep) stops the player and leaves the ground flags and
        // the latch alone, so a ball cannot flip off a block's underside.
        // [gdp collidedWithObjectInternal,
        // gd-ida-decomp.cpp:152150-152153 via 152213 (normal gravity),
        // 151937-151940 (flipped); hitGroundNoJump :150215-150229]
        if (!boolB || ((p.isFlying || p.isBall) && !passable)) {
          if (objAboveFeet) p.hitGroundNoJump(i, true);
          else p.hitGround(i, true);
        } else p.setYVelocity(0);
        // The squeeze contact: a ceiling, or with canSnap clear (a player whose
        // threshold is over half its height, as a mini ball's is) the block's
        // top as a floor. An F block's flip below clears it again.
        // [flipGravity, gd-ida-decomp.cpp:151146-151147]
        recordSqueezeContact(p, objAboveFeet, breakable || passable, g * objTop, g * objBot, pivotX, pivotY, i);
        // [:152155-152206, as for a landing]
        if (!objAboveFeet) landedOn(p, o, i, platformVel);
        else if (p.isFlying && toFeet) p.setYVelocity(p.platformYVel);
        // The J block's check runs after head contacts too, before the F block.
        // [gd-ida-decomp.cpp:152169-152170 (normal gravity), 151985-151986 (flipped)]
        if (isCube && p.stateNoAutoJump > 0 && p.padRingRelated) p.holding = false;
        if (objAboveFeet && p.stateFlipGravity > 0) {
          // F block: touching its underside turns the player over, toward it:
          // 2 toward the new floor. [gdp didHitHead → hardFlipGravity,
          // gd-ida-decomp.cpp:151223-151232, 151248-151265]
          p.flipGravity(!p.flipped);
          p.setYVelocity(-HEAD_SNAP_PUSH_VELOCITY * p.flipMod());
          p.maybeIsBoosted = true;
          p.onGround2 = false;
          if (p.stateNoAutoJump > 0) {
            p.onGround = false;
            p.holding = false;
            p.stateRingJump = false;
          }
        }
        return plat && breakable ? R_BREAK : R_CEIL;
      }
    }
  }

  if (plat) {
    // Platformer: walls push the player out instead of killing. [gdp lines 512-610]
    if (passable) return R_NONE;
    // The box, made shorter by the inset, must touch the block — unless it is
    // the block that last pushed the player — and one of two heights must be
    // strictly inside it: off a slope, the head and the feet each brought in
    // by the unwidened threshold; on or just off one, the head and the
    // centre. [gd-ida-decomp.cpp:151511-151526 (threshold), 152276-152291
    //  (heights), 152304-152307 (the test)]
    const remembered = i === p.wallLeftObj || i === p.wallRightObj;
    if (!remembered && !rectsTouch(p.x - half, p.y - half + inset, p.x + half, p.y + half - inset, x0, y0, x1, y1)) return R_NONE;
    let hi: number;
    let lo: number;
    if (p.onSlope || p.wasOnSlope || p.clock - p.slopeEndTick < 0.2 * TICKS_PER_SECOND) {
      hi = p.y + half * g;
      lo = p.y;
    } else {
      const wallThr = p.scaleSnapPasses > 0 ? SNAP_THRESHOLD_SCALED : SNAP_THRESHOLD_PLATFORMER;
      hi = p.y + half - wallThr;
      lo = p.y - half + wallThr;
    }
    if (!((hi < y1 && hi > y0) || (lo < y1 && lo > y0))) return R_NONE;
    // The remembered block keeps its side; any other goes by which half of it
    // the player is in. [:152310]
    let putRight = p.x > (x0 === o.x0[i] && x1 === o.x1[i] ? o.cx[i] : (x0 + x1) * 0.5);
    if (i === p.wallLeftObj) putRight = !p.axesSwapped;
    else if (i === p.wallRightObj) putRight = p.axesSwapped;
    // The block's face the player is put against is a wall for the squeeze
    // test, recorded before the move. [gd-ida-decomp.cpp:152315, 152337]
    if (!putRight) {
      recordWallContact(p, false, x0, pivotX, pivotY, i);
      p.setX(x0 - half);
      if (p.xVel > 0) p.xVel = 0;
    } else {
      recordWallContact(p, true, x1, pivotX, pivotY, i);
      p.setX(x1 + half);
      if (p.xVel < 0) p.xVel = 0;
    }
    // A wall ends a dash and lets go of the button, unless the orb allows
    // collisions. [gd-ida-decomp.cpp:152324-152331, 152346-152352]
    if (p.dashing && !p.dashAllowCollide) {
      p.stopDashing();
      p.holding = false;
    }
    return R_NONE;
  }

  // 3. Inner-hitbox death: 0.3 of the unscaled box, so 9 even for a mini
  // player. [gdp collidedWithObjectInternal, gd-ida-decomp.cpp:152369-152417]
  if (passable) return R_NONE;
  const inner = p.innerSize() * 0.5;
  if (!rectsTouch(p.x - inner, p.y - inner, p.x + inner, p.y + inner, x0, y0, x1, y1)) return R_NONE;
  if (objAboveFeet && p.isSafeFlip(POST_FLIP_SNAP_GRACE)) {
    // Just flipped into a block: snap under it instead of dying. [gdp lines 621-631;
    // isSafeFlip(0.1), gd-ida-decomp.cpp:152374]
    setRelY(p, objBot - half);
    p.hitGround(i, true);
    p.onGround2 = false;
    return R_CEIL;
  }
  if (p.isSpider && x1 < p.x + inner && p.clock - p.lastSpiderFlipTick < SPIDER_FLIP_GRACE * TICKS_PER_SECOND) return R_NONE;
  if (breakable) return R_BREAK;
  return R_DIE;
}

/** checkSnapJumpToObject: re-align x by up to the stair tolerance when landing on a stair pattern. [gdp] */
export function checkSnapJumpToObject(p: Player, o: ObjectSet, i: number): void {
  const posX = p.x;
  const objX = o.cx[i];
  if (p.snapObj >= 0 && p.snapObj !== i) {
    const t = p.speed === 4 && p.mini ? STAIR_SNAP_MINI_4X : STAIR_SNAP[p.speed];
    const little = p.mini ? t.littleStairMini : t.littleStair;
    const blockLength = p.flipMod() * 30;
    const dx = objX - o.cx[p.snapObj];
    const dy = o.cy[i] - o.cy[p.snapObj];
    if (
      (Math.abs(dx - little) <= t.threshold && Math.abs(dy - blockLength) <= t.threshold) ||
      (Math.abs(dx - t.downStair) <= t.threshold && Math.abs(dy + blockLength) <= t.threshold) ||
      (Math.abs(dx - t.bigStair) <= t.threshold && Math.abs(dy - blockLength * 2) <= t.threshold)
    ) {
      let newX = objX + p.snapDistance;
      if (Math.abs(newX - posX) > t.threshold) newX = newX <= posX ? posX - t.threshold : posX + t.threshold;
      p.setX(newX);
    }
  }
  p.snapObj = i;
  p.snapDistance = posX - objX;
}

/** preSlopeCollision's "carry on into the slope itself". */
const SLOPE_CONTINUE = -1;

/**
 * PlayerObject::preSlopeCollision: a slope's two straight sides, met as
 * one-unit strips of solid before the slope's face is.
 *
 * The vertical side is a strip only for a player past it and moving toward
 * it: left of a wall on the slope's left, or, on the right, going left or in
 * a platformer. A player moving away from that side meets no wall at all. The
 * flat side is a strip only for a player whose centre is past it, below a
 * floor slope's bottom or above a ceiling slope's top. In a platformer, on or
 * just off a slope, the wall strip is 5 shorter at each end; a classic player
 * going the strip's way has both strips a unit shorter at each end. Either
 * strip touching the player is collidedWithObjectInternal with that strip.
 * The slope the player last stood on skips all of this.
 *
 * Returns SLOPE_CONTINUE when the face is to be met, which is when neither
 * strip applied and the player touches the slope's box; otherwise the strips'
 * outcome. A slope moved by a trigger counts as still: its move this step is
 * not weighed against the player's.
 * [gd-ida-decomp.cpp:154084-154259; the slope's face skipped unless this
 *  returns 0, :157237]
 */
function preSlopeCollision(p: Player, o: ObjectSet, i: number, plat: boolean, wallLeft: boolean, floorTop: boolean): number {
  if (p.slopeUid === i) return SLOPE_CONTINUE;
  const ox0 = o.x0[i];
  const oy0 = o.y0[i];
  const ox1 = o.x1[i];
  const oy1 = o.y1[i];
  const half = p.hitboxSize() * 0.5;
  const px0 = p.x - half;
  const py0 = p.y - half;
  const px1 = p.x + half;
  const py1 = p.y + half;
  const goingLeft = p.reversed;
  const ends = plat && (p.onSlope || p.wasOnSlope) ? 5 : 0;
  let met = false;
  let inset = 0;
  let result = R_NONE;
  const strip = (x0: number, y0: number, x1: number, y1: number): void => {
    if (result === R_DIE || !rectsTouch(px0, py0, px1, py1, x0, y0, x1, y1)) return;
    const r = collideSolid(p, o, i, plat, x0, y0, x1, y1);
    if (r === R_DIE || r === R_BREAK) result = r;
  };

  // The vertical side. [:154149-154205]
  if (wallLeft ? p.x < ox0 : p.x > ox1 && (goingLeft || plat)) {
    inset = !plat && goingLeft === wallLeft ? 1 : 0;
    const e = inset + ends;
    if (wallLeft) strip(ox0, oy0 + e, ox0 + 1, oy1 - e);
    else strip(ox1 - 1, oy0 + e, ox1, oy1 - e);
    met = true;
  }
  // The flat side. [:154206-154229]
  if (floorTop ? p.y >= oy1 : p.y <= oy0 + 1) {
    if (floorTop) strip(ox0 + inset, oy1 - 1, ox1 - inset, oy1);
    else strip(ox0 + inset, oy0, ox1 - inset, oy0 + 1);
    met = true;
  }
  // [:154255-154258]
  if (!met && rectsTouch(px0, py0, px1, py1, ox0, oy0, ox1, oy1)) return SLOPE_CONTINUE;
  return result;
}

// ---------------------------------------------------------------------------
// Slope collision — PlayerObject::collidedWithSlopeInternal for static slopes
// (slopeMoveSpeed = 0, forced = false). The decompiler's "playerUphill" is
// the player going *down* the ramp (checked against the exit-velocity sign);
// it is named `descending` here. slopeFloorTop is `solidAbove`.
// ---------------------------------------------------------------------------

export function collideSlope(p: Player, o: ObjectSet, i: number, plat: boolean): number {
  const g = p.flipped ? -1 : 1;
  const h = p.hitboxSize();
  const radius = h * 0.5;
  const ox0 = o.x0[i];
  const oy0 = o.y0[i];
  const ox1 = o.x1[i];
  const oy1 = o.y1[i];
  const flags = o.flags[i];
  const uphill = (flags & F_UPHILL) !== 0;
  const solidAbove = (flags & F_SOLID_ABOVE) !== 0;
  const hazardSlope = o.kind[i] === K_HAZARD;
  const angle = o.param2[i];

  const pre = preSlopeCollision(p, o, i, plat, uphill === solidAbove, solidAbove);
  if (pre !== SLOPE_CONTINUE) return pre;

  const goingLeft = plat ? p.xVel < 0 : p.reversed;
  const slopeUphill = uphill !== !goingLeft;
  const descending = slopeUphill !== p.flipped;
  // v22, a float: the rect's width over the x speed, then its height over
  // that, each quotient a float; +1832 keeps it as a double of the float.
  // [gd-ida-decomp.cpp:157308-157309, 157905]
  const slopeYVel = Math.fround((oy1 - oy0) / Math.fround((ox1 - ox0) / (p.playerSpeed * p.speedMultiplier)));
  let floatG = descending ? (p.wasOnSlope ? SLOPE_ATTACH_TOLERANCE_ON_SLOPE : SLOPE_ATTACH_TOLERANCE) : 0;
  // A slope whose last move took it away from the feet adds that move, up to
  // 5 a step (10 in a platformer), and is met with the tolerance even going
  // up it (v30). [gd-ida-decomp.cpp:157320-157369, 157501-157502]
  const move = p.world.objectRise?.(i, p.axesSwapped) ?? 0;
  const slopeAway = g * move < 0;
  if (slopeAway) floatG = Math.fround(floatG + Math.min(Math.abs(Math.fround(move)), (plat ? 10 : 5) * p.stepDt));

  const slopeTopRelated = descending && p.slopeSolidAbove === solidAbove && p.flipped === solidAbove;
  if (p.wasOnSlope && p.slopeVelocity * g > 0 && (slopeTopRelated || p.currentSlopeYVel > slopeYVel)) return R_NONE;

  const radOnPrev = radius / Math.cos(p.slopeRotation);
  const onSlopeThreshold = p.y - g * (radOnPrev + floatG);
  if (p.wasOnSlope) {
    // A player that was on a slope meets every slope by the relaxed "still
    // attached" test, not by the rect. Upside down, only the bottom edge can let go:
    // the top-edge test is the upright branch alone, or a flipped ball lets go
    // of each ceiling slope the tick after meeting it.
    // [gd-ida-decomp.cpp:157376-157394]
    if (p.flipped) {
      if (onSlopeThreshold < oy0) return R_NONE;
    } else if (onSlopeThreshold > oy1) return R_NONE;
  } else if (!rectsTouch(p.x - radius, p.y - radius, p.x + radius, p.y + radius, ox0, oy0 + SLOPE_ENTRY_INSET, ox1, oy1 - SLOPE_ENTRY_INSET)) {
    return R_NONE;
  }

  const isNewSlope = p.wasOnSlope && p.slopeIdx !== i && p.slopeSolidAbove !== solidAbove;
  // The snap is worked out in floats, one rounding a step, in the game's
  // space (roundY): v44, the half height over the float cos of the float
  // angle; v46, the float size × 20; v48, the surface height as a float;
  // v50 = f(v48 ± v44) ∓ v46, and the limits the same way from the rect's
  // edge and the float half height. On a 45° slope a full-size v44 is a
  // half step of the position's grid from game y 128 to 256, so every sum
  // there is a tie, and where the roundings fall decides it.
  // [gd-ida-decomp.cpp:157398-157458; v46 :157414, 158010]
  const hF = Math.fround(h);
  const halfH = Math.fround(hF * 0.5);
  const v44 = Math.fround(Math.fround(hF / Math.fround(Math.cos(Math.fround(angle)))) * 0.5);
  const v46 = isNewSlope && !plat ? Math.fround(Math.fround(p.vehicleSize()) * SLOPE_NEW_SLOPE_OFFSET) : 0;
  const v48 = p.roundY(o.slopeYPos(i, p.x));
  let newY = solidAbove ? p.roundY(p.roundY(v48 - v44) + v46) : p.roundY(p.roundY(v48 + v44) - v46);
  let atLow: boolean;
  let atHigh: boolean;
  if (solidAbove) {
    const t = p.roundY(p.roundY(oy0 - halfH) + v46);
    const top = p.roundY(oy1);
    if (newY < t) newY = t;
    atLow = newY === t;
    if (newY > top) newY = top;
    atHigh = newY === top;
  } else {
    const t = p.roundY(p.roundY(oy1 + halfH) - v46);
    const bottom = p.roundY(oy0);
    if (newY > t) newY = t;
    atLow = newY === t;
    if (newY < bottom) newY = bottom;
    atHigh = newY === bottom;
  }

  const slopeUpsideDown = p.flipped !== solidAbove;
  const boolBB = !slopeUpsideDown && p.holding && p.isFlying && (!descending || plat);
  let collided: boolean;
  let boolI: boolean;
  if (slopeUpsideDown) {
    let floatP = descending ? 0 : floatG;
    if (p.isFlying && p.holding) floatP = p.wasOnSlope ? SLOPE_FLY_HOLD_TOLERANCE_ON_SLOPE : SLOPE_FLY_HOLD_TOLERANCE;
    collided = !p.onSlope && !isNewSlope && (!p.isFlying || plat || !descending) && g * p.y > g * (newY - floatP);
    if (g * p.y > g * newY) collided = true;
    boolI = (p.isFlying || p.isBall) && !p.holding && descending && p.wasOnSlope && !plat;
    if (collided && !p.isFlying && !p.isBall && !plat && p.stateHitHead <= 0) {
      // A cube hitting a ceiling slope. A recent flip or a recent mode change
      // saves it: it is put on the surface and sent back down at 2 or more.
      // Otherwise it dies more than 2 in; nearer than that it is left where it
      // is, still moving, and only loses the ground. (gdp has the snap on the
      // unsafe side.) [gd-ida-decomp.cpp:157646-157697, 157990-157992]
      const safe = p.isSafeMode(POST_FLIP_SNAP_GRACE) || p.isSafeFlip(POST_FLIP_SNAP_GRACE);
      if (safe || g * p.y - 2 <= g * newY) {
        if (safe) {
          p.setY(newY);
          p.setYVelocity(p.flipped ? Math.max(p.yVel, SLOPE_FLYING_CONTACT_CLAMP) : Math.min(p.yVel, -SLOPE_FLYING_CONTACT_CLAMP));
        }
        p.onGround = false;
        p.onGround2 = false;
        return R_NONE;
      }
      return R_DIE;
    }
  } else {
    // A ship holding the button is not caught by the tolerance. [gd-ida-decomp.cpp:157484-157497]
    const boolH = descending ? !isNewSlope && !p.onSlope && (!p.maybeIsBoosted || p.isFlying) && (!p.isShip || !p.holding) : slopeAway;
    collided = true;
    if (g * p.y >= g * newY) {
      collided = false;
      if (boolH && g * p.y < g * (newY + floatG)) collided = p.isUfo ? g * p.yVel <= 0 : true;
    }
    boolI = boolBB && isNewSlope && !plat;
  }

  if (collided && (hazardSlope || (!plat && p.stateHitHead <= 0 && (isNewSlope || (p.isWave && p.stateDartSlide <= 0))))) return R_DIE;

  if (p.wasOnSlope && p.slopeLastY === newY) {
    // No change since last tick: the decomp returns before setting m_isOnSlope,
    // which is how a player riding the clamped top edge gets released (and
    // launched). [gdp lines 161-166]
    if (!plat || Math.abs(p.xVel) >= 0.1) return R_NONE;
  }
  if (plat && !rectsTouch(p.x - radius - 2, p.y - radius - 10, p.x + radius + 2, p.y + radius + 10, ox0, oy0, ox1, oy1)) return R_NONE;
  if (!collided || (descending && p.isWave && p.holding && p.flipped === solidAbove)) return R_NONE;

  // Commit.
  p.slopeIdx = i;
  p.slopeUid = i;
  p.slopeAngle = angle;
  p.slopeAtLow = atLow;
  p.slopeAtHigh = atHigh;
  p.slopeLastY = newY;
  p.slopeSolidAbove = solidAbove;
  p.slopeDescending = descending;
  // +1392, a float from the same v44. [gd-ida-decomp.cpp:157760-157762]
  p.slopeExtra = Math.fround(v44 - halfH);
  const someMod = g * (descending ? 1 : -1) * (goingLeft ? -1 : 1);
  const oldRotation = p.slopeRotation;
  p.slopeRotation = angle * someMod;
  const pivotX = p.x;
  const pivotY = p.y;
  p.setY(newY);
  p.onSlope = true;
  // m_slopeStartTime: only the first tick of a slope run, so the launch it
  // hands over scales with how long the player actually rode it. [gdp line 215]
  if (!p.wasOnSlope) p.slopeStartTick = p.clock;
  p.collidingWithSlope = true;
  p.slopeUpsideDown = slopeUpsideDown;

  if (!boolI) {
    // The squeeze test's ceiling or floor is the player's own edge on the
    // slope. [updateCollide :143658-143669, called at :157816 and :157836]
    if (slopeUpsideDown) {
      // Written whether or not it is zeroed. [gd-ida-decomp.cpp:157800-157813]
      p.setYVelocity(g * p.yVel > 0 ? 0 : p.yVel);
      p.onGround = false;
      p.onGround2 = false;
      p.updateCollideTop(p.y + g * radius, pivotX, pivotY, i);
    } else {
      // The velocity it had, kept as a float, comes back above 5. [:157821-157825, 157946-157948]
      const old = Math.fround(p.yVel);
      p.hitGround(i, false);
      if (g * old > SLOPE_KEEP_RISING_VELOCITY) p.setYVelocity(old);
      if (plat && Math.abs(angle / DEG) > SLOPE_PLATFORMER_ICE_ANGLE && old < -5 && p.xVel > 0) p.xVel /= 2;
      p.updateCollideBottom(p.y - g * radius, pivotX, pivotY, i);
      // A slope moving up under it gives its speed as the platform's. Upside
      // down the game reads the move's x, not its y, and neither way looks at
      // rotated gameplay. [:157846-157866]
      const rise = p.world.objectRise?.(i, p.flipped) ?? 0;
      if (p.flipped ? rise < 0 : rise > 0) p.platformYVel = Math.fround(Math.fround(rise) / p.stepDt);
    }
  }

  if (slopeUpsideDown && p.isFlying && descending && !p.holding && g * p.yVel > -SLOPE_FLYING_CONTACT_CLAMP) {
    p.setYVelocity(g * -SLOPE_FLYING_CONTACT_CLAMP);
  } else if (boolBB && g * p.yVel < SLOPE_FLYING_CONTACT_CLAMP) {
    p.setYVelocity(g * SLOPE_FLYING_CONTACT_CLAMP);
  }

  p.currentSlopeYVel = slopeYVel;
  // +1956, a float, in the game's order: v100 = f(0.8 / the float angle),
  // capped at 1.1; v101 = f(f(v22 × 1.4) × v100); then the sign and flipMod,
  // which are exact. [gd-ida-decomp.cpp:157905-157913]
  const v100 = Math.min(Math.fround(SLOPE_EXIT_A / Math.fround(angle)), Math.fround(SLOPE_EXIT_CAP));
  const v101 = Math.fround(Math.fround(slopeYVel * SLOPE_EXIT_YVEL_FACTOR) * v100);
  p.slopeVelocity = v101 * g * (descending ? -1 : 1);
  if (slopeUpsideDown && plat && p.isUfo) p.holding = false;
  if (p.isFlying || p.isBall) {
    p.slopeVelocity = Math.fround(p.slopeVelocity * SLOPE_FLYING_BALL_FACTOR);
    if (p.isBall && oldRotation !== p.slopeRotation) {
      let ballRot = 1 / Math.cos(p.slopeRotation);
      if (ballRot > BALL_SLOPE_ROLL_CAP) ballRot = ballRot * BALL_SLOPE_ROLL_SOFT_A + BALL_SLOPE_ROLL_SOFT_B;
      // [:157926-157933]
      p.stopRotation();
      p.runBallRotation(ballRot);
    }
  }
  return R_LAND;
}

/** Objects the debug view can list: everything, by x. */
export function objectExtent(o: ObjectSet, obj: LevelObject, out: Float64Array): void {
  const i = obj.index;
  if (o.kind[i] !== K_NONE) {
    out[0] = o.x0[i];
    out[1] = o.y0[i];
    out[2] = o.x1[i];
    out[3] = o.y1[i];
    return;
  }
  const def = o.table.get(obj.id);
  const hw = ((def.gridW ?? 1) * 30 * Math.abs(obj.scaleX || 1)) / 2;
  const hh = ((def.gridH ?? 1) * 30 * Math.abs(obj.scaleY || 1)) / 2;
  const e = Math.max(hw, hh);
  out[0] = obj.x - e;
  out[1] = obj.y - e;
  out[2] = obj.x + e;
  out[3] = obj.y + e;
}


/**
 * Writes object `i` of `src` into `dst` mirrored across the line y = x.
 *
 * Every piece of geometry the resolvers read is carried over: the shape
 * stays, the box bounds trade axes, the centre trades axes, and an oriented
 * box keeps its two extents while its angle becomes 90° less — a mirror
 * reflects the box's own axes along with it, so the extents stay with the
 * axes they measured. A turned round object's box goes the same way. The
 * uphill slope flag is not touched here; it depends only on the object, so
 * `cloneReflected` settles it once. The raw rotation is copied unmirrored:
 * which way a pad or orb faces is asked of the world, never of the mirror.
 */
export function reflectObject(src: ObjectSet, dst: ObjectSet, i: number): void {
  dst.shape[i] = src.shape[i];
  dst.turned[i] = src.turned[i];
  const d = dst as unknown as Record<string, Float64Array>;
  d.cx[i] = src.cy[i];
  d.cy[i] = src.cx[i];
  d.hw[i] = src.hw[i];
  d.hh[i] = src.hh[i];
  d.boxHw[i] = src.boxHw[i];
  d.boxHh[i] = src.boxHh[i];
  d.cosR[i] = src.sinR[i];
  d.sinR[i] = src.cosR[i];
  d.rotDeg[i] = 90 - src.rotDeg[i];
  d.rawRot[i] = src.rawRot[i];
  d.x0[i] = src.y0[i];
  d.y0[i] = src.x0[i];
  d.x1[i] = src.y1[i];
  d.y1[i] = src.x1[i];
}

/**
 * Puts one object where its group's transform now says it is.
 *
 * `m` is the group's affine as six numbers (a, b, c, d, tx, ty), `spin` the
 * degrees the objects have been turned about themselves and `sx`/`sy` the scale
 * the group carries. The hitbox centre already includes the object's own
 * rotated offset, so carrying it through the affine is the whole of the rigid
 * motion.
 *
 * A box the group has turned becomes oriented at the angle it now has, right
 * angles included, and meets the player's own turned box from then on, as it
 * does in the game — which keeps it oriented even once it has turned back,
 * where this port looks only at the turn it has now. An upright box's
 * extents already stand the way its own right angle put them (swapped at
 * 90° and 270°), so an unturned one keeps them as they are. A round object
 * the group has turned is oriented the same way: it keeps its circle, and
 * gains its own box at the angle it now has (`turned`).
 *
 * Two approximations, both narrow: a solid or a letter block turned by a
 * group keeps an axis-aligned bound rather than becoming an oriented one, and
 * a slope's triangle follows its box rather than being rebuilt. Circles,
 * oriented boxes and every translation are exact.
 * [gdp GameObject::fastRotateObject :170742-170750, calculateOrientedBox
 *  :170660-170664; processRotationActions :440005-440015, rotateObject
 *  :427428-427440; the swap, setRotation :164488-164489]
 */
export function applyGroupTransform(
  base: ObjectSet,
  live: ObjectSet,
  i: number,
  m: Float64Array,
  spin: number,
  sx: number,
  sy: number,
): void {
  const bx = base.cx[i];
  const by = base.cy[i];
  live.cx[i] = m[0] * bx + m[2] * by + m[4];
  live.cy[i] = m[1] * bx + m[3] * by + m[5];
  // The game adds each turn to the object's rotation and never wraps it.
  // [gdp GameObject::fastRotateObject :170742-170746]
  live.rawRot[i] = base.rawRot[i] + spin;
  const shape = base.shape[i];
  if (shape === S_CIRCLE) {
    const r = base.hw[i] * Math.max(Math.abs(sx), Math.abs(sy));
    live.hw[i] = r;
    live.hh[i] = r;
    live.x0[i] = live.cx[i] - r;
    live.x1[i] = live.cx[i] + r;
    live.y0[i] = live.cy[i] - r;
    live.y1[i] = live.cy[i] + r;
    // The circle stays the first test, and bounds the object; the box only
    // narrows it, so it needs no room of its own. [:465038-465052]
    const turned = spin !== 0;
    const rot = normDeg(base.rotDeg[i] + spin);
    live.turned[i] = turned ? 1 : 0;
    live.rotDeg[i] = rot;
    live.boxHw[i] = base.boxHw[i] * Math.abs(sx);
    live.boxHh[i] = base.boxHh[i] * Math.abs(sy);
    live.cosR[i] = turned ? Math.cos(rot * DEG) : 1;
    live.sinR[i] = turned ? Math.sin(rot * DEG) : 0;
    return;
  }
  // Without kA33 a scale trigger's negative scale turns an upright box inside
  // out as the object's own does (see the ObjectSet constructor). [the scale
  // trigger's updateCustomScaleX/Y :167444-167493 into +1000/+1004, read by
  // getObjectRect :170826-170830]
  const signed = !base.level.header.fixNegativeScale && shape === S_AABB;
  let hw = base.hw[i] * (signed ? sx : Math.abs(sx));
  let hh = base.hh[i] * (signed ? sy : Math.abs(sy));
  const rot = normDeg(base.rotDeg[i] + spin);
  live.rotDeg[i] = rot;
  const swapped = shape !== S_OBB && (base.rotDeg[i] === 90 || base.rotDeg[i] === 270);
  const kind = base.kind[i];
  const oriented = shape === S_OBB || (shape === S_AABB && spin !== 0 && kind !== K_SOLID && kind !== K_SPECIAL);
  live.shape[i] = oriented ? S_OBB : shape;
  let angle = spin;
  if (oriented) {
    // An oriented box keeps its own extents at the object's angle, the same
    // box whichever way round they are.
    hw = Math.abs(hw);
    hh = Math.abs(hh);
    if (swapped) {
      const t = hw;
      hw = hh;
      hh = t;
    }
    angle = rot;
    live.cosR[i] = Math.cos(rot * DEG);
    live.sinR[i] = Math.sin(rot * DEG);
  } else {
    live.cosR[i] = base.cosR[i];
    live.sinR[i] = base.sinR[i];
  }
  live.hw[i] = hw;
  live.hh[i] = hh;
  if (signed && !oriented && angle === 0) {
    // Its ends the way its sizes run, inside out when they are negative.
    live.x0[i] = live.cx[i] - hw;
    live.x1[i] = live.cx[i] + hw;
    live.y0[i] = live.cy[i] - hh;
    live.y1[i] = live.cy[i] + hh;
    return;
  }
  const cos = Math.cos(angle * DEG);
  const sin = Math.sin(angle * DEG);
  const ex = Math.abs(hw * cos) + Math.abs(hh * sin);
  const ey = Math.abs(hw * sin) + Math.abs(hh * cos);
  live.x0[i] = live.cx[i] - ex;
  live.x1[i] = live.cx[i] + ex;
  live.y0[i] = live.cy[i] - ey;
  live.y1[i] = live.cy[i] + ey;
}
