// Where the view sits, how big it is, and which way it is turned.
//
// The design view is 480x320 units, and the window decides which of the two the
// game keeps. Anything at least 3:2 wide keeps the 320 of height and gets wider
// — a 16:9 window shows 569 units across, not 480 — and anything narrower keeps
// the 480 of width and gets taller. Height is the fixed quantity on every
// ordinary screen, which is the opposite of what the background tiles suggest.
// [gdp AppDelegate::setupGLView and CCDirector::updateScreenScale,
// gd-ida-decomp.cpp:77019-77041 and :801122-801146]
//
// The camera is updated inside the fixed 240 Hz tick rather than per frame, so
// it is deterministic and can be interpolated, as the game runs updateCamera
// once per physics sub-step. Everything the camera triggers ask for (zoom,
// offset, turn, static camera, edges) is taken once a tick, after the runtime
// has stepped its tweens, and composed here the way updateCamera composes it.
// [gdp GJBaseGameLayer::update :469984-469989; updateCamera :449342-450830]

import { clamp, lerp } from "../engine/math";
import { FLOOR_Y, GAME_GROUND_Y, MAX_GAMEPLAY_Y_DEFAULT } from "../physics/constants";
import type { PlayerState } from "../physics/types";
import { type CameraTween, cameraTweenDone, stepCameraTween } from "../triggers/easing";
import { designSize, VIEW_UNITS_HIGH, VIEW_UNITS_WIDE } from "../ui/viewport";

// The design box itself lives in ui/viewport.ts, because the interface has to
// agree with the level about where the edge of the screen is.
export { VIEW_UNITS_HIGH, VIEW_UNITS_WIDE };
/**
 * How far the player is kept behind the view's centre along the way it
 * travels, in design units: 75 / zoom world units, so its place across the
 * screen does not change with the zoom. It is a distance, not a fraction: the
 * fraction of the screen depends on the aspect ratio, which is 0.368 at 16:9
 * and 0.344 at 4:3. A reversed player has it ahead instead.
 * [gdp restoreDefaultGameplayOffsetX :430024-430026; updateCamera
 *  :449668-449689, 75 × sign / zoom]
 */
export const GAMEPLAY_OFFSET_X = 75;
/**
 * The dead zone the player is kept inside, measured from the centre of the
 * view. Swapped when gravity is flipped. A platformer uses the tighter pair.
 * [gdp updateCamera :449691-449721]
 */
export const DEAD_ZONE_UP = 70;
export const DEAD_ZONE_DOWN = 40;
export const DEAD_ZONE_PLATFORMER_UP = 55;
export const DEAD_ZONE_PLATFORMER_DOWN = 27.5;
/** Platformer travel-axis easing. Classic snaps (1). [gdp :449722-449726] */
export const PLATFORMER_TRAVEL_DIVISOR = 8;
/**
 * The vertical follow divides the tick's own 60 Hz delta — 0.25 at 240 Hz — by
 * this, so the camera closes 2.5% of the gap a tick. It is also the default
 * easing a Camera Mode trigger can change for the other modes.
 * [gdp :450574-450590; resetCamera :451335-451336]
 */
export const FOLLOW_DIVISOR = 10;
/** The default padding of the other modes' free follow. [gdp resetCamera :451335] */
export const FOLLOW_PADDING = 0.5;
/** The tick expressed in 60 Hz frames, which is what every camera divisor divides. */
const DT60 = 0.25;
/** The tick in seconds, which the camera's own hand-back tween steps by. */
const TICK_SECONDS = DT60 / 60;
/**
 * The lowest the view's bottom edge goes when no Camera Edge sets a floor:
 * the game's y 0, 90 under the ground line, so a cube on the ground stands a
 * third of the way up the view. [gdp updateCamera :449590-449593, where
 * getCameraEdgeValue(4) is 0 with no group (:429937-429985); limitCamera
 * :430885-430904 always applies the minimum]
 */
export const VIEW_FLOOR = -GAME_GROUND_Y;
/**
 * With no top edge, the view's top stops this far under the level's top
 * (maxGameplayYFor). [gdp updateCamera :449595-449597]
 */
export const LEVEL_TOP_MARGIN = 150;
/**
 * The view's left edge stays at x 15 or right of it, wherever no Camera Edge
 * sets a wall further right, on a run from the level's beginning (on every
 * run with kA23, on none with kA24). The player starts at x 0, off the left
 * of the view, which holds still until the player is 75 behind its centre.
 * It is not an edge: outside a platformer the view does not ease into it.
 * [gdp updateCamera :449613-449619 (+10958 set by setupHasCompleted :106344
 *  and resetLevelVariables :463044, +10956 by PlayLayer::addObject
 *  :90313-90314 for an enabled start position); the soft stop reads the edge
 *  slot :450498-450500]
 */
export const LEVEL_START_LEFT = 15;
/**
 * A classic level's end portal stands this far past its furthest object, and
 * at least this far past a screen's width from the level's start; the view's
 * right edge stops on it, so the player runs the last stretch across the
 * screen into the portal.
 * [gdp PlayLayer::createObjectsFromSetupFinished :102160-102177 (getScreenRight
 *  is the design width); updateCamera :449604-449612]
 */
export const LEVEL_END_MARGIN = 340;
const LEVEL_END_SCREEN_MARGIN = 300;

/** Where the end portal stands for a level end (CameraTriggerState.levelEnd) and a design view this wide. */
export function levelEndStop(levelEnd: number, designWide: number): number {
  return Math.max(levelEnd, designWide + LEVEL_END_SCREEN_MARGIN);
}

/**
 * Where a full-size player stands on the floor: the game's 105. The view
 * keeps its bottom on the floor while it zooms in on one last grounded there.
 * [gdp updateCamera :449738-449742]
 */
const FLOOR_STAND_Y = 105 - GAME_GROUND_Y;
/**
 * Within this many units of a Camera Edge the follow eases into it, its
 * divisor rising towards 24 at the edge itself. [gdp updateCamera
 * :450440-450545]
 */
const EDGE_SOFT_STOP = 60;
const EDGE_SOFT_DIVISOR = 24;
/**
 * The camera's speed a Static Camera's curve sets out at is clamped to this,
 * in units a second. [gdp updateStaticCameraPos :450965, exitStaticCamera
 * :451432 (clampf ±10000)]
 */
const SPEED_LIMIT = 10000;
/**
 * Key 55 on a teleport: for half a second the y follow's divisor is 30,
 * whatever it would have been, until y snaps. The countdown is a float that
 * loses the tick's own 60 Hz delta over 60 each step.
 * [gdp teleportPlayer :462457-462458 (float 254 = 0.5); updateCamera
 *  :450552-450566; zeroed with +1368/+1369 :449662-449668]
 */
const SLOW_Y_SECONDS = 0.5;
const SLOW_Y_DIVISOR = 30;

/**
 * One axis of the Static Camera trigger (1914) as the layer keeps it: whether
 * it holds the view, where it aims, how it gets there, and how its last exit
 * hands the view back. The runtime owns this half, which a checkpoint keeps;
 * the camera owns the positions (where an approach sets out from, its speed,
 * the hand-back's size).
 * [gdp GJBaseGameLayer::updateStaticCameraPosToGroup :451473-451550 and
 *  updateStaticCameraPos :450937-451023 (floats 96-131, one of each pair per
 *  axis); exitStaticCamera :451385-451465; the keys from
 *  CameraTriggerGameObject::customObjectSetup :301604-301639, labelled by
 *  SetupStaticCameraPopup::init :590627-590760]
 */
export interface StaticCameraAxis {
  /** Float 118/119: a Static Camera holds this axis. */
  on: boolean;
  /** Float 98/99: where it aims, the group's position when it fired, or live under Follow. */
  target: number;
  /** Counts the triggers that took the axis, so the camera starts each approach from where it stands. */
  seq: number;
  /** Key 212 "Follow": the group whose main object the axis tracks every tick; 0 for none. [114/116] */
  follow: number;
  /** Key 453 "Smooth Velocity": the approach is a curve that sets out at the camera's own speed. [128] */
  smoothVelocity: boolean;
  /** Key 454 "Modifier": how far the curve's second handle leans back from the target. [130] */
  modifier: number;
  /** Key 213 "Easing", at least 1: Follow's smoothing, reached as the approach completes. [112] */
  smoothing: number;
  /** Key 10: the approach's move time, which also sizes the curve's first handle. [106] */
  duration: number;
  /**
   * The approach so far, 0 to 1 and eased: the plain ease of the centre (tween
   * 0xA/0xB) or, with Follow or Smooth Velocity, the progress (0x15/0x16).
   */
  progress: number;
  tween: CameraTween | null;
  /** Counts the exits (key 110) that reached the axis, so the camera hands the view back once for each. */
  exitSeq: number;
  /** Whether the axis was held when the exit came: only then is there a hand-back. [120] */
  exitHeld: boolean;
  /** Key 465 "Exit Instant": the exit's own step snaps. [+1368/+1369] */
  exitInstant: boolean;
  /** The hand-back's move time, easing and rate (keys 10, 30, 85), and keys 453 and 454 on the exit. [122-131] */
  exitDuration: number;
  exitEasing: number;
  exitRate: number;
  exitSmoothVelocity: boolean;
  exitModifier: number;
}

export function newStaticCameraAxis(): StaticCameraAxis {
  return {
    on: false,
    target: 0,
    seq: 0,
    follow: 0,
    smoothVelocity: false,
    modifier: 0,
    smoothing: 1,
    duration: 0,
    progress: 1,
    tween: null,
    exitSeq: 0,
    exitHeld: false,
    exitInstant: false,
    exitDuration: 0,
    exitEasing: 0,
    exitRate: 2,
    exitSmoothVelocity: false,
    exitModifier: 0,
  };
}

/** What a camera trigger has asked for; the runtime owns it. */
export interface CameraTriggerState {
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** Degrees the view is turned by, clockwise as cocos turns a node. */
  rotation: number;
  staticX: StaticCameraAxis;
  staticY: StaticCameraAxis;
  limitLeft: number | null;
  limitRight: number | null;
  limitTop: number | null;
  limitBottom: number | null;
  /** The level's top, which the view stays 150 under when no edge is set above. */
  levelTop: number;
  /** A classic level's end, before levelEndStop's floor; null in a platformer, which has none. */
  levelEnd: number | null;
  /** Counts the Rotate Gameplay triggers with key 368, each of which snaps the gameplay offset to where it is heading. */
  leadSnap: number;
  /**
   * How far the player is kept behind the view's centre along the way it
   * travels, and whether that distance is already in world units. Defaults
   * GAMEPLAY_OFFSET_X (75) and false; the Gameplay Offset trigger (2901) sets them.
   */
  gameplayOffsetX: number;
  gameplayOffsetY: number;
  gameplayOffsetXRaw: boolean;
  gameplayOffsetYRaw: boolean;
  /** Camera Mode's easing (1..40) and padding (0..1). */
  followDivisor: number;
  padding: number;
  /** LEVEL_START_LEFT when the run has the level's left stop, null when it has none. */
  minLeft: number | null;
  /** A platformer (kA22) eases into every limit it has, its own as well as a Camera Edge. [:450439, :450500] */
  platformer: boolean;
  /** Counts the teleports whose key 464 snaps both axes on the camera's next step. */
  snapSeq: number;
  /** Counts the teleports whose key 55 slows the y follow (SLOW_Y_SECONDS). */
  slowYSeq: number;
  /**
   * Counts the checks a teleport to a target or a spider's jump makes, with
   * the last one's player y and margin: the view snaps when that player
   * landed more than the margin above or below it.
   */
  teleportCheckSeq: number;
  teleportCheckY: number;
  teleportCheckMargin: number;
}

/**
 * Where a point `dx, dy` from the view's centre lands once the view is turned
 * `degrees` clockwise, as the sprite shader turns it.
 */
export function turnPoint(dx: number, dy: number, degrees: number): [number, number] {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [dx * c + dy * s, -dx * s + dy * c];
}

/**
 * Where the corridor's two ground layers stand on a `wide` × `high` screen,
 * in screen units from its bottom: `height` apart about its middle once in
 * (`slide` 1), at its bottom and top edges when out (0), and pushed further
 * out by what a view turned `turn` degrees adds to the screen's height, so
 * a turned view never shows them coming. The floor's own clamp to the level's
 * ground is the caller's. [gdp GJBaseGameLayer::updateCameraBGArt
 *  :431194-431213 (v55 is half of +10960 × zoom, :452595-452625)]
 */
export function groundLayers(height: number, slide: number, turn: number, wide: number, high: number): { floor: number; ceiling: number } {
  const r = (turn * Math.PI) / 180;
  const extra = turn === 0 ? 0 : Math.fround(wide * Math.abs(Math.sin(r)) + high * Math.abs(Math.cos(r)) - high);
  const v55 = Math.fround(extra * 0.5);
  const v56 = Math.fround(v55 + high);
  const v57 = Math.fround(height * 0.5);
  const v58 = Math.fround(v56 - Math.fround(high * 0.5 + Math.fround(v57 - 1)));
  return {
    floor: Math.fround(Math.fround(Math.fround(high * 0.5 + Math.fround(1 - v57)) + v55) * slide - v55),
    ceiling: Math.fround(v56 - v58 * slide),
  };
}

/**
 * Where the corridor's ground art stands in the level for a camera: the
 * layers' places on the screen (groundLayers) taken back into the level
 * through the view, the floor never under the level's ground. With nothing
 * slid in the floor is the level's ground and the ceiling is off the top of
 * the screen. [gdp GJBaseGameLayer::updateCameraBGArt :431194-431227 (the
 * layers' visibility :431215-431227)]
 */
export function corridorArt(camera: Camera, height: number, slide: number, alpha = 1): { floor: number; ceiling: number | null } {
  const zoom = camera.zoomAt(alpha);
  const high = camera.unitsHighAt(alpha) * zoom;
  const wide = camera.unitsWideAt(alpha) * zoom;
  const turn = camera.rotationAt(alpha);
  const layers = groundLayers(height, slide, turn, wide, high);
  const bottom = camera.centre(alpha).y - high / 2 / zoom;
  const floor = Math.max(FLOOR_Y, bottom + (Math.max(layers.floor, (FLOOR_Y + 1 - bottom) * zoom) - 1) / zoom);
  const r = (turn * Math.PI) / 180;
  const edge = high + (turn === 0 ? 0 : (wide * Math.abs(Math.sin(r)) + high * Math.abs(Math.cos(r)) - high) / 2);
  return { floor, ceiling: layers.ceiling < edge ? bottom + (layers.ceiling + 1) / zoom : null };
}

/**
 * The cubic Bézier the static camera's curves follow.
 * [gdp cubicBezier :430841-430870]
 */
function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return p1 * 3 * t * u * u + u * p0 * u * u + p2 * 3 * t * t * u + t * p3 * t * t;
}

/** One axis of the camera as updateCamera keeps it. Positions are view centres, in world units. */
interface Axis {
  /** The view's centre this tick, before the hand-back (+852 less +408, plus half the view). */
  pos: number;
  /** Where the view was drawn this tick and the last: `pos` plus the hand-back, limited (+852, +1028). */
  shown: number;
  prevShown: number;
  /** How fast the view moved over the last tick, in units a second. [+368, :450811-450813] */
  speed: number;
  /** The camera offset the last tick carried. [+360] */
  offset: number;
  /** The target the last tick aimed at, which the soft stop compares with. [+352] */
  lastTarget: number;
  /** The gameplay offset along this axis while it is the one travelled along, and the target it last had. [floats 136-141] */
  lead: number;
  leadTarget: number;
  /** The Static Camera trigger this axis last saw, and its approach: the centre it has reached, where it set out from, the speed it set out at, and the progress when the centre last moved. [96, 94, 104, 110] */
  staticSeq: number;
  staticCentre: number;
  staticFrom: number;
  staticSpeed: number;
  staticLast: number;
  /** The exits this axis has handed the view back for. */
  exitSeq: number;
  /**
   * The hand-back (+400): the jump an exit or a turn of gameplay left between
   * where the view was and where it now aims, eased back to nothing. A plain
   * one tweens the jump itself to 0; a smooth one tweens a progress along a
   * curve that sets out at the camera's speed. [:450609-450640, :450712-450744]
   */
  back: number;
  backTween: CameraTween | null;
  backSmooth: boolean;
  backStart: number;
  backSpeed: number;
  backDuration: number;
  backModifier: number;
}

function newAxis(pos: number): Axis {
  return {
    pos,
    shown: pos,
    prevShown: pos,
    speed: 0,
    offset: 0,
    lastTarget: pos,
    lead: 0,
    leadTarget: 0,
    staticSeq: 0,
    staticCentre: 0,
    staticFrom: 0,
    staticSpeed: 0,
    staticLast: 0,
    exitSeq: 0,
    back: 0,
    backTween: null,
    backSmooth: false,
    backStart: 0,
    backSpeed: 0,
    backDuration: 0,
    backModifier: 0,
  };
}

/** A hand-back an exit or a gameplay turn asks for this tick. */
interface HandBack {
  duration: number;
  easing: number;
  rate: number;
  smooth: boolean;
  modifier: number;
  speed: number;
}

function newHandBack(): HandBack {
  return { duration: 0, easing: 0, rate: 2, smooth: false, modifier: 0, speed: 0 };
}

/** One axis's limits on the view's centre, as updateCamera works them out. */
interface AxisLimit {
  /** The highest centre, or null for none (the game's -99999). */
  max: number | null;
  /** Whether limitCamera applies `max`: only when the view's corner it stands for is above 0. */
  maxApplies: boolean;
  /** Whether a Camera Edge or the level's end set it, or the level is a platformer: what turns the soft stop on. */
  maxEdge: boolean;
  min: number | null;
  minEdge: boolean;
}

function newAxisLimit(): AxisLimit {
  return { max: null, maxApplies: false, maxEdge: false, min: null, minEdge: false };
}

export class Camera {
  /** x across, y up; [0] and [1] are the two axes. */
  private readonly axes: [Axis, Axis] = [newAxis(0), newAxis(105)];
  /** 1 is the design view; larger shows less. At the end of this tick, and the last (zoomAt). */
  zoom = 1;
  private prevZoom = 1;
  /** Set by the Camera Offset trigger. */
  offsetX = 0;
  offsetY = 0;
  /** Set by the Static Camera trigger, one axis at a time. */
  readonly staticX: StaticCameraAxis = newStaticCameraAxis();
  readonly staticY: StaticCameraAxis = newStaticCameraAxis();
  /** Degrees the view is turned by, clockwise as cocos turns a node, at the end of this tick and the last. */
  rotation = 0;
  private prevRotation = 0;
  /**
   * Walls the view will not cross, set by the Camera Edge trigger. A side with
   * no limit is null; the game treats an unset slot as a sentinel rather than
   * as zero, which matters because zero is a perfectly ordinary coordinate.
   */
  limitLeft: number | null = null;
  limitRight: number | null = null;
  limitTop: number | null = null;
  limitBottom: number | null = null;
  /** The level's top, which the view stays 150 under when no edge is set above. */
  levelTop = MAX_GAMEPLAY_Y_DEFAULT;
  /** A classic level's end (CameraTriggerState.levelEnd), which the view's right edge stops on; null for none. */
  levelEnd: number | null = null;
  /** The Rotate Gameplay key-368 count the runtime has, and the one the follow has acted on. */
  leadSnap = 0;
  private leadSnapSeen = 0;
  /** The Gameplay Offset trigger's values; see CameraTriggerState. */
  gameplayOffsetX = GAMEPLAY_OFFSET_X;
  gameplayOffsetY = GAMEPLAY_OFFSET_X;
  gameplayOffsetXRaw = false;
  gameplayOffsetYRaw = false;
  /**
   * How a mode other than the cube and the robot follows when no corridor
   * holds it: the easing divides the tick as FOLLOW_DIVISOR does, and the
   * padding sets how far the player may stray from the centre, from 130
   * units (0) down to 2 (1) of a 320-high view. Set by Camera Mode.
   */
  followDivisor = FOLLOW_DIVISOR;
  padding = FOLLOW_PADDING;
  /** The level's left stop (CameraTriggerState.minLeft), a run from the level's beginning unless told otherwise. */
  minLeft: number | null = LEVEL_START_LEFT;
  platformer = false;
  /** The teleports' camera counts the runtime has, and the ones the follow has acted on. */
  snapSeq = 0;
  private snapSeen = 0;
  slowYSeq = 0;
  private slowYSeen = 0;
  teleportCheckSeq = 0;
  teleportCheckY = 0;
  teleportCheckMargin = 0;
  private teleportCheckSeen = 0;
  /** What is left of key 55's slow y follow, in seconds. [float 254] */
  private slowY = 0;
  private started = false;
  /** What the last tick saw, which the next compares with. [+164, +1036, +1037; the player's last position] */
  private lastZoom = 1;
  private lastRotated = false;
  private lastReversed = false;
  private lastPlayerX = 0;
  private lastPlayerY = 0;
  /**
   * What one tick of following works with, filled in place: the follow runs
   * every tick, so it allocates nothing. The edges on each axis, whether each
   * snaps, and the hand-back each is asked for.
   */
  private readonly lims: [AxisLimit, AxisLimit] = [newAxisLimit(), newAxisLimit()];
  private readonly snaps: [boolean, boolean] = [false, false];
  private readonly backs: [HandBack, HandBack] = [newHandBack(), newHandBack()];
  private readonly backing: [boolean, boolean] = [false, false];

  /** Aspect comes from the canvas, so the view is as tall as the window is. */
  private aspect = 16 / 9;
  /** The design view at that aspect, at a zoom of 1. */
  private designHigh = designSize(16 / 9).height;
  private designWide = designSize(16 / 9).width;

  setAspect(width: number, height: number): void {
    const aspect = height > 0 ? width / height : 16 / 9;
    if (aspect === this.aspect) return;
    this.aspect = aspect;
    const design = designSize(aspect);
    this.designHigh = design.height;
    this.designWide = design.width;
  }

  /**
   * 480x320 is the design size and the window picks which of the two to keep.
   * A window at least 3:2 wide keeps the height and widens; a narrower one — a
   * phone held upright — keeps the width and grows taller instead. Getting this
   * the wrong way round makes a portrait window four times too close.
   * [gdp CCDirector::updateScreenScale :801122-801146]
   */
  get unitsHigh(): number {
    return this.unitsHighAt(1);
  }

  get unitsWide(): number {
    return this.unitsWideAt(1);
  }

  /**
   * The zoom part-way between the last two ticks. A zoom trigger's tween
   * steps once a tick, so a frame between two ticks takes the size between
   * them, as it takes the centre and the turn between them.
   */
  zoomAt(alpha = 1): number {
    return alpha >= 1 ? this.zoom : lerp(this.prevZoom, this.zoom, alpha);
  }

  /** The view's height and width in world units, part-way between the last two ticks. */
  unitsHighAt(alpha = 1): number {
    return this.designHigh / this.zoomAt(alpha);
  }

  unitsWideAt(alpha = 1): number {
    return this.unitsHighAt(alpha) * this.aspect;
  }

  /** The view's centre this tick, before any hand-back. Settable, for a test to put the camera somewhere. */
  get x(): number {
    return this.axes[0].pos;
  }

  set x(v: number) {
    this.place(0, v);
  }

  get y(): number {
    return this.axes[1].pos;
  }

  set y(v: number) {
    this.place(1, v);
  }

  private place(i: 0 | 1, v: number): void {
    const a = this.axes[i];
    a.pos = a.shown = a.prevShown = a.lastTarget = v;
  }

  /**
   * Snap on a restart or a level change so the view does not slide into
   * place. With the runtime's camera state the first frame already has the
   * zoom, turn and static camera a checkpoint or a start position left.
   */
  reset(player?: PlayerState, triggers?: CameraTriggerState): void {
    this.started = false;
    if (triggers) {
      this.applyTriggers(triggers);
    } else {
      this.offsetX = 0;
      this.offsetY = 0;
      Object.assign(this.staticX, newStaticCameraAxis());
      Object.assign(this.staticY, newStaticCameraAxis());
      this.rotation = 0;
      this.limitLeft = null;
      this.limitRight = null;
      this.limitTop = null;
      this.limitBottom = null;
      this.levelTop = MAX_GAMEPLAY_Y_DEFAULT;
      this.levelEnd = null;
      this.leadSnap = this.leadSnapSeen;
      this.gameplayOffsetX = GAMEPLAY_OFFSET_X;
      this.gameplayOffsetY = GAMEPLAY_OFFSET_X;
      this.gameplayOffsetXRaw = false;
      this.gameplayOffsetYRaw = false;
      this.followDivisor = FOLLOW_DIVISOR;
      this.padding = FOLLOW_PADDING;
      this.minLeft = LEVEL_START_LEFT;
      this.platformer = false;
      this.snapSeq = this.snapSeen;
      this.slowYSeq = this.slowYSeen;
      this.teleportCheckSeq = this.teleportCheckSeen;
    }
    this.prevRotation = this.rotation;
    this.prevZoom = this.zoom;
    if (player) this.follow(player);
  }

  /**
   * Takes another camera's whole state, for a sim's snapshot: the follow
   * carries its approach, its hand-backs and what it last saw from tick to
   * tick, and a restored run must go on from exactly there.
   */
  copyFrom(other: Camera): void {
    for (let i = 0; i < 2; i++) {
      const from = other.axes[i];
      Object.assign(this.axes[i], from, { backTween: from.backTween ? { ...from.backTween } : null });
    }
    Object.assign(this.staticX, other.staticX, { tween: other.staticX.tween ? { ...other.staticX.tween } : null });
    Object.assign(this.staticY, other.staticY, { tween: other.staticY.tween ? { ...other.staticY.tween } : null });
    this.zoom = other.zoom;
    this.prevZoom = other.prevZoom;
    this.offsetX = other.offsetX;
    this.offsetY = other.offsetY;
    this.rotation = other.rotation;
    this.prevRotation = other.prevRotation;
    this.limitLeft = other.limitLeft;
    this.limitRight = other.limitRight;
    this.limitTop = other.limitTop;
    this.limitBottom = other.limitBottom;
    this.levelTop = other.levelTop;
    this.levelEnd = other.levelEnd;
    this.leadSnap = other.leadSnap;
    this.leadSnapSeen = other.leadSnapSeen;
    this.gameplayOffsetX = other.gameplayOffsetX;
    this.gameplayOffsetY = other.gameplayOffsetY;
    this.gameplayOffsetXRaw = other.gameplayOffsetXRaw;
    this.gameplayOffsetYRaw = other.gameplayOffsetYRaw;
    this.followDivisor = other.followDivisor;
    this.padding = other.padding;
    this.minLeft = other.minLeft;
    this.platformer = other.platformer;
    this.snapSeq = other.snapSeq;
    this.snapSeen = other.snapSeen;
    this.slowYSeq = other.slowYSeq;
    this.slowYSeen = other.slowYSeen;
    this.teleportCheckSeq = other.teleportCheckSeq;
    this.teleportCheckY = other.teleportCheckY;
    this.teleportCheckMargin = other.teleportCheckMargin;
    this.teleportCheckSeen = other.teleportCheckSeen;
    this.slowY = other.slowY;
    this.started = other.started;
    this.lastZoom = other.lastZoom;
    this.lastRotated = other.lastRotated;
    this.lastReversed = other.lastReversed;
    this.lastPlayerX = other.lastPlayerX;
    this.lastPlayerY = other.lastPlayerY;
    this.aspect = other.aspect;
    this.designHigh = other.designHigh;
    this.designWide = other.designWide;
  }

  /**
   * Takes what the camera triggers have asked for, once a tick before the
   * follow: the runtime has stepped its tweens by then, as the game steps them
   * just before updateCamera. [gdp GJBaseGameLayer::update :469988-469990]
   */
  applyTriggers(state: CameraTriggerState): void {
    this.prevZoom = this.zoom;
    this.zoom = clamp(state.zoom, 0.1, 8);
    this.offsetX = state.offsetX;
    this.offsetY = state.offsetY;
    this.prevRotation = this.rotation;
    this.rotation = state.rotation;
    Object.assign(this.staticX, state.staticX);
    Object.assign(this.staticY, state.staticY);
    this.limitLeft = state.limitLeft;
    this.limitRight = state.limitRight;
    this.limitTop = state.limitTop;
    this.limitBottom = state.limitBottom;
    this.levelTop = state.levelTop;
    this.levelEnd = state.levelEnd;
    this.leadSnap = state.leadSnap;
    this.gameplayOffsetX = state.gameplayOffsetX;
    this.gameplayOffsetY = state.gameplayOffsetY;
    this.gameplayOffsetXRaw = state.gameplayOffsetXRaw;
    this.gameplayOffsetYRaw = state.gameplayOffsetYRaw;
    this.followDivisor = state.followDivisor;
    this.padding = state.padding;
    this.minLeft = state.minLeft;
    this.platformer = state.platformer;
    this.snapSeq = state.snapSeq;
    this.slowYSeq = state.slowYSeq;
    this.teleportCheckSeq = state.teleportCheckSeq;
    this.teleportCheckY = state.teleportCheckY;
    this.teleportCheckMargin = state.teleportCheckMargin;
  }

  /**
   * One fixed tick of following, as updateCamera composes the view.
   *
   * The axis the player travels along — x, or y while gameplay is rotated —
   * snaps: the view keeps the player 75 / zoom units behind its centre, and
   * when the zoom changes that distance follows it at once. Reversing slides
   * it across at the player's own speed. The other axis depends on the mode:
   * the cube and the robot get a dead zone with an exponential approach, and
   * any other mode keeps the player within the padding's distance of the
   * centre, at the Camera Mode easing; an easing of 1 or less snaps. A
   * corridor holds y as a Static Camera does, because that is what it is:
   * the sim gives the band's middle to the static y (Sim.animateInGround),
   * which is why a ship section does not bob with the player. A zoom in on a player
   * that last stood on the floor keeps the view's bottom where it was and
   * eases it down onto the floor, rather than zooming about the centre. A
   * Static Camera takes an axis over. The camera offset is added on top, the
   * edges clamp what comes out, easing into a Camera Edge or the level's end
   * over the last 60 units, and an exit from a static camera (or a turn of
   * gameplay) hands the view back over its move time rather than jumping.
   * A teleport's key 464, or a teleport or a spider's jump that lands the
   * player well above or below the view, snaps both axes; a teleport's key 55
   * slows the y follow for half a second instead.
   * [gdp updateCamera :449342-450830 — the limits :449578-449619; the offset
   *  :449686-449694; the gameplay offset :449668-449689 and :450045-450140;
   *  the zoom on the floor :449733-449753, :450040-450048; the dead zone and
   *  padding :449691-449733, :450212-450296; the static axis :449816-450010;
   *  the turn of gameplay :449643-449661; the soft stop :450440-450545; the
   *  smoothing :450565-450593; the hand-back :450609-450786; isInBasicMode
   *  :145589-145598; the teleports
   *  :449628-449668, :450552-450566, checkCameraLimitAfterTeleport
   *  :450837-450857]
   */
  follow(player: PlayerState): void {
    const first = !this.started;
    const zoom = this.zoom;
    const high = this.designHigh / zoom;
    const halfW = (high * this.aspect) / 2;
    const halfH = high / 2;
    const rotated = player.rotated;
    const travel = rotated ? 1 : 0;
    // The Gameplay Offset trigger sets the design-unit distance (default 75);
    // with its raw flag the value is already in world units. Rotated gameplay
    // uses the Y pair. [gdp updateCamera :449670-449689]
    const go = rotated
      ? this.gameplayOffsetYRaw
        ? this.gameplayOffsetY
        : this.gameplayOffsetY / zoom
      : this.gameplayOffsetXRaw
        ? this.gameplayOffsetX
        : this.gameplayOffsetX / zoom;
    const leadTarget = go * (player.reversed ? -1 : 1);
    const limits = this.limits(halfW, halfH);
    const basic = player.mode === "cube" || player.mode === "robot";
    const flying = player.mode === "ship" || player.mode === "ufo" || player.mode === "wave" || player.mode === "swing";
    // Zooming in on a player whose last landing was on the floor, while it is
    // low enough that the view's bottom can stay on the floor: the bottom is
    // kept rather than the centre, and the y follow eases it onto the floor.
    // [:449733-449753, the last grounded position +2076 set by hitGround and
    //  propellPlayer; :450040-450048]
    const floorHold =
      !rotated &&
      !player.flipped &&
      !flying &&
      zoom > this.lastZoom &&
      player.lastGroundY === FLOOR_STAND_Y &&
      player.y + GAME_GROUND_Y <= high - GAME_GROUND_Y / zoom;
    const backs = this.backs;
    const backing = this.backing;
    const snaps = this.snaps;
    backing[0] = backing[1] = false;
    snaps[0] = snaps[1] = first;
    // Rotate Gameplay's key 368 snaps the gameplay offset this step.
    // [gdp rotateGameplay :442856-442860 (floats 149/150); updateCamera
    //  :450045-450056]
    const leadSnap = this.leadSnap !== this.leadSnapSeen;
    this.leadSnapSeen = this.leadSnap;
    // A teleport's key 464 snaps both axes this step. A teleport to a target
    // or a spider's jump that left the player more than its margin over the
    // view's top or under its bottom, as the view was last drawn, snaps them
    // at once: the game runs a step of the camera with no time in it, which
    // snaps both. Either one, and an exit's Exit Instant, ends a slow y
    // follow (+1368/+1369 taken). The static-y and rotated tests are made
    // where the check is (Sim.checkCameraAfterTeleport).
    // [gdp teleportPlayer :462476-462479; checkCameraLimitAfterTeleport
    //  :450837-450857 (+852's y and the window's height, not divided by the
    //  zoom); updateCamera :449628-449642, :449662-449668]
    let taken = false;
    if (this.snapSeq !== this.snapSeen) {
      this.snapSeen = this.snapSeq;
      snaps[0] = snaps[1] = true;
      taken = true;
    }
    if (this.teleportCheckSeq !== this.teleportCheckSeen) {
      this.teleportCheckSeen = this.teleportCheckSeq;
      const bottom = this.axes[1].shown - this.designHigh / this.lastZoom / 2;
      const y = this.teleportCheckY;
      const margin = this.teleportCheckMargin;
      if (y > bottom + this.designHigh + margin || y < bottom - margin) {
        snaps[0] = snaps[1] = true;
        taken = true;
      }
    }
    if (this.slowYSeq !== this.slowYSeen) {
      this.slowYSeen = this.slowYSeq;
      this.slowY = SLOW_Y_SECONDS;
    }

    for (let i = 0; i < 2; i++) {
      const a = this.axes[i];
      const s = i === 0 ? this.staticX : this.staticY;
      const offset = i === 0 ? this.offsetX : this.offsetY;
      // The camera's own tween, before the camera moves, as the game steps
      // its tweens. [:469988]
      if (!first && a.backTween) a.back = stepCameraTween(a.backTween, TICK_SECONDS);
      // The offset's change moves the view at once rather than being chased.
      // A Static Camera that fired since the last tick sets out from where
      // the view was drawn, less the offset then, and drops whatever was
      // still being handed back on its axis. [:449690-449694;
      // updateStaticCameraPos :450947-450958 (+400 and tween 0xC/0xD);
      // updateStaticCameraPosToGroup :451505-451530 (tween 0x15/0x16)]
      // After a restart there is nothing to set out from: the static axis
      // starts where it aims.
      if (first || s.seq !== a.staticSeq) {
        a.staticSeq = s.seq;
        a.staticFrom = first ? s.target : a.shown - a.offset;
        a.staticCentre = a.staticFrom;
        a.staticSpeed = first ? 0 : clamp(a.speed, -SPEED_LIMIT, SPEED_LIMIT);
        a.staticLast = first ? s.progress : s.tween ? 0 : 1;
        if (!first) {
          a.back = 0;
          a.backTween = null;
          a.backSmooth = false;
        }
      }
      a.pos += offset - a.offset;
      a.offset = offset;
      // The zoom on the floor keeps the bottom: the centre moves by what the
      // half height grew by. [:449748-449753, the y re-centre skipped]
      if (i === 1 && floorHold) a.pos += halfH - this.designHigh / this.lastZoom / 2;
      // An exit snaps its step, and hands the view back from where it was
      // drawn when the axis was held. [exitStaticCamera :451406-451445;
      // updateCamera :449627-449642]
      if (s.exitSeq !== a.exitSeq) {
        a.exitSeq = s.exitSeq;
        if (s.exitInstant) taken = true;
        if (!first && (s.exitInstant || s.exitHeld)) snaps[i] = true;
        if (!first && s.exitHeld) {
          const b = backs[i];
          b.duration = s.exitDuration;
          b.easing = s.exitEasing;
          b.rate = s.exitRate;
          b.smooth = s.exitSmoothVelocity;
          b.modifier = s.exitModifier;
          b.speed = clamp(a.speed, -SPEED_LIMIT, SPEED_LIMIT);
          backing[i] = true;
        }
      }
    }
    // A turn of gameplay hands the axes no static camera holds back over a
    // second, eased in and out, unless they snap anyway. [:449643-449661]
    if (!first && rotated !== this.lastRotated) {
      for (let i = 0; i < 2; i++) {
        if ((i === 0 ? this.staticX : this.staticY).on || snaps[i]) continue;
        const b = backs[i];
        b.duration = 1;
        b.easing = 1;
        b.rate = 2;
        b.smooth = false;
        b.modifier = 0;
        b.speed = 0;
        backing[i] = true;
      }
    }
    if (taken) this.slowY = 0;

    for (let i = 0; i < 2; i++) {
      const a = this.axes[i];
      const s = i === 0 ? this.staticX : this.staticY;
      const offset = i === 0 ? this.offsetX : this.offsetY;
      const at = i === 0 ? player.x : player.y;
      let target: number;
      let divisor = 1;
      if (s.on) {
        // The static axis: the centre the approach has reached, plus the
        // offset. Follow tracks its group live and, as the approach ends,
        // eases at up to its smoothing. [:449816-450010; the curve's handles
        // :449889-449897]
        const p = s.progress;
        const to = s.target;
        let c = a.staticCentre;
        if (s.follow <= 0 && !s.smoothVelocity) c = a.staticFrom + (to - a.staticFrom) * p;
        else if (p >= 1) c = to;
        else if (s.smoothVelocity) {
          const h1 = a.staticFrom + (a.staticSpeed * s.duration) / 3;
          const h2 = to + s.modifier * (h1 - to);
          c = bezier(a.staticFrom, h1, h2, to, p);
        } else if (p !== a.staticLast) {
          c += (to - c) / ((1 - a.staticLast) / (p - a.staticLast));
          a.staticLast = p;
        }
        a.staticCentre = c;
        target = c + offset;
        if (s.follow > 0 && s.smoothing * p > 1) divisor = s.smoothing * p;
      } else if (i === travel) {
        // The travel axis snaps; the gameplay offset follows a zoom change at
        // once when it had settled, and otherwise slides at the player's own
        // speed. [:450045-450140]
        const moved = first ? 0 : Math.abs(at - (i === 0 ? this.lastPlayerX : this.lastPlayerY));
        let lead = a.lead;
        if (snaps[i] || leadSnap) lead = leadTarget;
        else if (zoom !== this.lastZoom && lead === a.leadTarget && player.reversed === this.lastReversed) lead = leadTarget;
        else if (leadTarget > lead) lead = Math.min(lead + moved, leadTarget);
        else lead = Math.max(lead - moved, leadTarget);
        a.lead = lead;
        a.leadTarget = leadTarget;
        target = at + lead + offset;
        if (this.platformer) divisor = PLATFORMER_TRAVEL_DIVISOR;
      } else if (floorHold && i === 1) {
        // The view's bottom on the floor, plus the offset. [:450040-450048,
        // with the follow's divisor of 10]
        target = VIEW_FLOOR + halfH + offset;
        divisor = FOLLOW_DIVISOR;
      } else {
        // The dead zone (the cube and the robot), or the padded free follow.
        // A platformer's dead zone is 55 / 27.5 instead of 70 / 40.
        // [:449695-449733, :450212-450296]
        let up: number;
        let down: number;
        if (basic) {
          const zoneUp = this.platformer ? DEAD_ZONE_PLATFORMER_UP : DEAD_ZONE_UP;
          const zoneDown = this.platformer ? DEAD_ZONE_PLATFORMER_DOWN : DEAD_ZONE_DOWN;
          up = player.flipped ? zoneDown : zoneUp;
          down = player.flipped ? zoneUp : zoneDown;
          divisor = FOLLOW_DIVISOR;
        } else {
          const designHalf = (i === 0 ? this.designWide : this.designHigh) / 2;
          up = down = (designHalf - (this.padding * (designHalf - 2 - 30) + 30)) / zoom;
          divisor = this.followDivisor;
        }
        const p = at + offset;
        target = p > a.pos + up ? p - up : p < a.pos - down ? p + down : a.pos;
      }
      // The edges clamp the target, and a Camera Edge (or the level's end)
      // eases the follow in over its last 60 units unless the target is
      // moving away. A static axis that snaps is left alone. [:450440-450545]
      const lim = limits[i];
      if (lim.max !== null) {
        if (target > lim.max) target = lim.max;
        if (lim.maxEdge && target > lim.max - EDGE_SOFT_STOP && !(target < a.lastTarget && target < a.pos)) {
          divisor = this.easeIn(divisor, lim.max - target, s.on);
        }
      }
      if (lim.min !== null) {
        if (target < lim.min) target = lim.min;
        if (lim.minEdge && target < lim.min + EDGE_SOFT_STOP && (target <= a.lastTarget || target <= a.pos)) {
          divisor = this.easeIn(divisor, target - lim.min, s.on);
        }
      }
      a.lastTarget = target;
      // Key 55's slow y follow, over whatever divisor y had, until it runs
      // out or y snaps. [:450552-450566]
      if (i === 1) {
        if (snaps[1]) this.slowY = 0;
        else if (this.slowY > 0) {
          divisor = SLOW_Y_DIVISOR;
          this.slowY = Math.fround(this.slowY - Math.fround(DT60 / 60));
        }
      }
      if (snaps[i]) divisor = 1;
      target = this.limit(lim, target);
      a.pos = this.limit(lim, divisor > 1 ? a.pos + (target - a.pos) / (divisor / DT60) : target);
    }

    for (let i = 0; i < 2; i++) {
      const a = this.axes[i];
      if (first) {
        a.back = 0;
        a.backTween = null;
        a.backSmooth = false;
      } else if (backing[i]) {
        // The jump between where the view was drawn and where it now aims,
        // eased back to nothing over the move time. [:450609-450640]
        const back = backs[i];
        const jump = a.shown - a.pos;
        a.back = back.duration > 0 ? jump : 0;
        a.backSmooth = back.duration > 0 && back.smooth;
        a.backStart = jump;
        a.backSpeed = back.speed;
        a.backDuration = back.duration;
        a.backModifier = back.modifier;
        const rate = back.rate > 0 ? back.rate : 2;
        a.backTween =
          back.duration > 0
            ? {
                from: a.backSmooth ? 0 : jump,
                to: a.backSmooth ? 1 : 0,
                duration: back.duration,
                elapsed: 0,
                easing: back.easing,
                rate,
                uid: -1,
                controlId: -1,
                paused: false,
              }
            : null;
      } else if (a.backTween) {
        if (a.backSmooth) {
          // The smooth hand-back: a curve from the jump to nothing that sets
          // out at the speed the camera had when the axis was let go.
          // [:450692-450712]
          const p = a.back;
          if (p >= 1) {
            a.back = 0;
            a.backTween = null;
            a.backSmooth = false;
          } else {
            const h1 = (a.backSpeed * a.backDuration) / 3 + a.backStart;
            a.back = bezier(a.backStart, h1, a.backModifier * h1, 0, p);
          }
        } else if (cameraTweenDone(a.backTween)) {
          a.backTween = null;
        }
      }
      const shown = this.limit(limits[i], a.pos + a.back);
      a.prevShown = first ? shown : a.shown;
      a.speed = first ? 0 : (shown - a.shown) / TICK_SECONDS;
      a.shown = shown;
    }
    this.lastZoom = zoom;
    this.lastRotated = rotated;
    this.lastReversed = player.reversed;
    this.lastPlayerX = player.x;
    this.lastPlayerY = player.y;
    this.started = true;
  }

  /**
   * Near an edge with a soft stop, the divisor rises from where it is towards
   * 24 as `d`, the target's distance from the edge, closes from 60 to 0; not
   * once it is 24, nor for a static axis that snaps. [:450440-450545]
   */
  private easeIn(divisor: number, d: number, held: boolean): number {
    if (divisor >= EDGE_SOFT_DIVISOR || (divisor === 1 && held)) return divisor;
    return divisor + (1 - d / EDGE_SOFT_STOP) * (EDGE_SOFT_DIVISOR - divisor);
  }

  /**
   * The edges on the view's centre, from the Camera Edge groups and, where
   * there are none, the game's defaults: the level's left stop at x 15 (when
   * the run has one), the view's bottom no lower than the game's y 0 and its
   * top 150 under the level's top. The left stop also stands in for a left
   * Camera Edge at or left of it. A classic level's end stops the right edge
   * on the end portal, less the camera offset, when that comes before any
   * right Camera Edge, and eases the view into it as an edge does; a
   * platformer eases into every limit it has. limitCamera applies a maximum
   * only when the corner it stands for is above 0, in the game's own
   * coordinates.
   * [gdp updateCamera :449578-449619, the soft stop's flags :450439 and
   *  :450498-450500 (+10734 the platformer's); limitCamera :430885-430904]
   */
  private limits(halfW: number, halfH: number): [AxisLimit, AxisLimit] {
    const lx = this.lims[0];
    const ly = this.lims[1];
    const right = this.limitRight;
    const left = this.limitLeft;
    const top = this.limitTop;
    const bottom = this.limitBottom;
    const platformer = this.platformer;
    lx.max = right !== null ? right - halfW : null;
    lx.maxApplies = right !== null && right - 2 * halfW > 0;
    lx.maxEdge = right !== null || platformer;
    if (this.levelEnd !== null) {
      const end = levelEndStop(this.levelEnd, this.designWide) - this.offsetX;
      if (lx.max === null || end - halfW < lx.max) {
        lx.max = end - halfW;
        lx.maxApplies = end - 2 * halfW > 0;
        lx.maxEdge = true;
      }
    }
    const stop = this.minLeft;
    const leftmost = stop !== null && (left === null || left <= stop) ? stop : left;
    lx.min = leftmost !== null ? leftmost + halfW : null;
    lx.minEdge = left !== null || platformer;
    // The game's bottom-left corner, in its own y (the port's + 90).
    const maxCornerY = (top !== null ? top : this.levelTop - LEVEL_TOP_MARGIN) + GAME_GROUND_Y - 2 * halfH;
    ly.max = maxCornerY - GAME_GROUND_Y + halfH;
    ly.maxApplies = maxCornerY > 0;
    ly.maxEdge = top !== null || platformer;
    ly.min = Math.max(bottom ?? VIEW_FLOOR, VIEW_FLOOR) + halfH;
    ly.minEdge = bottom !== null || platformer;
    return this.lims;
  }

  /** limitCamera on one axis: the maximum when it applies, then the minimum. */
  private limit(lim: AxisLimit, v: number): number {
    if (lim.maxApplies && lim.max !== null && v > lim.max) v = lim.max;
    if (lim.min !== null && v < lim.min) v = lim.min;
    return v;
  }

  /** The world rectangle on screen, unturned, grown a little so nothing pops at the edge. */
  bounds(pad = 30, alpha = 1): { x0: number; y0: number; x1: number; y1: number } {
    const high = this.unitsHighAt(alpha);
    const w = (high * this.aspect) / 2 + pad;
    const h = high / 2 + pad;
    const c = this.centre(alpha);
    return { x0: c.x - w, y0: c.y - h, x1: c.x + w, y1: c.y + h };
  }

  /**
   * The world rectangle a turned view can see: the bounding box of the view
   * turned about its centre, which the game grows its cull rect, its ground
   * and its background to. The same as `bounds` when the view is not turned.
   * [gdp GJBaseGameLayer::preUpdateVisibility :452608-452650]
   */
  coverBounds(pad = 30, alpha = 1): { x0: number; y0: number; x1: number; y1: number } {
    const turn = this.rotationAt(alpha);
    if (turn === 0) return this.bounds(pad, alpha);
    const r = (turn * Math.PI) / 180;
    const c = Math.abs(Math.cos(r));
    const s = Math.abs(Math.sin(r));
    const high = this.unitsHighAt(alpha);
    const wide = high * this.aspect;
    const w = (wide * c + high * s) / 2 + pad;
    const h = (wide * s + high * c) / 2 + pad;
    const m = this.centre(alpha);
    return { x0: m.x - w, y0: m.y - h, x1: m.x + w, y1: m.y + h };
  }

  /** The turn part-way between the last two ticks: straight, so 180 to 360 passes through 270. */
  rotationAt(alpha = 1): number {
    return alpha >= 1 ? this.rotation : lerp(this.prevRotation, this.rotation, alpha);
  }

  /**
   * Centre of the view in world units, which is not the player's position,
   * part-way between the last two ticks: `alpha` is how far into the next
   * tick this frame falls, from the loop's own accumulator. The shake is not
   * in it; the scene adds that.
   */
  centre(alpha = 1): { x: number; y: number } {
    const [ax, ay] = this.axes;
    if (alpha >= 1) return { x: ax.shown, y: ay.shown };
    return { x: lerp(ax.prevShown, ax.shown, alpha), y: lerp(ay.prevShown, ay.shown, alpha) };
  }
}
