// What a trigger object is, read once when the level loads.
//
// Every trigger shares a handful of fields — when it may fire, what group it
// points at, how long it takes — and then has its own keys on top. Rather than
// write a parser per id, this parses the shared part into a `TriggerSpec` and
// leaves the rest in `props` for the runtime to read with the helpers below.
// Firing is rare (10,426 placements across all 27 official levels, against
// millions of physics ticks), so reading a key at fire time costs nothing and
// saves a hundred little parsers that could drift from the level format.
//
// The index this builds is immutable and shared between sims, like ObjectSet:
// a trigger's activation position is frozen here, which is also what the game
// does — moving a trigger at runtime never changes where it goes off.
// [gdp GJBaseGameLayer::orderSpawnObjects :432836-432871]

import type { Level, LevelObject } from "../level/types";
import { GAME_GROUND_Y } from "../physics/constants";
import { KEYFRAME_OBJECT_ID, KEYFRAME_TRIGGER_ID, keyframeAnimId, keyframeOrder } from "./keyframes";

// --- shared keys -------------------------------------------------------------

/** Fires when the player touches it rather than when the player passes it. */
const K_TOUCH = 11;
/** Fires only when another trigger spawns it. */
const K_SPAWN = 62;
/** May fire more than once. */
const K_MULTI = 87;
/** Both players share one activation record. */
const K_SHARED_PLAYER = 284;
/** Tie-break ahead of position in the activation queue. Official levels set it once. */
const K_ORDERING = 115;
/** Gameplay channel; only the active one fires. */
const K_CHANNEL = 170;
/** Rotate Gameplay: switch the active channel to key 173's. */
const K_CHANGE_CHANNEL = 171;
const K_TARGET_CHANNEL = 173;
const ROTATE_GAMEPLAY_ID = 2900;
/** The checkpoint object, which a spawn can fire as well as a touch. */
const CHECKPOINT_OBJECT_ID = 2063;
/** Control id, so a Stop trigger can name a group of triggers rather than a group. */
const K_CONTROL = 534;
/** The groups this object is the parent of, as a dotted list. */
const K_PARENT_GROUPS = 274;
const K_TARGET = 51;
const K_TARGET_2 = 71;
const K_ACTIVATE_GROUP = 56;
const K_DURATION = 10;
const K_EASING = 30;
const K_EASING_RATE = 85;

export interface TriggerSpec {
  /** Index into level.objects, which is also the unique id the game sorts by. */
  index: number;
  id: number;
  /** Activation position, frozen at load. */
  x: number;
  y: number;
  touch: boolean;
  spawnTriggered: boolean;
  multi: boolean;
  sharedPlayer: boolean;
  ordering: number;
  channel: number;
  controlId: number;
  target: number;
  target2: number;
  activateGroup: boolean;
  duration: number;
  easing: number;
  easingRate: number;
  groups: readonly number[];
  props: Record<number, string>;
}

// --- reading keys ------------------------------------------------------------

export function num(spec: TriggerSpec, key: number, fallback = 0): number {
  const raw = spec.props[key];
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

export function flag(spec: TriggerSpec, key: number): boolean {
  return spec.props[key] === "1";
}

export function int(spec: TriggerSpec, key: number, fallback = 0): number {
  return Math.trunc(num(spec, key, fallback));
}

/** "0a1a1a0a0" — hue, saturation, value, then the two checkboxes. */
export function hsvOf(spec: TriggerSpec, key: number): {
  h: number;
  s: number;
  v: number;
  sChecked: boolean;
  vChecked: boolean;
} | null {
  const raw = spec.props[key];
  if (!raw) return null;
  const p = raw.split("a");
  if (p.length < 5) return null;
  return {
    h: Number(p[0]) || 0,
    s: Number(p[1]) || 0,
    v: Number(p[2]) || 0,
    sChecked: p[3] === "1",
    vChecked: p[4] === "1",
  };
}

/** A dotted list of ids, as the group and remap keys store them. */
export function idList(spec: TriggerSpec, key: number): number[] {
  const raw = spec.props[key];
  if (!raw) return [];
  const out: number[] = [];
  for (const part of raw.split(".")) {
    const v = Number(part);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

// --- the index ---------------------------------------------------------------

/**
 * Every trigger id the runtime moves, rotates, scales or follows something
 * with. An object in one of these groups may need its geometry recomputed as
 * the level plays; everything else is baked once and never touched, which is
 * what keeps the common case on the path it is on today.
 */
const MOVEMENT_TRIGGERS = new Set([901, 1346, 1347, 1814, 2067, 3006, 3007, 3008, 3016, 3017, 3018, 3019, 3033, 3022]);

/** Which key on a movement trigger names the group whose objects move. */
function movedGroups(spec: TriggerSpec, into: Set<number>): void {
  if (spec.target > 0) into.add(spec.target);
  // Teleport moves the player, not a group; the area triggers move whatever is
  // inside them, which is decided at fire time, so their target is the group.
  if (spec.id === 3016 || spec.id === 3661) {
    const follow = int(spec, 71);
    if (follow > 0) into.add(follow);
  }
  if (spec.id >= 3006 && spec.id <= 3008) {
    const alias = int(spec, 226);
    if (alias > 0) into.add(alias);
  }
}

/**
 * One gameplay channel's pass-by triggers, in the order the game pops them.
 * `direction` is the way the channel is travelled — 4 right, 3 left, 1 up,
 * 2 down — which picks what the queue is sorted by: key 115 first, then the
 * activation point's x (or y, for up and down, with the level's ground at
 * 90), negated for left and down, added to key 115 as floats and cut to an
 * integer, then the object's own index. A channel takes its direction from
 * the first pass-by Rotate Gameplay in the level that switches to it (key
 * 171, key 173 naming the channel), and is travelled right when none does.
 * [gdp GJBaseGameLayer::orderSpawnObjects :432836-432871 →
 *  LevelTools::sortChannelOrderObjects :122777-122920 (the directions
 *  :122830-122844, the comparator pick :122893-122908); compOrder,
 *  compOrderXInv, compOrderY, compOrderYInv :120294-120452]
 */
export interface ChannelQueue {
  /** Key 170. */
  readonly channel: number;
  readonly direction: number;
  readonly specs: readonly TriggerSpec[];
  /** Each spec's activation point as the floats the game compares: x, and y with the ground at 90. */
  readonly x: Float32Array;
  readonly y: Float32Array;
}

export interface TriggerIndex {
  /** Every trigger in the level, by object index. */
  readonly byObject: ReadonlyMap<number, TriggerSpec>;
  /**
   * Triggers that fire by being passed, one queue per gameplay channel
   * (key 170); only the active channel's queue is popped.
   */
  readonly channels: readonly ChannelQueue[];
  /** Where each channel that has a queue sits in `channels`. */
  readonly channelSlot: ReadonlyMap<number, number>;
  /** Triggers that fire on touch, sorted by x so the sim can scan forward. */
  readonly touch: readonly TriggerSpec[];
  /**
   * Object indices per group, including objects with no hitbox. File order,
   * except that a group a Spawn trigger fires — every group, with kA38 — is
   * sorted by x (see sortSpawnGroups).
   */
  readonly groups: ReadonlyMap<number, readonly number[]>;
  /**
   * A group's parent object, where some object names the group in its key 274:
   * the object that stands for the group wherever the game wants one object
   * rather than all of them. [gdp GameObject::objectFromVector reads 274
   *  :184060-184071 → GJBaseGameLayer::loadGroupParentsFromString
   *  :425442-425468 → setGroupParent :425262-425305; outside the editor the
   *  last object to name a group wins]
   */
  readonly parents: ReadonlyMap<number, number>;
  /**
   * Whether any Follow Player Y trigger (1814) with a delay (key 91) is placed,
   * so the player's y history is worth keeping: without a delay the game reads
   * the y as it is now. [gdp PlayerObject::getOldPosition :142151-142156]
   */
  readonly hasPlayerFollow: boolean;
  /** Groups a movement trigger can target, so the rest of the level stays static. */
  readonly movingGroups: ReadonlySet<number>;
  /** Object indices in a moving group — the dynamic half of the level. */
  readonly movingObjects: Int32Array;
  /** The highest group id the level mentions, for sizing the state arrays. */
  readonly groupCount: number;
  readonly count: number;
  /**
   * Each keyframe animation's Keyframe objects (3032), by animation id (key
   * 373), in order (key 374, then file order). [gdp GJBaseGameLayer::
   *  addKeyframe :428896-428916, updateKeyframeOrder :428839-428879]
   */
  readonly keyframeAnims: ReadonlyMap<number, readonly number[]>;
}

/**
 * Puts the groups a Spawn trigger fires in x order, once, as the level loads:
 * every group some 1268's key 51 names, or every group at all when the level
 * sets kA38. The order is what a spawn fires the members in, and an ordered
 * spawn times its members from the first of them. The game compares the x's
 * truncated to integers and its qsort leaves ties in no particular order;
 * file order is kept for them here.
 * [gdp GJBaseGameLayer::sortGroups :453213-453279, from updateSpecialGroupData
 *  :467051-467064 in PlayLayer::setupHasCompleted :106195; sortAllGroupsX
 *  :423269-423279; xCompPosition :415180-415187; kA38 is LevelHeader.sortAllGroupsX]
 */
function sortSpawnGroups(level: Level, groups: Map<number, number[]>): void {
  const objects = level.objects;
  const byX = (a: number, b: number): number => Math.trunc(objects[a].x) - Math.trunc(objects[b].x);
  if (level.header.sortAllGroupsX) {
    for (const list of groups.values()) if (list.length > 1) list.sort(byX);
    return;
  }
  const targets = new Set<number>();
  for (const o of objects) {
    if (o.id !== 1268) continue;
    const g = Math.trunc(Number(o.props[K_TARGET] ?? 0));
    if (g > 0) targets.add(g);
  }
  for (const g of targets) {
    const list = groups.get(g);
    if (list && list.length > 1) list.sort(byX);
  }
}

/**
 * Whether the game will spawn an object of this id at all, which is also what
 * picks the member an ordered spawn times the rest from. An id test only:
 * whether the object opted in to being spawned is checked later, so a member
 * that did not can still set the base. The 1.x colour triggers count as what
 * they are made into, 915 and 899. [gdp GameObject::isSpawnableTrigger
 *  :173769-173930, read by spawnObjectsInOrder :421726-421805 and spawnObject
 *  :456038-456089; objectFromVector :183928-183945 for the 1.x ids]
 */
export function isSpawnableTrigger(id: number): boolean {
  return SPAWNABLE_IDS.has(id) || SPAWNABLE_RANGES.some(([a, b]) => id >= a && id <= b);
}

const SPAWNABLE_IDS = new Set([
  29, 30, 32, 33, 104, 105, 221, 717, 718, 743, 744, 915, 1049, 1268, 1520, 1585, 1595, 1616, 2015, 2907, 2999, 3033,
  3600, 3655,
]);
const SPAWNABLE_RANGES: readonly (readonly [number, number])[] = [
  [899, 901], [1006, 1007], [1346, 1347], [1611, 1613], [1811, 1812], [1814, 1815], [1817, 1819], [1912, 1914],
  [1916, 1917], [1931, 1932], [1934, 1935], [2062, 2063], [2066, 2068], [2899, 2901], [2903, 2905], [2909, 2917],
  [2919, 2925], [3006, 3024], [3029, 3031], [3602, 3609], [3612, 3615], [3617, 3620], [3640, 3641], [3660, 3662],
];

/**
 * Builds everything the runtime needs that cannot change while a level plays.
 * `isTrigger` comes from the object table so this file does not need one.
 */
export function buildTriggerIndex(level: Level, isTrigger: (id: number) => boolean): TriggerIndex {
  const byObject = new Map<number, TriggerSpec>();
  const queue: TriggerSpec[] = [];
  const directions = new Map<number, number>();
  const touch: TriggerSpec[] = [];
  const groups = new Map<number, number[]>();
  const parents = new Map<number, number>();
  const movingGroups = new Set<number>();
  let groupCount = 1;
  let hasPlayerFollow = false;

  for (const o of level.objects) {
    for (const g of o.groups) {
      let list = groups.get(g);
      if (!list) groups.set(g, (list = []));
      list.push(o.index);
      if (g >= groupCount) groupCount = g + 1;
    }
    const parentOf = o.props[K_PARENT_GROUPS];
    if (parentOf) {
      for (const part of parentOf.split(".")) {
        const g = Math.trunc(Number(part));
        if (g > 0) parents.set(g, o.index);
      }
    }
    // A checkpoint object is not a trigger to the table, but one that opts in
    // to being spawned is fired by a spawn like one; its touch stays with the
    // collision pass. [gdp CheckpointGameObject::triggerObject :297595-297599]
    const spawnedCheckpoint = o.id === CHECKPOINT_OBJECT_ID && o.props[K_SPAWN] === "1";
    if (!isTrigger(o.id) && !spawnedCheckpoint) continue;
    const spec = parseTrigger(o);
    byObject.set(o.index, spec);
    if (spec.target >= groupCount) groupCount = spec.target + 1;
    if (spec.target2 >= groupCount) groupCount = spec.target2 + 1;
    if (spawnedCheckpoint) continue;
    if (MOVEMENT_TRIGGERS.has(spec.id)) movedGroups(spec, movingGroups);
    // UI Trigger (3613): its target group is drawn every frame at a screen
    // position, so it joins the dynamic list like a moving group.
    if (spec.id === 3613) {
      const g = Math.trunc(Number(spec.props[51] ?? 0)) || 0;
      if (g > 0) movingGroups.add(g);
    }
    if (spec.id === 1814 && num(spec, 91) > 0) hasPlayerFollow = true;
    if (spec.touch) touch.push(spec);
    else if (!spec.spawnTriggered) {
      queue.push(spec);
      if (spec.id === ROTATE_GAMEPLAY_ID && int(spec, K_CHANGE_CHANNEL) !== 0) {
        const channel = int(spec, K_TARGET_CHANNEL);
        if (!directions.has(channel)) directions.set(channel, gameplayDirection(o.rotation, o.flipX, o.flipY));
      }
    }
  }

  const byChannel = new Map<number, TriggerSpec[]>();
  for (const spec of queue) {
    let list = byChannel.get(spec.channel);
    if (!list) byChannel.set(spec.channel, (list = []));
    list.push(spec);
  }
  const channels: ChannelQueue[] = [];
  const channelSlot = new Map<number, number>();
  for (const channel of [...byChannel.keys()].sort((a, b) => a - b)) {
    const direction = directions.get(channel) ?? 4;
    const specs = byChannel.get(channel)!;
    const key = (s: TriggerSpec): number => orderKey(s, direction);
    specs.sort((a, b) => a.ordering - b.ordering || key(a) - key(b) || a.index - b.index);
    channelSlot.set(channel, channels.length);
    channels.push({
      channel,
      direction,
      specs,
      x: Float32Array.from(specs, (s) => s.x),
      y: Float32Array.from(specs, (s) => s.y + GAME_GROUND_Y),
    });
  }
  touch.sort((a, b) => a.x - b.x || a.index - b.index);
  sortSpawnGroups(level, groups);

  // A Keyframe Animation trigger moves its own key 51 or, without one, the
  // key 51 of the keyframes it plays.
  const keyframeAnims = new Map<number, number[]>();
  for (const o of level.objects) {
    if (o.id !== KEYFRAME_OBJECT_ID) continue;
    const anim = keyframeAnimId(o);
    let list = keyframeAnims.get(anim);
    if (!list) keyframeAnims.set(anim, (list = []));
    list.push(o.index);
  }
  for (const list of keyframeAnims.values()) {
    list.sort((a, b) => keyframeOrder(level.objects[a]) - keyframeOrder(level.objects[b]) || a - b);
  }
  for (const spec of byObject.values()) {
    if (spec.id !== KEYFRAME_TRIGGER_ID || spec.target > 0) continue;
    for (const i of groups.get(int(spec, 76)) ?? []) {
      const o = level.objects[i];
      if (o.id !== KEYFRAME_OBJECT_ID) continue;
      const g = Math.trunc(Number(o.props[K_TARGET] ?? 0));
      if (g > 0) movingGroups.add(g);
    }
  }

  // A spawn with remaps (key 442, pairs "from.to") sends a Move aimed at
  // `from` to `to` instead, so `to` moves too; chains are followed.
  const remaps: [number, number][] = [];
  for (const spec of byObject.values()) {
    const list = level.objects[spec.index].props[442];
    if (!list) continue;
    const parts = list.split(".").map((v) => Math.trunc(Number(v)));
    for (let k = 0; k + 1 < parts.length; k += 2) if (parts[k] > 0 && parts[k + 1] > 0) remaps.push([parts[k], parts[k + 1]]);
  }
  for (let grew = remaps.length > 0; grew; ) {
    grew = false;
    for (const [from, to] of remaps) {
      if (movingGroups.has(from) && !movingGroups.has(to)) {
        movingGroups.add(to);
        grew = true;
      }
    }
  }

  // A group that is only ever spawned still has to be reachable from a moving
  // one: a Spawn trigger can fire a Move trigger, and that Move trigger's own
  // target was already collected above, so nothing extra is needed here. What
  // is needed is the objects themselves.
  const moving: number[] = [];
  const seen = new Set<number>();
  for (const g of movingGroups) {
    for (const index of groups.get(g) ?? []) {
      if (seen.has(index)) continue;
      seen.add(index);
      moving.push(index);
    }
  }
  moving.sort((a, b) => a - b);

  return {
    byObject,
    channels,
    channelSlot,
    touch,
    groups,
    parents,
    hasPlayerFollow,
    movingGroups,
    movingObjects: Int32Array.from(moving),
    groupCount,
    count: byObject.size,
    keyframeAnims,
  };
}

/**
 * The integer a channel queue sorts a trigger by after key 115: key 115 plus
 * the activation point's coordinate along the channel's way, as floats, cut
 * towards zero. [gdp compOrder :120294-120318, compOrderXInv :120337-120361,
 *  compOrderY :120380-120405, compOrderYInv :120424-120449]
 */
function orderKey(spec: TriggerSpec, direction: number): number {
  const ordering = Math.fround(spec.ordering);
  const x = Math.fround(spec.x);
  const y = Math.fround(spec.y + GAME_GROUND_Y);
  switch (direction) {
    case 3:
      return Math.trunc(Math.fround(ordering - x));
    case 1:
      return Math.trunc(Math.fround(ordering + y));
    case 2:
      return Math.trunc(Math.fround(ordering - y));
    default:
      return Math.trunc(Math.fround(ordering + x));
  }
}

/**
 * The way a Rotate Gameplay trigger sends the player, from how it is turned
 * and flipped: 4 right, 3 left, 1 up, 2 down. Only whole quarter turns count;
 * any other angle keeps the object's default, right. It is also what the
 * editor stores as the trigger's key 167.
 * [gdp GameObject::getObjectDirection :168867-168889 over
 *  determineSlopeDirection :168708-168795; RotateGameplayGameObject::
 *  updateGameplayRotation :313495-313546 derives key 167 the same way]
 */
export function gameplayDirection(rotation: number, flipX: boolean, flipY: boolean): number {
  const r = Math.trunc(rotation) % 360;
  const zero = r === 0;
  const half = Math.abs(r) === 180;
  const quarter = r === 90 || r === -270;
  const threeQuarters = r === 270 || r === -90;
  let slope = 0;
  if (flipX && flipY) slope = half ? 0 : zero ? 3 : threeQuarters ? 4 : quarter ? 5 : 0;
  else if (flipX) slope = half ? 1 : zero ? 2 : quarter ? 6 : threeQuarters ? 7 : 0;
  else if (!flipY) slope = zero ? 0 : half ? 3 : quarter ? 4 : threeQuarters ? 5 : 0;
  else slope = zero ? 1 : half ? 2 : threeQuarters ? 6 : quarter ? 7 : 0;
  if (slope === 4 || slope === 7) return 2;
  if (slope === 5 || slope === 6) return 1;
  if (slope === 2 || slope === 3) return 3;
  return 4;
}

export function parseTrigger(o: LevelObject): TriggerSpec {
  const n = (key: number, fallback = 0): number => {
    const raw = o.props[key];
    if (raw === undefined) return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    index: o.index,
    id: o.id,
    x: o.x,
    y: o.y,
    touch: o.props[K_TOUCH] === "1",
    spawnTriggered: o.props[K_SPAWN] === "1",
    multi: o.props[K_MULTI] === "1",
    sharedPlayer: o.props[K_SHARED_PLAYER] === "1",
    // Keys 115 and 170 are integers to the game. [gdp
    // EffectGameObject::customObjectSetup :298697-298704, atoi]
    ordering: Math.trunc(n(K_ORDERING)),
    channel: Math.trunc(n(K_CHANNEL)),
    controlId: n(K_CONTROL),
    target: Math.trunc(n(K_TARGET)),
    target2: Math.trunc(n(K_TARGET_2)),
    activateGroup: o.props[K_ACTIVATE_GROUP] === "1",
    duration: n(K_DURATION),
    easing: Math.trunc(n(K_EASING)),
    easingRate: n(K_EASING_RATE, 2),
    groups: o.groups,
    props: o.props,
  };
}
