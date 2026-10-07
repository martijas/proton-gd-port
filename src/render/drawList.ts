// Every sprite in a level, baked once into the exact bytes the batcher uploads,
// in the order the game draws them.
//
// Most of a level never changes: it is expanded, sorted and packed at load, and
// a frame costs a merge of the few column buckets the camera overlaps and a
// copy of their instances. Triggers add a second, narrow path on top of that.
// Rather than write back into the baked buffer when something moves or changes
// colour, the per-frame gather recomputes those fields for the sprites it is
// already copying — a few thousand, never the whole level — so the static bake
// stays the single source of truth.
//
// What the game decides per object rather than per sprite — whether it shows
// at all, which frame it is on, how far into its enter effect it is, how far
// it has turned — is settled once per object in a gather and shared by all of
// its sprites, as the game sets it on the object and its children follow. An
// object off screen is not settled at all. Its frame and its turn are
// functions of the clocks; the enter effect it latched, and its memo of where
// its loop walk got to, are the only things a gather carries to the next, and
// a restart or respawn clears them (reset).
//
// The order is the game's batch nodes' (batchNodes.ts). Every z layer has a
// batch per sheet and per blend mode, and a glow batch, at fixed z values in
// the object layer; a sprite goes in the node its object's layer, blending
// and sheet pick, and key 25 orders it only among that node's sprites. So the
// sort key is (node z, z order, arrival, place in the object's own tree). A
// glow goes in its layer's glow batch at z order −1000, under everything else
// in the layer. Inside one object the sprites keep cocos's tree order: a
// child with a negative z before its parent, the rest after, ties in the
// order they were added. [gdp GJBaseGameLayer::setupLayers :434370-435747,
// parentForZLayer :435748-436250; GameObject::addMainSpriteToParent
// :169272-169338, activateObject :169451-169475; cocos2d CCSpriteBatchNode::
// updateAtlasIndex; the comparator qsortAllChildrenWithIndex sorts by,
// sub_599E54 :787378-787388: z order, then order of arrival]
//
// Arrival is taken as the order of the level string. In the game it is the
// order objects were last added to their batch, which is when they come on
// screen: a static order can only stand in for that. [guess]
//
// Where a sprite goes can change in play. A colour trigger that turns a
// channel's blending on or off moves its objects to the other node, and the
// game moves them as it happens (updateVisibility :95946-95958). The bake
// holds a slot for each place such a sprite can be, and a gather draws the
// one its object's halves blend for now, so nothing is sorted again.

import { affine, affineXY, apply, compose, IDENTITY, type Affine } from "../engine/math";
import { BLEND, INSTANCE_BYTES, INSTANCE_FLOATS, SHAPE } from "../engine/gl/spriteBatch";
import type { AtlasSet } from "../assets/atlas";
import { frameSourceSize } from "../assets/atlasTypes";
import type { ChildRecord, Cut, ObjectRecord } from "../assets/objectTypes";
import type { HsvShift, Level, LevelObject } from "../level/types";
import { OBJECT_KEY, objectFlag, objectInt } from "../level/decode";
import type { TriggerRuntime } from "../triggers/runtime";
import { loadAngles, loadRotation } from "../physics/objects";
import {
  CHANNEL,
  applyHsv,
  channelOpacityMod,
  colorForPulse,
  lighterColor,
  multipliedColorValue,
  multipliedHsv,
  pulseAppliesTo,
  type ColorSource,
  type ColorTable,
  type Rgb,
} from "./colors";
import { frameQuad } from "./frameQuad";
import { pulseScale } from "../audio/pulse";
import {
  animMemo,
  animTimingFor,
  animationForID,
  entityColours,
  flashHalves,
  hash01,
  isRingAnimation,
  isSpin16Animation,
  objectAnimationFor,
  randomFrameFor,
  ringChildFrames,
  skeletonFor,
  skeletonFrame,
  startSkeleton,
  switchSkeleton,
  syncedFrame,
  type AnimFrame,
  type AnimTiming,
  type SkeletonClock,
  type SkeletonPlan,
  type SkeletonSlot,
} from "./anim";
import {
  ENTER,
  ENTER_GROW_FROM,
  ENTER_SLIDE,
  customEnterProgress,
  enterFades,
  enterPose,
  enterProgress,
} from "./enterEffects";
import type { AnimEntity } from "../assets/anims";
import { textOf, textSprites, type LevelFont } from "./text";
import { effectiveZLayer, effectiveZOrder, LAYER_Z } from "../triggers/shaderState";
import { areaEase } from "../triggers/area";
import { colorTriggerBlends, colorTriggerChannel, isColorTrigger, type AreaTint } from "../triggers/runtime";
import {
  batchZ,
  colourSpriteInFront,
  colourSpriteStays,
  GLOW_Z_ORDER,
  legacyLayers,
  NO_NODE,
  PARENT_MODE,
  parentMode,
  PORTAL_BACK_MODE,
  slotOfZ,
} from "./batchNodes";

/** Width of one culling column, in GD units. A screen is about 569 across. */
const COLUMN = 120;
/** A sprite spanning more than this many columns is checked every frame instead. */
const WIDE_COLUMNS = 6;

/** `SpriteMeta.blendChannel` for a sprite that is additive whatever its channel says. */
export const BLEND_ALWAYS = -1;
/** And for one whose channel never makes it additive. */
export const BLEND_NEVER = -2;

/**
 * Objects that never blend by colour: the three rods and one 1.9 block piece.
 * [GameObject::customSetup :180166-180170 (15-17); setupCustomSprites
 *  :612179-612190 (650); +727, read first by shouldBlendColor :166462-166477]
 */
const NO_BLEND_IDS: ReadonlySet<number> = new Set([15, 16, 17, 650]);

/** The rods, each of which PlayLayer::addObject gives a ball (id 37). [:90318] */
const ROD_IDS: ReadonlySet<number> = new Set([15, 16, 17]);
/** The ball's layer and z order. [customSetup 37 :180263-180270] */
const ROD_BALL_LAYER = 3;
const ROD_BALL_ORDER = 10;
/** Where the ball sits above the rod's top. [:90335] */
const ROD_BALL_RISE = 10;

/**
 * The invisible blocks, spikes and slopes, and the three invisible blades:
 * faded by how far they are from the middle of the screen rather than by the
 * enter fade (+928). [GameObject::customSetup :178739, :178876, :179976;
 *  EnhancedGameObject::customSetup :182204; traced for every id by
 *  tools/ref-trace-ida-customsetup.py]
 */
export const INVISIBLE_IDS: ReadonlySet<number> = new Set([
  144, 145, 146, 147, 204, 205, 206, 459, 673, 674, 740, 741, 742, 1340, 1341, 1342, 1343, 1344, 1345,
]);

/**
 * The objects whose glow takes the background every frame rather than their
 * own colour (+929): the orbs, the ice spikes, and the hazard saws, blades
 * and cogwheels but 678-680 and the invisible ones. setObjectColor leaves
 * their glow alone, and updateVisibility gives it the background less
 * saturated and brighter, as the invisible blocks' tint — or the light
 * background (+930, GLOW_LIGHT_BG_IDS) for the black saws and cogwheels and
 * the dark blades. The brick (143) is not one, but updateVisibility gives its
 * glow the same tint by its id. Most orbs' glows are locked (GLOW_LOCKED).
 * [GameObject::customSetup :177765-177768 (1701-1703), :180197-180201
 *  (177-179); EnhancedGameObject::customSetup :182027-182040 (the LABEL_233
 *  blades), :182564-182574; RingObject::init :308156-308167, also
 *  DashRingObject's :308184-308187, for the orbs createWithKey makes as
 *  rings (physics/timeTable.ts); setObjectColor :165358-165364;
 *  updateVisibility :95996-95997 (143), :96010-96018; traced for every id by
 *  tools/ref-trace-ida-customsetup.py]
 */
export const GLOW_BG_IDS: ReadonlySet<number> = new Set([
  36, 84, 88, 89, 98, 141, 143, 177, 178, 179, 183, 184, 185, 186, 187, 188, 397, 398, 399, 675, 676, 677, 1022, 1330, 1333,
  1594, 1619, 1620, 1701, 1702, 1703, 1704, 1705, 1706, 1707, 1708, 1709, 1710, 1734, 1735, 1736, 1751, 3004, 3027,
]);
const GLOW_LIGHT_BG_IDS: ReadonlySet<number> = new Set([
  88, 89, 98, 397, 398, 399, 675, 676, 677, 1705, 1706, 1707, 1708, 1709, 1710, 1734, 1735, 1736,
]);

/**
 * The pads' and orbs' glows, which setupCustomSprites colours once and locks
 * (+931), packed RGB: setGlowColor does nothing to them afterwards, so they
 * keep it whatever their channel or the background does, the +929 orbs
 * included. [setupCustomSprites :614716-614723 (35, 36), :614701-614707
 *  (67; 84 by :614625-614626), :614502-614509 (140, 141), :613125-613129
 *  (1022), :608495-608502 (1332, 1333), :608621-608628 (1704),
 *  :609059-609066 (1751), :611349-611356 (3004, 3005);
 *  GameObject::setGlowColor :164902-164915]
 */
const GLOW_LOCKED: ReadonlyMap<number, number> = new Map([
  [35, 0xffaf00],
  [36, 0xffaf00],
  [67, 0x00ffff],
  [84, 0x00ffff],
  [140, 0xff00ff],
  [141, 0xff00ff],
  [1022, 0x19ff19],
  [1332, 0xff6464],
  [1333, 0xff6464],
  [1704, 0x19ff19],
  [1751, 0xc800ff],
  [3004, 0x6400ff],
  [3005, 0x6400ff],
]);

/**
 * The solid colour blocks, which skip the default enter fade (+889) — some of
 * them only while they do not blend (+892). [GameObject::customSetup :177824,
 *  :178719, :178904-178914, :179455-179469, :179652, :179693-179694,
 *  :180351-180359, :180405, :180434; traced by tools/ref-trace-ida-customsetup.py]
 */
export const FADE_EXEMPT_IDS: ReadonlySet<number> = new Set([
  90, 91, 92, 93, 94, 95, 96, 207, 208, 209, 210, 211, 212, 213, 309, 311, 331, 333, 472, 473, 474, 687, 688, 693, 694, 1747, 1748,
]);
const FADE_EXEMPT_UNLESS_BLENDING_IDS: ReadonlySet<number> = new Set([207, 208, 209, 210, 211, 212, 213, 331, 333, 693, 694]);

/**
 * The editor-only objects, which customSetup makes invisible outside the
 * editor (+855 = !+549) as key 135 does: the triggers, and the start
 * positions, the D/J/S/H/F blocks, collision, force, collision-state and
 * player-touch blocks, and the keyframes. Activating one in play never turns
 * it on, so nothing of it draws. Most are trigger records the build skips
 * anyway; the rest are what this catches. [GameObject::customSetup :177924,
 *  :177972, :177989, :178192, :178380, :178416-178418, :178496, +855 = !+549;
 *  activateObject :169451-169475; traced for every id by
 *  tools/ref-trace-ida-customsetup.py]
 */
export const HIDDEN_IN_PLAY_IDS: ReadonlySet<number> = new Set([
  22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 55, 56, 57, 58, 59, 105, 744, 899, 900, 901, 915, 1006, 1007, 1049,
  1268, 1346, 1347, 1520, 1585, 1595, 1611, 1612, 1613, 1616, 1755, 1811, 1812, 1813, 1814, 1815, 1816, 1817, 1818,
  1819, 1829, 1859, 1912, 1913, 1914, 1915, 1916, 1917, 1931, 1932, 1934, 1935, 2015, 2016, 2062, 2066, 2067, 2068,
  2069, 2866, 2899, 2900, 2901, 2903, 2904, 2905, 2907, 2909, 2910, 2911, 2912, 2913, 2914, 2915, 2916, 2917, 2919,
  2920, 2921, 2922, 2923, 2924, 2925, 2999, 3006, 3007, 3008, 3009, 3010, 3011, 3012, 3013, 3014, 3015, 3016, 3017,
  3018, 3019, 3020, 3021, 3022, 3023, 3024, 3029, 3030, 3031, 3032, 3033, 3600, 3602, 3603, 3604, 3605, 3606, 3607,
  3608, 3609, 3612, 3613, 3614, 3615, 3617, 3618, 3619, 3620, 3640, 3641, 3642, 3643, 3645, 3655, 3660, 3661, 3662,
]);

/**
 * Each portal's back half, which PlayLayer::addObject adds as an object of its
 * own (emitPortalExtras): the gravity, mode, mirror, size and dual portals,
 * both teleports and their exits, and the green gravity toggle. A 2064 is an
 * exit and takes the exit's frame; a 2902 an entry, the entry's.
 * [gdp PlayLayer::addObject :90062-90250, LABEL_135 for 10]
 */
export const PORTAL_BACK: ReadonlyMap<number, string> = new Map([
  [10, "portal_01_back_001.png"],
  [11, "portal_02_back_001.png"],
  [12, "portal_03_back_001.png"],
  [13, "portal_04_back_001.png"],
  [45, "portal_05_back_001.png"],
  [46, "portal_06_back_001.png"],
  [47, "portal_07_back_001.png"],
  [99, "portal_08_back_001.png"],
  [101, "portal_09_back_001.png"],
  [111, "portal_10_back_001.png"],
  [286, "portal_11_back_001.png"],
  [287, "portal_12_back_001.png"],
  [660, "portal_13_back_001.png"],
  [745, "portal_14_back_001.png"],
  [747, "portal_15_back_001.png"],
  [749, "portal_16_back_001.png"],
  [1331, "portal_17_back_001.png"],
  [1933, "portal_18_back_001.png"],
  [2064, "portal_16_back_001.png"],
  [2902, "portal_15_back_001.png"],
  [2926, "portal_19_back_001.png"],
]);
/** The layer a back half goes in: 4, between B1 (3) and T1 (5). [:90146 (+241 = 4)] */
export const PORTAL_BACK_LAYER = 4;
/** A portal's default z order once its back half is added. [:90165] */
export const PORTAL_FRONT_ORDER = 12;
/** A linked teleport's exit: the 749's frame and its default layer. [:89922-89927; customSetup 749] */
const PORTAL_EXIT = { front: "portal_16_front_001.png", zl: 5 } as const;
/** How far left of the 747 its exit stands, before the portal's scale and turn. [getTeleportXOff :310694-310719] */
const TELEPORT_EXIT_X = 10;

/**
 * Where a linked teleport's exit — the 749 PlayLayer::addObject makes beside
 * a 747 — stands from the portal: 10 to its left, scaled and turned with it,
 * and key 54 up. [PlayLayer::addObject :89924-89931; getTeleportXOff
 *  :310694-310719]
 */
export function linkedExitOffset(object: LevelObject): [number, number] {
  const rad = (object.rotation * Math.PI) / 180;
  return [-Math.abs(TELEPORT_EXIT_X * object.scaleX * Math.cos(rad)), parseFloat(String(object.props[54] ?? "0")) || 0];
}

/**
 * The objects with a texture rect of their own (+1040), for which
 * getObjectTextureRect never sets the fade's lead (+704), so it stays 0.
 * [GameObject::getObjectTextureRect :165040-165047; the constructor zeroes it
 *  :165551; set in customSetup, EnhancedGameObject::customSetup and
 *  setupCustomSprites, traced by tools/ref-trace-ida-customsetup.py, and for
 *  1886-1888 in the quadrant loop the trace cannot run :610143-610190]
 */
const CUSTOM_RECT_IDS: ReadonlySet<number> = new Set([
  925, 926, 1019, 1020, 1021, 1049, 1120, 1122, 1123, 1124, 1125, 1126, 1127, 1132, 1133, 1134, 1135, 1136, 1137, 1138,
  1139, 1170, 1241, 1242, 1243, 1244, 1245, 1246, 1304, 1758, 1759, 1760, 1761, 1762, 1763, 1831, 1832, 1833, 1834,
  1835, 1836, 1837, 1838, 1839, 1840, 1841, 1842, 1886, 1887, 1888,
  ...Array.from({ length: 4539 - 4401 + 1 }, (_, k) => 4401 + k),
]);

/**
 * The objects whose rect is a size of their own rather than their frame's:
 * +1041 with +1044 for the waterfall and the splash and the beasts, and
 * BlackSludge's content size, which its beast sprite stands in for.
 * [setupCustomSprites :608314-608316 (1516), :608344-608346 (1518);
 *  AnimatedGameObject::setupAnimatedSize :307266-307340]
 */
const CUSTOM_RECT_SIZES: ReadonlyMap<number, readonly [number, number]> = new Map<number, readonly [number, number]>([
  [1516, [30, 30]],
  [1518, [30, 15]],
  [918, [80, 80]],
  [919, [25, 6]],
  [1327, [35, 30]],
  [1328, [35, 40]],
  [1584, [60, 80]],
  [2012, [45, 45]],
]);

/**
 * The objects that pulse to the music (+824): the orbs, the pulsing balls and
 * the fireballs. The music scales them, so the enter effects that scale leave
 * them be — unless key 372 (+825) turns the pulse off. [GameObject::customSetup,
 *  traced by tools/ref-trace-ida-customsetup.py; applyEnterEffect
 *  :91256-91278; objectFromVector (372 → +825)]
 */
export const AUDIO_SCALE_IDS: ReadonlySet<number> = new Set([
  36, 37, 50, 51, 52, 53, 54, 60, 84, 132, 133, 136, 141, 148, 149, 150, 236, 405, 460, 494, 495, 496, 497, 1022, 1055, 1056,
  1057, 1330, 1333, 1582, 1583, 1594, 1704, 1751, 3004, 3027,
]);

/** The pulsing decorations customSetup gives a range of their own (+910): 0.8 to 1.2. [customSetup :178766-178771, :179880-179888, :182326-182336] */
const RANGED_PULSE_IDS: ReadonlySet<number> = new Set([132, 133, 136, 150, 236, 460, 494, 495, 496, 497, 1055, 1056, 1057]);

/**
 * How the music pulse scales a sprite: not at all; with its object, about
 * the object's position, as the pulse is (plain), within 0.8-1.2 (ranged) or
 * as an orb's ring; or about its own centre, as the pulse is — the ball a
 * rod carries, an object of its own on another object's sprite list.
 * [pulseScale]
 */
const PULSE_NONE = 0;
const PULSE_PLAIN = 1;
const PULSE_RANGED = 2;
const PULSE_RING = 3;
const PULSE_OWN = 4;

/** The orbs: RingObjects, whose setRScale is their own. [GameObject::createWithKey (RingObject::create)] */
const RING_IDS: ReadonlySet<number> = new Set([36, 84, 141, 1022, 1330, 1333, 1594, 1704, 1751, 3004, 3027]);

function pulseKindOf(object: LevelObject): number {
  if (!AUDIO_SCALE_IDS.has(object.id) || objectFlag(object, OBJECT_KEY.noAudioScale)) return PULSE_NONE;
  if (RING_IDS.has(object.id)) return PULSE_RING;
  return RANGED_PULSE_IDS.has(object.id) ? PULSE_RANGED : PULSE_PLAIN;
}

/**
 * How fast a rotating object turns before its sign, in degrees a second, from
 * the roll `r` (0..1) customSetup makes for it; 0 for an object that does not
 * turn. [EnhancedGameObject::customSetup :181863-182790 (+1199 and the speed
 *  handed to createRotateAction), traced for every id by
 *  tools/ref-trace-ida-customsetup.py]
 */
export function rotationBase(id: number, r: number): number {
  const wide = 90 + r * 90;
  switch (id) {
    case 85: case 86: case 87: case 97: case 222: case 223: case 224: case 394: case 395: case 396:
    case 997: case 998: case 999: case 1000: case 137: case 138: case 139: case 180: case 181: case 182:
      return wide;
    case 154: case 155: case 156:
      return 1.5 * wide;
    case 375: case 1521: case 1525:
      return 1.4 * wide;
    case 376: case 1522: case 1526:
      return 1.2 * wide;
    case 377: case 1523: case 1527:
      return wide;
    case 378: case 1524: case 1528:
      return 0.8 * wide;
    case 1019: case 1020: case 1021:
      return 45 + r * 135;
    case 1022: case 1330:
      return 270;
    case 1055: case 1056: case 1057: case 1058: case 1059: case 1060: case 1061:
    case 1831: case 1832: case 1833: case 1834: case 1752:
      return 270 + r * 90;
    case 1582:
      return (0.8 + r * 0.4) * 270;
    case 88: case 186: case 397: case 676: case 740: case 1705: case 1708: case 1735:
      return 300;
    case 89: case 98: case 183: case 184: case 185: case 187: case 188: case 398: case 399: case 677:
    case 678: case 679: case 680: case 741: case 742: case 1706: case 1707: case 1709: case 1710: case 1736:
      return 360;
    case 675: case 1734:
      return 240;
    case 1619:
      return 720;
    case 1620:
      return 1080;
    default:
      return 0;
  }
}

/**
 * An object's turning speed in degrees a second: key 97 when it is set, else
 * its base with a random sign; 0 when it does not turn or key 98 stops it.
 * customObjectSetup rolls the sign again whatever customSetup chose, so the
 * sign is always random unless key 97 sets the speed outright.
 * [EnhancedGameObject::customObjectSetup :181779-181798 → createRotateAction
 *  :181692-181720]
 */
export function rotationSpeed(object: LevelObject): number {
  const base = rotationBase(object.id, hash01(object.index, 0x5913));
  if (base === 0 || objectFlag(object, OBJECT_KEY.noRotation)) return 0;
  const fixed = Number.parseFloat(object.props[OBJECT_KEY.rotationSpeed] ?? "0") || 0;
  if (fixed !== 0) return fixed;
  return hash01(object.index, 0x519e) <= 0.5 ? -base : base;
}

/** `ObjectState.flags`. */
const O_KEEP_OPACITY = 1;
const O_KEEP_POSE = 2;
const O_INVISIBLE = 4;
const O_FADE_EXEMPT = 8;
const O_FADE_EXEMPT_UNLESS_BLENDING = 16;
const O_AUDIO_SCALE = 32;
const O_GLOW_BG = 64;
const O_GLOW_LIGHT_BG = 128;

export interface ViewBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DrawListStats {
  objects: number;
  sprites: number;
  skippedTriggers: number;
  skippedNoArt: number;
  /** Objects hidden in play, by key 135 or as editor-only: they may collide, but draw nothing. */
  hidden: number;
  missingFrames: number;
  wide: number;
  columns: number;
  dynamic: number;
  /** Sprites that play a frame animation. */
  animated: number;
  /** Objects that turn by themselves (saws, blades, wheels). */
  spinning: number;
  /** Objects drawn as a skeletal entity rather than as a sprite. */
  skeletons: number;
  /**
   * Places sprites are drawn from (Slots): one each, plus one for each other
   * batch a colour trigger can move a sprite to.
   */
  slots: number;
  /** Text objects drawn, and text objects skipped for want of a font. */
  texts: number;
  skippedNoFont: number;
}

/** What the live simulation contributes to a frame. */
export interface LiveScene {
  colors: ColorTable;
  triggers: TriggerRuntime;
  /** Player 1 has died: the invisible blocks show. [PlayLayer::updateVisibility :96030-96035] */
  playerDead?: () => boolean;
  /** The music pulse the pulsing objects scale with; without one they hold still. [src/audio/pulse.ts] */
  pulse?: () => number;
}

/** Per-sprite data the static bake cannot fold into the instance bytes. */
interface SpriteMeta {
  object: Int32Array;
  /** Colour channel the sprite follows; 1012 is derived from `mainChannel`. */
  channel: Int32Array;
  mainChannel: Int32Array;
  /**
   * The channel whose blending flag decides the sprite's, or BLEND_ALWAYS /
   * BLEND_NEVER: its batch's, so the main half's for the object's own sprite
   * and everything hung on it, and the colour sprite's for that sprite and its
   * children. A batch draws all it holds with one blend.
   */
  blendChannel: Int32Array;
  shift: (HsvShift | null)[];
  /**
   * Its alpha with its channel's opacity as the build found it: what a gather
   * with no live scene shows, as the baked colour is the build's too.
   */
  baseAlpha: Float32Array;
  /**
   * Its own alpha, without its channel's: the type's and its tree's. A live
   * gather puts the channel's opacity as it is now on top. [shade]
   */
  ownAlpha: Float32Array;
  /** 1 for a sprite additive in its own right (a glow, additive art), which no channel undoes. */
  baseAdditive: Uint8Array;
  /** 1 when this is the object's main colour rather than its detail one. */
  main: Uint8Array;
  /** 1 for a glow sprite, which an invisible block fades differently and a glow tint recolours. */
  glow: Uint8Array;
  /**
   * 1 for black art: black whatever its channel or a pulse does, which then
   * gives it only its opacity (`channel` is its object's main colour). See
   * Pending.black.
   */
  black: Uint8Array;
  /** How the music pulse scales it: a PULSE_* kind. */
  pulse: Uint8Array;
  /** Index into `flipbooks`, or -1 for a sprite that never changes frame. */
  flip: Int32Array;
  /** Index into `spin` (12 floats each), or -1 for a sprite that does not turn. */
  spin: Int32Array;
}

/**
 * The draw order: one entry per place a sprite can be drawn, sorted. Most
 * sprites have one; a sprite whose batch follows a channel a colour trigger
 * can make blend or stop blending has one per batch it can be in, each
 * drawn only while its object's halves blend that way.
 */
interface Slots {
  /** The sprite each slot draws. */
  sprite: Int32Array;
  /** Which of the object's four blend states (MAIN_BLENDS | COLOUR_BLENDS) the slot is drawn in, a bit each. */
  mask: Uint8Array;
  /** The z of its batch in the object layer (batchNodes.batchZ). */
  z: Int16Array;
  /** Which of the nine draw layers that batch is in (batchNodes.slotOfZ). */
  layer: Uint8Array;
}

/** A slot drawn in every blend state. */
const EVERY_STATE = 0b1111;
/** The bits of an object's blend state: its main half blends, its colour sprite blends. [+744, +745] */
const MAIN_BLENDS = 1;
const COLOUR_BLENDS = 2;
/** The most node runs a gather can make: one per batch z there is. */
const MAX_RUNS = 256;

/**
 * One animated sprite's frames, already in instance form.
 *
 * Swapping a frame means new texture coordinates *and* new geometry — frames
 * are trimmed individually, so the second frame of a sequence is rarely the
 * same size or centred in the same place as the first. Baking all of them at
 * load makes a frame change a ten-float copy, and keeps the arithmetic in the
 * build where the transform already is.
 */
interface Flipbook {
  /** Seconds per frame, for a skeletal limb; an object's own frames come from its clock (anim.ts). */
  interval: number;
  frames: number;
  /** `frames` × 10 floats: the transform, the position and the uv. */
  data: Float32Array;
  sheet: Uint8Array;
  rotated: Uint8Array;
  /**
   * Per-frame alpha multiplier. A skeletal limb uses 0 for the frames it is
   * not in; ring children use the special animation's fade.
   */
  alpha: Float32Array;
}

/** An animated object's clock: its settled timing and where its loop walk got to. */
interface AnimState {
  timing: AnimTiming;
  memo: Float64Array;
}

/**
 * What the build settles per object, and what a gather settles per object per
 * frame. Indexed by the object's place in the level.
 */
interface ObjectState {
  /** O_* bits. */
  flags: Uint8Array;
  /** Key 343: which enter channel the object follows. */
  channel: Uint8Array;
  /** How far the fade's leading edge is from the object's position (+704). */
  fadeHalf: Float32Array;
  /**
   * The channels whose blending is the object's (+960: its main half's or its
   * detail half's), for the fade exemption; the detail one is BLEND_NEVER for
   * an object with no detail art.
   */
  blendChannel: Int32Array;
  blendDetail: Int32Array;
  /** Index into `anims`, or -1. */
  anim: Int32Array;
  /** Index into `skeletons`, or -1: a beast, whose clip runs on its own clock. */
  skel: Int32Array;
  skeletons: { plan: SkeletonPlan; clock: SkeletonClock; appliedGen: number }[];
  /** Degrees a second it turns; 0 for none. */
  spinSpeed: Float32Array;
  /**
   * How far its sprites reach from its position, as a radius, every frame and
   * every turn included: an object further than that outside the view is not
   * settled.
   */
  reach: Float32Array;
  /** Packed RGB its glow is locked to (GLOW_LOCKED), or -1. */
  glowLock: Int32Array;
  /**
   * The channels its two batches follow, the main half's and its colour
   * sprite's (BLEND_NEVER without one), which of them a colour trigger can
   * change the blending of (MAIN_BLENDS | COLOUR_BLENDS), and the blend state
   * the level starts in.
   */
  mainBlend: Int32Array;
  colourBlend: Int32Array;
  varies: Uint8Array;
  startState: Uint8Array;
  // --- per gather ---
  /** Its halves' blend state this gather, which picks the slots it is drawn in. */
  state: Uint8Array;
  stamp: Int32Array;
  hidden: Uint8Array;
  frame: Int32Array;
  flash: Uint8Array;
  alpha: Float32Array;
  glowAlpha: Float32Array;
  /** Packed RGB its glow takes this gather in place of its channel's, or -1. */
  tint: Int32Array;
  dx: Float32Array;
  dy: Float32Array;
  scale: Float32Array;
  px: Float32Array;
  py: Float32Array;
  angle: Float64Array;
  /** The gather this object was last settled in, to tell an object that came back on screen. */
  seen: Int32Array;
  /** The enter effect latched as it started coming in or going out (+864, +866): 0 for none. */
  latchIn: Uint8Array;
  latchOut: Uint8Array;
  /** Whether it sat above the middle of the screen when it latched. */
  above: Uint8Array;
  /** Enter Tint (3021) effects applied this gather, or null. */
  enterTints: (AreaTint[] | null)[];
}

function objectState(n: number): ObjectState {
  const size = Math.max(1, n);
  return {
    flags: new Uint8Array(size),
    channel: new Uint8Array(size),
    fadeHalf: new Float32Array(size),
    blendChannel: new Int32Array(size).fill(BLEND_NEVER),
    blendDetail: new Int32Array(size).fill(BLEND_NEVER),
    anim: new Int32Array(size).fill(-1),
    skel: new Int32Array(size).fill(-1),
    skeletons: [],
    spinSpeed: new Float32Array(size),
    reach: new Float32Array(size),
    glowLock: new Int32Array(size).fill(-1),
    mainBlend: new Int32Array(size).fill(BLEND_NEVER),
    colourBlend: new Int32Array(size).fill(BLEND_NEVER),
    varies: new Uint8Array(size),
    startState: new Uint8Array(size),
    state: new Uint8Array(size),
    stamp: new Int32Array(size).fill(-1),
    hidden: new Uint8Array(size),
    frame: new Int32Array(size),
    flash: new Uint8Array(size),
    alpha: new Float32Array(size).fill(1),
    glowAlpha: new Float32Array(size).fill(1),
    tint: new Int32Array(size).fill(-1),
    dx: new Float32Array(size),
    dy: new Float32Array(size),
    scale: new Float32Array(size).fill(1),
    px: new Float32Array(size),
    py: new Float32Array(size),
    angle: new Float64Array(size),
    seen: new Int32Array(size).fill(-2),
    latchIn: new Uint8Array(size),
    latchOut: new Uint8Array(size),
    above: new Uint8Array(size),
    enterTints: new Array(size).fill(null),
  };
}

/** The tint the invisible blocks' and GLOW_BG_IDS' glows take: the background, less saturated and brighter. [updateVisibility :95846-95847] */
const INVISIBLE_TINT: HsvShift = { h: 0, s: -0.2, v: 0.2, sChecked: true, vChecked: true };

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
/** What black art is set to when it is made, and keeps. [ccBLACK, unk_983E30 / algn_981693] */
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

export class DrawList {
  /** Use `DrawList.build`; buildDrawList below is what lays these out. */
  constructor(
    readonly count: number,
    private readonly data: Float32Array,
    private readonly minX: Float32Array,
    private readonly maxX: Float32Array,
    private readonly minY: Float32Array,
    private readonly maxY: Float32Array,
    /** The column lists, the wide run and the dynamic run hold slots, not sprites. */
    private readonly columns: Int32Array[],
    private readonly wide: Int32Array,
    /** Slots of sprites a movement trigger can carry; culled against their live box. */
    private readonly dynamic: Int32Array,
    private readonly firstColumn: number,
    private readonly slots: Slots,
    private readonly meta: SpriteMeta,
    private readonly flipbooks: readonly Flipbook[],
    private readonly spin: Float32Array,
    private readonly anims: readonly AnimState[],
    private readonly objects: ObjectState,
    private readonly level: Level,
    readonly stats: DrawListStats,
  ) {
    this.scratch = new Float32Array(Math.max(1, count) * INSTANCE_FLOATS);
    this.bytes = new Uint8Array(this.scratch.buffer);
  }

  private readonly scratch: Float32Array;
  private readonly bytes: Uint8Array;
  private readonly m9 = new Float64Array(9);
  private lastVisible = 0;
  /** Which gather this is, so per-object state is settled once per call. */
  private gather = 0;
  /**
   * The background tint the glows take, the light colour an invisible
   * block's washes toward, and the light background, packed where a glow
   * takes them as they are: all follow the background and the player's
   * colour alone, so they are worked out once a gather, on the gather stamped
   * here.
   */
  private tintGather = -1;
  private tintBase: Rgb = WHITE;
  private tintLight: Rgb = WHITE;
  private tintPacked = 0;
  private lightBgPacked = 0;
  /**
   * The last `visible` call's sprites by batch: one run per batch z drawn
   * from, in order — its z, where it starts in the buffer and how long it is
   * — and each of the nine draw layers' (B5 to T4, the slots of
   * shaderState.LAYER_Z) first run and run count. The scene draws a layer at
   * a time, because the player's own pieces and a screen-effect band's edges
   * fall between them, and inside a layer puts the particle systems between
   * batches by their z.
   */
  readonly runZ = new Int16Array(MAX_RUNS);
  readonly runStart = new Int32Array(MAX_RUNS);
  readonly runCount = new Int32Array(MAX_RUNS);
  readonly layerRunFirst = new Int32Array(LAYER_Z.length);
  readonly layerRuns = new Int32Array(LAYER_Z.length);
  /** How many runs the last `visible` call made. */
  runs = 0;

  /** How many instances the last `visible` call selected. */
  get visibleCount(): number {
    return this.lastVisible;
  }

  /**
   * Forgets what the gathers carried from one to the next — the enter effect
   * each object latched, whether it was on screen, where its loop walk got to
   * — for a restart or a respawn, after which the game starts every object
   * afresh. [PlayLayer::resetLevel :105839-105843 → resetObject]
   */
  reset(): void {
    const os = this.objects;
    os.stamp.fill(-1);
    os.seen.fill(-2);
    os.latchIn.fill(0);
    os.latchOut.fill(0);
    os.above.fill(0);
    for (const state of this.anims) state.memo.fill(Number.NaN);
    this.tintGather = -1;
  }

  /**
   * What the last `visible` handed an object's setOpacity, 0..1: its fade at
   * the screen's edge or its enter effect's, before its colour's opacity and
   * its groups'. 0 for an object that call did not show — off screen, out of
   * view, switched off, or between the plays of its animation (+658) — which
   * is what the game's edge fade gives one past the edge.
   * [PlayLayer::updateVisibility :96001-96076 (vfunc 448 is setOpacity);
   *  GameObject::setOpacity :167614-167645]
   */
  objectFade(o: number): number {
    const os = this.objects;
    if (o < 0 || o >= os.stamp.length || os.stamp[o] !== this.gather || os.hidden[o] === 1) return 0;
    return os.alpha[o];
  }

  /**
   * Gathers what the camera can see into one buffer, still in draw order.
   *
   * The column lists are built by walking the sorted array, so each is already
   * ordered; merging a handful of them is a k-way merge on the slot index
   * (the draw order). `live` is what makes a level play: it is
   * consulted per gathered sprite, so only what is on screen pays for a colour
   * that is being pulsed or a block that is being moved.
   *
   * `seconds` is the simulation's clock, which the turning objects and the
   * skeletal limbs run on; an object's frame animation runs on the level time,
   * as the game's does. Both are the sim's, so a frame of a macro draws the
   * same whatever the display rate. [PlayLayer::updateVisibility :95979-95988]
   */
  visible(view: ViewBox, live?: LiveScene | null, seconds = 0, screen: ViewBox = view): Float32Array {
    const from = Math.max(this.firstColumn, Math.floor(view.x0 / COLUMN));
    const to = Math.min(this.firstColumn + this.columns.length - 1, Math.floor(view.x1 / COLUMN));
    const runs: Int32Array[] = [];
    const heads: number[] = [];
    for (let c = from; c <= to; c++) {
      const list = this.columns[c - this.firstColumn];
      if (list && list.length > 0) {
        runs.push(list);
        heads.push(0);
      }
    }
    if (this.wide.length > 0) {
      runs.push(this.wide);
      heads.push(0);
    }
    if (this.dynamic.length > 0) {
      runs.push(this.dynamic);
      heads.push(0);
    }

    this.gather++;
    const levelTime = live && Number.isFinite(live.triggers.levelTime) ? live.triggers.levelTime : seconds;

    let out = 0;
    let lastIndex = -1;
    const scratch = this.scratch;
    const data = this.data;
    const meta = this.meta;
    const slots = this.slots;
    const os = this.objects;
    const moving = live ? live.triggers.hasMotion : false;
    const pulse = live?.pulse ? live.pulse() : null;
    this.layerRunFirst.fill(0);
    this.layerRuns.fill(0);
    let nodeRuns = 0;
    let runZ = NO_NODE;
    for (;;) {
      let best = -1;
      let bestIndex = 0x7fffffff;
      for (let r = 0; r < runs.length; r++) {
        const head = heads[r];
        if (head >= runs[r].length) continue;
        const candidate = runs[r][head];
        if (candidate < bestIndex) {
          bestIndex = candidate;
          best = r;
        }
      }
      if (best < 0) break;
      heads[best]++;
      // A sprite wide enough to sit in two of the visible columns is at the
      // head of both runs, and the merge would take it from each in turn. The
      // runs are sorted, so a repeat is always the index just emitted.
      if (bestIndex === lastIndex) continue;
      lastIndex = bestIndex;
      const s = bestIndex;
      const i = slots.sprite[s];
      const o = meta.object[i];
      if (os.stamp[o] !== this.gather) this.settle(o, levelTime, seconds, live, view, screen);
      if (os.hidden[o] === 1) continue;
      // The batch this slot is for is not where the object's halves put it now.
      const mask = slots.mask[s];
      if (mask !== EVERY_STATE && (mask & (1 << os.state[o])) === 0) continue;
      const at = out * INSTANCE_FLOATS;
      scratch.set(data.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS), at);
      // The frame first, because the cull below reads the geometry and an
      // animated sprite's frames are not all the same size.
      const book = meta.flip[i];
      let frameAlpha = 1;
      if (book >= 0) {
        const anim = os.anim[o];
        if (anim >= 0) frameAlpha = this.showLimb(at, this.flipbooks[book], os.frame[o]);
        else if (os.skel[o] >= 0) frameAlpha = this.showLimb(at, this.flipbooks[book], os.frame[o]);
        else frameAlpha = this.playFrame(at, this.flipbooks[book], seconds);
      } else if (meta.spin[i] >= 0 && os.angle[o] !== 0) {
        this.turn(at, meta.spin[i] * 12, os.angle[o]);
      }
      if (frameAlpha <= 0) continue;
      const uiDraw = live?.triggers.uiOffsetOf?.(o, (screen.x1 - screen.x0) / 2, (screen.y1 - screen.y0) / 2);
      if (uiDraw) {
        scratch[at + 4] = (screen.x0 + screen.x1) / 2 + uiDraw.dx;
        scratch[at + 5] = (screen.y0 + screen.y1) / 2 + uiDraw.dy;
      } else if (moving && live && live.triggers.objectTransform(o, this.m9)) {
        this.carry(at, this.m9);
        const hx = Math.abs(scratch[at]) + Math.abs(scratch[at + 2]);
        const hy = Math.abs(scratch[at + 1]) + Math.abs(scratch[at + 3]);
        if (scratch[at + 4] + hx < view.x0 || scratch[at + 4] - hx > view.x1) continue;
        if (scratch[at + 5] + hy < view.y0 || scratch[at + 5] - hy > view.y1) continue;
      } else if (book >= 0 || meta.spin[i] >= 0) {
        // An animated sprite's baked box is one frame's, and a turning one's
        // its resting pose; cull against what is actually being drawn, or a
        // tall frame pops in at the screen edge.
        const hx = Math.abs(scratch[at]) + Math.abs(scratch[at + 2]);
        const hy = Math.abs(scratch[at + 1]) + Math.abs(scratch[at + 3]);
        if (scratch[at + 4] + hx < view.x0 || scratch[at + 4] - hx > view.x1) continue;
        if (scratch[at + 5] + hy < view.y0 || scratch[at + 5] - hy > view.y1) continue;
      } else {
        // The column test is on x only, and a wide sprite may be far off screen.
        if (this.maxX[i] < view.x0 || this.minX[i] > view.x1) continue;
        if (this.maxY[i] < view.y0 || this.minY[i] > view.y1) continue;
      }
      let alpha = meta.baseAlpha[i];
      if (live) alpha = this.shade(at, i, o, live);
      alpha *= frameAlpha * (meta.glow[i] === 1 ? os.glowAlpha[o] : os.alpha[o]);
      if (alpha <= 0) continue;
      const pulseKind = meta.pulse[i];
      if (pulseKind !== PULSE_NONE && pulse !== null) this.pulseSprite(at, o, pulseKind, pulse);
      if (os.dx[o] !== 0 || os.dy[o] !== 0 || (os.scale[o] !== 1 && pulseKind !== PULSE_OWN)) this.pose(at, o, pulseKind !== PULSE_OWN);
      // setGlowColor recolours the glow alone; the object's other sprites
      // keep their channels'. [GameObject::setGlowColor :164902-164915]
      if (os.tint[o] >= 0 && meta.glow[i] === 1) {
        const b = at * 4;
        const tint = os.tint[o];
        this.bytes[b + 40] = (tint >> 16) & 255;
        this.bytes[b + 41] = (tint >> 8) & 255;
        this.bytes[b + 42] = tint & 255;
      }
      this.bytes[out * INSTANCE_BYTES + 43] = Math.round(Math.min(1, alpha) * 255);
      // The slots are in batch order, so a batch's sprites are one run.
      const z = slots.z[s];
      if (z !== runZ && nodeRuns < MAX_RUNS) {
        runZ = z;
        this.runZ[nodeRuns] = z;
        this.runStart[nodeRuns] = out;
        this.runCount[nodeRuns] = 0;
        const layer = slots.layer[s];
        if (this.layerRuns[layer]++ === 0) this.layerRunFirst[layer] = nodeRuns;
        nodeRuns++;
      }
      this.runCount[nodeRuns - 1]++;
      out++;
    }
    this.lastVisible = out;
    this.runs = nodeRuns;
    return scratch;
  }

  /**
   * Everything about an object that is the same for all its sprites, once per
   * gather: whether it is anywhere near the view, whether a group toggle has
   * it off, its animation frame, its turn, and its enter effect and fade.
   */
  private settle(
    o: number,
    levelTime: number,
    seconds: number,
    live: LiveScene | null | undefined,
    view: ViewBox,
    screen: ViewBox,
  ): void {
    const os = this.objects;
    os.stamp[o] = this.gather;
    // Which batches its halves are in, from whether they blend now: a colour
    // trigger can move them. [updateVisibility :95946-95958 →
    //  addMainSpriteToParent, addColorSpriteToParent]
    const varies = os.varies[o];
    let state = os.startState[o];
    if (varies !== 0 && live) {
      if ((varies & MAIN_BLENDS) !== 0) state = this.blends(os.mainBlend[o], live) ? state | MAIN_BLENDS : state & ~MAIN_BLENDS;
      if ((varies & COLOUR_BLENDS) !== 0) {
        state = this.blends(os.colourBlend[o], live) ? state | COLOUR_BLENDS : state & ~COLOUR_BLENDS;
      }
    }
    os.state[o] = state;
    let x = this.level.objects[o].x;
    let y = this.level.objects[o].y;
    // Its reach about where it is now, carried by its groups' turn and scale
    // and grown by whatever an enter effect can do to it.
    let rx = os.reach[o];
    let ry = rx;
    if (live && live.triggers.hasMotion && live.triggers.objectTransform(o, this.m9)) {
      const m = this.m9;
      const ox = x;
      x = m[0] * ox + m[2] * y + m[4];
      y = m[1] * ox + m[3] * y + m[5];
      rx *= Math.hypot(m[0], m[2]);
      ry *= Math.hypot(m[1], m[3]);
    }
    const ui = live?.triggers.uiOffsetOf?.(o, (screen.x1 - screen.x0) / 2, (screen.y1 - screen.y0) / 2);
    if (ui) {
      x = (screen.x0 + screen.x1) / 2 + ui.dx;
      y = (screen.y0 + screen.y1) / 2 + ui.dy;
    }
    rx = rx * ENTER_GROW_FROM + ENTER_SLIDE;
    ry = ry * ENTER_GROW_FROM + ENTER_SLIDE;
    // Off screen, nothing of it shows and nothing it carries moves on: it is
    // not marked seen, so a latched enter effect lapses as the game's does.
    if (x + rx < view.x0 || x - rx > view.x1 || y + ry < view.y0 || y - ry > view.y1) {
      os.hidden[o] = 1;
      return;
    }
    // The game only shows an object whose groups are all on: a Toggle trigger
    // hides it as well as stopping it colliding. [GJBaseGameLayer::
    //  preUpdateVisibility :452902 (+550, groupWasDisabled :169906-169913)]
    if (live && live.triggers.hasToggles && live.triggers.objectDisabled(o)) {
      os.hidden[o] = 1;
      os.seen[o] = this.gather;
      return;
    }
    // An animated object between plays, or waiting on its trigger, is still
    // in the visible list — its enter effect runs on — but shows nothing
    // (+658, opacity 0). [EnhancedGameObject::waitForAnimationTrigger
    //  :620462-620475; GameObject::setOpacity]
    os.hidden[o] = 0;
    const anim = os.anim[o];
    if (anim >= 0) {
      const state = this.anims[anim];
      const triggered = live?.triggers.animationStartOf?.(o) ?? Number.NaN;
      const frame = syncedFrame(state.timing, levelTime, triggered, state.memo);
      os.frame[o] = frame;
      os.flash[o] = live ? flashHalves(this.level.objects[o], frame) : 0;
    }
    const skel = os.skel[o];
    if (skel >= 0) {
      // A beast starts its clip over, part-way in, each time it comes back on
      // screen, and on a restart. An Animate trigger's key 76 switches it to
      // a named clip once per fire. [AnimatedGameObject::activateObject
      //  :307207-307219; resetObject :307238-307249; playAnimation
      //  :307645-307681]
      const entry = os.skeletons[skel];
      const { plan, clock } = entry;
      if (os.seen[o] !== this.gather - 1 || seconds < clock.began) startSkeleton(plan, clock, seconds, o);
      const cmd = live?.triggers.skeletonAnimOf?.(o) ?? null;
      if (cmd && cmd.gen !== entry.appliedGen) {
        const name = animationForID(this.level.objects[o].id, cmd.id);
        if (name && switchSkeleton(plan, clock, name, seconds)) entry.appliedGen = cmd.gen;
      }
      os.frame[o] = skeletonFrame(plan, clock, seconds, o);
    }
    // The turn, from the sim's clock. The game turns an object only while it
    // is in the visible part of the level, from 0 at each reset; that pause
    // off screen cannot be seen, as every object's speed and sign are rolls,
    // and a clock of the sim's draws a macro's frame the same at any display
    // rate. [updateVisibility :95987-95988 → EnhancedGameObject::
    //  updateRotateAction :182804-182870 (+1216, zeroed by resetObject
    //  :170043-170067)]
    if (os.spinSpeed[o] !== 0) os.angle[o] = (seconds * os.spinSpeed[o]) % 360;
    os.px[o] = x;
    os.py[o] = y;
    this.enterAndFade(o, x, y, live, screen);
    os.seen[o] = this.gather;
    if (anim >= 0 && os.frame[o] < 0) os.hidden[o] = 1;
  }

  /**
   * The enter effect and the fade, as PlayLayer::updateVisibility applies them
   * to an object each frame.
   *
   * Which side: an object latches the effect in force as it starts coming in
   * (+864) or going out (+866), and keeps it until it is fully in or fully out
   * again; with neither latched, the left half of the screen is the going-out
   * side. Each side reads its own table, by the object's enter channel (key
   * 343), which the enter triggers fill as they are reached.
   *
   * The fade is measured from the object's position less +704 — half its
   * width beyond one block — over the 70-unit band inside the edge; key 64
   * skips it, and so does the solid colour blocks' exemption while the
   * default effect is in force. The glow fades with the object. The invisible
   * blocks fade by distance from the middle of the screen instead, and set
   * their glow's apart. The motion is applyEnterEffect, measured from the
   * position itself; key 67 holds the object at rest.
   *
   * The glow's colour is settled here too, where the game sets it: the
   * invisible blocks' and GLOW_BG_IDS' take the background, the second
   * sometimes the light background, and a locked one keeps its own.
   * [PlayLayer::updateVisibility :95996-95997, :96001-96076; applyEnterEffect
   *  :91072-91300; getRelativeModNew :91043-91055; GameObject::setOpacity
   *  :167614-167660 → setGlowOpacity; updateInvisibleBlock :91418-91444;
   *  setGlowColor :164902-164915]
   */
  private enterAndFade(o: number, x: number, y: number, live: LiveScene | null | undefined, screen: ViewBox): void {
    const os = this.objects;
    const flags = os.flags[o];
    // An object that was not in the last gather was out of view, where the
    // game's progress is 0 and both latches lapse.
    if (os.seen[o] !== this.gather - 1) {
      os.latchIn[o] = 0;
      os.latchOut[o] = 0;
    }
    const tables = live?.triggers.visual?.enter;
    const channel = os.channel[o];
    const mid = (screen.x0 + screen.x1) / 2;
    const entering = os.latchIn[o] !== 0 || !(os.latchOut[o] !== 0 || x <= mid);
    const code = tables ? (entering ? tables.in[channel] : tables.out[channel]) : ENTER.fade;
    const latched = entering ? os.latchIn[o] : os.latchOut[o];

    os.alpha[o] = 1;
    os.glowAlpha[o] = 1;
    os.tint[o] = -1;
    os.enterTints[o] = null;
    if ((flags & O_INVISIBLE) !== 0) {
      this.invisibleBlock(o, x, live, screen);
    } else {
      if ((flags & O_KEEP_OPACITY) !== 0 || !enterFades(code)) {
        // full opacity: key 64, "none", and the custom effects (their own fade)
      } else if (
        (flags & O_FADE_EXEMPT) !== 0 &&
        ((flags & O_FADE_EXEMPT_UNLESS_BLENDING) === 0 ||
          !(this.blends(os.blendChannel[o], live) || this.blends(os.blendDetail[o], live))) &&
        (latched === 0 || latched === ENTER.fade) &&
        code === ENTER.fade
      ) {
        // full opacity
      } else {
        const h = os.fadeHalf[o];
        os.alpha[o] = enterProgress(entering ? screen.x1 - (x - h) : x + h - screen.x0);
      }
      os.glowAlpha[o] = os.alpha[o];
    }
    if ((flags & O_GLOW_BG) !== 0 && live) {
      this.backdrop(live);
      os.tint[o] = (flags & O_GLOW_LIGHT_BG) !== 0 ? this.lightBgPacked : this.tintPacked;
    }
    if (os.glowLock[o] >= 0) os.tint[o] = os.glowLock[o];

    os.dx[o] = 0;
    os.dy[o] = 0;
    os.scale[o] = 1;
    // Custom enter (3017-3021): Fade and Tint from the channel's list; Move /
    // Rotate / Scale are not drawn, so the object rests.
    // [gdp applyCustomEnterEffect :90645-91026]
    if (code === ENTER.custom) {
      if ((flags & O_KEEP_POSE) === 0) this.applyCustomEnter(o, x, entering, live, screen);
      return;
    }
    const progress = enterProgress(entering ? screen.x1 - x : x - screen.x0);
    const done = (flags & O_KEEP_POSE) !== 0 || progress === 1;
    let use = 0;
    if (latched === 0 || (code === ENTER.none && latched !== ENTER.none)) {
      if (done) return;
      use = code;
      if (entering) os.latchIn[o] = code;
      else os.latchOut[o] = code;
      // The angled and vertical effects pick their side as they latch.
      const above = y > (screen.y0 + screen.y1) / 2 ? 1 : 0;
      os.above[o] = (os.above[o] & (entering ? 2 : 1)) | (above << (entering ? 0 : 1));
    } else if (!done) {
      use = latched;
    } else {
      if (entering) os.latchIn[o] = 0;
      else os.latchOut[o] = 0;
      return;
    }
    if (progress === 0) {
      if (entering) os.latchIn[o] = 0;
      else os.latchOut[o] = 0;
    }
    const above = ((os.above[o] >> (entering ? 0 : 1)) & 1) === 1;
    const pose = enterPose(use, progress, above, o);
    os.dx[o] = pose.dx;
    os.dy[o] = pose.dy;
    os.scale[o] = (flags & O_AUDIO_SCALE) !== 0 ? 1 : pose.scale;
  }

  /**
   * Enter Fade (3020) and Enter Tint (3021) for one object. Progress is the
   * distance inside the screen edge over key 222, eased by keys 242/243;
   * Fade multiplies opacity by that, Tint blends like Area Tint.
   * [gdp PlayLayer::applyCustomEnterEffect :90899-90958]
   */
  private applyCustomEnter(
    o: number,
    x: number,
    entering: boolean,
    live: LiveScene | null | undefined,
    screen: ViewBox,
  ): void {
    const effects = live?.triggers.customEnters(this.objects.channel[o], entering);
    if (!effects || effects.length === 0) return;
    const os = this.objects;
    const edge = entering ? screen.x1 : screen.x0;
    let alpha = 1;
    let tints: AreaTint[] | null = null;
    for (const e of effects) {
      const length = e.length + e.lengthPm * (live?.triggers.areaVariance(o, 223) ?? 0);
      const offset = e.offset + e.offsetPm * (live?.triggers.areaVariance(o, 221) ?? 0);
      const at = customEnterProgress(x, entering, edge, offset, length, e.deadzone);
      if (at >= 1) continue;
      if (e.id === 3020) {
        if ((os.flags[o] & O_KEEP_OPACITY) !== 0) continue;
        alpha *= areaEase(at, e.easing, e.rate);
      } else if (e.id === 3021 && e.tint) {
        (tints ??= []).push({ ...e.tint, value: at, percent: e.percent });
      }
    }
    os.alpha[o] *= alpha;
    os.glowAlpha[o] = os.alpha[o];
    os.enterTints[o] = tints;
  }

  /** Works out the background colours the glows take, once a gather. [updateVisibility :95836-95863] */
  private backdrop(live: LiveScene): void {
    if (this.tintGather === this.gather) return;
    this.tintGather = this.gather;
    const bg = live.colors.get(CHANNEL.BG);
    const lightBg = live.colors.get(CHANNEL.LIGHT_BG);
    this.tintBase = applyHsv(bg, INVISIBLE_TINT);
    this.tintLight = bg.r + bg.g + bg.b < 150 ? lightBg : WHITE;
    this.tintPacked = packRgb(this.tintBase);
    this.lightBgPacked = packRgb(lightBg);
  }

  /**
   * An invisible block's opacity: nearly nothing near the middle of the
   * screen, more toward the edges, and faded out at the edges themselves —
   * over 70 units on the left, 50 on the right. Its glow keeps a little more.
   * The glow, not the block, takes the background's colour, washed toward the
   * light background (or white, on a light background) as the block gets
   * solid; the block keeps its own channel's. With player 1 dead it shows in
   * full. The bands are in window points, which this port reads as units:
   * they agree at the default zoom.
   * [PlayLayer::updateInvisibleBlock :91356-91444 (vfunc 744 is
   *  setGlowColor); getRelativeMod :91303-91335; the bands and colours
   *  updateVisibility hands it :95836-95863, :96020-96028]
   */
  private invisibleBlock(o: number, x: number, live: LiveScene | null | undefined, screen: ViewBox): void {
    const os = this.objects;
    if (!live) return;
    this.backdrop(live);
    if (live.playerDead?.()) {
      os.tint[o] = this.tintPacked;
      return;
    }
    const half = (screen.x1 - screen.x0) / 2;
    const centre = screen.x0 + half;
    const h = os.fadeHalf[o];
    const xp = x <= centre ? x + h : x - h;
    const edge = clamp01((half - Math.abs(xp - centre)) * (xp <= centre ? 0.014286 : 0.02));
    let d: number;
    let span: number;
    if (xp <= screen.x0 + half + 35) {
      d = screen.x0 + half - 75 - xp;
      span = half - 105;
    } else {
      d = xp - (screen.x0 + half + 35);
      span = half - 125;
    }
    const t = clamp01(d / Math.max(1, span));
    const opacity = Math.min(Math.trunc((0.05 + 0.95 * t) * 255), Math.trunc(edge * 255));
    os.alpha[o] = opacity / 255;
    os.glowAlpha[o] = Math.min(Math.trunc((0.15 + 0.85 * t) * 255), Math.trunc(edge * 255)) / 255;
    const op = opacity / 255;
    if (op <= 0.8) {
      os.tint[o] = this.tintPacked;
    } else {
      const k = (1 - (op - 0.8) / 0.2) * 0.3 + 0.7;
      os.tint[o] = packMix(this.tintBase, this.tintLight, k);
    }
  }

  private blends(blendChannel: number, live: LiveScene | null | undefined): boolean {
    if (blendChannel === BLEND_ALWAYS) return true;
    return blendChannel >= 0 && live ? live.colors.get(blendChannel).blending : false;
  }

  /** Moves and scales a sprite with its object's enter pose, about the object's position. */
  private pose(at: number, o: number, scales: boolean): void {
    const os = this.objects;
    const s = this.scratch;
    const k = os.scale[o];
    if (k !== 1 && scales) {
      const ox = os.px[o];
      const oy = os.py[o];
      s[at] *= k;
      s[at + 1] *= k;
      s[at + 2] *= k;
      s[at + 3] *= k;
      s[at + 4] = ox + (s[at + 4] - ox) * k;
      s[at + 5] = oy + (s[at + 5] - oy) * k;
    }
    s[at + 4] += os.dx[o];
    s[at + 5] += os.dy[o];
  }

  /** Scales a sprite with the music pulse, about its object's position or, for PULSE_OWN, its own centre. */
  private pulseSprite(at: number, o: number, kind: number, pulse: number): void {
    const k = pulseScale(kind === PULSE_RING ? "ring" : kind === PULSE_RANGED ? "ranged" : "plain", pulse);
    if (k === 1) return;
    const s = this.scratch;
    s[at] *= k;
    s[at + 1] *= k;
    s[at + 2] *= k;
    s[at + 3] *= k;
    if (kind === PULSE_OWN) return;
    const ox = this.objects.px[o];
    const oy = this.objects.py[o];
    s[at + 4] = ox + (s[at + 4] - ox) * k;
    s[at + 5] = oy + (s[at + 5] - oy) * k;
  }

  /**
   * Turns a sprite of a rotating object by `angle` degrees clockwise in its
   * object's own space, then puts it back through the object's transform.
   */
  private turn(at: number, from: number, angle: number): void {
    const sp = this.spin;
    const s = this.scratch;
    const rad = (-angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // The sprite in object space, turned.
    const lxa = cos * sp[from] - sin * sp[from + 1];
    const lxb = sin * sp[from] + cos * sp[from + 1];
    const lxc = cos * sp[from + 2] - sin * sp[from + 3];
    const lxd = sin * sp[from + 2] + cos * sp[from + 3];
    const lpx = cos * sp[from + 4] - sin * sp[from + 5];
    const lpy = sin * sp[from + 4] + cos * sp[from + 5];
    // Through the object's own transform.
    const a = sp[from + 6];
    const b = sp[from + 7];
    const c = sp[from + 8];
    const d = sp[from + 9];
    s[at] = a * lxa + c * lxb;
    s[at + 1] = b * lxa + d * lxb;
    s[at + 2] = a * lxc + c * lxd;
    s[at + 3] = b * lxc + d * lxd;
    s[at + 4] = a * lpx + c * lpy + sp[from + 10];
    s[at + 5] = b * lpx + d * lpy + sp[from + 11];
  }

  /** Writes frame `k` of a flipbook over the copied instance. */
  private showFrame(at: number, book: Flipbook, k: number): void {
    const from = Math.min(Math.max(0, k), book.frames - 1) * 10;
    const s = this.scratch;
    for (let j = 0; j < 10; j++) s[at + j] = book.data[from + j];
    const b = at * 4;
    const f = from / 10;
    this.bytes[b + 44] = book.sheet[f];
    this.bytes[b + 45] = book.rotated[f];
  }

  /**
   * Writes the frame a skeletal limb is on at `seconds` over the copied
   * instance, and returns that frame's alpha.
   *
   * The clock is the simulation's, not the wall's, so a pause holds every
   * animation still and two runs of the same macro look identical.
   */
  private playFrame(at: number, book: Flipbook, seconds: number): number {
    const k = book.frames > 1 ? Math.floor(seconds / book.interval) % book.frames : 0;
    this.showFrame(at, book, k);
    return book.alpha[k];
  }

  /** Writes frame `k` of a skeletal limb over the copied instance, and returns that frame's alpha. */
  private showLimb(at: number, book: Flipbook, k: number): number {
    this.showFrame(at, book, k);
    return book.alpha[Math.min(Math.max(0, k), book.frames - 1)];
  }

  /** Carries a sprite's baked transform through its group's affine. */
  private carry(at: number, m: Float64Array): void {
    const s = this.scratch;
    const xa = s[at];
    const xb = s[at + 1];
    const xc = s[at + 2];
    const xd = s[at + 3];
    const px = s[at + 4];
    const py = s[at + 5];
    s[at] = m[0] * xa + m[2] * xb;
    s[at + 1] = m[1] * xa + m[3] * xb;
    s[at + 2] = m[0] * xc + m[2] * xd;
    s[at + 3] = m[1] * xc + m[3] * xd;
    s[at + 4] = m[0] * px + m[2] * py + m[4];
    s[at + 5] = m[1] * px + m[3] * py + m[5];
  }

  /**
   * One half's colour as the object wears it: its channel, then each pulse on
   * each of its groups that reaches that half, then its own hue shift.
   * [GameObject::colorForMode :173028-173089: groupColor :173063, the shift
   *  after it, transformColor :173079]
   */
  private worn(object: LevelObject, base: Rgb, isMain: boolean, shift: HsvShift | null, colours: ColorSource): Rgb {
    let rgb = base;
    if (colours.pulsesForGroup) {
      for (const g of object.groups) {
        const pulses = colours.pulsesForGroup(g);
        if (!pulses) continue;
        for (const p of pulses) {
          if (pulseAppliesTo(p, isMain)) rgb = colorForPulse(rgb, p, (n) => colours.get(n));
        }
      }
    }
    return applyHsv(rgb, shift);
  }

  /**
   * Re-reads the sprite's colour from the live table. Returns the alpha, which
   * the caller may still cut into for an enter effect.
   *
   * A lighter (1012) detail is the lighter form of the main half as it is worn
   * — pulsed and shifted — with the detail's own shift on top and no pulse of
   * its own. [colorForMode :173059 (no group colour for a 1012 detail);
   *  getActiveColorForMode, the 1012 branch: colorForEffect(getColor())]
   */
  private shade(at: number, i: number, o: number, live: LiveScene): number {
    const meta = this.meta;
    const colours = live.colors;
    const id = meta.channel[i];
    const channel = colours.get(id);
    const object = this.level.objects[o];
    const isMain = meta.main[i] === 1;
    let rgb: Rgb;
    if (meta.black[i] === 1) {
      rgb = BLACK;
    } else if (id === CHANNEL.LIGHTER) {
      const main = this.worn(object, colours.get(meta.mainChannel[i]), true, object.baseHsv, colours);
      rgb = applyHsv(lighterColor(main), meta.shift[i]);
    } else {
      rgb = this.worn(object, channel, isMain, meta.shift[i], colours);
    }
    // The channel's opacity as the game rounds it for the object's sprites.
    // [channelOpacityMod; GameObject::setOpacity :167631-167636, :167683-167687]
    let alpha = meta.ownAlpha[i] * channelOpacityMod(channel.a);
    for (const g of object.groups) alpha *= live.triggers.groupAlphaOf(g);
    const area = live.triggers.areaVisualOf?.(o);
    if (area) {
      if (area.opacity !== undefined) alpha *= area.opacity;
      if (meta.black[i] !== 1) rgb = areaTinted(rgb, area.tints, isMain, colours);
    }
    const enterTints = this.objects.enterTints[o];
    if (enterTints && meta.black[i] !== 1) rgb = areaTinted(rgb, enterTints, isMain, colours);
    // The special animations' first-frame flash. [flashHalves]
    const flash = this.objects.flash[o];
    if (flash !== 0 && meta.glow[i] === 0 && (flash & (isMain ? 1 : 2)) !== 0) rgb = WHITE;
    const b = at * 4;
    this.bytes[b + 40] = rgb.r;
    this.bytes[b + 41] = rgb.g;
    this.bytes[b + 42] = rgb.b;
    const bc = meta.blendChannel[i];
    const blends = bc === BLEND_ALWAYS || (bc >= 0 && colours.get(bc).blending);
    // Every additive sprite here is in one of the object layer's additive
    // batches. [BLEND.ADD_SPRITE]
    this.bytes[b + 46] = meta.baseAdditive[i] === 1 || blends ? BLEND.ADD_SPRITE : BLEND.NORMAL;
    return alpha;
  }

  static build(
    level: Level,
    render: (id: number) => ObjectRecord | undefined,
    atlas: AtlasSet,
    colors: ColorTable,
    movingGroups?: ReadonlySet<number>,
    entities?: ReadonlyMap<string, AnimEntity>,
    font?: LevelFont | null,
    /** Orb / portal colourblind guides. Defaults match a fresh save: orbs off, portals on. */
    guides?: { orb?: boolean; portal?: boolean },
  ): DrawList {
    return buildDrawList(level, render, atlas, colors, movingGroups, entities, font, guides);
  }
}

/**
 * The Area Tints on one half of an object, in order: with an HSV, the shift
 * scaled by how near the centre it is; else that much of the tint's share of
 * its channel mixed in. [gdp processAreaTintGroupAction :427199-427208
 * (getMultipliedHSV by 1 − value, transformColor), :427325-427383
 * (multipliedColorValue by 1 − percent + value × percent)]
 */
export function areaTinted(rgb: Rgb, tints: readonly AreaTint[], isMain: boolean, colours: { get(channel: number): Rgb }): Rgb {
  let out = rgb;
  for (const t of tints) {
    if (!(isMain ? t.main : t.detail)) continue;
    if (t.hsv) out = applyHsv(out, multipliedHsv(t.hsv, 1 - t.value));
    else out = multipliedColorValue(colours.get(t.channel), out, 1 - t.percent + t.value * t.percent);
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function packRgb(c: Rgb): number {
  return ((c.r & 255) << 16) | ((c.g & 255) << 8) | (c.b & 255);
}

/** GJEffectManager::getMixedColor, packed: `a` by k and `b` by 1 − k, truncated. [:474965-475000] */
function packMix(a: Rgb, b: Rgb, k: number): number {
  return (mixChannel(a.r, b.r, k) << 16) | (mixChannel(a.g, b.g, k) << 8) | mixChannel(a.b, b.b, k);
}

function mixChannel(x: number, y: number, k: number): number {
  return Math.max(0, Math.min(255, Math.trunc((1 - k) * y + x * k)));
}

// --- building ----------------------------------------------------------------

/**
 * What picks an object's batches: the game's object, or the extra object
 * PlayLayer::addObject makes beside a portal, which has its own.
 */
interface NodeInfo {
  /** Its place in the level string: the arrival order its batches tie-break on. */
  order: number;
  /** Key 24 as getObjectZLayer reads it, and key 25 as getObjectZOrder does. */
  zl: number;
  zo: number;
  /** getParentMode. */
  mode: number;
  /** It has a colour sprite (+187), and that sits in front of the object (+909, colourSpriteInFront). */
  hasColour: boolean;
  inFront: boolean;
  /** +552: the colour sprite stays on the object whatever the halves' blending. */
  stays: boolean;
  /** The channels the two halves' blending follows (blendChannelOf). */
  mainBlend: number;
  colourBlend: number;
  /** Which halves a colour trigger can change the blending of, and the state the build sees. */
  varies: number;
  startState: number;
}

/** Which part of the object a sprite is: its own sprite and what hangs on it, its colour sprite's, its glow. */
const PART_MAIN = 0;
const PART_COLOUR = 1;
const PART_GLOW = 2;

/**
 * The z of the batch a sprite is in, for its object's halves blending as
 * `state` says. The object's own sprite goes in the batch of its main half's
 * blending, one layer up when that half blends and the colour sprite does
 * not (unless the colour sprite is the one in front). The colour sprite goes
 * with it when the two blend alike, or when the object keeps it (+552);
 * otherwise in a batch of its own blending, one layer up when it blends and
 * sits in front. A glow goes in its layer's glow batch. NO_NODE for the one
 * batch the game never made. `legacy` is the level's legacyLayers.
 * [GameObject::addMainSpriteToParent :169272-169338, addColorSpriteToParent
 *  :169340-169420, addColorSpriteToSelf :168641-168670, activateObject
 *  :169462-169471]
 */
function nodeZFor(n: NodeInfo, part: number, state: number, legacy: boolean): number {
  if (part === PART_GLOW) return batchZ(n.zl, true, PARENT_MODE.GLOW);
  const main = (state & MAIN_BLENDS) !== 0;
  const colour = n.hasColour ? (state & COLOUR_BLENDS) !== 0 : main;
  if (part === PART_COLOUR && !n.stays && main !== colour) {
    return batchZ(n.zl + (colour && n.inFront ? 1 : 0), colour, n.mode, legacy);
  }
  return batchZ(n.zl + (n.hasColour && main && !colour && !n.inFront ? 1 : 0), main, n.mode, legacy);
}

interface Pending {
  /** What picks its batch, which part of the object it is, and its place in the object's tree. */
  node: NodeInfo;
  part: number;
  intra: number;
  /** Baked instance fields. */
  xa: number;
  xb: number;
  xc: number;
  xd: number;
  px: number;
  py: number;
  u0: number;
  v0: number;
  du: number;
  dv: number;
  r: number;
  g: number;
  b: number;
  /** Its alpha with its channel's opacity as the build finds it; `own` without. */
  a: number;
  own: number;
  sheet: number;
  rotated: number;
  additive: number;
  /** `additive` without the channel's part: see SpriteMeta.baseAdditive. */
  ownAdditive: number;
  /** The transform the frame was baked through, for re-baking its other frames. */
  matrix: Affine;
  /** Frames this sprite plays on its object's clock, or null when it holds one frame for ever. */
  anim: readonly AnimFrame[] | null;
  /**
   * World point a frame's scale/turn acts about when the sprite is anchored
   * (ring children); null means the sprite centre (2892/2893's spin).
   */
  animAbout: { x: number; y: number } | null;
  /** A flipbook built by the caller, for a skeletal limb. */
  book: Flipbook | null;
  /** The sprite in its object's own space and the object's transform, for one that turns. */
  spin: Float32Array | null;
  /** Per-sprite metadata the live path needs. */
  object: number;
  channel: number;
  mainChannel: number;
  blendChannel: number;
  shift: HsvShift | null;
  main: number;
  glow: number;
  /**
   * 1 for black art (a "K" sprite): set black when it is made and never
   * coloured again, so neither its channel nor a pulse reaches its colour.
   * Its opacity is still its object's main colour's, which `channel` names.
   * The object's own sprite is black art when the object keeps it out of
   * setObjectColor (+541); a black child is one addCustomBlackChild made,
   * kept out by +540, and its opacity is the object's (setOpacity hands the
   * children the main half's).
   * [setupCustomSprites :614660-614800 (setObjectColor(ccBLACK), +540, +541)
   *  and :606565-606820, :609096-609097; customSetup :178915-178916,
   *  :180361-180362; setObjectColor :165359-165362 (+541), :165397-165400
   *  (+540); addCustomBlackChild :166918-166944; setOpacity :167631-167700]
   */
  black: number;
  /** How the music pulse scales it: a PULSE_* kind, none when unset. */
  pulse?: number;
  /** What its corners make (SHAPE): a piece of a cut sprite can be a triangle. */
  shape?: number;
}

/**
 * How far an object's fade is measured ahead of its position (+704): half its
 * width beyond a block, from its main frame's untrimmed size (or the size of
 * its own the object carries), scaled, and turned. A quarter turn of key 6
 * (±90 or ±270 exactly, +760) swaps the sides; otherwise any rotation X that
 * is neither 0 nor ±180 takes the diagonal. An object with a texture rect of
 * its own never gets one. [GameObject::getObjectTextureRect :165040-165097;
 *  setRotation sets +760 :164488; objectFromVector :184214-184237]
 */
function fadeHalfOf(object: LevelObject, record: ObjectRecord, atlas: AtlasSet): number {
  if (CUSTOM_RECT_IDS.has(object.id)) return 0;
  let w: number;
  let h: number;
  const size = CUSTOM_RECT_SIZES.get(object.id);
  if (size) {
    [w, h] = size;
  } else {
    const found = record.f ? atlas.frame(record.f) : undefined;
    if (!found) return 0;
    const src = frameSourceSize(found.frame);
    w = src.w / atlas.pxPerUnit;
    h = src.h / atlas.pxPerUnit;
  }
  w *= Math.abs(object.scaleX);
  h *= Math.abs(object.scaleY);
  const r = loadRotation(object);
  const rx = loadAngles(object).x;
  if (r === 90 || r === -90 || r === 270 || r === -270) w = h;
  else if (rx !== 0 && Math.abs(rx) !== 180) w = Math.hypot(w, h);
  return w > 30 ? w / 2 - 15 : 0;
}

function buildDrawList(
  level: Level,
  render: (id: number) => ObjectRecord | undefined,
  atlas: AtlasSet,
  colors: ColorTable,
  movingGroups?: ReadonlySet<number>,
  entities?: ReadonlyMap<string, AnimEntity>,
  font?: LevelFont | null,
  guides?: { orb?: boolean; portal?: boolean },
): DrawList {
  const orbGuide = guides?.orb === true;
  const portalGuide = guides?.portal !== false;
  const pending: Pending[] = [];
  const stats: DrawListStats = {
    objects: 0,
    sprites: 0,
    skippedTriggers: 0,
    skippedNoArt: 0,
    hidden: 0,
    missingFrames: 0,
    wide: 0,
    columns: 0,
    dynamic: 0,
    animated: 0,
    spinning: 0,
    skeletons: 0,
    slots: 0,
    texts: 0,
    skippedNoFont: 0,
  };
  const objects = objectState(level.objects.length);
  const anims: AnimState[] = [];
  const variable = blendVariableChannels(level);
  const legacy = legacyLayers(level.capacity);
  const rodBall = rodBallFrame(Math.random());

  for (const object of level.objects) {
    const record = render(object.id);
    if (!record) {
      stats.skippedNoArt++;
      continue;
    }
    // A trigger is invisible in play. Its only art is the editor's palette icon,
    // which this build does not ship — 131 of the 133 trigger records point at
    // an edit_* frame, and the levels place 10,426 of them.
    if (record.k === "trigger") {
      stats.skippedTriggers++;
      continue;
    }
    // Hide (key 135), and the editor-only objects: shown nowhere in play. The
    // game makes them invisible outside the editor, and activating one then
    // never turns it on or parents its colour sprite, so nothing of it draws
    // — art, detail, children, glow — while it may still collide. The editor
    // keeps them visible; an editor draw list would pass these through.
    // [objectFromVector :184143-184146 (+1106); saveActiveColors
    //  :173315-173322 (+855 unless +549, the editor flag); customSetup
    //  :177924…:178496 (+855 = !+549, HIDDEN_IN_PLAY_IDS); activateObject
    //  :169451-169475; addGlow :165833]
    if (objectFlag(object, OBJECT_KEY.hide) || HIDDEN_IN_PLAY_IDS.has(object.id)) {
      stats.hidden++;
      continue;
    }
    stats.objects++;
    const i = object.index;
    const angles = loadAngles(object);
    const sx = object.scaleX * (object.flipX ? -1 : 1);
    const sy = object.scaleY * (object.flipY ? -1 : 1);
    const root =
      angles.x === angles.y
        ? affine(object.x, object.y, angles.x, sx, sy)
        : affineXY(object.x, object.y, angles.x, angles.y, sx, sy);
    // Keys 64 and 67 set the object's ignore-fade and ignore-enter flags.
    // [objectFromVector :184114-184122; saveActiveColors :173306-173309]
    objects.flags[i] =
      (objectFlag(object, OBJECT_KEY.dontFade) ? O_KEEP_OPACITY : 0) |
      (objectFlag(object, OBJECT_KEY.dontEnter) ? O_KEEP_POSE : 0) |
      (INVISIBLE_IDS.has(object.id) ? O_INVISIBLE : 0) |
      (FADE_EXEMPT_IDS.has(object.id) ? O_FADE_EXEMPT : 0) |
      (FADE_EXEMPT_UNLESS_BLENDING_IDS.has(object.id) ? O_FADE_EXEMPT_UNLESS_BLENDING : 0) |
      (AUDIO_SCALE_IDS.has(object.id) && !objectFlag(object, OBJECT_KEY.noAudioScale) ? O_AUDIO_SCALE : 0) |
      (GLOW_BG_IDS.has(object.id) ? O_GLOW_BG : 0) |
      (GLOW_LIGHT_BG_IDS.has(object.id) ? O_GLOW_LIGHT_BG : 0);
    objects.glowLock[i] = GLOW_LOCKED.get(object.id) ?? -1;
    // Key 343, clamped to the hundred and one channels. [objectFromVector :184028-184040]
    const channel = objectInt(object, OBJECT_KEY.enterChannel);
    objects.channel[i] = channel <= 0 ? 0 : Math.min(100, channel);
    objects.fadeHalf[i] = fadeHalfOf(object, record, atlas);
    // +960 is the main half's blending, else the detail half's; an object
    // with no detail art has no detail half. [addMainSpriteToParent
    //  :169316-169320]
    const channels = objectChannels(object, record);
    objects.blendChannel[i] = blendChannelOf(channels.base, channels.base, object.id);
    if (hasDetail(record)) objects.blendDetail[i] = blendChannelOf(channels.detail, channels.base, object.id);
    const speed = rotationSpeed(object);
    if (speed !== 0) {
      objects.spinSpeed[i] = speed;
      stats.spinning++;
    }
    const first = pending.length;
    emit(object, record, root, pending, stats, atlas, colors, i, objects, anims, variable, rodBall, entities, font, orbGuide, portalGuide);
    const pulse = pulseKindOf(object);
    for (let p = first; p < pending.length; p++) pending[p].pulse ??= pulse;
  }

  // --- the draw order ---
  // Every place each sprite can be drawn, sorted by batch, then z order, then
  // arrival, then its place in its object's tree. The key is two exact
  // doubles: (batch z, z order) and (arrival, place).
  const slotSprite: number[] = [];
  const slotZ: number[] = [];
  const slotMask: number[] = [];
  const keyHi: number[] = [];
  const keyLo: number[] = [];
  const zs: number[] = [];
  const masks: number[] = [];
  for (let p = 0; p < pending.length; p++) {
    const sprite = pending[p];
    const n = sprite.node;
    zs.length = 0;
    masks.length = 0;
    let reachable = 0;
    for (let state = 0; state < 4; state++) {
      // Only the states the level can put the object's halves in.
      if (((state ^ n.startState) & ~n.varies & 3) !== 0) continue;
      reachable |= 1 << state;
      const z = nodeZFor(n, sprite.part, state, legacy);
      if (z === NO_NODE) continue;
      const at = zs.indexOf(z);
      if (at >= 0) masks[at] |= 1 << state;
      else {
        zs.push(z);
        masks.push(1 << state);
      }
    }
    const zo = sprite.part === PART_GLOW ? GLOW_Z_ORDER : n.zo;
    for (let k = 0; k < zs.length; k++) {
      slotSprite.push(p);
      slotZ.push(zs[k]);
      slotMask.push(masks[k] === reachable ? EVERY_STATE : masks[k]);
      keyHi.push((zs[k] + 4096) * 4294967296 + (zo + 2147483648));
      keyLo.push(n.order * 2097152 + sprite.intra);
    }
  }
  const major = Float64Array.from(keyHi);
  const minor = Float64Array.from(keyLo);
  const sorted = new Uint32Array(slotSprite.length);
  for (let s = 0; s < sorted.length; s++) sorted[s] = s;
  sorted.sort((a, b) => major[a] - major[b] || minor[a] - minor[b] || slotSprite[a] - slotSprite[b]);
  // The sprites are baked in the order they are first drawn in, so a gather
  // reads the buffer mostly front to back.
  const spriteOf = new Int32Array(Math.max(1, pending.length)).fill(-1);
  const baked: Pending[] = [];
  for (const s of sorted) {
    const p = slotSprite[s];
    if (spriteOf[p] < 0) {
      spriteOf[p] = baked.length;
      baked.push(pending[p]);
    }
  }
  // A sprite whose every batch the game never made is never drawn.
  for (let k = 0; k < baked.length; k++) pending[k] = baked[k];
  pending.length = baked.length;
  const slotCount = sorted.length;
  const slots: Slots = {
    sprite: new Int32Array(Math.max(1, slotCount)),
    mask: new Uint8Array(Math.max(1, slotCount)),
    z: new Int16Array(Math.max(1, slotCount)),
    layer: new Uint8Array(Math.max(1, slotCount)),
  };
  for (let s = 0; s < slotCount; s++) {
    const from = sorted[s];
    slots.sprite[s] = spriteOf[slotSprite[from]];
    slots.mask[s] = slotMask[from];
    slots.z[s] = slotZ[from];
    slots.layer[s] = slotOfZ(slotZ[from]);
  }

  const count = pending.length;
  stats.sprites = count;
  stats.slots = slotCount;
  const buffer = new ArrayBuffer(Math.max(1, count) * INSTANCE_BYTES);
  const floats = new Float32Array(buffer);
  const bytes = new Uint8Array(buffer);
  const minX = new Float32Array(Math.max(1, count));
  const maxX = new Float32Array(Math.max(1, count));
  const minY = new Float32Array(Math.max(1, count));
  const maxY = new Float32Array(Math.max(1, count));
  const meta: SpriteMeta = {
    object: new Int32Array(Math.max(1, count)),
    channel: new Int32Array(Math.max(1, count)),
    mainChannel: new Int32Array(Math.max(1, count)),
    blendChannel: new Int32Array(Math.max(1, count)),
    shift: new Array<HsvShift | null>(Math.max(1, count)).fill(null),
    baseAlpha: new Float32Array(Math.max(1, count)),
    ownAlpha: new Float32Array(Math.max(1, count)),
    baseAdditive: new Uint8Array(Math.max(1, count)),
    main: new Uint8Array(Math.max(1, count)),
    glow: new Uint8Array(Math.max(1, count)),
    black: new Uint8Array(Math.max(1, count)),
    pulse: new Uint8Array(Math.max(1, count)),
    flip: new Int32Array(Math.max(1, count)).fill(-1),
    spin: new Int32Array(Math.max(1, count)).fill(-1),
  };
  const flipbooks: Flipbook[] = [];
  const spinning = pending.filter((p) => p.spin !== null).length;
  const spin = new Float32Array(Math.max(1, spinning) * 12);
  let spins = 0;

  for (let i = 0; i < count; i++) {
    const p = pending[i];
    const f = i * INSTANCE_FLOATS;
    floats[f] = p.xa;
    floats[f + 1] = p.xb;
    floats[f + 2] = p.xc;
    floats[f + 3] = p.xd;
    floats[f + 4] = p.px;
    floats[f + 5] = p.py;
    floats[f + 6] = p.u0;
    floats[f + 7] = p.v0;
    floats[f + 8] = p.du;
    floats[f + 9] = p.dv;
    const o = i * INSTANCE_BYTES;
    bytes[o + 40] = p.r;
    bytes[o + 41] = p.g;
    bytes[o + 42] = p.b;
    bytes[o + 43] = Math.round(p.a * 255);
    bytes[o + 44] = p.sheet;
    bytes[o + 45] = p.rotated;
    bytes[o + 46] = p.additive ? BLEND.ADD_SPRITE : BLEND.NORMAL;
    bytes[o + 47] = p.shape ?? SHAPE.QUAD;
    meta.object[i] = p.object;
    meta.channel[i] = p.channel;
    meta.mainChannel[i] = p.mainChannel;
    meta.blendChannel[i] = p.blendChannel;
    meta.shift[i] = p.shift;
    meta.baseAlpha[i] = p.a;
    meta.ownAlpha[i] = p.own;
    meta.baseAdditive[i] = p.ownAdditive;
    meta.main[i] = p.main;
    meta.glow[i] = p.glow;
    meta.black[i] = p.black;
    meta.pulse[i] = p.pulse ?? PULSE_NONE;
    if (p.book || p.anim) {
      const book = p.book ?? bakeFlipbook(p, atlas);
      if (book) {
        meta.flip[i] = flipbooks.length;
        flipbooks.push(book);
        stats.animated++;
      }
    }
    if (p.spin && meta.flip[i] < 0) {
      meta.spin[i] = spins;
      spin.set(p.spin, spins * 12);
      spins++;
    }
    const hx = Math.abs(p.xa) + Math.abs(p.xc);
    const hy = Math.abs(p.xb) + Math.abs(p.xd);
    if (meta.spin[i] >= 0) {
      // A turning sprite is bucketed by the circle it sweeps about its object.
      const ox = level.objects[p.object].x;
      const oy = level.objects[p.object].y;
      const reach = Math.hypot(p.px - ox, p.py - oy) + Math.hypot(hx, hy);
      minX[i] = ox - reach;
      maxX[i] = ox + reach;
      minY[i] = oy - reach;
      maxY[i] = oy + reach;
    } else {
      minX[i] = p.px - hx;
      maxX[i] = p.px + hx;
      minY[i] = p.py - hy;
      maxY[i] = p.py + hy;
    }
    // An animated sprite is bucketed by every frame it can be on, not by the
    // one it rests on: the column lists are what the camera queries, and a
    // frame that reaches further would be dropped before it is ever drawn.
    const book = meta.flip[i] >= 0 ? flipbooks[meta.flip[i]] : null;
    if (book) {
      for (let k = 0; k < book.frames; k++) {
        const f = k * 10;
        const fx = Math.abs(book.data[f]) + Math.abs(book.data[f + 2]);
        const fy = Math.abs(book.data[f + 1]) + Math.abs(book.data[f + 3]);
        minX[i] = Math.min(minX[i], book.data[f + 4] - fx);
        maxX[i] = Math.max(maxX[i], book.data[f + 4] + fx);
        minY[i] = Math.min(minY[i], book.data[f + 5] - fy);
        maxY[i] = Math.max(maxY[i], book.data[f + 5] + fy);
      }
    }
    // The object's reach is its furthest sprite's box, every frame and the
    // whole turn included, about its own position: the box's far corner, so
    // it stays a bound when a group turns the object.
    const homeX = level.objects[p.object].x;
    const homeY = level.objects[p.object].y;
    const reach = Math.hypot(Math.max(homeX - minX[i], maxX[i] - homeX), Math.max(homeY - minY[i], maxY[i] - homeY));
    if (reach > objects.reach[p.object]) objects.reach[p.object] = reach;
  }

  // --- column buckets ---
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < count; i++) {
    if (minX[i] < lo) lo = minX[i];
    if (maxX[i] > hi) hi = maxX[i];
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 0;
  }
  const firstColumn = Math.floor(lo / COLUMN);
  const lastColumn = Math.floor(hi / COLUMN);
  const columnCount = Math.max(1, lastColumn - firstColumn + 1);
  stats.columns = columnCount;

  // A sprite a trigger can move cannot live in a column bucket: the bucket is
  // its position at load, and it is about to be somewhere else. Those go in
  // their own run and are culled against where they actually are.
  const isDynamic = new Uint8Array(Math.max(1, count));
  let dynamicSprites = 0;
  if (movingGroups && movingGroups.size > 0) {
    for (let i = 0; i < count; i++) {
      const groups = level.objects[meta.object[i]].groups;
      for (const g of groups) {
        if (!movingGroups.has(g)) continue;
        isDynamic[i] = 1;
        dynamicSprites++;
        break;
      }
    }
  }
  stats.dynamic = dynamicSprites;

  // The buckets hold slots, by their sprite's box, in draw order.
  const sizes = new Int32Array(columnCount);
  const wideSlots: number[] = [];
  const dynamicSlots: number[] = [];
  const spanOf = (i: number): { a: number; b: number } => ({
    a: Math.max(firstColumn, Math.floor(minX[i] / COLUMN)),
    b: Math.min(lastColumn, Math.floor(maxX[i] / COLUMN)),
  });
  for (let s = 0; s < slotCount; s++) {
    const i = slots.sprite[s];
    if (isDynamic[i] === 1) {
      dynamicSlots.push(s);
      continue;
    }
    const { a, b } = spanOf(i);
    if (b - a + 1 > WIDE_COLUMNS) {
      wideSlots.push(s);
      continue;
    }
    for (let c = a; c <= b; c++) sizes[c - firstColumn]++;
  }
  stats.wide = wideSlots.length;

  const columns: Int32Array[] = new Array(columnCount);
  for (let c = 0; c < columnCount; c++) columns[c] = new Int32Array(sizes[c]);
  const fill = new Int32Array(columnCount);
  for (let s = 0; s < slotCount; s++) {
    const i = slots.sprite[s];
    if (isDynamic[i] === 1) continue;
    const { a, b } = spanOf(i);
    if (b - a + 1 > WIDE_COLUMNS) continue;
    for (let c = a; c <= b; c++) {
      const at = c - firstColumn;
      columns[at][fill[at]++] = s;
    }
  }

  return new DrawList(
    count,
    floats,
    minX,
    maxX,
    minY,
    maxY,
    columns,
    Int32Array.from(wideSlots),
    Int32Array.from(dynamicSlots),
    firstColumn,
    slots,
    meta,
    flipbooks,
    spin,
    anims,
    objects,
    level,
    stats,
  );
}

/** A texture flip about the sprite's own box, as CCSprite::setFlipX does it. */
const FLIP_X = affine(0, 0, 0, -1, 1);

/**
 * Puts every frame of one animated sprite through the transform its resting
 * frame went through, so playing it is a copy. A frame the game shows
 * mirrored (setFlipX) is mirrored in its own box.
 *
 * Returns null when a frame name does not resolve. That should not happen —
 * anim.ts only hands out sequences whose every frame is in the atlas — but it
 * is checked here as well rather than trusted.
 */
function bakeFlipbook(p: Pending, atlas: AtlasSet): Flipbook | null {
  const frames = p.anim;
  if (!frames) return null;
  const data = new Float32Array(frames.length * 10);
  const sheet = new Uint8Array(frames.length);
  const rotated = new Uint8Array(frames.length);
  const alpha = new Float32Array(frames.length);
  for (let k = 0; k < frames.length; k++) {
    const found = atlas.frame(frames[k].f);
    if (!found) return null;
    let matrix = frames[k].flip ? compose(p.matrix, FLIP_X) : p.matrix;
    const s = frames[k].scale ?? 1;
    const rot = frames[k].rot ?? 0;
    if (s !== 1 || rot !== 0) {
      if (p.animAbout) {
        // Scale/turn about the child's position (cocos setScale / setRotation
        // on an anchored sprite). [1839-1842 :621557-621560]
        const { x: ox, y: oy } = p.animAbout;
        const about = compose(affine(ox, oy, 0, 1, 1), compose(affine(0, 0, rot, s, s), affine(-ox, -oy, 0, 1, 1)));
        matrix = compose(about, matrix);
      } else {
        // About the sprite centre: local origin of a centre-based bake.
        // [2892/2893 :620942-620946]
        matrix = compose(matrix, affine(0, 0, rot, s, s));
      }
    }
    const quad = frameQuad(found.atlas, found.frame, atlas.pxPerUnit);
    const centre = apply(matrix, quad.cx, quad.cy);
    const at = k * 10;
    data[at] = matrix.a * quad.hw;
    data[at + 1] = matrix.b * quad.hw;
    data[at + 2] = matrix.c * quad.hh;
    data[at + 3] = matrix.d * quad.hh;
    data[at + 4] = centre.x;
    data[at + 5] = centre.y;
    data[at + 6] = quad.u0;
    data[at + 7] = quad.v0;
    data[at + 8] = quad.du;
    data[at + 9] = quad.dv;
    sheet[k] = found.atlasIndex;
    rotated[k] = quad.rotated ? 1 : 0;
    alpha[k] = frames[k].alpha ?? 1;
  }
  return {
    interval: 0,
    frames: frames.length,
    data,
    sheet,
    rotated,
    alpha,
  };
}

/**
 * Whether an object has a detail colour, which key 19 lands on if so. In the
 * game one exists only when the object has art that follows it, so both
 * halves are asked for: a default detail channel and a sprite on it. The
 * table carries a default for some objects with no such art (the 1.x
 * decoration spikes 18 and 19, which have no colour frame at all), and could
 * carry a detail sprite on one with no default.
 * [GameObject::createSpriteColor :166652-166680, called for a colour sprite
 *  or colour child only (addColorSprite :171326ff, addCustomColorChild
 *  :166893)]
 */
function hasDetail(record: ObjectRecord): boolean {
  if (record.dc === undefined) return false;
  let known = detailArt.get(record);
  if (known === undefined) {
    const walk = (children: ChildRecord[] | undefined): boolean =>
      (children ?? []).some((c) => (c.f !== undefined && slotOf(record, c.ct) === "D") || walk(c.ch));
    known = slotOf(record, record.ct) === "D" || walk(record.ch);
    detailArt.set(record, known);
  }
  return known;
}
const detailArt = new WeakMap<ObjectRecord, boolean>();

/**
 * The channels an object's base and detail art follow: keys 21 and 22 over
 * the object's defaults, or key 19's channel on the detail colour if it has
 * one and on the base if not. [GameObject::objectFromVector :184334-184378]
 */
export function objectChannels(object: LevelObject, record: ObjectRecord): { base: number; detail: number } {
  const own = levelChannels(object, record);
  // A rod hands its colour to its ball and is left with none: white.
  // [PlayLayer::addObject :90325-90327 (setDefaultMainColorMode clears the
  //  custom colour too, :171218-171232)]
  return ROD_IDS.has(object.id) ? { base: 0, detail: own.detail } : own;
}

function levelChannels(object: LevelObject, record: ObjectRecord): { base: number; detail: number } {
  const base = object.baseColor ?? record.bc ?? 0;
  const detail = object.detailColor ?? record.dc ?? 0;
  if (object.legacyColor === null) return { base, detail };
  return hasDetail(record) ? { base, detail: object.legacyColor } : { base: object.legacyColor, detail };
}

/** The ball's colour: P1, unless the rod's level colour is something other than its default. [PlayLayer::addObject :90323-90324; customSetup 37 :180263-180270] */
function rodBallChannel(object: LevelObject, record: ObjectRecord): number {
  const own = levelChannels(object, record).base;
  return own !== CHANNEL.OBJECT ? own : CHANNEL.P1;
}

/**
 * Which ball the level's rods carry, from a roll 0..1 made once a level
 * load: rod_ball_01 (a disc) a quarter of the time, 02 (a ring) half, 03
 * (a face) a quarter. [PlayLayer::init :107006-107008 (+11824 =
 *  roundf(r * 2) + 1); GameObject::getBallFrame]
 */
export function rodBallFrame(roll: number): string {
  const n = Math.min(3, Math.max(1, Math.round(roll * 2) + 1));
  return `rod_ball_0${n}_001.png`;
}

/**
 * Which channel's blending decides a sprite's in play. P1, P2 and the light
 * background always blend, whatever the table says, and a lighter (1012)
 * sprite blends as its object's base does; the rods never do. A glow or a
 * sprite additive in its own right is additive anyway (Pending.ownAdditive,
 * kept as SpriteMeta.baseAdditive).
 * [GameObject::shouldBlendColor :166462-166495, per object half by
 *  updateBlendMode :168564-168582]
 */
export function blendChannelOf(channel: number, base: number, objectId: number): number {
  if (NO_BLEND_IDS.has(objectId)) return BLEND_NEVER;
  const ch = channel === CHANNEL.LIGHTER ? base : channel;
  if (ch === CHANNEL.P1 || ch === CHANNEL.P2 || ch === CHANNEL.LIGHT_BG) return BLEND_ALWAYS;
  return ch > 0 && ch !== CHANNEL.LIGHTER ? ch : BLEND_NEVER;
}

/** Which colour slot a sprite follows, once the object's swap flag is applied. */
function slotOf(record: ObjectRecord, type: ChildRecord["ct"] | undefined): "B" | "D" | "K" {
  const base = type ?? "B";
  if (base === "K") return "K";
  // `sw` inverts which of the two channels the sprite follows. It is set on 473
  // objects and on every one of them the main sprite is already the detail one,
  // so in practice this turns those back into base. [meas: assets/objects.json]
  if (record.sw) return base === "B" ? "D" : "B";
  return base;
}

/**
 * A sprite with its top corners lowered (Cut), as the pieces the batcher can
 * draw: the full-width rectangle under the lower of the two corners, and the
 * right triangle between that and the cut. The cut crops the texture with
 * the corners, so each piece is a part of the sprite with its own part of the
 * frame and the art is not distorted. Each piece is given as where its
 * corner (0, 0) sits in the sprite's corners, top-left (0, 0) to bottom-right
 * (1, 1), and how far its corners (1, 0) and (0, 1) reach from there. A share
 * below zero would raise the corner past the art and stretch it; it is drawn
 * as none (only 1779, which no official level places).
 * [CCSprite::setTextureCoords :862782-862827, updateTransform :864326-864367]
 */
function cutPieces(cut: Cut): { x: number; y: number; ex: number; ey: number; triangle: boolean }[] {
  const left = Math.min(1, Math.max(0, cut[0]));
  const right = Math.min(1, Math.max(0, cut[1]));
  const low = Math.max(left, right);
  const pieces: { x: number; y: number; ex: number; ey: number; triangle: boolean }[] = [];
  if (low < 1) pieces.push({ x: 0, y: low, ex: 1, ey: 1 - low, triangle: false });
  if (left < right) pieces.push({ x: 0, y: right, ex: 1, ey: left - right, triangle: true });
  else if (right < left) pieces.push({ x: 1, y: left, ex: -1, ey: right - left, triangle: true });
  return pieces;
}

/**
 * One piece of a baked sprite (cutPieces): its half-axes, centre and frame
 * rectangle narrowed to the piece, and the same for its turning copy. The
 * frame corner follows the sprite corner, swapped for a frame the packer
 * turned, as the shader reads it.
 */
function cutPiece(p: Pending, piece: { x: number; y: number; ex: number; ey: number; triangle: boolean }): Pending {
  const sx = 2 * piece.x - 1 + piece.ex;
  const sy = 1 - 2 * piece.y - piece.ey;
  const [tx, ty, tex, tey] = p.rotated ? [piece.y, piece.x, piece.ey, piece.ex] : [piece.x, piece.y, piece.ex, piece.ey];
  let spin: Float32Array | null = null;
  if (p.spin) {
    spin = Float32Array.from(p.spin);
    spin[4] = p.spin[4] + p.spin[0] * sx + p.spin[2] * sy;
    spin[5] = p.spin[5] + p.spin[1] * sx + p.spin[3] * sy;
    spin[0] = p.spin[0] * piece.ex;
    spin[1] = p.spin[1] * piece.ex;
    spin[2] = p.spin[2] * piece.ey;
    spin[3] = p.spin[3] * piece.ey;
  }
  return {
    ...p,
    xa: p.xa * piece.ex,
    xb: p.xb * piece.ex,
    xc: p.xc * piece.ey,
    xd: p.xd * piece.ey,
    px: p.px + p.xa * sx + p.xc * sy,
    py: p.py + p.xb * sx + p.xd * sy,
    u0: p.u0 + tx * p.du,
    v0: p.v0 + ty * p.dv,
    du: tex * p.du,
    dv: tey * p.dv,
    spin,
    shape: piece.triangle ? SHAPE.TRIANGLE : SHAPE.QUAD,
  };
}

/**
 * The colour sprite among a record's sprites (+187): the top-level sprite the
 * game makes the object's colour sprite and hangs on the object at z 100, or
 * −100 when it goes behind. That is its one top-level sprite in the detail
 * slot, or one at ±100 whatever its own slot: the perspective blocks (980,
 * 982-988, 1552, 1554-1560) make an empty frame their colour sprite and hang
 * their *_color frames on it. With several, the one at ±100.
 * [GameObject::addColorSprite :171326ff, addCustomColorChild :166874-166906,
 *  addColorSpriteToSelf :168641-168670; setupCustomSprites :611785-611795 →
 *  addInternalCustomColorChild :166960-166985, which hangs them on +187]
 */
function colourSpriteOf(record: ObjectRecord): ChildRecord | null {
  let found: ChildRecord | null = null;
  for (const c of record.ch ?? []) {
    const atColourPlace = Math.abs(c.z) === 100;
    if (!atColourPlace && slotOf(record, c.ct) !== "D") continue;
    if (!found || (atColourPlace && Math.abs(found.z) !== 100)) found = c;
  }
  return found;
}

/**
 * The channels a colour trigger in the level can turn blending on or off for:
 * the ones some colour trigger leaves blending differently from how the level
 * starts. Every other channel's blending is the same all level, so its
 * objects' batches are too. [the triggers as TriggerRuntime.runColor reads
 *  them; the legacy background trigger's ground, key 14]
 */
export function blendVariableChannels(level: Level): Set<number> {
  const starts = (channel: number): boolean => level.header.colors.get(channel)?.blending ?? false;
  const out = new Set<number>();
  for (const o of level.objects) {
    if (!isColorTrigger(o.id)) continue;
    const channel = colorTriggerChannel(o.id, objectInt(o, 23));
    if (channel <= 0) continue;
    if (colorTriggerBlends(o.id, objectInt(o, 17)) !== starts(channel)) out.add(channel);
    if (o.id === 29 && objectInt(o, 14) !== 0 && starts(CHANNEL.GROUND)) out.add(CHANNEL.GROUND);
  }
  return out;
}

/** A child's anchor, as the push below takes it. */
interface ChildAnchor {
  ax: number;
  ay: number;
  fx: number;
  fy: number;
}

/** Guide icons the game hangs on orbs/portals when the matching option is on (`*_extra*`). */
function isGuideFrame(frame: string | undefined): boolean {
  return frame !== undefined && frame.includes("_extra");
}

function emit(
  object: LevelObject,
  record: ObjectRecord,
  transform: Affine,
  out: Pending[],
  stats: DrawListStats,
  atlas: AtlasSet,
  colors: ColorTable,
  order: number,
  objects: ObjectState,
  anims: AnimState[],
  variable: ReadonlySet<number>,
  rodBall: string,
  entities?: ReadonlyMap<string, AnimEntity>,
  font?: LevelFont | null,
  orbGuide = false,
  portalGuide = true,
): void {
  // What push draws with. A portal's back half and a linked teleport's exit
  // are objects of their own in the game, with batches, a place and a colour
  // of their own; emitPortalExtras swaps these for theirs.
  let placed = transform;
  let ownColour: number | null = null;
  const channels = objectChannels(object, record);
  const mainChannel = channels.base;
  // Black art ("K") follows the main colour in everything but its colour,
  // which stays black: its opacity is the main half's, and so is its blend.
  // (Pending.black)
  const channelFor = (slot: "B" | "D" | "K"): number => ownColour ?? (slot === "D" ? channels.detail : mainChannel);
  // The game settles blending per object half, main and colour sprite
  // (updateBlendMode :168564-168582 → shouldBlendColor :166462-166495), and a
  // half's batch draws everything in it with that blend. A black main sprite
  // blends as its main colour says, whatever its own colour, as the object's
  // main GJSpriteColor is what shouldBlendColor reads; black art hung on a
  // sprite goes with its batch.
  const blendFor = (channelId: number): number => blendChannelOf(channelId, mainChannel, object.id);
  /**
   * What a sprite in `slot` is coloured with: its channel, its hue shift, and
   * whether it is black art. A glow is never black: setObjectColor hands the
   * glow the main colour even where it leaves the object's own sprite black.
   * [setObjectColor :165358-165364]
   */
  const toneOf = (slot: "B" | "D" | "K", glow: boolean): { channelId: number; shift: HsvShift | null; black: boolean } => {
    const black = slot === "K" && !glow && ownColour === null;
    return {
      channelId: channelFor(slot),
      shift: black || ownColour !== null ? null : slot === "D" ? object.detailHsv : object.baseHsv,
      black,
    };
  };
  /** The colour a sprite is baked with: black art's own, or its channel's with its shift. */
  const bakedRgb = (tone: { channelId: number; shift: HsvShift | null; black: boolean }): Rgb => {
    if (tone.black) return BLACK;
    const tinted = tone.channelId === CHANNEL.LIGHTER ? lighterNow() : colors.get(tone.channelId);
    return applyHsv(tinted, tone.shift);
  };
  const blendsNow = (blendChannel: number): boolean =>
    blendChannel === BLEND_ALWAYS || (blendChannel >= 0 && colors.get(blendChannel).blending);
  // The lighter colour as the build sees it: of the main half with its shift.
  // [getActiveColorForMode, the 1012 branch]
  const lighterNow = (): Rgb => lighterColor(applyHsv(colors.get(mainChannel), object.baseHsv));

  // The object's own animation, from the game's table, on a clock of its own.
  // A text object or a beast draws something else, and has none.
  const animation = record.txt || record.ent ? null : objectAnimationFor(object.id, (name) => atlas.has(name));
  let animTiming: AnimTiming | null = null;
  if (animation) {
    animTiming = animTimingFor(object, animation);
    objects.anim[order] = anims.length;
    anims.push({ timing: animTiming, memo: animMemo() });
  }
  // Key 96 hides the object's glow. [objectFromVector :184210-184213 (+876);
  //  GameObject::setVisible :164695-164705]
  const glows = !objectFlag(object, OBJECT_KEY.noGlow);
  const spins = objects.spinSpeed[order] !== 0;
  // 2892/2893 hide the object's own sprite (+471) and animate a tagged copy;
  // the tables still carry both, so the main one is skipped here.
  // [setupCustomSprites :610842-610846; updateSyncedAnimation :620919]
  const hideMain = !!record.dd || isSpin16Animation(object.id);

  /** Frames a sprite plays: rings rebuild to the object's stepped cycle length. */
  const framesOf = (resting: string | undefined, detail: boolean): readonly AnimFrame[] | null => {
    if (!resting || !animation) return null;
    if (isRingAnimation(object.id) && animTiming) {
      if (!resting.startsWith("d_scaleFadeRing_01_")) return null;
      const list = ringChildFrames(resting, animTiming.frames);
      return list.every((a) => atlas.has(a.f)) ? list : null;
    }
    return animation.framesFor(resting, detail);
  };

  // A skeletal entity replaces the object's own art rather than joining it: the
  // still frames in the table are what the object falls back to when the
  // animation is not loaded, not a layer underneath it.
  const entity = record.ent ? entities?.get(record.ent) : undefined;
  const plan = entity ? skeletonFor(entity, object.id) : null;
  const entityColour = plan && entity ? entityColours(object.id, entity) : null;

  // Its batches. The whole animated sprite of a beast takes the main colour,
  // and the limb the game makes its colour sprite the detail colour.
  const mainSlot = plan ? slotOf(record, undefined) : slotOf(record, record.ct);
  const colourSprite = record.txt || plan ? null : colourSpriteOf(record);
  const hasColour =
    colourSprite !== null || (entityColour !== null && (entityColour.detailTags.size > 0 || entityColour.child !== null));
  // A beast's colour limbs take the slot the record's swap gives the detail.
  const colourSlot = plan ? slotOf(record, "D") : "D";
  const mainBlend = blendFor(channelFor(mainSlot));
  const colourBlend = hasColour ? blendFor(channelFor(colourSlot)) : BLEND_NEVER;
  const varies = (channel: number): boolean => channel >= 0 && variable.has(channel);
  const stays = colourSpriteStays(object.id);
  const inFront = colourSpriteInFront(object.id);
  // A colour sprite the object keeps (+552) in front of it (+909) goes where
  // the main half goes whatever it blends, so its blending moves nothing.
  const colourMoves = hasColour && !(stays && inFront);
  const node: NodeInfo = {
    order,
    zl: effectiveZLayer(object.zLayer, record.zl),
    zo: effectiveZOrder(object.zOrder, PORTAL_BACK.has(object.id) ? PORTAL_FRONT_ORDER : record.zo),
    mode: parentMode(object.id),
    hasColour,
    inFront,
    stays,
    mainBlend,
    colourBlend,
    varies: (varies(mainBlend) ? MAIN_BLENDS : 0) | (colourMoves && varies(colourBlend) ? COLOUR_BLENDS : 0),
    startState: (blendsNow(mainBlend) ? MAIN_BLENDS : 0) | (hasColour && blendsNow(colourBlend) ? COLOUR_BLENDS : 0),
  };
  objects.mainBlend[order] = node.mainBlend;
  objects.colourBlend[order] = node.colourBlend;
  objects.varies[order] = node.varies;
  objects.startState[order] = node.startState;
  let current = node;
  /** Each sprite's place in its object's tree, in the order cocos draws them. */
  let rank = 0;
  // A sprite blends as the batch it is in does, and a batch draws all it
  // holds with one blend: the colour sprite's own, unless the object keeps it
  // (+552), when it is in the main half's batch. [addColorSpriteToParent
  //  :169343 (+552 returns); setupLayers, one setBlendFunc(770, 1) or none
  //  per batch]
  const blendOf = (part: number): number =>
    part === PART_GLOW ? BLEND_ALWAYS : part === PART_COLOUR && !current.stays ? current.colourBlend : current.mainBlend;
  // Where the colour sprite hangs on the object when it is there:
  // addColorSpriteToSelf puts it at 100 in front (+909), −100 behind. One
  // the object keeps never goes through it and stays where customSetup put
  // it. [addColorSpriteToSelf :168655-168660]
  const placeZ = (c: ChildRecord): number => (c === colourSprite && !stays ? (inFront ? 100 : -100) : c.z);

  /**
   * One sprite. `local` is where it sits in the object's own space; the
   * object's transform is applied here, so a turning object can keep the two
   * apart. `anchor` is a child's anchor point, baked in once the frame's size
   * is known. Called in draw order: each call is the next place in the
   * object's tree.
   */
  const push = (
    frame: string | undefined,
    slot: "B" | "D" | "K",
    alpha: number,
    additive: boolean,
    local: Affine,
    part: number,
    anim: readonly AnimFrame[] | null = null,
    anchor: ChildAnchor | null = null,
    glow = false,
    cut: Cut | undefined = undefined,
  ): void => {
    if (!frame) return;
    const found = atlas.frame(frame);
    if (!found) {
      stats.missingFrames++;
      return;
    }
    // The anchor is a share of the untrimmed frame: the sprite's centre sits
    // that far back from the child's position, and a texture flip mirrors it
    // in place. [cocos2d CCNode anchorPoint; CCSprite::setFlipX]
    let inner = local;
    if (anchor) {
      const src = frameSourceSize(found.frame);
      inner = compose(local, affine((-anchor.ax * src.w) / atlas.pxPerUnit, (-anchor.ay * src.h) / atlas.pxPerUnit, 0, anchor.fx, anchor.fy));
    }
    const matrix = inner === IDENTITY ? placed : compose(placed, inner);
    const quad = frameQuad(found.atlas, found.frame, atlas.pxPerUnit);
    const centre = apply(matrix, quad.cx, quad.cy);
    const tone = toneOf(slot, glow);
    const channelId = tone.channelId;
    const blendChannel = blendOf(part);
    const channel = colors.get(channelId);
    const shift = tone.shift;
    const final = bakedRgb(tone);
    let spin: Float32Array | null = null;
    if (spins) {
      const c = apply(inner, quad.cx, quad.cy);
      spin = Float32Array.of(
        inner.a * quad.hw,
        inner.b * quad.hw,
        inner.c * quad.hh,
        inner.d * quad.hh,
        c.x,
        c.y,
        placed.a,
        placed.b,
        placed.c,
        placed.d,
        placed.tx,
        placed.ty,
      );
    }
    const book = anim && anim.length > 1 ? anim : null;
    // Anchored children (rings) scale about the child's position; others about
    // the sprite centre.
    const animAbout =
      book && anchor && book.some((a) => (a.scale ?? 1) !== 1 || (a.rot ?? 0) !== 0)
        ? apply(compose(placed, local), 0, 0)
        : null;
    const entry: Pending = {
      node: current,
      part,
      intra: rank++,
      xa: matrix.a * quad.hw,
      xb: matrix.b * quad.hw,
      xc: matrix.c * quad.hh,
      xd: matrix.d * quad.hh,
      px: centre.x,
      py: centre.y,
      u0: quad.u0,
      v0: quad.v0,
      du: quad.du,
      dv: quad.dv,
      r: final.r,
      g: final.g,
      b: final.b,
      a: Math.min(1, Math.max(0, channelOpacityMod(channel.a) * alpha)),
      own: Math.min(1, Math.max(0, alpha)),
      sheet: found.atlasIndex,
      rotated: quad.rotated ? 1 : 0,
      additive: additive || blendsNow(blendChannel) ? 1 : 0,
      ownAdditive: additive ? 1 : 0,
      matrix,
      anim: book,
      animAbout,
      book: null,
      spin,
      object: object.index,
      channel: channelId,
      mainChannel,
      blendChannel,
      shift,
      main: slot === "D" ? 0 : 1,
      glow: glow ? 1 : 0,
      black: tone.black ? 1 : 0,
    };
    // An animated sprite's frames replace its geometry each gather, so a cut
    // would not hold; none of the cut sprites animates.
    if (!cut || entry.anim) {
      out.push(entry);
      return;
    }
    const pieces = cutPieces(cut);
    for (let k = 0; k < pieces.length; k++) {
      const piece = cutPiece(entry, pieces[k]);
      if (k > 0) piece.intra = rank++;
      out.push(piece);
    }
  };

  const objectAlpha = record.a ?? 1;

  // A text object's art is its string. Without a font in hand it draws nothing
  // — the record has no frame to fall back to — so the count is reported.
  if (record.txt) {
    const text = textOf(object);
    if (!text) return;
    if (!font) {
      stats.skippedNoFont++;
      return;
    }
    stats.texts++;
    pushText(text, font, slotOf(record, record.ct), objectAlpha, transform);
    return;
  }

  if (plan && entityColour) {
    stats.skeletons++;
    objects.skel[order] = objects.skeletons.length;
    objects.skeletons.push({ plan, clock: { clip: 0, began: 0, rolls: 0 }, appliedGen: 0 });
    // A beast is black because its main colour defaults to 1010, which key 21
    // overrides like any other object's; its art is not black art, whatever
    // colour type the table gives it. [customSetup setDefaultMainColorMode
    //  (1010) for 918, 919, 1327, 1328, 1584 and 2012, e.g. :177567 (1584),
    //  :179229 (919), traced for every id; setObjectColor colours them]
    const body = slotOf(record, undefined);
    const detail = slotOf(record, "D");
    for (let i = 0; i < plan.slots.length; i++) {
      const limb = plan.slots[i];
      const isColour = entityColour.detailTags.has(limb.tag);
      pushSkeletonSlot(limb, plan.clips[0].interval, plan.frames, isColour ? detail : body, objectAlpha, transform, isColour ? PART_COLOUR : PART_MAIN);
      if (entityColour.child && entityColour.child.tag === limb.tag) {
        const tex = entityColour.child.tex;
        const child: SkeletonSlot = { ...limb, frames: limb.frames.map((f) => (f ? { ...f, tex } : null)) };
        pushSkeletonSlot(child, plan.clips[0].interval, plan.frames, detail, objectAlpha, transform, PART_COLOUR);
      }
    }
    return;
  }

  // `rnd` picks one frame for good when the object is placed: the spike
  // variants (id 9) are the only user, and a row of them looks wrong if they
  // all pick the same one.
  const mainFrame = record.rnd && record.rnd.length > 0 ? randomFrameFor(record.rnd, object.index) : record.f;
  const mainFrames = framesOf(mainFrame, mainSlot === "D");
  // The object's own sprite with everything hung on it, in tree order. A
  // don't-draw main sprite still carries its glow and children. [ObjectRecord.dd]
  // Orb/portal `*_extra*` children are addGuideArt's icons: only with the
  // matching option. [gdp GJBaseGameLayer::addGuideArt :432889; +11164/+11165]
  const rod = ROD_IDS.has(object.id);
  let children = record.ch ?? [];
  if (rod) children = children.filter((c) => !c.f?.startsWith("rod_ball_"));
  const showGuides = record.k === "orb" ? orbGuide : record.k === "portal" ? portalGuide : true;
  if (!showGuides) children = children.filter((c) => !isGuideFrame(c.f));
  tree(children, IDENTITY, objectAlpha, PART_MAIN, () => {
    if (!hideMain) push(mainFrame, mainSlot, objectAlpha, record.bl === 1, IDENTITY, PART_MAIN, mainFrames, null, false, record.cut);
  });
  // The glow goes in its layer's glow batch and always adds rather than covers.
  if (glows) push(record.g, mainSlot, objectAlpha, true, IDENTITY, PART_GLOW, null, null, true);
  emitPortalExtras();
  if (rod) emitRodBall();

  /**
   * The ball PlayLayer::addObject hangs over a rod: an object of its own (id
   * 37) with this level's ball frame, at the rod's top centre and 10 up,
   * carried by the rod's turn and scale to get there but not turned or
   * scaled itself, in the rod's groups. It is in P1 or the rod's own colour
   * and blends as that colour does, on layer 3 at order 10, and pulses with
   * the music from a tenth of its size. [gdp PlayLayer::addObject
   *  :90318-90345; customSetup 37 :180263-180270]
   */
  function emitRodBall(): void {
    const found = record.f ? atlas.frame(record.f) : null;
    if (!found) return;
    const top = frameSourceSize(found.frame).h / atlas.pxPerUnit / 2 + ROD_BALL_RISE;
    const at = apply(transform, 0, top);
    const channel = rodBallChannel(object, record);
    const blend = blendChannelOf(channel, channel, 37);
    current = {
      order,
      zl: ROD_BALL_LAYER,
      zo: ROD_BALL_ORDER,
      mode: parentMode(37),
      hasColour: false,
      inFront: false,
      stays: false,
      mainBlend: blend,
      colourBlend: BLEND_NEVER,
      varies: 0,
      startState: blendsNow(blend) ? MAIN_BLENDS : 0,
    };
    placed = affine(at.x, at.y, 0, 1, 1);
    ownColour = channel;
    const first = out.length;
    push(rodBall, "B", 1, false, IDENTITY, PART_MAIN);
    for (let p = first; p < out.length; p++) out[p].pulse = PULSE_OWN;
    ownColour = null;
    placed = transform;
    current = node;
  }

  /**
   * What PlayLayer::addObject adds beside a portal. Every portal (and the
   * green gravity toggle) gets a back half: an object of its own (id 38) with
   * the portal's `_back_` frame, at the portal's place, turn, flips and
   * scale, in its groups, on layer 4 — GJ_GameSheet02's batch for it sits on
   * top of B1, under the player — at the portal's z order less 100, in no
   * colour of its own. The portal's own default order then becomes 12. A
   * linked teleport (747) first gets its exit, a 749 10 units to the left
   * (scaled and turned with it) and key 54 up, turned the same way and
   * flipped the other, with the portal's order and groups but its own
   * default layer; the exit is a portal too, so it gets a back half of its
   * own. A hidden portal (key 135) gets neither, and its exit is hidden with
   * it — emit never sees a hidden object. The game's portal-guide option adds
   * one to both orders; it is off.
   * [gdp PlayLayer::addObject: the exit :89924-89965 (getTeleportXOff
   *  :310694-310719); the back halves :90062-90250 (LABEL_88, :90064 for key
   *  135; the frame by id; +241 = 4, +908 = 1, +226 = order − 100 + guide,
   *  the portal +226 = 12 + guide, :90137-90179); addGuideArt :89981ff
   *  returns the guide option, off by default]
   */
  function emitPortalExtras(): void {
    const back = PORTAL_BACK.get(object.id);
    if (!back) return;
    const ownOrder = effectiveZOrder(object.zOrder, record.zo);
    const extra = (zl: number, zo: number, mode: number): NodeInfo => ({
      order,
      zl,
      zo,
      mode,
      hasColour: false,
      inFront: false,
      stays: false,
      mainBlend: BLEND_NEVER,
      colourBlend: BLEND_NEVER,
      varies: 0,
      startState: 0,
    });
    ownColour = 0;
    if (object.id === 747) {
      const exit = PORTAL_EXIT;
      const [dx, dy] = linkedExitOffset(object);
      const sx = object.scaleX * (object.flipX ? 1 : -1);
      const sy = object.scaleY;
      placed = affine(object.x + dx, object.y + dy, object.rotation, sx, sy);
      current = extra(exit.zl, effectiveZOrder(object.zOrder, PORTAL_FRONT_ORDER), parentMode(749));
      push(exit.front, "B", objectAlpha, false, IDENTITY, PART_MAIN);
      current = extra(PORTAL_BACK_LAYER, ownOrder - 100, PORTAL_BACK_MODE);
      push(PORTAL_BACK.get(749), "B", objectAlpha, false, IDENTITY, PART_MAIN);
      placed = transform;
    }
    current = extra(PORTAL_BACK_LAYER, ownOrder - 100, PORTAL_BACK_MODE);
    push(back, "B", objectAlpha, false, IDENTITY, PART_MAIN);
    ownColour = null;
    current = node;
  }

  /** A text object's glyphs, each an ordinary sprite on the font's own unit. */
  function pushText(text: string, levelFont: LevelFont, colourSlot: "B" | "D" | "K", alpha: number, matrix: Affine): void {
    const tone = toneOf(colourSlot, false);
    const channelId = tone.channelId;
    const blendChannel = blendOf(PART_MAIN);
    const channel = colors.get(channelId);
    const shift = tone.shift;
    const final = bakedRgb(tone);
    const glyphs = textSprites(text, levelFont.font, levelFont.pxPerUnit);
    for (let i = 0; i < glyphs.length; i++) {
      const glyph = glyphs[i];
      const centre = apply(matrix, glyph.cx, glyph.cy);
      out.push({
        node: current,
        part: PART_MAIN,
        // Glyphs of one string keep their order, so a later letter never draws
        // behind an earlier one where they overlap.
        intra: rank++,
        xa: matrix.a * glyph.hw,
        xb: matrix.b * glyph.hw,
        xc: matrix.c * glyph.hh,
        xd: matrix.d * glyph.hh,
        px: centre.x,
        py: centre.y,
        u0: glyph.u0,
        v0: glyph.v0,
        du: glyph.du,
        dv: glyph.dv,
        r: final.r,
        g: final.g,
        b: final.b,
        a: Math.min(1, Math.max(0, channelOpacityMod(channel.a) * alpha)),
        own: Math.min(1, Math.max(0, alpha)),
        sheet: levelFont.unit,
        rotated: 0,
        additive: record.bl === 1 || blendsNow(blendChannel) ? 1 : 0,
        ownAdditive: record.bl === 1 ? 1 : 0,
        matrix,
        anim: null,
        animAbout: null,
        book: null,
        spin: null,
        object: object.index,
        channel: channelId,
        mainChannel,
        blendChannel,
        shift,
        main: colourSlot === "D" ? 0 : 1,
        glow: 0,
        black: tone.black ? 1 : 0,
      });
    }
  }

  /**
   * One limb of a skeletal entity: a sprite whose transform and frame both come
   * from the animation, baked for every frame of the clip so playing it is the
   * same copy a sprite animation is.
   */
  function pushSkeletonSlot(
    slot: SkeletonSlot,
    interval: number,
    frames: number,
    colourSlot: "B" | "D" | "K",
    alpha: number,
    parent: Affine,
    part: number,
  ): void {
    const data = new Float32Array(frames * 10);
    const sheet = new Uint8Array(frames);
    const rotated = new Uint8Array(frames);
    const frameAlpha = new Float32Array(frames);
    let resting = -1;
    for (let k = 0; k < frames; k++) {
      const piece = slot.frames[k];
      if (!piece) continue;
      const found = atlas.frame(piece.tex);
      if (!found) {
        stats.missingFrames++;
        continue;
      }
      const matrix = compose(parent, affine(piece.x, piece.y, piece.rot, piece.sx, piece.sy));
      const quad = frameQuad(found.atlas, found.frame, atlas.pxPerUnit);
      const centre = apply(matrix, quad.cx, quad.cy);
      const at = k * 10;
      data[at] = matrix.a * quad.hw;
      data[at + 1] = matrix.b * quad.hw;
      data[at + 2] = matrix.c * quad.hh;
      data[at + 3] = matrix.d * quad.hh;
      data[at + 4] = centre.x;
      data[at + 5] = centre.y;
      data[at + 6] = quad.u0;
      data[at + 7] = quad.v0;
      data[at + 8] = quad.du;
      data[at + 9] = quad.dv;
      sheet[k] = found.atlasIndex;
      rotated[k] = quad.rotated ? 1 : 0;
      frameAlpha[k] = 1;
      if (resting < 0) resting = k;
    }
    if (resting < 0) return;
    const book: Flipbook = { interval, frames, data, sheet, rotated, alpha: frameAlpha };
    // The instance the sort and the cull see is the first frame the limb is in;
    // the gather replaces it before either reads the geometry.
    const at = resting * 10;
    const tone = toneOf(colourSlot, false);
    const channelId = tone.channelId;
    const blendChannel = blendOf(part);
    const channel = colors.get(channelId);
    const shift = tone.shift;
    const final = bakedRgb(tone);
    out.push({
      node: current,
      part,
      intra: rank++,
      xa: data[at],
      xb: data[at + 1],
      xc: data[at + 2],
      xd: data[at + 3],
      px: data[at + 4],
      py: data[at + 5],
      u0: data[at + 6],
      v0: data[at + 7],
      du: data[at + 8],
      dv: data[at + 9],
      r: final.r,
      g: final.g,
      b: final.b,
      a: Math.min(1, Math.max(0, channelOpacityMod(channel.a) * alpha)),
      own: Math.min(1, Math.max(0, alpha)),
      sheet: sheet[resting],
      rotated: rotated[resting],
      additive: record.bl === 1 || blendsNow(blendChannel) ? 1 : 0,
      ownAdditive: record.bl === 1 ? 1 : 0,
      matrix: parent,
      anim: null,
      animAbout: null,
      book,
      spin: null,
      object: object.index,
      channel: channelId,
      mainChannel,
      blendChannel,
      shift,
      main: colourSlot === "D" ? 0 : 1,
      glow: 0,
      black: tone.black ? 1 : 0,
    });
  }

  /**
   * A sprite and what hangs on it, in the order a batch draws them: the
   * children with a negative z (lowest first), then the sprite (`self`), then
   * the rest; children with the same z in the order they were added. The
   * colour sprite and everything on it are the colour sprite's part, and it
   * sits at the z its object hangs it at (placeZ).
   * [cocos2d CCSpriteBatchNode::updateAtlasIndex; CCNode::sortAllChildren]
   */
  function tree(children: ChildRecord[], parent: Affine, alpha: number, part: number, self: () => void): void {
    const sorted = children.length > 1 ? [...children].sort((a, b) => placeZ(a) - placeZ(b)) : children;
    for (const c of sorted) if (placeZ(c) < 0) child(c, parent, alpha, part);
    self();
    for (const c of sorted) if (placeZ(c) >= 0) child(c, parent, alpha, part);
  }

  function child(c: ChildRecord, parent: Affine, alpha: number, part: number): void {
    const local = compose(parent, affine(c.dx, c.dy, c.rot ?? 0, c.sx ?? 1, c.sy ?? 1));
    const anchor: ChildAnchor | null =
      c.ax || c.ay || c.fx || c.fy ? { ax: c.ax ?? 0, ay: c.ay ?? 0, fx: c.fx ? -1 : 1, fy: c.fy ? -1 : 1 } : null;
    const childAlpha = alpha * (c.a ?? 1);
    const slot = slotOf(record, c.ct);
    const own = part === PART_MAIN && c === colourSprite ? PART_COLOUR : part;
    // A don't-draw sprite still carries its children. [ChildRecord.dd]
    tree(c.ch ?? [], local, childAlpha, own, () => {
      if (c.dd) return;
      push(c.f, slot, childAlpha, c.bl === 1, local, own, framesOf(c.f, slot === "D"), anchor, false, c.cut);
    });
    if (glows && c.g) push(c.g, slot, childAlpha, true, local, PART_GLOW, null, anchor, true);
  }
}
