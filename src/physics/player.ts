// PlayerObject: the per-player mutable state plus the parts of the decompiled
// PlayerObject that do not need the object list — the button's bytes and the
// touched-ring list, updateJump, the position integration (matcool
// PlayerObject::update), gravity flips, the pad, orb and slope launches, a
// force block's push, hitGround and the rotation updates. Collision
// resolution lives in collision.ts; orchestration, the press's rings
// included, in sim.ts.
//
// Field names follow the gdp/matcool member names where they exist so the
// comments can point at decomp lines. Units: see constants.ts.

import type { GameMode, Speed } from "../level/types";
import type { OrbType, PlayerState, SimEvent } from "./types";
import {
  BALL_AIR_ROLL_BASE,
  BALL_AIR_ROLL_V5,
  BALL_AIR_ROLL_V5_MINI,
  BALL_CLICK_FACTOR,
  BALL_ROLL_BASE,
  BALL_ROLL_SPEED_FACTOR,
  BALL_ROLL_V5,
  BALL_ROLL_V5_MINI,
  BLACK_ORB_FLYING_VELOCITY,
  BLACK_ORB_SPIDER_FACTOR,
  BLACK_ORB_UFO_FACTOR,
  BLACK_ORB_VELOCITY,
  BOOST_SPIN_SECONDS,
  BOOST_SPIN_SECONDS_MINI,
  CUBE_SPIN_SECONDS,
  CUBE_SPIN_SECONDS_MINI,
  DASH_DEG,
  DASH_SPIN_BASE,
  DASH_ART_SPIN,
  DASH_ART_SPIN_BASE,
  DASH_ART_SPIN_SLOPE,
  DASH_SPIN_FULL_SPEED,
  DASH_SPIN_MAX_FACTOR,
  DASH_SPIN_SLOPE,
  FLY_TOGGLE_VELOCITY_FACTOR,
  GRAVITY_FLIP_VELOCITY_FACTOR,
  FALL_SPIN_VELOCITY,
  FALL_UNGROUND2_VELOCITY,
  FLYING_GRAVITY,
  FLY_MAX_DOWN_FACTOR,
  FLY_MAX_UP,
  FORCE_BLOCK_PASSES,
  FORCE_MAX_LENGTH,
  FORCE_MODE_FACTOR,
  FORCE_MODE_FACTOR_MINI,
  FORCE_ROBOT_HOLD_DIVISOR,
  FORCE_ROBOT_HOLD_FACTOR,
  FORCE_SLIDE_EASE,
  FORCE_SLIDE_EASE_FREE,
  FORCE_SLIDE_END,
  FORCE_SLIDE_STOP,
  FORCE_SPIN_MIN_X,
  FRAME_DT,
  GAME_GROUND_Y,
  GRAVITY_FACTOR,
  GROUND_MODE_TERMINAL_VELOCITY,
  INNER_HITBOX_FACTOR,
  JUMP_DT_SCALE,
  LANDING_LATCH_MAX_VELOCITY,
  MINI_FLY_DIVISOR,
  MINI_JUMP_FACTOR,
  MINI_SCALE,
  ORB_BALL_SPIDER_FACTOR,
  ORB_FACTOR,
  ORB_SWING_FACTOR,
  PAD_BASE_VELOCITY,
  PAD_SLOW_MODE_FACTOR,
  PLATFORMER_ACCEL_FRAMES,
  PLATFORMER_DECEL_FRAMES,
  PLATFORMER_LAND_DELAY,
  PLATFORMER_MAX_SPEED_FACTOR,
  PLAYER_HITBOX,
  REVERSE_SYNC_SHARE,
  ROBOT_HOLD_ACCUM_FACTOR,
  ROBOT_HOLD_LIMIT,
  ROBOT_JUMP_FACTOR,
  ROTATION_ROBOT_AIR_DT_MULT,
  ROTATION_SLERP_BASE,
  ROTATION_SLERP_GROUND_MULT,
  ROTATION_SLERP_SHIP_MULT,
  SAFE_HEAD_SECONDS,
  SCALE_SNAP_PASSES,
  SHIP_BASE,
  SHIP_BASE_FALLING,
  SHIP_HOLD,
  SHIP_HOLD_RISING,
  SHIP_PLATFORMER_GRAVITY,
  SHIP_RELEASE_FALLING,
  SHIP_RELEASE_RISING,
  SHIP_ROTATION_INTERP,
  SHIP_ROTATION_MIN_MOVE,
  SHIP_ROTATION_SLOPE_FACTOR,
  SLOPE_BOOST_MIN_FACTOR,
  SLOPE_BOOST_RAMP_RATE,
  SLOPE_BOOST_RAMP_TIME,
  SLOPE_JUMP_BONUS,
  SLOPE_JUMP_CAP,
  SLOPE_JUMP_PLATFORMER_MIN_SPEED,
  SPEED_PARAMS,
  SPIDER_HITBOX,
  SWING_CLICK_FACTOR,
  SWING_GRAVITY,
  SWING_GRAVITY_MINI,
  TICKS_PER_SECOND,
  UFO_GRAVITY_BASE,
  UFO_GRAVITY_FALLING,
  UFO_GRAVITY_RISING,
  UFO_JUMP_VELOCITY,
  UFO_JUMP_VELOCITY_MINI_BASE,
  UFO_ROTATION_INTERP,
  UFO_SLOPE_BONUS,
  UFO_TILT_CLAMP_RAD,
  UFO_TILT_SCALE,
  WAVE_GROUND_SIZE,
  WAVE_HITBOX,
  WAVE_MINI_SLOPE,
  WAVE_ROTATION_INTERP,
  WAVE_ROTATION_INTERP_MINI,
  xSpeedFor,
  Y_VELOCITY_LIMIT,
  PLATFORM_LAUNCH_CAP,
  PLATFORM_LAUNCH_DROP,
  PLATFORM_LAUNCH_MIN,
} from "./constants";
import { DEG, slerp2D } from "./geometry";
import {
  EVENT_BALL_SWITCH,
  EVENT_FEATHER_LANDING,
  EVENT_HARD_LANDING,
  EVENT_NORMAL_JUMP,
  EVENT_NORMAL_LANDING,
  EVENT_ROBOT_BOOST_START,
  EVENT_ROBOT_BOOST_STOP,
  EVENT_SOFT_LANDING,
  EVENT_TINY_LANDING,
} from "./gameEvents";

/** What the player needs from the world: events, the spider's surface search and the level's flags. */
export interface PlayerWorld {
  emit(type: SimEvent["type"], player: 1 | 2, object?: number, detail?: string): void;
  /**
   * Raises a game event (GJGameEvent) for the Event triggers, as this player;
   * `object` is the one it came from, whose key 446 is the event's extra id.
   */
  gameEvent?(event: number, player: 1 | 2, object?: number): void;
  /** spiderTestJump: teleport `p` to the nearest surface against its gravity and flip it. */
  spiderJump(p: Player): void;
  readonly platformer: boolean;
  /**
   * Whether a dual is running. The game keeps a copy in each player (+2137),
   * written only when the dual toggles. [gdp GJBaseGameLayer::toggleDualMode,
   * gd-ida-decomp.cpp:462648-462649]
   */
  readonly dual: boolean;
  /** kA32, which both players carry as +1169. [resetLevelVariables :462956-462959] */
  readonly fixGravityBug: boolean;
  /** The mod menu's jump hack (SimCheats.jumpHack); absent is off. */
  readonly jumpHack?: boolean;
  /**
   * +2072 on both players, "boost slide": a platformer push slides out at
   * 0.05 a step whether or not a button is held. !kA45 at every reset, and
   * the Options trigger's key 593 sets it; a checkpoint keeps it.
   * [loadLevelSettings :430564-430565; resetPlayer :425077-425078;
   *  processOptionsTrigger :429856-429861; saveToCheckpoint :161568,
   *  loadFromCheckpoint :161736; read by updateMove :149273]
   */
  readonly boostSlide: boolean;
  /**
   * Object `i`'s position less its lastPosition along the player's y: the
   * world's x when gameplay is rotated (`swapped`). 0 for one that never
   * moved, or in a world with nothing that moves.
   * [gdp GameObject::getLastPosition :173378-173381]
   */
  objectRise?(i: number, swapped: boolean): number;
}

/**
 * The four modes whose toggle halves the y velocity and zeroes the angle, on
 * being turned on and on being turned off alike. `isFlying()` in the game is
 * true for exactly these four, which is not a coincidence: it reads the same
 * four flags. [gdp PlayerObject::isFlying, gd-ida-decomp.cpp:144427-144443]
 */
const FLY_TOGGLE_MODES: ReadonlySet<GameMode> = new Set<GameMode>(["ship", "ufo", "wave", "swing"]);

const MODE_INDEX: Record<GameMode, number> = { cube: 0, ship: 1, ball: 2, ufo: 3, wave: 4, robot: 5, spider: 6, swing: 7 };
export const MODE_BY_INDEX: GameMode[] = ["cube", "ship", "ball", "ufo", "wave", "robot", "spider", "swing"];

/** The orbs whose launch is a factor of the jump velocity. */
export type LaunchOrb = Extract<OrbType, "yellow" | "pink" | "red" | "blue" | "green">;

/**
 * setYVelocity's rounding: a velocity that is not a whole number keeps its
 * fraction to three decimals, rounded half away from zero. Every write the
 * game makes through setYVelocity or addToYVelocity takes it — gravity,
 * jumps, pads, orbs, the caps and clamps, copies. The halvings in flipGravity
 * and the four flying toggles, the ball's and the orbs' ×0.6 and ×0.7, a
 * gameplay turn's hand-over, update's ±1000, a platformer dash's own y
 * velocity (written every dash step over the rounded 0) and the push it ends
 * with write the double directly and are not rounded until the next write
 * that is.
 * [gdp PlayerObject::setYVelocity, gd-ida-decomp.cpp:141992-142007;
 *  addToYVelocity :142043-142047; the dash step :161035-161056, stopDashing
 *  :149800-149810]
 */
export function quantizeYVelocity(v: number): number {
  // (double)(int)v: the int of −0.4 is 0, and so is this.
  const whole = Math.trunc(v) || 0;
  if (v === whole) return v;
  const f = (v - whole) * 1000;
  // C's round() goes away from zero at a half; Math.round goes up.
  return whole + (f < 0 ? -Math.round(-f) : Math.round(f)) / 1000;
}

/**
 * The game keeps the player's position as a float point in its own space,
 * where y is this port's + 90. These are a world coordinate as storing it
 * there leaves it. [gdp PlayerObject::setPosition, gd-ida-decomp.cpp:143981;
 *  GameObject::setPosition :164602-164615; object y = atof + 90 :183970]
 */
export function floatX(x: number): number {
  return Math.fround(x);
}

export function floatY(y: number): number {
  return Math.fround(y + GAME_GROUND_Y) - GAME_GROUND_Y;
}

export class Player implements PlayerState {
  // --- PlayerState (public contract) ------------------------------------------
  x = 0;
  y = 0;
  yVel = 0;
  xSpeed = xSpeedFor(1);
  xVel = 0;
  mode: GameMode = "cube";
  speed: Speed = 1;
  mini = false;
  flipped = false;
  mirrored = false;
  reversed = false;
  onGround = false;
  onSlope = false;
  /** +2076, the camera's: see PlayerState. */
  lastGroundY = Number.NaN;
  rotation = 0;
  /**
   * +1909, the button as the game sees it: set by a press, cleared by the
   * release and by game logic while the button stays down — the ball's click,
   * the ball, spider and swing orbs, a claim-touch ring, the S and J blocks.
   * [gdp PlayerObject::pushButton :160450, releaseButton :159519]
   */
  holding = false;
  holdTicks = -1;
  dashing = false;
  dashAngle = 0;
  dead = false;
  finished = false;
  killedBy: number | null = null;
  /**
   * Whether the last bounds check found the player outside the level. Death
   * needs two in a row, so a single tick past the line is forgiven.
   * [gdp GJBaseGameLayer::checkCollisions `a2+2484`, read and cleared at
   *  gd-ida-decomp.cpp:464703-464707, written at :464882]
   */
  wasOutOfBounds = false;
  /**
   * A teleport has moved the player since its last collision pass, which then
   * leaves the dual band alone. Every teleport sets it; the next pass reads and
   * clears it.
   * [gdp GJBaseGameLayer::teleportPlayer `+1168`, gd-ida-decomp.cpp:462313-462315;
   *  checkCollisions :464675-464676, :464763; resetObject :153570]
   */
  teleported = false;
  /**
   * Gameplay turned a quarter: the player travels along y and falls along x.
   *
   * Everything about the player's own motion stays one-dimensional — gravity,
   * the jump, terminal velocity — and only the step it takes each tick is
   * written onto the other pair of axes. The sim does the matching work for
   * collision. [gdp PlayerObject byte 1971, set by rotateGameplay :152486]
   */
  rotated = false;
  /**
   * kA42 "Reverse Sync": how far a pad or orb that reversed the player still
   * has to move it along its way (+1984, a double), and the share of that the
   * next step's move adds (+1992). Both 0 without kA42.
   * [gdp PlayerObject::reversePlayer :148376-148389 charges it; update
   *  :161085, :161101-161113 pays it off; resetObject :153586-153587]
   */
  reverseOffset = 0;
  reverseSlice = 0;
  /**
   * `x` and `y` hold the world's y and x: set while collision runs in the
   * player's own frame for rotated gameplay (sim.ts swapPlayerAxes), false
   * between steps. Storing a coordinate needs it, because only the world's y
   * carries the game's 90.
   */
  axesSwapped = false;
  /** +1632, the last gravity flip, as a reading of `clock`: see isSafeFlip. */
  lastFlipTick = -1e9;
  /** +1592, the last mode change, as a reading of `clock`: see isSafeMode. */
  lastModeChangeTick = -1e9;

  // --- mode flags (kept in sync by setMode) ----------------------------------
  modeIndex = 0;
  isShip = false;
  isBall = false;
  isUfo = false;
  isWave = false;
  isRobot = false;
  isSpider = false;
  isSwing = false;
  isFlying = false;

  // --- updateTimeMod -------------------------------------------------------
  playerSpeed = SPEED_PARAMS[1].playerSpeed;
  yStart = SPEED_PARAMS[1].yStart;
  gravity = SPEED_PARAMS[1].gravity;
  speedMultiplier = SPEED_PARAMS[1].speedMultiplier;
  /**
   * +2356, the Gravity trigger's (2066) multiplier. It scales gravity and the
   * cube's spin rate; the trigger is not implemented, so it stays 1.
   * [gdp updateJump :155468-155475, runNormalRotation :144538; resetObject :153603]
   */
  gravityMod = 1;

  // --- input -----------------------------------------------------------------
  /**
   * The button as the last step's input left it. Presses and releases are
   * edges against this, never against `holding`, which the game clears on its
   * own while the button is still down.
   */
  rawHeld = false;
  wasJumpBuffered = false;
  /**
   * m_stateRingJump (+1910): a press nothing has spent yet — the UFO hop, the
   * swing's click, the robot's jump and every ring spend it.
   */
  stateRingJump = false;
  /**
   * +1914: stateRingJump as updateJumpVariables last copied it — at the press
   * and at the end of every update. A ring tests this, not the live byte.
   * [gd-ida-decomp.cpp:150816-150822; called :160454 and :161282]
   */
  canRingJump = false;
  /** PlayerState view of the two ring gates, for the debug page and the autoplayer's dedup. */
  get orbReady(): boolean {
    return this.canRingJump && this.holdingForOrb && !this.dashing;
  }
  /** +1913: `holding` as updateJumpVariables last copied it. */
  holdingForOrb = false;
  /** One ring of each family per press or update: +1915 normal, +1916 custom (toggle), +1917 teleport. */
  touchedRing = false;
  touchedCustomRing = false;
  touchedTeleportRing = false;
  /** +2225 and +2224: the platformer's left and right buttons are down. */
  leftHeld = false;
  rightHeld = false;
  /**
   * +2226: of the two direction buttons, left was pressed last, so it wins
   * while both are down. [gdp PlayerObject::switchedDirTo,
   * gd-ida-decomp.cpp:159446-159466; read by updateMove :149048]
   */
  leftPressedLast = false;

  // --- rings -------------------------------------------------------------------
  /**
   * m_touchingRings (+2084): the rings a press would take, oldest first. A ring
   * joins when a collision pass touches it and leaves when it fires, or when a
   * pass goes by without touching it — so at a press it holds what the last
   * two passes touched and nothing used up. Object indices.
   * [gdp addToTouchedRings, gd-ida-decomp.cpp:159801-159813; resetTouchedRings
   *  :153480-153500, called at :469851 right after the step's buttons]
   */
  readonly touchingRings: number[] = [];
  /** The set at +2088: the rings touched since the last resetTouchedRings. */
  readonly ringsThisPass: number[] = [];
  /**
   * +1700: the rings this press has fired. A new press empties it, which is
   * what lets a multi-activate ring fire again without being left.
   * [gdp pushButton :160453; ringJump :159898-159920]
   */
  readonly usedRings: number[] = [];

  // --- ground / boost bookkeeping -------------------------------------------------
  /** m_isOnGround2: grounded for rotation and animation purposes. */
  onGround2 = false;
  /**
   * m_maybeIsBoosted (+2060): rising after a jump or a launch, which sends
   * updateJump down its boosted branch — no terminal clamp, and the jump latch
   * is left alone. Only that branch's falling test ends it; a landing does not.
   * [writers gd-ida-decomp.cpp:147569, 147680, 151258, 152532, 153655, 155597,
   *  155774, 155952, 160148; hitGround 149979-150200 is not one of them]
   */
  maybeIsBoosted = false;
  /**
   * m_isAccelerating: the flying caps are skipped until the velocity is back
   * inside them. The red pad, the red and black orbs, a slope launch and a
   * quarter turn of gameplay set it, the turn unless its trigger has key 585
   * ("Dont Slide"); the yellow and pink pads clear it; portals, landings, the
   * blue and spider pads and every other orb leave it alone.
   * [gd-ida-decomp.cpp:147384, 147572, 157077-157085, 160343-160345, 160380;
   *  key 585 :152534-152535 → handlePlayerCommand(543) :142373-142379;
   *  cleared in updateJump :155726-155731]
   */
  isAccelerating = false;
  /**
   * The robot's held jump is the property of a *ground* jump and nothing else.
   * Releasing the button ends it, and only the next jump off the ground gives
   * it back — so an orb taken in mid-air never re-opens it, however long the
   * button is held afterwards. A yellow, pink, red or spider pad ends it too,
   * but only in a level with kA34 or in platformer; the blue pad never does.
   * Named for what it does; the binary calls it nothing.
   * [gdp releaseButton case 1, gd-ida-decomp.cpp:159517; bumpPlayer
   *  :157053-157054, +2408 = !kA34 at :430562-430563; cleared in updateJump's
   *  ground-jump branch :155778 and nowhere else]
   */
  robotHoldEnded = false;
  /** m_accelerationOrSpeed: robot hold accumulator. */
  robotHold = 0;
  lastLandTick = -1e9;
  /** m_isOnGround as it stood before this tick's updateJump, so a "land" event fires once per landing. */
  wasOnGround = false;
  lastX = 0;
  lastY = 0;
  /**
   * The gravity-side half of the last update's step, taken before rotated
   * gameplay swaps it onto x (+2164, a float). The move commands hold player 1's y
   * delta against it. [gdp PlayerObject::update :161027, :161081; read by
   * GJBaseGameLayer::update :469865]
   */
  stepY = 0;
  /** Object index landed on (m_unk50C/510), never treated as a head hit the same tick. */
  lastFloorObj = -1;
  /**
   * The block that last put the player on its right (+1304) or its left
   * (+1308), -1 for none. Met again, it puts the player on the same side and
   * needs no more than a touch. Each forgets its block on a step with no
   * wall logged on its side. [gdp updateCollideLeft :142883-142884,
   * updateCollideRight :142922-142923; read by collidedWithObjectInternal
   * :152292-152310; cleared by postCollision :159172-159175]
   */
  wallLeftObj = -1;
  wallRightObj = -1;

  // --- slopes ----------------------------------------------------------------
  /** +1953: on a slope when this pass began (preCollision copies +1952 into it). */
  wasOnSlope = false;
  collidingWithSlope = false;
  /** m_currentSlope (+1384) object index, -1 when none. */
  slopeIdx = -1;
  /**
   * +1400: the slope the player last stood on, as an object index, -1 for
   * none. Unlike m_currentSlope it outlasts the slope's exit, and only a
   * collision pass that ends off every slope, and began off one, clears it.
   * preSlopeCollision lets this slope through without its edge strips.
   * [gd-ida-decomp.cpp:157768-157770 (set), 159203-159209 (cleared)]
   */
  slopeUid = -1;
  /**
   * +1328: the y speed of a moving block or slope met this pass, moving
   * toward the player's feet, per step of 1. postCollision moves it to +1336
   * and clears it.
   * [gd-ida-decomp.cpp:151605-151617, 157846-157866; 159188-159192]
   */
  platformYVel = 0;
  /** +1336: last pass's +1328, which the moving-platform launch reads. */
  lastPlatformYVel = 0;
  /**
   * +2200: updates left in which a moving platform cannot launch the player,
   * 2 after landing on a "don't boost Y" object.
   * [updateLastGroundObject :142737-142751; updateStateVariables :153702]
   */
  noBoostYPasses = 0;
  /** +1956: the velocity leaving the slope hands over, gravity-signed. */
  slopeVelocity = 0;
  /** +1832: the slope's own y speed, which running off its low end leaves the player with. */
  currentSlopeYVel = 0;
  slopeAngle = 0;
  /** m_slopeRotation (+1824, radians, signed). */
  slopeRotation = 0;
  /** +1859, the slope's slopeFloorTop: it is a ceiling slope, solid above its face. */
  slopeSolidAbove = false;
  /**
   * +1404, m_slopeFlipGravityRelated: the decomp's "playerUphill" — the player
   * is going down the slope. A gravity flip on or just off a slope turns it over.
   */
  slopeDescending = false;
  /** unk_584: radius/cos(angle) − radius, added to the solid snap threshold after a slope. */
  slopeExtra = 0;
  /** m_unk3d0: last y the slope placed the player at. */
  slopeLastY = NaN;
  slopeAtHigh = false;
  slopeAtLow = false;
  slopeUpsideDown = false;
  /** m_slopeStartTime, as a tick: set when a player not already on a slope attaches to one. */
  slopeStartTick = -1e9;
  /** +2304, as a tick: the pass the player last left a slope on. */
  slopeEndTick = -1e9;

  // --- rotation ----------------------------------------------------------------
  /**
   * +1480: a spin is running — runNormalRotation's, boostPlayer's backwards
   * one, or the ball's roll on the ground. The fall spin, a gameplay turn
   * and the platformer's steering start no spin over it; stopRotation ends
   * it.
   */
  spinning = false;
  /**
   * +1472, the rate the angle turns at in degrees a second (a float in the
   * game). The cube's spin and the ball's two rolls share it, as they do in
   * the game; updateRotation adds it whenever it is not 0.
   */
  spinSpeed = 0;
  /**
   * +1481: the rate is the ball's roll in the air (runBallRotation2), which
   * the next landing ends. [gd-ida-decomp.cpp:143823, hitGround :150177-150178]
   */
  ballAirRoll = false;
  /** +1476, the speed runBallRotation was last given: 1, or the slope's 1 / cos. */
  rotateSpeed = 1;
  /** +1376: that speed is not 1, and updateRotation scales the ball's roll by it. */
  ballRotating = false;

  // --- dash ------------------------------------------------------------------
  /**
   * +1184 and +1192, the dash's pair. In a platformer they are the velocity
   * the dash moves at, x then y, traded when gameplay is rotated. A classic
   * dash uses only +1192, as the slope: y per unit of the forward step. A
   * gameplay turn mid-dash trades the two in either mode.
   * [gdp PlayerObject::startDashing, gd-ida-decomp.cpp:148586-148690;
   *  rotateGameplay :152539-152549]
   */
  dashVelX = 0;
  dashVelY = 0;
  /** The orb that started the dash (+1216), or −1. */
  dashOrbIdx = -1;
  /**
   * What a platformer dash takes from its orb when it starts: the end boost
   * (key 588), stop slide (key 589), allow collide (key 587) and the longest
   * it may last in seconds (key 590, 0 for no limit). The game reads them off
   * the orb (+1216) as it needs them.
   */
  dashEndBoost = 0;
  dashStopSlide = false;
  dashAllowCollide = false;
  dashMaxDuration = 0;
  /** +1208, when a platformer dash started, as a tick. */
  dashStartTick = 0;
  /** When the dash started, as a tick. */
  dashClock = 0;
  /** When updateDashArt last restarted the icon's spin, as a tick. */
  dashArtClock = 0;
  /** The icon's spin while dashing, in degrees a second, clockwise; 0 for a mode that does not spin. */
  dashSpinRate = 0;

  // --- spider ------------------------------------------------------------------
  lastSpiderFlipTick = -1e9;

  // --- checkSnapJumpToObject --------------------------------------------------
  snapObj = -1;
  snapDistance = 0;

  // --- letter blocks (touchedObject sets LETTER_BLOCK_PASSES, update takes one off) ---
  /** H, +2348. */
  stateHitHead = 0;
  /** F, +2352. */
  stateFlipGravity = 0;
  /** J, +2340. */
  stateNoAutoJump = 0;
  /** D, +2344. */
  stateDartSlide = 0;
  /**
   * +1600: the last launch was a blue pad or a normal ring, and there has
   * been no press since — a J block then lets go of the button on landing.
   * [set :159941-159942, :463255; cleared by pushButton :160452]
   */
  padRingRelated = false;
  /**
   * +2212: collision passes left in which a platformer player that has just
   * grown back from mini lands with the 15-unit snap threshold. Set by
   * setMini, worn off by updateStateVariables with the letter blocks and
   * ended with them by resetStateVariables — except that in a platformer the
   * reset then grows the player back from 0.6 and sets it again, so every
   * start, respawn and player 2 spawn there begins with it (the sim does that).
   * [gd-ida-decomp.cpp:150416-150418, read :151523-151524, :153706, zeroed
   *  :153533, re-armed by resetObject :153659-153660]
   */
  scaleSnapPasses = 0;

  // --- force blocks (touchedObject adds to the vector, the next update pushes) ---
  /** +2360: set by a force block's touch, one off each update; the update pushes while it is above 0. */
  forcePasses = 0;
  /**
   * +2364 and +2368, a float point: the push the force blocks and circles
   * this pass touched add up to, emptied by every update.
   */
  forceX = 0;
  forceY = 0;
  /**
   * +2372: in a platformer, a force block's sideways push is still sliding
   * out. While it is set, updateMove eases the x velocity towards 0 by a
   * share of it each step instead of steering it the usual way, and it
   * clears once the x velocity is under 0.5. A reset clears it and a
   * checkpoint does not keep it.
   * [set by update :161417-161418; updateMove :149258-149286, :149448-149455;
   *  cleared by resetObject :153593, updateStaticForce :147450-147453 and
   *  handlePlayerCommand(543) :142373-142379]
   */
  forceSlide = false;
  /**
   * +2376: the force IDs (key 530) already counted this pass. Emptied by
   * every update, so it only ever holds what the pass since the last update
   * touched.
   */
  readonly forceIds: number[] = [];

  // --- squeeze (preCollision empties them, postCollision reads them) ---------
  /**
   * +1864 and +1872: the lowest ceiling (upside down, the highest) and the
   * highest floor (upside down, the lowest) this collision pass has met, as
   * the game stores them (see contactY); 0 for none. A gravity flip empties
   * both.
   */
  collideTop = 0;
  collideBottom = 0;
  /**
   * +1880 and +1888: the rightmost wall on the player's left and the leftmost
   * on its right that this pass has pushed a platformer player off, as the
   * game stores them (see contactX); 0 for none. A gravity flip leaves them.
   */
  collideLeft = 0;
  collideRight = 0;
  /**
   * +1240 to +1252, the collision log: the objects this step has recorded as
   * a ceiling, a floor, a wall on the left and one on the right, by index
   * (storeCollision, from the updateCollide calls that name an object). The
   * ground and the band's edges name none. postCollision destroys a player
   * one object has met both as a floor and as a ceiling, or in a platformer
   * as walls on both sides. Emptied at the top of every step, and by a
   * gravity flip or a gameplay turn.
   * [gdp PlayerObject::storeCollision :142440-142490; resetCollisionLog
   *  :142397-142420, from GJBaseGameLayer::update :469854-469856,
   *  flipGravity :151155 and rotateGameplay :152508]
   */
  readonly logTop: number[] = [];
  readonly logBottom: number[] = [];
  readonly logLeft: number[] = [];
  readonly logRight: number[] = [];

  /** Current tick, mirrored from the sim before every update. */
  tick = 0;
  /**
   * The player's game clock (+2144), counted in 240ths of a second of game
   * time: one a step, so it equals `tick`, except under a time warp below 1,
   * when each step adds only the warp's share. What the "seconds since"
   * checks measure (the *Tick fields hold readings of it). Mirrored from the
   * sim before every update. [gdp GJBaseGameLayer::update :469827, 469834-469835:
   *  +792 grows by the warped step v15 and is copied to both players]
   */
  clock = 0;
  /** The step's delta in 60ths of a second, as update last got it (0.25, less under a time warp). */
  stepDt = FRAME_DT;

  constructor(
    readonly world: PlayerWorld,
    readonly playerNo: 1 | 2,
  ) {}

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  flipMod(): number {
    return this.flipped ? -1 : 1;
  }

  reverseMod(): number {
    return this.reversed ? -1 : 1;
  }

  /** A coordinate on this player's own x axis, as the game's float position stores it. */
  roundX(v: number): number {
    return this.axesSwapped ? floatY(v) : floatX(v);
  }

  /** A coordinate on this player's own y axis, as the game's float position stores it. */
  roundY(v: number): number {
    return this.axesSwapped ? floatX(v) : floatY(v);
  }

  /** setPositionX, in whichever frame the player is in. */
  setX(v: number): void {
    this.x = this.roundX(v);
  }

  /** setPositionY, in whichever frame the player is in. */
  setY(v: number): void {
    this.y = this.roundY(v);
  }

  /** The world's x and y, whichever frame the player is in. */
  get worldX(): number {
    return this.axesSwapped ? this.y : this.x;
  }

  get worldY(): number {
    return this.axesSwapped ? this.x : this.y;
  }

  /** setPosition with a world point: spawns and teleports. */
  setWorldPosition(x: number, y: number): void {
    if (this.axesSwapped) {
      this.x = floatY(y);
      this.y = floatX(x);
    } else {
      this.x = floatX(x);
      this.y = floatY(y);
    }
  }

  /** setYVelocity: every write the game rounds. See quantizeYVelocity. */
  setYVelocity(v: number): void {
    this.yVel = quantizeYVelocity(v);
  }

  /** addToYVelocity: setYVelocity(v + yVel). [gd-ida-decomp.cpp:142043-142047] */
  addToYVelocity(v: number): void {
    this.yVel = quantizeYVelocity(v + this.yVel);
  }

  /**
   * A floor or ceiling as updateCollideTop and updateCollideBottom store it:
   * `edge`, on the player's own y axis, as a float in the game's space, where
   * 0 means none. With gameplay rotated the game turns each object a quarter
   * about the player before colliding with it, so what it stores is the
   * player's world y, as it stood when that object's turn began, plus the
   * edge's distance along the gravity axis from where it stood. In the
   * mirror that is `pivotX + edge − pivotY`.
   * [gdp PlayerObject::rotateGameplayObject, gd-ida-decomp.cpp:154412-154413;
   *  handleRotatedCollisionInternal :158056-158074]
   */
  contactY(edge: number, pivotX: number, pivotY: number): number {
    return Math.fround((this.axesSwapped ? pivotX + (edge - pivotY) : edge) + GAME_GROUND_Y);
  }

  /**
   * updateCollideBottom: a floor this pass met; the highest counts, upside
   * down the lowest. `pivotX`/`pivotY`: see contactY. `object` goes in the
   * collision log, -1 for none.
   * [gdp PlayerObject::updateCollideBottom, gd-ida-decomp.cpp:142767-142800]
   */
  updateCollideBottom(edge: number, pivotX = this.x, pivotY = this.y, object = -1): void {
    const v = this.contactY(edge, pivotX, pivotY);
    const b = this.collideBottom;
    if (b === 0 || (this.flipped ? v < b : v > b)) this.collideBottom = v;
    logCollision(this.logBottom, object);
  }

  /**
   * updateCollideTop: a ceiling this pass met; the lowest counts, upside down
   * the highest. [gdp PlayerObject::updateCollideTop, gd-ida-decomp.cpp:142817-142849]
   */
  updateCollideTop(edge: number, pivotX = this.x, pivotY = this.y, object = -1): void {
    const v = this.contactY(edge, pivotX, pivotY);
    const t = this.collideTop;
    if (t === 0 || (this.flipped ? v > t : v < t)) this.collideTop = v;
    logCollision(this.logTop, object);
  }

  /** resetCollisionLog: the log empty. [gd-ida-decomp.cpp:142397-142420] */
  resetCollisionLog(): void {
    this.logTop.length = 0;
    this.logBottom.length = 0;
    this.logLeft.length = 0;
    this.logRight.length = 0;
  }

  /**
   * A wall as updateCollideLeft and updateCollideRight store it: `edge`, on
   * the player's own x axis, as a float in the game's space, where 0 means
   * none. With gameplay rotated the game's quarter turn about the player
   * (see contactY) lays the object's x the other way from the mirror's: what
   * it stores is the player's world x, as it stood when that object's turn
   * began, less the edge's distance along the mirror's x from where it stood.
   * In the mirror that is `pivotY − (edge − pivotX)`, and a wall on the
   * mirror's left is one on the game's right.
   * [gdp PlayerObject::rotateGameplayObject, gd-ida-decomp.cpp:154412-154413]
   */
  contactX(edge: number, pivotX: number, pivotY: number): number {
    return Math.fround(this.axesSwapped ? pivotY - (edge - pivotX) : edge);
  }

  /**
   * updateCollideLeft: a wall on the player's left, in the game's frame, that
   * this pass pushed it off; the rightmost counts, whichever way up.
   * `pivotX`/`pivotY`: see contactX.
   * [gdp PlayerObject::updateCollideLeft, gd-ida-decomp.cpp:142864-142887]
   */
  updateCollideLeft(edge: number, pivotX = this.x, pivotY = this.y, object = -1): void {
    const v = this.contactX(edge, pivotX, pivotY);
    const l = this.collideLeft;
    if (l === 0 || v > l) this.collideLeft = v;
    logCollision(this.logLeft, object);
    if (object >= 0) {
      this.wallLeftObj = object;
      this.wallRightObj = -1;
    }
  }

  /**
   * updateCollideRight: a wall on the player's right; the leftmost counts.
   * [gdp PlayerObject::updateCollideRight, gd-ida-decomp.cpp:142903-142926]
   */
  updateCollideRight(edge: number, pivotX = this.x, pivotY = this.y, object = -1): void {
    const v = this.contactX(edge, pivotX, pivotY);
    const r = this.collideRight;
    if (r === 0 || v < r) this.collideRight = v;
    logCollision(this.logRight, object);
    if (object >= 0) {
      this.wallRightObj = object;
      this.wallLeftObj = -1;
    }
  }

  /** postCollision: a side with no wall logged this step forgets its block. [:159172-159175] */
  forgetWalls(): void {
    if (this.logLeft.length === 0) this.wallLeftObj = -1;
    if (this.logRight.length === 0) this.wallRightObj = -1;
  }

  /** Gravity-relative value: positive = away from the floor. */
  rel(v: number): number {
    return this.flipped ? -v : v;
  }

  /** isInNormalMode: the cube — not flying, not the ball, robot or spider. [gd-ida-decomp.cpp:145258-145270] */
  isInNormalMode(): boolean {
    return !this.isFlying && !this.isBall && !this.isRobot && !this.isSpider;
  }

  /** m_vehicleSize */
  vehicleSize(): number {
    return this.mini ? MINI_SCALE : 1;
  }

  /**
   * +648/+652, the box before its scale: 27 for the spider, 10 for the wave,
   * 30 for everything else, whatever the size.
   * [gdp toggleSpiderMode :152721-152723, toggleDartMode :153041-153043,
   *  resetPlayerIcon :148112-148114]
   */
  boxSize(): number {
    return this.isSpider ? SPIDER_HITBOX : this.isWave ? WAVE_HITBOX : PLAYER_HITBOX;
  }

  /**
   * Main hitbox side: getObjectRect(), the box times the vehicle scale — 30,
   * spider 27, wave 10, and 18, 16.2 and 6 when mini.
   * [gdp GameObject::getObjectRect :163366-163371 → getObjectRect2 with +764/+768,
   *  the scale togglePlayerScale writes :150441-150442]
   */
  hitboxSize(): number {
    return this.boxSize() * this.vehicleSize();
  }

  /**
   * Inner solid-death rect side: getObjectRect(0.3, 0.3), which scales the
   * unscaled box and never the vehicle scale — 9 for every mode at both sizes,
   * spider 8.1, wave 3. [gdp GameObject::getObjectRect(float, float),
   * gd-ida-decomp.cpp:170812-170848; called from collidedWithObjectInternal :152369]
   */
  innerSize(): number {
    return this.boxSize() * INNER_HITBOX_FACTOR;
  }

  /**
   * Switches game mode, the way the game does it: as two toggles.
   *
   * A mode portal does not call one "set the mode" function. It calls
   * `switchedToMode(newId)`, which turns every *other* mode off, and then the
   * new mode's own `toggle*Mode(1)`. Each toggle's whole body sits inside
   * `if (flag != argument)`, so on one portal exactly two of them fire: the old
   * mode's off and the new mode's on. That matters because four of the seven —
   * fly (ship), bird (UFO), dart (wave) and swing — carry `yVel *= 0.5` and
   * `setRotation(0)` inside that guard, and therefore apply them when the mode
   * is turned *off* just as much as when it is turned on. Roll (ball), robot
   * and spider carry neither.
   *
   * So a wave entering a ship portal is halved twice and leaves at a quarter of
   * its vertical speed, pointing straight ahead — not at the wave's 45° with the
   * wave's speed, which is what this port used to do and what made those
   * transitions frame-perfect where the real game forgives them.
   *
   * The angle is written by `setRotation`, never by `stopRotation`, which only
   * zeroes the rotation *rate*. Leaving the ball or the swing stands the player
   * upright for the current gravity instead of at zero; entering robot or spider
   * zeroes it; entering the ball or the cube leaves whatever the off toggle left.
   *
   * Every toggle that fires stops the spin. The ship, UFO, wave and swing
   * toggles also call resetPlayerIcon on the way out, which runs
   * runRotateAction for whatever mode the player is left in; every mode but
   * the cube has a toggle of its own that stops it again straight after, so
   * only a cube that was flying comes out spinning. A ball does not roll
   * until it next meets the ground (hitGround). A portal of the mode the
   * player is already in fires no toggle and changes nothing.
   * [stopRotation in every toggle, gd-portal-modes.md; resetPlayerIcon :148115,
   *  called at :152883, :152981, :153085, :152627 (and :152772 for the spider,
   *  whose stopRotation at :152775 follows it); toggleRollMode's :153170]
   *
   * [gdp PlayerObject::switchedToMode 152656-152673 and the seven toggles
   *  152569-153283; halvings at 152586 / 152819 / 152930 / 153032. Table and
   *  derivation in data/ref/gd-portal-modes.md]
   */
  setMode(mode: GameMode): void {
    const left = this.mode;
    if (mode !== left) {
      this.lastModeChangeTick = this.clock;
      const wasFlying = FLY_TOGGLE_MODES.has(left);
      const willFly = FLY_TOGGLE_MODES.has(mode);

      // The off toggle, then the on toggle. Each halving is a raw write to the
      // double, so neither goes through setYVelocity's quantisation.
      if (wasFlying) this.yVel *= FLY_TOGGLE_VELOCITY_FACTOR;
      if (willFly) this.yVel *= FLY_TOGGLE_VELOCITY_FACTOR;

      if (wasFlying) this.rotation = 0;
      if (left === "swing" || left === "ball") this.rotation = this.flipped ? 180 : 0;
      if (willFly || mode === "robot" || mode === "spider") this.rotation = 0;

      // Both toggles that share the accumulator start it spent, and that is
      // what keeps a robot portal taken in mid-air from handing out a hold: the
      // portal leaves the boost flag set.
      // [gdp toggleRobotMode :153225, toggleSpiderMode :152724 — both write 1.5]
      if (mode === "robot" || mode === "spider") this.robotHold = ROBOT_HOLD_LIMIT;

      // The four flying toggles clear both ground flags, +2044 and +1969, and
      // the visual streak flag +1603. Neither toggle touches the boost or the
      // accelerating flag. [gdp toggleFlyMode :152821-152823, and the same
      // lines in the other three]
      if (wasFlying || willFly) {
        this.onGround = false;
        this.onGround2 = false;
      }
    }
    this.mode = mode;
    this.modeIndex = MODE_INDEX[mode];
    this.isShip = mode === "ship";
    this.isBall = mode === "ball";
    this.isUfo = mode === "ufo";
    this.isWave = mode === "wave";
    this.isRobot = mode === "robot";
    this.isSpider = mode === "spider";
    this.isSwing = mode === "swing";
    this.isFlying = this.isShip || this.isUfo || this.isWave || this.isSwing;
    if (mode !== left) {
      this.stopRotation();
      if (mode === "cube" && FLY_TOGGLE_MODES.has(left)) this.runRotateAction();
      // modeDidChange, which every toggle that fires ends with. [:145569-145572]
      if (this.dashing) this.updateDashArt();
    }
  }

  /**
   * togglePlayerScale: the size portal, and a twin taking the other's size.
   * Growing back to full size in a platformer gives the next two collision
   * passes the 15-unit snap threshold, so a player that grew into a block
   * underfoot is lifted onto it. A ball whose ground roll is running (+1480
   * — an air roll after a flip is not) goes through runRotateAction, so it
   * rolls afresh at speed 1 and the new size's rate. Past that the scale is
   * all this port needs: every box is measured through vehicleSize().
   * [gdp PlayerObject::togglePlayerScale, gd-ida-decomp.cpp:150392-150442,
   *  the roll :150499-150502; read at collidedWithObjectInternal
   *  :151523-151524]
   */
  setMini(mini: boolean): void {
    if (this.mini === mini) return;
    if (!mini && this.world.platformer) this.scaleSnapPasses = SCALE_SNAP_PASSES;
    this.mini = mini;
    if (this.isBall && this.spinning) this.runRotateAction();
  }

  /**
   * updateTimeMod: speed portal / start speed. A ball goes through
   * runRotateAction whatever it was doing, so it rolls on the ground's way at
   * the new speed's rate, in the air too.
   * [gdp PlayerObject::updateTimeMod, gd-ida-decomp.cpp:150522-150576, the
   *  roll :150569-150570]
   */
  setSpeed(speed: Speed): void {
    this.speed = speed;
    const p = SPEED_PARAMS[speed];
    this.playerSpeed = p.playerSpeed;
    this.yStart = p.yStart;
    this.gravity = p.gravity;
    this.speedMultiplier = p.speedMultiplier;
    this.xSpeed = p.playerSpeed * p.speedMultiplier;
    if (this.isBall) this.runRotateAction();
  }

  /**
   * playerIsFallingBugged: the "is it falling" test updateJump makes whenever it
   * decides to end a boost, drop the jump latch or clear +2044, and to pick the
   * ship's and the UFO's gravity factors.
   *
   * With kA32, in platformer, for the swing and in rotated gameplay it is true
   * unless the player is rising faster than 2g. Otherwise the game keeps the
   * test it shipped with, which only works for a player on normal gravity
   * outside a dual: upside down it is `yVel > 2g` in world terms, and in
   * a dual the normal-gravity player is held to `yVel < −2g`. Either way it is
   * true only once the player *falls* faster than 2g, so the jump latch
   * outlives a ledge — 9 more ticks for the cube, 10 for the robot, 15 for the
   * ball and spider — a landing keeps the boost while it stands, and in the
   * ±2g band a flipped or dual ship thrusts with 0.4 and falls with 1.2, and a
   * UFO falls with 1.2. Only the upside-down threshold is a double; the others
   * are floats.
   * [gdp PlayerObject::playerIsFallingBugged, gd-ida-decomp.cpp:144334-144360;
   *  playerIsFalling :144307-144319; read at :155520, 155527, 155595, 155674,
   *  155949, 155983, 156022]
   */
  fallingBugged(): boolean {
    const g = this.gravity;
    if (this.rotated || this.world.platformer || this.isSwing || this.world.fixGravityBug) {
      const twoG = Math.fround(g + g);
      return this.flipped ? this.yVel > -twoG : this.yVel < twoG;
    }
    if (this.flipped) return this.yVel > g + g;
    const v5 = Math.fround(this.world.dual ? -g : g);
    return this.yVel < Math.fround(v5 + v5);
  }

  // ---------------------------------------------------------------------------
  // input
  // ---------------------------------------------------------------------------

  /**
   * The bytes pushButton(Jump) sets before it looks at the rings: the button
   * is down and fresh, the pad-or-ring flag is off, no ring is used yet. Every
   * mode sees the press in the same step's updateJump; nothing latches it.
   * The rings and the immediate jump are the sim's (SimImpl.pushButton).
   * [gdp PlayerObject::pushButton, gd-ida-decomp.cpp:160450-160454]
   */
  pressButton(): void {
    this.holding = true;
    this.stateRingJump = true;
    this.padRingRelated = false;
    this.usedRings.length = 0;
    this.updateJumpVariables();
  }

  /**
   * releaseButton(Jump): lets go, ends the robot's held jump — it stays ended
   * until the robot next leaves the ground under its own power — and ends a
   * dash on the spot, before this step's movement, so the release step
   * already falls under gravity from the dash's 0. The dash ends whatever
   * `holding` says. [gdp PlayerObject::releaseButton, gd-ida-decomp.cpp:159516-159524]
   */
  releaseButton(): void {
    this.robotHoldEnded = true;
    this.holding = false;
    this.stateRingJump = false;
    if (this.dashing) this.stopDashing();
  }

  /** updateJumpVariables: what a ring tests from here on. [gd-ida-decomp.cpp:150814-150822] */
  updateJumpVariables(): void {
    this.holdingForOrb = this.holding;
    this.canRingJump = this.stateRingJump;
    this.touchedRing = false;
    this.touchedCustomRing = false;
    this.touchedTeleportRing = false;
  }

  /** addToTouchedRings. [gd-ida-decomp.cpp:159801-159813] */
  addToTouchedRings(i: number): void {
    if (!this.touchingRings.includes(i)) this.touchingRings.push(i);
    if (!this.ringsThisPass.includes(i)) this.ringsThisPass.push(i);
  }

  /** resetTouchedRings(false): keep what the last pass touched, then start a new pass. [gd-ida-decomp.cpp:153480-153500] */
  resetTouchedRings(): void {
    const kept = this.ringsThisPass;
    const list = this.touchingRings;
    let n = 0;
    for (let k = 0; k < list.length; k++) if (kept.includes(list[k])) list[n++] = list[k];
    list.length = n;
    kept.length = 0;
  }

  /** A ring that fired leaves the list. [gdp ringJump, gd-ida-decomp.cpp:159940] */
  dropTouchedRing(i: number): void {
    const at = this.touchingRings.indexOf(i);
    if (at >= 0) this.touchingRings.splice(at, 1);
  }

  /**
   * updateStateVariables: each letter block's hold wears off one update after
   * the last pass that touched it. The game's counters run on below zero;
   * every reader tests the sign, so stopping at 0 is the same and keeps the
   * state hash from telling apart two players that differ only in how long ago.
   * +2212, the platformer's grown-back snap, and the force blocks' counter wear
   * off the same way, and the force vector and its force IDs start again empty.
   * [gd-ida-decomp.cpp:153691-153716, called at the end of update :161283]
   */
  private updateStateVariables(): void {
    if (this.stateHitHead > 0) this.stateHitHead--;
    if (this.stateFlipGravity > 0) this.stateFlipGravity--;
    if (this.stateNoAutoJump > 0) this.stateNoAutoJump--;
    if (this.stateDartSlide > 0) this.stateDartSlide--;
    if (this.scaleSnapPasses > 0) this.scaleSnapPasses--;
    if (this.forcePasses > 0) this.forcePasses--;
    if (this.noBoostYPasses > 0) this.noBoostYPasses--;
    this.forceX = 0;
    this.forceY = 0;
    this.forceIds.length = 0;
  }

  /**
   * touchedObject for a force block or circle: the counter is set, and the
   * push `(fx, fy)` joins this pass's vector — unless it carries a force ID
   * another object has already added this pass. A vector longer than
   * FORCE_MAX_LENGTH is scaled back to it. Float arithmetic throughout, as
   * the game's CCPoint does it. [gdp PlayerObject::touchedObject,
   * gd-ida-decomp.cpp:159675-159698]
   */
  touchForce(fx: number, fy: number, id: number): void {
    this.forcePasses = FORCE_BLOCK_PASSES;
    if (id > 0) {
      if (this.forceIds.includes(id)) return;
      this.forceIds.push(id);
    }
    let x = Math.fround(this.forceX + fx);
    let y = Math.fround(this.forceY + fy);
    const length = Math.fround(Math.sqrt(Math.fround(Math.fround(x * x) + Math.fround(y * y))));
    if (length > FORCE_MAX_LENGTH) {
      const k = Math.fround(FORCE_MAX_LENGTH / length);
      x = Math.fround(x * k);
      y = Math.fround(y * k);
    }
    this.forceX = x;
    this.forceY = y;
  }

  /**
   * updateStaticForce, a Teleport's key 345: a push of `force` along `angle`
   * degrees, written straight into the velocities through updatePlayerForce
   * (raw, not rounded to thousandths): the y part onto the y velocity and, in
   * a platformer, the x part onto the x velocity, the two trading places
   * while gameplay is rotated, as the y velocity is then the world's x; set
   * outright, or added with `add` (key 443).
   * Any push lets a flyer past its caps. No force and no add stops the player
   * on both axes and holds it to its caps again.
   * [gdp PlayerObject::updateStaticForce, gd-ida-decomp.cpp:147416-147455;
   *  updatePlayerForce :147375-147395; the angle is a float times the float
   *  pi/180 (DASH_DEG), cocos2d::ccpForAngle and getLength in floats]
   */
  updateStaticForce(angle: number, force: number, add: boolean): void {
    if (force === 0 && !add) {
      this.isAccelerating = false;
      this.yVel = 0;
      if (this.world.platformer) {
        this.xVel = 0;
        this.forceSlide = false;
      }
      return;
    }
    const a = Math.fround(angle * DASH_DEG);
    let vx = Math.fround(Math.cos(a));
    let vy = Math.fround(Math.sin(a));
    const len = Math.fround(Math.sqrt(Math.fround(Math.fround(vx * vx) + Math.fround(vy * vy))));
    if (!(len > 0)) return;
    const k = Math.fround(force / len);
    vx = Math.fround(vx * k);
    vy = Math.fround(vy * k);
    if (this.rotated) {
      const t = vx;
      vx = vy;
      vy = t;
    }
    this.isAccelerating = true;
    this.yVel = add ? this.yVel + vy : vy;
    if (this.world.platformer) this.xVel = add ? this.xVel + vx : vx;
  }

  /**
   * The push, in the update after a pass touched a force block or circle.
   * The vector's y part, times the mode's share, goes onto the y velocity,
   * which is the world's x while gameplay is rotated; a non-zero one lets a
   * ship, UFO or swing past its caps (+1858), and one away from the floor
   * feeds the robot's hold accumulator. In a platformer the x part goes onto
   * the x velocity, and a cube pushed sideways harder than 0.1 starts
   * spinning. The update after the player has left runs it with the empty
   * vector, which still rounds the y velocity.
   *
   * A non-zero x push also sets forceSlide (+2372), which updatePlatformerX
   * reads until the push has slid out.
   * [gdp PlayerObject::update, gd-ida-decomp.cpp:161032, 161355-161424; +2372
   *  set at :161417-161418, read by updateMove :149258-149286]
   */
  private applyForce(dt: number): void {
    const k = (this.mini ? FORCE_MODE_FACTOR_MINI[this.mode] : undefined) ?? FORCE_MODE_FACTOR[this.mode];
    const v = Math.fround(Math.fround(dt * this.forceY) * k);
    this.addToYVelocity(v);
    if (v !== 0) this.isAccelerating = true;
    if (this.flipped ? v < 0 : v > 0) this.robotHold += (v / FORCE_ROBOT_HOLD_DIVISOR) * FORCE_ROBOT_HOLD_FACTOR;
    if (this.world.platformer) {
      this.xVel += Math.fround(this.forceX * dt);
      if (this.forceX !== 0) this.forceSlide = true;
      if (this.isInNormalMode() && !this.spinning && Math.abs(this.forceX) > FORCE_SPIN_MIN_X) this.runNormalRotation(true, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // PlayerObject::update (matcool) — one 240 Hz tick, dt = 0.25
  // ---------------------------------------------------------------------------

  update(dt: number): void {
    // ±1000, on the double, before anything reads it. [gd-ida-decomp.cpp:160995-161003]
    if (this.yVel > Y_VELOCITY_LIMIT) this.yVel = Y_VELOCITY_LIMIT;
    else if (this.yVel < -Y_VELOCITY_LIMIT) this.yVel = -Y_VELOCITY_LIMIT;
    this.stepDt = dt;
    this.lastX = this.x;
    this.lastY = this.y;
    this.wasOnGround = this.onGround;
    // v24, a float: what updateJump gets and what the y velocity is
    // integrated over. [gd-ida-decomp.cpp:161030-161031]
    const dtSlow = Math.fround(dt * JUMP_DT_SCALE);
    this.updateJump(dtSlow);
    // A force block's push, between the jump and the dash's 0. [:161032-161057]
    if (this.forcePasses > 0) this.applyForce(dtSlow);
    if (this.dashing) this.setYVelocity(0);

    let velX: number;
    if (this.world.platformer) {
      // updateMove does not steer a dashing player. [:149478-149481]
      if (!this.dashing) this.updatePlatformerX(dt, dtSlow);
      this.updateFacing(dtSlow);
      velX = dt * this.xVel;
    } else {
      velX = dt * this.speedMultiplier * this.playerSpeed * this.reverseMod();
    }
    let velY = dtSlow * this.yVel;
    if (this.dashing) {
      if (this.world.platformer) {
        // The dash's own pair: x into the x velocity, y straight over the
        // rounded 0, and both halves of the step over v24, never turned round
        // for the facing. [gd-ida-decomp.cpp:161050-161058, 161082-161083]
        this.xVel = this.dashVelX;
        this.yVel = this.dashVelY;
        velX = this.dashVelX * dtSlow;
        velY = this.dashVelY * dtSlow;
      } else {
        // The slope times the forward step as it is before the facing turns
        // it round, so a reversed dash climbs the same way. [:161044, 161060,
        // 161082-161083]
        velY = this.dashVelY * velX * this.reverseMod();
      }
    } else if (this.isWave) {
      // Exact 45° (mini 63.4°): the wave's y motion uses the unscaled dt. [mat lines 56-60]
      velY = (this.holding ? 1 : -1) * (this.flipped ? -1 : 1) * Math.abs(velX);
      if (this.mini) velY *= WAVE_MINI_SLOPE;
    }
    // The step goes over as a float point and is added to the float position
    // in the game's space, where y is this port's + 90; +2164 keeps the
    // gravity-side half as that float. Rotated gameplay swaps the two halves:
    // the forward step lands on y and the gravity step on x. Nothing else
    // about the motion changes.
    // [gdp PlayerObject::update, gd-ida-decomp.cpp:161071-161100]
    // The forward step carries the share of a reverse-sync offset the last
    // step set aside, before the turn swaps it. [:161082-161085]
    const stepX = Math.fround(velX + this.reverseSlice);
    this.stepY = Math.fround(velY);
    if (this.rotated) {
      this.x = Math.fround(this.x + this.stepY);
      this.y = Math.fround(this.y + GAME_GROUND_Y + stepX) - GAME_GROUND_Y;
    } else {
      this.x = Math.fround(this.x + stepX);
      this.y = Math.fround(this.y + GAME_GROUND_Y + this.stepY) - GAME_GROUND_Y;
    }
    // Then the next share: 2% of this step's forward speed, never more than
    // what is left, towards the offset's sign. [:161101-161113]
    this.reverseSlice = 0;
    if (this.reverseOffset !== 0) {
      const forward = this.world.platformer ? dt * this.xVel : dt * this.speedMultiplier * this.playerSpeed;
      let share = forward * REVERSE_SYNC_SHARE;
      const left = Math.abs(this.reverseOffset);
      if (left < share) share = left;
      if (this.reverseOffset <= 0) share = -share;
      this.reverseSlice = share;
      this.reverseOffset -= share;
    }

    // updateJumpVariables then updateStateVariables close PlayerObject::update;
    // the collision pass after it reads what they leave. [gd-ida-decomp.cpp:161282-161283]
    this.updateJumpVariables();
    this.updateStateVariables();
    // A platformer dash whose orb sets a longest time ends once it has run
    // past it, and lets go of the button. [:161296-161307]
    if (
      this.dashing &&
      this.world.platformer &&
      this.dashMaxDuration > 0 &&
      (this.clock - this.dashStartTick) / TICKS_PER_SECOND > this.dashMaxDuration
    ) {
      this.stopDashing();
      this.holding = false;
    }
  }

  /**
   * Platformer x velocity: a linear ramp to the classic speed over
   * PLATFORMER_ACCEL_FRAMES frames and a symmetric stop, in Vel units,
   * towards the direction held. [meas]
   *
   * While a force block's push slides out (forceSlide) it is updateMove's own
   * branch instead: the button held still steers, but only up to the top
   * speed and never clamped to it, and then the x velocity loses a share of
   * itself, 0.05 of it per 60th of the step (`dtMove`, update's 0.9 step)
   * with boost slide or a button held, 0.2 without; under 0.5 the slide is
   * over, and under 0.01 the player stops. The steering step is the ramp's.
   * [gdp PlayerObject::updateMove, gd-ida-decomp.cpp:149234-149236 (the
   *  steer), :149258-149286 (+2372 and the share), :149433-149455 (the ease);
   *  called with update's a2 × 0.9 :161043]
   */
  private updatePlatformerX(dt: number, dtMove: number): void {
    const max = this.speedMultiplier * this.playerSpeed * PLATFORMER_MAX_SPEED_FACTOR;
    const dir = this.heldDirection();
    if (this.forceSlide) {
      if (dir > 0 ? this.xVel < max : dir < 0 && this.xVel > -max) this.xVel += dir * (max / PLATFORMER_ACCEL_FRAMES) * dt;
      if (Math.abs(this.xVel) < FORCE_SLIDE_END) {
        this.forceSlide = false;
        if (dir !== 0) return;
      } else {
        const share = this.world.boostSlide || dir !== 0 ? FORCE_SLIDE_EASE : FORCE_SLIDE_EASE_FREE;
        this.xVel += -(share * this.xVel) * dtMove;
        if (Math.abs(this.xVel) < FORCE_SLIDE_STOP) {
          this.xVel = 0;
          this.forceSlide = false;
        }
        return;
      }
    }
    if (dir !== 0) {
      const a = (max / PLATFORMER_ACCEL_FRAMES) * dt;
      this.xVel += dir * a;
      if (this.xVel > max) this.xVel = max;
      if (this.xVel < -max) this.xVel = -max;
    } else {
      const d = (max / PLATFORMER_DECEL_FRAMES) * dt;
      if (this.xVel > d) this.xVel -= d;
      else if (this.xVel < -d) this.xVel += d;
      else this.xVel = 0;
    }
  }

  /**
   * The way the platformer's buttons steer: −1 left, 1 right, 0 neither. With
   * both down, the one pressed last wins.
   * [gdp PlayerObject::updateMove, gd-ida-decomp.cpp:149048-149084]
   */
  private heldDirection(): number {
    if (this.leftHeld && (!this.rightHeld || this.leftPressedLast)) return -1;
    return this.rightHeld ? 1 : 0;
  }

  /**
   * The facing and the spin, the part of the platformer's updateMove that
   * follows the x velocity.
   *
   * Steering left turns the player to face left (`reversed`, through
   * doReversePlayer) and steering right turns it back. On a turn, a cube not
   * spinning whose angle is between 45° and 135° or 225° and 315° — measured
   * from the slope it is on — turns half round, and a ship's or UFO's angle
   * changes sign. A dash keeps its facing.
   *
   * Then, for a cube: steering while it moves faster than 1 up or down starts
   * the spin if none is running, so a jump from a standstill spins once the
   * player steers; with nothing held, in the air, off any slope, not spinning
   * and off a right angle, it settles towards the nearest one.
   * [gdp PlayerObject::updateMove, gd-ida-decomp.cpp:149483-149559; called by
   *  update :161042-161043, after updateJump and the dash's y]
   */
  private updateFacing(dt: number): void {
    const dir = this.heldDirection();
    const normal = this.isInNormalMode();
    if (!this.dashing) {
      const was = this.reversed;
      if (dir < 0 && !was) this.doReversePlayer(true);
      else if (dir > 0 && was) this.doReversePlayer(false);
      if (this.reversed !== was) {
        if (!normal || this.spinning) {
          if (this.isShip || this.isUfo) this.rotation = -this.rotation;
        } else {
          const a = Math.abs(this.onSlope ? this.rotation - this.slopeRotation / DEG : this.rotation);
          if ((a > 45 && a < 135) || (a > 225 && a < 315)) this.rotation += 180;
        }
      }
    }
    const held = this.leftHeld || this.rightHeld;
    if (normal && this.xVel !== 0 && !this.spinning && held && Math.abs(this.yVel) > 1) {
      this.runRotateAction();
    } else if (
      normal &&
      !held &&
      !this.onSlope &&
      !this.wasOnSlope &&
      !this.onGround2 &&
      !this.spinning &&
      Math.trunc(this.rotation) % 90 !== 0
    ) {
      this.updateRotationTo(dt, this.convertToClosestRotation(0));
    }
  }

  // ---------------------------------------------------------------------------
  // PlayerObject::updateJump (gdp 2.2) — dt is already × 0.9
  // ---------------------------------------------------------------------------

  updateJump(dt: number): void {
    const flipMod = this.flipMod();
    const jumpBuffered = this.holding;
    // Robot needs a fresh press; everything else auto-jumps while held. [gdp line 110]
    const jumpBufferedAndRingJump = jumpBuffered && (this.stateRingJump || !this.isRobot);
    // v15 and v3: the gravity as a float, times the gravity trigger's
    // multiplier when that is not 1. `dt` is update's float v24, and every
    // velocity below is worked out in floats before it reaches the double
    // through setYVelocity or addToYVelocity. [gdp updateJump,
    // gd-ida-decomp.cpp:155459-155475]
    const usedGravity = this.isBall || this.isFlying || this.isSpider ? FLYING_GRAVITY : Math.fround(this.gravity);
    let floatC = this.gravityMod === 1 ? usedGravity : Math.fround(usedGravity * this.gravityMod);
    let v16 = this.mini ? MINI_JUMP_FACTOR : 1;

    if (this.isFlying) {
      // The decomp never clears m_isOnGround in the flying branch (only the
      // collision pass sets it), which leaves the flag stuck after any floor
      // contact. Clearing it here makes onGround mean "touched a floor this
      // tick" for every mode; the collision pass re-sets it right after. [meas]
      this.onGround = false;
      if (this.mini) v16 = MINI_FLY_DIVISOR;
      // m_isAccelerating ends once the velocity is back inside 8 up and 6.4
      // down, over the size factor, as floats. [gdp updateJump,
      // gd-ida-decomp.cpp:155485-155554]
      const v30 = Math.fround(FLY_MAX_UP / v16);
      const v33 = Math.fround(Math.fround(FLY_MAX_DOWN_FACTOR * -FLY_MAX_UP) / v16);
      const yv = this.yVel;
      if (this.flipped) {
        if (yv <= 0 && yv > -v30) this.isAccelerating = false;
        if (yv >= 0 && yv < -v33) this.isAccelerating = false;
      } else {
        if (yv >= 0 && yv < v30) this.isAccelerating = false;
        if (yv <= 0 && yv > v33) this.isAccelerating = false;
      }

      let v42 = FLY_MAX_DOWN_FACTOR;
      if (this.isShip) {
        // v51 (the game's v72): thrust while held, unless accelerating, where
        // only a ship moving toward the floor thrusts back; released and rising
        // it falls at 1.2. [gdp updateJump, gd-ida-decomp.cpp:155492-155521]
        let v51 = SHIP_HOLD_RISING;
        if (this.isAccelerating) {
          if (this.rel(this.yVel) < 0) v51 = SHIP_HOLD;
        } else if (jumpBuffered) {
          v51 = SHIP_HOLD;
        } else {
          v51 = SHIP_RELEASE_FALLING;
        }
        if (!jumpBuffered && !this.fallingBugged()) v51 = SHIP_RELEASE_RISING;

        // v73: the thrust base is 0.5 only while the button is held and the
        // ship is falling; released or rising it is 0.4. [gdp updateJump,
        // gd-ida-decomp.cpp:155527-155531]
        const v52 = jumpBuffered && this.fallingBugged() ? SHIP_BASE_FALLING : SHIP_BASE;
        if (this.world.platformer) floatC = Math.fround(floatC * SHIP_PLATFORMER_GRAVITY);
        // Thrust (v51 < 0) uses the raw flying gravity, without the gravity
        // trigger or the platformer factor. [155523-155526]
        if (v51 < 0) floatC = usedGravity;
        // [:155533-155536]
        this.addToYVelocity(-Math.fround(Math.fround(Math.fround(Math.fround(Math.fround(floatC * dt) * flipMod) * v51) * v52) / v16));
        if (jumpBuffered) this.onGround2 = false;
      } else if (this.isUfo) {
        if (this.stateRingJump && jumpBuffered) {
          this.stateRingJump = false;
          const v34 = this.mini ? UFO_JUMP_VELOCITY_MINI_BASE : UFO_JUMP_VELOCITY;
          // [:155692-155706]
          const v37 = Math.fround(flipMod * v34 * v16);
          if (this.flipped ? v37 < this.yVel : v37 > this.yVel) {
            this.setYVelocity(v37);
            if ((this.wasOnSlope || this.onSlope) && this.slopeVelocity > 0) {
              // The cap is a float, taken before the bonus. [:155707-155721]
              const v39 = Math.fround(this.yVel * SLOPE_JUMP_CAP);
              this.addToYVelocity(Math.fround(this.slopeVelocity * UFO_SLOPE_BONUS));
              this.setYVelocity(this.yVel > v39 ? v39 : this.yVel);
            }
            this.world.emit("jump", this.playerNo, undefined, "ufo");
          }
        }
        const v41 = this.fallingBugged() ? UFO_GRAVITY_FALLING : UFO_GRAVITY_RISING;
        // [:155674-155681]
        this.addToYVelocity(-Math.fround(Math.fround(Math.fround(Math.fround(Math.fround(floatC * dt) * flipMod) * v41) * UFO_GRAVITY_BASE) / v16));
        if (jumpBuffered) this.onGround2 = false;
      } else if (this.isWave) {
        // Direction only; the position integration uses ±velX directly. [gdp updateJump :155636-155649]
        this.setYVelocity(this.playerSpeed * this.speedMultiplier * flipMod * (jumpBuffered ? 1 : -1));
      } else {
        // swing
        if (this.stateRingJump && jumpBuffered) {
          const v66 = this.yVel;
          this.stateRingJump = false;
          this.flipGravity(!this.flipped);
          // The velocity before the flip, as a float, × 0.8. [:155604-155615]
          this.setYVelocity(Math.fround(Math.fround(v66) * SWING_CLICK_FACTOR));
          this.world.emit("jump", this.playerNo, undefined, "swing");
        }
        const v67 = this.mini ? SWING_GRAVITY_MINI : SWING_GRAVITY;
        // Read after the click: the tick it flips on already falls the new way.
        // [gdp updateJump, gd-ida-decomp.cpp:155612 then 155622-155627]
        this.addToYVelocity(-Math.fround(v67 * Math.fround(Math.fround(floatC * dt) * this.flipMod())));
        v42 = 1;
        v16 = 1;
        if (jumpBuffered) this.onGround2 = false;
      }

      if (!this.isAccelerating && !this.isWave) {
        // Both caps are written every tick, through setYVelocity, whether or
        // not they bite. [gdp updateJump, gd-ida-decomp.cpp:155560-155593]
        const up = Math.fround(FLY_MAX_UP / v16);
        const down = Math.fround(Math.fround(v42 * -FLY_MAX_UP) / v16);
        if (this.flipped) {
          this.setYVelocity(this.yVel < -up ? -up : this.yVel);
          this.setYVelocity(this.yVel > -down ? -down : this.yVel);
        } else {
          this.setYVelocity(this.yVel < down ? down : this.yVel);
          this.setYVelocity(this.yVel > up ? up : this.yVel);
        }
      }
      if (this.fallingBugged()) this.maybeIsBoosted = false;
    } else {
      const floatB = GRAVITY_FACTOR[this.mode];
      // v50: the step's gravity, a float. [:155914]
      const v50 = Math.fround(floatC * dt);
      const grounded = this.onGround || (this.world.jumpHack === true && this.stateRingJump);
      if (grounded && jumpBufferedAndRingJump && !this.dashing) {
        if (this.isSpider) {
          this.world.spiderJump(this);
        } else {
          this.onGround2 = false;
          this.maybeIsBoosted = true;
          this.onGround = false;
          this.stateRingJump = false;
          this.robotHoldEnded = false;
          this.robotHold = 0;
          let yStart = this.yStart;
          if (this.isRobot) yStart *= ROBOT_JUMP_FACTOR;
          // [:155785-155814]
          this.setYVelocity(Math.fround(Math.fround(yStart * flipMod) * v16));
          if (this.wasOnSlope || this.onSlope) {
            // Slope jump bonus, capped at 1.4× the jump. The cap is a float
            // (v39, taken before the bonus), and both writes are rounded. A
            // platformer gets it only while moving faster than 4 either way.
            // [gd-ida-decomp.cpp:155815-155848]
            if (this.slopeVelocity * flipMod > 0 && (!this.world.platformer || Math.abs(this.xVel) > SLOPE_JUMP_PLATFORMER_MIN_SPEED)) {
              const cap = Math.fround(this.yVel * SLOPE_JUMP_CAP);
              const bonus = this.isBall ? this.slopeVelocity : this.getModifiedSlopeYVel();
              this.addToYVelocity(Math.fround(bonus * SLOPE_JUMP_BONUS));
              if (this.flipped) this.setYVelocity(this.yVel < cap ? cap : this.yVel);
              else this.setYVelocity(this.yVel > cap ? cap : this.yVel);
            }
          }
          if (this.isBall) {
            // setYVelocity(yStart) → flipGravity (halves) → × 0.6, which is the
            // 0.3 × yStart boomlings measures. Both are raw writes. [:155855-155859]
            this.flipGravity(!this.flipped);
            this.holding = false;
            this.yVel *= BALL_CLICK_FACTOR;
          } else if (!this.isRobot) {
            this.runRotateAction();
          }
          this.world.emit("jump", this.playerNo, undefined, "ground");
          // Normal Jump, Robot Boost Start or Ball Switch. [gdp updateJump
          //  :155874-155901]
          const event = this.isRobot ? EVENT_ROBOT_BOOST_START : this.isBall ? EVENT_BALL_SWITCH : EVENT_NORMAL_JUMP;
          this.world.gameEvent?.(event, this.playerNo);
        }
      } else if (this.maybeIsBoosted) {
        // [:155914-155936]
        const floatD = Math.fround(Math.fround(v50 * flipMod) * floatB);
        if (this.isRobot && jumpBuffered && !this.robotHoldEnded && this.robotHold < ROBOT_HOLD_LIMIT) {
          // Holding cancels gravity until the accumulator reaches 1.5. [gdp lines 425-428]
          this.robotHold += Math.fround(dt * ROBOT_HOLD_ACCUM_FACTOR);
          this.addToYVelocity(floatD);
        }
        this.addToYVelocity(-floatD);
        // Robot Boost Stop, each step a robot's ended hold leaves it rising
        // with the button up. [gdp updateJump :155937-155946]
        if (this.isRobot && this.robotHoldEnded && !this.holding) this.world.gameEvent?.(EVENT_ROBOT_BOOST_STOP, this.playerNo);
        // A platformer boost also ends once the player stops rising.
        // [gd-ida-decomp.cpp:155949-155953; playerIsMovingUp :144378-144389]
        if (this.fallingBugged() || (this.world.platformer && !(this.flipped ? this.yVel < 0 : this.yVel > 0))) {
          this.maybeIsBoosted = false;
          this.onGround2 = false;
          // And once more as it starts to fall, if the hold never ended. [:155958-155969]
          if (this.isRobot && !this.robotHoldEnded) this.world.gameEvent?.(EVENT_ROBOT_BOOST_STOP, this.playerNo);
        }
      } else {
        if (
          this.fallingBugged() &&
          (!this.world.platformer || this.clock - this.lastLandTick >= PLATFORMER_LAND_DELAY * TICKS_PER_SECOND)
        ) {
          this.onGround = false;
        }
        // Gravity, then the ±15 clamp, which is written every tick. [:155990-156010]
        this.addToYVelocity(-Math.fround(Math.fround(v50 * flipMod) * floatB));
        if (this.flipped) {
          this.setYVelocity(this.yVel > GROUND_MODE_TERMINAL_VELOCITY ? GROUND_MODE_TERMINAL_VELOCITY : this.yVel);
        } else {
          this.setYVelocity(this.yVel < -GROUND_MODE_TERMINAL_VELOCITY ? -GROUND_MODE_TERMINAL_VELOCITY : this.yVel);
        }
        if (
          this.rel(this.yVel) < FALL_SPIN_VELOCITY &&
          !this.isBall &&
          !this.isSpider &&
          !this.isRobot &&
          !this.spinning &&
          !this.onSlope &&
          !this.collidingWithSlope &&
          (!this.world.platformer || !this.onGround2)
        ) {
          // [gdp updateJump :156011-156020]
          this.runRotateAction();
        }
        if (this.fallingBugged() && this.rel(this.yVel) < FALL_UNGROUND2_VELOCITY) this.onGround2 = false;
      }
    }

    this.wasJumpBuffered = jumpBuffered;
  }

  /**
   * getModifiedSlopeYVel: the stored slope velocity, scaled down when the slope
   * was only touched briefly (time on it × 10, floor 0.4). [osgp]
   */
  getModifiedSlopeYVel(): number {
    const onSlope = (this.clock - this.slopeStartTick) / TICKS_PER_SECOND;
    let ramp = 1;
    if (onSlope < SLOPE_BOOST_RAMP_TIME) {
      ramp = onSlope * SLOPE_BOOST_RAMP_RATE;
      if (ramp <= SLOPE_BOOST_MIN_FACTOR) ramp = SLOPE_BOOST_MIN_FACTOR;
    }
    return Math.fround(this.slopeVelocity * ramp);
  }

  /**
   * isBoostValid: a slope hand-off only counts when it beats the velocity the
   * player already has, in whichever direction that slope pushes.
   * [gdp PlayerObject::isBoostValid, gd-ida-decomp.cpp:142563-142579]
   */
  isBoostValid(yVel: number): boolean {
    const towardsGround = this.flipped
      ? !this.slopeSolidAbove && this.slopeDescending
      : !this.slopeSolidAbove || !this.slopeDescending;
    return towardsGround ? yVel > this.yVel : yVel < this.yVel;
  }

  /**
   * postCollision, for the pass the player leaves a slope on: the slope hands
   * over its velocity, or drops the player off its low end at its own speed,
   * and is then forgotten.
   *
   * The hand-over follows which side of the slope is solid, not the player's
   * gravity: up off a floor slope, down off a ceiling one. A player still
   * rising from a jump or a launch only takes it when flying or a ball. A
   * platformer's is worked out from its run speed along the slope instead, and
   * needs a direction held and enough of that speed.
   *
   * Running off the low end of a slope that was carrying it toward its solid
   * side — nothing boosting it, the button up and the press spent — the
   * player leaves at the slope's own y speed, off the ground and spinning: a
   * cube coming off a 45° slope at 1x starts its fall at −5.19, not at 0.
   * [gdp PlayerObject::postCollision, gd-ida-decomp.cpp:158438-158527;
   *  isBoostValid :142563-142579, getModifiedSlopeYVel :142596-142614]
   */
  leaveSlope(): void {
    if (!this.wasOnSlope || this.onSlope) return;
    this.slopeEndTick = this.clock;
    const sv = this.slopeVelocity;
    const launch = (sv < 0 && this.yVel > sv && this.slopeSolidAbove) || (sv > 0 && this.yVel < sv && !this.slopeSolidAbove);
    if ((!this.maybeIsBoosted || this.isFlying || this.isBall) && launch) {
      let boost = this.getModifiedSlopeYVel();
      let enough = true;
      if (this.world.platformer) {
        // [:158466-158477]
        boost = Math.fround(Math.abs(Math.tan(this.slopeAngle) * this.xVel) * Math.fround(1.1) * (boost >= 0 ? 1 : -1));
        enough = (this.leftHeld || this.rightHeld) && Math.abs(this.xVel) >= Math.cos(this.slopeAngle) * 5 - 1;
      }
      if (enough && this.isBoostValid(boost)) this.boostPlayer(boost);
    } else if (
      sv * this.flipMod() < 0 &&
      !this.maybeIsBoosted &&
      !this.holding &&
      !this.stateRingJump &&
      this.slopeSolidAbove === this.flipped
    ) {
      // [:158481-158503]
      this.onGround2 = false;
      this.setYVelocity(-this.currentSlopeYVel * this.flipMod());
      this.onGround = false;
      this.runRotateAction();
    }
    // [:158523-158526]
    this.currentSlopeYVel = 0;
    this.slopeVelocity = 0;
    this.slopeRotation = 0;
    this.slopeIdx = -1;
  }

  /**
   * The moving-platform launch, late in postCollision: a platform that was
   * carrying the player toward its head at more than 5 and has slowed by more
   * than 0.5 since last pass launches it at last pass's speed, capped at 20,
   * unless it is already moving faster that way or a "don't boost Y" object
   * holds it off. Then this pass's speed becomes last pass's.
   * [gdp PlayerObject::postCollision, gd-ida-decomp.cpp:159069-159116,
   *  159188-159192]
   */
  platformLaunch(): void {
    const last = this.lastPlatformYVel;
    const cur = this.platformYVel;
    if (last !== 0 && this.noBoostYPasses <= 0 && Math.abs(Math.fround(last - cur)) > PLATFORM_LAUNCH_DROP) {
      const slowed = this.flipped ? last < -PLATFORM_LAUNCH_MIN && cur > last : last > PLATFORM_LAUNCH_MIN && cur < last;
      if (slowed) {
        const v = Math.max(-PLATFORM_LAUNCH_CAP, Math.min(PLATFORM_LAUNCH_CAP, last));
        if (this.flipped ? this.yVel >= v : this.yVel <= v) this.boostPlayer(v);
      }
    }
    this.lastPlatformYVel = this.platformYVel;
    this.platformYVel = 0;
  }

  // ---------------------------------------------------------------------------
  // state changes
  // ---------------------------------------------------------------------------

  /**
   * Turns the player's gravity over, and halves the y velocity while doing it.
   *
   * The halving belongs here and nowhere else. Every caller in the game goes
   * through this one function and the multiply sits inside the "the flag really
   * changed" guard, so it runs entering flipped gravity and leaving it alike.
   * Most callers then write the velocity again — the green orb, the swing
   * click, the spider flip, an F block — and for those the halving is simply
   * overwritten, which is why it was possible to miss it for so long. The ones
   * where it shows are the gravity portals, the blue pad and orb, and the ball
   * click. Those the game routes through its layer come here by way of
   * SimImpl.flipGravity.
   *
   * A ball's roll stops and its air roll starts, turned by the new gravity:
   * clicked off the floor, a ball keeps turning the same way but slower
   * (425°/s against 600), and the ceiling it lands on rolls it back the other
   * way (hitGround).
   * [gdp PlayerObject::flipGravity, gd-ida-decomp.cpp:151121-151207; the ball
   *  :151196-151199]
   */
  flipGravity(flipped: boolean): void {
    if (this.flipped === flipped) return;
    this.flipped = flipped;
    this.lastFlipTick = this.clock;
    // The floor and ceiling met so far this pass no longer count, nor does
    // the collision log. [:151146-151147, :151155]
    this.collideTop = 0;
    this.collideBottom = 0;
    this.resetCollisionLog();
    // On a slope, or just off one, "going down it" turns over with the
    // gravity; the slope-exit launch reads it. [:151153-151154]
    if (this.wasOnSlope || this.onSlope) this.slopeDescending = !this.slopeDescending;
    // The jump latch goes; +2044 stays, so a player turned over where it stands
    // still counts as on the ground until something says otherwise. [:151195]
    this.onGround = false;
    // A raw write: not rounded to thousandths. [:151156-151158]
    this.yVel *= GRAVITY_FLIP_VELOCITY_FACTOR;
    if (this.isBall) {
      this.stopRotation();
      this.runBallRotation2();
    }
    this.world.emit("flip", this.playerNo);
  }

  /**
   * doReversePlayer: faces the player the given way. The ball rolls afresh,
   * turned by the new direction and by rotated gameplay, whether or not the
   * direction changed — so a gameplay turn, which comes through here every
   * time, rolls a ball the rotated way.
   * [gdp PlayerObject::doReversePlayer, gd-ida-decomp.cpp:148312-148345, the
   *  ball :148342-148343]
   */
  doReversePlayer(reversed: boolean): void {
    this.reversed = reversed;
    if (this.isBall) this.runRotateAction();
  }

  /**
   * copyAttributes: what one twin takes from the other when a dual starts, and
   * what player 1 takes from player 2 when player 2 is the one to leave it —
   * position, gravity, direction, mode, speed, size, vertical velocity and the
   * button, in that order. The gravity, direction, mode, speed and size go
   * through their own setters, so the flip and mode timestamps move, the latch
   * drops with them and a ball's roll starts afresh; the halvings do not stick,
   * because the velocity is copied last. Nothing else crosses over: not the
   * latch, the boost, the accelerating flag, the dash, rotated gameplay, the
   * rings or the letter blocks.
   * [gdp PlayerObject::copyAttributes, gd-ida-decomp.cpp:153299-153330]
   */
  copyAttributes(src: Player): void {
    // The clock comes first, so the flip and mode stamps below are now. [+2144]
    this.tick = src.tick;
    this.clock = src.clock;
    this.stepDt = src.stepDt;
    // The position is already the game's floats; the frame it is in goes with it.
    this.x = src.x;
    this.y = src.y;
    this.axesSwapped = src.axesSwapped;
    // +2024, the previous position the ship's tilt is aimed along.
    this.lastX = src.lastX;
    this.lastY = src.lastY;
    this.flipGravity(src.flipped);
    this.doReversePlayer(src.reversed);
    this.setMode(src.mode);
    this.setSpeed(src.speed);
    // The size comes after the mode, so a spin the mode change starts is at
    // the old size's rate. [:153318-153328]
    this.setMini(src.mini);
    // Through setYVelocity, so an unrounded velocity arrives rounded. [:153327-153328]
    this.setYVelocity(src.yVel);
    this.holding = src.holding;
    this.stateRingJump = src.stateRingJump;
  }

  /**
   * boostPlayer: the launch postCollision hands out, off the end of a slope
   * or off a moving platform that slowed — pads and orbs have their own. Like the
   * red pad and orb, it lets a flying player past its caps. `amount` is
   * already gravity-signed.
   *
   * A cube it launches spins backwards, at half a turn in 0.86667 s (0.66667
   * at any other size), turned by the gravity alone: not the direction, not
   * rotated gameplay, not the gravity multiplier, and not held back in a
   * platformer. A dashing, flying, ball, robot or spider player keeps
   * whatever it had.
   * [gdp PlayerObject::boostPlayer, gd-ida-decomp.cpp:147558-147604, the spin
   *  :147578-147599; both its callers are in postCollision, :158478 and :159110]
   */
  boostPlayer(amount: number): void {
    this.maybeIsBoosted = true;
    this.onGround2 = false;
    this.onGround = false;
    this.isAccelerating = true;
    // Its argument is a float. [:147576]
    this.setYVelocity(Math.fround(amount));
    if (this.dashing || this.isFlying || this.isBall || this.isRobot || this.isSpider) return;
    this.stopRotation();
    const seconds = this.mini ? BOOST_SPIN_SECONDS_MINI : BOOST_SPIN_SECONDS;
    this.spinSpeed = Math.fround((-180 * this.flipMod()) / seconds);
    this.spinning = true;
  }

  /**
   * propellPlayer: the launch of every pad but the spider pad. `bumpMod` is
   * what the pad is worth for this mode — getBumpMod, or the blue pad's 0.8.
   * It never touches the accelerating flag: bumpPlayer writes that afterwards,
   * and the blue pad, which does not go through bumpPlayer, leaves it be.
   * [gdp PlayerObject::propellPlayer, gd-ida-decomp.cpp:147666-147712]
   */
  propellPlayer(bumpMod: number): void {
    this.maybeIsBoosted = true;
    this.onGround2 = false;
    this.onGround = false;
    // It also takes the player off its slope, so this pass's postCollision
    // has no slope to leave: a pad at the foot of a ramp replaces the ramp's
    // launch instead of adding to it. The slope's velocity stays where it is;
    // nothing reads it again before the next slope writes its own. [147684-147685]
    this.onSlope = false;
    this.wasOnSlope = false;
    const size = this.mini ? MINI_JUMP_FACTOR : 1;
    // A float through setYVelocity, then the slow modes' 0.6 raw on the
    // double. [:147688-147693]
    this.setYVelocity(Math.fround(PAD_BASE_VELOCITY * bumpMod * this.flipMod() * size));
    if (this.isBall || this.isSpider || this.isSwing) this.yVel *= PAD_SLOW_MODE_FACTOR;
    // [:147694]
    this.runRotateAction();
    // Where it was launched from, for the camera. [:147715-147716]
    this.lastGroundY = this.worldY;
  }

  /** ringJump's factor for this orb in this mode. [gdp ringJump, gd-ida-decomp.cpp:160154-160221] */
  ringJumpFactor(type: LaunchOrb): number {
    switch (type) {
      case "blue":
        return ORB_FACTOR.blue;
      case "green":
        return this.isShip ? ORB_FACTOR.greenShip : ORB_FACTOR.green;
      case "pink":
        if (this.isShip) return ORB_FACTOR.pinkShip;
        if (this.isUfo) return ORB_FACTOR.pinkUfo;
        return this.isBall ? ORB_FACTOR.pinkBall : ORB_FACTOR.pink;
      case "red":
        if (this.isShip) return this.mini ? ORB_FACTOR.redShipMini : ORB_FACTOR.redShip;
        if (this.isUfo) return this.mini ? ORB_FACTOR.redUfoMini : ORB_FACTOR.redUfo;
        if (this.isBall || this.isSpider) return ORB_FACTOR.redBallOrSpider;
        return this.isRobot ? ORB_FACTOR.redRobot : ORB_FACTOR.red;
      default:
        return this.isRobot ? ORB_FACTOR.yellowRobot : ORB_FACTOR.yellow;
    }
  }

  /**
   * ringJump's launch for the yellow, pink, red, blue and green orbs. The
   * gravity flips the blue and green orbs carry are the sim's, around this
   * call. Ball, spider and swing take a fraction and let go of the button, so
   * landing does not jump again until the next press. Only the red orb lets a
   * flying player past its caps.
   * [gdp PlayerObject::ringJump, gd-ida-decomp.cpp:160141-160350]
   */
  ringLaunch(type: LaunchOrb): void {
    this.onGround2 = false;
    this.onGround = false;
    this.stateRingJump = false;
    this.maybeIsBoosted = true;
    const size = this.mini ? MINI_JUMP_FACTOR : 1;
    // v23 is yStart as a float, times the orb's float factor; then × flipMod
    // and the size, as floats, through setYVelocity. The ball's, spider's and
    // swing's share below is raw. [:160152-160221, 160260-160282]
    const v23 = Math.fround(Math.fround(this.yStart) * this.ringJumpFactor(type));
    this.setYVelocity(Math.fround(Math.fround(v23 * this.flipMod()) * size));
    // The ball's air roll, with no stop first: a ground roll that was running
    // still counts as running (+1480). [:160263-160266]
    if (this.isBall) this.runBallRotation2();
    else this.runRotateAction();
    if (this.isBall || this.isSpider) {
      this.yVel *= ORB_BALL_SPIDER_FACTOR;
      this.holding = false;
    } else if (this.isSwing) {
      this.yVel *= ORB_SWING_FACTOR;
      this.holding = false;
    }
    if (type === "red") this.isAccelerating = true;
  }

  /**
   * The black orb. It sets the velocity and the accelerating flag and nothing
   * else: the boost and the ground flags stay as they were, so a spider that
   * was not already boosted is held to 15 again by the next tick.
   * [gdp PlayerObject::ringJump, gd-ida-decomp.cpp:160352-160383]
   */
  dropRingLaunch(): void {
    this.stateRingJump = false;
    const v = this.isFlying
      ? BLACK_ORB_FLYING_VELOCITY * (this.isUfo ? BLACK_ORB_UFO_FACTOR : 1)
      : BLACK_ORB_VELOCITY * (this.isSpider ? BLACK_ORB_SPIDER_FACTOR : 1);
    this.setYVelocity(Math.fround(this.flipMod() * v));
    // [:160374-160377]
    if (this.isBall) this.runBallRotation2();
    else this.runRotateAction();
    this.isAccelerating = true;
    if (this.isBall || this.isSwing) this.holding = false;
  }

  /**
   * hitGround(object, ceiling). Any contact puts the player on the ground
   * (+2044), but only one that came in no faster than 5 against gravity arms
   * the jump latch (+1969) and stamps the landing time — so a player that
   * meets the level's ceiling at 6 cannot jump off it, while a landing always
   * can. A fast contact leaves the latch as it was rather than clearing it.
   * The game uses the ceiling argument for particles only; here it still
   * picks the landing event. Solid collision takes hitGroundNoJump instead
   * when canSnap is set, which it nearly always is for a block met head first.
   * [gdp PlayerObject::hitGround, gd-ida-decomp.cpp:150025, 150164-150170]
   */
  hitGround(objIdx: number, ceiling: boolean): void {
    const v9 = this.rel(this.yVel);
    if (!ceiling && !this.wasOnGround && !this.onGround) this.world.emit("land", this.playerNo, objIdx >= 0 ? objIdx : undefined);
    // The landing's game event, by how fast it came down: hard past 14,
    // normal past 8, soft past 4, and past 1 feather, or tiny for a player
    // already on the ground. Never for the wave. [gdp PlayerObject::hitGround
    //  :150025-150054; playerIsFalling :144307-144318]
    if (!this.isWave && this.world.gameEvent) {
      const landing =
        v9 < -14 ? EVENT_HARD_LANDING : v9 < -8 ? EVENT_NORMAL_LANDING : v9 < -4 ? EVENT_SOFT_LANDING : v9 < -1 ? (this.onGround2 ? EVENT_TINY_LANDING : EVENT_FEATHER_LANDING) : 0;
      if (landing !== 0) this.world.gameEvent(landing, this.playerNo, objIdx >= 0 ? objIdx : undefined);
    }
    this.onGround2 = true;
    if (v9 <= LANDING_LATCH_MAX_VELOCITY) {
      this.onGround = true;
      this.lastLandTick = this.clock;
    }
    this.lastFloorObj = objIdx;
    this.setYVelocity(0);
    // Where it met the ground, for the camera; a hitGroundNoJump keeps it too.
    // [:150189-150190]
    this.lastGroundY = this.worldY;
    // Neither the boost nor the accelerating flag is the landing's to clear:
    // the next updateJump ends the boost once its falling test says so, and a
    // flying player back inside its caps drops the flag. [gd-ida-decomp.cpp
    // hitGround 149979-150200 writes neither +2060 nor +1858]
    // Landing does *not* hand the hold back — only the jump that leaves the
    // ground does, so a robot that runs off a ledge and takes an orb gets no
    // hold. collidedWithObjectInternal never touches the flag.
    //
    // A spin ends. A ball's air roll ends, and so does a roll at a slope's
    // speed once off the slope; then a ball with no roll running starts one,
    // for the gravity it has now. (The game's last stop, for anything else
    // landing off a right angle, finds nothing running.) [:150173-150187]
    if (!this.isBall) {
      if (this.spinning || this.wasOnSlope) this.stopRotation();
    } else {
      if ((this.ballRotating && !this.onSlope) || this.ballAirRoll) this.stopRotation();
      if (!this.spinning) this.runRotateAction();
    }
  }

  /**
   * hitGroundNoJump: a hitGround that leaves the ground flag, the jump latch
   * and the landing time as they were. Solid collision takes it for a block
   * whose underside is at least the snap threshold above the feet, now or a
   * step ago (gravity-relative) — in practice a block met head first — so
   * bumping into one never lets the player jump off it.
   * [gdp PlayerObject::hitGroundNoJump, gd-ida-decomp.cpp:150215-150229]
   */
  hitGroundNoJump(objIdx: number, ceiling: boolean): void {
    const onGround = this.onGround;
    const onGround2 = this.onGround2;
    const lastLandTick = this.lastLandTick;
    this.hitGround(objIdx, ceiling);
    this.onGround = onGround;
    this.onGround2 = onGround2;
    this.lastLandTick = lastLandTick;
  }

  /**
   * stopRotation: the rate and its three flags go — the spin or ground roll,
   * the air roll, the slope's speed — and the angle stays where it is.
   * [gdp PlayerObject::stopRotation, gd-ida-decomp.cpp:142347-142357]
   */
  stopRotation(): void {
    this.spinning = false;
    this.ballAirRoll = false;
    this.ballRotating = false;
    this.spinSpeed = 0;
  }

  /**
   * isSafeFlip / isSafeMode: the gravity, or the mode, changed less than
   * `seconds` ago. The game measures that on its clock against a float, and
   * keeps "never" as time 0, so a change on the level's first instant — tick 0
   * here — does not count. [gd-ida-decomp.cpp:147844-147849, 147888-147893]
   */
  isSafeFlip(seconds: number): boolean {
    return this.lastFlipTick !== 0 && (this.clock - this.lastFlipTick) / TICKS_PER_SECOND < Math.fround(seconds);
  }

  isSafeMode(seconds: number): boolean {
    return this.lastModeChangeTick !== 0 && (this.clock - this.lastModeChangeTick) / TICKS_PER_SECOND < Math.fround(seconds);
  }

  /** isSafeHeadTest: a flip or a mode change in the last 0.2 s, or an H block. [gd-ida-decomp.cpp:147910-147912] */
  isSafeHeadTest(): boolean {
    return this.isSafeFlip(SAFE_HEAD_SECONDS) || this.isSafeMode(SAFE_HEAD_SECONDS) || this.stateHitHead > 0;
  }

  /**
   * destroyFromHitHead: whether meeting a dual band edge head first can put the
   * player out of bounds — a cube or a robot that no H block is holding.
   * [gd-ida-decomp.cpp:145615-145626]
   */
  destroyFromHitHead(): boolean {
    return !this.isFlying && !this.isBall && !this.isSpider && this.stateHitHead <= 0;
  }

  /** pushDown: a safe head hit stops the player and takes it off the ground. [gd-ida-decomp.cpp:147929-147938] */
  pushDown(): void {
    this.setYVelocity(0);
    this.onGround2 = false;
    this.onGround = false;
  }

  /**
   * +2160, the size the ground and the dual band measure the player by before
   * its scale: the box, except for the wave, which the game gives 20 against
   * its box of 10 — so a wave rides 10 units off the floor or a band edge
   * (mini 6). Block landings use the real box. [toggleSpiderMode :152721,
   * toggleDartMode :153041, resetPlayerIcon :148114]
   */
  groundSize(): number {
    return this.isWave ? WAVE_GROUND_SIZE : this.boxSize();
  }

  /**
   * runRotateAction: what a jump, a pad, an orb, a fall and a gameplay turn
   * start. Any spin running stops; a ball starts rolling afresh, anything
   * else gets runNormalRotation. A dashing player is left alone.
   * [gdp PlayerObject::runRotateAction, gd-ida-decomp.cpp:144577-144590]
   */
  runRotateAction(): void {
    if (this.dashing) return;
    this.stopRotation();
    if (this.isBall) this.runBallRotation(1);
    else this.runNormalRotation();
  }

  /**
   * runNormalRotation: the cube's spin, half a turn in 0.43333 s (0.33333 at
   * any size but full) — 415.4°/s and 540°/s — the way the player faces,
   * the way its gravity pulls, backwards in rotated gameplay (the turn is a
   * mirror of the world, and the angle is the world's), and scaled by the
   * gravity multiplier. A flying, robot, spider or dashing player does not
   * spin, and a platformer player only while a direction is held.
   *
   * `force` skips all of that, and `factor` multiplies the rate: the end of a
   * platformer dash spins the cube at up to twice it, and a force block
   * pushing a platformer cube sideways spins it at the plain rate.
   * [gdp PlayerObject::runNormalRotation, gd-ida-decomp.cpp:144512-144540;
   *  the held directions +2225/+2224, switchedDirTo :159446-159466; the
   *  forced calls, stopDashing :149888-149898 and update :161419-161420]
   */
  runNormalRotation(force = false, factor = 1): void {
    if (
      !force &&
      (this.isFlying ||
        this.isRobot ||
        this.isSpider ||
        this.dashing ||
        (this.world.platformer && !this.leftHeld && !this.rightHeld))
    ) {
      return;
    }
    const seconds = this.mini ? CUBE_SPIN_SECONDS_MINI : CUBE_SPIN_SECONDS;
    const turn = this.reverseMod() * 180 * this.flipMod() * (this.rotated ? -1 : 1);
    this.spinSpeed = Math.fround(Math.fround(Math.fround(turn * this.gravityMod) * factor) / seconds);
    this.spinning = true;
  }

  /**
   * runBallRotation(speed): the ball's roll on the ground, 120 / v5 a second
   * at the portal speed's factor and `speed` (a slope's 1 / cos) on top,
   * which updateRotation applies. It is turned by the gravity, the direction
   * and, like the cube's spin, rotated gameplay. Nothing rolls in a
   * platformer.
   * [gdp PlayerObject::runBallRotation, gd-ida-decomp.cpp:143720-143769]
   */
  runBallRotation(speed: number): void {
    if (this.dashing || this.world.platformer) return;
    this.rotateSpeed = speed;
    this.ballRotating = speed !== 1;
    let v5 = this.mini ? BALL_ROLL_V5_MINI : BALL_ROLL_V5;
    v5 *= BALL_ROLL_SPEED_FACTOR[this.speed];
    this.spinSpeed = (BALL_ROLL_BASE * this.flipMod() * this.reverseMod() * (this.rotated ? -1 : 1)) / v5;
    this.spinning = true;
  }

  /**
   * runBallRotation2: the ball's roll in the air, which a flip and an orb
   * start — −340 / v5 a second, v5 the ground roll's times 4, turned by the
   * gravity and the direction but not by rotated gameplay, and scaled by the
   * gravity multiplier. It leaves +1480 as it was, and a platformer ball
   * gets it too. The next landing ends it.
   * [gdp PlayerObject::runBallRotation2, gd-ida-decomp.cpp:143785-143826]
   */
  runBallRotation2(): void {
    if (this.dashing) return;
    let v5 = this.mini ? BALL_AIR_ROLL_V5_MINI : BALL_AIR_ROLL_V5;
    v5 *= BALL_ROLL_SPEED_FACTOR[this.speed];
    this.spinSpeed = (BALL_AIR_ROLL_BASE * this.flipMod() * this.reverseMod() * this.gravityMod) / v5;
    this.ballAirRoll = true;
  }

  /**
   * stopDashing. It forgets the landing time, as startDashing does. A classic
   * dash writes no velocity — its 0 is update's, written every dash step.
   *
   * A platformer dash hands its pair over through updatePlayerForce, times
   * the orb's end boost: both halves as floats, written raw, and the
   * accelerating flag set, so a flying player is let past its caps — unless
   * the orb stops the slide, which takes the flag back at once. A cube or
   * ball then spins, forced, faster the faster the dash was: from half the
   * normal rate for a still dash to twice it from speed 3 (17.31) up.
   * A ball rolls again straight away; the dash's start stopped it.
   *
   * Before any of that, a cube or ball takes its icon's angle: the dash's
   * spin, which the game runs on the frame clock and this port on the tick's.
   * [gdp PlayerObject::stopDashing, gd-ida-decomp.cpp:149796-149812, the
   *  icon's angle :149877-149887, the spin :149888-149898, the ball
   *  :149901-149902; updatePlayerForce
   *  :147375-147395; handlePlayerCommand(543) :142373-142379; update
   *  :161035-161038]
   */
  stopDashing(): void {
    if (!this.dashing) return;
    if (this.dashSpinRate !== 0) this.rotation = this.dashIconAngle();
    this.dashing = false;
    this.lastLandTick = -1e9; // +2048 = 0
    const platformer = this.world.platformer;
    if (platformer && this.dashOrbIdx >= 0) {
      this.isAccelerating = true;
      this.yVel = Math.fround(this.dashEndBoost * this.dashVelY);
      this.xVel = Math.fround(this.dashEndBoost * this.dashVelX);
      // handlePlayerCommand(543). [:149811-149812 → :142373-142379]
      if (this.dashStopSlide) {
        this.isAccelerating = false;
        this.forceSlide = false;
      }
    }
    this.dashOrbIdx = -1;
    if (platformer && !this.isFlying && !this.isRobot && !this.isSpider) {
      // getLength on the float point: sqrtf of float squares. [:149890-149897]
      const vx = Math.fround(this.dashVelX);
      const vy = Math.fround(this.dashVelY);
      const speed = Math.fround(Math.sqrt(Math.fround(Math.fround(vx * vx) + Math.fround(vy * vy))));
      const factor =
        speed > DASH_SPIN_FULL_SPEED
          ? DASH_SPIN_MAX_FACTOR
          : Math.fround(Math.fround(Math.fround(speed / DASH_SPIN_FULL_SPEED) * DASH_SPIN_SLOPE) + DASH_SPIN_BASE);
      this.runNormalRotation(true, factor);
    }
    if (this.isBall) this.runBallRotation(1);
    this.world.emit("dashEnd", this.playerNo);
  }

  /**
   * updateDashArt's angle: the player is drawn along the dash (from 90 in
   * rotated gameplay), turned half round when that lands strictly between
   * 90 and 270 — or, rotated, when it does not. Nothing wraps it.
   * [gdp PlayerObject::updateDashArt, gd-ida-decomp.cpp:144965-144988]
   */
  updateDashArt(): void {
    let a = (this.rotated ? 90 : 0) - this.dashAngle;
    const outside = a <= 90 || a >= 270;
    if (this.rotated === outside) a += 180;
    this.rotation = Math.fround(a);
    this.dashArtClock = this.clock;
    this.dashSpinRate = this.isFlying || this.isRobot || this.isSpider ? 0 : this.dashSpinFor();
  }

  /**
   * The rest of updateDashArt: a cube or a ball spins its icon from upright,
   * at DASH_ART_SPIN, the other way in rotated gameplay, and in a platformer
   * faster the faster the dash. [gdp PlayerObject::updateDashArt,
   * gd-ida-decomp.cpp:145044-145072]
   */
  private dashSpinFor(): number {
    const rate = this.rotated ? -DASH_ART_SPIN : DASH_ART_SPIN;
    if (!this.world.platformer) return rate;
    const vx = Math.fround(this.dashVelX);
    const vy = Math.fround(this.dashVelY);
    const speed = Math.fround(Math.sqrt(Math.fround(Math.fround(vx * vx) + Math.fround(vy * vy))));
    const factor =
      speed > DASH_SPIN_FULL_SPEED
        ? DASH_SPIN_MAX_FACTOR
        : Math.fround(Math.fround(Math.fround(speed / DASH_SPIN_FULL_SPEED) * DASH_ART_SPIN_SLOPE) + DASH_ART_SPIN_BASE);
    return rate * factor;
  }

  /** The icon's own angle inside the player while dashing, in degrees clockwise. */
  dashIconAngle(): number {
    return Math.fround((this.dashSpinRate * (this.clock - this.dashArtClock)) / TICKS_PER_SECOND);
  }

  // ---------------------------------------------------------------------------
  // rotation (updateRotation / updateShipRotation / updateSlopeRotation)
  // ---------------------------------------------------------------------------

  updateRotation(dt: number): void {
    if (this.dashing) return;
    if (!this.isBall) {
      if (this.onSlope) {
        this.updateSlopeRotation(dt);
      } else if (this.isFlying) {
        this.updateShipRotation(dt);
      } else if (!this.wasOnSlope) {
        if (this.onGround2 && !(this.rel(this.yVel) < FALL_SPIN_VELOCITY)) {
          // On the ground and not falling, the spin ends and the player
          // settles onto the nearest 90° — except a platformer player's spin,
          // which runs on until a landing stops it. In the air the angle is
          // left where the spin, or its end, put it (a platformer cube with
          // nothing held settles in updateFacing instead).
          // [gdp updateRotation, gd-ida-decomp.cpp:144873-144890]
          if (!(this.world.platformer && this.spinning)) {
            this.stopRotation();
            this.updateRotationTo(dt, this.convertToClosestRotation(0));
          }
        } else if (this.isRobot || this.isSpider) {
          // [:144893-144901]
          this.updateRotationTo(dt * ROTATION_ROBOT_AIR_DT_MULT, 0);
        }
      }
    }
    // The rate turns the angle whatever set it; a ball rolling at a slope's
    // speed turns that much faster. [:144903-144912]
    if (this.spinSpeed !== 0) {
      const rs = this.isBall && this.ballRotating ? this.rotateSpeed : 1;
      this.rotation += (dt / 60) * this.spinSpeed * rs;
    }
  }

  updateRotationTo(dt: number, angleDeg: number): void {
    if (this.dashing) return;
    const from = this.rotation * DEG;
    const to = angleDeg * DEG;
    let mult = this.playerSpeed * ROTATION_SLERP_BASE;
    if (this.isShip) mult *= ROTATION_SLERP_SHIP_MULT;
    else if (!this.isFlying && !this.isBall && this.onGround2 && !this.onSlope && !this.wasOnSlope) mult *= ROTATION_SLERP_GROUND_MULT;
    this.rotation = slerp2D(from, to, Math.min(dt, dt * mult)) / DEG;
  }

  updateSlopeRotation(dt: number): void {
    const rot = this.convertToClosestRotation(this.slopeRotation / DEG);
    this.updateRotationTo(dt, rot);
  }

  convertToClosestRotation(angle: number): number {
    if (this.isFlying || this.isRobot || this.isSpider || this.dashing) return angle;
    const pr = Math.trunc(this.rotation) % 360;
    let diff = (pr - angle) % 90;
    if (diff < 0) diff += 90;
    if (Math.abs(pr - angle) < Math.abs(diff)) return angle;
    return pr - diff;
  }

  updateShipRotation(dt: number): void {
    if (this.onSlope || this.dashing) return;
    let dx = this.x - this.lastX;
    const dy = -(this.y - this.lastY);
    if (this.reversed) dx = Math.abs(dx);
    if (dt * SHIP_ROTATION_MIN_MOVE > dx * dx + dy * dy) return;
    const from = this.rotation * DEG;
    let to = Math.atan2(dy, dx);
    let interp = UFO_ROTATION_INTERP;
    if (this.collidingWithSlope) to = 0;
    if (this.reversed) to = -to;
    if (this.isUfo) {
      const match = this.reversed === this.flipped;
      const v15 = match ? -UFO_TILT_CLAMP_RAD : UFO_TILT_CLAMP_RAD;
      to = match ? Math.max(to * UFO_TILT_SCALE, v15) : Math.min(to * UFO_TILT_SCALE, v15);
    } else if (this.isWave) {
      interp = this.mini ? WAVE_ROTATION_INTERP_MINI : WAVE_ROTATION_INTERP;
    } else {
      interp = SHIP_ROTATION_INTERP;
    }
    if (this.collidingWithSlope) interp *= SHIP_ROTATION_SLOPE_FACTOR;
    this.rotation = slerp2D(from, to, Math.min(dt * interp, dt)) / DEG;
  }

  // ---------------------------------------------------------------------------
  // snapshot support
  // ---------------------------------------------------------------------------

  copyFrom(o: Player): void {
    this.x = o.x;
    this.y = o.y;
    this.yVel = o.yVel;
    this.xSpeed = o.xSpeed;
    this.xVel = o.xVel;
    this.mode = o.mode;
    this.speed = o.speed;
    this.mini = o.mini;
    this.flipped = o.flipped;
    this.mirrored = o.mirrored;
    this.reversed = o.reversed;
    this.onGround = o.onGround;
    this.onSlope = o.onSlope;
    this.lastGroundY = o.lastGroundY;
    this.rotation = o.rotation;
    this.holding = o.holding;
    this.holdTicks = o.holdTicks;
    this.dashing = o.dashing;
    this.dashAngle = o.dashAngle;
    this.dead = o.dead;
    this.wasOutOfBounds = o.wasOutOfBounds;
    this.teleported = o.teleported;
    this.rotated = o.rotated;
    this.reverseOffset = o.reverseOffset;
    this.reverseSlice = o.reverseSlice;
    this.axesSwapped = o.axesSwapped;
    this.finished = o.finished;
    this.killedBy = o.killedBy;
    this.lastFlipTick = o.lastFlipTick;
    this.lastModeChangeTick = o.lastModeChangeTick;
    this.modeIndex = o.modeIndex;
    this.isShip = o.isShip;
    this.isBall = o.isBall;
    this.isUfo = o.isUfo;
    this.isWave = o.isWave;
    this.isRobot = o.isRobot;
    this.isSpider = o.isSpider;
    this.isSwing = o.isSwing;
    this.isFlying = o.isFlying;
    this.playerSpeed = o.playerSpeed;
    this.yStart = o.yStart;
    this.gravity = o.gravity;
    this.speedMultiplier = o.speedMultiplier;
    this.gravityMod = o.gravityMod;
    this.rawHeld = o.rawHeld;
    this.wasJumpBuffered = o.wasJumpBuffered;
    this.stateRingJump = o.stateRingJump;
    this.canRingJump = o.canRingJump;
    this.holdingForOrb = o.holdingForOrb;
    this.touchedRing = o.touchedRing;
    this.touchedCustomRing = o.touchedCustomRing;
    this.touchedTeleportRing = o.touchedTeleportRing;
    this.leftHeld = o.leftHeld;
    this.rightHeld = o.rightHeld;
    this.leftPressedLast = o.leftPressedLast;
    this.onGround2 = o.onGround2;
    this.maybeIsBoosted = o.maybeIsBoosted;
    this.isAccelerating = o.isAccelerating;
    this.robotHoldEnded = o.robotHoldEnded;
    this.robotHold = o.robotHold;
    this.lastLandTick = o.lastLandTick;
    this.wasOnGround = o.wasOnGround;
    this.lastX = o.lastX;
    this.lastY = o.lastY;
    this.stepY = o.stepY;
    this.lastFloorObj = o.lastFloorObj;
    this.wallLeftObj = o.wallLeftObj;
    this.wallRightObj = o.wallRightObj;
    this.wasOnSlope = o.wasOnSlope;
    this.collidingWithSlope = o.collidingWithSlope;
    this.slopeIdx = o.slopeIdx;
    this.slopeUid = o.slopeUid;
    this.platformYVel = o.platformYVel;
    this.lastPlatformYVel = o.lastPlatformYVel;
    this.noBoostYPasses = o.noBoostYPasses;
    this.slopeVelocity = o.slopeVelocity;
    this.currentSlopeYVel = o.currentSlopeYVel;
    this.slopeAngle = o.slopeAngle;
    this.slopeRotation = o.slopeRotation;
    this.slopeSolidAbove = o.slopeSolidAbove;
    this.slopeDescending = o.slopeDescending;
    this.slopeExtra = o.slopeExtra;
    this.slopeLastY = o.slopeLastY;
    this.slopeAtHigh = o.slopeAtHigh;
    this.slopeAtLow = o.slopeAtLow;
    this.slopeUpsideDown = o.slopeUpsideDown;
    this.slopeStartTick = o.slopeStartTick;
    this.slopeEndTick = o.slopeEndTick;
    this.spinning = o.spinning;
    this.spinSpeed = o.spinSpeed;
    this.ballAirRoll = o.ballAirRoll;
    this.rotateSpeed = o.rotateSpeed;
    this.ballRotating = o.ballRotating;
    this.dashVelX = o.dashVelX;
    this.dashVelY = o.dashVelY;
    this.dashOrbIdx = o.dashOrbIdx;
    this.dashEndBoost = o.dashEndBoost;
    this.dashStopSlide = o.dashStopSlide;
    this.dashAllowCollide = o.dashAllowCollide;
    this.dashMaxDuration = o.dashMaxDuration;
    this.dashStartTick = o.dashStartTick;
    this.dashClock = o.dashClock;
    this.dashArtClock = o.dashArtClock;
    this.dashSpinRate = o.dashSpinRate;
    this.lastSpiderFlipTick = o.lastSpiderFlipTick;
    this.snapObj = o.snapObj;
    this.snapDistance = o.snapDistance;
    this.stateHitHead = o.stateHitHead;
    this.stateFlipGravity = o.stateFlipGravity;
    this.stateNoAutoJump = o.stateNoAutoJump;
    this.stateDartSlide = o.stateDartSlide;
    this.scaleSnapPasses = o.scaleSnapPasses;
    this.padRingRelated = o.padRingRelated;
    this.forcePasses = o.forcePasses;
    this.forceX = o.forceX;
    this.forceY = o.forceY;
    this.forceSlide = o.forceSlide;
    copyIndices(this.forceIds, o.forceIds);
    this.collideTop = o.collideTop;
    this.collideBottom = o.collideBottom;
    this.collideLeft = o.collideLeft;
    this.collideRight = o.collideRight;
    copyIndices(this.logTop, o.logTop);
    copyIndices(this.logBottom, o.logBottom);
    copyIndices(this.logLeft, o.logLeft);
    copyIndices(this.logRight, o.logRight);
    copyIndices(this.touchingRings, o.touchingRings);
    copyIndices(this.ringsThisPass, o.ringsThisPass);
    copyIndices(this.usedRings, o.usedRings);
    this.tick = o.tick;
    this.clock = o.clock;
    this.stepDt = o.stepDt;
  }

  /**
   * Mixes into `h` what this player carries into the next steps without it
   * showing in its position: the rings a press would take, the rings this
   * press has used, the letter blocks wearing off, the J block's flag, a
   * teleport the next collision pass has yet to see, the platformer's
   * grown-back snap, whether a spin or roll is running, which way and whether
   * it is the ball's air roll — the angle it leaves decides what an oriented
   * object touches — which direction button was pressed last, the dash:
   * the orb it came from and its pair, which a gameplay turn can trade — a
   * force block's push still to come or still sliding out, and a
   * reverse-sync offset still to pay off. The force IDs and the squeeze's floor,
   * ceiling, walls and collision log are left out: the next update, pass or
   * step empties them before anything reads them.
   */
  carryHash(h: number): number {
    for (const i of this.touchingRings) h = Math.imul(h ^ (i + 1), 0x01000193);
    h = Math.imul(h ^ 0x10000000, 0x01000193);
    for (const i of this.ringsThisPass) h = Math.imul(h ^ (i + 1), 0x01000193);
    h = Math.imul(h ^ 0x20000000, 0x01000193);
    for (const i of this.usedRings) h = Math.imul(h ^ (i + 1), 0x01000193);
    const letters =
      this.stateDartSlide |
      (this.stateNoAutoJump << 2) |
      (this.stateHitHead << 4) |
      (this.stateFlipGravity << 6) |
      (this.padRingRelated ? 256 : 0) |
      (this.teleported ? 512 : 0) |
      (this.scaleSnapPasses << 10) |
      (this.spinning ? 4096 : 0) |
      (this.spinSpeed < 0 ? 8192 : 0) |
      (this.ballAirRoll ? 16384 : 0) |
      (this.leftPressedLast ? 32768 : 0) |
      (this.axesSwapped ? 65536 : 0) |
      (this.forceSlide ? 131072 : 0) |
      (this.noBoostYPasses << 18);
    if (this.lastPlatformYVel !== 0) h = Math.imul(h ^ Math.round(this.lastPlatformYVel * 4096) ^ 0x01000000, 0x01000193);
    if (this.dashing) {
      // The pair to 1/4096 of a unit is plenty to tell a traded one apart.
      h = Math.imul(h ^ (this.dashOrbIdx + 1) ^ 0x08000000, 0x01000193);
      h = Math.imul(h ^ Math.round(this.dashVelX * 4096), 0x01000193);
      h = Math.imul(h ^ Math.round(this.dashVelY * 4096), 0x01000193);
    }
    if (this.forcePasses > 0) {
      h = Math.imul(h ^ this.forcePasses ^ 0x04000000, 0x01000193);
      h = Math.imul(h ^ Math.round(this.forceX * 4096), 0x01000193);
      h = Math.imul(h ^ Math.round(this.forceY * 4096), 0x01000193);
    }
    if (this.reverseOffset !== 0 || this.reverseSlice !== 0) {
      h = Math.imul(h ^ Math.round(this.reverseOffset * 4096) ^ 0x02000000, 0x01000193);
      h = Math.imul(h ^ Math.round(this.reverseSlice * 4096), 0x01000193);
    }
    return Math.imul(h ^ letters ^ 0x30000000, 0x01000193);
  }
}

/** storeCollision: an object into one of the collision log's sets. [gd-ida-decomp.cpp:142440-142490] */
function logCollision(log: number[], object: number): void {
  if (object >= 0 && !log.includes(object)) log.push(object);
}

/** Copies a list of object indices in place, so a snapshot never shares an array with the live player. */
function copyIndices(dst: number[], src: readonly number[]): void {
  dst.length = src.length;
  for (let k = 0; k < src.length; k++) dst[k] = src[k];
}

export const PLAYER_FRAME_DT = FRAME_DT;
