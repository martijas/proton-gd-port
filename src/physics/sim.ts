// The deterministic 240 Hz simulation: GJBaseGameLayer::update's per-step
// order (buttons → resetTouchedRings → player.update → checkCollisions →
// updateRotation), the object interactions (portals, orbs, pads, force
// blocks, collectibles, teleports), the squeeze tests, dual mode and the
// snapshot/restore the autoplayer leans on.

import { pickStartPosition } from "../level/decode";
import type { GameMode, Level, LevelObject, Speed, StartPosition } from "../level/types";
import {
  applyGroupTransform,
  reflectObject,
  collideSlope,
  collideSolid,
  F_CHECKED,
  F_CLAIM_TOUCH,
  F_DASH_ALLOW_COLLIDE,
  F_DASH_STOP_SLIDE,
  F_EXTENDED,
  F_FLIP_Y,
  F_FREE_MODE,
  F_MULTI,
  F_NO_SNAP,
  F_REVERSE,
  F_SHARED,
  F_SOLID_ABOVE,
  F_UPHILL,
  FORCE_RANGE,
  FORCE_RELATIVE,
  K_CHECKPOINT,
  K_COLLECTIBLE,
  K_FORCE,
  K_HAZARD,
  K_NONE,
  K_ORB,
  K_PAD,
  K_PORTAL,
  K_SLOPE,
  K_SOLID,
  K_SPECIAL,
  ORB_TYPES,
  ObjectSet,
  objectExtent,
  PAD_TYPES,
  P_DUAL_OFF,
  P_DUAL_ON,
  P_GRAV_FLIP,
  P_GRAV_NORMAL,
  P_GRAV_TOGGLE,
  P_MIRROR_OFF,
  P_MIRROR_ON,
  P_MODE_BASE,
  P_SIZE_MINI,
  P_SIZE_NORMAL,
  P_SPEED_BASE,
  P_TP_LINKED_ENTRY,
  P_TP_TARGET_ENTRY,
  R_BREAK,
  R_DIE,
  S_AABB,
  S_CIRCLE,
  S_OBB,
  S_TRI,
  ST_ACT_P1,
  ST_ACT_P2,
  ST_DESTROYED,
  ST_TOUCH_P1,
  ST_TOUCH_P2,
} from "./collision";
import {
  BALL_CORRIDOR_HEIGHT,
  COLLISION_SECTION_SCALE,
  CORRIDOR_GRID,
  DASH_DEG,
  DASH_MAX_ANGLE,
  FLY_CORRIDOR_HEIGHT,
  FLOOR_Y,
  FORCE_DEG,
  FRAME_DT,
  GAME_GROUND_Y,
  LETTER_BLOCK_PASSES,
  maxGameplayYFor,
  MIN_GAMEPLAY_X,
  OPEN_CEILING,
  PAD_BLUE_BUMP,
  PAD_PINK_BUMP,
  PAD_RED_BUMP,
  PLATFORMER_DASH_SPEED,
  PLAYER_START_X,
  PLAYER_START_Y,
  POST_FLIP_SNAP_GRACE,
  SCALE_SNAP_PASSES,
  SPIDER_BEHIND_SLACK,
  SPIDER_CORRIDOR_HEIGHT,
  SPIDER_HAZARD_STRIP,
  SPIDER_RETRY_WIDEN,
  SPIDER_SEARCH_RANGE,
  SQUEEZE_FACTOR,
  SQUEEZE_FACTOR_PLATFORMER,
  SQUEEZE_NUDGE,
  SQUEEZE_NUDGE_TRIES,
  SQUEEZE_WALL_MARGIN,
  usesYSections,
} from "./constants";
import {
  circleHitsCircle,
  DEG,
  isFacingDown,
  isFacingLeft,
  obbsTouch,
  rectCornersHitCircle,
  rectHitsCircle,
  rectHitsObb,
  rectHitsTriangle,
  rectsTouch,
} from "./geometry";
import { floatY, MODE_BY_INDEX, Player, type PlayerWorld } from "./player";
import { startModeOf } from "./levelModes";
import { TimeTable } from "./timeTable";
import { buildTriggerIndex, type TriggerIndex } from "../triggers/spec";
import { cameraTweenDone, stepCameraTween, type CameraTween } from "../triggers/easing";
import { Camera, groundLayers } from "../render/camera";
import { designSize } from "../ui/viewport";
import {
  AUDIO_EVENT_KINDS,
  EVENT_JUMP_PUSH,
  EVENT_JUMP_RELEASE,
  EVENT_LEFT_PUSH,
  EVENT_LEFT_RELEASE,
  EVENT_PICKUP_ITEM,
  EVENT_RIGHT_PUSH,
  EVENT_RIGHT_RELEASE,
  EVENT_USER_COIN,
  TriggerRuntime,
  type GameplayRotation,
  type LevelEnd,
  type TriggerSnapshot,
} from "../triggers/runtime";
import { NO_INPUT, TICK_DT, type ObjectTable, type PlayerInput, type PlayerState, type Rect, type Sim, type SimEvent, type SimOptions, type SimSnapshot, type SimWave, type StartState, type WaveCause, type WorldShape } from "./types";
import { TOGGLE_BLOCK_ID } from "./objectData";

/** teleportPlayer's target for a 747: its own exit, key 54 over it. */
const LINKED_EXIT = -2;
/**
 * An object's switches that decide whether its circles are made, as bits
 * (SimImpl.effectBits): "no effects" (key 116, +900), hidden in play (key
 * 135, +1106), and a pickup's own particle (key 440, +1504), which takes the
 * place of the default one and its circle.
 * [gdp GameObject::objectFromVector :184116-184126 (116), :184143-184146
 *  (135); EffectGameObject::customObjectSetup :298744-298747 (440)]
 */
const EFFECT_NONE = 1;
const EFFECT_HIDDEN = 2;
const EFFECT_OWN_PARTICLE = 4;
/** The small coin, whose pickup effect has no circle. [GameObject::spawnDefaultPickupParticle :622151-622155] */
const SMALL_COIN_ID = 1614;
/** The exits and portals a teleport faces out of at 180 rather than 90. [gd-ida-decomp.cpp:462388-462416] */
const TELEPORT_EXIT_FACING_IDS: ReadonlySet<number> = new Set([38, 747, 749, 2064, 2902]);
/**
 * How far past the view's top or bottom a teleport or a spider's jump may
 * land the player before the camera snaps to it: 60, or 180 for a teleport
 * with key 55. [gdp teleportPlayer :462461-462464; the spider's
 * :155226-155229]
 */
const TELEPORT_CAMERA_MARGIN = 60;
const TELEPORT_CAMERA_MARGIN_SLOW = 180;
/** Dash, the one classic official level the game plays with kA40 forced on. [gd-ida-decomp.cpp:462939] */
const DASH_LEVEL_ID = 22;
const CANDIDATE_CAP = 2048;
/** Query margin around the player rect: covers one tick of motion plus the snap thresholds. */
const QUERY_MARGIN = 40;
/**
 * How far the pass's portals, pads and orbs may move the player before the
 * solids and hazards are looked for again around where it is now: whatever
 * the margin has left once the solids' own snaps are allowed for. A spider pad
 * or orb, or a teleport, moves it further. The game has no second look: it
 * collects every solid and hazard in the pass's section window and tests them
 * all, so this is only the port's query catching up, and it keeps to that
 * window.
 */
const REQUERY_DISTANCE = QUERY_MARGIN / 2;
/** Rows a column of sections can hold before the order key runs out of room: 409,600 units of height. */
const SECTION_ROWS = 4096;
/**
 * The section an object with extended collision is met in: past every real
 * one, as the game tests those objects after its section walk.
 * [gdp GJBaseGameLayer::checkCollisions :464968-464970]
 */
const EXTENDED_SECTION = 2 ** 31;
/**
 * How far player 1's y delta may stray from its update's own y step before
 * the move commands take it as none, in units a frame: 4 a step at 240 Hz.
 * [GJBaseGameLayer::update, gd-ida-decomp.cpp:469865]
 */
const MOVE_DY_SLACK_PER_FRAME = 16;

/**
 * The warm-up to a start position steps a sixtieth of a second at a time (the
 * float 1/60) for at most an hour of level time.
 * [gdp GJBaseGameLayer::loadUpToPosition, gd-ida-decomp.cpp:469459-469473;
 *  GeometryDash.exe holds 1/60 as 0x3c888889 at 0x620fb8]
 */
const WARM_UP_STEP = Math.fround(1 / 60);
const WARM_UP_CAP = 3600;

/**
 * The window the band is measured against, in design units: a 16:9 one, so
 * the band is a function of the sim rather than of the window. Only a window
 * narrower than 3:2 is taller than 320, and only a turned view is wider.
 */
const BAND_VIEW = designSize(16 / 9);
/**
 * How long the ground layers take to slide in: the first time, and when a
 * new height or a dual moves them. Out again takes 0.4, or 0.3 in a dual.
 * Eased in and out, at rate 2 in and 1.5 out.
 * [gdp animateInDualGroundNew :451075-451128 (0.5 and 0.4); animateOutGroundNew
 *  :448965-448985 (0.4 and 0.3)]
 */
const GROUND_IN_FIRST = 0.5;
const GROUND_IN_AGAIN = 0.4;
const GROUND_OUT = 0.4;
const GROUND_OUT_DUAL = 0.3;

/** An object's position less its lastPosition, as floats, and the step it was taken in. */
interface ObjectMotion {
  readonly dx: number;
  readonly dy: number;
  readonly tick: number;
}

interface SnapData {
  p1: Player;
  p2: Player | null;
  floorY: number;
  ceilingY: number;
  ground: GroundState;
  camera: Camera;
  dual: boolean;
  modePortal: number | null;
  dualPortal: number | null;
  corridorFree: boolean;
  corridorNoSnap: boolean;
  objState: Uint8Array;
  motion: Map<number, ObjectMotion>;
  eventsLen: number;
  triggers: TriggerSnapshot;
  lastPlayerX: number;
  lastPlayerY: number;
  end: LevelEnd | null;
  /**
   * A platformer checkpoint object's (+340 on player 1's saved state): player
   * 1 was put at the respawn point, and a respawn from it lets go of player
   * 1's buttons, stops its fall and takes it off the ground.
   */
  placed: boolean;
  /** Key 448 of the platformer checkpoint this snapshot is, spawned on a respawn from it; 0 for any other. */
  respawnGroup: number;
}

/**
 * The corridor's two ground layers as the layer keeps them. They are placed
 * on the screen, not in the level: `height` units of the screen apart,
 * centred on it once they have slid in, so the band they bound is height /
 * zoom units of the level around the camera's centre.
 */
interface GroundState {
  /** Whether they are in (+688). */
  in: boolean;
  /** The band's middle the anchor gave, snapped and clamped, in the port's y (+680 less 90). */
  mid: number;
  /** The band's height in screen units (+652). */
  height: number;
  /** How far they have slid in, 0 to 1 (+872), and its tween (0x19). */
  slide: number;
  tween: CameraTween | null;
  /**
   * The static y count the corridor took the camera with, or -1: while the
   * static y still has it, nobody else has taken the camera over (+576).
   */
  cameraSeq: number;
}

function newGroundState(): GroundState {
  return { in: false, mid: 0, height: 0, slide: 0, tween: null, cameraSeq: -1 };
}

/**
 * The band one mode asks for, before the dual rule widens it.
 *
 * 270 is the game's "no corridor" answer as well as the spider's real one, so
 * the caller tells the two apart by the mode rather than by the number.
 * [gdp GJBaseGameLayer::getGroundHeightForMode, gd-ida-decomp.cpp:419619-419650
 *  — ship/UFO/wave/swing 300, ball 240, everything else 270]
 */
function groundHeightForMode(mode: GameMode): number {
  switch (mode) {
    case "ship":
    case "ufo":
    case "wave":
    case "swing":
      return FLY_CORRIDOR_HEIGHT;
    case "ball":
      return BALL_CORRIDOR_HEIGHT;
    default:
      return SPIDER_CORRIDOR_HEIGHT;
  }
}

/**
 * Moves a rotated player between the world's axes and its own.
 *
 * A swap is its own inverse, so the same call goes in and comes back out. Only
 * the fields that hold a world position move; the velocities are already the
 * player's own, which is the point of the whole arrangement.
 */
function swapPlayerAxes(p: Player): void {
  const x = p.x;
  p.x = p.y;
  p.y = x;
  p.axesSwapped = !p.axesSwapped;
  const lx = p.lastX;
  p.lastX = p.lastY;
  p.lastY = lx;
}

const objectSetCache = new WeakMap<Level, WeakMap<ObjectTable, ObjectSet>>();
const triggerIndexCache = new WeakMap<Level, WeakMap<ObjectTable, TriggerIndex>>();

/**
 * The trigger index is immutable and, like ObjectSet, shared by every sim of a
 * level: it holds the activation order, the group membership and the enter
 * effects, none of which can change while a level plays.
 */
function triggerIndexFor(level: Level, table: ObjectTable): TriggerIndex {
  let byTable = triggerIndexCache.get(level);
  if (!byTable) triggerIndexCache.set(level, (byTable = new WeakMap()));
  let index = byTable.get(table);
  if (!index) byTable.set(table, (index = buildTriggerIndex(level, (id) => table.get(id).kind === "trigger")));
  return index;
}

function objectSetFor(level: Level, table: ObjectTable): ObjectSet {
  let byTable = objectSetCache.get(level);
  if (!byTable) objectSetCache.set(level, (byTable = new WeakMap()));
  let set = byTable.get(table);
  if (!set) byTable.set(table, (set = new ObjectSet(level, table)));
  return set;
}

/**
 * GJBaseGameLayer::getBumpMod: what a yellow, pink or red pad is worth for
 * the player's mode, before propellPlayer's 16. Mini means a scale under 1,
 * which the ship and UFO read for the red pad alone.
 * [gdp GJBaseGameLayer::getBumpMod, gd-ida-decomp.cpp:421316-421366]
 */
export function getBumpMod(p: Player, type: "yellow" | "pink" | "red"): number {
  if (type === "pink") {
    if (p.isShip) return PAD_PINK_BUMP.ship;
    if (p.isUfo) return PAD_PINK_BUMP.ufo;
    if (p.isBall || p.isSpider) return PAD_PINK_BUMP.ballOrSpider;
    return PAD_PINK_BUMP.other;
  }
  if (type === "red") {
    if (p.isShip) return p.mini ? PAD_RED_BUMP.shipMini : PAD_RED_BUMP.ship;
    if (p.isUfo) return p.mini ? PAD_RED_BUMP.ufoMini : PAD_RED_BUMP.ufo;
    return PAD_RED_BUMP.other;
  }
  return 1;
}

/**
 * The game's "same mode" test for linked dual gravity: the ship, ball, UFO,
 * spider, robot and swing flags compared one by one. The wave's is not among
 * them, so a wave and a cube pass. [gd-ida-decomp.cpp:420166-420171]
 */
function sameModeButWave(a: Player, b: Player): boolean {
  return (
    a.isShip === b.isShip &&
    a.isBall === b.isBall &&
    a.isUfo === b.isUfo &&
    a.isSpider === b.isSpider &&
    a.isRobot === b.isRobot &&
    a.isSwing === b.isSwing
  );
}

export class SimImpl implements Sim, PlayerWorld {
  tick = 0;
  readonly events: SimEvent[] = [];
  readonly waves: SimWave[] = [];
  /**
   * The rings that are powered on (RingObject +644), by object index, with
   * the step that last touched each. A ring powers on when a pass touches it
   * and off when a step goes by without a touch or a press takes it; only
   * powering on draws anything (SimWave "ringPower"), so this is not part of
   * a snapshot, and a restore powers every ring off, as the game's reset does.
   * [gdp GJBaseGameLayer::playerTouchedRing :463276-463292 → RingObject::
   *  powerOnObject :306767-306787 (EnhancedGameObject::powerOnObject
   *  :164059-164065 stamps the step); processStateObjects :421383-421410 →
   *  EnhancedGameObject::updateState :181603-181610 (powerOffObject, vtable
   *  908, for a ring the step did not touch); ringJump :159956-159960 (908
   *  after a ring fires); RingObject::resetObject :297985-297988]
   */
  private readonly ringPower = new Map<number, number>();
  /** processStateObjects' power-off, made once: the step loop runs it every step. */
  private readonly powerOffUntouched = (touched: number, i: number, rings: Map<number, number>): void => {
    if (touched < this.tick) rings.delete(i);
  };
  /**
   * The object each player last met (PlayerObject +2116, with +2032 where it
   * was), by player number less one; -1 for none. A portal circle stands on
   * it rather than on the portal that made it (spawnPortalCircle), which is
   * the same object but for three cases: a linked dual's other player turned
   * by a gravity portal, and the mirror and solo portals, whose circle is
   * always player 1's. It is not in a snapshot: every reset forgets it, as
   * player 2's own reset does at each dual's start, and a checkpoint's dual
   * puts player 1's back on the portal that held the camera.
   * [gdp the writers: GJBaseGameLayer::processCameraObject :420086-420090
   *  (every mode portal), bumpPlayer :463186-463193, gravBumpPlayer
   *  :463249-463252, collisionCheckObjects's gravity, mirror, size and dual
   *  portals :463503-463844, teleportPlayer :462332-462333 and
   *  :462419-462420 (the entry, then the exit), enterDualMode :420955-420956
   *  from PlayLayer::loadFromCheckpoint :105568-105573; PlayerObject::
   *  resetObject :153636-153637, from resetPlayer at every reset and from
   *  toggleDualMode :462652 on player 2]
   */
  private readonly lastMet = new Int32Array([-1, -1]);
  /** The object last met is a linked teleport's exit (SimWave.exit), not the portal. */
  private readonly lastMetExit = new Uint8Array(2);
  /** Keys 116, 135 and 440 per object as EFFECT_* bits, read on first use; -1 not yet read. */
  private effectBitsOf: Int8Array | null = null;
  floorY = FLOOR_Y;
  ceilingY = OPEN_CEILING;
  dual = false;
  /**
   * The portal that last switched mode, which is what the corridor hangs from
   * outside a dual. The game keeps it on the layer rather than on the player.
   * [gdp GJBaseGameLayer::playerWillSwitchMode `this+844 = portal`,
   *  gd-ida-decomp.cpp:462521]
   */
  private modePortal: number | null = null;
  /**
   * The dual portal, kept for the whole dual section and cleared on the way
   * out. While it is set it outranks `modePortal` as the corridor's anchor,
   * which is the part this port had wrong.
   * [gdp GJBaseGameLayer::toggleDualMode `this+848`, gd-ida-decomp.cpp:462662,
   *  462693]
   */
  private dualPortal: number | null = null;
  /**
   * The start position this run began from, or null: the corridor's anchor
   * when no portal has set one, and in a dual when the dual portal has not.
   * Fixed for the run. [gdp GJBaseGameLayer::getTargetFlyCameraY
   *  :420349-420385, +10848]
   */
  private readonly startPos: StartPosition | null;
  /** See Sim.startPosition. */
  readonly startPosition: number;
  /** See Sim.startTime. */
  readonly startTime: number;
  /**
   * Whether the corridor is switched off entirely. Layer state in the game, not
   * a property of the portal that set it: every mode or dual portal rewrites
   * it from its key 111, and so does a Camera Mode trigger.
   * [gdp GJBaseGameLayer::updateCameraMode `this+689`, gd-ida-decomp.cpp:451196]
   */
  private corridorFree = false;
  /**
   * Whether the corridor floor skips the 30-unit snap. Off in every official
   * level; key 370 on a mode or dual portal or a Camera Mode trigger switches
   * it on.
   * [gdp GJBaseGameLayer::updateCameraMode `this+690 = trigger+1568`,
   *  gd-ida-decomp.cpp:451197; read in animateInDualGroundNew :451069]
   */
  private corridorNoSnap = false;
  /** See GroundState. */
  private ground: GroundState = newGroundState();
  /**
   * The camera, followed here as the scene follows its own, at a 16:9 window:
   * where it is decides the band while a Static Camera trigger holds the
   * view's y (refreshBand). [gdp GJBaseGameLayer::getMinPortalY
   *  :420443-420489, +1028]
   */
  private readonly camera = new Camera();
  readonly platformer: boolean;
  /** kA32: see Player.fallingBugged. */
  readonly fixGravityBug: boolean;
  /**
   * Whether a player caught between a floor and a ceiling dies: kA31, or any
   * platformer. The game keeps the opposite in each player (+2492).
   * [gdp GJBaseGameLayer::resetLevelVariables, gd-ida-decomp.cpp:462941-462955;
   *  read by PlayerObject::postCollision :158532]
   */
  readonly squeezes: boolean;
  /** How high the player may go before it is out of bounds. */
  readonly maxGameplayY: number;
  /** The level mirrored across y = x, for rotated gameplay; built on first use. */
  private reflected: ObjectSet | null = null;
  /** The level as collision sees it this instant: the world, or the mirror. */
  private collSet!: ObjectSet;
  /** Set while a rotated player is swapped into its own frame. */
  private inLocalFrame = false;
  /** Geometry as the level stored it, shared between sims and never written to. */
  readonly baseObjs: ObjectSet;
  /** Geometry as it is now: the same object unless a trigger can move something. */
  readonly objs: ObjectSet;
  readonly triggers: TriggerRuntime;
  private readonly p1: Player;
  private p2: Player | null = null;
  private objState: Uint8Array;
  private objStateShared = false;
  /** Each moved object's last move (recordMotion), copied on write once a snapshot shares it. */
  private motion = new Map<number, ObjectMotion>();
  private motionShared = false;
  private hashDirty = true;
  private hashCache = 0;
  private readonly noclip: boolean;
  /** Practice mode (see SimOptions.practice). Not part of a snapshot or the hash. */
  private practice: boolean;
  /** The secret coins (142), by object index: see coinsTaken and respawnFrom. */
  private readonly secretCoins: Int32Array;
  private readonly onEvent: ((e: SimEvent) => void) | undefined;
  /** kA39 "fix radius collision": circular hazards test against a circular player. */
  private readonly circleFix: boolean;
  /** Whether the level keeps its objects in rows as well as columns: see usesYSections. */
  private readonly ySections: boolean;
  /**
   * The section window of the collision pass under way, fixed as it begins:
   * see sectionWindow. Scratch, like `cand`: every pass sets it before use.
   */
  private winCol = 0;
  private winRow = 0;
  /**
   * Whether a pad ends a robot's held jump: kA34, or any platformer.
   * [gdp PlayerObject::bumpPlayer, gd-ida-decomp.cpp:157053-157054;
   *  +2408 = !kA34 at :430562-430563]
   */
  private readonly padsEndRobotHold: boolean;
  /**
   * Whether a toggle orb spends the press: +2497, which is off with kA40
   * "Enable 2.2 Changes" and off in the official levels the game turns kA40
   * on for — every platformer one, and Dash.
   * [gdp PlayerObject::ringJump :159943-159946; GJBaseGameLayer::resetLevelVariables
   *  :462937-462940 (kA40 and the official override), :462962-462964 (+2497)]
   */
  private readonly toggleOrbSpendsPress: boolean;
  private readonly cand = new Int32Array(CANDIDATE_CAP);
  private readonly keys = new Float64Array(CANDIDATE_CAP);
  private readonly list = new Int32Array(CANDIDATE_CAP);
  private readonly stamp: Int32Array;
  private stampId = 0;
  private readonly tri = new Float64Array(6);
  /**
   * The spider's search keeps its own lists: it can run in the middle of the
   * collision pass, from a spider pad or orb, while `cand` is still being read.
   */
  private readonly spiderStatics = new Int32Array(CANDIDATE_CAP);
  private readonly spiderHazards = new Int32Array(CANDIDATE_CAP);
  private readonly spiderKeys = new Float64Array(CANDIDATE_CAP);
  private readonly spiderOrder = new Float64Array(CANDIDATE_CAP);
  private readonly extent = new Float64Array(4);
  /** Scratch for a group's affine, self-spin and scale while geometry is rebuilt. */
  private readonly m6 = new Float64Array(9);
  /**
   * Where player 1 stood when its last update began: the game's lastPosition
   * (+1052), which a teleport does not touch. Player.lastX/lastY are not it —
   * they double as the collision log, which a teleport resets.
   * [gdp PlayerObject::update :161026; PlayLayer::resetLevel :105934-105936]
   */
  /** This step's player delta in 60ths: 0.25, or less under a time warp (see step). */
  private frameDt = FRAME_DT;
  private lastPlayerX = 0;
  private lastPlayerY = 0;
  /**
   * How an End trigger ended the level, once one has: where the players are
   * flown and the trigger's switches, for the finish's sound and whatever
   * draws it. Null for a level that has not ended or ended by running off its
   * right edge.
   */
  end: LevelEnd | null = null;
  /** The platformer checkpoint the last step laid down, until the host takes it. */
  private checkpointMarked: SimSnapshot | null = null;
  /**
   * The speed a portal queued during this step, or -1. It never outlives the
   * step that set it, so snapshots and the state hash have nothing to carry.
   */
  private pendingSpeed: Speed | -1 = -1;
  /**
   * Where this step's input left player 2's button, worked out even while
   * there is no player 2, so that a two-player dual starts with the button
   * where it is. Written before every step's collision passes, so snapshots
   * and the state hash have nothing to carry.
   */
  private rawJump2 = false;

  constructor(
    readonly level: Level,
    readonly objects: ObjectTable,
    opts: SimOptions,
  ) {
    this.platformer = level.header.platformer;
    this.fixGravityBug = level.header.fixGravityBug;
    this.squeezes = level.header.playerSqueeze || this.platformer;
    this.maxGameplayY = maxGameplayYFor(level);
    this.baseObjs = objectSetFor(level, objects);
    const index = triggerIndexFor(level, objects);
    // kA40 "Enable 2.2 Changes", which the game also turns on for its own
    // platformer levels and Dash. [gdp resetLevelVariables :462937-462940]
    const kA40Forced = level.officialId !== undefined && (this.platformer || level.officialId === DASH_LEVEL_ID);
    const changes22 = level.header.enable22Changes || kA40Forced;
    // An enabled start position is picked as the level loads and the run
    // starts there; a start given here (a debug jump) outranks it.
    const startPos = opts.start ? null : pickStartPosition(level);
    this.triggers = new TriggerRuntime(level, this.baseObjs, index, {
      visuals: opts.visuals,
      seed: opts.seed,
      player1: opts.player1,
      player2: opts.player2,
      attempt: opts.attempt,
      changes22,
      shader: opts.shader,
      levelTop: this.maxGameplayY,
      fromStartPosition: startPos !== null || opts.start !== undefined,
    });
    // A level with nothing to move keeps reading the shared arrays, which is
    // every one of levels 1 to 18 and most of the rest until a Move trigger
    // actually fires.
    this.objs = index.movingObjects.length > 0 ? this.baseObjs.cloneForMotion() : this.baseObjs;
    this.collSet = this.objs;
    this.objState = new Uint8Array(this.objs.slotCount);
    this.stamp = new Int32Array(this.objs.n);
    this.noclip = opts.noclip === true;
    this.practice = opts.practice === true;
    const coins: number[] = [];
    for (let i = 0; i < this.baseObjs.n; i++) {
      if (this.baseObjs.kind[i] !== K_COLLECTIBLE || this.baseObjs.slot[i] < 0) continue;
      if (objects.get(level.objects[i].id).collectible === "secretCoin") coins.push(i);
    }
    this.secretCoins = Int32Array.from(coins);
    this.onEvent = opts.onEvent;
    this.circleFix = level.header.fixRadiusCollision;
    this.ySections = usesYSections(level);
    this.padsEndRobotHold = this.platformer || level.header.fixRobotJump;
    this.toggleOrbSpendsPress = !changes22;
    this.p1 = new Player(this, 1);
    this.startPos = startPos;
    this.startPosition = this.startPos ? this.startPos.index : -1;
    this.reset(opts.start);
    // Where the warm-up left the music clock, which is 0 without one.
    this.startTime = this.triggers.musicTime;
  }

  get state(): PlayerState {
    return this.p1;
  }

  get corridorHeight(): number {
    return this.ground.height;
  }

  get corridorSlide(): number {
    return this.ground.slide;
  }

  get state2(): PlayerState | null {
    return this.p2;
  }

  // ---------------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------------

  private reset(start: Partial<StartState> | undefined): void {
    const h = this.level.header;
    const sp = this.startPos;
    this.motion = new Map();
    this.motionShared = false;
    // resetPlayer: the start position, else the level's spawn group — its
    // main object or, failing that, a member — else (0, 105), which is
    // (0, 15) here. A platformer takes the spawn group's x and y, a classic
    // level its y alone. [gdp GJBaseGameLayer::resetPlayer :425029-425078,
    //  the object's position (getRealPosition, vtable +672, where nothing has
    //  moved it yet); tryGetObject
    //  :424989-425015, whose random member the first stands in for]
    let x = PLAYER_START_X;
    let y = PLAYER_START_Y;
    if (sp) {
      x = sp.x;
      y = sp.y;
    } else if (h.spawnGroup > 0) {
      const at = this.triggers.targetObjectOf(h.spawnGroup);
      if (at >= 0) {
        const o = this.level.objects[at];
        if (this.platformer) x = o.x;
        y = o.y;
      }
    }
    // setupLevelStart, from the start position's block or the header, with
    // the mode as startModeOf picks it. kA28 "Mirror Mode" is in the block but
    // nothing at the start reads it.
    // [gdp GJBaseGameLayer::setupLevelStart :462728-462821; PlayLayer::init
    //  :106416-106422 and resetLevel :105897-105912 pass the start position's
    //  block]
    const from = sp ?? {
      speed: h.startSpeed,
      mini: h.startMini,
      dual: h.startDual,
      flipped: h.startFlipped,
      reversed: h.startReversed,
      rotated: h.startRotated,
    };
    const s: StartState = {
      x,
      y,
      mode: startModeOf(this.level, sp),
      speed: from.speed,
      mini: from.mini,
      flipped: from.flipped,
      dual: from.dual,
      mirrored: false,
      reversed: from.reversed,
      rotated: from.rotated,
      ...(start ?? {}),
    };
    const p = this.p1;
    // The start is a float point in the game's space like every other position.
    p.setWorldPosition(s.x, s.y);
    p.lastX = p.x;
    p.lastY = p.y;
    // The flags before the setters, so a ball's roll, which the speed starts,
    // turns the way the start's gravity, direction and turn say.
    p.mini = s.mini;
    p.flipped = s.flipped;
    p.mirrored = s.mirrored;
    p.reversed = s.reversed;
    p.rotated = s.rotated;
    p.setMode(s.mode);
    p.setSpeed(s.speed);
    // resetObject sets the scale to 0.6 and grows the player back from it, so
    // a platformer starts with the grown-back snap armed. The platformer flag
    // is already set by then. [gdp PlayerObject::resetObject, gd-ida-decomp.cpp:
    // 153659-153660 → togglePlayerScale :150416-150418; loadLevelSettings
    // :430554-430555 before resetPlayer :106263]
    p.scaleSnapPasses = this.platformer ? SCALE_SNAP_PASSES : 0;
    // No portal has been crossed yet, so the band hangs from the start
    // position, or opens on the ground without one, and neither player has
    // met anything.
    this.forgetMet();
    this.modePortal = null;
    this.dualPortal = null;
    this.corridorFree = false;
    this.corridorNoSnap = false;
    this.ground = newGroundState();
    this.updateCorridor(p, s.mode, true);
    if (s.dual) this.enterDual(p, null);
    // The last position is set before the warm-up or the reset's pass-by
    // check, and a teleport either makes does not move it.
    // [gdp PlayLayer::resetLevel :105932-105938, then :105939-105963]
    this.lastPlayerX = p.x;
    this.lastPlayerY = p.y;
    if (sp) this.warmUp(sp, s);
    else this.checkPassedAtReset();
    // Nothing the reset fired lays the corridor again: the layer is still
    // resetting (+10949). [gdp GJBaseGameLayer::updateZoom :451293;
    //  resetLevelVariables :463007, PlayLayer::resetLevel :106011]
    this.triggers.pendingGround = null;
    this.resetCamera();
  }

  /**
   * The pass-by check a reset makes before the first step: what sits at or
   * behind player 1's start fires at time 0, with whatever it does to the
   * player. After a start position's warm-up it is the warm-up's last act.
   * [gdp PlayLayer::resetLevel :105954-105963; PlayLayer::init :106486]
   */
  private checkPassedAtReset(): void {
    const p = this.p1;
    // Where the camera will open, for an Animate trigger with key 214; no
    // animation starts before the first step.
    this.triggers.settleAnimationStarts(p.worldX, p.worldY, p.reversed, true);
    this.triggers.checkPassedAtReset(p.x, p.y, p.rotated);
    this.takeCameraMode();
    this.takeRotations();
    this.takeTeleports();
    if (this.takeEnd()) return;
    this.syncGeometry(false);
  }

  /**
   * GJBaseGameLayer::loadStartPosObject: the level runs up to the start
   * position before the player does anything. Player 1 goes along the time
   * table's path, unreversed and unturned, a sixtieth of a second at a time
   * until the table's time to the start position (at most an hour): the music
   * clock (+800), the spawn queue, the moves and the pass-by check all run as
   * in a step, on the table's channel after the first check, and colours fade
   * as in a frame. The level time stays at 0. Then the player is put back at
   * the start position with no y velocity, the start state is applied again,
   * and the music starts from the time the warm-up reached.
   *
   * A Teleport trigger on the way moves player 1, and the next step's move is
   * measured from where it put it. An End trigger on the way ends the run as
   * it would anywhere: it locks the players and stops the level time, and
   * the run is finished once the warm-up is over. Nothing is heard while the
   * level loads: the game notes each Song and SFX trigger with its time and
   * replays them when the music starts, so the audio events stay, in order
   * and with their times, and the particles go. A turn still turns player 1,
   * and the start state takes that back. With kA35 the camera's turn and
   * static camera go too. Last, the pass-by check runs once more with player
   * 1 on the start position, which the walk's last point can stop a float
   * short of, and what that fires is kept.
   * [gdp GJBaseGameLayer::loadStartPosObject :469534-469590 → loadUpToPosition
   *  :469428-469517; the loop :469465-469503 (the step 1/60, GeometryDash.exe
   *  0x620fb8; the cap 3600 :469459-469460; the clocks +800 and +792 alone
   *  :469472-469474, the level time zeroed by resetLevel :105896; the move
   *  from player 1's position :469476-469480; the end :469504-469510);
   *  teleportPlayer :462274-462314 and activatePlatformerEndTrigger
   *  :93034-93065, with no loading check; the sounds while +11600 is set
   *  :446516-446521, :447116, :447171, :447268, noted by activatedAudioTrigger
   *  :447750-448043 and replayed by PlayLayer::startMusic :105410-105415 →
   *  processActivatedAudioTriggers :454746-455240 (songs :454746-454962, SFX
   *  :455150-455240); the last check PlayLayer::init :106486, after
   *  resetLevel :106465]
   */
  private warmUp(sp: StartPosition, s: StartState): void {
    const p = this.p1;
    const trig = this.triggers;
    const table = new TimeTable(this.level, this.baseObjs, this.platformer, (g) => trig.portalTarget(g));
    const startX = p.worldX;
    const startY = p.worldY;
    p.doReversePlayer(false);
    p.rotated = false;
    let total = table.timeForPos(Math.fround(startX), 0, sp.targetOrder, sp.targetChannel);
    if (total > WARM_UP_CAP) total = WARM_UP_CAP;
    const steps = Math.trunc(Math.fround(Math.ceil(Math.fround(total / WARM_UP_STEP)) + 1));
    const eventsBefore = trig.events.length;
    const simEventsBefore = this.events.length;
    // The walk starts at the game's origin, where the game puts player 1
    // first, and each step's move is measured from where player 1 is.
    p.setWorldPosition(0, -GAME_GROUND_Y);
    let t = 0;
    for (let k = 0; k < steps; k++) {
      const dt = Math.fround(t + WARM_UP_STEP) <= total ? WARM_UP_STEP : Math.fround(total - t);
      t = Math.fround(t + dt);
      const at = table.posForTime(t);
      const dx = Math.fround(at.x - p.worldX);
      const dy = Math.fround(at.y - (p.worldY + GAME_GROUND_Y));
      p.setWorldPosition(at.x, at.y - GAME_GROUND_Y);
      trig.updateVisuals(dt);
      trig.beginStep(dt, true);
      this.takeWarmUpEffects();
      trig.setAreaPlayers(p.worldX, p.worldY, null);
      trig.stepMoves(dt, dx, dy, dx, dy, p.worldY);
      this.syncGeometry();
      trig.checkPassed(p.x, p.y, p.rotated);
      this.takeWarmUpEffects();
      trig.setActiveChannel(at.channel);
      trig.checkPassed(p.x, p.y, p.rotated);
      this.takeWarmUpEffects();
      trig.endStep();
      trig.settleAnimationStarts(p.worldX, p.worldY, p.reversed, true);
      this.syncGeometry();
    }
    // The walk's Song and SFX triggers are only noted; the music's start
    // plays whatever they left running (LevelAudio.startAttempt). Nothing
    // else the walk raised is an event of the run.
    // [gdp activateSongTrigger :446517, activateSongEditTrigger :447116,
    //  activateSFXTrigger :447171-447174, activateSFXEditTrigger :447268;
    //  PlayLayer::startMusic :105411-105415]
    const noted = trig.events.slice(eventsBefore).filter((e) => AUDIO_EVENT_KINDS.has(e.kind));
    if (trig.events.length > eventsBefore) trig.events.length = eventsBefore;
    trig.events.push(...noted);
    p.setWorldPosition(startX, startY);
    p.reverseOffset = 0;
    p.reverseSlice = 0;
    p.setYVelocity(0);
    p.lastX = p.x;
    p.lastY = p.y;
    if (sp.resetCamera) trig.resetCamera();
    // setupLevelStart again, for what the warm-up can have changed: the turn,
    // gravity and direction, player 2's gravity and direction, and the band.
    // [gdp loadStartPosObject :469588 → setupLevelStart :462736-462750, 462798]
    p.flipGravity(s.flipped);
    p.doReversePlayer(s.reversed);
    p.rotated = s.rotated;
    const p2 = this.p2;
    if (p2) {
      p2.flipGravity(!p.flipped);
      p2.doReversePlayer(p.reversed);
    }
    this.updateCorridor(p, p.mode, true);
    // What the turns flipped on the way is no event of the run.
    if (this.events.length > simEventsBefore) this.events.length = simEventsBefore;
    this.checkPassedAtReset();
  }

  /**
   * What the warm-up's triggers did that the sim takes over: turns, camera
   * modes and teleports act at once; an End trigger waits for the pass-by
   * check after the warm-up, which ends the run with it.
   */
  private takeWarmUpEffects(): void {
    this.takeRotations();
    this.takeCameraMode();
    this.takeTeleports();
  }

  /**
   * animateInDualGroundNew: the corridor's ground layers come in.
   *
   * The band hangs from an **object**, never from the player: its middle is
   * that object's y, less half the corridor, snapped down to the block grid
   * and clamped to the ground, plus half the corridor again. Which object is
   * the whole subtlety, and it is what this port used to get wrong — it
   * anchored to the player, so crossing a portal high inside its own box
   * lifted the band by a block and the section played differently depending
   * on the approach.
   *
   * The anchor is the dual portal while a dual is running and the mode portal
   * otherwise, with the start position the run began from between them.
   * *Keeping the dual portal for the whole dual section* is the part that
   * matters: Hexagon Force's two stacked ship portals at x 12825 sit inside a
   * dual that began at y 419, so the band is 240..540 and not the 180..480 the
   * portals themselves give. The level's blocks there run to y 533, which is
   * why anchoring to the mode portal made it unfinishable for the autoplayer
   * at 47.8 %.
   *
   * Two things this port already had right, and the comment here used to doubt:
   * the 30-unit snap **is** in the binary, and the clamp at the ground is the
   * game's own clamp. The game's world is level y + 90 and 90 is a multiple of
   * 30, so both survive the shift unchanged.
   *
   * The layers themselves slide in from the edges of the screen, over half a
   * second the first time and 0.4 s when a new height or a dual moves them
   * (none when only the anchor changed), or at once (`instant`) as a run
   * starts. A height change rescales how far they had come so their edges
   * do not jump. And the corridor takes the camera: the middle becomes the
   * static y, eased in over the same time, unless a Static Camera trigger
   * holds the y already (refreshBand then reads the band off the layers).
   * [gdp GJBaseGameLayer::animateInDualGroundNew :451047-451152 (the floor
   *  :451064-451076; the times :451077-451105; the rescale :451106-451118;
   *  the camera :451129-451137); getTargetFlyCameraY :420349-420385 (the
   *  anchor and its fallbacks); updateDualGround :451158-451172 (which object
   *  is passed in)]
   */
  private animateInGround(anchorY: number | null, height: number, instant: boolean): void {
    const g = this.ground;
    let floor = (anchorY ?? FLOOR_Y) - height / 2;
    if (!this.corridorNoSnap) floor = Math.floor(floor / CORRIDOR_GRID) * CORRIDOR_GRID;
    if (floor <= FLOOR_Y) floor = FLOOR_Y;
    let duration = 0;
    let slide = false;
    if (instant) {
      g.tween = null;
      g.slide = 1;
    } else if (g.in || this.dual) {
      duration = GROUND_IN_AGAIN;
      slide = !g.in || height !== g.height;
    } else {
      duration = GROUND_IN_FIRST;
      slide = true;
    }
    if (slide) {
      const half = BAND_VIEW.height / 2;
      if (g.slide < 0) g.slide = 0;
      else if (g.slide > 0) {
        g.slide = Math.fround(
          Math.fround(Math.fround(half + Math.fround(1 - g.height / 2)) * g.slide) / Math.fround(half + Math.fround(1 - height / 2)),
        );
      }
      g.tween = { from: g.slide, to: 1, duration, elapsed: 0, easing: 1, rate: 2, uid: -1, controlId: -1, paused: false };
    }
    g.mid = floor + height / 2;
    if (!this.triggers.camera.staticY.on || this.groundHasCamera()) g.cameraSeq = this.triggers.corridorStaticY(g.mid, duration);
    g.in = true;
    g.height = height;
    this.refreshBand();
  }

  /**
   * animateOutGroundNew: the layers slide back out to the screen's edges,
   * over 0.4 s (0.3 in a dual), and a corridor that held the camera lets go
   * of the static y.
   * [gdp GJBaseGameLayer::animateOutGroundNew :448965-448985]
   */
  private animateOutGround(): void {
    const g = this.ground;
    g.in = false;
    if (this.groundHasCamera()) this.triggers.releaseStaticY();
    g.tween = {
      from: g.slide,
      to: 0,
      duration: this.dual ? GROUND_OUT_DUAL : GROUND_OUT,
      elapsed: 0,
      easing: 1,
      rate: 1.5,
      uid: -1,
      controlId: -1,
      paused: false,
    };
    this.refreshBand();
  }

  /** Whether the corridor still holds the static y it took (+576): no Static Camera trigger has fired since. */
  private groundHasCamera(): boolean {
    return this.ground.cameraSeq >= 0 && this.ground.cameraSeq === this.triggers.camera.staticY.seq;
  }

  /**
   * The band the collision pass holds the player in, from the ground layers.
   *
   * While the corridor holds the camera, or nothing holds its y, the band is
   * the corridor's own middle plus the camera offset, height / zoom tall: the
   * layers are centred on the screen and the camera is on its way to that
   * middle. While a Static Camera trigger holds the y the band is read off
   * the layers where they are on the screen, about the camera's centre, so
   * it moves with the camera, follows the layers as they slide, and is the
   * height over the zoom: Dash's spider corridor under its 0.909 zoom is 297
   * tall around the camera's 165. The floor never goes under the ground.
   * Floats, as the game works them.
   * [gdp GJBaseGameLayer::getMinPortalY :420443-420489, getMaxPortalY
   *  :420494-420510; the layers' places, updateCameraBGArt :431194-431213
   *  (+10960 :452595-452625, what a turned view adds to the screen's height)]
   */
  private refreshBand(): void {
    const g = this.ground;
    if (!g.in) {
      this.setBand(FLOOR_Y, OPEN_CEILING);
      return;
    }
    const ground = GAME_GROUND_Y;
    const cam = this.triggers.camera;
    const zoom = Math.fround(cam.zoom);
    let floor: number;
    let ceiling: number;
    if (!cam.staticY.on || this.groundHasCamera()) {
      floor = Math.fround(Math.fround(Math.fround(-Math.fround(0.5 * g.height) / zoom) + (g.mid + ground)) + cam.offsetY);
      if (!(floor > ground)) floor = ground;
      ceiling = Math.fround(floor + Math.fround(g.height / zoom));
    } else {
      const layers = groundLayers(g.height, g.slide, this.camera.rotation, BAND_VIEW.width, BAND_VIEW.height);
      const bottom = Math.fround(this.camera.centre().y + ground - BAND_VIEW.height / 2 / zoom);
      // The ground layer never goes under the level's ground (y 91 on the screen).
      const lowest = Math.fround(-bottom * zoom + zoom * (ground + 1));
      const low = layers.floor <= lowest ? lowest : layers.floor;
      floor = Math.fround(bottom + Math.fround(low - 1) / zoom);
      if (!(floor > ground)) floor = ground;
      ceiling = Math.fround(bottom + Math.fround(layers.ceiling + 1) / zoom);
    }
    this.setBand(floor - ground, ceiling - ground);
  }

  private setBand(floor: number, ceiling: number): void {
    if (floor === this.floorY && ceiling === this.ceilingY) return;
    this.floorY = floor;
    this.ceilingY = ceiling;
    this.hashDirty = true;
  }

  /**
   * The ground layers' slide and the camera, once a step where the game
   * steps its tweens and then updates its camera, and the band they give,
   * which the next step's collision pass reads. [gdp GJBaseGameLayer::update
   *  :469984-469990 (the tweens, then updateCamera → updateCameraBGArt)]
   */
  private stepGround(dt: number): void {
    const g = this.ground;
    if (g.tween) {
      g.slide = stepCameraTween(g.tween, dt);
      if (cameraTweenDone(g.tween)) g.tween = null;
    }
    this.camera.applyTriggers(this.triggers.camera);
    this.camera.follow(this.p1);
    this.refreshBand();
  }

  /** The camera starts over where the run or the respawn puts the player, as the scene's does. */
  private resetCamera(): void {
    this.camera.reset(this.p1, this.triggers.camera);
    this.refreshBand();
  }

  /**
   * A Zoom trigger or a Static Camera exit that asked for the corridor again:
   * a zoom lays it again while it is in, an exit when it is in and nothing
   * holds the y now, so the corridor takes the camera back.
   * [gdp GJBaseGameLayer::updateZoom :451293-451301; exitStaticCamera
   *  :451451-451455]
   */
  private takeGroundRefresh(): void {
    const r = this.triggers.pendingGround;
    if (!r) return;
    this.triggers.pendingGround = null;
    if (!this.ground.in) return;
    if (!r.zoom && this.triggers.camera.staticY.on) return;
    this.updateCorridor(this.p1, this.p1.mode, r.zoom && r.instant);
  }

  /**
   * Recomputes the band for a mode change, entering a dual or leaving one.
   *
   * A 270-unit corridor means "no corridor" — except for the spider, which
   * really does get one that size, and except in a dual, where every mode gets
   * a band whatever its own height says.
   * [gdp GJBaseGameLayer::updateDualGround :451167-451171]
   */
  private updateCorridor(p: Player, mode: GameMode, instant = false): void {
    const height = this.groundHeight(p, mode);
    if (this.corridorFree || (height === SPIDER_CORRIDOR_HEIGHT && mode !== "spider" && !this.dual)) {
      this.animateOutGround();
      return;
    }
    // The dual portal in a dual, the mode portal otherwise; the start position
    // when that is not set, and in a dual the mode portal after it.
    const portal = this.dual ? this.dualPortal : this.modePortal;
    let anchorY: number | null = null;
    if (portal !== null) anchorY = this.objs.cy[portal];
    else if (this.startPos) anchorY = this.triggers.objectPosition(this.startPos.index)[1];
    else if (this.dual && this.modePortal !== null) anchorY = this.objs.cy[this.modePortal];
    this.animateInGround(anchorY, height, instant);
  }

  /**
   * How tall the band is. In a dual the ball's 240 is promoted to 270 first and
   * the taller of the two players' modes wins — which, since every promoted
   * height is already at least 270 and only the flying modes ask for 300,
   * reduces to "300 if either player is flying, 270 otherwise".
   * [gdp GJBaseGameLayer::getGroundHeight :420554-420580,
   *  getGroundHeightForMode :419619-419650]
   */
  private groundHeight(p: Player, mode: GameMode): number {
    const own = groundHeightForMode(mode);
    if (!this.dual) return own;
    const other = p.playerNo === 1 ? this.p2 : this.p1;
    const flying = own === FLY_CORRIDOR_HEIGHT || (other?.isFlying ?? false);
    return flying ? FLY_CORRIDOR_HEIGHT : SPIDER_CORRIDOR_HEIGHT;
  }

  // ---------------------------------------------------------------------------
  // PlayerWorld
  // ---------------------------------------------------------------------------

  emit(type: SimEvent["type"], player: 1 | 2, object?: number, detail?: string): void {
    const e: SimEvent = { tick: this.tick, type, player };
    if (object !== undefined) e.object = object;
    if (detail !== undefined) e.detail = detail;
    this.events.push(e);
    if (this.onEvent) this.onEvent(e);
  }

  spiderJump(p: Player): void {
    this.spiderTeleport(p);
  }

  /**
   * Notes a circle the game makes now (SimWave), at object `object`'s place,
   * or at (x, y) when given.
   */
  private wave(cause: WaveCause, p: Player, object: number, variant: string, x?: number, y?: number, x2?: number, y2?: number, exit = false): void {
    let wx = x;
    let wy = y;
    if (wx === undefined || wy === undefined) {
      if (object >= 0) [wx, wy] = this.triggers.objectPosition(object);
      else {
        wx = p.worldX;
        wy = p.worldY;
      }
    }
    this.waves.push({ cause, player: p.playerNo, object, exit, variant, x: wx, y: wy, x2: x2 ?? wx, y2: y2 ?? wy, size: p.vehicleSize() });
  }

  /** Player `p` meets object `i`, or with `exit` the linked exit beside it (lastMet). */
  private meet(p: Player, i: number, exit = false): void {
    this.lastMet[p.playerNo - 1] = i;
    this.lastMetExit[p.playerNo - 1] = exit ? 1 : 0;
  }

  /** Every reset forgets what both players last met (lastMet). */
  private forgetMet(): void {
    this.lastMet.fill(-1);
    this.lastMetExit.fill(0);
  }

  /**
   * spawnPortalCircle: a portal circle on the object player `p` last met
   * (lastMet), followed from there, and none for a player that has met
   * nothing since the reset — the game's test that +2032 is not (0, 0).
   * [gdp PlayerObject::spawnPortalCircle :143150-143190 (the gate :143163,
   *  setPosition(+2032) then followObject(+2116) :143171-143175)]
   */
  private portalWave(p: Player, variant: string): void {
    const k = p.playerNo - 1;
    const i = this.lastMet[k];
    if (i < 0) return;
    this.wave("portal", p, i, variant, undefined, undefined, undefined, undefined, this.lastMetExit[k] === 1);
  }

  /** Object `i`'s EFFECT_* bits. */
  private effectBits(i: number): number {
    let cache = this.effectBitsOf;
    if (!cache) {
      cache = new Int8Array(this.level.objects.length).fill(-1);
      this.effectBitsOf = cache;
    }
    const known = cache[i];
    if (known >= 0) return known;
    const props = this.level.objects[i].props;
    const num = (key: number): number => parseInt(props[key] ?? "0", 10) || 0;
    const bits = (num(116) !== 0 ? EFFECT_NONE : 0) | (num(135) !== 0 ? EFFECT_HIDDEN : 0) | (num(440) > 0 ? EFFECT_OWN_PARTICLE : 0);
    cache[i] = bits;
    return bits;
  }

  /** +2072, kept with the Options trigger's other switches (see PlayerWorld). */
  get boostSlide(): boolean {
    return this.triggers.visual.options.boostSlide;
  }

  // ---------------------------------------------------------------------------
  // step
  // ---------------------------------------------------------------------------

  step(in1: PlayerInput, in2?: PlayerInput): void {
    const p1 = this.p1;
    this.waves.length = 0;
    if (p1.dead || p1.finished) return;
    this.tick++;
    const trig = this.triggers;
    trig.tick = this.tick;
    // A time warp below 1 keeps the steps coming 240 to the real second but
    // shrinks the game time each one covers to the warp's share of a 240th,
    // so everything that moves slows by the warp while the music and the
    // level time keep real time. Read at the top of the step, as the game
    // works out the frame's steps before any trigger in them runs. A warp
    // above 1 would add steps instead, which a tick of this sim cannot hold.
    // [gdp GJBaseGameLayer::getModifiedDelta :430237-430243 (the 240th times
    //  the warp, 0.0041667 a double); update :469746-469774 (v15, v16 = its
    //  sixtieths as a float, v18 as a double), :469807 (the warp, read once)]
    const warp = trig.timeWarp;
    const gameDt = warp < 1 ? Math.fround(warp * 0.0041667) : TICK_DT;
    const frameDt = warp < 1 ? Math.fround(gameDt * 60) : FRAME_DT;
    const rotateDt = warp < 1 ? gameDt * 60 : FRAME_DT;
    this.frameDt = frameDt;
    // The spawn queue runs first: an Options trigger it fires already counts
    // for this step's buttons, and a group it moves on the spot (a silent move)
    // is already there for the press. [gdp GJBaseGameLayer::update,
    // gd-ida-decomp.cpp:469846]
    trig.beginStep(TICK_DT, false, gameDt);
    // Whatever the spawn queue fired acts before the buttons, as it does
    // inside the game's trigger: an End trigger locks the players where they
    // are, a turn and a Teleport trigger land before this step's move.
    if (this.takeEnd()) return;
    this.takeRotations();
    this.takeTeleports();
    this.takeCameraMode();
    this.takeGroundRefresh();
    this.syncGeometry();
    // processCommands: both players' buttons, before either of them moves and
    // before the move commands do, so a press sees the level where the last
    // step left it. A dual's player 2 answers to player 1's button unless the
    // level is two-player. An Options trigger can take the controls away from
    // either player, which the simulation honours by feeding them nothing
    // rather than by ignoring their state — a held button must not still be
    // held when control returns. [gdp GJBaseGameLayer::update,
    // gd-ida-decomp.cpp:469850; handleButton :463885-464010]
    const options = trig.visual.options;
    const p2 = this.p2;
    // Both players' clocks move before either button is handled: the ball's
    // immediate jump stamps its flip with this step, a ring taken at the press
    // emits events, and player 1's press can flip player 2 through a linked
    // orb. [gdp GJBaseGameLayer::update :469834-469835, before processCommands
    // :469850]
    p1.tick = this.tick;
    p1.clock += warp < 1 ? gameDt / TICK_DT : 1;
    if (p2) {
      p2.tick = this.tick;
      p2.clock = p1.clock;
    }
    this.processButtons(p1, options.disableControlsPlayer1 ? NO_INPUT : in1, true);
    const raw2 = this.level.header.twoPlayer ? (in2 ?? NO_INPUT) : in1;
    const input2 = options.disableControlsPlayer2 ? NO_INPUT : raw2;
    this.rawJump2 = input2.jump;
    if (p2) this.processButtons(p2, input2, this.level.header.twoPlayer);
    // resetTouchedRings: the press has had its look at the last two passes;
    // only what the last one touched stays on for the next. [:469851-469853]
    p1.resetTouchedRings();
    if (p2) p2.resetTouchedRings();
    // resetCollisionLog: the objects met this step start over. [:469854-469856]
    p1.resetCollisionLog();
    if (p2) p2.resetCollisionLog();
    // Player-locked moves take player 1's delta from where its last update
    // began, measured now, after the buttons: the whole of the last step, a
    // teleport included, plus whatever the press moved. A y delta more than 4
    // units off that update's own y step, as a spider's jump makes, counts as
    // none. Camera-locked moves take the same x delta: camera x follows the
    // player exactly, and the camera is not simulated here.
    // [gdp GJBaseGameLayer::update :469859-469877; the camera X rule
    //  :450110-450140]
    // Float differences of float positions. [:469862-469875]
    const dx = Math.fround(p1.x - this.lastPlayerX);
    let dy = Math.fround(p1.y - this.lastPlayerY);
    if (Math.abs(Math.fround(dy - p1.stepY)) > MOVE_DY_SLACK_PER_FRAME * frameDt) dy = 0;
    // Then the move commands, so a moving block is where it will be when the
    // collision pass looks at it. [:469890-469893]
    trig.setAreaPlayers(p1.worldX, p1.worldY, p2 ? [p2.worldX, p2.worldY] : null);
    trig.stepMoves(gameDt, dx, dy, dx, 0, p1.worldY);
    this.syncGeometry();
    this.lastPlayerX = p1.x;
    this.lastPlayerY = p1.y;
    this.stepPlayer(p1);
    // Player 1's y for a Follow Player Y trigger's delay, after its collisions.
    // [gdp GJBaseGameLayer::update :469925 → PlayerObject::updateSpecial]
    trig.recordPlayerY(p1.worldY, gameDt);
    // Player 2 moves only in a step that began in a dual and is still in one
    // (v106). One that player 1's pass has just spawned waits for the next
    // step, level with player 1, rather than a step ahead of it for the whole
    // section. [gdp GJBaseGameLayer::update, gd-ida-decomp.cpp:469860,
    // 469926-469933]
    const p2moves = p2 !== null && this.dual ? this.p2 : null;
    if (p2moves && !p1.dead) this.stepPlayer(p2moves);
    // processStateObjects: a ring no pass touched this step powers off.
    // [gdp GJBaseGameLayer::update :469986 → :421383-421410]
    if (this.ringPower.size !== 0) this.ringPower.forEach(this.powerOffUntouched);
    if (p1.dead) {
      this.pendingSpeed = -1;
      trig.playerDied();
      return;
    }
    p1.updateRotation(rotateDt);
    if (this.p2) this.p2.updateRotation(rotateDt);
    // Touch triggers fire from the collision pass, pass-by triggers after it.
    trig.checkTouch(p1.x, p1.y, p1.hitboxSize() * 0.5, 1);
    if (p2moves && this.p2 === p2moves) trig.checkTouch(p2moves.x, p2moves.y, p2moves.hitboxSize() * 0.5, 2);
    // A touched turn or Teleport trigger has acted inside the game's collision
    // pass, so the pass-by check below already sees it.
    // [gdp GJBaseGameLayer::update :469925-469942: checkCollisions, then
    //  checkSpawnObjects]
    this.takeRotations();
    this.takeTeleports();
    trig.checkPassed(p1.x, p1.y, p1.rotated);
    trig.endStep();
    // The camera's tweens, where the game steps them: after the pass-by
    // check, just before the camera moves, and before the visibility pass
    // that settles the animations. [gdp GJBaseGameLayer::update :469988]
    trig.stepCamera(gameDt);
    this.stepGround(gameDt);
    trig.settleAnimationStarts(p1.worldX, p1.worldY, p1.reversed);
    this.takeCameraMode();
    this.takeGroundRefresh();
    this.takeRotations();
    this.takeTeleports();
    if (this.takeEnd()) return;
    // A speed portal's speed, queued in the collision pass, reaches player 1
    // and, in a dual, player 2 at the top of the next sub-step, whichever of
    // them touched it; when two are queued in one step the last one wins.
    // Nothing between here and the next player update reads it, so it is
    // applied now rather than carried across the step.
    // [gdp GJBaseGameLayer::update :469847-469848 → updateTimeMod(…, 1, …)
    //  :421473-421477]
    const speed = this.pendingSpeed;
    if (speed >= 0) {
      this.pendingSpeed = -1;
      p1.setSpeed(speed as Speed);
      if (this.dual && this.p2) this.p2.setSpeed(speed as Speed);
    }
    this.syncGeometry();
    this.markPlatformerCheckpoint();
    if (!this.platformer && !p1.finished && p1.x >= this.level.lengthUnits) this.finish(p1);
  }

  /**
   * PlayLayer::postUpdate's half of a platformer checkpoint object: the
   * checkpoint is laid down now, from the whole step, with player 1 put at
   * the respawn point — the object itself, player 1 where it stands with key
   * 138, or key 71's main object — and marked as placed there (see
   * SnapData.placed), and only then is the object's key 51 spawned, so a
   * respawn does not see that spawn. What the spawn fires acts at once, as
   * it does inside the game's spawn (see takeSpawned), except a checkpoint
   * object: the game forgets the one it noted once the spawn is over, so a
   * 2063 that key 51 fires lays nothing. Key 448 rides along to be spawned
   * on every respawn from it. This is the normal game as well as practice: a
   * normal run that dies goes back to the last one. The game does this once
   * a frame, after the frame's last step; the sim, which has no frames, does
   * it after the step the object was touched in.
   * [gdp PlayLayer::postUpdate :105311-105362 (markCheckpoint :105316, which
   *  refuses only a dead player 1, :105241-105269; the position :105319-105337
   *  into the checkpoint's player state :105338-105345; key 448 into +2600
   *  :105348-105350; key 51 :105352-105359; +12104 cleared after it,
   *  :105361); CheckpointGameObject::customObjectSetup :309813-309844 (51,
   *  71, 448 → +1636, 138 → +1496); PlayLayer::resetLevel :105893-105903
   *  loads the last checkpoint whether practising or not, and spawns +2600
   *  :105965-105973]
   */
  private markPlatformerCheckpoint(): void {
    const i = this.triggers.pendingCheckpoint;
    if (i < 0) return;
    this.triggers.pendingCheckpoint = -1;
    const props = this.level.objects[i].props;
    const key = (k: number): number => parseInt(props[k] ?? "0", 10) || 0;
    if (!this.p1.dead) {
      let at: [number, number];
      const main = key(71) > 0 ? this.triggers.mainObjectOf(key(71)) : -1;
      if (key(138) !== 0) at = [this.p1.worldX, this.p1.worldY];
      else at = this.triggers.objectPosition(main >= 0 ? main : i);
      const snap = this.snapshot();
      const d = snap.opaque as SnapData;
      d.p1.setWorldPosition(at[0], at[1]);
      d.p1.lastX = d.p1.x;
      d.p1.lastY = d.p1.y;
      d.placed = true;
      d.respawnGroup = key(448);
      this.checkpointMarked = snap;
    }
    const spawn = key(51);
    if (spawn > 0) {
      this.triggers.spawnFromLevel(spawn, i);
      this.takeSpawned();
      this.triggers.pendingCheckpoint = -1;
    }
  }

  /**
   * What a level spawn — a platformer checkpoint's key 51 or 448 — fired, acted
   * on at once rather than at the next step: the game runs each of these
   * inside its trigger, within postUpdate or resetLevel, and a snapshot taken
   * before the next step must not lose them. In the order the step's end takes
   * them. [gdp PlayLayer::postUpdate :105352-105359 and resetLevel
   *  :105965-105973 → spawnGroup → triggerObject]
   */
  private takeSpawned(): void {
    this.takeCameraMode();
    this.takeGroundRefresh();
    this.takeRotations();
    this.takeTeleports();
    this.takeEnd();
  }

  takePlatformerCheckpoint(): SimSnapshot | null {
    const snap = this.checkpointMarked;
    this.checkpointMarked = null;
    return snap;
  }

  /** Rotate Gameplay triggers that fired since the last look, oldest first. */
  private takeRotations(): void {
    const pending = this.triggers.pendingRotations;
    if (pending.length === 0) return;
    for (const r of pending) this.rotateGameplay(r);
    pending.length = 0;
  }

  /**
   * An End trigger that fired since the last look ends the level here: the
   * game locks both players at once and completes the level at the end of
   * their flight, or at once with key 487, and nothing the players do after
   * the lock can change the outcome, so the sim stops with them.
   * [gdp PlayLayer::activatePlatformerEndTrigger :93034-93065 →
   *  playPlatformerEndAnimationToPos :92922-93030 (lockPlayer :92973)]
   */
  private takeEnd(): boolean {
    const end = this.triggers.pendingEnd;
    if (!end) return false;
    this.triggers.pendingEnd = null;
    this.end = end;
    this.finish(this.p1);
    return true;
  }

  /**
   * Teleport triggers (3022) that fired since the last look, oldest first,
   * each through the same teleportPlayer as a portal, for player 1. The game
   * runs each inside its own trigger; the sim takes them at the next point it
   * owns the player: after the spawn queue at the top of the step, after the
   * trigger checks, and after a level spawn.
   * [gdp EffectGameObject::triggerObject :314981 → teleportPlayer(layer,
   *  trigger, 0) :462312-462314, player 1 for a null player]
   */
  private takeTeleports(): void {
    const pending = this.triggers.pendingTeleports;
    if (pending.length === 0) return;
    for (const tp of pending) this.teleportPlayer(this.p1, tp.object, tp.target);
    pending.length = 0;
  }

  /**
   * A Camera Mode trigger's switches, applied as a portal's are, except that
   * a change of free mode redraws the corridor at once: a portal leaves that
   * to its own mode change. [gdp GJBaseGameLayer::updateCameraMode
   *  :451188-451232 (with a3 = true from the trigger, :315616), then
   *  updateDualGround(player 1, …) :451229-451231, :451158-451172]
   */
  private takeCameraMode(): void {
    const m = this.triggers.pendingCameraMode;
    if (!m) return;
    this.triggers.pendingCameraMode = null;
    const was = this.corridorFree;
    this.corridorFree = m.free;
    this.corridorNoSnap = m.noSnap;
    if (was !== m.free) this.updateCorridor(this.p1, this.p1.mode);
    this.hashDirty = true;
  }

  /**
   * The camera switches a mode or dual portal carries: free mode (key 111),
   * no grid snap (key 370) and, with key 112, the camera's easing and padding
   * (keys 113, 114). [gdp playerWillSwitchMode :462525 and toggleDualMode
   *  :462694 → updateCameraMode(portal, false) :451188-451232]
   */
  private portalCameraMode(i: number): void {
    const flags = this.objs.flags[i];
    this.corridorFree = (flags & F_FREE_MODE) !== 0;
    this.corridorNoSnap = (flags & F_NO_SNAP) !== 0;
    this.hashDirty = true;
    const props = this.level.objects[i].props;
    if (props[112] === "1") this.triggers.setCameraEase(Number(props[113] ?? 0) || 0, Number(props[114] ?? 0) || 0);
  }

  /**
   * Puts the moved groups' objects where their transform now says they are.
   *
   * Only the groups a trigger has actually touched are rebuilt, so a level
   * sitting still costs one set lookup a tick. An object in more than one moving
   * group takes them composed, in the order the level lists them.
   */
  private syncGeometry(moves = true): void {
    if (this.objs === this.baseObjs) return;
    const { all, groups, silent } = this.triggers.takeDirty();
    if (all) {
      for (const i of this.triggers.movedObjects) this.rebuildObject(i);
      return;
    }
    for (const g of groups) {
      const quiet = silent.has(g);
      for (const i of this.triggers.index.groups.get(g) ?? []) this.rebuildObject(i, moves, quiet);
    }
  }

  /**
   * GameObject's lastPosition: where an object was before the first move of
   * this step. Only the moves a trigger makes count; a reset or restore is not
   * a move, and a silent move puts lastPosition where the object lands, so it
   * cancels whatever this step had moved it by.
   * [the guard on the step counter +816, gd-ida-decomp.cpp:427729-427740;
   *  moveObjectsSilent :427890-427893; the counter, processCommands :464109]
   *
   * The game never refreshes lastPosition while an object stands still, which
   * read literally leaves every object carrying its last move for good. That
   * reading cannot be right: Yatagarasu (verified) moves a whole section 750
   * down in one step at x 2775, and with the move kept its slopes catch the
   * UFO onto the spikes lying on them at x 3700, which nothing gets past; and
   * a platform moving at a steady speed would hand its speed on for ever after
   * it stops, so it would never launch. A move counts in the step it happens.
   */
  private recordMotion(i: number, ox: number, oy: number, silent: boolean): void {
    const nx = this.objs.cx[i];
    const ny = this.objs.cy[i];
    if (nx === ox && ny === oy && !silent) return;
    const prev = this.motion.get(i);
    const sameStep = prev !== undefined && prev.tick === this.tick;
    const dx = silent ? 0 : Math.fround(nx) - Math.fround(sameStep ? ox - prev.dx : ox);
    const dy = silent ? 0 : Math.fround(ny) - Math.fround(sameStep ? oy - prev.dy : oy);
    if (this.motionShared) {
      this.motion = new Map(this.motion);
      this.motionShared = false;
    }
    this.motion.set(i, { dx, dy, tick: this.tick });
  }

  objectRise(i: number, swapped: boolean): number {
    const m = this.motion.get(i);
    if (!m || m.tick !== this.tick) return 0;
    return swapped ? m.dx : m.dy;
  }

  private rebuildObject(i: number, moved = false, silent = false): void {
    if (this.objs.kind[i] === K_NONE) return;
    const m = this.m6;
    this.triggers.objectTransform(i, m);
    const ox = this.objs.cx[i];
    const oy = this.objs.cy[i];
    applyGroupTransform(this.baseObjs, this.objs, i, m, m[6], m[7], m[8]);
    if (moved) this.recordMotion(i, ox, oy, silent);
    // The mirror follows the world, once it exists.
    if (this.reflected) reflectObject(this.objs, this.reflected, i);
  }

  private stepPlayer(p: Player): void {
    p.tick = this.tick;
    p.update(this.frameDt);
    this.collide(p);
  }

  /**
   * One player's share of processCommands: the presses and releases since
   * the last step, in the order they happened. `jump` is where the button
   * ended up; `tap` adds a round trip before that (a click shorter than a
   * step, or a release and re-press inside one), which the game runs as two
   * commands in the same step.
   *
   * Each press and release that reaches a player raises its game event, for
   * the Event trigger: Jump Push and Release (69, 70) and, in a platformer,
   * Left and Right Push and Release (71-74), with the player it came from.
   * `raise` is false for a dual's player 2 answering player 1's button in a
   * level that is not two-player: handleButton raises one event for both, as
   * player 1's. The events are handleButton's table unk_982ED8, which the
   * decompile does not show; the event names give its order.
   * [gdp GJBaseGameLayer::processQueuedButtons, gd-ida-decomp.cpp:464029-464045;
   *  handleButton :463975-463995 (the player is cleared without kA10
   *  :463973-463974); gameEventToString :428760-428777]
   */
  private processButtons(p: Player, input: PlayerInput, raise: boolean): void {
    const player = p === this.p1 ? 1 : 2;
    if (raise && this.platformer) {
      if (input.left !== p.leftHeld) {
        this.triggers.gameEvent(input.left ? EVENT_LEFT_PUSH : EVENT_LEFT_RELEASE, 0, player);
        this.touchButton(input.left, player);
      }
      if (input.right !== p.rightHeld) {
        this.triggers.gameEvent(input.right ? EVENT_RIGHT_PUSH : EVENT_RIGHT_RELEASE, 0, player);
        this.touchButton(input.right, player);
      }
    }
    // A direction pressed since the last step is the one pressed last; both at
    // once, and right counts as the later. [gdp PlayerObject::switchedDirTo,
    // gd-ida-decomp.cpp:159446-159466, from pushButton :160534-160536]
    if (input.left && !p.leftHeld) p.leftPressedLast = true;
    if (input.right && !p.rightHeld) p.leftPressedLast = false;
    p.leftHeld = input.left;
    p.rightHeld = input.right;
    const held = input.jump;
    const tap = input.tap === true;
    p.holdTicks = held ? (p.holdTicks < 0 || tap ? 0 : p.holdTicks + 1) : -1;
    let down = p.rawHeld;
    for (let edges = (tap ? 2 : 0) + (held !== down ? 1 : 0); edges > 0; edges--) {
      down = !down;
      if (down) this.pushButton(p);
      else p.releaseButton();
      if (raise) {
        this.triggers.gameEvent(down ? EVENT_JUMP_PUSH : EVENT_JUMP_RELEASE, 0, player);
        this.touchButton(down, player);
      }
    }
    p.rawHeld = held;
  }

  /**
   * Every button handleButton is given reaches the armed Touch triggers too,
   * after the player has had it, unless player 1 is dead.
   * [gdp GJBaseGameLayer::handleButton :463997-463998]
   */
  private touchButton(push: boolean, player: number): void {
    if (!this.p1.dead) this.triggers.playerButton(push, player === 1);
  }

  /**
   * pushButton(Jump). A press takes the rings the last two collision passes
   * touched, before this step's movement, and only when there are none does
   * a grounded player that is not flying jump on the spot. A claim-touch ring
   * fires alone and lets go of the button. Custom rings go first; ringJump's
   * family flags then let at most one normal, one custom and one teleport
   * ring through. Everything here runs in the world frame, rotated or not.
   * [gdp PlayerObject::pushButton, gd-ida-decomp.cpp:160446-160532]
   */
  private pushButton(p: Player): void {
    p.pressButton();
    const rings = p.touchingRings;
    if (rings.length === 0) {
      // The immediate jump: the same step's updateJump already pulls on it
      // (first-tick yVel 10.964 at 1x, apex 2.13 blocks). A held landing
      // rejumps inside updateJump instead and skips that tick's gravity, which
      // is why buffered jumps come out ~0.08 blocks higher. updateJump itself
      // turns a dashing player down. [160528-160531][boom][wiki]
      if (!p.isFlying && p.onGround) p.updateJump(0);
      return;
    }
    // No immediate jump once the list has anything on it, even if every ring
    // refuses. A ring that leaves the latch and the button, like the toggle
    // and black orbs, lets the step's updateJump jump instead. [160455, 155762]
    const o = this.objs;
    const order = rings.slice(); // ringJump takes each fired ring off the live list
    for (const i of order) {
      if ((o.flags[i] & F_CLAIM_TOUCH) === 0) continue;
      this.ringJump(p, i);
      p.holding = false; // [160481]
      return;
    }
    for (const i of order) if (ORB_TYPES[o.param[i]] === "toggle") this.ringJump(p, i);
    for (const i of order) if (ORB_TYPES[o.param[i]] !== "toggle") this.ringJump(p, i);
  }

  /**
   * The end of a classic level, or an End trigger's: the level time stops
   * with it. [gdp EndPortalObject::triggerObject :326158,
   *  PlayLayer::levelComplete :92676, activatePlatformerEndTrigger :93046]
   */
  private finish(p: Player): void {
    p.finished = true;
    if (this.p2) this.p2.finished = true;
    this.triggers.stopLevelTime();
    this.emit("finish", p.playerNo);
  }

  private die(p: Player, object: number): boolean {
    // An End trigger fired earlier in this step (a collectible's spawn can
    // fire one in the middle of the collision pass) has locked the players,
    // and destroyPlayer does nothing while player 1 is locked, whichever
    // player hit something. [gdp PlayLayer::destroyPlayer :93151 (player 1's
    //  +2074); lockPlayer :159595, from playPlatformerEndAnimationToPos
    //  :92973]
    if (this.noclip || this.triggers.pendingEnd) return false;
    p.dead = true;
    p.killedBy = object >= 0 ? object : null;
    p.stopDashing();
    // playerDestroyed → playDeathEffect, for the player that died; a dual's
    // other player leaves by playExitDualEffect, its own playerDestroyed
    // making no death effect. [gdp PlayLayer::destroyPlayer :93191-93197;
    //  PlayerObject::playerDestroyed :149938-149963]
    this.wave("death", p, -1, "");
    this.emit("die", p.playerNo, object >= 0 ? object : undefined);
    const other = p === this.p1 ? this.p2 : this.p1;
    if (other && this.dual) this.exitDualWave(other);
    if (other) other.dead = true;
    return true;
  }

  /**
   * playExitDualEffect: the ring the player a dual leaves behind makes, as
   * the dual ends — when the other player dies, and at a solo portal for the
   * player that did not take it. The game draws it on the screen rather than
   * in the level, so the renderer reads the mirrored view off the variant.
   * Nothing gates it. [gdp GJBaseGameLayer::playExitDualEffect
   *  :421036-421179 (+860 the mirrored view, :421110-421121)]
   */
  private exitDualWave(p: Player): void {
    this.wave("exitDual", p, -1, p.mirrored ? "mirrored" : "");
  }

  /**
   * What destroyObject draws for a collectible: a coin's two circles, always;
   * any other pickup's one, when it shows its pickup effects and has no
   * particle of its own — except the small coin, whose effect has none.
   * shouldShowPickupEffects' last test, that something of the pickup is
   * drawn at all, reads its opacity, which is the renderer's to ask
   * (circleWaves.wavesFor).
   * [gdp GJBaseGameLayer::destroyObject :463125-463146; GameObject::
   *  shouldShowPickupEffects :622095-622109 (+900, +855, then the opacity),
   *  spawnDefaultPickupParticle :622125-622180 (not 1614),
   *  playDestroyObjectAnim :622603-622660 (types 22 and 31)]
   */
  private pickupWaves(p: Player, i: number, kind: string | undefined): void {
    if (kind === "secretCoin" || kind === "userCoin") {
      this.wave("coin", p, i, kind === "userCoin" ? "user" : "secret");
      return;
    }
    if (this.level.objects[i].id === SMALL_COIN_ID || (this.effectBits(i) & (EFFECT_NONE | EFFECT_HIDDEN | EFFECT_OWN_PARTICLE)) !== 0) return;
    this.wave("pickup", p, i, "");
  }

  // ---------------------------------------------------------------------------
  // collision pass (GJBaseGameLayer::checkCollisions)
  // ---------------------------------------------------------------------------

  /**
   * Whether object `i` touches the player whose box the pass last read as
   * (x0, y0)–(x1, y1).
   *
   * An oriented object — placed off the right angles, or turned at all by a
   * trigger (see applyGroupTransform) — is met in two steps: that box
   * against the object's outer box, then the player's own oriented box —
   * its box where it is now, turned by the angle it is drawn at — against
   * the object's, both ways. Upright or on a right angle the player's box is
   * its rect. In rotated gameplay the pass runs in the mirror, where the
   * angle mirrors too. A round object a trigger has turned takes its circle
   * as the first step and its own box as the second, except with kA39.
   * [gdp GJBaseGameLayer::checkCollisions :465009-465052 (hazards);
   *  collisionCheckObjects :463454-463478 (everything else);
   *  GameObject::updateOrientedBox :170865-170900, called on the player at
   *  :465015 and :463470; PlayerObject::getObjectRotation :140253-140256]
   */
  private hitsPlayer(i: number, x0: number, y0: number, x1: number, y1: number, p: Player): boolean {
    // The level as the player sees it: the mirror while gameplay is rotated.
    const o = this.collSet;
    switch (o.shape[i]) {
      case S_AABB:
        return rectsTouch(x0, y0, x1, y1, o.x0[i], o.y0[i], o.x1[i], o.y1[i]);
      case S_OBB:
        if (!rectsTouch(x0, y0, x1, y1, o.x0[i], o.y0[i], o.x1[i], o.y1[i])) return false;
        return this.playerBoxMeets(p, o.cx[i], o.cy[i], o.hw[i], o.hh[i], o.cosR[i], o.sinR[i]);
      case S_CIRCLE: {
        // playerCircleCollision: circle against circle with kA39, otherwise the
        // box's corners and the circle's centre. Either way it reads the
        // player's box as it is now, not the one collisionCheckObjects took at
        // the start of the section. [gd-ida-decomp.cpp:419666-419758]
        const h = p.hitboxSize() * 0.5;
        if (this.circleFix) return circleHitsCircle(p.x, p.y, h, o.cx[i], o.cy[i], o.hw[i]);
        if (!rectCornersHitCircle(p.x - h, p.y - h, p.x + h, p.y + h, o.cx[i], o.cy[i], o.hw[i])) return false;
        // Turned by a trigger, it is oriented, and without kA39 the two boxes
        // must meet as well: the object's own, not its circle. [:465038-465052,
        // :463462-463478]
        return o.turned[i] === 0 || this.playerBoxMeets(p, o.cx[i], o.cy[i], o.boxHw[i], o.boxHh[i], o.cosR[i], o.sinR[i]);
      }
      default: {
        const t = this.tri;
        o.triangle(i, t);
        return rectHitsTriangle(x0, y0, x1, y1, t[0], t[1], t[2], t[3], t[4], t[5]);
      }
    }
  }

  /**
   * OBB2D::overlaps1Way both ways, between the player's box — where it is
   * now, turned by the angle it is drawn at — and an object's oriented box.
   * On a right angle the player's box is its rect.
   * [gdp GameObject::updateOrientedBox :170865-170900; getObjectRotation
   *  :140253-140256]
   */
  private playerBoxMeets(p: Player, cx: number, cy: number, hw: number, hh: number, cosR: number, sinR: number): boolean {
    const half = p.hitboxSize() * 0.5;
    if (p.rotation % 90 === 0) return rectHitsObb(p.x - half, p.y - half, p.x + half, p.y + half, cx, cy, hw, hh, cosR, sinR);
    const r = p.rotation * DEG;
    let cos = Math.cos(r);
    let sin = Math.sin(r);
    if (this.inLocalFrame) {
      // The mirror's angle is 90° less the world's. [reflectObject]
      const t = cos;
      cos = sin;
      sin = t;
    }
    return obbsTouch(p.x, p.y, half, half, cos, sin, cx, cy, hw, hh, cosR, sinR);
  }

  /** Insertion sort of `list[0..n)` by `keys` (small n). */
  private sortByKey(n: number): void {
    const list = this.list;
    const keys = this.keys;
    for (let a = 1; a < n; a++) {
      const li = list[a];
      const k = keys[a];
      let b = a - 1;
      while (b >= 0 && keys[b] > k) {
        list[b + 1] = list[b];
        keys[b + 1] = keys[b];
        b--;
      }
      list[b + 1] = li;
      keys[b + 1] = k;
    }
  }

  /** Moving objects overlapping the query box, appended to a list the last query filled. */
  private addMovedCandidates(o: ObjectSet, cand: Int32Array, n: number, qx0: number, qy0: number, qx1: number, qy1: number): number {
    const stamp = this.stamp;
    const id = this.stampId;
    const cap = cand.length;
    for (const i of this.triggers.movedObjects) {
      if (stamp[i] === id) continue;
      if (o.kind[i] === K_NONE) continue;
      if (o.x1[i] < qx0 || o.x0[i] > qx1 || o.y1[i] < qy0 || o.y0[i] > qy1) continue;
      stamp[i] = id;
      if (n < cap) cand[n++] = i;
    }
    return n;
  }

  /** A group that has been toggled off stops colliding as well as drawing. */
  private dropDisabled(n: number): number {
    const cand = this.cand;
    let out = 0;
    for (let k = 0; k < n; k++) {
      const i = cand[k];
      if (this.triggers.objectDisabled(i)) continue;
      cand[out++] = i;
    }
    return out;
  }

  private collide(p: Player): void {
    p.wasOnSlope = p.onSlope;
    p.onSlope = false;
    p.collidingWithSlope = false;
    // preCollision: no floor, ceiling or wall met yet. [gd-ida-decomp.cpp:154030-154033]
    p.collideTop = 0;
    p.collideBottom = 0;
    p.collideLeft = 0;
    p.collideRight = 0;
    // A. The ground, the band and the level's bounds, before any object, in
    // world coordinates even when gameplay is rotated.
    if (!this.groundAndBounds(p)) return;
    if (p.rotated) this.collideRotated(p);
    else this.resolve(p, this.objs);
    // F. postCollision's squeeze tests and collision-log checks, in the
    // world: a player caught between a floor and a ceiling, and in a
    // platformer between two walls. [:158529-158845]
    if (!p.dead) this.squeeze(p);
    if (!p.dead) p.platformLaunch();
    if (!p.dead && this.platformer) p.forgetWalls();
    // [:159203-159209]
    if (!p.onSlope && !p.wasOnSlope) p.slopeUid = -1;
  }

  /**
   * Collision for a player whose gameplay is rotated.
   *
   * The ground, the corridor and the level's bounds stay where they are, in
   * world coordinates: the game's checkCollisions never reads the rotation
   * flag, so a rotated player still meets the ground at y 0 (collide does
   * that part first). Everything the player can hit is then handled in the
   * player's own frame — the player's axes swapped and the level mirrored to
   * match — so the ordinary resolvers run without knowing anything happened.
   * [gdp GJBaseGameLayer::checkCollisions :464582 has no read of byte 1971]
   */
  private collideRotated(p: Player): void {
    const o = this.reflectedSet();
    this.enterLocalFrame(p, o);
    this.resolve(p, o);
    this.leaveLocalFrame(p);
  }

  /**
   * The mirrored level, built the first time a player's gameplay is rotated
   * and kept current after that. Most levels never build it.
   */
  private reflectedSet(): ObjectSet {
    if (this.reflected) return this.reflected;
    const r = this.baseObjs.cloneReflected();
    // Anything a trigger has already moved is mirrored from where it is now.
    if (this.objs !== this.baseObjs) for (const i of this.triggers.movedObjects) reflectObject(this.objs, r, i);
    this.reflected = r;
    return r;
  }

  /** Swaps the player into its own frame and points collision at the mirror. */
  private enterLocalFrame(p: Player, o: ObjectSet): void {
    swapPlayerAxes(p);
    this.collSet = o;
    this.inLocalFrame = true;
  }

  private leaveLocalFrame(p: Player): void {
    this.inLocalFrame = false;
    this.collSet = this.objs;
    swapPlayerAxes(p);
  }

  /**
   * The objects around the player that the pass may meet, into `cand`, in the
   * order the game meets them; `keys` holds each one's order key alongside.
   * Only what the pass's section window holds is kept: see sectionWindow.
   */
  private gather(p: Player, o: ObjectSet): number {
    const half = p.hitboxSize() * 0.5;
    const qx0 = p.x - half - QUERY_MARGIN;
    const qy0 = p.y - half - QUERY_MARGIN;
    const qx1 = p.x + half + QUERY_MARGIN;
    const qy1 = p.y + half + QUERY_MARGIN;
    let n = o.hash.query(qx0, qy0, qx1, qy1, this.cand, this.stamp, ++this.stampId);
    // The spatial hash was built from the level as it was written, so anything
    // a trigger has moved has to be offered separately. Until the first Move
    // trigger fires this costs one boolean.
    if (this.triggers.hasMotion) n = this.addMovedCandidates(o, this.cand, n, qx0, qy0, qx1, qy1);
    if (this.triggers.hasToggles) n = this.dropDisabled(n);
    return this.collectInOrder(n);
  }

  /**
   * Keeps what of cand[0..n) the pass collects — whatever is filed in its
   * section window — and puts it in the order collisionCheckObjects meets it,
   * with the keys in keys[]; returns how many are left. The game files its
   * objects in 100-unit sections and walks them a column at a time, left to
   * right — and, where the level has rows, a row at a time up each column —
   * keeping each section in the order its objects were made, which is the
   * level's own order. The section is taken from the object's position, not
   * its hitbox, and always in the world's frame, so rotated gameplay meets the
   * same objects in the same order. So a big object filed outside the window
   * is not met, even where its box reaches the player.
   * [gdp GJBaseGameLayer::checkCollisions :464880-464966 (the window, the walk
   *  and the mIDCompSort), addToSection :444742-444770, mIDCompSort :415061-415063]
   */
  private collectInOrder(n: number): number {
    const cand = this.cand;
    const list = this.list;
    const keys = this.keys;
    const per = this.objs.n;
    let m = 0;
    for (let k = 0; k < n; k++) {
      const i = cand[k];
      const sec = this.sectionOf(i);
      if (!this.inWindow(sec)) continue;
      list[m] = i;
      keys[m++] = sec * per + i;
    }
    if (m > 1) this.sortByKey(m);
    for (let k = 0; k < m; k++) cand[k] = list[k];
    return m;
  }

  /** Section, then level order, as one number: section × objects + index. */
  private collectionKey(i: number): number {
    return this.sectionOf(i) * this.objs.n + i;
  }

  /**
   * The section the game files object `i` in, as column × SECTION_ROWS + row,
   * or EXTENDED_SECTION for an object with extended collision.
   */
  private sectionOf(i: number): number {
    if ((this.objs.flags[i] & F_EXTENDED) !== 0) return EXTENDED_SECTION;
    const obj = this.level.objects[i];
    let x = obj.x;
    let y = obj.y;
    // A moved object is filed where it is now.
    if (this.objs !== this.baseObjs) {
      x += this.objs.cx[i] - this.baseObjs.cx[i];
      y += this.objs.cy[i] - this.baseObjs.cy[i];
    }
    const col = x > 0 ? Math.trunc(x * COLLISION_SECTION_SCALE) : 0;
    const gy = y + GAME_GROUND_Y;
    const row = this.ySections && gy > 0 ? Math.trunc(gy * COLLISION_SECTION_SCALE) : 0;
    return col * SECTION_ROWS + row;
  }

  /**
   * Fixes the sections this pass collects from, from where the player stands
   * as it begins: its column and the one either side, and where the level has
   * rows, its row and the one either side. The player's position is a float
   * in the game's space, where an object's is a double. Nothing filed outside
   * them is met this pass, however far a portal, pad or orb moves the player,
   * and nothing is collected again after one does: a player sent out of the
   * window meets what waits for it there on the next pass. The window is the
   * world's, like the sections.
   * [gdp GJBaseGameLayer::checkCollisions, gd-ida-decomp.cpp:464880-464966;
   *  solids and hazards collected only in collisionCheckObjects :463394-463430;
   *  teleportPlayer mid-walk :463753]
   */
  private sectionWindow(p: Player): void {
    const x = Math.fround(this.inLocalFrame ? p.y : p.x);
    const y = Math.fround((this.inLocalFrame ? p.x : p.y) + GAME_GROUND_Y);
    this.winCol = x > 0 ? Math.trunc(Math.fround(x * COLLISION_SECTION_SCALE)) : 0;
    this.winRow = this.ySections && y > 0 ? Math.trunc(Math.fround(y * COLLISION_SECTION_SCALE)) : 0;
  }

  /**
   * Whether section `sec` is in the pass's window. An object with extended
   * collision always is: the game tests those after the window's sections,
   * wherever the player is. [checkCollisions :464968-464970]
   */
  private inWindow(sec: number): boolean {
    if (sec === EXTENDED_SECTION) return true;
    const col = Math.floor(sec / SECTION_ROWS);
    const row = sec - col * SECTION_ROWS;
    return Math.abs(col - this.winCol) <= 1 && Math.abs(row - this.winRow) <= 1;
  }

  /**
   * What the player hits, once checkCollisions has settled it against the
   * ground, in the game's order.
   *
   * Everything is collected from the sections around where the player stands
   * as the pass begins (sectionWindow), and only from there.
   *
   * First collisionCheckObjects' walk over everything that acts on a touch —
   * portals, pads, orbs, slopes, letter and force blocks, collectibles,
   * checkpoints — in the order the game meets them. The player's
   * box is read once per section and again after a slope, a teleport portal
   * or a teleport orb, so what one of those does is seen by the objects after
   * it. Anything else that moves or resizes the player — a spider pad or orb,
   * a size portal — is only seen by the next section's objects (a round one
   * excepted, and an oriented one once its outer box is met: those tests read
   * the box as it is now, see hitsPlayer). Then the solids, the last one met
   * first, each tested against the box as the one before left it. Then the
   * hazards, against where the solids put the player. Then, if nothing killed
   * it, the start of postCollision; collide runs its squeeze tests.
   *
   * So a pad or portal acts before the block under it is landed on, a gravity
   * portal turns a player before the ceiling it rides is met, and a spike flush
   * with a block's face only kills a player the block did not push clear.
   * `o` is the level as the player sees it: the world, or the mirror when
   * gameplay is rotated.
   * [gdp GJBaseGameLayer::checkCollisions, gd-ida-decomp.cpp:464929-465060;
   *  collisionCheckObjects :463309-463960, the box read at :463381-463386 and
   *  read again at LABEL_124 :463754-463760, which the slope (:463730-463732),
   *  the teleport portal (:463749-463753) and the teleport orb (:463858-463860)
   *  go through]
   */
  private resolve(p: Player, o: ObjectSet): void {
    const plat = this.platformer;
    const cand = this.cand;
    this.sectionWindow(p);
    let n = this.gather(p, o);
    const startX = p.x;
    const startY = p.y;

    // B. collisionCheckObjects. Solids and hazards are only collected here.
    const actBit = p.playerNo === 1 ? ST_ACT_P1 : ST_ACT_P2;
    const touchBit = p.playerNo === 1 ? ST_TOUCH_P1 : ST_TOUCH_P2;
    let section = -1;
    let reread = true;
    let px0 = 0;
    let py0 = 0;
    let px1 = 0;
    let py1 = 0;
    for (let k = 0; k < n; k++) {
      const i = cand[k];
      const kind = o.kind[i];
      if (kind === K_SOLID || kind === K_HAZARD) continue;
      const sec = Math.floor(this.keys[k] / o.n);
      if (sec !== section) {
        section = sec;
        reread = true;
      }
      if (reread) {
        reread = false;
        const half = p.hitboxSize() * 0.5;
        px0 = p.x - half;
        py0 = p.y - half;
        px1 = p.x + half;
        py1 = p.y + half;
      }
      if (kind === K_SLOPE) {
        // A slope is looked for with a box twice its own size.
        // [getObjectRect(2, 2), gd-ida-decomp.cpp:463444-463447]
        const ex = (o.x1[i] - o.x0[i]) * 0.5;
        const ey = (o.y1[i] - o.y0[i]) * 0.5;
        if (!rectsTouch(px0, py0, px1, py1, o.x0[i] - ex, o.y0[i] - ey, o.x1[i] + ex, o.y1[i] + ey)) continue;
        const r = collideSlope(p, o, i, plat);
        if (r === R_DIE) {
          if (this.die(p, i)) return;
        } else if (r === R_BREAK) {
          this.breakBlock(p, i);
        }
        // Landed on or not, the box is read again. [:463730-463732]
        reread = true;
      } else {
        // canTouchObject: an orb, pad, portal, collectible, checkpoint, force
        // block or letter block on another channel than the active one goes
        // the way of one the player is not touching, leaving included.
        // [:463487, where the gate and the overlap are one test]
        const gated = o.channelOf.size > 0 && !this.triggers.canTouch(o.channelOf.get(i) ?? 0);
        if (kind === K_SPECIAL) {
          if (!gated && rectsTouch(px0, py0, px1, py1, o.x0[i], o.y0[i], o.x1[i], o.y1[i])) this.touchLetterBlock(p, o.param[i]);
        } else if (kind === K_FORCE) {
          // Every pass it touches, with no once-only mark. [:463812-463813]
          if (!gated && this.hitsPlayer(i, px0, py0, px1, py1, p)) this.touchForce(p, i);
        } else if (kind >= K_ORB && kind <= K_CHECKPOINT) {
          if (this.touchObject(p, o, i, !gated && this.hitsPlayer(i, px0, py0, px1, py1, p), actBit, touchBit)) reread = true;
        }
      }
      if (p.dead) return;
    }

    // A spider pad or orb, or a teleport, can have taken the player past what
    // was gathered around it. Look again around where it is now, but still only
    // in the window the pass began with: the game collected its solids and
    // hazards there, so what the player lands on outside it waits for the next
    // pass. [checkCollisions :464880-464966; teleportPlayer mid-walk :463753]
    if (Math.abs(p.x - startX) > REQUERY_DISTANCE || Math.abs(p.y - startY) > REQUERY_DISTANCE) n = this.gather(p, o);

    // C. Solids, the last one met first, each against the box as the one
    // before left it; touching counts. [:464974-465003]
    for (let k = n - 1; k >= 0; k--) {
      const i = cand[k];
      if (o.kind[i] !== K_SOLID) continue;
      const slot = o.slot[i];
      if (slot >= 0 && (this.objState[slot] & ST_DESTROYED) !== 0) continue;
      const half = p.hitboxSize() * 0.5;
      if (!rectsTouch(p.x - half, p.y - half, p.x + half, p.y + half, o.x0[i], o.y0[i], o.x1[i], o.y1[i])) continue;
      const r = collideSolid(p, o, i, plat);
      if (r === R_DIE) {
        if (this.die(p, i)) return;
      } else if (r === R_BREAK) {
        this.breakBlock(p, i);
      }
    }

    // D. Hazards, first met first, against the box the solids left. The first
    // one touched kills. [:465008-465057]
    if (!this.noclip) {
      const half = p.hitboxSize() * 0.5;
      const hx0 = p.x - half;
      const hy0 = p.y - half;
      const hx1 = p.x + half;
      const hy1 = p.y + half;
      for (let k = 0; k < n; k++) {
        const i = cand[k];
        if (o.kind[i] !== K_HAZARD) continue;
        if (!this.hitsPlayer(i, hx0, hy0, hx1, hy1, p)) continue;
        this.die(p, i);
        return;
      }
    }

    // E. postCollision, which is where a slope is left. [:465018-465021]
    p.leaveSlope();
  }

  /**
   * A force block or circle the pass touched: calculateForceToTarget, handed
   * to the player's touchedObject. Worked out in the world whatever frame the
   * pass runs in, from the object's centre and the player's, in floats.
   *
   * The push points along the object's angle — 90° less its rotation, half a
   * turn more when it is flipped upside down, so an unturned block pushes up —
   * or, with key 528, straight away from the object's centre (towards it when
   * flipped). Its strength is key 149, or with key 529 runs from key 526 to
   * key 527: across the object from the side the push points to to the side it
   * comes from, or with key 528 as well from the rim to the centre. The size
   * that range is measured over is the circle's radius, or half the longer
   * side of its outer box — for a block turned off the right angles, the
   * upright box around the turned one, not the block's own sides.
   * [gdp ForceBlockGameObject::calculateForceToTarget, gd-ida-decomp.cpp:312994-313089;
   *  PlayerObject::touchedObject :159675-159698; the rect, getObjectRect2
   *  :170950-170967, which an oriented object fills from getOuterObjectRect
   *  :170928-170934]
   */
  private touchForce(p: Player, i: number): void {
    const o = this.objs;
    const mode = o.forceMode[i];
    const flipY = (o.flags[i] & F_FLIP_Y) !== 0;
    // v8, and the vector from the player to the object's centre that the
    // relative and range modes read. [:313027-313036, 313043, 313082]
    const r =
      o.shape[i] === S_CIRCLE
        ? Math.fround(o.hw[i])
        : Math.fround(Math.max(o.x1[i] - o.x0[i], o.y1[i] - o.y0[i]) * 0.5);
    const dx = Math.fround(Math.fround(o.cx[i]) - p.worldX);
    const dy = Math.fround(Math.fround(o.cy[i] + GAME_GROUND_Y) - (p.worldY + GAME_GROUND_Y));
    // v13, a float. [:313044-313049, 313053-313058]
    const angle =
      (mode & FORCE_RELATIVE) !== 0
        ? Math.fround(Math.atan2(dy, dx) + (flipY ? 0 : Math.PI))
        : Math.fround(Math.fround(Math.fround(90 - Math.fround(o.rawRot[i])) + (flipY ? 180 : 0)) * FORCE_DEG);
    const cos = Math.fround(Math.cos(angle));
    const sin = Math.fround(Math.sin(angle));
    let strength = o.forceStrength[i];
    if ((mode & FORCE_RANGE) !== 0) {
      // v12, clamped to 0..1, then v6. [:313060-313088]
      let t: number;
      if ((mode & FORCE_RELATIVE) !== 0) {
        const d = Math.fround(Math.sqrt(Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy))));
        t = d < r ? Math.fround(1 - Math.fround(d / r)) : 0;
      } else {
        const along = Math.fround(Math.fround(dy * sin) + Math.fround(dx * cos));
        t = Math.fround(Math.fround(Math.fround(along + r) / r) * 0.5);
      }
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const min = o.forceMin[i];
      strength = Math.fround(min + Math.fround(Math.fround(o.forceMax[i] - min) * t));
    }
    p.touchForce(Math.fround(cos * strength), Math.fround(sin * strength), o.param[i]);
  }

  /**
   * postCollision's squeeze tests, where a player caught in one pass between
   * a floor and a ceiling, or in a platformer between two walls, dies where
   * the pass left it, with no object to blame, and the collision-log checks
   * after each.
   *
   * The floor and the ceiling come first (squeezeFloorAndCeiling), with kA31
   * or in a platformer. A platformer then tests the walls, whatever the first
   * test did — nudged the player, eased it down a slope, or let it be
   * (squeezeWalls).
   *
   * After each test, in every level and whatever it did, the collision log
   * (Player.logTop and the rest) is checked: one object met since the step
   * began both as a floor and as a ceiling, or in a platformer as walls on
   * both sides, puts the player back where its update began and destroys it
   * (crush).
   *
   * Run in the world after the pass, as the game's postCollision reads the
   * world: its position, the saved one, and the level's own objects. The
   * put-back to where the update began that comes before a squeeze death is
   * the editor's alone: it is behind +1604, which is set outside the editor.
   * The log's put-back is not.
   * [gdp PlayerObject::postCollision, gd-ida-decomp.cpp:158529-158845; the
   *  put-backs :158663-158664, 158812-158813; +1604 = !+10732,
   *  PlayerObject::init :162197 via GJBaseGameLayer::createPlayer
   *  :417895-417900, +10732 set by LevelEditorLayer::init :204650; the
   *  collision log :158682-158715 (after the first test, in every level) and
   *  :158831-158845 (after the second, in a platformer), both behind +2496,
   *  which only the editor sets (:417944-417949)]
   */
  private squeeze(p: Player): void {
    if (this.squeezes) this.squeezeFloorAndCeiling(p);
    if (logsMeet(p.logTop, p.logBottom)) {
      this.crush(p);
      return;
    }
    if (!this.platformer) return;
    if (!p.dead) this.squeezeWalls(p);
    if (logsMeet(p.logLeft, p.logRight)) this.crush(p);
  }

  /**
   * A collision-log death: back to where the update began, then destroyed.
   * [gdp PlayerObject::postCollision LABEL_303 :158694-158711]
   */
  private crush(p: Player): void {
    p.x = p.lastX;
    p.y = p.lastY;
    if (!p.dead) this.die(p, -1);
  }

  /**
   * The first squeeze test: a player that met both a floor and a ceiling this
   * pass, closer than 0.7 of its height (0.8 in a platformer), dies. Two
   * exceptions come first. A ceiling that is on the floor's side of where the
   * player is and of where its update began does not count. And a platformer
   * player on a slope with between 0.8 and all of its height to spare is
   * moved a quarter unit from where its update began — left on an uphill
   * floor slope or a downhill ceiling one, right otherwise — and stopped,
   * whichever side the ceiling is on; a squeezed one first tries the eight
   * places beside it (squeezeSideways).
   * [gdp PlayerObject::postCollision, gd-ida-decomp.cpp:158529-158680]
   */
  private squeezeFloorAndCeiling(p: Player): void {
    const top = p.collideTop;
    const bottom = p.collideBottom;
    if (top === 0 || bottom === 0) return;
    const h = p.hitboxSize();
    const factor = this.platformer ? SQUEEZE_FACTOR_PLATFORMER : SQUEEZE_FACTOR;
    const limit = Math.fround(h * factor);
    // v30: the gap, a float. [:158538-158540]
    const gap = Math.abs(Math.fround(top - bottom));
    // v24: the ceiling is past the player and was past it before the move. [:158541-158560]
    let clear = true;
    if (gap !== 0) {
      const y = p.y + GAME_GROUND_Y;
      const lastY = p.lastY + GAME_GROUND_Y;
      clear = p.flipped ? top > y && top > lastY : top < y && top < lastY;
    }
    const slope = p.slopeIdx;
    if (this.platformer && slope >= 0 && gap >= limit && gap <= h) {
      const o = this.objs;
      const half = h * 0.5;
      if (rectsTouch(p.x - half, p.y - half, p.x + half, p.y + half, o.x0[slope], o.y0[slope], o.x1[slope], o.y1[slope])) {
        // [:158565-158590]
        const down = ((o.flags[slope] & F_UPHILL) !== 0) !== ((o.flags[slope] & F_SOLID_ABOVE) !== 0) ? -1 : 1;
        p.xVel = 0;
        p.setX(p.lastX + down * p.stepDt);
        return;
      }
    }
    if (clear || gap >= limit) return;
    if (this.platformer && this.squeezeSideways(p)) return;
    // [:158657-158673]
    this.die(p, -1);
  }

  /**
   * The platformer's second squeeze test: a player pushed off a wall on each
   * side this pass, closer than its width less 5 × its scale (25, 15 when
   * mini), dies. One exception comes first: moving left, a left wall right of
   * where the player is and of where its update began does not count, nor,
   * otherwise, a right wall left of both. A squeezed player first tries the
   * eight places above and below it (squeezeUpOrDown).
   * [gdp PlayerObject::postCollision, gd-ida-decomp.cpp:158716-158830]
   */
  private squeezeWalls(p: Player): void {
    const left = p.collideLeft;
    const right = p.collideRight;
    if (left === 0 || right === 0) return;
    // v68: the gap, a float. [:158724-158731]
    const gap = Math.abs(Math.fround(right - left));
    if (gap === 0) return;
    // The wall on the side the player moves to is past it, and was before
    // the move. [:158734-158742]
    if (p.xVel < 0 ? left > p.x && left > p.lastX : right < p.x && right < p.lastX) return;
    const limit = Math.fround(p.hitboxSize() - Math.fround(p.vehicleSize() * SQUEEZE_WALL_MARGIN));
    if (gap >= limit) return;
    if (this.squeezeUpOrDown(p)) return;
    // [:158812-158826]
    this.die(p, -1);
  }

  /**
   * A squeezed platformer player's way out: 3, 6, 9 and 12 units right and
   * left, right first. The first place whose box — a unit narrower each side,
   * a unit taller each end — does not have solids both below and above the
   * player's centre, or one level with it, is where the player goes.
   * [gd-ida-decomp.cpp:158593-158656]
   */
  private squeezeSideways(p: Player): boolean {
    const half = p.hitboxSize() * 0.5;
    const x0 = Math.fround(p.x - half + 1);
    const x1 = Math.fround(p.x + half - 1);
    const y0 = p.y - half - 1;
    const y1 = p.y + half + 1;
    for (let k = 1; k <= SQUEEZE_NUDGE_TRIES; k++) {
      const step = Math.ceil(k * 0.5) * SQUEEZE_NUDGE;
      const dx = (k & 1) === 0 ? -step : step;
      if (this.sideIsOpen(Math.fround(x0 + dx), y0, Math.fround(x1 + dx), y1, p.y)) {
        p.setX(p.x + dx);
        return true;
      }
    }
    return false;
  }

  /**
   * The way out from between walls: 3, 6, 9 and 12 units up and down, up
   * first. The first place whose box — a unit wider each side, a unit
   * shorter each end — passes endIsOpen is where the player goes.
   * [gd-ida-decomp.cpp:158745-158810]
   */
  private squeezeUpOrDown(p: Player): boolean {
    const half = p.hitboxSize() * 0.5;
    const x0 = Math.fround(p.x - half - 1);
    const x1 = Math.fround(p.x + half + 1);
    const y0 = p.y - half + 1;
    const y1 = p.y + half - 1;
    for (let k = 1; k <= SQUEEZE_NUDGE_TRIES; k++) {
      const step = Math.ceil(k * 0.5) * SQUEEZE_NUDGE;
      const dy = (k & 1) === 0 ? -step : step;
      if (this.endIsOpen(x0, y0 + dy, x1, y1 + dy, p.x)) {
        p.setY(p.y + dy);
        return true;
      }
    }
    return false;
  }

  /**
   * The test the first squeeze makes of staticObjectsInRect: whether none of
   * what it finds has its position below `y` while another has it above, and
   * none has it level.
   * [gdp PlayerObject::postCollision, gd-ida-decomp.cpp:158613-158654]
   */
  private sideIsOpen(x0: number, y0: number, x1: number, y1: number, y: number): boolean {
    const o = this.objs;
    const cand = this.cand;
    const n = this.staticObjectsInRect(x0, y0, x1, y1);
    const moved = this.objs !== this.baseObjs;
    let below = false;
    let above = false;
    for (let k = 0; k < n; k++) {
      const i = cand[k];
      const at = this.level.objects[i].y + (moved ? o.cy[i] - this.baseObjs.cy[i] : 0);
      if (at === y) return false;
      if (at < y) below = true;
      else above = true;
      if (below && above) return false;
    }
    return true;
  }

  /**
   * The test the wall squeeze makes of staticObjectsInRect: the first one's
   * turned on its side, with a slip the game has. What it finds left of `x`
   * counts as left; anything else counts as right, unless its y — the game
   * reads the object's y there, not its x — is at or below `x`, which shuts
   * the place outright. So once the player is further along than any object
   * there is high, one object not left of its centre shuts the place. Open
   * when nothing is found on both sides and nothing shuts it. Positions are
   * floats in the game's space.
   * [gdp PlayerObject::postCollision, gd-ida-decomp.cpp:158778-158805, the y
   *  at :158799]
   */
  private endIsOpen(x0: number, y0: number, x1: number, y1: number, x: number): boolean {
    const o = this.objs;
    const cand = this.cand;
    const n = this.staticObjectsInRect(x0, y0, x1, y1);
    const moved = this.objs !== this.baseObjs;
    let left = false;
    let right = false;
    for (let k = 0; k < n; k++) {
      const i = cand[k];
      const obj = this.level.objects[i];
      const ox = Math.fround(obj.x + (moved ? o.cx[i] - this.baseObjs.cx[i] : 0));
      if (ox < x) {
        if (right) return false;
        left = true;
      } else {
        const oy = Math.fround(obj.y + (moved ? o.cy[i] - this.baseObjs.cy[i] : 0) + GAME_GROUND_Y);
        if (oy <= x || left) return false;
        right = true;
      }
    }
    return true;
  }

  /**
   * staticObjectsInRect(rect, false), into `cand`; returns how many: the
   * solids, breakables and slopes meeting the rect, among those filed in the
   * sections the rect covers and one more on every side, which leaves out
   * extended collision.
   * [gdp GJBaseGameLayer::staticObjectsInRect, gd-ida-decomp.cpp:419454-419604,
   *  the sections :419474-419552, the kinds :419583-419586]
   */
  private staticObjectsInRect(x0: number, y0: number, x1: number, y1: number): number {
    const o = this.objs;
    const cand = this.cand;
    let n = o.hash.query(x0, y0, x1, y1, cand, this.stamp, ++this.stampId);
    if (this.triggers.hasMotion) n = this.addMovedCandidates(o, cand, n, x0, y0, x1, y1);
    if (this.triggers.hasToggles) n = this.dropDisabled(n);
    const s = COLLISION_SECTION_SCALE;
    const col0 = x0 * s - 1 > 0 ? Math.trunc(x0 * s - 1) : 0;
    const col1 = Math.trunc(x1 * s + 1);
    const gy0 = (y0 + GAME_GROUND_Y) * s - 1;
    const row0 = this.ySections && gy0 > 0 ? Math.trunc(gy0) : 0;
    const row1 = this.ySections ? Math.trunc((y1 + GAME_GROUND_Y) * s + 1) : 0;
    let m = 0;
    for (let k = 0; k < n; k++) {
      const i = cand[k];
      const kind = o.kind[i];
      if (kind !== K_SOLID && kind !== K_SLOPE) continue;
      const slot = o.slot[i];
      if (slot >= 0 && (this.objState[slot] & ST_DESTROYED) !== 0) continue;
      if (!rectsTouch(x0, y0, x1, y1, o.x0[i], o.y0[i], o.x1[i], o.y1[i])) continue;
      const sec = this.sectionOf(i);
      if (sec === EXTENDED_SECTION) continue;
      const col = Math.floor(sec / SECTION_ROWS);
      const row = sec - col * SECTION_ROWS;
      if (col < col0 || col > col1 || row < row0 || row > row1) continue;
      cand[m++] = i;
    }
    return m;
  }

  /**
   * A letter block the pass touched. D, J, H and F hold for this pass and the
   * next: touching one sets its counter to 2 and every update takes one off.
   * S has no counter — it ends a dash on the spot and lets go of the button.
   * A slope met earlier in the same pass has already seen the old counters.
   * [gdp PlayerObject::touchedObject, gd-ida-decomp.cpp:159651-159716]
   */
  private touchLetterBlock(p: Player, code: number): void {
    switch (code) {
      case 1:
        p.stateDartSlide = LETTER_BLOCK_PASSES;
        break;
      case 2:
        p.stateNoAutoJump = LETTER_BLOCK_PASSES;
        break;
      case 3:
        if (p.dashing) {
          p.stopDashing();
          p.holding = false; // [159712]
        }
        break;
      case 4:
        p.stateHitHead = LETTER_BLOCK_PASSES;
        break;
      default:
        p.stateFlipGravity = LETTER_BLOCK_PASSES;
    }
  }

  /**
   * A portal, pad, orb, collectible or checkpoint the pass met, touching
   * or not: leaving one is what lets a multi-activate object fire again.
   * True when the walk must read the player's box again: after a teleport
   * portal that fired, and after a teleport orb the player touched, whether
   * or not it fired. [collisionCheckObjects :463749-463760, :463858-463860]
   */
  private touchObject(p: Player, o: ObjectSet, i: number, touching: boolean, actBit: number, touchBit: number): boolean {
    const kind = o.kind[i];
    const slot = o.slot[i];
    const s = this.objState[slot];
    if (!touching) {
      if ((s & touchBit) !== 0) this.setObjState(slot, s & ~touchBit);
      return false;
    }
    const firstTouch = (s & touchBit) === 0;
    if (firstTouch) this.setObjState(slot, s | touchBit);
    switch (kind) {
      case K_PORTAL:
        if (this.canActivate(o.flags[i], s, firstTouch, actBit)) {
          const f = o.flags[i];
          // hasBeenActivated, by either player, which a speed portal's circle
          // asks; a multi-activate object is never marked. [EffectGameObject::
          //  triggerActivated :298093-298101, EnhancedGameObject::
          //  hasBeenActivated :164149-164157]
          const first = (f & F_MULTI) !== 0 || (s & (ST_ACT_P1 | ST_ACT_P2)) === 0;
          if ((f & F_MULTI) === 0) this.setObjState(slot, this.objState[slot] | ((f & F_SHARED) !== 0 ? ST_ACT_P1 | ST_ACT_P2 : actBit));
          this.applyPortal(p, i, first);
          return o.param[i] === P_TP_LINKED_ENTRY || o.param[i] === P_TP_TARGET_ENTRY;
        }
        break;
      case K_PAD:
        // The blue pad decides for itself whether it was used, so the bit is
        // set after it has had its say.
        if (this.canActivate(o.flags[i], s, firstTouch, actBit)) {
          if (this.applyPad(p, i)) {
            if ((o.flags[i] & F_MULTI) === 0) this.setObjState(slot, this.objState[slot] | actBit);
          } else if ((o.flags[i] & F_MULTI) !== 0) {
            // gravBumpPlayer turns back before canBeActivatedByPlayer, which
            // is what records the touch, so for a multi-activate pad the
            // next pass is still a fresh entry. [gd-ida-decomp.cpp:463237-463239]
            this.setObjState(slot, this.objState[slot] & ~touchBit);
          }
        }
        break;
      case K_ORB:
        // collisionCheckObjects never looks again at a ring this player has
        // used; a multi-activate ring is never marked, so every pass sees it.
        // [gd-ida-decomp.cpp:463439]
        if ((s & actBit) === 0) {
          this.playerTouchedRing(p, i);
          return ORB_TYPES[o.param[i]] === "teleport";
        }
        break;
      case K_COLLECTIBLE: {
        if ((s & ST_ACT_P1) !== 0) break;
        const kind = this.objects.get(this.level.objects[i].id).collectible;
        const coin = kind === "secretCoin" || kind === "userCoin";
        // A coin is not picked up at all in practice: it stays, and nothing
        // fires. [gdp collisionCheckObjects case 0x16 :463675-463676, case
        //  0x1F :463780-463782]
        if (coin && this.practice) break;
        this.setObjState(slot, this.objState[slot] | ST_ACT_P1);
        // A key, a small coin or a pixel item (object type 30) counts, toggles
        // and scores on its way; a coin spawns its own group.
        // [gdp collisionCheckObjects case 0x1E :463762-463779; a coin's
        //  triggerObject :463678-463681 → :315158-315160 → LABEL_125
        //  :315442-315457]
        if (coin) this.triggers.coinCollected(i);
        else this.triggers.collected(i);
        // Then the game event, User Coin or Pickup Item, for no player.
        // [gdp collisionCheckObjects: a secret coin :463687 → :463855; a
        //  pickup :463778 and a user coin :463799 → :463801]
        this.triggers.gameEvent(coin ? EVENT_USER_COIN : EVENT_PICKUP_ITEM, 0, 0);
        this.pickupWaves(p, i, kind);
        this.emit("collect", p.playerNo, i, kind);
        break;
      }
      case K_CHECKPOINT:
        if ((s & ST_ACT_P1) === 0) {
          this.setObjState(slot, this.objState[slot] | ST_ACT_P1);
          this.emit("checkpoint", p.playerNo, i);
          // In a platformer the layer notes it and lays the checkpoint down
          // once the step is over; in a classic level it only flashes.
          // [gdp CheckpointGameObject::triggerObject :297595-297599 →
          //  PlayLayer::checkpointActivated :86960-86965 (+12104, platformer
          //  only) → GJBaseGameLayer::checkpointActivated :433324-433357]
          if (this.platformer) this.triggers.pendingCheckpoint = i;
        }
        break;
      default:
        break;
    }
    return false;
  }

  /**
   * canBeActivatedByPlayer, with the collision loop's own skip in front of it:
   * an object this player has used is never looked at again, and a
   * multi-activate one needs a fresh entry instead of a free one.
   * [gdp GJBaseGameLayer::collisionCheckObjects :463439, canBeActivatedByPlayer
   *  :456752-456765; activatedByPlayer :165225-165240 marks nothing for a
   *  multi-activate object]
   */
  private canActivate(flags: number, s: number, firstTouch: boolean, actBit: number): boolean {
    return (flags & F_MULTI) !== 0 ? firstTouch : (s & actBit) === 0;
  }

  /**
   * A Rotate Gameplay trigger. Player 1 always turns, player 2 only in a dual,
   * and both take the same arguments; key 172 leaves them both alone.
   * [gdp GJBaseGameLayer::rotateGameplay, gd-ida-decomp.cpp:442829-442849]
   */
  private rotateGameplay(r: GameplayRotation): void {
    if (r.channelOnly) return;
    this.rotatePlayer(this.p1, r);
    if (this.dual && this.p2) this.rotatePlayer(this.p2, r);
    this.hashDirty = true;
  }

  /**
   * Turns one player. Instant — nothing here is tweened.
   *
   * The gravity flip and the reverse are applied every time; the velocity
   * handover only when the quarter turn itself changes. On that handover the
   * old forward speed becomes the new gravity-axis velocity, which is what
   * carries the player's momentum through the turn instead of stopping it dead.
   * The old gravity-axis velocity becomes a platformer's x velocity and is
   * dropped otherwise. Key 169 replaces the handed-over values (583 the new y,
   * 582 the new x), outright or as multipliers by key 584.
   * [gdp PlayerObject::rotateGameplay, gd-ida-decomp.cpp:152445-152548;
   *  getCurrentXVelocity :142060-142072, the platformer's signed `xVel` or
   *  the classic forward speed, `xSpeed` here]
   */
  private rotatePlayer(p: Player, r: GameplayRotation): void {
    // Both halves are read before the flip can halve the y velocity. [:152474-152477]
    const forward = Math.fround(this.platformer ? p.xVel : p.xSpeed);
    const side = Math.fround(p.yVel);
    const wasRotated = p.rotated;
    const nowRotated = r.orientation === 3 || r.orientation === 4;
    p.rotated = nowRotated;
    p.flipGravity(r.orientation === 1 || r.orientation === 4);
    // The reverse goes through doReversePlayer on every turn, so a ball rolls
    // afresh the new frame's way; a platformer keeps its own facing and passes
    // that. [gdp PlayerObject::rotateGameplay :152481-152490; doReversePlayer
    //  :148342-148343]
    p.doReversePlayer(this.platformer ? p.reversed : r.direction === 2 || r.direction === 3);
    if (nowRotated === wasRotated) return;
    // A new quarter turn empties the collision log, and like a teleport
    // forgets where the player last met the ground. [:152508, :152533 →
    // playerTeleported :148810]
    p.resetCollisionLog();
    p.lastGroundY = Number.NaN;
    // Handed over as a float point, its halves swapped, through
    // updatePlayerForce, which writes the doubles directly: not rounded to
    // thousandths. A platformer's x velocity takes the other half.
    // [:152505-152531, 147375-147395]
    const edit = r.editVelocity;
    const fix = r.overrideVelocity;
    p.yVel = edit ? (fix ? Math.fround(r.velocityY) : Math.fround(forward * Math.fround(r.velocityY))) : forward;
    if (this.platformer) p.xVel = edit ? (fix ? Math.fround(r.velocityX) : Math.fround(side * Math.fround(r.velocityX))) : side;
    // The hand-over is a force, and a force lets a flying player past its
    // caps; the player also counts as launched. "Dont Slide" (key 585) takes
    // the first half back at once, so a flyer is held to its caps from the
    // next tick; the boost stays.
    // [gdp PlayerObject::rotateGameplay :152492, 152531-152535;
    //  updatePlayerForce :147384; handlePlayerCommand(543) :142373-142379]
    p.isAccelerating = !r.dontSlide;
    if (r.dontSlide) p.forceSlide = false;
    p.maybeIsBoosted = true;
    // The turn is a teleport as far as the collision log is concerned.
    p.lastX = p.x;
    p.lastY = p.y;
    // A cube not already spinning starts to, in the new frame's direction.
    // [gdp PlayerObject::rotateGameplay :152536-152538; isInNormalMode
    //  :145258-145270]
    if (p.isInNormalMode() && !p.spinning) p.runRotateAction();
    // A dash turns with the frame: its pair trades halves, +1192 through a
    // float, its angle goes half round (less 360 past 360), and it is drawn
    // again. A classic dash's slope trades with whatever +1184 holds.
    // [:152539-152549]
    if (p.dashing) {
      const vx = p.dashVelX;
      p.dashVelX = p.dashVelY;
      p.dashVelY = Math.fround(vx);
      const angle = p.dashAngle + 180;
      p.dashAngle = angle > 360 ? angle - 360 : angle;
      p.updateDashArt();
    }
  }

  /**
   * GJBaseGameLayer::flipGravity: how every gravity changer the game routes
   * through the layer turns a player over — the three gravity portals, the
   * blue pad, and the blue, green and gravity-dash orbs. A player already on
   * that gravity is left alone. In a linked dual the other player turns to the
   * opposite gravity with it, halving included, as long as the two are in the
   * same mode by sameModeButWave's reckoning. The spider pad and orb, the
   * spider's own jump, the ball and swing clicks and a gameplay rotation turn
   * the player directly and never come through here, so they never carry the
   * other player along. The halving is Player.flipGravity's. Returns the
   * other player when it turned with this one, for the gravity portal's
   * second circle.
   * [gdp GJBaseGameLayer::flipGravity, gd-ida-decomp.cpp:420149-420178]
   */
  private flipGravity(p: Player, flipped: boolean): Player | null {
    if (p.flipped === flipped) return null;
    p.flipGravity(flipped);
    const other = p === this.p1 ? this.p2 : this.p1;
    if (!other || !this.dualGravityLinked() || !sameModeButWave(p, other) || other.flipped === !flipped) return null;
    other.flipGravity(!flipped);
    return other;
  }

  /**
   * Dual gravity is linked in any dual that is not a two-player level, until an
   * Options trigger unlinks it (key 160 at 1; -1 links it again).
   * [gd-ida-decomp.cpp:420158-420162 (+1512, +870, LevelSettings +280 = kA10);
   *  the layer writes +1512 only in processOptionsTrigger :429823-429825]
   */
  private dualGravityLinked(): boolean {
    return this.dual && !this.level.header.twoPlayer && !this.triggers.visual.options.unlinkDualGravity;
  }

  /**
   * playerWillSwitchMode's dual rule: in a linked dual, a mode portal that
   * gives the player the mode the other player already has first turns it to
   * the other's opposite gravity. It is the player's own flip, so it never
   * turns the other player back. The cube portal counts only when the other
   * player is a cube, and the wave portal never does.
   * [gdp GJBaseGameLayer::playerWillSwitchMode, gd-ida-decomp.cpp:462534-462594]
   */
  private matchDualGravity(p: Player, mode: GameMode): void {
    const other = p === this.p1 ? this.p2 : this.p1;
    if (!other || !this.dualGravityLinked()) return;
    let same: boolean;
    switch (mode) {
      case "cube":
        same = !other.isFlying && !other.isBall && !other.isRobot && !other.isSpider;
        break;
      case "ship":
        same = other.isShip;
        break;
      case "ufo":
        same = other.isUfo;
        break;
      case "ball":
        same = other.isBall;
        break;
      case "robot":
        same = other.isRobot;
        break;
      case "spider":
        same = other.isSpider;
        break;
      case "swing":
        same = other.isSwing;
        break;
      default:
        same = false;
    }
    if (same) p.flipGravity(!other.flipped);
  }

  /**
   * The ground, the dual band and the level's bounds: the part of
   * checkCollisions that runs before any object is looked at, in world
   * coordinates even when gameplay is rotated. Returns whether the pass goes
   * on to the objects.
   *
   * The plain ground is a floor only for a player on normal gravity, and only
   * once it is no longer boosted. Upside down, reaching it is out of bounds —
   * unless the player flipped less than 0.1 s ago, when it is caught on the
   * ground line and the objects are skipped for this pass.
   *
   * The band's edges — for the flying modes, the ball and the spider always,
   * for the cube and robot in a dual — are surfaces, except where a cube or
   * robot meets one head first. That is out of bounds, and the player is left
   * where it is, unless it flipped or changed mode less than 0.2 s ago; then it
   * is put back and stopped, but not grounded. An H block makes the edge an
   * ordinary surface again. A player that was on a slope and is more than half
   * a box past an edge is out too. The pass after a teleport skips the band
   * altogether, so a player that lands past an edge stays there for that pass.
   *
   * Out of bounds kills on the second check in a row, so one tick outside is
   * forgiven. Travelling left is only possible with reversed gameplay; a
   * platformer stops at the line.
   * [gdp GJBaseGameLayer::checkCollisions, gd-ida-decomp.cpp:464676-464882;
   *  destroyFromHitHead :145615-145626, isSafeHeadTest :147910-147912,
   *  pushDown :147929-147938]
   */
  private groundAndBounds(p: Player): boolean {
    // v6: a teleport since the last pass. [:464675-464676]
    const teleported = p.teleported;
    p.teleported = false;
    const wasOut = p.wasOutOfBounds;
    p.wasOutOfBounds = false;
    // v8, v10 and v11: the size the ground measures by, what a smaller player
    // gains on it, and half the size. The ground line is where the centre of a
    // player standing on the ground sits. [:464678-464690]
    const scale = p.vehicleSize();
    const size = p.groundSize();
    const slack = scale === 1 ? 0 : size * (1 - scale) * 0.5;
    const half = size * 0.5;
    // v12, a float in the game's space like the position it is compared with. [:464690]
    const groundLine = floatY(FLOOR_Y + half - slack);
    // v13: the band. [:464691-464702]
    const band = !this.corridorFree && (p.isFlying || p.isBall || p.isSpider || this.dual);
    let out = false;
    if (this.platformer) {
      if (p.x < MIN_GAMEPLAY_X) {
        p.setX(MIN_GAMEPLAY_X);
        p.xVel = 0;
      }
    } else if (p.reversed) {
      out = p.x < MIN_GAMEPLAY_X;
    }
    if (p.y >= groundLine || band) {
      if (p.y > floatY(this.maxGameplayY + slack)) out = true;
    } else if (p.flipped) {
      if (!p.isSafeFlip(POST_FLIP_SNAP_GRACE)) {
        out = true;
      } else {
        // [:464736-464746]
        p.setY(groundLine);
        p.hitGround(-1, true);
        p.onGround2 = false;
        return false;
      }
    } else if (!p.maybeIsBoosted) {
      p.setY(groundLine);
      p.hitGround(-1, false);
      // Each surface here is a floor or ceiling for the squeeze test at the
      // player's own edge, half its box from its centre. [updateCollide
      // :143658-143669, called at :464760, :464798 and :464867]
      p.updateCollideBottom(p.y - p.hitboxSize() * 0.5);
    }
    // [:464763]
    if (band && !teleported) {
      // v25 and v26, floats. [:464773, 464826]
      const ceilingLine = floatY(this.ceilingY - half + slack);
      const floorLine = floatY(this.floorY + half - slack);
      let edgeOut = false;
      if (p.y > ceilingLine) {
        // Head first on the ceiling is a normal-gravity player's. [:464774-464813]
        const head = p.destroyFromHitHead() && !p.flipped;
        if ((p.wasOnSlope && p.y > ceilingLine + half) || (head && !p.isSafeHeadTest())) {
          edgeOut = true;
        } else {
          p.setY(ceilingLine);
          if (head) p.pushDown();
          else if (p.yVel > 0) p.hitGround(-1, !p.flipped);
          const edge = p.y + p.hitboxSize() * 0.5;
          if (p.flipped) p.updateCollideBottom(edge);
          else p.updateCollideTop(edge);
          p.wasOnSlope = false;
        }
      } else if (p.y < floorLine) {
        // And on the floor an upside-down one's; a ship or swing only lands on
        // it moving down. [:464826-464874]
        const head = p.destroyFromHitHead() && p.flipped;
        if ((p.wasOnSlope && p.y < floorLine - half) || (head && !p.isSafeHeadTest())) {
          edgeOut = true;
        } else {
          p.setY(floorLine);
          if (head) p.pushDown();
          else if ((!p.isShip && !p.isSwing) || p.yVel < 0) p.hitGround(-1, p.flipped);
          const edge = p.y - p.hitboxSize() * 0.5;
          if (p.flipped) p.updateCollideTop(edge);
          else p.updateCollideBottom(edge);
          p.wasOnSlope = false;
        }
      }
      if (edgeOut) {
        // [:464815-464824]
        if (wasOut && this.die(p, -1)) return false;
        p.wasOutOfBounds = true;
        return true;
      }
    }
    // [:464877-464882]
    if (wasOut && out && this.die(p, -1)) return false;
    p.wasOutOfBounds = out;
    return true;
  }

  private breakBlock(p: Player, i: number): void {
    const slot = this.objs.slot[i];
    if (slot < 0) return;
    if ((this.objState[slot] & ST_DESTROYED) !== 0) return;
    this.setObjState(slot, this.objState[slot] | ST_DESTROYED);
    this.emit("break", p.playerNo, i);
  }

  private setObjState(slot: number, v: number): void {
    if (this.objStateShared) {
      this.objState = this.objState.slice();
      this.objStateShared = false;
    }
    this.objState[slot] = v;
    this.hashDirty = true;
  }

  /** After a teleport nothing near the old position is being touched any more. */
  private clearTouchBits(p: Player): void {
    const bit = p.playerNo === 1 ? ST_TOUCH_P1 : ST_TOUCH_P2;
    const st = this.objState;
    for (let s = 0; s < st.length; s++) {
      if ((st[s] & bit) !== 0) this.setObjState(s, this.objState[s] & ~bit);
    }
  }

  // ---------------------------------------------------------------------------
  // portals
  // ---------------------------------------------------------------------------

  private applyPortal(p: Player, i: number, first = true): void {
    const o = this.objs;
    const code = o.param[i];
    const flags = o.flags[i];
    if (code >= P_MODE_BASE && code < P_MODE_BASE + 8) {
      const mode = MODE_BY_INDEX[code - P_MODE_BASE];
      // A platformer has no wave or swing: the game passes over those two
      // portals without looking at them. [gdp collisionCheckObjects cases 0x1A
      // and 0x29, gd-ida-decomp.cpp:463733-463740, 463815-463822; +10734 is
      // the platformer flag, loadLevelSettings :430552-430553]
      if (this.platformer && (mode === "wave" || mode === "swing")) return;
      // processCameraObject: the player meets the portal, the mode changed
      // or not. [gdp switchToRollMode :420320-420331 and the other
      //  switches → processCameraObject :420086-420090; the cube's case 6
      //  :463553-463558]
      this.meet(p, i);
      this.matchDualGravity(p, mode);
      if (p.mode !== mode) {
        p.setMode(mode);
        this.modeWaves(p, i, mode);
        // Neither the accelerating flag nor the boost is a portal's to write:
        // a cube falling at 15 arrives in a ship at 7.5 and the ship's first
        // tick holds it to 6.4. [no write to +1858 or +2060 in the toggles
        // 152569-153290 or playerWillSwitchMode 462507-462600]
        // The accumulator is setMode's to write: the robot and spider toggles
        // start it spent, and only a ground jump refills it. Zeroing it here
        // handed a robot portal taken in mid-air a free hold.
      }
      // This portal becomes the anchor, and the band is recomputed from it —
      // unless a dual is running, in which case the dual portal keeps the job.
      // Key 13, which used to pick between the portal's y and the player's, no
      // longer decides anything here: the portal's y is always the anchor now.
      this.modePortal = i;
      this.portalCameraMode(i);
      this.updateCorridor(p, mode);
      this.emit("portal", p.playerNo, i, mode);
      return;
    }
    if (code >= P_SPEED_BASE && code < P_SPEED_BASE + 5) {
      // The portal only queues its speed; step() hands it to both players once
      // the step is done. [gdp EffectGameObject::triggerObject :315460-315481,
      //  updateTimeMod(…, 0, …) stores it :421479-421483]
      const speed = (code - P_SPEED_BASE) as Speed;
      this.pendingSpeed = speed;
      // playShineEffect's circle, the first time the portal fires, unless it
      // has no effects or is hidden: a hidden object is never parented, and
      // the circle wants a parent. Whether it is drawn at all, its opacity,
      // is the renderer's to ask (circleWaves.wavesFor).
      // [EffectGameObject::triggerObject :315460-315482 → GameObject::
      //  playShineEffect :167956-167966 (768 hasBeenActivated, 440 the
      //  opacity, +900, +549 the editor, 248 the parent), :168200-168250;
      //  activateObject :169462-169470 (no parent for +855)]
      if (first && (this.effectBits(i) & (EFFECT_NONE | EFFECT_HIDDEN)) === 0) this.wave("speed", p, i, String(speed));
      this.emit("portal", p.playerNo, i, `speed${speed}`);
      return;
    }
    switch (code) {
      case P_GRAV_NORMAL:
        this.gravityPortal(p, i, false);
        this.emit("portal", p.playerNo, i, "gravityNormal");
        break;
      case P_GRAV_FLIP:
        this.gravityPortal(p, i, true);
        this.emit("portal", p.playerNo, i, "gravityFlip");
        break;
      case P_GRAV_TOGGLE:
        this.gravityPortal(p, i, !p.flipped);
        this.emit("portal", p.playerNo, i, "gravityToggle");
        break;
      case P_MIRROR_ON:
      case P_MIRROR_OFF: {
        // The player meets the portal; the mirrored view is the layer's
        // (+860), so both players take it, whichever touched the portal.
        // toggleFlipped's circle as the view turns, unless the portal has no
        // effects, is player 1's, on what player 1 last met.
        // [gdp collisionCheckObjects cases 0xE and 0xF :463585-463619;
        //  GJBaseGameLayer::toggleFlipped :449092-449130 (+549, player 1)]
        this.meet(p, i);
        const mirrored = code === P_MIRROR_ON;
        const was = this.p1.mirrored;
        this.p1.mirrored = mirrored;
        if (this.p2) this.p2.mirrored = mirrored;
        if (mirrored !== was && (this.effectBits(i) & EFFECT_NONE) === 0) this.portalWave(this.p1, mirrored ? "mirrorOn" : "mirrorOff");
        this.emit("portal", p.playerNo, i, mirrored ? "mirrorOn" : "mirrorOff");
        break;
      }
      case P_SIZE_MINI:
      case P_SIZE_NORMAL: {
        const mini = code === P_SIZE_MINI;
        const was = p.mini;
        this.meet(p, i);
        p.setMini(mini);
        // togglePlayerScale's two circles, as the size changes, unless the
        // portal has no effects. [gdp collisionCheckObjects cases 0x11 and
        //  0x12 :463629-463660; PlayerObject::togglePlayerScale
        //  :150364-150380, :150466-150499]
        if (mini !== was && (this.effectBits(i) & EFFECT_NONE) === 0) {
          this.portalWave(p, mini ? "mini" : "normal");
          this.wave("scale", p, -1, mini ? "mini" : "normal");
        }
        this.emit("portal", p.playerNo, i, mini ? "mini" : "normal");
        break;
      }
      case P_DUAL_ON:
        // [gdp collisionCheckObjects case 0x17 :463691-463709]
        this.meet(p, i);
        if (!this.dual) {
          this.portalCameraMode(i);
          this.enterDual(p, i);
          // A circle on each player, whatever the portal's switches.
          // [gdp GJBaseGameLayer::toggleDualMode :462656-462660]
          this.wave("dual", this.p1, -1, "");
          if (this.p2) this.wave("dual", this.p2, -1, "");
        }
        this.emit("portal", p.playerNo, i, "dual");
        break;
      case P_DUAL_OFF:
        // [gdp collisionCheckObjects case 0x18 :463711-463727]
        this.meet(p, i);
        if (this.dual) {
          this.portalCameraMode(i);
          // The player that did not take the portal leaves with its ring,
          // where it was before player 1 takes player 2's place; then player
          // 1's portal circle, on what player 1 last met, whatever the
          // portal's switches. [gdp GJBaseGameLayer::toggleDualMode
          //  :462671-462682 (the exit effect), :462685-462690 (the circle)]
          const leaver = p === this.p2 ? this.p1 : this.p2;
          if (leaver) this.exitDualWave(leaver);
          this.exitDual(p);
          this.portalWave(this.p1, "solo");
        }
        this.emit("portal", p.playerNo, i, "solo");
        break;
      case P_TP_LINKED_ENTRY:
        this.teleportPlayer(p, i, LINKED_EXIT);
        this.emit("portal", p.playerNo, i, "teleport");
        break;
      case P_TP_TARGET_ENTRY:
        this.teleportPlayer(p, i, this.triggers.portalTarget(o.param2[i]));
        this.emit("portal", p.playerNo, i, "teleport");
        break;
      default:
        break;
    }
  }

  /**
   * The circles a mode portal makes once the mode has changed: each mode's
   * toggle makes one as its mode comes on, unless the portal has no effects
   * — in a dual, the dual portal's switch is the one read, as
   * processCameraObject hands that over instead. The cube has no toggle of
   * its own and makes none; the wave adds a ring to its circle.
   * [gdp GJBaseGameLayer::switchToFlyMode :420198-420240, switchToRobotMode,
   *  switchToSpiderMode and switchToRollMode (+900 of processCameraObject's
   *  answer, :420071-420102); PlayerObject::toggleFlyMode :152870-152874,
   *  toggleBirdMode :152970-152974, toggleDartMode :153049-153078,
   *  toggleRollMode :153153-153157, toggleRobotMode :153258-153262,
   *  toggleSpiderMode :152754-152758, toggleSwingMode :152599-152603]
   */
  private modeWaves(p: Player, portal: number, mode: GameMode): void {
    if (mode === "cube") return;
    const switches = this.dual && this.dualPortal !== null ? this.dualPortal : portal;
    if ((this.effectBits(switches) & EFFECT_NONE) !== 0) return;
    this.portalWave(p, mode);
    if (mode === "wave") this.wave("dart", p, portal, "");
  }

  /**
   * A gravity portal: the player meets it, then the flip, and its circle when
   * the player's gravity really turned, unless the portal has no effects or
   * is hidden. A linked dual's other player turns too, under the same
   * switch, with a circle of its own on whatever that player last met —
   * none when it has met nothing.
   * [gdp collisionCheckObjects cases 3, 4 and 0x2A :463493-463541,
   *  :463825-463848 (+2032 and +2116 the portal; no effects when +900, else
   *  +1106); GJBaseGameLayer::flipGravity :420149-420178 (the other player's
   *  PlayerObject::flipGravity with the same switch); PlayerObject::
   *  flipGravity :151121-151178]
   */
  private gravityPortal(p: Player, portal: number, flipped: boolean): void {
    this.meet(p, portal);
    const was = p.flipped;
    const other = this.flipGravity(p, flipped);
    if (p.flipped === was || (this.effectBits(portal) & (EFFECT_NONE | EFFECT_HIDDEN)) !== 0) return;
    this.portalWave(p, p.flipped ? "gravityUp" : "gravityDown");
    if (other) this.portalWave(other, other.flipped ? "gravityUp" : "gravityDown");
  }

  /**
   * teleportPlayer: a teleport portal, a teleport orb or a Teleport trigger
   * (`from`) moving player `p` to `target` — an object index, LINKED_EXIT for
   * a 747's own exit, or -1 for none. Every call marks the player, and its
   * next collision pass skips the band, a target or not; nothing pulls a
   * player that lands past a band edge back inside.
   *
   * With a target the player goes where the target is now: a 747's exit
   * keeps the player's x and stands key 54 over the portal, unrotated, so
   * how high up the portal the player met it is dropped; anything else is
   * the target object's own position. Key 351 keeps the player's offset from
   * `from`, x included, and keys 352 and 353 keep its x or its y. Each step
   * is a float in the game's space, a world move whichever frame the pass
   * has the player in. Then key 354 sets the gravity (1 normal, 2 flipped,
   * 3 the other way) on this player alone, and key 345 hands it a push of
   * key 346 along the way the exit faces; with no key 346 and no key 443
   * that push is a stop. Key 347 redirects the player's force in place of
   * that push; the redirect (347-350) and the dash redirect (591) are not
   * built, and no official level uses them.
   *
   * Then the camera. Key 55 slows its y follow for half a second, and key
   * 464 snaps both its axes on its next step; both act with a target or
   * without. Key 510 makes where the player now is its last landing, which
   * the camera's hold on the floor reads. With a target the camera checks
   * where the player landed (checkCameraAfterTeleport), with a margin of 180
   * under key 55 and 60 otherwise.
   * [gdp GJBaseGameLayer::teleportPlayer, gd-ida-decomp.cpp:462274-462491:
   *  +1168 :462315, the offset :462316-462323, the position :462327-462349,
   *  354 :462351-462374, the facing :462388-462416 and :462450-462455,
   *  key 55 :462457-462464, playerTeleported :462465-462466, 347 or else
   *  345 :462467-462474, key 464 :462476-462479, key 510 :462480-462485,
   *  the check :462488-462489; getPortalTargetPos :419427-419436; the linked
   *  exit, built by PlayLayer::addObject :89924-89955 with the portal's
   *  rotation and the opposite flip; TeleportPortalObject::customObjectSetup
   *  :303108-303187 (55 at +1652, 464 at +1685, 510 at +1686)]
   */
  private teleportPlayer(p: Player, from: number, target: number): void {
    const props = this.level.objects[from].props;
    const on = (key: number): boolean => (parseInt(props[key] ?? "0", 10) || 0) !== 0;
    p.teleported = true;
    const g = GAME_GROUND_Y;
    const [fromX, fromY] = this.triggers.objectPosition(from);
    let facing: number;
    if (target !== -1) {
      let x: number;
      let y: number;
      if (target === LINKED_EXIT) {
        x = p.worldX;
        y = Math.fround(Math.fround(fromY + g) + this.objs.param2[from]);
      } else {
        const [tx, ty] = this.triggers.objectPosition(target);
        x = Math.fround(tx);
        y = Math.fround(ty + g);
      }
      if (on(351)) {
        x = Math.fround(x - Math.fround(Math.fround(fromX) - p.worldX));
        y = Math.fround(y - Math.fround(Math.fround(fromY + g) - (p.worldY + g)));
      }
      if (on(352)) x = p.worldX;
      if (on(353)) y = Math.fround(p.worldY + g);
      p.setWorldPosition(x, y - g);
      facing = target === LINKED_EXIT ? this.exitFacing(from, 749, true) : this.exitFacing(target, this.level.objects[target].id, false);
    } else {
      facing = Math.fround((this.level.objects[from].flipX ? 180 : 0) - this.rotationNow(from));
    }
    switch (parseInt(props[354] ?? "0", 10) || 0) {
      case 1:
        p.flipGravity(false);
        break;
      case 2:
        p.flipGravity(true);
        break;
      case 3:
        p.flipGravity(!p.flipped);
        break;
      default:
        break;
    }
    // When there was somewhere to go, the player meets the object that sent
    // it — a portal, an orb or a Teleport trigger alike — and then where it
    // went, with a circle at each, unless the sender has no effects.
    // [gdp GJBaseGameLayer::teleportPlayer :462330-462333 (the sender),
    //  :462376-462426 (the circles, the exit met at :462419-462420)]
    if (target !== -1) {
      const effects = (this.effectBits(from) & EFFECT_NONE) === 0;
      this.meet(p, from);
      if (effects) this.portalWave(p, "teleportIn");
      if (target === LINKED_EXIT) this.meet(p, from, true);
      else this.meet(p, target);
      if (effects) this.portalWave(p, "teleportOut");
    }
    if (target !== -1) this.afterTeleport(p);
    if (!on(347) && on(345)) p.updateStaticForce(facing, Math.fround(Number(props[346] ?? 0) || 0), on(443));
    const cam = this.triggers.camera;
    if (on(55)) cam.slowYSeq++;
    if (on(464)) cam.snapSeq++;
    if (on(510)) p.lastGroundY = p.worldY;
    if (target !== -1) this.checkCameraAfterTeleport(p, on(55) ? TELEPORT_CAMERA_MARGIN_SLOW : TELEPORT_CAMERA_MARGIN);
  }

  /**
   * checkCameraLimitAfterTeleport: after a teleport to a target or a
   * spider's jump, the camera snaps to player `p` when it landed more than
   * `margin` above the view's top or under its bottom. Not while a Static
   * Camera holds y, nor for a player whose gameplay is rotated. The test
   * against the view is the camera's (render/camera.ts follow), which has it.
   * [gdp GJBaseGameLayer::checkCameraLimitAfterTeleport,
   *  gd-ida-decomp.cpp:450837-450857 (float 119 the static y)]
   */
  private checkCameraAfterTeleport(p: Player, margin: number): void {
    const cam = this.triggers.camera;
    if (cam.staticY.on || p.rotated) return;
    cam.teleportCheckSeq++;
    cam.teleportCheckY = p.worldY;
    cam.teleportCheckMargin = margin;
  }

  /**
   * After a move: the player is off the ground for the rotation's sake
   * (playerTeleported). Where its update began (lastPosition, +1052) is left
   * alone, so the solids it lands among are met as crossed from there: a
   * player sent into a block's underside snaps onto it rather than dying.
   * Only the update, a death, a checkpoint and a reset write lastPosition.
   * [gdp PlayerObject::playerTeleported, gd-ida-decomp.cpp:148807-148812;
   *  lastPosition's writers :149950, :161026, :161650, :170023]
   */
  private afterTeleport(p: Player): void {
    p.onGround2 = false;
    p.lastGroundY = Number.NaN;
    this.clearTouchBits(p);
  }

  /**
   * The way a teleport's exit faces, in degrees: 180 less the exit's angle
   * for a teleport exit or portal (749, 2064, 38, 747, 2902), 90 less it for
   * anything else, half a turn more when the exit is flipped. A 747's exit is
   * its own 749, turned with the portal and flipped the other way.
   * [gdp GJBaseGameLayer::teleportPlayer :462388-462416]
   */
  private exitFacing(i: number, id: number, flipOpposite: boolean): number {
    const o = this.level.objects[i];
    const flip = flipOpposite ? !o.flipX : o.flipX;
    const base = TELEPORT_EXIT_FACING_IDS.has(id) ? 180 : 90;
    return Math.fround(Math.fround(base - this.rotationNow(i)) + (flip ? 180 : 0));
  }

  /** Object `i`'s angle now: its own plus what rotate triggers have turned it by. */
  private rotationNow(i: number): number {
    const m = this.m6;
    this.triggers.objectTransform(i, m);
    return this.level.objects[i].rotation + m[6];
  }

  /**
   * `portal` is the dual portal itself, which becomes the corridor's anchor for
   * the whole section and outranks any mode portal crossed inside it. Entering
   * a dual also gives every mode a band, including the cube's and the robot's,
   * because the game's "270 means no corridor" rule is switched off while dual.
   * [gdp GJBaseGameLayer::toggleDualMode :462662-462665 (the anchor) then
   *  playerWillSwitchMode → updateDualGround :451167-451171 (the band)]
   */
  private enterDual(p: Player, portal: number | null): void {
    // Player 2's reset forgets what it last met. [toggleDualMode :462652]
    this.lastMet[1] = -1;
    this.lastMetExit[1] = 0;
    this.dual = true;
    this.dualPortal = portal;
    if (portal !== null) this.modePortal = portal;
    this.p2 = this.spawnPlayer2();
    this.updateCorridor(p, p.mode);
    this.hashDirty = true;
  }

  /**
   * Player 2 for a new dual. The game resets its player 2 first, so nothing of
   * an earlier dual survives — which is why a fresh Player is right here — and
   * then spawnFromPlayer gives it player 1's attributes (Player.copyAttributes)
   * and, unless an Options trigger has unlinked dual gravity, the opposite
   * gravity and the opposite vertical velocity; either way it starts off the
   * ground, upright, and in unrotated gameplay. In a two-player level its button
   * starts up, and one already held stays up until it is let go and pressed
   * again: outside a dual the game drops player 2's presses, and the spawn
   * only releases. It first moves in the next step.
   * [gdp GJBaseGameLayer::toggleDualMode :462652 (vtable +636 — resetObject,
   *  :153559-153680, the same slot resetPlayer calls on both players at
   *  :425070-425075), :462653-462655 (the two-player release);
   *  handleButton :463900-463960 (no dual: player 2's events go nowhere);
   *  spawnPlayer2 :420882-420897; PlayerObject::spawnFromPlayer :153349-153373]
   */
  private spawnPlayer2(): Player {
    const p1 = this.p1;
    const p2 = new Player(this, 2);
    // The reset arms a platformer's grown-back snap, and taking player 1's
    // size after it never grows player 2, so the snap stays armed.
    // [resetObject :153659-153660 → togglePlayerScale :150416-150418;
    //  copyAttributes :153326]
    if (this.platformer) p2.scaleSnapPasses = SCALE_SNAP_PASSES;
    p2.copyAttributes(p1);
    // A dual portal taken in a rotated pass finds player 1 in its own frame.
    if (this.inLocalFrame) swapPlayerAxes(p2);
    p2.mirrored = p1.mirrored;
    p2.rawHeld = p1.rawHeld;
    p2.holdTicks = p1.holdTicks;
    const linked = !this.triggers.visual.options.unlinkDualGravity;
    p2.flipGravity(linked ? !p1.flipped : p1.flipped);
    p2.setYVelocity(linked ? -p1.yVel : p1.yVel);
    p2.onGround = false;
    p2.onGround2 = false;
    if (this.level.header.twoPlayer) {
      p2.releaseButton();
      p2.rawHeld = this.rawJump2;
      p2.holdTicks = -1;
    }
    return p2;
  }

  /**
   * Leaving drops the dual anchor and recomputes the band from player 1's mode
   * under the solo rule, which is how a cube or robot gets its open ceiling
   * back. [gdp GJBaseGameLayer::toggleDualMode :462693-462697]
   */
  private exitDual(p: Player): void {
    // When player 2 is the one to reach the solo portal, player 1 takes its
    // place — where it is, its gravity, its mode — and play goes on from there.
    // [gdp GJBaseGameLayer::toggleDualMode :462667-462676]
    if (p === this.p2) {
      this.p1.copyAttributes(p);
      // Player 2's rotated pass has player 2 in its own frame, not player 1.
      if (this.inLocalFrame) swapPlayerAxes(this.p1);
    }
    this.dual = false;
    this.dualPortal = null;
    this.p2 = null;
    this.updateCorridor(p, this.p1.mode);
    this.hashDirty = true;
  }

  // ---------------------------------------------------------------------------
  // pads and orbs
  // ---------------------------------------------------------------------------

  /**
   * Which way a pad or orb points along the player's gravity axis: down, or
   * left when gameplay is rotated. The world's own rotation and flip are what
   * count, never the mirror's, and the rotation is the unwrapped one.
   * [gd-ida-decomp.cpp:463231-463234 (blue pad), :157056-157059 (spider pad),
   * :160080-160082 (spider orb)]
   */
  private facingDown(p: Player, i: number): boolean {
    const o = this.objs;
    const flipY = (o.flags[i] & F_FLIP_Y) !== 0;
    return p.rotated ? isFacingLeft(o.rawRot[i], flipY) : isFacingDown(o.rawRot[i], flipY);
  }

  /**
   * reversePlayer, for a pad or orb carrying key 117: through doReversePlayer,
   * so a ball rolls afresh the other way before the launch replaces the roll.
   * A platformer keeps its own facing. With kA42 "Reverse Sync" the player
   * also owes twice the gap from it (what it still owes counted) to the
   * object's point, where a group has carried it, along its way, which the
   * next steps pay off (Player.reverseOffset). The sums are the game's floats,
   * in its space.
   * [gdp PlayerObject::reversePlayer, gd-ida-decomp.cpp:148361-148392 (the
   *  gap :148376-148389, from the object's getRealPosition, vtable +672, the
   *  slot resetLevel compares around resetObject :105842-105885)]
   */
  private reverseFrom(p: Player, i: number): void {
    if ((this.objs.flags[i] & F_REVERSE) === 0 || this.platformer) return;
    if (this.level.header.reverseSync) {
      const [ox, oy] = this.triggers.objectPosition(i);
      const owed = Math.fround(p.reverseOffset);
      const gap = p.rotated
        ? Math.fround(Math.fround(oy + GAME_GROUND_Y) - Math.fround(Math.fround(p.worldY + GAME_GROUND_Y) + owed))
        : Math.fround(Math.fround(ox) - Math.fround(p.worldX + owed));
      p.reverseOffset += Math.fround(gap + gap);
    }
    p.doReversePlayer(!p.reversed);
  }

  /**
   * The spider pad and orb: face the way the object points, then jump against
   * that gravity. Both flips are the player's own, so a dual partner never
   * follows them. [gdp PlayerObject::bumpPlayer :157055-157064;
   * PlayerObject::ringJump :160079-160087]
   */
  private spiderBump(p: Player, i: number): void {
    const down = this.facingDown(p, i);
    if (p.flipped !== down) p.flipGravity(down);
    this.spiderTeleport(p);
  }

  /**
   * A pad the player may use. Yellow, pink, red and spider pads are
   * bumpPlayer's; the blue pad is gravBumpPlayer's, which works out the
   * gravity the pad sets from the way it faces and does nothing at all — no
   * launch, no flip, no reverse, and the pad stays unused — when the player
   * already has it. Returns whether the pad was used, which is what spends it.
   * [gdp GJBaseGameLayer::bumpPlayer :463168-463205, gravBumpPlayer
   *  :463221-463262, PlayerObject::bumpPlayer :157048-157090]
   */
  private applyPad(p: Player, i: number): boolean {
    const type = PAD_TYPES[this.objs.param[i]];
    const target = type === "blue" ? !this.facingDown(p, i) : false;
    if (type === "blue" && p.flipped === target) return false;
    // The player meets the pad. [gdp bumpPlayer :463186-463193,
    //  gravBumpPlayer :463249-463252]
    this.meet(p, i);
    this.reverseFrom(p, i);
    switch (type) {
      case "blue":
        // Launches, then flips, so the flip halves the launch: 12.8 lands as
        // 6.4. Neither half touches the held jump or the accelerating flag.
        p.propellPlayer(PAD_BLUE_BUMP);
        this.flipGravity(p, target);
        p.padRingRelated = true; // +1600 [463255]
        break;
      case "spider":
        if (this.padsEndRobotHold) p.robotHoldEnded = true;
        this.spiderBump(p, i);
        break;
      default:
        // Only kA34 or a platformer lets a pad end the robot's held jump; in
        // the older levels a robot still holding keeps floating at the pad's
        // speed for the rest of its window. The accumulator is left alone.
        if (this.padsEndRobotHold) p.robotHoldEnded = true;
        p.propellPlayer(getBumpMod(p, type));
        // The red pad lets a flying player past its caps; yellow and pink
        // take that away, so the next tick holds it to them — the yellow
        // pad's 16, then 8. The red pad also forgets where the player was
        // launched from, which only the camera reads. [157077-157085]
        p.isAccelerating = type === "red";
        if (type === "red") p.lastGroundY = Number.NaN;
    }
    // playBumpEffect, unless the pad has no effects; a spider pad's always
    // plays. [gdp PlayerObject::propellPlayer :147695-147696 (its a3 the
    //  pad's +900, handed down by bumpPlayer :157067 and gravBumpPlayer
    //  :463251-463253); bumpPlayer's spider pad :157055-157064]
    if (type === "spider" || (this.effectBits(i) & EFFECT_NONE) === 0) this.wave("bump", p, i, type);
    this.emit("pad", p.playerNo, i, type);
    return true;
  }

  /**
   * playerTouchedRing: every ring the pass touches joins the list a press
   * reads; the pass itself fires one only for a player that is not flying,
   * and never a claim-touch ring. [gdp GJBaseGameLayer::playerTouchedRing,
   * gd-ida-decomp.cpp:463276-463292]
   */
  private playerTouchedRing(p: Player, i: number): void {
    p.addToTouchedRings(i);
    // powerOnObject: a ring that was not powered makes its circle, unless it
    // has no effects or is the toggle block. [RingObject::powerOnObject
    //  :306767-306787 → spawnCircle :306710-306750]
    if (!this.ringPower.has(i) && (this.effectBits(i) & EFFECT_NONE) === 0 && this.level.objects[i].id !== TOGGLE_BLOCK_ID) {
      this.wave("ringPower", p, i, "");
    }
    this.ringPower.set(i, this.tick);
    if (!p.isFlying && (this.objs.flags[i] & F_CLAIM_TOUCH) === 0) this.ringJump(p, i);
  }

  /**
   * ringJump's guard and bookkeeping, around the body in applyOrb. A ring
   * needs a press nothing has spent (+1914) with the button still down
   * (+1913), both as updateJumpVariables last saw them — not merely a held
   * button, so holding through a second orb, or through the jump that got
   * the player up there, does nothing — a player that is not dashing, a free
   * slot in the ring's family, and not to have fired for this press already.
   * Once it fires it leaves the touching list, joins the press's used set
   * and, unless multi-activate, is spent for this player.
   * [gdp PlayerObject::ringJump, gd-ida-decomp.cpp:159894-159961]
   */
  private ringJump(p: Player, i: number): void {
    if (p.dead || p.usedRings.includes(i)) return;
    if (!p.canRingJump || !p.holdingForOrb || p.dashing) return;
    const o = this.objs;
    const type = ORB_TYPES[o.param[i]];
    if (type === "toggle" ? p.touchedCustomRing : type === "teleport" ? p.touchedTeleportRing : p.touchedRing) return;
    p.usedRings.push(i);
    p.dropTouchedRing(i);
    // hasBeenActivated, by either player, which the ring's circle asks; a
    // multi-activate ring is never marked. [EffectGameObject::triggerActivated
    //  :298093-298101]
    const taken = (o.flags[i] & F_MULTI) === 0 && (this.objState[o.slot[i]] & (ST_ACT_P1 | ST_ACT_P2)) !== 0;
    if ((o.flags[i] & F_MULTI) === 0) {
      const slot = o.slot[i];
      this.setObjState(slot, this.objState[slot] | (p.playerNo === 1 ? ST_ACT_P1 : ST_ACT_P2));
    }
    this.applyOrb(p, i);
    // Its circle, unless the ring was taken before, has no effects or is the
    // toggle block; then it powers off. [PlayerObject::ringJump :159948-159955
    //  (the gates; 768 is hasBeenActivated), :160027-160050 (the circle),
    //  LABEL_153 :159956-159960 (vtable 908)]
    if (!taken && (this.effectBits(i) & EFFECT_NONE) === 0 && this.level.objects[i].id !== TOGGLE_BLOCK_ID) this.wave("ring", p, i, type);
    this.ringPower.delete(i);
  }

  /**
   * The body of ringJump, once the guard has let the orb through. Each type
   * spends the press, the boost and the ground flags as the game does and no
   * more: the spider and dash orbs leave the press alone, the toggle orb
   * spends it only in some levels, and the black orb leaves the boost and the
   * ground. None of them touches the robot's held jump — neither half of it —
   * so an orb taken in the air is a plain velocity set, and holding through
   * one adds no height.
   * [gdp PlayerObject::ringJump, gd-ida-decomp.cpp:159830-160385]
   */
  private applyOrb(p: Player, i: number): void {
    const o = this.objs;
    const type = ORB_TYPES[o.param[i]];
    this.reverseFrom(p, i);
    switch (type) {
      case "yellow":
      case "pink":
      case "red":
        p.ringLaunch(type);
        break;
      case "green":
        // Flips first, so the launch reads the new gravity and nothing halves it. [160225-160262]
        this.flipGravity(p, !p.flipped);
        p.ringLaunch(type);
        break;
      case "blue":
        // Launches first and flips after, so the flip halves the launch. [160262, 160289-160322]
        p.ringLaunch(type);
        this.flipGravity(p, !p.flipped);
        break;
      case "black":
        p.dropRingLaunch();
        break;
      case "spider":
        this.spiderBump(p, i);
        break;
      case "dash":
      case "dashGravity":
        // The flip comes first, then the dash sets the velocity it runs at.
        // Neither touches the press. [160089-160139]
        if (type === "dashGravity") this.flipGravity(p, !p.flipped);
        this.startDash(p, i);
        break;
      case "teleport":
        p.stateRingJump = false; // [160076]
        this.teleportPlayer(p, i, this.triggers.portalTarget(o.param2[i]));
        break;
      default:
        // Toggle orb: it hands its group to the trigger system, then spends
        // the press only where +2497 is set. [159943-159946]
        this.triggers.customRingActivated(i);
        if (this.toggleOrbSpendsPress) p.stateRingJump = false;
        break;
    }
    // +1600, the pad-or-ring flag a J block reads, is for the normal rings only. [159941-159942]
    if (type !== "toggle" && type !== "teleport") p.padRingRelated = true;
    if (type === "toggle") p.touchedCustomRing = true;
    else if (type === "teleport") p.touchedTeleportRing = true;
    else p.touchedRing = true;
    this.emit("orb", p.playerNo, i, type);
  }

  /**
   * startDashing. It leaves the ground flags, the boost and the accelerating
   * flag alone, forgets the landing time, and draws the player along the
   * dash. A classic dash and a platformer one read the orb differently: see
   * classicDash and platformerDash.
   * [gdp PlayerObject::startDashing, gd-ida-decomp.cpp:148581-148697]
   */
  private startDash(p: Player, i: number): void {
    p.dashing = true;
    p.dashClock = p.clock;
    p.lastLandTick = -1e9;
    p.stopRotation();
    p.dashOrbIdx = i;
    if (this.platformer) this.platformerDash(p, i);
    else this.classicDash(p, i);
    p.updateDashArt();
    this.emit("dashStart", p.playerNo, i);
  }

  /**
   * A classic dash runs along the orb's placed angle, negated to count
   * counter-clockwise (+828, which a rotate trigger's turn does not touch),
   * as a slope on the forward step. Flat, or in rotated gameplay whatever
   * the angle, it runs straight. Otherwise a raw clamp holds it to 70° either
   * way — an angle past 70 but short of 180 dashes up at 70, from 180 on down
   * at 70, and the mirror of that below −70 — and the slope is tanf of what
   * is left, except at exactly 45, which takes 1 / tanf. The angle kept is
   * the clamped one.
   * [gdp PlayerObject::startDashing, gd-ida-decomp.cpp:148639-148690]
   */
  private classicDash(p: Player, i: number): void {
    // A float, negated. [:148639]
    let angle = -Math.fround(this.baseObjs.rawRot[i]);
    let slope = 0;
    if (angle !== 0 && !p.rotated) {
      if (angle > DASH_MAX_ANGLE) angle = angle < 180 ? DASH_MAX_ANGLE : -DASH_MAX_ANGLE;
      else if (angle < -DASH_MAX_ANGLE) angle = angle > -180 ? -DASH_MAX_ANGLE : DASH_MAX_ANGLE;
      const tan = Math.fround(Math.tan(Math.fround(angle * DASH_DEG)));
      slope = angle === 45 ? Math.fround(1 / tan) : tan;
    }
    p.dashVelY = slope;
    p.dashAngle = angle;
  }

  /**
   * A platformer dash moves at its own velocity, the orb's speed (key 586)
   * times 5.77 along the way it points: its angle as it is now, turned half
   * round by flipX, cut to whole degrees and wrapped into 0..359, then
   * negated, which is the angle kept. The pair goes over as floats, traded in
   * rotated gameplay, and faces the player the way its x half goes. The orb's
   * end boost, stop slide, allow collide and longest time go with it.
   * The game turns it half round again for a skewed orb (rotation x and y
   * more than 179 apart), which this port has no data for.
   * [gdp PlayerObject::startDashing, gd-ida-decomp.cpp:148598-148636; the
   *  flipX getter is vfunc +704, beside the flipY one at +708]
   */
  private platformerDash(p: Player, i: number): void {
    const o = this.objs;
    p.dashStartTick = p.clock; // +1208 = +2144
    let rot = Math.fround(o.rawRot[i]);
    if (this.level.objects[i].flipX) rot = Math.fround(rot + 180);
    const whole = Math.trunc(rot) % 360;
    // An int's negation: 0, never −0. [:148607]
    const angle = -(whole < 0 ? whole + 360 : whole) || 0;
    // ccpForAngle, then the point times the float speed. [:148608-148609]
    const rad = Math.fround(angle * DASH_DEG);
    const speed = Math.fround(o.dashSpeed[i] * PLATFORMER_DASH_SPEED);
    let vx = Math.fround(Math.fround(Math.cos(rad)) * speed);
    let vy = Math.fround(Math.fround(Math.sin(rad)) * speed);
    if (p.rotated) {
      const t = vx;
      vx = vy;
      vy = t;
    }
    p.dashVelX = vx;
    p.dashVelY = vy;
    p.dashAngle = angle;
    p.dashEndBoost = o.dashEndBoost[i];
    p.dashMaxDuration = o.dashMaxDuration[i];
    p.dashStopSlide = (o.flags[i] & F_DASH_STOP_SLIDE) !== 0;
    p.dashAllowCollide = (o.flags[i] & F_DASH_ALLOW_COLLIDE) !== 0;
    // Faced the way it goes; a straight up or down dash keeps the facing. [:148621-148636]
    if (vx !== 0) p.doReversePlayer(p.rotated !== vx < 0);
  }

  /**
   * The spider's jump: to the nearest surface against its gravity, which then
   * turns toward it.
   *
   * With gameplay rotated that axis is x, so the search runs in the player's
   * own frame against the mirrored level, exactly as collision does. A press
   * arrives in the world's frame; a spider pad or orb arrives mid-collision,
   * already in the player's — so this only swaps when it is not there yet.
   */
  private spiderTeleport(p: Player): void {
    if (p.rotated && !this.inLocalFrame) {
      this.enterLocalFrame(p, this.reflectedSet());
      this.spiderTeleportHere(p, false);
      this.leaveLocalFrame(p);
      return;
    }
    this.spiderTeleportHere(p, false);
  }

  /**
   * spiderTestJumpInternal, in the player's frame: up the gravity axis on
   * normal gravity, down when flipped.
   *
   * Surfaces — solids, breakable blocks, slopes, passable blocks included — are
   * looked for in a strip from the player's centre to one unit past its
   * leading edge (in a platformer, its own width less a unit each side),
   * reaching from two units inside its head (its feet, flipped) to the band's
   * far edge, or 3,000 units off where there is no band and for a cube or
   * robot, whose reach no band limits. Hazards are looked
   * for in a strip 8 units wide (4.8 mini) down the middle. The nearest
   * surface wins, as the game sorts them — by the near edge, in tenths of a
   * unit — as long as the landing is no more than 10 units behind the
   * player's centre. A block that starts ahead of the centre (behind it,
   * reversed) only counts if the player, set down against it, would not be
   * inside another; in a platformer that test is for a slope's own face
   * instead. With no surface the player goes to the far end.
   *
   * A hazard nearer than the landing sends the search round again with the
   * player's own box plus 4 units on its right, and the second time lands the
   * player on the hazard, for the collision pass to kill; so does a hazard with
   * no surface anywhere. The wider box is used from the start when the strip
   * finds hazards but no surface.
   *
   * The reversed strip is not the forward one mirrored: the game measures it
   * back from the box's left edge rather than its centre, so it runs from a
   * whole box width plus one behind the centre to half a width behind.
   *
   * Only the position, the gravity (turned, and then one unit a tick toward
   * the new floor), the button (let go) and the spider's flip time are
   * written. The latch goes with the flip, so the spider is in the air until
   * the next pass lands it, and its next press waits for that.
   * [gdp PlayerObject::spiderTestJumpInternal, gd-ida-decomp.cpp:154650-155238
   *  (the reversed strip :154881-154903); boxCompMin/Max/MinX/MaxX :140272-140368;
   *  staticObjectsInRect :419454-419604, damagingObjectsInRect :419865-420056]
   */
  private spiderTeleportHere(p: Player, wide: boolean): void {
    if (p.dead) return;
    const o = this.collSet;
    const up = !p.flipped;
    const half = p.hitboxSize() * 0.5;
    const left = p.x - half;
    const right = p.x + half;
    // v7 and v8: how far it looks. Rotated, through a free-mode portal, or
    // for a cube or robot that a spider pad or orb has taken — even one in a
    // dual's band — 3,000 units either way but never below the ground (x 0,
    // rotated); otherwise the band. The same test (v70) has the camera check
    // the landing. [:154751-154778; isInBasicMode :145589-145598]
    const basic = !p.isFlying && !p.isBall && !p.isSpider;
    const far = p.rotated || this.corridorFree || basic || this.ceilingY === OPEN_CEILING;
    let lo: number;
    let hi: number;
    if (far) {
      lo = Math.max(FLOOR_Y, p.y - SPIDER_SEARCH_RANGE);
      hi = p.y + SPIDER_SEARCH_RANGE;
    } else {
      lo = this.floorY;
      hi = this.ceilingY;
    }
    // Along the gravity axis, from two units inside the leading face. [:154779-154813]
    const g0 = up ? p.y + half - 2 : lo;
    const g1 = up ? hi : p.y - half + 2;
    // Across it, the strip. [:154855-154903]
    let sx0: number;
    let sx1: number;
    if (this.platformer) {
      sx0 = left + 1;
      sx1 = right - 1;
    } else if (p.reversed) {
      sx0 = left - half - 1;
      sx1 = left;
    } else {
      sx0 = p.x;
      sx1 = right + 1;
    }
    const hazardHalf = SPIDER_HAZARD_STRIP * p.vehicleSize() * 0.5;
    const statics = this.spiderStatics;
    const hazards = this.spiderHazards;
    let ns = this.spiderStaticsIn(o, sx0, g0, sx1, g1);
    const nh = this.spiderHazardsIn(o, p.x - hazardHalf, g0, p.x + hazardHalf, g1);
    if ((ns === 0 && nh > 0) || wide) {
      // [:154929-154934]
      wide = true;
      ns = this.spiderStaticsIn(o, left, g0, right + SPIDER_RETRY_WIDEN, g1);
    }
    this.sortSpider(o, statics, ns, up);
    this.sortSpider(o, hazards, nh, up);

    let land = NaN;
    let landObj = -1;
    let onHazard = false;
    // v32: a slope face the player would not fit against, kept in case
    // nothing better turns up. [:155081-155100]
    let fallback = NaN;
    if (ns === 0) {
      if (nh > 0) {
        // [:154942-154953]
        landObj = hazards[0];
        land = this.gravityPosition(landObj);
        onHazard = true;
      }
    } else {
      for (let k = 0; k < ns; k++) {
        const i = statics[k];
        let at = up ? o.y0[i] - half : o.y1[i] + half;
        // A slope met on its sloped side: the face under or over the
        // player's centre. [:155004-155031]
        const face = o.kind[i] === K_SLOPE && p.flipped !== ((o.flags[i] & F_SOLID_ABOVE) !== 0);
        if (face) at = o.slopeYPos(i, p.x) - p.flipMod() * half;
        if (up ? at < p.y - SPIDER_BEHIND_SLACK : at > p.y + SPIDER_BEHIND_SLACK) continue;
        // [:155047-155142]
        const check = this.platformer ? face : p.reversed ? o.x1[i] < p.x : o.x0[i] > p.x;
        if (check && this.spiderBlocked(o, statics, ns, k, at, left, right, half, face)) {
          if (face) fallback = Number.isNaN(fallback) ? at : up ? Math.min(at, fallback) : Math.max(at, fallback);
          continue;
        }
        land = at;
        landObj = i;
        break;
      }
    }
    // [:155145-155170]
    if (this.platformer && !Number.isNaN(fallback)) {
      land = Number.isNaN(land) ? fallback : up ? Math.min(land, fallback) : Math.max(land, fallback);
    } else if (Number.isNaN(land)) {
      land = up ? hi - half : lo + half;
    }
    // A hazard on the way. [:155171-155200]
    if (!onHazard && nh > 0) {
      const at = this.gravityPosition(hazards[0]);
      if (up ? at < land : at > land) {
        if (!wide) {
          this.spiderTeleportHere(p, true);
          return;
        }
        land = at;
        landObj = hazards[0];
      }
    }

    // [:155201-155222]
    const fromX = p.worldX;
    const fromY = p.worldY;
    p.setY(land);
    p.flipGravity(up);
    p.setYVelocity(-p.flipMod());
    // The game lets go of the button here and writes nothing else of the
    // player's: the press and the boost stay as they were, which is why the
    // spider pad and orb leave the press alone. With the button let go, the
    // spider's own jump cannot fire again until the next press.
    p.holding = false;
    p.lastSpiderFlipTick = p.clock;
    p.stopRotation();
    // +2132 takes the new position, so the next pass sees no motion across the
    // jump. [:155217-155220]
    p.lastY = p.y;
    // playSpiderDashEffect, from where the jump began to where it landed. [:155221-155224]
    this.wave("spiderDash", p, -1, p.reversed ? "reversed" : "", fromX, fromY, p.worldX, p.worldY);
    this.emit("jump", p.playerNo, landObj >= 0 ? landObj : undefined, "spider");
    // A jump that looked past the band has the camera check where it landed,
    // as a teleport does; inside a band the camera already shows it.
    // [:155225-155230]
    if (far) this.checkCameraAfterTeleport(p, TELEPORT_CAMERA_MARGIN);
  }

  /** staticObjectsInRect: the solids and slopes whose box meets the rect, into spiderStatics. */
  private spiderStaticsIn(o: ObjectSet, x0: number, y0: number, x1: number, y1: number): number {
    const out = this.spiderStatics;
    let n = o.hash.query(x0, y0, x1, y1, out, this.stamp, ++this.stampId);
    if (this.triggers.hasMotion) n = this.addMovedCandidates(o, out, n, x0, y0, x1, y1);
    let m = 0;
    for (let k = 0; k < n; k++) {
      const i = out[k];
      const kind = o.kind[i];
      if (kind !== K_SOLID && kind !== K_SLOPE) continue;
      const slot = o.slot[i];
      if (slot >= 0 && (this.objState[slot] & ST_DESTROYED) !== 0) continue;
      if (this.triggers.hasToggles && this.triggers.objectDisabled(i)) continue;
      if (!rectsTouch(x0, y0, x1, y1, o.x0[i], o.y0[i], o.x1[i], o.y1[i])) continue;
      out[m++] = i;
    }
    return m;
  }

  /**
   * damagingObjectsInRect: the hazards that meet the rect, into spiderHazards
   * — an oriented one by its own box, a round one by the exact test.
   */
  private spiderHazardsIn(o: ObjectSet, x0: number, y0: number, x1: number, y1: number): number {
    const out = this.spiderHazards;
    let n = o.hash.query(x0, y0, x1, y1, out, this.stamp, ++this.stampId);
    if (this.triggers.hasMotion) n = this.addMovedCandidates(o, out, n, x0, y0, x1, y1);
    let m = 0;
    for (let k = 0; k < n; k++) {
      const i = out[k];
      if (o.kind[i] !== K_HAZARD) continue;
      if (this.triggers.hasToggles && this.triggers.objectDisabled(i)) continue;
      let hit: boolean;
      switch (o.shape[i]) {
        case S_OBB:
          hit = rectHitsObb(x0, y0, x1, y1, o.cx[i], o.cy[i], o.hw[i], o.hh[i], o.cosR[i], o.sinR[i]);
          break;
        case S_CIRCLE:
          hit = rectHitsCircle(x0, y0, x1, y1, o.cx[i], o.cy[i], o.hw[i]);
          break;
        default:
          hit = rectsTouch(x0, y0, x1, y1, o.x0[i], o.y0[i], o.x1[i], o.y1[i]);
      }
      if (hit) out[m++] = i;
    }
    return m;
  }

  /**
   * The game's qsort with boxCompMin going up and boxCompMax going down: by
   * the near edge in whole tenths of a unit, measured where the game measures
   * (level y + 90, or x when rotated). Ties keep the order the section walk
   * found them in.
   */
  private sortSpider(o: ObjectSet, list: Int32Array, n: number, up: boolean): void {
    const keys = this.spiderKeys;
    const order = this.spiderOrder;
    const off = this.inLocalFrame ? 0 : GAME_GROUND_Y;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      keys[k] = up ? Math.trunc((o.y0[i] + off) * 10) : -Math.trunc((o.y1[i] + off) * 10);
      order[k] = this.collectionKey(i);
    }
    for (let a = 1; a < n; a++) {
      const li = list[a];
      const ka = keys[a];
      const oa = order[a];
      let b = a - 1;
      while (b >= 0 && (keys[b] > ka || (keys[b] === ka && order[b] > oa))) {
        list[b + 1] = list[b];
        keys[b + 1] = keys[b];
        order[b + 1] = order[b];
        b--;
      }
      list[b + 1] = li;
      keys[b + 1] = ka;
      order[b + 1] = oa;
    }
  }

  /**
   * Whether the player, set down with its centre at `at`, would be inside
   * another of the surfaces found. Each other block is trimmed 2 units at
   * both ends along the gravity axis first — unless what is being tried is a
   * slope's face. [LABEL_186, gd-ida-decomp.cpp:155052-155100]
   */
  private spiderBlocked(o: ObjectSet, list: Int32Array, n: number, k: number, at: number, left: number, right: number, half: number, face: boolean): boolean {
    const trim = face ? 0 : 2;
    for (let j = 0; j < n; j++) {
      if (j === k) continue;
      const i = list[j];
      if (rectsTouch(left, at - half, right, at + half, o.x0[i], o.y0[i] + trim, o.x1[i], o.y1[i] - trim)) return true;
    }
    return false;
  }

  /**
   * An object's own position — not its hitbox's centre — along the player's
   * gravity axis: level y, or x in rotated gameplay's mirrored frame. It is
   * what the spider lands on when a hazard is in the way.
   * [GameObject::getRealPosition, gd-ida-decomp.cpp:164577-164584]
   */
  private gravityPosition(i: number): number {
    const obj = this.level.objects[i];
    const moved = this.objs !== this.baseObjs;
    if (this.inLocalFrame) return obj.x + (moved ? this.objs.cx[i] - this.baseObjs.cx[i] : 0);
    return obj.y + (moved ? this.objs.cy[i] - this.baseObjs.cy[i] : 0);
  }

  // ---------------------------------------------------------------------------
  // Sim interface: snapshots and queries
  // ---------------------------------------------------------------------------

  snapshot(): SimSnapshot {
    this.objStateShared = true;
    this.motionShared = true;
    const p1 = new Player(this, 1);
    p1.copyFrom(this.p1);
    let p2: Player | null = null;
    if (this.p2) {
      p2 = new Player(this, 2);
      p2.copyFrom(this.p2);
    }
    const data: SnapData = {
      p1,
      p2,
      floorY: this.floorY,
      ceilingY: this.ceilingY,
      ground: { ...this.ground, tween: this.ground.tween ? { ...this.ground.tween } : null },
      camera: this.snapshotCamera(),
      dual: this.dual,
      modePortal: this.modePortal,
      dualPortal: this.dualPortal,
      corridorFree: this.corridorFree,
      corridorNoSnap: this.corridorNoSnap,
      objState: this.objState,
      motion: this.motion,
      eventsLen: this.events.length,
      triggers: this.triggers.capture(),
      lastPlayerX: this.lastPlayerX,
      lastPlayerY: this.lastPlayerY,
      end: this.end,
      placed: false,
      respawnGroup: 0,
    };
    return { tick: this.tick, opaque: data };
  }

  restore(s: SimSnapshot): void {
    const d = s.opaque as SnapData;
    this.tick = s.tick;
    this.p1.copyFrom(d.p1);
    if (d.p2) {
      if (!this.p2) this.p2 = new Player(this, 2);
      this.p2.copyFrom(d.p2);
    } else {
      this.p2 = null;
    }
    this.floorY = d.floorY;
    this.ceilingY = d.ceilingY;
    this.ground = { ...d.ground, tween: d.ground.tween ? { ...d.ground.tween } : null };
    this.camera.copyFrom(d.camera);
    this.dual = d.dual;
    this.modePortal = d.modePortal;
    this.dualPortal = d.dualPortal;
    this.corridorFree = d.corridorFree;
    this.corridorNoSnap = d.corridorNoSnap;
    this.objState = d.objState;
    this.objStateShared = true;
    this.motion = d.motion;
    this.motionShared = true;
    this.triggers.restore(d.triggers);
    this.lastPlayerX = d.lastPlayerX;
    this.lastPlayerY = d.lastPlayerY;
    this.end = d.end;
    this.checkpointMarked = null;
    this.pendingSpeed = -1;
    this.syncGeometry(false);
    if (this.events.length > d.eventsLen) this.events.length = d.eventsLen;
    this.waves.length = 0;
    this.ringPower.clear();
    this.forgetMet();
    this.hashDirty = true;
  }

  /**
   * A practice respawn: the snapshot, less what the game's checkpoint does not
   * keep. The respawn resets each player first (resetObject), which empties
   * the rings a press would take, ends every letter block and a force block's
   * push, and drops the mark a teleport leaves, and the checkpoint has none of
   * them to give back. The grown-back snap ends too, except in a platformer:
   * there the reset grows the player back from 0.6 and arms it again, as at
   * the start, and taking the checkpoint's size never touches it. The rings
   * this press has used (+1700) are left alone; only a press clears them.
   * The secret coins taken since the start come back, as every reset gives
   * them back. Returns how many trigger events the checkpoint kept: the ones
   * after them are its key 448 spawn's, which the audio has still to hear.
   * [gdp PlayerObject::resetObject → resetStateVariables, gd-ida-decomp.cpp:153620,
   *  153520-153542 (+2212 at :153533, the force at :153534-153542), then
   *  togglePlayerScale :153659-153660, 150416-150418; resetTouchedRings(true)
   *  :153621, 153489-153491; +1168 :153570; resetPlayer on both players
   *  :425070-425075, from resetLevel :105781 → resetLevelVariables :463055;
   *  saveToCheckpoint :161518-161589, loadFromCheckpoint :161605-161746 (the
   *  size at :161647)]
   */
  /** The camera as it is, for a snapshot to keep. */
  private snapshotCamera(): Camera {
    const c = new Camera();
    c.copyFrom(this.camera);
    return c;
  }

  respawnFrom(s: SimSnapshot): number {
    const levelTime = this.triggers.levelTime;
    this.restore(s);
    this.triggers.respawned(levelTime);
    const d = s.opaque as SnapData;
    const kept = this.triggers.events.length;
    for (const p of [this.p1, this.p2]) {
      if (!p) continue;
      p.touchingRings.length = 0;
      p.ringsThisPass.length = 0;
      p.stateHitHead = 0;
      p.stateFlipGravity = 0;
      p.stateNoAutoJump = 0;
      p.stateDartSlide = 0;
      p.scaleSnapPasses = this.platformer ? SCALE_SNAP_PASSES : 0;
      p.forcePasses = 0;
      p.forceX = 0;
      p.forceY = 0;
      p.forceIds.length = 0;
      p.forceSlide = false;
      p.teleported = false;
      // A moving platform's speeds go with the reset. [resetObject :153580-153583]
      p.platformYVel = 0;
      p.lastPlatformYVel = 0;
      p.noBoostYPasses = 0;
      // Where it last met the ground: the reset zeroes it, and the checkpoint
      // does not keep it. [resetObject :153635]
      p.lastGroundY = Number.NaN;
      // The checkpoint keeps the velocity as a float and hands it back through
      // setYVelocity. [saveToCheckpoint :161545-161551, loadFromCheckpoint :161732]
      p.setYVelocity(Math.fround(p.yVel));
      // A reverse-sync offset comes back as a float; its next share does not
      // come back at all. [saveToCheckpoint :161564-161565, loadFromCheckpoint
      // :161648; resetObject :153587]
      p.reverseOffset = Math.fround(p.reverseOffset);
      p.reverseSlice = 0;
    }
    if (d.placed) {
      // A platformer checkpoint object's: every button let go, no fall, off
      // the ground. The directions are read afresh from each step's input,
      // so letting go of them only decides which one was pressed last.
      // [gdp PlayerObject::loadFromCheckpoint :161737-161743 (the flag set by
      //  PlayLayer::postUpdate :105345); releaseAllButtons :159562-159571]
      const p = this.p1;
      p.releaseButton();
      p.leftHeld = false;
      p.rightHeld = false;
      p.setYVelocity(0);
      p.onGround = false;
    }
    // A dual comes back with player 1 meeting the portal that last held the
    // camera — the dual portal, while there is one — unless player 1 is
    // flying or a ball. [gdp PlayLayer::loadFromCheckpoint :105568-105573 →
    //  enterDualMode :420939-420958 (+844, processCameraObject's answer
    //  :420092-420100)]
    const held = this.dualPortal ?? this.modePortal;
    if (this.dual && held !== null && !this.p1.isFlying && !this.p1.isBall) this.meet(this.p1, held);
    // A reset gives every secret coin back and forgets what the attempt had
    // picked up; the checkpoint picks up again only the user coins, which
    // count as triggered objects. [gdp PlayLayer::resetLevel :105781 →
    //  resetLevelVariables → clearPickedUpItems :463046; resetObject on every
    //  object :105839-105843, :169951-169964; loadFromCheckpoint :105589-105610]
    for (const i of this.secretCoins) {
      const slot = this.baseObjs.slot[i];
      if ((this.objState[slot] & ST_ACT_P1) !== 0) this.setObjState(slot, this.objState[slot] & ~ST_ACT_P1);
    }
    // Key 448 spawns once the players are back, and what it fires acts at
    // once, in the checkpoint's tick. [gdp PlayLayer::resetLevel
    //  :105965-105973, after loadLastCheckpoint :105893]
    // The reset lays the corridor again at once, and the camera starts over
    // where the player is. [gdp PlayLayer::resetLevel :105636-105642
    //  (updateDualGround with its instant flag); updateCamera(0) :105979]
    this.updateCorridor(this.p1, this.p1.mode, true);
    this.resetCamera();
    if (d.respawnGroup > 0) {
      this.triggers.tick = this.tick;
      this.triggers.spawnFromLevel(d.respawnGroup, 0);
      this.takeSpawned();
    }
    return kept;
  }

  setPractice(on: boolean): void {
    this.practice = on;
  }

  coinsTaken(): number[] {
    const out: number[] = [];
    for (const i of this.secretCoins) {
      if ((this.objState[this.baseObjs.slot[i]] & ST_ACT_P1) === 0) continue;
      // Key 12, read with atoi. [gdp EffectGameObject::customObjectSetup
      //  LABEL_126 :299556-299559 (+1600)]
      out.push(parseInt(this.level.objects[i].props[12] ?? "0", 10) || 0);
    }
    return out;
  }

  query(x0: number, y0: number, x1: number, y1: number): LevelObject[] {
    const objs = this.level.objects;
    const byX = this.objs.byX;
    // Objects can be wide (scaled / OBB), so widen the x window generously.
    const pad = 300;
    let lo = 0;
    let hi = byX.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (objs[byX[mid]].x < x0 - pad) lo = mid + 1;
      else hi = mid;
    }
    const out: LevelObject[] = [];
    const e = this.extent;
    for (let k = lo; k < byX.length; k++) {
      const obj = objs[byX[k]];
      if (obj.x > x1 + pad) break;
      objectExtent(this.objs, obj, e);
      if (e[2] < x0 || e[0] > x1 || e[3] < y0 || e[1] > y1) continue;
      out.push(obj);
    }
    return out;
  }

  hitboxOf(index: number): WorldShape | null {
    const o = this.objs;
    if (index < 0 || index >= o.n || o.kind[index] === K_NONE) return null;
    const slot = o.slot[index];
    if (slot >= 0 && (this.objState[slot] & ST_DESTROYED) !== 0) return null;
    if (this.triggers.hasToggles && this.triggers.objectDisabled(index)) return null;
    switch (o.shape[index]) {
      case S_CIRCLE:
        return { type: "circle", cx: o.cx[index], cy: o.cy[index], r: o.hw[index] };
      case S_TRI: {
        const t = new Float64Array(6);
        o.triangle(index, t);
        return { type: "triangle", ax: t[0], ay: t[1], bx: t[2], by: t[3], cx: t[4], cy: t[5] };
      }
      default:
        return {
          type: "rect",
          rect: { x: o.cx[index] - o.hw[index], y: o.cy[index] - o.hh[index], w: o.hw[index] * 2, h: o.hh[index] * 2 },
          rotation: o.shape[index] === S_OBB ? o.rotDeg[index] : 0,
        };
    }
  }

  playerRect(player: 1 | 2 = 1): Rect {
    const p = player === 2 && this.p2 ? this.p2 : this.p1;
    const h = p.hitboxSize();
    return { x: p.x - h / 2, y: p.y - h / 2, w: h, h };
  }

  playerInnerRect(player: 1 | 2 = 1): Rect {
    const p = player === 2 && this.p2 ? this.p2 : this.p1;
    const h = p.innerSize();
    return { x: p.x - h / 2, y: p.y - h / 2, w: h, h };
  }

  progress(): number {
    // kA44: the steps since the attempt began out of the level's length in
    // steps, both as floats. [gdp PlayLayer::getCurrentPercent :91461-91487;
    //  the step count +824, processCommands :464115, zeroed by resetLevel
    //  :105783 and kept by a checkpoint with the rest of the game state]
    const steps = this.level.header.lengthSteps;
    if (steps > 0) {
      const t = Math.fround(Math.fround(this.tick) / Math.fround(steps));
      return t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const len = this.level.lengthUnits;
    if (len <= 0) return 0;
    const v = this.p1.x / len;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  stateHash(): number {
    // The object-state half is cached; the trigger half is not, because nothing
    // a trigger does goes through setObjState and a stale hash here would make
    // the autoplayer treat two different worlds as the same one. It costs
    // nothing until a trigger has actually changed something.
    let h = Math.imul(this.objectStateHash() ^ this.triggers.hash(), 0x01000193);
    // Per player and never cached: the rings a press would take and the
    // letter blocks wearing off change every step.
    h = this.p1.carryHash(h);
    if (this.p2) h = this.p2.carryHash(h);
    // Unlinked dual gravity changes what the next flip does to the other player.
    if (this.triggers.visual.options.unlinkDualGravity) h = Math.imul(h ^ 0x40000000, 0x01000193);
    // So does boost slide, off by kA45 or the Options trigger: a push slides out faster.
    if (!this.triggers.visual.options.boostSlide) h = Math.imul(h ^ 0x50000000, 0x01000193);
    return (h >>> 0) || 1;
  }

  private objectStateHash(): number {
    if (!this.hashDirty) return this.hashCache;
    let h = 0x811c9dc5;
    const st = this.objState;
    for (let i = 0; i < st.length; i++) {
      h ^= st[i];
      h = Math.imul(h, 0x01000193);
    }
    // The corridor switches decide the band the next portal draws.
    h ^= (this.dual ? 1 : 0) | (this.corridorFree ? 2 : 0) | (this.corridorNoSnap ? 4 : 0);
    h = Math.imul(h, 0x01000193);
    h ^= this.floorY | 0;
    h = Math.imul(h, 0x01000193);
    h ^= this.ceilingY === OPEN_CEILING ? 0x7fff : this.ceilingY | 0;
    h = Math.imul(h, 0x01000193);
    h ^= (this.ground.in ? 1 : 0) | ((this.ground.slide * 1024) << 1);
    h = Math.imul(h, 0x01000193);
    this.hashCache = h >>> 0;
    this.hashDirty = false;
    return this.hashCache;
  }
}

/** Whether one object is in both halves of the collision log. [postCollision :158682-158715] */
function logsMeet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  for (const i of a) if (b.includes(i)) return true;
  return false;
}

export function createSim(level: Level, objects: ObjectTable, opts: SimOptions = {}): Sim {
  return new SimImpl(level, objects, opts);
}
