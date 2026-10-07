// The trigger engine: what fires, in what order, and what it changes.
//
// Three separate things live here because the game keeps them in one place too,
// and because they have to agree tick for tick:
//
//   * scheduling — which triggers the player has passed or touched, the spawn
//     queue and its delays, and the toggles that decide whether a group exists
//     at all;
//   * group state — the transform a moving group carries, which the collision
//     geometry and the draw list both read;
//   * effects — colours, pulses, the camera, and the visual flags the renderer
//     acts on.
//
// Everything a trigger can change is either in a typed array here or in the
// ColorTable, and both are captured whole by `capture()`. That is what keeps
// the autoplayer's snapshot/restore honest: a trigger that moves a block into
// the player's path has to fail the bot, and it can only do that if restoring a
// branch puts the block back.
//
// Rule citations point into data/ref/trigger-semantics.md, which in turn cites
// line numbers in the 2.206 decompile.

import type { HsvShift, Level, LevelHeader } from "../level/types";
import { K_SLOPE, K_SOLID, type ObjectSet } from "../physics/collision";
import { COLLISION_SECTION_SCALE, GAME_GROUND_Y, maxGameplayYFor, usesYSections } from "../physics/constants";
import { OBJECT_KEY, objectFlag, parseHsv } from "../level/decode";
import {
  GAMEPLAY_OFFSET_X,
  LEVEL_END_MARGIN,
  LEVEL_START_LEFT,
  LEVEL_TOP_MARGIN,
  levelEndStop,
  newStaticCameraAxis,
  VIEW_FLOOR,
  VIEW_UNITS_HIGH,
  type StaticCameraAxis,
} from "../render/camera";
import { CHANNEL, ColorTable, type ColorSnapshot, type PulseAction, type Rgb } from "../render/colors";
import { animateSwitchesClip } from "../render/anim";
import { wrapDegrees } from "../engine/math";
import { ENTER, ENTER_TRIGGER_IDS, enterCode } from "../render/enterEffects";
import { type Command, commandProgress, newCommand, stepCommand } from "./commands";
import { Lcg } from "./rng";
import {
  applyShaderTrigger,
  carriedShaderState,
  cloneShaderState,
  createShaderState,
  effectiveZOrder,
  SHADER_TRIGGER_IDS,
  stepShaderState,
  type ShaderState,
} from "./shaderState";
import { type CameraTween, cameraTweenDone, stepCameraTween } from "./easing";
import {
  AREA_EDITABLE,
  AREA_FIELDS,
  AREA_UNSET,
  areaEase,
  areaRandom,
  areaRate,
  areaValue,
  type AreaRandom,
  variance,
} from "./area";
import {
  AdvancedFollowSystem,
  cloneAdvFollow,
  type AdvFollowHost,
  type AdvFollowSnapshot,
} from "./advancedFollow";
import {
  applyPersistentTrigger,
  transferPersistent,
  persistentSpecOf,
  type PersistentCarry,
} from "./persistent";
import { uiKeysOf, uiOffsetFromCentre, type UiAnchor } from "./uiLayout";
import { flag, hsvOf, idList, int, isSpawnableTrigger, num, type TriggerIndex, type TriggerSpec } from "./spec";
import {
  buildKeyframePath,
  KEYFRAME_OBJECT_ID,
  KEYFRAME_TRIGGER_ID,
  keyframeAnimId,
  keyframeMods,
  keyframePose,
  type KeyframePose,
  readKeyframe,
} from "./keyframes";

/** 1x scroll speed, which is what an ordered spawn staggers by. [gdp :421771] */
export const SPAWN_SPEED = 311.580109;
/** The same speed as the float a platformer's pass-by point moves at. [gdp LevelTools::posForTimeInternal :122165-122166, 122342] */
const PLATFORMER_TRIGGER_SPEED = Math.fround(SPAWN_SPEED);

/** How an End trigger ends the level: see TriggerRuntime.activateEndTrigger. */
export interface LevelEnd {
  /** Where the players are flown, in the port's frame. */
  x: number;
  y: number;
  /** Key 487: levelComplete at once rather than after the one-second flight. */
  instant: boolean;
  /** Not key 460: the ghost trail and the end circles play. */
  effects: boolean;
  /** Not key 461: the end sound (endStart_02.ogg) plays. [gdp PlayLayer::showCompleteEffect :88846-88870] */
  sound: boolean;
}
/** A spawn chain may not re-enter the same group inside one tick. [gdp :443163-443230] */
const MAX_SPAWN_DEPTH = 32;
/**
 * Item, timer and counter ids run 0..9999; anything outside is clamped onto
 * the nearest end before it is read or written.
 * [gdp GJEffectManager::countForItem :474905-474925, updateCountForItem
 *  :487384-487397, addCountToItem :487546-487563, timeForItem :477546-477560]
 */
const MAX_ITEM_ID = 9999;
/** A timer holds at most this much either way. [gdp GJEffectManager::updateTimer :486873-486895] */
const MAX_TIMER_VALUE = 9999999;
/**
 * The player's y is kept for the last two seconds, one slot every hundredth,
 * for a Follow Player Y trigger's delay. [gdp PlayerObject::updateSpecial
 * :142088-142110, getOldPosition :142151-142165]
 */
const Y_HISTORY_SLOTS = 200;
const Y_HISTORY_STEP = 0.01;

/**
 * What a Rotate Gameplay trigger (id 2900) asks of the players.
 *
 * The editor does not let anyone type keys 166 and 167. It works them out from
 * how the trigger itself is turned and flipped, so a level only ever carries
 * the eight combinations that make sense: `orientation` 2 is upright, 1 is
 * upright with gravity flipped, 3 is a quarter turn and 4 a quarter turn with
 * gravity flipped; `direction` 4 is right, 3 left, 1 up and 2 down, and only
 * left and down reverse the player.
 * [gdp RotateGameplayGameObject::customObjectSetup :301401-301468 for the keys,
 *  GJBaseGameLayer::rotateGameplay :442808-442862 for how they are used,
 *  RotateGameplayGameObject::updateGameplayRotation :313495-313546 for 166/167]
 */
export interface GameplayRotation {
  /** Key 166. */
  orientation: number;
  /** Key 167. */
  direction: number;
  /** Key 169: replace the velocity the turn hands over. */
  editVelocity: boolean;
  /** Keys 582 and 583: the two components, as values or as multipliers. */
  velocityX: number;
  velocityY: number;
  /** Key 584: `velocityX/Y` are the values rather than multipliers. */
  overrideVelocity: boolean;
  /** Key 172: switch the channel and leave the players alone. */
  channelOnly: boolean;
  /**
   * Key 585, "Dont Slide": a turn that hands the velocity over takes the
   * accelerating flag straight back, so a flying player is held to its caps
   * again from the next tick. [PlayerObject::rotateGameplay :152534-152535]
   */
  dontSlide: boolean;
}

function gameplayRotationOf(spec: TriggerSpec): GameplayRotation {
  return {
    orientation: int(spec, 166),
    direction: int(spec, 167),
    editVelocity: flag(spec, 169),
    velocityX: num(spec, 582),
    velocityY: num(spec, 583),
    overrideVelocity: flag(spec, 584),
    channelOnly: flag(spec, 172),
    dontSlide: flag(spec, 585),
  };
}

/**
 * The channel a colour trigger changes when key 23 does not name one above 1.
 * Every object starts aimed at channel 1, so a Color Trigger (899) without
 * key 23 recolours channel 1; the older ids are given theirs as they are made.
 * The 1.x Line trigger (104) is made as a 915.
 * [GameObject::GameObject :165584 (+880 = 1); EffectGameObject::customSetup
 *  :302332-302449 (29, 30, 105, 744, 900 → 1009, 915 → 1002); key 23 read
 *  only above 1, customObjectSetup :299793-299800; objectFromVector
 *  :183928-183930 (104 made as 915)]
 */
const COLOR_TRIGGER_CHANNEL: Record<number, number> = {
  29: CHANNEL.BG,
  30: CHANNEL.GROUND,
  104: CHANNEL.LINE,
  105: CHANNEL.OBJECT,
  744: CHANNEL.THREE_D,
  899: 1,
  900: CHANNEL.GROUND_2,
  915: CHANNEL.LINE,
};
/**
 * The 1.x channel triggers, made as 899s and pointed at their channel after
 * key 23 has been read, so key 23 does nothing on them.
 * [objectFromVector :183934-183945 (made as 899), :184244-184275 (+880)]
 */
const FIXED_COLOR_CHANNEL: Record<number, number> = { 221: 1, 717: 2, 718: 3, 743: 4 };
/**
 * These four never blend and never fade their opacity: customObjectSetup
 * clears both after reading keys 17, 35 and 36.
 * [EffectGameObject::customObjectSetup :299835-299847]
 */
const OPAQUE_LEGACY = new Set([29, 30, 105, 900]);

const COLOR_TRIGGERS = new Set([29, 30, 104, 105, 221, 717, 718, 743, 744, 899, 900, 915]);

/** Whether an id is one of the colour triggers. */
export function isColorTrigger(id: number): boolean {
  return COLOR_TRIGGERS.has(id);
}

/** The channel a colour trigger recolours, from its id and key 23; 0 for none. */
export function colorTriggerChannel(id: number, key23: number): number {
  return FIXED_COLOR_CHANNEL[id] ?? (key23 > 1 ? key23 : (COLOR_TRIGGER_CHANNEL[id] ?? 0));
}

/**
 * Whether a colour trigger leaves its channel blending, from its id and key
 * 17. A 1.x Line trigger is additive whatever key 17 says; the four opaque
 * ones never are. [gdp objectFromVector :184267-184270, after key 17 at
 *  :299786-299789; EffectGameObject::customObjectSetup :299835-299847]
 */
export function colorTriggerBlends(id: number, key17: number): boolean {
  return OPAQUE_LEGACY.has(id) ? false : id === 104 || key17 !== 0;
}

/** Six floats of affine per group: a, b, c, d, tx, ty. */
const M = 6;
/** A trigger has no art and no hitbox; the game treats it as one grid square. */
const TOUCH_HALF = 15;
/** The collision block object, and its half-size before the object's own scale. */
const COLLISION_BLOCK_ID = 1816;
const COLLISION_BLOCK_HALF = 15;

/** One question a Collision trigger asks: two block ids, or a block and a player. */
interface CollisionPair {
  a: number;
  b: number;
  player: 0 | 1 | 2;
}

/**
 * A spawn remap: group ids a spawned trigger should read as something else.
 *
 * This is what makes one copy of a mechanism serve a dozen places in a level.
 * A Spawn trigger can carry a list of (original, replacement) pairs, and every
 * trigger it fires reads its group ids through them — so the same five triggers
 * can drive group 100 in one section and group 200 in the next without being
 * duplicated. Chains compose: a remapped Spawn trigger merges its own pairs
 * over the ones it inherited, and the newer pair wins.
 * [gdp SpawnTriggerGameObject::updateRemapKeys :325395-325520, applied in
 *  GJBaseGameLayer::spawnObject :456065-456085; key 442 is a flat list of pairs
 *  — Geode 2.2074 bindings, gd::vector<ChanceObject> m_remapObjects]
 */
export type Remap = ReadonlyMap<number, number> | null;

/** Reads key 442's flat `a.b.c.d` list as the pairs (a→b), (c→d). */
export function ownRemap(spec: TriggerSpec): Remap {
  const flat = idList(spec, 442);
  if (flat.length < 2) return null;
  const out = new Map<number, number>();
  // A later pair for the same original wins, which is the game's own rule.
  for (let i = 0; i + 1 < flat.length; i += 2) out.set(flat[i], flat[i + 1]);
  return out.size > 0 ? out : null;
}

/** `own` layered over `inherited`, with `own` winning where they disagree. */
export function mergeRemap(inherited: Remap, own: Remap): Remap {
  if (!own) return inherited;
  if (!inherited) return own;
  const out = new Map(inherited);
  for (const [from, to] of own) out.set(from, to);
  return out;
}

/** A chain as flat pairs, which is what a queued spawn stores and a snapshot copies. */
function flatten(remap: Remap): readonly number[] {
  if (!remap) return [];
  const out: number[] = [];
  for (const [from, to] of remap) out.push(from, to);
  return out;
}

function unflatten(flat: readonly number[]): Remap {
  if (flat.length < 2) return null;
  const out = new Map<number, number>();
  for (let i = 0; i + 1 < flat.length; i += 2) out.set(flat[i], flat[i + 1]);
  return out;
}

/** A small stable number for a chain, so the spawn guard can tell two apart. */
function remapKey(remap: Remap): number {
  if (!remap) return 0;
  let h = 0x811c9dc5;
  for (const [from, to] of remap) {
    h = Math.imul(h ^ from, 0x01000193);
    h = Math.imul(h ^ to, 0x01000193);
  }
  return h >>> 0;
}

export interface TriggerEvent {
  tick: number;
  kind: "sfx" | "sfxEdit" | "song" | "songEdit" | "shader" | "ui" | "particle";
  id: number;
  /**
   * An audio trigger's object index: the sound reads its settings from the
   * level object, as the game reads them from the trigger it was handed.
   * [gdp EffectGameObject::triggerObject :314935-314937, 314972-314996]
   */
  object?: number;
  /**
   * The music clock (+800) when an audio trigger fired, which a checkpoint
   * keeps with the rest. [gdp activatedAudioTrigger :448038-448043]
   */
  at?: number;
  /**
   * A Spawn Particle trigger's particle group and the object its key 71 group
   * places them at (-1 for none), both read through the remap it ran with.
   */
  group?: number;
  anchor?: number;
}

/** The trigger events that are sound: Song, Edit Song, SFX and Edit SFX. */
export const AUDIO_EVENT_KINDS: ReadonlySet<TriggerEvent["kind"]> = new Set(["song", "songEdit", "sfx", "sfxEdit"]);

/** What the renderer needs that is not a colour or a transform. */
export interface VisualState {
  /** Background and ground art indices, which a Change Background trigger swaps. */
  background: number;
  ground: number;
  middleground: number;
  /** Camera shake, in units; the renderer offsets by a wobble of this size. */
  shakeStrength: number;
  shakeInterval: number;
  shakeRemaining: number;
  /**
   * The Ghost Trail on player 1, which the Enable and Disable Ghost Trail
   * triggers (32 and 33) start and stop: copies of the icon fading behind
   * the player (render/ghostTrail.ts), not a streak. Player 2's is
   * `ghostTrail2`, set only while a dual is on — a trail turned on before
   * the dual starts gives player 2 none. [gdp trigger dispatch
   *  :315129-315140 → PlayLayer::toggleGhostEffect :92269-92276]
   */
  ghostTrail: boolean;
  /** Player 2's Ghost Trail; only written while a dual is on. */
  ghostTrail2: boolean;
  /** Whether the player is drawn at all. */
  hidePlayer: boolean;
  /**
   * BG Effect Off/On (1819/1818): hides the player's trail/dust particle system.
   * [gdp PlayLayer::toggleBGEffectVisibility :92292-92303]
   */
  bgEffectHidden: boolean;
  /**
   * The screen effects: one value per parameter, eased by the shader
   * triggers, and the draw layers they reach.
   */
  shader: ShaderState;
  /** The Gradient triggers' layers, by key 209, oldest first (render/gradients.ts draws them). */
  gradients: GradientState[];
  /** What the Options trigger has switched on or off. */
  options: LevelOptions;
  /**
   * How many Animate triggers have reached each object that waits for one
   * (key 123), by object index. Replaced, never changed in place, so a
   * snapshot can share it. The particle field starts an emitter again when
   * its count goes up.
   */
  animations: ReadonlyMap<number, number>;
  /**
   * The level time each of those objects' animation started from frame 1
   * after the last Animate trigger to reach it: the first step that ended
   * with the object active (TriggerRuntime.objectActive), NaN while it waits
   * for that. Replaced like `animations`. [EnhancedGameObject::triggerAnimation
   *  :620430-620445 (+1164 cleared); updateSyncedAnimation sets it to minus
   *  the level time on its next call :620687-620690, which only
   *  PlayLayer::updateVisibility makes, for an active object :95979-95983]
   */
  animationStarts: ReadonlyMap<number, number>;
  /**
   * The latest Animate trigger's key 76 (animation id) for each beast it
   * reached, with a generation that bumps each fire so the renderer can
   * switch the clip once. Replaced like `animations`. [playAnimationCommand
   *  :422977-423004 → AnimatedGameObject::playAnimation :307645-307681]
   */
  skeletonAnims: ReadonlyMap<number, { id: number; gen: number }>;
  /**
   * The enter effect in force on each of the 101 enter channels, coming in and
   * going out, as render/enterEffects.ts ENTER codes. Replaced, never changed
   * in place. [GJBaseGameLayer::updateActiveEnterEffect :467525-467625]
   */
  enter: EnterTables;
  /**
   * Custom enter instances (3017-3021) per enter channel, coming in and going
   * out. Replaced like `enter`. [gdp addCustomEnterEffect :467370-467508]
   */
  customEnterIn: ReadonlyMap<number, readonly CustomEnterEffect[]>;
  customEnterOut: ReadonlyMap<number, readonly CustomEnterEffect[]>;
}

/** The two enter-effect tables, by enter channel 0-100. */
export interface EnterTables {
  readonly in: Uint8Array;
  readonly out: Uint8Array;
}

/** Every channel on the default, the fade: what resetActiveEnterEffects leaves. [:448610-448625] */
function defaultEnterTables(): EnterTables {
  return { in: new Uint8Array(101).fill(ENTER.fade), out: new Uint8Array(101).fill(ENTER.fade) };
}

/**
 * The switches the Options trigger flips. Each is a tri-state in the game — on,
 * off, or "leave whatever it was" — which the level writes as 1, -1 or nothing
 * at all, so these are booleans with a separate "never touched" default rather
 * than plain flags.
 * [gdp GameOptionsTrigger's property list, cross-checked against
 *  flowvix's gd-info-explorer and the Geode 2.2074 bindings; the two agree on
 *  all fourteen keys]
 */
export interface LevelOptions {
  streakAdditive: boolean;
  unlinkDualGravity: boolean;
  hideGround: boolean;
  hidePlayer1: boolean;
  hidePlayer2: boolean;
  hideMiddleground: boolean;
  disableControlsPlayer1: boolean;
  disableControlsPlayer2: boolean;
  hideAttempts: boolean;
  /** Seconds; only meaningful when the level said to edit it. */
  respawnTime: number;
  editRespawnTime: boolean;
  audioOnDeath: boolean;
  noDeathSfx: boolean;
  /**
   * Both players' +2072 (see PlayerWorld.boostSlide): !kA45 at the start,
   * then key 593. A checkpoint keeps it, as the snapshot keeps this.
   */
  boostSlide: boolean;
}

function defaultOptions(header: LevelHeader): LevelOptions {
  return {
    // The layer's streak blend flag, which every reset sets back to additive;
    // key 159 = -1 makes it normal. The streaks follow it only when it
    // changes, which render/scene.ts tracks. [gdp resetLevelVariables
    //  :463029 → togglePlayerStreakBlend(1) :429735-429746;
    //  processOptionsTrigger :429820-429822]
    streakAdditive: true,
    unlinkDualGravity: false,
    hideGround: false,
    hidePlayer1: false,
    hidePlayer2: false,
    hideMiddleground: false,
    disableControlsPlayer1: false,
    disableControlsPlayer2: false,
    hideAttempts: false,
    respawnTime: 1,
    editRespawnTime: false,
    // The game's +1038 starts at zero: a death stops the sound unless a level
    // asks otherwise. [gdp PlayLayer::destroyPlayer :93283-93292]
    audioOnDeath: false,
    noDeathSfx: false,
    // +2072 is !kA45 at every reset. [gdp resetPlayer :425077-425078]
    boostSlide: !header.decreaseBoostSlide,
  };
}

const NO_GROUPS: ReadonlySet<number> = new Set();

/** Level key to the option it sets. Everything here is tri-state but 574. */
const OPTION_KEYS: readonly [number, keyof LevelOptions][] = [
  [159, "streakAdditive"],
  [160, "unlinkDualGravity"],
  [161, "hideGround"],
  [162, "hidePlayer1"],
  [163, "hidePlayer2"],
  [195, "hideMiddleground"],
  [165, "disableControlsPlayer1"],
  [199, "disableControlsPlayer2"],
  [532, "hideAttempts"],
  [573, "editRespawnTime"],
  [575, "audioOnDeath"],
  [576, "noDeathSfx"],
  [593, "boostSlide"],
];

/**
 * One gradient layer, as the layer keeps it by its id: the Gradient trigger
 * that last set it, whose position, turn, colours and group opacity the
 * layer reads again every frame. [gdp GradientTriggerObject::customObjectSetup
 *  :300278-300349; GJBaseGameLayer::triggerGradientCommand :436326-436500;
 *  updateGradientLayers :423485-424305]
 */
export interface GradientState {
  /** Key 209, at most 999. */
  id: number;
  /** The trigger object that set it. */
  object: number;
  /** Key 202: the draw layer, numbered as the shader range is (1 BG to 15 Max), at least 1. */
  layer: number;
  /**
   * Key 25 as getObjectZOrder reads it: with the layer's max z, held to ±5,
   * it is where the gradient sits among the object layer's children.
   * [gdp triggerGradientCommand :436467-436474]
   */
  zOrder: number;
  /** Key 174: 0 normal, 1 additive, 2 the multiplying one, 3 the inverting one. */
  blend: number;
  /** Key 207: the four groups are the quad's corners rather than its sides. */
  vertexMode: boolean;
  /**
   * Keys 203 to 206. As sides: the top's y, the bottom's y, the left's x and
   * the right's x, each from its group's main object; as corners: the bottom
   * left, bottom right, top left and top right. 0 for none.
   */
  groups: readonly [number, number, number, number];
  /** Keys 21 and 22: the channels the start and the end of the gradient take. */
  start: number;
  end: number;
}

export interface TriggerOptions {
  /** Colours, pulses, the shake and shaders; the camera always runs. The autoplayer turns them off. */
  visuals?: boolean;
  /** The attempt's random seed. The game stores this in its replay strings too. */
  seed?: number;
  player1?: Rgb;
  player2?: Rgb;
  /** The attempt number an Item Compare on attempts reads; 1 is the first. */
  attempt?: number;
  /** kA40 "Enable 2.2 Changes", including where the game forces it on: Dash and its own platformer levels. */
  changes22?: boolean;
  /**
   * The previous attempt's screen effects, for a restart from the start. The
   * game resets the one layer it has rather than making a new one, and the
   * values the reset leaves alone carry into the next attempt; they are
   * copied, then reset, as resetShaderState says.
   * [gdp resetLevelVariables :462991-462996 → ShaderLayer::resetAllShaders]
   */
  shader?: ShaderState;
  /**
   * The level's top (maxGameplayYFor), when the caller has already worked it
   * out: the sim has, for its own out-of-bounds test, which reads the same
   * value. [gdp updateMaxGameplayY :430608-430651]
   */
  levelTop?: number;
  /**
   * The run starts from a start position, or from a debug jump, which stands
   * in for one: then the view has no left stop at x 15 unless the level asks
   * for it with kA23. [gdp updateCamera :449613-449619; +10956 set by
   * PlayLayer::addObject :90313-90314]
   */
  fromStartPosition?: boolean;
  /**
   * Persistent item/timer values from the previous attempt of this visit.
   * [gdp GJEffectManager::transferPersistentItems]
   */
  persistent?: PersistentCarry;
}

interface SpawnAction {
  group: number;
  /** An ordered spawn staggers single objects, not whole groups; -1 otherwise. */
  object: number;
  /** Seconds left before it fires. */
  remaining: number;
  /** Where in the chain it came from, for the re-entrancy guard. */
  spawner: number;
  /** Spawn the group's members staggered by their x rather than all at once. */
  ordered: boolean;
  baseDelay: number;
  /** The remap chain in force when this was queued, as flat pairs. */
  remap: readonly number[];
  /** Paused by a Stop trigger: its clock holds. */
  paused?: boolean;
}

/**
 * A Count trigger (1611) that has been activated and is waiting for its item
 * to reach its number. It fires nothing when it is armed: it fires the first
 * time a change to the item reaches or crosses the number, from either side,
 * and is dropped then unless it is multi-activate.
 * [gdp GJEffectManager::runCountTrigger :487736-487880 (the listener, holding
 *  the count as it stood), updateCountForItem :487384-487525 (the test);
 *  CountTriggerGameObject::customObjectSetup :300855-300877 for the keys]
 */
interface CountListener {
  /** Key 80 as the trigger holds it; an id outside 0..9999 never matches a change. */
  item: number;
  /** Key 77. */
  target: number;
  /** The item's count the last time this listener saw it change. */
  prev: number;
  /** Key 51, already read through the remap in force when it was armed. */
  group: number;
  /** Key 56: switch the group on and spawn it, rather than switch it off. */
  activate: boolean;
  /** Key 104: stays armed after firing. */
  multi: boolean;
  /** The Count trigger itself, for the spawn guard and for Stop. */
  spawner: number;
  /** The Count trigger's control id, for Stop with key 535. */
  controlId: number;
  /** Paused by a Stop trigger: it ignores item changes until resumed. */
  paused: boolean;
  /** The remap chain in force when it was armed, as flat pairs. */
  remap: readonly number[];
}

/**
 * How a timer runs, beside its value (TimerItem): a Time trigger (3614) sets
 * it all, a Time Control (3617) only `running`. A timer an Item Edit makes
 * stands still at a speed of 1. [gdp GJEffectManager::startTimer
 *  :486742-486857; updateTimer :486903-486908]
 */
interface TimerRun {
  /** Item +16: counting (key 471 unset, or a resume). */
  running: boolean;
  /** Key 470: what each second of game time adds. */
  speed: number;
  /** Key 473, and key 474: stop there, set to it, and spawn `group`. */
  target: number;
  stopAtTarget: boolean;
  /** Key 469: count real time through a time warp. */
  ignoreWarp: boolean;
  /** Key 51, read through the remap in force when the Time trigger fired. */
  group: number;
  spawner: number;
  /** The Time trigger's control id, for Stop with key 535. */
  controlId: number;
  /** Paused by a Stop trigger: its clock holds until resumed. */
  paused: boolean;
  remap: readonly number[];
}

/**
 * A Time Event (3615) watching a timer cross key 473 the way its speed
 * runs. `last` starts at 0, not at the timer's value, so a timer already
 * past the mark fires it on the next step. [gdp GJEffectManager::
 * runTimerTrigger :488084-488173 (+4 zeroed); updateTimers :482766-482819]
 */
interface TimerWatch {
  timer: number;
  target: number;
  group: number;
  /** Key 475: stays after firing. */
  multi: boolean;
  last: number;
  spawner: number;
  remap: readonly number[];
}

const IDLE_TIMER: TimerRun = {
  running: false,
  speed: 1,
  target: 0,
  stopAtTarget: false,
  ignoreWarp: false,
  group: 0,
  spawner: 0,
  controlId: 0,
  paused: false,
  remap: [],
};

/**
 * The game events the sim raises, by the game's numbers.
 * [gdp GJBaseGameLayer::gameEventToString :428543ff: 62 and 63 :428739-428744,
 *  69-74 :428760-428777]
 */
export const EVENT_USER_COIN = 62;
export const EVENT_PICKUP_ITEM = 63;
export const EVENT_JUMP_PUSH = 69;
export const EVENT_JUMP_RELEASE = 70;
export const EVENT_LEFT_PUSH = 71;
export const EVENT_LEFT_RELEASE = 72;
export const EVENT_RIGHT_PUSH = 73;
export const EVENT_RIGHT_RELEASE = 74;

/**
 * An Event trigger (3604) listening for one game event: when the game raises
 * it with the same key, the group spawns with the remap in force when the
 * trigger fired. One per event in the trigger's list, in the order they came.
 * [gdp GJBaseGameLayer::activateEventTrigger :464167-464273 (an
 *  EventTriggerInstance: the group, the trigger, the remap)]
 */
interface EventListener {
  /** The game event, one of key 430's list. */
  event: number;
  /** getEventKey of keys 447 and 525: 525 + 10000 × 447. [:428499-428502] */
  key: number;
  /** Key 51, already read through the remap in force when it was armed. */
  group: number;
  /** The Event trigger itself, for the spawn guard. */
  spawner: number;
  /** The remap chain in force when it was armed, as flat pairs. */
  remap: readonly number[];
}

/** An armed Touch trigger (1595): see TriggerRuntime.armTouch. [gdp TouchToggleAction, 44 bytes] */
interface TouchAction {
  /** Key 51, already read through the remap in force when it was armed. */
  group: number;
  /** Key 81: follows the button while it is held. */
  hold: boolean;
  /** Key 82: 0 switches the group over, 1 on, 2 off. */
  mode: number;
  /** Key 198: 0 either player, 1 player 1, 2 player 2. */
  control: number;
  /** Key 89: answers only player 2's side. */
  dual: boolean;
  /** The Touch trigger itself, which a Stop trigger names it by and the spawn guard reads. */
  trigger: number;
  controlId: number;
  /** Paused by a Stop trigger (mode 1) until one resumes it (mode 2). */
  paused: boolean;
  /** The remap chain in force when it was armed, as flat pairs. */
  remap: readonly number[];
}

/** The two layer switches a portal or a Camera Mode trigger sets. [gdp updateCameraMode :451188-451232] */
export interface CameraModeRequest {
  /** Key 111: no corridor, and the camera follows freely. */
  free: boolean;
  /** Key 370: the corridor floor skips the 30-unit snap. */
  noSnap: boolean;
}

/**
 * What Gravity (2066), Player Control (1932) and Reverse (1917) ask the sim to
 * do to the players. Taken within the step or the level spawn that fired them.
 * [gdp reverseDirection :416188-416196; activatePlayerControlTrigger
 *  :421196-421248; triggerGravityChange :422792-422818]
 */
export type PlayerRequest =
  | { kind: "reverse" }
  | { kind: "gravity"; value: number; p1: boolean; p2: boolean }
  | {
      kind: "control";
      p1: boolean;
      p2: boolean;
      jump: boolean;
      move: boolean;
      rotation: boolean;
      slide: boolean;
    };

interface CameraState {
  /**
   * The live zoom (float 82) and its tween (0xE). Each of the trigger tweens
   * here carries the trigger that started it and its control id, so a Stop
   * trigger can reach it (runStop).
   */
  zoom: number;
  zoomTween: CameraTween | null;
  /** The live camera offset (floats 84/85) and its tweens (0xF/0x10). */
  offsetX: number;
  offsetY: number;
  offsetXTween: CameraTween | null;
  offsetYTween: CameraTween | null;
  /** The live turn (float 177), where it is heading (178), and the tween between them (0x11). */
  rotation: number;
  rotationTarget: number;
  rotationTween: CameraTween | null;
  /** A Static Camera holds an axis on its own; see StaticCameraAxis. */
  staticX: StaticCameraAxis;
  staticY: StaticCameraAxis;
  /** Group ids that limit the view; 0 on a side means no limit there. */
  edgeLeft: number;
  edgeRight: number;
  edgeTop: number;
  edgeBottom: number;
  /**
   * The edge groups resolved to world coordinates, or null on a side with no
   * limit. The trigger only ever stores a group id; the position that group's
   * object happens to be at is what the camera actually clamps to, and that
   * object can itself be moving.
   * [gdp getCameraEdgeValue :429937-429985 and the limit arithmetic in
   *  updateCamera :449586-449601]
   */
  limitLeft: number | null;
  limitRight: number | null;
  limitTop: number | null;
  limitBottom: number | null;
  /**
   * The level's top (float 2864, less the port's 90): 2790 in the game's
   * units, or 390 over the highest object, and at least 1590, in a level with
   * y sections. The view stays 150 under it. [gdp updateMaxGameplayY
   * :430608-430651]
   */
  levelTop: number;
  /**
   * Where a classic level's end portal stands (float 2736): 340 past its
   * furthest object, before the floor a screen's width puts under it
   * (levelEndStop). The view's right edge stops there. Null in a platformer,
   * which has no end portal. [gdp PlayLayer::createObjectsFromSetupFinished
   * :102160-102177; updateCamera :449604-449612]
   */
  levelEnd: number | null;
  /** Counts the Rotate Gameplay triggers whose key 368 snaps the camera's gameplay offset. [gdp rotateGameplay :442856-442860] */
  leadSnap: number;
  /**
   * How far the player is kept behind the view's centre along the way it
   * travels (+580 / +588), and whether that distance is already in world
   * units rather than design units over the zoom (+584 / +592). Defaults
   * 75 and false; the Gameplay Offset trigger (2901) sets them.
   * [gdp updateGameplayOffsetX/Y :430003-430047; updateCamera :449670-449689]
   */
  gameplayOffsetX: number;
  gameplayOffsetY: number;
  gameplayOffsetXRaw: boolean;
  gameplayOffsetYRaw: boolean;
  /**
   * How far the middleground is moved up (+604), and its tween (0x14): the
   * MG trigger (2999) eases it to its key 29. Stepped with the camera's.
   * [gdp GJBaseGameLayer::updateMGOffsetY :449303-449321]
   */
  mgOffsetY: number;
  mgOffsetTween: CameraTween | null;
  /**
   * The background's and middleground's share of the camera's move (+692,
   * +696; +700, +704): set by the BG Speed (3606) and MG Speed (3612)
   * triggers' keys 143 and 144, back to 0.1 both ways and 0.3 across and 0.5
   * up for a value past 999, and every run starts at those.
   * [gdp GJBaseGameLayer::updateBGArtSpeed :430921-430942; updateMGArtSpeed
   *  :430959-430972; resetLevelVariables :462922-462923]
   */
  bgSpeedX: number;
  bgSpeedY: number;
  mgSpeedX: number;
  mgSpeedY: number;
  /**
   * Camera Mode keys 113 and 114, when its key 112 says to edit them (a portal
   * can carry them too): the follow's easing, clamped 1..40, and the padding,
   * clamped 0..1. The camera's free follow reads them (render/camera.ts).
   * [gdp GJBaseGameLayer::updateCameraMode :451201-451228; defaults in
   *  resetCamera :451335-451336]
   */
  followDivisor: number;
  padding: number;
  /**
   * The level's left stop (LEVEL_START_LEFT), or null when the run has none:
   * kA24 takes it away, and a run from a start position has it only with
   * kA23. Fixed for the run. [gdp updateCamera :449613-449619]
   */
  minLeft: number | null;
  /** kA22, under which the camera eases into every limit. [gdp updateCamera :450439, :450500] */
  platformer: boolean;
  /**
   * What the teleports and the spider's jump ask of the camera, as counts it
   * compares with the last it saw (render/camera.ts follow): key 464's snap
   * (+1368/+1369), key 55's slow y follow (float 254), and the check
   * checkCameraLimitAfterTeleport makes, with that player's y and the margin.
   * The sim writes them (Sim.teleportPlayer, Sim.checkCameraAfterTeleport).
   * [gdp teleportPlayer :462456-462489; checkCameraLimitAfterTeleport
   *  :450837-450857]
   */
  snapSeq: number;
  slowYSeq: number;
  teleportCheckSeq: number;
  teleportCheckY: number;
  teleportCheckMargin: number;
}

function newCamera(levelTop: number, levelEnd: number | null, minLeft: number | null, platformer: boolean): CameraState {
  return {
    zoom: 1,
    zoomTween: null,
    offsetX: 0,
    offsetY: 0,
    offsetXTween: null,
    offsetYTween: null,
    rotation: 0,
    rotationTarget: 0,
    rotationTween: null,
    staticX: newStaticCameraAxis(),
    staticY: newStaticCameraAxis(),
    edgeLeft: 0,
    edgeRight: 0,
    edgeTop: 0,
    edgeBottom: 0,
    limitLeft: null,
    limitRight: null,
    limitTop: null,
    limitBottom: null,
    levelTop,
    levelEnd,
    leadSnap: 0,
    gameplayOffsetX: GAMEPLAY_OFFSET_X,
    gameplayOffsetY: GAMEPLAY_OFFSET_X,
    gameplayOffsetXRaw: false,
    gameplayOffsetYRaw: false,
    mgOffsetY: 0,
    mgOffsetTween: null,
    bgSpeedX: 0.1,
    bgSpeedY: 0.1,
    mgSpeedX: 0.3,
    mgSpeedY: 0.5,
    followDivisor: 10,
    padding: 0.5,
    minLeft,
    platformer,
    snapSeq: 0,
    slowYSeq: 0,
    teleportCheckSeq: 0,
    teleportCheckY: 0,
    teleportCheckMargin: 0,
  };
}

/**
 * A copy that shares nothing the live camera steps in place: a checkpoint
 * holding the live tween would be stepped along with it.
 */
function cloneCamera(c: CameraState): CameraState {
  const t = (x: CameraTween | null): CameraTween | null => (x ? { ...x } : null);
  const axis = (a: StaticCameraAxis): StaticCameraAxis => ({ ...a, tween: t(a.tween) });
  return {
    ...c,
    zoomTween: t(c.zoomTween),
    offsetXTween: t(c.offsetXTween),
    offsetYTween: t(c.offsetYTween),
    rotationTween: t(c.rotationTween),
    mgOffsetTween: t(c.mgOffsetTween),
    staticX: axis(c.staticX),
    staticY: axis(c.staticY),
  };
}

/**
 * convertToClosestDirection(v, 180): whole turns off until the angle is
 * within ±180, 180 itself staying 180. [gdp GJBaseGameLayer::
 * convertToClosestDirection :428041-428058]
 */
export function closestDirection(v: number): number {
  if (v > 180) return Math.fround(v - Math.ceil(Math.floor(Math.abs(v) / 180) * 0.5) * 360);
  if (v < -180) return Math.fround(v + Math.ceil(Math.floor(Math.abs(v) / 180) * 0.5) * 360);
  return v;
}

/** An Edit Area trigger's tween of one field of a running area. */
interface AreaTween {
  key: number;
  from: number;
  to: number;
  elapsed: number;
  duration: number;
  easing: number;
  rate: number;
}

/**
 * One running Area Move, Rotate or Scale: the trigger's fields, copied when
 * it fired, and worked out again from scratch every step until an Area Stop
 * or a later copy of the same area replaces it.
 * [gdp EnterEffectInstance, ctor :441838-441872; loadValuesFromObject
 *  :717794-717886]
 */
interface AreaInstance {
  /** The trigger it came from. */
  source: number;
  /** 0 move, 1 rotate, 2 scale: the order the game keeps its lists in, reversed; 3 fade, 4 tint. */
  kind: 0 | 1 | 2 | 3 | 4;
  /** An Area Tint's channel (260), halves (65 main only, 66 detail only) and HSV (278 with 49). */
  tint: AreaTintSource | null;
  group: number;
  /** Key 71 as read, which a repeat firing must match to reuse this instance. */
  centreGroup: number;
  /** Key 538 if set, else key 71: a group, or -1 and -2 for the players. */
  centre: number;
  controlId: number;
  effectId: number;
  priority: number;
  axis: number;
  xy: boolean;
  radial: boolean;
  dual: boolean;
  invert: boolean;
  twoSided: boolean;
  easing: number;
  rate: number;
  easing2: number;
  rate2: number;
  vals: Record<number, number>;
  tweens: AreaTween[];
  /** Bumped by 2 a step; dual easing's side memory is stamped with it. */
  counter: number;
  sides: Map<number, number>;
}

/** What the area triggers have done to one object this step: x, y, spin, and the two scale factors. */
type AreaOffset = [number, number, number, number, number];

interface AreaTintSource {
  channel: number;
  main: boolean;
  detail: boolean;
  hsv: HsvShift | null;
}

/** A custom enter effect (3020/3021) sitting on one channel's coming-in or going-out list. */
export interface CustomEnterEffect {
  id: number;
  source: number;
  effectId: number;
  length: number;
  lengthPm: number;
  offset: number;
  offsetPm: number;
  deadzone: number;
  easing: number;
  rate: number;
  /** Enter Tint key 265: how hard it blends at the edge. */
  percent: number;
  /** Enter Tint (3021): the channel blend, or null for Enter Fade. */
  tint: AreaTintSource | null;
}

const NO_CUSTOM_ENTER: ReadonlyMap<number, readonly CustomEnterEffect[]> = new Map();

/** One Area Tint reaching an object: how far into the area it is (0 at the centre) and how much it tints. */
export interface AreaTint extends AreaTintSource {
  value: number;
  percent: number;
}

/** What the Area Fade and Tint triggers do to one object this step. */
export interface AreaVisual {
  /** The opacity the nearest Area Fade gives it, times its own; undefined with no fade on it. */
  opacity: number | undefined;
  /** The tints, in the order they apply. */
  tints: AreaTint[];
}

const NO_AREA_VISUALS: ReadonlyMap<number, AreaVisual> = new Map();

const NO_AREA_OFFSETS: ReadonlyMap<number, AreaOffset> = new Map();

function cloneArea(a: AreaInstance): AreaInstance {
  return { ...a, vals: { ...a.vals }, tweens: a.tweens.map((t) => ({ ...t })), sides: new Map(a.sides) };
}

export interface TriggerSnapshot {
  areas: readonly AreaInstance[];
  areaOffsets: ReadonlyMap<number, AreaOffset>;
  areaVisuals: ReadonlyMap<number, AreaVisual>;
  areaGroups: readonly number[];
  groupM: Float64Array;
  groupSpin: Float64Array;
  groupScale: Float64Array;
  groupAlpha: Float32Array;
  groupEnabled: Int8Array;
  fired: Uint8Array;
  touching: Uint8Array;
  collisionControl: Uint8Array;
  activeChannel: number;
  channelAt: Int32Array;
  channelReversed: Uint8Array;
  musicTime: number;
  pendingCheckpoint: number;
  touchIndex: number;
  commands: Command[];
  spawns: SpawnAction[];
  items: Map<number, number>;
  timers: Map<number, number>;
  persistentItems: Map<number, number>;
  persistentTimers: Map<number, number>;
  timerRuns: Map<number, TimerRun>;
  timerWatches: TimerWatch[];
  countListeners: CountListener[];
  eventListeners: readonly EventListener[];
  eventStamps: ReadonlyMap<string, number>;
  touchActions: readonly TouchAction[];
  points: number;
  levelTime: number;
  levelTimeStopped: boolean;
  viewX: number;
  viewY: number;
  viewReversed: boolean;
  yHistory: Float32Array | null;
  yHistoryAt: number;
  yHistoryClock: number;
  followDy: Float64Array | null;
  advFollow: AdvFollowSnapshot | null;
  advMotion: Float64Array | null;
  onDeath: readonly number[];
  toggleGen: number;
  seed: number;
  timeWarp: number;
  camera: CameraState;
  visual: VisualState;
  colors: ColorSnapshot | null;
  eventsLen: number;
}

/**
 * Everything a level's triggers have done so far.
 *
 * State is copy-on-write: `capture()` hands out the live arrays and marks them
 * shared, and the first write afterwards forks them. That is the same
 * discipline `objState` already uses in the sim, and it is what keeps a beam
 * search branch cheap — a branch that never fires a trigger never copies
 * anything.
 */
export class TriggerRuntime {
  private groupM: Float64Array;
  private groupSpin: Float64Array;
  private groupScale: Float64Array;
  private groupAlpha: Float32Array;
  private groupEnabled: Int8Array;
  private fired: Uint8Array;
  private shared = false;
  /**
   * The gameplay channel whose pass-by triggers fire (+728); 0 at the start
   * and after every reset. A Rotate Gameplay with key 171 switches it.
   * [gdp GJBaseGameLayer::resetSpawnChannelIndex :454562-454590, from
   *  resetLevelVariables :463056; rotateGameplay :442819-442828]
   */
  private activeChannel = 0;
  /** How far each channel's queue has fired, by slot in `index.channels` (+736). */
  private channelAt: Int32Array;
  /**
   * Whether a channel pops against its way (+764): set by the Rotate Gameplay
   * that switched to it, when the new way is left or down.
   */
  private channelReversed: Uint8Array;
  /**
   * The two channel arrays are copied on write on their own: a pass-by pop
   * happens every few steps, and forking the whole trigger state for one
   * integer would cost the autoplayer's search more than the rest of it.
   */
  private channelsShared = false;
  /** Where the active channel sits in `index.channels`, -1 for a channel with no queue. */
  private activeSlot: number;
  /**
   * Player 1's rotated flag as the pass-by check reads it. A Rotate Gameplay
   * turns the player inside the trigger in the game, and the check reads the
   * flag afresh for the next trigger; the sim turns the player after the
   * checks, so this carries the turn until then. A call-stack value, like
   * `activeRemap`. [gdp checkSpawnObjects :454495, read for each trigger]
   */
  private passRotated = false;
  /**
   * The level's music clock (+800), seconds since the attempt began, which
   * a start position's warm-up has already run on and a checkpoint keeps.
   * In a platformer the pass-by triggers fire by it, not by the player: at
   * x ≤ the clock times 1x speed.
   * [gdp GJBaseGameLayer::update :469941; loadUpToPosition :469472;
   *  checkSpawnObjects :454460-454464
   *  → PlayLayer::posForTime :87536-87547 → LevelTools::posForTimeInternal
   *  :122165-122166, 122342 for a platformer; zeroed by resetLevelVariables
   *  → resetSongTriggerValues :462967, 441578-441583; part of the game state
   *  a checkpoint copies back]
   */
  private musicClock = 0;

  /** The music clock (+800), which a Song trigger is timed by: see `musicClock`. */
  get musicTime(): number {
    return this.musicClock;
  }

  private touchIndex = 0;
  private commands: Command[] = [];
  private spawns: SpawnAction[] = [];
  private items = new Map<number, number>();
  private timers = new Map<number, number>();
  /** Item ids marked Persistent Item Setup so a death restart keeps them. */
  private persistentItems = new Map<number, number>();
  /** Timer ids marked the same way. */
  private persistentTimers = new Map<number, number>();
  /** UI Trigger layout: object index -> anchor for screen pinning. */
  private uiAnchors = new Map<number, UiAnchor>();
  /** How each timer a Time trigger started runs; a timer missing here stands still. */
  private timerRuns = new Map<number, TimerRun>();
  /** Armed Time Event triggers, oldest first. */
  private timerWatches: TimerWatch[] = [];
  /** Armed Count triggers, oldest first. */
  private countListeners: CountListener[] = [];
  /** The Event triggers listening, oldest first (see EventListener). */
  private eventListeners: readonly EventListener[] = [];
  /**
   * The step each (event, key) pair last fired on, so it fires at most once
   * a step. [gdp gameEventTriggered :462237-462240, the map at +1136 against
   *  the step count +816]
   */
  private eventStamps: Map<string, number> = new Map();
  /** The armed Touch triggers, oldest first; replaced, never changed in place. */
  private touchActions: readonly TouchAction[] = [];
  /**
   * The level's points, which a collectible (key 383) adds to and an Item
   * Edit can set; an Item Compare reads them as item type 3. A respawn at a
   * checkpoint gets back the ones the checkpoint was placed with: the reset
   * zeroes them, then the checkpoint's game state, which holds them, is
   * copied back over it.
   * [gdp GJBaseGameLayer::addPoints :430302-430306; +1516 zeroed in
   *  resetLevelVariables :462929, then PlayLayer::loadFromCheckpoint :105527 →
   *  GJGameState::operator= :105019 (+328 + 1188); saved by createCheckpoint
   *  :105114]
   */
  private points = 0;
  /**
   * Seconds this attempt has run, item type 4. It counts from the first step,
   * so a start position's warm-up leaves it at 0, and a practice respawn does
   * not wind it back: the game only zeroes it on a reset with no checkpoint to
   * go to.
   * [gdp GJBaseGameLayer::update :469830-469831; PlayLayer::resetLevel :105896,
   *  before loadStartPosObject :105942, whose loop runs +800 and +792 alone
   *  :469472-469474]
   */
  levelTime = 0;
  /**
   * Set once the level is complete or an End trigger has fired: from then on
   * the level time stands still, and no End trigger acts again. A reset
   * clears it, a practice respawn included. [gdp GJBaseGameLayer::update
   *  :469828-469831, +11304 set by EndPortalObject::triggerObject :326158,
   *  PlayLayer::levelComplete :92676 and activatePlatformerEndTrigger
   *  :93041-93046; cleared by resetLevelVariables :462932]
   */
  private levelTimeStopped = false;
  /**
   * Player 1's world position at the end of the last step, and whether it was
   * reversed, which the active range is worked out from (objectActive): the
   * game's visibility pass runs after a frame's steps, and an Animate trigger
   * asks whether it has made the object active.
   */
  private viewX = 0;
  private viewY = 0;
  private viewReversed = false;
  /** How many objects in `visual.animationStarts` wait to be active (NaN). */
  private pendingStarts = 0;
  /** The y sections a platformer or kA37 adds (usesYSections). */
  private readonly ySections: boolean;
  /**
   * Player 1's game y, one slot per hundredth of a second, for the Follow
   * Player Y trigger's delay; null in a level without one that has a delay,
   * so nothing else pays for it. `yHistoryAt` is the slot counter and
   * `yHistoryClock` the time banked towards the next slot. A checkpoint keeps
   * all three. [gdp PlayerObject::updateSpecial :142088-142110;
   *  saveToCheckpoint :161569-161571, loadFromCheckpoint :161651-161653]
   */
  private yHistory: Float32Array | null = null;
  private yHistoryAt = 0;
  private yHistoryClock = 0;
  /**
   * How far Follow Player Y has carried each object up or down, on top of its
   * groups: the game moves each member by its own gap, so one group transform
   * cannot hold it. Null in a level without the trigger. `followGroups` is
   * every group one has moved, a high-water mark as movedGroups is.
   * [gdp processPlayerFollowActions :427914-428015]
   */
  private followDy: Float64Array | null = null;
  private readonly followGroups = new Set<number>();
  private advFollow: AdvancedFollowSystem | null = null;
  /** Per-object advanced-follow push: dx, dy, extra rotation. */
  private advMotion: Float64Array | null = null;
  /**
   * The running area triggers, highest key 341 first, and what they did to
   * each object this step. The offsets are built fresh each step, as the game
   * takes every area's push back out before putting them all on again, so a
   * snapshot can share the map. `areaGroups` are the groups those objects
   * were reached through, rebuilt when an area lets go of them.
   * [gdp processAreaActions :469272-469352; resetAreaObjectValues
   *  :436707-436801]
   */
  private areas: AreaInstance[] = [];
  private areaOffsets: ReadonlyMap<number, AreaOffset> = NO_AREA_OFFSETS;
  private areaVisuals: ReadonlyMap<number, AreaVisual> = NO_AREA_VISUALS;
  private areaGroups: readonly number[] = [];
  private areaRand: AreaRandom | null = null;
  private areaP1x = 0;
  private areaP1y = 0;
  private areaP2: [number, number] | null = null;
  /** The attempt number, item type 5. Set by whoever starts the attempt; not part of a snapshot. */
  attempt: number;
  /** kA40, "Enable 2.2 Changes", as the sim works it out (see TriggerOptions). */
  private readonly changes22: boolean;
  /** kA27, "Allow Multi-Rotation": see stepCommands. */
  private readonly multiRotation: boolean;
  /**
   * 1 for each object a rotate moves round its centre but never turns: a
   * solid, breakable or slope in a level without kA41 "Allow Static-Rotate".
   * Key 121 makes an object decoration, which turns. Null with kA41.
   * [GJBaseGameLayer::applyLevelSettings :430498-430512 (+728 = kA41 or
   *  canRotateFree); GameObject::canRotateFree :168950-168958 (types 0, 21
   *  and 25); key 121 makes the type 7 :173308-173309; the turn is applied only
   *  with +728, processRotationActions :440008-440016, :440043-440051]
   */
  private readonly fixedAngle: Uint8Array | null;
  private rng: Lcg;
  private readonly firedSlot: Int32Array;
  /**
   * The remap in force for the trigger being dispatched right now. It is a
   * call-stack value rather than stored state — nothing outlives the dispatch —
   * so it is saved and put back around every nested activation.
   */
  private activeRemap: Remap = null;
  /**
   * Collision blocks (object 1816) by the block id they carry, and the pairs
   * the level's Collision triggers actually ask about. Only those pairs are
   * tested each tick, so a level with no collision trigger pays nothing at all.
   */
  private readonly blocksById = new Map<number, number[]>();
  private readonly collisionPairs: CollisionPair[] = [];
  private readonly collisionTriggers: { spec: TriggerSpec; pair: number }[] = [];
  /**
   * Per collision trigger: 0 live, 1 paused by Stop, 2 stopped. Parallel to
   * `collisionTriggers`; part of the snapshot so a rewind can re-arm.
   * [gdp controlActionsForTrigger :484873-484899 (CollisionTriggerAction)]
   */
  private collisionControl: Uint8Array = new Uint8Array(0);
  /** One byte a pair: were the two overlapping at the end of the last tick. */
  private touching: Uint8Array;
  /** Both players' boxes as (x, y, half) triples, filled by checkTouch. */
  private readonly playerBox = [0, 0, -1, 0, 0, -1];
  private readonly boxA = [0, 0, 0, 0];
  private readonly boxB = [0, 0, 0, 0];
  private readonly blockScratch = new Float64Array(9);
  /** Groups whose transform changed since the geometry was last rebuilt. */
  private dirty = new Set<number>();
  /** The dirty groups a silent Move moved, which leaves no motion behind. */
  private silentDirty = new Set<number>();
  private allDirty = true;
  /**
   * Which objects a group toggle has switched off, derived from groupEnabled
   * rather than stored: it is read once per collision candidate, so it has to
   * be an array lookup, but rebuilding it on every restore would cost more than
   * it saves. The generation counter is part of the state, the mask is not, so
   * a branch that never toggles anything never rebuilds.
   */
  private disabledMask: Uint8Array;
  private toggleGen = 0;
  private maskGen = -1;

  readonly colors: ColorTable;
  readonly visuals: boolean;
  readonly camera: CameraState;
  readonly visual: VisualState;
  readonly events: TriggerEvent[] = [];
  /** Advanced by the sim so events carry a tick. */
  tick = 0;
  /** 0.1 to 2. Below 1 the sim shrinks each step's game time to it (see Sim.step). */
  timeWarp = 1;
  /**
   * Gravity (2066), Player Control (1932) and Reverse (1917) triggers that
   * have fired, oldest first, for the sim to apply to the players. The game
   * applies each inside its trigger; they are taken within the step or the
   * level spawn that fired them.
   */
  readonly pendingPlayer: PlayerRequest[] = [];
  /**
   * Teleport triggers (3022) that have fired, oldest first, for the sim to
   * run through teleportPlayer: each trigger's object index and the object its
   * group resolved to, -1 for none. Every one runs, in order, as the game runs
   * each inside its own trigger: a gravity toggle (key 354) or an added push
   * (key 443) counts once per trigger. Taken within the step or the level
   * spawn that fired them. [gdp EffectGameObject::triggerObject :314981 →
   *  teleportPlayer]
   */
  readonly pendingTeleports: { object: number; target: number }[] = [];
  /** A Camera Mode trigger's switches, for the sim to apply as a portal would. */
  pendingCameraMode: CameraModeRequest | null = null;
  /**
   * A Zoom trigger, or a Static Camera exit, that asks the corridor to be laid
   * again (Sim.takeGroundRefresh): the band is measured on the screen, so a
   * zoom changes it, and an exit hands the static y back to the corridor.
   * `instant` for a zoom with no move time. [gdp GJBaseGameLayer::updateZoom
   *  :451293-451301; exitStaticCamera :451451-451455]
   */
  pendingGround: { zoom: boolean; instant: boolean } | null = null;
  /**
   * Rotate Gameplay triggers that fired this step, oldest first, for the sim to
   * apply to the players. More than one can fire in a step, and the order
   * matters because each one sets the orientation outright.
   */
  readonly pendingRotations: GameplayRotation[] = [];
  /**
   * An End trigger (3600) that has fired, for the sim to end the level with:
   * where the player is sent, and the trigger's three switches. Taken within
   * the step or the level spawn that fired it.
   */
  pendingEnd: LevelEnd | null = null;
  /**
   * The checkpoint object (2063) a platformer touched or spawned since the
   * last step's end, the last one if several, for the sim to lay down at the
   * end of the step; -1 for none. Unlike the requests above it can wait out
   * a step boundary — one that a respawn's key 448 spawns is laid at the end
   * of the next step, as the game lays it in the next postUpdate — so a
   * snapshot carries it. [gdp PlayLayer::checkpointActivated :86960-86965;
   *  laid by postUpdate :105311-105361; resetLevel spawns +2600 after
   *  zeroing +12104, :105786 and :105965-105973]
   */
  pendingCheckpoint = -1;
  /** Set while the On Death groups spawn: an End trigger ignores a dead player. */
  private dying = false;

  constructor(
    readonly level: Level,
    readonly objs: ObjectSet,
    readonly index: TriggerIndex,
    opts: TriggerOptions = {},
  ) {
    const g = index.groupCount;
    this.groupM = new Float64Array(g * M);
    this.groupSpin = new Float64Array(g);
    this.groupScale = new Float64Array(g * 2);
    this.groupAlpha = new Float32Array(g);
    this.groupEnabled = new Int8Array(g);
    this.visuals = opts.visuals !== false;
    this.rng = new Lcg(opts.seed ?? 1);
    this.attempt = opts.attempt ?? 1;
    this.changes22 = opts.changes22 === true;
    this.multiRotation = level.header.allowMultiRotation;
    this.ySections = usesYSections(level);
    const header = level.header;
    const leftStop = (header.leftStopAlways || opts.fromStartPosition !== true) && !header.noLeftStop;
    this.camera = newCamera(
      opts.levelTop ?? maxGameplayYFor(level),
      header.platformer ? null : lastObjectX(level) + LEVEL_END_MARGIN,
      leftStop ? LEVEL_START_LEFT : null,
      header.platformer,
    );
    this.fixedAngle = level.header.allowStaticRotate ? null : fixedAngles(objs);
    if (index.hasPlayerFollow) this.yHistory = new Float32Array(Y_HISTORY_SLOTS);
    for (const spec of index.byObject.values()) {
      if (spec.id !== 1814) continue;
      this.followDy = new Float64Array(level.objects.length);
      break;
    }
    for (const spec of index.byObject.values()) {
      // Area motion/visual, Edit Area, and the custom enter effects all share
      // the variance table. [gdp applyCustomEnterEffect :90773-90794]
      if ((spec.id >= 3006 && spec.id <= 3015) || (spec.id >= 3017 && spec.id <= 3021) || spec.id === 3024) {
        this.areaRand = areaRandom(level.objects.length);
        break;
      }
    }
    for (const spec of index.byObject.values()) {
      if (spec.id !== 3016 && spec.id !== 3660 && spec.id !== 3661) continue;
      if (!this.areaRand) this.areaRand = areaRandom(level.objects.length);
      if (!this.advFollow) this.advFollow = new AdvancedFollowSystem();
      if (!this.advMotion) this.advMotion = new Float64Array(level.objects.length * 3);
      break;
    }
    this.colors = ColorTable.resolve(level.header, { player1: opts.player1, player2: opts.player2 });
    this.visual = {
      background: level.header.background,
      ground: level.header.ground,
      middleground: Number(level.header.raw.kA25 ?? 0) || 0,
      shakeStrength: 0,
      shakeInterval: 0,
      shakeRemaining: 0,
      ghostTrail: false,
      ghostTrail2: false,
      hidePlayer: false,
      bgEffectHidden: false,
      shader: opts.shader && this.visuals ? carriedShaderState(opts.shader) : createShaderState(),
      gradients: [],
      options: defaultOptions(level.header),
      animations: new Map(),
      animationStarts: new Map(),
      skeletonAnims: new Map(),
      enter: defaultEnterTables(),
      customEnterIn: NO_CUSTOM_ENTER,
      customEnterOut: NO_CUSTOM_ENTER,
    };
    this.firedSlot = new Int32Array(level.objects.length).fill(-1);
    let slot = 0;
    for (const i of index.byObject.keys()) this.firedSlot[i] = slot++;
    this.fired = new Uint8Array(slot);
    this.channelAt = new Int32Array(index.channels.length);
    this.channelReversed = new Uint8Array(index.channels.length);
    this.activeSlot = index.channelSlot.get(0) ?? -1;
    this.disabledMask = new Uint8Array(level.objects.length);
    this.buildCollisionIndex();
    this.touching = new Uint8Array(this.collisionPairs.length);
    this.resetGroups();
    this.layoutUIObjects();
    if (opts.persistent) this.applyPersistentCarry(opts.persistent);
  }

  /**
   * Collects the collision blocks and the pairs the level asks about.
   *
   * A Collision trigger names two block ids, or one block id and a player.
   * Every block carrying an id is a rectangle that can move with its group, so
   * what gets tested each tick is this short pair list rather than every block
   * against every other.
   * [block_id 80 and dynamic_block 94 on object 1816; block_a 80, block_b 95,
   *  trigger_on_exit 93, p1 138, p2 200 on trigger 1815; Instant Collision 3609
   *  branches to true_id 51 and false_id 71 — flowvix's gd-info-explorer
   *  property table, agreeing with the Geode 2.2074 bindings]
   */
  private buildCollisionIndex(): void {
    for (const o of this.level.objects) {
      if (o.id !== COLLISION_BLOCK_ID) continue;
      const id = Number(o.props[80] ?? 0);
      if (!Number.isFinite(id) || id <= 0) continue;
      let list = this.blocksById.get(id);
      if (!list) this.blocksById.set(id, (list = []));
      list.push(o.index);
    }
    const seen = new Map<string, number>();
    for (const spec of this.index.byObject.values()) {
      if (spec.id !== 1815 && spec.id !== 3609) continue;
      const player: 0 | 1 | 2 = flag(spec, 138) ? 1 : flag(spec, 200) ? 2 : 0;
      // Either slot may hold the only block when the other side is a player, so
      // the pair is normalised rather than assuming A is always filled in.
      const first = int(spec, 80);
      const second = int(spec, 95);
      const a = first > 0 ? first : second;
      const b = first > 0 ? second : 0;
      if (a <= 0) continue;
      const key = a + "|" + (player === 0 ? b : 0) + "|" + player;
      let at = seen.get(key);
      if (at === undefined) {
        at = this.collisionPairs.length;
        this.collisionPairs.push({ a, b: player === 0 ? b : 0, player });
        seen.set(key, at);
      }
      this.collisionTriggers.push({ spec, pair: at });
    }
    this.collisionControl = new Uint8Array(this.collisionTriggers.length);
  }

  private resetGroups(): void {
    const g = this.index.groupCount;
    for (let i = 0; i < g; i++) {
      this.groupM[i * M] = 1;
      this.groupM[i * M + 1] = 0;
      this.groupM[i * M + 2] = 0;
      this.groupM[i * M + 3] = 1;
      this.groupM[i * M + 4] = 0;
      this.groupM[i * M + 5] = 0;
      this.groupScale[i * 2] = 1;
      this.groupScale[i * 2 + 1] = 1;
      this.groupAlpha[i] = 1;
      this.groupEnabled[i] = 1;
    }
  }

  // --- copy on write ---------------------------------------------------------

  private fork(): void {
    if (!this.shared) return;
    this.groupM = this.groupM.slice();
    this.groupSpin = this.groupSpin.slice();
    this.groupScale = this.groupScale.slice();
    this.groupAlpha = this.groupAlpha.slice();
    this.groupEnabled = this.groupEnabled.slice();
    this.fired = this.fired.slice();
    this.touching = this.touching.slice();
    this.collisionControl = this.collisionControl.slice();
    this.commands = this.commands.map((c) => ({ ...c }));
    this.spawns = this.spawns.map((s) => ({ ...s }));
    this.items = new Map(this.items);
    this.timers = new Map(this.timers);
    this.persistentItems = new Map(this.persistentItems);
    this.persistentTimers = new Map(this.persistentTimers);
    this.timerRuns = new Map(this.timerRuns);
    this.timerWatches = this.timerWatches.map((w) => ({ ...w }));
    this.countListeners = this.countListeners.map((l) => ({ ...l }));
    this.eventStamps = new Map(this.eventStamps);
    if (this.yHistory) this.yHistory = this.yHistory.slice();
    if (this.followDy) this.followDy = this.followDy.slice();
    if (this.advMotion) this.advMotion = this.advMotion.slice();
    if (this.advFollow) {
      const snap = this.advFollow.capture();
      this.advFollow = new AdvancedFollowSystem();
      this.advFollow.restore(snap);
    }
    if (this.areas.length > 0) this.areas = this.areas.map(cloneArea);
    this.onDeath = [...this.onDeath];
    this.shared = false;
  }

  capture(): TriggerSnapshot {
    this.shared = true;
    this.channelsShared = true;
    return {
      areas: this.areas,
      areaOffsets: this.areaOffsets,
      areaVisuals: this.areaVisuals,
      areaGroups: this.areaGroups,
      groupM: this.groupM,
      groupSpin: this.groupSpin,
      groupScale: this.groupScale,
      groupAlpha: this.groupAlpha,
      groupEnabled: this.groupEnabled,
      fired: this.fired,
      touching: this.touching,
      collisionControl: this.collisionControl,
      activeChannel: this.activeChannel,
      channelAt: this.channelAt,
      channelReversed: this.channelReversed,
      musicTime: this.musicClock,
      pendingCheckpoint: this.pendingCheckpoint,
      touchIndex: this.touchIndex,
      commands: this.commands,
      spawns: this.spawns,
      items: this.items,
      timers: this.timers,
      persistentItems: this.persistentItems,
      persistentTimers: this.persistentTimers,
      timerRuns: this.timerRuns,
      timerWatches: this.timerWatches,
      countListeners: this.countListeners,
      eventListeners: this.eventListeners,
      eventStamps: this.eventStamps,
      touchActions: this.touchActions,
      points: this.points,
      levelTime: this.levelTime,
      levelTimeStopped: this.levelTimeStopped,
      viewX: this.viewX,
      viewY: this.viewY,
      viewReversed: this.viewReversed,
      yHistory: this.yHistory,
      yHistoryAt: this.yHistoryAt,
      yHistoryClock: this.yHistoryClock,
      followDy: this.followDy,
      advFollow: this.advFollow ? this.advFollow.capture() : null,
      advMotion: this.advMotion,
      onDeath: this.onDeath,
      toggleGen: this.toggleGen,
      seed: this.rng.seed,
      timeWarp: this.timeWarp,
      camera: cloneCamera(this.camera),
      visual: {
        ...this.visual,
        // Whole, tweens and all, as the game's checkpoint copies its
        // GJShaderState: the live one is stepped in place every frame. With
        // the visuals off nothing ever touches it, so it is shared.
        // [gdp PlayLayer::createCheckpoint :105118]
        shader: this.visuals ? cloneShaderState(this.visual.shader) : this.visual.shader,
        gradients: [...this.visual.gradients],
        options: { ...this.visual.options },
      },
      colors: this.visuals ? this.colors.capture() : null,
      eventsLen: this.events.length,
    };
  }

  restore(s: TriggerSnapshot): void {
    // The transform arrays are forked as a set, so one reference comparison
    // says whether anything moved between here and the snapshot. A beam-search
    // branch that only pressed a button rebuilds no geometry at all.
    const moved =
      this.groupM !== s.groupM ||
      this.followDy !== s.followDy ||
      this.advMotion !== s.advMotion ||
      this.areaOffsets !== s.areaOffsets;
    this.areas = s.areas as AreaInstance[];
    this.areaOffsets = s.areaOffsets;
    this.areaVisuals = s.areaVisuals;
    this.areaGroups = s.areaGroups;
    this.groupM = s.groupM;
    this.groupSpin = s.groupSpin;
    this.groupScale = s.groupScale;
    this.groupAlpha = s.groupAlpha;
    this.groupEnabled = s.groupEnabled;
    this.fired = s.fired;
    this.touching = s.touching;
    this.collisionControl = s.collisionControl;
    this.shared = true;
    this.activeChannel = s.activeChannel;
    this.channelAt = s.channelAt;
    this.channelReversed = s.channelReversed;
    this.channelsShared = true;
    this.activeSlot = this.index.channelSlot.get(s.activeChannel) ?? -1;
    this.musicClock = s.musicTime;
    this.touchIndex = s.touchIndex;
    this.commands = s.commands;
    this.spawns = s.spawns;
    this.items = s.items;
    this.timers = s.timers;
    this.persistentItems = s.persistentItems;
    this.persistentTimers = s.persistentTimers;
    this.timerRuns = s.timerRuns;
    this.timerWatches = s.timerWatches;
    this.countListeners = s.countListeners;
    this.eventListeners = s.eventListeners;
    this.eventStamps = s.eventStamps as Map<string, number>;
    this.touchActions = s.touchActions;
    this.points = s.points;
    this.levelTime = s.levelTime;
    this.levelTimeStopped = s.levelTimeStopped;
    this.viewX = s.viewX;
    this.viewY = s.viewY;
    this.viewReversed = s.viewReversed;
    this.yHistory = s.yHistory;
    this.yHistoryAt = s.yHistoryAt;
    this.yHistoryClock = s.yHistoryClock;
    this.followDy = s.followDy;
    if (s.advFollow) {
      if (!this.advFollow) this.advFollow = new AdvancedFollowSystem();
      this.advFollow.restore(s.advFollow);
    } else if (this.advFollow) {
      this.advFollow.restore(
        cloneAdvFollow({
          instances: [],
          physics: new Map(),
          dirtySort: false,
          nextOrdinal: 0,
          history: { samples: 0, rings: new Map(), ring: new Float32Array(0), nextBase: 0 },
        }),
      );
    }
    this.advMotion = s.advMotion;
    if (s.advMotion && !this.advMotion) this.advMotion = s.advMotion.slice();
    this.onDeath = s.onDeath;
    // The other requests are taken within the step or the level spawn that
    // made them, so no snapshot holds one; a step that ended in a death
    // before taking them must not pass them on to the state restored here.
    this.pendingCheckpoint = s.pendingCheckpoint;
    this.pendingEnd = null;
    this.pendingTeleports.length = 0;
    this.pendingCameraMode = null;
    this.pendingGround = null;
    this.pendingRotations.length = 0;
    this.pendingPlayer.length = 0;
    this.toggleGen = s.toggleGen;
    this.rng.setSeed(s.seed);
    this.timeWarp = s.timeWarp;
    Object.assign(this.camera, cloneCamera(s.camera));
    Object.assign(this.visual, s.visual);
    // A copy again, so the snapshot survives being restored more than once.
    // [gdp PlayLayer::loadFromCheckpoint :105529-105531]
    this.visual.shader = this.visuals ? cloneShaderState(s.visual.shader) : s.visual.shader;
    this.visual.gradients = [...s.visual.gradients];
    this.visual.options = { ...s.visual.options };
    // The enter tables come back with the rest (they are replaced, never
    // changed in place, so the snapshot's own are safe to share). They are
    // part of the game's state: resetLevel sets them to the fade, then
    // loadFromCheckpoint copies the checkpoint's back over them — a practice
    // checkpoint's, or the one a start position's warm-up left, which every
    // attempt after the first loads instead of warming up again.
    // [PlayLayer::resetLevel :105832 → resetActiveEnterEffects :448610-448625,
    //  then loadLastCheckpoint or :105898-105902 → loadFromCheckpoint :105527
    //  → GJGameState::operator= :104868-104869 (+888/+900 of the state at
    //  +328, the layer's +1216/+1228); saved by createCheckpoint :105114, and
    //  for a start position once by PlayLayer::startMusic :105411-105421]
    this.pendingStarts = 0;
    for (const at of this.visual.animationStarts.values()) if (Number.isNaN(at)) this.pendingStarts++;
    if (s.colors) this.colors.restore(s.colors);
    if (this.events.length > s.eventsLen) this.events.length = s.eventsLen;
    if (moved) {
      this.allDirty = true;
      this.dirty.clear();
      this.silentDirty.clear();
    }
  }

  // --- group state -----------------------------------------------------------

  /** The affine a group's objects are carried by, as six numbers. */
  groupTransform(group: number, out: Float64Array): boolean {
    if (group < 0 || group >= this.index.groupCount) return false;
    const at = group * M;
    out[0] = this.groupM[at];
    out[1] = this.groupM[at + 1];
    out[2] = this.groupM[at + 2];
    out[3] = this.groupM[at + 3];
    out[4] = this.groupM[at + 4];
    out[5] = this.groupM[at + 5];
    return true;
  }

  groupSpinOf(group: number): number {
    return group >= 0 && group < this.index.groupCount ? this.groupSpin[group] : 0;
  }

  groupScaleOf(group: number, axis: 0 | 1): number {
    return group >= 0 && group < this.index.groupCount ? this.groupScale[group * 2 + axis] : 1;
  }

  groupAlphaOf(group: number): number {
    return group >= 0 && group < this.index.groupCount ? this.groupAlpha[group] : 1;
  }

  /**
   * Whether an object is switched off. A group toggle hides the object, stops
   * it colliding and stops it triggering, all at once, and an object in several
   * groups only needs one of them off. [gdp GameObject::groupWasDisabled :169906]
   */
  objectDisabled(objectIndex: number): boolean {
    if (this.toggleGen === 0) return false;
    if (this.maskGen !== this.toggleGen) this.rebuildMask();
    return this.disabledMask[objectIndex] === 1;
  }

  private rebuildMask(): void {
    this.disabledMask.fill(0);
    for (let g = 1; g < this.index.groupCount; g++) {
      if (this.groupEnabled[g] === 1) continue;
      for (const index of this.index.groups.get(g) ?? []) this.disabledMask[index] = 1;
    }
    this.maskGen = this.toggleGen;
  }

  /** Groups whose transform has moved since the last time geometry was rebuilt. */
  takeDirty(): { all: boolean; groups: Iterable<number>; silent: ReadonlySet<number> } {
    const out = { all: this.allDirty, groups: [...this.dirty], silent: this.silentDirty.size > 0 ? new Set(this.silentDirty) : NO_GROUPS };
    this.allDirty = false;
    this.dirty.clear();
    this.silentDirty.clear();
    return out;
  }

  private markDirty(group: number): void {
    if (group > 0 && group < this.index.groupCount) this.dirty.add(group);
  }

  /**
   * Whether anything has actually moved yet. Until the first Move, Rotate or
   * Scale trigger fires — which in most levels is a long way in, and in levels
   * 1 to 18 is never — the collision broadphase can ignore moving objects
   * entirely and stay on the path it is on today.
   */
  get hasMotion(): boolean {
    return this.motion;
  }

  /** Whether any group has been switched off, so collision has to check. */
  get hasToggles(): boolean {
    return this.toggleGen > 0;
  }

  private motion = false;
  /**
   * Groups that have actually been moved, and the objects in them.
   *
   * This is a high-water mark rather than state: restoring to before a move
   * leaves the group in the set, which costs one wasted box test and never a
   * wrong answer. It is what keeps the broadphase from scanning every object a
   * movement trigger *could* touch — 5,750 of them in Dash — when only a
   * handful have moved so far.
   */
  private readonly movedGroups = new Set<number>();
  private movedList: Int32Array = new Int32Array(0);
  private activeMoving: Int32Array = new Int32Array(0);
  private activeMovingStale = false;

  /** Objects the collision broadphase has to offer on top of the spatial hash. */
  get movedObjects(): Int32Array {
    if (this.activeMovingStale) {
      const seen = new Set<number>();
      for (const g of this.movedGroups) {
        for (const i of this.index.groups.get(g) ?? []) seen.add(i);
      }
      this.activeMoving = Int32Array.from([...seen].sort((a, b) => a - b));
      this.movedList = Int32Array.from([...this.movedGroups].sort((a, b) => a - b));
      this.activeMovingStale = false;
    }
    return this.activeMoving;
  }

  private noteMoved(group: number): void {
    this.motion = true;
    if (!this.movedGroups.has(group)) {
      this.movedGroups.add(group);
      this.activeMovingStale = true;
    }
  }

  // --- the tick --------------------------------------------------------------

  /**
   * The top of the game's sub-step: the spawn queue, before the buttons are
   * handled. `loading` is a step of a start position's warm-up, which runs
   * the music clock and not the level time. [gdp GJBaseGameLayer::update,
   * gd-ida-decomp.cpp:469846 → GJEffectManager::updateSpawnTriggers;
   * loadUpToPosition :469472-469474]
   */
  beginStep(dt: number, loading = false, gameDt = dt): void {
    // The level time runs first, so the first step reads one tick, and stops
    // once the level is done. It and the music clock take the step before
    // time warp shrinks it, `dt`; the spawn queue takes the shrunk one,
    // `gameDt`. [gdp GJBaseGameLayer::update :469828-469831, the delta divided
    //  back by the warp at :469724 and :469774; the queue's v27 :469844-469846;
    //  the music clock's v15 / warp :469941]
    if (!this.levelTimeStopped && !loading) this.levelTime += dt;
    this.musicClock += dt;
    if (this.spawns.length > 0) this.stepSpawns(gameDt);
  }

  /**
   * After the buttons and before the player moves: every live command, so a
   * press still sees the level where the last step left it. `playerY` is
   * player 1's world y as it stands now, before its own update.
   * [gdp GJBaseGameLayer::update, gd-ida-decomp.cpp:469890-469893]
   */
  stepMoves(dt: number, playerDx: number, playerDy: number, cameraDx: number, cameraDy: number, playerY: number): void {
    if (this.timers.size > 0) this.stepTimers(dt);
    if (this.commands.length > 0) this.stepCommands(dt, playerDx, playerDy, cameraDx, cameraDy, playerY);
    else if (this.advFollow?.active) this.stepAdvFollowOnly(dt, playerY);
    if (this.areas.length > 0 || this.areaGroups.length > 0) this.stepAreas(dt);
    if (this.visual.shakeRemaining > 0) {
      this.visual.shakeRemaining -= dt;
      if (this.visual.shakeRemaining <= 0) {
        this.visual.shakeRemaining = 0;
        this.visual.shakeStrength = 0;
      }
    }
  }

  /**
   * Fires everything player 1 has now passed on the active channel. Each
   * channel's queue only ever moves forward: there is no un-firing, and a
   * trigger's position is the one frozen when the level loaded. A trigger is
   * passed when its x is at or behind player 1's — at or ahead of it on a
   * reversed channel — or, while gameplay is rotated, the same with y. A
   * Rotate Gameplay fired here can switch the channel and turn the player,
   * and the next trigger is read on the new channel with the new turn. In a
   * platformer the player does not count at all: the x is compared, never
   * reversed, with how far the music clock would have carried a player at
   * 1x speed. `playerX`/`playerY` are player 1's world position in the
   * port's frame, `rotated` its gameplay turn.
   * [gdp GJBaseGameLayer::checkSpawnObjects :454433-454549; the platformer's
   *  point :454460-454464 via posForTime, whose speed is the float of
   *  311.580109 (GeometryDash.exe holds it three times and 311.58 never)]
   */
  checkPassed(playerX: number, playerY: number, rotated: boolean): void {
    const platformer = this.level.header.platformer;
    const refX = platformer ? Math.fround(Math.fround(this.musicClock) * PLATFORMER_TRIGGER_SPEED) : playerX;
    this.passRotated = rotated;
    for (;;) {
      const slot = this.activeSlot;
      if (slot < 0) return;
      const channel = this.index.channels[slot];
      const at = this.channelAt[slot];
      if (at >= channel.specs.length) return;
      const reversed = this.channelReversed[slot] === 1;
      let passed: boolean;
      if (platformer) {
        passed = channel.x[at] <= refX;
      } else if (this.passRotated) {
        const refY = Math.fround(playerY + GAME_GROUND_Y);
        passed = reversed ? channel.y[at] >= refY : channel.y[at] <= refY;
      } else {
        passed = reversed ? channel.x[at] >= refX : channel.x[at] <= refX;
      }
      if (!passed) return;
      this.forkChannels();
      this.channelAt[slot] = at + 1;
      const spec = channel.specs[at];
      if (this.objectDisabled(spec.index)) continue;
      this.activate(spec, 1, 0);
    }
  }

  /**
   * canTouchObject: while a channel other than 0 is active, a trigger or
   * other effect object on another non-zero channel cannot be touched.
   * [gdp GJBaseGameLayer::canTouchObject :421284-421300, the gate on every
   *  object collisionCheckObjects meets :463487]
   */
  canTouch(channel: number): boolean {
    return this.activeChannel === 0 || channel === 0 || channel === this.activeChannel;
  }

  /**
   * A Rotate Gameplay's key 171: the active channel becomes `channel`, and
   * it pops against its way when the new way is left or down.
   * [gdp GJBaseGameLayer::rotateGameplay :442819-442828]
   */
  private switchChannel(channel: number, reversed: boolean): void {
    this.activeChannel = channel;
    const slot = this.index.channelSlot.get(channel);
    this.activeSlot = slot ?? -1;
    if (slot === undefined) return;
    this.forkChannels();
    this.channelReversed[slot] = reversed ? 1 : 0;
  }

  /**
   * The active channel, set outright and leaving each channel's way alone:
   * the warm-up to a start position makes the pass-by check read the channel
   * its own walk along the level is on. [gdp GJBaseGameLayer::loadUpToPosition
   *  :469499 (+728 = +732, which PlayLayer::posForTime writes)]
   */
  setActiveChannel(channel: number): void {
    this.activeChannel = channel;
    this.activeSlot = this.index.channelSlot.get(channel) ?? -1;
  }

  /**
   * kA35 "Reset Camera" on the start position a run warms up to: the turn,
   * the static camera and the four camera edges the warm-up's camera triggers
   * left are dropped, the turn through the Camera Rotate trigger's own call
   * with 0. The zoom and the offset stay.
   * [gdp GJBaseGameLayer::loadStartPosObject :469562-469586 (the edge slots
   *  :469565-469568; vtable +688, as CameraTriggerGameObject::triggerObject
   *  calls it for 2015 :315599-315609; resetStaticCamera(1, 1)
   *  :448861-448887)]
   */
  resetCamera(): void {
    const cam = this.camera;
    cam.rotation = 0;
    cam.rotationTarget = 0;
    cam.rotationTween = null;
    for (const st of [cam.staticX, cam.staticY]) {
      st.on = false;
      st.tween = null;
      st.progress = 1;
      st.exitHeld = false;
    }
    cam.edgeLeft = cam.edgeRight = cam.edgeTop = cam.edgeBottom = 0;
    cam.limitLeft = cam.limitRight = cam.limitTop = cam.limitBottom = null;
    // [gdp resetCamera :451344-451345 → restoreDefaultGameplayOffsetX/Y]
    cam.gameplayOffsetX = GAMEPLAY_OFFSET_X;
    cam.gameplayOffsetY = GAMEPLAY_OFFSET_X;
    cam.gameplayOffsetXRaw = false;
    cam.gameplayOffsetYRaw = false;
  }

  /**
   * The pass-by check a reset makes before the first step, with player 1
   * where it starts: whatever is at or behind it fires at time 0. The spawn
   * guard is empty again by the first step's spawn queue.
   * [gdp PlayLayer::resetLevel :105954-105963 (not from a checkpoint or a start
   *  position), and PlayLayer::init :106486 after a start position's warm-up;
   *  GJBaseGameLayer::update clears the guard before updateSpawnTriggers
   *  :469843]
   */
  checkPassedAtReset(playerX: number, playerY: number, rotated: boolean): void {
    this.checkPassed(playerX, playerY, rotated);
    this.spawnGuard.clear();
    // The reset's own camera pass reads the edges where they are now.
    // [gdp PlayLayer::resetLevel :105980 → updateCamera(0)]
    this.resolveCameraEdges();
  }

  private forkChannels(): void {
    if (!this.channelsShared) return;
    this.channelAt = this.channelAt.slice();
    this.channelReversed = this.channelReversed.slice();
    this.channelsShared = false;
  }

  /**
   * Fires the touch triggers the player's hitbox is inside.
   *
   * Triggers have no hitbox in the object table — they are invisible and the
   * collision pass never sees them — so this is its own scan rather than part
   * of the sim's candidate loop. The list is in x order and the player moves
   * forward, so a cursor finds the window in a step or two; it is allowed to
   * walk backwards because a teleport can put the player behind it.
   * [gdp GJBaseGameLayer::playerTouchedTrigger :456781-456824]
   */
  checkTouch(x: number, y: number, half: number, player: 1 | 2): void {
    const list = this.index.touch;
    if (list.length === 0) return;
    const x0 = x - half - TOUCH_HALF;
    const x1 = x + half + TOUCH_HALF;
    let at = Math.min(this.touchIndex, list.length - 1);
    while (at > 0 && list[at - 1].x >= x0) at--;
    while (at < list.length && list[at].x < x0) at++;
    this.touchIndex = at;
    const slot = player === 1 ? 0 : 3;
    this.playerBox[slot] = x;
    this.playerBox[slot + 1] = y;
    this.playerBox[slot + 2] = half;
    for (let k = at; k < list.length; k++) {
      const spec = list[k];
      if (spec.x > x1) break;
      if (Math.abs(spec.y - y) > half + TOUCH_HALF) continue;
      if (this.objectDisabled(spec.index)) continue;
      if (!this.canTouch(spec.channel)) continue;
      this.activate(spec, player, 0);
    }
  }

  /** A trigger the player is standing on, when the sim already knows which one. */
  touched(objectIndex: number, player: 1 | 2): void {
    const spec = this.index.byObject.get(objectIndex);
    if (!spec || !spec.touch) return;
    if (this.objectDisabled(objectIndex)) return;
    if (!this.canTouch(spec.channel)) return;
    this.activate(spec, player, 0);
  }

  private stepSpawns(dt: number): void {
    this.fork();
    const due: SpawnAction[] = [];
    // The game snapshots the queue length first, so a spawn that queues another
    // spawn does not also step it this tick.
    const n = this.spawns.length;
    for (let i = 0; i < n; i++) {
      const a = this.spawns[i];
      if (a.paused) continue;
      a.remaining -= dt;
      if (a.remaining <= 0) due.push(a);
    }
    if (due.length === 0) return;
    this.spawns = this.spawns.filter((a) => a.remaining > 0);
    for (const a of due) {
      const chain = unflatten(a.remap);
      if (a.object >= 0) this.spawnObject(a.object, 0, chain);
      else this.spawnGroup(a.group, a.spawner, a.ordered, a.baseDelay, 0, chain);
    }
  }

  /**
   * One step of every live command, in the game's fixed passes: every scale,
   * then every rotate and aim, every dynamic move, every move and fade, then
   * Follow Player Y, and Follow last. Each pass takes its commands in the
   * order they were made. A move lands only in its own pass, so a scale or
   * rotate pivots on its centre where it stood before this step's moves, a
   * dynamic move measures its gap before them, and a Follow sees everything
   * else this step did.
   * [gdp GJBaseGameLayer::processMoveActionsStep :469390-469401:
   *  processTransformActions, processRotationActions,
   *  processDynamicObjectActions(0), processMoveActions,
   *  processPlayerFollowActions, processFollowActions; the pivots read at
   *  :440326 and :439939, the gap at :445524-445526, and the moves applied
   *  by processMoveActions :427806-427835]
   */
  private stepCommands(dt: number, playerDx: number, playerDy: number, cameraDx: number, cameraDy: number, playerY: number): void {
    this.fork();
    // Where each followed object stands before anything moves this step. A
    // Follow copies how far that object has moved by the time the follows
    // run — whatever moved it: a move, a rotate about some other centre, a
    // scale, a Follow ahead of it in the list — and nothing that moved it
    // outside this pass. [gdp processFollowActions :428340-428420, which
    // measures from each object's position before its first change this step;
    // that stamp is bumped at the top of processCommands :464109]
    const followFrom = this.followFrom;
    followFrom.clear();
    let followers = false;
    for (const c of this.commands) {
      if (c.finished || c.paused || commandPass(c) >= 0) continue;
      followers = true;
      if (c.kind !== "follow" || followFrom.has(c.followGroup)) continue;
      const main = this.mainObject(c.followGroup);
      followFrom.set(
        c.followGroup,
        main >= 0
          ? (() => {
              const p = this.objectPosition(main);
              return [Math.fround(p[0]), Math.fround(p[1])];
            })()
          : null,
      );
    }
    // Without kA27 "Allow Multi-Rotation" only the newest rotate on each
    // target group turns it, one fresh this step included; the older ones run
    // their clocks on and lose this step's share. A keyframe that emits a
    // turn this step joins that list after its pose pass (it registers the
    // same way, :486625-486638). A dynamic aim joins without emptying it.
    // The port leaves its non-dynamic aim out too, although the game runs one
    // as an ordinary rotate over the trigger's duration: the port turns it at
    // once (see "aim" in stepOne), so there is no running command to weigh.
    // A 0° rotate is done as it is made: it is listed for its first step,
    // holding the others back, and then goes.
    // [gdp GJEffectManager::prepareMoveActions :486272-486289 (with +1064 =
    //  !kA27 each rotate empties its group's list before joining it; the list
    //  is rebuilt every step, :486170), processRotationActions :439888-439901
    //  (only listed commands turn anything), stepTransformCommand
    //  :716560-716590 (the share is spent either way); the dynamic aims
    //  :445609-445643; triggerRotateCommand :443855-443902 →
    //  createRotateCommand :489608-489645, no test of the angle; a 0° one is
    //  done at once, runRotateCommand :716195ff (+112, +114), and erased
    //  after that step, prepareMoveActions :486713-486718]
    const newest = this.newestRotate;
    newest.clear();
    for (let pass = 0; pass < COMMAND_PASSES; pass++) {
      if (pass === 1 && !this.multiRotation) {
        newest.clear();
        for (const c of this.commands) {
          if (c.finished || c.paused) continue;
          if (c.kind === "rotate") newest.set(c.group, c);
          else if (c.kind === "keyframe" && c.dueRotation !== 0) newest.set(c.group, c);
        }
      }
      for (const c of this.commands) {
        if (c.paused) continue;
        // A keyframe works its whole pose out with the scales, then hands
        // its turn to the rotate pass and its move to the move pass, as the
        // game's temporary commands do. [gdp prepareMoveActions :486588-486670]
        if (c.kind === "keyframe" && pass > 0) {
          this.handOverKeyframe(c, pass);
          continue;
        }
        if (c.finished || commandPass(c) !== pass) continue;
        this.stepOne(c, dt, playerDx, playerDy, cameraDx, cameraDy);
      }
    }
    if (followers) this.stepPlayerFollows(dt, playerY);
    this.stepAdvFollow(dt, playerY);
    if (followers) this.stepFollows(dt, followFrom);
    let finished = false;
    for (const c of this.commands) finished ||= c.finished;
    if (finished) this.commands = this.commands.filter((c) => !c.finished);
  }

  /**
   * Where the players stand for an area centred on one, in the port's frame,
   * before this step's update: player 2 only while a dual is on.
   */
  setAreaPlayers(x1: number, y1: number, p2: [number, number] | null): void {
    // A dual ending drops player 2's Ghost Trail with the player; starting
    // one does not copy player 1's. [toggleGhostEffect :92269-92276]
    if (!p2) this.visual.ghostTrail2 = false;
    this.areaP1x = x1;
    this.areaP1y = y1;
    this.areaP2 = p2;
  }

  // --- area triggers ---------------------------------------------------------

  /**
   * Area Move, Rotate and Scale, as the last part of the move step: every
   * push from the last step comes back out, then each running area, scales
   * first, then rotates, then moves, measures every object of its group from
   * its centre and pushes it by however much of its effect that distance
   * leaves. An object a later area reaches is measured where the earlier ones
   * this step have already put it.
   * [gdp processMoveActionsStep :469390-469401 → processAreaActions
   *  :469272-469352 → processAreaEffects :468901-469250; the push taken out
   *  before an object is measured, processAreaMoveGroupAction :437614]
   */
  /**
   * Area Move, Rotate and Scale only — once per physics step. Fade and Tint
   * run from updateVisuals, once a frame, as processAreaVisualActions does.
   * [gdp processAreaActions :469272-469352]
   */
  private stepAreas(dt: number): void {
    this.fork();
    const before = this.areaGroups;
    const offsets = new Map<number, AreaOffset>();
    const groups = new Set<number>();
    this.areaOffsets = offsets;
    for (const kind of [2, 1, 0] as const) {
      for (const a of this.areas) {
        if (a.kind === kind) this.stepAreaMotion(a, dt, offsets, groups);
      }
    }
    for (const g of before) this.markDirty(g);
    for (const g of groups) {
      this.noteMoved(g);
      this.markDirty(g);
    }
    this.areaGroups = groups.size > 0 ? [...groups] : [];
  }

  /** Area Fade and Tint, once a frame. [gdp processAreaVisualActions :470151-470155] */
  private stepAreaVisuals(dt: number): void {
    let any = false;
    for (const a of this.areas) {
      if (a.kind >= 3) {
        any = true;
        break;
      }
    }
    if (!any && this.areaVisuals.size === 0) return;
    // Tweens and the dual-easing counter mutate the instances; fork so a
    // checkpoint that shares them is not stepped.
    if (any) this.fork();
    const visuals = new Map<number, AreaVisual>();
    const fadeAt = new Map<number, number>();
    for (const kind of [3, 4] as const) {
      for (const a of this.areas) {
        if (a.kind === kind) this.stepAreaVisual(a, dt, visuals, fadeAt);
      }
    }
    this.areaVisuals = visuals.size > 0 ? visuals : NO_AREA_VISUALS;
  }

  private stepAreaTweens(a: AreaInstance, dt: number): void {
    // Edit Area's tweens land first. [gdp updateTransitions :717056-717096]
    if (a.tweens.length === 0) return;
    const v = a.vals;
    for (const t of a.tweens) {
      t.elapsed += dt;
      if (t.elapsed < t.duration) {
        v[t.key] = t.from + (t.to - t.from) * areaEase(t.elapsed / t.duration, t.easing, t.rate);
      } else v[t.key] = t.to;
    }
    a.tweens = a.tweens.filter((t) => t.elapsed < t.duration);
  }

  /**
   * The centre an area measures from: a group's main object, a player, or one
   * of the nine screen anchors (key 538 ≤ −3).
   * [gdp processAreaEffects :468953-469044]
   */
  private areaCentrePoint(centre: number): [number, number] | null {
    if (centre === -1 || centre === -2) {
      if (centre === -2 && this.areaP2) return this.areaP2;
      return [this.areaP1x, this.areaP1y];
    }
    if (centre < 0) {
      const box = this.areaViewBox();
      let ax: number;
      let ay: number;
      switch (centre) {
        case -4:
          ax = 0;
          ay = 0;
          break;
        case -5:
          ax = 0;
          ay = box.h * 0.5;
          break;
        case -6:
          ax = 0;
          ay = box.h;
          break;
        case -7:
          ax = box.w * 0.5;
          ay = 0;
          break;
        case -8:
          ax = box.w * 0.5;
          ay = box.h;
          break;
        case -9:
          ax = box.w;
          ay = 0;
          break;
        case -10:
          ax = box.w;
          ay = box.h * 0.5;
          break;
        case -11:
          ax = box.w;
          ay = box.h;
          break;
        default:
          ax = box.w * 0.5;
          ay = box.h * 0.5;
          break;
      }
      return [box.left + ax, box.bottom + ay];
    }
    const main = this.mainObject(centre);
    if (main < 0) return null;
    return this.objectPosition(main);
  }

  /**
   * The view as area screen centres use it: a 16:9 window about the camera
   * that follows player 1, the same size objectActive uses.
   * [gdp processAreaEffects :469006-469008; objectActive below]
   */
  private areaViewBox(): { left: number; bottom: number; w: number; h: number } {
    const cam = this.camera;
    const zoom = Math.min(8, Math.max(0.1, cam.zoom));
    const h = VIEW_UNITS_HIGH / zoom;
    const w = (h * 16) / 9;
    const go = this.passRotated ? cam.gameplayOffsetY : cam.gameplayOffsetX;
    const raw = this.passRotated ? cam.gameplayOffsetYRaw : cam.gameplayOffsetXRaw;
    const lead = ((this.viewReversed ? -1 : 1) * go) / (raw ? 1 : zoom);
    const cx = (cam.staticX.on ? cam.staticX.target : this.viewX + (this.passRotated ? 0 : lead)) + cam.offsetX;
    const cy = (cam.staticY.on ? cam.staticY.target : this.viewY + (this.passRotated ? lead : 0)) + cam.offsetY;
    return { left: cx - w / 2, bottom: cy - h / 2, w, h };
  }

  private stepAreaMotion(a: AreaInstance, dt: number, offsets: Map<number, AreaOffset>, groups: Set<number>): void {
    this.stepAreaTweens(a, dt);
    const centre = this.areaCentrePoint(a.centre);
    if (!centre) return;
    let [cx, cy] = centre;
    const v = a.vals;
    a.counter += 2;
    if (a.axis !== 0) {
      v[252] = v[220];
      v[253] = v[221];
    }
    cx += v[220];
    cy += v[252];
    if (a.twoSided) v[263] = -Math.abs(v[263]);
    const members = this.index.groups.get(a.group);
    if (!members) return;
    const rand = this.areaRand as AreaRandom;
    for (const i of members) {
      const [ox, oy] = this.objectPosition(i);
      const length = v[222] + v[223] * variance(rand, i, 223);
      const { v: at, side } = areaValue(
        a.axis,
        ox,
        oy,
        cx,
        cy,
        v[221] * variance(rand, i, 221),
        v[253] * variance(rand, i, 253),
        length,
        v[263],
        v[264],
        v[282],
        a.invert,
      );
      if (at >= 1) {
        if (a.dual) a.sides.set(i, 0);
        continue;
      }
      const strength = 1 - this.areaEased(a, i, at, side);
      let off = offsets.get(i);
      const fresh = off === undefined;
      if (!off) off = [0, 0, 0, 1, 1];
      if (a.kind === 0) {
        // [gdp processAreaMoveGroupAction :437621-437748]
        let dx: number;
        let dy: number;
        if (a.xy) {
          dx = (v[237] + v[238] * variance(rand, i, 238)) * strength;
          dy = (v[239] + v[240] * variance(rand, i, 240)) * strength;
        } else {
          let dist = v[218] + v[219] * variance(rand, i, 219);
          if (dist === 0) continue;
          let ux: number;
          let uy: number;
          if (a.radial) {
            const rx = ox - cx;
            const ry = oy - cy;
            const len = Math.hypot(rx, ry);
            const soft = Math.max(v[288], 0);
            if (len < soft) dist *= len / soft;
            ux = len <= 0 ? 0 : rx / len;
            uy = len <= 0 ? 0 : ry / len;
          } else {
            // Angle 0 points down. [ccpForAngle((deg - 90) * pi/180)]
            const rad = (v[231] + v[232] * variance(rand, i, 232) - 90) * 0.017453;
            ux = Math.cos(rad);
            uy = Math.sin(rad);
          }
          dx = dist * strength * ux;
          dy = dist * strength * uy;
        }
        if (dx === 0 && dy === 0) continue;
        off[0] += dx;
        off[1] += dy;
      } else if (a.kind === 1) {
        // [gdp processAreaRotateGroupAction :437436-437488]
        const turn = (v[270] + v[271] * variance(rand, i, 271)) * strength;
        if (turn === 0) continue;
        off[2] += turn;
      } else {
        // [gdp processAreaTransformGroupAction :437141-437208]
        const sx = v[233] + v[234] * variance(rand, i, 234);
        const sy = v[235] + v[236] * variance(rand, i, 236);
        if (sx === 0 && sy === 0) continue;
        off[3] *= (sx - 1) * strength + 1;
        off[4] *= (sy - 1) * strength + 1;
      }
      if (fresh) offsets.set(i, off);
      groups.add(a.group);
    }
  }

  private stepAreaVisual(
    a: AreaInstance,
    dt: number,
    visuals: Map<number, AreaVisual>,
    fadeAt: Map<number, number>,
  ): void {
    this.stepAreaTweens(a, dt);
    const centre = this.areaCentrePoint(a.centre);
    if (!centre) return;
    let [cx, cy] = centre;
    const v = a.vals;
    a.counter += 2;
    if (a.axis !== 0) {
      v[252] = v[220];
      v[253] = v[221];
    }
    cx += v[220];
    cy += v[252];
    if (a.twoSided) v[263] = -Math.abs(v[263]);
    const members = this.index.groups.get(a.group);
    if (!members) return;
    const rand = this.areaRand as AreaRandom;
    for (const i of members) {
      const [ox, oy] = this.objectPosition(i);
      const length = v[222] + v[223] * variance(rand, i, 223);
      const { v: at } = areaValue(
        a.axis,
        ox,
        oy,
        cx,
        cy,
        v[221] * variance(rand, i, 221),
        v[253] * variance(rand, i, 253),
        length,
        v[263],
        v[264],
        v[282],
        a.invert,
      );
      this.areaVisual(a, i, at, visuals, fadeAt);
    }
  }

  /**
   * An Area Fade or Tint reaching one object, at `at` of the way out (not
   * eased). A fade sets the opacity from key 286 at the centre to key 275 at
   * the edge and beyond, and of the fades on an object in one step the one it
   * is deepest into wins. A tint inside its area mixes key 265's share of its
   * channel in at the centre, less further out, or with key 278 shifts by its
   * HSV, scaled the same way.
   * [gdp processAreaFadeGroupAction :426992-427057 → GameObject::setAreaOpacity
   *  :167548-167566; processAreaTintGroupAction :427159-427395;
   *  EnterEffectInstance::loadValuesFromObject :717866-717869 (+120 key 265,
   *  +128 key 275, +132 key 286)]
   */
  private areaVisual(a: AreaInstance, i: number, at: number, visuals: Map<number, AreaVisual>, fadeAt: Map<number, number>): void {
    const v = a.vals;
    let entry = visuals.get(i);
    if (a.kind === 3) {
      const best = fadeAt.get(i);
      if (best !== undefined && at >= best) return;
      fadeAt.set(i, at);
      if (!entry) visuals.set(i, (entry = { opacity: undefined, tints: [] }));
      entry.opacity = Math.max(0, Math.min(1, v[286] + (v[275] - v[286]) * at));
      return;
    }
    const tint = a.tint;
    if (!tint || at >= 1 || (!tint.main && !tint.detail)) return;
    if (!entry) visuals.set(i, (entry = { opacity: undefined, tints: [] }));
    entry.tints.push({ ...tint, value: at, percent: v[265] });
  }

  /** What the Area Fade and Tint triggers do to an object this step, if anything. */
  areaVisualOf(objectIndex: number): AreaVisual | undefined {
    return this.areaVisuals.size > 0 ? this.areaVisuals.get(objectIndex) : undefined;
  }

  /**
   * One object's eased distance. With dual easing the side of the centre it
   * is on picks the curve, and the side it was on last step holds until it
   * is clear of the ends.
   * [gdp GJBaseGameLayer::getEasedAreaValue :426878-426945]
   */
  private areaEased(a: AreaInstance, object: number, at: number, side: boolean): number {
    if (!a.dual) return areaEase(at, a.easing, a.rate);
    let s = side;
    if (at > 0.01 && at < 0.99) {
      const c = a.counter;
      const tag = a.sides.get(object) ?? 0;
      if (tag === c - 2) s = false;
      else if (tag === c - 1) s = true;
      a.sides.set(object, c + (s ? 1 : 0));
    }
    return s ? areaEase(at, a.easing, a.rate) : areaEase(at, a.easing2, a.rate2);
  }

  /**
   * Area Move, Rotate or Scale fired: a fresh instance, or the same trigger's
   * running one reloaded when it targets the same groups. A non-zero Area
   * Effect ID replaces whichever running area had it.
   * [gdp GJBaseGameLayer::addAreaEffect :467774-467869; key 226 and key 342
   *  read over keys 51, 71 and 538 at customObjectSetup :300240-300259;
   *  compEnterEffectSort :415080-415095]
   */
  private runArea(spec: TriggerSpec, kind: 0 | 1 | 2 | 3 | 4): void {
    if (!this.areaRand) return;
    this.fork();
    const group = this.grp(int(spec, 226) || int(spec, 51));
    let centreGroup = int(spec, 71);
    let centreOverride = int(spec, 538);
    const alias = int(spec, 342);
    if (alias > 0) centreGroup = alias;
    else if (alias < 0) centreOverride = alias;
    centreGroup = this.grp(centreGroup);
    const controlId = int(spec, 534);
    const vals: Record<number, number> = {};
    for (const k of AREA_FIELDS) vals[k] = num(spec, k);
    const same = this.areas.find(
      (a) => a.source === spec.index && a.group === group && a.centreGroup === centreGroup && a.controlId === controlId,
    );
    if (same) {
      same.vals = vals;
      return;
    }
    const effectId = int(spec, 225);
    let list = this.areas;
    if (effectId > 0) {
      const at = list.findIndex((a) => a.kind === kind && a.effectId === effectId);
      if (at >= 0) list = list.filter((_, j) => j !== at);
    }
    const area: AreaInstance = {
      source: spec.index,
      kind,
      group,
      centreGroup,
      centre: centreOverride !== 0 ? centreOverride : centreGroup,
      controlId,
      effectId,
      priority: int(spec, 341),
      axis: int(spec, 262),
      xy: flag(spec, 241),
      radial: flag(spec, 287),
      dual: flag(spec, 261),
      invert: flag(spec, 276),
      twoSided: flag(spec, 283),
      easing: int(spec, 242),
      rate: areaRate(num(spec, 243)),
      easing2: int(spec, 248),
      rate2: areaRate(num(spec, 249)),
      vals,
      tweens: [],
      counter: 0,
      sides: new Map(),
      // [gdp EnterEffectObject::customObjectSetup :300089-300092 (260),
      //  :300185-300212 (65, 66, 278 with 49)]
      tint:
        kind === 4
          ? { channel: int(spec, 260), main: !flag(spec, 66), detail: !flag(spec, 65), hsv: flag(spec, 278) ? parseHsv(spec.props[49]) : null }
          : null,
    };
    this.areas = [...list, area].sort((x, y) => y.priority - x.priority);
  }

  /**
   * Edit Area: the running areas started by the triggers in key 51's group,
   * or with key 355 the one with that Area Effect ID, tween every field this
   * trigger sets to its value over key 10 seconds.
   * [gdp triggerAreaEffectAnimation :426494-426620; loadTransitions
   *  :717409-717762]
   */
  private runAreaEdit(spec: TriggerSpec): void {
    if (this.areas.length === 0) return;
    this.fork();
    const target = this.grp(int(spec, 226) || int(spec, 51));
    const byId = flag(spec, 355);
    const sources = byId ? null : new Set(this.index.groups.get(target) ?? []);
    const taken = new Set<number>();
    for (const a of this.areas) {
      if (byId) {
        if (a.effectId !== target || (target > 0 && taken.has(a.kind))) continue;
        taken.add(a.kind);
      } else if (!sources?.has(a.source)) continue;
      for (const k of AREA_EDITABLE) {
        const raw = spec.props[k];
        if (raw === undefined) continue;
        const to = Number(raw);
        if (!Number.isFinite(to) || to === AREA_UNSET) continue;
        a.tweens = a.tweens.filter((t) => t.key !== k);
        a.tweens.push({
          key: k,
          from: a.vals[k],
          to,
          elapsed: 0,
          duration: num(spec, 10),
          easing: int(spec, 242),
          rate: areaRate(num(spec, 243)),
        });
      }
    }
  }

  /**
   * Area Stop: the running area whose Area Effect ID is this trigger's key 51
   * goes, one of each kind.
   * [gdp dispatch :315001 → controlAreaEffectWithID :467943-468039]
   */
  private runAreaStop(spec: TriggerSpec): void {
    const id = int(spec, 51);
    if (this.areas.length === 0) return;
    const drop = new Set<AreaInstance>();
    const seen = new Set<number>();
    for (const a of this.areas) {
      if (a.effectId !== id || (id > 0 && seen.has(a.kind))) continue;
      seen.add(a.kind);
      drop.add(a);
    }
    if (drop.size === 0) return;
    this.fork();
    this.areas = this.areas.filter((a) => !drop.has(a));
  }

  /** One step of one command other than the two follows. */
  private stepOne(c: Command, dt: number, playerDx: number, playerDy: number, cameraDx: number, cameraDy: number): void {
    if (c.kind === "keyframe") {
      this.stepKeyframe(c, dt);
      return;
    }
    const wasFresh = c.fresh;
    stepCommand(c, dt);
    if (c.kind === "rotate" && c.angle === 0) {
      // Its one step as the newest on its group is all a 0° rotate does.
      c.finished = true;
      return;
    }
    if (c.kind === "move" && c.dynamic) {
      this.stepDynamicMove(c, wasFresh);
      return;
    }
    // Nothing moves on the tick a command is created, so a zero-duration move
    // teleports on the tick after the trigger fires, not on it.
    // [gdp GroupCommandObject2::reset :716879 and step :716512-716516]
    if (wasFresh) return;
    const f = commandProgress(c);
    switch (c.kind) {
      case "move": {
        let stepX: number;
        let stepY: number;
        if (c.lockPlayerX) stepX = playerDx * c.modX;
        else if (c.lockCameraX) stepX = cameraDx * c.modX;
        else {
          const absX = c.dx * f;
          stepX = absX - c.appliedX;
          c.appliedX = absX;
        }
        if (c.lockPlayerY) stepY = playerDy * c.modY;
        else if (c.lockCameraY) stepY = cameraDy * c.modY;
        else {
          const absY = c.dy * f;
          stepY = absY - c.appliedY;
          c.appliedY = absY;
        }
        if (stepX !== 0 || stepY !== 0) this.translateGroup(c.group, stepX, stepY);
        break;
      }
      case "rotate": {
        const abs = c.angle * f;
        const step = abs - c.appliedAngle;
        c.appliedAngle = abs;
        const listed = this.multiRotation || this.newestRotate.get(c.group) === c;
        if (step !== 0 && listed) this.rotateGroup(c.group, c.centre, step, c.lockRotation);
        break;
      }
      case "scale": {
        const now = f;
        const prev = c.appliedAngle;
        c.appliedAngle = now;
        const sx = (c.scaleX - 1) * now + 1;
        const sy = (c.scaleY - 1) * now + 1;
        const psx = (c.scaleX - 1) * prev + 1;
        const psy = (c.scaleY - 1) * prev + 1;
        this.scaleGroup(c.group, c.centre, safeRatio(sx, psx), safeRatio(sy, psy));
        break;
      }
      case "alpha": {
        const a = c.fromAlpha + (c.toAlpha - c.fromAlpha) * f;
        this.groupAlpha[c.group] = a;
        break;
      }
      case "aim": {
        // Turn the group so it points at another group, and keep pointing if
        // the trigger asked for that. Dynamic mode closes key 403's share of
        // the remaining angle each step (at least 1). [gdp :445487-445490]
        const want = this.aimAngle(c.centre > 0 ? c.centre : c.group, c.followGroup);
        if (want !== null) {
          const target = want + c.angleOffset;
          const delta = wrapDegrees(target - this.groupSpin[c.group]);
          if (delta !== 0) {
            const step = c.dynamic ? delta / Math.max(1, c.easing | 0) : delta;
            this.rotateGroup(c.group, c.centre, step, false);
          }
        }
        if (!c.dynamic) c.finished = true;
        break;
      }
    }
  }

  /**
   * One step of a keyframe animation. Its clock runs from the first step,
   * the one after the trigger fired. The pose is worked out whole, the scale
   * is applied now (a change of less than a hundredth's size is not), and
   * the turn and the move wait for their passes; nodes reached spawn their
   * groups, once each, at once or after their delay.
   * [gdp GJEffectManager::prepareMoveActions :486386-486710]
   */
  private stepKeyframe(c: Command, dt: number): void {
    const path = c.path;
    if (!path) {
      c.finished = true;
      return;
    }
    c.elapsed += dt;
    const due: number[] = [];
    const pose = keyframePose(
      path,
      c.elapsed,
      this.keyframeOut,
      (k) => c.spawned.includes(k),
      (k) => due.push(k),
    );
    c.dueX = pose.x - c.poseX;
    c.dueY = pose.y - c.poseY;
    c.poseX = pose.x;
    c.poseY = pose.y;
    c.dueRotation = pose.rotation - c.poseRotation;
    c.poseRotation = pose.rotation;
    if (Math.abs(pose.scaleX) >= 0.01 && Math.abs(pose.scaleY) >= 0.01) {
      if (pose.scaleX !== c.poseScaleX || pose.scaleY !== c.poseScaleY) {
        // The game's temp transform sets relativeRotation, so the scale axes
        // follow the centre's current turn. [gdp prepareMoveActions :486661]
        const along = this.centreAngle(c.centre > 0 ? c.centre : c.group);
        this.scaleGroup(
          c.group,
          c.centre,
          safeRatio(pose.scaleX, c.poseScaleX),
          safeRatio(pose.scaleY, c.poseScaleY),
          along,
        );
      }
      c.poseScaleX = pose.scaleX;
      c.poseScaleY = pose.scaleY;
    }
    if (c.elapsed >= c.duration) c.finished = true;
    if (due.length === 0) return;
    c.spawned = [...c.spawned, ...due];
    const chain = unflatten(c.remap);
    for (const k of due) {
      const node = path.nodes[k];
      const group = this.grp(node.spawnGroup);
      if (node.spawnDelay <= 0) {
        this.spawnGroup(group, c.trigger, false, 0, 0, chain);
        continue;
      }
      this.spawns = [
        ...this.spawns,
        { group, object: -1, remaining: node.spawnDelay, spawner: c.trigger, ordered: false, baseDelay: 0, remap: c.remap },
      ];
    }
  }

  private readonly keyframeOut: KeyframePose = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

  /** A keyframe's turn in the rotate pass, and its move in the move pass. */
  private handOverKeyframe(c: Command, pass: number): void {
    if (pass === 1 && c.dueRotation !== 0) {
      // Spend the share either way; only the listed command turns anything.
      // [gdp stepTransformCommand :716560-716590; processRotationActions
      //  :439888-439901]
      const listed = this.multiRotation || this.newestRotate.get(c.group) === c;
      if (listed) this.rotateGroup(c.group, c.centre, c.dueRotation, false);
      c.dueRotation = 0;
    } else if (pass === 3 && (c.dueX !== 0 || c.dueY !== 0)) {
      this.translateGroup(c.group, c.dueX, c.dueY);
      c.dueX = 0;
      c.dueY = 0;
    }
  }

  /** A group's main object's turn now: its own angle plus what its groups have spun. */
  private centreAngle(group: number): number {
    const pivot = this.mainObject(group);
    if (pivot < 0) return group > 0 && group < this.index.groupCount ? this.groupSpin[group] : 0;
    const o = this.level.objects[pivot];
    let angle = o.rotation;
    if (this.objectTransform(pivot, this.blockScratch)) angle += this.blockScratch[6];
    return angle;
  }

  /**
   * A dynamic move re-aims every step: it covers this step's share of what is
   * left of its eased curve, times the gap between its two ends as they stand
   * now, so a target that moves is still met. With no duration it closes the
   * whole gap, on every step for one that runs for ever (-1), on its first
   * alone otherwise. Both ends are any member, whatever kA40 says, and it
   * measures from the key 395 group when there is one.
   * [gdp activateMoveTrigger :443564-443569 → triggerDynamicMoveCommand
   *  :443366-443376 (tryGetObject; +1340 before +1276);
   *  processDynamicObjectActions :445453-445540: active while time is left,
   *  for ever at -1, and on the first step :445457; the share :445512-445520,
   *  1 for no duration :445523; the gap now :445524-445526]
   */
  private stepDynamicMove(c: Command, fresh: boolean): void {
    let share = 1;
    if (c.duration > 0) {
      // The first step leaves the curve at 0, so it moves nothing.
      if (fresh) return;
      const prev = c.appliedAngle;
      const now = commandProgress(c);
      c.appliedAngle = now;
      share = prev !== 1 ? (now - prev) / (1 - prev) : 0;
    } else if (!fresh && c.duration !== -1) {
      return;
    }
    const to = this.positionOf(this.targetObject(c.followGroup));
    const from = this.positionOf(this.targetObject(c.centre > 0 ? c.centre : c.group));
    if (!to || !from || share === 0) return;
    const dx = (to[0] - from[0]) * share;
    const dy = (to[1] - from[1]) * share;
    if (dx !== 0 || dy !== 0) this.translateGroup(c.group, dx, dy);
  }

  /** Scratch for stepCommands: each followed group's main object before this step, or null without one. */
  private readonly followFrom = new Map<number, [number, number] | null>();
  /** Scratch for stepCommands: the newest live rotate on each target group, filled only without kA27. */
  private readonly newestRotate = new Map<number, Command>();

  /**
   * The game's lifetime for the two follow commands, which differs from the
   * eased ones: the clock runs from the first step, and the step after the
   * command's time is up still runs it, once more, before it goes. The clock
   * adds the float step, so half a second is 120 steps, not 121.
   * [gdp GroupCommandObject2::step :716494-716541 (no first-step hold without
   *  an easing; the float step into a double at :716512), prepareMoveActions
   *  :486292-486338, :486372-486375 (a finished follow still gets its node,
   *  marked +120) and :486713-486718, then postMoveActions :480933-480975
   *  erases it; the float step from GJBaseGameLayer::update :469891]
   * Returns false for a command that sits this step out.
   */
  private stepFollowLife(c: Command, dt: number): boolean {
    if (c.finished || c.paused) return false;
    if (c.lingering) {
      c.finished = true;
      return true;
    }
    stepCommand(c, Math.fround(dt));
    if (c.finished) {
      c.finished = false;
      c.lingering = true;
    }
    return true;
  }

  /**
   * Follow: each target group takes its followed object's movement this step,
   * scaled by the two mods. Commands with the same pair of groups share one
   * move a step, the latest one's mods, in the place of the earliest.
   * [gdp processFollowActions :428340-428420; one CCMoveCNode per
   *  followed + 1000 x target in prepareMoveActions :486292-486338]
   */
  private stepFollows(dt: number, followFrom: Map<number, [number, number] | null>): void {
    const pairs = new Map<number, Command>();
    const live: Command[] = [];
    for (const c of this.commands) {
      if (c.kind !== "follow" || !this.stepFollowLife(c, dt)) continue;
      const key = c.followGroup + 1000 * c.group;
      if (!pairs.has(key)) live.push(c);
      pairs.set(key, c);
    }
    for (const first of live) {
      const mods = pairs.get(first.followGroup + 1000 * first.group) ?? first;
      const from = followFrom.get(first.followGroup);
      if (!from) continue;
      const main = this.mainObject(first.followGroup);
      if (main < 0) continue;
      // The game diffs float copies of the position, so a leader a float
      // cannot place exactly creeps the follower a little every step.
      // [gdp processFollowActions :428340-428420]
      const now = this.objectPosition(main);
      const dx = (Math.fround(now[0]) - Math.fround(from[0])) * mods.followModX;
      const dy = (Math.fround(now[1]) - Math.fround(from[1])) * mods.followModY;
      if (dx !== 0 || dy !== 0) this.translateGroup(first.group, dx, dy);
    }
  }

  /**
   * Follow Player Y: each step the group closes a share of the gap between
   * its y and player 1's y as it was `delay` seconds ago, plus the offset.
   * The share is speed x the step in 60ths, at most all of it, and the move
   * is held to max speed x the same when max speed is set. Each member closes
   * its own gap from where it is now, so members at different heights, or
   * carried apart by other groups, all converge. One command a group: the
   * latest one's settings win.
   * [gdp processPlayerFollowActions :427914-428015; one node a group in
   *  prepareMoveActions :486339-486375; keys 90, 91, 92, 105 from
   *  EffectGameObject::customObjectSetup :299193-299231]
   */
  private stepPlayerFollows(dt: number, playerY: number): void {
    const byGroup = new Map<number, Command>();
    for (const c of this.commands) {
      if (c.kind !== "followPlayerY" || !this.stepFollowLife(c, dt)) continue;
      byGroup.set(c.group, c);
    }
    const perFrame = Math.fround(dt * 60);
    for (const [group, c] of byGroup) {
      const members = this.index.groups.get(group);
      if (!members || members.length === 0) continue;
      const share = Math.fround(Math.min(1, Math.max(0, perFrame * c.followSpeed)));
      const cap = Math.fround(c.followMaxSpeed * perFrame);
      const was = this.oldPlayerY(c.followDelay, playerY);
      if (was === 0) continue;
      const target = Math.fround(was + c.followOffset);
      let moved = false;
      for (const i of members) {
        const y = Math.fround(this.objectPosition(i)[1] + GAME_GROUND_Y);
        let step = Math.fround(Math.fround(target - y) * share);
        if (step === 0) continue;
        if (cap > 0) step = step > cap ? cap : step < -cap ? -cap : step;
        if (!moved) {
          this.fork();
          moved = true;
        }
        (this.followDy as Float64Array)[i] += step;
      }
      if (!moved) continue;
      this.followGroups.add(group);
      this.noteMoved(group);
      this.markDirty(group);
    }
  }

  /**
   * Player 1's game y `delay` seconds ago: the current one for no delay, else
   * the slot that many hundredths back, at most 199.
   * [gdp PlayerObject::getOldPosition :142151-142165]
   */
  private oldPlayerY(delay: number, playerY: number): number {
    if (delay <= 0 || !this.yHistory) return Math.fround(playerY + GAME_GROUND_Y);
    const back = Math.min(Y_HISTORY_SLOTS - 1, Math.floor(Math.fround(delay / Y_HISTORY_STEP)));
    let slot = (this.yHistoryAt % Y_HISTORY_SLOTS) - back;
    if (slot < 0) slot += Y_HISTORY_SLOTS;
    return this.yHistory[slot];
  }

  /**
   * Records player 1's y after its update, for Follow Player Y's delay. A
   * no-op in a level without one that has a delay. The clock is a float and
   * so is the step it adds.
   * [gdp PlayerObject::updateSpecial :142088-142110, called with the float
   *  step after player 1's collisions in GJBaseGameLayer::update :469925]
   */
  recordPlayerY(worldY: number, dt: number): void {
    if (!this.yHistory) return;
    this.fork();
    const history = this.yHistory as Float32Array;
    let clock = Math.fround(Math.fround(dt) + this.yHistoryClock);
    if (clock >= Y_HISTORY_STEP) {
      this.yHistoryAt++;
      clock = Math.fround(clock - Y_HISTORY_STEP);
    }
    this.yHistoryClock = clock;
    history[this.yHistoryAt % Y_HISTORY_SLOTS] = worldY + GAME_GROUND_Y;
  }

  private translateGroup(group: number, dx: number, dy: number, silent = false): void {
    if (group <= 0 || group >= this.index.groupCount) return;
    this.fork();
    const at = group * M;
    this.groupM[at + 4] += dx;
    this.groupM[at + 5] += dy;
    this.noteMoved(group);
    this.markDirty(group);
    if (silent) this.silentDirty.add(group);
  }

  /**
   * Turns a group about where its centre group's main object is now. With no
   * main object — no centre, or a centre of several objects and no parent —
   * the objects only spin where they stand.
   * [gdp GJBaseGameLayer::processRotationActions :439909 (tryGetMainObject),
   *  :439939 (getUnmodifiedPosition: its current position), :439948-440032]
   */
  private rotateGroup(group: number, centre: number, degrees: number, lockRotation: boolean): void {
    if (group <= 0 || group >= this.index.groupCount) return;
    this.fork();
    this.noteMoved(group);
    if (!lockRotation) this.groupSpin[group] += degrees;
    const pivot = this.mainObject(centre);
    if (pivot >= 0) {
      const o = this.pivotAt(pivot);
      const rad = (-degrees * Math.PI) / 180; // clockwise positive, like key 6
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const at = group * M;
      const a = this.groupM[at];
      const b = this.groupM[at + 1];
      const c = this.groupM[at + 2];
      const d = this.groupM[at + 3];
      const tx = this.groupM[at + 4] - o.x;
      const ty = this.groupM[at + 5] - o.y;
      this.groupM[at] = a * cos - b * sin;
      this.groupM[at + 1] = a * sin + b * cos;
      this.groupM[at + 2] = c * cos - d * sin;
      this.groupM[at + 3] = c * sin + d * cos;
      this.groupM[at + 4] = o.x + tx * cos - ty * sin;
      this.groupM[at + 5] = o.y + tx * sin + ty * cos;
    }
    this.markDirty(group);
  }

  /**
   * Scale about the centre where it is now. `along` turns the scale axes (a
   * keyframe's temp transform sets relativeRotation so they follow the
   * centre). A non-uniform scale after a rotate leaves shear in the group
   * affine; the draw list's carry applies that whole matrix, which is what
   * the game gets by decomposing each object's scale/rotation/skew.
   * [gdp processTransformActions :440221, :440265-440490]
   */
  private scaleGroup(group: number, centre: number, sx: number, sy: number, along = 0): void {
    if (group <= 0 || group >= this.index.groupCount) return;
    if (sx === 1 && sy === 1) return;
    if (along !== 0) {
      // R(-along) ∘ S ∘ R(along) about the centre, without touching groupSpin.
      this.rotateGroup(group, centre, -along, true);
      this.scaleGroup(group, centre, sx, sy, 0);
      this.rotateGroup(group, centre, along, true);
      return;
    }
    this.fork();
    this.noteMoved(group);
    this.groupScale[group * 2] *= sx;
    this.groupScale[group * 2 + 1] *= sy;
    const pivot = this.mainObject(centre);
    if (pivot >= 0) {
      const o = this.pivotAt(pivot);
      const at = group * M;
      this.groupM[at] *= sx;
      this.groupM[at + 1] *= sy;
      this.groupM[at + 2] *= sx;
      this.groupM[at + 3] *= sy;
      this.groupM[at + 4] = o.x + (this.groupM[at + 4] - o.x) * sx;
      this.groupM[at + 5] = o.y + (this.groupM[at + 5] - o.y) * sy;
    }
    this.markDirty(group);
  }

  /**
   * Where one object has been carried to, composed over every moving group it
   * belongs to, then lifted by Follow Player Y's own move. Fills nine numbers — the affine, then the self-spin and the two
   * scale factors — and answers false when the object has not moved, which is
   * the answer for all but a few thousand objects in the busiest level.
   *
   * An object that keeps its angle (see fixedAngle) gets no turn at all: its
   * own point goes where the affine takes it, and the rest of it follows that
   * point, scaled by its groups but never turned. So its linear part is the
   * two scale factors alone and its self-spin is 0.
   *
   * The collision geometry and the draw list both go through here, so the
   * hitboxes and the art move together.
   */
  objectTransform(objectIndex: number, out: Float64Array): boolean {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    out[4] = 0;
    out[5] = 0;
    out[6] = 0;
    out[7] = 1;
    out[8] = 1;
    const o = this.level.objects[objectIndex];
    if (!o || o.groups.length === 0 || !this.motion) return false;
    const turns = this.fixedAngle === null || this.fixedAngle[objectIndex] === 0;
    let any = false;
    for (const g of o.groups) {
      if (!this.movedGroups.has(g)) continue;
      any = true;
      const at = g * M;
      const ga = this.groupM[at];
      const gb = this.groupM[at + 1];
      const gc = this.groupM[at + 2];
      const gd = this.groupM[at + 3];
      const gtx = this.groupM[at + 4];
      const gty = this.groupM[at + 5];
      const a = ga * out[0] + gc * out[1];
      const b = gb * out[0] + gd * out[1];
      const c = ga * out[2] + gc * out[3];
      const d = gb * out[2] + gd * out[3];
      const tx = ga * out[4] + gc * out[5] + gtx;
      const ty = gb * out[4] + gd * out[5] + gty;
      out[0] = a;
      out[1] = b;
      out[2] = c;
      out[3] = d;
      out[4] = tx;
      out[5] = ty;
      if (turns) out[6] += this.groupSpin[g];
      out[7] *= this.groupScale[g * 2];
      out[8] *= this.groupScale[g * 2 + 1];
    }
    const lift = this.followDy === null ? 0 : this.followDy[objectIndex];
    if (lift !== 0) {
      out[5] += lift;
      any = true;
    }
    if (this.advMotion) {
      const mot = objectIndex * 3;
      const ax = this.advMotion[mot];
      const ay = this.advMotion[mot + 1];
      const ar = this.advMotion[mot + 2];
      if (ax !== 0 || ay !== 0 || ar !== 0) {
        out[4] += ax;
        out[5] += ay;
        if (ar !== 0) out[6] += ar;
        any = true;
      }
    }
    if (this.areaOffsets.size > 0) {
      const area = this.areaOffsets.get(objectIndex);
      if (area) {
        out[4] += area[0];
        out[5] += area[1];
        out[6] += area[2];
        out[7] *= area[3];
        out[8] *= area[4];
        any = true;
      }
    }
    if (any && !turns) {
      // Round the centre without turning: the object's point through the
      // whole affine, and the object about that point only scaled.
      // [gdp processRotationActions :440000-440004 (the move, either way),
      //  :440008-440016 (addRotation, only with +728)]
      const px = out[0] * o.x + out[2] * o.y + out[4];
      const py = out[1] * o.x + out[3] * o.y + out[5];
      out[0] = out[7];
      out[1] = 0;
      out[2] = 0;
      out[3] = out[8];
      out[4] = px - out[7] * o.x;
      out[5] = py - out[8] * o.y;
    }
    return any;
  }

  /** One group id, read through whatever remap the current dispatch carries. */
  private grp(id: number): number {
    const remap = this.activeRemap;
    if (!remap || id <= 0) return id;
    return remap.get(id) ?? id;
  }

  /** Where one object is right now, carried by every group it is in. */
  objectPosition(index: number): [number, number] {
    const o = this.level.objects[index];
    const m = this.blockScratch;
    this.objectTransform(index, m);
    return [m[0] * o.x + m[2] * o.y + m[4], m[1] * o.x + m[3] * o.y + m[5]];
  }

  /** objectPosition into `out`, for a caller that asks every frame. */
  objectPositionTo(index: number, out: [number, number]): [number, number] {
    const o = this.level.objects[index];
    const m = this.blockScratch;
    this.objectTransform(index, m);
    out[0] = m[0] * o.x + m[2] * o.y + m[4];
    out[1] = m[1] * o.x + m[3] * o.y + m[5];
    return out;
  }

  /** A pivot's current position, as rotateGroup and scaleGroup want it. */
  private pivotAt(index: number): { x: number; y: number } {
    const [x, y] = this.objectPosition(index);
    return { x, y };
  }

  /** Where an object is right now, or null for no object. */
  private positionOf(index: number): [number, number] | null {
    return index < 0 ? null : this.objectPosition(index);
  }

  /**
   * The clockwise angle from one group to another, in the same degrees the rest
   * of the port uses — so zero points right and ninety points down.
   */
  private aimAngle(fromGroup: number, toGroup: number): number | null {
    const from = this.positionOf(this.targetObject(fromGroup));
    const to = this.positionOf(this.targetObject(toGroup));
    if (!from || !to) return null;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    if (dx === 0 && dy === 0) return null;
    return (-Math.atan2(dy, dx) * 180) / Math.PI;
  }

  /**
   * The one object that stands for a group: its parent (key 274), else its
   * only member; none for a group of several with no parent. Rotate and scale
   * centres, Follow, the static camera and the camera edges all use this.
   * [gdp GJBaseGameLayer::tryGetMainObject :423396-423405,
   *  getSingleGroupObject :423244-423251]
   */
  private mainObject(group: number): number {
    if (group <= 0) return -1;
    const parent = this.index.parents.get(group);
    if (parent !== undefined) return parent;
    const list = this.index.groups.get(group);
    return list && list.length === 1 ? list[0] : -1;
  }

  /**
   * The main object, or failing that any member: an aim, a teleport. The game
   * picks that member with its unseeded fast_rand, which no replay could
   * follow; the first member stands in for it.
   * [gdp GJBaseGameLayer::tryGetObject :424989-425015; getRotateCommandTargets
   *  :425163-425197]
   */
  private targetObject(group: number): number {
    const main = this.mainObject(group);
    if (main >= 0) return main;
    const list = group > 0 ? this.index.groups.get(group) : undefined;
    return list && list.length > 0 ? list[0] : -1;
  }

  /** tryGetMainObject for the sim: a group's parent, else its only member, else -1. */
  mainObjectOf(group: number): number {
    return this.mainObject(group);
  }

  /** The objects in a group (getGroup), for the audio side's proximity. */
  groupMembers(group: number): readonly number[] {
    return group > 0 ? (this.index.groups.get(group) ?? []) : [];
  }

  /** tryGetObject for the sim: the main object, else the first member, else -1 (see targetObject). */
  targetObjectOf(group: number): number {
    return this.targetObject(group);
  }

  /**
   * A group spawned by the level itself rather than by a trigger — a
   * platformer checkpoint's keys 51 and 448 — at once and with no remap.
   */
  spawnFromLevel(group: number, spawner: number): void {
    this.spawnGroup(group, spawner, false, 0, 0);
    this.spawnGuard.clear();
  }

  /**
   * The object a teleport sends the player to: the only member of its group,
   * or none for an empty group. The game picks among several with its own
   * generator (qword_A9C810, which no replay seeds); the first member stands
   * in for it. A parent (key 274) has no say here.
   * [gdp GJBaseGameLayer::getPortalTarget, gd-ida-decomp.cpp:422931-422962]
   */
  portalTarget(group: number): number {
    const list = group > 0 ? this.index.groups.get(group) : undefined;
    return list && list.length > 0 ? list[0] : -1;
  }

  /**
   * The two ends of a target-mode Move that is not dynamic: any member in a
   * level with the 2.2 changes on (kA40, forced for Dash and the platformer
   * floors), only the main object in an older one. A dynamic Move takes any
   * member either way. [gdp getMoveTargetDelta :425096-425145, called with
   *  !(+1547) at :443607; +1547 from resetLevelVariables :462937-462940]
   */
  private moveTargetObject(group: number): number {
    return this.changes22 ? this.targetObject(group) : this.mainObject(group);
  }

  // --- firing ----------------------------------------------------------------

  private hasFired(spec: TriggerSpec, player: 1 | 2): boolean {
    const slot = this.firedSlot[spec.index];
    if (slot < 0) return false;
    const bit = spec.sharedPlayer ? 1 : player === 1 ? 1 : 2;
    return (this.fired[slot] & bit) !== 0;
  }

  private markFired(spec: TriggerSpec, player: 1 | 2): void {
    const slot = this.firedSlot[spec.index];
    if (slot < 0) return;
    this.fork();
    this.fired[slot] |= spec.sharedPlayer ? 1 : player === 1 ? 1 : 2;
  }

  /** Fires one trigger, with a depth guard so a spawn ring cannot run away. */
  private activate(spec: TriggerSpec, player: 1 | 2, depth: number, remap: Remap = null): void {
    if (!spec.multi) {
      if (this.hasFired(spec, player)) return;
      this.markFired(spec, player);
    }
    const outer = this.activeRemap;
    this.activeRemap = remap;
    try {
      this.dispatch(spec, player, depth, remap);
    } finally {
      this.activeRemap = outer;
    }
  }

  /**
   * Fires a group's triggers. A disabled group cannot be spawned at all, and a
   * group can only be spawned once per tick per spawner, which is what stops an
   * infinite chain. [gdp GJBaseGameLayer::spawnGroup :443163-443230]
   */
  private spawnGroup(group: number, spawner: number, ordered: boolean, baseDelay: number, depth: number, remap: Remap = null): void {
    if (group <= 0 || depth > MAX_SPAWN_DEPTH) return;
    if (group < this.index.groupCount && this.groupEnabled[group] === 0) return;
    const members = this.index.groups.get(group);
    if (!members) return;
    // Two spawns of one group in a tick collapse into one — unless they carry
    // different remaps, in which case they are genuinely different work.
    const key = group * 1_000_003 + spawner + Math.imul(remapKey(remap), 31);
    if (this.spawnGuard.has(key)) return;
    this.spawnGuard.add(key);
    if (!ordered) {
      for (const index of members) this.spawnObject(index, depth, remap);
      return;
    }
    // Ordered spawn staggers the members by how far apart they are, converted
    // to time at 1x scroll speed, from the first member the game would spawn
    // at all — by id, whether or not that one opted in to being spawned, and
    // whether or not the port runs it as a trigger (a checkpoint that is not
    // spawn-only, or a collision state block, sets the base too). A particle
    // object (2065) counts when its key 123 (+1229) is set. The distances are from
    // where the members are now, so a moved group staggers by its moved
    // spacing; only the load-time sort goes by the file's x.
    // [gdp spawnObjectsInOrder :421726-421805, getPosition :421760-421770;
    //  isSpawnableTrigger :173769-173930]
    let x0: number | null = null;
    for (const index of members) {
      const o = this.level.objects[index];
      if (!(o.id === 2065 ? objectFlag(o, OBJECT_KEY.animateOnTrigger) : isSpawnableTrigger(o.id))) continue;
      if (x0 === null) {
        x0 = this.objectPosition(index)[0];
        this.spawnObject(index, depth, remap);
        continue;
      }
      if (!this.index.byObject.has(index)) continue; // nothing here for the port to run
      const t = (this.objectPosition(index)[0] - x0) / SPAWN_SPEED - baseDelay;
      if (t <= 0) this.spawnObject(index, depth, remap);
      else this.queueSpawnObject(index, t, remap);
    }
  }

  private readonly spawnGuard = new Set<number>();

  private queueSpawnObject(index: number, delay: number, remap: Remap): void {
    this.fork();
    this.spawns = [
      ...this.spawns,
      { group: 0, object: index, remaining: delay, spawner: index, ordered: false, baseDelay: 0, remap: flatten(remap) },
    ];
  }

  private spawnObject(index: number, depth: number, remap: Remap = null): void {
    const spec = this.index.byObject.get(index);
    if (!spec) return;
    // Only a trigger that opted in can be spawned, and a disabled one cannot.
    if (!spec.spawnTriggered) return;
    if (this.objectDisabled(index)) return;
    // One once-only check, and activate makes it: testing and marking here as
    // well meant a spawned trigger without multi-trigger saw its own mark and
    // never fired. [gdp GJBaseGameLayer::spawnObject :456038-456089]
    this.activate(spec, 1, depth + 1, remap);
  }

  /**
   * Tests the collision pairs the level asks about and fires what changed.
   *
   * A collision trigger is not fired by being passed — it answers its own block
   * pair, every tick, for as long as the level runs. The overlap state is one
   * byte a pair so entering can be told from leaving, and it is part of the
   * snapshot: a branch that walked into a block and was rewound has to be able
   * to walk into it again.
   */
  private checkCollisionPairs(): void {
    for (let i = 0; i < this.collisionPairs.length; i++) {
      const now = this.pairOverlaps(this.collisionPairs[i]) ? 1 : 0;
      if (now === this.touching[i]) continue;
      this.fork();
      this.touching[i] = now;
      for (let ti = 0; ti < this.collisionTriggers.length; ti++) {
        if (this.collisionControl[ti] !== 0) continue;
        const entry = this.collisionTriggers[ti];
        if (entry.pair !== i) continue;
        const spec = entry.spec;
        if (this.objectDisabled(spec.index)) continue;
        if (spec.id === 3609) {
          // Instant Collision answers every change, one group for yes and
          // another for no.
          this.spawnGroup(this.grp(now === 1 ? spec.target : spec.target2), spec.index, false, 0, 0);
          continue;
        }
        const onExit = flag(spec, 93);
        if (now === 1 ? onExit : !onExit) continue;
        // [gdp GJEffectManager::handleObjectCollision :482313-482351 → the
        //  delegate's toggleGroupTriggered]
        this.toggleGroupTriggered(this.grp(spec.target), spec.activateGroup, spec.index, 0, null);
      }
    }
  }

  private pairOverlaps(pair: CollisionPair): boolean {
    const a = this.blocksById.get(pair.a);
    if (!a || a.length === 0) return false;
    if (pair.player !== 0) {
      const at = pair.player === 1 ? 0 : 3;
      const half = this.playerBox[at + 2];
      if (half <= 0) return false;
      const x = this.playerBox[at];
      const y = this.playerBox[at + 1];
      for (const i of a) {
        const box = this.blockBox(i, false);
        if (Math.abs(box[0] - x) <= box[2] + half && Math.abs(box[1] - y) <= box[3] + half) return true;
      }
      return false;
    }
    const b = this.blocksById.get(pair.b);
    if (!b || b.length === 0) return false;
    for (const i of a) {
      const box = this.blockBox(i, false);
      for (const j of b) {
        const other = this.blockBox(j, true);
        if (Math.abs(box[0] - other[0]) <= box[2] + other[2] && Math.abs(box[1] - other[1]) <= box[3] + other[3]) {
          return true;
        }
      }
    }
    return false;
  }

  /** A collision block's rectangle, carried by whatever group moves it. */
  private blockBox(index: number, second: boolean): number[] {
    const out = second ? this.boxB : this.boxA;
    const o = this.level.objects[index];
    const m = this.blockScratch;
    this.objectTransform(index, m);
    out[0] = m[0] * o.x + m[2] * o.y + m[4];
    out[1] = m[1] * o.x + m[3] * o.y + m[5];
    out[2] = COLLISION_BLOCK_HALF * Math.abs(o.scaleX || 1) * Math.abs(m[7]);
    out[3] = COLLISION_BLOCK_HALF * Math.abs(o.scaleY || 1) * Math.abs(m[8]);
    return out;
  }

  /** Clears the per-tick spawn guard, as the game does twice per sub-step. */
  endStep(): void {
    this.checkCollisionPairs();
    this.spawnGuard.clear();
  }

  // --- dispatch --------------------------------------------------------------

  private dispatch(spec: TriggerSpec, player: 1 | 2, depth: number, remap: Remap = null): void {
    const id = spec.id;
    if (COLOR_TRIGGERS.has(id)) {
      this.runColor(spec);
      return;
    }
    if (ENTER_TRIGGER_IDS.has(id)) {
      this.runEnterEffect(spec);
      return;
    }
    switch (id) {
      // --- scheduling ---
      case 1268:
        this.runSpawn(spec, depth, remap);
        return;
      case 1049:
        this.toggleGroup(this.grp(spec.target), spec.activateGroup);
        return;
      case 1616:
        this.runStop(spec);
        return;
      case 1912: {
        // chance percent of the time the first group wins. One draw, always.
        const chance = num(spec, 10);
        const target = this.grp(this.rng.next01() * 100 > chance ? spec.target2 : spec.target);
        this.spawnGroup(target, spec.index, false, 0, depth);
        return;
      }
      case 2068: {
        const entries = idList(spec, 152);
        let total = 0;
        for (let i = 1; i < entries.length; i += 2) total += entries[i];
        const r = Math.round(this.rng.next01() * total);
        let acc = 0;
        for (let i = 0; i + 1 < entries.length; i += 2) {
          acc += entries[i + 1];
          if (acc >= r) {
            this.spawnGroup(this.grp(entries[i]), spec.index, false, 0, depth);
            return;
          }
        }
        return;
      }
      case 3607:
        this.runSequence(spec, depth);
        return;
      case 3618: {
        // Re-arms every trigger in the group so it can fire again.
        this.fork();
        for (const index of this.index.groups.get(this.grp(spec.target)) ?? []) {
          const slot = this.firedSlot[index];
          if (slot >= 0) this.fired[slot] = 0;
        }
        return;
      }
      case 1812:
        // On Death is armed here and fired by the sim when the player dies.
        this.fork();
        if (!this.onDeath.includes(this.grp(spec.target))) this.onDeath = [...this.onDeath, this.grp(spec.target)];
        return;

      // --- movement ---
      case 901:
        this.runMove(spec);
        return;
      case 1346:
        this.runRotate(spec);
        return;
      case 2067:
        this.runScale(spec);
        return;
      case 1347:
        this.runFollow(spec);
        return;
      case 1814:
        this.runFollowPlayerY(spec);
        return;
      case 3016:
        this.runAdvancedFollow(spec);
        return;
      case 3660:
        this.runAdvancedFollowEdit(spec);
        return;
      case 3661:
        this.runAdvancedFollowRetarget(spec);
        return;
      case KEYFRAME_TRIGGER_ID:
        this.runKeyframeAnimation(spec, remap);
        return;
      case 3006:
        this.runArea(spec, 0);
        return;
      case 3007:
        this.runArea(spec, 1);
        return;
      case 3008:
        this.runArea(spec, 2);
        return;
      case 3009:
        this.runArea(spec, 3);
        return;
      case 3010:
        this.runArea(spec, 4);
        return;
      case 3011:
      case 3012:
      case 3013:
      case 3014:
      case 3015:
        this.runAreaEdit(spec);
        return;
      case 3024:
        this.runAreaStop(spec);
        return;
      case 3022:
        // Teleport: player 1 to the target group's object, or, with no group,
        // only its gravity and push. The sim runs it. [gdp
        //  EffectGameObject::triggerObject :314981 → teleportPlayer]
        this.pendingTeleports.push({ object: spec.index, target: this.portalTarget(this.grp(spec.target)) });
        return;

      // --- colour and visuals ---
      case 1006:
        this.runPulse(spec);
        return;
      case 1007:
        this.runAlpha(spec);
        return;
      case 1585:
        this.runAnimate(spec);
        return;
      case 1520:
        if (!this.visuals) return;
        this.visual.shakeStrength = Math.min(num(spec, 75), 100);
        this.visual.shakeInterval = num(spec, 84);
        this.visual.shakeRemaining = spec.duration;
        return;
      case 2903:
        this.runGradient(spec);
        return;
      case 3029:
        this.visual.background = int(spec, 533, this.visual.background) || int(spec, 51, this.visual.background);
        return;
      case 3030:
        this.visual.ground = int(spec, 533, this.visual.ground) || int(spec, 51, this.visual.ground);
        return;
      case 3031:
        this.visual.middleground = int(spec, 533, this.visual.middleground);
        return;
      case 2999:
        this.runMiddlegroundMove(spec);
        return;
      case 32:
      case 33:
        // Player 1 always; player 2 only while the dual is on (+870).
        // [PlayLayer::toggleGhostEffect :92269-92276]
        this.visual.ghostTrail = id === 32;
        if (this.areaP2) this.visual.ghostTrail2 = id === 32;
        return;
      case 1612:
      case 1613:
        this.visual.hidePlayer = id === 1612;
        return;
      case 3662:
        // Link Visible copies one group's on/off state onto another.
        this.toggleGroup(this.grp(spec.target), this.groupEnabled[Math.min(this.grp(spec.target2), this.index.groupCount - 1)] === 1);
        return;

      // --- camera ---
      case 1913:
        this.runZoom(spec);
        return;
      case 1914:
        this.runStaticCamera(spec);
        return;
      case 1916:
        this.runCameraOffset(spec);
        return;
      case 2015:
        this.runCameraRotate(spec);
        return;
      case 2062: {
        const slot = int(spec, 164);
        const edge = this.grp(spec.target);
        if (slot === 1) this.camera.edgeLeft = edge;
        else if (slot === 2) this.camera.edgeRight = edge;
        else if (slot === 3) this.camera.edgeTop = edge;
        else if (slot === 4) this.camera.edgeBottom = edge;
        return;
      }
      case 2925:
        this.runCameraMode(spec);
        return;
      case 2016:
        // Camera Guide is an editor aid and does nothing while a level plays.
        return;
      case 2899:
        this.runOptions(spec);
        return;
      case 2901: {
        // Keys 28/29 are the new offsets (as ints), key 101 picks the axes
        // (1 = x only, 2 = y only), and keys 58/59 keep them in world units
        // rather than dividing by the zoom. [gdp EffectGameObject::triggerObject
        //  :314914-314922 → updateGameplayOffsetX/Y :430003-430047;
        //  customObjectSetup :298850-298874]
        const axis = int(spec, 101);
        if (axis !== 2) {
          this.camera.gameplayOffsetX = Math.trunc(num(spec, 28));
          this.camera.gameplayOffsetXRaw = flag(spec, 58);
        }
        if (axis !== 1) {
          this.camera.gameplayOffsetY = Math.trunc(num(spec, 29));
          this.camera.gameplayOffsetYRaw = flag(spec, 59);
        }
        return;
      }

      // --- items and counters ---
      case 1611:
        this.armCount(spec, remap);
        return;
      case 1811:
        this.runInstantCount(spec, depth, remap);
        return;
      case 1817:
        this.runPickup(spec, depth);
        return;
      case 3619:
        this.runItemEdit(spec, depth);
        return;
      case 3620:
        this.runItemCompare(spec, depth, remap);
        return;
      case 1815:
      case 3609:
        // Collision triggers are not fired by being passed: they answer their
        // own block pair every tick, from checkCollisionPairs.
        return;

      // --- gameplay ---
      case 1935:
        this.timeWarp = Math.min(2, Math.max(0.1, num(spec, 120, 1)));
        return;

      // --- scenery ---
      case 3606: {
        const x = num(spec, 143, 0);
        const y = num(spec, 144, 0);
        this.camera.bgSpeedX = Math.abs(x) > 999 ? 0.1 : x;
        this.camera.bgSpeedY = Math.abs(y) > 999 ? 0.1 : y;
        return;
      }
      case 3612: {
        const x = num(spec, 143, 0);
        const y = num(spec, 144, 0);
        this.camera.mgSpeedX = Math.abs(x) > 999 ? 0.3 : x;
        this.camera.mgSpeedY = Math.abs(y) > 999 ? 0.5 : y;
        return;
      }
      case 1917:
        // [gdp GJBaseGameLayer::reverseDirection :416188-416196]
        this.pendingPlayer.push({ kind: "reverse" });
        return;
      case 1932: {
        // Key 138 alone is player 1, key 200 alone player 2, both or neither
        // both. [gdp GJBaseGameLayer::activatePlayerControlTrigger
        //  :421196-421248; PlayerControlGameObject::customObjectSetup
        //  :301348-301384]
        const only1 = flag(spec, 138);
        const only2 = flag(spec, 200);
        this.pendingPlayer.push({
          kind: "control",
          p1: only1 || !only2,
          p2: only2 || !only1,
          jump: flag(spec, 540),
          move: flag(spec, 541),
          rotation: flag(spec, 542),
          slide: flag(spec, 543),
        });
        return;
      }
      case 2066: {
        // Key 201 is the player that set it off. Otherwise player 1 unless
        // key 200 alone, player 2 unless key 138 alone — so with both set,
        // neither. Key 148 is held to 0.1..2, and is 0.1 when not above it.
        // [gdp GJBaseGameLayer::triggerGravityChange :422792-422818;
        //  EffectGameObject::customObjectSetup :298930-298953]
        const g = num(spec, 148, 0);
        const value = g > 0.1 ? Math.min(g, 2) : 0.1;
        const only1 = flag(spec, 138);
        const only2 = flag(spec, 200);
        const byPlayer = flag(spec, 201);
        this.pendingPlayer.push({
          kind: "gravity",
          value: Math.fround(value),
          p1: byPlayer ? player === 1 : !only2,
          p2: byPlayer ? player === 2 : !only1,
        });
        return;
      }
      case 2900: {
        // Key 171 switches the channel first, whatever key 172 says; the
        // players turn after, unless key 172 leaves them. The pass-by check
        // sees the turn at once, as the game's does. Key 368 snaps the
        // camera's gameplay offset on its next step. [gdp
        // GJBaseGameLayer::rotateGameplay :442808-442862]
        const r = gameplayRotationOf(spec);
        if (int(spec, 171) !== 0) this.switchChannel(int(spec, 173), r.direction === 2 || r.direction === 3);
        if (!r.channelOnly) this.passRotated = r.orientation === 3 || r.orientation === 4;
        this.pendingRotations.push(r);
        if (flag(spec, 368)) this.camera.leadSnap++;
        return;
      }
      case 3600:
        this.activateEndTrigger(spec, depth, remap);
        return;
      case 2063:
        // A spawned checkpoint object: in a platformer the layer notes it,
        // as a touched one. [gdp CheckpointGameObject::triggerObject
        //  :297595-297599 → PlayLayer::checkpointActivated :86960-86965]
        if (this.level.header.platformer) this.pendingCheckpoint = spec.index;
        return;
      case 1931:
        // The old End trigger reaches PlayLayer::activateEndTrigger, which is
        // empty in 2.206: nothing happens while a level plays. [gdp
        //  EffectGameObject::triggerObject :314937-314941 → vtable +624,
        //  PlayLayer::activateEndTrigger :86727-86731]
        return;
      case 3614:
        this.startTimer(spec, remap);
        return;
      case 3615:
        this.watchTimer(spec, remap);
        return;
      case 3617: {
        // Key 472: 0 resumes, 1 pauses, anything else does nothing; a timer
        // no Time trigger or Item Edit has made is left alone.
        // [gdp GJBaseGameLayer::activateTimerTrigger :429510-429521;
        //  pauseTimer :479898-479914, resumeTimer :479931-479947]
        const id = clampItemId(int(spec, 80));
        const mode = int(spec, 472);
        if ((mode !== 0 && mode !== 1) || !this.timers.has(id)) return;
        this.fork();
        this.timerRuns.set(id, { ...(this.timerRuns.get(id) ?? IDLE_TIMER), running: mode === 0 });
        return;
      }
      case 3604:
        this.armEvent(spec, remap);
        return;
      case 1595:
        this.armTouch(spec, remap);
        return;
      case 3641: {
        this.fork();
        applyPersistentTrigger(
          persistentSpecOf(spec.props),
          this.items,
          this.timers,
          this.persistentItems,
          this.persistentTimers,
          clampItemId,
        );
        return;
      }
      case 3655:
        // The game's activateObjectControlTrigger is empty in 2.206.
        // [gdp :421265-421267]
        return;
      case 1818:
        this.visual.bgEffectHidden = false;
        return;
      case 1819:
        this.visual.bgEffectHidden = true;
        return;
      case 3613:
        // Re-pin the target group (positionUIObjects at load; a mid-level
        // fire refreshes the same anchors). Objects stay in the world draw
        // list with a screen offset rather than a separate UI layer.
        this.layoutUITrigger(spec);
        this.events.push({ tick: this.tick, kind: "ui", id: spec.index });
        return;

      // --- audio ---
      // What an audio trigger does is sound, which the audio side works out
      // from the trigger's own keys; the simulation only notes when.
      case 1934:
        this.events.push({ tick: this.tick, kind: "song", id: int(spec, 392), object: spec.index, at: this.musicClock });
        return;
      case 3605:
        this.events.push({ tick: this.tick, kind: "songEdit", id: 0, object: spec.index, at: this.musicClock });
        return;
      case 3602:
        // No sound, no note either. [gdp GJBaseGameLayer::activateSFXTrigger :447166-447169]
        if (int(spec, 392) <= 0) return;
        this.events.push({ tick: this.tick, kind: "sfx", id: int(spec, 392), object: spec.index, at: this.musicClock });
        return;
      case 3603:
        this.events.push({ tick: this.tick, kind: "sfxEdit", id: 0, object: spec.index, at: this.musicClock });
        return;

      // --- particles ---
      case 2065:
        this.events.push({ tick: this.tick, kind: "particle", id: spec.index });
        return;
      case 3608: {
        // The particles are drawn by the scene, at where the key 71 group's
        // object is. [gdp GJBaseGameLayer::spawnParticleTrigger :431433-431494]
        const anchorGroup = this.grp(int(spec, 71));
        const anchor = anchorGroup > 0 ? this.targetObject(anchorGroup) : -1;
        this.events.push({ tick: this.tick, kind: "particle", id: spec.index, group: this.grp(spec.target), anchor });
        return;
      }

      default:
        // [gdp EffectGameObject::triggerObject :314940-314970]
        if (SHADER_TRIGGER_IDS.has(id)) this.runShader(spec);
        return;
    }
  }

  /** Groups a still-armed On Death trigger will spawn. */
  private onDeath: readonly number[] = [];

  /** Called by the sim when the player dies. */
  playerDied(): void {
    this.dying = true;
    try {
      for (const g of this.onDeath) this.spawnGroup(g, 0, false, 0, 0);
    } finally {
      this.dying = false;
    }
    this.spawnGuard.clear();
  }

  /**
   * An End trigger (3600): the level ends, once, and not for a dead player.
   * It spawns key 51, stops the level time, and hands the sim where the
   * player goes: the trigger's own position, or key 71's main object's. The
   * sim then locks both players, optionally turns on the ghost trail, and
   * flies them there over a second before levelComplete — at once with key
   * 487; key 460 skips the end effects (the ghost trail and the circles) and
   * key 461 the end sound. It also holds the time warp at 1 from here on,
   * which the port, whose warp only sets the music's rate, does not.
   * Triggered by passing, touching or a spawn, it ends a classic level as
   * well as a platformer.
   * [gdp EndTriggerGameObject::triggerObject :315851-315875 → vtable +628,
   *  PlayLayer::activatePlatformerEndTrigger :93034-93065 (the slot: +624 is
   *  activateEndTrigger, 1931's call :314937-314941, and the two are
   *  declared together, :185656-185680); playPlatformerEndAnimationToPos
   *  :92922-93030; the keys, EndTriggerGameObject::customObjectSetup
   *  :309857-309885; +11304 and the warp, PlayLayer::updateTimeWarp
   *  :86939-86944; 461 in showCompleteEffect :88846-88870]
   */
  private activateEndTrigger(spec: TriggerSpec, depth: number, remap: Remap): void {
    if (this.dying || this.levelTimeStopped) return;
    const spawn = this.grp(spec.target);
    if (spawn > 0) this.spawnGroup(spawn, spec.index, false, 0, depth, remap);
    this.levelTimeStopped = true;
    // Key 71 through the spawn's remap, as key 51 is: the game's spawn remaps
    // both on the object itself before triggering it, and puts them back
    // after. [spawnObject :456070-456084; applyRemap :455343-455356 (+1280,
    // key 71); read inside the trigger :93049-93057]
    const main = spec.target2 > 0 ? this.mainObject(this.grp(spec.target2)) : -1;
    const [x, y] = this.objectPosition(main >= 0 ? main : spec.index);
    this.pendingEnd = { x, y, instant: int(spec, 487) !== 0, effects: int(spec, 460) === 0, sound: int(spec, 461) === 0 };
  }

  // --- handlers --------------------------------------------------------------

  private runColor(spec: TriggerSpec): void {
    if (!this.visuals) return;
    const channel = colorTriggerChannel(spec.id, int(spec, 23));
    if (channel <= 0) return;
    const opaque = OPAQUE_LEGACY.has(spec.id);
    // Player Color 1 or 2 (keys 15 and 16, 15 first) takes the player's own
    // colour, strengthened, as the level loads; otherwise keys 7-9, each 0
    // when missing. The opacity (35) only counts when 36 is above 0, and is
    // 0 when missing then. [gdp PlayLayer::addObject :90024-90045; keys at
    //  customObjectSetup :299746-299785, 35 and 36 :299801-299812]
    const player = int(spec, 15) !== 0 ? 1 : int(spec, 16) !== 0 ? 2 : 0;
    const rgb = player !== 0 ? this.colors.playerColour(player) : { r: int(spec, 7), g: int(spec, 8), b: int(spec, 9) };
    const change = {
      channel,
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      duration: spec.duration,
      opacity: opaque ? 1 : int(spec, 36) > 0 ? num(spec, 35) : 1,
      blending: colorTriggerBlends(spec.id, int(spec, 17)),
      copyId: int(spec, 50),
      copyHsv: hsvOf(spec, 49),
      copyOpacity: flag(spec, 60),
      trigger: spec.index,
      controlId: spec.controlId,
    };
    this.colors.startFade(change);
    // The legacy background trigger can tint the ground with the same colour.
    if (spec.id === 29 && flag(spec, 14)) {
      this.colors.startFade({ ...change, channel: CHANNEL.GROUND, blending: false, opacity: 1 });
    }
  }

  private runPulse(spec: TriggerSpec): void {
    if (!this.visuals) return;
    const isGroup = int(spec, 52) === 1;
    const hsvMode = flag(spec, 48);
    const p: PulseAction = {
      target: this.grp(spec.target),
      fadeIn: num(spec, 45),
      hold: num(spec, 46),
      fadeOut: num(spec, 47),
      elapsed: 0,
      value: 0,
      mode: hsvMode ? 1 : 2,
      colour: { r: int(spec, 7, 255), g: int(spec, 8, 255), b: int(spec, 9, 255) },
      hsv: hsvOf(spec, 49) ?? { h: 0, s: 1, v: 1, sChecked: false, vChecked: false },
      copyChannel: int(spec, 50),
      mainOnly: flag(spec, 65),
      detailOnly: flag(spec, 66),
      animateHsv: flag(spec, 210),
      trigger: spec.index,
      controlId: spec.controlId,
    };
    this.colors.addPulse(p, isGroup, flag(spec, 86));
  }

  /**
   * The Animate trigger: for beasts (918, 1584, 2012) it switches the named
   * clip from key 76; for objects that wait for one (key 123) each one's
   * count goes up — which restarts a Custom Particles emitter — and its
   * frame animation is rewound to wait for its first step as an active
   * object (settleAnimationStarts), as the game's clock only starts once the
   * visibility pass reaches it. With key 214 the frame-animation path
   * passes over an object that is not active; beasts always switch.
   * [gdp EffectGameObject::triggerObject :315512-315513 →
   *  playAnimationCommand :422977-423004 → AnimatedGameObject::playAnimation
   *  or animationTriggered :164755-164759 → EnhancedGameObject::
   *  triggerAnimation :620430-620445 (the +1252 / +657 test, +1164 = 0);
   *  customObjectSetup key 76 → +1464 :299286-299289]
   */
  private runAnimate(spec: TriggerSpec): void {
    if (!this.visuals) return;
    const group = this.grp(spec.target);
    const animId = int(spec, 76);
    let next: Map<number, number> | null = null;
    let starts: Map<number, number> | null = null;
    let skeletons: Map<number, { id: number; gen: number }> | null = null;
    for (const index of this.index.groups.get(group) ?? []) {
      const object = this.level.objects[index];
      if (animateSwitchesClip(object.id)) {
        skeletons ??= new Map(this.visual.skeletonAnims);
        const prev = skeletons.get(index);
        skeletons.set(index, { id: animId, gen: (prev?.gen ?? 0) + 1 });
        continue;
      }
      if (!objectFlag(object, OBJECT_KEY.animateOnTrigger)) continue;
      if (objectFlag(object, OBJECT_KEY.animateActiveOnly) && !this.objectActive(index)) continue;
      next ??= new Map(this.visual.animations);
      starts ??= new Map(this.visual.animationStarts);
      next.set(index, (next.get(index) ?? 0) + 1);
      if (!Number.isNaN(starts.get(index) ?? 0)) this.pendingStarts++;
      starts.set(index, Number.NaN);
    }
    if (next) this.visual.animations = next;
    if (starts) this.visual.animationStarts = starts;
    if (skeletons) this.visual.skeletonAnims = skeletons;
  }

  /** How many Animate triggers have reached an object so far. */
  animationsOf(index: number): number {
    return this.visual.animations.get(index) ?? 0;
  }

  /**
   * The level time an object's animation started after the last Animate
   * trigger to reach it; NaN for none, and while it waits to be active.
   */
  animationStartOf(index: number): number {
    return this.visual.animationStarts.get(index) ?? Number.NaN;
  }

  /** The latest Animate clip command for a beast, or null. */
  skeletonAnimOf(index: number): { id: number; gen: number } | null {
    return this.visual.skeletonAnims.get(index) ?? null;
  }

  /**
   * The end of a step: player 1's world position and direction for the
   * active range, and the animation clocks of the objects an Animate trigger
   * has rewound that are active now, which start from this step's level
   * time. Not while a start position's level loads: the game's visibility
   * pass does not run until play begins. [PlayLayer::updateVisibility :95979-95983 →
   *  updateSyncedAnimation :620687-620690; loadUpToPosition :469428-469517]
   */
  settleAnimationStarts(playerX: number, playerY: number, reversed: boolean, loading = false): void {
    this.viewX = playerX;
    this.viewY = playerY;
    this.viewReversed = reversed;
    if (this.pendingStarts === 0 || loading) return;
    let starts: Map<number, number> | null = null;
    for (const [index, at] of this.visual.animationStarts) {
      if (!Number.isNaN(at) || !this.objectActive(index)) continue;
      starts ??= new Map(this.visual.animationStarts);
      starts.set(index, this.levelTime);
      this.pendingStarts--;
    }
    if (starts) this.visual.animationStarts = starts;
  }

  /**
   * Whether an object is active: filed in one of the sections, 100 units
   * square, that the camera's view touches or that lie one beyond them —
   * the list the game's visibility pass walks. The view is the camera as it
   * follows player 1, which keeps the player 75 / zoom units behind its
   * centre along the way it travels (ahead of it when reversed) and does not
   * follow across it here, so it is centred on the player there; the camera
   * triggers' static position (where it aims), offset, turn and zoom, all
   * stepped per tick, go on top, and the view stops where the camera's own
   * limits stop it: the edges, the level's left stop, a classic level's end,
   * the floor and the level's top. Its width is a 16:9 window's, which keeps
   * the answer a function of the sim rather than of the window. Rows count
   * only in a level with y sections.
   * [GJBaseGameLayer::preUpdateVisibility :452391ff (the turned view's
   *  bounding box :452600-452651, the range :452664-452700); the section size
   *  :461909-461910, :430569-430572; addToSection :444742-444770; the camera
   *  :449578-449619, :449668-449689, :450110-450140]
   */
  private objectActive(index: number): boolean {
    const [x, y] = this.objectPosition(index);
    const cam = this.camera;
    const zoom = Math.min(8, Math.max(0.1, cam.zoom));
    const high = VIEW_UNITS_HIGH / zoom;
    const wide = (high * 16) / 9;
    const go = this.passRotated ? cam.gameplayOffsetY : cam.gameplayOffsetX;
    const raw = this.passRotated ? cam.gameplayOffsetYRaw : cam.gameplayOffsetXRaw;
    const lead = ((this.viewReversed ? -1 : 1) * go) / (raw ? 1 : zoom);
    let cx = (cam.staticX.on ? cam.staticX.target : this.viewX + (this.passRotated ? 0 : lead)) + cam.offsetX;
    let cy = (cam.staticY.on ? cam.staticY.target : this.viewY + (this.passRotated ? lead : 0)) + cam.offsetY;
    const right = this.edgeValue(cam.edgeRight, 0);
    const left = this.edgeValue(cam.edgeLeft, 0);
    const top = this.edgeValue(cam.edgeTop, 1);
    const bottom = this.edgeValue(cam.edgeBottom, 1);
    let maxX = right !== null ? right - wide / 2 : null;
    if (cam.levelEnd !== null) {
      const end = levelEndStop(cam.levelEnd, (VIEW_UNITS_HIGH * 16) / 9) - cam.offsetX - wide / 2;
      if (maxX === null || end < maxX) maxX = end;
    }
    if (maxX !== null) cx = Math.min(cx, maxX);
    const leftmost = cam.minLeft !== null && (left === null || left <= cam.minLeft) ? cam.minLeft : left;
    if (leftmost !== null) cx = Math.max(cx, leftmost + wide / 2);
    cy = Math.min(cy, (top ?? cam.levelTop - LEVEL_TOP_MARGIN) - high / 2);
    cy = Math.max(cy, Math.max(bottom ?? VIEW_FLOOR, VIEW_FLOOR) + high / 2);
    let hw = wide / 2;
    let hh = high / 2;
    if (cam.rotation !== 0) {
      const rad = (cam.rotation * Math.PI) / 180;
      const c = Math.abs(Math.cos(rad));
      const s = Math.abs(Math.sin(rad));
      [hw, hh] = [hw * c + hh * s, hw * s + hh * c];
    }
    const column = (v: number): number => (v > 0 ? Math.trunc(v * COLLISION_SECTION_SCALE) : 0);
    const col = column(x);
    if (col < Math.floor((cx - hw) * COLLISION_SECTION_SCALE) - 1 || col > Math.ceil((cx + hw) * COLLISION_SECTION_SCALE) + 1) return false;
    if (!this.ySections) return true;
    const row = column(y + GAME_GROUND_Y);
    const y0 = cy - hh + GAME_GROUND_Y;
    const y1 = cy + hh + GAME_GROUND_Y;
    return row >= Math.floor(y0 * COLLISION_SECTION_SCALE) - 1 && row <= Math.ceil(y1 * COLLISION_SECTION_SCALE) + 1;
  }

  /**
   * An enter-effect trigger: its code into the coming-in table, the going-out
   * one or both (key 217: 0 both, 1 in, 2 out) on its channel (key 344,
   * clamped to 0-100). A custom trigger (3017-3021) also pushes onto that
   * channel's custom list; any other code clears it.
   * [GJBaseGameLayer::updateActiveEnterEffect :467525-467625;
   *  addCustomEnterEffect :467370-467508; EnterEffectObject::customObjectSetup
   *  :299961-299972]
   */
  private runEnterEffect(spec: TriggerSpec): void {
    if (!this.visuals) return;
    const code = enterCode(spec.id);
    const channel = Math.max(0, Math.min(100, int(spec, 344)));
    const mode = int(spec, 217);
    const tables = this.visual.enter;
    const intoIn = mode >= 0 && mode <= 1;
    const intoOut = mode === 0 || mode === 2;
    if (!intoIn && !intoOut) return;
    const next = {
      in: intoIn ? Uint8Array.from(tables.in) : tables.in,
      out: intoOut ? Uint8Array.from(tables.out) : tables.out,
    };
    if (intoIn) next.in[channel] = code;
    if (intoOut) next.out[channel] = code;
    this.visual.enter = next;
    if (code === ENTER.custom) {
      const effect = this.customEnterOf(spec);
      if (intoIn) this.visual.customEnterIn = this.pushCustomEnter(this.visual.customEnterIn, channel, effect);
      if (intoOut) this.visual.customEnterOut = this.pushCustomEnter(this.visual.customEnterOut, channel, effect);
    } else {
      if (intoIn && this.visual.customEnterIn.has(channel)) {
        const cleared = new Map(this.visual.customEnterIn);
        cleared.delete(channel);
        this.visual.customEnterIn = cleared.size > 0 ? cleared : NO_CUSTOM_ENTER;
      }
      if (intoOut && this.visual.customEnterOut.has(channel)) {
        const cleared = new Map(this.visual.customEnterOut);
        cleared.delete(channel);
        this.visual.customEnterOut = cleared.size > 0 ? cleared : NO_CUSTOM_ENTER;
      }
    }
  }

  /** One custom enter trigger's fields, as applyCustomEnterEffect reads them. */
  private customEnterOf(spec: TriggerSpec): CustomEnterEffect {
    return {
      id: spec.id,
      source: spec.index,
      effectId: int(spec, 225),
      length: num(spec, 222),
      lengthPm: num(spec, 223),
      offset: num(spec, 220),
      offsetPm: num(spec, 221),
      deadzone: num(spec, 282),
      easing: int(spec, 242),
      rate: areaRate(num(spec, 243)),
      percent: num(spec, 265),
      tint:
        spec.id === 3021
          ? { channel: int(spec, 260), main: !flag(spec, 66), detail: !flag(spec, 65), hsv: flag(spec, 278) ? parseHsv(spec.props[49]) : null }
          : null,
    };
  }

  /**
   * Push or replace a custom enter on one channel. A non-zero Area Effect ID
   * replaces the running instance that shares it; otherwise a fresh one is
   * appended. [gdp addCustomEnterEffect :467370-467508]
   */
  private pushCustomEnter(
    map: ReadonlyMap<number, readonly CustomEnterEffect[]>,
    channel: number,
    effect: CustomEnterEffect,
  ): ReadonlyMap<number, readonly CustomEnterEffect[]> {
    const next = new Map(map);
    let list = [...(next.get(channel) ?? [])];
    if (effect.effectId > 0) {
      const at = list.findIndex((e) => e.effectId === effect.effectId);
      if (at >= 0) list = list.filter((_, i) => i !== at);
    }
    const same = list.findIndex((e) => e.source === effect.source);
    if (same >= 0) list[same] = effect;
    else list.push(effect);
    next.set(channel, list);
    return next;
  }

  /** The custom enter effects on a channel, coming in or going out. */
  customEnters(channel: number, entering: boolean): readonly CustomEnterEffect[] {
    const map = entering ? this.visual.customEnterIn : this.visual.customEnterOut;
    return map.get(channel) ?? [];
  }

  /** One object's draw from the area variance table, or 0 without one. */
  areaVariance(objectIndex: number, key: number): number {
    return this.areaRand ? variance(this.areaRand, objectIndex, key) : 0;
  }

  /** Alpha fades a whole group's opacity rather than a colour channel's. */
  private runAlpha(spec: TriggerSpec): void {
    const group = this.grp(spec.target);
    if (group <= 0 || group >= this.index.groupCount) return;
    this.fork();
    const to = flag(spec, 36) ? num(spec, 35, 1) : num(spec, 35, 1);
    if (spec.duration <= 0) {
      this.groupAlpha[group] = to;
      return;
    }
    const c = newCommand("alpha", group);
    c.duration = spec.duration;
    c.controlId = spec.controlId;
    c.trigger = spec.index;
    c.fromAlpha = this.groupAlpha[group];
    c.toAlpha = to;
    this.commands = [...this.commands, c];
  }

  private runSpawn(spec: TriggerSpec, depth: number, remap: Remap): void {
    let delay = num(spec, 63);
    const jitter = num(spec, 556);
    if (jitter !== 0) delay = Math.max(0, delay + this.rng.nextSigned() * jitter);
    const ordered = flag(spec, 441);
    // The trigger's own pairs layer over the ones it inherited, unless key 581
    // says to start the chain fresh here.
    const outgoing = mergeRemap(flag(spec, 581) ? null : remap, ownRemap(spec));
    if (delay > 0) {
      this.fork();
      this.spawns = [
        ...this.spawns,
        {
          group: this.grp(spec.target),
          object: -1,
          remaining: delay,
          spawner: spec.index,
          ordered,
          baseDelay: 0,
          remap: flatten(outgoing),
        },
      ];
      return;
    }
    this.spawnGroup(this.grp(spec.target), spec.index, ordered, 0, depth, outgoing);
  }

  private runSequence(spec: TriggerSpec, depth: number): void {
    // A sequence walks its list one step per activation; the position is a
    // counter keyed on the trigger itself. Key 436 is the wrap mode once the
    // list is spent: 0 stop, 1 loop from the start, 2 stay on the last.
    // [gdp SequenceTriggerGameObject::triggerObject :315973-316114
    //  (+1708 mode at :316076-316086); customObjectSetup key 436 :314380-314383]
    const entries = idList(spec, 435);
    if (entries.length === 0) return;
    const steps = Math.ceil(entries.length / 2);
    const key = -spec.index - 1;
    let next = (this.items.get(key) ?? 0) + 1;
    if (next > steps) {
      const mode = int(spec, 436);
      if (mode === 0) return;
      if (mode === 2) next = steps;
      else next = 1;
    }
    this.fork();
    this.items.set(key, next);
    this.spawnGroup(this.grp(entries[(next - 1) * 2]), spec.index, false, 0, depth);
  }

  /**
   * Stop (key 580 = 0), Pause (1) or Resume (2). It acts on what the triggers
   * in the target group started — their moves, rotations and the rest, their
   * pending spawns and their pulses — not on the objects those move; with
   * key 535 it acts on what carries the target as its control id instead.
   * [gdp controlTriggersInGroup :468242ff → GJEffectManager::
   *  controlActionsForTrigger :484607 (by the trigger's +772: 1006 pulses
   *  :484941, 1268 spawns :485018-485048, ...); controlTriggersWithControlID
   *  :468055]
   */
  private runStop(spec: TriggerSpec): void {
    this.fork();
    const mode = int(spec, 580);
    const byControl = flag(spec, 535);
    const members = new Set(byControl ? [] : (this.index.groups.get(this.grp(spec.target)) ?? []));
    for (const c of this.commands) {
      const hit = byControl ? c.controlId === spec.target : members.has(c.trigger);
      if (!hit) continue;
      if (mode === 1) c.paused = true;
      else if (mode === 2) c.paused = false;
      else c.finished = true;
    }
    if (mode === 0) this.commands = this.commands.filter((c) => !c.finished);
    if (!byControl && this.spawns.some((s) => members.has(s.spawner))) {
      if (mode === 0) this.spawns = this.spawns.filter((s) => !members.has(s.spawner));
      else for (const s of this.spawns) if (members.has(s.spawner)) s.paused = mode === 1;
    }
    if (this.visuals) {
      const colourHit = (id: number | undefined, control: number | undefined): boolean =>
        byControl ? control === spec.target : members.has(id ?? -1);
      this.colors.controlPulses((p) => colourHit(p.trigger, p.controlId), mode);
      this.colors.controlFades((f) => colourHit(f.trigger, f.controlId), mode);
    }
    this.stopCameraTweens(spec, mode, byControl);
    this.stopTouches(spec, mode, byControl);
    this.stopAdvancedFollow(spec, mode, byControl, members);
    this.stopCounts(spec, mode, byControl, members);
    this.stopCollisions(spec, mode, byControl, members);
    this.stopTimers(spec, mode, byControl, members);
  }

  /**
   * Stop, Pause and Resume on armed Count listeners.
   * [gdp controlActionsForTrigger :484729-484763 (CountTriggerAction)]
   */
  private stopCounts(spec: TriggerSpec, mode: number, byControl: boolean, members: Set<number>): void {
    if (this.countListeners.length === 0) return;
    const hit = (l: CountListener): boolean => (byControl ? l.controlId === spec.target : members.has(l.spawner));
    if (!this.countListeners.some(hit)) return;
    if (mode === 0) this.countListeners = this.countListeners.filter((l) => !hit(l));
    else for (const l of this.countListeners) if (hit(l)) l.paused = mode === 1;
  }

  /**
   * Stop, Pause and Resume on Collision / Instant Collision triggers.
   * [gdp controlActionsForTrigger :484873-484899 (CollisionTriggerAction)]
   */
  private stopCollisions(spec: TriggerSpec, mode: number, byControl: boolean, members: Set<number>): void {
    if (this.collisionTriggers.length === 0) return;
    for (let i = 0; i < this.collisionTriggers.length; i++) {
      const t = this.collisionTriggers[i].spec;
      const hit = byControl ? t.controlId === spec.target : members.has(t.index);
      if (!hit) continue;
      if (mode === 0) this.collisionControl[i] = 2;
      else if (mode === 1) {
        if (this.collisionControl[i] !== 2) this.collisionControl[i] = 1;
      } else if (mode === 2 && this.collisionControl[i] === 1) this.collisionControl[i] = 0;
    }
  }

  /**
   * Stop, Pause and Resume on timers a Time trigger started, and on Time Event
   * watches from triggers in the target group.
   * [gdp controlActionsForTrigger :484801-484871 (3614 TimerItem, 3615
   *  TimerTriggerAction)]
   */
  private stopTimers(spec: TriggerSpec, mode: number, byControl: boolean, members: Set<number>): void {
    for (const [id, run] of [...this.timerRuns]) {
      const hit = byControl ? run.controlId === spec.target : members.has(run.spawner);
      if (!hit) continue;
      if (mode === 0) {
        this.timers.delete(id);
        this.timerRuns.delete(id);
      } else this.timerRuns.set(id, { ...run, paused: mode === 1 });
    }
    if (byControl || this.timerWatches.length === 0) return;
    const watchHit = (w: TimerWatch): boolean => members.has(w.spawner);
    if (mode === 0 && this.timerWatches.some(watchHit)) {
      this.timerWatches = this.timerWatches.filter((w) => !watchHit(w));
    }
  }

  /**
   * Stop, Pause and Resume on armed Touch triggers: the ones a Touch trigger
   * in the target group armed, or with the target as their control id. A
   * stopped one goes; a paused one ignores the button until resumed.
   * [gdp controlTriggersInGroup :468242ff → GJEffectManager::
   *  controlActionsForTrigger :484661-484691 (by the trigger's +772);
   *  controlTriggersWithControlID :468055 (by +1484)]
   */
  private stopTouches(spec: TriggerSpec, mode: number, byControl: boolean): void {
    if (this.touchActions.length === 0) return;
    const members = byControl ? null : new Set(this.index.groups.get(this.grp(spec.target)) ?? []);
    const hit = (a: TouchAction): boolean => (byControl ? a.controlId === spec.target : members!.has(a.trigger));
    if (!this.touchActions.some(hit)) return;
    this.fork();
    if (mode === 0) this.touchActions = this.touchActions.filter((a) => !hit(a));
    else if (mode === 1 || mode === 2) this.touchActions = this.touchActions.map((a) => (hit(a) ? { ...a, paused: mode === 1 } : a));
  }

  /**
   * Stop, Pause and Resume on the camera triggers' tweens: the zoom, the
   * offset and the turn a Zoom, Camera Offset or Camera Rotate in the target
   * group started, or one with the target as its control id. A stopped one
   * goes and leaves the value where it was; a paused one holds until it is
   * resumed. [gdp controlTriggersInGroup :468311-468322 (1913, 1916, 2015 →
   *  controlTweenAction with the trigger's +772); controlTriggersWithControlID
   *  :468086 (with the control id); GJGameState::controlTweenAction
   *  :451598-451640]
   */
  private stopCameraTweens(spec: TriggerSpec, mode: number, byControl: boolean): void {
    const cam = this.camera;
    const members = byControl ? null : (this.index.groups.get(this.grp(spec.target)) ?? []);
    const control = (t: CameraTween | null): CameraTween | null => {
      if (!t || t.uid < 0) return t;
      if (byControl ? t.controlId !== spec.target : !members?.includes(t.uid)) return t;
      if (mode === 0) return null;
      if (mode === 1) t.paused = true;
      else if (mode === 2) t.paused = false;
      return t;
    };
    cam.zoomTween = control(cam.zoomTween);
    cam.offsetXTween = control(cam.offsetXTween);
    cam.offsetYTween = control(cam.offsetYTween);
    cam.rotationTween = control(cam.rotationTween);
  }

  private runMove(spec: TriggerSpec): void {
    if (spec.target <= 0) return;
    // Key 393 (Small Step, +1336) is parsed and saved but never read by any
    // move path in 2.206. [gdp trigger-semantics.md; +1336 reads only at
    //  :318173/:318182 (save) and :649109 (getter)]
    const c = newCommand("move", this.grp(spec.target));
    c.duration = spec.duration;
    c.easing = spec.easing;
    c.easingRate = spec.easingRate;
    c.controlId = spec.controlId;
    c.trigger = spec.index;
    c.dx = num(spec, 28);
    c.dy = num(spec, 29);
    c.lockPlayerX = flag(spec, 58);
    c.lockPlayerY = flag(spec, 59);
    c.lockCameraX = flag(spec, 141);
    c.lockCameraY = flag(spec, 142);
    c.modX = num(spec, 143, 1) || 1;
    c.modY = num(spec, 144, 1) || 1;
    const dynamic = flag(spec, 397) && spec.target2 > 0;
    const fromGroup = int(spec, 395) > 0 ? this.grp(int(spec, 395)) : 0;
    // Target mode replaces the offset with the vector from one object to
    // another, worked out once now from where both stand. A dynamic move takes
    // any member for either end, whatever kA40 says.
    // [gdp getMoveTargetDelta :425096-425145, both positions live at
    //  :425139-425141; triggerDynamicMoveCommand :443366-443376]
    if (flag(spec, 100)) {
      const pick = (group: number): number => (dynamic ? this.targetObject(group) : this.moveTargetObject(group));
      const from = pick(fromGroup > 0 ? fromGroup : c.group);
      const to = pick(this.grp(spec.target2));
      const a = this.positionOf(from);
      const b = this.positionOf(to);
      if (a && b && from !== to) {
        c.dx = b[0] - a[0];
        c.dy = b[1] - a[1];
      } else {
        c.dx = 0;
        c.dy = 0;
      }
      const coord = int(spec, 101);
      if (coord === 1) c.dy = 0;
      else if (coord === 2) c.dx = 0;
      c.lockPlayerX = c.lockPlayerY = c.lockCameraX = c.lockCameraY = false;
      // Direction mode keeps the aim but fixes the distance.
      if (flag(spec, 394)) {
        const len = Math.hypot(c.dx, c.dy);
        const distance = num(spec, 396);
        if (len > 0) {
          c.dx = (c.dx / len) * distance;
          c.dy = (c.dy / len) * distance;
        } else {
          c.dx = 0;
          c.dy = 0;
        }
      }
    }
    // Dynamic mode keeps the target live rather than resolving it once,
    // measuring from the key 395 group when there is one.
    if (dynamic) {
      c.dynamic = true;
      c.followGroup = this.grp(spec.target2);
      c.centre = fromGroup;
    }
    const locked = c.lockPlayerX || c.lockPlayerY || c.lockCameraX || c.lockCameraY;
    if (c.dx === 0 && c.dy === 0 && !locked && !c.dynamic) return;
    // Silent mode skips the whole command machinery and moves the group now.
    if (flag(spec, 544)) {
      this.translateGroup(c.group, c.dx, c.dy, true);
      return;
    }
    this.fork();
    this.commands = [...this.commands, c];
  }

  private runRotate(spec: TriggerSpec): void {
    if (spec.target <= 0) return;
    const c = newCommand("rotate", this.grp(spec.target));
    c.centre = this.grp(spec.target2);
    c.duration = spec.duration;
    c.easing = spec.easing;
    c.easingRate = spec.easingRate;
    c.controlId = spec.controlId;
    c.trigger = spec.index;
    c.angle = num(spec, 68) + num(spec, 69) * 360;
    c.lockRotation = flag(spec, 70);
    // Aim mode replaces the angle outright: the group is turned to face another
    // group rather than by a fixed amount, and in dynamic mode it keeps facing.
    // Key 403 (editor "Easing:", Geode m_dynamicModeEasing) is the per-step
    // divisor of the remaining angle while dynamic — not the cocos curve on
    // keys 30/85. Absent or below 1 means 1. [gdp processDynamicObjectActions
    //  :445487-445490; SetupRotateCommandPopup::init :554154-554173]
    const aimAt = this.grp(int(spec, 401));
    if (aimAt > 0) {
      const aim = newCommand("aim", c.group);
      aim.centre = c.centre;
      aim.followGroup = aimAt;
      aim.angleOffset = num(spec, 402);
      aim.dynamic = flag(spec, 397);
      aim.duration = aim.dynamic ? (spec.duration > 0 ? spec.duration : -1) : 0;
      aim.easing = int(spec, 403);
      aim.controlId = spec.controlId;
      aim.trigger = spec.index;
      this.fork();
      this.commands = [...this.commands, aim];
      return;
    }
    // A 0° rotate still counts without kA27, as the newest on its group for
    // one step (see stepCommands). With kA27 it would turn nothing.
    if (c.angle === 0 && this.multiRotation) return;
    this.fork();
    this.commands = [...this.commands, c];
  }

  private runScale(spec: TriggerSpec): void {
    if (spec.target <= 0) return;
    const c = newCommand("scale", this.grp(spec.target));
    c.centre = this.grp(spec.target2);
    c.duration = spec.duration;
    c.easing = spec.easing;
    c.easingRate = spec.easingRate;
    c.controlId = spec.controlId;
    c.trigger = spec.index;
    let sx = num(spec, 150, 1) || 1;
    let sy = num(spec, 151, 1) || 1;
    if (flag(spec, 153)) sx = 1 / sx;
    if (flag(spec, 154)) sy = 1 / sy;
    c.scaleX = sx;
    c.scaleY = sy;
    if (sx === 1 && sy === 1) return;
    this.fork();
    this.commands = [...this.commands, c];
  }

  /**
   * Follow: the target group copies the followed group's main object's
   * movement, x key 72 and y key 73 times it, for key 10 seconds (-1 for
   * ever). Both mods default to 0, and with both 0 there is nothing to do.
   * [gdp EffectGameObject::customObjectSetup :298776-298826; triggerObject
   *  :315501-315509 → createFollowCommand :489713-489735 → runFollowCommand
   *  :716268-716280]
   */
  private runFollow(spec: TriggerSpec): void {
    if (spec.target <= 0) return;
    const c = newCommand("follow", this.grp(spec.target));
    c.followGroup = this.grp(spec.target2);
    c.followModX = Math.fround(num(spec, 72));
    c.followModY = Math.fround(num(spec, 73));
    if (c.followModX === 0 && c.followModY === 0) return;
    c.duration = Math.fround(spec.duration);
    c.controlId = spec.controlId;
    c.trigger = spec.index;
    c.fresh = false;
    this.fork();
    this.commands = [...this.commands, c];
  }

  /**
   * Follow Player Y: key 90 speed (clamped 0..500; 0 does nothing), 91 delay
   * in seconds, 92 offset (an integer), 105 max speed, 10 duration. All
   * default to 0. [gdp EffectGameObject::customObjectSetup :299193-299231;
   *  triggerObject :315283-315293 → runPlayerFollowCommand :716296-716330]
   */
  private runFollowPlayerY(spec: TriggerSpec): void {
    if (spec.target <= 0) return;
    const speed = Math.min(500, Math.fround(num(spec, 90)));
    if (!(speed > 0)) return;
    const c = newCommand("followPlayerY", this.grp(spec.target));
    c.followSpeed = speed;
    c.followDelay = Math.fround(num(spec, 91));
    c.followOffset = int(spec, 92);
    c.followMaxSpeed = Math.fround(num(spec, 105));
    c.duration = Math.fround(spec.duration);
    c.controlId = spec.controlId;
    c.trigger = spec.index;
    c.fresh = false;
    this.fork();
    this.commands = [...this.commands, c];
  }

  private runAdvancedFollow(spec: TriggerSpec): void {
    if (!this.advFollow || !this.areaRand) return;
    this.fork();
    this.advFollow.trigger(spec, this.advHost());
  }

  private runAdvancedFollowEdit(spec: TriggerSpec): void {
    if (!this.advFollow || !this.areaRand) return;
    this.fork();
    this.advFollow.edit(spec, this.advHost(), this.rng);
  }

  private runAdvancedFollowRetarget(spec: TriggerSpec): void {
    if (!this.advFollow) return;
    this.fork();
    this.advFollow.retarget(spec, this.advHost());
  }

  private stopAdvancedFollow(spec: TriggerSpec, mode: number, byControl: boolean, members: Set<number>): void {
    if (!this.advFollow) return;
    if (byControl) this.advFollow.control(-1, spec.target, mode);
    else {
      for (const index of members) {
        const t = this.index.byObject.get(index);
        if (t?.id === 3016) this.advFollow.control(index, -1, mode);
      }
    }
  }

  private stepAdvFollow(dt: number, playerY: number): void {
    if (!this.advFollow?.active || !this.areaRand) return;
    this.fork();
    this.advFollow.step(Math.fround(dt * 240), this.tick, this.advHost(), this.areaRand, this.rng);
  }

  private stepAdvFollowOnly(dt: number, playerY: number): void {
    this.fork();
    this.stepAdvFollow(dt, playerY);
  }

  private advHost(): AdvFollowHost {
    const self = this;
    return {
      grp: (id) => self.grp(id),
      groupMembers: (g) => self.index.groups.get(g) ?? [],
      mainObject: (g) => self.mainObject(g),
      targetObject: (g) => self.targetObject(g),
      objectPosition: (i) => self.objectPosition(i),
      objectRotation: (i) => self.level.objects[i]?.rotation ?? 0,
      objectId: (i) => self.level.objects[i]?.id ?? 0,
      objectGroups: (i) => self.level.objects[i]?.groups ?? [],
      specOf: (i) => self.index.byObject.get(i),
      player1: () => [self.areaP1x, self.areaP1y],
      player2: () => self.areaP2,
      noteMoved: (g) => self.noteMoved(g),
      markDirty: (g) => self.markDirty(g),
      setMotion: (i, dx, dy, drot) => self.applyAdvMotion(i, dx, dy, drot),
    };
  }

  private applyAdvMotion(objectIndex: number, dx: number, dy: number, drot: number): void {
    if (!this.advMotion) this.advMotion = new Float64Array(this.level.objects.length * 3);
    this.fork();
    const at = objectIndex * 3;
    this.advMotion[at] += dx;
    this.advMotion[at + 1] += dy;
    this.advMotion[at + 2] += drot;
    this.motion = true;
    for (const g of this.level.objects[objectIndex]?.groups ?? []) this.noteMoved(g);
    for (const g of this.level.objects[objectIndex]?.groups ?? []) this.markDirty(g);
  }

  /**
   * Event (3604): a listener for each game event in key 430's list, keyed by
   * keys 447 and 525; with key 431 it takes away the listeners on those
   * events and key that spawn its group instead. Firing twice listens twice.
   * [gdp EventLinkTrigger::customObjectSetup :313952-314100 (51, 447, 525,
   *  431, and 430 as a '.'-separated set); triggerObject :315726-315735 →
   *  GJBaseGameLayer::activateEventTrigger :464167-464273]
   */
  private armEvent(spec: TriggerSpec, remap: Remap): void {
    const key = int(spec, 525) + 10000 * int(spec, 447);
    const group = this.grp(spec.target);
    const events = eventList(spec.props[430]);
    if (events.length === 0) return;
    this.fork();
    if (flag(spec, 431)) {
      this.eventListeners = this.eventListeners.filter((l) => !(l.key === key && l.group === group && events.includes(l.event)));
      return;
    }
    const flat = flatten(remap);
    this.eventListeners = [
      ...this.eventListeners,
      ...events.map((event) => ({ event, key, group, spawner: spec.index, remap: flat })),
    ];
  }

  /**
   * Touch (1595) arms itself and then answers the players' button: key 51
   * is the group, key 82 switches it on (1), off (2) or over (0), key 81
   * makes it follow the button while held, key 198 picks player 1 (1) or
   * player 2 (2), and key 89 answers only player 2's side, which then no
   * longer moves player 2. Each firing arms another.
   * [gdp EffectGameObject::customObjectSetup :299161-299187;
   *  triggerObject :315514-315545 → GJEffectManager::runTouchTriggerCommand
   *  :485726-485790]
   */
  private armTouch(spec: TriggerSpec, remap: Remap): void {
    this.fork();
    this.touchActions = [
      ...this.touchActions,
      {
        group: this.grp(spec.target),
        hold: flag(spec, 81),
        mode: int(spec, 82),
        control: int(spec, 198),
        dual: flag(spec, 89),
        trigger: spec.index,
        controlId: spec.controlId,
        paused: false,
        remap: flatten(remap),
      },
    ];
  }

  /**
   * A press or release, of player 1's button or not, that the armed Touch
   * triggers answer: switching their groups on or off, and spawning them
   * when on. A release only reaches the ones that follow the button. The
   * sim calls it for every button a living player 1 sees.
   * [gdp GJBaseGameLayer::handleButton :463997-463998 →
   *  GJEffectManager::playerButton :482526-482608 → toggleGroupTriggered
   *  :423103-423110]
   */
  playerButton(push: boolean, player1: boolean): void {
    for (let i = 0; i < this.touchActions.length; i++) {
      const a = this.touchActions[i];
      if (a.paused || (a.dual && player1)) continue;
      if (a.control === 1 ? !player1 : a.control === 2 ? player1 : a.control !== 0) continue;
      if (!push && !a.hold) continue;
      let on: boolean;
      if (a.mode === 0) on = !this.groupIsEnabled(a.group);
      else if (a.hold) on = a.mode === 1 ? push : !push;
      else on = a.mode === 1;
      this.toggleGroupTriggered(a.group, on, a.trigger, 0, unflatten(a.remap));
    }
  }

  /** Whether an armed Touch trigger answers only player 2's side. [gdp GJEffectManager::hasActiveDualTouch :474877-474888] */
  hasActiveDualTouch(): boolean {
    return this.touchActions.some((a) => a.dual && !a.paused);
  }

  /**
   * Keyframe Animation (3033) plays, for each animation that has a Keyframe
   * object in its key 76 group, that animation's path on its own key 51 or,
   * without one, the keyframe's.
   * [gdp GJBaseGameLayer::playKeyframeAnimation :451933-451995]
   */
  private runKeyframeAnimation(spec: TriggerSpec, remap: Remap): void {
    const mods = keyframeMods(spec.props);
    const played = new Set<number>();
    for (const index of this.index.groups.get(this.grp(int(spec, 76))) ?? []) {
      const o = this.level.objects[index];
      if (o.id !== KEYFRAME_OBJECT_ID) continue;
      const anim = keyframeAnimId(o);
      if (played.has(anim)) continue;
      played.add(anim);
      const members = this.index.keyframeAnims.get(anim);
      if (!members) continue;
      const path = buildKeyframePath(
        members.map((i) => readKeyframe(this.level.objects[i])),
        mods,
      );
      if (!path) continue;
      const target = spec.target > 0 ? spec.target : Math.trunc(Number(o.props[51] ?? 0));
      const c = newCommand("keyframe", this.grp(target));
      // Parent ID (key 71) is the rotation/scale centre; without one the
      // animated group is its own centre. [gdp createKeyframeCommand
      //  :489921-489935; Setup help: Parent ID]
      c.centre = spec.target2 > 0 ? this.grp(spec.target2) : c.group;
      c.controlId = spec.controlId;
      c.duration = path.duration;
      c.path = path;
      c.trigger = spec.index;
      c.remap = flatten(remap);
      this.fork();
      this.commands = [...this.commands, c];
    }
  }

  /**
   * The game raising an event, with an extra id and the player (1 or 2, 0 for
   * none). The Event triggers listening for it under that key spawn their
   * groups, at most once a step for the pair; then, for a player's event, the
   * ones listening for either player. [gdp GJBaseGameLayer::gameEventTriggered
   *  :462225-462258]
   */
  gameEvent(event: number, extra: number, player: number): void {
    if (this.eventListeners.length === 0) return;
    const key = player + 10000 * extra;
    const stamp = `${event}:${key}`;
    if ((this.eventStamps.get(stamp) ?? 0) !== this.tick) {
      this.fork();
      this.eventStamps.set(stamp, this.tick);
      for (const l of this.eventListeners) {
        if (l.event === event && l.key === key) this.spawnGroup(l.group, l.spawner, false, 0, 0, unflatten(l.remap));
      }
    }
    if (player !== 0) this.gameEvent(event, extra, 0);
  }

  /**
   * Count (1611) arms a listener on its item and fires nothing now, even when
   * the item already holds the number: it answers later changes.
   * [gdp CountTriggerGameObject::triggerObject :315810-315832 →
   *  GJEffectManager::runCountTrigger :487736-487880]
   */
  private armCount(spec: TriggerSpec, remap: Remap): void {
    const item = int(spec, 80);
    this.fork();
    this.countListeners = [
      ...this.countListeners,
      {
        item,
        target: int(spec, 77),
        prev: this.itemCount(item),
        group: this.grp(spec.target),
        activate: spec.activateGroup,
        multi: flag(spec, 104),
        spawner: spec.index,
        controlId: spec.controlId,
        paused: false,
        remap: flatten(remap),
      },
    ];
  }

  /**
   * Instant Count (1811) tests once, now: key 88 picks equal (0), greater (1)
   * or less (2), and anything else never passes.
   * [gdp CountTriggerGameObject::triggerObject :315777-315807 →
   *  GJBaseGameLayer::testInstantCountTrigger :429136-429166]
   */
  private runInstantCount(spec: TriggerSpec, depth: number, remap: Remap): void {
    const have = this.itemCount(int(spec, 80));
    const want = int(spec, 77);
    const mode = int(spec, 88);
    const hit = mode === 0 ? have === want : mode === 1 ? have > want : mode === 2 ? have < want : false;
    if (hit) this.toggleGroupTriggered(this.grp(spec.target), spec.activateGroup, spec.index, depth, remap);
  }

  /**
   * Pickup (1817): key 88 mode 1 multiplies the item by key 449 and mode 2
   * divides it (not by 0), both rounded to the nearest whole number; otherwise
   * key 77 is added, or set outright with key 139. Key 77 defaults to 0.
   * [gdp CountTriggerGameObject::customObjectSetup :300830-300854;
   *  GJBaseGameLayer::addPickupTrigger :459042-459086]
   */
  private runPickup(spec: TriggerSpec, depth: number): void {
    const item = int(spec, 80);
    const mode = int(spec, 88);
    if (mode === 1 || mode === 2) {
      const by = Math.fround(num(spec, 449));
      if (mode === 2 && by === 0) return;
      const have = Math.fround(this.itemCount(item));
      this.setCount(item, roundHalfAway(Math.fround(mode === 1 ? have * by : have / by)), depth);
      return;
    }
    if (flag(spec, 139)) this.setCount(item, int(spec, 77), depth);
    else this.addCount(item, int(spec, 77), depth);
  }

  /**
   * Item Edit (3619): the target (key 51, of type 478: 1 item, 2 timer, 3
   * points) takes A op B op the modifier, where A is key 80 of type 476, B is
   * key 95 of type 477, the first op is key 481 (+ - x /) and the second key
   * 482 (x or /). Key 480 then applies that onto the target's current value
   * (0 sets it). Keys 485/486 round and 578/579 fix the sign, after the
   * modifier and after the assignment. An item or timer with id 0 is absent,
   * except for points and the level time, which need none.
   * [gdp ItemTriggerGameObject::customObjectSetup :301001-301192;
   *  GJBaseGameLayer::activateItemEditTrigger :459103-459228]
   */
  private runItemEdit(spec: TriggerSpec, depth: number): void {
    let targetType = int(spec, 478);
    const target = int(spec, 51);
    if (targetType <= 0) {
      if (target <= 0) return;
      targetType = 1;
    } else if (target <= 0 && targetType !== 3) return;
    let typeA = int(spec, 476);
    let idA = int(spec, 80);
    const typeB = int(spec, 477);
    const idB = int(spec, 95);
    let useA = typeA !== 0 && (idA > 0 || typeA === 3 || typeA === 4);
    let combine = false;
    if (typeB !== 0 && (idB > 0 || typeB === 3 || typeB === 4)) {
      if (useA) combine = true;
      else {
        typeA = typeB;
        idA = idB;
        useA = true;
      }
    }
    let a = this.itemValue(typeA, idA);
    const b = this.itemValue(typeB, idB);
    const current = this.itemValue(targetType, target);
    if (combine) a = mathOperation(a, b, Math.max(1, int(spec, 481)));
    const mod = thousandths(num(spec, 479));
    let v = useA ? mathOperation(a, mod, Math.max(3, int(spec, 482))) : mod;
    v = mathSign(mathRounding(v, int(spec, 485)), int(spec, 578));
    const assign = int(spec, 480);
    if (assign !== 0) v = mathOperation(current, v, assign);
    v = mathSign(mathRounding(v, int(spec, 486)), int(spec, 579));
    if (targetType === 1) this.setCount(target, toInt(v), depth);
    else if (targetType === 2) this.setTimer(target, v);
    else if (targetType === 3) {
      this.fork();
      this.points = toInt(v);
    }
  }

  /**
   * Item Compare (3620): the left side is key 80 of type 476 (at least 1) op
   * key 479, op key 480 (+ - x /, default x); the right side is key 95 of type
   * 477 op key 483 by key 481 — or key 483 alone when there is no right-hand
   * item. Each side can be rounded (485/486) and have its sign fixed
   * (578/579). Key 482 picks the test, with key 484 as the tolerance: equal
   * within it (0), greater (1), greater or equal (2), less (3), less or equal
   * (4), not equal (5). True spawns key 51, false key 71.
   * [gdp ItemTriggerGameObject::customObjectSetup :301001-301192;
   *  GJBaseGameLayer::activateItemCompareTrigger :429330-429472]
   */
  private runItemCompare(spec: TriggerSpec, depth: number, remap: Remap): void {
    const typeB = int(spec, 477);
    const idB = int(spec, 95);
    const modA = thousandths(num(spec, 479));
    const modB = thousandths(num(spec, 483));
    const tolerance = thousandths(num(spec, 484));
    const opA = int(spec, 480) > 0 ? int(spec, 480) : 3;
    const opB = int(spec, 481) > 0 ? int(spec, 481) : 3;
    let left = mathOperation(this.itemValue(Math.max(1, int(spec, 476)), int(spec, 80)), modA, opA);
    left = mathSign(mathRounding(left, int(spec, 485)), int(spec, 578));
    const useB = typeB !== 0 && (idB > 0 || typeB === 3 || typeB === 4);
    let right = useB ? mathOperation(this.itemValue(typeB, idB), modB, opB) : modB;
    right = mathSign(mathRounding(right, int(spec, 486)), int(spec, 579));
    let hit: boolean;
    switch (int(spec, 482)) {
      case 0:
        hit = Math.abs(left - right) <= tolerance;
        break;
      case 1:
        hit = left + tolerance > right;
        break;
      case 2:
        hit = left + tolerance >= right;
        break;
      case 3:
        hit = left - tolerance < right;
        break;
      case 4:
        hit = left - tolerance <= right;
        break;
      case 5:
        hit = Math.abs(left - right) > tolerance;
        break;
      default:
        hit = false;
    }
    this.spawnGroup(this.grp(hit ? spec.target : spec.target2), spec.index, false, 0, depth, remap);
  }

  /**
   * What an Item Compare or Edit reads: 1 an item's count, 2 a timer, 3 the
   * points, 4 the level time, 5 the attempt number; anything else is 0.
   * [gdp GJBaseGameLayer::getItemValue :429183-429210]
   */
  private itemValue(type: number, id: number): number {
    switch (type) {
      case 1:
        return this.itemCount(id);
      case 2:
        return this.timers.get(clampItemId(id)) ?? 0;
      case 3:
        return this.points;
      case 4:
        return this.levelTime;
      case 5:
        return this.attempt;
      default:
        return 0;
    }
  }

  /**
   * A camera tween for a trigger's move time, easing and rate (a rate of 0
   * or less is 2), or null when the trigger acts at once. Zoom, Camera Offset
   * and Camera Rotate tag it with the trigger and its control id, which a
   * Stop trigger finds it by; the static camera's own is the layer's, which
   * none can reach.
   * [gdp CameraTriggerGameObject::customObjectSetup :301526-301536;
   *  triggerObject :315585-315610 (+772 and +1484); updateStaticCameraPos
   *  and updateStaticCameraPosToGroup tween with -1, -1]
   */
  private cameraTween(from: number, to: number, spec: TriggerSpec, owned = true): CameraTween | null {
    if (!(spec.duration > 0)) return null;
    return {
      from,
      to,
      duration: spec.duration,
      elapsed: 0,
      easing: spec.easing,
      rate: spec.easingRate > 0 ? spec.easingRate : 2,
      uid: owned ? spec.index : -1,
      controlId: owned ? spec.controlId : -1,
      paused: false,
    };
  }

  /**
   * Zoom (1913): key 371, 0.4 to 3, over the move time. With no key 371 the
   * level is from before 2.1, and key 109 says how far out in steps of 30
   * units on 300. [gdp EffectGameObject::customObjectSetup :299032-299079;
   *  updateZoom :451250-451300]
   */
  private runZoom(spec: TriggerSpec): void {
    let raw = Math.fround(num(spec, 371, 0));
    if (raw <= 0) {
      const legacy = int(spec, 109);
      raw = legacy < -3 ? Math.fround(1.6667) : Math.fround(300 / (Math.min(legacy, 8) * 30 + 300));
    }
    const target = raw <= 0 ? 1 : raw >= 3 ? 3 : raw <= 0.4 ? Math.fround(0.4) : raw;
    const cam = this.camera;
    cam.zoomTween = this.cameraTween(cam.zoom, target, spec);
    if (!cam.zoomTween) cam.zoom = target;
    this.pendingGround = { zoom: true, instant: cam.zoomTween === null };
  }

  /**
   * MG (2999): eases the middleground's offset to key 29, over key 10's time
   * with key 30's easing at key 85's rate (2 when 0 or less), or puts it
   * there at once. [gdp EffectGameObject::customObjectSetup :298881-298900;
   *  triggerObject :314954-314961 → updateMGOffsetY :449303-449321]
   */
  private runMiddlegroundMove(spec: TriggerSpec): void {
    const cam = this.camera;
    const target = Math.fround(num(spec, 29));
    cam.mgOffsetTween = this.cameraTween(cam.mgOffsetY, target, spec);
    if (!cam.mgOffsetTween) cam.mgOffsetY = target;
  }

  /**
   * Camera Rotate (2015): turns the view to key 68's angle, or by it with key
   * 70 "Add". Key 394 "Snap360" first brings both the angle and the target
   * into ±180, so the turn takes the short way round. Over key 10's move time
   * with the easing, or at once; at once, the view takes key 68 itself rather
   * than the target, which is what the game does with Add and no move time.
   * [gdp CameraTriggerGameObject::customObjectSetup :301526-301562;
   *  triggerObject :315598-315609 → PlayLayer::updateScreenRotation
   *  :89622-89650 → GJBaseGameLayer::updateScreenRotation :449176-449210;
   *  the popup's labels, SetupCameraRotatePopup2::init :618062-618070]
   */
  private runCameraRotate(spec: TriggerSpec): void {
    const cam = this.camera;
    const degrees = Math.fround(num(spec, 68));
    cam.rotationTarget = flag(spec, 70) ? Math.fround(degrees + cam.rotationTarget) : degrees;
    if (flag(spec, 394)) {
      cam.rotation = closestDirection(cam.rotation);
      cam.rotationTarget = closestDirection(cam.rotationTarget);
    }
    cam.rotationTween = this.cameraTween(cam.rotation, cam.rotationTarget, spec);
    if (!cam.rotationTween) cam.rotation = degrees;
  }

  /**
   * Static Camera (1914) on the axes key 101 picks (0 both, 1 x, 2 y). Key 110
   * lets them go instead, handing the view back over the trigger's own move
   * time; key 465 snaps that step. Otherwise each axis aims at the group's
   * main object where it is now and gets there over the move time: eased in
   * a straight line, or along a curve that sets out at the camera's speed
   * with key 453, and with key 212 it keeps tracking the group, smoothed by
   * key 213 as it arrives. The positions are the camera's; this keeps what
   * the trigger asked for and the approach's progress.
   * [gdp CameraTriggerGameObject::triggerObject :315619-315660 →
   *  exitStaticCamera :451385-451465, updateStaticCameraPosToGroup
   *  :451473-451550 → updateStaticCameraPos :450937-451023; the popup's
   *  labels, SetupStaticCameraPopup::init :590627-590760]
   */
  private runStaticCamera(spec: TriggerSpec): void {
    const cam = this.camera;
    const axis = int(spec, 101);
    const axes: Array<[StaticCameraAxis, 0 | 1]> = [];
    if (axis !== 2) axes.push([cam.staticX, 0]);
    if (axis !== 1) axes.push([cam.staticY, 1]);
    if (flag(spec, 110)) {
      for (const [st] of axes) {
        st.exitSeq++;
        st.exitInstant = flag(spec, 465);
        st.exitHeld = st.on;
        if (!st.on) continue;
        st.on = false;
        st.tween = null;
        st.exitDuration = spec.duration;
        st.exitEasing = spec.easing;
        st.exitRate = spec.easingRate > 0 ? spec.easingRate : 2;
        st.exitSmoothVelocity = flag(spec, 453);
        st.exitModifier = Math.fround(num(spec, 454));
      }
      this.pendingGround = { zoom: false, instant: false };
      return;
    }
    // The main object's position now, so a guide group a move trigger has
    // carried is aimed at where it is. [:451494, vtable +672 getRealPosition]
    const group = this.grp(spec.target2);
    const at = this.positionOf(this.mainObject(group));
    if (!at) return;
    const smoothing = Math.fround(num(spec, 213));
    for (const [st, k] of axes) {
      st.on = true;
      st.seq++;
      st.target = at[k];
      st.follow = flag(spec, 212) ? group : 0;
      st.smoothVelocity = flag(spec, 453);
      st.modifier = Math.fround(num(spec, 454));
      st.smoothing = smoothing <= 1 ? 1 : smoothing;
      st.duration = spec.duration;
      st.tween = this.cameraTween(0, 1, spec, false);
      st.progress = st.tween ? 0 : 1;
    }
  }

  /**
   * The corridor takes the static y: updateStaticCameraPos on y alone, aiming
   * at the band's middle over `duration` (at once for 0), eased in and out
   * at rate 2, as animateInDualGroundNew asks. Returns the axis's new count,
   * which tells the sim the corridor still holds it until a Static Camera
   * trigger takes it over. [gdp animateInDualGroundNew :451137-451143 →
   *  updateStaticCameraPos :450937-451023]
   */
  corridorStaticY(target: number, duration: number): number {
    const st = this.camera.staticY;
    st.on = true;
    st.seq++;
    st.target = target;
    st.follow = 0;
    st.smoothVelocity = false;
    st.modifier = 0;
    st.smoothing = 1;
    st.duration = duration;
    st.tween =
      duration > 0
        ? { from: 0, to: 1, duration, elapsed: 0, easing: 1, rate: 2, uid: -1, controlId: -1, paused: false }
        : null;
    st.progress = st.tween ? 0 : 1;
    return st.seq;
  }

  /**
   * resetStaticCamera on y alone, as the corridor going out lets go of the
   * static y it held: off at once, with nothing to hand back.
   * [gdp animateOutGroundNew :448965-448973 → resetStaticCamera :448861-448887]
   */
  releaseStaticY(): void {
    const st = this.camera.staticY;
    st.on = false;
    st.tween = null;
    st.progress = 1;
    st.exitHeld = false;
  }

  /**
   * Camera Mode (2925): the switches a portal carries. Key 111 frees the
   * camera and drops the corridor, key 370 turns the corridor's 30-unit snap
   * off; both are layer state the sim holds, so they go to it as a request.
   * With key 112, keys 113 and 114 retune the camera follow.
   * [gdp CameraTriggerGameObject::triggerObject :315614-315616 →
   *  updateCameraMode(…, true) :451188-451232; keys from
   *  EffectGameObject::customObjectSetup :299720-299744]
   */
  private runCameraMode(spec: TriggerSpec): void {
    this.pendingCameraMode = { free: flag(spec, 111), noSnap: flag(spec, 370) };
    if (flag(spec, 112)) this.setCameraEase(num(spec, 113), num(spec, 114));
  }

  /**
   * Keys 113 and 114 of a Camera Mode trigger or a portal that sets key 112:
   * easing clamped to 1..40, padding to 0..1. [gdp updateCameraMode :451201-451228]
   */
  setCameraEase(easing: number, padding: number): void {
    const e = Math.fround(easing);
    const p = Math.fround(padding);
    this.camera.followDivisor = e < 1 ? 1 : e > 40 ? 40 : e;
    this.camera.padding = p < 0 ? 0 : p > 1 ? 1 : p;
  }

  /**
   * Camera Offset (1916): keys 28 and 29, on the axes key 101 picks, over the
   * move time. [gdp CameraTriggerGameObject::triggerObject :315661-315678 →
   *  updateCameraOffsetX/Y :449227-449290]
   */
  private runCameraOffset(spec: TriggerSpec): void {
    const cam = this.camera;
    const axis = int(spec, 101);
    if (axis !== 2) {
      const x = Math.fround(num(spec, 28));
      cam.offsetXTween = this.cameraTween(cam.offsetX, x, spec);
      if (!cam.offsetXTween) cam.offsetX = x;
    }
    if (axis !== 1) {
      const y = Math.fround(num(spec, 29));
      cam.offsetYTween = this.cameraTween(cam.offsetY, y, spec);
      if (!cam.offsetYTween) cam.offsetY = y;
    }
  }

  /**
   * The Options trigger. A key that is absent or 0 leaves its setting alone,
   * 1 turns it on and anything else turns it off, which is why these cannot be
   * read as plain booleans: a level that wants the ground back writes -1
   * rather than nothing. [gdp GJBaseGameLayer::processOptionsTrigger
   * :429799-429860, each `if (v) field = v == 1`]
   */
  private runOptions(spec: TriggerSpec): void {
    const o = this.visual.options;
    for (const [key, field] of OPTION_KEYS) {
      const v = int(spec, key);
      if (v === 0) continue;
      (o[field] as boolean) = v === 1;
    }
    // Key 573 turns the edit on (1) or clears the delay to 0 (−1); key 574 is
    // the seconds, clamped 1..10. [gdp processOptionsTrigger :429863-429882]
    const edit = int(spec, 573);
    if (edit === 1) {
      const raw = num(spec, 574, o.respawnTime);
      o.respawnTime = raw <= 1 ? 1 : raw >= 10 ? 10 : raw;
      o.editRespawnTime = true;
    } else if (edit !== 0) {
      o.respawnTime = 0;
      o.editRespawnTime = false;
    }
  }

  /**
   * Gradient (2903): sets the gradient layer key 209 names (999 at most) to
   * this trigger, which it then follows. Key 208 takes that layer away, and
   * key 508 takes every layer away. Key 456 is the editor's preview opacity
   * and nothing in play reads it.
   * [gdp GJBaseGameLayer::triggerGradientCommand :436326-436500 (508 →
   *  resetGradientLayers :422204-422238; 208 :436349-436354);
   *  GradientTriggerObject::customObjectSetup :300278-300349 (202 at least 1);
   *  updateGradientLayers :423647-423650, which reads 456 only in the editor]
   */
  private runGradient(spec: TriggerSpec): void {
    if (!this.visuals) return;
    const list = this.visual.gradients;
    if (flag(spec, 508)) {
      list.length = 0;
      return;
    }
    const id = Math.min(int(spec, 209), 999);
    const at = list.findIndex((g) => g.id === id);
    if (flag(spec, 208)) {
      if (at >= 0) list.splice(at, 1);
      return;
    }
    const object = this.level.objects[spec.index];
    const state: GradientState = {
      id,
      object: spec.index,
      layer: Math.max(1, int(spec, 202)),
      zOrder: effectiveZOrder(object?.zOrder ?? null, 0),
      blend: Math.trunc(num(spec, 174)),
      vertexMode: flag(spec, 207),
      groups: [int(spec, 203), int(spec, 204), int(spec, 205), int(spec, 206)],
      start: int(spec, 21),
      end: int(spec, 22),
    };
    if (at >= 0) list[at] = state;
    else list.push(state);
  }

  /**
   * A shader trigger: its keys go to the one layer every effect lives in,
   * which eases them over the frames that follow. See shaderState.ts.
   * [gdp GJBaseGameLayer::triggerShaderCommand :422254-422603]
   */
  private runShader(spec: TriggerSpec): void {
    if (!this.visuals) return;
    applyShaderTrigger(this.visual.shader, spec);
  }

  // --- groups and items ------------------------------------------------------

  toggleGroup(group: number, enable: boolean): void {
    if (group <= 0 || group >= this.index.groupCount) return;
    const want = enable ? 1 : 0;
    if (this.groupEnabled[group] === want) return;
    this.fork();
    this.groupEnabled[group] = want;
    this.toggleGen++;
    this.markDirty(group);
  }

  groupIsEnabled(group: number): boolean {
    return group <= 0 || group >= this.index.groupCount || this.groupEnabled[group] === 1;
  }

  /**
   * Switches a group on or off, and spawns it when switching it on: what
   * "Activate Group" means on a Count, an Instant Count, a Collision and a
   * collectible. [gdp GJBaseGameLayer::toggleGroupTriggered :423103-423110,
   *  reached through the effect manager's delegate slot 0 (the
   *  non-virtual thunk at :423127-423129)]
   */
  private toggleGroupTriggered(group: number, activate: boolean, spawner: number, depth: number, remap: Remap): void {
    this.toggleGroup(group, activate);
    if (activate) this.spawnGroup(group, spawner, false, 0, depth, remap);
  }

  /** An item's count; one never set is 0. [gdp GJEffectManager::countForItem :474905-474925] */
  itemCount(id: number): number {
    return this.items.get(clampItemId(id)) ?? 0;
  }

  /**
   * Values to hand the next attempt of this visit. [gdp transferPersistentItems]
   */
  persistentCarry(): PersistentCarry {
    for (const id of this.persistentItems.keys()) this.persistentItems.set(id, this.items.get(id) ?? 0);
    for (const id of this.persistentTimers.keys()) this.persistentTimers.set(id, this.timers.get(id) ?? 0);
    return { items: new Map(this.persistentItems), timers: new Map(this.persistentTimers) };
  }

  private applyPersistentCarry(carry: PersistentCarry): void {
    this.persistentItems = new Map(carry.items);
    this.persistentTimers = new Map(carry.timers);
    transferPersistent(this.items, this.timers, carry);
  }

  /**
   * Screen offset for a UI-pinned object, or null. [gdp positionUIObjects :444507-444569]
   */
  uiOffsetOf(objectIndex: number, viewHalfW: number, viewHalfH: number): { dx: number; dy: number } | null {
    const a = this.uiAnchors.get(objectIndex);
    if (!a) return null;
    return uiOffsetFromCentre(a, viewHalfW, viewHalfH);
  }

  /**
   * positionUIObjects does once at load, and again when a UI trigger fires.
   * [gdp :444377-444607, :467060]
   */
  private layoutUIObjects(): void {
    for (const spec of this.index.byObject.values()) {
      if (spec.id !== 3613) continue;
      this.layoutUITrigger(spec);
    }
  }

  /** Pin one UI trigger's target group about its guide. */
  private layoutUITrigger(spec: TriggerSpec): void {
    const keys = uiKeysOf(spec.props);
    if (keys.group <= 0) return;
    const guide = keys.target > 0 ? this.mainObject(this.grp(keys.target)) : -1;
    const guideX = guide >= 0 ? this.level.objects[guide].x : 0;
    const guideY = guide >= 0 ? this.level.objects[guide].y : 0;
    for (const i of this.index.groups.get(keys.group) ?? []) {
      const o = this.level.objects[i];
      this.uiAnchors.set(i, {
        objX: o.x,
        objY: o.y,
        guideX,
        guideY,
        xref: keys.xref,
        yref: keys.yref,
        scaleX: keys.scaleX,
        scaleY: keys.scaleY,
      });
    }
  }

  /** A timer's value in seconds, 0 for one that does not exist. */
  timerValue(id: number): number {
    return this.timers.get(clampItemId(id)) ?? 0;
  }

  /**
   * Sets an item's count, and fires every armed Count trigger on that item the
   * change reaches or crosses from either side — nearest number first in the
   * direction of the change — dropping each that fires unless it is
   * multi-activate. A listener whose count already sat on its number does not
   * fire until the count leaves it and comes back.
   * [gdp GJEffectManager::updateCountForItem :487384-487525; countSortAsc /
   *  countSortDec :470872-470895, stable for up to 16 listeners]
   */
  private setCount(id: number, value: number, depth: number): void {
    const item = clampItemId(id);
    const was = this.items.get(item) ?? 0;
    this.fork();
    if (value === 0) this.items.delete(item);
    else this.items.set(item, value);
    if (this.persistentItems.has(item)) this.persistentItems.set(item, value);
    if (this.countListeners.length === 0) return;
    const up = was <= value;
    const on = this.countListeners.filter((l) => l.item === item);
    on.sort((a, b) => (up ? a.target - b.target : b.target - a.target));
    for (const l of on) {
      // Something an earlier listener fired may have moved the count on.
      if (!this.countListeners.includes(l) || l.prev === value) continue;
      const prev = l.prev;
      l.prev = value;
      // A paused Count still tracks the value so a resume does not fire for a
      // cross that happened while it was held. [gdp controlActionsForTrigger
      //  :484750-484759]
      if (l.paused) continue;
      const reached = prev < l.target ? value >= l.target : prev > l.target && value <= l.target;
      if (!reached) continue;
      if (!l.multi) this.countListeners = this.countListeners.filter((x) => x !== l);
      this.toggleGroupTriggered(l.group, l.activate, l.spawner, depth, unflatten(l.remap));
    }
  }

  /** Adds to an item's count. [gdp GJEffectManager::addCountToItem :487546-487563] */
  private addCount(id: number, by: number, depth: number): void {
    this.setCount(id, this.itemCount(id) + by, depth);
  }

  /** A timer's value, clamped as the game clamps it. [gdp GJEffectManager::updateTimer :486873-486905] */
  private setTimer(id: number, value: number): void {
    this.fork();
    const tid = clampItemId(id);
    const v = Math.min(MAX_TIMER_VALUE, Math.max(-MAX_TIMER_VALUE, value));
    this.timers.set(tid, v);
    if (this.persistentTimers.has(tid)) this.persistentTimers.set(tid, v);
  }

  /**
   * Time (3614): sets how timer key 80 runs, and its value to key 467 unless
   * the timer already exists and key 468 says to keep it. Running unless key
   * 471. [gdp GJBaseGameLayer::activateTimerTrigger :429522-429537;
   *  GJEffectManager::startTimer :486742-486857; the keys,
   *  TimerTriggerGameObject::customObjectSetup :300944-300978]
   */
  private startTimer(spec: TriggerSpec, remap: Remap): void {
    const id = clampItemId(int(spec, 80));
    this.fork();
    if (!this.timers.has(id) || !flag(spec, 468)) this.timers.set(id, num(spec, 467));
    this.timerRuns.set(id, {
      running: !flag(spec, 471),
      speed: num(spec, 470),
      target: num(spec, 473),
      stopAtTarget: flag(spec, 474),
      ignoreWarp: flag(spec, 469),
      group: this.grp(spec.target),
      spawner: spec.index,
      controlId: spec.controlId,
      paused: false,
      remap: flatten(remap),
    });
  }

  /** Time Event (3615): arms a watch on timer key 80. [gdp activateTimerTrigger :429499-429509] */
  private watchTimer(spec: TriggerSpec, remap: Remap): void {
    this.fork();
    this.timerWatches = [
      ...this.timerWatches,
      {
        timer: clampItemId(int(spec, 80)),
        target: num(spec, 473),
        group: this.grp(spec.target),
        multi: flag(spec, 475),
        last: 0,
        spawner: spec.index,
        remap: flatten(remap),
      },
    ];
  }

  /**
   * One step of every timer, before the moves: a running one adds the step's
   * game time times its speed, and stops on its target if it has one; then
   * each timer's watches see whether it crossed theirs.
   * [gdp GJBaseGameLayer::update :469890 → GJEffectManager::updateTimers
   *  :482625-482826]
   */
  private stepTimers(dt: number): void {
    this.fork();
    // The ids as they stand now: a timer a spawn starts waits for the next step.
    for (const id of [...this.timers.keys()]) {
      const run = this.timerRuns.get(id) ?? IDLE_TIMER;
      const before = this.timers.get(id) ?? 0;
      if (run.running && !run.paused) {
        // The game passes the warp along beside the step; dividing it back
        // out for key 469 is this port's reading of it. [guess]
        const step = run.ignoreWarp && this.timeWarp !== 1 ? dt / this.timeWarp : dt;
        const now = before + step * run.speed;
        const t = run.target;
        if (run.stopAtTarget && ((before < t && now >= t) || (before > t && now <= t))) {
          this.timers.set(id, t);
          this.timerRuns.set(id, { ...run, running: false });
          if (run.group > 0) this.spawnGroup(run.group, run.spawner, false, 0, 0, unflatten(run.remap));
        } else {
          this.timers.set(id, now);
        }
      }
      if (this.timerWatches.length > 0) this.checkTimerWatches(id);
    }
  }

  private checkTimerWatches(id: number): void {
    const speed = (this.timerRuns.get(id) ?? IDLE_TIMER).speed;
    let spent: Set<TimerWatch> | null = null;
    for (const w of this.timerWatches.slice()) {
      if (w.timer !== id) continue;
      const now = this.timers.get(id) ?? 0;
      const crossed = (w.last < w.target && now >= w.target && speed > 0) || (w.last > w.target && now <= w.target && speed < 0);
      if (crossed && !w.multi) (spent ??= new Set()).add(w);
      else w.last = now;
      if (crossed) this.spawnGroup(w.group, w.spawner, false, 0, 0, unflatten(w.remap));
    }
    if (spent) this.timerWatches = this.timerWatches.filter((w) => !spent.has(w));
  }

  /**
   * A collectible (object type 30: the keys, the small coin 1614, the pixel
   * items) the player has just picked up. Key 381 — or key 79 = 1 — adds one
   * to item key 80, or takes one away with key 78; key 382 — or key 79 = 2 —
   * switches group 51 on (and spawns it) or off by key 56; key 383 adds
   * points. The sim calls this once per object, as the game does.
   * [gdp EffectGameObject::customObjectSetup :298721-298772;
   *  collisionCheckObjects case 0x1E :463762-463779 → triggerObject
   *  :314855-314880 → collectedObject :459006-459021, toggleGroupTriggered,
   *  addPoints]
   */
  collected(objectIndex: number): void {
    const props = this.level.objects[objectIndex].props;
    const key = (k: number): number => Math.trunc(Number(props[k] ?? 0)) || 0;
    const mode = key(79);
    if (key(381) !== 0 || mode === 1) this.addCount(key(80), key(78) !== 0 ? -1 : 1, 0);
    if (key(382) !== 0 || mode === 2) this.toggleGroupTriggered(key(51), key(56) !== 0, objectIndex, 0, null);
    const points = key(383);
    if (points !== 0) {
      this.fork();
      this.points += points;
    }
  }

  /**
   * A secret or user coin the player has just picked up: it spawns its group
   * (key 51), unordered and with no remap, as its triggerObject does. The sim
   * does not call this in practice.
   * [gdp EffectGameObject::customObjectSetup LABEL_126 :299550-299556 (+1276);
   *  collisionCheckObjects case 0x16 :463678-463681 → triggerObject
   *  :315158-315160 → LABEL_125 :315442-315457]
   */
  coinCollected(objectIndex: number): void {
    const group = Math.trunc(Number(this.level.objects[objectIndex].props[51] ?? 0)) || 0;
    if (group > 0) this.spawnGroup(group, objectIndex, false, 0, 0);
  }

  /**
   * A trigger orb (1594) the player has just taken: with key 504 it spawns
   * group 51, otherwise it switches group 51 on (and spawns it) or off by key
   * 56, both with no remap. The sim calls this from the orb's ringJump.
   * [gdp RingObject::customObjectSetup :302960-302990 (51 → +1276, 56 →
   *  +1449, 504 → +1636); PlayerObject::ringJump :159943-159945 →
   *  GJBaseGameLayer::activateCustomRing :439065-439098]
   */
  customRingActivated(objectIndex: number): void {
    const props = this.level.objects[objectIndex].props;
    const key = (k: number): number => Math.trunc(Number(props[k] ?? 0)) || 0;
    if (key(504) !== 0) this.spawnGroup(key(51), objectIndex, false, 0, 0);
    else this.toggleGroupTriggered(key(51), key(56) !== 0, objectIndex, 0, null);
  }

  /**
   * After a practice respawn has put the snapshot back: what the game's
   * checkpoint does not keep. The level time carries on from where it was,
   * and runs again if it had stopped; the objects an Animate trigger had
   * started wait for one again. The points and player 1's y history,
   * slot counter and clock all come back with the checkpoint, as the
   * snapshot already has them.
   * [gdp PlayLayer::resetLevel :105781 (resetLevelVariables clears +11304
   *  :462932), :105893-105896 (the level time is only zeroed with no
   *  checkpoint); the points with GJGameState::operator= :105019 from
   *  PlayLayer::loadFromCheckpoint :105527; PlayerObject::saveToCheckpoint
   *  :161569-161571, loadFromCheckpoint :161651-161653]
   */
  respawned(levelTime: number): void {
    this.levelTime = levelTime;
    this.levelTimeStopped = false;
    // The reset puts every object that waits for an Animate trigger back to
    // waiting, and beasts back on their default clip; the checkpoint has no
    // animation state to give back.
    // [PlayLayer::resetLevel :105839-105843 → EnhancedGameObject::resetObject
    //  :170043-170067 → waitForAnimationTrigger; AnimatedGameObject::
    //  resetObject :307238-307249]
    if (this.visual.animationStarts.size > 0) this.visual.animationStarts = new Map();
    if (this.visual.skeletonAnims.size > 0) this.visual.skeletonAnims = new Map();
    this.pendingStarts = 0;
  }

  /**
   * A new attempt's random seed, for one loaded back from a start position's
   * warm-up: the reset seeds the generator before the load, and the load
   * does not carry a seed. [gdp PlayLayer::resetLevel :105790-105797, then
   *  loadFromCheckpoint :105898-105905]
   */
  reseed(seed: number): void {
    this.rng.setSeed(seed);
  }

  /** The level is complete, or an End trigger has fired: the level time stops. */
  stopLevelTime(): void {
    this.levelTimeStopped = true;
  }

  // --- per frame -------------------------------------------------------------

  /**
   * Advances colours, pulses and the screen effects. The game does this once
   * per rendered frame with the whole frame's delta rather than per physics
   * tick. The camera is stepped per tick instead (stepCamera).
   */
  updateVisuals(dt: number): void {
    if (!this.visuals) return;
    this.colors.update(dt);
    this.colors.process();
    // The screen effects' tweens, once a frame with the frame's delta, after
    // the colour fades as the game orders them. [gdp GJBaseGameLayer::update
    //  :469728-469734 → updateShaderLayer :424443ff]
    stepShaderState(this.visual.shader, dt);
    // Area Fade and Tint, once a frame from the visibility pass.
    // [gdp processAreaVisualActions :470151-470155, from updateVisibility]
    if (this.areas.length > 0 || this.areaVisuals.size > 0) this.stepAreaVisuals(dt);
  }

  /**
   * The camera's tweens and edges, once per physics step after the pass-by
   * check, where the game runs updateTweenActions just before updateCamera:
   * a tween a trigger started this step has taken its first step when the
   * step ends. The edges and a Follow static camera's group are read where
   * they are now, as updateCamera reads them. Not called by the start
   * position's warm-up, which never runs them. Run with the visuals off as
   * well: the band a corridor holds the player in depends on the camera
   * (Sim.refreshBand).
   * [gdp GJBaseGameLayer::update :469984-469989 → GJGameState::
   *  updateTweenActions; loadUpToPosition :469428-469517; updateCamera
   *  :449586-449601, :449866-449871]
   */
  stepCamera(dt: number): void {
    const cam = this.camera;
    this.resolveCameraEdges();
    // A paused tween neither steps nor ends. [GJValueTween::step :417576-417577]
    if (cam.zoomTween && !cam.zoomTween.paused) {
      cam.zoom = stepCameraTween(cam.zoomTween, dt);
      if (cameraTweenDone(cam.zoomTween)) cam.zoomTween = null;
    }
    if (cam.offsetXTween && !cam.offsetXTween.paused) {
      cam.offsetX = stepCameraTween(cam.offsetXTween, dt);
      if (cameraTweenDone(cam.offsetXTween)) cam.offsetXTween = null;
    }
    if (cam.offsetYTween && !cam.offsetYTween.paused) {
      cam.offsetY = stepCameraTween(cam.offsetYTween, dt);
      if (cameraTweenDone(cam.offsetYTween)) cam.offsetYTween = null;
    }
    if (cam.rotationTween && !cam.rotationTween.paused) {
      cam.rotation = stepCameraTween(cam.rotationTween, dt);
      if (cameraTweenDone(cam.rotationTween)) cam.rotationTween = null;
    }
    if (cam.mgOffsetTween) {
      cam.mgOffsetY = stepCameraTween(cam.mgOffsetTween, dt);
      if (cameraTweenDone(cam.mgOffsetTween)) cam.mgOffsetTween = null;
    }
    this.stepStaticAxis(cam.staticX, 0, dt);
    this.stepStaticAxis(cam.staticY, 1, dt);
  }

  /** One axis of the static camera: its approach, and where a Follow group is now. */
  private stepStaticAxis(st: StaticCameraAxis, k: 0 | 1, dt: number): void {
    if (st.tween) {
      st.progress = stepCameraTween(st.tween, dt);
      if (cameraTweenDone(st.tween)) st.tween = null;
    }
    if (st.on && st.follow > 0) {
      const at = this.positionOf(this.mainObject(st.follow));
      if (at) st.target = at[k];
    }
  }

  /**
   * A cheap digest of the trigger state that can change what the player hits.
   *
   * Deliberately narrow. Colours, pulses and the camera are left out because
   * they cannot move a hitbox. So is how far the active channel's activation
   * queue has got, and the music clock that drives a platformer's: that
   * progress follows player 1's x in a classic level, its y while gameplay
   * is turned, and the step count in a platformer. The autoplayer only
   * compares nodes of one generation, which share the step count, and its
   * search key carries the position; folding the progress in here would stop
   * two branches a hair apart from being recognised as the same position —
   * which on a level with a colour trigger every few blocks is most of them.
   *
   * Until a trigger has actually toggled, moved or counted something this is
   * zero, so levels 1 to 18 and the opening of every other level pay nothing.
   */
  hash(): number {
    if (
      !this.motion &&
      this.toggleGen === 0 &&
      !this.advFollow?.active &&
      this.commands.length === 0 &&
      this.spawns.length === 0 &&
      this.items.size === 0 &&
      this.timers.size === 0 &&
      this.timerWatches.length === 0 &&
      this.onDeath.length === 0 &&
      this.countListeners.length === 0 &&
      this.eventListeners.length === 0 &&
      this.touchActions.length === 0 &&
      this.points === 0 &&
      !this.levelTimeStopped &&
      this.yHistory === null &&
      this.activeChannel === 0 &&
      this.index.channels.length <= 1
    ) {
      return 0;
    }
    let h = 0x811c9dc5;
    h = Math.imul(h ^ this.toggleGen, 0x01000193);
    h = Math.imul(h ^ this.commands.length, 0x01000193);
    h = Math.imul(h ^ this.spawns.length, 0x01000193);
    h = Math.imul(h ^ this.onDeath.length, 0x01000193);
    h = Math.imul(h ^ this.countListeners.length, 0x01000193);
    for (const l of this.eventListeners) h = Math.imul(h ^ l.event ^ (l.key << 7) ^ (l.group << 14), 0x01000193);
    for (const a of this.touchActions) h = Math.imul(h ^ a.trigger ^ (a.paused ? 0x40000000 : 0), 0x01000193);
    h = Math.imul(h ^ this.points, 0x01000193);
    // Past the end the level time stands still, which an Item Compare can see.
    if (this.levelTimeStopped) h = Math.imul(h ^ 0x5354, 0x01000193);
    // Which channel fires next, which way each pops, and how far the ones not
    // in use got: none of that follows the player or the step count. The
    // active channel's own progress does, and stays out for the reason above.
    if (this.index.channels.length > 1 || this.activeChannel !== 0) {
      h = Math.imul(h ^ this.activeChannel, 0x01000193);
      for (let s = 0; s < this.channelAt.length; s++) {
        const at = s === this.activeSlot ? 0 : this.channelAt[s];
        h = Math.imul(h ^ ((at << 1) | this.channelReversed[s]), 0x01000193);
      }
    }
    if (this.motion) {
      // Groups are walked in id order and identity ones skipped, so the digest
      // depends on where the level *is* and not on how it got there — a group
      // that moved down a branch this one abandoned must not still count.
      if (this.activeMovingStale) void this.movedObjects;
      for (const g of this.movedList) {
        const at = g * M;
        const tx = this.groupM[at + 4];
        const ty = this.groupM[at + 5];
        if (tx === 0 && ty === 0 && this.groupM[at] === 1 && this.groupM[at + 3] === 1) continue;
        h = Math.imul(h ^ g, 0x01000193);
        h = Math.imul(h ^ (tx * 4), 0x01000193);
        h = Math.imul(h ^ (ty * 4), 0x01000193);
      }
    }
    for (const [id, n] of this.items) h = Math.imul(h ^ id ^ (n * 16), 0x01000193);
    // An Item Compare reads timers and an Item Edit writes them.
    for (const [id, t] of this.timers) h = Math.imul(h ^ id ^ (t * 1000), 0x01000193);
    for (const [id, r] of this.timerRuns) h = Math.imul(h ^ id ^ (r.running ? 0x10000 : 0), 0x01000193);
    for (const w of this.timerWatches) h = Math.imul(h ^ w.timer ^ (w.last * 1000), 0x01000193);
    // Follow Player Y with a delay reads player 1's y from up to two seconds
    // back, so two runs standing in the same place can still part later.
    if (this.yHistory) {
      h = Math.imul(h ^ this.yHistoryAt, 0x01000193);
      for (let i = 0; i < Y_HISTORY_SLOTS; i++) h = Math.imul(h ^ (this.yHistory[i] * 4), 0x01000193);
    }
    // Follow Player Y's own lifts, member by member, in index order.
    if (this.followDy) {
      const dy = this.followDy;
      for (const g of [...this.followGroups].sort((a, b) => a - b)) {
        for (const i of this.index.groups.get(g) ?? []) {
          if (dy[i] !== 0) h = Math.imul(h ^ i ^ (dy[i] * 4), 0x01000193);
        }
      }
    }
    if (this.advFollow) h = Math.imul(h ^ this.advFollow.hash(), 0x01000193);
    if (this.advMotion) {
      for (let i = 0; i < this.advMotion.length; i += 3) {
        const dx = this.advMotion[i];
        const dy = this.advMotion[i + 1];
        if (dx !== 0 || dy !== 0) h = Math.imul(h ^ (i / 3) ^ (dx * 4) ^ (dy * 4), 0x01000193);
      }
    }
    // The running areas, and where they have pushed things this step.
    for (const a of this.areas) {
      h = Math.imul(h ^ a.source ^ (a.counter << 12), 0x01000193);
      for (const t of a.tweens) h = Math.imul(h ^ t.key ^ (t.elapsed * 1000), 0x01000193);
    }
    for (const [i, o] of this.areaOffsets) {
      h = Math.imul(h ^ i ^ (o[0] * 4), 0x01000193);
      h = Math.imul(h ^ (o[1] * 4) ^ (o[2] * 4), 0x01000193);
      h = Math.imul(h ^ (o[3] * 1000) ^ (o[4] * 1000), 0x01000193);
    }
    return h >>> 0;
  }

  /** The edge groups where they are now: a group can move, so this is not done when the trigger fires. */
  private resolveCameraEdges(): void {
    const cam = this.camera;
    cam.limitLeft = this.edgeValue(cam.edgeLeft, 0);
    cam.limitRight = this.edgeValue(cam.edgeRight, 0);
    cam.limitTop = this.edgeValue(cam.edgeTop, 1);
    cam.limitBottom = this.edgeValue(cam.edgeBottom, 1);
  }

  /** Where a camera edge group sits, on the axis that edge limits. */
  private edgeValue(group: number, axis: 0 | 1): number | null {
    if (group <= 0) return null;
    const at = this.positionOf(this.mainObject(group));
    return at ? at[axis] : null;
  }

  /** A short line for the debug HUD. */
  describe(): string {
    const live = this.commands.length;
    let fired = 0;
    let total = 0;
    for (let s = 0; s < this.channelAt.length; s++) {
      fired += this.channelAt[s];
      total += this.index.channels[s].specs.length;
    }
    return `triggers ${fired}/${total} fired, channel ${this.activeChannel}  ${live} command${live === 1 ? "" : "s"}  ${this.spawns.length} queued  ${this.colors.activeEffects} effects`;
  }
}

/**
 * An Event trigger's key 430: event ids between dots, each read with atoi, as
 * a set, so in order and each once. [gdp EventLinkTrigger::customObjectSetup
 *  :314006-314095]
 */
function eventList(raw: string | undefined): number[] {
  if (!raw) return [];
  const out = new Set<number>();
  for (const part of raw.split(".")) if (part !== "") out.add(parseInt(part, 10) || 0);
  return [...out].sort((a, b) => a - b);
}

/**
 * The furthest object along x, and 0 at least, which the end portal is placed
 * from. [gdp PlayLayer::addObject :89885-89888 (float 2957);
 *  createObjectsFromSetupFinished :102163]
 */
function lastObjectX(level: Level): number {
  let x = 0;
  for (const o of level.objects) if (o.x > x) x = o.x;
  return x;
}

/** An item, timer or counter id clamped to 0..9999, as the effect manager clamps every one. */
function clampItemId(id: number): number {
  return id > MAX_ITEM_ID - 1 ? MAX_ITEM_ID : id < 0 ? 0 : id;
}

/** C's round and lroundf: halves go away from zero. */
function roundHalfAway(v: number): number {
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

/** A double cast to int, as the ARM conversion does it: towards zero, saturating, NaN to 0. */
function toInt(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(-2147483648, Math.min(2147483647, Math.trunc(v)));
}

/**
 * An item trigger's modifier or tolerance, rounded to thousandths as a float.
 * [gdp activateItemCompareTrigger :429396-429398, activateItemEditTrigger :459153]
 */
function thousandths(v: number): number {
  return Math.fround(roundHalfAway(Math.fround(Math.fround(v) * 1000)) / 1000);
}

/** 1 +, 2 -, 3 x, 4 / (by 0 gives 0); anything else 0. [gdp GJBaseGameLayer::performMathOperation :429227-429253] */
function mathOperation(a: number, b: number, op: number): number {
  switch (op) {
    case 1:
      return a + b;
    case 2:
      return a - b;
    case 3:
      return a * b;
    case 4:
      return b === 0 ? 0 : a / b;
    default:
      return 0;
  }
}

/** 1 round, 2 floor, 3 ceiling; 0 leaves it. [gdp GJBaseGameLayer::performMathRounding :429269-429284] */
function mathRounding(v: number, mode: number): number {
  return mode === 1 ? roundHalfAway(v) : mode === 2 ? Math.floor(v) : mode === 3 ? Math.ceil(v) : v;
}

/** 1 makes it positive, 2 negative; 0 leaves it. [gdp performMathSign :429300-429314] */
function mathSign(v: number, mode: number): number {
  return mode === 1 ? Math.abs(v) : mode === 2 ? -Math.abs(v) : v;
}

/** Guards the divide in a scale step; the game clamps the same way. */
function safeRatio(now: number, prev: number): number {
  const a = Math.abs(now) < 0.01 ? (now < 0 ? -0.01 : 0.01) : now;
  const b = Math.abs(prev) < 0.01 ? (prev < 0 ? -0.01 : 0.01) : prev;
  return a / b;
}

/** How many passes stepCommands makes before the two follows. */
const COMMAND_PASSES = 4;

/**
 * The pass a command steps in: scales, then rotates and aims, then dynamic
 * moves, then moves and fades. -1 for the two follows, which step after them
 * all. An aim works out its turn in its pass; the game works out a dynamic
 * one's before the scales and queues it behind the rotates.
 * [gdp processMoveActionsStep :469394-469398; processDynamicObjectActions(1)
 *  :445475-445491 → registerRotationCommand :481259]
 */
function commandPass(c: Command): number {
  switch (c.kind) {
    case "scale":
      return 0;
    case "keyframe":
      return 0;
    case "rotate":
    case "aim":
      return 1;
    case "move":
      return c.dynamic ? 2 : 3;
    case "alpha":
      return 3;
    default:
      return -1;
  }
}

/**
 * fixedAngle for a level without kA41: the solids (breakables among them) and
 * slopes, which the object set keeps as K_SOLID and K_SLOPE. The set leaves out
 * an object with key 121, as the game makes one decoration.
 */
function fixedAngles(objs: ObjectSet): Uint8Array {
  const out = new Uint8Array(objs.n);
  for (let i = 0; i < objs.n; i++) out[i] = objs.kind[i] === K_SOLID || objs.kind[i] === K_SLOPE ? 1 : 0;
  return out;
}
