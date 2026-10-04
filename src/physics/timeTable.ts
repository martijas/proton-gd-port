// The level's clock without a player: how long the run from the level start
// takes to reach a point, and where it is t seconds in.
//
// The game keeps one list for this: every speed portal, Reverse, Song and
// Time Warp trigger, Rotate Gameplay trigger and teleport that has key 13 set,
// plus any pad or orb that reverses the player (key 117) and has it too. Every
// speed portal in the official levels has it. Walking the list is how the
// game warms a level up to a start position before the run begins
// (GJBaseGameLayer::loadUpToPosition), so the warm-up lasts exactly as long as
// the run would have taken, turns included, and ends on the channel the run
// would be on.
//
// Positions are the game's: y is the port's + 90, as everywhere the game
// compares a trigger's point with the player's.
// [PlayLayer::addObject, gd-ida-decomp.cpp:90352-90360 (who joins the list);
//  LevelTools::sortSpeedObjects :122945-123144, timeForPos :123161-123449,
//  posForTimeInternal :122123-122345]

import type { Level, LevelObject, Speed } from "../level/types";
import { K_NONE, K_ORB, K_PAD, type ObjectSet } from "./collision";
import { GAME_GROUND_Y } from "./constants";
import { gameplayDirection } from "../triggers/spec";

/**
 * What an entry does besides being somewhere: a speed-mod index for a speed
 * portal (0 1x, 1 0.5x, 2 2x, 3 3x, 4 4x), or one of these. Anything carrying
 * key 117 counts as a reverse, whatever else it is.
 * [EffectGameObject::updateSpeedModType, gd-ida-decomp.cpp:310236-310309]
 */
const REVERSE = -1;
const TIME_WARP = -2;
const SONG = -3;
const TURN = -4;
const TELEPORT = -5;

/** GameObject::isSpeedObject, with each id's type. [gd-ida-decomp.cpp:174136-174166] */
const TYPE_BY_ID: ReadonlyMap<number, number> = new Map([
  [200, 1],
  [201, 0],
  [202, 2],
  [203, 3],
  [1334, 4],
  [1917, REVERSE],
  [1934, SONG],
  [1935, TIME_WARP],
  [2900, TURN],
  [2902, TELEPORT],
  [3022, TELEPORT],
  [3027, TELEPORT],
]);

/**
 * Units a second for each speed-mod index; anything but 1-4 is 1x. The floats
 * are the player's speed times its multiplier times 60, as the game's table
 * holds them. [LevelTools::valueForSpeedMod :122098-122107 (the table at
 *  byte_981284 + 76 and 1x inline, 0x439bca41); GeometryDash.exe holds the
 *  five at 0x2e7f9d-0x2e7fc5, 0.5x first]
 */
const UNITS_PER_SECOND = [311.580109, 251.16008, 387.420136, 468.000153, 576.000183].map(Math.fround);

/** The speed-mod index for the port's speed (0 = 0.5x … 4 = 4x). */
const MOD_BY_SPEED: Record<Speed, number> = { 0: 1, 1: 0, 2: 2, 3: 3, 4: 4 };

function unitsPerSecond(mod: number): number {
  return mod >= 1 && mod <= 4 ? UNITS_PER_SECOND[mod] : UNITS_PER_SECOND[0];
}

/**
 * Objects the list meets at their own point: the orbs, which are taken by a
 * click. Speed portals and the teleport portal always meet the player at
 * their leading edge; anything else only when it is touch-activated.
 * [sortSpeedObjects :123046-123113]
 */
const AT_OWN_POINT: ReadonlySet<number> = new Set([36, 84, 141, 1022, 1330, 1333, 1594, 1704, 1751, 3027]);
const AT_EDGE: ReadonlySet<number> = new Set([200, 201, 202, 203, 1334, 2902]);
/** Touch-activated without key 11: a ring's init sets it. The spider orb is the one ring not met at its own point. [RingObject::init :308156-308167] */
const TOUCH_BY_DEFAULT: ReadonlySet<number> = new Set([3004]);
/** The half-size of a trigger's box, which has no art of its own: one grid square, as the touch check has it. */
const TRIGGER_HALF = 15;
/** How far short of the box the player's centre is when its own box first touches it. */
const EDGE_REACH = 15;

interface Entry {
  readonly index: number;
  readonly id: number;
  readonly type: number;
  /** The point the list measures to (+1592), game space. */
  x: number;
  y: number;
  /** Key 115 and key 170. [EffectGameObject::customObjectSetup :298696-298704] */
  readonly order: number;
  readonly channel: number;
  /** Met at the leading edge of its box rather than at its point, and that box. */
  readonly atEdge: boolean;
  readonly boxX: number;
  readonly boxY: number;
  readonly halfW: number;
  readonly halfH: number;
  /** A turn: keys 166/167 as the rotated and reversed state, 172 channel only, 171 and 173 the channel switch. [RotateGameplayGameObject::customObjectSetup :301401-301460] */
  readonly rotated: boolean;
  readonly reversed: boolean;
  readonly channelOnly: boolean;
  readonly changeChannel: boolean;
  readonly targetChannel: number;
  /** The way a channel switched to by this turn is sorted along (see gameplayDirection). */
  readonly direction: number;
  /** A teleport: where it sends the player, game space, and keys 352/353, which keep the player's x or y. [TeleportPortalObject::customObjectSetup :303158-303165] */
  readonly toX: number;
  readonly toY: number;
  readonly keepX: boolean;
  readonly keepY: boolean;
  /**
   * A Time Warp's key 120 as a float, unclamped, and 0 when the key is missing.
   * [EffectGameObject::customObjectSetup :298914-298924]
   */
  readonly warp: number;
}

/** Where the run is and which channel its pass-by check reads. */
export interface TimePoint {
  x: number;
  y: number;
  channel: number;
}

const atoi = (v: string | undefined): number => (v === undefined ? 0 : parseInt(v, 10) || 0);
const flag = (o: LevelObject, key: number): boolean => atoi(o.props[key]) !== 0;

export class TimeTable {
  private readonly entries: Entry[];
  private readonly startSpeed: number;

  /**
   * `firstMember` answers a teleport's target group with one object, the way
   * the sim picks a teleport target, or -1.
   */
  constructor(
    level: Level,
    objs: ObjectSet,
    private readonly platformer: boolean,
    firstMember: (group: number) => number,
  ) {
    // The level's own kA4, whatever a start position says.
    // [PlayLayer::timeForPos :87505-87522, posForTime :87537-87547: settings +272]
    this.startSpeed = unitsPerSecond(MOD_BY_SPEED[level.header.startSpeed]);
    const entries: Entry[] = [];
    for (const o of level.objects) {
      if (!flag(o, 13)) continue;
      const reverse = flag(o, 117);
      const listed = TYPE_BY_ID.get(o.id);
      // Anything else joins only as an effect object that reverses: in the
      // port, a pad or an orb, the objects key 117 does anything on.
      if (listed === undefined && !(reverse && (objs.kind[o.index] === K_PAD || objs.kind[o.index] === K_ORB))) continue;
      entries.push(makeEntry(o, reverse ? REVERSE : (listed ?? 0), level, objs, firstMember));
    }
    this.entries = placeEdges(sortByChannel(entries));
  }

  /** How many objects the list holds. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * How long the run takes to reach (x, y): along the list, each stretch at
   * the speed and warp in force, until the stretch that holds the point on
   * the target channel (and past the target order, when one is given; -1 for
   * any channel); then the rest of the way at the speed in force. Song
   * triggers are skipped. Nothing at or left of x 0 takes time, and a
   * platformer runs at 1x in a straight line.
   * [LevelTools::timeForPos, gd-ida-decomp.cpp:123161-123449, called by
   *  loadUpToPosition :469458 as PlayLayer::timeForPos(point, kA19, kA26, false)]
   */
  timeForPos(tx: number, ty: number, order: number, channel: number): number {
    if (!(tx > 0)) return 0;
    let speed = this.platformer ? UNITS_PER_SECOND[0] : this.startSpeed;
    if (this.platformer || this.entries.length === 0) return Math.fround(tx / speed);
    let warp = 1;
    let rotated = false;
    let reversed = false;
    let px = 0;
    let py = 0;
    let current = 0;
    let elapsed = 0;
    const maxOrder = new Map<number, number>();
    for (const e of this.entries) {
      if (e.type === SONG) continue;
      const before = maxOrder.get(current) ?? 0;
      if (e.order > before) maxOrder.set(current, e.order);
      const ex = e.x > 0 ? e.x : 0;
      const ey = e.y > 0 ? e.y : 0;
      let dx = Math.fround(ex - px);
      let dy = Math.fround(ey - py);
      const wasRotated = rotated;
      let along: number;
      if (reversed) {
        if (rotated) {
          if (dy <= 0) dy = 0;
          along = dy;
        } else {
          if (dx >= 0) dx = 0;
          along = dx;
        }
      } else if (rotated) {
        if (dy >= 0) dy = 0;
        along = dy;
      } else {
        if (dx <= 0) dx = 0;
        along = dx;
      }
      const stretch = Math.fround(Math.abs(along) / Math.fround(speed * warp));
      const onTarget =
        (channel === current || channel === -1) && !(order > 0 && (maxOrder.get(current) ?? 0) < order && before !== order);
      if (onTarget) {
        const inside = rotated
          ? (py <= ty && e.y >= ty) || (py >= ty && e.y <= ty)
          : (px <= tx && e.x >= tx) || (px >= tx && e.x <= tx);
        if (inside) {
          const rest = rotated ? Math.abs(Math.fround(py - ty)) : Math.abs(Math.fround(px - tx));
          return Math.fround(elapsed + Math.fround(rest / Math.fround(speed * warp)));
        }
      }
      let offX = 0;
      let offY = 0;
      switch (e.type) {
        case TELEPORT:
          offX = e.keepX ? 0 : Math.fround(e.toX - e.x);
          offY = e.keepY ? 0 : Math.fround(e.toY - e.y);
          break;
        case TURN:
          if (!e.channelOnly) {
            rotated = e.rotated;
            reversed = e.reversed;
          }
          if (e.changeChannel) current = e.targetChannel;
          break;
        case SONG:
          break;
        case TIME_WARP:
          warp = e.warp;
          break;
        case REVERSE:
          reversed = !reversed;
          break;
        default:
          speed = unitsPerSecond(e.type);
      }
      elapsed = Math.fround(elapsed + stretch);
      if (wasRotated && rotated) py = Math.fround(py + dy);
      else {
        px = Math.fround(px + dx);
        if (wasRotated || rotated) py = Math.fround(py + dy);
      }
      px = Math.fround(px + offX);
      py = Math.fround(py + offY);
    }
    const rest = rotated ? Math.abs(Math.fround(py - ty)) : Math.abs(Math.fround(px - tx));
    return Math.fround(elapsed + Math.fround(rest / Math.fround(speed * warp)));
  }

  /**
   * Where the run is t seconds in, and on which channel: each stretch at the
   * speed and warp in force, forward along the way the last turn and reverse
   * set, jumping at each teleport. A stretch to an object on another channel
   * than the run's covers no ground, but the object still acts. A platformer
   * runs at 1x along x.
   * [LevelTools::posForTimeInternal, gd-ida-decomp.cpp:122123-122345, called
   *  by loadUpToPosition :469475 as PlayLayer::posForTime, whose channel goes
   *  to layer +732]
   */
  posForTime(t: number): TimePoint {
    let speed = this.platformer ? UNITS_PER_SECOND[0] : this.startSpeed;
    if (this.platformer || this.entries.length === 0) return { x: Math.fround(t * speed), y: 0, channel: 0 };
    let warp = 1;
    let rotated = false;
    let reversed = false;
    let px = 0;
    let py = 0;
    let channel = 0;
    let elapsed = 0;
    for (const e of this.entries) {
      const pace = Math.fround(speed * warp);
      const ex = e.x > 0 ? e.x : 0;
      const ey = e.y > 0 ? e.y : 0;
      const wasRotated = rotated;
      let dx = Math.fround(ex - px);
      let dy = Math.fround(ey - py);
      if (reversed) {
        if (rotated) {
          if (dy <= 0) dy = 0;
        } else if (dx >= 0) dx = 0;
      } else if (rotated) {
        if (dy >= 0) dy = 0;
      } else if (dx <= 0) dx = 0;
      if (e.channel !== channel) {
        dx = 0;
        dy = 0;
      }
      const next = Math.fround(elapsed + Math.fround(Math.abs(rotated ? dy : dx) / pace));
      if (next >= t) {
        let d = Math.fround(Math.fround(t - elapsed) * pace);
        if (rotated !== reversed) d = -d;
        if (rotated) py = Math.fround(py + d);
        else px = Math.fround(px + d);
        return { x: px, y: py, channel };
      }
      let offX = 0;
      let offY = 0;
      switch (e.type) {
        case TELEPORT:
          offX = e.keepX ? 0 : Math.fround(e.toX - e.x);
          offY = e.keepY ? 0 : Math.fround(e.toY - e.y);
          break;
        case TURN:
          if (!e.channelOnly) {
            rotated = e.rotated;
            reversed = e.reversed;
          }
          if (e.changeChannel) channel = e.targetChannel;
          break;
        case SONG:
          break;
        case TIME_WARP:
          warp = e.warp;
          break;
        case REVERSE:
          reversed = !reversed;
          break;
        default:
          speed = unitsPerSecond(e.type);
      }
      if (wasRotated && rotated) py = Math.fround(py + dy);
      else {
        px = Math.fround(px + dx);
        if (wasRotated || rotated) py = Math.fround(py + dy);
      }
      elapsed = next;
      px = Math.fround(px + offX);
      py = Math.fround(py + offY);
    }
    let d = Math.fround(Math.fround(Math.fround(t - elapsed) * speed) * warp);
    if (reversed !== rotated) d = -d;
    if (rotated) py = Math.fround(py + d);
    else px = Math.fround(px + d);
    return { x: px, y: py, channel };
  }
}

function makeEntry(o: LevelObject, type: number, level: Level, objs: ObjectSet, firstMember: (group: number) => number): Entry {
  const i = o.index;
  const hasBox = objs.kind[i] !== K_NONE;
  let toX = Math.fround(o.x);
  let toY = Math.fround(o.y + GAME_GROUND_Y);
  if (type === TELEPORT) {
    // The target group's object, else the teleport itself.
    // [sortSpeedObjects :122972-122980]
    const target = firstMember(atoi(o.props[51]));
    if (target >= 0) {
      toX = Math.fround(level.objects[target].x);
      toY = Math.fround(level.objects[target].y + GAME_GROUND_Y);
    }
  }
  const edgeCandidate = AT_EDGE.has(o.id) || (!AT_OWN_POINT.has(o.id) && (flag(o, 11) || TOUCH_BY_DEFAULT.has(o.id)));
  return {
    index: i,
    id: o.id,
    type,
    x: Math.fround(o.x),
    y: Math.fround(o.y + GAME_GROUND_Y),
    order: atoi(o.props[115]),
    channel: atoi(o.props[170]),
    atEdge: edgeCandidate && !flag(o, 369),
    boxX: hasBox ? objs.cx[i] : o.x,
    boxY: (hasBox ? objs.cy[i] : o.y) + GAME_GROUND_Y,
    halfW: hasBox ? objs.hw[i] : TRIGGER_HALF,
    halfH: hasBox ? objs.hh[i] : TRIGGER_HALF,
    rotated: atoi(o.props[166]) === 3 || atoi(o.props[166]) === 4,
    reversed: atoi(o.props[167]) === 1 || atoi(o.props[167]) === 3,
    channelOnly: flag(o, 172),
    changeChannel: flag(o, 171),
    targetChannel: atoi(o.props[173]),
    direction: gameplayDirection(o.rotation, o.flipX, o.flipY),
    toX,
    toY,
    keepX: flag(o, 352),
    keepY: flag(o, 353),
    warp: Math.fround(parseFloat(o.props[120] ?? "") || 0),
  };
}

/**
 * The list in the order it is walked: by channel, each channel sorted along
 * its own way by key 115, then the point, then level order — the same order a
 * channel's pass-by queue has. Channel 0 comes first and the walk follows each
 * channel switch as it meets it; whatever is left follows, channel by channel
 * in the order they first appear.
 * [LevelTools::sortChannelOrderObjects :122777-122920 (the ways :122826-122845,
 *  compOrder :120294-120318 and its three siblings :122889-122910),
 *  moveTriggerObjectsToArray :122724-122757]
 */
function sortByChannel(list: Entry[]): Entry[] {
  const ways = new Map<number, number>();
  for (const e of list) if (e.id === 2900 && e.changeChannel && !ways.has(e.targetChannel)) ways.set(e.targetChannel, e.direction);
  const byChannel = new Map<number, Entry[]>();
  for (const e of list) {
    let group = byChannel.get(e.channel);
    if (!group) byChannel.set(e.channel, (group = []));
    group.push(e);
  }
  for (const [channel, group] of byChannel) {
    const way = ways.get(channel) ?? 4;
    group.sort((a, b) => a.order - b.order || orderKey(a, way) - orderKey(b, way) || a.index - b.index);
  }
  const out: Entry[] = [];
  let channel = 0;
  for (;;) {
    const group = byChannel.get(channel);
    const e = group?.shift();
    if (!e) break;
    out.push(e);
    if (e.id === 2900 && e.changeChannel) channel = e.targetChannel;
  }
  for (const group of byChannel.values()) out.push(...group);
  return out;
}

/** compOrder's second key: key 115 plus the point along the way, as floats, cut towards zero. */
function orderKey(e: Entry, way: number): number {
  const order = Math.fround(e.order);
  switch (way) {
    case 3:
      return Math.trunc(Math.fround(order - Math.fround(e.x)));
    case 1:
      return Math.trunc(Math.fround(order + Math.fround(e.y)));
    case 2:
      return Math.trunc(Math.fround(order - Math.fround(e.y)));
    default:
      return Math.trunc(Math.fround(order + Math.fround(e.x)));
  }
}

/**
 * Moves each entry that meets the player at its box to where the player's
 * centre is when its own box first touches it: 15 short of the leading edge
 * along the way the run is going there, and the box's centre across it. The
 * way is tracked through the sorted list's turns and reverses. Key 369 keeps
 * an entry at its point. The list is sorted again afterwards.
 * [sortSpeedObjects :123023-123144]
 */
function placeEdges(list: Entry[]): Entry[] {
  let rotated = false;
  let reversed = false;
  for (const e of list) {
    if (e.atEdge) {
      // Float steps, as the game's: the box's centre, then half its size, then 15.
      e.x = Math.fround(e.boxX);
      e.y = Math.fround(e.boxY);
      const hw = Math.fround(e.halfW);
      const hh = Math.fround(e.halfH);
      if (rotated) e.y = reversed ? Math.fround(Math.fround(e.y - hh) - EDGE_REACH) : Math.fround(Math.fround(e.y + hh) + EDGE_REACH);
      else e.x = reversed ? Math.fround(Math.fround(e.x + hw) + EDGE_REACH) : Math.fround(Math.fround(e.x - hw) - EDGE_REACH);
    }
    if (e.type === TURN) {
      if (!e.channelOnly) {
        rotated = e.rotated;
        reversed = e.reversed;
      }
    } else if (e.type === REVERSE) reversed = !reversed;
  }
  return sortByChannel(list);
}
